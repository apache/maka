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
 * The rail's session section takes no filter.
 *
 * It used to carry `'chats' | 'flagged' | 'archived'`. Archived became Settings
 * › 活动 › 已归档任务 (#2985) — cleaning tasks up is management, and the rail
 * lists what you are working on. `flagged` never had a writer: nothing ever
 * selected it, so the branch that filtered on it could not run. What was left
 * was a one-value filter: a control whose answer is always the same answer.
 *
 * The rail's 任务 row went with it, and nothing replaced it. Selecting this
 * section is what clicking a task row already does, so expanded the row sat
 * directly above the list that is its own destination. Collapsed the list is
 * not rendered — but the rail cannot switch tasks there at all, so coming back
 * from 扩展 means widening the rail either way. `activeId` is untouched by a
 * section change, so the task you left is still marked when it does.
 *
 * `sessions` therefore has no control of its own on the rail. It is where you
 * are unless you went somewhere, which is why the other two sections light up
 * and this one has nothing to light.
 */
export type ExtensionModule = 'skills' | 'mcp';
export type AutomationModule = 'scheduled-tasks' | 'daily-review';

export type NavSelection =
  | { section: 'sessions' }
  | { section: 'extensions'; module: ExtensionModule }
  | { section: 'automations'; module: AutomationModule };

export type NavModuleMemory = {
  extensions: ExtensionModule;
  automations: AutomationModule;
};
