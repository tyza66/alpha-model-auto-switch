# @tyza66/alpha-model-auto-switch

[Alpha](https://github.com/Mutantcat-Working-Group/Alpha) 的自动模型故障转移插件。

当当前模型出现严重不可用问题时（连续失败达到阈值，或遇到 `AUTH`/`QUOTA` 等立即切换错误码），插件会自动切换到同一提供商的其他模型，并继续执行任务，不破坏任务的执行。

## 功能特性

- **自动故障转移**：检测模型调用失败并自动切换到同一提供商的备用模型
- **可配置阈值**：设置连续失败多少次后触发切换
- **致命错误检测**：遇到关键错误（认证、配额等）时立即切换
- **会话持久化**：记住每个会话中失败的模型，避免切换回去
- **用户通知**：切换模型时可选注入可见通知
- **设置面板**：从 UI 启用/禁用和配置

## 安装

```bash
npm install @tyza66/alpha-model-auto-switch
```

## 配置

可以通过 `cordis.patch.yml` 配置插件：

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

## 工作原理

1. 插件注册 `llm/stream` waterfall 监听器，观察每次模型调用
2. 当调用失败并返回致命错误码时，该模型的失败计数递增
3. 当失败计数达到阈值（或检测到立即切换错误码）时，插件会：
   - 查询该提供商可用的替代模型
   - 选择最佳替代模型（排除之前失败的模型）
   - 通过 `selectForNextRequest` 切换模型
   - 可选注入用户可见通知
4. 任务使用新模型继续执行，不破坏执行流程

## 错误码

### 致命错误码（累计达到阈值）

- `AUTH` - 认证失败
- `INVALID_CREDENTIAL` - API 密钥格式错误
- `QUOTA` - 账户配额耗尽
- `CONTEXT_WINDOW_EXCEEDED` - 超出上下文窗口
- `UNSUPPORTED_REASONING_EFFORT` - 不支持的推理强度
- `NO_ADAPTER` - 提供商没有注册的适配器
- `INVALID_MODEL_INFO` - 无效的模型元数据
- `INVALID_ADAPTER` - 无效的适配器配置
- `REGISTRATION_DISPOSED` - 适配器注册已释放

### 立即切换错误码（立即切换）

- `AUTH`
- `INVALID_CREDENTIAL`
- `QUOTA`
- `NO_ADAPTER`

## 许可证

MIT
