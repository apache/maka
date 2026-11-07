// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
import { readFile, mkdir, writeFile, rename, readdir, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
async function read(path, fallback) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 42 * 1024 * 1024)
      throw Error('Invalid or oversized legacy file');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}
const key = (id) => {
  const slash = id.indexOf('/');
  return slash < 0 ? id : id.slice(0, slash) + ':' + id.slice(slash + 1);
};
const merge = (old, current) => {
  if (current === undefined) return old;
  if (Array.isArray(old) && Array.isArray(current)) {
    const seen = new Set(current.map((item) => item?.id ?? JSON.stringify(item)));
    return [...old.filter((item) => !seen.has(item?.id ?? JSON.stringify(item))), ...current];
  }
  if (old && current && typeof old === 'object' && typeof current === 'object')
    return { ...old, ...current };
  return current;
};
/** Dry run by default. Original files and all existing native values are retained. */
export async function importLegacy(source, destination, { apply = false } = {}) {
  source = resolve(source);
  destination = resolve(destination);
  if (source === destination) throw Error('Source and destination must differ');
  const host = await read(join(source, 'plugins/host.json'), null);
  if (
    !host ||
    host.version !== 2 ||
    typeof host.enabled !== 'boolean' ||
    typeof host.shortcut !== 'string' ||
    !Array.isArray(host.disabled) ||
    !host.preferences
  )
    throw Error('Invalid legacy Quick Tools host settings');
  const values = new Map();
  const preferences = {};
  const shortcuts = {};
  if (host.enabled) shortcuts.toggle = host.shortcut;
  for (const [id, preference] of Object.entries(host.preferences)) {
    if (!preference || typeof preference !== 'object') throw Error('Invalid legacy preference');
    const { hotkey, ...rest } = preference;
    preferences[key(id)] = rest;
    if (typeof hotkey === 'string' && hotkey) shortcuts[key(id)] = hotkey;
  }
  for (const id of host.disabled) preferences[id] = { ...preferences[id], enabled: false };
  values.set('preferences', preferences);
  values.set('shortcuts', shortcuts);
  const legacyPackages = await read(join(source, 'extensions/registry.json'), {
    version: 1,
    records: [],
  });
  if (
    legacyPackages.version !== 1 ||
    !Array.isArray(legacyPackages.records) ||
    legacyPackages.records.length > 64
  )
    throw Error('Invalid legacy package registry');
  const builtins = new Set();
  const tools = new URL('../../plugins/application/quick-tools/tools/', import.meta.url);
  for (const entry of await readdir(tools, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = await read(new URL(entry.name + '/manifest.json', tools), null);
    if (manifest) builtins.add(manifest.id);
  }
  const artifact = async (record) => {
    const id = record.manifest?.id,
      hash = record.digest;
    if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(id ?? '') || !/^[a-f0-9]{64}$/.test(hash ?? ''))
      throw Error('Invalid legacy package location');
    const directory = join(source, 'extensions/packages', id, hash);
    for (const path of [
      join(source, 'extensions'),
      join(source, 'extensions/packages'),
      join(source, 'extensions/packages', id),
      directory,
    ]) {
      if (!(await lstat(path)).isDirectory()) throw Error('Invalid legacy package directory');
    }
    const codePath = join(directory, 'index.cjs'),
      info = await lstat(codePath);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw Error('Invalid legacy package code');
    const manifest = await read(join(directory, 'manifest.json'), null);
    const bundle = { format: 1, manifest, code: await readFile(codePath, 'utf8') };
    const digest = createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
    if (digest !== hash || JSON.stringify(manifest) !== JSON.stringify(record.manifest))
      throw Error('Legacy package integrity check failed');
    return { bundle, digest };
  };
  const records = [];
  for (const record of legacyPackages.records) {
    const id = record.manifest?.id;
    if (typeof id !== 'string') throw Error('Missing legacy package ID');
    if (record.enabled === false) preferences[id] = { ...preferences[id], enabled: false };
    if (builtins.has(id)) continue;
    if (record.previous && record.previous.manifest?.id !== id)
      throw Error('Legacy rollback identity mismatch');
    const current = await artifact(record);
    records.push({
      ...current,
      ...(record.previous ? { previous: await artifact(record.previous) } : {}),
    });
  }
  if (records.length) values.set('extensions', { version: 1, records });
  const history = await read(join(source, 'input-history.json'), undefined);
  if (history !== undefined) values.set('input-history', history);
  for (const file of await readdir(join(source, 'plugins'))) {
    if (!/^[a-z0-9][a-z0-9.-]{0,99}\.json$/.test(file) || file === 'host.json') continue;
    const id = file.slice(0, -5);
    if (['preferences', 'shortcuts', 'extensions', 'input-history', 'trace'].includes(id))
      throw Error('Legacy plugin uses a reserved native identifier');
    values.set(id, await read(join(source, 'plugins', file), undefined));
  }
  const prepared = [];
  for (const [id, value] of values) {
    const file = join(destination, id + '.json');
    const current = await read(file, undefined);
    let next = merge(value, current);
    if (id === 'extensions' && current) {
      const ids = new Set(current.records.map((record) => record.bundle.manifest.id));
      next = {
        version: 1,
        records: [
          ...value.records.filter((record) => !ids.has(record.bundle.manifest.id)),
          ...current.records,
        ],
      };
    }
    if (id === 'input-history' && current) {
      next = {};
      for (const mode of ['search', 'assistant'])
        next[mode] = [...new Set([...(value[mode] ?? []), ...(current[mode] ?? [])])].slice(-50);
    }
    if (id === 'maka.clipboard' && current)
      next = { ...next, clips: merge(value.clips ?? [], current.clips ?? []).slice(-300) };
    const body = JSON.stringify(next);
    if (Buffer.byteLength(body) > 42 * 1024 * 1024)
      throw Error('Merged storage exceeds native capacity');
    if (JSON.stringify(current) !== body) prepared.push({ id, file, body, current });
  }
  if (apply && prepared.length) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const backup = join(destination, 'import-backup-' + randomUUID());
    await mkdir(backup, { mode: 0o700 });
    for (const item of prepared) {
      if (item.current !== undefined)
        await writeFile(join(backup, item.id + '.json'), JSON.stringify(item.current), {
          mode: 0o600,
        });
      const temporary = item.file + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, item.body, { mode: 0o600 });
      await rename(temporary, item.file);
    }
  }
  return { files: prepared.length, applied: apply, sourceRetained: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      destination: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  if (!values.source || !values.destination)
    throw Error(
      'Use --source OLD_QUICK_TOOLS --destination NATIVE_QUICK_TOOLS [--apply]. Close the native app before applying.',
    );
  console.log(
    JSON.stringify(await importLegacy(values.source, values.destination, { apply: values.apply })),
  );
}
