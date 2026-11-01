/**
 * dsh-model-picker browser half. Owns the composer model selector: one trigger
 * in the composer tool row and a menu that pins favourite models on top and
 * carries a search field. Favourites live in the Host
 * (`/api/dsh-model-picker/favorites`) and are mirrored to localStorage, so the
 * Model Manager settings page and this picker share one list.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-picker',
  factory: (require) => {
    const exports = {}
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { createElement: h, useState, useEffect, useMemo, useCallback, useRef } = React

    const NS = 'dsh-model-picker'
    const STYLE_ID = 'dsh-model-picker-css'
    const FAVORITES_KEY = 'dsh-model-picker.favorites.v1'
    const FAVORITES_API = '/api/dsh-model-picker/favorites'

    const EN = {
      'trigger.loading': 'Loading models…',
      'trigger.fallback': 'Select model',
      'trigger.aria': 'Select model, current {model}',
      'menu.aria': 'Models',
      'search.placeholder': 'Search models…',
      'search.clear': 'Clear search',
      'search.empty': 'No model matches this search.',
      'favorites.title': 'Favourites',
      'favorites.add': 'Add {model} to favourites',
      'favorites.remove': 'Remove {model} from favourites',
      'effort.title': 'Effort',
      'effort.default': 'Default',
      'empty.models': 'No models available.',
      'status.loading': 'Refreshing model list…',
      'error.action': 'Model operation failed: {message}',
      'error.sessionInUse': 'This session is already in use by another running DSH instance.',
    }

    const ZH = {
      'trigger.loading': '正在加载模型…',
      'trigger.fallback': '选择模型',
      'trigger.aria': '选择模型，当前 {model}',
      'menu.aria': '模型',
      'search.placeholder': '搜索模型…',
      'search.clear': '清除搜索',
      'search.empty': '没有匹配的模型。',
      'favorites.title': '收藏',
      'favorites.add': '收藏 {model}',
      'favorites.remove': '取消收藏 {model}',
      'effort.title': '推理等级',
      'effort.default': '默认',
      'empty.models': '暂无可用模型。',
      'status.loading': '正在刷新模型列表…',
      'error.action': '模型操作失败：{message}',
      'error.sessionInUse': '当前会话已被其他正在运行的 DSH 实例占用。',
    }

    /** Fallback translator; the slot's own `t` prop wins once it is mounted. */
    function fallbackT(key, params) {
      const text = EN[key] ?? key
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (whole, name) => (params[name] === undefined ? whole : String(params[name])))
    }

    // ---------------------------------------------------------------- favourites

    const favoriteListeners = new Set()
    let favoritesCache = null
    let favoritesInflight = null

    function readLocalFavorites() {
      try {
        const raw = JSON.parse(window.localStorage.getItem(FAVORITES_KEY) ?? '[]')
        return Array.isArray(raw) ? raw.filter((entry) => typeof entry === 'string') : []
      } catch {
        return []
      }
    }

    function writeLocalFavorites(list) {
      try {
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(list))
      } catch {
        /* private mode or quota: the Host copy stays authoritative */
      }
    }

    function favoritesSnapshot() {
      return favoritesCache ?? readLocalFavorites()
    }

    function setFavorites(list) {
      favoritesCache = Array.isArray(list) ? list.filter((entry) => typeof entry === 'string') : []
      writeLocalFavorites(favoritesCache)
      for (const listener of favoriteListeners) {
        try {
          listener()
        } catch {
          /* one broken subscriber must not starve the others */
        }
      }
      return favoritesCache
    }

    /** Load the Host's list once; a failed request keeps the local copy. */
    function loadFavorites() {
      if (favoritesInflight !== null) return favoritesInflight
      favoritesInflight = fetch(FAVORITES_API, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          if (!response.ok) return favoritesSnapshot()
          const body = await response.json()
          return Array.isArray(body?.favorites) ? setFavorites(body.favorites) : favoritesSnapshot()
        })
        .catch(() => favoritesSnapshot())
        .finally(() => {
          favoritesInflight = null
        })
      return favoritesInflight
    }

    /** Add or remove one `provider/model` key: optimistic locally, then durable. */
    function toggleFavorite(key, favorite) {
      const without = favoritesSnapshot().filter((entry) => entry !== key)
      setFavorites(favorite ? [...without, key] : without)
      fetch(FAVORITES_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, favorite }),
      })
        .then(async (response) => {
          if (!response.ok) return
          const body = await response.json()
          if (Array.isArray(body?.favorites)) setFavorites(body.favorites)
        })
        .catch(() => {
          /* the optimistic list stays; the next successful write reconciles */
        })
      return favoritesSnapshot()
    }

    const favoritesKey = (provider, model) => `${provider}/${model}`

    // ---------------------------------------------------------------------- css

    const CSS = `
.msp_root{position:relative;min-width:0;display:flex}
.msp_trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:none;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:13px;line-height:20px;display:flex}.msp_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.msp_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.msp_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.msp_label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.msp_chevron{color:var(--dsw-alias-label-caption);flex:none;display:inline-flex;transition:transform .12s}
.msp_chevron.open{transform:rotate(180deg)}
.msp_menu{position:fixed;z-index:1100;display:flex;flex-direction:column;
  background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-prominent);
  border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);
  width:340px;max-width:min(420px,calc(100vw - 32px));max-height:min(420px,calc(100vh - 32px));padding:4px;
  color:var(--dsw-alias-label-primary);overflow:hidden}
.msp_searchRow{position:relative;flex:none;padding:2px}
.msp_search{box-sizing:border-box;width:100%;height:30px;border:none;border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 30px 0 9px}
.msp_search:focus{outline:none;box-shadow:inset 0 0 0 1px var(--dsw-alias-state-business-primary)}
.msp_searchClear{position:absolute;top:50%;right:6px;transform:translateY(-50%);width:20px;height:20px;
  display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:50%;
  background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;padding:0}
.msp_searchClear:hover{background:var(--dsw-alias-interactive-bg-hover)}
.msp_groups{min-height:0;overflow-y:auto;padding:2px}
.msp_groupTitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-weight:500;padding:6px 8px 2px}
.msp_row{display:flex;align-items:center;gap:2px;border-radius:var(--dsw-radius-md);min-height:32px}
.msp_row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.msp_star{flex:none;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;
  border:none;border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-caption);
  cursor:pointer;font-size:14px;line-height:1;padding:0}
.msp_star:hover{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-interactive-bg-hover)}
.msp_star.on{color:var(--dsw-alias-state-warn-label)}
.msp_pick{flex:1;min-width:0;display:flex;align-items:center;gap:6px;border:none;background:none;
  color:inherit;font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;
  padding:5px 8px 5px 0;border-radius:var(--dsw-radius-md)}
.msp_name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.msp_provider{flex:none;color:var(--dsw-alias-label-caption);font-size:11px}
.msp_check{flex:none;width:14px;color:var(--dsw-alias-label-primary);text-align:center}
.msp_status,.msp_empty{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}
.msp_error{margin:2px;padding:6px 7px;border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}
.msp_effortRow{flex:none;display:flex;align-items:center;gap:4px;flex-wrap:wrap;
  border-top:.5px solid var(--dsw-alias-border-l1);padding:6px 8px 4px;margin-top:2px}
.msp_effortTitle{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-right:2px}
.msp_effort{border:.5px solid var(--dsw-alias-border-l2);background:none;color:var(--dsw-alias-label-secondary);
  border-radius:999px;corner-shape:round;font:inherit;font-size:11px;line-height:16px;padding:1px 8px;cursor:pointer}
.msp_effort:hover{background:var(--dsw-alias-interactive-bg-hover)}
.msp_effort.on{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
`

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-model-picker'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------ picker

    // `useSyncExternalStore` demands a cached snapshot, so both the inert face and
    // the fallback state are frozen module-level values: a fresh object per call
    // re-renders forever and React tears the entry down.
    const EMPTY_STATE = Object.freeze({ current: null, groups: Object.freeze([]), status: 'ready', error: null, retainedEffort: undefined, pending: null, routable: null, failures: Object.freeze([]) })
    const noopUnsubscribe = () => () => {}
    const emptySubscribe = () => noopUnsubscribe
    const emptySnapshot = () => EMPTY_STATE

    /** One shared snapshot subscription; the fallback covers React < 18 builds. */
    const useStore = typeof React.useSyncExternalStore === 'function'
      ? (subscribe, read) => React.useSyncExternalStore(subscribe, read, read)
      : (subscribe, read) => {
        const [value, setValue] = useState(read)
        useEffect(() => subscribe(() => setValue(read())), [subscribe, read])
        return value
      }

    function useDirectoryStore(directory) {
      const subscribe = useCallback(
        (listener) => (typeof directory?.subscribe === 'function' ? directory.subscribe(listener) : noopUnsubscribe()),
        [directory],
      )
      const read = useCallback(
        () => (typeof directory?.getSnapshot === 'function' ? directory.getSnapshot() : EMPTY_STATE),
        [directory],
      )
      return useStore(subscribe, read)
    }

    function findChoice(groups, current) {
      if (current === null || current === undefined) return undefined
      for (const group of groups) {
        for (const model of group.models) {
          if (group.id === current.provider && model.id === current.model) return { group, model }
        }
      }
      return undefined
    }

    /** Filter by name (prefix first), then id; keeps the incoming order inside a bucket. */
    function rank(models, needle) {
      if (needle === '') return models
      const buckets = [[], [], []]
      for (const model of models) {
        const name = String(model.name ?? model.id).toLowerCase()
        const id = String(model.id).toLowerCase()
        const at = name.indexOf(needle)
        if (at === 0) buckets[0].push(model)
        else if (at > 0) buckets[1].push(model)
        else if (id.includes(needle)) buckets[2].push(model)
      }
      return [...buckets[0], ...buckets[1], ...buckets[2]]
    }

    function ModelPicker(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackT
      const { available, directory, load, select, locked } = props
      const state = useDirectoryStore(directory)
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [favoritesState, setFavoritesState] = useState(favoritesSnapshot)
      // The store notifies without arguments, so the listener must re-read the
      // snapshot: handing `setFavoritesState` to the Set directly would set the
      // state to `undefined` on the first star.
      const favorites = Array.isArray(favoritesState) ? favoritesState : []
      const [error, setError] = useState(null)
      const [menuPos, setMenuPos] = useState(null)
      const rootRef = useRef(null)
      const menuRef = useRef(null)
      const searchRef = useRef(null)

      useEffect(() => {
        const refresh = () => setFavoritesState(favoritesSnapshot())
        favoriteListeners.add(refresh)
        return () => favoriteListeners.delete(refresh)
      }, [])
      useEffect(() => {
        loadFavorites()
      }, [])

      const groups = Array.isArray(state.groups) ? state.groups : []
      const current = state.current ?? null
      const choice = findChoice(groups, current)
      const reasoning = choice?.model?.reasoning
      const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
      const currentEffort = current?.reasoningEffort ?? reasoning?.defaultEffort
      const loading = (state.status === 'idle' || state.status === 'loading') && groups.length === 0
      const modelName = choice?.model?.name ?? choice?.model?.id ?? (loading ? t('trigger.loading') : t('trigger.fallback'))

      const needle = query.trim().toLowerCase()
      const visible = useMemo(() => {
        const favoriteSet = new Set(favorites)
        const byKey = new Map()
        for (const group of groups) {
          for (const model of group.models) byKey.set(favoritesKey(group.id, model.id), { group, model })
        }
        const pinned = []
        for (const key of favorites) {
          const hit = byKey.get(key)
          if (hit === undefined) continue
          if (needle !== '' && rank([hit.model], needle).length === 0) continue
          pinned.push(hit)
        }
        const rest = []
        for (const group of groups) {
          const models = rank(group.models.filter((model) => !favoriteSet.has(favoritesKey(group.id, model.id))), needle)
          if (models.length > 0) rest.push({ group, models })
        }
        return { pinned, rest, count: pinned.length + rest.reduce((sum, entry) => sum + entry.models.length, 0) }
      }, [groups, favorites, needle])

      const close = useCallback(() => {
        setOpen(false)
        setQuery('')
      }, [])

      /**
       * The composer card clips its own overflow, so an absolutely positioned
       * menu is invisible. Measure the trigger and render the menu in a portal
       * anchored to it, the way the shipped selector does. The menu opens upward
       * (the composer sits at the bottom of the window) and flips downward only
       * when there is no room above.
       */
      const measure = useCallback(() => {
        const node = rootRef.current
        if (node === null || typeof node.getBoundingClientRect !== 'function') return null
        const rect = node.getBoundingClientRect()
        const width = Math.min(340, Math.max(240, window.innerWidth - 32))
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
        const above = rect.top - 16
        // Roughly the menu's own height; only used to decide which side to open on.
        const estimated = 380
        if (above < estimated && window.innerHeight - rect.bottom > above) {
          return { left, bottom: undefined, top: rect.bottom + 8, width }
        }
        return { left, bottom: Math.max(8, window.innerHeight - rect.top + 8), top: undefined, width }
      }, [])

      const show = useCallback(() => {
        try {
          load()
        } catch {
          /* the menu still renders its own empty/error state */
        }
        loadFavorites()
        setMenuPos(measure())
        setOpen(true)
      }, [load, measure])

      // A resize or a composer that moved must not leave the menu stranded.
      useEffect(() => {
        if (!open) return undefined
        const reposition = () => setMenuPos(measure())
        window.addEventListener('resize', reposition)
        window.addEventListener('scroll', reposition, true)
        return () => {
          window.removeEventListener('resize', reposition)
          window.removeEventListener('scroll', reposition, true)
        }
      }, [open, measure])

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }
        const onDown = (event) => {
          // The trigger lives outside the portaled menu, so a click on it must not
          // be treated as an outside click (that closed the menu before the click
          // could reopen it).
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return
          close()
        }
        document.addEventListener('keydown', onKey, true)
        document.addEventListener('mousedown', onDown)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          document.removeEventListener('mousedown', onDown)
        }
      }, [open, close])

      useEffect(() => {
        if (!open) return undefined
        const timer = setTimeout(() => searchRef.current?.focus(), 0)
        return () => clearTimeout(timer)
      }, [open])

      const choose = (group, model) => {
        close()
        if (current !== null && current.provider === group.id && current.model === model.id) return
        setError(null)
        const defaultEffort = model.reasoning?.defaultEffort
        Promise.resolve(select({
          provider: group.id,
          model: model.id,
          ...(defaultEffort === undefined ? {} : { reasoningEffort: defaultEffort }),
        })).then(
          (result) => {
            if (result === undefined || result === null || result === false || result.ok !== false) return
            const message = result.error?.code === 'session/writer-held'
              ? t('error.sessionInUse')
              : t('error.action', { message: `${result.error?.code ?? ''}: ${result.error?.message ?? ''}` })
            setError(message)
          },
          (failure) => setError(t('error.action', { message: failure?.message ?? String(failure) })),
        )
      }

      const chooseEffort = (effort) => {
        if (current === null) return
        Promise.resolve(select({
          provider: current.provider,
          model: current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        })).catch(() => {})
      }

      if (available === false) return null

      const row = (group, model) => {
        const key = favoritesKey(group.id, model.id)
        const starred = favorites.includes(key)
        const selected = current !== null && current.provider === group.id && current.model === model.id
        const label = model.name ?? model.id
        return h('div', { key, className: 'msp_row' },
          h('button', {
            type: 'button',
            className: starred ? 'msp_star on' : 'msp_star',
            'aria-pressed': starred,
            title: t(starred ? 'favorites.remove' : 'favorites.add', { model: label }),
            'aria-label': t(starred ? 'favorites.remove' : 'favorites.add', { model: label }),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              toggleFavorite(key, !starred)
            },
          }, starred ? '★' : '☆'),
          h('button', {
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            className: 'msp_pick',
            title: label,
            onClick: () => choose(group, model),
          },
            h('span', { className: 'msp_name' }, label),
            h('span', { className: 'msp_provider' }, group.name ?? group.id),
            h('span', { className: 'msp_check' }, selected ? '✓' : ''),
          ),
        )
      }

      /**
       * The menu, rendered into `document.body` by a portal. The composer card
       * clips overflow, so a menu living inside it is invisible; the position is
       * measured from the trigger and re-measured on resize/scroll.
       */
      const renderMenu = () => {
        const placement = menuPos === null
          ? { left: 8, bottom: 8, width: 340 }
          : {
            left: menuPos.left,
            width: menuPos.width,
            ...(menuPos.top === undefined ? { bottom: menuPos.bottom } : { top: menuPos.top }),
          }
        const body = h('div', {
          className: 'msp_menu',
          ref: menuRef,
          role: 'dialog',
          'aria-label': t('menu.aria'),
          style: placement,
        },
          h('div', { className: 'msp_searchRow' },
            h('input', {
              ref: searchRef,
              className: 'msp_search',
              type: 'search',
              role: 'searchbox',
              placeholder: t('search.placeholder'),
              'aria-label': t('search.placeholder'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                const first = visible.pinned[0]
                  ?? (visible.rest[0] === undefined ? undefined : { group: visible.rest[0].group, model: visible.rest[0].models[0] })
                if (first !== undefined) choose(first.group, first.model)
              },
            }),
            query === ''
              ? null
              : h('button', {
                type: 'button',
                className: 'msp_searchClear',
                title: t('search.clear'),
                'aria-label': t('search.clear'),
                onClick: () => {
                  setQuery('')
                  searchRef.current?.focus()
                },
              }, '✕'),
          ),
          error !== null ? h('div', { className: 'msp_error' }, error) : null,
          loading ? h('div', { className: 'msp_status' }, t('status.loading')) : null,
          h('div', { className: 'msp_groups', role: 'menu' },
            visible.pinned.length > 0
              ? h('div', { role: 'group', 'aria-label': t('favorites.title') },
                h('div', { className: 'msp_groupTitle' }, t('favorites.title')),
                visible.pinned.map((entry) => row(entry.group, entry.model)))
              : null,
            visible.rest.map((entry) => h('div', { key: entry.group.id, role: 'group', 'aria-label': entry.group.name ?? entry.group.id },
              h('div', { className: 'msp_groupTitle' }, entry.group.name ?? entry.group.id),
              entry.models.map((model) => row(entry.group, model)),
            )),
            visible.count === 0 && !loading
              ? h('div', { className: 'msp_empty', role: 'status' }, needle === '' ? t('empty.models') : t('search.empty'))
              : null,
          ),
          efforts.length > 1 && current !== null
            ? h('div', { className: 'msp_effortRow' },
              h('span', { className: 'msp_effortTitle' }, t('effort.title')),
              reasoning?.defaultEffort === undefined
                ? h('button', {
                  type: 'button',
                  className: currentEffort === undefined ? 'msp_effort on' : 'msp_effort',
                  'aria-pressed': currentEffort === undefined,
                  onClick: () => chooseEffort(undefined),
                }, t('effort.default'))
                : null,
              efforts.map((effort) => h('button', {
                key: effort.id,
                type: 'button',
                className: currentEffort === effort.id ? 'msp_effort on' : 'msp_effort',
                'aria-pressed': currentEffort === effort.id,
                title: effort.name ?? effort.id,
                onClick: () => chooseEffort(effort.id),
              }, effort.name ?? effort.id)),
            )
            : null,
        )
        if (typeof document === 'undefined') return body
        if (typeof ReactDOM.createPortal === 'function') return ReactDOM.createPortal(body, document.body)
        return body
      }

      return h('div', { className: 'msp_root', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'msp_trigger',
          // plugin-effort-slider hides "the shipped model button" by matching
          // `button[aria-haspopup="menu"]:not([data-efs-model-btn])` inside the
          // composer trailing row. Claiming that marker keeps this trigger
          // visible while the slider stays active.
          'data-efs-model-btn': '1',
          'aria-label': t('trigger.aria', { model: modelName }),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          title: modelName,
          disabled: locked === true,
          onClick: () => (open ? close() : show()),
        },
          h('span', { className: 'msp_label' }, modelName),
          h('span', { className: open ? 'msp_chevron open' : 'msp_chevron', 'aria-hidden': true }, '▾'),
        ),
        open && renderMenu(),
      )
    }

    // ------------------------------------------------------------------- mount

    /** An inert directory face, so the picker renders a stable empty state. */
    function inertFace() {
      return {
        available: false,
        directory: { subscribe: emptySubscribe, getSnapshot: emptySnapshot },
        load: () => {},
        select: () => Promise.resolve(false),
      }
    }

    exports.inject = ['locale', 'slots', 'modelDirectories', 'sessions', 'remote', 'remote.session']

    exports.apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'dsh-model-picker: dictionaries')
      ctx.effect(() => {
        ensureStyle()
        return () => {
          document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)?.remove()
        }
      }, 'dsh-model-picker: styles')

      const slots = ctx.slots
      const modelDirectories = ctx.modelDirectories
      const sessions = ctx.sessions

      // `conversation.input.model` is a single slot: registering at a lower
      // priority makes this entry its rendering occupant, so the model control
      // in the composer IS this picker — the one with search and favourites.
      // `data-efs-model-btn` keeps plugin-effort-slider from mistaking this
      // trigger for the shipped selector and hiding it (it excludes that marker).
      slots.inject('conversation.input.model', () => slots.register({
        name: 'conversation.input.model',
        priority: -1,
        locale: NS,
        inject: (sessionId) => {
          const id = typeof sessionId === 'string'
            ? sessionId
            : (sessionId !== null && typeof sessionId === 'object' && typeof sessionId.sessionId === 'string' ? sessionId.sessionId : '')
          if (id === '') return inertFace()
          try {
            const directory = modelDirectories.directoryFor(id)
            const available = sessions.subagentAddress(id) === undefined
            return {
              available,
              directory: directory.store,
              load: () => {
                if (available) directory.load().catch(() => {})
              },
              select: (selection) => (available
                ? directory.select(selection)
                : Promise.resolve({ ok: false, error: { code: 'unavailable', message: 'model selection is unavailable for addressed subagent sessions' } })),
            }
          } catch {
            return inertFace()
          }
        },
      }, ModelPicker))

      // The Model Manager settings page reads the same list through this face.
      exports.favorites = { loadFavorites, toggleFavorite, favoritesKey, FAVORITES_KEY, FAVORITES_API }
    }

    return exports
  },
})
