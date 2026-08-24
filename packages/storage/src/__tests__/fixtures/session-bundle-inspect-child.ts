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

import { createSessionBundleFileService, type SessionBundleLimits } from '../../index.js';

const [archivePath, archiveDigest, limitsJson, destinationRoot] = process.argv.slice(2);
if (!archivePath || !archiveDigest || !limitsJson) process.exit(2);

const limits = JSON.parse(limitsJson) as SessionBundleLimits;
const service = createSessionBundleFileService();
const source = {
  path: archivePath,
  expectedArchiveDigest: archiveDigest as `sha256:${string}`,
};
const result = destinationRoot
  ? await service.hydrate({
      source,
      limits,
      expectedSessionId: 'cloud-session-1',
      destinationRoot,
    })
  : await service.inspect({ source, limits });
process.stdout.write(
  JSON.stringify({
    sessionId: result.manifest.envelope.sessionId,
    archiveDigest: result.archiveDigest,
    identityHex: Buffer.from(result.stateIdentity.bytes).toString('hex'),
    verified: result.verified,
    ...(destinationRoot ? { destinationRoot } : {}),
  }),
);
