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

import { batch, cleanup, computed, Input, inputAction, List, signal, Text, View } from 'nsh';
import type { YNode } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { keymap } from 'nsh/keymap';
import { windowSize } from 'nsh/device';
import type {
  AgentRecallPage,
  AgentRecallPassage,
  AgentSession,
  HistoryRowPosition,
  RecallQuery,
} from '../../../../packages/plugin-sdk/src/index.js';
import { host } from './host';
import { tr } from './locale';
import { createText, errorText, renderText, UiError, type UiText } from './text';
import { Icon } from './Icon';
import {
  C,
  bodyTextStyle,
  captionTextStyle,
  compact,
  controlFocusStyle,
  controlHoverStyle,
  controlStyle,
  inputBorderRadius,
} from './ui';

export type RecallTarget = {
  sessionId: string;
  anchor?: { messageId: string; position: HistoryRowPosition };
};
type Request = {
  id: number;
  terms: RecallQuery['terms'];
  signature: string;
  stream: { next(): Promise<AgentRecallPage | null>; close(): Promise<void> } | null;
  closing: Promise<void> | null;
};
type Answer = { request: Request; page: AgentRecallPage };
type SearchState =
  | { kind: 'empty' }
  | { kind: 'loading'; request: Request; previous: Answer | null }
  | { kind: 'failed'; request: Request; error: UiText }
  | { kind: 'ready'; request: Request; page: AgentRecallPage };
type Result =
  | { kind: 'title'; session: AgentSession }
  | { kind: 'passage'; passage: AgentRecallPassage };
type Row =
  | { id: string; kind: 'result'; request: number; index: number; result: Result }
  | { id: string; kind: 'gap'; reason: string };
type Selection = { request: number; index: number };
const SEARCH_PAUSE_MS = 250;

function excerptRuns(passage: AgentRecallPassage) {
  const runs: { text: string; matched: boolean }[] = [];
  let end = 0;
  for (const range of passage.highlights) {
    if (range.start > end)
      runs.push({ text: passage.excerpt.slice(end, range.start), matched: false });
    runs.push({ text: passage.excerpt.slice(range.start, range.end), matched: true });
    end = range.end;
  }
  if (end < passage.excerpt.length) runs.push({ text: passage.excerpt.slice(end), matched: false });
  return runs;
}

export function RecallSearch(props: {
  origin: string | null;
  open(origin: string | null, target: RecallTarget): Promise<boolean | void>;
  close(): void;
}) {
  const origin = props.origin;
  const query = signal('');
  const state = signal<SearchState>({ kind: 'empty' });
  const selected = signal(0);
  const opening = signal(false);
  const openError = createText();
  let alive = true;
  let sequence = 0;
  let wanted: Request | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let list: YNode | undefined;
  let removeKeys = () => {};
  const release = (request: Request) => {
    if (!request.stream) return Promise.resolve();
    return (request.closing ??= request.stream.close().catch((reason) => {
      if (alive) openError.set(errorText(reason));
    }));
  };
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const previous = wanted;
    wanted = null;
    if (previous) void release(previous);
  };
  cleanup(() => {
    alive = false;
    cancel();
    removeKeys();
  });
  const answer = computed<Answer | null>(() => {
    const current = state();
    return current.kind === 'ready'
      ? current
      : current.kind === 'loading'
        ? current.previous
        : null;
  });
  const results = computed<Result[]>(() => {
    const current = answer();
    return current
      ? [
          ...current.page.titles.map((session): Result => ({ kind: 'title', session })),
          ...current.page.passages.map(
            (passage): Result => ({
              kind: 'passage',
              passage,
            }),
          ),
        ]
      : [];
  });
  const rows = computed<Row[]>(() => {
    const current = answer();
    if (!current) return [];
    return [
      ...results().map(
        (result, index): Row => ({
          id: `${current.request.id}:result:${index}`,
          kind: 'result',
          request: current.request.id,
          index,
          result,
        }),
      ),
      ...current.page.gaps.map(
        (reason, index): Row => ({
          id: `${current.request.id}:gap:${index}`,
          kind: 'gap',
          reason,
        }),
      ),
    ];
  });
  const index = () => Math.min(selected(), Math.max(0, results().length - 1));
  const partial = () => {
    const current = state();
    return current.kind === 'ready' && (!current.page.complete || current.page.gaps.length > 0);
  };
  const read = async (request: Request) => {
    try {
      request.stream = await host.subscribe('agent', 'recall', {
        terms: request.terms,
        session_id: null,
      });
      if (!alive || wanted !== request) return;
      const page = await request.stream.next();
      if (!alive || wanted !== request) return;
      if (page === null) throw new UiError('Conversation search ended without a result.');
      state.set({ kind: 'ready', request, page });
      if (page.titles.length || page.passages.length || page.gaps.length)
        list?.scrollToIndex({ index: 0, animated: false });
    } catch (reason) {
      if (alive && wanted === request)
        state.set({ kind: 'failed', request, error: errorText(reason) });
    } finally {
      await release(request);
    }
  };
  const search = (text: string, retry = false) => {
    if (!alive || opening()) return;
    const [first, ...rest] = text.trim().split(/\s+/);
    const terms: RecallQuery['terms'] | null = first ? [first, ...rest] : null;
    const signature = JSON.stringify(terms);
    query.set(text);
    if (!retry && signature === wanted?.signature) return;
    const previous = answer();
    cancel();
    wanted = terms ? { id: ++sequence, terms, signature, stream: null, closing: null } : null;
    batch(() => {
      state.set(wanted ? { kind: 'loading', request: wanted, previous } : { kind: 'empty' });
      selected.set(0);
      openError.set('');
    });
    if (wanted) {
      const request = wanted;
      timer = setTimeout(
        () => {
          timer = undefined;
          if (alive && wanted === request) void read(request);
        },
        retry ? 0 : SEARCH_PAUSE_MS,
      );
    }
  };
  const failure = () => {
    const current = state();
    return current.kind === 'failed' ? current : null;
  };
  const retry = (request: number | undefined) => {
    const current = state();
    if (alive && current.kind === 'failed' && current.request.id === request) search(query(), true);
  };
  const move = (delta: number) => {
    if (!alive || opening() || state().kind !== 'ready' || !results().length) return;
    const next = Math.max(0, Math.min(results().length - 1, index() + delta));
    selected.set(next);
    list?.scrollToIndex({
      index: next,
      animated: false,
      viewPosition: delta > 0 ? 1 : 0,
    });
  };
  const choose = async (selection: Selection) => {
    const current = state();
    if (!alive || opening() || current.kind !== 'ready' || current.request.id !== selection.request)
      return;
    const result = results()[selection.index];
    if (!result) return;
    const target: RecallTarget =
      result.kind === 'title'
        ? { sessionId: result.session.id }
        : {
            sessionId: result.passage.session.id,
            anchor: {
              messageId: result.passage.anchorMessageId,
              position: result.passage.anchorPosition,
            },
          };
    batch(() => {
      selected.set(selection.index);
      opening.set(true);
      openError.set('');
    });
    try {
      const opened = await props.open(origin, target);
      if (alive && opened !== false) props.close();
    } catch (reason) {
      if (alive) openError.set(errorText(reason));
    } finally {
      if (alive) opening.set(false);
    }
  };
  const submit = () => {
    const current = state();
    if (current.kind === 'loading' && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      if (wanted === current.request) void read(current.request);
      return;
    }
    if (current.kind === 'ready') void choose({ request: current.request.id, index: index() });
  };
  const close = () => {
    if (alive) props.close();
  };
  return (
    <Dialog
      animation="none"
      onOpenChange={(open) => {
        if (!open) close();
      }}
      style={{
        flex: 1,
        justifyContent: 'flex-start',
        alignItems: 'center',
        backgroundColor: '#00000099',
        paddingHorizontal: 16,
        paddingTop: compact() ? 16 : windowSize().height / 8,
        paddingBottom: 16,
      }}
    >
      <View
        style={{
          width: '100%',
          maxWidth: 760,
          height: '100%',
          maxHeight: '100%',
          minHeight: 0,
          flexShrink: 1,
          backgroundColor: C.surface,
          padding: 16,
          gap: 12,
          borderWidth: 1,
          borderRadius: 16,
          borderColor: C.line,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text
            style={{
              flex: 1,
              color: C.text,
              fontSize: 18,
              lineHeight: 24,
              fontWeight: '600',
            }}
          >
            {tr('Search conversations')}
          </Text>
          <Button
            accessibilityLabel={tr('Close conversation search')}
            tooltip={tr('Close · Esc')}
            onPress={close}
            style={{
              ...controlStyle,
              width: 32,
              paddingHorizontal: 8,
              alignItems: 'center',
            }}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
          >
            <Icon name="close" color={C.muted} />
          </Button>
        </View>
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {tr('Search every conversation you can read, including archived conversations.')}
        </Text>
        <Input
          ref={(node) => {
            removeKeys();
            const keys = [
              keymap.bind('up', () => move(-1), {
                when: 'always',
                repeat: true,
                within: node,
              }),
              keymap.bind('down', () => move(1), {
                when: 'always',
                repeat: true,
                within: node,
              }),
            ];
            removeKeys = () => keys.forEach((remove) => remove());
          }}
          testID="recall-search"
          accessibilityLabel={tr('Search conversation history')}
          autoFocus
          value={query()}
          onChange={(text) => search(text)}
          onSubmit={submit}
          submitBehavior="submit"
          readonly={opening()}
          placeholder={tr('Search titles and messages…')}
          style={{
            color: C.text,
            placeholderColor: C.muted,
            height: compact() ? 32 : 40,
            backgroundColor: C.background,
            borderRadius: inputBorderRadius,
            paddingHorizontal: 12,
            fontSize: 14,
          }}
        />
        <If when={state().kind === 'empty'}>
          <Text style={{ ...bodyTextStyle, color: C.muted }}>
            {tr('Type words to search conversation history.')}
          </Text>
        </If>
        <If when={state().kind === 'loading'}>
          <Text style={{ ...bodyTextStyle, color: C.muted }}>{tr('Searching conversations…')}</Text>
        </If>
        <If when={state().kind === 'failed'}>
          <Text style={{ ...bodyTextStyle, color: C.danger }}>
            {failure() ? renderText(failure()!.error) : ''}
          </Text>
          <Button
            accessibilityLabel={tr('Retry')}
            onPress={inputAction(retry, failure()?.request.id)}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
          >
            <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Retry')}</Text>
          </Button>
        </If>
        <If when={partial()}>
          <Text style={{ ...captionTextStyle, color: C.warning }}>
            {tr('Search is incomplete. Available matches are shown.')}
          </Text>
        </If>
        <If when={openError()}>
          <Text style={{ ...bodyTextStyle, color: C.danger }}>{openError()}</Text>
        </If>
        <If when={opening()}>
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Opening conversation…')}</Text>
        </If>
        <List
          each={rows()}
          estimatedItemSize={128}
          ref={(node) => {
            list = node;
          }}
          style={{ flex: 1, minHeight: 0, opacity: state().kind === 'ready' ? 1 : 0.5 }}
          empty={
            <If when={state().kind === 'ready'}>
              <Text style={{ ...bodyTextStyle, color: C.muted }}>
                {tr('No matching conversations or messages.')}
              </Text>
            </If>
          }
        >
          {(item) => (
            <Each of={[item()]} key={(row: Row) => row.id}>
              {(value) => {
                const row = value();
                if (row.kind === 'gap')
                  return (
                    <View style={{ padding: 12 }}>
                      <Text style={{ ...captionTextStyle, color: C.warning }}>{row.reason}</Text>
                    </View>
                  );
                const result = row.result;
                const session = result.kind === 'title' ? result.session : result.passage.session;
                const preview = result.kind === 'passage' ? excerptRuns(result.passage) : [];
                const title = () => session.title || tr('Untitled conversation');
                return (
                  <Button
                    accessibilityLabel={
                      result.kind === 'title'
                        ? tr('Open conversation {title}', { title: title() })
                        : tr('Open matching passage in {title}', { title: title() })
                    }
                    onPress={inputAction(choose, {
                      request: row.request,
                      index: row.index,
                    })}
                    disabled={opening() || state().kind !== 'ready'}
                    selected={index() === row.index}
                    style={{
                      height: result.kind === 'title' ? 72 : 128,
                      minWidth: 0,
                      flexDirection: 'column',
                      alignItems: 'stretch',
                      justifyContent: 'center',
                      padding: 12,
                      gap: 4,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: 'transparent',
                      backgroundColor: index() === row.index ? C.raised : C.surface,
                    }}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                  >
                    <View
                      pointerEvents="none"
                      style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}
                    >
                      <Text
                        numberOfLines={1}
                        ellipsizeMode="tail"
                        style={{
                          ...bodyTextStyle,
                          flex: 1,
                          color: C.text,
                          fontWeight: '500',
                        }}
                      >
                        {title()}
                      </Text>
                      <If when={session.archived}>
                        <Text style={{ ...captionTextStyle, color: C.muted }}>
                          {tr('Archived')}
                        </Text>
                      </If>
                    </View>
                    <Text
                      pointerEvents="none"
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={{ ...captionTextStyle, color: C.muted }}
                    >
                      {session.workspace.path}
                    </Text>
                    <If when={result.kind === 'passage'}>
                      <Text
                        pointerEvents="none"
                        numberOfLines={3}
                        ellipsizeMode="tail"
                        style={{ ...captionTextStyle, color: C.secondary }}
                      >
                        <Each of={preview}>
                          {(run) => (
                            <Text
                              style={
                                run().matched
                                  ? {
                                      backgroundColor: `${C.accent}33`,
                                      color: C.text,
                                      fontWeight: '600',
                                    }
                                  : {}
                              }
                            >
                              {run().text}
                            </Text>
                          )}
                        </Each>
                      </Text>
                    </If>
                  </Button>
                );
              }}
            </Each>
          )}
        </List>
      </View>
    </Dialog>
  );
}
