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

// Framework-free primitives behind useOAuthLoginFlow's async safety. Kept in a
// React-free module so their behavior is unit-testable without a DOM (see
// oauth-login-flow-guard.test.ts) and so the desktop test runner can import
// them without pulling React into its program.

// Synchronous one-shot action guard: rejects a second concurrent action before
// React can re-render the disabled button. A plain closure (held in a ref by
// the hook) so the check is synchronous, not subject to render batching.
export interface OneShotActionGuard<Action> {
  begin(action: Action): boolean;
  finish(): void;
  readonly current: Action | null;
}

export function createOneShotActionGuard<Action>(): OneShotActionGuard<Action> {
  let current: Action | null = null;
  return {
    begin(action: Action): boolean {
      if (current !== null) return false;
      current = action;
      return true;
    },
    finish(): void {
      current = null;
    },
    get current(): Action | null {
      return current;
    },
  };
}

// Cancel-on-unmount primitive: cancels a still-pending authorization request
// and clears the holder so a late resolution cannot re-cancel it. No-ops when
// nothing is pending.
export function teardownPendingAuthorization(
  holder: { current: string | null },
  cancelAuthorization: (authRequestId: string) => void,
): void {
  const pendingAuthRequestId = holder.current;
  holder.current = null;
  if (pendingAuthRequestId) cancelAuthorization(pendingAuthRequestId);
}
