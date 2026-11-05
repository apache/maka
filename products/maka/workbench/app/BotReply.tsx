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

import { View } from 'nsh';
import { Button, TextView } from 'nsh/base';
import { MermaidView, mermaidExtensions } from './MermaidView';
import type { BotTranscriptMessage } from './botTranscript';
import { tr } from './locale';
import { Text } from 'nsh';
import { Icon } from './Icon';
import { C, bodyTextStyle, captionTextStyle } from './ui';

/** Messages the Bot sent with `SendUser`, shown as its reply in the Chat view. */
export function BotReply(props: {
  messages: () => BotTranscriptMessage[];
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
  /** The worker whose finished run this reply reports, when the Turn was started by one. */
  worker?: { title: () => string; open(): void };
}) {
  return (
    <View selectable style={{ width: '100%', paddingVertical: 8, gap: 16 }}>
      <Each of={props.messages()} key={(message) => String(message.sequence)}>
        {(message) => (
          <TextView
            markdown={message().text}
            extensions={mermaidExtensions}
            renderCustom={(node) => <MermaidView source={() => node.text ?? ''} />}
            sourceId={`bot/${message().sequence}`}
            selectable
            contentStyle={{ rowGap: 16 }}
            options={{ preserveLineBreaks: true }}
            labels={{ table: tr('Markdown table'), copied: tr('Copied') }}
            onScrollIntent={props.userScroll}
            onLinkPress={(event) => void props.openLink(event.url, () => false)}
            styles={{
              root: { ...bodyTextStyle, color: C.text },
              paragraph: bodyTextStyle,
              code: { color: C.accentHover, backgroundColor: C.surface },
            }}
          />
        )}
      </Each>
      <If when={props.worker}>
        <Button
          accessibilityLabel={tr('Open the worker beside this conversation')}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
          onPress={() => props.worker?.open()}
        >
          <Icon name="split" color={C.accent} />
          <Text style={[{ ...captionTextStyle, color: C.accent }, { numberOfLines: 1 }]}>
            {tr('View the record of {title}', { title: props.worker!.title() })}
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
        {(worker) => (
          <Button
            disabled={!props.open}
            accessibilityLabel={tr('Open the conversation beside this one')}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' }}
            onPress={() => props.open?.(worker().id)}
          >
            <Icon name="activity" color={worker().activity === 'waiting' ? C.warning : C.accent} />
            <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}>
              {worker().activity === 'waiting'
                ? tr('{title} is waiting for your reply. Open it.', { title: worker().title })
                : tr('{title} is working. See its progress.', { title: worker().title })}
            </Text>
          </Button>
        )}
      </Each>
    </View>
  );
}

/** Shown at the end of the Bot's Chat while it is working on a Turn. */
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
