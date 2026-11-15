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

import { cleanup, computed, platform, signal, Text, View } from 'nsh';
import { TextView } from 'nsh/base';
import { hasTextPrefix, type Row } from './history';
import { CodeBlockAction, codeBlockActions, codeBlockStyles } from './codeBlockLook';
import { MermaidView } from './MermaidView';
import { MarkdownImageView } from './MarkdownImage';
import { SpecView, markdownExtensions } from './SpecView';
import { SourceText } from './SourceText';
import { tr } from './locale';
import { splitSpecMarkdown } from './spec/session.ts';
import { C, bodyTextStyle, secondaryTextStyle } from './ui';

export function MarkdownBody(props: {
  row: () => Row;
  sourceId: string;
  sessionId: string;
  compact?: boolean;
  /** Compact size in the full text color, for a message another agent sent. */
  fullColor?: boolean;
  /** The complete text, read apart from the row, shown in place of the row's own. */
  text?(): string;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
}) {
  const failure = signal<string | null>(null);
  let alive = true;
  cleanup(() => {
    alive = false;
  });

  const isStreaming = () => {
    if (props.text !== undefined) return false;
    const r = props.row();
    return r.closedAt === null || Boolean(r.preview);
  };

  const makeLinkGuard = () => {
    const row = props.row();
    const sourceId = props.sourceId;
    return () => {
      const current = props.row();
      return (
        alive &&
        props.sourceId === sourceId &&
        current.messageId === row.messageId &&
        current.field === row.field &&
        (props.text !== undefined || (hasTextPrefix(current) && current.text.startsWith(row.text)))
      );
    };
  };

  const openSpecLink = (target: string, restoreFocus: () => boolean): Promise<void> => {
    const owns = makeLinkGuard();
    if (!owns()) return Promise.resolve();
    return props.openLink(target, () => {
      if (!owns()) return false;
      return restoreFocus();
    });
  };

  const rawMarkdown = () => (props.text ? props.text() : props.row().text);
  const segments = computed(() => splitSpecMarkdown(rawMarkdown()));
  const ownerIdentity = () => {
    const r = props.row();
    return `${props.sourceId}\0${r.messageId}\0${r.field}`;
  };

  const readingStyle = props.compact ? secondaryTextStyle : bodyTextStyle;
  const color = () => (props.compact && !props.fullColor ? C.muted : C.text);
  const blockGap = props.compact ? 6 : 16;

  return (
    <View selectable>
      <If
        when={props.text !== undefined || hasTextPrefix(props.row())}
        else={
          <Text style={[{ ...readingStyle, color: color() }, { userSelect: 'text' }]}>
            <SourceText row={props.row} sourceId={props.sourceId} />
          </Text>
        }
      >
        <View style={{ width: '100%', gap: blockGap }}>
          <Each
            of={segments()}
            key={(seg) => (seg.kind === 'spec' ? `${ownerIdentity()}\0${seg.key}` : seg.key)}
          >
            {(seg) => (
              <If
                when={seg().kind === 'spec'}
                else={
                  <TextView
                    markdown={(() => {
                      const s = seg();
                      return s.kind === 'markdown' ? s.text : '';
                    })()}
                    extensions={markdownExtensions}
                    renderCustom={(node) =>
                      node.name === 'spec' ? (
                        <SpecView
                          source={() => node.text ?? ''}
                          streaming={isStreaming}
                          sessionId={props.sessionId}
                          openLink={openSpecLink}
                        />
                      ) : (
                        <MermaidView source={() => node.text ?? ''} />
                      )
                    }
                    sourceId={(() => {
                      const s = seg();
                      return s.kind === 'markdown' && s.atStart ? props.sourceId : undefined;
                    })()}
                    selectable
                    contentStyle={{ rowGap: blockGap }}
                    options={{ streaming: true, preserveLineBreaks: true }}
                    labels={{ table: tr('Markdown table'), copied: tr('Copied') }}
                    onScrollIntent={props.userScroll}
                    onParseError={({ reason }) => failure.set(reason)}
                    onLinkPress={(event) => {
                      const owns = makeLinkGuard();
                      const target = event.target;
                      if (owns() && target?.isLive())
                        void props.openLink(event.url, () => {
                          if (!owns() || !target) return false;
                          return target.focus();
                        });
                    }}
                    renderImage={(context) => (
                      <MarkdownImageView
                        image={() => context.image}
                        sessionId={props.sessionId}
                        linked={context.linked}
                        flow={context.flow}
                        lineHeight={context.lineHeight}
                      />
                    )}
                    renderCodeBlockAction={(action) => <CodeBlockAction action={action} />}
                    codeBlockActions={codeBlockActions()}
                    styles={{
                      root: { ...readingStyle, color: color() },
                      paragraph: readingStyle,
                      heading: {
                        ...readingStyle,
                        fontSize: props.compact ? secondaryTextStyle.fontSize : 18,
                        fontWeight: props.compact ? '600' : '700',
                        color: color(),
                      },
                      heading1: { fontSize: props.compact ? secondaryTextStyle.fontSize : 18 },
                      heading2: { fontSize: props.compact ? secondaryTextStyle.fontSize : 18 },
                      heading3: { fontSize: props.compact ? secondaryTextStyle.fontSize : 18 },
                      heading4: { fontSize: props.compact ? secondaryTextStyle.fontSize : 18 },
                      heading5: { fontSize: props.compact ? secondaryTextStyle.fontSize : 18 },
                      heading6: { fontSize: props.compact ? secondaryTextStyle.fontSize : 18 },
                      blockquote: { borderLeftColor: C.line, color: C.secondary },
                      link: { color: C.accent },
                      code: { color: color(), backgroundColor: C.card, borderRadius: 4 },
                      ...codeBlockStyles(color(), props.compact ? 8 : 12),
                      // The desktop starts a table's text where a code block's starts.
                      tableCell: {
                        ...readingStyle,
                        ...(platform.idiom === 'terminal' ? {} : { paddingHorizontal: 16 }),
                        color: color(),
                        borderColor: C.line,
                      },
                      tableHeaderCell: {
                        ...readingStyle,
                        ...(platform.idiom === 'terminal' ? {} : { paddingHorizontal: 16 }),
                        color: color(),
                        fontWeight: '600',
                        borderColor: C.line,
                      },
                      tableHead: { backgroundColor: C.cardRaised },
                      tableRow: { backgroundColor: C.card },
                      rule: { backgroundColor: C.line },
                    }}
                  />
                }
              >
                <SpecView
                  source={() => {
                    const current = seg();
                    return current.kind === 'spec' ? current.source : '';
                  }}
                  streaming={() => {
                    const current = seg();
                    return isStreaming() && current.kind === 'spec' && !current.closed;
                  }}
                  sessionId={props.sessionId}
                  openLink={openSpecLink}
                />
              </If>
            )}
          </Each>
        </View>
        <If when={failure()}>
          <Text style={[{ ...readingStyle, color: color() }, { userSelect: 'text' }]}>
            <SourceText row={props.row} sourceId={props.sourceId} />
          </Text>
        </If>
      </If>
    </View>
  );
}
