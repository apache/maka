import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);
const codeModeBuild = 'npm --workspace @maka/code-mode run build';
const runtimeBuild = 'npm --workspace @maka/runtime run build';

async function readManifest(path) {
  return JSON.parse(await readFile(new URL(path, repoRoot), 'utf8'));
}

test('product build paths build CodeMode before Runtime', async () => {
  const root = await readManifest('package.json');
  const desktop = await readManifest('apps/desktop/package.json');
  const cli = await readManifest('packages/cli/package.json');
  const manifests = [
    ['root', root],
    ['desktop', desktop],
    ['CLI', cli],
  ];

  for (const [manifestLabel, manifest] of manifests) {
    for (const [scriptName, script] of Object.entries(manifest.scripts)) {
      const runtimeIndex = script.indexOf(runtimeBuild);
      if (runtimeIndex === -1) continue;
      const label = `${manifestLabel} ${scriptName}`;
      const codeModeIndex = script.indexOf(codeModeBuild);
      assert.notEqual(codeModeIndex, -1, `${label} must build CodeMode`);
      assert.ok(codeModeIndex < runtimeIndex, `${label} must build CodeMode before Runtime`);
    }
  }
});
