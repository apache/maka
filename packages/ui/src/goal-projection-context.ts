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

import { createContext, useContext } from 'react';
import type { ChatViewGoalIndicatorProps } from './chat-view.js';
import type { ComposerGoalProps } from './composer.js';

/** The required transport shape for the optional Goal props on Composer. */
export interface ComposerGoalProjection {
  readonly goalActive: NonNullable<ComposerGoalProps['goalActive']>;
  readonly onSetGoal: ComposerGoalProps['onSetGoal'] | undefined;
}

/** The required transport shape for the optional Goal indicator on ChatView. */
export interface ChatViewGoalProjection {
  readonly goalIndicator: ChatViewGoalIndicatorProps['goalIndicator'] | undefined;
}

const inactiveComposerGoalProjection: ComposerGoalProjection = {
  goalActive: false,
  onSetGoal: undefined,
};
const inactiveChatViewGoalProjection: ChatViewGoalProjection = {
  goalIndicator: undefined,
};

const ComposerGoalProjectionContext = createContext<ComposerGoalProjection>(
  inactiveComposerGoalProjection,
);
const ChatViewGoalProjectionContext = createContext<ChatViewGoalProjection>(
  inactiveChatViewGoalProjection,
);

export const ComposerGoalProjectionProvider = ComposerGoalProjectionContext.Provider;
export const ChatViewGoalProjectionProvider = ChatViewGoalProjectionContext.Provider;
export const ComposerGoalProjectionConsumer = ComposerGoalProjectionContext.Consumer;
export const ChatViewGoalProjectionConsumer = ChatViewGoalProjectionContext.Consumer;

/** Defaults to an inactive projection for Composer hosts outside Desktop. */
export function useComposerGoalProjection(): ComposerGoalProjection {
  return useContext(ComposerGoalProjectionContext);
}

/** Defaults to no indicator for ChatView hosts outside Desktop. */
export function useChatViewGoalProjection(): ChatViewGoalProjection {
  return useContext(ChatViewGoalProjectionContext);
}
