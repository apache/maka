import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { FixedPromptTask } from './fixed-prompt-controller.js';

export function resolveFixedPromptRunRoot(
  outDir: string,
  runId: string,
  envName = 'MAKA_PROMPT_RUN_ID',
): string {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`${envName} must contain only letters, numbers, dot, underscore, or hyphen`);
  }
  return join(outDir, runId);
}

/** Scan a Harbor task cache (`<root>/<hash>/<task-name>/task.toml`) or exported
 * dataset (`<root>/<task-name>/task.toml`) into a deterministic task list. */
export async function discoverCachedHarborTasks(
  tasksRoot: string,
  taskIds?: ReadonlySet<string>,
  options: { duplicatePolicy?: 'error' | 'newest' } = {},
): Promise<FixedPromptTask[]> {
  const byId = new Map<string, { task: FixedPromptTask; modifiedAtMs: number }>();
  let hashDirs;
  try {
    hashDirs = await readdir(tasksRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const hashDir of hashDirs) {
    if (!hashDir.isDirectory()) continue;
    const hashPath = join(tasksRoot, hashDir.name);
    const exportedTaskToml = await readTaskToml(hashPath);
    if (exportedTaskToml !== undefined) {
      if (taskIds && !taskIds.has(hashDir.name)) continue;
      addDiscoveredTask(byId, hashDir.name, hashPath, exportedTaskToml, options);
      continue;
    }
    let inner;
    try {
      inner = await readdir(hashPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const taskDir of inner) {
      if (!taskDir.isDirectory()) continue;
      if (taskIds && !taskIds.has(taskDir.name)) continue;
      const taskPath = join(hashPath, taskDir.name);
      const taskToml = await readTaskToml(taskPath);
      if (taskToml === undefined) continue;
      addDiscoveredTask(byId, taskDir.name, taskPath, taskToml, options);
    }
  }
  return [...byId.values()].map((entry) => entry.task).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Pick tasks by explicit id, preserving the requested order. Throws on an
 * unknown id (and, unless `rejectDuplicates` is false, on a duplicate id that
 * would double-weight a task). `label` scopes the unknown-id error message for
 * callers that select from more than one named id list.
 */
export function selectTasksByIds<T extends { id: string }>(
  allTasks: readonly T[],
  ids: readonly string[],
  options: { label?: string; rejectDuplicates?: boolean } = {},
): T[] {
  const { label, rejectDuplicates = true } = options;
  if (rejectDuplicates) {
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (duplicates.length > 0) throw new Error(`duplicate task id(s): ${duplicates.join(', ')}`);
  }
  const byId = new Map(allTasks.map((task) => [task.id, task]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `${label ? `${label} contains ` : ''}unknown task id(s): ${missing.join(', ')}`,
    );
  }
  return ids.map((id) => byId.get(id)!);
}

export async function fingerprintFixedPromptTaskTree(
  tasks: readonly FixedPromptTask[],
): Promise<string> {
  const taskEntries = [];
  for (const task of [...tasks].sort((left, right) => left.id.localeCompare(right.id))) {
    taskEntries.push({ id: task.id, entries: await taskDirectoryEntries(task.path) });
  }
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ schemaVersion: 1, tasks: taskEntries }))
    .digest('hex')}`;
}

export async function fingerprintFixedPromptTask(task: FixedPromptTask): Promise<string> {
  return `sha256:${createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        task: { id: task.id, entries: await taskDirectoryEntries(task.path) },
      }),
    )
    .digest('hex')}`;
}

async function taskDirectoryEntries(
  taskPath: string,
): Promise<Array<Record<string, string | boolean>>> {
  const root = resolve(taskPath);
  const entries: Array<Record<string, string | boolean>> = [];
  await walkTaskDirectory(root, root, entries);
  return entries;
}

async function walkTaskDirectory(
  root: string,
  dir: string,
  entries: Array<Record<string, string | boolean>>,
): Promise<void> {
  const children = await readdir(dir, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const path = join(dir, child.name);
    const entryPath = relative(root, path).split('\\').join('/');
    const stats = await lstat(path);
    if (child.isDirectory()) {
      entries.push({ path: entryPath, type: 'directory' });
      await walkTaskDirectory(root, path, entries);
    } else if (child.isSymbolicLink()) {
      throw new Error(
        `task source symlink is not supported: ${entryPath} -> ${await readlink(path)}`,
      );
    } else if (child.isFile()) {
      entries.push({
        path: entryPath,
        type: 'file',
        executable: (stats.mode & 0o111) !== 0,
        hash: createHash('sha256')
          .update(await readFile(path))
          .digest('hex'),
      });
    } else {
      entries.push({ path: entryPath, type: 'other' });
    }
  }
}

interface CachedTaskToml {
  text: string;
  modifiedAtMs: number;
}

async function readTaskToml(taskPath: string): Promise<CachedTaskToml | undefined> {
  try {
    const path = join(taskPath, 'task.toml');
    const [text, stats] = await Promise.all([readFile(path, 'utf8'), lstat(path)]);
    return { text, modifiedAtMs: stats.mtimeMs };
  } catch {
    return undefined;
  }
}

function addDiscoveredTask(
  byId: Map<string, { task: FixedPromptTask; modifiedAtMs: number }>,
  taskId: string,
  taskPath: string,
  taskToml: CachedTaskToml,
  options: { duplicatePolicy?: 'error' | 'newest' },
): void {
  // The controller keys events by task id, so two cached versions of the same
  // task name would silently collide and pollute scoring. Fail loud instead.
  const existing = byId.get(taskId);
  if (existing && options.duplicatePolicy !== 'newest') {
    throw new Error(`duplicate cached task id "${taskId}": ${existing.task.path} and ${taskPath}`);
  }
  if (
    existing &&
    (existing.modifiedAtMs > taskToml.modifiedAtMs ||
      (existing.modifiedAtMs === taskToml.modifiedAtMs && existing.task.path > taskPath))
  ) {
    return;
  }
  byId.set(taskId, {
    modifiedAtMs: taskToml.modifiedAtMs,
    task: {
      id: taskId,
      path: taskPath,
      ...metadataField(parseTaskTomlMetadata(taskToml.text)),
    },
  });
}

function parseTaskTomlMetadata(text: string): FixedPromptTask['metadata'] {
  return {
    ...stringField('difficulty', sectionField(text, 'metadata', 'difficulty')),
    ...numberField(
      'estimatedDurationSec',
      sectionField(text, 'metadata', 'estimated_duration_sec'),
    ),
    ...numberField(
      'expertTimeEstimateMin',
      sectionField(text, 'metadata', 'expert_time_estimate_min'),
    ),
    ...numberField(
      'juniorTimeEstimateMin',
      sectionField(text, 'metadata', 'junior_time_estimate_min'),
    ),
    ...numberField('agentTimeoutSec', sectionField(text, 'agent', 'timeout_sec')),
    ...numberField('verifierTimeoutSec', sectionField(text, 'verifier', 'timeout_sec')),
    ...numberField('buildTimeoutSec', sectionField(text, 'environment', 'build_timeout_sec')),
  };
}

function sectionField(text: string, sectionName: string, fieldName: string): string | undefined {
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (line.length === 0) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      inSection = section[1] === sectionName;
      continue;
    }
    if (!inSection) continue;
    const field = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (field?.[1] !== fieldName) continue;
    return field[2]?.trim();
  }
  return undefined;
}

function stringField(
  key: 'difficulty',
  raw: string | undefined,
): Pick<NonNullable<FixedPromptTask['metadata']>, 'difficulty'> | {} {
  if (raw === undefined) return {};
  const value = raw.match(/^"([^"]*)"$/)?.[1] ?? raw;
  return value.length > 0 ? { [key]: value } : {};
}

function numberField<
  K extends Exclude<keyof NonNullable<FixedPromptTask['metadata']>, 'difficulty'>,
>(key: K, raw: string | undefined): Pick<NonNullable<FixedPromptTask['metadata']>, K> | {} {
  if (raw === undefined) return {};
  const value = Number(raw);
  return Number.isFinite(value)
    ? ({ [key]: value } as Pick<NonNullable<FixedPromptTask['metadata']>, K>)
    : {};
}

function metadataField(
  metadata: FixedPromptTask['metadata'],
): Pick<FixedPromptTask, 'metadata'> | {} {
  return metadata && Object.keys(metadata).length > 0 ? { metadata } : {};
}
