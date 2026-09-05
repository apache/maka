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
 * Resolve the renderer entry before Electron starts. This lets Vite finish
 * dependency optimization and prevents a first navigation from combining
 * modules from two optimizer generations.
 */
export async function warmupDevRenderer(server, entry = '/main.tsx') {
  const environment = server.environments?.client;
  if (environment?.warmupRequest && environment?.waitForRequestsIdle) {
    await environment.warmupRequest(entry);
    await environment.waitForRequestsIdle();
    return;
  }

  // Vite 7 and earlier expose the same operation on the server. Keep this
  // fallback for local installs that have not moved to per-environment APIs.
  await server.warmupRequest(entry);
}
