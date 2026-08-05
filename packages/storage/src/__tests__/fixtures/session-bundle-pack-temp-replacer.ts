import { readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [root, resultPath] = process.argv.slice(2);
if (root === undefined || resultPath === undefined) process.exit(2);

process.stdout.write('ready\n');
const deadline = Date.now() + 10_000;
while (Date.now() < deadline) {
  const name = readdirSync(root).find((candidate) =>
    candidate.includes('.maka-session-bundle-pack-'),
  );
  if (name === undefined) continue;
  const temporaryPath = join(root, name);
  const capturedPath = `${temporaryPath}.captured`;
  try {
    renameSync(temporaryPath, capturedPath);
    writeFileSync(temporaryPath, 'EVIL');
    writeFileSync(resultPath, JSON.stringify({ capturedPath, temporaryPath }));
    process.exit(0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
process.exit(3);
