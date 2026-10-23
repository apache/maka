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

import { errorText, renderText, type UiText } from './text';
import { tr } from './locale';
import { SourceText } from './SourceText';
import { cleanup, computed, effect, signal, Text, View } from 'nsh';
import { markdown } from 'maka/markdown';
import type { MarkdownBlock } from 'maka/markdown';
import { hasCompletePrefix, type Row } from './history';
import { C, bodyTextStyle, secondaryTextStyle } from './ui';
import { MarkdownBlockView } from './MarkdownBlock';

type Input = { messageId: string; field: string; source: string };
type Projection = { input: Input; blocks: MarkdownBlock[] };
const sameInput = (left: Input | null, right: Input | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.messageId === right.messageId &&
    left.field === right.field &&
    left.source === right.source);

export function MarkdownBody(props: {
  row: () => Row;
  sourceId: string;
  sessionId: string;
  compact?: boolean;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
}) {
  const projection = signal<Projection | null>(null);
  const failure = signal<{ input: Input; message: UiText } | null>(null);
  let wanted: Input | null = null;
  let preparing = false;
  let alive = true;
  const input = (): Input | null => {
    const row = props.row();
    return hasCompletePrefix(row)
      ? { messageId: row.messageId, field: row.field, source: row.text }
      : null;
  };
  const compatible = (parsed: Input, current: Input | null) =>
    current !== null &&
    current.messageId === parsed.messageId &&
    current.field === parsed.field &&
    current.source.startsWith(parsed.source);
  async function prepare() {
    if (!alive || preparing || wanted === null) return;
    if (
      sameInput(projection()?.input ?? null, wanted) ||
      sameInput(failure()?.input ?? null, wanted)
    )
      return;
    const captured = wanted;
    preparing = true;
    try {
      const blocks = await markdown.parse(captured.source);
      const current = input();
      if (
        alive &&
        compatible(captured, current) &&
        wanted !== null &&
        compatible(wanted, current)
      ) {
        projection.set({ input: captured, blocks });
        failure.set(null);
      }
    } catch (reason) {
      if (alive && sameInput(captured, wanted)) {
        projection.set(null);
        failure.set({ input: captured, message: errorText(reason) });
      }
    } finally {
      preparing = false;
      void prepare();
    }
  }
  effect(() => {
    const current = input();
    if (sameInput(current, wanted)) return;
    if (wanted === null || !compatible(wanted, current)) {
      projection.set(null);
    }
    wanted = current;
    failure.set(null);
    void prepare();
  });
  cleanup(() => {
    alive = false;
  });
  const blocks = computed(() => {
    const parsed = projection();
    // Only an actual parsed prefix of this exact message is retained while
    // append work catches up. Replacements and incomplete history stay literal.
    return parsed && compatible(parsed.input, input()) ? parsed.blocks : null;
  });
  return (
    <If
      when={blocks()}
      else={
        <View style={{ gap: 0 }}>
          <Text
            selectable
            style={{
              ...(props.compact ? secondaryTextStyle : bodyTextStyle),
              color: props.compact ? C.muted : C.text,
            }}
          >
            <SourceText row={props.row} sourceId={props.sourceId} />
          </Text>
          <If when={failure()}>
            <Text style={{ ...(props.compact ? secondaryTextStyle : {}), color: C.danger }}>
              {tr('Formatting unavailable: {reason}', { reason: renderText(failure()!.message) })}
            </Text>
          </If>
        </View>
      }
    >
      <View style={{ gap: props.compact ? 6 : 16 }}>
        <Each of={blocks() ?? []} key={(block: MarkdownBlock) => block.key}>
          {(block) => (
            <MarkdownBlockView
              block={block}
              sessionId={props.sessionId}
              sourceId={props.sourceId}
              compact={props.compact}
              openLink={props.openLink}
              userScroll={props.userScroll}
            />
          )}
        </Each>
      </View>
    </If>
  );
}
