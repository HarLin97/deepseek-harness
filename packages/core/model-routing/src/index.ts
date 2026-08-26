/**
 * Three-tier model routing (main Agent / sub-agent / vision) stored in the
 * Host user-settings document. Host consumers (sub-agent launch, vision
 * gating) read the resolved section through the settings service and the
 * exported helpers; the browser settings scope reads and writes the same
 * section. The vision tier also drives the global `agent/request` routing
 * listener: every image-bearing request whose selected model cannot take
 * images runs on the configured vision model, or fails with a clear
 * vision-not-supported error when no vision model exists.
 * @module @deepseek-ai/dsh-model-routing
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
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

/** True when the model-visible message surface contains an image. */
function messagesHaveImage(messages: readonly Message[]): boolean {
  return messages.some(message => contentHasImage(message.content))
}

/**
 * Resolve the vision-model tier for image-bearing requests, or `undefined`
 * when the model-routing namespace is absent from the host settings service
 * or its vision field is empty — image requests then fail with the
 * vision-not-supported error. The settings service is read opportunistically
 * (the documented `ctx.get` pattern), never as a hard dep.
 * @param ctx - the context that may mount the settings service.
 * @returns the configured vision model id, or `undefined` when not configured.
 */
function visionModelOf(ctx: Context): string | undefined {
  const routing = ctx.get('settings')?.get(MODEL_ROUTING_NAMESPACE) as ModelRoutingSettings | undefined
  return routing === undefined ? undefined : resolveVision(routing.main, routing.vision)
}

/**
 * Route image-bearing requests to the configured vision model, for EVERY
 * agent. Registered on the plugin context (the harness root, untagged), the
 * listener is admitted to every agent's `agent/request` waterfall; the
 * waterfall runs outer-to-inner and the outermost return finalizes the
 * request config, so this rewrite lands on top of any inner selection stamp.
 * A request the selected model cannot take images for uses the configured
 * vision model; with no vision tier the request fails with a clear
 * vision-not-supported error instead of reaching an adapter that refuses it.
 * @param ctx - the context to register on; settings and llm are read
 * opportunistically at request time.
 * @returns the listener disposer.
 */
function installVisionRouting(ctx: Context): () => void {
  return ctx.on('agent/request', async ({ agent }: { agent: Agent }, next) => {
    const resolved = await next()
    if (!messagesHaveImage(agent.session.deriveMessages())) return resolved
    // Read through the global service store (`ctx.get`, never a hard dep):
    // a plugin-context direct accessor only resolves services the plugin's
    // own fiber injected, while the store is visible from every context.
    const llm = ctx.get('llm')
    if (llm === undefined) return resolved
    try {
      const info = await llm.resolveModelInfo(resolved.provider, resolved.model)
      if (info.inputModalities !== undefined && info.inputModalities.includes('image')) return resolved
    } catch {
      // Unknown route: keep the resolved config and let normal dispatch report it.
      return resolved
    }
    const vision = visionModelOf(ctx)
    if (vision === undefined) {
      throw new LlmError(
        `Model "${resolved.model}" does not support image input, and vision is not supported: no vision model is configured.`,
        'MODEL_DOES_NOT_SUPPORT_IMAGES',
      )
    }
    return { ...resolved, model: vision }
  })
}

/**
 * Register the durable model-routing section when a settings provider is
 * composed, and the global vision-routing listener on the host root. The
 * composition base carries an empty main, so the namespace resolves even
 * before the user configures a model.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(MODEL_ROUTING_NAMESPACE, ModelRoutingSettingsSchema, {
      base: DEFAULT_MODEL_ROUTING,
    })
  })
  installVisionRouting(ctx)
}
