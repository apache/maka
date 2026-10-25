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

import type {
  WorktreeMutation,
  WorktreeMutationResult,
  WorktreeSnapshot,
} from '@maka/core/worktree';
export interface WorktreeHostRef {
  profileId: string;
  hostId: string;
}
export interface WorktreeServices {
  subscribeChanges(listener: () => void): () => void;
  query(host: WorktreeHostRef, projectId?: string): Promise<WorktreeSnapshot>;
  mutate(host: WorktreeHostRef, input: WorktreeMutation): Promise<WorktreeMutationResult>;
  resumeTask(host: WorktreeHostRef, path: string): Promise<string | undefined>;
  openTask(host: WorktreeHostRef, path: string, terminal: boolean): Promise<string | undefined>;
}
