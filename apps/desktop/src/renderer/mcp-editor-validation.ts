export type McpEditorDraft = {
  id: string;
  kind: 'stdio' | 'remote';
  command: string;
  url: string;
};

export type McpEditorValidationCode = 'required' | 'invalid-url';
export type McpEditorErrors = Partial<
  Record<'id' | 'command' | 'url', McpEditorValidationCode>
>;

export function validateMcpEditorDraft(
  draft: McpEditorDraft,
): McpEditorErrors {
  const errors: McpEditorErrors = {};
  if (!draft.id.trim()) errors.id = 'required';

  if (draft.kind === 'stdio') {
    if (!draft.command.trim()) errors.command = 'required';
    return errors;
  }

  const value = draft.url.trim();
  if (!value) {
    errors.url = 'required';
    return errors;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.url = 'invalid-url';
    }
  } catch {
    errors.url = 'invalid-url';
  }
  return errors;
}
