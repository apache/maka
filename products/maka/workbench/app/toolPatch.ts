/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

export type ToolPatchFile = {
  path: string;
  operation: 'create' | 'update' | 'delete';
  hunks: { context: string; before: string; after: string }[];
};

const fileHeader = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const linesOf = (text: string) => text.replace(/\r?\n$/, '').split(/\r?\n/);

function patchFile(
  path: string,
  operation: ToolPatchFile['operation'],
  lines: string[],
): ToolPatchFile | null {
  if (operation === 'delete') return lines.length ? null : { path, operation, hunks: [] };
  if (operation === 'create') {
    if (!lines.length || lines.some((line) => !line.startsWith('+'))) return null;
    return {
      path,
      operation,
      hunks: [{ context: '', before: '', after: lines.map((line) => line.slice(1)).join('\n') }],
    };
  }
  const hunks: ToolPatchFile['hunks'] = [];
  let context = '';
  let before: string[] = [];
  let after: string[] = [];
  const flush = () => {
    if (!before.length && !after.length) return;
    hunks.push({ context, before: before.join('\n'), after: after.join('\n') });
    before = [];
    after = [];
  };
  for (const line of lines) {
    if (line === '@@' || line.startsWith('@@ ')) {
      flush();
      context = line.slice(3);
    } else if (line === '*** End of File') {
      flush();
      context = '';
    } else if (line.startsWith('+')) {
      after.push(line.slice(1));
    } else if (line.startsWith('-')) {
      before.push(line.slice(1));
    } else if (line === '' || line.startsWith(' ')) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    } else {
      return null;
    }
  }
  flush();
  return hunks.length ? { path, operation, hunks } : null;
}

/** Show the patch's requested excerpts. These hunks carry no original file line numbers. */
export function structuredToolPatch(
  path: string,
  type: string,
  diff: string | undefined,
): ToolPatchFile[] | null {
  const operation =
    type === 'create_file'
      ? 'create'
      : type === 'update_file'
        ? 'update'
        : type === 'delete_file'
          ? 'delete'
          : null;
  if (!operation) return null;
  const file = patchFile(path, operation, diff ? linesOf(diff) : []);
  return file ? [file] : null;
}

export function textToolPatch(patch: string): ToolPatchFile[] | null {
  const lines = linesOf(patch.trim());
  if (lines[0] !== '*** Begin Patch' || lines.at(-1) !== '*** End Patch') return null;
  const files: ToolPatchFile[] = [];
  let current: { path: string; operation: ToolPatchFile['operation']; lines: string[] } | null =
    null;
  for (const line of lines.slice(1, -1)) {
    const marker = fileHeader.exec(line.trim());
    if (marker) {
      if (current) {
        const file = patchFile(current.path, current.operation, current.lines);
        if (!file) return null;
        files.push(file);
      }
      current = {
        path: marker[2]!,
        operation: marker[1] === 'Add' ? 'create' : marker[1] === 'Update' ? 'update' : 'delete',
        lines: [],
      };
    } else if (current) {
      current.lines.push(line);
    } else {
      return null;
    }
  }
  if (!current) return null;
  const file = patchFile(current.path, current.operation, current.lines);
  return file ? [...files, file] : null;
}
