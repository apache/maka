/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const [archivePath, limitsJson] = process.argv.slice(2);
if (archivePath === undefined || limitsJson === undefined) process.exit(2);

const target = resolve(archivePath);
const originalOpen = fs.promises.open.bind(fs.promises);
let mutated = false;
fs.promises.open = async (...args) => {
  const handle = await originalOpen(...args);
  if (resolve(args[0].toString()) !== target) return handle;
  const originalCreateReadStream = handle.createReadStream.bind(handle);
  handle.createReadStream = (options) => {
    if (!mutated) {
      mutated = true;
      const changed = new Date(Date.now() + 60_000);
      fs.utimesSync(target, changed, changed);
    }
    return originalCreateReadStream(options);
  };
  return handle;
};
syncBuiltinESMExports();

const { createSessionBundleFileService, SessionBundleFileError } = await import('../../index.js');
try {
  await createSessionBundleFileService().inspect({
    source: { path: target },
    limits: JSON.parse(limitsJson),
  });
  process.exit(3);
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      code: error instanceof SessionBundleFileError ? error.code : 'unexpected',
      operation: error instanceof SessionBundleFileError ? error.details?.operation : undefined,
    }),
  );
  process.exit(error instanceof SessionBundleFileError && error.code === 'source_changed' ? 0 : 4);
}
