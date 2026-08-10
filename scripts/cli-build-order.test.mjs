import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const repoRoot = new URL('../', import.meta.url);

function workspaceBuild(name) {
  return `npm --workspace ${name} run build`;
}

async function readManifest(path) {
  return JSON.parse(await readFile(new URL(path, repoRoot), 'utf8'));
}

test('CLI pretest builds direct workspace dependencies and orders Eval', async () => {
  const root = await readManifest('package.json');
  const cli = await readManifest('packages/cli/package.json');
  const evalPackage = await readManifest('packages/eval/package.json');
  const workspaceNames = new Set();

  for (const workspacePath of root.workspaces) {
    const manifest = await readManifest(`${workspacePath}/package.json`);
    workspaceNames.add(manifest.name);
  }

  const pretest = cli.scripts.pretest;
  const directWorkspaceDependencies = Object.keys(cli.dependencies ?? {}).filter((name) =>
    workspaceNames.has(name),
  );

  for (const dependency of directWorkspaceDependencies) {
    assert.notEqual(
      pretest.indexOf(workspaceBuild(dependency)),
      -1,
      `CLI pretest must build ${dependency}`,
    );
  }

  const evalIndex = pretest.indexOf(workspaceBuild(evalPackage.name));
  const evalWorkspaceDependencies = Object.keys(evalPackage.dependencies ?? {}).filter((name) =>
    workspaceNames.has(name),
  );
  for (const dependency of evalWorkspaceDependencies) {
    const dependencyIndex = pretest.indexOf(workspaceBuild(dependency));
    assert.notEqual(
      dependencyIndex,
      -1,
      `CLI pretest must build ${dependency} before ${evalPackage.name}`,
    );
    assert.ok(
      dependencyIndex < evalIndex,
      `CLI pretest must build ${dependency} before ${evalPackage.name}`,
    );
  }
});
