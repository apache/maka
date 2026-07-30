// The isolation rules for a fixture launch, pinned.
//
// Every entry here corresponds to a way a run can silently measure something
// other than the build under test. The migration harness shipped with none of
// them because it spread `process.env` wholesale instead of reusing this
// builder, and no test noticed — a leaked variable does not fail anything, it
// just changes what you captured.
import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { buildFixtureEnv, isCiLinuxDisplay, isDeniedEnvKey } from './fixture-env.mjs';

const originals = new Map();
function setEnv(key, value) {
  if (!originals.has(key)) originals.set(key, process.env[key]);
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originals.clear();
});

describe('isDeniedEnvKey', () => {
  it('drops the dev server URL', () => {
    // main-window.ts loads VITE_DEV_SERVER_URL when set, with no fixture
    // guard: a developer running `npm run dev` would capture the dev server's
    // renderer instead of the bundle they just built.
    assert.equal(isDeniedEnvKey('VITE_DEV_SERVER_URL'), true);
  });

  it('drops every MAKA_E2E variable so the shell cannot steer the run', () => {
    for (const key of [
      'MAKA_E2E',
      'MAKA_E2E_FIXTURE',
      'MAKA_E2E_FIXTURE_THEME',
      'MAKA_E2E_FIXTURE_LOCALE',
      'MAKA_E2E_FIXTURE_PLATFORM',
      'MAKA_E2E_SHOW_WINDOW',
      'MAKA_E2E_USER_DATA_DIR',
    ]) {
      assert.equal(isDeniedEnvKey(key), true, `${key} must not be inherited`);
    }
  });

  it('drops provider credentials', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SOME_API_TOKEN', 'X_API_SECRET']) {
      assert.equal(isDeniedEnvKey(key), true);
    }
  });

  it('keeps the platform environment Electron needs', () => {
    // Deny-list, not allow-list: Electron relies on undocumented platform env
    // that an allow-list would silently drop.
    for (const key of ['PATH', 'HOME', 'LANG', 'DISPLAY', 'XDG_RUNTIME_DIR', 'TMPDIR']) {
      assert.equal(isDeniedEnvKey(key), false, `${key} must survive`);
    }
  });
});

describe('buildFixtureEnv', () => {
  it('does not let an exported MAKA_E2E_SHOW_WINDOW leak into a hidden run', () => {
    // The realistic path: someone uses `launch:fixture`, exports the variable
    // in that shell, then captures a baseline — against a visible, focused
    // window, silently different from every other capture.
    setEnv('MAKA_E2E_SHOW_WINDOW', '1');
    const env = buildFixtureEnv('/tmp/data', '/tmp/home', { scenario: 'first-run' });
    assert.equal(env.MAKA_E2E_SHOW_WINDOW, undefined);
  });

  it('answers only from its arguments, never from the ambient environment', () => {
    // The first version of this builder read process.env.CI inline, so this
    // very suite passed on every laptop and failed on the Linux CI runner —
    // "hidden run" meant a different thing depending on where you asked. The
    // ambient read now lives in isCiLinuxDisplay for callers to compose.
    setEnv('CI', 'true');
    const env = buildFixtureEnv('/tmp/data', '/tmp/home', { scenario: 'first-run' });
    assert.equal(env.MAKA_E2E_SHOW_WINDOW, undefined);
  });

  it('sets show-window only when asked', () => {
    const env = buildFixtureEnv('/tmp/data', '/tmp/home', { showWindow: true });
    assert.equal(env.MAKA_E2E_SHOW_WINDOW, '1');
  });

  it('does not let an exported theme or locale steer the capture', () => {
    setEnv('MAKA_E2E_FIXTURE_THEME', 'dark');
    setEnv('MAKA_E2E_FIXTURE_LOCALE', 'en');
    const env = buildFixtureEnv('/tmp/data', '/tmp/home', { theme: 'light' });
    assert.equal(env.MAKA_E2E_FIXTURE_THEME, 'light');
    assert.equal(env.MAKA_E2E_FIXTURE_LOCALE, undefined);
  });

  it('strips a host provider key', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-real-key');
    const env = buildFixtureEnv('/tmp/data', '/tmp/home', { scenario: 'first-run' });
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  it('sandboxes the home directory in both POSIX and Windows form', () => {
    const env = buildFixtureEnv('/tmp/data', '/tmp/data/home');
    assert.equal(env.HOME, '/tmp/data/home');
    assert.equal(env.USERPROFILE, '/tmp/data/home');
    assert.equal(env.MAKA_E2E_USER_DATA_DIR, '/tmp/data');
  });

  it('pins the timezone through the fixture override when asked', () => {
    // Absolute times render through the host zone, so an unpinned capture
    // diffs against itself across machines.
    const env = buildFixtureEnv('/tmp/data', '/tmp/home', { timezone: 'UTC' });
    assert.equal(env.MAKA_E2E_FIXTURE_TIMEZONE, 'UTC');
  });

  it('marks the run as E2E and skips the login-shell PATH probe', () => {
    const env = buildFixtureEnv('/tmp/data', '/tmp/home');
    assert.equal(env.MAKA_E2E, '1');
    assert.equal(env.MAKA_SKIP_SHELL_ENV, '1');
  });
});

describe('isCiLinuxDisplay', () => {
  it('asks for a visible window only on a Linux CI display', () => {
    // xvfb throttles a hidden window's compositor to ~1fps; a laptop must
    // stay hidden so a run never steals the developer's focus.
    assert.equal(isCiLinuxDisplay({ CI: 'true' }, 'linux'), true);
    assert.equal(isCiLinuxDisplay({}, 'linux'), false);
    assert.equal(isCiLinuxDisplay({ CI: 'true' }, 'darwin'), false);
    assert.equal(isCiLinuxDisplay({ CI: 'true' }, 'win32'), false);
  });
});
