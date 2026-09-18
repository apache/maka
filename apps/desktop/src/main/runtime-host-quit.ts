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

type QuitOwner = Pick<RuntimeHostDesktopManager, 'prepareOwnedLocalHostQuit'>;

export interface RuntimeHostQuitPrompts {
  confirmInterrupt(): Promise<boolean>;
}

/** Stop Host admission before Desktop cleanup can race a new background job. */
export async function prepareRuntimeHostQuit(
  owner: QuitOwner | undefined,
  prompts: RuntimeHostQuitPrompts,
): Promise<'ready' | 'cancelled'> {
  if (!owner) return 'ready';
  const result = await owner.prepareOwnedLocalHostQuit('refuse_active_work');
  if (result === 'ready') return 'ready';
  if (!await prompts.confirmInterrupt()) return 'cancelled';
  await owner.prepareOwnedLocalHostQuit('interrupt_active_work');
  return 'ready';
}
