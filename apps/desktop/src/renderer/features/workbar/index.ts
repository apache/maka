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

export { WorkbarHost } from './ui/workbar-host';
export { WorkbarSurface } from './ui/workbar-surface';
export { WorkbarTitlebarActions, WorkbarToggle } from './ui/workbar-toggle';
export { WorkbarServicesProvider, useWorkbarServices } from './services-context';
export { useWorkbarLayoutState } from './controller/use-workbar-layout-state';
export {
  consumeCompanionInitialPrompt,
  consumeCompanionQuoteSnapshot,
  openCompanionPanel,
  removeStagedCompanionQuote,
  stageCompanionQuote,
} from './tools/side-chat/quote-companion-panel-state';
export {
  applyCompanionForkVisibilityEvent,
  reconcileCompanionForkVisibility,
} from './tools/side-chat/quote-companion-visibility';
export { recoverOrphanedCompanionCopies } from './tools/side-chat/quote-companion-core';
export { useSideConversationWorkspace } from './tools/side-chat/use-side-conversation-workspace';
export {
  findPreferredSideChatWorkbarTab,
  terminalRefFromWorkbarTab,
  terminalSessionWorkbarTabId,
} from './model/workbar-tabs';
export type {
  CompanionQuoteSnapshot,
  CompanionQuoteTarget,
  QuoteCompanionPanelState,
} from './tools/side-chat/quote-companion-panel-state';
export type { CompanionForkVisibilityEvent } from './tools/side-chat/quote-companion-visibility';
export type {
  SessionWorkbarPanelsState,
  SessionWorkbarPlacement,
  SessionWorkbarTab,
  SessionWorkbarTabKind,
} from './model/workbar-tabs';
export type {
  SideChatSessionPort,
  WorkbarIngestInput,
  WorkbarSessionTracePage,
  WorkbarSessionUsageSummary,
  WorkbarServices,
} from './ports';
