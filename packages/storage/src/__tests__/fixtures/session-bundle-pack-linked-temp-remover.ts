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
import { syncBuiltinESMExports } from 'node:module';

const [stateRoot, workspaceRoot, destination, resultPath, limitsJson, identityHex] =
  process.argv.slice(2);
if (
  stateRoot === undefined ||
  workspaceRoot === undefined ||
  destination === undefined ||
  resultPath === undefined ||
  limitsJson === undefined ||
  identityHex === undefined
) {
  process.exit(2);
}

const originalLink = fs.promises.link.bind(fs.promises);
let capturedPath: string | undefined;
fs.promises.link = async (existingPath, newPath) => {
  await originalLink(existingPath, newPath);
  const temporaryPath = existingPath.toString();
  capturedPath = `${temporaryPath}.captured`;
  await fs.promises.rename(temporaryPath, capturedPath);
};
syncBuiltinESMExports();

const { createSessionBundleFileService, SessionBundleFileError } = await import('../../index.js');
try {
  await createSessionBundleFileService().pack({
    snapshot: {
      stateRoot,
      workspaceRoot,
      stateIdentity: {
        mediaType: 'application/vnd.maka.session-state-identity+json;version=1',
        bytes: Buffer.from(identityHex, 'hex'),
      },
    },
    envelope: {
      sessionId: 'cloud-session-1',
      lastCommittedActivationId: 'activation-9',
    },
    destination,
    limits: JSON.parse(limitsJson),
  });
  process.exit(3);
} catch (error) {
  await fs.promises.writeFile(
    resultPath,
    JSON.stringify({
      code: error instanceof SessionBundleFileError ? error.code : 'unexpected',
      capturedPath,
    }),
  );
  process.exit(error instanceof SessionBundleFileError && error.code === 'io_failure' ? 0 : 4);
}
