/** Model-routing settings: schema validation, resolution helpers, and host registration. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
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
