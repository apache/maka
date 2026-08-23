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

import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';

export function makaEvalRuntimePolicyDocument(proxyUrl?: string) {
  const policy = createDefaultRuntimePolicy();
  const proxy = proxyUrl ? new URL(proxyUrl) : undefined;
  return {
    schemaVersion: 2 as const,
    revision: 0,
    policy: {
      ...policy,
      ...(proxy
        ? {
            networkProxy: {
              ...policy.networkProxy,
              enabled: true,
              protocol: 'http' as const,
              host: proxy.hostname,
              port: Number(proxy.port || 80),
            },
          }
        : {}),
      privacy: { incognitoActive: true },
    },
  };
}
