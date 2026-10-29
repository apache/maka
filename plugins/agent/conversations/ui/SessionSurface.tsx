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
  cleanup,
  computed,
  effect,
  inputAction,
  signal,
  Scroll,
  Text,
  View,
  keymap,
  platform,
  windowSize,
  type ViewRef,
  type JSX,
} from 'nsh';
import { Button, Dialog } from 'nsh/base';
import type { UiContext, UiHost } from '../../../../packages/plugin-sdk/src/workbench.js';
import type {
  AgentInteractionResult,
  ModelSelection,
  UiTarget,
} from '../../../../packages/plugin-sdk/src/generated/runtime.js';
import {
  composerViewContract,
  workspaceViewContract,
  settingsViewContract,
  type WorkspaceViewHandle,
  type ConversationShell,
  type ConversationNavigationInput,
  type ConversationSessionInput,
  type ConversationPreviewInput,
  type ConversationSessionHandle,
  type ComposerSession,
  type ComposerViewInput,
} from '../../../../packages/plugin-sdk/src/workbench-views.js';
import { delayed } from '../../../../products/maka/workbench/app/delayed';
import {
  createText,
  UiError,
  errorText,
  message as uiMessage,
} from '../../../../products/maka/workbench/app/text';
import { currentLocale, displayText, tr } from '../../../../products/maka/workbench/app/locale';
import type { Host } from '../../../../products/maka/workbench/app/host';
import {
  bodyTextStyle,
  C,
  Header,
  controlStyle,
  controlHoverStyle,
  controlFocusStyle,
  type BrowserHeader,
} from '../../../../products/maka/workbench/app/ui';
import {
  Conversation,
  type Control,
  type ConversationAnchor,
  type ConversationHandle,
} from './Conversation';
import {
  RecallSearch,
  type RecallTarget,
} from '../../../../products/maka/workbench/app/RecallSearch';
import { createForeground } from '../../../../products/maka/workbench/app/activation';
import { Icon } from '../../../../products/maka/workbench/app/Icon';
import { Palette } from '../../../../products/maka/workbench/app/Palette';
import type {
  CommandEntry,
  ComposerCommand,
} from '../../../../products/maka/workbench/app/composerCommands';
import { WorkspacePicker } from '../../../../products/maka/workbench/app/WorkspacePicker';
import { ModelSelect } from '../../../../products/maka/workbench/app/ModelSelect';
import { CompactDialog } from '../../../../products/maka/workbench/app/CompactDialog';
import type { ModelBackend } from '../../../../products/maka/workbench/app/modelSelection';
import {
  InteractionComposer,
  interactionOutcomeSummary,
} from '../../../../products/maka/workbench/app/InteractionComposer';
import { ComputerAppControls } from '../../../../products/maka/workbench/app/ComputerAppControls';
import type { ImagePreview } from '../../../../products/maka/workbench/app/ImageThumbnail';
import {
  createBrowsing,
  type BrowserWorkspace,
} from '../../../../products/maka/workbench/app/browsing';
import {
  WorkspaceBrowser,
  type WorkspaceBrowserProps,
} from '../../../../products/maka/workbench/app/WorkspaceBrowser';
import {
  applicationMenu,
  ownTitleBar,
  windowTitle,
} from '../../../../products/maka/workbench/app/chrome';
import {
  performSessionAction,
  type SessionAction,
} from '../../../../products/maka/workbench/app/sessionLifecycle';
import {
  createTerminalInterrupt,
  TerminalInterrupt,
} from '../../../../products/maka/workbench/app/TerminalInterrupt';
import { viewRuntimeContext } from '../../../../products/maka/workbench/app/plugins/viewContext';
import { projectComposerAttachments } from '../../../../products/maka/workbench/app/composerSession';
import { watchNotifications } from '../../../../products/maka/workbench/app/notifications';

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
export function createConversationUi(context: UiContext<UiHost, JSX.Element>, host: Host) {
  const runtime = context.runtime;
  effect(() => currentLocale.set(context.locale()));
  const shell = signal<ConversationShell | null>(null);
  const bind = (next: ConversationShell) => {
    if (shell() !== next) shell.set(next);
  };
  const browsing = createBrowsing(host);
  const foreground = createForeground();
  const selected = () => shell()?.sessionId() ?? null;
  const overlay = signal<Overlay | null>(null);
  const reloading = () => runtime.reloading() || (shell()?.blocked() ?? false);
  const workspace = signal<WorkspaceViewHandle | null>(null);
  const resources = {
    shown: () => workspace()?.shown() ?? false,
    hide: () => workspace()?.hide(),
    openFiles: (target: { sessionId: string }) => workspace()?.openFiles(target),
    openImage: (image: ImagePreview) => workspace()?.openImage(image),
    attachOpener: (sessionId: string, node: ViewRef) => workspace()?.attachOpener(sessionId, node),
    focused: () => workspace()?.focused() ?? false,
  };
  const sidebarExpanded = Object.assign(() => shell()?.sidebarShown() ?? false, {
    set(expanded: boolean) {
      if (expanded) shell()?.showSidebar();
      else shell()?.hideSidebar();
    },
  });
  const browserFocus = signal(false);
  const error = createText();
  const status = createText();
  const switching = signal(false);
  const busy = signal(false);
  // Shown only when saving a draft or confirming an action takes a while, so a
  // quick one does not flash the feedback row and move the page.
  const working = delayed(() => switching() || busy());
  const controls = signal<any[]>([]);
  const controlsKnown = signal(false);
  const recovering = signal(false);
  const recoveredFork = signal<{ id: string; title: string } | null>(null);
  // Shown once, in the fork just opened from a conversation action, until the
  // user leaves it: the switch is otherwise silent and the titles look alike.
  const forkNotice = signal<{ id: string; source: string; title: string } | null>(null);
  const handle = signal<ConversationHandle | null>(null);
  let dropFiles: ((event: { uris: string[] }) => void) | null = null;
  const fileDragging = signal(false);
  let editor: { focus(): void } | undefined;
  const composerSession = computed(() => {
    const owner = handle();
    return owner ? projectComposerSession(owner, host) : null;
  });
  const focusComposer = () => editor?.focus();
  let browserRoot: ViewRef | undefined;
  let alive = true;
  let controlRead = 0;
  let overlayInstance = 0;
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
  let observedSession: string | null = null;
  let wasVisible = false;
  effect(() => {
    const next = selected();
    if (next !== observedSession) {
      observedSession = next;
      overlay.set(null);
    }
    const visible = shell()?.visible() ?? false;
    const owner = handle();
    if (visible && !wasVisible && owner?.sessionId === next)
      void owner.refreshModel().catch(report);
    wasVisible = visible;
  });
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
    source: ActionContext = {
      sessionId: selected(),
      instance: overlay()?.instance ?? null,
    },
    anchor?: ConversationAnchor,
  ): Promise<boolean> => {
    const current = () =>
      alive && selected() === source.sessionId && (overlay()?.instance ?? null) === source.instance;
    if (!current() || switching() || reloading()) return false;
    if (forkNotice() && forkNotice()!.id !== id) forkNotice.set(null);
    const owner = handle();
    const sourceOverlay = overlay();
    if (selected() === id) {
      if (owner?.sessionId !== id) return false;
      if (anchor) await owner.reveal(anchor, current);
      return true;
    }
    switching.set(true);
    try {
      const revealed = anchor
        ? new Promise<void>((resolve, reject) => {
            pendingReveal = {
              sessionId: id,
              anchor,
              current: () =>
                alive && selected() === id && (overlay() === null || overlay() === sourceOverlay),
              resolve,
              reject,
            };
          })
        : null;
      const committed = await shell()!.openSession(id);
      if (!committed) return false;
      if (overlay() === sourceOverlay) overlay.set(null);
      status.set('');
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
          (['metadata', 'changeSession', 'fork', 'setCompactionPrompt'].includes(method) &&
            ['metadata', 'changeSession', 'fork', 'setCompactionPrompt'].includes(
              original.method,
            ))) &&
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
    if (!(shell()?.visible() ?? false) && !shell()?.dismissRoute()) return;
    if (request.kind === 'sessions') {
      resources.hide();
      status.set('');
      if (overlay()?.kind === 'sessions') {
        browserFocus.set(true);
        return;
      }
      if (shell()?.sidebarDocked()) {
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
    if (target.kind === 'settings') {
      overlay.set(null);
      shell()?.openSettings(target.model);
      return;
    }
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
    const source = {
      sessionId: expectedSessionId,
      instance: overlay()?.instance ?? null,
    };
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
        open({
          kind: 'models',
          sessionId: result.session.id,
          focusOnClose: 'composer',
        });
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
    if (!(await shell()!.openSession(null)))
      throw new UiError(
        'The conversation was deleted, but its latest draft is not saved. Return to the draft to check its status.',
      );
  };
  // Text a fork made to edit a message or regenerate a reply puts in its draft (and sends),
  // taken once by its Conversation.
  const prefills = new Map<string, { text: string; send: boolean }>();
  const changeBrowsedSession = async (
    action: SessionAction,
    origin: string | null,
    prefill?: { text: string; send: boolean },
  ): Promise<boolean> => {
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
    if (!alive) return false;
    let opened = false;
    if (result.kind === 'removed') await removeSelected(result.sessionId);
    else if (result.kind === 'forked') {
      if (prefill !== undefined) prefills.set(result.session.id, prefill);
      opened = await switchSession(result.session.id, source);
      if (!opened) prefills.delete(result.session.id);
      else
        forkNotice.set({
          id: result.session.id,
          source: action.session.id,
          title: action.session.title || tr('Untitled conversation'),
        });
    } else if (handle()?.sessionId === result.session.id) await handle()!.refresh();
    await browsing.refresh();
    return opened;
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
      !(shell()?.visible() ?? false) ||
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
    blocked: () => overlay() !== null || !(shell()?.visible() ?? false),
    report,
    dismissOverlay: () => {
      const current = overlay();
      return current !== null ? closeOverlay(current.instance) : (shell()?.dismissRoute() ?? false);
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
    await workspace()?.openLink(sessionId, target, restoreFocus);
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
  const commandCompact = async (context: ActionContext, prompt?: string) => {
    if (!closeCommand(context)) return false;
    const owner = handle();
    if (!owner) return false;
    open({ kind: 'compact', sessionId: owner.sessionId, owner, prompt });
    return true;
  };
  const ownedContributions = computed(
    () =>
      new Map(
        runtime
          .contributions()
          .filter(
            (item) => JSON.stringify(item.instance.instance) === JSON.stringify(context.instance),
          )
          .map((item) => [item.id, item]),
      ),
  );
  const invokeCommand = ({
    id,
    sessionId,
    argument,
  }: {
    id: string;
    sessionId: string | null;
    argument?: string;
  }) => {
    if (selected() !== sessionId) return;
    const contribution = ownedContributions().get(id);
    const originalOverlay = overlay();
    if (contribution)
      void runtime
        .invoke(
          contribution,
          { sessionId, argument },
          () => selected() === sessionId && overlay() === originalOverlay,
        )
        .catch(report);
  };
  const invokeOwn = (id: string, argument?: string) =>
    invokeCommand({ id, sessionId: selected(), argument });
  const changeTextSize = (step: number) => {
    const settings = runtime.view(context.configuration.settings as UiTarget, settingsViewContract);
    const command = runtime
      .contributions()
      .find(
        (item) =>
          item.id === 'appearanceTextSize' &&
          JSON.stringify(item.instance.instance) === JSON.stringify(settings.instance.instance),
      );
    if (command)
      void runtime
        .invoke(command, { sessionId: selected(), argument: step > 0 ? '+1' : String(step) })
        .catch(report);
  };
  keymap.bind('mod+p', () => invokeOwn('commands'), { when: 'always' });
  keymap.bind('mod+o', () => invokeOwn('sessions'), { when: 'always' });
  if (ownTitleBar) keymap.bind('mod+f', () => invokeOwn('sessions'), { when: 'always' });
  keymap.bind('mod+g', () => invokeOwn('models'), { when: 'always' });
  keymap.bind('mod+n', () => invokeOwn('new'), { when: 'always' });
  keymap.bind('mod+l', () => invokeOwn('latest'), { when: 'always' });
  if (ownTitleBar) {
    keymap.bind('mod+shift+]', () => stepSession(1), { when: 'always' });
    keymap.bind('mod+shift+[', () => stepSession(-1), { when: 'always' });
  }
  keymap.bind('alt+up', () => invokeOwn('history-focus'), { when: 'always' });
  keymap.bind('alt+down', () => invokeOwn('activity-focus'), {
    when: 'always',
  });
  windowTitle(() => handle()?.title() ?? null);
  watchNotifications({
    sessions: browsing.sessions,
    foreground,
    open: (sessionId) => void selectBrowsed(sessionId, selected()),
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
            recoveredFork.set({
              id: result.session.id,
              title: result.session.title,
            });
          if (original.method === 'create' && result.kind === 'created') {
            await switchSession(result.session.id);
            if (selected() === result.session.id && !result.session.backend)
              open({
                kind: 'models',
                sessionId: result.session.id,
                focusOnClose: 'composer',
              });
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
  const openBrowsed = ({ id, origin }: { id: string; origin: string | null }) =>
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
    if (!alive || !(shell()?.visible() ?? false) || overlay()) return;
    sidebarExpanded.set(false);
    browserFocus.set(false);
    handle()?.focus();
  };
  const sidebarShown = () =>
    overlay()?.kind === 'sessions' || (sidebarExpanded() && (shell()?.sidebarDocked() ?? false));
  const toggleSidebar = (request: { sessionId: string | null; expanded: boolean }) => {
    if (
      !alive ||
      !(shell()?.visible() ?? false) ||
      selected() !== request.sessionId ||
      sidebarShown() !== request.expanded
    )
      return;
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
  const navigationDocked = () =>
    (shell()?.sidebarShown() ?? false) &&
    (shell()?.sidebarDocked() ?? false) &&
    overlay()?.kind !== 'sessions';
  const browserHeader = (sessionId: string | null, foreground = false): BrowserHeader => ({
    navigationDocked: navigationDocked(),
    previewDocked: shell()?.previewDocked() ?? false,
    expanded: sidebarShown(),
    hidden: overlay()?.kind === 'sessions' && !foreground,
    toggle: inputAction(toggleSidebar, { sessionId, expanded: sidebarShown() }),
  });
  // The bindings above take the same keys first; the menu shows and offers them.
  applicationMenu({
    newConversation: () => invokeOwn('new'),
    chooseWorkspace: () => invokeOwn('workspace'),
    sessions: () => invokeOwn('browse'),
    search: () => invokeOwn('sessions'),
    commands: () => invokeOwn('commands'),
    models: () => invokeOwn('models'),
    latest: () => invokeOwn('latest'),
    nextSession: () => stepSession(1),
    previousSession: () => stepSession(-1),
    settings: () => invokeOwn('settings'),
    sidebarShown,
    toggleSidebar: () => toggleSidebar({ sessionId: selected(), expanded: sidebarShown() }),
    textSize: changeTextSize,
  });
  // The conversation below (1) or above (-1) the open one in the session browser.
  const stepSession = (step: 1 | -1) => {
    const current = overlay();
    if (switching() || busy() || (current && current.kind !== 'sessions')) return;
    const rows = browsing.sessions();
    const index = rows.findIndex((session) => session.id === selected());
    const next = rows[index === -1 ? 0 : index + step];
    if (next && next.id !== selected()) void selectBrowsed(next.id, selected());
  };
  const selectBrowsed = async (id: string, origin: string | null) => {
    const current = overlay();
    const instance = current?.kind === 'sessions' ? current.instance : null;
    await switchSession(id, {
      sessionId: origin,
      instance: current?.instance ?? null,
    });
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
    docked: navigationDocked,
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
    newConversation: (sessionId) => invokeCommand({ id: 'new', sessionId }),
    settings: (sessionId) => invokeCommand({ id: 'settings', sessionId }),
    search: (sessionId) => invokeCommand({ id: 'sessions', sessionId }),
  };
  let wasDocked = shell()?.sidebarDocked();
  let previousWidth = windowSize().width;
  effect(() => {
    const width = windowSize().width;
    const docked = shell()?.sidebarDocked();
    const current = overlay();
    const visible = shell()?.visible() ?? false;
    if (visible && docked && current?.kind === 'sessions') {
      closeOverlay(current.instance);
      sidebarExpanded.set(true);
      browserFocus.set(true);
    } else if (
      visible &&
      width < previousWidth &&
      !docked &&
      wasDocked &&
      current === null &&
      browserRoot &&
      keymap.focusedWithin(browserRoot)
    ) {
      open({ kind: 'sessions', sessionId: selected() });
    }
    wasDocked = docked;
    previousWidth = width;
  });
  void refreshControls().catch(report);
  // Whether the Host has no model connection, read each time the composer is
  // shown again (back from Settings, too): the start pane then asks for one.
  const noConnections = signal(false);
  let connectionRead = 0;
  effect(() => {
    if (overlay() !== null || !(shell()?.visible() ?? false)) return;
    const read = ++connectionRead;
    void host
      .query('settings', 'connections', { kind: 'start' })
      .then((result) => {
        if (!alive || read !== connectionRead || result.kind === 'changed') return;
        noConnections.set(result.connections.length === 0 && result.next === null);
      })
      .catch(() => undefined);
  });
  const composerTarget = context.configuration.composer as UiTarget;
  const ComposerView = (input: ComposerViewInput<JSX.Element>) =>
    runtime.renderView(composerTarget, composerViewContract, input);
  const commandCandidates = computed(() =>
    runtime
      .contributions()
      .flatMap((contribution) => {
        const declaration = contribution.declaration;
        if (declaration.kind !== 'command') return [];
        return [
          {
            contribution,
            order: declaration.order,
            metadata: {
              id: contribution.key,
              title: displayText(declaration.title),
              detail: declaration.description
                ? displayText(declaration.description)
                : contribution.instance.path.join(' / '),
              trigger:
                declaration.trigger ??
                `plugin:${contribution.instance.path.join(':')}:${contribution.id}`,
              hint: declaration.hint
                ? displayText(declaration.hint)
                : declaration.shortcut
                  ? keymap.label(declaration.shortcut)
                  : undefined,
              takesArgument: declaration.takesArgument,
            },
          },
        ];
      })
      .sort((left, right) => {
        if (left.order == null) return right.order == null ? 0 : 1;
        if (right.order == null) return -1;
        return left.order - right.order;
      }),
  );
  const commands = (source: ActionContext): CommandEntry[] => {
    const expectedOwner = handle();
    const expectedInvocation = expectedOwner?.invocation() ?? null;
    return commandCandidates().flatMap<CommandEntry>(({ contribution, metadata }) => {
      if (!runtime.commandEnabled(contribution, { sessionId: source.sessionId })) return [];
      return [
        {
          ...metadata,
          async run(argument?: string) {
            if (!closeCommand(source)) return false;
            try {
              return await runtime.invoke(
                contribution,
                { sessionId: source.sessionId, argument },
                () =>
                  selected() === source.sessionId &&
                  overlay() === null &&
                  (contribution.id !== 'stop' ||
                    ownedContributions().get('stop')?.key !== contribution.key ||
                    (handle() === expectedOwner &&
                      expectedOwner?.invocation() === expectedInvocation)),
              );
            } catch (reason) {
              report(reason);
              return false;
            }
          },
        },
      ];
    });
  };
  const composerCommands = computed(() =>
    commands({ instance: null, sessionId: selected() }).filter(
      (command): command is ComposerCommand => command.trigger !== undefined,
    ),
  );
  const sessionHandle: ConversationSessionHandle = {
    async leave() {
      const owner = handle();
      const origin = selected();
      const originalOverlay = overlay();
      const visible = shell()?.visible();
      if (owner && !(await owner.flushDraft())) return false;
      return (
        alive &&
        handle() === owner &&
        selected() === origin &&
        overlay() === originalOverlay &&
        shell()?.visible() === visible
      );
    },
  };
  const previewHandle = {
    shown: resources.shown,
    close: () => workspace()?.close(),
    focused: resources.focused,
    modalSuppressed: () => workspace()?.modalSuppressed() ?? false,
  };
  return {
    sessionId: selected,
    navigation(input: ConversationNavigationInput) {
      bind(input.shell);
      return <WorkspaceBrowser {...browserProps} />;
    },
    preview(input: ConversationPreviewInput) {
      bind(input.shell);
      input.attach(previewHandle);
      return runtime.renderView(
        context.configuration.workspace as UiTarget,
        workspaceViewContract,
        {
          selected,
          blocked: () => overlay() !== null || reloading() || !(shell()?.visible() ?? false),
          get docked() {
            return input.docked;
          },
          get surface() {
            return input.surface;
          },
          report,
          attach: (next) => {
            if (workspace() !== next) workspace.set(next);
          },
        },
      );
    },
    session(input: ConversationSessionInput) {
      bind(input.shell);
      input.attach(sessionHandle);
      return (
        <viewRuntimeContext.Provider value={runtime}>
          <View
            onFileDrop={(event) => {
              fileDragging.set(false);
              dropFiles?.(event);
            }}
            onFileDragEnter={() => fileDragging.set(true)}
            onFileDragLeave={() => fileDragging.set(false)}
            style={{ flex: 1, minHeight: 0 }}
          >
            <If when={selected() === null}>
              <View>
                <Header
                  title=""
                  commands={inputAction(invokeCommand, {
                    id: 'commands',
                    sessionId: null,
                  })}
                  browser={browserHeader(null)}
                />
              </View>
            </If>
            <Each of={selected() ? [selected()!] : []} key={(id: string) => id}>
              {(id) => (
                <Conversation
                  client={host.session(id())}
                  visible={() =>
                    selected() === id() && overlay() === null && (shell()?.visible() ?? false)
                  }
                  foreground={foreground}
                  control={control}
                  fork={(action) => changeBrowsedSession(action, id())}
                  edit={(action, text, send) => changeBrowsedSession(action, id(), { text, send })}
                  takePrefill={() => {
                    const prefill = prefills.get(id()) ?? null;
                    prefills.delete(id());
                    return prefill;
                  }}
                  commands={inputAction(invokeCommand, {
                    id: 'commands',
                    sessionId: id(),
                  })}
                  browser={() => browserHeader(id())}
                  files={
                    workspace()
                      ? inputAction(invokeCommand, { id: 'files', sessionId: id() })
                      : undefined
                  }
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
                    if (handle() === previous) {
                      handle.set(null);
                    }
                  }}
                />
              )}
            </Each>
            <ComposerView
              dropFiles={(drop) => {
                dropFiles = drop;
              }}
              fileDragging={fileDragging}
              blocked={reloading}
              active={() => overlay() === null && !reloading() && (shell()?.visible() ?? false)}
              session={composerSession}
              stopAction={stopAction}
              needsConnection={noConnections}
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
                      working() ||
                      !controlsKnown() ||
                      controls().length ||
                      forkNotice()?.id === selected()
                    }
                  >
                    <Scroll
                      accessibilityLabel={tr('Action feedback')}
                      style={{
                        minHeight: bodyTextStyle.lineHeight + 16,
                        flexShrink: 1,
                        backgroundColor: C.surface,
                        // A card of its own on the desktop: square corners
                        // flush on the composer's rounded top read as notches.
                        ...(platform.isTerminal ? {} : { borderRadius: 8, marginBottom: 8 }),
                      }}
                      contentStyle={{
                        paddingHorizontal: 16,
                        paddingVertical: 8,
                        gap: 8,
                      }}
                    >
                      <If when={error()}>
                        <Text
                          style={[{ ...bodyTextStyle, color: C.danger }, { userSelect: 'text' }]}
                        >
                          {error()}
                        </Text>
                      </If>
                      <If when={working()}>
                        <Text style={{ ...bodyTextStyle, color: C.muted }}>
                          {switching()
                            ? tr('Saving draft before switching…')
                            : tr('Confirming action…')}
                        </Text>
                      </If>
                      <If when={status()}>
                        <Text
                          style={[{ ...bodyTextStyle, color: C.muted }, { userSelect: 'text' }]}
                        >
                          {status()}
                        </Text>
                      </If>
                      <If when={forkNotice()?.id === selected()}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <Icon name="fork" color={C.secondary} />
                          <Text style={{ ...bodyTextStyle, flex: 1, color: C.muted }}>
                            {tr(
                              'This is a fork of {title}. The original conversation is unchanged.',
                              { title: forkNotice()!.title },
                            )}
                          </Text>
                          <Button
                            onPress={inputAction(openBrowsed, {
                              id: forkNotice()!.source,
                              origin: selected(),
                            })}
                            style={controlStyle}
                            hoverStyle={controlHoverStyle()}
                            focusStyle={controlFocusStyle()}
                          >
                            <Text style={{ ...bodyTextStyle, color: C.accent }}>
                              {tr('Back to original')}
                            </Text>
                          </Button>
                        </View>
                      </If>
                      <If when={!controlsKnown() || controls().length > 0}>
                        <Button
                          disabled={recovering()}
                          onPress={inputAction(recoverControls, null)}
                          style={controlStyle}
                          hoverStyle={controlHoverStyle()}
                          focusStyle={controlFocusStyle()}
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
                              hoverStyle={controlHoverStyle()}
                              focusStyle={controlFocusStyle()}
                            >
                              <Text style={{ ...bodyTextStyle, color: C.warning }}>
                                {tr('Abandon unconfirmed {method}', {
                                  method: original().method,
                                })}{' '}
                                · {original().id.slice(0, 8)}
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
              commands={composerCommands}
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
              chooseWorkspace={inputAction(invokeCommand, {
                id: 'workspace',
                sessionId: selected(),
              })}
              settings={inputAction(invokeCommand, {
                id: 'settings',
                sessionId: selected(),
              })}
            />
            <If when={recoveredFork()}>
              <Button
                onPress={inputAction(openBrowsed, {
                  id: recoveredFork()!.id,
                  origin: selected(),
                })}
                style={{ ...controlStyle, alignSelf: 'flex-start' }}
                hoverStyle={controlHoverStyle()}
                focusStyle={controlFocusStyle()}
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
                        backgroundColor: C.scrim,
                      }}
                    >
                      <View style={{ backgroundColor: C.background }}>
                        <Header
                          title={current.sessionId === null ? '' : tr('Sessions')}
                          commands={inputAction(invokeCommand, {
                            id: 'commands',
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
                    commands={commands({
                      instance: current.instance,
                      sessionId: current.sessionId,
                    })}
                    close={closeOverlay}
                  />
                );
              }}
            </Each>
            <TerminalInterrupt state={interrupt} />
          </View>
        </viewRuntimeContext.Provider>
      );
    },
    enabled(id: string) {
      if (!shell() || reloading()) return false;
      if (id === 'files') return handle() !== null && workspace() !== null;
      if (['compact', 'latest', 'history-focus', 'activity-focus'].includes(id))
        return handle() !== null;
      if (id === 'stop') return handle()?.invocation() != null;
      return true;
    },
    run(id: string, argument?: string) {
      const source = {
        instance: overlay()?.instance ?? null,
        sessionId: selected(),
      };
      switch (id) {
        case 'commands':
          return open({ kind: 'commands', sessionId: selected() });
        case 'browse':
          return open({ kind: 'sessions', sessionId: selected() });
        case 'sessions':
          return commandSessions(source);
        case 'new':
          return commandNew(source);
        case 'workspace':
          return commandWorkspace(source);
        case 'models':
          return commandModels(source);
        case 'settings':
          return commandSettings(source);
        case 'files':
          return commandFiles(source);
        case 'compact':
          return commandCompact(source, argument);
        case 'latest':
          return commandLatest({
            ...source,
            turnId: handle()?.activeTurn() ?? null,
          });
        case 'history-focus':
          return commandHistory(source);
        case 'activity-focus':
          return commandActivity({
            ...source,
            turnId: handle()?.activityTurn() ?? null,
          });
        case 'stop':
          return commandStop({
            ...source,
            invocationId: handle()?.invocation() ?? null,
          });
      }
    },
    async prepareReload() {
      const owner = handle();
      if (owner && !(await owner.flushDraft()))
        throw new UiError(
          'Draft could not be saved or restored. Its existing contents are preserved.',
        );
      if (!alive || handle() !== owner) throw new UiError('Conversation navigation was cancelled.');
      return null;
    },
  };
}

function projectComposerSession(
  owner: ConversationHandle,
  host: Host,
): ComposerSession<JSX.Element> {
  return {
    sessionId: owner.sessionId,
    completion: {
      files: (query, directory) =>
        host.subscribe('agent', 'fileCandidates', {
          sessionId: owner.sessionId,
          query,
          ...(directory ? { directory } : {}),
        }),
      skills: ({ query, model, thinkingLevel }) =>
        host.query('agent', 'skillCandidates', {
          sessionId: owner.sessionId,
          backend: { kind: 'model', model, thinkingLevel },
          query,
        }),
      pathLabel: host.pathLabel,
    },
    checklist: {
      read: (offset) => host.query('agent', 'checklist', { sessionId: owner.sessionId, offset }),
      watch: (offset) =>
        host.subscribe('agent', 'watchChecklist', { sessionId: owner.sessionId, offset }),
    },
    queue: {
      sessionId: owner.queue.sessionId,
      snapshot: owner.queue.snapshot,
      running: owner.queue.running,
      read: owner.queue.read,
      change: owner.queue.change,
    },
    attachments: projectComposerAttachments(owner.attachments, host),
    permissions: {
      sessionId: owner.permissions.sessionId,
      snapshot: owner.permissions.snapshot,
      pending: owner.permissions.pending,
      error: owner.permissions.error,
      select: owner.permissions.select,
    },
    projectMcp: {
      proposal: owner.projectMcp.proposal,
      pending: owner.projectMcp.pending,
      error: owner.projectMcp.error,
      notice: owner.projectMcp.notice,
      trust: owner.projectMcp.trust,
      dismiss: owner.projectMcp.dismiss,
    },
    draft: owner.draft,
    previewImage: owner.previewImage,
    editable: owner.editable,
    blockedReason: owner.blockedReason,
    backend: owner.backend,
    modelDetails: owner.modelDetails,
    refreshModel: owner.refreshModel,
    workspace: owner.workspace,
    empty: owner.empty,
    error: owner.error,
    notice: owner.notice,
    recoverable: owner.recoverable,
    recovering: owner.recovering,
    unconfirmed: owner.unconfirmed,
    invocation: owner.invocation,
    stopping: owner.stopping,
    metrics: owner.metrics,
    changeDraft: owner.changeDraft,
    submit: owner.submit,
    sendRendered: owner.sendRendered,
    recover: owner.recover,
    abandon: owner.abandon,
    stop: owner.stop,
  };
}
