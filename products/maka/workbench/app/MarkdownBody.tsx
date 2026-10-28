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

import { cleanup, platform, signal, Text, View } from 'nsh';
import { TextView } from 'nsh/base';
import { hasCompletePrefix, type Row } from './history';
import { MarkdownImageView } from './MarkdownImage';
import { SourceText } from './SourceText';
import { tr } from './locale';
import { C, bodyTextStyle, codeTextStyle, secondaryTextStyle } from './ui';

export function MarkdownBody(props: {
  row: () => Row;
  sourceId: string;
  sessionId: string;
  compact?: boolean;
  openLink(target: string, restoreFocus: () => boolean): Promise<void>;
  userScroll(): void;
}) {
  const failure = signal<string | null>(null);
  let alive = true;
  cleanup(() => {
    alive = false;
  });
  const readingStyle = props.compact ? secondaryTextStyle : bodyTextStyle;
  const color = () => (props.compact ? C.muted : C.text);
  return (
    <View selectable>
      <If
        when={hasCompletePrefix(props.row())}
        else={
          <Text style={[{ ...readingStyle, color: color() }, { userSelect: 'text' }]}>
            <SourceText row={props.row} sourceId={props.sourceId} />
          </Text>
        }
      >
        <TextView
          markdown={props.row().text}
          sourceId={props.sourceId}
          selectable
          contentStyle={{ rowGap: props.compact ? 6 : 16 }}
          options={{ streaming: true, preserveLineBreaks: true }}
          labels={{ table: tr('Markdown table'), copied: tr('Copied') }}
          onScrollIntent={props.userScroll}
          onParseError={({ reason }) => failure.set(reason)}
          onLinkPress={(event) => {
            const row = props.row();
            const sourceId = props.sourceId;
            const target = event.target;
            const owns = () => {
              const current = props.row();
              return (
                alive &&
                props.sourceId === sourceId &&
                current.messageId === row.messageId &&
                current.field === row.field &&
                hasCompletePrefix(current) &&
                current.text.startsWith(row.text)
              );
            };
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
          renderCodeBlockAction={(action) => (
            <Text style={[{ ...secondaryTextStyle, color: C.muted }, { userSelect: 'none' }]}>
              {action.id === 'wrap' ? tr('Wrap code') : (action.label ?? action.id)}
            </Text>
          )}
          codeBlockActions={[
            { id: 'wrap', label: tr('Wrap code') },
            { id: 'copy', label: tr('Copy code block') },
          ]}
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
            code: { color: props.compact ? C.muted : C.accentHover, backgroundColor: C.surface },
            codeBlock: {
              backgroundColor: C.surface,
              borderColor: C.line,
              borderRadius: props.compact ? 8 : 12,
            },
            codeBlockCode: { ...codeTextStyle, color: color() },
            // The desktop starts the actions where the code starts.
            codeBlockHeader: platform.isTerminal
              ? { color: C.muted }
              : { color: C.muted, paddingHorizontal: 12, paddingTop: 8 },
            tableCell: { ...readingStyle, color: color(), borderColor: C.line },
            tableHeaderCell: {
              ...readingStyle,
              color: color(),
              fontWeight: '600',
              borderColor: C.line,
            },
            tableHead: { backgroundColor: C.raised },
            tableRow: { backgroundColor: C.surface },
            rule: { backgroundColor: C.line },
          }}
        />
        <If when={failure()}>
          <Text style={[{ ...secondaryTextStyle, color: C.danger }, { userSelect: 'none' }]}>
            {tr('Formatting unavailable: {reason}', { reason: failure()! })}
          </Text>
        </If>
      </If>
    </View>
  );
}
