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

import { createHash } from 'node:crypto';
import type { ClientCapabilityConnectionIdentity } from './client-capability-service.js';

const PROVIDER_ID_DOMAIN = 'maka.client-capability-provider.v1';

export function clientCapabilityProviderId(
  identity: Pick<
    ClientCapabilityConnectionIdentity,
    'principalKind' | 'principalId' | 'clientInstanceId'
  >,
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        PROVIDER_ID_DOMAIN,
        identity.principalKind,
        identity.principalId,
        identity.clientInstanceId,
      ]),
    )
    .digest('base64url');
  return `cc_${digest}`;
}
