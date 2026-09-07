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

export { ToolPreparationService } from './preparation/tool-preparation-service.js';
export {
  ToolAuthorityRegistry,
  type RegisteredToolAuthority,
  type ToolAuthorityRegistration,
} from './preparation/tool-authority-registry.js';
export {
  EXPLICIT_ALL_TOOL_AUTHORITY_IDS,
  EXPLICIT_NONE_TOOL_AUTHORITY_IDS,
  defaultToolAuthorityRegistrations,
} from './preparation/default-tool-authorities.js';
export type {
  AuthorityContext,
  PreparedOperation,
  ResourceAuthority,
  ResourceClaim,
} from './preparation/types.js';
export type {
  ComputerAuthority,
  ComputerResourceAuthority,
  ComputerResourceOperation,
  DeepResearchAuthority,
  DomainAccessMode,
  GoalAuthority,
  GoalResourceAuthority,
  GoalResourceOperation,
  HistoryAuthority,
  HistoryResourceAuthority,
  HistoryResourceOperation,
  MemoryAuthority,
  PlanAuthority,
  PlanResourceAuthority,
  PlanResourceOperation,
  PreciseDomainAuthority,
  PreciseDomainAuthorityKind,
  PreciseDomainResourceIdentity,
  ScheduledTaskAuthority,
  ScheduledTaskResourceAuthority,
  ScheduledTaskResourceOperation,
  SessionDomainAuthority,
  SessionDomainOperation,
  SessionTodoAuthority,
  SessionTodoResourceAuthority,
  SessionTodoResourceOperation,
  ShellRunAuthority,
  ShellRunResourceAuthority,
  ShellRunResourceOperation,
  SkillCatalogAuthority,
  SkillCatalogResourceAuthority,
  SkillCatalogResourceOperation,
  TerminalBackgroundAuthority,
} from './preparation/domain-authority-contracts.js';
