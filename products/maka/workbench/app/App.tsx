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
import { applyLanguagePreference, currentLocale, tr } from './locale';
import { initializeUiScale, uiScale } from './uiScale';
import { cleanup, effect, inputAction, signal, Scroll, Text, View } from 'nsh';
import type { YNode, JSX } from 'nsh';
import { Button, Dialog } from 'nsh/base';
import { host } from './host';
import { keymap } from 'nsh';
import {
  bodyTextStyle,
  C,
  Header,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  type BrowserHeader,
} from './ui';
import { Composer } from './Composer';
import { Conversation } from './Conversation';
import type { Control, ConversationAnchor, ConversationHandle } from './Conversation';
import { RecallSearch, type RecallTarget } from './RecallSearch';
import { createForeground } from './activation';
import { Palette } from './Palette';
import type { CommandEntry, ComposerCommand } from './composerCommands';
import { WorkspacePicker } from './WorkspacePicker';
import { ModelSelect } from './ModelSelect';
import { CompactDialog } from './CompactDialog';
import { ModelSettings, type SettingsRoute } from './ModelSettings';
import type { ModelBackend } from './modelSelection';
import { InteractionComposer, interactionOutcomeSummary } from './InteractionComposer';
import { ComputerAppControls } from './ComputerAppControls';
import type {
  AgentInteractionResult,
  ModelSelection,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { ImagePreview } from './ImageThumbnail';
import { createResources } from './resources';
import { createBrowsing } from './browsing';
import type { BrowserWorkspace } from './browsing';
import { Workbench, canDockBrowser } from './Workbench';
import { WorkspaceBrowser, type WorkspaceBrowserProps } from './WorkspaceBrowser';
import { applicationMenu } from './chrome';
import { performSessionAction, type SessionAction } from './sessionLifecycle';
import { createTerminalInterrupt, TerminalInterrupt } from './TerminalInterrupt';
import { createWorkbenchPlugins, pluginContext, type PanelRoute } from './plugins/context';
import type {
  UiContext,
  UiExports,
  UiRootProps,
} from '../../../../packages/plugin-sdk/src/workbench.js';

type OverlayTarget = {
  sessionId: string | null;
} & (
  | { kind: 'commands' | 'workspaces' | 'sessions' | 'search' }
  | { kind: 'models'; focusOnClose?: 'composer' }
  | { kind: 'settings'; model?: ModelSelection }
  | { kind: 'compact'; owner: ConversationHandle; prompt?: string }
);
type Overlay = OverlayTarget & { instance: number };
type ActionContext = { instance: number | null; sessionId: string | null };
type RestoredUi = {
  sessionId: string | null;
  settings: SettingsRoute | null;
  panel: PanelRoute | null;
};
function App(
  props: UiRootProps<JSX.Element> & { bindReload(prepare: () => Promise<unknown>): () => void },
) {
  initializeUiScale();
  const browsing = createBrowsing();
  const foreground = createForeground();
  const restored = props.restored as RestoredUi | null;
  let settingsRoute = restored?.settings ?? null;
  const selected = signal<string | null>(
    restored === null ? host.initialSession : restored.sessionId,
  );
  const overlay = signal<Overlay | null>(
    restored?.settings ? { kind: 'settings', sessionId: selected(), instance: 1 } : null,
  );
  const reloading = props.runtime.reloading;
  effect(() => props.runtime.setLocale(currentLocale()));
  const resources = createResources({ selected, blocked: () => overlay() !== null || reloading() });
  const plugins = createWorkbenchPlugins(props.runtime, props.context, {
    sessionId: selected,
    showPanel() {
      resources.hide();
      overlay.set(null);
    },
    report: (reason) => report(reason),
    restorePanel: restored?.panel,
  });
  cleanup(
    props.bindReload(async () => {
      const owner = handle();
      if (owner && !(await owner.flushDraft()))
        throw new UiError(
          'Draft could not be saved or restored. Its existing contents are preserved.',
        );
      if (!alive || handle() !== owner) throw new UiError('Conversation navigation was cancelled.');
      return {
        sessionId: selected(),
        settings: overlay()?.kind === 'settings' ? settingsRoute : null,
        panel: plugins.panelRoute(),
      };
    }),
  );
  effect(() => {
    if (resources.shown()) {
      const panel = plugins.panel();
      if (panel) plugins.closePanel(panel.instance);
    }
  });
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
  let dropFiles: ((event: { uris: string[] }) => void) | null = null;
  let editor: YNode | undefined;
  const focusComposer = () => editor?.focus();
  let browserRoot: YNode | undefined;
  let alive = true;
  let controlRead = 0;
  let overlayInstance = restored?.settings ? 1 : 0;
  let pendingReveal: {
    sessionId: string;
    anchor: ConversationAnchor;
    current(): boolean;
    resolve(): void;
    reject(reason: unknown): void;
  } | null = null;
  cleanup(() => {
    alive = false;
    pendingReveal?.reject(new UiError('Conversation navigation was cancelled.'));
    pendingReveal = null;
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
  const switchSession = async (
    id: string,
    source: ActionContext = { sessionId: selected(), instance: overlay()?.instance ?? null },
    anchor?: ConversationAnchor,
  ): Promise<boolean> => {
    const current = () =>
      alive && selected() === source.sessionId && (overlay()?.instance ?? null) === source.instance;
    if (!current() || switching() || reloading()) return false;
    const owner = handle();
    if (selected() === id) {
      if (owner?.sessionId !== id) return false;
      if (anchor) await owner.reveal(anchor, current);
      return true;
    }
    switching.set(true);
    try {
      if (owner && !(await owner.flushDraft())) return false;
      if (!current() || handle() !== owner) return false;
      const revealed = anchor
        ? new Promise<void>((resolve, reject) => {
            pendingReveal = {
              sessionId: id,
              anchor,
              current: () => alive && selected() === id && overlay() === null,
              resolve,
              reject,
            };
          })
        : null;
      overlay.set(null);
      status.set('');
      selected.set(id);
      if (revealed) await revealed;
      return alive && selected() === id;
    } catch (reason) {
      if (current() || (alive && selected() === id && overlay() === null)) report(reason);
      return false;
    } finally {
      if (pendingReveal?.sessionId === id) pendingReveal = null;
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
    const urgent = method === 'stop' || method === 'stopComputerApp';
    if (!urgent && !controlsKnown())
      throw new UiError('Checking earlier actions. Try again in a moment.');
    const originals: any[] = urgent ? await host.pendingControls() : controls();
    const pending = originals.find(
      (original) =>
        (original.method === method ||
          (['metadata', 'changeSession', 'fork'].includes(method) &&
            ['metadata', 'changeSession', 'fork'].includes(original.method))) &&
        original.sessionId === (input.sessionId ?? null) &&
        (method !== 'stop' || original.correlation.invocationId === input.invocationId) &&
        (method !== 'stopComputerApp' || original.correlation.operationId === input.operationId) &&
        (method !== 'respond' || original.correlation.requestId === input.requestId),
    );
    if (pending)
      throw new UiError(
        'This action has an unresolved original. Recover it below before trying again.',
      );
    if (!urgent && busy())
      throw new UiError('An action is being confirmed. Try again in a moment.');
    if (!urgent) busy.set(true);
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
      if (!urgent && alive) busy.set(false);
    }
  };
  const closeOverlay = (instance: number) => {
    if (!alive || overlay()?.instance !== instance) return false;
    if (overlay()?.kind === 'sessions') browserFocus.set(false);
    overlay.set(null);
    return true;
  };
  const closeModels = (owner: ConversationHandle, instance: number) => {
    const current = overlay();
    if (
      current?.kind !== 'models' ||
      current.sessionId !== owner.sessionId ||
      selected() !== owner.sessionId ||
      handle() !== owner ||
      !closeOverlay(instance)
    )
      return false;
    if (current.focusOnClose === 'composer') owner.focus();
    return true;
  };
  const open = (request: OverlayTarget) => {
    const { sessionId } = request;
    if (!alive || selected() !== sessionId) return;
    if (request.kind === 'sessions') {
      resources.hide();
      status.set('');
      if (overlay()?.kind === 'sessions') {
        browserFocus.set(true);
        return;
      }
      if (canDockBrowser()) {
        overlay.set(null);
        sidebarExpanded.set(true);
        browserFocus.set(true);
        return;
      }
    }
    const target =
      request.kind === 'models' && sessionId === null
        ? { kind: 'settings' as const, sessionId }
        : request;
    if (target.kind === 'settings') settingsRoute = null;
    status.set('');
    browserFocus.set(target.kind === 'sessions');
    overlay.set({ ...target, instance: ++overlayInstance });
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
  const manageModels = ({
    sessionId,
    instance,
    model,
  }: {
    sessionId: string;
    instance: number;
    model?: ModelSelection;
  }) => {
    if (
      alive &&
      selected() === sessionId &&
      handle()?.sessionId === sessionId &&
      closeOverlay(instance)
    )
      open({ kind: 'settings', sessionId, model });
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
    const source = { sessionId: expectedSessionId, instance: overlay()?.instance ?? null };
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
      await switchSession(result.session.id, source);
      if (selected() === result.session.id)
        open({ kind: 'models', sessionId: result.session.id, focusOnClose: 'composer' });
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
    const source = { sessionId: origin, instance: overlay()?.instance ?? null };
    const result = await performSessionAction(control, action);
    if (!alive) return;
    if (result.kind === 'removed') await removeSelected(result.sessionId);
    else if (result.kind === 'forked') await switchSession(result.session.id, source);
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
  const closeCommand = (context: ActionContext) =>
    alive &&
    selected() === context.sessionId &&
    (context.sessionId === null || handle()?.sessionId === context.sessionId) &&
    (context.instance === null ? overlay() === null : closeOverlay(context.instance));
  const interrupt = createTerminalInterrupt({
    session: handle,
    blocked: () => overlay() !== null,
    report,
    dismissOverlay: () => {
      const current = overlay();
      return current !== null && closeOverlay(current.instance);
    },
  });
  const commandSessions = (context: ActionContext) => {
    if (closeCommand(context)) open({ kind: 'search', sessionId: context.sessionId });
  };
  const commandNew = (context: ActionContext) => {
    if (closeCommand(context)) newConversation(context.sessionId);
  };
  const commandWorkspace = (context: ActionContext) => {
    if (closeCommand(context)) open({ kind: 'workspaces', sessionId: context.sessionId });
  };
  const commandModels = (context: ActionContext) => {
    if (closeCommand(context)) open({ kind: 'models', sessionId: context.sessionId });
  };
  const commandSettings = (context: ActionContext) => {
    if (closeCommand(context)) open({ kind: 'settings', sessionId: context.sessionId });
  };
  const commandFiles = (context: ActionContext) => {
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
  const commandLatest = (context: ActionContext & { turnId: string | null }) => {
    if (closeCommand(context)) handle()?.jumpLatest(context.turnId);
  };
  const commandHistory = (context: ActionContext) => {
    if (closeCommand(context)) handle()?.focusHistory();
  };
  const commandActivity = (context: ActionContext & { turnId: string | null }) => {
    if (closeCommand(context)) handle()?.focusActivity(context.turnId);
  };
  const commandStop = (context: ActionContext & { invocationId: string | null }) => {
    if (closeCommand(context)) void handle()?.stop(context.invocationId).catch(report);
  };
  const commandResetScale = (context: ActionContext) => {
    if (closeCommand(context)) void uiScale.resetAndSave();
  };
  const commandCompact = async (context: ActionContext, prompt?: string) => {
    if (!closeCommand(context)) return false;
    const owner = handle();
    if (!owner) return false;
    open({ kind: 'compact', sessionId: owner.sessionId, owner, prompt });
    return true;
  };
  const commands = (context: ActionContext): CommandEntry[] => [
    ...(uiScale.supported
      ? [
          {
            id: 'interface-scale-reset',
            trigger: 'reset-scale',
            title: tr('Reset interface scale to 100%'),
            detail: tr('Interface scale'),
            hint: keymap.label('mod+alt+0'),
            run: inputAction(commandResetScale, context),
          },
        ]
      : []),
    {
      id: 'sessions',
      trigger: 'resume',
      title: tr('Sessions'),
      detail: tr('Resume a conversation'),
      hint: keymap.label('mod+o'),
      run: inputAction(commandSessions, context),
    },
    {
      id: 'new',
      trigger: 'new',
      title: tr('New conversation'),
      detail: tr('A fresh start in your workspace'),
      hint: keymap.label('mod+n'),
      run: inputAction(commandNew, context),
    },
    {
      id: 'workspace',
      trigger: 'workspace',
      title: tr('Choose workspace'),
      detail: tr('Start a conversation in another folder'),
      run: inputAction(commandWorkspace, context),
    },
    {
      id: 'models',
      trigger: 'model',
      title: tr('Models'),
      detail: tr('Choose the model for this conversation'),
      hint: keymap.label('mod+g'),
      run: inputAction(commandModels, context),
    },
    {
      id: 'settings',
      trigger: 'settings',
      title: tr('Connections & models'),
      detail: tr('Add connections, API keys and models'),
      run: inputAction(commandSettings, context),
    },
    ...(context.sessionId
      ? [
          {
            id: 'files',
            trigger: 'files',
            title: tr('Files'),
            detail: tr('Browse workspace files and current changes'),
            run: inputAction(commandFiles, context),
          },
        ]
      : []),
    ...(context.sessionId
      ? [
          {
            id: 'compact',
            trigger: 'compact',
            title: tr('Compact conversation'),
            detail: tr('Summarize context for the next request'),
            takesArgument: true,
            run: (prompt?: string) => commandCompact(context, prompt),
          },
        ]
      : []),
    {
      id: 'latest',
      trigger: 'latest',
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
      trigger: 'history',
      title: tr('Focus conversation'),
      detail: tr('Scroll the whole conversation'),
      hint: keymap.label('alt+up'),
      run: inputAction(commandHistory, context),
    },
    {
      id: 'activity-focus',
      trigger: 'activity',
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
      trigger: 'stop',
      title: tr('Stop'),
      detail: tr('Cancel the current run'),
      hint: 'Esc',
      run: inputAction(commandStop, {
        instance: context.instance,
        sessionId: context.sessionId,
        invocationId: handle()?.sessionId === context.sessionId ? handle()!.invocation() : null,
      }),
    },
    ...plugins.commands(context.sessionId).map((command) => ({
      ...command,
      run(argument?: string) {
        if (closeCommand(context)) return command.run(argument);
      },
    })),
  ];
  if (uiScale.supported) {
    keymap.bind('mod+0', () => void uiScale.resetAndSave(), { when: 'always' });
    keymap.bind('mod+alt+0', () => void uiScale.resetAndSave(), { when: 'always' });
  }
  keymap.bind('mod+p', () => open({ kind: 'commands', sessionId: selected() }), { when: 'always' });
  keymap.bind('mod+o', () => open({ kind: 'search', sessionId: selected() }), { when: 'always' });
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
              open({ kind: 'models', sessionId: result.session.id, focusOnClose: 'composer' });
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
  const sidebarShown = () =>
    overlay()?.kind === 'sessions' ||
    (sidebarExpanded() && canDockBrowser(resources.shown() || plugins.panel() !== null));
  const toggleSidebar = (request: { sessionId: string | null; expanded: boolean }) => {
    if (!alive || selected() !== request.sessionId || sidebarShown() !== request.expanded) return;
    const current = overlay();
    if (current && current.kind !== 'sessions') return;
    if (!request.expanded) {
      open({ kind: 'sessions', sessionId: request.sessionId });
      return;
    }
    if (current) closeOverlay(current.instance);
    if (current?.kind === 'sessions') handle()?.focus();
    else closeSidebar();
  };
  const browserHeader = (sessionId: string | null, foreground = false): BrowserHeader => ({
    expanded: sidebarShown(),
    hidden: overlay()?.kind === 'sessions' && !foreground,
    toggle: inputAction(toggleSidebar, { sessionId, expanded: sidebarShown() }),
  });
  const selectBrowsed = async (id: string, origin: string | null) => {
    const current = overlay();
    const instance = current?.kind === 'sessions' ? current.instance : null;
    await switchSession(id, { sessionId: origin, instance: current?.instance ?? null });
    if (!alive || selected() !== id) return;
    if (instance !== null) closeOverlay(instance);
    browserFocus.set(false);
    handle()?.focus();
  };
  const openRecalled = async (instance: number, origin: string | null, target: RecallTarget) => {
    if (!alive || overlay()?.instance !== instance || selected() !== origin) return false;
    const opened = await switchSession(
      target.sessionId,
      { sessionId: origin, instance },
      target.anchor,
    );
    if (!opened || !alive || selected() !== target.sessionId) return false;
    if (!target.anchor) handle()?.jumpLatest(null);
    browserFocus.set(false);
    return true;
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
    search: (sessionId) => open({ kind: 'search', sessionId }),
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
    <pluginContext.Provider value={plugins}>
      <View style={{ flex: 1, backgroundColor: C.background }}>
        <If when={plugins.updateError()}>
          <View
            style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, alignItems: 'center' }}
          >
            <Text style={{ ...bodyTextStyle, color: C.warning }}>
              {plugins.updateError() || tr('The interface update could not be completed.')}
            </Text>
            <Button
              accessibilityLabel={tr('Retry')}
              onPress={plugins.retryUpdates}
              style={controlStyle}
            >
              <Text style={{ ...bodyTextStyle, color: C.accent }}>{tr('Retry')}</Text>
            </Button>
          </View>
        </If>
        <Workbench
          dropFiles={(event) => dropFiles?.(event)}
          expanded={() => sidebarExpanded() && overlay()?.kind !== 'sessions'}
          browser={browserProps}
          resources={resources}
        >
          <If when={selected() === null}>
            <View>
              <Header
                title=""
                commands={inputAction(open, { kind: 'commands', sessionId: null })}
                browser={browserHeader(null)}
              />
            </View>
          </If>
          <Each of={selected() ? [selected()!] : []} key={(id: string) => id}>
            {(id) => (
              <Conversation
                client={host.session(id())}
                visible={() => selected() === id() && overlay() === null}
                foreground={foreground}
                control={control}
                fork={(action) => changeBrowsedSession(action, id())}
                commands={inputAction(open, { kind: 'commands', sessionId: id() })}
                browser={() => browserHeader(id())}
                files={inputAction(resources.openFiles, { sessionId: id() })}
                filesOpener={(node) => resources.attachOpener(id(), node)}
                previewImage={previewImage}
                openLink={(target, restoreFocus) => openLink(id(), target, restoreFocus)}
                focusComposer={focusComposer}
                stopAction={stopAction}
                attach={(next) => {
                  handle.set(next);
                  const request = pendingReveal;
                  if (request?.sessionId === next.sessionId) {
                    pendingReveal = null;
                    void next
                      .reveal(request.anchor, request.current)
                      .then(request.resolve, request.reject);
                  }
                }}
                detach={(previous) => {
                  if (handle() === previous) handle.set(null);
                }}
              />
            )}
          </Each>
          <Composer
            dropFiles={(drop) => {
              dropFiles = drop;
            }}
            blocked={reloading}
            active={() => overlay() === null && !reloading()}
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
                      <View style={{ minHeight: 0, flexShrink: 1, gap: 8 }}>
                        <ComputerAppControls
                          sessionId={owner.sessionId}
                          apps={owner.computerApps}
                          control={control}
                        />
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
                      </View>
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
                      <Text style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}>
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
                      <Text style={[{ ...bodyTextStyle, color: C.muted }, { userSelect: 'text' }]}>
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
                              ? tr('Recover original actions ({count})', {
                                  count: controls().length,
                                })
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
            commands={() =>
              commands({ instance: null, sessionId: selected() }).filter(
                (command): command is ComposerCommand => command.trigger !== undefined,
              )
            }
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
                      close={(instance) => closeModels(owner, instance)}
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
            onPress={inputAction(openRecoveredFork, {
              id: recoveredFork()!.id,
              origin: selected(),
            })}
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
            if (current.kind === 'compact')
              return (
                <CompactDialog
                  owner={current.owner}
                  prompt={current.prompt}
                  close={() => closeOverlay(current.instance)}
                />
              );
            if (current.kind === 'search')
              return (
                <RecallSearch
                  origin={current.sessionId}
                  open={(origin, target) => openRecalled(current.instance, origin, target)}
                  close={() => closeOverlay(current.instance)}
                />
              );
            if (current.kind === 'sessions')
              return (
                <Dialog
                  animation="none"
                  onOpenChange={() => closeOverlay(current.instance)}
                  style={{
                    flex: 1,
                    backgroundColor: '#00000099',
                  }}
                >
                  <View style={{ backgroundColor: C.background }}>
                    <Header
                      title={current.sessionId === null ? '' : tr('Sessions')}
                      commands={inputAction(open, {
                        kind: 'commands',
                        sessionId: current.sessionId,
                      })}
                      browser={browserHeader(current.sessionId, true)}
                    />
                  </View>
                  <View
                    style={{
                      width: '100%',
                      maxWidth: 640,
                      flex: 1,
                      minHeight: 0,
                      backgroundColor: C.surface,
                    }}
                  >
                    <WorkspaceBrowser
                      {...browserProps}
                      close={() => closeOverlay(current.instance)}
                    />
                  </View>
                </Dialog>
              );
            if (current.kind === 'settings')
              return (
                <ModelSettings
                  initial={settingsRoute}
                  routeChanged={(route) => {
                    settingsRoute = route;
                  }}
                  model={current.model}
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
                  changed={() => {
                    const owner = handle();
                    if (
                      alive &&
                      selected() === current.sessionId &&
                      owner?.sessionId === current.sessionId
                    )
                      void owner.refresh().catch(report);
                    if (alive) void browsing.refresh().catch(report);
                  }}
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
        <TerminalInterrupt state={interrupt} />
      </View>
    </pluginContext.Provider>
  );
}
export function activate(_context: UiContext): UiExports<JSX.Element> {
  const empty = async () => null;
  let prepareReload: () => Promise<unknown> = empty;
  return {
    root: {
      kind: 'root',
      render: (props) => (
        <App
          {...props}
          bindReload={(prepare) => {
            prepareReload = prepare;
            return () => {
              if (prepareReload === prepare) prepareReload = empty;
            };
          }}
        />
      ),
      prepareReload: () => prepareReload(),
    },
  };
}
