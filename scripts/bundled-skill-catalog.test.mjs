import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('the generated Runtime Skill catalog matches its reviewable sources', async () => {
  await execFileAsync(process.execPath, ['scripts/gen-bundled-skill-catalog.mjs', '--check']);
});
