import assert from 'node:assert/strict';
import test from 'node:test';

// electron-builder rejects an unknown option outright (its schema sets
// `additionalProperties: false`), and the release workflow is the only thing
// that ever loads this config — so a misspelled or removed option is invisible
// until release day, on both platforms at once, because macOS and Windows share
// one config object. This asserts the config against electron-builder's own
// validator rather than restating its rules. If a future electron-builder moves
// this module, update the path here; the version is pinned in package.json.
const { validateConfiguration } = await import(
  new URL('../node_modules/app-builder-lib/out/util/config/config.js', import.meta.url)
);

// `validateConfiguration` only reads the config, so it is passed as loaded — a
// structured clone would throw on the function hooks electron-builder configs
// are allowed to carry, turning a valid config into a failing test.
const loadConfig = async () =>
  (await import(new URL('../apps/desktop/electron-builder.config.mjs', import.meta.url))).default;

test('the desktop release config is valid for the installed electron-builder', async () => {
  await validateConfiguration(await loadConfig(), { add: () => {} });
});

test('an unknown release option is rejected rather than ignored', async () => {
  const config = await loadConfig();

  // electron-builder 26.15 flattens ajv oneOf errors, so the message no
  // longer names the offending property — it reports the enclosing path
  // ("configuration.win should be one of these"). The contract that still
  // matters is that an unknown option rejects at all.
  await assert.rejects(
    validateConfiguration({ ...config, win: { ...config.win, sign: false } }, { add: () => {} }),
    /(?:Error: )?Invalid configuration object\. electron-builder \d+\.\d+\.\d+ has been initialized using a configuration object that does not match the API schema\.\n - configuration\.win/,
  );
});
