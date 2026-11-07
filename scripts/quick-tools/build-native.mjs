// Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'target/quick-tools');
mkdirSync(out, { recursive: true });
if (process.platform === 'darwin') {
  execFileSync(
    'swiftc',
    [
      '-O',
      resolve(root, 'plugins/application/quick-tools/native/macos.swift'),
      '-o',
      resolve(out, 'maka-quick-native'),
    ],
    { stdio: 'inherit' },
  );
  execFileSync('codesign', ['--force', '--sign', '-', resolve(out, 'maka-quick-native')], {
    stdio: 'inherit',
  });
}
