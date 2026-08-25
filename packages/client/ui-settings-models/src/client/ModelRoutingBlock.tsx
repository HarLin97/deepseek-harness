/**
 * Model-routing tier block: main / sub-agent / vision model selectors at the
 * top of the Models settings page. Every selector fills from the host-scoped
 * provider catalog (the same groups as a session's directory, without a
 * per-session selection) and writes its model id into the `model-routing`
 * settings namespace through the bound settings scope — the harness
 * preference convention (revision-fenced writes, pushed invalidations).
 * Sub and vision are optional: their empty option clears the field (sub
 * falls back to the main model, image support is unavailable without a
 * vision model). Main is required: its empty option is disabled and an
 * empty pick writes nothing.
 */
import { useSyncExternalStore } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelRoutingCatalog, ModelRoutingField, ModelRoutingSettings } from './model-routing.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Injected data and verbs the block renders from. */
export interface ModelRoutingBlockProps {
  /** Bound model-routing settings scope (snapshot + set/unset verbs). */
  routing: SettingsScope<ModelRoutingSettings>
  /** The host model catalog the selectors fill from (last good load). */
  catalog: ModelRoutingCatalog
  /** Whether the settings document accepts writes. */
  writable: boolean
  /** Section copy. */
  t: (key: ModelsKey) => string
}

/** The model options of every provider group, in directory order. */
function modelOptions(catalog: ModelRoutingCatalog) {
  return catalog.groups.map(group => (
    <optgroup key={group.id} label={group.name}>
      {group.models.map(model => (
        <option key={model.id} value={model.id}>{model.name}</option>
      ))}
    </optgroup>
  ))
}

/**
 * Render the three-tier routing selectors.
 * @param props - scope, catalog, writability, and copy.
 * @returns the routing block.
 */
export function ModelRoutingBlock({ routing, catalog, writable, t }: ModelRoutingBlockProps) {
  const snapshot = useSyncExternalStore(
    listener => routing.subscribe(listener),
    () => routing.getSnapshot(),
  )
  const ready = snapshot.status === 'ready'
  const locked = !writable || !ready
  const value = snapshot.value
  const select = (field: ModelRoutingField, id: string): void => {
    // The main tier is required: an empty pick never reaches the namespace.
    if (field === 'main' && id === '') return
    if (id === '') void routing.unset(field)
    else void routing.set(field, id)
  }
  const tiers: readonly {
    field: ModelRoutingField
    current: string
    label: string
    hint: string
    required: boolean
  }[] = [
    { field: 'main', current: value?.main ?? '', label: t('mainModel'), hint: t('mainModelHint'), required: true },
    { field: 'sub', current: value?.sub ?? '', label: t('subModel'), hint: t('subModelHint'), required: false },
    { field: 'vision', current: value?.vision ?? '', label: t('visionModel'), hint: t('visionModelHint'), required: false },
  ]
  return (
    <div className={styles.routingBlock}>
      <h3 className={styles.routingTitle}>{t('routingTitle')}</h3>
      <p className={styles.routingIntro}>{t('routingIntro')}</p>
      <div className={styles.routingFields}>
        {tiers.map(({ field, current, label, hint, required }) => (
          <div className={styles.field} key={field}>
            <span className={styles.fieldLabel}>{label}</span>
            <select
              className={`${styles.input} ${styles.selectInput}`}
              value={current}
              aria-label={label}
              disabled={locked}
              onChange={(event) => { select(field, event.target.value) }}
            >
              <option value="" disabled={required}>{t('routingUnconfigured')}</option>
              {modelOptions(catalog)}
            </select>
            <span className={styles.routingHint}>{hint}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
