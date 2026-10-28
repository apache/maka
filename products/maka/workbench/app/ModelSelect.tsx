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

import { textTooltip } from './ui';
import {
  batch,
  cleanup,
  computed,
  effect,
  inputAction,
  Scroll,
  signal,
  Text,
  View,
  List,
} from 'nsh';
import { Input } from 'nsh/base';
import type { YNode } from 'nsh';
import type {
  ModelSelection,
  SettingsModelCursor,
  SettingsConnectionSummary,
  ThinkingLevel,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import { Button, Popover } from 'nsh/base';
import { keymap } from 'nsh';
import { platform, windowSize } from 'nsh';
import { host } from './host';
import { tr } from './locale';
import { createText, errorText, UiError } from './text';
import type { ConversationHandle } from './Conversation';
import { effectiveThinkingLevel, effortCaption, modelCaption, sameRoute } from './modelSelection';
import type { BackendIdentity, ModelBackend, ModelChoice } from './modelSelection';
import { ChoiceIndicator } from './ChoiceIndicator';
import { Icon } from './Icon';
import {
  C,
  captionTextStyle,
  inputTextStyle,
  inputBorderRadius,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  controlDisabledStyle,
  shortcut,
} from './ui';

type Pane = 'root' | 'models' | 'connections' | 'effort';
type SelectionAction = {
  instance: number;
  sessionId: string;
  expected: BackendIdentity;
  backend: ModelBackend;
};
type EffortAction = SelectionAction & { level: ThinkingLevel };
type ModelsPage = {
  revision: number;
  next: SettingsModelCursor | null;
  choices: ModelChoice[];
};

type ModelMenuHandle = { instance: number; back(): void; dismiss(): void };
type ModelTarget = { sessionId: string; instance: number | null };
const modelRowHeight = platform.isTerminal ? 48 : 40;
// Notes under the model list start where the rows' text does.
const listTextInset = {
  paddingHorizontal: platform.isTerminal ? 0 : controlStyle.paddingHorizontal,
};

export function ModelSelect(props: {
  owner: ConversationHandle;
  instance(): number | null;
  current(): boolean;
  toggle(target: ModelTarget): void;
  close(instance: number): boolean;
  select(instance: number, backend: ModelBackend): Promise<void>;
  manage(target: { sessionId: string; instance: number; model?: ModelSelection }): void;
}) {
  const owner = props.owner;
  let menu: ModelMenuHandle | null = null;
  const changed = computed(() => {
    const instance = props.instance();
    return (next: boolean, reason: string) => {
      if (!props.current() || props.instance() !== instance) return;
      if (next) {
        if (instance === null) props.toggle({ sessionId: owner.sessionId, instance });
      } else if (instance !== null && menu?.instance === instance) {
        if (reason === 'cancel') menu.back();
        else menu.dismiss();
      }
    };
  });
  const model = () => modelCaption(owner.backend(), owner.modelDetails());
  const effort = () => effortCaption(owner.backend(), owner.modelDetails());
  const label = () => (effort() ? `${model()} · ${effort()}` : model());
  return (
    <Popover
      open={props.instance() !== null}
      onOpenChange={changed()}
      placement="top"
      align="end"
      offset={8}
      margin={8}
      style={{ minWidth: 0, alignItems: 'flex-end' }}
      popupStyle={{
        width: 420,
        maxWidth: Math.max(0, windowSize().width - 16),
        maxHeight: Math.min(360, Math.max(0, windowSize().height - 16)),
        minHeight: 0,
        padding: 8,
        backgroundColor: C.surface,
        borderWidth: 1,
        borderColor: C.line,
        borderRadius: 12,
      }}
      trigger={
        <Button
          accessibilityLabel={tr('Choose model and effort')}
          tooltip={textTooltip(() =>
            props.instance() !== null
              ? undefined
              : `${label()} · ${shortcut(tr('Choose model and effort'), 'mod+g')}`,
          )}
          onPress={inputAction(props.toggle, {
            sessionId: owner.sessionId,
            instance: props.instance(),
          })}
          style={{
            ...controlStyle,
            maxWidth: '100%',
            minWidth: 0,
            flexDirection: 'row',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 8,
          }}
          hoverStyle={{ backgroundColor: C.line }}
          focusStyle={{ backgroundColor: C.line }}
          activeStyle={{ backgroundColor: C.surface }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              minWidth: 0,
              flexShrink: 1,
            }}
          >
            <Text
              style={[
                {
                  color: owner.backend() ? C.secondary : C.warning,
                  fontSize: 13,
                  minWidth: 0,
                  flexShrink: 1,
                },
                { numberOfLines: 1 },
              ]}
            >
              {model()}
            </Text>
            <If when={effort()}>
              <Text
                style={[{ color: C.secondary, fontSize: 13, flexShrink: 0 }, { numberOfLines: 1 }]}
              >
                {` · ${effort()}`}
              </Text>
            </If>
          </View>
          <Icon name="down" color={C.secondary} />
        </Button>
      }
    >
      <Each
        of={props.instance() === null ? [] : [props.instance()!]}
        key={(instance: number) => instance}
      >
        {(opening) => {
          const instance = opening();
          return (
            <ModelMenu
              owner={owner}
              instance={instance}
              current={() => props.current() && props.instance() === instance}
              close={props.close}
              select={(backend) => props.select(instance, backend)}
              manage={(model) => {
                if (
                  props.current() &&
                  props.instance() === instance &&
                  (!model || sameRoute(owner.backend(), model))
                )
                  props.manage({ sessionId: owner.sessionId, instance, model: model ?? undefined });
              }}
              attach={(handle) => {
                menu = handle;
              }}
              detach={(handle) => {
                if (menu === handle) menu = null;
              }}
            />
          );
        }}
      </Each>
    </Popover>
  );
}

function ModelMenu(props: {
  owner: ConversationHandle;
  instance: number;
  current(): boolean;
  close(instance: number): boolean;
  select(backend: ModelBackend): Promise<void>;
  manage(model: ModelSelection | null): void;
  attach(handle: ModelMenuHandle): void;
  detach(handle: ModelMenuHandle): void;
}) {
  const owner = props.owner;
  const pane = signal<Pane>(owner.backend() ? 'root' : 'models');
  const query = signal('');
  const connection = signal<{ id: string; name: string; slug: string } | null>(null);
  const connections = signal<SettingsConnectionSummary[]>([]);
  const connectionPage = signal<{ revision: number; next: number | null } | null>(null);
  const connectionsLoading = signal(false);
  const page = signal<ModelsPage | null>(null);
  const choices = () => page()?.choices ?? [];
  const selected = signal(0);
  const loading = signal(false);
  const pending = signal(false);
  const error = createText();
  let alive = true;
  let generation = 0;
  let modelsQueued = false;
  let removeSearchKeys = () => {};
  let list: YNode | undefined;
  let focusIntent: 'model' | 'effort' | null = null;
  cleanup(() => {
    alive = false;
    generation += 1;
    removeSearchKeys();
  });

  const active = () => alive && props.current();
  const readyChoice = () => {
    const details = owner.modelDetails();
    return details.kind === 'ready' && sameRoute(owner.backend(), details.choice.selection)
      ? details.choice
      : null;
  };
  const hasEffortControls = () => {
    const choice = readyChoice();
    return (
      choice !== null &&
      (choice.thinkingLevels.length > 0 || owner.backend()?.thinkingLevel != null)
    );
  };
  const sameBackend = (left: BackendIdentity, right: BackendIdentity) =>
    sameRoute(left, right) && left?.thinkingLevel === right?.thinkingLevel;
  const action = (backend: ModelBackend): SelectionAction => ({
    instance: props.instance,
    sessionId: owner.sessionId,
    expected: owner.backend(),
    backend,
  });
  const submit = async (request: SelectionAction) => {
    if (
      !active() ||
      pending() ||
      request.instance !== props.instance ||
      request.sessionId !== owner.sessionId ||
      !sameBackend(request.expected, owner.backend())
    )
      return;
    if (sameBackend(request.backend, request.expected)) {
      props.close(request.instance);
      return;
    }
    pending.set(true);
    error.set('');
    try {
      await props.select(request.backend);
      if (active()) props.close(request.instance);
    } catch (reason) {
      if (active()) error.set(errorText(reason));
    } finally {
      if (alive) pending.set(false);
    }
  };
  const selectEffort = (request: EffortAction) => {
    const choice = readyChoice();
    if (
      !choice ||
      !sameRoute(request.backend, choice.selection) ||
      !choice.thinkingLevels.includes(request.level) ||
      effectiveThinkingLevel(request.backend, choice) !== request.level
    )
      return;
    void submit(request);
  };
  const resetEffort = (request: SelectionAction) => {
    const choice = readyChoice();
    if (
      !choice ||
      !sameRoute(request.backend, choice.selection) ||
      choice.defaultThinkingLevel !== null ||
      request.backend.thinkingLevel !== null
    )
      return;
    void submit(request);
  };
  const close = ({ instance, from }: { instance: number; from: Pane }) => {
    if (active() && !pending() && pane() === from) props.close(instance);
  };
  const back = () => {
    if (!active() || pending()) return;
    if (pane() === 'root') props.close(props.instance);
    else if (pane() === 'connections') {
      pane.set('models');
      error.set('');
      void loadModels(true);
    } else {
      focusIntent = pane() === 'models' ? 'model' : 'effort';
      pane.set('root');
      error.set('');
    }
  };
  const changePane = ({ instance, to, from }: { instance: number; to: Pane; from: Pane }) => {
    if (!active() || pending() || instance !== props.instance || pane() !== from) return;
    if (to === 'effort' && !hasEffortControls()) return;
    if (to === 'root') focusIntent = from === 'models' ? 'model' : 'effort';
    error.set('');
    pane.set(to);
    if (to === 'models') void loadModels(true);
    if (to === 'connections' && !connectionPage()) void loadConnections();
  };
  const loadConnections = async () => {
    if (!active() || connectionsLoading() || connectionPage()?.next === null) return;
    connectionsLoading.set(true);
    error.set('');
    let changed = false;
    try {
      for (;;) {
        const previous = connectionPage();
        const result = await host.query(
          'settings',
          'connections',
          previous && previous.next !== null
            ? { kind: 'continue', revision: previous.revision, offset: previous.next }
            : { kind: 'start' },
        );
        if (!active()) return;
        if (result.kind === 'changed') {
          if (changed)
            throw new UiError(
              'The model catalog keeps changing. Retry to read the current choices.',
            );
          changed = true;
          connections.set([]);
          connectionPage.set(null);
          continue;
        }
        connections.set([...(previous ? connections() : []), ...result.connections]);
        connectionPage.set({ revision: result.revision, next: result.next });
        break;
      }
    } catch (reason) {
      if (active()) error.set(errorText(reason));
    } finally {
      if (alive) connectionsLoading.set(false);
    }
  };
  const filterConnection = (next: { id: string; name: string; slug: string } | null) => {
    if (!active() || pending() || pane() !== 'connections') return;
    connection.set(next);
    pane.set('models');
    void loadModels(true);
  };
  const loadModels = async (restart = false) => {
    if (!active() || pane() !== 'models' || (!restart && !page()?.next)) return;
    if (restart) {
      generation += 1;
      batch(() => {
        page.set(null);
        selected.set(0);
        error.set('');
      });
    }
    modelsQueued = true;
    // Discarding a Promise cannot cancel admitted Host work. Keep one query
    // in flight, then read the latest search or the next published page.
    if (loading()) return;
    loading.set(true);
    error.set('');
    try {
      do {
        modelsQueued = false;
        const reading = generation;
        const search = query();
        let changed = false;
        try {
          do {
            const previousPage = page();
            if (previousPage && !previousPage.next) break;
            const result = await host.query(
              'settings',
              'models',
              previousPage?.next
                ? { kind: 'continue', revision: previousPage.revision, cursor: previousPage.next }
                : { kind: 'start', query: search, connectionId: connection()?.id ?? null },
            );
            if (!active() || pane() !== 'models' || reading !== generation) break;
            if (result.kind === 'changed') {
              if (changed)
                throw new UiError(
                  'The model catalog keeps changing. Retry to read the current choices.',
                );
              changed = true;
              page.set(null);
              selected.set(0);
              continue;
            }
            page.set({
              revision: result.revision,
              next: result.next,
              choices: [...(previousPage?.choices ?? []), ...result.choices],
            });
            break;
          } while (active() && pane() === 'models' && reading === generation);
        } catch (reason) {
          if (active() && pane() === 'models' && reading === generation) {
            modelsQueued = false;
            error.set(errorText(reason));
          }
        }
      } while (active() && pane() === 'models' && modelsQueued);
    } finally {
      if (alive) loading.set(false);
    }
  };
  const retry = ({ instance, from }: { instance: number; from: Pane }) => {
    if (!active() || pending() || instance !== props.instance || pane() !== from) return;
    if (from === 'models') void loadModels(true);
    else if (from === 'connections') void loadConnections();
    else void owner.refreshModel();
  };
  const index = () => Math.min(selected(), Math.max(0, choices().length - 1));
  const routeId = (choice: ModelChoice) =>
    JSON.stringify([choice.selection.connectionId, choice.selection.modelId]);
  const byId = computed(() => new Map(choices().map((choice) => [routeId(choice), choice])));
  const ids = computed(() => choices().map(routeId));
  const modelAction = (choice: ModelChoice) =>
    action({
      connectionId: choice.selection.connectionId,
      modelId: choice.selection.modelId,
      thinkingLevel: sameRoute(owner.backend(), choice.selection)
        ? (owner.backend()?.thinkingLevel ?? null)
        : null,
    });
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(choices().length - 1, index() + delta));
    selected.set(next);
    list?.scrollToIndex({ index: next, animated: false, viewPosition: delta > 0 ? 1 : 0 });
    if (next >= choices().length - 2) void loadModels();
  };
  const activate = () => {
    const choice = choices()[index()];
    if (choice) void submit(modelAction(choice));
  };
  const focusRoot = (which: 'model' | 'effort', node: YNode) => {
    if (focusIntent !== which) return;
    focusIntent = null;
    node.focus();
  };
  const handle: ModelMenuHandle = {
    instance: props.instance,
    back,
    dismiss: () => close({ instance: props.instance, from: pane() }),
  };
  effect(() => {
    if (pane() === 'effort' && owner.modelDetails().kind === 'ready' && !hasEffortControls()) {
      focusIntent = 'model';
      pane.set('root');
    }
  });
  props.attach(handle);
  cleanup(() => props.detach(handle));
  void owner.refreshModel();
  if (pane() === 'models') void loadModels(true);

  return (
    <View style={{ minHeight: 0, flexShrink: 1, gap: 4 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <Text
          style={{
            ...captionTextStyle,
            color: C.secondary,
            fontWeight: '600',
            paddingHorizontal: 8,
          }}
        >
          {pane() === 'connections' ? tr('Filter by connection') : tr('Models')}
        </Text>
        <Button
          disabled={pending()}
          accessibilityLabel={
            pane() === 'root'
              ? tr('Close model selection')
              : pane() === 'connections'
                ? tr('Back to models')
                : tr('Back to model settings')
          }
          onPress={
            pane() === 'connections'
              ? back
              : pane() === 'root'
                ? inputAction(close, { instance: props.instance, from: pane() })
                : inputAction(changePane, { instance: props.instance, from: pane(), to: 'root' })
          }
          tooltip={textTooltip(() => (pane() === 'root' ? tr('Close') : tr('Back')))}
          style={{ ...controlStyle, width: 32, paddingHorizontal: 8, alignItems: 'center' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Icon name={pane() === 'root' ? 'close' : 'back'} color={C.muted} />
        </Button>
      </View>
      <If when={pane() === 'root'}>
        <Button
          ref={(node) => focusRoot('model', node)}
          disabled={pending()}
          accessibilityLabel={tr('Choose model')}
          onPress={inputAction(changePane, {
            instance: props.instance,
            from: 'root',
            to: 'models',
          })}
          style={{
            ...controlStyle,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
          }}
          hoverStyle={{ backgroundColor: C.raised }}
          focusStyle={{ backgroundColor: C.raised }}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.secondary }}>{tr('Model')}</Text>
          <Text
            style={[
              {
                ...captionTextStyle,
                color: C.muted,
                flex: 1,
                minWidth: 0,
                textAlign: 'right',
              },
              { numberOfLines: 1 },
            ]}
          >
            {modelCaption(owner.backend(), owner.modelDetails())}
          </Text>
          <Icon name="right" color={C.muted} />
        </Button>
        <If when={hasEffortControls()}>
          <Button
            ref={(node) => focusRoot('effort', node)}
            disabled={pending() || !readyChoice()}
            accessibilityLabel={tr('Choose reasoning effort')}
            onPress={inputAction(changePane, {
              instance: props.instance,
              from: 'root',
              to: 'effort',
            })}
            style={{
              ...controlStyle,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
            }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.raised }}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary }}>
              {tr('Reasoning effort')}
            </Text>
            <Text
              style={[
                {
                  ...captionTextStyle,
                  color: C.muted,
                  flex: 1,
                  minWidth: 0,
                  textAlign: 'right',
                },
                { numberOfLines: 1 },
              ]}
            >
              {effortCaption(owner.backend(), owner.modelDetails())}
            </Text>
            <Icon name="right" color={C.muted} />
          </Button>
        </If>
        <If when={readyChoice()}>
          <Button
            disabled={pending()}
            accessibilityLabel={tr('Edit current model settings')}
            onPress={inputAction(props.manage, readyChoice()!.selection)}
            style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
            hoverStyle={{ backgroundColor: C.raised }}
            focusStyle={{ backgroundColor: C.raised }}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.secondary, flex: 1 }}>
              {tr('Model settings')}
            </Text>
            <Icon name="right" color={C.muted} />
          </Button>
        </If>
      </If>
      <If when={pane() === 'connections'}>
        <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
          <View style={{ gap: 4 }}>
            <Button
              ref={(node) => node.focus()}
              disabled={pending()}
              accessibilityLabel={tr('All connections')}
              selected={connection() === null}
              onPress={inputAction(filterConnection, null)}
              style={controlStyle}
              hoverStyle={controlHoverStyle}
              focusStyle={controlFocusStyle}
            >
              <Text style={{ ...captionTextStyle, color: C.text }}>{tr('All connections')}</Text>
            </Button>
            <Each
              of={connections()}
              key={(item: SettingsConnectionSummary) => item.basis.connectionId}
            >
              {(item) => (
                <Button
                  disabled={pending()}
                  accessibilityLabel={item().name}
                  selected={connection()?.id === item().basis.connectionId}
                  onPress={inputAction(filterConnection, {
                    id: item().basis.connectionId,
                    name: item().name,
                    slug: item().slug,
                  })}
                  style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
                  hoverStyle={controlHoverStyle}
                  focusStyle={controlFocusStyle}
                >
                  <View style={[{ flex: 1, minWidth: 0 }, { pointerEvents: 'none' }]}>
                    <Text style={[{ ...captionTextStyle, color: C.text }, { numberOfLines: 1 }]}>
                      {item().name}
                    </Text>
                    <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}>
                      {item().slug}
                    </Text>
                  </View>
                  <ChoiceIndicator
                    kind="radio"
                    checked={connection()?.id === item().basis.connectionId}
                  />
                </Button>
              )}
            </Each>
            <If when={!connectionPage() || connectionPage()?.next !== null}>
              <Button
                disabled={connectionsLoading()}
                onPress={loadConnections}
                style={controlStyle}
                hoverStyle={controlHoverStyle}
                focusStyle={controlFocusStyle}
              >
                <Text style={{ ...captionTextStyle, color: C.accent }}>
                  {connectionsLoading() ? tr('Loading…') : tr('Load more connections')}
                </Text>
              </Button>
            </If>
          </View>
        </Scroll>
      </If>
      <If when={pane() === 'models'}>
        <Button
          disabled={pending()}
          accessibilityLabel={tr('Filter by connection')}
          onPress={inputAction(changePane, {
            instance: props.instance,
            from: 'models',
            to: 'connections',
          })}
          style={{ ...controlStyle, flexDirection: 'row', alignItems: 'center', gap: 8 }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Connection')}</Text>
          <Text
            style={[
              { ...captionTextStyle, color: C.text, flex: 1, textAlign: 'right' },
              { numberOfLines: 1 },
            ]}
          >
            {connection() ? `${connection()!.name} · ${connection()!.slug}` : tr('All connections')}
          </Text>
          <Icon name="down" color={C.muted} />
        </Button>
        <Input
          ref={(node) => {
            removeSearchKeys();
            const unbind = [
              keymap.bind('up', () => move(-1), { when: 'always', repeat: true, within: node }),
              keymap.bind('down', () => move(1), { when: 'always', repeat: true, within: node }),
              keymap.bind('enter', activate, { when: 'always', within: node }),
              keymap.bind('escape', back, { when: 'always', within: node }),
            ];
            removeSearchKeys = () => unbind.forEach((remove) => remove());
          }}
          autoFocus
          accessibilityLabel={tr('Search models')}
          value={query()}
          readonly={pending()}
          onChange={(text) => {
            batch(() => {
              query.set(text);
              selected.set(0);
            });
            list?.scrollToIndex({ index: 0, animated: false });
            void loadModels(true);
          }}
          placeholder={tr('Search models…')}
          style={{
            ...inputTextStyle,
            placeholderColor: C.muted,
            color: C.text,
            height: 32,
            backgroundColor: C.background,
            borderRadius: inputBorderRadius,
            paddingHorizontal: 12,
          }}
        />
        <List
          each={ids()}
          ref={(node) => {
            list = node;
          }}
          estimatedItemSize={modelRowHeight}
          onLoadMore={() => {
            if (!error()) void loadModels();
          }}
          style={{
            height: choices().length * modelRowHeight,
            minHeight: modelRowHeight,
            flexShrink: 1,
          }}
        >
          {(id) => (
            <Each<string> of={[id()]} key={(key: string) => key}>
              {(key) => {
                const initial = byId().get(key());
                if (!initial) return <View />;
                const choice = () => byId().get(key()) ?? initial;
                return (
                  <Button
                    accessibilityLabel={tr('Use {model} · {connection}', {
                      model: choice().label,
                      connection: choice().connectionName,
                    })}
                    disabled={pending()}
                    selected={sameRoute(owner.backend(), choice().selection)}
                    onPress={inputAction(submit, modelAction(choice()))}
                    style={{
                      height: modelRowHeight,
                      paddingHorizontal: 12,
                      paddingVertical: platform.isTerminal ? 8 : 4,
                      borderRadius: 8,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 12,
                      backgroundColor:
                        choices()[index()] && routeId(choices()[index()]) === key()
                          ? C.line
                          : C.surface,
                    }}
                    hoverStyle={{ backgroundColor: C.raised }}
                    focusStyle={{ backgroundColor: C.raised }}
                    disabledStyle={controlDisabledStyle}
                  >
                    <View style={[{ flex: 1, minWidth: 0 }, { pointerEvents: 'none' }]}>
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.text, fontSize: 14 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {choice().label}
                      </Text>
                      <Text style={[{ ...captionTextStyle, color: C.muted }, { numberOfLines: 1 }]}>
                        {choice().connectionName} · {choice().selection.modelId}
                      </Text>
                    </View>
                    <ChoiceIndicator
                      kind="radio"
                      checked={sameRoute(owner.backend(), choice().selection)}
                      disabled={pending()}
                    />
                  </Button>
                );
              }}
            </Each>
          )}
        </List>
        <If when={!loading() && !error() && choices().length === 0}>
          <Text style={{ ...captionTextStyle, color: C.muted, ...listTextInset }}>
            {tr('No models match this search and connection.')}
          </Text>
        </If>
        <Text style={{ ...captionTextStyle, color: C.muted, ...listTextInset }}>
          {loading()
            ? tr('Loading…')
            : choices().length === 1
              ? tr('{count} model', { count: choices().length })
              : tr('{count} models', { count: choices().length })}
        </Text>
      </If>
      <If when={pane() === 'effort'}>
        <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
          <Each<ModelChoice>
            of={readyChoice() ? [readyChoice()!] : []}
            key={(choice: ModelChoice) => routeId(choice)}
          >
            {(item) => (
              <View style={{ gap: 8 }}>
                <Each<ThinkingLevel>
                  of={item().thinkingLevels}
                  key={(level: ThinkingLevel) => level}
                >
                  {(level) => (
                    <Button
                      disabled={pending()}
                      accessibilityLabel={tr('Use effort {level}', { level: level() })}
                      selected={effectiveThinkingLevel(owner.backend(), item()) === level()}
                      onPress={inputAction(selectEffort, {
                        ...action({
                          connectionId: item().selection.connectionId,
                          modelId: item().selection.modelId,
                          thinkingLevel: item().defaultThinkingLevel === level() ? null : level(),
                        }),
                        level: level(),
                      })}
                      style={{
                        ...controlStyle,
                        backgroundColor: C.background,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 12,
                      }}
                      hoverStyle={{ backgroundColor: C.raised }}
                      focusStyle={{ backgroundColor: C.raised }}
                      disabledStyle={controlDisabledStyle}
                    >
                      <ChoiceIndicator
                        kind="radio"
                        checked={effectiveThinkingLevel(owner.backend(), item()) === level()}
                        disabled={pending()}
                      />
                      <Text style={{ ...captionTextStyle, color: C.text }}>{level()}</Text>
                    </Button>
                  )}
                </Each>
                <If
                  when={
                    item().defaultThinkingLevel === null && owner.backend()?.thinkingLevel != null
                  }
                >
                  <Button
                    disabled={pending()}
                    accessibilityLabel={tr('Use provider settings')}
                    onPress={inputAction(
                      resetEffort,
                      action({
                        connectionId: item().selection.connectionId,
                        modelId: item().selection.modelId,
                        thinkingLevel: null,
                      }),
                    )}
                    style={controlStyle}
                    hoverStyle={controlHoverStyle}
                    focusStyle={controlFocusStyle}
                    disabledStyle={controlDisabledStyle}
                  >
                    <Text style={{ ...captionTextStyle, color: C.secondary }}>
                      {tr('Use provider settings')}
                    </Text>
                  </Button>
                </If>
              </View>
            )}
          </Each>
        </Scroll>
      </If>
      <If
        when={
          pane() !== 'models' && pane() !== 'connections' && owner.modelDetails().kind !== 'ready'
        }
      >
        <Text style={{ ...captionTextStyle, color: C.muted }}>
          {owner.modelDetails().kind === 'loading'
            ? tr('Loading model policy…')
            : tr('The saved model policy is unavailable. Its selection is preserved.')}
        </Text>
        <Button
          disabled={pending()}
          onPress={inputAction(retry, { instance: props.instance, from: pane() })}
          accessibilityLabel={tr('Retry model policy')}
          style={controlStyle}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
          disabledStyle={controlDisabledStyle}
        >
          <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
        </Button>
      </If>
      <Button
        disabled={pending()}
        accessibilityLabel={tr('Manage connections and models')}
        onPress={inputAction(props.manage, null)}
        style={controlStyle}
        hoverStyle={controlHoverStyle}
        focusStyle={controlFocusStyle}
        disabledStyle={controlDisabledStyle}
      >
        <Text style={{ ...captionTextStyle, color: C.accent }}>
          {tr('Manage connections & models')}
        </Text>
      </Button>
      <If when={error()}>
        <Scroll
          accessibilityLabel={tr('Model selection error')}
          style={{ minHeight: 16, flexShrink: 1 }}
        >
          <Text style={[{ ...captionTextStyle, color: C.danger }, { userSelect: 'text' }]}>
            {error()}
          </Text>
        </Scroll>
        <If when={pane() === 'models' || pane() === 'connections'}>
          <Button
            disabled={pending()}
            onPress={inputAction(retry, { instance: props.instance, from: pane() })}
            accessibilityLabel={tr('Retry model catalog')}
            style={controlStyle}
            hoverStyle={controlHoverStyle}
            focusStyle={controlFocusStyle}
            disabledStyle={controlDisabledStyle}
          >
            <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
          </Button>
        </If>
      </If>
      <If when={pending()}>
        <Text style={{ ...captionTextStyle, color: C.muted }}>{tr('Saving selection…')}</Text>
      </If>
    </View>
  );
}
