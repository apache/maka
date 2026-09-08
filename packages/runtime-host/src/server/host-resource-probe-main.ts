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

import * as systemInformation from 'systeminformation';

async function main(): Promise<void> {
  const [kind, extra] = process.argv.slice(2);
  if (extra !== undefined) throw new Error('Unexpected Runtime Host resource probe argument');
  const result =
    kind === 'graphics'
      ? await systemInformation.graphics()
      : kind === 'storage'
        ? await systemInformation.fsSize()
        : kind === 'network'
          ? await networkStats()
          : undefined;
  if (result === undefined) throw new Error('Invalid Runtime Host resource probe');
  process.stdout.write(JSON.stringify(result));
}

async function networkStats() {
  const interfaceName = await systemInformation.networkInterfaceDefault();
  return {
    interfaceName,
    stats: interfaceName ? await systemInformation.networkStats(interfaceName) : [],
  };
}

void main().catch(() => {
  process.exitCode = 1;
});
