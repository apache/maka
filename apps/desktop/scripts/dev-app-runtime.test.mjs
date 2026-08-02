import assert from 'node:assert/strict';
import test from 'node:test';
import { createMacosDevelopmentLaunch } from './dev-app-runtime.mjs';

test('launches the signed development bundle through LaunchServices', () => {
  assert.deepEqual(createMacosDevelopmentLaunch('/repo/Maka Dev.app', ['/repo/desktop', '--flag']), {
    command: 'open',
    args: [
      '-n',
      '-W',
      '-a',
      '/repo/Maka Dev.app',
      '--args',
      '/repo/desktop',
      '--flag',
    ],
  });
});

test('forwards the Vite URL without copying unrelated environment secrets', () => {
  const launch = createMacosDevelopmentLaunch('/repo/Maka Dev.app', ['/repo/desktop'], {
    VITE_DEV_SERVER_URL: 'http://localhost:5173',
    API_SECRET: 'do-not-forward',
  });
  assert.deepEqual(launch.args.slice(2, 4), [
    '--env',
    'VITE_DEV_SERVER_URL=http://localhost:5173',
  ]);
  assert.equal(launch.args.some((arg) => arg.includes('do-not-forward')), false);
});
