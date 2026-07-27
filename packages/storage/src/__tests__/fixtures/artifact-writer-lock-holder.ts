import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withArtifactWriterLock } from '../../artifact-writer-lock.js';

const [workspaceRoot, transientResidueSessionId] = process.argv.slice(2);
if (!workspaceRoot || !process.send) {
  throw new Error(
    'usage: artifact-writer-lock-holder <workspace-root> [transient-residue-session-id]',
  );
}

try {
  await withArtifactWriterLock(workspaceRoot, async () => {
    const residuePath = transientResidueSessionId
      ? await createTransientPublicationResidue(workspaceRoot, transientResidueSessionId)
      : undefined;
    try {
      await send({ type: 'locked' });
      await waitForRelease();
    } finally {
      if (residuePath) await rm(residuePath, { force: true });
    }
  });
  await send({ type: 'released' });
} catch (error) {
  await send({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  }).catch(() => {});
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}

function waitForRelease(): Promise<void> {
  return new Promise((resolve, reject) => {
    process.once('message', resolve);
    process.once('disconnect', () => reject(new Error('parent disconnected before release')));
  });
}

async function createTransientPublicationResidue(
  workspaceRoot: string,
  sessionId: string,
): Promise<string> {
  const sessionRoot = join(workspaceRoot, 'artifacts', sessionId);
  const targetHash = createHash('sha256').update('transient.txt').digest('hex');
  const residuePath = join(
    sessionRoot,
    `.artifact-publish.${targetHash}.00000000-0000-4000-8000-000000000000.tmp`,
  );
  await mkdir(sessionRoot, { recursive: true });
  await writeFile(residuePath, 'transient publication');
  return residuePath;
}

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
