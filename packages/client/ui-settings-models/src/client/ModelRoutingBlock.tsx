/**
 * Model-routing tier block: main / sub-agent / vision model selectors at the
 * top of the Models settings page.
 */

import type { ReactNode } from 'react'
import type {
  ModelRoutingCatalog,
  ModelRoutingField,
  ModelRoutingSettings,
} from './model-routing.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props derived by the parent from renderer-bound stores and injected callbacks. */
export interface ModelRoutingBlockProps {
  /** Current model-routing section. */
  routing: ModelRoutingSettings | undefined
  /** Whether the bound settings scope has a current Host answer. */
  ready: boolean
  /** The Host model catalog the selectors fill from. */
  catalog: ModelRoutingCatalog
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Persist one selector change. */
  onSelect: (field: ModelRoutingField, id: string) => void
  /** Section copy. */
  t: (key: ModelsKey) => string
}

/** The model options of every provider group, in directory order. */
function modelOptions(catalog: ModelRoutingCatalog): ReactNode {
  return catalog.groups.map(group => (
    <optgroup key={group.id} label={group.name}>
      {group.models.map(model => (
        <option key={`${group.id}/${model.id}`} value={model.id}>{model.name}</option>
      ))}
    </optgroup>
  ))
}

/**
 * Render the three-tier routing selectors.
 * @param props - current settings, catalog, write state, and callbacks.
 * @returns the routing block.
 */
export function ModelRoutingBlock({
  routing,
  ready,
  catalog,
  writable,
  onSelect,
  t,
}: ModelRoutingBlockProps): ReactNode {
  const locked = !writable || !ready
  const tiers: readonly {
    field: ModelRoutingField
    current: string
    label: string
    hint: string
    required: boolean
  }[] = [
    {
      field: 'main',
      current: routing?.main ?? '',
      label: t('mainModel'),
      hint: t('mainModelHint'),
      required: true,
    },
    {
      field: 'sub',
      current: routing?.sub ?? '',
      label: t('subModel'),
      hint: t('subModelHint'),
      required: false,
    },
    {
      field: 'vision',
      current: routing?.vision ?? '',
      label: t('visionModel'),
      hint: t('visionModelHint'),
      required: false,
    },
  ]
  return (
    <div className={styles['routingBlock']}>
      <h3 className={styles['routingTitle']}>{t('routingTitle')}</h3>
      <p className={styles['routingIntro']}>{t('routingIntro')}</p>
      <div className={styles['routingFields']}>
        {tiers.map(({ field, current, label, hint, required }) => (
          <div className={styles['field']} key={field}>
            <span className={styles['fieldLabel']}>{label}</span>
            <select
              className={`${styles['input']} ${styles['selectInput']}`}
              value={current}
              aria-label={label}
              disabled={locked}
              onChange={(event) => { onSelect(field, event.target.value) }}
            >
              <option value="" disabled={required}>{t('routingUnconfigured')}</option>
              {modelOptions(catalog)}
            </select>
            <span className={styles['routingHint']}>{hint}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
