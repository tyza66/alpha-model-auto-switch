// @tyza66/alpha-model-auto-switch client half — browser ModuleLoader bundle.
//
// Registers one settings section ("Model Auto-Switch") into the settings
// sidebar. The section renders:
//
//   1. A switch that turns the auto-switch on or off.
//   2. Status information about the current state.
//
// The client talks to the host half over the webserver routes it registers
// (`/api/model-auto-switch/{state,enabled}`) with plain `fetch`.

window.__ModuleLoader__.load({ id: '@tyza66/alpha-model-auto-switch', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')

  /** Slot name every settings page registers into; the sidebar lists it. */
  var SECTION_SLOT = 'settings.section'
  /** Dictionary namespace owned by this plugin. */
  var NS = 'settings.modelAutoSwitch'

  var en = {
    nav: 'Model Auto-Switch',
    title: 'Model Auto-Switch',
    intro: 'Automatically switch to another model from the same provider when the current model becomes severely unavailable.',
    enableLabel: 'Auto-Switch',
    enableHint: 'When enabled, the plugin monitors model calls and switches to an alternative model if the current one fails repeatedly.',
    on: 'On',
    off: 'Off',
    loading: 'Loading…',
    failed: 'Could not reach the host; your change was not saved.',
    saving: 'Saving…',
    savedNotice: 'Saved. Takes effect from the next round.',
    versionLabel: 'Version',
    thresholdLabel: 'Failure Threshold',
    thresholdHint: 'Number of consecutive failures before switching models.',
    maxSwitchesLabel: 'Max Switches',
    maxSwitchesHint: 'Maximum number of model switches per session.',
  }

  var zh = {
    nav: '模型自动切换',
    title: '模型自动切换',
    intro: '当当前模型严重不可用时，自动切换到同一提供商的其他模型。',
    enableLabel: '自动切换',
    enableHint: '启用后，插件会监控模型调用，在当前模型反复失败时自动切换到备用模型。',
    on: '开',
    off: '关',
    loading: '加载中…',
    failed: '无法连接 host，改动未保存。',
    saving: '保存中…',
    savedNotice: '已保存，下一轮开始生效。',
    versionLabel: '版本',
    thresholdLabel: '失败阈值',
    thresholdHint: '连续失败多少次后切换模型。',
    maxSwitchesLabel: '最大切换次数',
    maxSwitchesHint: '每个会话最多切换多少次模型。',
  }

  /**
   * POST a JSON body to a plugin route and resolve with the parsed JSON
   * response, rejecting on any non-2xx status.
   * @param {string} path - absolute plugin API path.
   * @param {object} body - object to serialize as the request body.
   * @returns {Promise<object>} parsed response payload.
   */
  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.ok ? res.json() : Promise.reject(new Error('http ' + res.status))
    })
  }

  /**
   * The auto-switch settings section.
   */
  function AutoSwitchSection(props) {
    var t = props.t
    var state = React.useState(null)
    var snapshot = state[0]
    var setSnapshot = state[1]
    var busy = React.useState(false)
    var saving = busy[0]
    var setSaving = busy[1]
    var error = React.useState('')
    var errorMessage = error[0]
    var setErrorMessage = error[1]
    var saved = React.useState(false)
    var showSaved = saved[0]
    var setShowSaved = saved[1]

    React.useEffect(function () {
      var cancelled = false

      function refresh() {
        return fetch('/api/model-auto-switch/state', { method: 'GET', headers: { accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : Promise.reject(new Error('http ' + res.status)) })
          .then(function (result) {
            if (cancelled) return null
            setSnapshot(result)
            setErrorMessage('')
            return result
          })['catch'](function () {
            if (!cancelled) setErrorMessage(t('failed'))
            return null
          })
      }

      refresh()
      var timer = setInterval(refresh, 2000)
      return function () {
        cancelled = true
        clearInterval(timer)
      }
    }, [])

    /** Flip the switch: write, then re-read what the host now holds. */
    function toggle(next) {
      setSaving(true)
      setErrorMessage('')
      setShowSaved(false)
      postJson('/api/model-auto-switch/enabled', { enabled: next })
        .then(function (result) {
          setSnapshot(result)
          setShowSaved(true)
        })['catch'](function () {
          setErrorMessage(t('failed'))
        })['finally'](function () {
          setSaving(false)
        })
    }

    if (snapshot === null && errorMessage === '') {
      return React.createElement('p', null, t('loading'))
    }

    var enabled = snapshot !== null && snapshot.enabled === true

    return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '760px' } }, [
      React.createElement('h2', { key: 'title', style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, t('title')),
      React.createElement('p', { key: 'intro', style: { margin: 0, fontSize: '13px', opacity: 0.7 } }, t('intro')),

      // The switch row.
      React.createElement('div', {
        key: 'row',
        style: {
          display: 'flex', alignItems: 'center', gap: '12px',
          padding: '12px 0', borderTop: '1px solid rgba(128,128,128,0.2)'
        }
      }, [
        React.createElement('div', { key: 'text', style: { flex: 1, minWidth: 0 } }, [
          React.createElement('div', { key: 'label', style: { fontSize: '13px', fontWeight: 500 } }, t('enableLabel')),
          React.createElement('div', { key: 'hint', style: { fontSize: '12px', opacity: 0.6, marginTop: '2px' } }, t('enableHint'))
        ]),
        React.createElement('button', {
          key: 'btn',
          type: 'button',
          role: 'switch',
          'aria-checked': enabled ? 'true' : 'false',
          disabled: saving,
          onClick: function () { toggle(!enabled) },
          style: {
            flex: 'none', cursor: saving ? 'default' : 'pointer', font: 'inherit',
            fontSize: '13px', padding: '5px 14px', borderRadius: '8px',
            border: '1px solid rgba(128,128,128,0.3)',
            background: enabled ? 'rgba(60,160,90,0.16)' : 'transparent',
            color: 'inherit'
          }
        }, saving ? t('saving') : (enabled ? t('on') : t('off')))
      ]),

      // Status lines
      snapshot !== null && React.createElement('div', {
        key: 'status',
        style: {
          display: 'flex', flexDirection: 'column', gap: '8px',
          padding: '12px 0', borderTop: '1px solid rgba(128,128,128,0.2)'
        }
      }, [
        React.createElement('div', { key: 'threshold', style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', opacity: 0.7 } }, [
          React.createElement('span', null, t('thresholdLabel') + ': ' + snapshot.failureThreshold)
        ]),
        React.createElement('div', { key: 'maxSwitches', style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px', opacity: 0.7 } }, [
          React.createElement('span', null, t('maxSwitchesLabel') + ': ' + snapshot.maxSwitchesPerSession)
        ])
      ]),

      showSaved
        ? React.createElement('p', { key: 'saved', role: 'status', style: { margin: 0, fontSize: '12px' } }, t('savedNotice'))
        : null,
      errorMessage !== ''
        ? React.createElement('p', { key: 'error', role: 'status', style: { margin: 0, fontSize: '12px', color: '#d64545' } }, errorMessage)
        : null,

      // Footer: the bundle version
      snapshot !== null && snapshot.version
        ? React.createElement('p', { key: 'version', style: { margin: '16px 0 0', fontSize: '11px', opacity: 0.45 } },
            t('versionLabel') + ' ' + snapshot.version)
        : null
    ])
  }

  /**
   * Mount the settings section.
   * @param ctx - the browser plugin context.
   */
  function apply(ctx) {
    var t = ctx.locale.bind(NS)
    ctx.effect(
      function () {
        return ctx.locale.register(NS, { zh: zh, en: en })
      },
      'model-auto-switch: section dictionaries'
    )
    ctx.slots.inject(SECTION_SLOT, function () {
      return ctx.slots.register(
        {
          name: SECTION_SLOT,
          id: 'model-auto-switch',
          order: 100,
          label: function () { return t('nav') },
          locale: NS
        },
        function (slotProps) {
          return React.createElement(AutoSwitchSection, {
            t: t,
            close: slotProps.close
          })
        }
      )
    })
  }

  var inject = ['slots', 'locale']

  exports.apply = apply
  exports.inject = inject
  return module.exports
}})
