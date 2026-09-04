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

import type { RuntimeHostDesktopManager } from './runtime-host-desktop-manager.js';

type RetirementOwner = Pick<RuntimeHostDesktopManager, 'retireOwnedLocalHost'>;

export async function prepareRuntimeHostQuit(
  owner: RetirementOwner | undefined,
  confirmInterrupt: () => Promise<boolean>,
): Promise<'ready' | 'cancelled'> {
  if (!owner) return 'ready';
  const guarded = await owner.retireOwnedLocalHost('refuse_active_work');
  if (guarded.kind !== 'active_tasks') return 'ready';
  if (!(await confirmInterrupt())) return 'cancelled';
  const authorized = await owner.retireOwnedLocalHost('interrupt_active_work');
  if (authorized.kind === 'active_tasks') {
    throw new Error('Runtime Host refused authorized quit retirement');
  }
  return 'ready';
}
