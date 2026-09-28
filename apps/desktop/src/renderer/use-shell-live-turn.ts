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

import type { LiveTurnSnapshot } from './features/conversation/index.js';
import { activeHostTurn, type SessionExecutionProjection } from './application/contracts/session-execution.js';

/** Shell observes execution at low frequency; content never establishes liveness. */
export function useShellLiveTurn(options: {
  liveTurn: LiveTurnSnapshot;
  execution: SessionExecutionProjection | undefined;
}) {
  const turn = activeHostTurn(options.execution);
  const content = turn?.turnId === options.liveTurn.turnId ? options.liveTurn : undefined;
  return {
    turnActive: Boolean(turn),
    activeStreamingLive: Boolean(content?.hasStreamingText && content.streamingMessageId === undefined),
    activeStreamingMessageId: content?.streamingMessageId,
    hasInFlightLiveTools: content?.hasInFlightTools ?? false,
    hasLiveTurnContent: Boolean(content?.hasStreamingText || content?.hasThinkingText || content?.hasLiveTools),
  };
}
