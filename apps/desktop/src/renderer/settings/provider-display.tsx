import type { ProviderType } from '@maka/core/llm-connections';
import { ProviderBrandMark } from './provider-brand-marks';
export { providerDisplay } from './provider-display-copy';

// Kept as a thin wrapper so the many `ProviderLogo` call sites stay put.
function ProviderLogoMark({ type }: { type: ProviderType }) {
  return <ProviderBrandMark type={type} />;
}

export function ProviderLogo(props: { type: ProviderType; compact?: boolean }) {
  return (
    <span className="providerLogo" data-provider={props.type} data-compact={props.compact ? 'true' : undefined} aria-hidden="true">
      <ProviderLogoMark type={props.type} />
    </span>
  );
}
