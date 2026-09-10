/**
 * Section-level routing share for tests that render {@link ModelsSection} but
 * do not exercise the routing block itself: a ready bound source and a no-op
 * write. The block's own behavior is covered in model-routing.client.spec.tsx.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ModelsSectionProps } from '../src/client/ModelsSection.tsx'
import type { ModelRoutingSettings } from '../src/client/model-routing.ts'

/** The routing share of {@link ModelsSectionProps} for a section-level render. */
export function routingShare(
  value: ModelRoutingSettings = { main: '' },
): Pick<ModelsSectionProps, 'useRouting' | 'selectRouting'> {
  const store = createSnapshotStore<SettingsScopeSnapshot<ModelRoutingSettings>>({
    status: 'ready',
    value,
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: 'host',
  })
  return { useRouting: bindSnapshotSelector(store), selectRouting: () => {} }
}
