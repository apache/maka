import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { FileAttemptStore } from './attempt-store.js';
import type { ExperimentSpec, JsonValue } from './experiment.js';
import { parseExperimentSpec } from './spec.js';

export async function openExperimentDirectory(root: string, spec: ExperimentSpec) {
  await mkdir(root, { recursive: true });
  const specPath = join(root, 'experiment.json');
  const temporaryPath = join(root, `.experiment-${randomUUID()}.tmp`);
  const canonical = `${canonicalJson(spec)}\n`;
  const temporary = await open(temporaryPath, 'wx', 0o600);
  try {
    await temporary.writeFile(canonical);
    await temporary.sync();
    await temporary.close();
    await link(temporaryPath, specPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = parseExperimentSpec(JSON.parse(await readFile(specPath, 'utf8')));
    if (canonicalJson(existing) !== canonicalJson(spec)) throw new Error('experiment spec differs');
  } finally {
    await temporary.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
  return { root, specPath, attempts: new FileAttemptStore(join(root, 'attempts')) };
}

function canonicalJson(value: JsonValue | ExperimentSpec): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child as JsonValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
