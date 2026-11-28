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
import { formatCount, tr } from '../../locale';
import {
  appendFileQuote,
  extractPatchLineText,
  getDraft,
  quoteLimit,
  type ParsedDiffFile,
} from '../../state/chat';
import { showToast } from '../../state/hostPool';
import { hapticNotification, hapticSelection } from '../../state/preferences';
import { spacing, type } from '../../theme/tokens';
import { ActionButton, ScreenHeader } from '../../ui';
import { glassSurfaceStyle } from '../../ui/Glass';

export function DiffScreen(props: {
  rootId: string;
  sessionId: string;
  canQuote: boolean;
  file: ParsedDiffFile;
  onBack: () => void;
  onQuotedBackToChat: () => void;
}) {
  const selectedLine = signal<{ side: 'old' | 'new'; line: number; text: string } | null>(null);

  const limitReached = () => getDraft(props.rootId, props.sessionId).quotes.length >= quoteLimit;
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
    if (
      !props.canQuote ||
      !appendFileQuote(props.rootId, props.sessionId, props.file.path, picked.line, picked)
    )
      return;
    hapticNotification('success');
    showToast(tr('Quoted {path}:{line}', { path: fileName(), line: String(picked.line) }));
    props.onQuotedBackToChat();
  };

  return (
    <NavPage
      style={{ flex: 1 }}
      title={fileName()}
      hidesBottomBarWhenPushed
      headerShadowVisible={false}
      headerTransparent
      headerBackgroundOnScroll
      header={<ScreenHeader title={fileName()} backLabel={tr('Changes')} onBack={props.onBack} />}
    >
      <DiffContent />
    </NavPage>
  );

  function DiffContent() {
    const insets = safeAreaInsets();
    const quoteBarHeight = signal(0);
    const bottom = () => insets().bottom + 8;
    return (
      <View style={{ flex: 1, backgroundColor: token('canvas') }}>
        <DiffView
          testID="diff-code"
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
          selectLineOnPress={props.canQuote}
          onLineNumberPress={
            props.canQuote
              ? ({ line }) => {
                  hapticSelection();
                  const lineNum = line.number;
                  const side: 'old' | 'new' = line.side === 'old' ? 'old' : 'new';
                  selectedLine.set({
                    side,
                    line: lineNum,
                    text: extractPatchLineText(props.file.patch, side, lineNum),
                  });
                }
              : undefined
          }
          renderFileHeader={() => (
            <View
              style={{
                paddingHorizontal: 12,
                flex: 1,
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
                    {'+' + formatCount(props.file.added)}
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
                    {'-' + formatCount(props.file.deleted)}
                  </Text>
                </If>
              </View>
            </View>
          )}
          scrollPaddingTop={insets().top}
          scrollPaddingBottom={props.canQuote ? quoteBarHeight() + bottom() + 8 : insets().bottom}
          style={{ flex: 1, marginLeft: insets().left, marginRight: insets().right }}
        />

        <If when={props.canQuote}>
          <View
            style={{
              position: 'absolute',
              left: Math.max(spacing.pageX, insets().left),
              right: Math.max(spacing.pageX, insets().right),
              bottom: bottom(),
              alignItems: 'center',
              pointerEvents: 'box-none',
            }}
          >
            <View
              testID="diff-quote-bar"
              onLayout={({ bounds }) => quoteBarHeight.set(Math.ceil(bounds.size.height))}
              style={{ ...glassSurfaceStyle(spacing.pillRadius), padding: 4, maxWidth: '100%' }}
            >
              <ActionButton
                title={
                  limitReached()
                    ? tr('Quote limit reached ({count})', { count: quoteLimit })
                    : selectedLine()
                      ? tr('Quote line {line} to chat', { line: String(selectedLine()!.line) })
                      : tr('Quote line to chat')
                }
                variant="glassPrimary"
                icon="quote"
                compact
                pill
                minHeight={spacing.rowMinHeight}
                disabled={limitReached()}
                onPress={quoteAndReturn}
              />
            </View>
          </View>
        </If>
      </View>
    );
  }
}
