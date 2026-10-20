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

/** Installed in the renderer before any application drop handlers run. */
export const MAIN_WINDOW_DROP_GUARD_SCRIPT = `
(() => {
  const block = (e) => {
    const target = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (target?.closest('[data-maka-file-drop-target="true"]')) return;
    if (target?.closest('[data-maka-queue-drop-target="true"]')
      && e.dataTransfer?.types.includes('application/x-maka-queue-entry')) return;
    if (target?.closest('[data-maka-session-drop-target="true"]')
      && e.dataTransfer?.types.includes('application/x-maka-session')) return;
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('dragover', block, true);
  window.addEventListener('drop', block, true);
})();
`;
