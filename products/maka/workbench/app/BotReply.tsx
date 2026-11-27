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

import { cleanup, Clipboard, computed, platform, signal, Text, View } from 'nsh';
import { Button, ContextMenu, MenuItem, TextView } from 'nsh/base';
import { MarkdownImageView } from './MarkdownImage';
import { MermaidView } from './MermaidView';
import { SpecView, markdownExtensions } from './SpecView';
import { ThemeCard } from './ThemeCard';
import type { BotTranscriptMessage } from './botTranscript';
import { tr } from './locale';
import { compactCopyInset, CompactReplyFooter, LocalMessageCopy } from './CompactReplyFooter';
import type { replyMetrics } from './replyDetails';
import { Icon } from './Icon';
import { ShimmerText, ThinkingMark } from './Loading';
import { splitSpecMarkdown } from './spec/session.ts';
import type { BindTextViewToc } from './turnToc';
import { C, bodyTextStyle, captionTextStyle } from './ui';

/** Messages the Bot sent with `SendUser`, shown as its reply in the Chat view. */
export function BotReply(props: {
  messages: () => BotTranscriptMessage[];
  bindToc?: BindTextViewToc;
  sessionId?: string;
  metrics?(at: number): ReturnType<typeof replyMetrics>;
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
    <View
      style={{ width: '100%', paddingVertical: props.metrics ? 0 : 8, gap: props.metrics ? 0 : 16 }}
    >
      <Each of={props.messages()} key={(message) => String(message.sequence)}>
        {(message) => {
          const segments = computed(() => splitSpecMarkdown(message().text));
          return (
            <View
              class={props.metrics ? 'group' : undefined}
              style={{ width: '100%', gap: props.metrics ? 0 : 16 }}
            >
              <View style={{ gap: 16 }}>
                <If when={!!message().discovery}>
                  <Text style={{ ...captionTextStyle, color: C.muted }}>
                    {tr('Proactive discovery')}
                  </Text>
                </If>
                <Each of={segments()} key={(seg) => seg.key}>
                  {(seg) => {
                    const selected = signal('');
                    const menuText = signal('');
                    let menuOpen = false;
                    const initialSeg = seg();
                    const toc =
                      initialSeg.kind === 'markdown'
                        ? props.bindToc?.(
                            `${message().sequence}:${initialSeg.key}`,
                            message().sequence * 1e9 + initialSeg.start,
                          )
                        : undefined;
                    if (toc) cleanup(() => toc.dispose());
                    return (
                      <If
                        when={seg().kind === 'spec'}
                        else={
                          <ContextMenu
                            onOpenChange={({ open }) => {
                              menuOpen = open;
                              if (open) menuText.set(selected());
                            }}
                            trigger={
                              <TextView
                                ref={toc ? (node) => toc.onRef(node) : undefined}
                                onHeadingsChange={
                                  toc ? (event) => toc.onHeadingsChange(event) : undefined
                                }
                                onVisibleBlocksChange={
                                  toc ? (event) => toc.onVisibleBlocksChange(event) : undefined
                                }
                                markdown={(() => {
                                  const s = seg();
                                  return s.kind === 'markdown' ? s.text : '';
                                })()}
                                extensions={markdownExtensions}
                                renderCustom={(node) =>
                                  node.name === 'maka-theme' ? (
                                    <ThemeCard source={() => node.text ?? ''} />
                                  ) : node.name === 'spec' ? (
                                    <SpecView
                                      source={() => node.text ?? ''}
                                      sessionId={props.sessionId}
                                      openLink={props.openLink}
                                    />
                                  ) : (
                                    <MermaidView source={() => node.text ?? ''} />
                                  )
                                }
                                sourceId={(() => {
                                  const s = seg();
                                  return s.kind === 'markdown' && s.start === 0
                                    ? `bot/${message().sequence}`
                                    : undefined;
                                })()}
                                selectable
                                onSelectionChange={({ text }) => {
                                  if (!menuOpen) selected.set(text);
                                }}
                                contentStyle={{ rowGap: 16 }}
                                options={{ preserveLineBreaks: true }}
                                labels={{ table: tr('Markdown table'), copied: tr('Copied') }}
                                onScrollIntent={props.userScroll}
                                onLinkPress={(event) => {
                                  const target = event.target;
                                  if (!target || target.isLive()) {
                                    void props.openLink(event.url, () =>
                                      target ? target.focus() : false,
                                    );
                                  }
                                }}
                                renderImage={
                                  props.sessionId
                                    ? (image, context) => (
                                        <MarkdownImageView
                                          image={() => image}
                                          sessionId={props.sessionId!}
                                          linked={context.link != null}
                                          flow={context.flow}
                                          lineHeight={context.lineHeight}
                                        />
                                      )
                                    : undefined
                                }
                                styles={{
                                  root: { ...bodyTextStyle, color: C.text },
                                  paragraph: bodyTextStyle,
                                  code: { color: C.accentHover, backgroundColor: C.card },
                                }}
                              />
                            }
                          >
                            <MenuItem
                              onSelect={() =>
                                void Clipboard.writeText(menuText() || message().text)
                              }
                            >
                              <Text>{tr('Copy message')}</Text>
                            </MenuItem>
                            <If when={!!props.quote && !!menuText().trim()}>
                              <MenuItem onSelect={() => props.quote?.(message(), menuText())}>
                                <Text>{tr('Quote selection')}</Text>
                              </MenuItem>
                            </If>
                          </ContextMenu>
                        }
                      >
                        <SpecView
                          source={() => {
                            const current = seg();
                            return current.kind === 'spec' ? current.source : '';
                          }}
                          sessionId={props.sessionId}
                          openLink={props.openLink}
                        />
                      </If>
                    );
                  }}
                </Each>
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
                    <Icon name="split" color={C.accentText} />
                    <Text style={{ ...captionTextStyle, color: C.accentText }}>
                      {tr('Open investigation')}
                    </Text>
                  </Button>
                </If>
              </View>
              <If when={props.metrics}>
                <View
                  class="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                  style={{ marginLeft: compactCopyInset }}
                >
                  <CompactReplyFooter
                    at={message().at}
                    metrics={() => props.metrics!(message().at)}
                    copy={<LocalMessageCopy text={() => message().text} />}
                  />
                </View>
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
          <Icon name="split" color={C.accentText} />
          <Text
            style={[
              { ...captionTextStyle, color: C.accentText, flexShrink: 1 },
              { numberOfLines: 1 },
            ]}
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
                color={worker().activity === 'waiting' ? C.warning : C.accentText}
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
  const text = () => (props.detail() ? `${tr('Working…')} · ${props.detail()}` : tr('Working…'));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}>
      <If
        when={platform.idiom === 'terminal'}
        else={
          <>
            <ThinkingMark />
            <ShimmerText text={text()} style={captionTextStyle} />
          </>
        }
      >
        <Icon name="activity" color={C.accentText} />
        <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}>
          {text()}
        </Text>
      </If>
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
