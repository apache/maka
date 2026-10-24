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

export const BOT_TOOLS = new Set([
  'InboxList',
  'InboxRead',
  'InboxCheck',
  'SendUser',
  'DiscoveryFeedback',
  'AssistantSetAvatar',
  'Sleep',
  'AssistantConversation',
  'MatterDelegate',
  'MatterTasks',
  'MatterTaskMessage',
  'MatterReply',
  'MatterTaskControl',
  'MatterDelegationRecover',
  'MatterFeedbackRetry',
  'InitiativeEnable',
  'InitiativeConfigure',
  'InitiativeControl',
  'InitiativeStatus',
  'MemoryIndexCreate',
  'MemoryIndexCreateGroup',
  'MemoryIndexMaintain',
  'MemoryIndexControl',
  'MemoryIndexAddSources',
  'MemoryIndexList',
  'MemoryIndexRead',
  'MemoryIndexContent',
  'MemoryIndexLinks',
  'MemoryOriginal',
  'MemoryHistory',
  'MemorySources',
  'MemoryRange',
]);
export const BOT_DELEGATION_TOOLS = new Set(
  [...BOT_TOOLS].filter(
    (name) =>
      name.startsWith('Matter') || name.startsWith('Initiative') || name.startsWith('Memory'),
  ),
);
/** Assistant tools visible to the exploration session: read-only Memory and Matters plus DiscoveryContext; reports go through notebook files. */
export const DISCOVERY_TOOLS = new Set([
  'DiscoveryContext',
  'MemoryStatus',
  'MemorySources',
  'MemoryRange',
  'MemoryHistory',
  'MemoryExtract',
  'MemorySourceQuery',
  'MemoryOriginal',
  'MemoryIndexList',
  'MemoryIndexRead',
  'MemoryIndexContent',
  'MemoryIndexLinks',
  'MatterOverview',
]);
