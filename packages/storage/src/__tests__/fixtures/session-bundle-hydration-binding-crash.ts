import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [archivePath, archiveDigest, limitsJson, destinationRoot] = process.argv.slice(2);
if (
  archivePath === undefined ||
  archiveDigest === undefined ||
  limitsJson === undefined ||
  destinationRoot === undefined
) {
  process.exit(2);
}

const originalOpen = fs.promises.open.bind(fs.promises);
let targeted = false;
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (targeted || !args[0].toString().endsWith('.owner.json')) return handle;
  targeted = true;
  const originalWrite = handle.write.bind(handle);
  handle.write = (async (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    if (position === null) return originalWrite(buffer, offset, length, position);
    await originalWrite(buffer, offset, Math.min(length, 1), position);
    process.stdout.write('binding-partial\n');
    return new Promise<never>(() => {});
  }) as typeof handle.write;
  return handle;
};
syncBuiltinESMExports();

const { createSessionBundleFileService } = await import('../../index.js');
await createSessionBundleFileService().hydrate({
  source: {
    path: archivePath,
    expectedArchiveDigest: archiveDigest as `sha256:${string}`,
  },
  limits: JSON.parse(limitsJson),
  expectedSessionId: 'cloud-session-1',
  destinationRoot,
});
