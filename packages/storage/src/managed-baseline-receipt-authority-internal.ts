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

import type {
  CreateManagedWorkspaceFromSourceInput,
  GitWorkspaceService,
  ManagedWorkspaceBaselineReceiptV1,
  ManagedWorkspaceBinding,
} from './git-workspace-service.js';

export interface ManagedBaselineReceiptAuthorityInternal {
  issue(binding: ManagedWorkspaceBinding): Promise<ManagedWorkspaceBaselineReceiptV1>;
  require(input: CreateManagedWorkspaceFromSourceInput): Promise<ManagedWorkspaceBaselineReceiptV1>;
  verify(receipt: ManagedWorkspaceBaselineReceiptV1): Promise<void>;
}

const receiptAuthorities = new WeakMap<
  GitWorkspaceService,
  ManagedBaselineReceiptAuthorityInternal
>();

export function registerManagedBaselineReceiptAuthorityInternal(
  service: GitWorkspaceService,
  authority: ManagedBaselineReceiptAuthorityInternal,
): void {
  if (receiptAuthorities.has(service)) {
    throw new Error('Managed baseline receipt authority is already registered');
  }
  receiptAuthorities.set(service, authority);
}

export function requireManagedBaselineReceiptAuthorityInternal(
  service: GitWorkspaceService,
): ManagedBaselineReceiptAuthorityInternal {
  const authority = receiptAuthorities.get(service);
  if (!authority) {
    throw new Error('Managed baseline receipt authority is unavailable');
  }
  return authority;
}
