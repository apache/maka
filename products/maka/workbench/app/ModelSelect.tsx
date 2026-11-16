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
  inputAction,
  keymap,
  List,
  platform,
  Scroll,
  signal,
  Text,
  View,
  windowSize,
  type ListRef,
} from 'nsh';
import { Button, Input, Popover } from 'nsh/base';
import type { AgentModelsPage } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ConversationHandle } from '../../../../plugins/agent/conversations/ui/Conversation';
import { delayed } from './delayed';
import { useHost } from './host';
import { Icon } from './Icon';
import { tr } from './locale';
import {
  effectiveThinkingLevel,
  effortCaption,
  modelCaption,
  routeKey,
  sameBackend,
  sameRoute,
  thinkingLevel,
  withThinkingLevel,
  type BackendIdentity,
  type ModelBackend,
  type ModelChoice,
} from './modelSelection';
import { createText, errorText, UiError } from './text';
import {
  C,
  captionTextStyle,
  controlDisabledStyle,
  floatingStyle,
  menuDetailTextStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
  shortcut,
  textTooltip,
  toolbarControlStyle,
} from './ui';

type SelectionAction = {
  instance: number;
  sessionId: string;
  expected: BackendIdentity;
  backend: ModelBackend;
};
type EffortAction = SelectionAction & { level: string };
type ModelsPage = Pick<
  Extract<AgentModelsPage, { kind: 'ready' }>,
  'revision' | 'next' | 'choices'
>;
type ModelMenuHandle = { instance: number; cancel(): void; dismiss(): void };
type ModelTarget = { sessionId: string; instance: number | null };
type ModelOwner = Pick<
  ConversationHandle,
  'sessionId' | 'backend' | 'modelDetails' | 'refreshModel'
>;

const ROW = 32;
const noteStyle = () => ({
  ...menuDetailTextStyle,
  color: C.muted,
  paddingHorizontal: 8,
  paddingTop: 4,
  paddingBottom: 8,
});

export function ModelSelect(props: {
  owner: ModelOwner;
  running?(): boolean;
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
    return ({ open: next, reason }: { open: boolean; reason: string }) => {
      if (!props.current() || props.instance() !== instance) return;
      if (next) {
        if (instance === null) props.toggle({ sessionId: owner.sessionId, instance });
      } else if (instance !== null && menu?.instance === instance) {
        if (reason === 'cancel') menu.cancel();
        else menu.dismiss();
      }
    };
  });
  const model = () => {
    const details = owner.modelDetails();
    return details.kind === 'ready' && sameRoute(owner.backend(), details.choice.selection)
      ? details.choice.label
      : modelCaption(owner.backend(), details);
  };
  const effort = () => effortCaption(owner.backend(), owner.modelDetails());
  const tooltipLabel = () =>
    [modelCaption(owner.backend(), owner.modelDetails()), effort()].filter(Boolean).join(' · ');
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
        ...floatingStyle(),
        width: platform.idiom === 'terminal' ? 420 : 340,
        maxHeight: Math.min(380, Math.max(0, windowSize().height - 16)),
      }}
      trigger={
        <Button
          accessibilityLabel={tr(
            props.running?.() ? 'Model for queued and future messages' : 'Choose model and effort',
          )}
          tooltip={textTooltip(() =>
            props.instance() !== null
              ? undefined
              : `${tooltipLabel()} · ${shortcut(tr(props.running?.() ? 'Model for queued and future messages' : 'Choose model and effort'), 'mod+g')}`,
          )}
          style={{
            ...toolbarControlStyle,
            maxWidth: '100%',
            minWidth: 0,
            flexDirection: 'row',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: platform.idiom === 'terminal' ? 8 : 4,
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
          <Icon name="down" color={C.muted} />
        </Button>
      }
    >
      <If when={props.running?.()}>
        <Text style={noteStyle()}>{tr('Model for queued and future messages')}</Text>
      </If>
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
  owner: ModelOwner;
  instance: number;
  current(): boolean;
  close(instance: number): boolean;
  select(backend: ModelBackend): Promise<void>;
  manage(): void;
  attach(handle: ModelMenuHandle): void;
  detach(handle: ModelMenuHandle): void;
}) {
  const host = useHost();
  const owner = props.owner;
  const query = signal('');
  const page = signal<ModelsPage | null>(null);
  const choices = () => page()?.choices ?? [];
  const selected = signal(0);
  const loading = signal(false);
  const pending = signal(false);
  const saving = delayed(pending);
  const effortOpen = signal(false);
  const error = createText();
  let alive = true;
  let generation = 0;
  let modelsQueued = false;
  let removeSearchKeys = () => {};
  let list: ListRef | undefined;
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
      (choice.thinkingLevels.length > 0 || thinkingLevel(owner.backend()) != null)
    );
  };
  effect(() => {
    if (effortOpen() && owner.modelDetails().kind === 'ready' && !hasEffortControls())
      effortOpen.set(false);
  });

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
    effortOpen.set(false);
    if (sameBackend(request.backend, request.expected)) return;
    pending.set(true);
    error.set('');
    try {
      await props.select(request.backend);
    } catch (reason) {
      if (active()) error.set(errorText(reason, 'Could not change the model.'));
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
      choice.defaultThinkingLevel != null ||
      thinkingLevel(request.backend) !== null
    )
      return;
    void submit(request);
  };

  const loadModels = async (restart = false) => {
    if (!active() || (!restart && !page()?.next)) return;
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
              'agent',
              'models',
              previousPage?.next
                ? { kind: 'continue', revision: previousPage.revision, cursor: previousPage.next }
                : { kind: 'start', query: search },
            );
            if (!active() || reading !== generation) break;
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
            const nextChoices = [...(previousPage?.choices ?? []), ...result.choices];
            const currentIndex =
              !previousPage && !search
                ? nextChoices.findIndex((choice) => sameRoute(owner.backend(), choice.selection))
                : -1;
            batch(() => {
              page.set({
                revision: result.revision,
                next: result.next,
                choices: nextChoices,
              });
              if (currentIndex >= 0) selected.set(currentIndex);
            });
            break;
          } while (active() && reading === generation);
        } catch (reason) {
          if (active() && reading === generation) {
            modelsQueued = false;
            error.set(errorText(reason, 'Could not load models.'));
          }
        }
      } while (active() && modelsQueued);
    } finally {
      if (alive) loading.set(false);
    }
  };

  const retryCatalog = () => {
    if (active() && !pending()) void loadModels(true);
  };
  const retryPolicy = () => {
    if (active() && !pending()) void owner.refreshModel();
  };
  const index = () => Math.min(selected(), Math.max(0, choices().length - 1));
  const routeId = (choice: ModelChoice) => routeKey(choice.selection);
  const byId = computed(() => new Map(choices().map((choice) => [routeId(choice), choice])));
  const ids = computed(() => choices().map(routeId));
  const modelAction = (choice: ModelChoice) =>
    action(sameRoute(owner.backend(), choice.selection) ? owner.backend()! : choice.selection);
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
  const dismiss = () => {
    effortOpen.set(false);
    if (active()) props.close(props.instance);
  };
  const cancel = () => {
    if (effortOpen()) {
      effortOpen.set(false);
      return;
    }
    dismiss();
  };

  const handle: ModelMenuHandle = {
    instance: props.instance,
    cancel,
    dismiss,
  };
  props.attach(handle);
  cleanup(() => props.detach(handle));
  void owner.refreshModel();
  void loadModels(true);

  return (
    <View style={{ minHeight: 0, flexShrink: 1 }}>
      <View style={menuRowStyle()}>
        <Icon name="search" color={C.muted} />
        <Input
          ref={(node) => {
            removeSearchKeys();
            const unbind = [
              keymap.bind('up', () => move(-1), { when: 'always', repeat: true, within: node }),
              keymap.bind('down', () => move(1), { when: 'always', repeat: true, within: node }),
              keymap.bind('enter', activate, { when: 'always', within: node }),
              keymap.bind('escape', cancel, { when: 'always', within: node }),
            ];
            removeSearchKeys = () => unbind.forEach((remove) => remove());
          }}
          autoFocus
          accessibilityLabel={tr('Search models and sources')}
          value={query()}
          readonly={saving()}
          onChange={({ value: text }) => {
            batch(() => {
              query.set(text);
              selected.set(0);
            });
            list?.scrollToIndex({ index: 0, animated: false });
            void loadModels(true);
          }}
          placeholder={tr('Search models and sources…')}
          style={{
            ...captionTextStyle,
            flex: 1,
            minWidth: 0,
            color: C.text,
            placeholderColor: C.muted,
          }}
        />
      </View>
      <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
      <If when={choices().length > 0}>
        <List
          each={ids()}
          ref={(node) => {
            list = node;
          }}
          estimatedItemSize={ROW}
          onLoadMore={() => {
            if (!error()) void loadModels();
          }}
          style={{
            height: choices().length * ROW,
            minHeight: ROW,
            flexShrink: 1,
          }}
        >
          {(id) => (
            <Each<string> of={[id()]} key={(key: string) => key}>
              {(key) => {
                const initial = byId().get(key());
                if (!initial) return <View />;
                const choice = () => byId().get(key()) ?? initial;
                const checked = () => sameRoute(owner.backend(), choice().selection);
                return (
                  <Button
                    accessibilityLabel={tr('Use {model} · {connection}', {
                      model: choice().label,
                      connection: choice().sourceName,
                    })}
                    disabled={pending()}
                    selected={checked()}
                    onPress={inputAction(submit, modelAction(choice()))}
                    style={{
                      ...menuRowStyle(),
                      height: ROW,
                      backgroundColor:
                        choices()[index()] && routeId(choices()[index()]) === key()
                          ? C.floatingRaised
                          : undefined,
                    }}
                    hoverStyle={menuRowHoverStyle()}
                    focusStyle={menuRowHoverStyle()}
                    disabledStyle={saving() ? controlDisabledStyle : undefined}
                  >
                    <Icon name="bot" color={C.secondary} />
                    <View
                      style={[
                        {
                          flex: 1,
                          minWidth: 0,
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 8,
                        },
                        { pointerEvents: 'none' },
                      ]}
                    >
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.text, flexShrink: 0, maxWidth: '70%' },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {choice().label}
                      </Text>
                      <Text
                        style={[
                          { ...captionTextStyle, color: C.muted, flex: 1, minWidth: 0 },
                          { numberOfLines: 1 },
                        ]}
                      >
                        {choice().sourceName}
                      </Text>
                    </View>
                    <View style={[{ width: 16 }, { pointerEvents: 'none' }]}>
                      <If when={checked()}>
                        <Icon name="check" color={C.accent} />
                      </If>
                    </View>
                  </Button>
                );
              }}
            </Each>
          )}
        </List>
      </If>
      <If when={loading() && choices().length === 0}>
        <Text style={noteStyle()}>{tr('Loading…')}</Text>
      </If>
      <If when={!loading() && !error() && choices().length === 0}>
        <Text style={noteStyle()}>{tr('No models match this search.')}</Text>
      </If>
      <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
      <Popover
        open={effortOpen() && hasEffortControls()}
        onOpenChange={({ open }) => {
          if (!pending() && hasEffortControls()) effortOpen.set(open);
          else if (!open) effortOpen.set(false);
        }}
        placement="left"
        align="end"
        offset={8}
        margin={8}
        style={{ alignSelf: 'stretch' }}
        popupStyle={{
          ...floatingStyle(),
          width: 200,
          maxHeight: Math.min(280, Math.max(0, windowSize().height - 16)),
        }}
        trigger={
          <Button
            disabled={pending() || !hasEffortControls()}
            selected={effortOpen() && hasEffortControls()}
            accessibilityLabel={tr('Choose reasoning effort')}
            style={{
              ...menuRowStyle(),
              backgroundColor: effortOpen() && hasEffortControls() ? C.floatingRaised : undefined,
            }}
            hoverStyle={menuRowHoverStyle()}
            focusStyle={menuRowHoverStyle()}
            disabledStyle={!hasEffortControls() || saving() ? controlDisabledStyle : undefined}
          >
            <Icon name="thinking" color={C.secondary} />
            <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
              {tr('Reasoning effort')}
            </Text>
            <Text
              style={[{ ...captionTextStyle, color: C.muted, flexShrink: 1 }, { numberOfLines: 1 }]}
            >
              {hasEffortControls()
                ? effortCaption(owner.backend(), owner.modelDetails()) || tr('Default')
                : tr('Unsupported')}
            </Text>
            <Icon name="right" color={C.muted} />
          </Button>
        }
      >
        <Scroll style={{ minHeight: 0, flexShrink: 1 }}>
          <Each<ModelChoice>
            of={readyChoice() ? [readyChoice()!] : []}
            key={(choice: ModelChoice) => routeId(choice)}
          >
            {(item) => (
              <View>
                <Each<string> of={item().thinkingLevels} key={(level: string) => level}>
                  {(level) => {
                    const checked = () =>
                      effectiveThinkingLevel(owner.backend(), item()) === level();
                    return (
                      <Button
                        disabled={pending()}
                        accessibilityLabel={tr('Use effort {level}', { level: level() })}
                        selected={checked()}
                        onPress={inputAction(selectEffort, {
                          ...action(
                            withThinkingLevel(
                              owner.backend() ?? item().selection,
                              item().defaultThinkingLevel === level() ? null : level(),
                            ),
                          ),
                          level: level(),
                        })}
                        style={menuRowStyle()}
                        hoverStyle={menuRowHoverStyle()}
                        focusStyle={menuRowHoverStyle()}
                        disabledStyle={saving() ? controlDisabledStyle : undefined}
                      >
                        <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>
                          {level()}
                        </Text>
                        <View style={[{ width: 16 }, { pointerEvents: 'none' }]}>
                          <If when={checked()}>
                            <Icon name="check" color={C.accent} />
                          </If>
                        </View>
                      </Button>
                    );
                  }}
                </Each>
                <If
                  when={
                    item().defaultThinkingLevel == null && thinkingLevel(owner.backend()) != null
                  }
                >
                  <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
                  <Button
                    disabled={pending()}
                    accessibilityLabel={tr('Use provider settings')}
                    onPress={inputAction(
                      resetEffort,
                      action(withThinkingLevel(owner.backend() ?? item().selection, null)),
                    )}
                    style={menuRowStyle()}
                    hoverStyle={menuRowHoverStyle()}
                    focusStyle={menuRowHoverStyle()}
                    disabledStyle={saving() ? controlDisabledStyle : undefined}
                  >
                    <Text style={{ ...captionTextStyle, color: C.secondary, flex: 1 }}>
                      {tr('Use provider settings')}
                    </Text>
                  </Button>
                </If>
              </View>
            )}
          </Each>
        </Scroll>
      </Popover>
      <Button
        disabled={pending()}
        accessibilityLabel={tr('Manage models')}
        onPress={inputAction(props.manage, null)}
        style={menuRowStyle()}
        hoverStyle={menuRowHoverStyle()}
        focusStyle={menuRowHoverStyle()}
        disabledStyle={saving() ? controlDisabledStyle : undefined}
      >
        <Icon name="settings" color={C.secondary} />
        <Text style={{ ...captionTextStyle, color: C.text, flex: 1 }}>{tr('Manage models…')}</Text>
      </Button>
      <If when={owner.backend() !== null && owner.modelDetails().kind === 'unavailable'}>
        <Text style={noteStyle()}>
          {tr('The saved model policy is unavailable. Its selection is preserved.')}
        </Text>
        <Button
          disabled={pending()}
          onPress={retryPolicy}
          accessibilityLabel={tr('Retry model policy')}
          style={menuRowStyle()}
          hoverStyle={menuRowHoverStyle()}
          focusStyle={menuRowHoverStyle()}
          disabledStyle={saving() ? controlDisabledStyle : undefined}
        >
          <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
        </Button>
      </If>
      <If when={error()}>
        <Scroll
          accessibilityLabel={tr('Model selection error')}
          style={{ minHeight: 16, flexShrink: 1 }}
        >
          <Text style={[{ ...noteStyle(), color: C.danger }, { userSelect: 'text' }]}>
            {error()}
          </Text>
        </Scroll>
        <Button
          disabled={pending()}
          onPress={retryCatalog}
          accessibilityLabel={tr('Retry model catalog')}
          style={menuRowStyle()}
          hoverStyle={menuRowHoverStyle()}
          focusStyle={menuRowHoverStyle()}
          disabledStyle={saving() ? controlDisabledStyle : undefined}
        >
          <Text style={{ ...captionTextStyle, color: C.accent }}>{tr('Retry')}</Text>
        </Button>
      </If>
      <If when={saving()}>
        <Text style={noteStyle()}>{tr('Saving selection…')}</Text>
      </If>
    </View>
  );
}
