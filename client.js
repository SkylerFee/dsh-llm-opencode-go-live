/** Web 客户端入口：随插件包加载，在 Models 页添加供应商卡片，并在帧级悬浮层展示 Go 用量。 */
window.__ModuleLoader__.load({
  id: '@skylerfee/dsh-llm-opencode-go-live',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'llm-opencode-go-live'
    const ROUTE = 'opencode-go-live'
    /** 与 src/index.ts 的 BALANCE_ROUTE_PATH 平行定义：client bundle 无法 import 插件源码。 */
    const BALANCE_ROUTE = '/api/opencode-go-live/balance'
    // 悬浮窗的纯界面偏好（位置、固定、最小化）留在浏览器本地；是否展示由插件配置决定。
    const OVERLAY_POS_KEY = 'opencode-go-live.overlay.pos'
    const OVERLAY_PINNED_KEY = 'opencode-go-live.overlay.pinned'
    /** 上游按 key 限流，自动刷新保持低频。 */
    const OVERLAY_REFRESH_MS = 300_000
    const MANUAL_REFRESH_THROTTLE_MS = 10_000
    /** 拖拽结束后的这段时间内的点击视为拖拽余波，不触发展开。 */
    const DRAG_CLICK_SUPPRESS_MS = 250
    /** 最近一次拖拽移动的时间戳；徽章整块可拖，用它区分拖动与点击。 */
    let overlayDragMovedAt = 0
    const keyFormat = /^[\x21-\x7e]+$/
    const envLine = /^[A-Z][A-Z0-9_]*=[^=]/
    const cardStyle = {
      marginTop: 12, padding: '12px 14px', display: 'grid', gap: 12,
      border: '0.5px solid var(--dsw-alias-border-l4)', borderRadius: 16,
      color: 'var(--dsw-alias-label-primary)',
    }
    const inputStyle = {
      boxSizing: 'border-box', width: '100%', minHeight: 36, padding: '7px 10px',
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
    }
    const buttonStyle = {
      minHeight: 36, padding: '0 14px', border: 0, borderRadius: 18, cursor: 'pointer',
      background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)',
    }
    const editStyle = {
      marginLeft: 'auto', minHeight: 28, padding: '0 10px', cursor: 'pointer',
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 'var(--dsw-radius-sm)',
      background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
    }
    const overlayStyle = {
      width: 264, padding: '10px 12px',
      display: 'grid', gap: 8, fontSize: 12, userSelect: 'none', touchAction: 'none',
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 12,
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 6px 20px rgba(0, 0, 0, 0.16)',
    }
    const overlayTitleStyle = {
      display: 'flex', alignItems: 'center', gap: 6, cursor: 'grab', touchAction: 'none',
      fontSize: 12, fontWeight: 500,
    }
    const overlayIconButtonStyle = {
      minHeight: 22, minWidth: 22, padding: '0 6px', cursor: 'pointer', fontSize: 11,
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 6,
      background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    }
    const chipStyle = {
      padding: '5px 8px 5px 10px',
      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, userSelect: 'none', touchAction: 'none',
      border: '0.5px solid var(--dsw-alias-border-l3)', borderRadius: 999,
      background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
      boxShadow: '0 4px 14px rgba(0, 0, 0, 0.14)',
    }
    const chipMainStyle = {
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0, cursor: 'pointer',
      border: 0, background: 'transparent', color: 'inherit', font: 'inherit',
    }
    const trackStyle = {
      height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--dsw-alias-bg-layer-2)',
    }
    const copy = {
      zh: {
        title: 'OpenCode Go (Live)', key: 'API Key', configured: 'API 密钥已配置',
        missing: 'API 密钥缺失', edit: '编辑', cancel: '取消', save: '应用', saved: 'API 密钥已保存',
        blank: '请输入 API Key', invalid: '请输入有效的 API Key，不要粘贴环境变量赋值行',
        settingsUnavailable: '供应商配置尚不可用', models: '个可用模型', empty: '暂无可用模型',
        showOverlay: '显示用量悬浮窗',
        overlayTitle: 'OpenCode Go 用量', closeOverlay: '关闭用量面板', refresh: '刷新',
        restoreOverlay: '展开用量面板',
        pinOverlay: '固定位置', unpinOverlay: '解除固定',
        chipTitle: 'Go', chipPending: '…', chipFailed: '⚠',
        windowRolling: '5 小时', windowWeekly: '本周', windowMonthly: '本月',
        loading: '加载中…', updatedAtPrefix: '更新于',
        hourUnit: '小时', minuteUnit: '分', resetsSuffix: '后重置', resetsSoon: '即将重置',
        errorMissingCredential: 'API 密钥缺失，请先在上方卡片中配置',
        errorAuth: 'API 密钥无效', errorNoSubscription: '没有 OpenCode Go 订阅',
        errorNetwork: '查询失败，请稍后重试', errorUnknown: '接口响应无法解析',
      },
      en: {
        title: 'OpenCode Go (Live)', key: 'API key', configured: 'API key configured',
        missing: 'API key missing', edit: 'Edit', cancel: 'Cancel', save: 'Apply', saved: 'API key saved',
        blank: 'Enter an API key', invalid: 'Enter a valid API key, not an environment assignment',
        settingsUnavailable: 'Provider settings are unavailable', models: 'available models', empty: 'No models are available yet',
        showOverlay: 'Show usage overlay',
        overlayTitle: 'OpenCode Go usage', closeOverlay: 'Close usage panel', refresh: 'Refresh',
        restoreOverlay: 'Expand usage panel',
        pinOverlay: 'Pin position', unpinOverlay: 'Unpin position',
        chipTitle: 'Go', chipPending: '…', chipFailed: '⚠',
        windowRolling: '5-hour', windowWeekly: 'This week', windowMonthly: 'This month',
        loading: 'Loading…', updatedAtPrefix: 'Updated',
        hourUnit: 'h', minuteUnit: 'm', resetsSuffix: ' until reset', resetsSoon: 'Resetting soon',
        errorMissingCredential: 'API key missing; configure it in the card above',
        errorAuth: 'The API key is invalid', errorNoSubscription: 'No OpenCode Go subscription',
        errorNetwork: 'Query failed; try again later', errorUnknown: 'The response could not be parsed',
      },
    }
    /** 宿主 envelope 的错误码到词典键；未知码回退到通用失败文案。 */
    const errorKeys = {
      MISSING_CREDENTIAL: 'errorMissingCredential',
      AUTH: 'errorAuth',
      NO_SUBSCRIPTION: 'errorNoSubscription',
      NETWORK: 'errorNetwork',
      UNKNOWN: 'errorUnknown',
    }
    const usageWindows = [
      ['rolling', 'windowRolling'],
      ['weekly', 'windowWeekly'],
      ['monthly', 'windowMonthly'],
    ]

    function isRecord(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    }

    /** 读取布尔界面偏好；存储不可用时按未设置处理（默认不固定、不最小化）。 */
    function readFlag(key) {
      try { return window.localStorage.getItem(key) === '1' } catch { return false }
    }

    /** 写入布尔界面偏好；存储不可用只影响持久性，不影响本次会话。 */
    function writeFlag(key, value) {
      try { window.localStorage.setItem(key, value ? '1' : '0') } catch { /* 忽略不可写存储 */ }
    }

    /** 固定图标：已固定为实心图钉，未固定为空心图钉。 */
    function pinIcon(filled) {
      return h('svg', {
        width: 12, height: 12, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false',
        style: { display: 'block' },
      },
      h('circle', {
        cx: 12, cy: 9, r: 4.5,
        fill: filled ? 'currentColor' : 'none',
        stroke: 'currentColor', strokeWidth: 1.6,
      }),
      h('path', {
        d: 'M12 13.5V21', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round',
      }))
    }

    /** 刚刚发生过拖拽时忽略随后的点击，避免移动位置被当成点击展开。 */
    function draggedRecently() {
      return Date.now() - overlayDragMovedAt < DRAG_CLICK_SUPPRESS_MS
    }

    /** 校验宿主 envelope；结构不符时按不可解析处理。 */
    function isUsageEnvelope(value) {
      if (!isRecord(value)) return false
      if (value.ok === true) return isRecord(value.usage)
      if (value.ok === false) return typeof value.code === 'string'
      return false
    }

    /** 查询宿主余额路由；任何失败都收敛为 envelope，不抛出。 */
    async function queryBalance(signal) {
      try {
        const response = await fetch(BALANCE_ROUTE, { signal, headers: { accept: 'application/json' } })
        if (!response.ok) return { ok: false, code: 'NETWORK', message: '' }
        const value = await response.json()
        return isUsageEnvelope(value) ? value : { ok: false, code: 'UNKNOWN', message: '' }
      } catch {
        return { ok: false, code: 'NETWORK', message: '' }
      }
    }

    /** 读取展示开关；读不到时按默认展示，避免把配置故障放大成界面消失。 */
    async function readOverlayEnabled(ctx) {
      try {
        const settings = await ctx.remote.settings.describe()
        if (!settings.ok) return true
        const namespace = settings.value.namespaces.find(item => item.ns === NS)
        const value = namespace && namespace.value ? namespace.value.showBalanceOverlay : undefined
        return typeof value === 'boolean' ? value : true
      } catch {
        return true
      }
    }

    /**
     * 写入展示开关。
     * 卡片开关与悬浮窗关闭共用这一入口；写入前重新读取 revision，
     * 避免两个入口把对方的写标记为过期（settings-conflict）。
     * @returns 成功时 undefined；失败时返回宿主诊断消息。
     */
    async function writeOverlayEnabled(ctx, next) {
      const settings = await ctx.remote.settings.describe()
      const namespace = settings.ok ? settings.value.namespaces.find(item => item.ns === NS) : undefined
      const revision = namespace && typeof namespace.revision === 'number' ? namespace.revision : undefined
      const result = await ctx.remote.settings.mutate(NS, [
        { op: 'set', path: ['showBalanceOverlay'], value: next },
      ], revision)
      return result.ok ? undefined : result.error.message
    }

    /** 进度条配色：超限红、接近上限琥珀、其余成功色。 */
    function barColor(window) {
      if (window.status === 'rate-limited') return 'var(--dsw-alias-state-error-primary)'
      if (window.percent >= 80) return 'var(--dsw-static-amber-500)'
      return 'var(--dsw-alias-state-success-primary)'
    }

    /** 重置倒计时；无法解析时间时返回 null，由调用方隐藏该行。 */
    function resetLabel(window, t) {
      const target = typeof window.resetsAt === 'string' ? Date.parse(window.resetsAt) : Number.NaN
      if (!Number.isFinite(target)) return null
      const minutes = Math.max(0, Math.round((target - Date.now()) / 60_000))
      if (minutes >= 60) return `${Math.round(minutes / 60)}${t('hourUnit')}${t('resetsSuffix')}`
      if (minutes >= 1) return `${minutes}${t('minuteUnit')}${t('resetsSuffix')}`
      return t('resetsSoon')
    }

    /** 从宿主读取凭据引用、密钥状态、当前模型目录与展示开关。 */
    function readProvider(ctx, t) {
      return Promise.all([ctx.remote.settings.describe(), ctx.remote.session.modelCatalog()]).then(async ([settings, catalog]) => {
        const namespace = settings.ok ? settings.value.namespaces.find(item => item.ns === NS) : undefined
        const ref = namespace && typeof namespace.value?.apiKeyEnv === 'string'
          ? namespace.value.apiKeyEnv : null
        const credential = ref === null ? undefined : await ctx.remote.credentials.describe([ref])
        const group = catalog.ok ? catalog.value.groups.find(item => item.id === ROUTE) : undefined
        const failure = catalog.ok ? catalog.value.failures.find(item => item.id === ROUTE) : undefined
        const overlayValue = namespace && namespace.value ? namespace.value.showBalanceOverlay : undefined
        return {
          ref,
          configured: credential?.ok ? credential.value[ref]?.configured === true : false,
          writable: credential?.ok ? credential.value[ref]?.writable !== false : false,
          models: group?.models ?? [],
          overlayEnabled: typeof overlayValue === 'boolean' ? overlayValue : true,
          error: !settings.ok ? settings.error.message
            : ref === null ? t('settingsUnavailable')
              : credential && !credential.ok ? credential.error.message
                : !catalog.ok ? catalog.error.message : failure?.message ?? null,
        }
      })
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'remote.session', 'remote.settings'],
      /** 注册仅由本插件持有的 Models 卡片、用量悬浮窗与双语文案。 */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('opencodeGoLive', copy))

        /** 在卡片挂载期间读取目录；密钥始终只写入凭据服务。 */
        function LiveProviderCard({ t }) {
          const [view, setView] = React.useState({
            ref: null, configured: false, writable: false, models: [],
            overlayEnabled: true, error: null,
          })
          const [draft, setDraft] = React.useState('')
          const [editing, setEditing] = React.useState(false)
          const [saving, setSaving] = React.useState(false)
          const [savingOverlay, setSavingOverlay] = React.useState(false)
          const [notice, setNotice] = React.useState('')
          const [revision, setRevision] = React.useState(0)

          React.useEffect(() => {
            let active = true
            let generation = 0
            /** 后到的响应不得覆盖新的配置或目录。 */
            async function refresh() {
              const current = ++generation
              try {
                const next = await readProvider(ctx, t)
                if (active && current === generation) setView(next)
              } catch (error) {
                if (active && current === generation) setView(previous => ({ ...previous, error: String(error) }))
              }
            }
            void refresh()
            const disposers = [
              ctx.remote.$on('settings/document-updated', (ns) => { if (ns === NS) void refresh() }),
              ctx.remote.$on('credentials/reference-updated', () => { void refresh() }),
              ctx.remote.$on('llm/adapters-updated', () => { void refresh() }),
            ]
            return () => { active = false; generation++; for (const dispose of disposers) dispose() }
          }, [revision])

          /** 凭据引用变化时丢弃草稿与编辑态，避免把旧引用的密钥写进新引用。 */
          React.useEffect(() => { setEditing(false); setDraft('') }, [view.ref])

          /** 保存当前引用的密钥并重新读取状态，不回显密钥值。 */
          async function save(event) {
            event.preventDefault()
            const value = draft.trim()
            if (value.length === 0) { setNotice(t('blank')); return }
            if (!keyFormat.test(value) || envLine.test(value) || /^(['"`]).*\1$/.test(value)) {
              setNotice(t('invalid'))
              return
            }
            if (view.ref === null || !view.writable) return
            setSaving(true)
            setNotice('')
            try {
              const result = await ctx.remote.credentials.set(view.ref, value)
              if (!result.ok) { setNotice(result.error.message); return }
              setDraft('')
              setEditing(false)
              setNotice(t('saved'))
              setRevision(previous => previous + 1)
            } catch (error) {
              setNotice(String(error))
            } finally {
              setSaving(false)
            }
          }

          /** 切换展示开关：乐观更新，冲突或拒绝时回滚并显示宿主诊断。 */
          async function toggleOverlay(event) {
            const next = event.target.checked
            if (savingOverlay) return
            setView(previous => ({ ...previous, overlayEnabled: next }))
            setSavingOverlay(true)
            setNotice('')
            try {
              const message = await writeOverlayEnabled(ctx, next)
              if (message !== undefined) {
                setView(previous => ({ ...previous, overlayEnabled: !next }))
                setNotice(message)
                return
              }
              setRevision(previous => previous + 1)
            } catch (error) {
              setView(previous => ({ ...previous, overlayEnabled: !next }))
              setNotice(String(error))
            } finally {
              setSavingOverlay(false)
            }
          }

          return h('section', { 'aria-label': t('title'), style: cardStyle },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 500 } }, t('title')),
              h('code', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, ROUTE),
              h('button', {
                type: 'button', style: editStyle, disabled: saving || (!editing && !view.writable),
                onClick: () => { setDraft(''); setNotice(''); setEditing(previous => !previous) },
              }, t(editing ? 'cancel' : 'edit'))),
            editing ? h('form', { onSubmit: save, style: { display: 'flex', alignItems: 'end', gap: 8, flexWrap: 'wrap' } },
              h('label', { style: { flex: '1 1 220px', fontSize: 13 } }, t('key'),
                h('input', {
                  type: 'password', autoComplete: 'off', value: draft, style: inputStyle,
                  disabled: saving || !view.writable, 'aria-label': t('key'),
                  onChange: event => setDraft(event.target.value),
                })),
              h('button', { type: 'submit', style: buttonStyle, disabled: saving || !view.writable }, t('save'))) : null,
            h('p', { role: 'status', style: { margin: 0, fontSize: 12 } },
              view.configured ? t('configured') : t('missing')),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
              h('input', {
                type: 'checkbox', role: 'switch', checked: view.overlayEnabled,
                'aria-label': t('showOverlay'), disabled: savingOverlay,
                onChange: toggleOverlay,
              }),
              t('showOverlay')),
            notice ? h('p', { role: 'status', style: { margin: 0, fontSize: 12 } }, notice) : null,
            view.error ? h('p', { role: 'alert', style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-state-error-primary)' } }, view.error) : null,
            h('details', null,
              h('summary', { style: { cursor: 'pointer', fontSize: 13 } }, `${view.models.length} ${t('models')}`),
              view.models.length === 0
                ? h('p', { style: { fontSize: 13 } }, t('empty'))
                : h('ul', { style: { maxHeight: 220, overflow: 'auto', paddingLeft: 20, fontSize: 13 } },
                  view.models.map(model => h('li', { key: model.id },
                    h('code', null, model.id), model.name && model.name !== model.id ? ` — ${model.name}` : null))))
          )
        }

        /**
         * 帧级悬浮用量面板。
         * 展示与否由插件配置决定（未配置即默认开启）；位置、固定、最小化是浏览器本地界面偏好。
         * 关闭按钮写入插件配置，模型页开关通过 settings/document-updated 事件同步关闭。
         */
        function BalanceOverlay({ t }) {
          // null 表示配置尚未读到：此时既不渲染也不查询，避免开关关闭时闪现面板。
          const [enabled, setEnabled] = React.useState(null)
          const [envelope, setEnvelope] = React.useState(null)
          // 徽章是默认形态；鼠标悬浮时展开完整面板，移开自动收起。
          const [hovered, setHovered] = React.useState(false)
          // 拖拽期间即使指针越过锚点边界也不收起，否则拖到视口边缘会突然变成徽章。
          const [dragging, setDragging] = React.useState(false)
          const [pinned, setPinned] = React.useState(() => readFlag(OVERLAY_PINNED_KEY))
          const [pos, setPos] = React.useState(null)
          const [nonce, setNonce] = React.useState(0)
          const [lastQueryAt, setLastQueryAt] = React.useState(0)
          const [saving, setSaving] = React.useState(false)
          const [writeError, setWriteError] = React.useState('')

          React.useEffect(() => {
            let active = true
            let generation = 0
            /** 展示与否只由配置文档决定；后到的读取不得覆盖新值。 */
            async function refreshEnabled() {
              const current = ++generation
              const next = await readOverlayEnabled(ctx)
              if (!active || current !== generation) return
              setEnabled(next)
            }
            void refreshEnabled()
            const disposers = [
              ctx.remote.$on('settings/document-updated', (ns) => { if (ns === NS) void refreshEnabled() }),
            ]
            return () => { active = false; generation++; for (const dispose of disposers) dispose() }
          }, [])

          React.useEffect(() => {
            let active = true
            let generation = 0
            const controller = new AbortController()
            /** 手动刷新与自动刷新共用同一个查询入口；最小化时仍继续刷新。 */
            async function load() {
              const current = ++generation
              const next = await queryBalance(controller.signal)
              if (!active || current !== generation) return
              setLastQueryAt(Date.now())
              setEnvelope(next)
            }
            if (enabled !== true) return () => { active = false; generation++; controller.abort() }
            void load()
            const timer = setInterval(() => { void load() }, OVERLAY_REFRESH_MS)
            const disposers = [ctx.remote.$on('credentials/reference-updated', () => { void load() })]
            return () => {
              active = false
              generation++
              controller.abort()
              clearInterval(timer)
              for (const dispose of disposers) dispose()
            }
          }, [enabled, nonce])

          /** 手动刷新按节流窗口放行，避免连点打满上游限流。 */
          function requestRefresh() {
            const now = Date.now()
            if (now - lastQueryAt < MANUAL_REFRESH_THROTTLE_MS) return
            setLastQueryAt(now)
            setNonce(previous => previous + 1)
          }

          /** 关闭 = 把插件配置的展示开关写成 false，模型页开关随之同步关闭。 */
          async function closeOverlay() {
            if (saving) return
            setSaving(true)
            setWriteError('')
            try {
              const message = await writeOverlayEnabled(ctx, false)
              if (message !== undefined) { setWriteError(message); return }
              // 乐观隐藏；宿主随后广播的 settings/document-updated 会确认同一结果。
              setEnabled(false)
            } catch (error) {
              setWriteError(String(error))
            } finally {
              setSaving(false)
            }
          }

          /** 固定后位置锁定：拖拽不再生效，位置保持固定时的值。 */
          function togglePinned() {
            const next = !pinned
            setPinned(next)
            writeFlag(OVERLAY_PINNED_KEY, next)
          }

          /** 标题栏按钮上的 pointerdown 不得冒泡成拖拽。 */
          function stopDrag(event) {
            if (typeof event.stopPropagation === 'function') event.stopPropagation()
          }

          /**
           * 拖拽移动悬浮窗。
           * 处理器只绑在锚点上（面板的标题栏与内容区都冒泡到这里），因此 `currentTarget`
           * 恒为锚点；锚点同时是 `position: absolute` 的定位元素，其 `offsetParent`
           * 才是 frame。若改成取面板元素，面板的 `offsetParent` 会解析到锚点自身，
           * 可用范围被钳制为 0，表现为拖不动。
           */
          function startDrag(event) {
            if (pinned) return
            setDragging(true)
            const anchor = event.currentTarget
            const frame = anchor && anchor.offsetParent
            if (!anchor || !frame) return
            const anchorRect = anchor.getBoundingClientRect()
            const frameRect = frame.getBoundingClientRect()
            const startX = event.clientX
            const startY = event.clientY
            const maxX = Math.max(0, frameRect.width - anchorRect.width)
            const maxY = Math.max(0, frameRect.height - anchorRect.height)
            const origin = {
              x: Math.min(Math.max(0, anchorRect.left - frameRect.left), maxX),
              y: Math.min(Math.max(0, anchorRect.top - frameRect.top), maxY),
            }
            let latest = origin
            if (typeof event.preventDefault === 'function') event.preventDefault()
            const move = moveEvent => {
              latest = {
                x: Math.min(Math.max(0, origin.x + moveEvent.clientX - startX), maxX),
                y: Math.min(Math.max(0, origin.y + moveEvent.clientY - startY), maxY),
              }
              overlayDragMovedAt = Date.now()
              setPos(latest)
            }
            const finish = () => {
              setDragging(false)
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', finish)
              try { window.localStorage.setItem(OVERLAY_POS_KEY, JSON.stringify(latest)) } catch { /* 忽略不可写存储 */ }
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', finish)
            setPos(origin)
          }

          React.useEffect(() => {
            try {
              const raw = window.localStorage.getItem(OVERLAY_POS_KEY)
              if (raw === null) return
              const parsed = JSON.parse(raw)
              if (!isRecord(parsed) || typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return
              // 视口缩小后越界的位置回退到默认角落。
              if (parsed.x < 0 || parsed.y < 0) return
              if (parsed.x > window.innerWidth - 40 || parsed.y > window.innerHeight - 40) return
              setPos({ x: parsed.x, y: parsed.y })
            } catch { /* 位置只是偏好，读取失败保持默认 */ }
          }, [])

          if (enabled !== true) return null

          // 锚点常驻并承载悬浮判定与整块拖拽：徽章与面板互为内层内容，
          // 切换内容不会重建锚点，因此不会反复触发 mouseleave 造成抖动。
          const anchorStyle = { position: 'absolute', ...(pos === null ? { right: 16, bottom: 16 } : { left: pos.x, top: pos.y }) }
          const rolling = envelope !== null && envelope.ok === true ? envelope.usage.rolling : undefined
          const rollingPercent = isRecord(rolling) && typeof rolling.percent === 'number'
            ? Math.min(100, Math.max(0, Math.round(rolling.percent)))
            : null
          const pinButton = h('button', {
            type: 'button', 'aria-pressed': pinned, onPointerDown: stopDrag,
            style: {
              ...overlayIconButtonStyle,
              color: pinned ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
            },
            title: t(pinned ? 'unpinOverlay' : 'pinOverlay'), 'aria-label': t(pinned ? 'unpinOverlay' : 'pinOverlay'),
            onClick: togglePinned,
          }, pinIcon(pinned))

          if (!hovered) {
            // 徽章：5 小时窗口的进度条与用量百分比 + 固定按钮；整块可拖，鼠标进入即展开。
            return h('div', {
              style: anchorStyle,
              onMouseEnter: () => setHovered(true),
              onMouseLeave: () => { if (!dragging) setHovered(false) },
              onPointerDown: startDrag,
            },
            h('div', { 'data-opencode-go-live-overlay': 'chip', style: chipStyle },
              h('button', {
                type: 'button', style: chipMainStyle, title: t('restoreOverlay'), 'aria-label': t('restoreOverlay'),
                // 鼠标设备上悬浮已经展开；这里保留点击入口，供不支持悬浮的设备使用。
                onClick: () => { if (!draggedRecently()) setHovered(true) },
              },
              h('span', { style: { fontWeight: 500 } }, t('chipTitle')),
              h('div', { style: { ...trackStyle, width: 56 } },
                rollingPercent === null
                  ? null
                  : h('div', { style: { height: '100%', width: `${rollingPercent}%`, background: barColor(rolling), borderRadius: 2 } })),
              h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } },
                rollingPercent === null
                  ? t(envelope !== null && envelope.ok === false ? 'chipFailed' : 'chipPending')
                  : `${rollingPercent}%`)),
              pinButton))
          }

          const failed = envelope !== null && envelope.ok === false
          const rows = []
          for (const [key, label] of usageWindows) {
            const window = envelope !== null && envelope.ok === true ? envelope.usage[key] : undefined
            if (!isRecord(window) || typeof window.percent !== 'number') continue
            const percent = Math.min(100, Math.max(0, Math.round(window.percent)))
            const reset = resetLabel(window, t)
            rows.push(h('div', { key, style: { display: 'grid', gap: 4 } },
              h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
                h('span', null, t(label)),
                h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `${percent}%`)),
              h('div', { style: trackStyle },
                h('div', { style: { height: '100%', width: `${percent}%`, background: barColor(window), borderRadius: 2 } })),
              reset === null ? null : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, reset)))
          }
          const checked = envelope !== null && envelope.ok === true && typeof envelope.checkedAt === 'string'
            ? new Date(envelope.checkedAt).toLocaleTimeString()
            : null

          return h('div', {
            style: anchorStyle,
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => { if (!dragging) setHovered(false) },
            onPointerDown: startDrag,
          },
          h('section', {
            role: 'region', 'aria-label': t('overlayTitle'),
            'data-opencode-go-live-overlay': 'panel',
            style: overlayStyle,
          },
          h('div', { style: overlayTitleStyle },
            h('span', { style: { flex: 1 } }, t('overlayTitle')),
            pinButton,
            h('button', {
              type: 'button', onPointerDown: stopDrag,
              style: overlayIconButtonStyle, title: t('refresh'), 'aria-label': t('refresh'),
              onClick: requestRefresh,
            }, '⟳'),
            h('button', {
              type: 'button', onPointerDown: stopDrag, disabled: saving,
              style: overlayIconButtonStyle, title: t('closeOverlay'), 'aria-label': t('closeOverlay'),
              onClick: closeOverlay,
            }, '×')),
          failed
            ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } },
              t(Object.hasOwn(errorKeys, envelope.code) ? errorKeys[envelope.code] : 'errorUnknown'))
            : rows.length === 0
              ? h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('loading'))
              : rows,
          writeError
            ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 11 } }, writeError)
            : null,
          checked === null
            ? null
            : h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, `${t('updatedAtPrefix')} ${checked}`)))
        }

        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer', id: ROUTE, locale: 'opencodeGoLive',
        }, LiveProviderCard))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'opencode-go-live-balance', order: 100, locale: 'opencodeGoLive',
        }, BalanceOverlay))
      },
    }
  },
})
