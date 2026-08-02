import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  extractToolCommand,
  formatAsKeyValueLines,
  formatQuietJsonValue,
  formatToolInvocationLine,
} from '../tool-quiet-preview.js';

describe('tool quiet preview', () => {
  it('extracts command aliases and rejects non-command shapes', () => {
    assert.equal(extractToolCommand({ command: 'ls -la' }), 'ls -la');
    assert.equal(extractToolCommand({ cmd: 'echo hi' }), 'echo hi');
    assert.equal(extractToolCommand({ script: 'run.sh' }), 'run.sh');
    assert.equal(extractToolCommand({ path: '/foo' }), undefined);
    assert.equal(extractToolCommand(undefined), undefined);
    assert.equal(extractToolCommand('string'), undefined);
  });

  it('projects known invocations and uses key-value fallback', () => {
    assert.equal(
      formatToolInvocationLine({ toolName: 'Bash', args: { command: 'npm test' } }, 'en'),
      'npm test',
    );
    assert.equal(
      formatToolInvocationLine({ toolName: 'Read', args: { path: '/foo/bar.ts' } }, 'en'),
      '/foo/bar.ts',
    );
    assert.equal(
      formatToolInvocationLine({ toolName: 'Skill', args: { name: 'my-skill' } }, 'en'),
      'my-skill',
    );
    const stdin = { inputPreview: { text: 'echo hi', bytes: 7, truncated: false } };
    assert.match(
      formatToolInvocationLine({ toolName: 'WriteStdin', args: stdin }, 'zh')!,
      /后台终端交互/,
    );
    assert.match(
      formatToolInvocationLine({ toolName: 'WriteStdin', args: stdin }, 'en')!,
      /Background terminal interaction/,
    );
    const fallback = formatToolInvocationLine(
      { toolName: 'Custom', args: { alpha: 1, beta: 'two' } },
      'en',
    )!;
    assert.match(fallback, /alpha: 1/);
    assert.match(fallback, /beta: two/);
    assert.doesNotMatch(fallback, /\{/);
  });

  it('formats localized results, lists, replacements, and diagnostics', () => {
    assert.equal(formatQuietJsonValue(null, 'zh').body, '（空）');
    assert.equal(formatQuietJsonValue(null, 'en').body, '(empty)');
    for (const locale of ['zh', 'en'] as const) {
      const output = formatQuietJsonValue({ ok: true, path: '/foo.ts', bytes: 42 }, locale);
      assert.equal(output.headline, '/foo.ts');
      assert.match(output.body, locale === 'zh' ? /已完成/ : /done/);
      assert.match(output.body, /42 B/);
    }
    assert.match(
      formatQuietJsonValue({ ok: true, path: '/foo.ts', replacements: 3 }, 'zh').body,
      /3 处/,
    );
    assert.match(
      formatQuietJsonValue({ ok: true, path: '/foo.ts', replacements: 3 }, 'en').body,
      /3 replacements/,
    );
    const list = formatQuietJsonValue({ matches: ['a.ts:1:foo', 'b.ts:2:bar'] }, 'en').body;
    assert.match(list, /a\.ts:1:foo/);
    assert.match(list, /b\.ts:2:bar/);
    const diagnostic = formatQuietJsonValue({ results: [], error: 'denied', ok: false }, 'en').body;
    assert.match(diagnostic, /error: denied/);
    assert.match(diagnostic, /ok: false/);
  });

  it('redacts secrets in values and embedded keys', () => {
    const value = formatQuietJsonValue({ password: 'correct-horse', ok: true }, 'en').body;
    assert.doesNotMatch(value, /correct-horse/);
    assert.match(value, /redacted/i);
    const key = formatAsKeyValueLines({ 'password=secret': true }, 0, 'en');
    assert.doesNotMatch(key, /secret/);
    assert.match(key, /redacted/i);
  });
});
