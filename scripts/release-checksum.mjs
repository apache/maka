import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeSha256Sidecar(artifactPath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
  const checksumPath = `${artifactPath}.sha256`;
  await writeFile(checksumPath, `${hash.digest('hex')}  ${basename(artifactPath)}\n`, 'utf8');
  return checksumPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [artifactPath, ...unsupported] = process.argv.slice(2);
  if (!artifactPath || unsupported.length > 0) {
    throw new Error('Usage: node scripts/release-checksum.mjs <artifact>');
  }
  console.log(await writeSha256Sidecar(artifactPath));
}
