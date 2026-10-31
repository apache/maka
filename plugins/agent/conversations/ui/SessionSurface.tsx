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
  untracked,
  computed,
  effect,
  inputAction,
  signal,
  Scroll,
  Text,
  View,
  keymap,
  windowSize,
  platform,
  type ViewRef,
  type JSX,
} from 'nsh';
import { Button, Dialog } from 'nsh/base';
import type { UiContext, UiHost } from '../../../../packages/plugin-sdk/src/workbench.js';
import type { StagedFile } from 'maka/host';
import type {
  AgentInteractionResult,
  AgentWorkspaceAccess,
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
import { loadDraft, type Host } from '../../../../products/maka/workbench/app/host';
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
import type {
  ModelBackend,
  ModelDetails,
} from '../../../../products/maka/workbench/app/modelSelection';
import {
  InteractionComposer,
  interactionOutcomeSummary,
} from '../../../../products/maka/workbench/app/InteractionComposer';
import type { ImagePreview } from '../../../../products/maka/workbench/app/ImageThumbnail';
import {
  createBrowsing,
  type Browsing,
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
  | { kind: 'commands' | 'workspaces' | 'sessions' }
  // `within`: the search starts in the open conversation only.
  | { kind: 'search'; within?: boolean }
  | { kind: 'models'; focusOnClose?: 'composer' }
  | { kind: 'settings'; model?: ModelSelection }
  | { kind: 'compact'; owner: ConversationHandle; prompt?: string }
);
type Overlay = OverlayTarget & { instance: number };
function unavailableSession(reason: unknown): boolean {
  return (
    reason === 'agent_session_unavailable' ||
    (reason instanceof Error && reason.message === 'agent_session_unavailable')
  );
}
type ActionContext = { instance: number | null; sessionId: string | null };
type PendingFile = { id: string; name: string; bytes: number; file: StagedFile };
type PendingDraft = {
  workspace: BrowserWorkspace;
  workspaceLabel: string;
  text: string;
  backend: ModelBackend | null;
  access: AgentWorkspaceAccess | null;
  requests: boolean | null;
  modelChosen: boolean;
  files: PendingFile[];
  target: { kind: 'creating'; operationId: string } | { kind: 'session'; sessionId: string } | null;
  revision: number;
};
// A pane opened beside the main one shares its catalog read and leaves the
// window title, notifications, menu and app-wide shortcuts to the main pane.
export function createConversationUi(
  context: UiContext<UiHost, JSX.Element>,
  host: Host,
  side?: { browsing: Browsing },
) {
  const runtime = context.runtime;
  effect(() => currentLocale.set(context.locale()));
  const shell = signal<ConversationShell | null>(null);
  const bind = (next: ConversationShell) => {
    if (shell() !== next) shell.set(next);
  };
  const browsing = side?.browsing ?? createBrowsing(host);
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
  const pending = signal<PendingDraft | null>(null);
  const updatePending = (patch: Partial<Omit<PendingDraft, 'revision'>>) => {
    const current = pending();
    if (current) pending.set({ ...current, ...patch, revision: current.revision + 1 });
  };
  const replacePending = (next: PendingDraft | null) => {
    const previous = pending();
    pending.set(next);
    for (const file of previous?.files ?? []) file.file.dispose();
  };
  cleanup(() => replacePending(null));
  const pendingWorkspace = computed(() => pending()?.workspace ?? null);
  const pendingWorkspaceLabel = computed(() => pending()?.workspaceLabel ?? '');
  const pendingText = computed(() => pending()?.text ?? '');
  const pendingSending = signal(false);
  const pendingFiles = computed(() => pending()?.files ?? []);
  const pendingIntake = signal<Promise<void> | null>(null);
  const pendingFileBusy = () => pendingIntake() !== null;
  const pendingPicker = signal(false);
  const pendingAccess = computed(() => pending()?.access ?? null);
  const pendingRequests = computed(() => pending()?.requests ?? null);
  const pendingBackend = computed(() => pending()?.backend ?? null);
  const pendingModelChosen = computed(() => pending()?.modelChosen ?? false);
  const pendingModelDetails = signal<ModelDetails>({
    kind: 'unavailable',
    message: uiMessage('Choose a model.'),
  });
  const pendingModelInstance = signal<number | null>(null);
  const pendingTarget = computed(() => pending()?.target ?? null);
  const pendingCreated = computed(() => {
    const target = pendingTarget();
    return target?.kind === 'session' ? target.sessionId : null;
  });
  const pendingCreateAttempt = computed(() => {
    const target = pendingTarget();
    return target?.kind === 'creating' ? target.operationId : null;
  });
  const pendingHandoff = signal<string | null>(null);
  const pendingCreateUncertain = () => pendingCreateAttempt() !== null;
  let pendingModelGeneration = 0;
  const pendingDraftGeneration = signal(0);
  let pendingDefaultEpoch = 0;
  let pendingDefaultRead: Promise<void> | null = null;
  const pendingModel = {
    sessionId: 'pending',
    backend: pendingBackend,
    modelDetails: pendingModelDetails,
    async refreshModel() {
      const backend = pendingBackend();
      const generation = ++pendingModelGeneration;
      if (!backend) {
        pendingModelDetails.set({ kind: 'unavailable', message: uiMessage('Choose a model.') });
        return;
      }
      pendingModelDetails.set({ kind: 'loading' });
      try {
        const result = await host.query('settings', 'resolveModel', {
          connectionId: backend.connectionId,
          modelId: backend.modelId,
        });
        if (!alive || generation !== pendingModelGeneration) return;
        pendingModelDetails.set(
          result.kind === 'ready'
            ? { kind: 'ready', choice: result.choice }
            : {
                kind: 'unavailable',
                message: uiMessage('Model unavailable: {model}.', { model: backend.modelId }),
              },
        );
      } catch (reason) {
        if (alive && generation === pendingModelGeneration)
          pendingModelDetails.set({ kind: 'unavailable', message: errorText(reason) });
      }
    },
  };
  let dropFiles: ((event: { uris: string[] }) => void) | null = null;
  const fileDragging = signal(false);
  let editor: { focus(): void } | undefined;
  const composerSession = computed(() => {
    const owner = handle();
    return owner && owner.sessionId === selected() ? projectComposerSession(owner, host) : null;
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
  const readPendingSession = async () => {
    const id = pendingCreated();
    if (!id) return null;
    try {
      return await host.query('agent', 'observe', { sessionId: id });
    } catch (reason) {
      if (!unavailableSession(reason)) throw reason;
      if (pendingCreated() === id) updatePending({ target: null });
      return null;
    }
  };

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
      if (source.sessionId === null && pendingWorkspace())
        pendingDraftGeneration.set(pendingDraftGeneration() + 1);
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
    const unresolved = originals.find(
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
    if (unresolved)
      throw new UiError(
        'This action has an unresolved original. Recover it below before trying again.',
      );
    if (!urgent && busy())
      throw new UiError('An action is being confirmed. Try again in a moment.');
    const pendingCreation = method === 'create' && pendingSending() && pendingWorkspace() !== null;
    if (!urgent) busy.set(true);
    try {
      let result: any;
      if (pendingCreation) {
        const original = await host.beginControl(method, input);
        updatePending({ target: { kind: 'creating', operationId: original.operationId } });
        for (;;) {
          const event = await original.next();
          if (event === null)
            throw new UiError('Confirmation is still unknown. Recover the original action below.');
          if (event.kind === 'not_dispatched') {
            updatePending({ target: null });
            throw new UiError('The action was not dispatched. Try again.');
          }
          if (event.kind === 'finished') {
            result = returned(event.reply);
            updatePending({
              target:
                result.kind === 'created'
                  ? { kind: 'session', sessionId: result.session.id }
                  : null,
            });
            break;
          }
        }
      } else result = returned((await host.control(method, input)).reply);
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
  const create = async (
    workspace: BrowserWorkspace,
    expectedSessionId = selected(),
    workspaceLabel?: string,
  ) => {
    if (!alive || selected() !== expectedSessionId) return;
    if (!platform.isTerminal) {
      if (pendingSending() || pendingFileBusy() || pendingCreateUncertain()) return;
      const label =
        workspaceLabel ??
        (workspace.kind === 'session'
          ? (handle()?.workspace() ?? '')
          : (workspace.selection.segments.at(-1) ?? ''));
      if (!(await shell()!.openSession(null)) || !alive || selected() !== null) return;
      if (expectedSessionId === null && pendingWorkspace()) {
        try {
          await readPendingSession();
        } catch (reason) {
          report(reason);
          return;
        }
        if (pendingCreated()) {
          report(
            new UiError(
              'This conversation was already created. Finish sending it before changing workspaces.',
            ),
          );
          return;
        }
        updatePending({ workspace, workspaceLabel: label });
        pendingDraftGeneration.set(pendingDraftGeneration() + 1);
        pendingModelInstance.set(null);
        overlay.set(null);
        focusComposer();
        return;
      }
      if (
        pendingWorkspace() &&
        (pendingText() ||
          pendingFiles().length ||
          pendingCreated() ||
          pendingAccess() !== null ||
          pendingRequests() !== null ||
          pendingModelChosen())
      ) {
        overlay.set(null);
        focusComposer();
        return;
      }
      replacePending({
        workspace,
        workspaceLabel: label,
        text: '',
        backend: null,
        access: null,
        requests: null,
        modelChosen: false,
        files: [],
        target: null,
        revision: 0,
      });
      pendingDraftGeneration.set(pendingDraftGeneration() + 1);
      const generation = ++pendingDefaultEpoch;
      pendingPicker.set(false);
      pendingModelGeneration += 1;
      pendingModelDetails.set({ kind: 'unavailable', message: uiMessage('Choose a model.') });
      pendingModelInstance.set(null);
      pendingDefaultRead = host
        .query('settings', 'connections', { kind: 'start' })
        .then((page) => {
          if (
            !alive ||
            pendingDefaultEpoch !== generation ||
            pendingWorkspace() === null ||
            pendingBackend() ||
            page.kind !== 'ready' ||
            !page.defaultTarget
          )
            return;
          updatePending({ backend: { ...page.defaultTarget, thinkingLevel: null } });
          return pendingModel.refreshModel();
        })
        .catch(report);
      overlay.set(null);
      focusComposer();
      return;
    }
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
    else if (pendingWorkspace()) focusComposer();
    else open({ kind: 'workspaces', sessionId });
  };
  const removeSelected = async (sessionId: string) => {
    if (pendingCreated() === sessionId) {
      updatePending({ target: null });
    }
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
  const prefills = new Map<
    string,
    { text: string; send: boolean; files?: StagedFile[]; first?: boolean }
  >();
  const stagePending = (
    read: () => Promise<{ files: StagedFile[]; text?: string | null }>,
    onText?: (text: string) => void,
  ) => {
    const workspace = pendingWorkspace();
    if (!workspace || pendingFileBusy() || pendingSending()) return;
    const intake = read()
      .then(async ({ files, text }) => {
        if (!alive || pendingWorkspace() !== workspace) {
          for (const file of files) file.dispose();
          return;
        }
        updatePending({
          files: [
            ...pendingFiles(),
            ...files.map((file) => {
              const metadata = file.metadata() as { name: string; bytes: number };
              return { id: file.id, name: metadata.name, bytes: metadata.bytes, file };
            }),
          ],
        });
        if (text) onText?.(text);
        pendingPicker.set(false);
        if (selected() === null && overlay() === null && (shell()?.visible() ?? false))
          focusComposer();
      })
      .catch(report)
      .finally(() => {
        if (alive) pendingIntake.set(null);
      });
    pendingIntake.set(intake);
  };
  const pendingComposer = computed(() => {
    const generation = pendingDraftGeneration();
    const workspace = pendingWorkspace();
    const owns = () =>
      alive &&
      selected() === null &&
      pendingWorkspace() === workspace &&
      pendingDraftGeneration() === generation;
    const confirmation = () => `${generation}/${pending()?.revision ?? 0}`;
    return {
      id: `pending/${generation}`,
      draft: pendingText,
      workspace: pendingWorkspaceLabel,
      permissions: {
        id: `pending/${generation}`,
        access: pendingAccess,
        requestPermissions: pendingRequests,
        pending: pendingSending,
        selectAccess: (access: AgentWorkspaceAccess) => {
          if (owns() && !pendingSending() && pendingAccess() !== access) {
            updatePending({ access });
          }
        },
        selectRequests: (requests: boolean) => {
          if (owns() && !pendingSending() && pendingRequests() !== requests) {
            updatePending({ requests });
          }
        },
      },
      changeDraft: (text: string) => {
        if (owns() && pendingText() !== text) {
          updatePending({ text });
        }
      },
      confirmation,
      sending: pendingSending,
      ready: () => !pendingCreateUncertain() && !pendingFileBusy(),
      files: pendingFiles,
      picking: pendingPicker,
      openPicker: (open: boolean) => {
        if (owns()) pendingPicker.set(open);
      },
      removeFile: (id: string) => {
        if (!owns() || pendingSending()) return;
        const removed = pendingFiles().find((file) => file.id === id);
        if (!removed) return;
        updatePending({ files: pendingFiles().filter((file) => file.id !== id) });
        removed.file.dispose();
      },
      selectFiles(files: string[]) {
        if (owns() && files.length)
          stagePending(async () => ({ files: await host.stageFiles(files) }));
      },
      pasteClipboard(onText: (text: string) => void) {
        if (owns())
          stagePending(async () => {
            const selection = await host.stageClipboard();
            try {
              return { files: selection.files(), text: selection.text };
            } finally {
              selection.dispose();
            }
          }, onText);
      },
      reportError: report,
      submit(text: string, expected?: string) {
        const workspace = pendingWorkspace();
        const staged = pendingFiles();
        const files = staged.map((item) => item.file);
        const access = pendingAccess();
        const requests = pendingRequests();
        if (
          !owns() ||
          !workspace ||
          text !== pendingText() ||
          (expected !== undefined && expected !== confirmation()) ||
          (!text.trim() && files.length === 0) ||
          pendingSending() ||
          pendingFileBusy() ||
          pendingCreateUncertain() ||
          selected() !== null
        )
          return;
        pendingSending.set(true);
        void (async () => {
          try {
            error.set('');
            const requireUnchangedDraft = () => {
              if (pendingText() !== text)
                throw new UiError(
                  'The draft changed before confirmation. Send again to confirm it.',
                );
            };
            await pendingDefaultRead;
            if (!alive || selected() !== null || pendingWorkspace() !== workspace) return;
            requireUnchangedDraft();
            const backend = pendingBackend();
            if (!backend) {
              pendingModelInstance.set(++overlayInstance);
              return;
            }
            await pendingModel.refreshModel();
            if (!alive || selected() !== null || pendingWorkspace() !== workspace) return;
            requireUnchangedDraft();
            if (pendingBackend() !== backend || pendingModelDetails().kind !== 'ready')
              throw new UiError('Model unavailable: {model}. Choose another model.', {
                model: backend.modelId,
              });
            let id = pendingCreated();
            let sendFirst = true;
            if (id) {
              const previous = await readPendingSession();
              id = pendingCreated();
              if (id && previous) {
                const history = await host.query('agent', 'history', {
                  sessionId: id,
                  through: previous.through,
                  position: { kind: 'start' },
                  view: 'conversation',
                });
                sendFirst = !history.chunks.some((row) => row.role === 'user');
              }
            }
            if (!id) {
              const result = await control('create', {
                title: tr('New conversation'),
                automaticTitle: true,
                labels: [],
                workspace,
              });
              if (result.kind !== 'created')
                throw new UiError('Conversation creation rejected: {reason}', {
                  reason: result.reason ?? result.kind,
                });
              id = result.session.id as string;
            }
            requireUnchangedDraft();
            if (access !== null || requests !== null) {
              if (
                !controlsKnown() ||
                controls().some(
                  (original) => original.sessionId === id && original.method === 'metadata',
                )
              )
                throw new UiError(
                  'This action has an unresolved original. Recover it below before trying again.',
                );
              const observed = await host.query('agent', 'observe', { sessionId: id });
              const session = observed.session;
              const settings = {
                access: access ?? session.permissions.access,
                requestPermissions: requests ?? session.permissions.requestPermissions,
              };
              if (
                settings.access !== session.permissions.access ||
                settings.requestPermissions !== session.permissions.requestPermissions
              ) {
                const changed = await control('metadata', {
                  sessionId: id,
                  expectedRevision: session.revision,
                  title: session.title,
                  labels: session.labels,
                  permissions: { settings, revokeGrants: true },
                });
                if (changed.kind !== 'committed')
                  throw new UiError('Sandbox settings rejected: {reason}', {
                    reason: changed.reason ?? changed.kind,
                  });
              }
            }
            const choice = await control('selectBackend', {
              sessionId: id,
              backend: { kind: 'model', ...backend },
            });
            if (choice.kind !== 'committed')
              throw new UiError('Model selection rejected: {reason}', {
                reason: choice.reason ?? choice.kind,
              });
            requireUnchangedDraft();
            const stored = await loadDraft(host.session(id));
            if (stored.revision > 0)
              throw new UiError(
                'The conversation draft changed. Open the conversation to review it.',
              );
            prefills.set(id, { text, send: sendFirst, files, first: true });
            pendingHandoff.set(id);
            const switched = await switchSession(id, { sessionId: null, instance: null });
            if (switched) {
              await browsing.refresh();
            } else {
              prefills.delete(id);
              pendingHandoff.set(null);
            }
          } catch (reason) {
            report(reason);
          } finally {
            if (alive) pendingSending.set(false);
          }
        })();
      },
    };
  });
  cleanup(() => {
    prefills.clear();
  });
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
  const commandFind = (context: ActionContext) => {
    // With no conversation open, Find searches them all.
    if (closeCommand(context))
      open({ kind: 'search', sessionId: context.sessionId, within: handle() !== null });
  };
  const commandNew = (context: ActionContext) => {
    if (closeCommand(context)) newConversation(context.sessionId);
  };
  // The Bot is one persistent Session per installation; the first open creates it
  // in the current conversation's workspace, later opens return the same Session.
  // `undefined` until the Host has answered; then the Bot Session or `null` for none.
  const botSession = signal<string | null | undefined>(undefined);
  const refreshBotSession = async () => {
    const head = await host.query('agent', 'botOutbox', { limit: 0 });
    if (alive) botSession.set(head.sessionId ?? null);
    return head.sessionId ?? null;
  };
  void refreshBotSession().catch(() => {});
  const commandBot = (context: ActionContext) => {
    const sessionId = context.sessionId;
    if (!closeCommand(context)) return;
    void (async () => {
      try {
        error.set('');
        // An existing Bot opens directly; only its first open needs a workspace.
        const existing = botSession() ?? (await refreshBotSession().catch(() => null));
        if (existing !== null) {
          await switchSession(existing, { sessionId, instance: null });
          return;
        }
        // The Host picks the workspace of the Bot's first open itself.
        const result = await control('openBot', {});
        if (!alive) return;
        if (result.kind !== 'opened')
          throw new UiError('Bot could not be opened: {reason}', {
            reason: result.reason ?? result.kind,
          });
        botSession.set(result.sessionId);
        await switchSession(result.sessionId, { sessionId, instance: null });
        if (result.created) await browsing.refresh();
      } catch (reason) {
        report(reason);
      }
    })();
  };
  const commandWorkspace = (context: ActionContext) => {
    if (closeCommand(context)) open({ kind: 'workspaces', sessionId: context.sessionId });
  };
  const commandModels = (context: ActionContext) => {
    if (!closeCommand(context)) return;
    if (context.sessionId === null && pendingWorkspace()) {
      pendingModelInstance.set(pendingModelInstance() === null ? ++overlayInstance : null);
      return;
    }
    open({ kind: 'models', sessionId: context.sessionId });
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
  // A side pane binds its conversation's keys within itself, so they take
  // over from the main pane's only while focus is there.
  const unbindKeys: (() => void)[] = [];
  cleanup(() => {
    for (const unbind of unbindKeys.splice(0)) unbind();
  });
  const bindKeys = (within?: ViewRef) => {
    const options = within ? { when: 'always' as const, within } : { when: 'always' as const };
    unbindKeys.push(keymap.bind('mod+p', () => invokeOwn('commands'), options));
    if (ownTitleBar) unbindKeys.push(keymap.bind('mod+f', () => invokeOwn('find'), options));
    unbindKeys.push(keymap.bind('mod+g', () => invokeOwn('models'), options));
    unbindKeys.push(keymap.bind('mod+l', () => invokeOwn('latest'), options));
    unbindKeys.push(keymap.bind('alt+up', () => invokeOwn('history-focus'), options));
    unbindKeys.push(keymap.bind('alt+down', () => invokeOwn('activity-focus'), options));
    if (within) return;
    unbindKeys.push(keymap.bind('mod+o', () => invokeOwn('sessions'), options));
    unbindKeys.push(keymap.bind('mod+n', () => invokeOwn('new'), options));
    if (ownTitleBar) {
      unbindKeys.push(keymap.bind('mod+shift+]', () => stepSession(1), options));
      unbindKeys.push(keymap.bind('mod+shift+[', () => stepSession(-1), options));
    }
  };
  let sideKeys: ViewRef | undefined;
  if (!side) {
    bindKeys();
    windowTitle(() => handle()?.title() ?? null);
    watchNotifications({
      sessions: browsing.sessions,
      foreground,
      open: (sessionId) => void selectBrowsed(sessionId, selected()),
    });
  }
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
          if (original.method === 'openBot' && result.kind === 'opened') {
            botSession.set(result.sessionId);
            await switchSession(result.sessionId);
          }
          if (original.method === 'create' && original.id === pendingCreateAttempt()) {
            updatePending({
              target:
                result.kind === 'created'
                  ? { kind: 'session', sessionId: result.session.id }
                  : null,
            });
          } else if (original.method === 'create' && result.kind === 'created') {
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
      const original = await host.abandonControl(id);
      if (id === pendingCreateAttempt() && original.abandoned) {
        updatePending({ target: null });
      }
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
    close: shell()?.closePane,
  });
  // The bindings above take the same keys first; the menu shows and offers them.
  if (!side)
    applicationMenu({
      newConversation: () => invokeOwn('new'),
      chooseWorkspace: () => invokeOwn('workspace'),
      sessions: () => invokeOwn('browse'),
      search: () => invokeOwn('sessions'),
      find: () => invokeOwn('find'),
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
    changeSession: async (action, origin) => {
      await changeBrowsedSession(action, origin);
    },
    create,
    newConversation: (sessionId) => invokeCommand({ id: 'new', sessionId }),
    openBot: (sessionId) => invokeCommand({ id: 'bot', sessionId }),
    botSession,
    settings: (sessionId) => invokeCommand({ id: 'settings', sessionId }),
    search: (sessionId) => invokeCommand({ id: 'sessions', sessionId }),
    canOpenBeside: () => !!shell()?.openBeside,
    beside: () => shell()?.besideSessionIds?.() ?? [],
    openBeside: (sessionId) => shell()?.openBeside?.(sessionId),
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
      if (
        (pendingSending() && pendingHandoff() === null) ||
        pendingCreateUncertain() ||
        (pendingHandoff() === selected() && pendingHandoff() !== null)
      )
        return false;
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
    browsing,
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
            ref={(node) => {
              if (!side || sideKeys === node) return;
              sideKeys = node;
              bindKeys(node);
            }}
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
                  botSession={botSession}
                  visible={() =>
                    selected() === id() && overlay() === null && (shell()?.visible() ?? false)
                  }
                  foreground={foreground}
                  control={control}
                  continuationPending={() =>
                    !controlsKnown() ||
                    controls().some(
                      (original) => original.method === 'resume' && original.sessionId === id(),
                    )
                  }
                  fork={async (action) => {
                    await changeBrowsedSession(action, id());
                  }}
                  edit={(action, text, send) => changeBrowsedSession(action, id(), { text, send })}
                  takePrefill={(available: boolean) => {
                    const prefill = prefills.get(id()) ?? null;
                    prefills.delete(id());
                    if (!available) {
                      if (pendingHandoff() === id()) {
                        pendingHandoff.set(null);
                        pendingSending.set(false);
                        void shell()!.openSession(null).catch(report);
                      }
                      if (prefill)
                        report(
                          new UiError(
                            'The draft changed before confirmation. Send again to confirm it.',
                          ),
                        );
                      return null;
                    }
                    if (pendingHandoff() === id()) {
                      pending.set(null);
                      pendingHandoff.set(null);
                    }
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
              pending={() => (selected() === null && pendingWorkspace() ? pendingComposer() : null)}
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
                  <If when={status()}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        paddingHorizontal: 12,
                        paddingVertical: 4,
                        flexShrink: 0,
                      }}
                    >
                      <Text
                        style={[
                          { ...bodyTextStyle, flex: 1, minWidth: 0, color: C.muted },
                          { userSelect: 'text' },
                        ]}
                      >
                        {status()}
                      </Text>
                      <Button
                        accessibilityLabel={tr('Dismiss action feedback')}
                        onPress={inputAction(() => status.set(''), null)}
                        style={{
                          ...controlStyle,
                          width: 32,
                          height: 32,
                          paddingHorizontal: 0,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        hoverStyle={controlHoverStyle()}
                        focusStyle={controlFocusStyle()}
                      >
                        <Icon name="close" color={C.muted} />
                      </Button>
                    </View>
                  </If>
                  <If
                    when={
                      error() ||
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
                <>
                  <If when={selected() === null && pendingWorkspace() !== null}>
                    <ModelSelect
                      owner={pendingModel}
                      instance={pendingModelInstance}
                      current={() => alive && selected() === null && pendingWorkspace() !== null}
                      toggle={() =>
                        pendingModelInstance.set(
                          pendingModelInstance() === null ? ++overlayInstance : null,
                        )
                      }
                      close={(instance) => {
                        if (pendingModelInstance() !== instance) return false;
                        pendingModelInstance.set(null);
                        return true;
                      }}
                      manage={({ instance, model }) => {
                        if (pendingModelInstance() !== instance) return;
                        pendingModelInstance.set(null);
                        shell()?.openSettings(model);
                      }}
                      select={async (_instance, backend) => {
                        if (pendingSending()) return;
                        updatePending({ backend, modelChosen: true });
                        await pendingModel.refreshModel();
                      }}
                    />
                  </If>
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
                            return current?.kind === 'models' &&
                              current.sessionId === owner.sessionId
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
                </>
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
                      within={current.within}
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
                      create={(workspace, label) => create(workspace, current.sessionId, label)}
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
      // A side pane holds one open conversation; navigation belongs to the main pane.
      if (side && ['new', 'workspace', 'browse', 'sessions'].includes(id)) return false;
      if (id === 'files') return handle() !== null && workspace() !== null;
      if (id === 'bot') return true;
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
        case 'find':
          return commandFind(source);
        case 'new':
          return commandNew(source);
        case 'bot':
          return commandBot(source);
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
      if (pendingSending() || pendingCreateUncertain() || pendingHandoff())
        throw new UiError('Finish or recover the pending action before reloading.');
      await pendingIntake();
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
    computerAccess: owner.computerAccess,
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
    resumable: owner.resumable,
    resuming: owner.resuming,
    resume: owner.resume,
    metrics: owner.metrics,
    contextUsage: owner.contextUsage,
    changeDraft: owner.changeDraft,
    submit: owner.submit,
    sendRendered: owner.sendRendered,
    recover: owner.recover,
    abandon: owner.abandon,
    stop: owner.stop,
  };
}
