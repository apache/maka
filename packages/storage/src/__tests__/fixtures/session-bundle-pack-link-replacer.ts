import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

const [stateRoot, workspaceRoot, destination, resultPath, limitsJson, identityHex] =
  process.argv.slice(2);
if (
  stateRoot === undefined ||
  workspaceRoot === undefined ||
  destination === undefined ||
  resultPath === undefined ||
  limitsJson === undefined ||
  identityHex === undefined
) {
  process.exit(2);
}

const originalLink = fs.promises.link.bind(fs.promises);
let capturedPath: string | undefined;
let temporaryPath: string | undefined;
fs.promises.link = async (existingPath, newPath) => {
  temporaryPath = existingPath.toString();
  capturedPath = `${temporaryPath}.captured`;
  await fs.promises.rename(temporaryPath, capturedPath);
  await fs.promises.writeFile(temporaryPath, 'EVIL');
  await originalLink(existingPath, newPath);
};
syncBuiltinESMExports();

const { createSessionBundleFileService, SessionBundleFileError } = await import('../../index.js');
try {
  await createSessionBundleFileService().pack({
    snapshot: {
      stateRoot,
      workspaceRoot,
      stateIdentity: {
        mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
        bytes: Buffer.from(identityHex, 'hex'),
      },
    },
    envelope: {
      sessionId: 'cloud-session-1',
      lastCommittedActivationId: 'activation-9',
    },
    destination,
    limits: JSON.parse(limitsJson),
  });
  process.exit(3);
} catch (error) {
  await fs.promises.writeFile(
    resultPath,
    JSON.stringify({
      code: error instanceof SessionBundleFileError ? error.code : 'unexpected',
      capturedPath,
      temporaryPath,
    }),
  );
  process.exit(error instanceof SessionBundleFileError && error.code === 'source_changed' ? 0 : 4);
}
