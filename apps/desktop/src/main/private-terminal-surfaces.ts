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

// Contains identities only. Never retain terminal text or human input here.
const surfaces = new Map<number, Set<string>>();
const captures = new Set<Promise<unknown>>();

/** Register before yielding so mounting a private surface fences in-flight capture too. */
export function trackDesktopCapture<T>(task: Promise<T>): Promise<T> {
  captures.add(task);
  void task.then(() => captures.delete(task), () => captures.delete(task));
  return task;
}

export async function drainDesktopCaptures(): Promise<void> {
  await Promise.allSettled([...captures]);
}

export function setPrivateTerminalSurface(windowId: number, controllerId: string, visible: boolean): void {
  const controllers = surfaces.get(windowId) ?? new Set<string>();
  if (visible) controllers.add(controllerId);
  else controllers.delete(controllerId);
  if (controllers.size) surfaces.set(windowId, controllers);
  else surfaces.delete(windowId);
}

export function clearPrivateTerminalSurfaces(windowId: number): void {
  surfaces.delete(windowId);
}

export function hasPrivateTerminalSurface(): boolean {
  return surfaces.size > 0;
}
