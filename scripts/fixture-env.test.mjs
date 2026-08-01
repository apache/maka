import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { buildFixtureEnv } from './fixture-env.mjs';

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

test('fixture launch state comes only from explicit arguments', () => {
  setEnv('CI', 'true');
  setEnv('MAKA_E2E_SHOW_WINDOW', '1');
  setEnv('MAKA_E2E_FIXTURE_THEME', 'dark');
  setEnv('MAKA_E2E_FIXTURE_LOCALE', 'en');
  setEnv('ANTHROPIC_API_KEY', 'sk-real-key');
  setEnv('SOME_API_TOKEN', 'secret-token');
  setEnv('X_API_SECRET', 'secret-value');

  const env = buildFixtureEnv('/tmp/data', '/tmp/data/home', {
    scenario: 'first-run',
    theme: 'light',
    timezone: 'UTC',
  });

  assert.equal(env.MAKA_E2E, '1');
  assert.equal(env.MAKA_SKIP_SHELL_ENV, '1');
  assert.equal(env.MAKA_E2E_SHOW_WINDOW, undefined);
  assert.equal(env.MAKA_E2E_FIXTURE_THEME, 'light');
  assert.equal(env.MAKA_E2E_FIXTURE_LOCALE, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.SOME_API_TOKEN, undefined);
  assert.equal(env.X_API_SECRET, undefined);
  assert.equal(env.HOME, '/tmp/data/home');
  assert.equal(env.USERPROFILE, '/tmp/data/home');
  assert.equal(env.MAKA_E2E_USER_DATA_DIR, '/tmp/data');
  assert.equal(env.MAKA_E2E_FIXTURE_TIMEZONE, 'UTC');
});
