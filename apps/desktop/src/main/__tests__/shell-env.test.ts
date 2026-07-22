/**
 * PR #1316 review coverage: lock the per-shell capture-command quoting, the
 * marker-adjacency contract (which is why the dead xonsh branch was dropped),
 * and the mergeEnv preservation / stripping rules. Pure-function unit tests
 * — same `node:test` + `node:assert/strict` layout as `build-info.test.ts`.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildCaptureCommand, buildMarkerRegex, mergeEnv } from '../shell-env.js';

const MARK = '0123456789ab';

describe('buildCaptureCommand', () => {
  describe('POSIX family (bash / zsh / fish / sh)', () => {
    it('zsh produces the -i -l -c argv and a flush-marker payload', () => {
      const { command, shellArgs } = buildCaptureCommand('zsh', '/usr/bin/node', MARK);
      assert.deepEqual(shellArgs, ['-i', '-l', '-c']);
      assert.equal(
        command,
        `'/usr/bin/node' -p '"${MARK}" + JSON.stringify(process.env) + "${MARK}"'`,
      );
      // The payload concatenates mark + JSON + mark with no separator, so the
      // emitted bytes are `<mark>{...}<mark>` — markers flush against the
      // braces the capture regex anchors on.
      const emitted = `${MARK}${JSON.stringify({ k: 'v' })}${MARK}`;
      const match = buildMarkerRegex(MARK).exec(emitted);
      assert.ok(match);
      assert.equal(match[1], JSON.stringify({ k: 'v' }));
    });

    it('tcsh / csh collapse to the legacy single -ic argv', () => {
      const tcsh = buildCaptureCommand('tcsh', '/usr/bin/node', MARK);
      assert.deepEqual(tcsh.shellArgs, ['-ic']);
      const csh = buildCaptureCommand('csh', '/usr/bin/node', MARK);
      assert.deepEqual(csh.shellArgs, ['-ic']);
      // Same flush-marker payload as the rest of the POSIX family.
      assert.equal(
        tcsh.command,
        `'/usr/bin/node' -p '"${MARK}" + JSON.stringify(process.env) + "${MARK}"'`,
      );
    });

    it('round-trips an apostrophe in execPath via the close-quote / escape / reopen sequence', () => {
      // POSIX single-quoting cannot contain a literal `'`; the safe escape is
      // to close the quote, emit a backslash-escaped quote, and reopen.
      const { command, shellArgs } = buildCaptureCommand('bash', "/Users/Bob's/node", MARK);
      assert.deepEqual(shellArgs, ['-i', '-l', '-c']);
      assert.equal(
        command,
        `'/Users/Bob'\\''s/node' -p '"${MARK}" + JSON.stringify(process.env) + "${MARK}"'`,
      );
    });
  });

  describe('PowerShell', () => {
    it('uses -Login -Command and doubles an embedded apostrophe', () => {
      const { command, shellArgs } = buildCaptureCommand('pwsh', "/Users/Bob's/node", MARK);
      assert.deepEqual(shellArgs, ['-Login', '-Command']);
      // PowerShell single-quoted strings escape `'` as `''`.
      assert.equal(
        command,
        `& '/Users/Bob''s/node' -p '''${MARK}'' + JSON.stringify(process.env) + ''${MARK}'''`,
      );
    });

    it('matches powershell-preview too and leaves an apostrophe-free path untouched', () => {
      const { command, shellArgs } = buildCaptureCommand('powershell-preview', '/usr/bin/node', MARK);
      assert.deepEqual(shellArgs, ['-Login', '-Command']);
      assert.equal(
        command,
        `& '/usr/bin/node' -p '''${MARK}'' + JSON.stringify(process.env) + ''${MARK}'''`,
      );
    });
  });

  describe('nu', () => {
    it('uses a raw string and -i -l -c (embedded quotes are a documented edge case)', () => {
      const { command, shellArgs } = buildCaptureCommand('nu', '/usr/bin/node', MARK);
      assert.deepEqual(shellArgs, ['-i', '-l', '-c']);
      assert.equal(
        command,
        `^'/usr/bin/node' -p '"${MARK}" + JSON.stringify(process.env) + "${MARK}"'`,
      );
    });
  });

  it('xonsh falls into the POSIX branch (the dedicated branch is gone)', () => {
    // xonsh is intentionally unsupported. It must NOT get a special argv and
    // must share the POSIX payload — proving the dead branch was removed.
    const { command, shellArgs } = buildCaptureCommand('xonsh', '/usr/bin/node', MARK);
    assert.deepEqual(shellArgs, ['-i', '-l', '-c']);
    assert.equal(
      command,
      `'/usr/bin/node' -p '"${MARK}" + JSON.stringify(process.env) + "${MARK}"'`,
    );
  });
});

describe('buildMarkerRegex', () => {
  it('matches <mark>{...}<mark> and captures the JSON body', () => {
    const regex = buildMarkerRegex(MARK);
    const match = regex.exec(`${MARK}${JSON.stringify({ k: 'v' })}${MARK}`);
    assert.ok(match);
    assert.equal(match[1], JSON.stringify({ k: 'v' }));
  });

  it('captures the body across newlines (dotall via [\\s\\S])', () => {
    // Shell init noise / pretty-printed env can land newlines inside the JSON
    // object; the regex must span them.
    const body = JSON.stringify({ k: 'v\nmulti', nested: { a: 1 } });
    const match = buildMarkerRegex(MARK).exec(`${MARK}${body}${MARK}`);
    assert.ok(match);
    assert.equal(match[1], body);
  });

  it('does NOT match the old xonsh shape `mark {...} mark` (space-separated)', () => {
    // The dropped xonsh branch ran Python `print(mark, json, mark)`, whose
    // default sep joins args with a SPACE — producing `mark {...} mark`. That
    // shape never satisfied the flush-marker regex, which is exactly why the
    // branch was dead. This test is the guard that would have caught review
    // item #3 before it shipped.
    const xonshShape = `${MARK} {"k":"v"} ${MARK}`;
    assert.equal(buildMarkerRegex(MARK).exec(xonshShape), null);
  });
});

describe('mergeEnv', () => {
  // mergeEnv mutates the global `process.env`; snapshot every key before each
  // test and restore exactly afterward so the suite stays hermetic.
  function snapshotEnv(): () => void {
    const before = new Map<string, string>();
    for (const [key, value] of Object.entries(process.env)) before.set(key, value as string);
    return () => {
      for (const key of Object.keys(process.env)) {
        if (!before.has(key)) delete process.env[key];
      }
      for (const [key, value] of before) process.env[key] = value;
    };
  }

  it('applies the resolved PATH (resolved wins for user-configured vars)', () => {
    const restore = snapshotEnv();
    try {
      delete process.env.PATH;
      mergeEnv({ PATH: '/resolved/bin:/usr/bin' });
      assert.equal(process.env.PATH, '/resolved/bin:/usr/bin');
    } finally {
      restore();
    }
  });

  it('strips XDG_RUNTIME_DIR so the login-shell runtime dir never overwrites the original', () => {
    // microsoft/vscode#22593: the shell's runtime dir must not persist into
    // GUI-process children. The resolved value is dropped before the apply
    // loop, so a pre-existing original is left untouched.
    const restore = snapshotEnv();
    try {
      process.env.XDG_RUNTIME_DIR = '/original/runtime';
      mergeEnv({ XDG_RUNTIME_DIR: '/shell/runtime', PATH: '/bin' });
      assert.equal(process.env.XDG_RUNTIME_DIR, '/original/runtime');
    } finally {
      restore();
    }
  });

  it('also drops XDG_RUNTIME_DIR when the original env lacked one', () => {
    const restore = snapshotEnv();
    try {
      delete process.env.XDG_RUNTIME_DIR;
      mergeEnv({ XDG_RUNTIME_DIR: '/shell/runtime', PATH: '/bin' });
      assert.equal(process.env.XDG_RUNTIME_DIR, undefined);
    } finally {
      restore();
    }
  });

  it('preserves a pre-existing MAKA_* value the resolved env tried to overwrite', () => {
    // The prefix-rule refactor must restore ANY MAKA_* key, even ones not on
    // a hand-maintained list — this is what survives future MAKA_* renames.
    const restore = snapshotEnv();
    try {
      process.env.MAKA_FUTURE_FLAG = 'original';
      mergeEnv({ MAKA_FUTURE_FLAG: 'from-shell', PATH: '/bin' });
      assert.equal(process.env.MAKA_FUTURE_FLAG, 'original');
    } finally {
      restore();
    }
  });

  it('deletes a preserved key that was absent from the original env', () => {
    const restore = snapshotEnv();
    try {
      delete process.env.ELECTRON_RUN_AS_NODE;
      mergeEnv({ PATH: '/bin' });
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
    } finally {
      restore();
    }
  });

  it('preserves the Electron-specific trio even when the resolved env carries it', () => {
    const restore = snapshotEnv();
    try {
      process.env.ELECTRON_RUN_AS_NODE = '1';
      process.env.ELECTRON_NO_ATTACH_CONSOLE = '1';
      process.env.ORIGINAL_XDG_CURRENT_DESKTOP = 'GNOME';
      mergeEnv({
        ELECTRON_RUN_AS_NODE: 'from-shell',
        ELECTRON_NO_ATTACH_CONSOLE: 'from-shell',
        ORIGINAL_XDG_CURRENT_DESKTOP: 'from-shell',
        PATH: '/bin',
      });
      assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(process.env.ELECTRON_NO_ATTACH_CONSOLE, '1');
      assert.equal(process.env.ORIGINAL_XDG_CURRENT_DESKTOP, 'GNOME');
    } finally {
      restore();
    }
  });
});
