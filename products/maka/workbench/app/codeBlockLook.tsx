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

import { platform, Text } from 'nsh';
import { tr } from './locale';
import { C, codeTextStyle, secondaryTextStyle } from './ui';

/** One look for every code block: in a reply, and a diagram's source. */
export const codeBlockActions = () => [
  { id: 'wrap', label: tr('Wrap code') },
  { id: 'copy', label: tr('Copy code block') },
];

export function CodeBlockAction(props: { action: { id: string; label?: string | null } }) {
  return (
    <Text style={[{ ...secondaryTextStyle, color: C.muted }, { userSelect: 'none' }]}>
      {props.action.id === 'wrap' ? tr('Wrap code') : (props.action.label ?? props.action.id)}
    </Text>
  );
}

export function codeBlockStyles(color: string, radius: number) {
  return {
    codeBlock: { backgroundColor: C.card, borderColor: C.line, borderRadius: radius },
    codeBlockCode: { ...codeTextStyle, color },
    codeBlockHeader:
      platform.idiom === 'terminal'
        ? { color: C.muted }
        : { color: C.muted, paddingHorizontal: 12, paddingTop: 8 },
    // The desktop starts the language where the code starts.
    codeBlockLanguage:
      platform.idiom === 'terminal'
        ? secondaryTextStyle
        : { ...secondaryTextStyle, paddingLeft: 4 },
  };
}
