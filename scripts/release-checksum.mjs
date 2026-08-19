import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

export async function writeSha256Sidecar(artifactPath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
  const checksumPath = `${artifactPath}.sha256`;
  await writeFile(checksumPath, `${hash.digest('hex')}  ${basename(artifactPath)}\n`, 'utf8');
  return checksumPath;
}
