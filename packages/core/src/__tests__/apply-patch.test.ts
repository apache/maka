import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyUpdateChunksToContent,
  assertSafePatchPath,
  parseApplyPatch,
} from '../apply-patch.js';

function envelope(body: string): string {
  return `*** Begin Patch\n${body}*** End Patch\n`;
}

describe('parseApplyPatch', () => {
  test('parses add, update, move, and delete operations', () => {
    const patch = envelope(
      [
        '*** Add File: hello.txt',
        '+Hello',
        '*** Update File: src/app.py',
        '*** Move to: src/main.py',
        '@@ def greet():',
        '-print("Hi")',
        '+print("Hello")',
        '*** Delete File: obsolete.txt',
        '',
      ].join('\n'),
    );
    const parsed = parseApplyPatch(patch);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.hunks.length, 3);
    assert.deepEqual(parsed.value.hunks[0], {
      kind: 'add',
      path: 'hello.txt',
      contents: 'Hello\n',
    });
    assert.equal(parsed.value.hunks[1]?.kind, 'update');
    if (parsed.value.hunks[1]?.kind === 'update') {
      assert.equal(parsed.value.hunks[1].path, 'src/app.py');
      assert.equal(parsed.value.hunks[1].movePath, 'src/main.py');
      assert.equal(parsed.value.hunks[1].chunks.length, 1);
    }
    assert.deepEqual(parsed.value.hunks[2], { kind: 'delete', path: 'obsolete.txt' });
  });

  test('strips heredoc wrappers in lenient mode', () => {
    const patch = [
      "<<'EOF'",
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+x',
      '*** End Patch',
      'EOF',
    ].join('\n');
    const parsed = parseApplyPatch(patch);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.hunks[0]?.kind, 'add');
  });

  test('rejects absolute paths at the tool safety check', () => {
    assert.ok(assertSafePatchPath('/etc/passwd'));
    assert.ok(assertSafePatchPath('C:/Windows/system32'));
    assert.ok(assertSafePatchPath('../escape'));
    assert.equal(assertSafePatchPath('src/ok.ts'), null);
  });
});

describe('applyUpdateChunksToContent', () => {
  test('applies a unique hunk and preserves CRLF', () => {
    const original = 'line1\r\nline2\r\nline3\r\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          oldLines: ['line2'],
          newLines: ['line2-updated'],
          isEndOfFile: false,
        },
      ],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'line1\r\nline2-updated\r\nline3\r\n');
  });

  test('fails when the hunk is not unique', () => {
    const original = 'a\nx\nb\nx\nc\n';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: ['x'], newLines: ['y'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, false);
  });

  test('pure insertion without EOF marker appends at EOF', () => {
    const original = 'line1\nline2\n';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: [], newLines: ['appended'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'line1\nline2\nappended\n');
  });

  test('preserves CR-only line endings outside the edit', () => {
    const original = 'a\rb\rc\r';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: ['b'], newLines: ['B'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'a\rB\rc\r');
  });

  test('preserves mixed endings outside the edited region', () => {
    const original = 'a\r\nb\nc\r';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: ['b'], newLines: ['B'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Untouched lines keep their original terminators; the replaced line uses
    // the file's dominant default ending (CRLF here because the file has CRLF).
    assert.equal(result.content, 'a\r\nB\r\nc\r');
  });
});
