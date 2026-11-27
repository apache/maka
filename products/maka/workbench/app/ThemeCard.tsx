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

import { computed, platform, signal, Text, View } from 'nsh';
import { TextView } from 'nsh/base';
import { appearance } from './appearance';
import { CodeBlockAction, codeBlockActions, codeBlockStyles } from './codeBlockLook';
import { tr } from './locale';
import { hardToRead, readThemeBlock, sameLook, type Look } from './look';
import { SettingsButton } from './SettingsPage';
import { lookLabel } from './ThemeEditor';
import { Specimen } from './ThemeSpecimen';
import { bodyTextStyle, C, captionTextStyle, lineWidth, radius, secondaryTextStyle } from './ui';

/** A theme Maka wrote in a reply, as a ```maka-theme block of the look's JSON. */
export const themeExtensions = [{ name: 'maka-theme', language: 'maka-theme' }];

/** Below this width the card shows the appearance in effect only, not light and dark side by side. */
const sideBySide = 520;

/** The theme a block describes, drawn in light and dark, which this device takes only when the
 * person applies it; what is not a theme stays a code block. */
export function ThemeCard(props: { source(): string }) {
  const block = computed(() => {
    try {
      return readThemeBlock(JSON.parse(props.source()));
    } catch {
      return null;
    }
  });
  const code = () => (
    <TextView
      document={{ blocks: [{ type: 'codeBlock', language: 'json', code: props.source() }] }}
      selectable
      renderCodeBlockAction={(action) => <CodeBlockAction action={action} />}
      codeBlockActions={codeBlockActions()}
      styles={codeBlockStyles(C.text, 12)}
    />
  );
  if (platform.idiom === 'terminal') return code();
  return (
    <If when={block()} else={code()}>
      <Card block={() => block()!} />
    </If>
  );
}

function Card(props: { block(): NonNullable<ReturnType<typeof readThemeBlock>> }) {
  const look = () => props.block().look;
  const width = signal(0);
  // The look this device had before the card's was applied, for as long as the card is shown.
  const previous = signal<Look | null>(null);
  const applied = () => sameLook(look(), appearance.shown());
  const apply = () => {
    previous.set(appearance.shown());
    appearance.changeLook(look(), true);
  };
  const undo = () => {
    const before = previous();
    if (!before) return;
    previous.set(null);
    appearance.changeLook(before, true);
  };
  const note = (text: string) => (
    <Text style={{ ...captionTextStyle, color: C.warning }}>{text}</Text>
  );
  return (
    <View
      style={{
        gap: 10,
        padding: 12,
        borderRadius: radius(12),
        borderWidth: lineWidth(),
        borderColor: C.line,
      }}
      onLayout={({ bounds }) => width.set(bounds.size.width)}
    >
      <Text style={{ ...bodyTextStyle, color: C.text, fontWeight: '600' }}>
        {props.block().name ?? lookLabel(look().base)}
      </Text>
      <If when={width() >= sideBySide} else={<Specimen look={look} compact />}>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Specimen look={look} compact dark={false} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Specimen look={look} compact dark />
          </View>
        </View>
      </If>
      <If when={hardToRead(look())}>{note(tr('Some text in this theme is hard to read.'))}</If>
      <If when={props.block().ignored > 0}>
        {note(tr('Some values were not valid and were left out.'))}
      </If>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <If
          when={applied()}
          else={<SettingsButton label={tr('Apply')} tone="primary" onPress={apply} />}
        >
          <Text style={{ ...secondaryTextStyle, color: C.secondary }}>{tr('Applied')}</Text>
          <If when={previous()}>
            <SettingsButton label={tr('Undo')} tone="quiet" onPress={undo} />
          </If>
        </If>
      </View>
      <If when={applied()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Fine-tune it in Settings › General › Theme.')}
        </Text>
      </If>
    </View>
  );
}
