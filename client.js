/** Web 客户端入口：随插件包加载，在 Models 页添加供应商卡片。 */
window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-llm-opencode-go-live',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'llm-opencode-go-live'
    const ROUTE = 'opencode-go-live'
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
    const copy = {
      zh: {
        title: 'OpenCode Go (Live)', key: 'API Key', configured: 'API 密钥已配置',
        missing: 'API 密钥缺失', edit: '编辑', cancel: '取消', save: '应用', saved: 'API 密钥已保存',
        blank: '请输入 API Key', invalid: '请输入有效的 API Key，不要粘贴环境变量赋值行',
        settingsUnavailable: '供应商配置尚不可用', models: '个可用模型', empty: '暂无可用模型',
      },
      en: {
        title: 'OpenCode Go (Live)', key: 'API key', configured: 'API key configured',
        missing: 'API key missing', edit: 'Edit', cancel: 'Cancel', save: 'Apply', saved: 'API key saved',
        blank: 'Enter an API key', invalid: 'Enter a valid API key, not an environment assignment',
        settingsUnavailable: 'Provider settings are unavailable', models: 'available models', empty: 'No models are available yet',
      },
    }

    /** 从宿主读取凭据引用、密钥状态与当前模型目录。 */
    function readProvider(ctx, t) {
      return Promise.all([ctx.remote.settings.describe(), ctx.remote.session.modelCatalog()]).then(async ([settings, catalog]) => {
        const namespace = settings.ok ? settings.value.namespaces.find(item => item.ns === NS) : undefined
        const ref = namespace && typeof namespace.value?.apiKeyEnv === 'string'
          ? namespace.value.apiKeyEnv : null
        const credential = ref === null ? undefined : await ctx.remote.credentials.describe([ref])
        const group = catalog.ok ? catalog.value.groups.find(item => item.id === ROUTE) : undefined
        const failure = catalog.ok ? catalog.value.failures.find(item => item.id === ROUTE) : undefined
        return {
          ref,
          configured: credential?.ok ? credential.value[ref]?.configured === true : false,
          writable: credential?.ok ? credential.value[ref]?.writable !== false : false,
          models: group?.models ?? [],
          error: !settings.ok ? settings.error.message
            : ref === null ? t('settingsUnavailable')
              : credential && !credential.ok ? credential.error.message
                : !catalog.ok ? catalog.error.message : failure?.message ?? null,
        }
      })
    }

    return {
      inject: ['slots', 'locale', 'remote', 'remote.credentials', 'remote.session', 'remote.settings'],
      /** 注册仅由本插件持有的 Models 卡片与双语文案。 */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('opencodeGoLive', copy))

        /** 在卡片挂载期间读取目录；密钥始终只写入凭据服务。 */
        function LiveProviderCard({ t }) {
          const [view, setView] = React.useState({ ref: null, configured: false, writable: false, models: [], error: null })
          const [draft, setDraft] = React.useState('')
          const [editing, setEditing] = React.useState(false)
          const [saving, setSaving] = React.useState(false)
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

        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer', id: ROUTE, locale: 'opencodeGoLive',
        }, LiveProviderCard))
      },
    }
  },
})
