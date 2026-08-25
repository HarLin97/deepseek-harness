/**
 * Three-tier model routing (main Agent / sub-agent / vision) stored in the
 * Host user-settings document. Host consumers (sub-agent launch, vision
 * gating) read the resolved section through the settings service and the
 * exported helpers; the browser settings scope reads and writes the same
 * section.
 * @module @deepseek-ai/dsh-model-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Settings namespace owned by the model-routing plugin. */
export const MODEL_ROUTING_NAMESPACE = settingsNamespace('model-routing')

/** Field carrying the main Agent model. */
export const MODEL_ROUTING_MAIN_FIELD = 'main'

/** Field carrying the sub-agent model; empty falls back to the main model. */
export const MODEL_ROUTING_SUB_FIELD = 'sub'

/** Field carrying the vision model; empty means image support unavailable. */
export const MODEL_ROUTING_VISION_FIELD = 'vision'

/** Three-tier model selection shared by the Host schema and the browser scope. */
export interface ModelRoutingSettings {
  /** Main Agent model. */
  main: string
  /** Sub-agent model; empty falls back to the main model. */
  sub?: string
  /** Vision model; empty means image support unavailable. */
  vision?: string
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
  [MODEL_ROUTING_VISION_FIELD]: z.string(),
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
 * Resolve the vision model for an image-bearing request: the configured
 * vision model, or undefined when unset (image support unavailable).
 * @param _main - the resolved main Agent model; kept for signature symmetry
 * with {@link resolveSubModel}.
 * @param vision - the configured vision model, or undefined when unset.
 * @returns the model to serve an image-bearing request, or undefined.
 */
export function resolveVision(_main: string, vision: string | undefined): string | undefined {
  return vision !== undefined && vision !== '' ? vision : undefined
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
