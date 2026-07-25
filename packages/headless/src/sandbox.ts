import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { ArtifactFreezeResult, SubmittedSnapshot } from './contracts.js';

/**
 * A throwaway copy of a task fixture. The copy keeps a run from mutating
 * the source fixture and from bleeding into other runs — it is NOT a
 * security sandbox (a tool can still reach outside it via absolute paths
 * or the network; see runner.ts for the permission policy).
 */
export interface PreparedWorkspace {
  /** Absolute path to the throwaway copy — the agent's cwd. */
  dir: string;
  /** Remove the copy. Always call (the runner does so in a finally). */
  cleanup: () => Promise<void>;
}

export async function prepareWorkspace(fixtureDir: string): Promise<PreparedWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-headless-ws-'));
  try {
    const source = await realpath(fixtureDir);
    // Copy the fixture into the throwaway dir, rejecting symlinks: a
    // fixture symlink could point outside its root, and fs.cp preserves
    // symlinks verbatim — the agent could then write through it to the
    // source or host. Coding-task fixtures don't need symlinks.
    await cp(source, dir, {
      recursive: true,
      filter: async (src) => {
        if ((await lstat(src)).isSymbolicLink()) {
          throw new Error(`fixture contains a symlink (${src}); not supported for safety`);
        }
        return true;
      },
    });
  } catch (error) {
    // mkdtemp already created the dir, but the runner only registers its
    // cleanup after we return — so clean up here if the copy fails.
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

export async function freezeSubmittedWorkspace(input: {
  workspaceDir: string;
  snapshotRoot?: string;
  artifactRefs?: Array<Record<string, unknown>>;
  now?: () => number;
  newId?: () => string;
}): Promise<ArtifactFreezeResult> {
  const id = input.newId?.() ?? randomUUID();
  const snapshotRoot = input.snapshotRoot ?? tmpdir();
  await mkdir(snapshotRoot, { recursive: true });
  const snapshotPath = await mkdtemp(join(snapshotRoot, 'maka-headless-submitted-'));
  try {
    await cp(await realpath(input.workspaceDir), snapshotPath, {
      recursive: true,
      verbatimSymlinks: true,
      filter: async (source) => {
        const entry = await lstat(source);
        return entry.isFile() || entry.isDirectory() || entry.isSymbolicLink();
      },
    });
  } catch (error) {
    await rm(snapshotPath, { recursive: true, force: true });
    throw error;
  }
  return {
    submittedSnapshot: {
      id,
      workspaceRoot: input.workspaceDir,
      snapshotPath,
      artifactRefs: input.artifactRefs ? [...input.artifactRefs] : [],
      createdAt: input.now?.() ?? Date.now(),
    },
  };
}

export async function prepareScoringWorkspace(
  snapshot: SubmittedSnapshot,
): Promise<PreparedWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'maka-headless-score-'));
  try {
    await cp(await realpath(snapshot.snapshotPath), dir, {
      recursive: true,
      verbatimSymlinks: true,
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * Clean-room grading: restore the listed paths in the workspace from the
 * pristine fixture, overwriting whatever the agent left there. Run between
 * the agent turn and the verification command so a config can't rewrite
 * its own test to pass. Each path is removed first (drops any agent-planted
 * symlink) then re-copied from the source.
 */
export async function restoreProtectedPaths(
  sourceDir: string,
  workspaceDir: string,
  paths: string[],
): Promise<void> {
  const source = await realpath(sourceDir);
  for (const rel of paths) {
    if (isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
      throw new Error(`protectedPaths must be relative and stay inside the workspace: ${rel}`);
    }
    const to = join(workspaceDir, rel);
    await rm(to, { recursive: true, force: true });
    await mkdir(dirname(to), { recursive: true });
    await cp(join(source, rel), to, { recursive: true });
  }
}
