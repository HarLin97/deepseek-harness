/**
 * Subagent model routing: a configured model-routing namespace steers child
 * launches to the sub tier (`sub || main`), while an explicit request model,
 * an unconfigured namespace, or an empty routing main keep the parent route.
 * The continuable path additionally records the routed model in the durable
 * descriptor so a cold resume reconstructs the same composition.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MODEL_ROUTING_NAMESPACE, apply, type ModelRoutingSettings } from '@deepseek-ai/dsh-model-routing'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, {
  foldSubagentDescriptor,
  resolveChildAgentOptions,
  resolveChildRoutedModel,
} from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

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

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A delegating parent reduced to the fields the child composition reads. */
function fakeParent(ctx: Context, options: AgentOptions): Agent {
  return { ctx, options } as unknown as Agent
}

/** A context with a settings service, optionally mounting the model-routing namespace. */
async function settingsContext(mountRouting: boolean, section?: ModelRoutingSettings): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemorySettings).await()
  if (mountRouting) {
    await ctx.plugin({ apply }).await()
    if (section !== undefined) await ctx.settings.update(MODEL_ROUTING_NAMESPACE, section)
  }
  return ctx
}

/** Boot the subagent stack plus the model-routing namespace for end-to-end routes. */
async function setupHarness(script: Script): Promise<{ ctx: Context; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-routing-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(MemorySettings)
  await ctx.plugin({ apply })
  await ctx.settings.update(MODEL_ROUTING_NAMESPACE, { main: 'main-model', sub: 'sub-model' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'main-model' })
  return { ctx, parent }
}

describe('resolveChildRoutedModel', () => {
  it('resolves the sub model when configured', async () => {
    const ctx = await settingsContext(true, { main: 'main-model', sub: 'sub-model' })
    expect(resolveChildRoutedModel(fakeParent(ctx, { provider: 'mock', model: 'main-model' }))).toBe('sub-model')
  })

  it('falls back to the main model when sub is unset', async () => {
    const ctx = await settingsContext(true, { main: 'main-model' })
    expect(resolveChildRoutedModel(fakeParent(ctx, { provider: 'mock', model: 'main-model' }))).toBe('main-model')
  })

  it('returns undefined when the model-routing namespace is not mounted', async () => {
    const ctx = await settingsContext(false)
    expect(resolveChildRoutedModel(fakeParent(ctx, { provider: 'mock', model: 'parent-model' }))).toBeUndefined()
  })

  it('returns undefined when the routing main is empty', async () => {
    const ctx = await settingsContext(true)
    expect(resolveChildRoutedModel(fakeParent(ctx, { provider: 'mock', model: 'parent-model' }))).toBeUndefined()
  })
})

describe('resolveChildAgentOptions model routing', () => {
  it('routes a child without an explicit request model to the configured sub model', async () => {
    const ctx = await settingsContext(true, { main: 'main-model', sub: 'sub-model' })
    const parent = fakeParent(ctx, { provider: 'mock', model: 'parent-model' })
    const options = resolveChildAgentOptions(parent, undefined, 2, resolveChildRoutedModel(parent))
    expect(options.model).toBe('sub-model')
    // Provider and budget still inherit; the child's own depth is stamped.
    expect(options.provider).toBe('mock')
    expect(options.maxTokens).toBeUndefined()
    expect(options.subagentDepth).toBe(2)
  })

  it('inherits the main model when sub is unset', async () => {
    const ctx = await settingsContext(true, { main: 'main-model' })
    const parent = fakeParent(ctx, { provider: 'mock', model: 'main-model' })
    expect(resolveChildAgentOptions(parent, undefined, 1, resolveChildRoutedModel(parent)).model).toBe('main-model')
  })

  it('routes on the routing main even when the parent model differs', async () => {
    const ctx = await settingsContext(true, { main: 'routing-main' })
    const parent = fakeParent(ctx, { provider: 'mock', model: 'parent-model' })
    const routed = resolveChildRoutedModel(parent)
    expect(resolveChildAgentOptions(parent, undefined, 1, routed).model).toBe('routing-main')
  })

  it('keeps an explicitly requested model over the routed one', async () => {
    const ctx = await settingsContext(true, { main: 'main-model', sub: 'sub-model' })
    const parent = fakeParent(ctx, { provider: 'mock', model: 'parent-model' })
    const routed = resolveChildRoutedModel(parent)
    expect(routed).toBe('sub-model')
    const options = resolveChildAgentOptions(parent, { provider: 'mock', model: 'explicit-model' }, 1, routed)
    expect(options.model).toBe('explicit-model')
  })

  it('inherits the parent model without any settings service', () => {
    const parent = fakeParent(new Context(), { provider: 'mock', model: 'parent-model' })
    expect(resolveChildAgentOptions(parent, undefined, 1).model).toBe('parent-model')
  })

  it('inherits the parent model when the model-routing namespace is not registered', async () => {
    const ctx = await settingsContext(false)
    const parent = fakeParent(ctx, { provider: 'mock', model: 'parent-model' })
    expect(resolveChildAgentOptions(parent, undefined, 1).model).toBe('parent-model')
  })

  it('inherits the parent model when the routing main is empty', async () => {
    const ctx = await settingsContext(true)
    const parent = fakeParent(ctx, { provider: 'mock', model: 'parent-model' })
    expect(resolveChildAgentOptions(parent, undefined, 1).model).toBe('parent-model')
  })
})

describe('subagent model routing end to end', () => {
  it('launches a one-shot child on the routed sub model', async () => {
    const { ctx, parent } = await setupHarness([textResponse('child done')])
    const run = await ctx.subagents.start('spawn', {
      label: 'child task',
      prompt: [{ type: 'text' as const, text: 'child task' }],
      parent,
      signal: new AbortController().signal,
    })
    try {
      await run.result
      const child = run.localAgent
      if (child === undefined) throw new Error('expected the one-shot child to be created')
      expect(child.options.model).toBe('sub-model')
    } finally {
      await run.dispose()
    }
  })

  it('keeps an explicitly requested model on the one-shot child', async () => {
    const { ctx, parent } = await setupHarness([textResponse('child done')])
    const run = await ctx.subagents.start('spawn', {
      label: 'child task',
      prompt: [{ type: 'text' as const, text: 'child task' }],
      parent,
      agentOptions: { provider: 'mock', model: 'explicit-model' },
      signal: new AbortController().signal,
    })
    try {
      await run.result
      const child = run.localAgent
      if (child === undefined) throw new Error('expected the one-shot child to be created')
      expect(child.options.model).toBe('explicit-model')
    } finally {
      await run.dispose()
    }
  })

  it('launches a continuable child on the routed sub model and records it durably', { timeout: 20_000 }, async () => {
    const { ctx, parent } = await setupHarness([textResponse('child done')])
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => {
      if (agent !== parent) child = agent
    })
    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'child task',
      request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
      signal: new AbortController().signal,
    })
    if (child === undefined) throw new Error('expected the continuable child to be created')
    expect(child.options.model).toBe('sub-model')
    await vi.waitFor(() => {
      expect(ctx.agents.get(started.childId)).toBeUndefined()
    }, { timeout: 15_000 })
    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = foldSubagentDescriptor(loaded.events)
    if (descriptor?.mode !== 'continuable') throw new Error('expected a continuable descriptor')
    expect(descriptor.agentModel).toBe('sub-model')
  })
})
