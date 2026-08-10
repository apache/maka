import { parseCommandLine } from './mcp-command-line.js';

export type McpEditorDraft = {
  id: string;
  kind: 'stdio' | 'remote';
  commandLine: string;
  url: string;
};

export type McpEditorValidationCode =
  | 'required'
  | 'invalid-url'
  | 'unbalanced-quote';
export type McpEditorErrors = Partial<
  Record<'id' | 'commandLine' | 'url', McpEditorValidationCode>
>;

export function validateMcpEditorDraft(
  draft: McpEditorDraft,
): McpEditorErrors {
  const errors: McpEditorErrors = {};
  if (!draft.id.trim()) errors.id = 'required';

  if (draft.kind === 'stdio') {
    const parsed = parseCommandLine(draft.commandLine);
    if (!parsed.ok) {
      errors.commandLine = 'unbalanced-quote';
    } else if (!parsed.command.trim()) {
      errors.commandLine = 'required';
    }
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
