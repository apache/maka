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

import { safeAreaInsets, signal, Text, View, token } from 'nsh';
import { DiffView, NavPage } from 'nsh/base';
import { tr } from '../../locale';
import { appendQuoteToDraft, extractPatchLineText, type ParsedDiffFile } from '../../state/chat';
import { showToast } from '../../state/hostPool';
import { hapticNotification, hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, Icon, ScreenHeader } from '../../ui';

export function DiffScreen(props: {
  rootId: string;
  sessionId: string;
  file: ParsedDiffFile;
  onBack: () => void;
  onQuotedBackToChat: () => void;
}) {
  const insets = safeAreaInsets();
  const selectedLine = signal<{ side: 'old' | 'new'; line: number; text: string } | null>(null);

  const fileName = () => props.file.path.split('/').pop() || props.file.path;
  const normalizedPatch = () =>
    props.file.patch.endsWith('\n') ? props.file.patch : props.file.patch + '\n';

  const firstChangedLine = (): { side: 'old' | 'new'; line: number; text: string } => {
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)/m.exec(props.file.patch);
    const line = match ? Number(match[1]) : 1;
    return {
      side: 'new',
      line,
      text: extractPatchLineText(props.file.patch, 'new', line),
    };
  };

  const quoteAndReturn = () => {
    const picked = selectedLine() ?? firstChangedLine();
    appendQuoteToDraft(props.rootId, props.sessionId, props.file.path, picked.line, picked.text);
    hapticNotification('success');
    showToast(tr('Quoted {path}:{line}', { path: fileName(), line: picked.line }));
    props.onQuotedBackToChat();
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={fileName()}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      ios={{
        headerRightItems: [
          {
            key: 'quote',
            symbol: 'quote.bubble',
            label: tr('Quote line to chat'),
            onPress: quoteAndReturn,
          },
        ],
      }}
      header={
        <ScreenHeader
          title={fileName()}
          backLabel={tr('Changes')}
          onBack={props.onBack}
          trailing={
            <View
              role="button"
              accessibilityLabel={tr('Quote')}
              onPress={quoteAndReturn}
              style={{ minHeight: 44, paddingHorizontal: 8, justifyContent: 'center' }}
            >
              <Text style={{ ...type.subheadlineMedium, color: token('primary') }}>
                {tr('Quote')}
              </Text>
            </View>
          }
        />
      }
    >
      <View style={{ flex: 1, backgroundColor: token('canvas') }}>
        {/* File Path & Diff Stats Strip */}
        <View
          style={{
            paddingHorizontal: spacing.pageX,
            paddingVertical: 10,
            backgroundColor: token('grouped-bg'),
            borderBottomWidth: spacing.hairline,
            borderBottomColor: token('separator'),
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <Text
            style={{
              ...type.mono,
              fontSize: 12,
              color: token('muted-foreground'),
              flex: 1,
              numberOfLines: 1,
              textOverflow: 'ellipsis-middle',
            }}
          >
            {props.file.path}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <If when={props.file.added > 0}>
              <Text
                style={{
                  ...type.caption,
                  fontWeight: '600',
                  fontVariant: ['tabular-nums'],
                  color: token('diff-add-fg'),
                }}
              >
                {'+' + String(props.file.added)}
              </Text>
            </If>
            <If when={props.file.deleted > 0}>
              <Text
                style={{
                  ...type.caption,
                  fontWeight: '600',
                  fontVariant: ['tabular-nums'],
                  color: token('diff-del-fg'),
                }}
              >
                {'-' + String(props.file.deleted)}
              </Text>
            </If>
          </View>
        </View>

        {/* Single-Column Unified DiffView */}
        <DiffView
          patch={normalizedPatch()}
          layout="unified"
          softWrap
          inline="wordAlt"
          indicators="classic"
          fontSize={12.5}
          lineHeight={20}
          contextLines={3}
          styles={{
            gutter: { backgroundColor: token('grouped-bg') },
            lineAdded: { backgroundColor: token('diff-add-bg') },
            lineDeleted: { backgroundColor: token('diff-del-bg') },
            indicatorAdded: { color: token('diff-add-fg') },
            indicatorDeleted: { color: token('diff-del-fg') },
            separator: { backgroundColor: token('grouped-bg') },
          }}
          onLineNumberPress={({ line }) => {
            hapticSelection();
            const lineNum = line.line + 1;
            const side: 'old' | 'new' = line.side === 'old' ? 'old' : 'new';
            selectedLine.set({
              side,
              line: lineNum,
              text: extractPatchLineText(props.file.patch, side, lineNum),
            });
          }}
          style={{ flex: 1 }}
        />

        {/* Bottom Quote-Line Action Bar */}
        <View
          style={{
            paddingHorizontal: spacing.pageX,
            paddingTop: 10,
            paddingBottom: Math.max(insets().bottom, 14) + 6,
            backgroundColor: token('surface'),
            borderTopWidth: spacing.hairline,
            borderTopColor: token('separator'),
            gap: 8,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="quote" color={token('primary')} size={18} />
            <Text
              style={{
                ...type.footnote,
                color: token('muted-foreground'),
                flex: 1,
                numberOfLines: 1,
                textOverflow: 'ellipsis',
              }}
            >
              {selectedLine()
                ? props.file.path + ':' + String(selectedLine()!.line)
                : tr('Tap any line number to quote a specific line into chat')}
            </Text>
          </View>
          <ActionButton
            title={
              selectedLine()
                ? tr('Quote line {line} to chat', { line: selectedLine()!.line })
                : tr('Quote line to chat')
            }
            icon="quote"
            compact
            onPress={quoteAndReturn}
          />
        </View>
      </View>
    </NavPage>
  );
}
