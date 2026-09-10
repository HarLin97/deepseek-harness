/**
 * Two-tier model routing (main Agent / sub-agent) stored in the Host
 * user-settings document. Host consumers (sub-agent launch) read the resolved
 * section through the settings service and the exported helpers; the browser
 * settings scope reads and writes the same section.
 *
 * Image-bearing requests are NOT routed here: upstream owns multimodal
 * admission, so this namespace deliberately carries no vision tier.
 * @module @deepseek-ai/dsh-model-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Side-effect type import: brings in the `Context.settings` module augmentation.
import type {} from '@deepseek-ai/dsh-settings'

/** Settings namespace owned by the model-routing plugin. */
export const MODEL_ROUTING_NAMESPACE = 'model-routing'

/** Field carrying the main Agent model. */
export const MODEL_ROUTING_MAIN_FIELD = 'main'

/** Field carrying the sub-agent model; empty falls back to the main model. */
export const MODEL_ROUTING_SUB_FIELD = 'sub'

/** Model selection shared by the Host schema and the browser scope. */
export interface ModelRoutingSettings {
  /** Main Agent model. */
  main: string
  /** Sub-agent model; empty falls back to the main model. */
  sub?: string
}

/**
 * Composition base below the user layer: an empty main keeps routing
 * unchanged until the user picks a model, while the schema still demands a
 * string main in every resolved section.
 */
export const DEFAULT_MODEL_ROUTING: Partial<ModelRoutingSettings> = {
  [MODEL_ROUTING_MAIN_FIELD]: '',
}

/** Durable model-routing schema; also the wire envelope the browser scope validates against. */
export const ModelRoutingSettingsSchema: z<ModelRoutingSettings> = z.object({
  [MODEL_ROUTING_MAIN_FIELD]: z.string().required(),
  [MODEL_ROUTING_SUB_FIELD]: z.string(),
})

/**
 * Resolve the model a sub-agent should launch with: the configured sub-agent
 * model when set, otherwise the main Agent model.
 * @param main - the resolved main Agent model.
 * @param sub - the configured sub-agent model, or undefined when unset.
 * @returns the model the sub-agent should use.
 */
export function resolveSubModel(main: string, sub: string | undefined): string {
  return sub !== undefined && sub !== '' ? sub : main
}

/**
 * Register the durable model-routing section when a settings provider is
 * composed. The composition base carries an empty main, so the namespace
 * resolves even before the user configures a model.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(MODEL_ROUTING_NAMESPACE, ModelRoutingSettingsSchema, {
      base: DEFAULT_MODEL_ROUTING,
    })
  })
}
