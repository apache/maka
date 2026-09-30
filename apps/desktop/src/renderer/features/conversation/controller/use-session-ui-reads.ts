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

import { useSessionUiRead } from './use-session-ui-read.js';
import type { SessionUiReads } from '../model/session-ui-reads.js';

/** Shell subscribes to low-frequency execution and content summaries, never raw tokens. */
export function useAppShellSessionUiReads(reads: SessionUiReads, activeId: string | undefined, ownerId: string | undefined) {
  return {
    ...useSessionUiRead(reads, 'load', activeId),
    ...useSessionUiRead(reads, 'summary', activeId),
    messageRetryPending: useSessionUiRead(reads, 'retry', activeId),
    stopPending: useSessionUiRead(reads, 'stop', activeId),
    activeInteraction: useSessionUiRead(reads, 'interaction', ownerId),
    activeMessageQueue: useSessionUiRead(reads, 'queue', activeId),
  };
}
