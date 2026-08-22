import { ExternalSessionAdapterRegistry } from '@maka/core/external-session';
import {
  ClaudeCodeSessionAdapter,
  type ClaudeCodeSessionAdapterOptions,
} from './claude-code-session-adapter.js';
import { CodexSessionAdapter, type CodexSessionAdapterOptions } from './codex-session-adapter.js';

export interface ExternalSessionAdapterOptions {
  codex?: CodexSessionAdapterOptions;
  claudeCode?: ClaudeCodeSessionAdapterOptions;
}

/** Default source registry shared by product-facing external Session import surfaces. */
export function createExternalSessionAdapterRegistry(
  options: ExternalSessionAdapterOptions = {},
): ExternalSessionAdapterRegistry {
  return new ExternalSessionAdapterRegistry([
    new CodexSessionAdapter(options.codex),
    new ClaudeCodeSessionAdapter(options.claudeCode),
  ]);
}
