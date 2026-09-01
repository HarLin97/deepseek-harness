// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelRoutingBlock } from '../src/client/ModelRoutingBlock.tsx'
import type { ModelRoutingCatalog, ModelRoutingSettings } from '../src/client/model-routing.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

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

const t = (key: keyof typeof en): string => en[key]

function mount(options: {
  routing?: ModelRoutingSettings
  ready?: boolean
  writable?: boolean
  catalog?: ModelRoutingCatalog
} = {}) {
  const onSelect = vi.fn()
  render(
    <ModelRoutingBlock
      routing={options.routing}
      ready={options.ready ?? true}
      writable={options.writable ?? true}
      catalog={options.catalog ?? CATALOG}
      onSelect={onSelect}
      t={t}
    />,
  )
  return { onSelect }
}

function tier(label: string): HTMLSelectElement {
  return screen.getByLabelText<HTMLSelectElement>(label)
}

describe('ModelRoutingBlock', () => {
  it('renders main, sub-agent, and vision selectors from the Host catalog', () => {
    mount({
      routing: {
        main: 'deepseek-v4-flash',
        sub: 'gpt-4o',
        vision: 'deepseek-v4-pro',
      },
    })
    expect(tier(en.mainModel).value).toBe('deepseek-v4-flash')
    expect(tier(en.subModel).value).toBe('gpt-4o')
    expect(tier(en.visionModel).value).toBe('deepseek-v4-pro')
    expect([...tier(en.mainModel).options].map(option => option.value))
      .toEqual(['', 'deepseek-v4-flash', 'deepseek-v4-pro', 'gpt-4o'])
    expect([...tier(en.mainModel).querySelectorAll('optgroup')].map(group => group.label))
      .toEqual(['DeepSeek', 'OpenAI'])
  })

  it('reports field changes while keeping only the main empty option disabled', () => {
    const { onSelect } = mount({ routing: { main: 'deepseek-v4-flash', sub: 'gpt-4o' } })
    const empty = (select: HTMLSelectElement) => [...select.options].find(option => option.value === '')
    expect(empty(tier(en.mainModel))?.disabled).toBe(true)
    expect(empty(tier(en.subModel))?.disabled).toBe(false)
    expect(empty(tier(en.visionModel))?.disabled).toBe(false)

    fireEvent.change(tier(en.mainModel), { target: { value: 'deepseek-v4-pro' } })
    fireEvent.change(tier(en.subModel), { target: { value: '' } })
    fireEvent.change(tier(en.visionModel), { target: { value: 'gpt-4o' } })
    expect(onSelect.mock.calls).toEqual([
      ['main', 'deepseek-v4-pro'],
      ['sub', ''],
      ['vision', 'gpt-4o'],
    ])
  })

  it('locks all selectors until routing is ready or when settings are read-only', () => {
    const first = mount({ ready: false })
    expect(tier(en.mainModel).disabled).toBe(true)
    cleanup()
    mount({ writable: false })
    expect(tier(en.mainModel).disabled).toBe(true)
    expect(tier(en.subModel).disabled).toBe(true)
    expect(tier(en.visionModel).disabled).toBe(true)
    expect(first.onSelect).not.toHaveBeenCalled()
  })
})
