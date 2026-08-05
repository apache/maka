import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [archivePath, limitsJson] = process.argv.slice(2);
if (archivePath === undefined || limitsJson === undefined) process.exit(2);

const target = resolve(archivePath);
const originalOpen = fs.promises.open.bind(fs.promises);
let mutated = false;
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (resolve(args[0].toString()) !== target) return handle;
  const originalCreateReadStream = handle.createReadStream.bind(handle);
  handle.createReadStream = (options) => {
    if (!mutated) {
      mutated = true;
      const changed = new Date(Date.now() + 60_000);
      fs.utimesSync(target, changed, changed);
    }
    return originalCreateReadStream(options);
  };
  return handle;
};
syncBuiltinESMExports();

const { createSessionBundleFileService, SessionBundleFileError } = await import('../../index.js');
try {
  await createSessionBundleFileService().inspect({
    source: { path: target },
    limits: JSON.parse(limitsJson),
  });
  process.exit(3);
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      code: error instanceof SessionBundleFileError ? error.code : 'unexpected',
      operation: error instanceof SessionBundleFileError ? error.details?.operation : undefined,
    }),
  );
  process.exit(error instanceof SessionBundleFileError && error.code === 'source_changed' ? 0 : 4);
}
