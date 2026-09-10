/**
 * Model-routing tier block: main and sub-agent model selectors at the top of
 * the Models settings page. Every selector fills from the host-scoped provider
 * catalog (the same groups as a session's directory, without a per-session
 * selection) and reports its pick through `onSelect`; the parent's injected
 * callback writes the model id into the `model-routing` settings namespace
 * through the bound settings scope — the harness preference convention
 * (revision-fenced writes, pushed invalidations). Sub is optional: its empty
 * option clears the field, falling back to the main model. Main is required:
 * its empty option is disabled and an empty pick writes nothing.
 */
import type { ReactNode } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelRoutingCatalog, ModelRoutingField, ModelRoutingSettings } from './model-routing.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Data and verbs the parent derives for the routing block. */
export interface ModelRoutingBlockProps {
  /** Current model-routing section, undefined before the scope's first answer. */
  routing: ModelRoutingSettings | undefined
  /** Whether the bound settings scope has a current Host answer. */
  ready: boolean
  /** The host model catalog the selectors fill from (last good load). */
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
        <option key={model.id} value={model.id}>{model.name}</option>
      ))}
    </optgroup>
  ))
}

/**
 * Route one selector pick into a bound routing scope: the main tier is
 * required, so an empty main pick writes nothing, while an empty optional
 * tier clears its field so that tier falls back.
 * @param routing - the bound scope's write verbs.
 * @param field - the tier the pick belongs to.
 * @param id - the picked model id, or the empty string for the empty option.
 */
export function selectRoutingField(
  routing: Pick<SettingsScope<ModelRoutingSettings>, 'set' | 'unset'>,
  field: ModelRoutingField,
  id: string,
): void {
  if (field === 'main' && id === '') return
  if (id === '') void routing.unset(field)
  else void routing.set(field, id)
}

/**
 * Render the two-tier routing selectors.
 * @param props - current settings, catalog, write state, and callbacks.
 * @returns the routing block.
 */
export function ModelRoutingBlock({
  routing, ready, catalog, writable, onSelect, t,
}: ModelRoutingBlockProps): ReactNode {
  const locked = !writable || !ready
  const tiers: readonly {
    field: ModelRoutingField
    current: string
    label: string
    hint: string
    required: boolean
  }[] = [
    { field: 'main', current: routing?.main ?? '', label: t('mainModel'), hint: t('mainModelHint'), required: true },
    { field: 'sub', current: routing?.sub ?? '', label: t('subModel'), hint: t('subModelHint'), required: false },
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
