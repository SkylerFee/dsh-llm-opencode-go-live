# OpenCode Go Live Balance Overlay Design (English)

- Status: implemented
- Branch: `feat/balance-overlay`
- 中文版：[opencode-go-live-balance-overlay-design.zh.md](opencode-go-live-balance-overlay-design.zh.md)

## 1. Background and goals

Add OpenCode Go subscription usage display to the `@skylerfee/dsh-llm-opencode-go-live` plugin:

1. **Floating panel**: a frame-wide floating layer showing the Go subscription's three billing windows as usage percentages with reset times;
2. **Display toggle**: a switch inside the plugin's existing Models-page provider card controls whether the overlay renders;
3. **Localization**: every new UI string enters the existing `opencodeGoLive` bilingual dictionary (zh/en); no raw literals.

Confirmed scope decisions:

- "Balance" means the **Go subscription usage allowance** (rolling/weekly/monthly percent + reset time). The Zen prepaid dollar balance has no API-key-accessible public endpoint and is out of scope.
- The toggle lives **inside the plugin's Models card** (no `settings.general.item` global row).

## 2. Data source contract

### 2.1 Upstream endpoint

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_LIVE_API_KEY>
```

Response (verified against upstream sst/opencode `dev` branch, `packages/console/app/src/routes/zen/go/v1/usage.ts`):

```jsonc
// 200
{
  "usage": {
    "rolling":  { "status": "ok" | "rate-limited", "percent": <0-100 number>, "resetsAt": "<ISO 8601>" },
    "weekly":   { ...same shape },
    "monthly":  { ...same shape }
  }
}
// 401 → { "type": "error", "error": { "type": "AuthError", "message": "..." } }
// 403 → { "type": "error", "error": { "type": "EntitlementError", "message": "OpenCode Go subscription required." } }
```

Go allowance model: the 5-hour rolling window is 20% of the monthly dollar limit, weekly 50%, monthly 100%.

### 2.2 Undocumented-endpoint risk

The endpoint does not appear in OpenCode's public documentation; it is an upstream implementation convention. Mitigations:

- The endpoint URL and response parsing live in one new module, `src/balance.ts`;
- Parsing tolerates unknown fields (drops them instead of failing), so new window fields never break existing rendering;
- an upstream change is expected to touch only `src/balance.ts`.

## 3. Overall architecture

The static plugin's two halves (no dynamic-Cordis `host.call`; a static client bundle has no such channel):

```
┌ Host half (src/) ─────────────────────────┐      ┌ Client half (client.js) ──────────────────┐
│ Config gains a top-level volatile field   │      │ shell.overlay slot → overlay component    │
│   showBalanceOverlay: boolean (default    │      │   (component renders null while off)     │
│   true)                                   │      │                                          │
│                                            │      │ fetch on mount + 5-minute polling +     │
│ ctx.inject(['connection'], child =>       │      │   manual refresh (10s throttle)           │
│   child.connection.fetch.register({       │      │                                          │
│     path: '/api/opencode-go-live/balance' │◄─────│ fetch('/api/opencode-go-live/balance')   │
│     methods: ['GET'], requestBody:        │ JSON │   same-origin; browser session cookie   │
│       'buffered',                          │      │   attaches automatically                  │
│     fetch: balanceRouteHandler }))         │      │                                          │
│                                            │      │ Toggle row inside LiveProviderCard:      │
│ balanceRouteHandler:                       │      │   read: settings.describe() ns value     │
│   ① reuse credential resolution           │      │   write: settings.mutate() single-field  │
│      (credentialRef →                     │      │   set; optimistic update +               │
│      credentials.resolve →                │      │   settings/document-updated refresh      │
│      assertUsableApiKey)                  │      │   (already subscribed)                   │
│   ② createUsageSource().fetchUsage()      │      │                                          │
│      (10s timeout AbortSignal)             │      │ All copy through ctx.locale.register's   │
│   ③ return the unified envelope (§5)      │      │   opencodeGoLive dictionary (zh/en)     │
└────────────────────────────────────────────┘      └──────────────────────────────────────────┘
```

## 4. Module design

### 4.1 `src/balance.ts` (new)

```ts
/** Upstream usage endpoint; centralized so upstream drift is a one-file change. */
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

/** Normalized view of one billing window. */
export interface UsageWindow {
  status: 'ok' | 'rate-limited'
  /** 0-100; the display layer clamps, this layer only checks finiteness. */
  percent: number
  /** Upstream ISO string; undefined when unparsable, display hides the countdown. */
  resetsAt: string | undefined
}

/** Normalized usage report; missing or invalid windows are dropped. */
export interface UsageReport {
  rolling?: UsageWindow
  weekly?: UsageWindow
  monthly?: UsageWindow
}

/** The unified envelope the host route returns to the client. */
export type UsageEnvelope =
  | { ok: true; checkedAt: string; usage: UsageReport }
  | { ok: false; code: UsageErrorCode; message: string }

export type UsageErrorCode =
  | 'MISSING_CREDENTIAL'   // host credential service absent or reference unconfigured
  | 'AUTH'                 // upstream 401
  | 'NO_SUBSCRIPTION'      // upstream 403 (no Go subscription)
  | 'NETWORK'              // network failure or timeout
  | 'UNKNOWN'              // unparsable response or all windows invalid

export interface UsageSourceOptions { baseUrl?: string; fetch?: typeof globalThis.fetch }
export interface UsageSource { fetchUsage(apiKey: string, signal: AbortSignal): Promise<UsageEnvelope> }

/** Testable narrow interface, isomorphic to createModelsSource; tests inject a fixed fetch double. */
export function createUsageSource(options?: UsageSourceOptions): UsageSource

/** Pure function: normalize an upstream HTTP status and JSON body into the envelope. */
export function parseUsageResponse(status: number, body: unknown): UsageEnvelope
```

**Parsing rules (field-level tolerance, window-level validation)**:

| Situation | Handling |
|---|---|
| `status` not `'ok'`/`'rate-limited'` | drop that window |
| `percent` not a finite number | drop that window |
| `resetsAt` not parsable by `Date.parse` | keep the window, `resetsAt: undefined` |
| all three windows invalid or non-JSON body | `{ ok: false, code: 'UNKNOWN' }` |
| HTTP 401 / 403 | `{ ok: false, code: 'AUTH' / 'NO_SUBSCRIPTION' }` (upstream message not forwarded; the client localizes) |
| fetch rejection / timeout abort | `{ ok: false, code: 'NETWORK' }` |

### 4.2 `src/index.ts` (modified)

1. **Extract shared credential resolution**: the inline resolver currently passed to `createDynamicAdapter` becomes `resolveLiveApiKey(ctx, apiKeyEnv)`, shared by the route and the adapter (behavior unchanged; the existing integration test covers the original path).
2. **Register the balance route**:

```ts
export const BALANCE_ROUTE_PATH = '/api/opencode-go-live/balance' // asserted by tests; client.js defines the parallel constant (§4.4)
const USAGE_TIMEOUT_MS = 10_000

// inside apply(), alongside the existing ctx.inject(['settings'], ...):
ctx.inject(['connection'], (child) => {
  child.effect(() => child.connection.fetch.register({
    path: BALANCE_ROUTE_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => balanceRouteHandler(child, resolvedConfig, request),
  }))
})
```

3. **balanceRouteHandler**:
   - in order: failed credential resolution → envelope `MISSING_CREDENTIAL`;
   - `createUsageSource().fetchUsage(key, AbortSignal.timeout(USAGE_TIMEOUT_MS))`;
   - serialize the envelope and return `new Response(json, { headers: { 'content-type': 'application/json' } })`; HTTP is always 200 (the `/api` bridge authenticates before the handler sees the request; unauthenticated requests get the bridge's own 401/403);
   - an unexpected handler exception → `{ ok: false, code: 'UNKNOWN' }` plus a `child.logger.warn` (**never log the API key or the upstream response body**).
4. **connection is an optional injection**: in a browser-less composition Cordis never runs the callback, no route registers, no error log (matching the existing `resolveAttachments` on-demand `ctx.get` degradation; no client exists there either).
   The implementation reads `connection` through reflective narrow interfaces (`HostFetchRoute` / `HostConnectionFace` / `ContextWithConnection`), the same posture as the existing `ctx.get('fs') as {...}`: the published package therefore needs no `@deepseek-ai/dsh-client-connection` dependency, and no pnpm major-version difference can rewrite the lockfile. The contract surface matches the official host signatures, bounded by the narrow interfaces.

### 4.3 `src/config.ts` (modified)

A new **top-level** volatile field (top-level rather than a nested `ui` group: volatile form projection of nested fields is unverified, and the top-level field is isomorphic to the existing `apiKeyEnv`, lowest risk):

```ts
export interface Config {
  apiKeyEnv: Volatile<string>
  catalog?: CatalogConfig
  /** Whether the web client renders the balance overlay; consumed only by the client, the host runtime never reads it. */
  showBalanceOverlay?: Volatile<boolean>
}

export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default('OPENCODE_GO_LIVE_API_KEY').volatile(),
  catalog: z.object({ /* unchanged */ }),
  showBalanceOverlay: z.boolean().default(true).volatile(),
})
```

`resolveConfig` grows accordingly:

- `ResolvedConfig` gains `showBalanceOverlay: boolean` (default `true`; invalid types throw `TypeError`, following the existing `nonNegativeSafeInteger` error style);
- the host `apply()` does not consume the value (the client decides rendering); resolution only guarantees validity and type convergence.

`cordis.patch.yml` gains **no field** (the schema default is already true, keeping the patch minimal; `tests/config.spec.ts` adds an assertion guarding the default).

### 4.4 `client.js` (modified)

**Parallel constants** (the client bundle cannot import `src/`; the two definitions cross-reference each other, same as the existing `NS`/`ROUTE` practice):

```js
const BALANCE_ROUTE = '/api/opencode-go-live/balance' // keep in sync with BALANCE_ROUTE_PATH in src/index.ts
const OVERLAY_POS_KEY = 'opencode-go-live.overlay.pos'
const OVERLAY_PINNED_KEY = 'opencode-go-live.overlay.pinned'      // pinned position
const OVERLAY_EXPANDED_KEY = 'opencode-go-live.overlay.expanded'  // kept expanded
const OVERLAY_SIZE_KEY = 'opencode-go-live.overlay.size'          // { width, height }
const OVERLAY_DEFAULT_WIDTH = 264   // panel width before any resize; height follows content
const OVERLAY_MIN_WIDTH = 200, OVERLAY_MIN_HEIGHT = 120   // minimum size
const OVERLAY_MAX_WIDTH = 480, OVERLAY_MAX_HEIGHT = 520   // maximum size (then clamped to the viewport)
const OVERLAY_VIEWPORT_MARGIN = 24  // margin the size cap keeps against the viewport
const OVERLAY_RESIZE_STEP = 16      // keyboard resize step
const WINDOW_DRAG_RECALL_ATTR = 'data-window-drag-recall' // host window-drag recall mark (parallel definition)
const OVERLAY_REFRESH_MS = 300_000   // 5-minute auto refresh
const MANUAL_REFRESH_THROTTLE_MS = 10_000
```

#### 4.4.1 Dictionary additions (`copy.zh` / `copy.en` paired)

| Key | zh | en |
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

The countdown composes in the component: `${n}${t('hourUnit')}${t('resetsSuffix')}` (zh: 「3 小时后重置」; en: 「3h until reset」) — no dictionary interpolation mechanism is introduced.

#### 4.4.2 New toggle row inside `LiveProviderCard`

- **Read**: `readProvider` extends to take `value.showBalanceOverlay` from the `llm-opencode-go-live` namespace of `settings.describe()` (`undefined` → treated as on).
- **Write** (toggle click):

```js
const result = await ctx.remote.settings.mutate(NS, [
  { op: 'set', path: ['showBalanceOverlay'], value: next },
], view.settingsRevision)   // revision carried from describe; guards settings-conflict
```

  - `result.ok === false` → show `result.error.message` (same presentation as the existing key-save error), roll the optimistic state back;
  - success → keep the optimistic value; the `settings/document-updated` event (NS-filtered, already subscribed) refreshes from the server view.
- The toggle row sits after the key-status row and before the model list; `role="switch"` + `aria-checked`.

#### 4.4.3 New component `BalanceOverlay`

- **Mount**: a second slot injection inside `apply()`:

```js
ctx.slots.inject('shell.overlay', () => ctx.slots.register({
  name: 'shell.overlay', id: 'opencode-go-live-balance', order: 100, locale: 'opencodeGoLive',
}, BalanceOverlay))
```

- **Toggle interaction**: the component reads the toggle view on its own (chosen over sharing card state: the overlay independently subscribes to `settings/document-updated` and calls `settings.describe()` itself, decoupled from card state; while the toggle is off it `return null` and the slot registration stays).
- **Layout** (host theme tokens throughout, light/dark adaptive):
  - `position: absolute`, default bottom-right (`right/bottom: 16px`), 264px wide (`box-sizing: border-box`, the same coordinate space as `getBoundingClientRect`); the host `shell.overlay` container is itself `position:absolute; inset:0; pointer-events:none`, and its direct children automatically get `pointer-events:auto`, so the panel follows the frame layout without extra pointer-event declarations;
  - title row: title + keep-expanded button + pin button + refresh button + close button (each button must `stopPropagation` on `pointerdown`, otherwise it bubbles into a drag);
  - three window rows: window name + progress bar (4px tall, rounded) + `${percent}%` + countdown;
  - footer: `updatedAtPrefix` + relative time;
  - bottom-right: the resize handle (16px hit area, `cursor: nwse-resize`), present only in the expanded form.
- **State colors**: `status === 'rate-limited'` → `--dsw-alias-state-error-primary`; `percent ≥ 80` → `--dsw-static-amber-500`; otherwise `--dsw-alias-state-success-primary`. The host Theme's `listTokens` output was checked: there is **no** `--dsw-alias-state-warning-*`, so the warning tier uses the static amber palette.
- **Nothing renders before the toggle is known**: the switch starts at `null` (unknown). Only a read `true` renders and queries, which avoids flashing the panel while the toggle is off and avoids a wasted upstream request.
- **Close writes the switch**: the close button writes the plugin's `showBalanceOverlay` to `false` instead of hiding locally. The card switch and the overlay close share one `writeOverlayEnabled` entry point that re-reads the revision before every write, so neither entry marks the other's write stale (`settings-conflict`); after a successful write the host's `settings/document-updated` broadcast turns the card switch off in step. The panel keeps no independent close state, so there is no "switch on but panel hidden" fork.
- **Pinned position**: one button in the title bar and on the chip toggles pinning. The icon is an inline vector pin (round head plus stem): **pinned renders filled (`fill: currentColor` in the brand color), unpinned hollow (`fill: none` in the secondary color)**, with `aria-pressed` in step; **the default is unpinned** (no `localStorage` key means unpinned). While pinned `startDrag` returns immediately, the position stays put, and the state is written to `localStorage` to survive a reload. A vector icon rather than an emoji keeps the filled/hollow distinction in the current color, lets it follow the theme, and makes it assertable in tests.
- **The chip is the default form; hover expands it**: there is no persisted minimized state and no minimize button — the default render is the chip (5-hour bar and usage percent plus a keep-expanded button and a pin button), entering the anchor expands the full panel, and leaving it collapses back. The bar and percent both take the used value, rounded and clamped to 0–100, colored by `barColor`; a placeholder appears while there is no data and a warning glyph on failure. The chip body is its own button (so devices without hover can expand) sibling to the two pin buttons, which avoids nesting a button inside another; queries and auto-refresh keep running while collapsed.
- **The anchor stays mounted**: the `div` carrying the hover handlers and the chip-wide drag stays mounted while the chip or the panel is its inner content. Binding the handlers to an element that unmounts on content switch would fire `mouseleave` at the moment of expansion and produce an expand/collapse flicker loop.
- **Interface preferences vs config**: position and pinning are browser-local interface preferences (`localStorage`); whether the control is shown is decided by the `showBalanceOverlay` plugin config. The two never share one store.
- **Dragging**: `onPointerDown` is bound **only on the anchor**; events from the chip and from the panel (title bar and content) all bubble to it, so `event.currentTarget` is always the anchor. That is a correctness requirement: the position math needs the anchor as its reference because the anchor is the `position: absolute` element, so only its `offsetParent` is the frame; taking the panel element instead resolves the panel's `offsetParent` to the anchor itself, clamping the travel range to 0 and making the control look undraggable. `pointermove` updates the position and release clamps to the viewport and writes `localStorage[OVERLAY_POS_KEY]` (`{ x, y }`). Because the whole chip is draggable while containing buttons, a drag that actually moved records a timestamp and clicks within `DRAG_CLICK_SUPPRESS_MS` (250ms) are ignored, so moving the control is never mistaken for clicking to expand. The position is read on mount and falls back to the default corner when out of bounds (after a viewport change).
- **Subtracting the anchor from the window drag geometry, with two layers of cover**:
  1. **The primary guarantee is the host's own rule**: the anchor carries `tabIndex: -1`, which makes it match the host's `base.css` interactive-element selector `html[data-platform=darwin] :is(button, a, input, …, [contenteditable='true'], [tabindex], [role='dialog'], …) { -webkit-app-region: no-drag }` (an attribute selector ignores the value, so `-1` also keeps it out of the tab order and adds no extra focus stop). That rule is maintained and verified with the host, and its presence in the installed app was confirmed in `app.asar` (`…,[contenteditable=true],[tabindex],…){-webkit-app-region:no-drag}`).
  2. **An inline declaration as the fallback**: the anchor declares both spellings, `WebkitAppRegion: 'no-drag'` and `webkitAppRegion: 'no-drag'`. Only one is used deliberately: Blink's CSSOM aliases expose only the lowercase-w `webkitAppRegion` (string-checking the installed Electron Framework binary shows lowercase `webkitTransform`/`webkitAppearance`/`webkitUserSelect` and zero capital-`Webkit*` forms), while the historical WebKit spelling is the capital W; writing both means the result never depends on one engine's alias table.
  The anchor is the overlay's outermost positioned element and its box covers both chip and panel; the `shell.overlay` layer renders after every column, so the subtracted box is later in document order than any `data-window-drag` row and overrides all of them.
- **Drag-region recall pulse**: `no-drag` changes the computed app-region value only once, at mount, and Electron re-collects drag rects only when that value changes (electron#32341), so after expanding, moving, resizing, or a data row count change the stale geometry can still hit a window drag row. Whenever any of `[expanded, pos, size, envelope]` changes the component calls `pulseWindowDragRecall()`: only when `document.documentElement.dataset.platform === 'darwin'`, it sets `data-window-drag-recall` on `document.body` and removes it on the next frame — set then clear is two computed-value changes, the same mechanism as the host's `window-drag/recall.ts` (whose comment already treats "a mounted overlay's own app-region value" as a change of its own). A different platform, a missing `document`, or a pulse that has not yet been cleared all skip it.
- **Kept expanded**: one button in the title bar and on the chip toggles "keep expanded" (`OVERLAY_EXPANDED_KEY`). The expanded form is `hovered || expandPinned`, so once on, moving the pointer away keeps the full panel, and once off the control returns to hover-expand/hover-collapse. Its icon is an inline vector too (a square frame plus an arrow, **filled = kept expanded, hollow = not**) with `aria-pressed` in step; toggling only writes `localStorage` and never touches `hovered`, so turning it off while the pointer is still over the overlay keeps it expanded until the pointer leaves. It is a separate state from pinning the position: the former decides whether the panel stays expanded, the latter whether the position can be dragged.
- **Resizable expansion**: the bottom-right handle calls `stopPropagation` on press (otherwise the anchor's move drag would start too) and then listens to `window` `pointermove`/`pointerup` exactly like the move drag; the origin size comes from `resizeOrigin` (the default width plus the measured panel height before any resize — the same coordinate space, so the first drag does not jump), and every delta is clamped by `clampOverlaySize`: minimum `200×120`, maximum `480×520` reduced against the viewport (keeping `OVERLAY_VIEWPORT_MARGIN`, and never inverting the range on a small viewport). Release writes `localStorage[OVERLAY_SIZE_KEY]` (`{ width, height }`), and mount reads and clamps it, so a hand-edited or viewport-crossing value lands inside the bounds. The handle also takes the keyboard: arrow keys resize by `OVERLAY_RESIZE_STEP` through the same origin and clamping. While resizing the panel does not collapse, just as while dragging (`onMouseLeave` checks both `dragging` and `resizing`). Once the height is fixed only the content area scrolls (`overlayBodyStyle`'s `overflow: auto`), keeping the title row and handle visible.
- **Data fetch**:

```js
async function queryBalance(signal) {
  const response = await fetch(BALANCE_ROUTE, { signal })
  if (!response.ok) return { ok: false, code: 'NETWORK', message: '' }
  const value = await response.json()
  return isUsageEnvelope(value) ? value : { ok: false, code: 'UNKNOWN', message: '' }
}
```

  - when mounted, the toggle is on, and the panel is not session-closed → query once immediately;
  - `setInterval(OVERLAY_REFRESH_MS)` (cleared in the effect disposer);
  - manual refresh button: fires only if the last query is ≥ `MANUAL_REFRESH_THROTTLE_MS` old;
  - the `credentials/reference-updated` event (subscribed by the overlay itself) → re-query (usage follows the key);
  - keep the previous data while loading (the `loading` state shows only when no data exists yet).

## 5. Host route response contract (`GET /api/opencode-go-live/balance`)

```jsonc
// success (HTTP 200)
{ "ok": true, "checkedAt": "2026-10-04T03:42:53.000Z",
  "usage": { "rolling": { "status": "ok", "percent": 37.5, "resetsAt": "..." }, ... } }
// failure (also HTTP 200; code per §4.1; message is an English diagnostic; the client localizes by code)
{ "ok": false, "code": "AUTH", "message": "llm-opencode-go-live: upstream returned 401" }
```

Security boundaries:

- the API key resolves only inside the host credential service and never appears in responses, logs, or caches;
- upstream response bodies are never logged (`balanceRouteHandler` logs only error-code-level information);
- no new persistence (the overlay position is browser localStorage, a local UI preference with no sensitive data).

## 6. Error handling matrix

| Scenario | Client presentation |
|---|---|
| credential unconfigured | `errorMissingCredential` + guidance copy (the card is right there) |
| upstream 401 | `errorAuth` |
| upstream 403 | `errorNoSubscription` |
| network failure / timeout / host route 404 (browserless deployment) | `errorNetwork` + retry button |
| unparsable response | `errorUnknown` |
| toggle write conflict (settings-conflict) | roll back the optimistic state + show the host diagnostic message |

## 7. Test plan (all offline; network sources use fixed doubles)

### 7.1 `tests/balance.spec.ts` (new)

| Case | Assertion |
|---|---|
| full three-window response | envelope `ok:true`, all window fields present |
| rolling window only | weekly/monthly absent |
| unknown `status` value | that window dropped |
| invalid `percent` (string/NaN) | that window dropped |
| non-ISO `resetsAt` | window kept, `resetsAt === undefined` |
| all windows invalid / non-JSON body | `{ ok:false, code:'UNKNOWN' }` |
| upstream 401 / 403 | `AUTH` / `NO_SUBSCRIPTION` |
| `createUsageSource` fetch throws | `NETWORK`; the double never touches the real network |

### 7.2 `tests/config.spec.ts` (extended)

| Case | Assertion |
|---|---|
| `Config({}).showBalanceOverlay.get()` | `=== true` (volatile default) |
| `resolveConfig` with explicit `false` | `=== false` |
| `resolveConfig` with an invalid type | `TypeError` |
| `cordis.patch.yml` does not mention `showBalanceOverlay` | patch stays minimal |

### 7.3 `tests/integration.spec.ts` (extended)

| Case | Assertion |
|---|---|
| plugin mounted without the connection service | no throw (optional-injection degradation) |
| fake `connection.fetch.register` captures the handler + fake credentials return a key + fetch double | handler returns 200 + envelope `ok:true` |
| fake credentials `resolve → undefined` | envelope `MISSING_CREDENTIAL` |

### 7.4 `tests/client.spec.ts` (extended)

- the fake `slots.inject` accepts both `settings.models.footer` and `shell.overlay` (assert both slot names are injected);
- the fake ctx gains `remote.settings.mutate` (capturing NS / ops / revision);
- the sandbox globals provide a `fetch` double, `localStorage`/`sessionStorage` stubs, a `document` stub (html platform mark plus body attribute access) and a `requestAnimationFrame` queue (`flushFrames()` settles it);
- cases: toggle on by default → the card renders the toggle row; clicking → `mutate` receives the `['showBalanceOverlay']` path set; a failed write → optimistic rollback; the overlay renders three window rows on hover while the toggle is on and the envelope is `ok:true` (consuming the host's real `parseUsageResponse` output); `ok:false` renders the matching error copy; the overlay renders `null` while the toggle is off; a config missing the field still renders the chip; the close button writes `showBalanceOverlay=false` and removes the control, and reopening the switch brings the chip back (no hover state survives being hidden); the chip shows the 5-hour bar and percent, its button set is the body and the two pin buttons, the pin icon is hollow by default and fills plus persists on click; chip and panel drags are both gated by pinning, and the click trailing a drag does not expand; the anchor carries `tabIndex: -1` and declares both app-region spellings as `no-drag`, and mount/expand write `data-window-drag-recall` which the next frame clears (`win32` writes nothing); the keep-expanded button holds the panel open after the pointer leaves and can be turned off again (with storage, `aria-pressed`, and icon assertions); the resize handle changes width and height by the pointer delta, clamps past the minimum and maximum sizes, persists on release, does not collapse while resizing, and an out-of-range stored size converges on mount, with the keyboard arrows going through the same clamping.

## 8. Documentation and release

- `README.md` / `README.zh.md`: a new "Balance overlay" feature section (toggle, data meaning, the `/zen/go/v1/usage` undocumented-endpoint risk note);
- `docs/usage.md` / `docs/usage.zh.md`: overlay usage instructions;
- both design documents land with the code branch;
- process: merge after `pnpm run check` passes; before release run `pnpm pack --dry-run` to confirm the artifact contains no test files or sensitive data (per [development-and-release.md](development-and-release.md)).

## 9. Risks and unverified items (must be stated at implementation handoff)

1. **The upstream endpoint is undocumented**: `/zen/go/v1/usage` was verified against the upstream dev-branch source and may drift (mitigation in §2.2).
2. ~~**`z.boolean().volatile()` chainability**~~: **verified working**. `Config({}).showBalanceOverlay.get() === true` and an explicit `false` takes effect; `tests/config.spec.ts` pins that behavior.
3. **Volatile-field settings form projection**: the plugin already sets `settings.configure({ auto: false })` and owns its card, and `mutate` writes do not depend on the auto-generated form; but the field's visibility in the `describe()` view must be verified against a real host during implementation.
4. **No real-OpenCode-Go E2E yet**: all tests are offline; live verification with a valid subscription key (real overlay rendering, the 403 case, 5-hour window rollover) is left to user acceptance.
5. **Electron desktop**: browser `fetch` to the host route goes through the IPC bridge (deliverables precedent); the overlay's desktop behavior needs a live check.
6. ~~**Theme warning-color tokens**~~: **checked and settled**: there is no `--dsw-alias-state-warning-*`; the panel uses `--dsw-static-amber-500`.

## 10. Implementation step checklist (suggested commit split)

1. `src/balance.ts` + `tests/balance.spec.ts` (pure functions and double tests first);
2. `src/config.ts` + `tests/config.spec.ts` extension (volatile default verification, front-loads risk §9.2);
3. `src/index.ts` route registration + credential-resolution extraction + `tests/integration.spec.ts` extension;
4. `client.js` toggle row + `BalanceOverlay` component + dictionary + `tests/client.spec.ts` extension;
5. `README` / `docs/usage` bilingual updates;
6. full `pnpm run check` green → merge → (at release) `pnpm pack --dry-run`.

## 11. Implementation status (2026-10-04)

The code and tests have landed as designed; `tsc` builds and all 39 offline tests pass.

| File | Content |
|---|---|
| `src/balance.ts` | Endpoint constant, `UsageWindow`/`UsageReport`/`UsageEnvelope`, the `parseUsageResponse` pure function, the `createUsageSource` narrow interface. |
| `src/index.ts` | `BALANCE_ROUTE_PATH`, the extracted `resolveLiveApiKey` (shared by adapter and route), the `balanceRoute` handler, optional `ctx.inject(['connection'])` registration, the `ContextWithConnection` narrow interface. |
| `src/config.ts` | The top-level volatile field `showBalanceOverlay` (default `true`), its `resolveConfig` validation, and the `ResolvedConfig` field. |
| `client.js` | 23 dictionary keys, the card switch (`settings.mutate` + revision + optimistic rollback), and `BalanceOverlay` (three windows, dragging, close, throttled refresh, error mapping). |
| `tests/balance.spec.ts` | 9 parsing and source cases (fixed fetch double). |
| `tests/config.spec.ts` | 3 cases: default, invalid value, and the patch not repeating the default. |
| `tests/integration.spec.ts` | 3 cases: balance-route success, missing credential, and browser-less degradation. |
| `tests/client.spec.ts` | 7 cases: card switch write and rollback, the chip default form with hover expand/collapse (consuming the host's real `parseUsageResponse` output), error copy, rendering nothing while the toggle is off, a missing field still defaulting on, close-syncs-switch and recovery, the chip bar/percent with the pin icon state switch, and the drag gate plus drag-click suppression for both forms. |

Decisions settled during implementation: `connection` goes through reflective narrow interfaces (no new dependency), the warning tier uses the static amber token, an unknown toggle renders and queries nothing, and the panel is absolute rather than fixed.

### 11.1 Post-verification refinements (2026-10-04)

After live verification passed, four behaviors were refined from feedback:

1. **Default on**: a missing `showBalanceOverlay` counts as on (the schema default and the client's fallback agree), guarded by a test that renders with the field absent;
2. **Pinned position**: a title-bar 📌 button locks and unlocks the current position, disabling drag while pinned and persisting the state to `localStorage`;
3. **Minimize**: the － button collapses the panel into a chip showing only the 5-hour window's remaining allowance; clicking the chip restores it, the state persists, and refreshing continues while collapsed;
4. **Close syncs the switch**: the × button rewrites the `showBalanceOverlay` config to `false` through the same `writeOverlayEnabled` helper the card uses (re-reading the revision each time), removing the former sessionStorage close mechanism and the "switch on but panel hidden" fork.

**Not yet verified against a live host** (the plugin entry in this machine's `web` profile is currently `disabled: true`, so the running GUI cannot show it):

1. Whether a real DSH host returns `showBalanceOverlay` from `describe()`, and how `settings.mutate` revision conflicts behave;
2. The `/zen/go/v1/usage` response and overlay rendering under a real OpenCode Go key (including the 403 no-subscription case);
3. Electron desktop fetch bridging and overlay behavior;
4. Drag clamping and position restore in a narrow window.

### 11.2 Second feedback round (2026-10-04)

1. **The chip shows usage itself**: the minimized chip changed from remaining-allowance text to the 5-hour bar plus used percent, sharing the full panel's rounding, clamping, and coloring;
2. **Pinning stays available while minimized**: the chip body and the pin button are two sibling buttons, so pin/unpin works in the minimized state too;
3. **Hover preview**: hovering the minimized chip expands everything and leaving collapses it, without changing the persisted minimized state; the handlers sit on a permanently mounted anchor to avoid flicker.

### 11.3 Third feedback round (2026-10-04)

1. **The chip is draggable while unpinned**: the chip-wide drag lives on the anchor, and a moved drag suppresses the trailing click so repositioning is never read as expanding;
2. **No minimize button**: hover already previews everything, so collapsing is driven by the mouse leaving (confirmed with the user); the persisted minimized state was removed with it;
3. **Vector pin icon**: an inline SVG pin replaces the emoji — filled means pinned, hollow means unpinned, following the current color;
4. **Pinning defaults to off**: asserted in tests (no `localStorage` key, `aria-pressed=false`, hollow icon).

### 11.4 Drag regression fix (2026-10-04)

Live feedback reported "the overlay cannot be dragged to a new position", whose root cause was a regression introduced with the always-mounted anchor in §4.4.3:

- The drag handler still used the old structure's `event.currentTarget.parentElement` to reach the panel and then read `panel.offsetParent` as the frame. Because the anchor is `position: absolute`, the panel's `offsetParent` resolves to the anchor itself, so `frameRect` equalled the panel's own size and `maxX/maxY` clamped to 0 — a drag forced the anchor to `(0,0)` (the frame's top-left corner) and looked like nothing could be dragged.
- Fix: the drag handler is bound only on the anchor (panel title-bar and content `pointerdown` bubble to it), so `currentTarget` is always the anchor and `offsetParent` is the frame again; the title bar no longer binds its own handler, which would otherwise make `currentTarget` the title bar.
- Regression guard: the drag test uses "anchor at 100 + pointer delta 60 → assert `left === 160`"; if clamping returns, the result is 0 and the assertion fails. The same test covers dragging from the panel content and the no-collapse-during-drag rule.
- `userSelect: none` and `touchAction: none` were added to the panel and chip styles so whole-surface dragging never selects text or triggers touch scrolling.

### 11.5 Dragging from the top moving the window, plus keep-expanded and resizing (2026-10-04)

Live feedback reported two things:

1. **After moving the overlay to the top, hovering to expand and then dragging moved the whole interface instead of only the overlay.**
2. **A "keep expanded" button is needed, and the expanded panel must be resizable with minimum and maximum size limits.**

#### 11.5.1 Root cause (issue 1)

The host's macOS/Electron window dragging has exactly one channel — declarative app-regions (there is no pointer-event implementation under `packages/client/web/src/window-drag/`; the installed app's `app.asar` likewise carries only the `[data-platform=darwin] [data-window-drag]` and `[data-window-drag-recall]` rules, with no JS dragging):

- Electron composes `-webkit-app-region` boxes by **geometry plus DOM order**: `drag` adds geometry, `no-drag` subtracts it, and **the last box containing the point decides** (`window-drag/regions.ts`);
- the host's `base.css` subtracts drag only for interactive elements: `button`, `a`, `input`, `[role='dialog']`, `[tabindex]`, and so on;
- the overlay anchor previously declared no app-region at all, and the panel is `role="region"` (not in that list), so the overlay contributed no no-drag box;
- once moved to the top, the overlay geometrically overlaps `data-window-drag` rows (the conversation header, the sidebar logo row/top strip), and expanding widens that overlap: pressing on the panel body leaves the last containing box a window drag row, so Electron starts a native window drag while our JS also moves the panel — the whole interface moves.

#### 11.5.2 The fix

- **The anchor declares `WebkitAppRegion: 'no-drag'`**: the anchor is the outermost positioned element of the overlay and its box covers both chip and panel; the `shell.overlay` layer renders after every column, so the anchor is later in document order than any drag row and overrides them all. (Buttons inside the panel are still subtracted individually by the host's own rule.)
- **A recall pulse on every geometry change**: app-region changes once at mount, and Electron re-collects drag rects only when the computed value changes (electron#32341), so expanding, moving, resizing, or a row-count change leaves the new geometry matching the old drag rects. Whenever `[expanded, pos, size, envelope]` changes the component calls `pulseWindowDragRecall()`: only when `dataset.platform === 'darwin'` it sets `data-window-drag-recall` on the body and clears it on the next frame (set then clear = two computed-value changes), the same mechanism as the host's `window-drag/recall.ts`; at most one pulse is in flight, and the host's `touchesRows` ignores the mark's own attribute write, so the pulse cannot re-arm itself.
- **Regression guard**: `tests/client.spec.ts` asserts the anchor style carries `WebkitAppRegion: 'no-drag'`, that mount puts `data-window-drag-recall` on the body where `flushFrames()` then clears it, and that `hover()` re-arms it; `win32` writes nothing. Removing either the no-drag declaration or the pulse effect makes that test fail (verified).

#### 11.5.3 Keep-expanded and resizing (issue 2)

- **Keep expanded**: a new `localStorage` key `opencode-go-live.overlay.expanded` (`OVERLAY_EXPANDED_KEY`) and one button in the title bar and on the chip; the expanded form became `hovered || expandPinned`, so while it is on the panel no longer collapses when the pointer leaves. The icon keeps the "filled = on" vector language (with `aria-pressed` in step) and is independent of pinning the position.
- **Resizing**: the bottom-right handle (`role="separator"` plus `tabIndex`, focusable) calls `stopPropagation` on press so it never also starts the anchor's move drag; the origin comes from `resizeOrigin` (default width 264 plus the measured panel height before any resize) and each delta is clamped by `clampOverlaySize` to **minimum 200×120 and maximum 480×520**, further reduced against the viewport by `OVERLAY_VIEWPORT_MARGIN` (24) while never inverting the range on a small viewport; release writes `opencode-go-live.overlay.size`. The panel became `box-sizing: border-box` so the written width and height share the coordinate space of `getBoundingClientRect` and the first drag does not jump; once the height is fixed only the content area scrolls. The keyboard arrows resize by `OVERLAY_RESIZE_STEP` (16) through the same origin and clamping.
- **Default width semantics changed**: the move from content-box to border-box means `width: 264` is now the panel's actual border-box width (it was about 289px including padding), matching the "264px wide" statement in this design.
- **Hover state no longer sticks while hidden**: with the switch off the anchor unmounts, so `mouseleave` never fires and `hovered` used to stay `true`; re-opening the switch then landed on an expanded panel while the keep-expanded icon showed off. A read of the switch as off now resets `hovered` too, so re-opening starts from the chip; the regression guard lives in the existing close-button case.

#### 11.5.4 Live acceptance and what remains unverified

**Manually accepted by the user in the DSH desktop profile (with the client bundle synced by hand)**: after moving the overlay to the top, hovering to expand and then dragging no longer moves the window, and both keep-expanded and the bottom-right resize handle work.

Still unverified (the offline suite does not cover them):

1. whether the drag-region recall pulse is always enough to make Electron re-collect after every geometry change (today's acceptance does not prove the timing at every window size);
2. how the handle feels on a real pointer device and how usable the minimum/maximum sizes are;
3. how a maximally resized panel overlaps content beneath it (settings page, terminal panel);
4. window dragging on `win32`, where the host's recall pulse is darwin-only.
