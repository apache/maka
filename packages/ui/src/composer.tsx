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
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { LucideIcon } from './icons.js';
import { useMountedRef } from './use-mounted-ref.js';
import {
  ICON_SIZE,
  ArrowUp,
  CircleGauge,
  FileText,
  ListTodo,
  Network,
  Pencil,
  Plus,
  Square,
  Sparkles,
  Target,
  Upload,
  Workflow,
} from './icons.js';
import {
  ChatModelSwitcher,
  ModelChipStatic,
  NewChatModelPicker,
  ThinkingLevelSelector,
} from './chat-model-switcher.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { type ChatModelChoice, exactModelChoiceValue } from './chat-model-helpers.js';
import {
  appendPromptContextDraft,
  deriveComposerModelSwitchAvailability,
  isReferenceSizedPaste,
  type ComposerModelSwitchAvailability,
} from './composer-helpers.js';
import { stripQuoteHeadingMarkers } from './quote-ref-chip.js';
import { DirectoryReferenceChip } from './directory-reference-chip.js';
import { FolderOpen } from './icons.js';
import { WorkspacePicker, type WorkspacePickerModel } from './workspace-picker.js';
import { useComposerDraft, type ComposerDraftPersistence } from './use-composer-draft.js';
import { useComposerHistory } from './use-composer-history.js';
import {
  composerWireText,
  createChatInputActionOwner,
  createTriggerSearchSource,
  fileTransferContainsFiles,
  isChatInputComposing,
  mentionQueryMatches,
  slashCommandQuery,
  skillMentionQuery,
  type ChatInputActionOwner,
  type ComposerTextPort,
} from './chat-input-behavior.js';
import { SKILL_INVOCATION_TOKEN_SOURCE } from '@maka/core/skill-invocation-token';
import type {
  AttachmentRef,
  FollowUpMode,
  MessageQueueEntryProjection,
  QuoteRef,
} from '@maka/core/events';
import type { PermissionMode } from '@maka/core/permission';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { ProviderType } from '@maka/core/llm-connections';
import type { SessionSummary } from '@maka/core/session';
import {
  Button as UiButton,
  ChatComposer as AstryxChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  IconButton,
  Lightbox,
  Token,
  Tooltip,
  useChatPasteAsToken,
  type ChatComposerInputHandle,
  type ChatComposerToken,
  type ChatComposerTrigger,
  type SearchableItem,
  type SearchSource,
} from '@astryxdesign/core';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { useIndicator } from '@astryxdesign/core/Indicator';
import { PermissionModeSelect } from './permission-mode-menu.js';
import { AttachmentKindIcon } from './attachment-kinds.js';
import { formatPreviewSize } from './artifact-preview-registry.js';
import {
  inlineReferenceFileBasename,
  inlineReferenceToken,
  workspaceFileInlineReference,
  workspaceFileReferencePositions,
  type WorkspaceFileReferencePosition,
} from './inline-reference.js';
import { ComposerMessageQueue } from './composer-message-queue.js';

/** A Skill as the composer offers it: what the `/` menu lists and what a
 * chosen entry writes into the draft. */
export interface ComposerSkillOption {
  /** The id the `/skill:<id>` token carries, and what Runtime resolves. */
  id: string;
  name: string;
  description?: string;
}

export interface ComposerSlashCommandOption {
  id: string;
  name: string;
  description?: string;
  keywords?: readonly string[];
  Icon?: LucideIcon;
}

type ComposerSlashSuggestion =
  | { kind: 'command'; command: ComposerSlashCommandOption; group: string }
  | { kind: 'skill'; skill: ComposerSkillOption; group: string };

/**
 * The draft text a chosen Skill becomes. This is the product-wide invocation
 * grammar (`SKILL_INVOCATION_TOKEN_SOURCE` in `@maka/core`), the same one
 * the TUI submits and the same one a user can type by hand — the chip is a
 * rendering of it, not a second channel beside it.
 *
 * By id, not by the scope-aware ref: the ref cannot be spelled in this grammar
 * (`project:.maka/skills:writer` would parse as `project`), and ids are unique
 * within a scan — `scanSkills` drops shadowed duplicates before the picker ever
 * sees them. What the structured channel bought was pinning the exact file
 * across the gap between choosing and sending; in that gap a ref is no less
 * stale than an id, it is only differently stale, and resolving at send time is
 * what `/skill:` means everywhere else in the product.
 *
 * A controlled `value` set rebuilds the editor from this string and drops the
 * chip spans with it; `redrawSkillTokens` puts them back, so a draft restored
 * by session switch, prompt history or revision rollback reads the same as the
 * one that was staged.
 */
function skillTokenValue(id: string): string {
  return `/skill:${id}`;
}

/**
 * Rows the input grows to before it scrolls. `ChatComposerInput` prices this in
 * its own hardcoded 22px line, so the cap is 220px — one line under the 240px
 * the hand-rolled textarea auto-resize enforced. Our type override sets a
 * shorter line than 22px, so the editor shows slightly more than `maxRows`
 * rows before it scrolls; rows, not pixels, is the knob upstream exposes.
 */
const COMPOSER_MAX_ROWS = 10;

/** Uppercased extension for the staged-file card's meta line ("EPUB · 621.0 KB").
 *  Null when the name has no usable extension, so the meta line is size-only. */
function attachmentExtensionLabel(name: string): string | null {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return null;
  const ext = name.slice(idx + 1);
  return ext.length > 8 ? null : ext.toUpperCase();
}

/**
 * PR-UI-15 (@yuejing 2026-05-22): Composer copy is locale-aware.
 *
 * Audit §3.5 — placeholder + state copy were hardcoded zh and drifted
 * stylistically from the first-run input that used to sit beside this
 * one. That second input is gone (#1433), so this placeholder is the
 * only one a user ever reads: one short, action-oriented line.
 */
export interface ComposerHandle {
  /** Replace the input text, leaving focus on the input with the caret at the end. */
  setText(text: string): void;
  /** Append a prompt/context fragment after the existing draft instead of replacing it. */
  appendText(text: string): void;
  /** Read the current input text (inline tokens serialized to their values). */
  getText(): string;
  /** Clear one persisted draft without affecting another session's. */
  clearDraft(draftKey: string): void;
  /** Write a specific session draft before navigation changes the active key. */
  setDraft(draftKey: string, text: string): void;
  /** Read a specific draft without changing the active input. */
  getDraft(draftKey: string): string;
  /** Append to a specific session draft without replacing newer text. */
  appendDraft?(draftKey: string, text: string): void;
  /** Move focus to the input without changing its content. */
  focus(): void;
  /** Open the active Session's existing account-and-model picker. */
  openModelPicker(): void;
}

export interface ComposerSendMetadata {
  workspaceFileReferences?: readonly WorkspaceFileReferencePosition[];
  followUpMode?: FollowUpMode;
}

type ComposerImportActionId = 'pick' | 'attach' | 'directory';

export interface ComposerGoalProps {
  /**
   * Open the host's Goal dialog. The composer offers the entry and nothing
   * else: a Goal names a condition and two budgets, which is a form, and the
   * ＋ menu is a menu. Absent handler, no entry — the same rule the other
   * ＋ entries follow.
   */
  onSetGoal?(): void | Promise<void>;
  /**
   * A Goal is already running here. Arming refuses a second one, so the
   * entry says so up front instead of spending the user's click on an error.
   */
  goalActive?: boolean;
}

export const Composer = forwardRef<
  ComposerHandle,
  {
    disabled?: boolean;
    /**
     * Prevent submission while leaving the draft and recovery controls usable.
     * Hosts use this for configuration failures that the model picker can fix.
     */
    sendBlocked?: boolean;
    hidden?: boolean;
    /**
     * When true, a turn is in flight — live output OR the pre-first-token wait.
     * Send becomes Stop while the draft is empty. The ＋ menu and permission
     * control stay reachable (#1444); the model and thinking menus stay
     * mounted but lock with an explanatory tooltip, so the footer row never
     * reflows mid-turn. Attachment import remains blocked unless the host opts
     * in via `allowAttachmentImportWhileStreaming`.
     */
    streaming?: boolean;
    /**
     * Keep attachment paste, drop, and picker imports available during a
     * running turn. Only hosts whose running-turn submission carries staged
     * attachments into a follow-up should opt in; text-only steering hosts
     * must retain the default gate so text cannot leave its attachment behind.
     */
    allowAttachmentImportWhileStreaming?: boolean;
    /**
     * #646: retained for hosts that still track first-token wait vs mid-turn
     * lull. Quiet composer no longer surfaces long status copy from these;
     * streaming is communicated only by Send → Stop.
     */
    processing?: boolean;
    /**
     * #646: retained for host wait-state projection; not rendered as chrome.
     */
    continuing?: boolean;
    /** True while the current streaming session is processing a stop request. */
    stopPending?: boolean;
    queuedMessages?: readonly MessageQueueEntryProjection[];
    queuedMessageRevision?: number;
    /** Promote a queued follow-up into the active Turn (调整方向). */
    onPromoteQueuedEntry?(entryId: string): void | Promise<void>;
    /** Update one queued entry in place without changing its order or placement. */
    onUpdateQueuedEntry?(
      entryId: string,
      expectedQueueRevision: number,
      text: string,
    ): void | Promise<void>;
    /** Remove one queued entry without restoring it. */
    onDeleteQueuedEntry?(entryId: string): void | Promise<void>;
    /** Reorder the follow-up queue; entryIds is the full intended order. */
    onReorderQueuedEntries?(entryIds: readonly string[]): void | Promise<void>;
    /** Runtime-only key used to keep unsent drafts isolated per session. */
    draftKey?: string;
    /** Optional host persistence for reload-safe draft scopes. */
    draftPersistence?: ComposerDraftPersistence;
    /**
     * The composer's one submit. Mid-turn the host decides what handing the
     * draft over means there — steering, a control command — because that is a
     * reading of the same action, not a second control on this surface.
     */
    onSend(
      text: string,
      metadata?: ComposerSendMetadata,
    ): boolean | void | Promise<boolean | void>;
    onStop(): void | Promise<void>;
    onPickAttachments?(): void | Promise<void>;
    onPickDirectory?(): void | Promise<void>;
    pendingDirectories?: readonly import('@maka/core/events').DirectoryReference[];
    onRemoveDirectory?(index: number): void;
    onAttachFilePaths?(files: File[]): void | Promise<void>;
    pendingAttachments?: readonly {
      displayName: string;
      kind: AttachmentRef['kind'];
      mimeType?: string;
      size: number;
      /** Renderer-resolvable image source (object/data URL) for `kind: 'image'`
       *  previews. When set, the chip is clickable and opens the image in a
       *  Lightbox; while absent (still loading, or preview failed) the chip is
       *  inert like any other kind. */
      previewUrl?: string;
    }[];
    onRemoveAttachment?(index: number): void;
    /** Quoted excerpts staged for the next send; rendered as removable chips. */
    pendingQuotes?: readonly QuoteRef[];
    onRemoveQuote?(index: number): void;
    /** Start staged context collapsed on compact secondary composer surfaces. */
    contextDrawerDefaultCollapsed?: boolean;
    /** Hide the unavailable dot when an inherited model is intentionally read-only. */
    showStaticModelUnavailableStatus?: boolean;
    /**
     * Stage a reference-sized paste as a quote chip rather than letting it
     * flood the textarea. Omitted by hosts that don't compose quotes, in which
     * case a large paste behaves like any other paste.
     */
    onPasteAsQuote?(input: { text: string; label?: string }): void;
    modelLabel?: string;
    activeSession?: SessionSummary;
    activeModelConnectionId?: string;
    activeModelConnectionSlug?: string;
    activeModel?: string;
    activeModelLabel?: string;
    activeProviderType?: ProviderType;
    modelChoices?: ChatModelChoice[];
    /** Whether this Session already has conversation history whose provider prompt cache may be rebuilt by a switch. */
    modelSwitchHasHistory?: boolean;
    /** Identity recovery must not present the stale target as a checked, selectable row. */
    hideUnavailableCurrentModel?: boolean;
    /** Renders the provider brand mark beside each model option;
     *  injected by the desktop app to keep the provider SVG library out of @maka/ui. */
    renderProviderMark?(type: ProviderType): ReactNode;
    /** Host-projected availability when another recovery surface opens this picker. */
    modelSwitchAvailability?: ComposerModelSwitchAvailability;
    onModelChange?(input: {
      llmConnectionId: string;
      llmConnectionSlug: string;
      model: string;
    }): void | Promise<void>;
    /** Per-model thinking-level variants for the active model; empty/undefined hides the switcher. */
    activeThinkingLevels?: readonly import('@maka/core/model-thinking').ThinkingLevel[];
    activeThinkingLevel?: import('@maka/core/model-thinking').ThinkingLevel;
    onThinkingLevelChange?(level: import('@maka/core/model-thinking').ThinkingLevel | undefined): void | Promise<void>;
    newChatThinkingLevels?: readonly import('@maka/core/model-thinking').ThinkingLevel[];
    newChatThinkingLevel?: import('@maka/core/model-thinking').ThinkingLevel;
    onNewChatThinkingLevelChange?(level: import('@maka/core/model-thinking').ThinkingLevel | undefined): void | Promise<void>;
    /**
     * Home / empty-state composer only (no active session yet): the model
     * the next new chat will start with, and the picker callback. When set,
     * the otherwise-static model chip becomes a real dropdown so the user can
     * choose the new-chat model inline instead of only via Settings · 模型.
     */
    newChatModel?: { llmConnectionId: string; llmConnectionSlug: string; model: string };
    newChatProviderType?: ProviderType;
    onPickNewChatModel?(input: {
      llmConnectionId: string;
      llmConnectionSlug: string;
      model: string;
    }): void | Promise<void>;
    /**
     * Empty-state only: no models are configured yet, so the model chip is a
     * non-interactive label. When provided, the chip becomes a button into
     * Settings · 模型 instead of wearing a dropdown chevron it cannot honor.
     */
    onOpenModelSettings?(): void;
    /**
     * U3: no model connection exists at all (e.g. right after an onboarding
     * skip). Send is blocked with an explanatory title and an inline hint
     * mounts above the composer box pointing at Settings · 模型, so the user
     * is never left at a dead end with a disabled Send and no guidance.
     * The hint sits OUTSIDE the <form> so it never grows the composer's
     * constant footprint (#740).
     */
    noModelConnection?: boolean;
    /** Optional Host-aware replacement for the generic no-model hint. */
    noModelHint?: string;
    /** Read-only usage indicator for the active model's latest request. */
    contextUsage?: {
      usageTokens?: number;
      declaredContextWindow?: number;
      metadataContextWindow?: number;
    };
    /**
     * Optional edit-and-resend banner above the composer. Desktop owns the
     * revision draft; Composer only renders the notice + cancel affordance.
     */
    revisionNotice?: {
      /** Short primary status, e.g. "修改已发送消息". */
      title: string;
      /** Optional quieter secondary line under the title. */
      detail?: string;
      cancelLabel: string;
      onCancel(): void;
    };
    /**
     * Where a NEW chat starts. Rendered at the end of the footer's send-context
     * group and only while no session owns the composer: the project is fixed
     * the moment the first message creates the session.
     */
    workspacePicker?: WorkspacePickerModel;
    /**
     * PR-MOVE-PERMISSION-MODE (WAWQAQ 47fe0d0e + a667cf6c): the
     * permission mode picker lives inside the composer left-controls
     * instead of the chat header. Composer renders a dropdown labelled
     * by the mode the session's boundary is actually in (只读 / 自动 /
     * 完全权限); selecting an option fires `onPermissionModeChange`.
     * A read-only session displays 只读 without it becoming a third
     * option (#1611).
     */
    permissionMode?: PermissionMode;
    permissionModeDisabledReason?: string;
    onPermissionModeChange?(mode: PermissionMode): void | Promise<void>;
    /**
     * Plan mode — a temporary collaboration excursion, and a toggle because
     * that is what it is. Agent is the implicit default, so the composer only
     * carries whether Plan is on. Runtime ends the excursion by itself when a
     * proposal is approved or abandoned, which is why nothing here treats Plan
     * as a resting mode the user must leave by hand.
     */
    planModeActive?: boolean;
    planModeDisabledReason?: string;
    onPlanModeChange?(active: boolean): void | Promise<void>;
    /**
     * The Session's standing orchestration default. Of the field's three
     * values only Swarm and Graph name a way to fan a turn out; `default` is
     * the absence of one, so this is an optional choice between two rather
     * than a choice among three. The two are exclusive — a run carries one
     * orchestration — which is why the menu offers them as a radio group with
     * no selection at rest, not as two switches that would silently turn each
     * other off.
     *
     * Independent of Plan on purpose. The two are different fields with
     * different lifetimes: Plan gates which tools a turn gets, this names how
     * a turn fans out by default, and Runtime resolves the overlap by
     * stripping the subagent and agent-graph tools while planning. So "plan
     * with Swarm armed for afterwards" is a state the Session can hold, and
     * neither control writes the other's field.
     */
    orchestrationMode?: OrchestrationMode;
    orchestrationModeDisabledReason?: string;
    onOrchestrationModeChange?(mode: OrchestrationMode): void | Promise<void>;
    /**
     * Why a Goal cannot be set right now — a running Turn, typically. A Goal
     * takes hold on the Turn after it is armed, so arming during one reads as
     * having done nothing; the host names the reason and the entry shows it.
     */
    goalDisabledReason?: string;
    /**
     * Composer mention popups. Both are optional and the whole feature no-ops
     * when absent (SSR contracts render Composer with minimal props):
     *   - `mentionSkills` powers the `/` popup, which the ＋ menu's Skills entry
     *     opens by typing the trigger — one menu, one entry point in code. Pass
     *     only ENABLED skills; the composer filters them client-side and writes
     *     the chosen one into the draft as a `/skill:<id>` chip (human-in-the-
     *     loop, never auto-send).
     *   - `onSearchMentionFiles` powers the `@` popup.
     */
    mentionSkills?: ReadonlyArray<ComposerSkillOption>;
    /**
     * The host's SETTLED verdict on whether the catalog has anything to offer,
     * held steady across refreshes. The host clears `mentionSkills` while
     * re-fetching it (the `/` popup must stay fail-closed), so the list being
     * empty cannot tell "refreshing" from "no skills" — and reading the
     * transient `[]` as the latter disables the ＋ menu's Skills row and grows
     * it by a description line for the length of the round trip, blinking the
     * open menu's geometry on every mode or model change. Hosts that never
     * clear the list mid-flight can omit this; the row then falls back to
     * `mentionSkills.length === 0`.
     */
    mentionSkillsUnavailable?: boolean;
    /**
     * True while the host is re-fetching `mentionSkills`. The row's LOOK is
     * governed by `mentionSkillsUnavailable` and does not move during a
     * refresh; this flag governs what a click DOES. Mid-refresh the enabled
     * look is a held presentation of the previous catalog, not a promise the
     * current one can honor — acting on it would write a stray `/` into the
     * draft and pop an empty menu — so the row ignores clicks (and stops
     * closing the menu, so the click can simply be retried) until the catalog
     * settles.
     */
    mentionSkillsLoading?: boolean;
    slashCommands?: ReadonlyArray<ComposerSlashCommandOption>;
    onSearchMentionFiles?(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
  } & ComposerGoalProps
>(function Composer(props, ref) {
  const formRef = useRef<HTMLFormElement>(null);
  /** Astryx's imperative handle on the contentEditable input. */
  const inputHandleRef = useRef<ChatComposerInputHandle>(null);
  /** ChatComposerInput's root, from which the editable node is resolved. */
  const inputRootRef = useRef<HTMLDivElement>(null);
  function editableNode(): HTMLElement | null {
    return inputRootRef.current?.querySelector<HTMLElement>('[contenteditable="true"]') ?? null;
  }
  const [dragActive, setDragActive] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const modelSwitchAvailability =
    props.modelSwitchAvailability ??
    deriveComposerModelSwitchAvailability({
      streaming: props.streaming,
      sessionStatus: props.activeSession?.status,
    });
  const modelSwitchAvailabilityRef = useRef(modelSwitchAvailability);
  modelSwitchAvailabilityRef.current = modelSwitchAvailability;
  useLayoutEffect(() => setModelPickerOpen(false), [props.activeSession?.id]);
  const [pendingImportAction, setPendingImportAction] = useState<ComposerImportActionId | null>(null);
  const composerMountedRef = useMountedRef();
  const sendPendingRef = useRef(false);
  const compositionActiveRef = useRef(false);
  const plainTextPasteInputActiveRef = useRef(false);
  const importActionOwnerRef = useRef<ChatInputActionOwner<ComposerImportActionId> | null>(null);
  if (!importActionOwnerRef.current) {
    importActionOwnerRef.current = createChatInputActionOwner((action) => {
      if (composerMountedRef.current) setPendingImportAction(action);
    });
  }
  // The input is controlled: `text` is the serialized draft (inline tokens
  // collapse to their values), mirrored into a ref so the imperative handle —
  // memoized with an empty dep list — always reads the live value.
  const [text, setText] = useState('');
  const textRef = useRef('');
  function applyText(next: string) {
    // Every value passes through here, which makes this the one place an
    // external write can be defined against: whatever the last write owed, a
    // newer value cancels. `textPort.setValue` re-arms both flags right after.
    // Without the clear, a `setValue` React bails out of (the new draft equals
    // the old one, so no commit and no effect) leaves them armed until some
    // unrelated later render — where the caret jumps to the end mid-word, and a
    // half-typed `/skill:` seizes into a chip under it.
    caretToEndRef.current = false;
    redrawPendingRef.current = false;
    textRef.current = next;
    setText(next);
  }
  /**
   * The two operations the draft / history hooks need from the input. Stable
   * identity so neither hook re-runs an effect when the draft changes.
   */
  const caretToEndRef = useRef(false);
  /** A caret-to-end owed to an editor that was not focused when it came due. */
  const caretPendingRef = useRef(false);
  const redrawPendingRef = useRef(false);
  const textPortRef = useRef<ComposerTextPort>(null);
  if (!textPortRef.current) {
    textPortRef.current = {
      getValue: () => textRef.current,
      setValue: (value: string) => {
        applyText(value);
        caretToEndRef.current = true;
        redrawPendingRef.current = true;
      },
    };
  }
  const textPort = textPortRef.current;
  /**
   * ChatComposerInput restores the caret to the end of the content when a
   * controlled update lands on a *focused* editor, so callers that want the old
   * "focus at end" behavior focus first, then set the value.
   *
   * A draft that was rewritten while the editor was blurred never got that
   * restore — switching sessions from the sidebar swaps the draft with focus
   * elsewhere, and the next programmatic focus (Esc out of the artifact pane,
   * say) then landed the caret at offset 0, so typing prepended to the restored
   * draft. Collapse to the end here when the editor holds no selection of its
   * own, which is what the retired `focusTextInputAtEnd` did unconditionally.
   *
   * Only on a focused editor, though. A selection inside a `contenteditable` is
   * never only a caret: the browser focuses the element to carry it, whatever
   * held focus before — measured in the shipping runtime, a selection placed
   * here takes focus from a focused button exactly as it takes it from `body` —
   * and sequential focus navigation then resumes from the selection rather than
   * from the top of the document. So a restored draft claimed focus nobody
   * directed at it: on a cold start, tens of milliseconds in, past the skip link
   * and with no `focus()` call to explain it; and on a session swap, out from
   * under the sidebar row the user had just activated. Hold the caret while the
   * editor is not focused and land it on the editor's next real focus, which is
   * the first moment the offset is the only thing being decided.
   */
  function caretToContentEnd() {
    const editable = editableNode();
    if (!editable) return;
    if (document.activeElement !== editable) {
      caretPendingRef.current = true;
      return;
    }
    caretPendingRef.current = false;
    const selection = document.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  function focusInput() {
    inputHandleRef.current?.focus();
    const editable = editableNode();
    const selection = document.getSelection();
    if (!editable || (selection?.anchorNode && editable.contains(selection.anchorNode))) return;
    caretToContentEnd();
  }
  /**
   * Settle a held caret when focus reaches the editor for real. On the component
   * root, like the other native listeners here: `focusin` and `pointerdown`
   * bubble, and a disabled composer renders no editable to look up at mount.
   *
   * A pointer press places the caret itself and is the more specific intent, so
   * it drops the claim rather than being overruled by it.
   */
  useEffect(() => {
    const root = inputRootRef.current;
    if (!root) return undefined;
    const land = () => {
      if (caretPendingRef.current) caretToContentEnd();
    };
    const drop = () => {
      caretPendingRef.current = false;
    };
    root.addEventListener('focusin', land);
    root.addEventListener('pointerdown', drop);
    return () => {
      root.removeEventListener('focusin', land);
      root.removeEventListener('pointerdown', drop);
    };
  }, []);
  /**
   * The ＋ menu's Skills entry opens the same `/` menu the keyboard opens: it
   * types the trigger for the user. There is no second Skill surface to keep in
   * step with this one, because there is no second surface.
   *
   * `useTriggerMenu` only recognizes a trigger at a line start or after a space
   * or newline (`findActiveTrigger`), so a draft ending in a word — or in a chip,
   * which `insertToken` anchors with U+00A0 — needs a space in front of the
   * slash or the menu silently never opens. One `insertText` carries both, so
   * the editor sees a single input event and a single undo step.
   *
   * Deferred a frame: the DropdownMenu returns focus to ＋ as it closes, and a
   * focus call racing that lands the caret nowhere.
   *
   * `caretToContentEnd` unconditionally, not `focusInput`: the latter keeps a
   * selection the editor already owns, and the menu round trip leaves a stale
   * one collapsed at offset 0 — measured, the slash landed in front of the
   * draft rather than after it. Appending from ＋ is the predictable read
   * anyway. With the caret at the end, the character before it is the last
   * character of the content, chips included (U+00A0, which is not a space, so
   * it takes the space too).
   */
  function openSkillMenu() {
    window.requestAnimationFrame(() => {
      inputHandleRef.current?.focus();
      caretToContentEnd();
      const previous = (editableNode()?.textContent ?? '').at(-1);
      const needsSpace = previous !== undefined && previous !== ' ' && previous !== '\n';
      document.execCommand('insertText', false, needsSpace ? ' /' : '/');
    });
  }
  /**
   * Redraw the chips a controlled write flattened.
   *
   * `ChatComposerInput` rebuilds the editor from the string on every external
   * value change (`editable.textContent = controlledValue`), which is correct
   * for text and lossy for tokens: the chip spans go, and the draft comes back
   * as the `/skill:<id>` text they serialize to. Upstream declares a
   * `deserialize` hook for exactly this and never calls it (facebook/astryx
   * #4655), so until it does, we re-insert the chips ourselves.
   *
   * Nothing is recovered here that was not already in the string — the draft
   * stays the single source of truth, and this only restores its rendering.
   * That is what keeps it deletable in one piece: when upstream deserializes,
   * this function and its one call site go, and no state goes with them.
   *
   * Three preconditions, all cheap, all necessary:
   *
   * - Only for an external write. `redrawPendingRef` is set by `textPort.setValue`
   *   — the sole funnel for draft swap, history recall and the imperative handle
   *   — and cleared by `applyText`, so a user who has taken the draft back never
   *   watches a half-typed `/skill:` seize into a chip under the caret.
   * - Only on the DOM shape that write produces: exactly one text node equal to
   *   the draft. Anything else means upstream skipped the rewrite (the chips are
   *   still there) or the editor is in a shape whose offsets we cannot trust.
   * - Never mid-composition. The rewrite already broke the IME's composition;
   *   moving the selection on top of that makes it worse.
   *
   * A pending redraw survives a failed attempt, and that is the whole reason it
   * is a flag rather than a call at the write. The two inputs do not arrive
   * together: switching sessions swaps the draft on the spot while the Skill
   * catalog for the newly active session lands a render or two later, still
   * holding the previous session's Skills. Clearing on the first attempt would
   * read that stale catalog as proof the token is unresolvable and give up for
   * good. Retrying costs one regex over a short draft on renders where a write
   * is outstanding, and every other precondition — mid-composition, an
   * unexpected DOM — gets the same second chance for free.
   *
   * Back to front, because `Range.deleteContents` inside a text node leaves the
   * original node holding the text before the range: earlier offsets stay valid,
   * later ones would not. The token's own matched text becomes the chip value,
   * not a value rebuilt from the catalog id, so a differently-cased token comes
   * back spelled the way the draft spells it.
   *
   * `insertToken` anchors each chip with a U+00A0, so we take the following
   * space into the replaced range to keep one separator rather than two. The
   * draft therefore serializes with U+00A0 where it had a space, and with one
   * extra U+00A0 when a token ends the draft. That is the same text a chip
   * picked from the `/` menu produces, `composerWireText` normalizes it on send,
   * and upstream's sync effect is keyed on the controlled value rather than on
   * the serialization, so the difference cannot loop back as a rewrite.
   *
   * A token whose id is not in the live catalog stays text: no chip should claim
   * a Skill that will not resolve.
   */
  function redrawSkillTokens(): boolean {
    if (compositionActiveRef.current) return false;
    const skills = props.mentionSkills;
    if (!skills?.length) return false;
    const draft = textRef.current;
    if (!draft.includes('/skill:')) return false;
    const editable = editableNode();
    const node = editable?.firstChild;
    if (!editable || editable.childNodes.length !== 1) return false;
    if (!(node instanceof Text) || node.data !== draft) return false;
    const byId = new Map(skills.map((skill) => [skill.id.toLowerCase(), skill]));
    const matches = [...draft.matchAll(new RegExp(SKILL_INVOCATION_TOKEN_SOURCE, 'g'))];
    const selection = document.getSelection();
    if (!selection) return false;
    let redrew = false;
    for (let i = matches.length - 1; i >= 0; i--) {
      const match = matches[i];
      const skill = byId.get(match[1].toLowerCase());
      if (!skill) continue;
      const start = match.index;
      let end = start + match[0].length;
      const next = draft[end];
      if (next === ' ' || next === '\u00A0') end += 1;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      selection.removeAllRanges();
      selection.addRange(range);
      inputHandleRef.current?.insertToken(
        inlineReferenceToken({ kind: 'skill', value: match[0], label: skill.name }),
      );
      redrew = true;
    }
    return redrew;
  }
  /**
   * Every port write lands the caret at the end, which is what the textarea's
   * `setSelectionRange(end, end)` did unconditionally on the same two paths
   * (draft swap, prompt-history recall). Upstream only restores the caret when
   * the update hits a *focused* editor, so without this a draft restored while
   * the composer was blurred — switching sessions from the sidebar — left the
   * caret at offset 0 and the next keystroke prepended to the draft.
   *
   * The redraw gets the same treatment for the same reason, and can land a
   * render later than the write that owed it: `insertToken` parks the selection
   * after the last chip it wrote, so the caret has to be collected again.
   *
   * A held caret is suspended across the redraw rather than left armed. The
   * redraw drives `insertToken` through the document selection, and its first
   * range focuses the editor — which would otherwise fire the focus lander onto
   * the very range the redraw is holding, collapsing it to the end so the chip
   * landed at the end and its source text stayed in the draft. The redraw ends
   * by collecting the caret itself, so on success the claim is settled; on a
   * pass that redrew nothing it is handed back untouched.
   */
  useEffect(() => {
    let restoreCaret = caretToEndRef.current;
    caretToEndRef.current = false;
    if (redrawPendingRef.current) {
      const heldCaret = caretPendingRef.current;
      caretPendingRef.current = false;
      const redrew = redrawSkillTokens();
      caretPendingRef.current = redrew ? false : heldCaret;
      if (redrew) {
        redrawPendingRef.current = false;
        restoreCaret = true;
      }
    }
    if (restoreCaret) caretToContentEnd();
  });
  // Draft persistence + prompt-history navigation live in dedicated hooks
  // (issue #1044). `resetPromptHistoryNavigation` is a hoisted wrapper so the
  // draft hook's swap effect can reset history navigation even though the
  // history hook is created one line below it.
  const {
    saveCurrentDraft,
    clearDraft,
    setDraft,
    getDraft,
    appendDraft,
    activeDraftKey,
  } = useComposerDraft({
    text: textPort,
    draftKey: props.draftKey,
    onDraftKeyChange: resetPromptHistoryNavigation,
    persistence: props.draftPersistence,
  });
  const { resetNavigation, rememberSentEntry, handleArrowKey } = useComposerHistory({
    text: textPort,
    saveCurrentDraft,
  });
  // PR-UI-15: locale-aware copy for placeholder + toolbar states.
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).composer;
  const mentionCopy = getConversationCopy(locale).mentions;

  useEffect(() => {
    return () => {
      sendPendingRef.current = false;
      importActionOwnerRef.current?.reset();
    };
  }, []);

  /**
   * Nothing may act on a keystroke the IME is still using.
   *
   * ChatComposerInput runs its own trigger-menu key handling *before* the
   * `onKeyDown` we pass it, and that handler takes Enter as "accept the
   * highlighted suggestion" without checking `isComposing` — so a guard inside
   * our handler would arrive too late to stop a CJK candidate commit from
   * inserting a file mention. A native listener on the component root fires
   * before React dispatches at its own root container, so stopping propagation
   * here takes the key away from every React handler at once, theirs and ours.
   */
  useEffect(() => {
    const root = inputRootRef.current;
    if (!root) return undefined;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isChatInputComposing(event, compositionActiveRef.current)) event.stopPropagation();
    };
    root.addEventListener('keydown', onKeyDown);
    return () => root.removeEventListener('keydown', onKeyDown);
  }, []);

  /**
   * A multi-line insert has to survive the editor, and Chrome's answer doesn't:
   * an `insertText` carrying newlines lands as one text node with the newlines
   * dropped outright. Measured, not inferred — with this listener disabled,
   * inserting `one\ntwo\nthree` yields `onetwothree`. Replay it as the
   * browser's own line-break command, which produces the `<br>` Astryx's
   * serializer does understand and which the controlled round trip then stores
   * as a real newline; unlike a scripted Range insertion it also keeps the
   * caret and the undo stack intact. Typed line breaks don't come through here;
   * `onInputKeyDown` owns Enter, and `insertLineBreak` already serializes
   * correctly.
   *
   * Reached by any programmatic multi-line insert: dictation and IME block
   * commits in the product, and `fill()` in the E2E suite (which is what the
   * Markdown code-paste journey exercises).
   *
   * Listen on the component root, not the editable: `beforeinput` bubbles, and
   * a host that mounts the composer disabled renders `contenteditable="false"`,
   * so an editable lookup here would miss and never retry.
   */
  useEffect(() => {
    const root = inputRootRef.current;
    if (!root) return undefined;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== 'insertText') return;
      const lines = (event.data ?? '').split('\n');
      if (lines.length < 2) return;
      event.preventDefault();
      for (const [index, line] of lines.entries()) {
        if (index > 0) document.execCommand('insertLineBreak');
        if (line) document.execCommand('insertText', false, line);
      }
    };
    root.addEventListener('beforeinput', onBeforeInput);
    return () => root.removeEventListener('beforeinput', onBeforeInput);
  }, []);

  function resetPromptHistoryNavigation() {
    resetNavigation();
  }

  // The `@` / `/` menus are Astryx trigger menus now. `useTriggerMenu` compares
  // the active trigger by identity on every input event, so the trigger objects
  // and their sources must not be rebuilt per render — they read live props
  // through this ref instead.
  const mentionSourceRef = useRef({
    mentionSkills: props.mentionSkills,
    slashCommands: props.slashCommands,
    onSearchMentionFiles: props.onSearchMentionFiles,
    commandsGroup: mentionCopy.commandsGroup,
    skillsGroup: mentionCopy.skillsGroup,
  });
  mentionSourceRef.current = {
    mentionSkills: props.mentionSkills,
    slashCommands: props.slashCommands,
    onSearchMentionFiles: props.onSearchMentionFiles,
    commandsGroup: mentionCopy.commandsGroup,
    skillsGroup: mentionCopy.skillsGroup,
  };

  const searchSourcesRef = useRef<{ files: SearchSource; skills: SearchSource }>(null);
  if (!searchSourcesRef.current) {
    const runFileSearch = (query: string): Promise<SearchableItem[]> => {
      const search = mentionSourceRef.current.onSearchMentionFiles;
      return (search ? search(query) : Promise.resolve([])).then((files) =>
        files
          .filter((file) => mentionQueryMatches(query, file.relativePath))
          .slice(0, 50)
          .map((file) => ({ id: file.relativePath, label: file.relativePath })),
      );
    };
    const files = createTriggerSearchSource<SearchableItem>(runFileSearch);
    const listSlashSuggestions = (rawQuery: string): SearchableItem[] => {
      const source = mentionSourceRef.current;
      const skills = source.mentionSkills ?? [];
      const editable = editableNode();
      const selection = document.getSelection();
      let textBeforeCaret = textPort.getValue();
      let textAfterCaret = '';
      if (
        editable &&
        selection?.focusNode &&
        editable.contains(selection.focusNode)
      ) {
        const range = document.createRange();
        range.selectNodeContents(editable);
        range.setEnd(selection.focusNode, selection.focusOffset);
        textBeforeCaret = range.toString();
        range.selectNodeContents(editable);
        range.setStart(selection.focusNode, selection.focusOffset);
        textAfterCaret = range.toString();
      }
      const commandQuery = slashCommandQuery(textBeforeCaret, textAfterCaret, rawQuery);
      const query = skillMentionQuery(rawQuery);
      const commandItems = commandQuery === null
        ? []
        : (source.slashCommands ?? [])
            .filter((command) =>
              mentionQueryMatches(
                commandQuery,
                `${command.id} ${command.name} ${command.description ?? ''} ${(command.keywords ?? []).join(' ')}`,
              ),
            )
            .map((command) => ({
              id: `command:${command.id}`,
              label: command.name,
              auxiliaryData: {
                kind: 'command',
                command,
                group: source.commandsGroup,
              } satisfies ComposerSlashSuggestion,
            }));
      const skillItems = skills
        .filter((skill) =>
          mentionQueryMatches(query, `${skill.id} ${skill.name} ${skill.description ?? ''}`),
        )
        .map((skill) => ({
          id: `skill:${skill.id}`,
          label: skill.name,
          auxiliaryData: {
            kind: 'skill',
            skill,
            group: source.skillsGroup,
          } satisfies ComposerSlashSuggestion,
        }));
      return [...commandItems, ...skillItems].slice(0, 50);
    };
    // `bootstrap` is required by SearchSource but never called by
    // `useTriggerMenu`; the menu opens straight into `search`.
    searchSourcesRef.current = {
      files,
      skills: {
        bootstrap: () => listSlashSuggestions(''),
        search: listSlashSuggestions,
      },
    };
  }

  // Rebuilt only when the locale changes (the menus carry localized labels);
  // a closed menu is the only state a rebuild can disturb.
  const triggers = useMemo<ChatComposerTrigger[]>(() => {
    const sources = searchSourcesRef.current!;
    const list: ChatComposerTrigger[] = [];
    if (props.onSearchMentionFiles) {
      list.push({
        character: '@',
        searchSource: sources.files,
        menuLabel: mentionCopy.filesAriaLabel,
        emptySearchResultsText: mentionCopy.noFiles,
        loadingText: mentionCopy.loading,
        renderItem: (item) => (
          <>
            <FileText size={ICON_SIZE.control} aria-hidden="true" className="maka-composer-mention-icon" />
            <span className="maka-composer-mention-text">
              <span className="maka-composer-mention-name">{inlineReferenceFileBasename(item.id)}</span>
              <span className="maka-composer-mention-secondary">{item.id}</span>
            </span>
          </>
        ),
        // The token serializes back to `@<path>`, so the mention reaches the
        // model exactly as the plain-text popup used to splice it in — it just
        // reads as a chip while the draft is being composed.
        //
        // One difference, and it is not free: `insertToken` anchors the token
        // with U+00A0 rather than a plain space. `composerWireText` normalizes
        // that away on send, and the skill token grammar's `\s` boundary
        // matches it either way — but `findActiveTrigger` accepts only ' ' and
        // '\n' as a trigger boundary, so typing `@` directly after a chip
        // opens no menu until the user types a space. That boundary set is
        // internal to `useTriggerMenu`; the fix belongs upstream.
        onSelect: (item): ChatComposerToken =>
          inlineReferenceToken(workspaceFileInlineReference(item.id)),
      });
    }
    if (
      props.mentionSkills !== undefined ||
      (props.slashCommands?.length ?? 0) > 0
    ) {
      list.push({
        character: '/',
        searchSource: sources.skills,
        menuLabel:
          (props.slashCommands?.length ?? 0) > 0
            ? mentionCopy.commandsAndSkillsAriaLabel
            : mentionCopy.skillsAriaLabel,
        emptySearchResultsText:
          (props.slashCommands?.length ?? 0) > 0
            ? mentionCopy.noCommandsOrSkills
            : mentionCopy.noSkills,
        loadingText: mentionCopy.loading,
        // Name over description, and no id: the second line is one line wide,
        // and the id spent a dozen characters of it on a string nobody types
        // here — the menu is how you avoid typing it. It stays searchable
        // (the slash source matches against it) and it is still what the chip
        // serializes to; it just no longer crowds out the sentence that tells
        // two Skills apart.
        //
        // Visible, not a tooltip: every menu item in Astryx — dropdown, radio,
        // checkbox, submenu — carries its explanation as a `description` line,
        // and none carries one on hover. A `/` menu is driven with ↑↓, so a
        // hover-only description would be invisible to the way it is used.
        renderItem: (item) => {
          const suggestion = item.auxiliaryData as ComposerSlashSuggestion;
          if (suggestion.kind === 'command') {
            const { command } = suggestion;
            const Icon = command.Icon;
            return (
              <>
                {Icon ? (
                  <Icon
                    size={ICON_SIZE.control}
                    aria-hidden="true"
                    className="maka-composer-mention-icon"
                  />
                ) : null}
                <span className="maka-composer-mention-text">
                  <span className="maka-composer-mention-name">
                    {command.name}
                    <span className="maka-composer-command-token">/{command.id}</span>
                  </span>
                  <span className="maka-composer-mention-secondary">
                    {command.description}
                  </span>
                </span>
              </>
            );
          }
          const { skill } = suggestion;
          return (
            <>
              <Sparkles size={ICON_SIZE.control} aria-hidden="true" className="maka-composer-mention-icon" />
              <span className="maka-composer-mention-text">
                <span className="maka-composer-mention-name">{skill.name}</span>
                <span className="maka-composer-mention-secondary">{skill.description}</span>
              </span>
            </>
          );
        },
        // A chosen Skill is an inline chip in the draft — Astryx's own
        // `onSelect → ChatComposerToken` contract, the same one `@` uses.
        //
        // It used to be a selection held beside the draft and shown in the
        // context drawer. That made the staged Skill a second source of truth
        // for one fact, and every draft operation had to carry it separately:
        // per-session persistence, prompt history, blocked-send recovery and
        // revision rollback each had their own Skill-shaped twin. In the text
        // there is one draft, and `/skill:<id>` is already the invocation
        // grammar Runtime parses — so the chip a user picks and the token a
        // user types are the same thing, and both survive every path the text
        // survives.
        //
        // No colour: Maka blue is the single product accent, and a staged
        // Skill is identified by its sparkle and its label.
        onSelect: (item): string | ChatComposerToken => {
          const suggestion = item.auxiliaryData as ComposerSlashSuggestion;
          if (suggestion.kind === 'command') {
            return `/${suggestion.command.id} `;
          }
          return inlineReferenceToken({
            kind: 'skill',
            value: skillTokenValue(suggestion.skill.id),
            label: suggestion.skill.name,
          });
        },
      });
    }
    return list;
    // The sources live in a ref, so only the localized copy, provider presence,
    // and the Skill projection identity (see the refresh effect below) matter.
  }, [
    locale,
    Boolean(props.onSearchMentionFiles),
    props.mentionSkills,
    props.slashCommands,
  ]);

  /**
   * A visible `/` menu must never keep offering a Skill the host has since
   * withdrawn (mode change, session rebind, MCP event). The Astryx trigger menu
   * only searches on input, so replay one input event when the projection
   * changes while the menu is open: `triggers` was rebuilt on the same render,
   * so `useTriggerMenu` sees a new active trigger and re-runs the search.
   */
  useEffect(() => {
    const editable = editableNode();
    if (editable?.getAttribute('aria-expanded') !== 'true') return;
    editable.dispatchEvent(new Event('input', { bubbles: true }));
  }, [locale, props.mentionSkills, props.slashCommands]);

  /**
   * An open menu must follow the caret, not just the text. `useTriggerMenu`
   * recomputes the active trigger only from `input`, so moving the caret off
   * the query with an arrow key left the menu open over a trigger that is no
   * longer under the cursor — and the next Enter then "accepted" a suggestion,
   * splicing a token in at the stale offset and swallowing the send. The
   * retired popup tracked this with its own `selectionchange` listener; this is
   * the same listener, replaying one input event so upstream re-derives the
   * trigger (and closes the menu when there is none) from its own grammar.
   *
   * Only while a menu is open, and only for a caret inside this editor: the
   * event fires document-wide for every selection change on the page.
   */
  useEffect(() => {
    const onSelectionChange = () => {
      const editable = editableNode();
      if (editable?.getAttribute('aria-expanded') !== 'true') return;
      const anchor = document.getSelection()?.anchorNode;
      if (!anchor || !editable.contains(anchor)) return;
      editable.dispatchEvent(new Event('input', { bubbles: true }));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, []);

  /**
   * Reference-sized pastes never flood the input. When the host stages quotes
   * they keep becoming drawer chips (the send path still carries them as
   * structured `QuoteRef`s); otherwise Astryx's paste-as-token folds them into
   * an expandable inline chip instead of dumping the whole blob inline.
   */
  const pasteAsInlineToken = useChatPasteAsToken({
    inputRef: inputHandleRef,
    threshold: 0,
    toToken: (pasted) => ({ value: pasted, label: copy.pastedQuoteLabel }),
  });
  const pasteAsToken = {
    onPaste: (event: ClipboardEvent<HTMLDivElement>, pasted: string) => {
      if (props.disabled || !isReferenceSizedPaste(pasted)) return false;
      if (props.onPasteAsQuote) {
        props.onPasteAsQuote({ text: pasted, label: copy.pastedQuoteLabel });
        return true;
      }
      return pasteAsInlineToken.onPaste(event, pasted);
    },
  };

  useImperativeHandle(
    ref,
    () => ({
      setText(nextText: string) {
        resetPromptHistoryNavigation();
        // Focus first: the controlled update that follows restores the caret to
        // the end of the new content only when the editor already has focus.
        focusInput();
        textPort.setValue(nextText);
        saveCurrentDraft(nextText);
      },
      appendText(nextText: string) {
        resetPromptHistoryNavigation();
        const next = appendPromptContextDraft(textPort.getValue(), nextText);
        focusInput();
        textPort.setValue(next);
        saveCurrentDraft(next);
      },
      getText() {
        return textPort.getValue();
      },
      clearDraft(draftKey: string) {
        clearDraft(draftKey);
        if (activeDraftKey() !== draftKey) return;
        textPort.setValue('');
        saveCurrentDraft('');
      },
      setDraft(draftKey: string, nextText: string) {
        setDraft(draftKey, nextText);
        if (activeDraftKey() !== draftKey) return;
        resetPromptHistoryNavigation();
        focusInput();
        textPort.setValue(nextText);
      },
      getDraft(draftKey: string) {
        return getDraft(draftKey);
      },
      appendDraft(draftKey: string, nextText: string) {
        const next = appendDraft(draftKey, nextText);
        if (activeDraftKey() !== draftKey) return;
        resetPromptHistoryNavigation();
        focusInput();
        textPort.setValue(next);
      },
      focus() {
        focusInput();
      },
      openModelPicker() {
        if (!modelSwitchAvailabilityRef.current.available) return;
        setModelPickerOpen(true);
      },
    }),
    [],
  );

  async function sendCurrent(followUpMode?: FollowUpMode) {
    if (
      props.disabled
      || props.sendBlocked
      || sendPendingRef.current
      || importActionOwnerRef.current?.pending
    ) return;
    // There is one authoritative draft: staged Skills and files serialize into
    // `text`. The optional metadata below is a send-time rendering snapshot of
    // file chips that still exist in the editor, not a second draft state.
    const text = composerWireText(textPort.getValue());
    if (!text) return;
    const editable = editableNode();
    const workspaceFileReferences = editable ? workspaceFileReferencePositions(editable) : [];
    const submittedDraftKey = activeDraftKey();
    sendPendingRef.current = true;
    setSendPending(true);
    let sent: boolean | void;
    try {
      const metadata: ComposerSendMetadata = {
        ...(workspaceFileReferences.length > 0 ? { workspaceFileReferences } : {}),
        ...(followUpMode ? { followUpMode } : {}),
      };
      sent = await props.onSend(text, Object.keys(metadata).length > 0 ? metadata : undefined);
    } finally {
      sendPendingRef.current = false;
      if (composerMountedRef.current) setSendPending(false);
    }
    if (!composerMountedRef.current) return;
    if (sent === false) return;
    // Save to both local ref and global persistence so the history
    // survives page reloads and is shared across all input surfaces.
    rememberSentEntry(text);
    // The owner may have changed while onSend awaited (new-session creation,
    // revision branch, or user navigation). Never erase a foreign draft.
    if (activeDraftKey() !== submittedDraftKey) {
      clearDraft(submittedDraftKey);
      return;
    }
    // The user can begin the next message while the send IPC is still
    // resolving. Clear only the exact draft that was submitted; a newer value
    // belongs to the next send and must survive this older completion.
    if (composerWireText(textPort.getValue()) !== text) {
      saveCurrentDraft(textPort.getValue());
      return;
    }
    clearDraft(submittedDraftKey);
    textPort.setValue('');
    saveCurrentDraft('');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Mid-turn the host queues the draft as a follow-up by default; only
    // Shift+Enter (see onInputKeyDown) steers it into the active Turn.
    void sendCurrent();
  }

  const attachmentImportBlocked = Boolean(
    props.disabled
      || (props.streaming && !props.allowAttachmentImportWhileStreaming),
  );

  async function runImportAction(actionId: ComposerImportActionId, action: (() => void | Promise<void>) | undefined) {
    if (!action || attachmentImportBlocked) return;
    await importActionOwnerRef.current?.run(actionId, async () => {
      await action();
    });
  }

  /**
   * Our key conventions, hosted on `ChatComposerInput`'s `onKeyDown` seam. It
   * runs AFTER the trigger menu has had its turn (arrows / Enter / Tab / Esc
   * navigate and select a mention there) and BEFORE the input's own Enter
   * handling — which we always pre-empt, because a send can be rejected and
   * the built-in submit clears the editor unconditionally.
   */
  function onInputKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keystrokes made during an IME composition never reach this handler — the
    // native listener above takes them away from React entirely.
    if (event.key === 'Enter' && event.currentTarget.getAttribute('aria-expanded') === 'true') {
      // A trigger menu that is open but has nothing highlighted (loading, or no
      // matches) leaves Enter unconsumed. Swallow this one so a mention query
      // can't send the draft out from under the popup — and close the menu,
      // because "@" with no matches is otherwise a stable state in which Enter
      // never sends again.
      event.preventDefault();
      event.currentTarget.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      return;
    }
    // Esc while a drag-active highlight is showing should clear it
    // immediately. The existing useEffect listens for blur/dragend/drop
    // but not keydown, so a user who hits Esc to cancel a stuck drag
    // gesture would otherwise see the highlight linger until they
    // blurred the window or completed a real drop somewhere.
    if (event.key === 'Escape' && dragActive) {
      setDragActive(false);
    }
    // Esc during streaming interrupts the model. We don't preventDefault
    // unconditionally so Esc still works to close modals when the composer
    // happens to be focused outside a streaming turn.
    if (event.key === 'Escape' && props.streaming) {
      event.preventDefault();
      if (props.stopPending) return;
      props.onStop();
      return;
    }
    // PR-GLOBAL-INPUT-HISTORY: up/down arrow navigates the global input
    // history; the state machine + textarea application live in
    // useComposerHistory (issue #1044). A consumed keystroke stops here so it
    // can't fall through to send.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (handleArrowKey(event)) return;
    }
    if (event.key !== 'Enter') return;
    // Alt+Enter always inserts a line break. During a running turn, Shift+Enter
    // steers this one draft into the active Turn; plain Enter queues it.
    if (event.altKey || (event.shiftKey && !props.streaming)) {
      event.preventDefault();
      document.execCommand('insertLineBreak');
      return;
    }
    event.preventDefault();
    void sendCurrent(props.streaming && event.shiftKey ? 'steer' : undefined);
  }

  function onInputChange(next: string) {
    applyText(next);
    resetPromptHistoryNavigation();
    saveCurrentDraft(next);
  }

  function canAcceptDroppedFiles(): boolean {
    return Boolean(
      props.onAttachFilePaths
        && !attachmentImportBlocked
        && !importActionOwnerRef.current?.pending,
    );
  }

  function hasDraggedFiles(event: DragEvent<HTMLFormElement>): boolean {
    return fileTransferContainsFiles(event.dataTransfer.types, event.dataTransfer.files.length);
  }

  function onComposerDragOver(event: DragEvent<HTMLFormElement>) {
    if (!canAcceptDroppedFiles() || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }

  function onComposerDragLeave(event: DragEvent<HTMLFormElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  }

  function onComposerDrop(event: DragEvent<HTMLFormElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    setDragActive(false);
    if (!canAcceptDroppedFiles()) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    void runImportAction('attach', () => props.onAttachFilePaths?.(files));
  }

  /**
   * Files pasted into the input (screenshot shortcut, Finder copy) take the
   * same import path as a drop. `ChatComposerInput` routes them here before it
   * looks at text, so the clipboard-file branch of the old paste handler is
   * gone — only the acceptance gate remains ours.
   */
  function onInputFiles(files: File[]) {
    if (!canAcceptDroppedFiles() || files.length === 0) return;
    void runImportAction('attach', () => props.onAttachFilePaths?.(files));
  }

  useEffect(() => {
    if (!dragActive) return undefined;
    const clearDragActive = () => setDragActive(false);
    window.addEventListener('blur', clearDragActive);
    window.addEventListener('dragend', clearDragActive);
    window.addEventListener('drop', clearDragActive);
    return () => {
      window.removeEventListener('blur', clearDragActive);
      window.removeEventListener('dragend', clearDragActive);
      window.removeEventListener('drop', clearDragActive);
    };
  }, [dragActive]);

  const importActionBusy = pendingImportAction !== null;
  const noModelConnection = props.noModelConnection === true;
  const sendDisabled =
    props.disabled ||
    props.sendBlocked ||
    sendPending ||
    importActionBusy ||
    !text.trim() ||
    noModelConnection;
  // The disabled Send is explanatory only in the no-model dead-end; other
  // disabled reasons (empty draft, in-flight import) keep the neutral label.
  const sendTitle = noModelConnection && !props.disabled ? copy.noModelSendTitle : copy.sendLabel;
  // One slot, one button, two states — Astryx's send/stop toggle. Mid-turn an
  // empty draft has nothing to submit, so the slot is Stop; the moment there is
  // a draft, handing it over is the only meaningful action there and the button
  // returns to Send (the host queues it as a follow-up). Stop is not lost in
  // that window: Esc interrupts from the input, which is where the hands already
  // are.
  const stopShown = props.streaming === true && !text.trim();
  // The pending plate renders the follow-up queue only: steering entries are
  // already handed to the active Turn and leave the plate at that moment.
  const queueCount = props.queuedMessages?.length ?? 0;
  const modelChipLabel = props.modelLabel?.trim() || copy.selectModel;
  // Mid-turn the model and thinking menus stay mounted but locked, each
  // carrying the reason in its own words (model vs thinking level) — the
  // lock is one state with two wordings, not two locks.
  const switchLock = modelSwitchAvailability.available
    ? undefined
    : modelSwitchAvailability.reason;
  const modelSwitcherDisabledReason =
    switchLock === 'streaming' ? copy.switchDisabledStreaming
    : switchLock === 'running' ? copy.switchDisabledRunning
    : switchLock === 'permission' ? copy.switchDisabledPermission
    : undefined;
  const thinkingSwitcherDisabledReason =
    switchLock === 'streaming' ? copy.thinkingDisabledStreaming
    : switchLock === 'running' ? copy.thinkingDisabledRunning
    : switchLock === 'permission' ? copy.thinkingDisabledPermission
    : undefined;

  /**
   * The drawer's contract is context staged for the *next send*: quotes and
   * attachments are consumed when the message goes out, and this count tells
   * the user how many such items are pending. Plan / Swarm / Graph are
   * session-scoped modes that survive the send, so they are not counted here
   * and no longer render inside the drawer (#1897) — they read as mode state
   * on the footer toolbar instead. Skills are not counted either: a staged
   * Skill is a chip in the draft itself, visible where it will be sent from.
   */
  const drawerTokenCount =
    (props.pendingQuotes?.length ?? 0) +
    (props.pendingAttachments?.length ?? 0) +
    (props.pendingDirectories?.length ?? 0);
  /** The last staged image opened from a chip (Lightbox media shape). Kept
   *  mounted after close — see the Lightbox render — so only the open flag
   *  drives visibility. */
  const [attachmentLightbox, setAttachmentLightbox] = useState<{
    src: string;
    alt: string;
    caption: string;
  } | null>(null);
  const [attachmentLightboxOpen, setAttachmentLightboxOpen] = useState(false);
  useEffect(() => {
    if (attachmentLightboxOpen || !attachmentLightbox) return;
    // Unmount one commit AFTER the closed render, never in it: child effects
    // run first, so Astryx has already executed dialog.close() — the native
    // hand-back of focus to the chip button — by the time this fires. The
    // deferred unmount also keeps the DOM to a single .astryx-lightbox for
    // the chat transcript's own lightbox.
    setAttachmentLightbox(null);
  }, [attachmentLightboxOpen, attachmentLightbox]);
  /**
   * The orchestration modes the ＋ menu offers — the field's two real values.
   *
   * `default` is not among them and has no row: it is not a third thing to
   * pick, it is what the Session is when neither of these is chosen. The group
   * carries that as no selection, which is a state Astryx's radio group takes
   * (`value: string | undefined`) and screen readers announce as a set with
   * nothing checked.
   */
  const orchestrationOptions: ReadonlyArray<{
    id: Exclude<OrchestrationMode, 'default'>;
    icon: ReactNode;
    label: string;
    onTitle: string;
  }> = [
    {
      id: 'swarm',
      icon: <Network size={ICON_SIZE.control} aria-hidden="true" />,
      label: copy.swarmModeLabel,
      onTitle: copy.swarmModeOnTitle,
    },
    {
      id: 'graph',
      icon: <Workflow size={ICON_SIZE.control} aria-hidden="true" />,
      label: copy.graphModeLabel,
      onTitle: copy.graphModeOnTitle,
    },
  ];
  /** A host that passes no handler cannot be in a mode this control can leave. */
  const planModeActive = props.onPlanModeChange !== undefined && props.planModeActive === true;
  // Deliberately NOT disabled while the host commits a toggle. The host
  // already drops re-entrant toggles itself, so a disable during its short
  // IPC round trip carries no protection — it only dims the row (and the
  // footer mark) to half opacity and back on every click, a visible blink
  // in the very menu the user is looking at.
  const planModeDisabled =
    props.disabled === true
    || Boolean(props.planModeDisabledReason);
  const orchestrationMode: OrchestrationMode =
    props.onOrchestrationModeChange ? props.orchestrationMode ?? 'default' : 'default';
  const orchestrationModeDisabled =
    props.disabled === true
    || Boolean(props.orchestrationModeDisabledReason);
  /**
   * The marks at the tail of the footer's left controls are the resting
   * readout for whatever is on, plus one nearby way out each; the menu stays
   * the switch. They sit after the model and thinking pickers, so a mode
   * turning on or off never shifts those two.
   *
   * There can be two of them — Plan and an orchestration default are separate
   * Session state, and a Session holding both should say so rather than have
   * one of them hidden behind the other.
   *
   * Which mode a mark is comes from its icon, never from a hue. Maka blue is
   * the single product accent (DESIGN.md), so a per-mode colour would be a
   * second and third accent carrying no semantic — and a coloured pill per
   * status is on the same file's Don't list.
   */
  const activeModeMarks: ReadonlyArray<{
    id: string;
    icon: ReactNode;
    label: string;
    tooltip: string;
    isDisabled: boolean;
    onDeactivate(): void;
  }> = [
    ...(planModeActive
      ? [{
        id: 'plan',
        icon: <ListTodo size={ICON_SIZE.control} aria-hidden="true" />,
        label: copy.planModeLabel,
        tooltip: props.planModeDisabledReason ?? copy.planModeOnTitle,
        isDisabled: planModeDisabled,
        onDeactivate: () => { void props.onPlanModeChange?.(false); },
      }]
      : []),
    ...orchestrationOptions
      .filter((option) => option.id === orchestrationMode)
      .map((option) => ({
        id: option.id,
        icon: option.icon,
        label: option.label,
        tooltip: props.orchestrationModeDisabledReason ?? option.onTitle,
        isDisabled: orchestrationModeDisabled,
        onDeactivate: () => { void props.onOrchestrationModeChange?.('default'); },
      })),
  ];
  /**
   * The mark Astryx draws for a chosen option — a check when chosen, nothing
   * when not — which is what its own `Selector` puts on a selected option, and
   * what a menu of otherwise identical rows needs: no column of empty boxes
   * ahead of the labels, and the mode icons on the same x as the action rows
   * above. Both selectable item types draw their own control at the row's
   * start — a box for Plan, a circle for the orchestration options — so the
   * mark is passed as `endContent` and a rule scoped to this panel suppresses
   * them. Read through `useIndicator` rather than an icon, so a theme
   * replacing the `check` indicator reaches these rows too.
   *
   * That rule lives in the host, with the rest of `.maka-composer-*` — this
   * component ships markup and class names, and every composer rule is the
   * host's (`apps/desktop/src/renderer/styles/composer.css` today). A second
   * host has to bring composer styling with it; that is the existing split,
   * not something this control introduced.
   *
   * Upstream ask: let a selectable item choose its indicator, and this pair
   * of workarounds goes away.
   */
  const SelectionMark = useIndicator('check');
  /**
   * Whether any action row precedes the mode group. The divider separates two
   * groups, so with nothing above it there is nothing to separate — a host
   * that wires only the mode controls would open the menu on a rule.
   */
  const hasPlusMenuActions = Boolean(
    props.onPickAttachments || props.onPickDirectory || props.mentionSkills || props.onSetGoal,
  );
  const hasPlusMenuModes = Boolean(props.onPlanModeChange || props.onOrchestrationModeChange);
  const showPlusMenu = Boolean(hasPlusMenuActions || hasPlusMenuModes);

  return (
    <>
      {!props.hidden && noModelConnection && (
        <div className="maka-composer-no-model-hint" role="status">
          <span>{props.noModelHint ?? copy.noModelHint}</span>
          {props.onOpenModelSettings && (
            <UiButton
              variant="ghost"
              size="sm"
              className="maka-composer-no-model-hint-action"
              label={copy.noModelAction}
              onClick={() => props.onOpenModelSettings?.()}
            />
          )}
        </div>
      )}
      {!props.hidden && props.revisionNotice && (
        <div className="maka-composer-revision-notice" role="status" data-revision-notice="true">
          <Pencil size={ICON_SIZE.meta} aria-hidden="true" />
          <span className="maka-composer-revision-notice-text">
            {props.revisionNotice.title}
            {props.revisionNotice.detail ? <span className="maka-composer-revision-notice-detail">{props.revisionNotice.detail}</span> : null}
          </span>
          <UiButton
            variant="ghost"
            size="sm"
            className="maka-composer-revision-notice-cancel"
            label={props.revisionNotice.cancelLabel}
            isDisabled={sendPending}
            onClick={() => props.revisionNotice?.onCancel()}
          />
        </div>
      )}
      {!props.hidden && queueCount > 0 ? (
          <ComposerMessageQueue
            queuedMessages={props.queuedMessages!}
            queueRevision={props.queuedMessageRevision}
          copy={copy}
          onPromoteEntry={props.onPromoteQueuedEntry}
          onUpdateEntry={props.onUpdateQueuedEntry}
          onDeleteEntry={props.onDeleteQueuedEntry}
          onReorderEntries={props.onReorderQueuedEntries}
        />
      ) : null}
      <form
        ref={formRef}
        className="maka-composer composer"
        hidden={props.hidden}
        data-drag-active={dragActive ? 'true' : undefined}
        data-maka-file-drop-target={canAcceptDroppedFiles() ? 'true' : undefined}
        onDragOver={onComposerDragOver}
        onDragLeave={onComposerDragLeave}
        onDrop={onComposerDrop}
        onSubmit={submit}
      >
        <AstryxChatComposer
          className="maka-composer-astryx"
          data-maka-contract="composer-inner"
          // Unreachable, and required. The shell only submits its own value,
          // and it never has one: `value` is passed straight to the controlled
          // ChatComposerInput, so the shell's copy stays empty and its submit
          // short-circuits. Sending is owned by the form (the send button) and
          // by `onInputKeyDown` (Enter). Same for the shell's stop button — we
          // render our own into the `sendButton` slot.
          onSubmit={() => {}}
          isDisabled={props.disabled}
          drawer={drawerTokenCount > 0 ? (
            <ChatComposerDrawer
              className="maka-composer-drawer"
              count={drawerTokenCount}
              label={copy.stagedContext}
              defaultIsCollapsed={props.contextDrawerDefaultCollapsed}
              // The collapse band's tooltip (composer.css ::after) follows the
              // pointer instead of sitting at a fixed offset — on a full-width
              // band a fixed bubble can be half a window away from the cursor.
              // The custom property feeds the ::after's `left`; clamped so the
              // bubble never crosses the band's right edge.
              onPointerMove={(event) => {
                const toggle = event.currentTarget.querySelector<HTMLElement>(
                  '[role="button"][aria-controls]',
                );
                if (!toggle) return;
                const band = toggle.getBoundingClientRect();
                if (event.clientY < band.top || event.clientY > band.bottom) return;
                // Clamp against the bubble's border-box: computed width is
                // content-box only, so the paddings must be priced in or the
                // right edge overshoots by exactly their sum.
                const bubbleStyle = getComputedStyle(toggle, '::after');
                const bubbleWidth =
                  (Number.parseFloat(bubbleStyle.width) || 124) +
                  (Number.parseFloat(bubbleStyle.paddingLeft) || 0) +
                  (Number.parseFloat(bubbleStyle.paddingRight) || 0);
                const x = Math.min(
                  Math.max(event.clientX - band.left + 14, 8),
                  Math.max(8, band.width - bubbleWidth - 8),
                );
                toggle.style.setProperty('--maka-drawer-tooltip-x', `${x}px`);
              }}
              // Without this, keyboard focus after a hover would show the
              // bubble at the last pointer position instead of the
              // beside-the-pill fallback.
              onPointerLeave={(event) => {
                event.currentTarget
                  .querySelector<HTMLElement>('[role="button"][aria-controls]')
                  ?.style.removeProperty('--maka-drawer-tooltip-x');
              }}
            >
              <div className="maka-composer-context-drawer" role="group" aria-label={copy.stagedContext}>
                {props.pendingDirectories?.map((reference, index) => (
                  <DirectoryReferenceChip
                    key={`${reference.hostId}:${reference.path}`}
                    reference={reference}
                    onRemove={props.onRemoveDirectory ? () => props.onRemoveDirectory?.(index) : undefined}
                  />
                ))}
                {props.pendingQuotes?.map((quote, index) => (
                  <Token
                    key={`${quote.sourceTurnId ?? 'quote'}-${index}`}
                    size="sm"
                    label={quote.label?.trim() || stripQuoteHeadingMarkers(quote.text.slice(0, 48)) || copy.pastedQuoteLabel}
                    onRemove={props.onRemoveQuote ? () => props.onRemoveQuote?.(index) : undefined}
                  />
                ))}
                {props.pendingAttachments?.map((attachment, index) => {
                  const onRemove = props.onRemoveAttachment
                    ? () => props.onRemoveAttachment?.(index)
                    : undefined;
                  // Astryx-standard rendering (maintainer decision on #2367's
                  // follow-up): every attachment is a Token in the same chip
                  // rhythm as quotes — kind icon + truncated name. The full
                  // name and «EXT · size» meta live in a hover/focus Tooltip,
                  // and an image with a decoded preview opens it in a
                  // Lightbox on click instead of rendering an inline
                  // thumbnail.
                  const extension = attachmentExtensionLabel(attachment.displayName);
                  const sizeLabel = formatPreviewSize(attachment.size, locale);
                  // One string for both surfaces (chip tooltip + lightbox
                  // caption), so the wording cannot drift between them.
                  const detail = `${attachment.displayName} · ${
                    extension ? `${extension} · ${sizeLabel}` : sizeLabel
                  }`;
                  const previewUrl =
                    attachment.kind === 'image' ? attachment.previewUrl : undefined;
                  return (
                    <Tooltip
                      key={`${attachment.displayName}-${index}`}
                      content={detail}
                      // "always", not the default "auto": the tooltip anchors
                      // Token's non-focusable root span, so auto would never
                      // attach focus listeners. focusin bubbles from the
                      // chip's inner buttons, giving keyboard users the same
                      // metadata hover shows.
                      focusTrigger="always"
                    >
                      <Token
                        size="sm"
                        className="maka-composer-attachment-token"
                        icon={<AttachmentKindIcon kind={attachment.kind} />}
                        label={attachment.displayName}
                        onRemove={onRemove}
                        onClick={
                          previewUrl
                            ? () => {
                                setAttachmentLightbox({
                                  src: previewUrl,
                                  alt: attachment.displayName,
                                  caption: detail,
                                });
                                setAttachmentLightboxOpen(true);
                              }
                            : undefined
                        }
                      />
                    </Tooltip>
                  );
                })}
              </div>
            </ChatComposerDrawer>
          ) : undefined}
          input={(
            <div
              className="maka-composer-input"
              onInputCapture={(event) => {
                if (plainTextPasteInputActiveRef.current) event.stopPropagation();
              }}
              // PR-FE-BUG-HUNT-10: a paste that lands mid-CJK-composition must
              // not be consumed — `ChatComposerInput` always preventDefault()s
              // the paste, which would interrupt the IME mid-character. The
              // guard has to sit above the input on the capture phase, since
              // the component's own handler is what we need to skip.
              onPasteCapture={(event) => {
                if (!isChatInputComposing(event, compositionActiveRef.current)) return;
                // Stand fully down: keep our file-attachment and paste-as-token
                // handlers off the event, but let the browser complete the
                // paste itself. Cancelling it here would drop the payload and
                // disturb the composition the guard exists to protect.
                event.stopPropagation();
              }}
            >
              <ChatComposerInput
                ref={inputRootRef}
                handleRef={inputHandleRef}
                data-maka-contract="composer-input"
                className="maka-composer-editor"
                value={text}
                onChange={onInputChange}
                placeholder={copy.placeholder}
                label={copy.textareaAriaLabel}
                maxRows={COMPOSER_MAX_ROWS}
                // Prompt history stays ours: persisted, shared across input
                // surfaces, and clearable from Settings · 数据 (see
                // use-composer-history.ts).
                hasHistory={false}
                triggers={triggers}
                pasteAsToken={pasteAsToken}
                onPaste={(event, pasted) => {
                  // Astryx has already offered token-adjacent, file, and
                  // reference-sized-token pastes before it reaches this seam.
                  const plainTextContainer = document.createElement('div');
                  plainTextContainer.textContent = pasted;
                  const menuWasOpen = event.currentTarget.getAttribute('aria-expanded') === 'true';
                  plainTextPasteInputActiveRef.current = true;
                  try {
                    // Deprecated, but still the composer's only insertion
                    // primitive that creates a browser undo transaction.
                    // Migrate when Astryx exposes a transactional plain-text
                    // insertion authority.
                    return document.execCommand(
                      'insertHTML',
                      false,
                      plainTextContainer.innerHTML.replace(/\r\n?|\n/g, '<br>'),
                    );
                  } finally {
                    plainTextPasteInputActiveRef.current = false;
                    if (menuWasOpen) {
                      event.currentTarget.dispatchEvent(
                        new KeyboardEvent('keydown', {
                          key: 'Escape',
                          bubbles: true,
                          cancelable: true,
                        }),
                      );
                    }
                  }
                }}
                onFiles={onInputFiles}
                onKeyDown={onInputKeyDown}
                onCompositionStart={() => { compositionActiveRef.current = true; }}
                onCompositionEnd={() => { compositionActiveRef.current = false; }}
              />
              {dragActive && (
                <span className="maka-visually-hidden" role="status" aria-live="polite">
                  {copy.dropToImport}
                </span>
              )}
            </div>
          )}
          footerActions={(
            <div className="maka-composer-left-controls">
              {/* Resting order: ＋ leftmost, then permission icon. */}
              {showPlusMenu ? (
                <span className="maka-composer-plus-menu">
                  <DropdownMenu
                    placement="above"
                    hasChevron={false}
                    className="maka-composer-quiet-menu maka-composer-plus-panel"
                    button={{
                      label: copy.addContext,
                      icon: <Plus size={ICON_SIZE.control} aria-hidden="true" />,
                      isIconOnly: true,
                      variant: 'ghost',
                      size: 'sm',
                      isDisabled: props.disabled,
                      tooltip: copy.addContext,
                    }}
                  >
                    {props.onPickAttachments ? (
                      <DropdownMenuItem
                        label={pendingImportAction === 'pick' ? copy.addingAttachment : copy.addFileOrDirectory}
                        icon={<Upload size={ICON_SIZE.control} aria-hidden="true" />}
                        isDisabled={attachmentImportBlocked || importActionBusy}
                        onClick={() => {
                          void runImportAction('pick', props.onPickAttachments);
                        }}
                      />
                    ) : null}
                    {props.onPickDirectory ? (
                      <DropdownMenuItem
                        label={copy.referenceFolder}
                        icon={<FolderOpen size={ICON_SIZE.control} aria-hidden="true" />}
                        isDisabled={props.disabled || props.streaming === true || importActionBusy}
                        onClick={() => {
                          void runImportAction('directory', props.onPickDirectory);
                        }}
                      />
                    ) : null}
                    {props.mentionSkills ? (
                      <DropdownMenuItem
                        label={copy.chooseSkill}
                        icon={<Sparkles size={ICON_SIZE.control} aria-hidden="true" />}
                        // Nothing to choose from means nothing to open. The
                        // entry types `/` into the draft, so an enabled item
                        // with an empty catalog spends the user's click writing
                        // a stray slash and popping an empty menu. Say why it is
                        // unavailable: the panel this replaced showed "no skills
                        // available", and a silent grey row answers nothing.
                        //
                        // Only a SETTLED empty catalog counts. The host clears
                        // the list while re-fetching it (a Plan toggle or model
                        // change does that with this menu open), and rendering
                        // that transient `[]` as "no skills" grows this row by
                        // a description line and back — the menu visibly jumps.
                        // So the verdict is the host's settled flag when it
                        // supplies one, and the row repaints only when the
                        // catalog's emptiness actually changed.
                        isDisabled={
                          props.disabled
                          || (props.mentionSkillsUnavailable
                            ?? props.mentionSkills.length === 0)
                        }
                        description={
                          (props.mentionSkillsUnavailable
                            ?? props.mentionSkills.length === 0)
                            ? copy.noSkillsAvailable
                            : undefined
                        }
                        // Mid-refresh the row LOOKS like the previous catalog
                        // but cannot act for the current one: opening the `/`
                        // menu now would write a stray slash against a list
                        // that is fail-closed empty. A loading click or Enter
                        // is a complete no-op — nothing typed, menu left open —
                        // so the same activation a beat later simply works.
                        // `aria-busy` says so to assistive technology (the
                        // geometry-stable row would otherwise announce
                        // "available" and silently ignore the action); the
                        // class is the same contract for tests and styling.
                        // The gate lives INSIDE one always-present handler:
                        // swapping the prop between undefined and a function
                        // changes Item's internal structure, and the remount
                        // would drop keyboard focus mid-refresh.
                        aria-busy={props.mentionSkillsLoading === true ? true : undefined}
                        className={
                          props.mentionSkillsLoading === true
                            ? 'maka-composer-skills-loading'
                            : undefined
                        }
                        hasCloseOnSelect={props.mentionSkillsLoading !== true}
                        onClick={() => {
                          if (props.mentionSkillsLoading === true) return;
                          openSkillMenu();
                        }}
                      />
                    ) : null}
                    {props.onSetGoal ? (
                      <DropdownMenuItem
                        label={copy.setGoal}
                        icon={<Target size={ICON_SIZE.control} aria-hidden="true" />}
                        isDisabled={
                          props.disabled
                          || props.goalActive === true
                          || Boolean(props.goalDisabledReason)
                        }
                        description={
                          props.goalActive === true
                            ? copy.goalAlreadySet
                            : props.goalDisabledReason
                        }
                        onClick={() => {
                          void props.onSetGoal?.();
                        }}
                      />
                    ) : null}
                    {hasPlusMenuModes ? (
                      <>
                        {hasPlusMenuActions ? <DropdownMenuDivider /> : null}
                        {props.onPlanModeChange ? (
                          <DropdownMenuCheckboxItem
                            label={copy.planModeLabel}
                            icon={<ListTodo size={ICON_SIZE.control} aria-hidden="true" />}
                            value={planModeActive}
                            isDisabled={planModeDisabled}
                            onChange={(next) => {
                              void props.onPlanModeChange?.(next);
                            }}
                            endContent={planModeActive ? (
                              <SelectionMark state="checked" size="sm" />
                            ) : undefined}
                            aria-description={
                              props.planModeDisabledReason
                              ?? (planModeActive ? copy.disablePlanMode : copy.enablePlanMode)
                            }
                          />
                        ) : null}
                        {props.onOrchestrationModeChange ? (
                          <DropdownMenuRadioGroup
                            label={copy.orchestrationModeAriaLabel}
                            // No orchestration is no selection, not a value.
                            value={orchestrationMode === 'default' ? undefined : orchestrationMode}
                            // Astryx closes a menu on a radio commit. These
                            // rows sit beside Plan, which stays open, and the
                            // way back to no orchestration is the selected row
                            // itself — both need the menu still there.
                            hasCloseOnSelect={false}
                            // A radio item reports its own value on every
                            // activation, including when it is already the
                            // selected one. That repeat is the user asking for
                            // the mode they are already in, which is how they
                            // leave it: the group empties instead of staying
                            // put. The row they are on announces the change,
                            // unlike two switches where the other row moved.
                            onChange={(value) => {
                              void props.onOrchestrationModeChange?.(
                                value === orchestrationMode ? 'default' : (value as OrchestrationMode),
                              );
                            }}
                          >
                            {orchestrationOptions.map((option) => (
                              <DropdownMenuRadioItem
                                key={option.id}
                                value={option.id}
                                label={option.label}
                                icon={option.icon}
                                isDisabled={orchestrationModeDisabled}
                                endContent={orchestrationMode === option.id ? (
                                  <SelectionMark state="checked" size="sm" />
                                ) : undefined}
                                aria-description={props.orchestrationModeDisabledReason}
                              />
                            ))}
                          </DropdownMenuRadioGroup>
                        ) : null}
                      </>
                    ) : null}
                  </DropdownMenu>
                </span>
              ) : null}
              {props.onPermissionModeChange ? (
                <PermissionModeSelect
                  appearance="icon"
                  activeMode={props.permissionMode ?? 'ask'}
                  onSelect={(mode) => {
                    void props.onPermissionModeChange?.(mode);
                  }}
                  disabled={
                    props.disabled
                    || Boolean(props.permissionModeDisabledReason)
                  }
                  disabledReason={props.permissionModeDisabledReason}
                />
              ) : null}
              {/* Model + thinking sit left after permission (adjacent pair), not
                  in the send cluster. Thinking is its own menu, only when the
                  active/new-chat model offers levels. Mid-turn the pair stays
                  mounted — `modelSwitcherDisabledReason` carries the lock and
                  its explanation, so the footer never reflows when a turn
                  starts or ends. */}
              <div className="maka-model-selection-controls">
                {props.activeSession ? (
                  <ChatModelSwitcher
                    activeSession={props.activeSession}
                    activeModelConnectionId={props.activeModelConnectionId}
                    activeModelConnectionSlug={props.activeModelConnectionSlug}
                    activeModel={props.activeModel}
                    activeModelLabel={props.activeModelLabel}
                    currentProviderType={props.activeProviderType}
                    choices={props.modelChoices ?? []}
                    hasConversationHistory={props.modelSwitchHasHistory}
                    availability={modelSwitchAvailability}
                    disabledReason={modelSwitcherDisabledReason}
                    isMenuOpen={modelPickerOpen}
                    onMenuOpenChange={setModelPickerOpen}
                    hideUnavailableCurrentOption={props.hideUnavailableCurrentModel}
                    renderProviderMark={props.renderProviderMark}
                    onChange={props.onModelChange}
                  />
                ) : props.onPickNewChatModel && (props.modelChoices?.length ?? 0) > 0 ? (
                  <NewChatModelPicker
                    label={modelChipLabel}
                    choices={props.modelChoices ?? []}
                    currentValue={
                      props.newChatModel
                        ? exactModelChoiceValue(
                            props.newChatModel.llmConnectionId,
                            props.newChatModel.llmConnectionSlug,
                            props.newChatModel.model,
                          )
                        : undefined
                    }
                    currentProviderType={props.newChatProviderType}
                    renderProviderMark={props.renderProviderMark}
                    onPick={props.onPickNewChatModel}
                  />
                ) : (
                  <ModelChipStatic
                    label={modelChipLabel}
                    onOpenSettings={props.onOpenModelSettings}
                    showUnavailableStatus={props.showStaticModelUnavailableStatus}
                  />
                )}
                {props.activeSession ? (
                  <ThinkingLevelSelector
                    levels={props.activeThinkingLevels ?? []}
                    current={props.activeThinkingLevel}
                    onChange={props.onThinkingLevelChange}
                    disabled={!modelSwitchAvailability.available}
                    disabledReason={thinkingSwitcherDisabledReason}
                  />
                ) : (
                  <ThinkingLevelSelector
                    levels={props.newChatThinkingLevels ?? []}
                    current={props.newChatThinkingLevel}
                    onChange={props.onNewChatThinkingLevelChange}
                  />
                )}
                {props.contextUsage ? <ContextUsageIndicator {...props.contextUsage} /> : null}
              </div>
              {/* The project decides where a NEW chat starts, which makes it a
                  parameter of this send like the model beside it — so it sits
                  at the end of that group rather than in a header row of its
                  own, which grew the card by a row for the draft state alone.
                  Last in the group is what makes it cheap to lose: the first
                  message creates the session and unmounts it, and nothing to
                  its left moves. Not gated on `streaming`: `activeSession`
                  already covers it.

                  The wrapper is the popover's scope — Astryx's Layer renders
                  the open menu next to the trigger rather than portaling it, so
                  the palette rebinding and the pinned-footer rules attach
                  here. */}
              {!props.activeSession && props.workspacePicker ? (
                <div className="maka-composer-workspace">
                  <WorkspacePicker workspacePicker={props.workspacePicker} />
                </div>
              ) : null}
              {/* Mode readouts sit after the model pair, so a mode turning on
                  or off never nudges the model and thinking pickers (#1897).
                  Same ghost icon button as ＋ and permission two slots left —
                  a mode is state on this toolbar, not a coloured pill, and the
                  icon carries which mode it is. Clicking it leaves the mode,
                  which unmounts this button, so focus is handed back to the
                  input exactly as removing a Skill token does; otherwise a
                  keyboard user is dropped on `document.body`. */}
              {activeModeMarks.map((mark) => (
                <IconButton
                  key={mark.id}
                  variant="ghost"
                  type="button"
                  size="sm"
                  className="maka-composer-mode-button"
                  data-mode={mark.id}
                  label={mark.label}
                  tooltip={mark.tooltip}
                  isDisabled={mark.isDisabled}
                  onClick={() => {
                    mark.onDeactivate();
                    window.requestAnimationFrame(() => focusInput());
                  }}
                  icon={mark.icon}
                />
              ))}
            </div>
          )}
          sendButton={stopShown ? (
            <IconButton
              variant="secondary"
              type="button"
              isDisabled={props.stopPending}
              label={props.stopPending ? copy.stopping : copy.stopLabel}
              aria-busy={props.stopPending ? 'true' : undefined}
              data-pending={props.stopPending ? 'true' : undefined}
              tooltip={props.stopPending ? copy.stopping : copy.stopLabel}
              onClick={() => {
                if (props.stopPending) return;
                void props.onStop();
              }}
              icon={<Square size={ICON_SIZE.control} aria-hidden="true" />}
            />
          ) : (
            // GLOBAL ANCHOR — DO NOT RESTYLE. This Send/Stop slot (its size,
            // shape, glyph, and placement) is the one control the whole app
            // navigates by; it has regressed multiple times from well-meaning
            // "improvements". Queue affordances live in the pending plate
            // above the card, never in this button.
            <IconButton
              variant="primary"
              type="submit"
              isDisabled={sendDisabled}
              label={copy.sendLabel}
              aria-busy={sendPending ? 'true' : undefined}
              data-pending={sendPending ? 'true' : undefined}
              tooltip={sendTitle}
              icon={<ArrowUp size={ICON_SIZE.chrome} aria-hidden="true" />}
            />
          )}
        />
      </form>
      {attachmentLightbox && (
        <Lightbox
          // Driven by the flag, never by unmounting: the component must
          // survive the close so Astryx runs dialog.close(), which is what
          // hands focus back to the chip button that opened it (the native
          // <dialog> contract keyboard users rely on).
          isOpen={attachmentLightboxOpen}
          onOpenChange={(isOpen) => {
            if (!isOpen) setAttachmentLightboxOpen(false);
          }}
          hasZoom
          media={attachmentLightbox}
        />
      )}
    </>
  );
});

function ContextUsageIndicator(props: {
  usageTokens?: number;
  declaredContextWindow?: number;
  metadataContextWindow?: number;
}) {
  const copy = getConversationCopy(useUiLocale()).messages;
  // A window from either source is enough to show a share: the user's
  // declaration when there is one, otherwise the model's reported window. The
  // distinction matters for the compaction threshold, which only a declaration
  // arms, not for reading a number off the screen. With no window at all the
  // usage stands on its own.
  const window = props.declaredContextWindow ?? props.metadataContextWindow;
  const label =
    props.usageTokens === undefined
      ? '—'
      : window !== undefined && window > 0
        ? `${Math.round((props.usageTokens / window) * 100)}%`
        : `${props.usageTokens} tok`;
  const tooltip =
    props.usageTokens === undefined
      ? copy.systemNotes.contextUsageUnavailable
      : window !== undefined && window > 0
        ? copy.systemNotes.contextUsageShare(props.usageTokens, window)
        : copy.systemNotes.contextUsageNoWindow;
  const indicator = (
    <span className="maka-context-usage-indicator" aria-label={tooltip ?? label}>
      <CircleGauge size={ICON_SIZE.meta} aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
  return tooltip ? <Tooltip content={tooltip}>{indicator}</Tooltip> : indicator;
}

export type ComposerProps = ComponentProps<typeof Composer>;
