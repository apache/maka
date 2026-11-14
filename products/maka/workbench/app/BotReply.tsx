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

import { Clipboard, signal, Text, View } from 'nsh';
import { Button, ContextMenu, MenuItem, TextView } from 'nsh/base';
import { MermaidView, mermaidExtensions } from './MermaidView';
import type { BotTranscriptMessage } from './botTranscript';
import { tr } from './locale';
import { Icon } from './Icon';
import { C, bodyTextStyle, captionTextStyle } from './ui';

/** Messages the Bot sent with `SendUser`, shown as its reply in the Chat view. */
export function BotReply(props: {
  messages: () => BotTranscriptMessage[];
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
  quote?(message: BotTranscriptMessage, text: string): void;
  openInvestigation?(sessionId: string): void;
  /** The worker whose finished run this reply reports, when the Turn was started by one. */
  worker?: { title: () => string; exists: () => boolean; open(): void };
}) {
  const recordLabel = () => {
    const title = props.worker?.title().trim() ?? '';
    return title
      ? tr('View the record of {title}', { title })
      : tr('View the record of the worker');
  };
  return (
    <View style={{ width: '100%', paddingVertical: 8, gap: 16 }}>
      <Each of={props.messages()} key={(message) => String(message.sequence)}>
        {(message) => {
          const selected = signal('');
          const menuText = signal('');
          let menuOpen = false;
          return (
            <View style={{ gap: 8 }}>
              <If when={!!message().discovery}>
                <Text style={{ ...captionTextStyle, color: C.muted }}>
                  {tr('Proactive discovery')}
                </Text>
              </If>
              <ContextMenu
                onOpenChange={({ open }) => {
                  menuOpen = open;
                  if (open) menuText.set(selected());
                }}
                trigger={
                  <TextView
                    markdown={message().text}
                    extensions={mermaidExtensions}
                    renderCustom={(node) => <MermaidView source={() => node.text ?? ''} />}
                    sourceId={`bot/${message().sequence}`}
                    selectable
                    onSelectionChange={({ text }) => {
                      if (!menuOpen) selected.set(text);
                    }}
                    contentStyle={{ rowGap: 16 }}
                    options={{ preserveLineBreaks: true }}
                    labels={{ table: tr('Markdown table'), copied: tr('Copied') }}
                    onScrollIntent={props.userScroll}
                    onLinkPress={(event) => void props.openLink(event.url, () => false)}
                    styles={{
                      root: { ...bodyTextStyle, color: C.text },
                      paragraph: bodyTextStyle,
                      code: { color: C.accentHover, backgroundColor: C.card },
                    }}
                  />
                }
              >
                <MenuItem onSelect={() => void Clipboard.writeText(menuText() || message().text)}>
                  <Text>{tr('Copy message')}</Text>
                </MenuItem>
                <If when={!!props.quote && !!menuText().trim()}>
                  <MenuItem onSelect={() => props.quote?.(message(), menuText())}>
                    <Text>{tr('Quote selection')}</Text>
                  </MenuItem>
                </If>
              </ContextMenu>
              <If when={!!message().discovery && !!props.openInvestigation}>
                <Button
                  accessibilityLabel={tr('Open investigation')}
                  onPress={() => props.openInvestigation?.(message().discovery!.workerSessionId)}
                  style={{
                    flexDirection: 'row',
                    gap: 6,
                    alignSelf: 'flex-start',
                    alignItems: 'center',
                  }}
                >
                  <Icon name="split" color={C.accent} />
                  <Text style={{ ...captionTextStyle, color: C.accent }}>
                    {tr('Open investigation')}
                  </Text>
                </Button>
              </If>
            </View>
          );
        }}
      </Each>
      <If when={props.worker?.exists() && !props.messages().some((message) => !!message.discovery)}>
        <Button
          accessibilityLabel={recordLabel()}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            alignSelf: 'flex-start',
            maxWidth: '100%',
          }}
          onPress={() => props.worker?.open()}
        >
          <Icon name="split" color={C.accent} />
          <Text
            style={[{ ...captionTextStyle, color: C.accent, flexShrink: 1 }, { numberOfLines: 1 }]}
          >
            {recordLabel()}
          </Text>
        </Button>
      </If>
    </View>
  );
}

/** Shown at the end of the Bot's Chat for a conversation it created that is running or waits. */
export function BotWaiting(props: {
  workers: () => readonly { id: string; title: string; activity: 'working' | 'waiting' }[];
  open?(id: string): void;
}) {
  return (
    <View style={{ width: '100%', paddingVertical: 8, gap: 8 }}>
      <Each of={props.workers()} key={(worker) => worker.id}>
        {(worker) => {
          const label = () =>
            worker().activity === 'waiting'
              ? tr('{title} is waiting for your reply. Open it.', { title: worker().title })
              : tr('{title} is working. See its progress.', { title: worker().title });
          return (
            <Button
              disabled={!props.open}
              accessibilityLabel={label()}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                alignSelf: 'flex-start',
                maxWidth: '100%',
              }}
              onPress={() => props.open?.(worker().id)}
            >
              <Icon
                name="activity"
                color={worker().activity === 'waiting' ? C.warning : C.accent}
              />
              <Text
                style={[
                  { ...captionTextStyle, color: C.text, flexShrink: 1 },
                  { numberOfLines: 1 },
                ]}
              >
                {label()}
              </Text>
            </Button>
          );
        }}
      </Each>
    </View>
  );
}

/** Shown at the end of Chat while a Turn is at work and has no header of its own yet. */
export function BotWorking(props: { detail: () => string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
      <Icon name="activity" color={C.accent} />
      <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}>
        {props.detail() ? `${tr('Working…')} · ${props.detail()}` : tr('Working…')}
      </Text>
    </View>
  );
}

/** Shown under a finished Turn that ended without a message and without going to sleep. */
export function BotNote(props: { text: () => string }) {
  return (
    <View style={{ paddingVertical: 8 }}>
      <Text style={{ ...captionTextStyle, color: C.muted }}>{props.text()}</Text>
    </View>
  );
}
