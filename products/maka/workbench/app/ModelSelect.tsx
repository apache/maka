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
  availableSpeeds,
  effectiveThinkingLevel,
  effortCaption,
  modelCaption,
  routeKey,
  sameBackend,
  sameRoute,
  selectionForChoice,
  serviceTier,
  speedCaption,
  thinkingLevel,
  withThinkingLevel,
  type BackendIdentity,
  type ModelBackend,
  type ModelChoice,
} from './modelSelection';
import { SettingsSegmented } from './SettingsPage';
import { createText, errorText, UiError } from './text';
import { useToolbarCompact } from './composerToolbar';
import {
  C,
  captionTextStyle,
  composerToolbarChevronSize,
  composerToolbarControlStyle,
  controlDisabledStyle,
  floatingStyle,
  menuDetailTextStyle,
  menuRowHoverStyle,
  menuRowStyle,
  menuSeparatorStyle,
  shortcut,
  textTooltip,
} from './ui';

type SelectionAction = {
  instance: number;
  sessionId: string;
  expected: BackendIdentity;
  backend: ModelBackend;
  label?: string | null;
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
  select(instance: number, backend: ModelBackend, label?: string | null): Promise<void>;
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
    return details.kind === 'ready' && selectionForChoice(owner.backend(), details.choice)
      ? details.choice.label
      : modelCaption(owner.backend(), details);
  };
  const modifiers = () =>
    [
      effortCaption(owner.backend(), owner.modelDetails()),
      speedCaption(owner.backend(), owner.modelDetails()),
    ]
      .filter(Boolean)
      .join(' · ');
  const triggerLabel = () => {
    const suffix = useToolbarCompact() ? '' : modifiers();
    return suffix ? `${model()} · ${suffix}` : model();
  };
  const tooltipLabel = () =>
    [modelCaption(owner.backend(), owner.modelDetails()), modifiers()].filter(Boolean).join(' · ');
  return (
    <Popover
      open={props.instance() !== null}
      onOpenChange={changed()}
      placement="top"
      align="end"
      offset={8}
      margin={8}
      style={{ minWidth: 0, flexShrink: 1, maxWidth: '100%', alignItems: 'flex-end' }}
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
            ...composerToolbarControlStyle,
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
          <Text
            style={[
              {
                color: owner.backend() ? C.secondary : C.warning,
                fontSize: 13,
                minWidth: 0,
                flexShrink: 1,
              },
              { numberOfLines: 1, textOverflow: 'ellipsis' },
            ]}
          >
            {triggerLabel()}
          </Text>
          <Icon name="down" size={composerToolbarChevronSize} color={C.muted} />
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
              select={(backend, label) => props.select(instance, backend, label)}
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
  select(backend: ModelBackend, label?: string | null): Promise<void>;
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
  const refreshing = signal(false);
  const pending = signal(false);
  const saving = delayed(pending);
  const effortOpen = signal(false);
  const error = createText();
  let alive = true;
  let generation = 0;
  let modelsQueued = false;
  let restartQueued = false;
  let pageSearch = '';
  let subscription: { close(): Promise<void> } | null = null;
  let removeSearchKeys = () => {};
  let list: ListRef | undefined;
  cleanup(() => {
    alive = false;
    generation += 1;
    removeSearchKeys();
    void subscription?.close();
  });

  const active = () => alive && props.current();
  const readyChoice = () => {
    const details = owner.modelDetails();
    return details.kind === 'ready' && selectionForChoice(owner.backend(), details.choice)
      ? details.choice
      : null;
  };
  const speeds = computed(() => availableSpeeds(readyChoice()));
  const hasEffortControls = () => {
    const choice = readyChoice();
    return (
      choice !== null &&
      (choice.thinkingLevels.length > 0 ||
        thinkingLevel(selectionForChoice(owner.backend(), choice)) != null)
    );
  };
  effect(() => {
    if (effortOpen() && owner.modelDetails().kind === 'ready' && !hasEffortControls())
      effortOpen.set(false);
  });

  const action = (
    backend: ModelBackend,
    label: string | null = readyChoice()?.label ?? null,
  ): SelectionAction => ({
    instance: props.instance,
    sessionId: owner.sessionId,
    expected: owner.backend(),
    backend,
    label,
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
      await props.select(request.backend, request.label ?? null);
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
      !selectionForChoice(request.backend, choice) ||
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
      !selectionForChoice(request.backend, choice) ||
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
      restartQueued = true;
    }
    modelsQueued = true;
    if (loading()) return;
    loading.set(true);
    error.set('');
    try {
      do {
        modelsQueued = false;
        const reset = restartQueued;
        restartQueued = false;
        const reading = generation;
        const search = query();
        const sameSearch = search === pageSearch;
        const focused = () => (sameSearch ? choices()[index()] : undefined);
        const count = reset ? (sameSearch ? Math.max(16, choices().length) : 16) : 0;
        let previousPage = reset ? null : page();
        let changed = false;
        try {
          do {
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
              previousPage = null;
              continue;
            }
            const nextPage = {
              revision: result.revision,
              next: result.next,
              choices: [...(previousPage?.choices ?? []), ...result.choices],
            };
            refreshing.set(result.refreshing);
            if (
              nextPage.next &&
              (nextPage.choices.length < count ||
                (focused() &&
                  !nextPage.choices.some((choice) =>
                    sameRoute(focused()!.selection, choice.selection),
                  )))
            ) {
              previousPage = nextPage;
              continue;
            }
            const focus = focused()?.selection ?? (!search ? owner.backend() : null);
            const currentIndex = focus
              ? nextPage.choices.findIndex((choice) => selectionForChoice(focus, choice))
              : -1;
            batch(() => {
              page.set(nextPage);
              pageSearch = search;
              selected.set(
                currentIndex >= 0
                  ? currentIndex
                  : Math.min(selected(), Math.max(0, nextPage.choices.length - 1)),
              );
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

  void (async () => {
    try {
      const opened = await host.subscribe('agent', 'watchModels', {});
      if (!active()) {
        await opened.close();
        return;
      }
      subscription = opened;
      for (;;) {
        const result = await opened.next();
        if (!active() || result === null) break;
        if (result.kind !== 'ready') continue;
        refreshing.set(result.refreshing);
        if (page()?.revision !== result.revision) {
          void loadModels(true);
          void owner.refreshModel();
        }
      }
    } catch (reason) {
      if (active()) error.set(errorText(reason, 'Could not load models.'));
    }
  })();

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
    action(selectionForChoice(owner.backend(), choice) ?? choice.selection, choice.label);
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
                const checked = () => selectionForChoice(owner.backend(), choice()) !== null;
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
      <If
        when={(loading() || refreshing() || page() === null) && !error() && choices().length === 0}
      >
        <Text style={noteStyle()}>{tr('Loading…')}</Text>
      </If>
      <If
        when={page() !== null && !loading() && !refreshing() && !error() && choices().length === 0}
      >
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
                              selectionForChoice(owner.backend(), item()) ?? item().selection,
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
                    item().defaultThinkingLevel == null &&
                    thinkingLevel(selectionForChoice(owner.backend(), item())) != null
                  }
                >
                  <View style={[menuSeparatorStyle(), { pointerEvents: 'none' }]} />
                  <Button
                    disabled={pending()}
                    accessibilityLabel={tr('Use provider settings')}
                    onPress={inputAction(
                      resetEffort,
                      action(
                        withThinkingLevel(
                          selectionForChoice(owner.backend(), item()) ?? item().selection,
                          null,
                        ),
                      ),
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
      <If when={speeds().length > 0}>
        <SettingsSegmented
          label={tr('Speed')}
          value={serviceTier(owner.backend()) ?? ''}
          choices={[
            { value: '', title: tr('Default') },
            ...speeds().map((tier) => ({
              value: tier.id,
              title: tier.name,
            })),
          ]}
          disabled={pending()}
          change={(value) => {
            const current = owner.backend();
            if (current?.kind === 'model')
              void submit(action({ ...current, serviceTier: value || null }));
          }}
        />
      </If>
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
