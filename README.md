# @tyza66/alpha-model-auto-switch

Automatic model failover plugin for [Alpha](https://github.com/Mutantcat-Working-Group/Alpha).

When the current model becomes severely unavailable (consecutive failures with fatal error codes, or immediate-switch codes like `AUTH`/`QUOTA`), the plugin automatically switches to another model from the same provider and continues the task without breaking execution.

## Features

- **Automatic failover**: Detects model failures and switches to an alternative model from the same provider
- **Configurable thresholds**: Set the number of consecutive failures before switching
- **Fatal error detection**: Immediately switch on critical errors (auth, quota, etc.)
- **Session persistence**: Remembers failed models per session to avoid switching back
- **User notifications**: Optionally injects a visible notice when switching models
- **Settings panel**: Enable/disable and configure from the UI

## Installation

```bash
npm install @tyza66/alpha-model-auto-switch
```

## Configuration

The plugin can be configured via `cordis.patch.yml`:

```yaml
- insert:
    - id: model-auto-switch
      name: '@tyza66/alpha-model-auto-switch'
      disabled: false
      config:
        enabled: true
        failureThreshold: 3
        fatalErrorCodes:
          - AUTH
          - INVALID_CREDENTIAL
          - QUOTA
          - CONTEXT_WINDOW_EXCEEDED
        immediateSwitchCodes:
          - AUTH
          - INVALID_CREDENTIAL
          - QUOTA
        maxSwitchesPerSession: 10
        switchCooldownMs: 5000
        notifyOnSwitch: true
        excludeFailedModels: true
```

## How It Works

1. The plugin registers a `llm/stream` waterfall listener that observes every model call
2. When a call fails with a fatal error code, the failure count for that model is incremented
3. When the failure count reaches the threshold (or an immediate-switch code is detected), the plugin:
   - Queries the provider for available alternative models
   - Selects the best alternative (excluding previously failed models)
   - Switches the model via `selectForNextRequest`
   - Optionally injects a user-visible notice
4. The task continues with the new model without breaking execution

## Error Codes

### Fatal Error Codes (count toward threshold)

- `AUTH` - Authentication failure
- `INVALID_CREDENTIAL` - Malformed API key
- `QUOTA` - Account quota exhausted
- `CONTEXT_WINDOW_EXCEEDED` - Context window exceeded
- `UNSUPPORTED_REASONING_EFFORT` - Unsupported reasoning effort
- `NO_ADAPTER` - No adapter registered for provider
- `INVALID_MODEL_INFO` - Invalid model metadata
- `INVALID_ADAPTER` - Invalid adapter configuration
- `REGISTRATION_DISPOSED` - Adapter registration disposed

### Immediate Switch Codes (switch immediately)

- `AUTH`
- `INVALID_CREDENTIAL`
- `QUOTA`
- `NO_ADAPTER`

## License

MIT
