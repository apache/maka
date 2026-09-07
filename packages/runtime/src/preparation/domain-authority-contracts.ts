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

import type { ResourceAuthority } from './types.js';

export type DomainAccessMode = 'read' | 'write' | 'exclusive';

export interface SessionDomainOperation<Operation extends string> {
  readonly operation: Operation;
}

export interface SessionDomainAuthority<Input extends SessionDomainOperation<string>, Result>
  extends ResourceAuthority<Input, Result> {}

export type SessionTodoResourceOperation =
  | SessionDomainOperation<'read'>
  | (SessionDomainOperation<'replace'> & { readonly items: unknown });

export type GoalResourceOperation =
  | SessionDomainOperation<'status'>
  | (SessionDomainOperation<'set'> & { readonly condition: string })
  | SessionDomainOperation<'clear'>
  | SessionDomainOperation<'pause'>
  | SessionDomainOperation<'resume'>;

export type PlanResourceOperation =
  | SessionDomainOperation<'submit'>
  | (SessionDomainOperation<'update'> & { readonly executionId: string })
  | (SessionDomainOperation<'cancel'> & { readonly executionId: string });

export type ShellRunResourceOperation =
  | (SessionDomainOperation<'stop'> & { readonly ref: string })
  | (SessionDomainOperation<'write'> & { readonly ref: string });

export type HistoryResourceOperation =
  | SessionDomainOperation<'search'>
  | (SessionDomainOperation<'read'> & { readonly sessionId: string });

export type ScheduledTaskResourceOperation =
  | SessionDomainOperation<'list'>
  | SessionDomainOperation<'create'>
  | (SessionDomainOperation<'pause' | 'resume' | 'delete'> & { readonly taskId: string });

export type SkillCatalogResourceOperation = SessionDomainOperation<'search'>;

export type ComputerResourceOperation = SessionDomainOperation<'invoke'>;

export type SessionTodoResourceAuthority<Result = unknown> = SessionDomainAuthority<
  SessionTodoResourceOperation,
  Result
>;

export type GoalResourceAuthority<Result = unknown> = SessionDomainAuthority<
  GoalResourceOperation,
  Result
>;

export type PlanResourceAuthority<Result = unknown> = SessionDomainAuthority<
  PlanResourceOperation,
  Result
>;

export type ShellRunResourceAuthority<Result = unknown> = SessionDomainAuthority<
  ShellRunResourceOperation,
  Result
>;

export type HistoryResourceAuthority<Result = unknown> = ResourceAuthority<
  HistoryResourceOperation,
  Result
>;

export type ScheduledTaskResourceAuthority<Result = unknown> = ResourceAuthority<
  ScheduledTaskResourceOperation,
  Result
>;

export type SkillCatalogResourceAuthority<Result = unknown> = ResourceAuthority<
  SkillCatalogResourceOperation,
  Result
>;

export type ComputerResourceAuthority<Result = unknown> = SessionDomainAuthority<
  ComputerResourceOperation,
  Result
>;

/**
 * Common identities for precise non-filesystem authorities. The contracts are
 * ready for domain adapters; until those adapters are completed, tools with an
 * internal correctness boundary use none() and unsafe shared domains use all().
 */
export type PreciseDomainAuthorityKind =
  | 'session-todo'
  | 'goal'
  | 'plan'
  | 'shell-run'
  | 'history'
  | 'scheduled-task'
  | 'skill-catalog'
  | 'computer'
  | 'deep-research'
  | 'memory'
  | 'terminal-background';

export interface PreciseDomainResourceIdentity {
  readonly authority: PreciseDomainAuthorityKind;
  /** Stable domain identity such as sessionId, taskId, graphId, or terminalId. */
  readonly key: string;
}

export interface PreciseDomainAuthority<Input = unknown, Result = unknown>
  extends ResourceAuthority<Input, Result> {
  readonly domain: PreciseDomainAuthorityKind;
}

export interface SessionTodoAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'session-todo';
}

export interface GoalAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'goal';
}

export interface PlanAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'plan';
}

export interface ShellRunAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'shell-run';
}

export interface HistoryAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'history';
}

export interface ScheduledTaskAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'scheduled-task';
}

export interface SkillCatalogAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'skill-catalog';
}

export interface ComputerAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'computer';
}

export interface DeepResearchAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'deep-research';
}

export interface MemoryAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'memory';
}

export interface TerminalBackgroundAuthority<Input = unknown, Result = unknown>
  extends PreciseDomainAuthority<Input, Result> {
  readonly domain: 'terminal-background';
}
