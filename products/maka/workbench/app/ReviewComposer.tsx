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

import { inputAction, List, platform, Scroll, signal, Text, View, type InputRef } from 'nsh';
import { Button, Input } from 'nsh/base';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  type CodeLocation,
  formatReviewBatch,
  formatReviewNote,
  type ReviewNote,
  type ReviewStore,
  type SymbolLocationBatch,
} from './reviewState';
import {
  bodyTextStyle,
  C,
  captionTextStyle,
  codeTextStyle,
  controlDisabledStyle,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  quietActiveStyle,
  quietFocusStyle,
  quietHoverStyle,
  textTooltip,
} from './ui';

export function lineRangeText(startLine: number, endLine: number): string {
  return startLine === endLine
    ? tr('Line {line}', { line: startLine + 1 })
    : tr('Lines {start}–{end}', { start: startLine + 1, end: endLine + 1 });
}

export function AddLineNoteButton(props: { onPress(): void }) {
  return (
    <Button
      accessibilityLabel={tr('Add review note')}
      tooltip={textTooltip(() => tr('Add review note'))}
      onPress={props.onPress}
      style={{
        width: 20,
        height: 20,
        borderRadius: 4,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: C.accent,
      }}
      hoverStyle={{ opacity: 0.9 }}
      focusStyle={controlFocusStyle()}
    >
      <Icon name="plus" size={12} color={C.chrome} />
    </Button>
  );
}

export function InlineReviewComposer(props: {
  startLine: number;
  endLine: number;
  initialComment?: string;
  canPrompt: boolean;
  onSave(comment: string): void;
  onInsertPrompt(comment: string): void;
  onSendNow(comment: string): void;
  onCancel(): void;
}) {
  const draft = signal(props.initialComment ?? '');
  const valid = () => draft().trim().length > 0;
  let focusedOnce = false;

  return (
    <View
      style={{
        marginVertical: 4,
        marginHorizontal: 8,
        padding: 8,
        gap: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: C.line,
        backgroundColor: C.panel,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="conversation" size={14} color={C.accent} />
        <Text style={{ ...captionTextStyle, flex: 1, color: C.secondary, fontWeight: '500' }}>
          {lineRangeText(props.startLine, props.endLine)}
        </Text>
        <Button
          accessibilityLabel={tr('Cancel')}
          onPress={props.onCancel}
          style={{
            ...controlStyle,
            width: 24,
            minHeight: 24,
            paddingHorizontal: 4,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="close" size={14} color={C.muted} />
        </Button>
      </View>
      <Input
        ref={(node: InputRef | null) => {
          if (node && !focusedOnce) {
            focusedOnce = true;
            node.focus();
          }
        }}
        multiline
        value={draft()}
        onChange={({ value }) => draft.set(value)}
        onSubmit={() => {
          if (!valid()) return;
          if (props.canPrompt) props.onSendNow(draft());
          else props.onSave(draft());
        }}
        submitBehavior="newline"
        placeholder={tr('Add a review note or prompt…')}
        accessibilityLabel={tr('Add review note')}
        style={{
          ...bodyTextStyle,
          minHeight: 56,
          maxHeight: 140,
          paddingHorizontal: 8,
          paddingVertical: 6,
          borderRadius: 6,
          borderWidth: 1,
          borderColor: C.line,
          backgroundColor: C.card,
          color: C.text,
        }}
      />
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 4,
          flexWrap: 'wrap',
        }}
      >
        <Button
          accessibilityLabel={tr('Save note')}
          disabled={!valid()}
          onPress={() => {
            if (valid()) props.onSave(draft());
          }}
          style={{
            ...controlStyle,
            minHeight: 28,
            height: 28,
            paddingHorizontal: 8,
            backgroundColor: C.card,
          }}
          hoverStyle={controlHoverStyle()}
          focusStyle={controlFocusStyle()}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Save note')}</Text>
        </Button>
        <If when={props.canPrompt}>
          <Button
            accessibilityLabel={tr('Add to prompt')}
            disabled={!valid()}
            onPress={() => {
              if (valid()) props.onInsertPrompt(draft());
            }}
            style={{
              ...controlStyle,
              minHeight: 28,
              height: 28,
              paddingHorizontal: 8,
              backgroundColor: C.card,
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Add to prompt')}</Text>
          </Button>
          <Button
            accessibilityLabel={tr('Send now')}
            disabled={!valid()}
            onPress={() => {
              if (valid()) props.onSendNow(draft());
            }}
            style={{
              ...controlStyle,
              minHeight: 28,
              height: 28,
              paddingHorizontal: 10,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              backgroundColor: C.accent,
            }}
            hoverStyle={{ opacity: 0.9 }}
            focusStyle={controlFocusStyle()}
            disabledStyle={controlDisabledStyle}
          >
            <Icon name="send" size={12} color={C.chrome} />
            <Text style={{ ...captionTextStyle, color: C.chrome, fontWeight: '500' }}>
              {tr('Send now')}
            </Text>
          </Button>
        </If>
      </View>
    </View>
  );
}

export function InlineReviewNoteCard(props: {
  note: ReviewNote;
  canPrompt: boolean;
  onEdit(): void;
  onRemove(): void;
  onSendNow(): void;
}) {
  return (
    <View
      style={{
        marginVertical: 4,
        marginHorizontal: 8,
        padding: 8,
        gap: 4,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: C.line,
        backgroundColor: C.panel,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="note" size={14} color={C.accent} />
        <Text style={{ ...captionTextStyle, flex: 1, color: C.secondary, fontWeight: '500' }}>
          {lineRangeText(props.note.startLine, props.note.endLine)}
        </Text>
        <If when={props.canPrompt}>
          <Button
            accessibilityLabel={tr('Send now')}
            tooltip={textTooltip(() => tr('Send now'))}
            onPress={props.onSendNow}
            style={{
              ...controlStyle,
              minHeight: 24,
              height: 24,
              paddingHorizontal: 6,
              alignItems: 'center',
            }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name="send" size={12} color={C.accent} />
          </Button>
        </If>
        <Button
          accessibilityLabel={tr('Edit note')}
          tooltip={textTooltip(() => tr('Edit note'))}
          onPress={props.onEdit}
          style={{
            ...controlStyle,
            minHeight: 24,
            height: 24,
            paddingHorizontal: 6,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="edit" size={12} color={C.secondary} />
        </Button>
        <Button
          accessibilityLabel={tr('Remove note')}
          tooltip={textTooltip(() => tr('Remove note'))}
          onPress={props.onRemove}
          style={{
            ...controlStyle,
            minHeight: 24,
            height: 24,
            paddingHorizontal: 6,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="trash" size={12} color={C.muted} />
        </Button>
      </View>
      <Text style={[{ ...bodyTextStyle, color: C.text }, { userSelect: 'text' }]}>
        {props.note.comment}
      </Text>
    </View>
  );
}

export function ReviewBatchBar(props: {
  sessionId: string;
  store: ReviewStore;
  canPrompt: boolean;
  onJumpToNote(note: ReviewNote): void;
  onDeliver(text: string, mode: 'insert' | 'send'): boolean;
}) {
  const expanded = signal(false);
  const notes = () => props.store.notes(props.sessionId);

  const deliverAll = (mode: 'insert' | 'send') => {
    const list = notes();
    if (list.length === 0) return;
    const formatted = formatReviewBatch(list);
    if (props.onDeliver(formatted, mode)) {
      props.store.clearNotes(props.sessionId);
      expanded.set(false);
    }
  };

  return (
    <If when={notes().length > 0}>
      <View
        style={{
          borderRadius: 8,
          borderWidth: 1,
          borderColor: C.line,
          backgroundColor: C.card,
          padding: 8,
          gap: 8,
          flexShrink: 0,
        }}
      >
        <If when={expanded()}>
          <Scroll style={{ maxHeight: 160 }}>
            <View style={{ gap: 4 }}>
              <Each of={notes()} key={(note) => note.id}>
                {(note) => (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      paddingHorizontal: 6,
                      paddingVertical: 4,
                      borderRadius: 6,
                      backgroundColor: C.panel,
                    }}
                  >
                    <Button
                      onPress={inputAction(props.onJumpToNote, note())}
                      style={{ flex: 1, minWidth: 0, alignItems: 'flex-start' }}
                      hoverStyle={quietHoverStyle()}
                      focusStyle={quietFocusStyle()}
                    >
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.secondary, fontWeight: '500' },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {note().pathLabel} · {lineRangeText(note().startLine, note().endLine)}
                      </Text>
                      <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}>
                        {note().comment}
                      </Text>
                    </Button>
                    <Button
                      accessibilityLabel={tr('Remove note')}
                      onPress={() => props.store.removeNote(props.sessionId, note().id)}
                      style={{
                        ...controlStyle,
                        width: 24,
                        minHeight: 24,
                        paddingHorizontal: 4,
                        alignItems: 'center',
                      }}
                      hoverStyle={quietHoverStyle()}
                      focusStyle={quietFocusStyle()}
                    >
                      <Icon name="close" size={12} color={C.muted} />
                    </Button>
                  </View>
                )}
              </Each>
            </View>
          </Scroll>
        </If>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Button
            onPress={() => expanded.set(!expanded())}
            style={{
              ...controlStyle,
              minHeight: 28,
              height: 28,
              paddingHorizontal: 8,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
            hoverStyle={quietHoverStyle()}
            activeStyle={quietActiveStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Icon name={expanded() ? 'down' : 'up'} size={14} color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.text, fontWeight: '500' }}>
              {notes().length === 1
                ? tr('1 review note')
                : tr('{count} review notes', { count: notes().length })}
            </Text>
          </Button>
          <View style={{ flex: 1 }} />
          <Button
            accessibilityLabel={tr('Clear notes')}
            onPress={() => {
              props.store.clearNotes(props.sessionId);
              expanded.set(false);
            }}
            style={{ ...controlStyle, minHeight: 28, height: 28, paddingHorizontal: 8 }}
            hoverStyle={quietHoverStyle()}
            focusStyle={quietFocusStyle()}
          >
            <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Clear notes')}</Text>
          </Button>
          <If when={props.canPrompt}>
            <Button
              accessibilityLabel={tr('Add to prompt')}
              onPress={() => deliverAll('insert')}
              style={{
                ...controlStyle,
                minHeight: 28,
                height: 28,
                paddingHorizontal: 8,
                backgroundColor: C.cardRaised,
              }}
              hoverStyle={controlHoverStyle()}
              focusStyle={controlFocusStyle()}
            >
              <Text style={{ ...captionTextStyle, color: C.text }}>{tr('Add to prompt')}</Text>
            </Button>
            <Button
              accessibilityLabel={tr('Send review')}
              onPress={() => deliverAll('send')}
              style={{
                ...controlStyle,
                minHeight: 28,
                height: 28,
                paddingHorizontal: 10,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 4,
                backgroundColor: C.accent,
              }}
              hoverStyle={{ opacity: 0.9 }}
              focusStyle={controlFocusStyle()}
            >
              <Icon name="send" size={12} color={C.chrome} />
              <Text style={{ ...captionTextStyle, color: C.chrome, fontWeight: '500' }}>
                {tr('Send review')}
              </Text>
            </Button>
          </If>
        </View>
      </View>
    </If>
  );
}

export function SymbolLocationsDrawer(props: {
  batch: SymbolLocationBatch;
  pathLabel(loc: CodeLocation): string;
  onSelect(loc: CodeLocation, index: number): void;
  onClose(): void;
}) {
  const title = () =>
    props.batch.kind === 'definitions'
      ? tr('Definitions · {symbol} ({count})', {
          symbol: props.batch.symbol,
          count: props.batch.locations.length,
        })
      : tr('References · {symbol} ({count})', {
          symbol: props.batch.symbol,
          count: props.batch.locations.length,
        });
  const backendLabel = () =>
    props.batch.backend.kind === 'lsp' ? props.batch.backend.server : tr('Indexed fallback');

  return (
    <View
      style={{
        height: platform.idiom === 'terminal' ? 10 : 196,
        minHeight: 120,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: C.line,
        backgroundColor: C.card,
        padding: 8,
        gap: 6,
        flexShrink: 0,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="symbol" size={14} color={C.accent} />
        <Text
          style={[
            { ...captionTextStyle, flex: 1, color: C.text, fontWeight: '500' },
            { numberOfLines: 1 },
          ]}
        >
          {title()}
        </Text>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{backendLabel()}</Text>
        <Button
          accessibilityLabel={tr('Close symbol results')}
          tooltip={textTooltip(() => tr('Close symbol results'))}
          onPress={props.onClose}
          style={{
            ...controlStyle,
            width: 24,
            minHeight: 24,
            paddingHorizontal: 4,
            alignItems: 'center',
          }}
          hoverStyle={quietHoverStyle()}
          focusStyle={quietFocusStyle()}
        >
          <Icon name="close" size={14} color={C.muted} />
        </Button>
      </View>
      <If when={props.batch.truncated}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Showing first {count} matches', { count: props.batch.locations.length })}
        </Text>
      </If>
      <List
        each={props.batch.locations}
        keyExtractor={(loc: CodeLocation, index: number) =>
          `${loc.path.bytesBase64}:${loc.range.start.line}:${loc.range.start.column}:${index}`
        }
        estimatedItemSize={36}
        style={{ flex: 1, minHeight: 0 }}
      >
        {(loc, index) => (
          <Button
            selected={props.batch.activeIndex === index()}
            onPress={() => props.onSelect(loc(), index())}
            style={{
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
              gap: 2,
              backgroundColor: props.batch.activeIndex === index() ? C.cardRaised : 'transparent',
            }}
            hoverStyle={controlHoverStyle()}
            focusStyle={controlFocusStyle()}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text
                style={[
                  { ...captionTextStyle, color: C.secondary, fontWeight: '500', flexShrink: 1 },
                  { numberOfLines: 1 },
                ]}
              >
                {props.pathLabel(loc())}:{loc().range.start.line + 1}
              </Text>
            </View>
            <If when={loc().preview.length > 0}>
              <Text
                style={[{ ...codeTextStyle, fontSize: 12, color: C.muted }, { numberOfLines: 1 }]}
              >
                {loc().preview}
              </Text>
            </If>
          </Button>
        )}
      </List>
    </View>
  );
}

export { formatReviewNote };
