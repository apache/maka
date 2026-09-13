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

import { sessionUiSelectors as select, type AppShellSessionUiStateController } from './features/conversation/index.js';
import { useExternalStoreSelector } from './use-external-store-selector.js';

/** Shell subscribes to low-frequency execution and content summaries, never raw tokens. */
export function useAppShellSessionUiReads(controller: AppShellSessionUiStateController, activeId: string | undefined) {
  return {
    ...useExternalStoreSelector(controller, select.messageLoad, undefined, select.messageLoadEqual),
    ...useExternalStoreSelector(controller, select.active, activeId, select.activeEqual),
    messageRetryPendingBySession: useExternalStoreSelector(controller, select.retry),
    stopPendingBySession: useExternalStoreSelector(controller, select.stop),
    interactionBySession: useExternalStoreSelector(controller, select.interaction),
    messageQueueBySession: useExternalStoreSelector(controller, select.queue),
    streamingSessionIds: useExternalStoreSelector(controller, select.pulse, undefined, select.pulseEqual),
  };
}
