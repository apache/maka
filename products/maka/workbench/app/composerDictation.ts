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

import type { ComposerEditor } from './ComposerEditor';

export async function dictateIntoDraft(
  editor: ComposerEditor,
  expectedText: string,
  selection: { start: number; end: number },
  record: () => Promise<string | null>,
  current: () => boolean,
) {
  const range = { ...selection };
  const text = await record();
  if (text === null || !current()) return;
  if (!text.trim()) return { kind: 'empty' } as const;
  editor.focus();
  if (!(await editor.replaceRange({ ...range, expectedSelection: range, expectedText, text })))
    return { kind: 'changed', text } as const;
}

/** The native meter maps -55…0 dB to 0…1. Ignore short clicks before the first phrase. */
export function speechEndpoint(started: number) {
  let voiceSince: number | undefined;
  let lastVoice: number | undefined;
  return (now: number, level: number): 'finish' | 'cancel' | undefined => {
    if (level < 0) return lastVoice === undefined ? 'cancel' : 'finish';
    if (level >= 0.22) {
      voiceSince ??= now;
      if (lastVoice !== undefined || now - voiceSince >= 160) lastVoice = now;
    } else {
      voiceSince = undefined;
    }
    if (lastVoice !== undefined && now - lastVoice >= 1200) return 'finish';
    if (lastVoice === undefined && now - started >= 12000) return 'cancel';
  };
}
