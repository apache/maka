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

import {
  batch,
  cleanup,
  computed,
  effect,
  Input,
  inputAction,
  Scroll,
  signal,
  Text,
  View,
} from 'nsh';
import type { YNode } from 'nsh';
import type { ThinkingLevel } from '../../../../packages/plugin-sdk/src/generated/runtime';
import { Button, Popover } from 'nsh/base';
import { keymap } from 'nsh/keymap';
import { List } from 'nsh/list';
import { platform, windowSize } from 'nsh/device';
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

type Pane = 'root' | 'models' | 'effort';
type SelectionAction = {
  instance: number;
  sessionId: string;
  expected: BackendIdentity;
  backend: ModelBackend;
};
type EffortAction = SelectionAction & { level: ThinkingLevel };
type ModelsPage = {
  revision: number;
  next: { query: string; connection: number; model: number } | null;
  choices: ModelChoice[];
};

type ModelMenuHandle = { instance: number; back(): void; dismiss(): void };
type ModelTarget = { sessionId: string; instance: number | null };
const modelRowHeight = platform.isTerminal ? 48 : 40;

export function ModelSelect(props: {
  owner: ConversationHandle;
  instance(): number | null;
  current(): boolean;
  toggle(target: ModelTarget): void;
  close(instance: number): boolean;
  select(instance: number, backend: ModelBackend): Promise<void>;
  manage(target: { sessionId: string; instance: number }): void;
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
          tooltip={`${label()} · ${shortcut(tr('Choose model and effort'), 'mod+g')}`}
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
              numberOfLines={1}
              style={{
                color: owner.backend() ? C.secondary : C.warning,
                fontSize: 13,
                minWidth: 0,
                flexShrink: 1,
              }}
            >
              {model()}
            </Text>
            <If when={effort()}>
              <Text numberOfLines={1} style={{ color: C.secondary, fontSize: 13, flexShrink: 0 }}>
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
              manage={() => {
                if (props.current() && props.instance() === instance)
                  props.manage({ sessionId: owner.sessionId, instance });
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
  manage(): void;
  attach(handle: ModelMenuHandle): void;
  detach(handle: ModelMenuHandle): void;
}) {
  const owner = props.owner;
  const pane = signal<Pane>(owner.backend() ? 'root' : 'models');
  const query = signal('');
  const page = signal<ModelsPage | null>(null);
  const choices = () => page()?.choices ?? [];
  const selected = signal(0);
  const loading = signal(false);
  const pending = signal(false);
  const error = createText();
  let alive = true;
  let generation = 0;
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
    else {
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
  };
  const loadModels = async (restart = false) => {
    if (!active() || (!restart && (loading() || !page()?.next))) return;
    const reading = ++generation;
    const search = query();
    let changed = false;
    if (restart) {
      page.set(null);
      selected.set(0);
    }
    loading.set(true);
    error.set('');
    try {
      do {
        const previousPage = page();
        const result = await host.query(
          'settings',
          'models',
          previousPage?.next
            ? { kind: 'continue', revision: previousPage.revision, cursor: previousPage.next }
            : { kind: 'start', query: search },
        );
        if (!active() || reading !== generation) return;
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
      } while (active() && reading === generation);
    } catch (reason) {
      if (active() && reading === generation) error.set(errorText(reason));
    } finally {
      if (alive && reading === generation) loading.set(false);
    }
  };
  const retry = ({ instance, from }: { instance: number; from: Pane }) => {
    if (!active() || pending() || instance !== props.instance || pane() !== from) return;
    if (from === 'models') void loadModels(true);
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
          {tr('Models')}
        </Text>
        <Button
          disabled={pending()}
          accessibilityLabel={
            pane() === 'root' ? tr('Close model selection') : tr('Back to model settings')
          }
          onPress={
            pane() === 'root'
              ? inputAction(close, { instance: props.instance, from: pane() })
              : inputAction(changePane, { instance: props.instance, from: pane(), to: 'root' })
          }
          tooltip={pane() === 'root' ? tr('Close') : tr('Back')}
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
            numberOfLines={1}
            style={{
              ...captionTextStyle,
              color: C.muted,
              flex: 1,
              minWidth: 0,
              textAlign: 'right',
            }}
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
              numberOfLines={1}
              style={{
                ...captionTextStyle,
                color: C.muted,
                flex: 1,
                minWidth: 0,
                textAlign: 'right',
              }}
            >
              {effortCaption(owner.backend(), owner.modelDetails())}
            </Text>
            <Icon name="right" color={C.muted} />
          </Button>
        </If>
      </If>
      <If when={pane() === 'models'}>
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
                    <View pointerEvents="none" style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        numberOfLines={1}
                        style={{ ...captionTextStyle, color: C.text, fontSize: 14 }}
                      >
                        {choice().label}
                      </Text>
                      <Text numberOfLines={1} style={{ ...captionTextStyle, color: C.muted }}>
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
        <Text style={{ ...captionTextStyle, color: C.muted }}>
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
      <If when={pane() !== 'models' && owner.modelDetails().kind !== 'ready'}>
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
          <Text selectable style={{ ...captionTextStyle, color: C.danger }}>
            {error()}
          </Text>
        </Scroll>
        <If when={pane() === 'models'}>
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
