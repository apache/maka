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

const panels = new Map<string, () => boolean>();
export function bindSideConversationReadiness(id: string, hasContent: () => boolean): () => void {
  panels.set(id, hasContent);
  return () => { if (panels.get(id) === hasContent) panels.delete(id); };
}
export function sideConversationHasContent(id: string): boolean {
  // An unmounted or not-yet-ready panel cannot certify a safe handoff.
  return panels.get(id)?.() ?? true;
}
