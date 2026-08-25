# @deepseek-ai/dsh-model-routing

English | [中文](README.zh.md)

Three-tier model routing (main Agent / sub-agent / vision) as a `model-routing` Settings namespace. The plugin registers the namespace when a settings provider is composed; the browser settings scope reads and writes the same section, and Host consumers (sub-agent launch, vision gating) read it through `ctx.settings`.

The section carries `{ main, sub?, vision? }`:

- `main` is the required main Agent model; the registration supplies `main: ''` as the composition base, so the namespace resolves before the user configures a model and routing stays unchanged until then.
- `sub` is the sub-agent model; `resolveSubModel(main, sub)` returns the sub model when set and falls back to `main` otherwise (empty `sub` also falls back).
- `vision` is the vision model for image-bearing requests; `resolveVision(main, vision)` returns it when set and `undefined` otherwise (empty `vision` also means unsupported), leaving the caller's gating path to decide.

- `ctx.settings.get(MODEL_ROUTING_NAMESPACE)` returns the resolved `{ main, sub?, vision? }` section.
- `apply` registers the namespace and its composition base; without a settings provider nothing is registered.

The plugin does not validate catalog membership. A configured tier may name a model the provider directory does not advertise; the consumer that opens a model request owns availability diagnostics.

## Model Experience

Indirectly, through the model ids it resolves: the namespace only stores and resolves the three tiers, and the routing consumers (sub-agent launch, vision gating) own every model-visible request they build from a resolved id.

#### KV Cache effect

Changing a tier affects only requests that subsequently resolve through it; the namespace never rewrites an existing request's log, so it does not invalidate any established prefix.

## Known Limitations and Deferred Work

- An unconfigured main resolves to `''`; consumers must treat that as "no routing override" and keep their existing behavior.
- The namespace is not yet composed into any shipped bundle; wiring it into the harness profile is the routing integration's follow-up.
