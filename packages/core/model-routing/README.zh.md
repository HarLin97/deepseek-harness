# @deepseek-ai/dsh-model-routing

[English](README.md) | 中文

三档模型路由（主 Agent / 子代理 / 视觉）以 `model-routing` Settings 命名空间承载。插件在组合了设置提供方时注册该命名空间；浏览器 settings scope 读写同一分节，Host 消费方（子代理启动、视觉门控）通过 `ctx.settings` 读取。

分节携带 `{ main, sub?, vision? }`：

- `main` 是必填的主 Agent 模型；注册时以 `main: ''` 作为组合基础层，因此命名空间在用户配置模型之前即可解析，路由在此之前保持不变。
- `sub` 是子代理模型；`resolveSubModel(main, sub)` 在配置了 sub 时返回 sub，否则回退到 `main`（空 `sub` 同样回退）。
- `vision` 是图像请求使用的视觉模型；`resolveVision(main, vision)` 在配置时返回它，否则返回 `undefined`（空 `vision` 同样视为不支持），由调用方的门控路径决定行为。

- `ctx.settings.get(MODEL_ROUTING_NAMESPACE)` 返回解析后的 `{ main, sub?, vision? }` 分节。
- `apply` 注册命名空间及其组合基础层；未挂载设置提供方时不注册任何内容。

该插件不校验目录成员关系。配置的档位可以指定 provider 目录未公布的模型；实际发起模型请求的消费方负责可用性诊断。

## 模型体验

通过其解析出的模型 id 间接影响：命名空间只存储与解析三档模型，路由消费方（子代理启动、视觉门控）负责从解析出的 id 构建所有模型可见请求。

#### KV Cache 影响

更改某一档位只影响随后经其解析的请求；命名空间从不改写现有请求的日志，因此不会使任何已建立的前缀失效。

## 已知限制与暂缓事项

- 未配置的主模型解析为 `''`；消费方必须将其视为「无路由覆盖」并保持既有行为。
- 命名空间尚未编入任何随附 bundle；将其接入 harness profile 属于路由集成的后续工作。
