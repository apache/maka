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
import { SourceChip } from './AnswerSources';
import { citationOffsets, type InlineCitation, type AnswerSource } from './answerCitations';
import { hasTextPrefix, messageBytes, type Row } from './history';
import { CodeBlockAction, codeBlockActions, codeBlockStyles } from './codeBlockLook';
import { MermaidView } from './MermaidView';
import { MarkdownImageView } from './MarkdownImage';
import { SpecView, markdownExtensions } from './SpecView';
import { SourceText } from './SourceText';
import { tr } from './locale';
import { splitSpecMarkdown } from './spec/session.ts';
import { C, bodyTextStyle, isDark, secondaryTextStyle } from './ui';

export function MarkdownBody(props: {
  row: () => Row;
  citations?(): readonly InlineCitation[] | undefined;
  sourceId: string;
  sessionId: string | null;
  compact?: boolean;
  /** Signed-in users can send Markdown code without instantiating a generated view. */
  interactiveBlocks?: boolean;
  /** False when the surrounding message owns text selection. */
  selectable?: boolean;
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
  const interactive = () => props.sessionId !== null && props.interactiveBlocks !== false;
  const segments = computed(() => {
    const text = rawMarkdown();
    return interactive()
      ? splitSpecMarkdown(text)
      : [{ kind: 'markdown' as const, key: 'markdown', text, start: 0 }];
  });
  const markers = computed(() => {
    const citations = props.citations?.();
    if (!citations?.length) return [];
    const row = props.row();
    if (props.text === undefined && !hasTextPrefix(row)) return [];
    return citationOffsets(rawMarkdown(), citations, row.totalBytes);
  });
  // Each TextView parses its own segment. Spec contents belong to SpecView,
  // so citations within that fence follow the generated view.
  const segmentMarkers = computed(() => {
    const result = new Map<string, { name: string; afterByte: number; source: AnswerSource }[]>();
    const positioned = markers();
    if (!positioned.length) return result;
    const text = rawMarkdown();
    let end = 0;
    let bytes = 0;
    let next = 0;
    for (const seg of segments()) {
      const start = seg.kind === 'markdown' ? seg.start : end;
      bytes += messageBytes(text.slice(end, start));
      end = seg.kind === 'markdown' ? start + seg.text.length : seg.end;
      const limit = bytes + messageBytes(text.slice(start, end));
      const here = [];
      while (next < positioned.length && positioned[next]!.byte <= limit) {
        const marker = positioned[next]!;
        here.push({
          name: `source-${here.length}`,
          afterByte: marker.byte - bytes,
          source: marker.source,
        });
        next++;
      }
      if (here.length) result.set(seg.key, here);
      bytes = limit;
    }
    return result;
  });
  const ownerIdentity = () => {
    const r = props.row();
    return `${props.sourceId}\0${r.messageId}\0${r.field}`;
  };

  const readingStyle = props.compact ? secondaryTextStyle : bodyTextStyle;
  const color = () => (props.compact && !props.fullColor ? C.muted : C.text);
  const blockGap = props.compact ? 6 : 16;

  return (
    <View selectable={props.selectable ?? true}>
      <If
        when={props.text !== undefined || hasTextPrefix(props.row())}
        else={
          <Text style={{ ...readingStyle, color: color() }}>
            <SourceText row={props.row} sourceId={props.sourceId} />
          </Text>
        }
      >
        <View style={{ width: '100%', gap: blockGap }}>
          <Each
            of={segments()}
            key={(seg) => (seg.kind === 'spec' ? `${ownerIdentity()}\0${seg.key}` : seg.key)}
          >
            {(seg) => {
              const atSegment = () => segmentMarkers().get(seg().key);
              const extensions = () => {
                const base = interactive() ? markdownExtensions : [];
                const inline = atSegment();
                return inline
                  ? [...base, ...inline.map(({ name, afterByte }) => ({ name, afterByte }))]
                  : base;
              };
              return (
                <If
                  when={seg().kind === 'spec'}
                  else={
                    <TextView
                      markdown={(() => {
                        const s = seg();
                        return s.kind === 'markdown' ? s.text : '';
                      })()}
                      extensions={extensions()}
                      renderCustom={(node) => {
                        const marker = node.name.startsWith('source-')
                          ? atSegment()?.[Number(node.name.slice(7))]
                          : undefined;
                        if (marker)
                          return (
                            <SourceChip source={() => marker.source} openLink={openSpecLink} />
                          );
                        return node.name === 'spec' ? (
                          <SpecView
                            source={() => node.text ?? ''}
                            streaming={isStreaming}
                            sessionId={props.sessionId!}
                            openLink={openSpecLink}
                          />
                        ) : (
                          <MermaidView source={() => node.text ?? ''} />
                        );
                      }}
                      sourceId={(() => {
                        const s = seg();
                        return s.kind === 'markdown' && s.start === 0 ? props.sourceId : undefined;
                      })()}
                      contentStyle={{ rowGap: blockGap }}
                      options={{
                        streaming: interactive(),
                        preserveLineBreaks: true,
                      }}
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
                      renderImage={(context) =>
                        props.sessionId === null ? (
                          <Text>{context.image.alt || context.image.src}</Text>
                        ) : (
                          <MarkdownImageView
                            image={() => context.image}
                            sessionId={props.sessionId}
                            linked={context.linked}
                            flow={context.flow}
                            lineHeight={context.lineHeight}
                          />
                        )
                      }
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
                        // A reply's sections step down from 20 to the body's size.
                        heading1: { fontSize: props.compact ? secondaryTextStyle.fontSize : 20 },
                        heading2: { fontSize: props.compact ? secondaryTextStyle.fontSize : 18 },
                        heading3: { fontSize: props.compact ? secondaryTextStyle.fontSize : 16 },
                        heading4: { fontSize: props.compact ? secondaryTextStyle.fontSize : 14 },
                        heading5: { fontSize: props.compact ? secondaryTextStyle.fontSize : 14 },
                        heading6: { fontSize: props.compact ? secondaryTextStyle.fontSize : 14 },
                        blockquote: { borderLeftColor: C.line, color: C.secondary },
                        link: { color: C.accent },
                        code: { color: color(), backgroundColor: C.card, borderRadius: 4 },
                        ...codeBlockStyles(color(), props.compact ? 8 : 12),
                        // On the desktop a table is framed as a code block is and ruled only
                        // between rows: each body cell draws the line above it and the header
                        // none, so no rule meets the frame. A light table's rules sit a step
                        // under the frame. Its text starts where a code block's starts.
                        ...(platform.idiom === 'terminal'
                          ? {}
                          : {
                              tableGrid: {
                                borderWidth: 1,
                                borderColor: C.line,
                                borderRadius: props.compact ? 8 : 12,
                              },
                            }),
                        tableCell: {
                          ...readingStyle,
                          ...(platform.idiom === 'terminal' ? {} : tableRule(1)),
                          color: color(),
                        },
                        tableHeaderCell: {
                          ...readingStyle,
                          ...(platform.idiom === 'terminal' ? {} : tableRule(0)),
                          color: color(),
                          fontWeight: '600',
                        },
                        // Rows lie on the panel; only the header is tinted, so inline code in a
                        // cell keeps its own fill. Its top corners follow the frame's.
                        tableHead: {
                          backgroundColor: C.card,
                          ...(platform.idiom === 'terminal'
                            ? {}
                            : {
                                borderTopLeftRadius: props.compact ? 7 : 11,
                                borderTopRightRadius: props.compact ? 7 : 11,
                              }),
                        },
                        rule: { backgroundColor: C.line },
                      }}
                    />
                  }
                >
                  <View>
                    <SpecView
                      source={() => {
                        const current = seg();
                        return current.kind === 'spec' ? current.source : '';
                      }}
                      streaming={() => {
                        const current = seg();
                        return isStreaming() && current.kind === 'spec' && !current.closed;
                      }}
                      sessionId={props.sessionId!}
                      openLink={openSpecLink}
                    />
                    <Each of={atSegment() ?? []} key={(marker) => marker.name}>
                      {(marker) => (
                        <SourceChip source={() => marker().source} openLink={openSpecLink} />
                      )}
                    </Each>
                  </View>
                </If>
              );
            }}
          </Each>
        </View>
        <If when={failure()}>
          <Text style={{ ...readingStyle, color: color() }}>
            <SourceText row={props.row} sourceId={props.sourceId} />
          </Text>
        </If>
      </If>
    </View>
  );
}

/** A desktop table cell's lines: a rule `top` wide above it, none beside or below. */
const tableRule = (top: number) => ({
  paddingHorizontal: 16,
  borderTopWidth: top,
  borderRightWidth: 0,
  borderBottomWidth: 0,
  borderColor: isDark() ? C.line : C.raised,
});
