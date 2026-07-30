import assert from 'node:assert/strict';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  publishMarkerFile,
  type MarkerFileDependencies,
  type MarkerFileHandle,
} from '../marker-file.js';

for (const publication of ['create', 'replace'] as const) {
  for (const failurePhase of ['write', 'sync', 'close'] as const) {
    test(`${publication} removes its temporary marker after a ${failurePhase} failure`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'maka-marker-file-fault-'));
      const markerFile = '.marker.json';
      const temporaryPath = join(root, `${markerFile}.${process.pid}.fault.tmp`);
      const fault = new Error(`${failurePhase} failed`);
      try {
        await assert.rejects(
          () =>
            publishMarkerFile(
              {
                root,
                markerFile,
                contents: '{"schemaVersion":1}\n',
                maxBytes: 1_024,
                publication,
                invalidFile: () => new Error('invalid marker'),
              },
              {
                randomUUID: () => 'fault',
                open: faultingOpen(temporaryPath, failurePhase, fault),
              },
            ),
          fault,
        );
        assert.deepEqual(await readdir(root), []);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

function faultingOpen(
  temporaryPath: string,
  failurePhase: 'write' | 'sync' | 'close',
  fault: Error,
): MarkerFileDependencies['open'] {
  return async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    if (path !== temporaryPath) return handle;

    let closeFailed = false;
    const wrapped: MarkerFileHandle = {
      stat: (options) => handle.stat(options),
      readFile: (encoding) => handle.readFile(encoding),
      writeFile: async (data, encoding) => {
        if (failurePhase === 'write') {
          await handle.writeFile(data.slice(0, 1), encoding);
          throw fault;
        }
        await handle.writeFile(data, encoding);
      },
      sync: async () => {
        if (failurePhase === 'sync') throw fault;
        await handle.sync();
      },
      close: async () => {
        if (failurePhase === 'close' && !closeFailed) {
          closeFailed = true;
          await handle.close();
          throw fault;
        }
        await handle.close();
      },
    };
    return wrapped;
  };
}
