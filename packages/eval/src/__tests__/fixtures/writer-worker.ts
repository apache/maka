import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileAttemptStore } from '../../attempt-store.js';

const root = process.argv[2]!;
await writeFile(join(root, `ready-${process.pid}`), '');
while (!(await exists(join(root, 'go')))) await new Promise((resolve) => setTimeout(resolve, 5));
try {
  await new FileAttemptStore(join(root, 'attempts')).runExclusive(async () => {
    process.stdout.write('ENTER\n');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  });
} catch {
  process.exitCode = 2;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
