/**
 * Shared workspace privacy contract.
 *
 * The main process owns the effective state. Renderers may request or
 * display it, but consumers must receive a main-resolved context rather
 * than trust renderer input. Invalid boundary data fails closed.
 *
 * @see docs/workspace-privacy-context.md
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Workspace-wide privacy context.
 *
 * The contract has exactly one field. Adding fields requires updating
 * this interface, the main-process authority path, and every consumer.
 */
export interface WorkspacePrivacyContext {
  /**
   * True when the workspace is in incognito mode. Source-of-truth is
   * the main process; renderers may read but cannot durably claim
   * incognito on their own. Defaults to `false` on a fresh workspace.
   *
   * Each consumer defines its own fail-closed result at the main-process
   * boundary. Main composition and focused consumer tests own the inventory.
   */
  incognitoActive: boolean;
}

// ---------------------------------------------------------------------------
// Default / factory
// ---------------------------------------------------------------------------

/**
 * Canonical default. A fresh workspace, or any path that has not yet
 * resolved an authoritative privacy snapshot, MUST use this — never
 * leave `incognitoActive` undefined and never assume true unless main
 * has confirmed.
 */
export function defaultWorkspacePrivacyContext(): WorkspacePrivacyContext {
  return { incognitoActive: false };
}

// ---------------------------------------------------------------------------
// Result envelope (mirrors PR-MEMORY-1 / PR-SEARCH-0 normalizer pattern)
// ---------------------------------------------------------------------------

export type WorkspacePrivacyContextResult =
  | { ok: true; value: WorkspacePrivacyContext }
  | { ok: false; reason: WorkspacePrivacyContextInvalidReason; message: string };

export type WorkspacePrivacyContextInvalidReason = 'not_object' | 'incognito_active_invalid';

// ---------------------------------------------------------------------------
// Type guard + validator
// ---------------------------------------------------------------------------

/**
 * Type guard. Use when the caller has already accepted that a non-
 * matching value should fall back to a default — for cases where the
 * caller wants a typed reason on failure, use
 * `validateWorkspacePrivacyContext`.
 */
export function isWorkspacePrivacyContext(value: unknown): value is WorkspacePrivacyContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.incognitoActive === 'boolean';
}

/**
 * Validate + canonicalize a `WorkspacePrivacyContext` payload.
 *
 * Pipeline:
 *   1. typeof object guard (rejects null / array / primitive / function).
 *   2. `incognitoActive` typeof boolean guard.
 *
 * Returns the canonical record (only `incognitoActive`; extra fields
 * stripped) on success, or a typed rejection. Missing or non-boolean
 * `incognitoActive` is REJECTED — the validator never invents a
 * default. The only path to a default is the explicit
 * `defaultWorkspacePrivacyContext()` factory.
 *
 * Authority gate (per xuan `ece30c92`): renderer payloads passing
 * through this validator are still subject to the rule that the
 * renderer is NOT the write source. An IPC handler accepting an
 * incognito snapshot from renderer MUST treat the renderer's value
 * as untrusted; main / session / workspace owner is the only valid
 * write authority for the actual workspace state.
 *
 * @see docs/workspace-privacy-context.md "Consumer rule"
 */
export function validateWorkspacePrivacyContext(input: unknown): WorkspacePrivacyContextResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      ok: false,
      reason: 'not_object',
      message: 'WorkspacePrivacyContext must be an object',
    };
  }
  const record = input as Record<string, unknown>;
  if (typeof record.incognitoActive !== 'boolean') {
    return {
      ok: false,
      reason: 'incognito_active_invalid',
      message: 'WorkspacePrivacyContext.incognitoActive must be a boolean',
    };
  }
  // Extra fields stripped — canonical return contains ONLY documented
  // fields. Matches the IPC-1 / IPC-2 / IPC-3 normalize-and-strip
  // pattern.
  return { ok: true, value: { incognitoActive: record.incognitoActive } };
}
