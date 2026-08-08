import { ExternalSessionAdapterRegistry } from '@maka/core/external-session';
import { CodexSessionAdapter, type CodexSessionAdapterOptions } from './codex-session-adapter.js';

export interface ExternalSessionAdapterOptions {
  codex?: CodexSessionAdapterOptions;
}

/** Internal default registry. Product entry points are intentionally added later. */
export function createExternalSessionAdapterRegistry(
  options: ExternalSessionAdapterOptions = {},
): ExternalSessionAdapterRegistry {
  return new ExternalSessionAdapterRegistry([new CodexSessionAdapter(options.codex)]);
}
