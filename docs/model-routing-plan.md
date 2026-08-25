# 三档模型路由（主/子/视觉）实现计划

> **For agentic workers:** 子代理驱动执行。目标仓库：`D:\ai\deepseek-harness`（harness fork，品牌 千机/Arky Copilot）。改动遵循「可继续合并上游」约束：只加新能力，不改已有包 scope/命名。

**Goal:** harness 支持三档模型选择——主模型、子模型（子代理）、视觉模型——模型列表从服务商 provider 目录获取；子模型空则回退主模型，视觉模型未配则图像报「不支持」。

**Architecture:** 新增 `model-routing` settings 命名空间（main/sub/vision 三字段），UI 在模型设置区加三个下拉（复用 provider 目录），路由三处接线：主 Agent 用 main、子代理 `resolveChildAgentOptions` 用 sub||main、视觉在 hasImage 且当前模型无图像能力时用 vision（未配则门控拒绝）。

**Tech Stack:** 沿用 harness 的 cordis/settings/client 栈。集成点：settings 命名空间插件、ui-model-selection、subagent/src/child-agent.ts 的 resolveChildAgentOptions、llm 的模型能力/图像准入预检。

---

## 关键集成点（已探明）

| 点 | 位置 | 现状 |
|---|---|---|
| 模型目录/选择 | `packages/client/ui-model-selection/src/client/{service,directory}.ts` | 按会话 `sessions.models`/`selectModel`；provider 目录来自 adapter 的 `models` |
| 子代理模型 | `packages/subagent/subagent/src/child-agent.ts` `resolveChildAgentOptions` | 继承父模型，`request.agentOptions.model` 可覆盖 |
| 图像检测 | `packages/llm/llm/src/content.ts` `hasImage` | 递归检测嵌套图像块 |
| 图像准入 | `packages/llm/llm/src/index.ts` ~656 `inputModalities` 负能力 | 模型无图像能力时下游预检拒绝图像 |

## Task 1: model-routing settings 命名空间

**Files:** 新 host 插件（参考现有 settings 命名空间插件，如 ui-theme 的 theme-settings.ts / settings 注册模式）。

- `interface ModelRoutingSettings { main: string; sub?: string; vision?: string }` + schema（sub/vision 可选）。
- 注册命名空间 `model-routing`（Host 端 settings service）。
- 提供读取辅助（供路由使用）：`resolveMain(sub?: string)` = sub 非空 ? sub : main；`resolveVision()` 返回 vision 或 undefined。
- 单元测试：schema 校验、sub 回退、vision 缺失。

**验证：** 新插件的 settings 命名空间可读可写；测试绿。

## Task 2: 子代理模型路由

**Files:** `packages/subagent/subagent/src/child-agent.ts`（resolveChildAgentOptions 或调用处）。

- 子代理启动时解析模型：`sub || main`（从 model-routing 读取；sub 空 → 继承 main）。
- 在 `resolveChildAgentOptions` 或其调用链注入：request 未显式指定 model 时，若配置了 sub 则用 sub，否则继承父（父即 main）。
- 若 sub 未配 → 行为不变（继承父 = main）。

**验证：** 单元测试——配置 sub 时子代理 model = sub；sub 空时 = main（父）；request 显式指定时优先。

## Task 3: 视觉模型路由 + 门控

**Files:** `packages/llm/llm/src/index.ts`（模型解析/图像准入预检）。

- 请求含图（`hasImage`）且当前选中模型无图像能力时：
  - `vision` 已配 → 该次请求改用 vision 模型；
  - `vision` 未配 → 维持现有拒绝路径，提示「视觉不支持」。
- 在图像准入预检处注入：能解析到 vision 模型就放行并用 vision，否则报不支持。

**验证：** 单元测试——vision 配置时图像请求用 vision 模型；未配置时图像被拒且文案含「视觉不支持」。

## Task 4: UI — 三档下拉

**Files:** `packages/client/ui-model-selection`（设置区）+ 对应 locales。

- 模型设置区加三个下拉：主模型 / 子模型 / 视觉模型。
- 每个下拉从 provider 目录填充（复用当前会话可用的模型列表）。
- 子/视觉可为空（空 = 回退/不支持）。
- 写入 `model-routing` 命名空间。

**验证：** harness 运行，模型设置区出现三个下拉，选择后持久化。

## Task 5: 验证与收尾

**状态：已完成**（2026-08-25）。

- 全量单测（改动包）+ typecheck + 构建：四套测试 885 通过（model-routing 12 / subagent 262 / apiproxy 381 / ui-settings-models 230，其中 1 skipped），`pnpm typecheck` 绿，`build:lib:host` 绿。
- **接线**：`@deepseek-ai/dsh-model-routing` 以 host 行挂进 `packages/bundle/base/cordis.patch.yml`（`- id: model-routing`，紧邻 settings 行），并在 `packages/bundle/base/package.json` 声明 workspace 依赖——与 workflow-worker-thread 等 host 包同一模式。web/headless profile 都经 dsh-base 自动获得该行，无需改 `dsh.profile.bundles` 模板。`dsh --profile web --dump-default-config` 的 130 行组合中可见 `- id: model-routing`。
- **harness 实测**（隔离 DSH_HOME + 本地 mock OpenAI-compatible provider）：
  - 模型设置区三档下拉的数据源就绪：`llm.models` 返回 mock 组的 deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp；`settings.describe` 显示 `model-routing` 命名空间已注册（value/main/sub/vision 全解析，`applies: live`）。浏览器内下拉渲染由 ui-settings-models 的 230 个 client 测试覆盖（本环境无浏览器，未做真机 UI 点选）。
  - 子代理路由：headless profile 跑一次子代理委托，mock 日志显示父请求 model=deepseek-v4-pro（主）、子请求 model=deepseek-v4-flash（sub），子回复回传父级，任务完成 exit 0。
  - 视觉路由：web profile 经 RPC 发含图 prompt，出网请求 model=deepseek-v4-flash-vision-exp（vision），回合正常完成；`settings.mutate` 清掉 vision 后同一含图 prompt 被拒：`MODEL_DOES_NOT_SUPPORT_IMAGES` + 「vision is not supported: no vision model is configured」。
- **实测发现并修复一处接线 bug**：api-proxy 的视觉改写 listener 原注册在 `installModelSelection` 之后；agent/request 水瀑是外→内执行、最外层返回值定稿，selection listener（最外层）会在每次请求上把模型重新盖回 session 选中模型，视觉改写被吞掉（单测没抓到是因为测试里 `selection.assembled` 从未设置）。修复：把视觉 listener 注册到 `installModelSelection` 之前（视觉层成为最外层、改写在 selection 盖章之上落定），并在单测里先走一次 `ctx.systemPrompt.assemble({})` 让 selection 参与水瀑——回归验证：错误顺序下该用例失败（收到 deepseek-chat 而非 vision-pro），正确顺序通过。
- **遗留说明**：「主 Agent 用 main」未做第三处接线——主 agent 的模型仍走 session 级选择 / agent-default-model；`model-routing.main` 的角色是子代理与视觉的回退基准（sub 空 → main；vision 空 → 不支持）。这是 Task 1-4 的既定设计（UI 主模型下拉写入命名空间供回退读取），如需主 agent 默认也跟随 `model-routing.main`，是后续独立小任务。
- 更新 README（可选）：未做。

---

## 实施顺序

Task 1（settings 命名空间，自包含）→ Task 2（子代理路由）→ Task 3（视觉路由）→ Task 4（UI）→ Task 5（验证）。

## 风险与注意

- harness 有自己的 lint/lefthook（pre-commit 跑 lint/whitespace/vendor guard）——每个提交前必须过。
- 只加新能力，不改现有包 scope/命名（保持上游可合并）。
- 视觉路由涉及 llm 核心预检，改时保持负能力路径（未配 vision 时行为不变）。
