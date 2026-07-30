import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createProjectRootController } from '../project-root-controller.js';

/**
 * Behavioral coverage for the shared project-root selection authority
 * (issue #1084 review follow-up): selected > persisted > fallback
 * precedence, explicit-path validation, and persistence on adoption.
 * The IPC modules only forward to this controller, so these unit tests
 * lock the state machine without needing an Electron ipcMain.
 */

interface Fixture {
  base: string;
  lastProjectPathFile: string;
  fallbackDir: string;
  persistedDir: string;
  selectedDir: string;
}

async function withFixture(fn: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'maka-project-root-controller-'));
  try {
    const fixture: Fixture = {
      base,
      lastProjectPathFile: join(base, 'last-project-path.json'),
      fallbackDir: join(base, 'fallback'),
      persistedDir: join(base, 'persisted'),
      selectedDir: join(base, 'selected'),
    };
    await mkdir(fixture.fallbackDir, { recursive: true });
    await mkdir(fixture.persistedDir, { recursive: true });
    await mkdir(fixture.selectedDir, { recursive: true });
    await fn(fixture);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function waitForPersistedPath(file: string, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { projectPath?: string };
      if (parsed.projectPath === expected) return;
    } catch {
      // Not written yet (setSelection persists fire-and-forget).
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`setSelection must persist ${expected} to ${file}`);
}

async function waitForPersistedSelection(
  file: string,
  expected: { projectId: string | null; projectPath: string },
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as {
        projectId?: string | null;
        projectPath?: string;
      };
      if (
        parsed.projectId === expected.projectId &&
        parsed.projectPath === expected.projectPath
      ) {
        return;
      }
    } catch {
      // Not written yet (setSelection persists fire-and-forget).
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`setSelection must persist ${JSON.stringify(expected)} to ${file}`);
}

describe('project-root controller', () => {
  it('falls back to the first resolvable fallback root when nothing is selected or persisted', async () => {
    await withFixture(async (fixture) => {
      const controller = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      assert.equal(await controller.current(), fixture.fallbackDir);
    });
  });

  it('prefers a validated persisted project over the fallback roots', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        fixture.lastProjectPathFile,
        JSON.stringify({ projectPath: fixture.persistedDir }),
        'utf8',
      );
      const controller = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      assert.equal(await controller.current(), fixture.persistedDir);
    });
  });

  it('ignores a persisted project that no longer exists and falls back', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        fixture.lastProjectPathFile,
        JSON.stringify({ projectPath: join(fixture.base, 'deleted') }),
        'utf8',
      );
      const controller = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      assert.equal(await controller.current(), fixture.fallbackDir);
    });
  });

  it('prefers the in-session selection over both persisted and fallback roots', async () => {
    await withFixture(async (fixture) => {
      await writeFile(
        fixture.lastProjectPathFile,
        JSON.stringify({ projectPath: fixture.persistedDir }),
        'utf8',
      );
      const controller = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      controller.setSelection('project-selected', fixture.selectedDir);
      assert.equal(await controller.current(), fixture.selectedDir);
    });
  });

  it('persists an adopted selection so a fresh controller restores it', async () => {
    await withFixture(async (fixture) => {
      const controller = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      controller.setSelection('project-selected', fixture.selectedDir);
      await waitForPersistedPath(fixture.lastProjectPathFile, fixture.selectedDir);

      const restored = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      assert.equal(await restored.current(), fixture.selectedDir);
    });
  });

  it('persists the project id and path as one selection snapshot', async () => {
    await withFixture(async (fixture) => {
      const controller = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      controller.setSelection('project-1', fixture.selectedDir);
      await waitForPersistedSelection(fixture.lastProjectPathFile, {
        projectId: 'project-1',
        projectPath: fixture.selectedDir,
      });

      const restored = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });
      assert.deepEqual(await restored.currentSelection(), {
        projectId: 'project-1',
        path: fixture.selectedDir,
      });
    });
  });

  it('validates explicit paths: rejects non-strings and missing directories, resolves real ones', async () => {
    await withFixture(async (fixture) => {
      const controller = createProjectRootController({
        lastProjectPathFile: fixture.lastProjectPathFile,
        fallbackRoots: () => [fixture.fallbackDir],
      });

      assert.deepEqual(await controller.resolveExplicit(undefined), { ok: false, reason: 'invalid-path' });
      assert.deepEqual(await controller.resolveExplicit(''), { ok: false, reason: 'invalid-path' });
      assert.deepEqual(await controller.resolveExplicit(42), { ok: false, reason: 'invalid-path' });
      assert.deepEqual(
        await controller.resolveExplicit(join(fixture.base, 'missing')),
        { ok: false, reason: 'not-found' },
      );
      assert.deepEqual(
        await controller.resolveExplicit(fixture.selectedDir),
        { ok: true, projectPath: fixture.selectedDir },
      );

      // A nested path inside a git repo resolves to the repo root, matching
      // the project-root walk the picker handlers rely on.
      const repoRoot = join(fixture.base, 'repo');
      const nested = join(repoRoot, 'apps', 'desktop');
      await mkdir(join(repoRoot, '.git'), { recursive: true });
      await writeFile(join(repoRoot, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
      await mkdir(nested, { recursive: true });
      assert.deepEqual(
        await controller.resolveExplicit(nested),
        { ok: true, projectPath: repoRoot },
      );

      // Validation must not adopt: the current root is untouched.
      assert.equal(await controller.current(), fixture.fallbackDir);
    });
  });
});
