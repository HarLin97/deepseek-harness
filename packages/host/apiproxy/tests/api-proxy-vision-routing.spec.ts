/**
 * Web session vision-model routing: an image-bearing prompt served by a model
 * without image capability runs on the configured model-routing vision model
 * for that request, while an unconfigured or unroutable vision tier keeps the
 * existing refusal path with the vision-not-supported message. A capable
 * model and text-only prompts leave the request untouched.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmCallConfig, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo,
  ModelModality, StreamChunk, UserMessage,
} from '@deepseek-ai/dsh-llm'
import { MODEL_ROUTING_NAMESPACE, apply } from '@deepseek-ai/dsh-model-routing'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`vision-${String(nextRpc++)}`), payload }
}

function expectValue<T>(response: { result: { ok: true; value: T } | { ok: false } }): T {
  if (!response.result.ok) throw new Error('expected successful response')
  return response.result.value
}

/** Adapter advertising per-model input modalities. */
class ModalityAdapter extends LlmAdapter {
  constructor(private readonly modalities: ReadonlyMap<string, readonly ModelModality[]>) {
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
      inputModalities,
    })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const inputModalities = this.modalities.get(model)
    if (inputModalities === undefined) {
      return Promise.reject(new Error(`no such model "${model}"`))
    }
    return Promise.resolve({ provider, id: model, name: model, inputModalities })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    // Vision routing tests never enter provider streaming.
  }
}

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

async function harness(
  routing: { main: string; vision?: string } | undefined,
): Promise<{ ctx: Context; agent: Agent; sessionId: SessionId }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  const modalities = new Map<string, readonly ModelModality[]>([
    ['deepseek-chat', ['text']],
    ['vision-pro', ['text', 'image']],
  ])
  ctx.llm.registerAdapter(['deepseek-official'], new ModalityAdapter(modalities))
  if (routing !== undefined) {
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    await ctx.settings.update(MODEL_ROUTING_NAMESPACE, {
      ...routing,
      ...routing.vision === undefined ? {} : { vision: routing.vision },
    })
  }
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    status: 'running',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  ctx.agents.register(agent)
  return { ctx, agent, sessionId: session.id }
}

/** Wire prompt parts: one png image followed by a text part. */
function imageParts(): (
  | { type: 'image'; mediaType: 'image/png'; data: string; name?: string }
  | { type: 'text'; text: string }
)[] {
  return [
    { type: 'image' as const, mediaType: 'image/png' as const, data: 'AQ==', name: 'pic.png' },
    { type: 'text' as const, text: 'what is in this picture?' },
  ]
}

/** Mount a durable attachment service that accepts the test's single small image. */
function provideAttachments(ctx: Context): void {
  const saveImage = vi.fn((input: { data: Uint8Array; mediaType: 'image/png'; name?: string }) => Promise.resolve({
    attachmentId: 'att-vision',
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    width: 1,
    height: 1,
    ...input.name === undefined ? {} : { name: input.name },
  }))
  const attachments = {
    imageLimits: {
      maxImageBytes: 4,
      maxImagesPerMessage: 2,
      maxMessageImageBytes: 4,
      maxImagePixels: 4,
      mediaTypes: ['image/png'],
    },
    validateImage: vi.fn((_input: { data: Uint8Array }) => Promise.resolve()),
    saveImage,
  }
  ctx.provide('attachments', {
    ...attachments,
    saveImages(inputs: readonly Parameters<typeof saveImage>[0][]) {
      return AttachmentStore.prototype.saveImages.call(attachments, inputs)
    },
  } as never)
}

/** Install a followup that lands the durable message in the session surface. */
function landFollowup(agent: Agent): ReturnType<typeof vi.fn> {
  const followup = vi.fn((message: UserMessage) => {
    agent.session.append('user/message', message, { surfaceOp: 'append' })
  })
  Object.assign(agent, { followup })
  return followup
}

describe('Web session vision-model routing', () => {
  it('routes an image prompt to the configured vision model when the selected model cannot take images', async () => {
    const { ctx, agent, sessionId } = await harness({ main: 'deepseek-chat', vision: 'vision-pro' })
    provideAttachments(ctx)
    const followup = landFollowup(agent)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const admitted = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: imageParts(),
    }))
    expect(admitted.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledOnce()

    // The admission does not change the session's model selection: routing is
    // per-request, so the next request assembles against the selected model.
    expect(expectValue(await api.sessions.models(request({ sessionId }))).current)
      .toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })

    const signal = new AbortController().signal
    // Real runs assemble the system prompt before each request, which stamps
    // the assembled selection into installModelSelection; without this step
    // the selection listener never applies and a vision rewrite would appear
    // to work even when the listener ordering is wrong (the regression this
    // spec pins: the vision tier must wrap the selection stamp, not be
    // overwritten by it).
    await ctx.systemPrompt.assemble({})
    const seed: LlmCallConfig = { provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'deepseek-official', model: 'vision-pro', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('refuses an image prompt with the vision-not-supported message when no vision model is configured', async () => {
    const { ctx, agent, sessionId } = await harness({ main: 'deepseek-chat' })
    provideAttachments(ctx)
    const followup = landFollowup(agent)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const refused = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: imageParts(),
    }))
    expect(refused.result).toMatchObject({
      ok: false,
      error: {
        code: 'attachment-error',
        message: expect.stringContaining('vision is not supported'),
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      },
    })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps the existing refusal when the model-routing namespace is absent', async () => {
    const { ctx, agent, sessionId } = await harness(undefined)
    provideAttachments(ctx)
    const followup = landFollowup(agent)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const refused = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: imageParts(),
    }))
    expect(refused.result).toMatchObject({
      ok: false,
      error: {
        code: 'attachment-error',
        message: expect.stringContaining('vision is not supported'),
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      },
    })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('keeps an image prompt on the selected image-capable model, ignoring the vision tier', async () => {
    const { ctx, agent, sessionId } = await harness({ main: 'vision-pro', vision: 'vision-pro' })
    provideAttachments(ctx)
    const followup = landFollowup(agent)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'vision-pro' }),
      cwd: '/tmp',
    })

    const admitted = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: imageParts(),
    }))
    expect(admitted.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledOnce()

    const signal = new AbortController().signal
    const seed: LlmCallConfig = { provider: 'deepseek-official', model: 'vision-pro', temperature: 0.2 }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'deepseek-official', model: 'vision-pro', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('leaves a text-only prompt on the selected model even when a vision model is configured', async () => {
    const { ctx, agent, sessionId } = await harness({ main: 'deepseek-chat', vision: 'vision-pro' })
    provideAttachments(ctx)
    const followup = landFollowup(agent)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const admitted = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'hello' }],
    }))
    expect(admitted.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledOnce()

    const signal = new AbortController().signal
    const seed: LlmCallConfig = { provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toMatchObject({ provider: 'deepseek-official', model: 'deepseek-chat', temperature: 0.2 })
    await ctx.fiber.dispose()
  })

  it('refuses an image prompt when the configured vision model cannot be resolved', async () => {
    const { ctx, agent, sessionId } = await harness({ main: 'deepseek-chat', vision: 'ghost-model' })
    provideAttachments(ctx)
    const followup = landFollowup(agent)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: '/tmp',
    })

    const refused = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: imageParts(),
    }))
    expect(refused.result).toMatchObject({
      ok: false,
      error: {
        code: 'attachment-error',
        message: expect.stringContaining('vision is not supported'),
        details: { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' },
      },
    })
    expect(followup).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
