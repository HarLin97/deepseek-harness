/** Model-routing settings: schema validation, resolution helpers, and host registration. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { LlmAdapter, LlmRuntime, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock, GenerateOptions, LlmCallConfig, LlmModelInfo, LlmProviderInfo,
  LlmResolvedModelInfo, ModelModality, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_MODEL_ROUTING, MODEL_ROUTING_NAMESPACE, ModelRoutingSettingsSchema,
  apply, resolveSubModel, resolveVision,
} from '../src/index.ts'

/** The smallest real provider: one in-memory document, always writable. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

describe('ModelRoutingSettingsSchema', () => {
  it('rejects a section without the required main model', () => {
    // The schema boundary admits untyped document data at runtime (the
    // settings service calls it with a detached section), so the invalid
    // input crosses the typed call as the service's own `as never` does.
    expect(() => ModelRoutingSettingsSchema({ sub: 'deepseek-v4-lite' } as never)).toThrow()
  })

  it('accepts a main model alone and leaves the optional tiers absent', () => {
    expect(ModelRoutingSettingsSchema({ main: 'deepseek-v4-flash' })).toEqual({ main: 'deepseek-v4-flash' })
  })

  it('accepts all three tiers', () => {
    expect(ModelRoutingSettingsSchema({
      main: 'deepseek-v4-flash', sub: 'deepseek-v4-lite', vision: 'deepseek-vl2',
    })).toEqual({ main: 'deepseek-v4-flash', sub: 'deepseek-v4-lite', vision: 'deepseek-vl2' })
  })

  it('rejects a non-string main model', () => {
    expect(() => ModelRoutingSettingsSchema({ main: 42 } as never)).toThrow()
  })
})

describe('resolveSubModel', () => {
  it('uses the sub model when configured', () => {
    expect(resolveSubModel('deepseek-v4-flash', 'deepseek-v4-lite')).toBe('deepseek-v4-lite')
  })

  it('falls back to the main model when sub is absent', () => {
    expect(resolveSubModel('deepseek-v4-flash', undefined)).toBe('deepseek-v4-flash')
  })

  it('falls back to the main model when sub is empty', () => {
    expect(resolveSubModel('deepseek-v4-flash', '')).toBe('deepseek-v4-flash')
  })
})

describe('resolveVision', () => {
  it('returns the vision model when configured', () => {
    expect(resolveVision('deepseek-v4-flash', 'deepseek-vl2')).toBe('deepseek-vl2')
  })

  it('returns undefined when vision is absent', () => {
    expect(resolveVision('deepseek-v4-flash', undefined)).toBeUndefined()
  })

  it('returns undefined when vision is empty', () => {
    expect(resolveVision('deepseek-v4-flash', '')).toBeUndefined()
  })
})

describe('model-routing host', () => {
  it('registers, resolves, validates, and disposes the durable namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.settings.get(MODEL_ROUTING_NAMESPACE)).toEqual(DEFAULT_MODEL_ROUTING)
    await ctx.settings.update(MODEL_ROUTING_NAMESPACE, {
      main: 'deepseek-v4-flash', sub: 'deepseek-v4-lite', vision: 'deepseek-vl2',
    })
    expect(ctx.settings.get(MODEL_ROUTING_NAMESPACE)).toEqual({
      main: 'deepseek-v4-flash', sub: 'deepseek-v4-lite', vision: 'deepseek-vl2',
    })
    await expect(ctx.settings.update(MODEL_ROUTING_NAMESPACE, { main: 42 })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(MODEL_ROUTING_NAMESPACE)
  })

  it('stays unregistered when no settings provider is composed', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(ctx.get('settings')).toBeUndefined()
    await fiber.dispose()
  })
})

/** Adapter advertising per-model input modalities. */
class ModalityAdapter extends LlmAdapter {
  constructor(private readonly modalities: ReadonlyMap<string, readonly ModelModality[] | undefined>) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Modality Provider' }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([...this.modalities].map(([id, inputModalities]) => ({
      provider: 'deepseek-official',
      id,
      name: id,
      ...inputModalities === undefined ? {} : { inputModalities },
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (!this.modalities.has(model)) {
      return Promise.reject(new Error(`no such model "${model}"`))
    }
    const inputModalities = this.modalities.get(model)
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...inputModalities === undefined ? {} : { inputModalities },
    })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Vision routing tests never enter provider streaming.
  }
}

async function visionHarness(
  options: { routing?: { main: string; vision?: string } } = {},
): Promise<{ ctx: Context; agent: Agent; seed: LlmCallConfig }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const modalities = new Map<string, readonly ModelModality[] | undefined>([
    ['deepseek-chat', ['text']],
    ['vision-pro', ['text', 'image']],
    ['no-modality', undefined],
  ])
  ctx.llm.registerAdapter(['deepseek-official'], new ModalityAdapter(modalities))
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin({ apply }).await()
  if (options.routing !== undefined) {
    await ctx.settings.update(MODEL_ROUTING_NAMESPACE, {
      ...options.routing,
      ...options.routing.vision === undefined ? {} : { vision: options.routing.vision },
    })
  }
  const session = ctx.sessions.create()
  const agent = { session, ctx } as unknown as Agent
  return { ctx, agent, seed: { provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 } }
}

/** Land one model-visible user message in the session surface. */
function landMessage(agent: Agent, content: ContentBlock[]): void {
  agent.session.append('user/message', createUserMessage({
    content,
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** The waterfall dispatch the agent loop performs before every request. */
function dispatchRequest(
  ctx: Context,
  agent: Agent,
  seed: LlmCallConfig,
): Promise<LlmCallConfig> {
  const signal = new AbortController().signal
  return agentEvents(ctx, agent).waterfall(
    'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
  )
}

/** One png image block followed by a text block. */
function imageParts(): ContentBlock[] {
  return [
    {
      type: 'image',
      attachment: {
        attachmentId: AttachmentId('att-vision'),
        mediaType: 'image/png',
        bytes: 1,
        width: 1,
        height: 1,
      },
    },
    { type: 'text', text: 'what is in this picture?' },
  ]
}

describe('global vision-model routing', () => {
  it('routes an image prompt to the configured vision model when the selected model cannot take images', async () => {
    const { ctx, agent, seed } = await visionHarness({
      routing: { main: 'deepseek-chat', vision: 'vision-pro' },
    })
    landMessage(agent, imageParts())
    await expect(dispatchRequest(ctx, agent, seed))
      .resolves.toMatchObject({ provider: 'deepseek-official', model: 'vision-pro', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('rejects an image prompt with the vision-not-supported error when no vision model is configured', async () => {
    const { ctx, agent, seed } = await visionHarness({ routing: { main: 'deepseek-chat' } })
    landMessage(agent, imageParts())
    await expect(dispatchRequest(ctx, agent, seed)).rejects.toMatchObject({
      code: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
      message: expect.stringContaining('vision is not supported'),
    })
    await ctx.fiber.dispose()
  })

  it('keeps an image prompt on the selected image-capable model, ignoring the vision tier', async () => {
    const { ctx, agent, seed } = await visionHarness({
      routing: { main: 'deepseek-chat', vision: 'vision-pro' },
    })
    landMessage(agent, imageParts())
    seed.model = 'vision-pro'
    await expect(dispatchRequest(ctx, agent, seed))
      .resolves.toMatchObject({ provider: 'deepseek-official', model: 'vision-pro', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('routes an image prompt to the vision model when the selected model advertises no modalities', async () => {
    const { ctx, agent, seed } = await visionHarness({
      routing: { main: 'deepseek-chat', vision: 'vision-pro' },
    })
    landMessage(agent, imageParts())
    seed.model = 'no-modality'
    await expect(dispatchRequest(ctx, agent, seed))
      .resolves.toMatchObject({ provider: 'deepseek-official', model: 'vision-pro', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('leaves a text-only prompt on the selected model even when a vision model is configured', async () => {
    const { ctx, agent, seed } = await visionHarness({
      routing: { main: 'deepseek-chat', vision: 'vision-pro' },
    })
    landMessage(agent, [{ type: 'text', text: 'hello' }])
    await expect(dispatchRequest(ctx, agent, seed))
      .resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('keeps the resolved config when the selected model route cannot be resolved', async () => {
    const { ctx, agent, seed } = await visionHarness({
      routing: { main: 'deepseek-chat', vision: 'vision-pro' },
    })
    landMessage(agent, imageParts())
    seed.model = 'ghost-model'
    await expect(dispatchRequest(ctx, agent, seed))
      .resolves.toMatchObject({ provider: 'deepseek-official', model: 'ghost-model', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('keeps the resolved config when no llm service is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    await ctx.settings.update(MODEL_ROUTING_NAMESPACE, { main: 'deepseek-chat', vision: 'vision-pro' })
    const session = ctx.sessions.create()
    const agent = { session, ctx } as unknown as Agent
    landMessage(agent, imageParts())
    const seed: LlmCallConfig = { provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 }
    await expect(dispatchRequest(ctx, agent, seed))
      .resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('rejects an image prompt when the model-routing namespace has no settings provider', async () => {
    // `apply` is mounted without any settings provider, so the routing
    // namespace never registers and the vision tier stays absent.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['deepseek-official'], new ModalityAdapter(
      new Map([['deepseek-chat', ['text']]]),
    ))
    await ctx.plugin({ apply }).await()
    const session = ctx.sessions.create()
    const agent = { session, ctx } as unknown as Agent
    landMessage(agent, imageParts())
    const seed: LlmCallConfig = { provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 }
    await expect(dispatchRequest(ctx, agent, seed)).rejects.toMatchObject({
      code: 'MODEL_DOES_NOT_SUPPORT_IMAGES',
      message: expect.stringContaining('vision is not supported'),
    })
    await ctx.fiber.dispose()
  })
})
