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

// Only the display contract recorded by the Host opts into a specialized view.
export function filePresentation(key: string | null | undefined) {
  switch (key) {
    case 'maka.workspace.Files@1/read':
      return 'read';
    case 'maka.workspace.Files@1/write':
      return 'write';
    case 'maka.workspace.Files@1/edit':
      return 'edit';
    case 'maka.workspace.Files@1/applyPatch':
      return 'patch';
    default:
      return null;
  }
}
export function toolPresentation(key: string | null | undefined) {
  switch (key) {
    case 'maka.workspace.Files@1/glob':
      return 'glob';
    case 'maka.workspace.Files@1/grep':
      return 'grep';
    case 'maka.workspace.Processes@1/execute':
      return 'execute';
    case 'maka.workspace.Processes@1/read':
      return 'processRead';
    case 'maka.workspace.Processes@1/writeStdin':
      return 'stdin';
    case 'maka.workspace.Processes@1/stop':
      return 'stop';
    default:
      return filePresentation(key);
  }
}
// Keep Web separate: the existing plugin's display model predates this family.
export function webPresentation(key: string | null | undefined) {
  switch (key) {
    case 'maka.workspace.Web@1/fetch':
      return 'fetch';
    case 'maka.workspace.Web@1/search':
      return 'webSearch';
    default:
      return null;
  }
}
