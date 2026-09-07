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

export type RuntimeHostProfileKind = 'local' | 'environment' | 'remote';

export interface RuntimeHostProfileOfKind<Kind extends RuntimeHostProfileKind> {
  readonly kind: Kind;
}

const WORKSPACE_AUTHORITY_BY_PROFILE_KIND = {
  local: 'client',
  environment: 'host',
  remote: 'host',
} as const satisfies Record<RuntimeHostProfileKind, 'client' | 'host'>;

export function isRuntimeHostProfileKind(value: unknown): value is RuntimeHostProfileKind {
  return typeof value === 'string' && Object.hasOwn(WORKSPACE_AUTHORITY_BY_PROFILE_KIND, value);
}

export function runtimeHostProfileUsesHostWorkspace(
  kind: RuntimeHostProfileKind,
): kind is Exclude<RuntimeHostProfileKind, 'local'> {
  return WORKSPACE_AUTHORITY_BY_PROFILE_KIND[kind] === 'host';
}
