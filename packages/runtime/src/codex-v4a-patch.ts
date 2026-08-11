import type { ApplyPatchOperation } from './filesystem-executor.js';

export class CodexV4aPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexV4aPatchError';
  }
}

const FILE_HEADER = /^\*\*\* (Add|Delete|Update) File: (.+)$/;

function isUpdateDiffLine(line: string): boolean {
  return (
    line === '@@' || line.startsWith('@@ ') || line === '*** End of File' || /^[ +\-]/.test(line)
  );
}

/** Parse the client-executed subset of the Codex V4A envelope into existing operations. */
export function parseCodexV4aPatch(input: string): ApplyPatchOperation[] {
  const lines = input.replaceAll('\r\n', '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new CodexV4aPatchError(
      'ApplyPatch input must start with *** Begin Patch and end with *** End Patch.',
    );
  }

  const operations: ApplyPatchOperation[] = [];
  for (let index = 0; index < lines.length; ) {
    const header = FILE_HEADER.exec(lines[index] ?? '');
    if (!header) {
      throw new CodexV4aPatchError(`Invalid ApplyPatch file header at line ${index + 2}.`);
    }
    const [, action, rawPath] = header;
    const path = rawPath?.trim();
    if (!path) throw new CodexV4aPatchError('ApplyPatch file paths cannot be empty.');
    index += 1;

    if (action === 'Delete') {
      operations.push({ type: 'delete_file', path });
      continue;
    }
    if (action === 'Update' && lines[index]?.startsWith('*** Move to:')) {
      throw new CodexV4aPatchError(
        'ApplyPatch Move is not supported; add the destination and delete the source instead.',
      );
    }

    const body: string[] = [];
    while (index < lines.length && !FILE_HEADER.test(lines[index] ?? '')) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    if (body.length === 0) {
      throw new CodexV4aPatchError(`ApplyPatch ${action} for ${path} has no diff.`);
    }
    if (action === 'Add') {
      if (body.some((line) => !line.startsWith('+'))) {
        throw new CodexV4aPatchError(`ApplyPatch Add for ${path} must prefix every line with +.`);
      }
      operations.push({ type: 'create_file', path, diff: [...body, '+'].join('\n') });
      continue;
    }
    if (body.some((line) => !isUpdateDiffLine(line))) {
      throw new CodexV4aPatchError(`ApplyPatch Update for ${path} contains an invalid diff line.`);
    }
    operations.push({ type: 'update_file', path, diff: body.join('\n') });
  }

  if (operations.length === 0) {
    throw new CodexV4aPatchError('ApplyPatch input must contain at least one file operation.');
  }
  return operations;
}

export function serializeCodexV4aOperation(operation: ApplyPatchOperation): string {
  const header =
    operation.type === 'create_file'
      ? `*** Add File: ${operation.path}`
      : operation.type === 'delete_file'
        ? `*** Delete File: ${operation.path}`
        : `*** Update File: ${operation.path}`;
  const body = operation.type === 'delete_file' ? '' : `\n${operation.diff.replace(/\n$/, '')}`;
  return `*** Begin Patch\n${header}${body}\n*** End Patch`;
}
