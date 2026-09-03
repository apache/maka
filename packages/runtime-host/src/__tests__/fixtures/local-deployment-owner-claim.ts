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

import { applyLocalHostDeploymentTransition } from '../../operator/local-deployment-owner.js';

const [mode, location, rootId, installationId, integrity] = process.argv.slice(2);
if (!mode || !location || !rootId || !installationId || !integrity) {
  throw new Error(
    'usage: local-deployment-owner-claim <--authority-root|--account-home> <location> <root-id> <installation-id> <integrity>',
  );
}
if (mode !== '--authority-root' && mode !== '--account-home') {
  throw new Error('invalid local deployment owner claim mode');
}

const result = await applyLocalHostDeploymentTransition(
  rootId,
  {
    kind: 'claim',
    owner: { kind: 'desktop', installationId },
    selected: { kind: 'npm_registry', version: '1.0.0', integrity },
  },
  mode === '--authority-root' ? { authorityRoot: location } : { homeDir: location },
);
process.stdout.write(JSON.stringify({ kind: result.kind }));
