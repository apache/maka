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
  let wroteOneByte = false;
  handle.write = (async (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ) => {
    if (wroteOneByte) {
      throw Object.assign(new Error('injected ownership write failure'), {
        code: 'EIO',
      });
    }
    wroteOneByte = true;
    return originalWrite(buffer, offset, Math.min(length, 1), position);
  }) as typeof handle.write;
  return handle;
};
syncBuiltinESMExports();

const { createSessionBundleFileService, SessionBundleFileError } = await import('../../index.js');
try {
  await createSessionBundleFileService().hydrate({
    source: {
      path: archivePath,
      expectedArchiveDigest: archiveDigest as `sha256:${string}`,
    },
    limits: JSON.parse(limitsJson),
    expectedSessionId: 'cloud-session-1',
    destinationRoot,
  });
  process.exit(3);
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      code: error instanceof SessionBundleFileError ? error.code : 'unexpected',
    }),
  );
  process.exit(error instanceof SessionBundleFileError && error.code === 'io_failure' ? 0 : 4);
}
