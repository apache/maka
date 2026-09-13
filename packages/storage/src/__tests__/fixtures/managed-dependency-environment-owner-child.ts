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

import {
  createManagedDependencyEnvironmentAuthority,
  createManagedDependencyEnvironmentProducerCapability,
} from '../../managed-dependency-environment.js';

const storageRoot = process.env.MAKA_DEPENDENCY_OWNER_ROOT;
if (!storageRoot) throw new Error('Missing dependency owner fixture root');

const producerCapability = createManagedDependencyEnvironmentProducerCapability(
  `sha256:${'a'.repeat(64)}`,
);
await createManagedDependencyEnvironmentAuthority({
  storageRoot,
  producer: {
    capability: producerCapability,
    packageManagerName: 'npm',
    packageManagerVersion: '11.12.1',
    nodeRuntime: {
      version: '24.7.0',
      abi: '137',
      platform: process.platform,
      arch: process.arch,
    },
    async provision() {},
  },
});
process.stdout.write('READY\n');
setInterval(() => undefined, 1_000);
