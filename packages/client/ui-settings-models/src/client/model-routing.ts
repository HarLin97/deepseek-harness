/**
 * Browser contract for the model-routing settings namespace: the client
 * mirror of the host's `dsh-model-routing` section (namespace name and value
 * shape only — the host schema stays the authority), plus the catalog shape
 * the routing tier selectors fill from. Kept value-only so the client bundle
 * never imports the host package (client bundle purity gate).
 */
import type { ModelCatalogFailure, ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'

/** Client mirror of the host's model-routing settings section. */
export interface ModelRoutingSettings {
  /** Main Agent model. */
  main: string
  /** Sub-agent model; empty falls back to the main model. */
  sub?: string
  /** Vision model; empty means image support unavailable. */
  vision?: string
}

/** The model-routing settings namespace, mirroring the host plugin's constant. */
export const MODEL_ROUTING_NAMESPACE = 'model-routing'

/** One routing tier's selector identity. */
export type ModelRoutingField = 'main' | 'sub' | 'vision'

/** The session-independent provider catalog the routing selectors fill from. */
export interface ModelRoutingCatalog {
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
}
