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

import { AsyncLocalStorage } from 'node:async_hooks';

export interface BrowserOriginAdmission {
  readonly sessionId: string;
  readonly url: string;
}

const currentAdmission = new AsyncLocalStorage<BrowserOriginAdmission>();

/** Bind the Host-approved Browser scope to exactly one provider invocation. */
export function withBrowserOriginAdmission<T>(
  admission: BrowserOriginAdmission,
  run: () => T,
): T {
  return currentAdmission.run(admission, run);
}

/** Browser tools fail closed when they are invoked outside the admitted call. */
export function browserOriginAdmission(sessionId: string): BrowserOriginAdmission | undefined {
  const admission = currentAdmission.getStore();
  return admission?.sessionId === sessionId ? admission : undefined;
}
