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

import { Text, View } from 'nsh';
import { tr } from './locale';
import type { Look } from './look';
import { codeTextStyle, lookColors, lookShape, secondaryTextStyle } from './ui';

/** A piece of a conversation in a look, in the appearance in effect or the one `dark` names:
 * what the settings page has none of.
 * `compact` keeps a bubble, a reply, code and the field: every color but the warning, and
 * every part of the shape. */
export function Specimen(props: { look(): Look | null; compact?: boolean; dark?: boolean }) {
  const C = lookColors(props.look, props.dark);
  const { radius, lineWidth, letterSpacing, raisedShadow } = lookShape(props.look, props.dark);
  const line = (text: string, color: string, extra: object = {}) => (
    <Text style={{ ...secondaryTextStyle, color, letterSpacing: letterSpacing(), ...extra }}>
      {text}
    </Text>
  );
  return (
    <View style={{ padding: 12, gap: 10, backgroundColor: C.panel }}>
      <View
        style={{
          alignSelf: 'flex-end',
          maxWidth: '80%',
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: radius(12),
          backgroundColor: C.card,
          ...raisedShadow(),
        }}
      >
        {line(tr('Can you check this function?'), C.text)}
      </View>
      <Text style={{ ...secondaryTextStyle, color: C.text, letterSpacing: letterSpacing() }}>
        {tr('It returns early when the list is empty.')}{' '}
        <Text style={{ color: C.accentText, textDecorationLine: 'underline' }}>
          {tr('See the notes.')}
        </Text>
      </Text>
      <If when={!props.compact}>{line(tr('Ran the tests · 12 passed'), C.muted)}</If>
      <View style={{ borderRadius: radius(6), padding: 8, backgroundColor: C.card, gap: 2 }}>
        <Text style={{ ...codeTextStyle, color: C.text, backgroundColor: C.removed }}>
          {'- if (items.length == 0) return;'}
        </Text>
        <Text style={{ ...codeTextStyle, color: C.text, backgroundColor: C.added }}>
          {'+ if (!items.length) return [];'}
        </Text>
      </View>
      <If when={!props.compact}>{line(tr('Something needs your attention.'), C.warning)}</If>
      <View
        style={{ flexDirection: props.compact ? 'row' : 'column', gap: props.compact ? 8 : 10 }}
      >
        <View
          style={{
            flexGrow: props.compact ? 1 : 0,
            minHeight: 32,
            paddingHorizontal: 10,
            justifyContent: 'center',
            borderRadius: radius(8),
            borderWidth: lineWidth(),
            borderColor: C.line,
            backgroundColor: C.background,
            ...raisedShadow(),
          }}
        >
          {line(tr('Write a reply…'), C.muted)}
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View
            style={{
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: radius(8),
              backgroundColor: C.accent,
              ...raisedShadow(),
            }}
          >
            {line(tr('Send'), C.onAccent, { fontWeight: '600' })}
          </View>
          <If when={!props.compact}>
            <View
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: radius(8),
                borderWidth: lineWidth(),
                borderColor: C.line,
              }}
            >
              {line(tr('Cancel'), C.text)}
            </View>
          </If>
        </View>
      </View>
    </View>
  );
}
