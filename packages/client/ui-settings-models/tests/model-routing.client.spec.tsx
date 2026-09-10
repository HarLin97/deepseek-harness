// @vitest-environment jsdom
/** Model-routing tier block: main and sub-agent selectors filled from the host
 * model catalog and reported through onSelect; sub clears to empty while main
 * stays required. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelRoutingBlock, selectRoutingField } from '../src/client/ModelRoutingBlock.tsx'
import type { ModelRoutingCatalog, ModelRoutingField, ModelRoutingSettings } from '../src/client/model-routing.ts'
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

/** Records the scope writes one pick issues, as the bound scope would. */
function writeRecorder() {
  const writes: { op: 'set' | 'unset'; field: string; value?: unknown }[] = []
  const scope = {
    set: (field: string, value: unknown): Promise<void> => {
      writes.push({ op: 'set', field, value })
      return Promise.resolve()
    },
    unset: (field: string): Promise<void> => {
      writes.push({ op: 'unset', field })
      return Promise.resolve()
    },
  }
  return { writes, scope }
}

/** Mount the block with the parent's own wiring: plain props plus the real
 * persistence callback over a recording scope. */
function mountBlock(overrides: {
  routing?: ModelRoutingSettings
  ready?: boolean
  writable?: boolean
  catalog?: ModelRoutingCatalog
} = {}) {
  const { routing = { main: '' }, ready = true, writable = true, catalog = CATALOG } = overrides
  const { writes, scope } = writeRecorder()
  const onSelect = vi.fn((field: ModelRoutingField, id: string): void => {
    selectRoutingField(scope, field, id)
  })
  render(
    <ModelRoutingBlock
      routing={routing}
      ready={ready}
      catalog={catalog}
      writable={writable}
      onSelect={onSelect}
      t={t}
    />,
  )
  return { onSelect, writes, scope }
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
  it('renders the two tier selectors with the unconfigured option', () => {
    mountBlock()
    expect(screen.getByText(en.routingTitle)).toBeTruthy()
    expect(screen.getByText(en.routingIntro)).toBeTruthy()
    for (const label of [en.mainModel, en.subModel]) {
      const select = tierSelect(label)
      expect(select.tagName).toBe('SELECT')
      expect(unconfiguredOf(select).textContent).toBe(en.routingUnconfigured)
    }
  })

  it('fills every selector from the provider catalog in directory order', () => {
    mountBlock()
    const values = [...tierSelect(en.mainModel).options].map(option => option.value)
    expect(values).toEqual(['', 'deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-4o'])
    expect([...tierSelect(en.mainModel).querySelectorAll('optgroup')].map(group => group.label))
      .toEqual(['DeepSeek', 'OpenAI'])
    // Every selector carries the same catalog rows.
    expect(screen.getAllByText('DeepSeek-V4-Flash')).toHaveLength(2)
    expect(screen.getAllByText('GPT-4o')).toHaveLength(2)
  })

  it('renders only the unconfigured option when the catalog is empty', () => {
    mountBlock({ catalog: { groups: [], failures: [] } })
    expect([...tierSelect(en.subModel).options].map(option => option.value)).toEqual([''])
    expect(tierSelect(en.subModel).querySelectorAll('optgroup')).toHaveLength(0)
  })

  it('reflects the persisted section in every selector', () => {
    mountBlock({ routing: { main: 'deepseek-v4-flash', sub: 'gpt-4o' } })
    expect(tierSelect(en.mainModel).value).toBe('deepseek-v4-flash')
    expect(tierSelect(en.subModel).value).toBe('gpt-4o')
  })

  it('renders an unconfigured section as empty selectors', () => {
    mountBlock({ routing: { main: '' } })
    expect(tierSelect(en.mainModel).value).toBe('')
    expect(tierSelect(en.subModel).value).toBe('')
  })

  it('writes a picked model into the model-routing namespace', () => {
    const { writes, onSelect } = mountBlock({ routing: { main: 'deepseek-v4-flash' } })
    fireEvent.change(tierSelect(en.mainModel), { target: { value: 'deepseek-v4-pro' } })
    expect(onSelect).toHaveBeenCalledWith('main', 'deepseek-v4-pro')
    expect(writes).toEqual([{ op: 'set', field: 'main', value: 'deepseek-v4-pro' }])

    fireEvent.change(tierSelect(en.subModel), { target: { value: 'gpt-4o' } })
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual({ op: 'set', field: 'sub', value: 'gpt-4o' })
  })

  it('clears the sub tier through an unset op, leaving it to fall back', () => {
    const { writes } = mountBlock({ routing: { main: 'deepseek-v4-flash', sub: 'gpt-4o' } })
    fireEvent.change(tierSelect(en.subModel), { target: { value: '' } })
    expect(writes).toEqual([{ op: 'unset', field: 'sub' }])
  })

  it('keeps the main tier required: empty option disabled and an empty pick writes nothing', () => {
    const { writes, scope } = mountBlock({ routing: { main: 'deepseek-v4-flash' } })
    expect(unconfiguredOf(tierSelect(en.mainModel)).disabled).toBe(true)
    expect(unconfiguredOf(tierSelect(en.subModel)).disabled).toBe(false)
    // The disabled option is unreachable through a user gesture, so the
    // required tier's refusal is exercised through the persistence callback.
    selectRoutingField(scope, 'main', '')
    expect(writes).toEqual([])
  })

  it('locks the selectors until the scope answers', () => {
    mountBlock({ ready: false })
    expect(tierSelect(en.mainModel).disabled).toBe(true)
    expect(tierSelect(en.subModel).disabled).toBe(true)
    cleanup()
    mountBlock()
    expect(tierSelect(en.mainModel).disabled).toBe(false)
  })

  it('locks every selector for a read-only document', () => {
    mountBlock({ writable: false })
    expect(tierSelect(en.mainModel).disabled).toBe(true)
    expect(tierSelect(en.subModel).disabled).toBe(true)
  })
})

describe('selectRoutingField', () => {
  it('routes each pick to the matching scope verb and refuses an empty required main', () => {
    const { writes, scope } = writeRecorder()
    selectRoutingField(scope, 'main', 'model-a')
    expect(writes).toEqual([{ op: 'set', field: 'main', value: 'model-a' }])
    selectRoutingField(scope, 'sub', 'model-b')
    expect(writes[1]).toEqual({ op: 'set', field: 'sub', value: 'model-b' })
    selectRoutingField(scope, 'sub', '')
    expect(writes[2]).toEqual({ op: 'unset', field: 'sub' })
    selectRoutingField(scope, 'main', '')
    expect(writes).toHaveLength(3)
  })
})
