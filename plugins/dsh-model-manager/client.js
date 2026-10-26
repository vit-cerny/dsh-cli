/**
 * dsh-model-manager browser half. A Settings → Model Manager page that imports
 * models, providers, keys and OAuth logins from other harnesses and manages what
 * DSH then serves. Secrets only ever appear as the redacted hints the Host sends.
 */
window.__ModuleLoader__.load({
  id: 'dsh-import-models',
  factory: (require) => {
    const exports = {}
    const React = require('react')
    const { createElement: h, useState, useEffect, useCallback, useMemo } = React

    const NS = 'dsh-model-manager'
    const STYLE_ID = 'dsh-model-manager-css'

    const ZH = {
      'nav.label': '模型导入',
      'page.title': '模型导入与外部凭据',
      'page.intro': '把其他 agent 工具里的模型、提供方、API Key 与 OAuth 登录导入 DSH，并在下方管理。密钥只以脱敏提示显示。',
      'action.rescan': '重新扫描',
      'action.preview': '预览计划',
      'action.importSelected': '导入所选',
      'action.import': '导入',
      'action.selectAll': '全选',
      'action.clear': '清空',
      'action.disable': '停用',
      'action.enable': '启用',
      'action.models': '模型',
      'action.remove': '移除',
      'action.addRoute': '添加提供方',
      'state.loading': '读取中…',
      'state.error': '出错了',
      'state.empty': '没有可导入的配置。',
      'state.notFound': '未找到',
      'state.noModels': '未声明模型',
      'state.plan': '导入计划',
      'state.routes': 'DSH 当前提供方',
      'state.records': '已保存的 OAuth 凭据',
      'state.imported': '导入完成',
      'state.modelSearch': '搜索模型…',
      'kind.provider': 'API 提供方',
      'kind.oauth': 'OAuth 登录',
      'kind.env': '.env 文件',
      'col.models': '模型',
      'col.protocol': '协议',
      'col.endpoint': '端点',
      'col.credential': '凭据',
      'form.route': '路由 ID',
      'form.displayName': '显示名称',
      'form.baseURL': '端点地址',
      'form.api': '协议',
      'form.models': '模型 ID（逗号分隔）',
      'form.apiKey': 'API Key（可留空稍后设置）',
      'form.cancel': '取消',
      'form.save': '保存',
    }

    const EN = {
      'nav.label': 'Model Manager',
      'page.title': 'Models & foreign credentials',
      'page.intro': 'Import the models, providers, API keys and OAuth logins held by other agent tools into DSH, then manage them below. Secrets only ever appear as redacted hints.',
      'action.rescan': 'Rescan',
      'action.preview': 'Preview plan',
      'action.importSelected': 'Import selected',
      'action.import': 'Import',
      'action.selectAll': 'Select all',
      'action.clear': 'Clear',
      'action.disable': 'Disable',
      'action.enable': 'Enable',
      'action.models': 'Models',
      'action.remove': 'Remove',
      'action.addRoute': 'Add provider',
      'state.loading': 'Reading…',
      'state.error': 'Something went wrong',
      'state.empty': 'Nothing to import was found.',
      'state.notFound': 'not found',
      'state.noModels': 'no models declared',
      'state.plan': 'Import plan',
      'state.routes': 'Providers DSH serves',
      'state.records': 'Stored OAuth sign-ins',
      'state.imported': 'Imported',
      'state.modelSearch': 'Search models…',
      'kind.provider': 'API provider',
      'kind.oauth': 'OAuth sign-in',
      'kind.env': '.env file',
      'col.models': 'Models',
      'col.protocol': 'Protocol',
      'col.endpoint': 'Endpoint',
      'col.credential': 'Credential',
      'form.route': 'Route id',
      'form.displayName': 'Display name',
      'form.baseURL': 'Endpoint URL',
      'form.api': 'Protocol',
      'form.models': 'Model ids (comma separated)',
      'form.apiKey': 'API key (optional, can be set later)',
      'form.cancel': 'Cancel',
      'form.save': 'Save',
    }

    let t = (key) => EN[key] ?? key

    function installI18n(ctx) {
      ctx.inject(['locale'], (i18nCtx) => {
        const disposeZh = i18nCtx.locale.register(NS, 'zh', ZH)
        const disposeEn = i18nCtx.locale.register(NS, 'en', EN)
        t = i18nCtx.locale.bind(NS)
        return () => {
          disposeEn()
          disposeZh()
          t = (key) => EN[key] ?? key
        }
      })
    }

    const CSS = `
.mm_page{display:flex;flex-direction:column;gap:14px;max-width:860px;color:var(--dsw-alias-label-primary)}
.mm_title{margin:0;font-size:16px;font-weight:500;line-height:24px}
.mm_intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.mm_bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mm_spacer{flex:1}
.mm_btn,.mm_ghost{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:30px;padding:0 12px;border-radius:var(--dsw-radius-sm);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}
.mm_btn{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.mm_btn:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.mm_ghost{border:.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-primary)}
.mm_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mm_btn:disabled,.mm_ghost:disabled{opacity:.4;cursor:default}
.mm_danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent)}
.mm_small{height:26px;padding:0 9px;font-size:12px}
.mm_card{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:12px 14px;display:flex;flex-direction:column;gap:10px}
.mm_cardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mm_cardName{font-size:14px;font-weight:500;line-height:22px}
.mm_chip{flex:none;padding:1px 8px;border-radius:999px;corner-shape:round;font-size:11px;line-height:16px;color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1)}
.mm_ok{color:var(--dsw-alias-state-success-primary)}
.mm_warn{color:var(--dsw-alias-state-warn-label)}
.mm_path{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mm_rows{display:flex;flex-direction:column;gap:6px}
.mm_row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);padding:8px 10px;cursor:pointer}
.mm_row.off{opacity:.55}
.mm_rowMain{min-width:0;display:flex;flex-direction:column;gap:2px}
.mm_rowName{font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mm_meta{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mm_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mm_check{width:15px;height:15px;accent-color:var(--dsw-alias-state-business-primary)}
.mm_err{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.mm_okmsg{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}
.mm_table{width:100%;border-collapse:collapse;font-size:12px}
.mm_table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-tertiary);padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.mm_table td{padding:5px 6px;border-bottom:.5px solid var(--dsw-alias-border-l1);vertical-align:middle}
.mm_code{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px}
.mm_pre{font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);padding:10px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
.mm_form{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mm_formFull{grid-column:1/-1}
.mm_field{display:flex;flex-direction:column;gap:3px;min-width:0}
.mm_label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.mm_input{box-sizing:border-box;width:100%;height:30px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 9px}
.mm_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.mm_list{display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow:auto}
.mm_tag{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;corner-shape:round;padding:1px 8px;font-family:var(--ds-font-family-code);font-size:11px;line-height:18px}
.mm_tag.off{opacity:.5;border-style:dashed}
.mm_tagX{border:none;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:13px;line-height:1;padding:0}
.mm_tagX:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-model-manager'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const API = {
      sources: '/api/dsh-model-manager/sources',
      plan: '/api/dsh-model-manager/plan',
      import: '/api/dsh-model-manager/import',
      routes: '/api/dsh-model-manager/routes',
      toggleRoute: '/api/dsh-model-manager/route/toggle',
      removeRoute: '/api/dsh-model-manager/route/remove',
      addRoute: '/api/dsh-model-manager/route/add',
      toggleModel: '/api/dsh-model-manager/model/toggle',
      secret: '/api/dsh-model-manager/secret',
    }

    async function request(path, options) {
      const res = await fetch(path, options)
      let body = {}
      try { body = await res.json() } catch { /* non-JSON error page */ }
      if (!res.ok) {
        const error = new Error(body?.error ?? `HTTP ${res.status}`)
        error.status = res.status
        throw error
      }
      return body
    }

    const post = (path, payload) => request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    })

    function Button({ variant, small, danger, children, ...rest }) {
      const className = `${variant === 'primary' ? 'mm_btn' : 'mm_ghost'}${small ? ' mm_small' : ''}${danger ? ' mm_danger' : ''}`
      return h('button', { type: 'button', className, ...rest }, children)
    }

    function Chip({ tone, children }) {
      return h('span', { className: `mm_chip${tone === 'ok' ? ' mm_ok' : tone === 'warn' ? ' mm_warn' : ''}` }, children)
    }

    function SourceCard({ source, selected, busy, onToggle, onSelectSource, onImportSource }) {
      const items = Array.isArray(source.items) ? source.items : []
      return h('section', { className: 'mm_card' },
        h('div', { className: 'mm_cardHead' },
          h('span', { className: 'mm_cardName' }, source.label ?? source.id),
          h(Chip, null, source.id),
          items.length > 0 ? h(Chip, null, `${items.length} item${items.length === 1 ? '' : 's'}`) : null,
          source.found === false ? h(Chip, { tone: 'warn' }, t('state.notFound')) : null,
          h('span', { className: 'mm_spacer' }),
          items.length > 0 ? h(Button, { small: true, disabled: busy, onClick: () => onSelectSource(items) }, t('action.selectAll')) : null,
          items.length > 0 ? h(Button, { small: true, disabled: busy, onClick: () => onImportSource(source.id) }, t('action.import')) : null,
        ),
        source.path !== undefined ? h('div', { className: 'mm_path', title: source.path }, source.path) : null,
        (source.notes ?? []).length > 0 ? h('div', { className: 'mm_note' }, source.notes.join(' · ')) : null,
        items.length === 0
          ? h('div', { className: 'mm_note' }, t('state.empty'))
          : h('div', { className: 'mm_rows' }, items.map((item) => {
            const key = `${item.sourceId}:${item.foreignId}`
            const on = selected.has(key)
            const meta = [
              item.kind === 'oauth' ? t('kind.oauth') : item.kind === 'env' ? t('kind.env') : t('kind.provider'),
              item.protocol,
              item.baseURL,
              item.modelCount > 0 ? `${item.modelCount} ${t('col.models')}` : t('state.noModels'),
              item.hasKey ? item.keyHint : undefined,
              (item.entryNames ?? []).length > 0 ? item.entryNames.join(', ') : undefined,
            ].filter(Boolean).join('  ·  ')
            return h('label', { key, className: on ? 'mm_row' : 'mm_row off' },
              h('input', { className: 'mm_check', type: 'checkbox', checked: on, onChange: () => onToggle(key) }),
              h('span', { className: 'mm_rowMain' },
                h('span', { className: 'mm_rowName' }, item.displayName ?? item.foreignId),
                h('span', { className: 'mm_meta', title: meta }, meta),
                (item.notes ?? []).length > 0 ? h('span', { className: 'mm_note' }, item.notes.join(' · ')) : null,
              ),
            )
          })),
      )
    }

    function AddRouteForm({ busy, onCancel, onSubmit }) {
      const [form, setForm] = useState({ route: '', displayName: '', baseURL: '', api: 'openai-completions', models: '', apiKey: '' })
      const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }))
      const submit = () => onSubmit({
        route: form.route.trim(),
        displayName: form.displayName.trim() || undefined,
        baseURL: form.baseURL.trim(),
        api: form.api,
        models: form.models.split(',').map((entry) => entry.trim()).filter(Boolean),
        apiKey: form.apiKey.trim() || undefined,
      })
      const field = (label, input, full) => h('label', { className: full ? 'mm_field mm_formFull' : 'mm_field' },
        h('span', { className: 'mm_label' }, label), input)
      return h('div', { className: 'mm_card' },
        h('div', { className: 'mm_cardHead' }, h('span', { className: 'mm_cardName' }, t('action.addRoute'))),
        h('div', { className: 'mm_form' },
          field(t('form.route'), h('input', { className: 'mm_input', value: form.route, onChange: set('route'), placeholder: 'my-gateway' })),
          field(t('form.displayName'), h('input', { className: 'mm_input', value: form.displayName, onChange: set('displayName'), placeholder: 'My Gateway' })),
          field(t('form.baseURL'), h('input', { className: 'mm_input', value: form.baseURL, onChange: set('baseURL'), placeholder: 'https://gateway.example/v1' }), true),
          field(t('form.api'), h('select', { className: 'mm_input', value: form.api, onChange: set('api') },
            h('option', { value: 'openai-completions' }, 'OpenAI Chat Completions'),
            h('option', { value: 'openai-responses' }, 'OpenAI Responses'),
            h('option', { value: 'anthropic-messages' }, 'Anthropic Messages'),
          )),
          field(t('form.models'), h('input', { className: 'mm_input', value: form.models, onChange: set('models'), placeholder: 'gpt-5, claude-sonnet-5' })),
          field(t('form.apiKey'), h('input', { className: 'mm_input', type: 'password', autoComplete: 'new-password', value: form.apiKey, onChange: set('apiKey') }), true),
        ),
        h('div', { className: 'mm_bar' },
          h(Button, { variant: 'primary', disabled: busy || form.route === '' || form.baseURL === '' || form.models === '', onClick: submit }, t('form.save')),
          h(Button, { disabled: busy, onClick: onCancel }, t('form.cancel')),
        ),
      )
    }

    function ModelList({ route, busy, onToggleModel }) {
      const [query, setQuery] = useState('')
      const models = useMemo(() => {
        const rows = (route.models ?? []).map((model) => ({ id: model.id, name: model.name, enabled: true }))
        for (const id of route.disabledModels ?? []) rows.push({ id, name: undefined, enabled: false })
        const needle = query.trim().toLowerCase()
        return rows.filter((row) => needle === ''
          || String(row.id).toLowerCase().includes(needle)
          || String(row.name ?? '').toLowerCase().includes(needle))
      }, [route, query])
      return h('div', { className: 'mm_rows' },
        h('input', { className: 'mm_input', placeholder: t('state.modelSearch'), value: query, onChange: (event) => setQuery(event.target.value) }),
        h('div', { className: 'mm_list' }, models.map((model) => h('span', { key: model.id, className: model.enabled ? 'mm_tag' : 'mm_tag off' },
          h('span', { title: model.name ?? model.id }, model.id),
          h('button', {
            type: 'button',
            className: 'mm_tagX',
            title: model.enabled ? t('action.disable') : t('action.enable'),
            disabled: busy,
            onClick: () => onToggleModel(model.id, !model.enabled),
          }, model.enabled ? '×' : '+'),
        ))),
      )
    }

    function RouteRow({ route, busy, openModels, onOpenModels, onDisable, onRemove, onToggleModel }) {
      return h(React.Fragment, null,
        h('tr', null,
          h('td', null,
            h('div', { className: 'mm_code' }, route.route),
            route.displayName !== route.route ? h('div', { className: 'mm_note' }, route.displayName) : null,
          ),
          h('td', { className: 'mm_code' }, route.api),
          h('td', { className: 'mm_code', title: route.baseURL }, String(route.baseURL).length > 40 ? `${String(route.baseURL).slice(0, 40)}…` : route.baseURL),
          h('td', { className: 'mm_code' }, route.apiKeyEnv ?? '—'),
          h('td', null, h(Button, { small: true, disabled: busy, onClick: () => onOpenModels(route.route) },
            `${route.modelCount}${route.disabledModels.length > 0 ? ` (−${route.disabledModels.length})` : ''}`)),
          h('td', null, h('div', { className: 'mm_bar' },
            h(Button, { small: true, disabled: busy, onClick: () => onDisable(route.route) }, t('action.disable')),
            h(Button, { small: true, danger: true, disabled: busy, onClick: () => onRemove(route.route) }, t('action.remove')),
          )),
        ),
        openModels === route.route
          ? h('tr', null, h('td', { colSpan: 6 },
            h(ModelList, { route, busy, onToggleModel: (model, enabled) => onToggleModel(route.route, model, enabled) })))
          : null,
      )
    }

    function ManagerPage() {
      const [sources, setSources] = useState([])
      const [routesData, setRoutesData] = useState(undefined)
      const [selected, setSelected] = useState(new Set())
      const [plan, setPlan] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [toast, setToast] = useState('')
      const [openModels, setOpenModels] = useState(undefined)
      const [adding, setAdding] = useState(false)

      const load = useCallback(async () => {
        setBusy(true)
        setError('')
        try {
          const [scan, routes] = await Promise.all([request(API.sources), request(API.routes)])
          setSources(Array.isArray(scan.sources) ? scan.sources : [])
          setRoutesData(routes)
          setSelected(new Set((scan.sources ?? []).flatMap((source) => (source.items ?? []).map((item) => `${item.sourceId}:${item.foreignId}`))))
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const run = async (action) => {
        setBusy(true)
        setError('')
        setToast('')
        try {
          const message = await action()
          if (typeof message === 'string') setToast(message)
          setRoutesData(await request(API.routes))
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      const selectedSources = () => {
        const ids = new Set()
        for (const source of sources) {
          for (const item of source.items ?? []) {
            if (selected.has(`${item.sourceId}:${item.foreignId}`)) ids.add(item.sourceId)
          }
        }
        return [...ids]
      }

      const preview = () => run(async () => {
        setPlan(await post(API.plan, { sources: selectedSources() }))
      })

      const doImport = (sourceIds) => run(async () => {
        const result = await post(API.import, { sources: sourceIds ?? selectedSources() })
        setPlan(result.plan)
        return `${t('state.imported')}: ${result.wrote.routes.length} routes, ${result.wrote.refs.length + result.wrote.records.length} credentials`
      })

      const addRoute = (form) => run(async () => {
        await post(API.addRoute, {
          route: form.route,
          displayName: form.displayName,
          baseURL: form.baseURL,
          api: form.api,
          models: form.models,
          apiKey: form.apiKey,
        })
        setAdding(false)
      })

      const allKeys = sources.flatMap((source) => (source.items ?? []).map((item) => `${item.sourceId}:${item.foreignId}`))
      const routes = routesData?.routes ?? []

      return h('div', { className: 'mm_page' },
        h('h2', { className: 'mm_title' }, t('page.title')),
        h('p', { className: 'mm_intro' }, t('page.intro')),

        h('div', { className: 'mm_bar' },
          h(Button, { disabled: busy, onClick: load }, t('action.rescan')),
          h(Button, { disabled: busy, onClick: () => setSelected(new Set(allKeys)) }, t('action.selectAll')),
          h(Button, { disabled: busy, onClick: () => setSelected(new Set()) }, t('action.clear')),
          h(Button, { disabled: busy, onClick: preview }, t('action.preview')),
          h(Button, { variant: 'primary', disabled: busy || selected.size === 0, onClick: () => doImport() }, t('action.importSelected')),
          h('span', { className: 'mm_spacer' }),
          h(Button, { disabled: busy, onClick: () => setAdding((value) => !value) }, t('action.addRoute')),
        ),

        busy ? h('p', { className: 'mm_note' }, t('state.loading')) : null,
        error !== '' ? h('p', { className: 'mm_err' }, `${t('state.error')}: ${error}`) : null,
        toast !== '' ? h('p', { className: 'mm_okmsg' }, toast) : null,

        adding ? h(AddRouteForm, { busy, onCancel: () => setAdding(false), onSubmit: addRoute }) : null,

        plan !== undefined
          ? h('div', { className: 'mm_card' },
            h('div', { className: 'mm_cardHead' },
              h('span', { className: 'mm_cardName' }, t('state.plan')),
              h(Chip, null, `${plan.summary?.routes ?? 0} routes`),
              h(Chip, null, `${plan.summary?.models ?? 0} models`),
              h(Chip, null, `${plan.summary?.credentials ?? 0} credentials`),
              (plan.summary?.skipped ?? 0) > 0 ? h(Chip, { tone: 'warn' }, `${plan.summary.skipped} skipped`) : null,
            ),
            h('pre', { className: 'mm_pre' }, JSON.stringify({
              routes: Object.fromEntries(Object.entries(plan.routes ?? {}).map(([route, entry]) => [
                route,
                { api: entry.api, baseURL: entry.baseURL, apiKeyEnv: entry.apiKeyEnv, models: (entry.models ?? []).length },
              ])),
              credentials: [...(plan.refs ?? []), ...(plan.envRefs ?? [])].map((ref) => ref.ref)
                .concat((plan.records ?? []).map((record) => record.key)),
              skipped: plan.skipped ?? [],
            }, null, 2)),
          )
          : null,

        sources.map((source) => h(SourceCard, {
          key: source.id,
          source,
          selected,
          busy,
          onToggle: (key) => setSelected((current) => {
            const next = new Set(current)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          }),
          onSelectSource: (items) => setSelected((current) => {
            const next = new Set(current)
            for (const item of items) next.add(`${item.sourceId}:${item.foreignId}`)
            return next
          }),
          onImportSource: (sourceId) => doImport([sourceId]),
        })),

        h('div', { className: 'mm_card' },
          h('div', { className: 'mm_cardHead' },
            h('span', { className: 'mm_cardName' }, t('state.routes')),
            h(Chip, null, `${routes.length}`),
          ),
          routes.length === 0
            ? h('div', { className: 'mm_note' }, t('state.empty'))
            : h('table', { className: 'mm_table' },
              h('thead', null, h('tr', null,
                h('th', null, 'route'),
                h('th', null, t('col.protocol')),
                h('th', null, t('col.endpoint')),
                h('th', null, t('col.credential')),
                h('th', null, t('col.models')),
                h('th', null, ''),
              )),
              h('tbody', null, routes.map((route) => h(RouteRow, {
                key: route.route,
                route,
                busy,
                openModels,
                onOpenModels: (name) => setOpenModels((current) => (current === name ? undefined : name)),
                onDisable: (name) => run(async () => { await post(API.toggleRoute, { route: name, enabled: false }) }),
                onRemove: (name) => run(async () => {
                  await post(API.removeRoute, { route: name })
                  if (openModels === name) setOpenModels(undefined)
                }),
                onToggleModel: (name, model, enabled) => run(async () => {
                  await post(API.toggleModel, { route: name, model, enabled })
                }),
              }))),
            ),
          (routesData?.records ?? []).length > 0
            ? h('div', { className: 'mm_note' }, `${t('state.records')}: ${routesData.records.map((record) => record.key).join(', ')}`)
            : null,
          (routesData?.disabledRoutes ?? []).length > 0
            ? h('div', { className: 'mm_note' }, `disabled: ${routesData.disabledRoutes.join(', ')}`)
            : null,
        ),
      )
    }

    exports.inject = ['slots']

    exports.apply = (ctx) => {
      installI18n(ctx)
      ctx.effect(() => {
        ensureStyle()
        return () => {
          document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)?.remove()
        }
      }, 'dsh-model-manager: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-manager',
        order: 12,
        label: () => t('nav.label'),
      }, ManagerPage))
    }

    return exports
  },
})
