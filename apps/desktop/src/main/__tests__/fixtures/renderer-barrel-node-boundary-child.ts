// Child process for renderer-core-barrel-node-boundary.test.ts. Registers the
// throwing loader hook, then imports the built @maka/core barrel. Prints
// `barrel-ok` and exits 0 only if the barrel evaluates without touching any
// `node:*` module.
import { register } from 'node:module';

register(new URL('./throw-on-node-import-hook.js', import.meta.url));

import('@maka/core')
  .then(() => {
    console.log('barrel-ok');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
