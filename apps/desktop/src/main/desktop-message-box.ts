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

import {
  app,
  type BrowserWindow,
  dialog,
  type MessageBoxOptions,
  type MessageBoxReturnValue,
} from 'electron';
import { revealMode } from './startup-context.js';

export async function presentMessageBox(
  options: MessageBoxOptions,
  parent?: BrowserWindow,
): Promise<MessageBoxReturnValue> {
  // A run that may not reveal the dialog has nobody to answer it.
  if (revealMode === 'hidden') return { response: options.cancelId ?? 0, checkboxChecked: false };
  bringDecisionForward();
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

// A dialog blocks its flow until someone answers it, and the request behind it
// (a Dock or AppleScript quit, a Host failure) often arrives while another app
// is active, where a dialog of an inactive app stays buried.
export function bringDecisionForward(): void {
  if (revealMode === 'active') app.focus({ steal: true });
}
