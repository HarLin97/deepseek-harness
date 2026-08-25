// @vitest-environment jsdom
/** Model-routing tier block: three selectors (main / sub-agent / vision)
 * filled from the host model catalog, written through the bound
 * model-routing settings scope; sub and vision clear to empty while main
 * stays required. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import Schema from '@deepseek-ai/schemastery'
import type { RpcResponse, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/client'
import { ModelRoutingBlock } from '../src/client/ModelRoutingBlock.tsx'
import { MODEL_ROUTING_NAMESPACE, type ModelRoutingCatalog, type ModelRoutingSettings } from '../src/client/model-routing.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en): string => en[key]

/** Two providers with distinct models, in directory order. */
const CATALOG: ModelRoutingCatalog = {
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      models: [{ id: 'gpt-4o', name: 'GPT-4o' }],
    },
  ],
  failures: [],
}

/** The same section shape the host's model-routing namespace validates against. */
const RoutingSchema = Schema.object({
  main: Schema.string().required(),
  sub: Schema.string(),
  vision: Schema.string(),
})

let nextRpc = 0
function ok<T>(value: T): RpcResponse<T> {
  return { rpcId: `r-${nextRpc++}` as never, result: { ok: true, value } }
}

function routingView(value: Record<string, unknown>, revision: number): SettingsNamespaceView {
  return {
    ns: MODEL_ROUTING_NAMESPACE,
    schema: JSON.parse(JSON.stringify(RoutingSchema.toJSON())) as unknown,
    value,
    applies: 'live',
    secrets: [],
    revision,
  }
}

/** A real SettingsScopeController over a scripted wire face that applies ops. */
function scopeHarness(initial: Partial<ModelRoutingSettings>, writable = true) {
  const doc = new Map<string, unknown>(Object.entries(initial))
  let revision = 0
  const describe = vi.fn(() => Promise.resolve(ok({
    writable,
    hasDocument: true,
    namespaces: [routingView(Object.fromEntries(doc), revision)],
  })))
  const mutate = vi.fn((payload: {
    ns: string
    ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[]
  }) => {
    for (const op of payload.ops) {
      const field = op.path[0]!
      if (op.op === 'set') doc.set(field, op.value)
      else doc.delete(field)
    }
    revision += 1
    return Promise.resolve(ok(routingView(Object.fromEntries(doc), revision)))
  })
  const scope = new SettingsScopeController<ModelRoutingSettings>(
    { settings: { describe, mutate } } as never,
    { namespace: MODEL_ROUTING_NAMESPACE },
    'host',
  )
  return { scope, describe, mutate }
}

async function mountBlock(overrides: {
  initial?: Partial<ModelRoutingSettings>
  writable?: boolean
  catalog?: ModelRoutingCatalog
} = {}) {
  const { initial = { main: '' }, writable = true, catalog = CATALOG } = overrides
  const { scope, describe, mutate } = scopeHarness(initial, writable)
  await scope.load()
  render(<ModelRoutingBlock routing={scope} catalog={catalog} writable={writable} t={t} />)
  return { scope, describe, mutate }
}

function tierSelect(label: string): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>(label)
}

function unconfiguredOf(select: HTMLSelectElement): HTMLOptionElement {
  const option = [...select.options].find(candidate => candidate.value === '')
  if (option === undefined) throw new Error('the selector has no empty option')
  return option
}

describe('ModelRoutingBlock', () => {
  it('renders the three tier selectors with the unconfigured option', async () => {
    await mountBlock()
    expect(screen.getByText(en.routingTitle)).toBeTruthy()
    expect(screen.getByText(en.routingIntro)).toBeTruthy()
    for (const label of [en.mainModel, en.subModel, en.visionModel]) {
      const select = screen.getByLabelText<HTMLSelectElement>(label)
      expect(select.tagName).toBe('SELECT')
      expect(unconfiguredOf(select).textContent).toBe(en.routingUnconfigured)
    }
  })

  it('fills every selector from the provider catalog in directory order', async () => {
    await mountBlock()
    const values = [...tierSelect(en.mainModel).options].map(option => option.value)
    expect(values).toEqual(['', 'deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-4o'])
    expect([...tierSelect(en.mainModel).querySelectorAll('optgroup')].map(group => group.label))
      .toEqual(['DeepSeek', 'OpenAI'])
    // Every selector carries the same catalog rows.
    expect(screen.getAllByText('DeepSeek-V4-Flash')).toHaveLength(3)
    expect(screen.getAllByText('GPT-4o')).toHaveLength(3)
  })

  it('renders only the unconfigured option when the catalog is empty', async () => {
    await mountBlock({ catalog: { groups: [], failures: [] } })
    expect([...tierSelect(en.visionModel).options].map(option => option.value)).toEqual([''])
    expect(tierSelect(en.visionModel).querySelectorAll('optgroup')).toHaveLength(0)
  })

  it('reflects the persisted section in every selector', async () => {
    await mountBlock({
      initial: { main: 'deepseek-v4-flash', sub: 'gpt-4o', vision: 'deepseek-v4-pro' },
    })
    expect(tierSelect(en.mainModel).value).toBe('deepseek-v4-flash')
    expect(tierSelect(en.subModel).value).toBe('gpt-4o')
    expect(tierSelect(en.visionModel).value).toBe('deepseek-v4-pro')
  })

  it('renders an unconfigured section as empty selectors', async () => {
    await mountBlock({ initial: { main: '' } })
    expect(tierSelect(en.mainModel).value).toBe('')
    expect(tierSelect(en.subModel).value).toBe('')
    expect(tierSelect(en.visionModel).value).toBe('')
  })

  it('writes a picked model into the model-routing namespace', async () => {
    const { mutate } = await mountBlock({ initial: { main: 'deepseek-v4-flash' } })
    fireEvent.change(tierSelect(en.mainModel), { target: { value: 'deepseek-v4-pro' } })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: MODEL_ROUTING_NAMESPACE,
        ops: [{ op: 'set', path: ['main'], value: 'deepseek-v4-pro' }],
        expectedRevision: 0,
      })
    })
    await waitFor(() => { expect(tierSelect(en.mainModel).value).toBe('deepseek-v4-pro') })

    fireEvent.change(tierSelect(en.subModel), { target: { value: 'gpt-4o' } })
    await waitFor(() => {
      expect(mutate).toHaveBeenLastCalledWith({
        ns: MODEL_ROUTING_NAMESPACE,
        ops: [{ op: 'set', path: ['sub'], value: 'gpt-4o' }],
        expectedRevision: 1,
      })
    })
  })

  it('clears sub and vision through unset ops, saving the empty selection', async () => {
    const { mutate } = await mountBlock({
      initial: { main: 'deepseek-v4-flash', sub: 'gpt-4o', vision: 'deepseek-v4-pro' },
    })
    fireEvent.change(tierSelect(en.subModel), { target: { value: '' } })
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        ns: MODEL_ROUTING_NAMESPACE,
        ops: [{ op: 'unset', path: ['sub'] }],
        expectedRevision: 0,
      })
    })
    fireEvent.change(tierSelect(en.visionModel), { target: { value: '' } })
    await waitFor(() => {
      expect(mutate).toHaveBeenLastCalledWith({
        ns: MODEL_ROUTING_NAMESPACE,
        ops: [{ op: 'unset', path: ['vision'] }],
        expectedRevision: 1,
      })
    })
  })

  it('keeps the main tier required: its empty option is disabled and an empty pick writes nothing', async () => {
    const { mutate } = await mountBlock({ initial: { main: 'deepseek-v4-flash' } })
    expect(unconfiguredOf(tierSelect(en.mainModel)).disabled).toBe(true)
    expect(unconfiguredOf(tierSelect(en.subModel)).disabled).toBe(false)
    expect(unconfiguredOf(tierSelect(en.visionModel)).disabled).toBe(false)
    fireEvent.change(tierSelect(en.mainModel), { target: { value: '' } })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('locks the selectors while the scope has not loaded, then unlocks it', async () => {
    const { scope } = scopeHarness({ main: 'deepseek-v4-flash' })
    render(<ModelRoutingBlock routing={scope} catalog={CATALOG} writable t={t} />)
    expect(tierSelect(en.mainModel).disabled).toBe(true)
    await act(async () => { await scope.load() })
    expect(tierSelect(en.mainModel).disabled).toBe(false)
  })

  it('locks every selector for a read-only document', async () => {
    await mountBlock({ writable: false })
    expect(tierSelect(en.mainModel).disabled).toBe(true)
    expect(tierSelect(en.subModel).disabled).toBe(true)
    expect(tierSelect(en.visionModel).disabled).toBe(true)
  })
})

describe('model-routing scope wiring', () => {
  it('exposes the bound scope snapshot and write verbs', async () => {
    const { scope } = scopeHarness({ main: 'deepseek-v4-flash' })
    await scope.load()
    expect(scope.getSnapshot()).toMatchObject({ status: 'ready', value: { main: 'deepseek-v4-flash' } })
    expect(typeof scope.set).toBe('function')
    expect(typeof scope.unset).toBe('function')
  })
})
