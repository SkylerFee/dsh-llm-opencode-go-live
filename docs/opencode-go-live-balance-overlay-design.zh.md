# OpenCode Go Live 余额悬浮展示区设计（中文版）

- 状态：已实现
- 分支：`feat/balance-overlay`
- 英文版：[opencode-go-live-balance-overlay-design.md](opencode-go-live-balance-overlay-design.md)

## 1. 背景与目标

为 `@skylerfee/dsh-llm-opencode-go-live` 插件增加 OpenCode Go 订阅用量展示：

1. **悬浮面板**：帧级悬浮层实时展示 Go 订阅三个计费窗口的用量百分比与重置时间；
2. **展示开关**：在插件已有的 Models 页供应商卡片内提供开关，控制悬浮面板是否渲染；
3. **多语言**：全部新增 UI 文案进入现有 `opencodeGoLive` 双语词典（zh/en），不引入裸字符串。

已确认的范围决定：

- 「余额」指 **Go 订阅用量限额**（rolling/weekly/monthly 百分比 + 重置时间）。Zen 预付美元余额没有 API-key 可访问的公开端点，不在本期范围。
- 开关位置为**插件 Models 卡片内**（不注册 `settings.general.item` 全局行）。

## 2. 数据源契约

### 2.1 上游端点

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_LIVE_API_KEY>
```

响应（依据上游 sst/opencode `dev` 分支 `packages/console/app/src/routes/zen/go/v1/usage.ts` 核实）：

```jsonc
// 200
{
  "usage": {
    "rolling":  { "status": "ok" | "rate-limited", "percent": <0-100 数值>, "resetsAt": "<ISO 8601>" },
    "weekly":   { ...同构 },
    "monthly":  { ...同构 }
  }
}
// 401 → { "type": "error", "error": { "type": "AuthError", "message": "..." } }
// 403 → { "type": "error", "error": { "type": "EntitlementError", "message": "OpenCode Go subscription required." } }
```

Go 订阅限额模型：5 小时滚动窗口 = 月额度 20%、周 = 50%、月 = 100%（美元额度）。

### 2.2 非官方端点风险

该端点未出现在 OpenCode 公开文档，属上游实现约定。缓解措施：

- 端点 URL 与响应解析集中在新模块 `src/balance.ts` 单点维护；
- 解析对未知字段宽容（丢弃而非失败），新增窗口字段不影响既有渲染；
- 上游若改动端点，预期修改面仅限 `src/balance.ts`。

## 3. 总体架构

静态插件的两半结构（不使用动态 Cordis 包的 `host.call`；静态 client bundle 不具备该通道）：

```
┌ Host half (src/) ────────────────────────┐      ┌ Client half (client.js) ──────────────────┐
│ Config 新增顶层 volatile 字段            │      │ shell.overlay slot → 悬浮面板组件        │
│   showBalanceOverlay: boolean (默认 true)│      │   （开关关闭时组件渲染 null）            │
│                                           │      │                                           │
│ ctx.inject(['connection'], child =>       │      │ 挂载时 fetch + 每 5 分钟轮询 +           │
│   child.connection.fetch.register({      │      │   手动刷新（10s 节流）                   │
│     path: '/api/opencode-go-live/balance'│◄─────│ fetch('/api/opencode-go-live/balance')    │
│     methods: ['GET'], requestBody:       │ JSON │   同源请求，自动携带浏览器会话 cookie    │
│       'buffered',                         │      │                                           │
│     fetch: balanceRouteHandler }))        │      │ LiveProviderCard 卡片内开关行：          │
│                                           │      │   读：settings.describe() 的 ns 值       │
│ balanceRouteHandler:                      │      │   写：settings.mutate() 单字段 set        │
│   ① 复用凭据解析（credentialRef →        │      │   乐观更新 + settings/document-updated    │
│      credentials.resolve →                │      │   事件（已订阅）回刷                      │
│      assertUsableApiKey）                 │      │                                           │
│   ② createUsageSource().fetchUsage()     │      │ 全部文案走 ctx.locale.register 的          │
│      （10s 超时 AbortSignal）             │      │   opencodeGoLive 词典（zh/en）            │
│   ③ 返回统一 JSON envelope（见 §5）      │      │                                           │
└───────────────────────────────────────────┘      └───────────────────────────────────────────┘
```

## 4. 模块设计

### 4.1 `src/balance.ts`（新增）

```ts
/** 上游 usage 端点默认地址；集中定义便于上游演进时单点修改。 */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** 单个计费窗口的归一化视图。 */
export interface UsageWindow {
  status: 'ok' | 'rate-limited'
  /** 0-100；展示层负责 clamp，本层只校验为有限数。 */
  percent: number
  /** 上游 ISO 字符串；非法时为 undefined，展示层隐藏倒计时。 */
  resetsAt: string | undefined
}

/** 归一化 usage 报告；缺失或非法的窗口被丢弃。 */
export interface UsageReport {
  rolling?: UsageWindow
  weekly?: UsageWindow
  monthly?: UsageWindow
}

/** 宿主路由返回给客户端的统一 envelope。 */
export type UsageEnvelope =
  | { ok: true; checkedAt: string; usage: UsageReport }
  | { ok: false; code: UsageErrorCode; message: string }

export type UsageErrorCode =
  | 'MISSING_CREDENTIAL'   // 宿主凭据服务缺失或引用未配置
  | 'AUTH'                 // 上游 401
  | 'NO_SUBSCRIPTION'      // 上游 403（无 Go 订阅）
  | 'NETWORK'              // 网络失败或超时
  | 'UNKNOWN'              // 响应不可解析或全部窗口非法

export interface UsageSourceOptions { baseUrl?: string; fetch?: typeof globalThis.fetch }
export interface UsageSource { fetchUsage(apiKey: string, signal: AbortSignal): Promise<UsageEnvelope> }

/** 与 createModelsSource 同构的可测试窄接口；测试用固定 fetch 替身。 */
export function createUsageSource(options?: UsageSourceOptions): UsageSource

/** 纯函数：把上游 HTTP 状态与 JSON body 归一化为 envelope。 */
export function parseUsageResponse(status: number, body: unknown): UsageEnvelope
```

**解析规则（字段级宽容、窗口级校验）**：

| 情况 | 处理 |
|---|---|
| `status` 非 `'ok'`/`'rate-limited'` | 该窗口丢弃 |
| `percent` 非有限数 | 该窗口丢弃 |
| `resetsAt` 不可被 `Date.parse` 解析 | 该窗口保留，`resetsAt: undefined` |
| 三个窗口全部非法或 body 非 JSON | `{ ok: false, code: 'UNKNOWN' }` |
| HTTP 401 / 403 | `{ ok: false, code: 'AUTH' / 'NO_SUBSCRIPTION' }`（不透传上游 message，客户端本地化） |
| fetch reject / 超时 abort | `{ ok: false, code: 'NETWORK' }` |

### 4.2 `src/index.ts`（修改）

1. **抽公共凭据解析**：现有 `createDynamicAdapter` 参数里的 inline 凭据解析抽为 `resolveLiveApiKey(ctx, apiKeyEnv)`，路由与适配器共用（行为不变，integration 测试已覆盖原路径）。
2. **注册余额路由**：

```ts
export const BALANCE_ROUTE_PATH = '/api/opencode-go-live/balance' // 供测试断言；client.js 平行定义（见 §4.4）
const USAGE_TIMEOUT_MS = 10_000

// apply() 内，与现有 ctx.inject(['settings'], ...) 并列：
ctx.inject(['connection'], (child) => {
  child.effect(() => child.connection.fetch.register({
    path: BALANCE_ROUTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => balanceRouteHandler(child, resolvedConfig, request),
  }))
})
```

3. **balanceRouteHandler**：
   - 依次：凭据解析失败 → envelope `MISSING_CREDENTIAL`；
   - `createUsageSource().fetchUsage(key, AbortSignal.timeout(USAGE_TIMEOUT_MS))`；
   - envelope JSON 序列化返回 `new Response(json, { headers: { 'content-type': 'application/json' } })`，HTTP 始终 200（认证由 `/api` 桥在到达 handler 前完成，未认证请求桥自行 401/403）；
   - handler 自身异常（不应发生）→ `{ ok: false, code: 'UNKNOWN' }`，`child.logger.warn` 记录（**不记录 API key 与上游响应体**）。
4. **connection 为可选注入**：无浏览器部署（纯 CLI composition）时 Cordis 不执行回调，路由不注册，不产生错误日志（与现有 `resolveAttachments` 按需 `ctx.get` 的降级姿态一致；此时客户端也不存在）。
   实现按反射式窄接口（`HostFetchRoute` / `HostConnectionFace` / `ContextWithConnection`）读取 `connection`，与既有 `ctx.get('fs') as {...}` 同一姿态：发布包因此不必新增 `@deepseek-ai/dsh-client-connection` 依赖，也避免 pnpm 主版本差异改写 lockfile。契约面与官方 host 签名一致，范围受窄接口约束。

### 4.3 `src/config.ts`（修改）

新增**顶层** volatile 字段（顶层而非嵌套 `ui` 组：volatile form 投影对嵌套字段的暴露行为未经验证，顶层字段与现有 `apiKeyEnv` 同构、风险最低）：

```ts
export interface Config {
  apiKeyEnv: Volatile<string>
  catalog?: CatalogConfig
  /** 是否在 Web 客户端渲染余额悬浮面板；仅客户端消费，Host 运行时不读取。 */
  showBalanceOverlay?: Volatile<boolean>
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('OPENCODE_GO_LIVE_API_KEY').volatile(),
  catalog: z.object({ /* 不变 */ }),
  showBalanceOverlay: z.boolean().default(true).volatile(),
})
```

`resolveConfig` 同步扩展：

- `ResolvedConfig` 增加 `showBalanceOverlay: boolean`（默认 `true`；非法类型抛 `TypeError`，沿用现有 `nonNegativeSafeInteger` 的错误风格）；
- Host `apply()` 不消费该值（渲染与否由客户端决定），解析仅保证配置合法性与类型收敛。

`cordis.patch.yml` **不新增字段**（schema 默认值即 true，保持 patch 最小；`tests/config.spec.ts` 增加断言防止默认值漂移）。

### 4.4 `client.js`（修改）

**平行常量**（client bundle 无法 import `src/`，两处定义互注对方位置，与现有 `NS`/`ROUTE` 同做法）：

```js
const BALANCE_ROUTE = '/api/opencode-go-live/balance' // 与 src/index.ts 的 BALANCE_ROUTE_PATH 保持一致
const OVERLAY_POS_KEY = 'opencode-go-live.overlay.pos'
const OVERLAY_PINNED_KEY = 'opencode-go-live.overlay.pinned'      // 固定位置
const OVERLAY_EXPANDED_KEY = 'opencode-go-live.overlay.expanded'  // 固定展开
const OVERLAY_SIZE_KEY = 'opencode-go-live.overlay.size'          // { width, height }
const OVERLAY_DEFAULT_WIDTH = 264   // 未调整过时的面板宽度；高度随内容自适应
const OVERLAY_MIN_WIDTH = 200, OVERLAY_MIN_HEIGHT = 120   // 最小尺寸
const OVERLAY_MAX_WIDTH = 480, OVERLAY_MAX_HEIGHT = 520   // 最大尺寸（再按视口收缩）
const OVERLAY_VIEWPORT_MARGIN = 24  // 尺寸上限相对视口保留的边距
const OVERLAY_RESIZE_STEP = 16      // 键盘调整大小的步长
const WINDOW_DRAG_RECALL_ATTR = 'data-window-drag-recall' // 宿主窗口拖拽区重算标记（平行定义）
const OVERLAY_REFRESH_MS = 300_000   // 5 分钟自动刷新
const MANUAL_REFRESH_THROTTLE_MS = 10_000
```

#### 4.4.1 词典扩展（`copy.zh` / `copy.en` 成对）

| 键 | zh | en |
|---|---|---|
| `overlayTitle` | OpenCode Go 用量 | OpenCode Go usage |
| `windowRolling` | 5 小时 | 5-hour |
| `windowWeekly` | 本周 | This week |
| `windowMonthly` | 本月 | This month |
| `loading` | 加载中… | Loading… |
| `refresh` | 刷新 | Refresh |
| `closeOverlay` | 关闭用量面板 | Close usage panel |
| `showOverlay` | 显示用量悬浮窗 | Show usage overlay |
| `pinOverlay` / `unpinOverlay` | 固定位置 / 解除固定 | Pin position / Unpin position |
| `pinExpandOverlay` / `unpinExpandOverlay` | 固定展开 / 取消固定展开 | Keep expanded / Stop keeping expanded |
| `resizeOverlay` | 调整面板大小 | Resize panel |
| `updatedAtPrefix` | 更新于 | Updated |
| `hourUnit` | 小时 | h |
| `minuteUnit` | 分 | m |
| `resetsSuffix` | 后重置 | until reset |
| `errorMissingCredential` | API 密钥缺失，请先在卡片中配置 | API key missing; configure it in the card above |
| `errorAuth` | API 密钥无效 | The API key is invalid |
| `errorNoSubscription` | 没有 OpenCode Go 订阅 | No OpenCode Go subscription |
| `errorNetwork` | 查询失败，请稍后重试 | Query failed; try again later |
| `errorUnknown` | 响应无法解析 | The response could not be parsed |

倒计时文案由组件组合：`${n}${t('hourUnit')}${t('resetsSuffix')}`（zh：「3 小时后重置」；en：「3h until reset」）——避免引入词典插值机制。

#### 4.4.2 `LiveProviderCard` 内新增开关行

- **读**：`readProvider` 扩展，从 `settings.describe()` 的 `llm-opencode-go-live` namespace 取 `value.showBalanceOverlay`（`undefined` → `true` 视为开）。
- **写**（点击开关）：

```js
const result = await ctx.remote.settings.mutate(NS, [
  { op: 'set', path: ['showBalanceOverlay'], value: next },
], view.settingsRevision)   // revision 从 describe 结果携带，防 settings-conflict
```

  - `result.ok === false` → 显示 `result.error.message`（沿用密钥保存的错误呈现模式），本地乐观状态回滚；
  - 成功 → 保留乐观值，`settings/document-updated`（NS 匹配过滤，卡片已订阅）到达后以服务端视图为准回刷。
- 开关行位于密钥状态行之后、模型列表之前；使用 `role="switch"` + `aria-checked`。

#### 4.4.3 新组件 `BalanceOverlay`

- **挂载**：`apply()` 内新增第二处 slot 注入：

```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'opencode-go-live-balance', order: 100, locale: 'opencodeGoLive',
}, BalanceOverlay))
```

- **开关联动**：组件内部读取卡片同步的开关视图（两处共享同一模块级可变状态或由 overlay 自行 `settings.describe()`——**取后者**：overlay 独立订阅 `settings/document-updated` 自行读配置，避免与卡片状态耦合；开关关闭时 `return null`，slot 注册不动）。
- **布局**（全部使用宿主 theme token，明暗主题自适应）：
  - `position: absolute`，默认右下角（`right/bottom: 16px`），宽 264px（`box-sizing: border-box`，与 `getBoundingClientRect` 同一坐标系）；宿主 `shell.overlay` 容器本身是 `position:absolute; inset:0; pointer-events:none`，其直接子元素自动获得 `pointer-events:auto`，因此面板既随 frame 布局，也不需要额外的指针事件声明；
  - 标题行：标题 + 固定展开按钮 + 固定位置按钮 + 刷新按钮 + 关闭按钮（按钮上的 `pointerdown` 必须 `stopPropagation`，否则会冒泡成拖拽）；面板没有最小化按钮——收起由鼠标移开自动完成；
  - 三个窗口行：窗口名 + 进度条（4px 高、圆角）+ `${percent}%` + 倒计时；
  - 底部：`updatedAtPrefix` + 相对时间；
  - 右下角：调整大小手柄（16px 命中区，`cursor: nwse-resize`），只在展开形态存在。
- **状态着色**：`status === 'rate-limited'` → `--dsw-alias-state-error-primary`；`percent ≥ 80` → `--dsw-static-amber-500`；否则 `--dsw-alias-state-success-primary`。已核对宿主 Theme 的 `listTokens` 输出：**没有** `--dsw-alias-state-warning-*`，因此警告档使用静态琥珀色板。
- **配置未读到时不渲染**：开关初值为 `null`（未知）。只有读到 `true` 才渲染并查询，避免开关关闭时闪现面板，也避免一次多余的上游请求。
- **关闭与开关同步**：关闭按钮把插件配置的 `showBalanceOverlay` 写成 `false`，而不是本地隐藏。卡片开关与悬浮窗关闭共用同一个 `writeOverlayEnabled` 入口，该入口每次写入前重新读取 revision，避免两个入口把对方的写标记为过期（`settings-conflict`）；写入成功后宿主广播的 `settings/document-updated` 使卡片开关同步显示为关。面板不保留任何独立的关闭状态，因此不存在「开关显示开、面板却不显示」的分叉。
- **固定位置**：标题栏／徽章上的同一个按钮切换固定状态。图标是内联矢量图钉（圆形头 + 针身）：**已固定为实心（`fill: currentColor` + 品牌色），未固定为空心（`fill: none` + 次要色）**，`aria-pressed` 同步；**默认不固定**（`localStorage` 无键即为未固定）。固定后 `startDrag` 直接返回，位置保持不变，状态写入 `localStorage` 跨刷新保持。使用矢量图标而不是 emoji，是为了让「实心／空心」由当前颜色渲染，可随主题变化并且可被测试断言。
- **徽章是默认形态、悬浮展开**：不再有持久的最小化状态，也不再需要最小化按钮——默认渲染徽章（5 小时窗口的进度条与用量百分比 + 固定展开按钮 + 固定位置按钮），鼠标移入锚点即展开完整面板，移出即收回。进度条与百分比都取已用值，取整并钳制到 0–100，着色沿用 `barColor`；无数据时显示占位符，失败时显示告警符。徽章主体是独立按钮（供不支持悬浮的设备展开），与两个固定按钮并列，避免按钮嵌套按钮；收起期间查询与自动刷新照常进行。
- **锚点常驻**：承载悬浮判定与徽章整块拖拽的 `div` 常驻，徽章与面板是它的内层内容。若把判定绑在会随内容切换而卸载的元素上，`mouseleave` 会在展开瞬间触发，形成展开/收回的抖动循环。
- **界面偏好与配置的分工**：位置与固定是浏览器本地界面偏好（`localStorage`）；是否展示由插件配置 `showBalanceOverlay` 决定，两者不混用同一存储。
- **拖拽**：`onPointerDown` **只绑在锚点上**，徽章与面板（标题栏及内容区）的事件都冒泡到它，因此 `event.currentTarget` 恒为锚点。这一点是正确性前提：位置换算需要以锚点为参照，因为锚点才是 `position: absolute` 的定位元素，只有它的 `offsetParent` 是 frame；若改取面板元素，面板的 `offsetParent` 会解析到锚点自身，可用范围被钳制成 0，表现为「拖不动」。`pointermove` 更新位置，松开时 clamp 到视口内并写 `localStorage[OVERLAY_POS_KEY]`（`{ x, y }`）。徽章整块可拖且内部含按钮，因此移动过的拖拽会记录时间戳，`DRAG_CLICK_SUPPRESS_MS`(250ms) 内的点击被忽略，避免「移动位置」被识别成「点击展开」。挂载时读取位置，越界（视口变更后）则回退默认右下角。
- **锚点从窗口拖拽几何中减除，两道保险**：
  1. **主保障是宿主自己的规则**：锚点带 `tabIndex: -1`，命中宿主 `base.css` 的交互元素选择器 `html[data-platform=darwin] :is(button, a, input, …, [contenteditable='true'], [tabindex], [role='dialog'], …) { -webkit-app-region: no-drag }`（属性选择器不看取值，`-1` 因此不进 Tab 顺序，也不会带来多余的焦点停靠点）。这条规则由宿主维护并随宿主一起验证，已在已安装 app 的 `app.asar` 中核对存在（`…,[contenteditable=true],[tabindex],…){-webkit-app-region:no-drag}`）。
  2. **内联声明作为兜底**：锚点同时声明 `WebkitAppRegion: 'no-drag'` 与 `webkitAppRegion: 'no-drag'` 两种拼写。之所以不只用一种：Blink 的 CSSOM 别名只暴露小写 w 的 `webkitAppRegion`（对已安装的 Electron Framework 二进制做字符串核对：`webkitTransform`／`webkitAppearance`／`webkitUserSelect` 均为小写形式，大写 `Webkit*` 形式 0 次），而 WebKit 系引擎的历史拼写是大写 W；两种都写才不依赖具体引擎的别名表。
  锚点是悬浮窗最外层定位元素，其盒子覆盖徽章与面板；`shell.overlay` 层排在各列之后，因此减除盒在文档顺序上晚于任何 `data-window-drag` 行，能整体压过它们。
- **拖拽区重算脉冲**：`no-drag` 只在挂载时改变一次 app-region 计算值；Electron 只在计算值变化时重新收集拖拽矩形（electron#32341），因此展开、移动、调整大小或数据行数变化之后，旧几何仍可能命中窗口拖拽行。组件在 `[expanded, pos, size, envelope]` 任一变化时调用 `pulseWindowDragRecall()`：仅在 `document.documentElement.dataset.platform === 'darwin'` 时，先给 `document.body` 写 `data-window-drag-recall`，再在下一帧移除——先写后清即两次计算值变化，正是宿主 `window-drag/recall.ts` 的同一机制（该文件对 “mounted overlay 自身的 app-region 变化” 已作同义说明）。平台不符、无 `document` 或脉冲未清除时直接跳过。
- **固定展开**：标题栏与徽章上的同一个按钮切换「固定展开」（`OVERLAY_EXPANDED_KEY`）。展开形态为 `hovered || expandPinned`，所以打开后指针移开仍保持完整面板，关闭后回到「悬浮展开、移开收起」。按钮图标同样是内联矢量（方形框 + 箭头，**实心=已固定展开，空心=未固定**）并同步 `aria-pressed`；切换只写 `localStorage`，不触碰 `hovered`——指针仍在悬浮窗上时关闭固定展开会保持展开到指针移出为止。它与「固定位置」是两个独立状态：前者决定是否常驻展开，后者决定能否拖动位置。
- **展开尺寸可调**：右下角手柄按下时 `stopPropagation`（否则会同时触发锚点的移动拖拽），随后与移动拖拽同构地监听 `window` 的 `pointermove`/`pointerup`；起点尺寸取 `resizeOrigin`（未调整过时用默认宽度与面板实测高度，两者同坐标系所以不会跳变），每次位移经 `clampOverlaySize` 收敛：最小 `200×120`、最大 `480×520` 再与视口相减（留 `OVERLAY_VIEWPORT_MARGIN`，且不因视口过小而反转区间）。松手写入 `localStorage[OVERLAY_SIZE_KEY]`（`{ width, height }`）；挂载时读取并钳制，因此手工改坏或跨视口的历史值都在边界内收敛。手柄支持键盘：方向键按 `OVERLAY_RESIZE_STEP` 收放，走同一套起点与钳制。调整期间与拖拽一样不收起（`onMouseLeave` 同时看 `dragging` 与 `resizing`）。高度一旦固定，只有内容区滚动（`overlayBodyStyle` 的 `overflow: auto`），标题行与手柄始终可见。
- **数据获取**：

```js
async function queryBalance(signal) {
  const response = await fetch(BALANCE_ROUTE, { signal })
  if (!response.ok) return { ok: false, code: 'NETWORK', message: '' }
  const value = await response.json()
  return isUsageEnvelope(value) ? value : { ok: false, code: 'UNKNOWN', message: '' }
}
```

  - 挂载且开关开 + 面板未被会话关闭 → 立即查询一次；
  - `setInterval(OVERLAY_REFRESH_MS)`（effect 清理函数清除）；
  - 手动刷新按钮：距上次查询 ≥ `MANUAL_REFRESH_THROTTLE_MS` 才发请求；
  - `credentials/reference-updated` 事件（overlay 自行订阅）→ 重新查询（密钥更换后用量视图随之变化）；
  - 加载中不闪烁旧内容（保留上次数据，`loading` 态仅在无数据时显示）。

## 5. 宿主路由响应契约（`GET /api/opencode-go-live/balance`）

```jsonc
// 成功（HTTP 200）
{ "ok": true, "checkedAt": "2026-10-04T03:42:53.000Z",
  "usage": { "rolling": { "status": "ok", "percent": 37.5, "resetsAt": "..." }, ... } }
// 失败（同样 HTTP 200；code 见 §4.1，message 为英文诊断，客户端按 code 显示本地化文案）
{ "ok": false, "code": "AUTH", "message": "llm-opencode-go-live: upstream returned 401" }
```

安全边界：

- API key 只在 Host 凭据服务内解析，绝不出现在响应、日志或缓存中；
- 上游响应体不落日志（`balanceRouteHandler` 只记录错误码级别信息）；
- 无新增持久化（悬浮窗位置为浏览器 localStorage，属用户本地 UI 偏好，不含敏感数据）。

## 6. 错误处理矩阵

| 场景 | 客户端表现 |
|---|---|
| 凭据未配置 | `errorMissingCredential` + 引导文案（卡片就在旁边） |
| 上游 401 | `errorAuth` |
| 上游 403 | `errorNoSubscription` |
| 网络失败/超时/宿主路由 404（无 connection 部署） | `errorNetwork` + 重试按钮 |
| 响应不可解析 | `errorUnknown` |
| 开关写入冲突（settings-conflict） | 回滚乐观状态 + 显示宿主诊断 message |

## 7. 测试计划（全部离线，来源网络用固定替身）

### 7.1 `tests/balance.spec.ts`（新增）

| 用例 | 断言 |
|---|---|
| 完整三窗口响应 | envelope `ok:true`，三窗口字段齐全 |
| 仅 rolling 窗口 | weekly/monthly 为 absent |
| `status` 未知值 | 该窗口丢弃 |
| `percent` 非法（字符串/NaN） | 该窗口丢弃 |
| `resetsAt` 非 ISO | 窗口保留、`resetsAt === undefined` |
| 全部窗口非法 / body 非 JSON | `{ ok:false, code:'UNKNOWN' }` |
| 上游 401 / 403 | `AUTH` / `NO_SUBSCRIPTION` |
| `createUsageSource` fetch 抛错 | `NETWORK`；替身 fetch 不访问真实网络 |

### 7.2 `tests/config.spec.ts`（扩展）

| 用例 | 断言 |
|---|---|
| `Config({}).showBalanceOverlay.get()` | `=== true`（volatile 默认值） |
| `resolveConfig` 显式 `false` | `=== false` |
| `resolveConfig` 非法类型 | `TypeError` |
| `cordis.patch.yml` 不含 `showBalanceOverlay` | 保持 patch 最小 |

### 7.3 `tests/integration.spec.ts`（扩展）

| 用例 | 断言 |
|---|---|
| 挂载插件（无 connection 服务） | 不抛错（可选注入降级） |
| fake `connection.fetch.register` 捕获 handler + fake credentials 返回 key + 替身 fetch | handler 返回 200 + envelope `ok:true` |
| fake credentials `resolve → undefined` | envelope `MISSING_CREDENTIAL` |

### 7.4 `tests/client.spec.ts`（扩展）

- fake `slots.inject` 同时接受 `settings.models.footer` 与 `shell.overlay`（断言两个 slot 名都被注入）；
- fake ctx 增加 `remote.settings.mutate`（捕获 NS / ops / revision）；
- sandbox 全局提供 `fetch` 替身、`localStorage`/`sessionStorage` 桩、`document` 桩（html 平台标记 + body 属性读写）与 `requestAnimationFrame` 队列（可 `flushFrames()` 结算）；
- 用例：开关默认开 → 卡片渲染开关行；点击开关 → `mutate` 收到 `['showBalanceOverlay']` path set；写入失败 → 乐观回滚；overlay 在开关开 + envelope `ok:true` 时悬浮渲染三窗口行（直接消费宿主 `parseUsageResponse` 的真实产出）；`ok:false` 时渲染对应错误文案；开关关时 overlay 渲染 `null`；配置里没有该字段时默认渲染徽章；关闭按钮写入 `showBalanceOverlay=false` 后控件消失、重新打开开关后徽章恢复（隐藏期间不残留悬浮态）；徽章显示 5 小时进度条与百分比、按钮集合为主体与两个固定按钮、固定图标默认空心且点击后实心并写入存储；徽章与面板拖拽都受固定门控、拖拽余波的点击不展开；锚点带 `tabIndex: -1` 且两种 app-region 拼写都声明为 `no-drag`，挂载/展开后写 `data-window-drag-recall` 并在下一帧清除（`win32` 平台不写）；固定展开按钮让面板在移开鼠标后保持展开并能取消（含存储与 `aria-pressed`/图标断言）；调整大小手柄按位移改变宽高、超界被钳制到最小/最大尺寸、松手写入存储、调整期间不收起、越界历史值在挂载时收敛，键盘方向键走同一套钳制。

## 8. 文档与发布

- `README.md` / `README.zh.md`：新增「余额悬浮窗」功能段（开关、数据含义、`/zen/go/v1/usage` 非官方端点风险提示）；
- `docs/usage.md` / `docs/usage.zh.md`：补充悬浮面板使用说明；
- 本设计文档两份随代码分支入库；
- 流程：`pnpm run check` 通过后合并；发布前 `pnpm pack --dry-run` 确认产物不含测试文件与敏感数据（沿用 [development-and-release.zh.md](development-and-release.zh.md)）。

## 9. 风险与未验证项（实现交接必须声明）

1. **上游端点非官方文档化**：`/zen/go/v1/usage` 依据上游 dev 分支源码核实，可能随上游演进变化（缓解见 §2.2）。
2. ~~**`z.boolean().volatile()` 链式可用性**~~：**已验证可用**。`Config({}).showBalanceOverlay.get() === true`、显式 `false` 生效，`tests/config.spec.ts` 已固定该行为。
3. **volatile 字段的 settings 表单投影**：插件已 `settings.configure({ auto: false })` 自持卡片，`mutate` 写入路径不依赖自动表单；但 `describe()` 视图中字段可见性需在实现时以真实宿主验证。
4. **真实 OpenCode Go API E2E 未验证**：所有测试离线；需有效订阅 key 的实机验证留待用户验收（悬浮窗真实渲染、403 场景、5 小时窗口滚动）。
5. **Electron 桌面端**：浏览器 `fetch` 到宿主路由经 IPC 桥（deliverables 先例）；悬浮窗在桌面端的实际表现需实测。
6. ~~**主题警告色 token**~~：**已核对并确定**：无 `--dsw-alias-state-warning-*`，使用 `--dsw-static-amber-500`。

## 10. 实施步骤清单（建议提交拆分）

1. `src/balance.ts` + `tests/balance.spec.ts`（纯函数与替身测试先行）；
2. `src/config.ts` + `tests/config.spec.ts` 扩展（volatile 默认值验证，风险点 §9.2 前置排除）；
3. `src/index.ts` 路由注册 + 凭据解析抽取 + `tests/integration.spec.ts` 扩展；
4. `client.js` 开关行 + `BalanceOverlay` 组件 + 词典 + `tests/client.spec.ts` 扩展；
5. `README` / `docs/usage` 双语更新；
6. `pnpm run check` 全量通过 → 合并 → （发布时）`pnpm pack --dry-run`。

## 11. 实现状态（2026-10-04）

代码与测试已按本方案落地，`tsc` 构建通过，39 个离线测试全绿。

| 文件 | 内容 |
|---|---|
| `src/balance.ts` | 端点常量、`UsageWindow`/`UsageReport`/`UsageEnvelope`、`parseUsageResponse` 纯函数、`createUsageSource` 窄接口。 |
| `src/index.ts` | `BALANCE_ROUTE_PATH`、`resolveLiveApiKey` 抽取（适配器与路由共用）、`balanceRoute` 处理器、`ctx.inject(['connection'])` 可选注册、`ContextWithConnection` 窄接口。 |
| `src/config.ts` | 顶层 volatile 字段 `showBalanceOverlay`（默认 `true`）、`resolveConfig` 校验与 `ResolvedConfig` 字段。 |
| `client.js` | 词典 23 键、卡片开关（`settings.mutate` + revision + 乐观回滚）、`BalanceOverlay`（三窗口、拖拽、关闭、节流刷新、错误映射）。 |
| `tests/balance.spec.ts` | 9 个解析与来源用例（固定 fetch 替身）。 |
| `tests/config.spec.ts` | 默认值、非法值、patch 不重复默认值 3 个用例。 |
| `tests/integration.spec.ts` | 余额路由成功/凭据缺失/无 connection 降级 3 个用例。 |
| `tests/client.spec.ts` | 7 个用例：卡片开关写入与回滚、徽章默认形态与悬浮展开／收起（消费宿主 `parseUsageResponse` 真实产出）、错误文案、开关关闭时不渲染、未配置字段默认开启、关闭后开关同步与恢复、徽章进度条与百分比及固定图标状态切换、徽章与面板的拖拽门控与拖拽点击抑制。 |

设计过程中收敛的实现决策：`connection` 走反射窄接口（不新增依赖）、警告色使用静态琥珀 token、开关初值未知时不渲染不查询、面板用 absolute 而非 fixed。

### 11.1 实机反馈后的优化（2026-10-04）

实机验证通过后按反馈收敛了四项行为：

1. **默认开启**：未配置 `showBalanceOverlay` 即视为开启（schema 默认值与客户端缺省判断一致），新增「配置里没有该字段仍渲染」的测试守卫；
2. **固定位置**：标题栏 📌 按钮锁定／解除当前位置，固定期间禁用拖拽，状态持久化到 `localStorage`；
3. **最小化**：－ 按钮收起为徽章，只显示 5 小时窗口剩余额度百分比，点击徽章恢复，状态持久化且收起期间继续刷新；
4. **关闭即同步开关**：× 按钮改写插件配置 `showBalanceOverlay=false`，与卡片开关共用 `writeOverlayEnabled`（每次写入前重读 revision），移除了原先的 sessionStorage 会话关闭机制与「开关开却不显示」的分叉状态。

**尚未实机验证**（本机 `web` profile 中该插件条目当前为 `disabled: true`，因此无法在运行中的 GUI 直接观察）：

1. 真实 DSH 宿主中 `describe()` 是否回传 `showBalanceOverlay`，以及 `settings.mutate` 的 revision 并发行为；
2. 真实 OpenCode Go 密钥下的 `/zen/go/v1/usage` 响应与悬浮窗渲染（含 403 无订阅场景）；
3. Electron 桌面端的 fetch 桥接与悬浮窗表现；
4. 面板在窄窗口下的拖拽钳制与位置恢复。

### 11.2 第二轮反馈（2026-10-04）

1. **徽章展示用量本身**：最小化徽章由「剩余额度文字」改为「5 小时进度条 + 已用百分比」，与完整面板同一取整、钳制与配色规则；
2. **徽章保留固定能力**：徽章主体与固定按钮拆成两个并列按钮，固定/取消固定在最小化状态下同样可用；
3. **悬浮临时展开**：最小化时悬浮徽章展开全部内容、移出收回，展开不改变持久的最小化状态；判定绑在常驻锚点上以避免抖动。

### 11.3 第三轮反馈（2026-10-04）

1. **徽章未固定时可拖动**：整块拖拽绑在锚点上，且真正移动过的拖拽会抑制随后的点击，避免「调整位置」被识别为「点击展开」；
2. **去掉最小化按钮**：既然悬浮已经能预览全部内容，收起改由鼠标移开自动完成（已与用户确认）；随之移除了持久的最小化状态；
3. **矢量图钉图标**：以与当前颜色一致的内联 SVG 取代 emoji 图钉，实心表示已固定、空心表示未固定；
4. **固定默认关闭**：测试断言无 `localStorage` 键、`aria-pressed=false`、图标为空心。

### 11.4 拖动失效修复（2026-10-04）

实机反馈「悬浮窗没法拖动改变位置」，根因是 §4.4.3 引入常驻锚点后的一处回归：

- 拖拽处理器仍按旧结构用 `event.currentTarget.parentElement` 取面板元素，再读 `panel.offsetParent` 作为 frame。锚点本身是 `position: absolute`，于是面板的 `offsetParent` 解析到锚点自身，`frameRect` 等于面板自身尺寸，可用范围 `maxX/maxY` 被钳制为 0——拖动时锚点被强制落到 `(0,0)`（frame 左上角），表现为完全拖不动。
- 修复：拖拽处理器改为只绑在锚点上（面板标题栏与内容区的 `pointerdown` 冒泡到锚点），`currentTarget` 恒为锚点，`offsetParent` 恢复为 frame；标题栏不再单独绑定，避免 `currentTarget` 变成标题栏。
- 回归守卫：拖拽测试用「锚点位置 100 + 指针位移 60 → 断言 `left === 160`」；若钳制再次发生，结果为 0 而断言失败。测试同时覆盖"面板内容区也可拖动"与拖拽期不收起。
- 顺带在面板与徽章样式上加 `userSelect: none` 与 `touchAction: none`，整块可拖不会选中文字或触发触摸滚动。

### 11.5 顶部拖动拖走窗口的修复与固定展开／尺寸调整（2026-10-04）

实机反馈两项：

1. **悬浮窗移到顶部后，鼠标 hover 展开再拖动，整个界面跟着拖动**；
2. **需要「固定展开」按钮，且展开面板要能调整大小，并有最大／最小尺寸限制。**

#### 11.5.1 根因（问题 1）

宿主 macOS/Electron 的窗口拖动只有声明式 app-region 一条通道（`packages/client/web/src/window-drag/` 下没有指针事件实现；已安装 app 的 `app.asar` 中同样只有 `[data-platform=darwin] [data-window-drag]` 与 `[data-window-drag-recall]` 规则，无 JS 拖动）：

- Electron 把 `-webkit-app-region` 盒子按**几何 + DOM 顺序**合成，`drag` 加几何、`no-drag` 减几何，**最后一个包含该点的盒子决定**（`window-drag/regions.ts`）；
- 宿主在 `base.css` 里只对 `button`、`a`、`input`、`[role='dialog']`、`[tabindex]` 等交互元素减除 drag；
- 悬浮窗锚点此前**没有**声明任何 app-region，而面板是 `role="region"`（不在减除列表里），因此它本身不贡献任何 no-drag 盒子；
- 悬浮窗移到顶部后与 `data-window-drag` 行（对话头、侧栏 logo 行／顶部条）几何重叠，展开又进一步扩大重叠区域：在面板正文按下时，最后的 drag 盒子仍是窗口拖拽行 → Electron 开始原生拖窗，同时我们的 JS 也在移动面板，表现为「整个界面被拖动」。

#### 11.5.2 修复

- **锚点声明 `WebkitAppRegion: 'no-drag'`**：锚点是悬浮窗最外层定位元素，其盒子覆盖徽章与面板；`shell.overlay` 层在所有列之后渲染，锚点在文档顺序上晚于任何 drag 行，因此能整体压过它们。（面板内部的 `button` 仍由宿主规则各自减除。）
- **几何变化时补拖拽区重算脉冲**：app-region 只在挂载时变化一次，而 Electron 只在计算值变化时重新收集拖拽矩形（electron#32341），所以展开、移动、调整大小、数据行数变化都会让新几何落回旧拖拽矩形。组件在 `[expanded, pos, size, envelope]` 变化时调用 `pulseWindowDragRecall()`：仅在 `dataset.platform === 'darwin'` 时先写 body 的 `data-window-drag-recall`、下一帧清除（先写后清＝两次计算值变化），与宿主 `window-drag/recall.ts` 同一机制；同一时刻最多一次脉冲，脉冲属性本身的变更也被宿主的 `touchesRows` 忽略，不会自激。
- **回归守卫**：`tests/client.spec.ts` 断言锚点样式含 `WebkitAppRegion: 'no-drag'`、挂载后 body 出现 `data-window-drag-recall` 且 `flushFrames()` 后清除、`hover()` 展开后再次出现；`win32` 平台不写该标记。分别移除 no-drag 声明或脉冲副作用，该用例都会失败（已实测）。

#### 11.5.3 固定展开与尺寸调整（问题 2）

- **固定展开**：新增 `localStorage` 键 `opencode-go-live.overlay.expanded`（`OVERLAY_EXPANDED_KEY`）与标题栏／徽章上的同一按钮；展开形态改为 `hovered || expandPinned`，因此固定展开期间指针移开不再收起。图标沿用「实心＝已固定」的矢量语言（`aria-pressed` 同步），与「固定位置」互不影响。
- **尺寸调整**：右下角手柄（`role="separator"` + `tabIndex`，可聚焦）按下时 `stopPropagation`，避免与锚点的移动拖拽同时生效；起点取 `resizeOrigin`（未调整过＝默认宽度 264 + 面板实测高度），位移经 `clampOverlaySize` 收敛为 **最小 200×120、最大 480×520**，并按视口减去 `OVERLAY_VIEWPORT_MARGIN`(24)（视口过小时以下限为准，区间不反转）；松手写 `opencode-go-live.overlay.size`。面板改为 `box-sizing: border-box`，使写入的宽高与 `getBoundingClientRect` 同坐标系，首次拖动不跳变；高度固定后仅内容区滚动。键盘方向键按 `OVERLAY_RESIZE_STEP`(16) 走同一套起点与钳制。
- **默认宽度语义变化**：面板由 content-box 改为 border-box，`width: 264` 现在是面板的实际外框宽度（此前含内边距约 289px），与设计文档「宽 264px」一致。
- **顺带修复隐藏期间的悬浮态残留**：开关关闭时锚点卸载，`mouseleave` 不会再补上，原先 `hovered` 会保持 `true`，重新打开开关就让面板直接停在展开形态、而「固定展开」图标显示未固定。现在读到开关为关时同时把 `hovered` 复位，重新打开开关先回到徽章；回归守卫加在既有「关闭按钮写入配置」用例中。

#### 11.5.4 实机验收与仍未验证项

**已由用户在 DSH 桌面端 profile（手工同步的客户端 bundle）手动验收**：悬浮窗移到顶部后 hover 展开再拖动不再带走窗口，固定展开与右下角手柄调整大小可用。

仍未验证（离线测试不覆盖）：

1. 拖拽区重算脉冲是否在每次几何变化后都足以让 Electron 重算（当前验收通过不等于时序在所有窗口尺寸下都成立）；
2. 手柄在真实指针设备上的手感与最小／最大尺寸的可用性；
3. 面板调整到最大尺寸后与下方元素（设置页、终端面板）的视觉遮挡关系；
4. `win32` 平台的窗口拖拽行为（宿主的重算脉冲只按 darwin 生效）。
