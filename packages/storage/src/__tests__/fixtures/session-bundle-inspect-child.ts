import { createSessionBundleFileService, type SessionBundleLimits } from '../../index.js';

const [archivePath, archiveDigest, limitsJson, destinationRoot] = process.argv.slice(2);
if (!archivePath || !archiveDigest || !limitsJson) process.exit(2);

const limits = JSON.parse(limitsJson) as SessionBundleLimits;
const service = createSessionBundleFileService();
const source = {
  path: archivePath,
  expectedArchiveDigest: archiveDigest as `sha256:${string}`,
};
const result = destinationRoot
  ? await service.hydrate({
      source,
      limits,
      expectedSessionId: 'cloud-session-1',
      destinationRoot,
    })
  : await service.inspect({ source, limits });
process.stdout.write(
  JSON.stringify({
    sessionId: result.manifest.envelope.sessionId,
    archiveDigest: result.archiveDigest,
    identityHex: Buffer.from(result.stateIdentity.bytes).toString('hex'),
    verified: result.verified,
    ...(destinationRoot ? { destinationRoot } : {}),
  }),
);
