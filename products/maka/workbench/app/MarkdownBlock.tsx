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

import { tr } from './locale';
import { cleanup, computed, inputAction, Scroll, signal, Text, View } from 'nsh';
import type { YNode } from 'nsh';
import { Button } from 'nsh/base';
import { Clipboard } from 'nsh/clipboard';
import { platform, windowSize } from 'nsh/device';
import type { MarkdownBlock, MarkdownRun, MarkdownTable } from 'maka/markdown';
import {
  C,
  bodyTextStyle,
  secondaryTextStyle,
  captionTextStyle,
  codeTextStyle,
  controlStyle,
} from './ui';
import { Icon } from './Icon';
import { MarkdownImageView } from './MarkdownImage';

export function MarkdownBlockView(props: {
  block: () => MarkdownBlock;
  sourceId: string;
  sessionId: string;
  compact?: boolean;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
}) {
  const block = props.block;
  const container = () =>
    block().kind === 'code' || block().marker !== '' || block().quote > 0 || block().indent > 0;
  const inset = () =>
    Math.min((block().indent + Math.max(0, block().quote - 1)) * 16, windowSize().width / 4);
  return (
    <If
      when={container()}
      else={
        <MarkdownBlockContent
          block={block}
          sourceId={props.sourceId}
          sessionId={props.sessionId}
          compact={props.compact}
          openLink={props.openLink}
          userScroll={props.userScroll}
        />
      }
    >
      <View
        style={{
          flexDirection: 'row',
          gap: 8,
          paddingLeft: inset(),
          borderLeftWidth: block().quote > 0 ? 2 : 0,
          borderLeftColor: C.line,
        }}
      >
        <If when={block().marker}>
          <Text
            style={{ ...(props.compact ? secondaryTextStyle : {}), color: C.muted, flexShrink: 0 }}
          >
            {block().marker}
          </Text>
        </If>
        <View style={{ flex: 1, minWidth: 0 }}>
          <MarkdownBlockContent
            block={block}
            sourceId={props.sourceId}
            sessionId={props.sessionId}
            compact={props.compact}
            openLink={props.openLink}
            userScroll={props.userScroll}
          />
        </View>
      </View>
    </If>
  );
}

function StyledRuns(props: {
  runs(): MarkdownRun[];
  sourceId: string;
  sessionId: string;
  width?(): number;
  compact?: boolean;
  linked?: boolean;
}) {
  return (
    <Each of={props.runs()} key={(run) => JSON.stringify([run.key, run.image?.target])}>
      {(run) => (
        <Text
          textSource={{ id: props.sourceId, segments: run().source }}
          style={{
            fontWeight: run().strong ? '700' : undefined,
            fontStyle: run().emphasis ? 'italic' : undefined,
            textDecorationLine: run().strike ? 'line-through' : undefined,
            fontFamily: props.compact && run().code ? 'monospace' : undefined,
            color: run().code ? (props.compact ? C.muted : C.accentHover) : undefined,
            backgroundColor: run().code ? C.surface : undefined,
          }}
        >
          <If when={run().image} else={<>{run().text}</>}>
            <MarkdownImageView
              image={() => run().image!}
              sessionId={props.sessionId}
              width={props.width}
              linked={props.linked ?? false}
            />
          </If>
        </Text>
      )}
    </Each>
  );
}

function InlineRuns(props: {
  runs(): MarkdownRun[];
  sourceId: string;
  sessionId: string;
  width?(): number;
  compact?: boolean;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
}) {
  const groups = computed(() => {
    const result: { key: string; link: MarkdownRun['link']; runs: MarkdownRun[] }[] = [];
    for (const run of props.runs()) {
      const previous = result[result.length - 1];
      if (previous && previous.link?.key === run.link?.key) previous.runs.push(run);
      else result.push({ key: run.key, link: run.link, runs: [run] });
    }
    return result;
  });
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  return (
    <Each of={groups()} key={(group) => group.key}>
      {(group) => {
        let node: YNode | undefined;
        let mounted = true;
        cleanup(() => {
          mounted = false;
        });
        const activate = async (request: { key: string; target: string }) => {
          const owns = () =>
            alive &&
            mounted &&
            groups().some(
              (current) => current.key === request.key && current.link?.target === request.target,
            );
          if (owns())
            await props.openLink(request.target, () => {
              if (!owns() || !node) return false;
              node.focus();
              return true;
            });
        };
        return (
          <If
            when={group().link}
            else={
              <StyledRuns
                runs={() => group().runs}
                sourceId={props.sourceId}
                sessionId={props.sessionId}
                width={props.width}
                compact={props.compact}
              />
            }
          >
            <Text
              ref={(value) => {
                node = value;
              }}
              role="link"
              accessibilityLabel={group()
                .runs.map((run) => (run.image ? run.image.alt || run.image.target : run.text))
                .join('')}
              focusable
              onPress={inputAction(activate, { key: group().key, target: group().link!.target })}
              style={{ color: C.accentHover, textDecorationLine: 'underline' }}
            >
              <StyledRuns
                runs={() => group().runs}
                sourceId={props.sourceId}
                sessionId={props.sessionId}
                width={props.width}
                compact={props.compact}
                linked
              />
            </Text>
          </If>
        );
      }}
    </Each>
  );
}

function MarkdownBlockContent(props: {
  block: () => MarkdownBlock;
  sourceId: string;
  sessionId: string;
  compact?: boolean;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
}) {
  const block = props.block;
  const width = signal(0);
  return (
    <If
      when={block().kind === 'table'}
      else={
        <If
          when={block().kind === 'code'}
          else={
            <If
              when={block().kind === 'paragraph' || block().kind === 'heading'}
              else={
                <If
                  when={block().kind === 'rule'}
                  else={
                    <Text
                      selectable
                      textSource={{ id: props.sourceId, segments: block().source }}
                      style={{
                        ...(props.compact ? secondaryTextStyle : {}),
                        color: props.compact ? C.muted : C.text,
                      }}
                    >
                      {block().text}
                    </Text>
                  }
                >
                  <If
                    when={platform.isTerminal}
                    else={<View style={{ height: 1, backgroundColor: C.line }} />}
                  >
                    <Text style={{ ...(props.compact ? secondaryTextStyle : {}), color: C.muted }}>
                      ───
                    </Text>
                  </If>
                </If>
              }
            >
              <Text
                onLayout={(frame) => width.set(frame.size.width)}
                selectable
                style={{
                  ...(props.compact ? secondaryTextStyle : bodyTextStyle),
                  color: props.compact ? C.muted : block().quote > 0 ? C.secondary : C.text,
                  fontSize: props.compact
                    ? secondaryTextStyle.fontSize
                    : block().kind === 'heading'
                      ? 18
                      : 14,
                  fontWeight: block().kind === 'heading' ? (props.compact ? '600' : '700') : '400',
                }}
              >
                <InlineRuns
                  runs={() => block().runs}
                  sourceId={props.sourceId}
                  sessionId={props.sessionId}
                  width={width}
                  compact={props.compact}
                  openLink={props.openLink}
                />
              </Text>
            </If>
          }
        >
          <CodeBlock
            block={block}
            sourceId={props.sourceId}
            compact={props.compact}
            userScroll={props.userScroll}
          />
        </If>
      }
    >
      <TableBlock
        table={() => block().table!}
        sourceId={props.sourceId}
        sessionId={props.sessionId}
        compact={props.compact}
        openLink={props.openLink}
        userScroll={props.userScroll}
      />
    </If>
  );
}

function TableBlock(props: {
  table(): MarkdownTable;
  sourceId: string;
  sessionId: string;
  compact?: boolean;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
}) {
  const cells = computed(() => {
    const table = props.table();
    return table.rows.flatMap((row, rowIndex) =>
      table.columns.map((align, column) => ({
        key: row.cells[column]?.key ?? `${row.key}:empty:${column}`,
        runs: row.cells[column]?.runs ?? [],
        align,
        row: rowIndex,
        last: rowIndex === table.rows.length - 1,
      })),
    );
  });
  return (
    <Scroll
      horizontal
      onScrollIntent={props.userScroll}
      accessibilityLabel={tr('Markdown table')}
      style={{ flexGrow: 0 }}
    >
      <View
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${props.table().columns.length}, max-content)`,
          alignSelf: 'flex-start',
          borderWidth: platform.isTerminal ? 0 : 1,
          borderColor: C.line,
          borderRadius: platform.isTerminal ? 0 : 8,
          overflow: 'hidden',
        }}
      >
        <Each of={cells()} key={(cell) => cell.key}>
          {(cell) => (
            <View
              style={{
                paddingHorizontal: props.compact || platform.isTerminal ? 8 : 12,
                paddingVertical: props.compact ? 4 : 8,
                minHeight:
                  (props.compact ? secondaryTextStyle.lineHeight : bodyTextStyle.lineHeight) +
                  (props.compact ? 8 : 16),
                borderBottomWidth: platform.isTerminal || cell().last ? 0 : 1,
                borderBottomColor: C.line,
                backgroundColor:
                  cell().row === 0 ? C.raised : cell().row % 2 ? C.surface : C.background,
              }}
            >
              <Text
                selectable
                style={{
                  ...(props.compact ? secondaryTextStyle : bodyTextStyle),
                  color: props.compact ? C.muted : C.text,
                  fontWeight: cell().row === 0 ? '600' : '400',
                  textAlign: cell().align,
                }}
              >
                <InlineRuns
                  runs={() => cell().runs}
                  sourceId={props.sourceId}
                  sessionId={props.sessionId}
                  compact={props.compact}
                  openLink={props.openLink}
                />
              </Text>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}

type CopyState =
  | { kind: 'idle' }
  | { kind: 'copying' | 'copied'; text: string }
  | { kind: 'failed'; text: string; message: string };

function CodeBlock(props: {
  block: () => MarkdownBlock;
  sourceId: string;
  compact?: boolean;
  userScroll(): void;
}) {
  const block = props.block;
  const key = computed(() => block().key);
  const text = computed(() => block().text);
  const wrapped = signal(true);
  const state = signal<CopyState>({ kind: 'idle' });
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const toggleWrapped = (request: { key: string; wrapped: boolean }) => {
    if (alive && key() === request.key && wrapped() === request.wrapped)
      wrapped.set(!request.wrapped);
  };
  const action = computed(() => {
    const originalKey = key();
    const originalText = text();
    const owns = () => alive && key() === originalKey && text() === originalText;
    // Handler identity retains this exact rendered version without serializing
    // the code into the action's JSON arguments. Unchanged code keeps its handler.
    return inputAction(async () => {
      if (!owns() || state().kind === 'copying') return;
      state.set({ kind: 'copying', text: originalText });
      try {
        await Clipboard.writeText(originalText);
        if (alive) state.set(owns() ? { kind: 'copied', text: originalText } : { kind: 'idle' });
      } catch (reason) {
        if (alive)
          state.set(
            owns()
              ? {
                  kind: 'failed',
                  text: originalText,
                  message: reason instanceof Error ? reason.message : String(reason),
                }
              : { kind: 'idle' },
          );
      }
    }, null);
  });
  const copied = () => {
    const current = state();
    return current.kind === 'copied' && current.text === text();
  };
  const failure = () => {
    const current = state();
    return current.kind === 'failed' && current.text === text() ? current.message : '';
  };
  return (
    <View
      style={{
        backgroundColor: C.surface,
        borderRadius: props.compact ? 8 : 12,
        padding: props.compact ? 8 : 16,
        gap: props.compact ? 4 : 8,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', minHeight: 32, gap: 8 }}>
        <Text style={{ ...captionTextStyle, color: C.muted, flex: 1 }}>
          {block().language || 'code'}
        </Text>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{copied() ? tr('Copied') : ''}</Text>
        <Button
          accessibilityLabel={tr('Wrap code')}
          selected={wrapped()}
          tooltip={wrapped() ? tr('Show original columns') : tr('Wrap long lines')}
          onPress={inputAction(toggleWrapped, { key: key(), wrapped: wrapped() })}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name={wrapped() ? 'nowrap' : 'wrap'} color={C.secondary} />
        </Button>
        <Button
          accessibilityLabel={tr('Copy code block')}
          tooltip={copied() ? tr('Code copied') : tr('Copy code block')}
          onPress={action()}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.raised }}
        >
          <Icon name={copied() ? 'check' : 'copy'} color={C.secondary} />
        </Button>
      </View>
      <Scroll horizontal={!wrapped()} scrollable={!wrapped()} onScrollIntent={props.userScroll}>
        <Text
          selectable
          textSource={{ id: props.sourceId, segments: block().source }}
          style={{
            ...codeTextStyle,
            width: wrapped() ? '100%' : undefined,
            minWidth: 0,
            color: props.compact ? C.muted : C.text,
          }}
        >
          {block().text}
        </Text>
      </Scroll>
      <If when={failure()}>
        <Text selectable style={{ ...captionTextStyle, color: C.danger }}>
          {failure()}
        </Text>
      </If>
    </View>
  );
}
