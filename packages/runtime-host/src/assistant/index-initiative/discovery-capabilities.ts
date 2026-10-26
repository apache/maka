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

/**
 * Tools the proactive discovery Session must not see or run (#6249, #6250).
 *
 * Discovery investigates and reports through DiscoveryReport; it does not create,
 * adopt or mutate conversation-owned Matters or memory indexes, control initiative
 * configuration, or deliver to the user directly. Read tools (MatterOverview,
 * MemoryIndexRead, DiscoveryContext, ...) and source queries stay available.
 * Whether MemorySourceQuery and MemoryExtract belong here is still an open
 * design question tracked in the RFC.
 */
export const DISCOVERY_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  // Matter creation, adoption and conversation-scoped control.
  'MatterDelegate',
  'MatterStart',
  'MatterAdopt',
  'MatterControl',
  'MatterMessage',
  'MatterTaskControl',
  'MatterTaskMessage',
  'MatterReply',
  'MatterDelegationRecover',
  'MatterFeedbackRetry',
  // Matter worker lifecycle tools; valid only inside an activation the Session owns.
  'MatterRead',
  'MatterReadFile',
  'MatterWriteFile',
  'MatterCheckpoint',
  'MatterSettle',
  'MatterConditionTest',
  'MatterAskBot',
  // Memory index mutation. Writes belong to index workers and the conversation.
  'MemoryIndexCreate',
  'MemoryIndexCreateGroup',
  'MemoryIndexWrite',
  'MemoryIndexEdit',
  'MemoryIndexCheckpoint',
  'MemoryIndexControl',
  'MemoryIndexAddSources',
  'MemoryIndexMaintain',
  // Initiative configuration is owned by the conversation.
  'InitiativeEnable',
  'InitiativeConfigure',
  'InitiativeControl',
  // Bot-only coordination tools.
  'SendUser',
  'InboxCheck',
  'InboxList',
  'InboxRead',
  'AssistantCharacterPack',
  'AssistantPetPack',
  'AssistantSetup',
  'AssistantStickerSearch',
  'Sleep',
]);
