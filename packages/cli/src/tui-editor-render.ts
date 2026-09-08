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

import type { Editor } from '@earendil-works/pi-tui';

export function renderEditorWithFocus(editor: Editor, width: number): string[] {
  const lines = editor.render(width);
  if (editor.focused) return lines;
  // pi-tui 0.84.4 gates only the IME marker on `focused`, not its synthetic cursor.
  // Our editor themes use SGR 7/text/SGR 0 only for that cursor. Remove its wrapper,
  // keeping the character (or paste marker) and other styles, including borders
  // and skill highlights. Recheck this contract when upgrading pi-tui.
  return lines.map((line) => line.replace(/\x1b\[7m([^\x1b]*)\x1b\[0m/gu, '$1'));
}
