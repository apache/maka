/** Main-owned workspace privacy state. Invalid boundary data fails closed. */

export interface WorkspacePrivacyContext {
  /** Renderers may read this value but cannot claim write authority. */
  incognitoActive: boolean;
}

export type WorkspacePrivacyContextResult =
  | { ok: true; value: WorkspacePrivacyContext }
  | { ok: false; reason: WorkspacePrivacyContextInvalidReason; message: string };

export type WorkspacePrivacyContextInvalidReason = 'not_object' | 'incognito_active_invalid';

/** Validate and strip a privacy payload without inventing a default. */
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
  return { ok: true, value: { incognitoActive: record.incognitoActive } };
}
