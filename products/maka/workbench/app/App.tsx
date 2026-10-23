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

import { createText, UiError, errorText, message as uiMessage } from './text';
import { applyLanguagePreference, tr } from './locale';
import { cleanup, effect, inputAction, mount, signal, Scroll, Text, View } from 'nsh';
import type { YNode } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { host } from './host';
import { keymap } from 'nsh/keymap';
import { bodyTextStyle, C, Header, controlStyle, controlHoverStyle, controlFocusStyle } from './ui';
import { Composer } from './Composer';
import { Conversation } from './Conversation';
import type { Control, ConversationHandle } from './Conversation';
import { Palette } from './Palette';
import type { PaletteEntry } from './Palette';
import { WorkspacePicker } from './WorkspacePicker';
import { ModelSelect } from './ModelSelect';
import { ModelSettings } from './ModelSettings';
import type { ModelBackend } from './modelSelection';
import { InteractionComposer, interactionOutcomeSummary } from './InteractionComposer';
import type { AgentInteractionResult } from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ImagePreview } from './ImageThumbnail';
import { createResources } from './resources';
import { createBrowsing } from './browsing';
import type { BrowserWorkspace } from './browsing';
import { Workbench, canDockBrowser } from './Workbench';
import { WorkspaceBrowser, type WorkspaceBrowserProps } from './WorkspaceBrowser';
import { applicationMenu, dialogTop } from './chrome';
import { performSessionAction, type SessionAction } from './sessionLifecycle';

type Overlay = {
  instance: number;
  kind: 'commands' | 'workspaces' | 'models' | 'sessions' | 'settings';
  sessionId: string | null;
};
type CommandContext = { instance: number; sessionId: string | null };
function App() {
  const browsing = createBrowsing();
  const selected = signal<string | null>(host.initialSession);
  const overlay = signal<Overlay | null>(null);
  const resources = createResources({ selected, blocked: () => overlay() !== null });
  const sidebarExpanded = signal(true);
  const browserFocus = signal(false);
  const error = createText();
  const status = createText();
  const switching = signal(false);
  const busy = signal(false);
  const controls = signal<any[]>([]);
  const controlsKnown = signal(false);
  const recovering = signal(false);
  const recoveredFork = signal<{ id: string; title: string } | null>(null);
  const handle = signal<ConversationHandle | null>(null);
  let editor: YNode | undefined;
  const focusComposer = () => editor?.focus();
  let browserRoot: YNode | undefined;
  let alive = true;
  let controlRead = 0;
  let overlayInstance = 0;
  cleanup(() => {
    alive = false;
  });
  const report = (reason: unknown) => {
    if (alive) error.set(errorText(reason));
  };
  const presentInteraction = (
    original: { sessionId: string; requestId: string },
    result: AgentInteractionResult,
  ) => {
    if (!alive || selected() !== original.sessionId) return false;
    if (result.kind === 'recorded') {
      const record = result.record;
      if (
        record.sessionId === original.sessionId &&
        record.requestId === original.requestId &&
        record.outcome
      ) {
        error.set('');
        status.set(interactionOutcomeSummary(record.outcome));
        return true;
      }
      report(new UiError('The Host returned a different or incomplete original request outcome.'));
    } else {
      report(
        new UiError('Answer was not accepted: {reason}. Refresh the request before trying again.', {
          reason: result.reason,
        }),
      );
    }
    return false;
  };
  const refreshControls = async () => {
    const reading = ++controlRead;
    const originals = await host.pendingControls();
    if (alive && reading === controlRead) {
      controls.set(originals);
      controlsKnown.set(true);
    }
  };
  const switchSession = async (id: string, expectedSessionId = selected()) => {
    if (!alive || selected() !== expectedSessionId || selected() === id || switching()) return;
    switching.set(true);
    try {
      if (handle() && !(await handle()!.flushDraft())) return;
      if (alive) {
        overlay.set(null);
        status.set('');
        selected.set(id);
      }
    } catch (reason) {
      report(reason);
    } finally {
      if (alive) switching.set(false);
    }
  };
  const returned = (reply: any) => {
    const receipt = reply?.receipt;
    if (receipt?.kind !== 'recorded' || receipt.outcome?.kind !== 'returned')
      throw new UiError('Confirmation is still unknown. Recover the original action below.');
    const value = receipt.outcome.value;
    return value;
  };
  const control: Control = async (method, input) => {
    if (method !== 'stop' && !controlsKnown())
      throw new UiError('Checking earlier actions. Try again in a moment.');
    const originals: any[] = method === 'stop' ? await host.pendingControls() : controls();
    const pending = originals.find(
      (original) =>
        (original.method === method ||
          (['metadata', 'changeSession', 'fork'].includes(method) &&
            ['metadata', 'changeSession', 'fork'].includes(original.method))) &&
        original.sessionId === (input.sessionId ?? null) &&
        (method !== 'stop' || original.correlation.invocationId === input.invocationId) &&
        (method !== 'respond' || original.correlation.requestId === input.requestId),
    );
    if (pending)
      throw new UiError(
        'This action has an unresolved original. Recover it below before trying again.',
      );
    if (method !== 'stop' && busy())
      throw new UiError('An action is being confirmed. Try again in a moment.');
    if (method !== 'stop') busy.set(true);
    try {
      const result = returned((await host.control(method, input)).reply);
      if (method === 'respond') presentInteraction(input, result);
      return result;
    } catch (reason) {
      if (method === 'respond' && selected() === input.sessionId) report(reason);
      throw reason;
    } finally {
      await refreshControls().catch((reason) => {
        controlsKnown.set(false);
        report(reason);
      });
      if (method !== 'stop' && alive) busy.set(false);
    }
  };
  const closeOverlay = (instance: number) => {
    if (!alive || overlay()?.instance !== instance) return false;
    if (overlay()?.kind === 'sessions') browserFocus.set(false);
    overlay.set(null);
    return true;
  };
  const open = ({
    kind,
    sessionId,
  }: {
    kind: 'commands' | 'workspaces' | 'models' | 'sessions' | 'settings';
    sessionId: string | null;
  }) => {
    if (!alive || selected() !== sessionId) return;
    if (kind === 'sessions' && canDockBrowser()) {
      resources.hide();
      status.set('');
      overlay.set(null);
      sidebarExpanded.set(true);
      browserFocus.set(true);
      return;
    }
    if (kind === 'models' && sessionId === null) {
      kind = 'settings';
    }
    status.set('');
    browserFocus.set(kind === 'sessions');
    overlay.set({ kind, sessionId, instance: ++overlayInstance });
  };
  const toggleModels = ({
    sessionId,
    instance,
  }: {
    sessionId: string;
    instance: number | null;
  }) => {
    if (!alive || selected() !== sessionId || handle()?.sessionId !== sessionId) return;
    const current = overlay();
    if (instance !== null) {
      if (current?.kind === 'models' && current.sessionId === sessionId) closeOverlay(instance);
    } else if (current?.kind !== 'models') open({ kind: 'models', sessionId });
  };
  const manageModels = ({ sessionId, instance }: { sessionId: string; instance: number }) => {
    if (
      alive &&
      selected() === sessionId &&
      handle()?.sessionId === sessionId &&
      closeOverlay(instance)
    )
      open({ kind: 'settings', sessionId });
  };
  const chooseModel = async (
    owner: ConversationHandle,
    instance: number,
    backend: ModelBackend,
  ) => {
    if (
      !alive ||
      selected() !== owner.sessionId ||
      handle() !== owner ||
      overlay()?.instance !== instance
    )
      throw new UiError('This model selection is no longer open.');
    const result = await control('selectBackend', {
      sessionId: owner.sessionId,
      backend: { kind: 'model', ...backend },
    });
    if (result.kind !== 'committed')
      throw new UiError('Model selection rejected: {reason}', {
        reason: result.reason ?? result.kind,
      });
    await owner.refresh();
  };
  const create = async (workspace: BrowserWorkspace, expectedSessionId = selected()) => {
    if (!alive || selected() !== expectedSessionId) return;
    try {
      error.set('');
      const result = await control('create', {
        title: tr('New conversation'),
        automaticTitle: true,
        labels: [],
        workspace,
      });
      if (!alive) return;
      if (result.kind !== 'created')
        throw new UiError('Conversation creation rejected: {reason}', {
          reason: result.reason ?? result.kind,
        });
      await switchSession(result.session.id, expectedSessionId);
      if (selected() === result.session.id) open({ kind: 'models', sessionId: result.session.id });
      await browsing.refresh();
    } catch (reason) {
      report(reason);
    }
  };
  const newConversation = (sessionId: string | null) => {
    if (!alive || selected() !== sessionId) return;
    if (sessionId) void create({ kind: 'session', sessionId }, sessionId);
    else open({ kind: 'workspaces', sessionId });
  };
  const removeSelected = async (sessionId: string) => {
    const scope = browsing.scope();
    if (scope.kind === 'workspace' && scope.sessionId === sessionId)
      browsing.setScope({ kind: 'all' });
    const owner = handle();
    if (!alive || selected() !== sessionId || owner?.sessionId !== sessionId) return;
    if (!(await owner.flushDraft()))
      throw new UiError(
        'The conversation was deleted, but its latest draft is not saved. Return to the draft to check its status.',
      );
    if (alive && selected() === sessionId && handle() === owner) {
      overlay.set(null);
      selected.set(null);
    }
  };
  const changeBrowsedSession = async (action: SessionAction, origin: string | null) => {
    if (!alive || selected() !== origin || switching() || busy())
      throw new UiError('This conversation action is no longer current.');
    const owner = handle();
    if (
      action.kind === 'remove' &&
      owner?.sessionId === action.session.id &&
      !(await owner.flushDraft())
    )
      throw new UiError(
        'The draft is not ready to save. Return to the conversation before deleting it.',
      );
    if (!alive || selected() !== origin || handle() !== owner)
      throw new UiError('This conversation action is no longer current.');
    const result = await performSessionAction(control, action);
    if (!alive) return;
    if (result.kind === 'removed') await removeSelected(result.sessionId);
    else if (result.kind === 'forked') await switchSession(result.session.id, origin);
    else if (handle()?.sessionId === result.session.id) await handle()!.refresh();
    await browsing.refresh();
  };
  const stop = ({
    sessionId,
    invocationId,
  }: {
    sessionId: string | null;
    invocationId: string | null;
  }) => {
    const owner = handle();
    if (
      !alive ||
      overlay() ||
      !owner ||
      selected() !== sessionId ||
      owner.sessionId !== sessionId ||
      owner.invocation() !== invocationId
    )
      return;
    void owner.stop(invocationId).catch(report);
  };
  const stopAction = () =>
    inputAction(stop, {
      sessionId: selected(),
      invocationId: handle()?.invocation() ?? null,
    });
  const closeCommand = (context: CommandContext) =>
    alive &&
    selected() === context.sessionId &&
    (context.sessionId === null || handle()?.sessionId === context.sessionId) &&
    closeOverlay(context.instance);
  const commandSessions = (context: CommandContext) => {
    if (closeCommand(context)) open({ kind: 'sessions', sessionId: context.sessionId });
  };
  const commandNew = (context: CommandContext) => {
    if (closeCommand(context)) newConversation(context.sessionId);
  };
  const commandWorkspace = (context: CommandContext) => {
    if (closeCommand(context)) open({ kind: 'workspaces', sessionId: context.sessionId });
  };
  const commandModels = (context: CommandContext) => {
    if (closeCommand(context)) open({ kind: 'models', sessionId: context.sessionId });
  };
  const commandSettings = (context: CommandContext) => {
    if (closeCommand(context)) open({ kind: 'settings', sessionId: context.sessionId });
  };
  const commandFiles = (context: CommandContext) => {
    if (closeCommand(context) && context.sessionId)
      resources.openFiles({ sessionId: context.sessionId });
  };
  const openLink = async (sessionId: string, target: string, restoreFocus: () => boolean) => {
    if (!alive || selected() !== sessionId || overlay()) return;
    try {
      const link = await host.openLink(target);
      if (link && alive && selected() === sessionId && !overlay()) {
        resources.openFile({ sessionId, ...link, title: host.pathLabel(link.path) }, restoreFocus);
      }
    } catch (reason) {
      if (alive && selected() === sessionId)
        report(new UiError('Could not open link: {reason}', { reason: errorText(reason) }));
    }
  };
  const commandLatest = (context: CommandContext & { turnId: string | null }) => {
    if (closeCommand(context)) handle()?.jumpLatest(context.turnId);
  };
  const commandHistory = (context: CommandContext) => {
    if (closeCommand(context)) handle()?.focusHistory();
  };
  const commandActivity = (context: CommandContext & { turnId: string | null }) => {
    if (closeCommand(context)) handle()?.focusActivity(context.turnId);
  };
  const commandStop = (context: CommandContext & { invocationId: string | null }) => {
    if (closeCommand(context)) void handle()?.stop(context.invocationId).catch(report);
  };
  const commands = (context: CommandContext): PaletteEntry[] => [
    {
      id: 'sessions',
      title: tr('Sessions'),
      detail: tr('Resume a conversation'),
      hint: keymap.label('mod+o'),
      run: inputAction(commandSessions, context),
    },
    {
      id: 'new',
      title: tr('New conversation'),
      detail: tr('A fresh start in your workspace'),
      hint: keymap.label('mod+n'),
      run: inputAction(commandNew, context),
    },
    {
      id: 'workspace',
      title: tr('Choose workspace'),
      detail: tr('Start a conversation in another folder'),
      run: inputAction(commandWorkspace, context),
    },
    {
      id: 'models',
      title: tr('Models'),
      detail: tr('Choose the model for this conversation'),
      hint: keymap.label('mod+g'),
      run: inputAction(commandModels, context),
    },
    {
      id: 'settings',
      title: tr('Connections & models'),
      detail: tr('Add connections, API keys and models'),
      run: inputAction(commandSettings, context),
    },
    ...(context.sessionId
      ? [
          {
            id: 'files',
            title: tr('Files'),
            detail: tr('Browse workspace files and current changes'),
            run: inputAction(commandFiles, context),
          },
        ]
      : []),
    {
      id: 'latest',
      title: tr('Jump to latest'),
      detail: tr('Return to the newest messages'),
      hint: keymap.label('mod+l'),
      run: inputAction(commandLatest, {
        instance: context.instance,
        sessionId: context.sessionId,
        turnId: handle()?.sessionId === context.sessionId ? handle()!.activeTurn() : null,
      }),
    },
    {
      id: 'history-focus',
      title: tr('Focus conversation'),
      detail: tr('Scroll the whole conversation'),
      hint: keymap.label('alt+up'),
      run: inputAction(commandHistory, context),
    },
    {
      id: 'activity-focus',
      title: tr('Focus activity'),
      detail: tr('Read this turn’s independent activity panel'),
      hint: keymap.label('alt+down'),
      run: inputAction(commandActivity, {
        instance: context.instance,
        sessionId: context.sessionId,
        turnId: handle()?.sessionId === context.sessionId ? handle()!.activityTurn() : null,
      }),
    },
    {
      id: 'stop',
      title: tr('Stop'),
      detail: tr('Cancel the current run'),
      hint: 'Esc',
      run: inputAction(commandStop, {
        instance: context.instance,
        sessionId: context.sessionId,
        invocationId: handle()?.sessionId === context.sessionId ? handle()!.invocation() : null,
      }),
    },
  ];
  keymap.bind('mod+p', () => open({ kind: 'commands', sessionId: selected() }), { when: 'always' });
  keymap.bind('mod+o', () => open({ kind: 'sessions', sessionId: selected() }), { when: 'always' });
  keymap.bind('mod+g', () => open({ kind: 'models', sessionId: selected() }), { when: 'always' });
  keymap.bind('mod+n', () => newConversation(selected()), { when: 'always' });
  const jumpLatest = () => {
    if (handle()) handle()!.jumpLatest(handle()!.activeTurn());
  };
  keymap.bind('mod+l', jumpLatest, { when: 'always' });
  keymap.bind('alt+up', () => handle()?.focusHistory(), { when: 'always' });
  keymap.bind(
    'alt+down',
    () => {
      if (handle()) handle()!.focusActivity(handle()!.activityTurn());
    },
    { when: 'always' },
  );
  // The bindings above take the same keys first; the menu shows and offers them.
  applicationMenu({
    newConversation: () => newConversation(selected()),
    chooseWorkspace: () => open({ kind: 'workspaces', sessionId: selected() }),
    sessions: () => open({ kind: 'sessions', sessionId: selected() }),
    commands: () => open({ kind: 'commands', sessionId: selected() }),
    models: () => open({ kind: 'models', sessionId: selected() }),
    latest: jumpLatest,
    settings: () => open({ kind: 'settings', sessionId: selected() }),
  });
  const recoverControls = async () => {
    if (recovering()) return;
    recovering.set(true);
    error.set('');
    try {
      const originals = await host.pendingControls();
      let responseConfirmed = false;
      for (const original of originals) {
        if (!original.reference) continue;
        try {
          const reply = await host.recoverControl(original.id);
          if (!alive) return;
          const result = returned(reply);
          if (
            original.method === 'respond' &&
            original.sessionId &&
            original.correlation !== null &&
            typeof original.correlation === 'object' &&
            'requestId' in original.correlation &&
            typeof original.correlation.requestId === 'string'
          )
            responseConfirmed =
              presentInteraction(
                {
                  sessionId: original.sessionId,
                  requestId: original.correlation.requestId,
                },
                result,
              ) || responseConfirmed;
          if (
            original.method === 'changeSession' &&
            result.kind === 'removed' &&
            result.sessionId === original.sessionId
          )
            await removeSelected(result.sessionId);
          if (original.method === 'fork' && result.kind === 'forked')
            recoveredFork.set({ id: result.session.id, title: result.session.title });
          if (original.method === 'create' && result.kind === 'created') {
            await switchSession(result.session.id);
            if (selected() === result.session.id && !result.session.backend)
              open({ kind: 'models', sessionId: result.session.id });
          }
        } catch (reason) {
          report(reason);
        }
      }
      const owner = handle();
      if (owner && selected() === owner.sessionId) await owner.refresh();
      await browsing.refresh();
      if (!responseConfirmed) status.set(uiMessage('Original actions checked.'));
    } catch (reason) {
      report(reason);
    } finally {
      await refreshControls().catch(report);
      if (alive) recovering.set(false);
    }
  };
  const openRecoveredFork = ({ id, origin }: { id: string; origin: string | null }) =>
    selectBrowsed(id, origin);
  const abandonControl = async (id: string) => {
    try {
      await host.abandonControl(id);
      await refreshControls();
    } catch (reason) {
      report(reason);
    }
  };
  const previewImage = (image: ImagePreview) => {
    if (!alive || selected() !== image.source.read.sessionId || overlay()) return;
    browserFocus.set(false);
    resources.openImage(image);
  };
  const closeSidebar = () => {
    if (!alive || overlay()) return;
    sidebarExpanded.set(false);
    browserFocus.set(false);
    handle()?.focus();
  };
  const selectBrowsed = async (id: string, origin: string | null) => {
    const current = overlay();
    const instance = current?.kind === 'sessions' ? current.instance : null;
    await switchSession(id, origin);
    if (!alive || selected() !== id) return;
    if (instance !== null) closeOverlay(instance);
    browserFocus.set(false);
    handle()?.focus();
  };
  const browserProps: WorkspaceBrowserProps = {
    browsing,
    selected,
    switching: () => switching() || busy(),
    focusRequest: browserFocus,
    focusHandled: () => browserFocus.set(false),
    attach: (node) => {
      // Retain the identity across conditional unmount. Resize reads the
      // native focus path from before that presentation change.
      browserRoot = node;
    },
    close: closeSidebar,
    selectSession: selectBrowsed,
    changeSession: changeBrowsedSession,
    create,
    newConversation,
    settings: (sessionId) => open({ kind: 'settings', sessionId }),
  };
  let wasDocked = canDockBrowser();
  effect(() => {
    const docked = canDockBrowser();
    const current = overlay();
    if (docked && current?.kind === 'sessions') {
      closeOverlay(current.instance);
      sidebarExpanded.set(true);
      browserFocus.set(true);
    } else if (
      !docked &&
      wasDocked &&
      current === null &&
      browserRoot &&
      keymap.focusedWithin(browserRoot)
    ) {
      open({ kind: 'sessions', sessionId: selected() });
    }
    wasDocked = docked;
  });
  void host
    .query('settings', 'assistantPreferences', {})
    .then((preferences) => {
      if (alive) applyLanguagePreference(preferences.language ?? 'auto', preferences.revision);
    })
    .catch(report);
  void refreshControls().catch(report);
  return (
    <View style={{ flex: 1, backgroundColor: C.background }}>
      <Workbench
        expanded={() => sidebarExpanded() && overlay()?.kind !== 'sessions'}
        browser={browserProps}
        resources={resources}
      >
        <If when={selected() === null}>
          <View>
            <Header
              title=""
              commands={inputAction(open, { kind: 'commands', sessionId: null })}
              browse={inputAction(open, { kind: 'sessions', sessionId: null })}
            />
          </View>
        </If>
        <Each of={selected() ? [selected()!] : []} key={(id: string) => id}>
          {(id) => (
            <Conversation
              client={host.session(id())}
              control={control}
              fork={(action) => changeBrowsedSession(action, id())}
              commands={inputAction(open, { kind: 'commands', sessionId: id() })}
              browse={inputAction(open, { kind: 'sessions', sessionId: id() })}
              files={inputAction(resources.openFiles, { sessionId: id() })}
              filesOpener={(node) => resources.attachOpener(id(), node)}
              previewImage={previewImage}
              openLink={(target, restoreFocus) => openLink(id(), target, restoreFocus)}
              focusComposer={focusComposer}
              stopAction={stopAction}
              attach={(next) => {
                handle.set(next);
              }}
              detach={(previous) => {
                if (handle() === previous) handle.set(null);
              }}
            />
          )}
        </Each>
        <Composer
          session={handle}
          stopAction={stopAction}
          request={
            <View style={{ minHeight: 0, flexShrink: 1 }}>
              <Each<ConversationHandle>
                of={handle() ? [handle()!] : []}
                key={(owner: ConversationHandle) => owner.sessionId}
              >
                {(item) => {
                  const owner = item();
                  return (
                    <Each
                      of={owner.interactions().entries.slice(0, 1)}
                      key={(entry) => entry.requestId}
                    >
                      {(entry) => (
                        <InteractionComposer
                          sessionId={owner.sessionId}
                          requestId={entry().requestId}
                          control={control}
                          focusComposer={focusComposer}
                          confirming={() => busy() || !controlsKnown()}
                        />
                      )}
                    </Each>
                  );
                }}
              </Each>
              <If
                when={
                  error() ||
                  status() ||
                  switching() ||
                  busy() ||
                  !controlsKnown() ||
                  controls().length
                }
              >
                <Scroll
                  accessibilityLabel={tr('Action feedback')}
                  style={{
                    minHeight: bodyTextStyle.lineHeight + 16,
                    flexShrink: 1,
                    backgroundColor: C.surface,
                  }}
                  contentStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 8 }}
                >
                  <If when={error()}>
                    <Text selectable style={{ ...bodyTextStyle, color: C.danger }}>
                      {error()}
                    </Text>
                  </If>
                  <If when={switching() || busy()}>
                    <Text style={{ ...bodyTextStyle, color: C.muted }}>
                      {switching()
                        ? tr('Saving draft before switching…')
                        : tr('Confirming action…')}
                    </Text>
                  </If>
                  <If when={status()}>
                    <Text selectable style={{ ...bodyTextStyle, color: C.muted }}>
                      {status()}
                    </Text>
                  </If>
                  <If when={!controlsKnown() || controls().length > 0}>
                    <Button
                      disabled={recovering()}
                      onPress={inputAction(recoverControls, null)}
                      style={controlStyle}
                      hoverStyle={controlHoverStyle}
                      focusStyle={controlFocusStyle}
                    >
                      <Text style={{ ...bodyTextStyle, color: C.warning }}>
                        {recovering()
                          ? tr('Reading original action receipts…')
                          : controlsKnown()
                            ? tr('Recover original actions ({count})', { count: controls().length })
                            : tr('Recheck original actions')}
                      </Text>
                    </Button>
                    <Each
                      of={controls().filter((original) => !original.reference)}
                      key={(original) => original.id}
                    >
                      {(original) => (
                        <Button
                          onPress={inputAction(abandonControl, original().id)}
                          style={controlStyle}
                          hoverStyle={controlHoverStyle}
                          focusStyle={controlFocusStyle}
                        >
                          <Text style={{ ...bodyTextStyle, color: C.warning }}>
                            {tr('Abandon unconfirmed {method}', { method: original().method })} ·{' '}
                            {original().id.slice(0, 8)}
                          </Text>
                        </Button>
                      )}
                    </Each>
                  </If>
                </Scroll>
              </If>
            </View>
          }
          attach={(node) => {
            editor = node;
          }}
          commands={({ sessionId }) => open({ kind: 'commands', sessionId })}
          models={
            <Each<ConversationHandle>
              of={handle() ? [handle()!] : []}
              key={(owner: ConversationHandle) => owner.sessionId}
            >
              {(item) => {
                const owner = item();
                return (
                  <ModelSelect
                    owner={owner}
                    instance={() => {
                      const current = overlay();
                      return current?.kind === 'models' && current.sessionId === owner.sessionId
                        ? current.instance
                        : null;
                    }}
                    current={() => selected() === owner.sessionId && handle() === owner}
                    toggle={toggleModels}
                    close={closeOverlay}
                    manage={manageModels}
                    select={(instance, backend) => chooseModel(owner, instance, backend)}
                  />
                );
              }}
            </Each>
          }
          chooseWorkspace={inputAction(open, { kind: 'workspaces', sessionId: selected() })}
          settings={inputAction(open, { kind: 'settings', sessionId: selected() })}
        />
      </Workbench>
      <If when={recoveredFork()}>
        <Button
          onPress={inputAction(openRecoveredFork, { id: recoveredFork()!.id, origin: selected() })}
          style={{ ...controlStyle, alignSelf: 'flex-start' }}
          hoverStyle={controlHoverStyle}
          focusStyle={controlFocusStyle}
        >
          <Text style={{ color: C.accent }}>
            {tr('Open recovered fork')} · {recoveredFork()!.title}
          </Text>
        </Button>
      </If>
      <Each
        of={overlay() && overlay()!.kind !== 'models' ? [overlay()!] : []}
        key={(value: Overlay) => value.instance}
      >
        {(value) => {
          const current = value();
          const close = inputAction(closeOverlay, current.instance);
          if (current.kind === 'sessions')
            return (
              <Dialog
                animation="none"
                onOpenChange={() => closeOverlay(current.instance)}
                style={{
                  flex: 1,
                  justifyContent: 'center',
                  alignItems: 'center',
                  padding: 16,
                  paddingTop: dialogTop(16),
                  backgroundColor: '#00000099',
                }}
              >
                <View
                  style={{
                    width: '100%',
                    maxWidth: 640,
                    height: '100%',
                    maxHeight: 640,
                    backgroundColor: C.surface,
                    padding: 8,
                    borderWidth: 1,
                    borderColor: C.line,
                    borderRadius: 16,
                  }}
                >
                  <WorkspaceBrowser
                    {...browserProps}
                    docked={false}
                    close={() => closeOverlay(current.instance)}
                  />
                </View>
              </Dialog>
            );
          if (current.kind === 'settings')
            return (
              <ModelSettings
                close={() => closeOverlay(current.instance)}
                changed={() => {
                  const owner = handle();
                  if (
                    alive &&
                    selected() === current.sessionId &&
                    owner?.sessionId === current.sessionId
                  )
                    void owner.refreshModel().catch(report);
                }}
              />
            );
          if (current.kind === 'workspaces')
            return (
              <WorkspacePicker
                instance={current.instance}
                current={() =>
                  overlay()?.instance === current.instance && selected() === current.sessionId
                }
                close={closeOverlay}
                create={(workspace) => create(workspace, current.sessionId)}
              />
            );
          return (
            <Palette
              instance={current.instance}
              commands={commands({ instance: current.instance, sessionId: current.sessionId })}
              close={closeOverlay}
            />
          );
        }}
      </Each>
    </View>
  );
}
mount(App);
