import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import { ArrowUp, Blocks, Paperclip, Pencil, Plus, X } from './icons.js';
import { ChatModelSwitcher, ModelChipStatic, NewChatModelPicker } from './chat-model-switcher.js';
import { useUiLocale } from './locale-context.js';
import { getConversationCopy } from './conversation-copy.js';
import { type ChatModelChoice, modelChoiceValue } from './chat-model-helpers.js';
import { appendPromptContextDraft, isReferenceSizedPaste } from './composer-helpers.js';
import { useComposerDraft } from './use-composer-draft.js';
import { useComposerHistory } from './use-composer-history.js';
import {
  useComposerSkillDraft,
  type ComposerSkillSelection,
} from './use-composer-skill-draft.js';
import {
  createChatInputActionOwner,
  fileTransferContainsFiles,
  focusTextInputAtEnd,
  isChatInputComposing,
  type ChatInputActionOwner,
} from './chat-input-behavior.js';
import { ComposerMentionPopup, mentionOptionId } from './composer-mention-popup.js';
import { useMentionPopup } from './use-mention-popup.js';
import { ComposerWorkspaceRow, type ComposerBranchPicker, type ComposerWorkspacePicker } from './composer-workspace-row.js';
import type { AttachmentRef, PermissionMode, ProviderType, QuoteRef, SessionSummary } from '@maka/core';
import { Button as UiButton } from './ui.js';
import { Textarea as UiTextarea } from './primitives/textarea.js';
import { AttachmentFileCard } from './attachment-file-card.js';
import { QuoteRefChip } from './quote-ref-chip.js';
import { Kbd } from './primitives/kbd.js';
import { PermissionModeSelect } from './permission-mode-menu.js';
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuSeparator, MenuSub, MenuSubPopup, MenuSubTrigger, MenuTrigger } from './primitives/menu.js';

const COMPOSER_MAX_HEIGHT = 240;

/**
 * PR-UI-15 (@yuejing 2026-05-22): Composer copy is locale-aware.
 *
 * Audit §3.5 — placeholder + state copy were hardcoded zh and drifted
 * stylistically from the first-run input that used to sit beside this
 * one. That second input is gone (#1433), so this placeholder is the
 * only one a user ever reads: one short, action-oriented line.
 */
export interface ComposerHandle {
  /** Replace the textarea value and resize, leaving focus on the input. */
  setText(text: string): void;
  /** Append a prompt/context fragment after the existing draft instead of replacing it. */
  appendText(text: string): void;
  /** Read the current uncontrolled textarea value. */
  getText(): string;
  /** Snapshot the structured Skills owned by the active draft. */
  getSkills(): ComposerSkillSelection[];
  /** Clear one persisted text and Skill draft without affecting another session. */
  clearDraft(draftKey: string): void;
  /** Write a specific session draft before navigation changes the active key. */
  setDraft(draftKey: string, text: string): void;
  /** Replace structured Skills under an explicit session draft key. */
  setSkillDraft(
    draftKey: string,
    skills: readonly ComposerSkillSelection[],
  ): void;
  /** Move focus to the textarea without changing its content. */
  focus(): void;
  /** Fixture/integration seam for the same structured selection state used by `/`. */
  setSkills(skills: ReadonlyArray<{ ref?: string; id: string; name: string }>): void;
}

type ComposerImportActionId = 'pick' | 'attach';

export const Composer = forwardRef<
  ComposerHandle,
  {
    disabled?: boolean;
    hidden?: boolean;
    /**
     * When true, a turn is in flight — live output OR (with `processing`) the
     * pre-first-token wait. Toolbar swaps to a working hint ("Maka 正在回答…" or
     * "正在处理…") and Send becomes Stop. The ＋ menu stays reachable (#1444);
     * import actions remain blocked mid-turn until the runtime accepts them.
     */
    streaming?: boolean;
    /**
     * #646: the `streaming` window is the pre-first-token wait (the model is
     * being awaited with nothing streaming yet), not live output. Only changes
     * the hint copy — "Maka 正在处理…" instead of "正在回答…", matching the
     * timeline's model-wait indicator. Ignored unless `streaming` is true.
     */
    processing?: boolean;
    /**
     * #646: a mid-turn step-to-step lull after content has already streamed. Only
     * changes the hint copy — "Maka 继续中…", matching the timeline's calm hint —
     * so the Stop button stays up without re-showing "正在处理…". Ignored unless
     * `streaming` is true; mutually exclusive with `processing`.
     */
    continuing?: boolean;
    /** True while the current streaming session is processing a stop request. */
    stopPending?: boolean;
    /** Runtime-only key used to keep unsent drafts isolated per session. */
    draftKey?: string;
    onSend(
      text: string,
      skillIds: readonly string[],
    ): boolean | void | Promise<boolean | void>;
    onStop(): void | Promise<void>;
    onPickAttachments?(): void | Promise<void>;
    onAttachFilePaths?(files: File[]): void | Promise<void>;
    pendingAttachments?: readonly { displayName: string; kind: AttachmentRef['kind']; mimeType?: string; size: number }[];
    onRemoveAttachment?(index: number): void;
    /** Quoted excerpts staged for the next send; rendered as removable chips. */
    pendingQuotes?: readonly QuoteRef[];
    onRemoveQuote?(index: number): void;
    /**
     * Stage a reference-sized paste as a quote chip rather than letting it
     * flood the textarea. Omitted by hosts that don't compose quotes, in which
     * case a large paste behaves like any other paste.
     */
    onPasteAsQuote?(input: { text: string; label?: string }): void;
    /** Built-in expert teams offered under 专家团 in the "+" menu. */
    expertTeams?: readonly { id: string; name: string; description?: string }[];
    /** Start a new expert-team session from the "+" menu. */
    onStartExpertTeam?(teamId: string): void;
    modelLabel?: string;
    activeSession?: SessionSummary;
    activeConnectionLabel?: string;
    activeModel?: string;
    activeModelLabel?: string;
    activeProviderType?: ProviderType;
    modelChoices?: ChatModelChoice[];
    /** Renders the provider brand mark on each group heading of the model menus;
     *  injected by the desktop app to keep the provider SVG library out of @maka/ui. */
    renderProviderMark?(type: ProviderType): ReactNode;
    modelChangePending?: boolean;
    onModelChange?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
    /** Per-model thinking-level variants for the active model; empty/undefined hides the switcher. */
    activeThinkingLevels?: readonly import('@maka/core').ThinkingLevel[];
    activeThinkingLevel?: import('@maka/core').ThinkingLevel;
    onThinkingLevelChange?(level: import('@maka/core').ThinkingLevel | undefined): void | Promise<void>;
    newChatThinkingLevels?: readonly import('@maka/core').ThinkingLevel[];
    newChatThinkingLevel?: import('@maka/core').ThinkingLevel;
    onNewChatThinkingLevelChange?(level: import('@maka/core').ThinkingLevel | undefined): void | Promise<void>;
    /**
     * Home / empty-state composer only (no active session yet): the model
     * the next new chat will start with, and the picker callback. When set,
     * the otherwise-static model chip becomes a real dropdown so the user can
     * choose the new-chat model inline instead of only via Settings · 模型.
     */
    newChatModel?: { llmConnectionSlug: string; model: string };
    newChatProviderType?: ProviderType;
    onPickNewChatModel?(input: { llmConnectionSlug: string; model: string }): void | Promise<void>;
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
    workspacePicker?: ComposerWorkspacePicker;
    /**
     * Git branch picker for the workspace row, shown to the right of
     * the folder indicator when the workspace is a git repository.
     * Clicking the trigger opens a Menu listing local branches; selecting
     * one fires `onSelect` to switch branches (handled in the shell).
     */
    branchPicker?: ComposerBranchPicker;
    /**
     * PR-MOVE-PERMISSION-MODE (WAWQAQ 47fe0d0e + a667cf6c): the
     * permission mode picker lives inside the composer left-controls
     * instead of the chat header. Composer renders a dropdown labelled
     * by the current mode (询问权限 / 自动执行 / 跳过确认);
     * selecting an option fires `onPermissionModeChange`. When the
     * active session is in the legacy `explore` mode the picker
     * collapses to display 询问权限 — explore is internal-only now and
     * won't surface here.
     */
    permissionMode?: PermissionMode;
    permissionModePending?: boolean;
    permissionModeDisabledReason?: string;
    onPermissionModeChange?(mode: PermissionMode): void | Promise<void>;
    /**
     * Session collaboration mode switch. Agent mode is the implicit default,
     * so the composer only exposes whether Plan mode is enabled.
     */
    planModeActive?: boolean;
    planModePending?: boolean;
    planModeDisabledReason?: string;
    onPlanModeChange?(active: boolean): void | Promise<void>;
    /** Session orchestration mode switch. Default mode remains the implicit fallback. */
    swarmModeActive?: boolean;
    swarmModePending?: boolean;
    swarmModeDisabledReason?: string;
    onSwarmModeChange?(active: boolean): void | Promise<void>;
    /**
     * Composer mention popups. Both are optional and the whole feature no-ops
     * when absent (SSR contracts render Composer with minimal props):
     *   - `mentionSkills` powers the `/` popup — pass only ENABLED skills; the
     *     composer filters them client-side by id/name and creates a structured
     *     Skill Chip (human-in-the-loop, never auto-send).
     *   - `onSearchMentionFiles` powers the `@` popup — the composer debounces
     *     the query, and selecting a file inserts `@<relativePath> `.
     */
    mentionSkills?: ReadonlyArray<{ ref?: string; id: string; name: string; description?: string }>;
    onSearchMentionFiles?(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
  }
>(function Composer(props, ref) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [pendingImportAction, setPendingImportAction] = useState<ComposerImportActionId | null>(null);
  const composerMountedRef = useMountedRef();
  const sendPendingRef = useRef(false);
  const compositionActiveRef = useRef(false);
  const importActionOwnerRef = useRef<ChatInputActionOwner<ComposerImportActionId> | null>(null);
  if (!importActionOwnerRef.current) {
    importActionOwnerRef.current = createChatInputActionOwner((action) => {
      if (composerMountedRef.current) setPendingImportAction(action);
    });
  }
  // Draft persistence + prompt-history navigation live in dedicated hooks
  // (issue #1044). `resetPromptHistoryNavigation` is a hoisted wrapper so the
  // draft hook's swap effect can reset history navigation even though the
  // history hook is created one line below it.
  const { hasDraftText, saveCurrentDraft, clearDraft, setDraft, activeDraftKey } = useComposerDraft({
    textareaRef,
    draftKey: props.draftKey,
    autoResize,
    onDraftKeyChange: resetPromptHistoryNavigation,
  });
  const { resetNavigation, rememberSentEntry, handleArrowKey } = useComposerHistory({
    textareaRef,
    autoResize,
    saveCurrentDraft,
  });
  const skillDraft = useComposerSkillDraft(props.draftKey);
  // Mention popup state (@ file / skill) lives in useMentionPopup (issue
  // #1044); the identifiers below keep their names so the keydown routing
  // (arrows / Enter / Tab / Esc, pinned by the composer-mention contract)
  // reads exactly as before.
  const {
    mention,
    mentionItems,
    mentionActiveIndex,
    setMentionActiveIndex,
    mentionLoading,
    mentionListboxId,
    mentionPopupOpen,
    recomputeMention,
    closeMention,
    selectMention,
  } = useMentionPopup({
    textareaRef,
    mentionSkills: props.mentionSkills,
    onSearchMentionFiles: props.onSearchMentionFiles,
    saveCurrentDraft,
    autoResize,
    resetPromptHistoryNavigation,
    onSelectSkill: (skill) => skillDraft.add(skill),
  });
  // PR-UI-15: locale-aware copy for placeholder + toolbar states. We
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).composer;

  useEffect(() => {
    return () => {
      sendPendingRef.current = false;
      importActionOwnerRef.current?.reset();
    };
  }, []);

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    // Standard "reset to auto, then set to scrollHeight" trick so the
    // textarea can both grow and shrink as the user edits. Cap at
    // COMPOSER_MAX_HEIGHT so it never pushes the chat surface off-screen;
    // overflow becomes an internal scroll past that.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
  }

  function resetPromptHistoryNavigation() {
    resetNavigation();
  }

  useImperativeHandle(
    ref,
    () => ({
      setText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = text;
        saveCurrentDraft(text);
        autoResize();
        // Move caret to end so the user can keep typing.
        focusTextInputAtEnd(el);
      },
      appendText(text: string) {
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = appendPromptContextDraft(el.value, text);
        saveCurrentDraft(el.value);
        autoResize();
        focusTextInputAtEnd(el);
      },
      getText() {
        return textareaRef.current?.value ?? '';
      },
      getSkills() {
        return skillDraft.get(skillDraft.activeDraftKey());
      },
      clearDraft(draftKey: string) {
        clearDraft(draftKey);
        skillDraft.clear(draftKey);
        if (activeDraftKey() !== draftKey) return;
        const el = textareaRef.current;
        if (el) el.value = '';
        saveCurrentDraft('');
        autoResize();
      },
      setDraft(draftKey: string, text: string) {
        setDraft(draftKey, text);
        if (activeDraftKey() !== draftKey) return;
        const el = textareaRef.current;
        if (!el) return;
        resetPromptHistoryNavigation();
        el.value = text;
        autoResize();
        focusTextInputAtEnd(el);
      },
      setSkillDraft(
        draftKey: string,
        skills: readonly ComposerSkillSelection[],
      ) {
        skillDraft.replace(draftKey, skills);
      },
      focus() {
        textareaRef.current?.focus();
      },
      setSkills(skills) {
        skillDraft.replace(skillDraft.activeDraftKey(), skills);
      },
    }),
    [],
  );

  async function sendCurrent() {
    if (props.disabled || sendPendingRef.current || importActionOwnerRef.current?.pending) return;
    const textarea = textareaRef.current;
    const form = formRef.current;
    const text = (textarea?.value ?? '').trim();
    // `skillIds` is the legacy wire field name. New selections submit the
    // stable scope-aware ref so send-time re-resolution cannot drift to a
    // same-id skill discovered at a different precedence.
    const skillIds = skillDraft.skills.map((skill) => skill.ref ?? skill.id);
    if (!text && skillIds.length === 0) return;
    const submittedDraftKey = activeDraftKey();
    const submittedSkillDraftKey = skillDraft.activeDraftKey();
    sendPendingRef.current = true;
    setSendPending(true);
    let sent: boolean | void;
    try {
      sent = await props.onSend(text, skillIds);
    } finally {
      sendPendingRef.current = false;
      if (composerMountedRef.current) setSendPending(false);
    }
    if (!composerMountedRef.current) return;
    if (sent === false) return;
    // Save to both local ref and global persistence so the history
    // survives page reloads and is shared across all input surfaces.
    if (text) rememberSentEntry(text);
    clearDraft(submittedDraftKey);
    skillDraft.clear(submittedSkillDraftKey);
    // The owner may have changed while onSend awaited (new-session creation,
    // revision branch, or user navigation). Never erase a foreign draft.
    if (activeDraftKey() !== submittedDraftKey) return;
    saveCurrentDraft('');
    skillDraft.clear(skillDraft.activeDraftKey());
    form?.reset();
    // form.reset() empties the textarea but doesn't fire input — collapse
    // manually so the composer snaps back to its single-row footprint.
    if (textarea) {
      textarea.style.height = '';
      autoResize();
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendCurrent();
  }

  async function runImportAction(actionId: ComposerImportActionId, action: (() => void | Promise<void>) | undefined) {
    if (!action || props.disabled || props.streaming) return;
    await importActionOwnerRef.current?.run(actionId, async () => {
      await action();
    });
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Skip when an IME composition is active so CJK input isn't interrupted.
    if (isChatInputComposing(event, compositionActiveRef.current)) return;
    // Mention popup navigation. MUST come before the Esc/drag and streaming
    // branches: while the popup is open Enter/Tab select a mention (never
    // send), and Esc closes ONLY the popup (it must not clear a drag highlight
    // or stop the stream). Arrow keys move the highlight and wrap around.
    if (mentionPopupOpen) {
      const count = mentionItems.length;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (count > 0) setMentionActiveIndex((index) => (index + 1) % count);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (count > 0) setMentionActiveIndex((index) => (index - 1 + count) % count);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        if (count > 0) {
          event.preventDefault();
          selectMention(mentionActiveIndex);
          return;
        }
        // Nothing to select (loading / no matches): swallow Enter so it can't
        // send while the popup is up, and just close it. Let Tab move focus.
        if (event.key === 'Enter') event.preventDefault();
        closeMention();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMention();
        return;
      }
    }
    if (
      event.key === 'Backspace' &&
      event.currentTarget.selectionStart === 0 &&
      event.currentTarget.selectionEnd === 0 &&
      skillDraft.removeLast()
    ) {
      event.preventDefault();
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
    if (event.shiftKey || event.altKey) return; // Shift+Enter / Alt+Enter inserts a newline.
    event.preventDefault();
    void sendCurrent();
  }

  function onTextareaInput() {
    resetPromptHistoryNavigation();
    autoResize();
    saveCurrentDraft();
    recomputeMention();
  }

  function canAcceptDroppedFiles(): boolean {
    return Boolean(props.onAttachFilePaths && !props.disabled && !props.streaming && !importActionOwnerRef.current?.pending);
  }

  function hasDraggedFiles(event: DragEvent<HTMLFormElement>): boolean {
    return fileTransferContainsFiles(event.dataTransfer.types, event.dataTransfer.files.length);
  }

  function hasPastedFiles(event: ClipboardEvent<HTMLTextAreaElement>): boolean {
    return fileTransferContainsFiles(event.clipboardData.types, event.clipboardData.files.length);
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

  function onTextareaPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    // PR-FE-BUG-HUNT-10 hotfix: extend the IME composition guard from
    // the keydown path (line 5640) to the paste path. If the user is
    // mid-CJK composition and the clipboard happens to contain a file
    // (screenshot shortcut etc.), `event.preventDefault()` below would
    // interrupt the IME mid-character.
    //
    // Original PR #216 copied `event.nativeEvent.isComposing` from the
    // keydown handler verbatim, but `isComposing` only exists on
    // KeyboardEvent / InputEvent in the DOM spec — not ClipboardEvent.
    // (Browsers happen to expose it on the underlying event too, but
    // TypeScript types don't acknowledge that.) Use a narrow `in` check
    // + a typed cast so this compiles AND keeps working when the
    // browser does expose the flag.
    if (isChatInputComposing(event, compositionActiveRef.current)) return;
    if (!hasPastedFiles(event)) {
      pasteLongTextAsQuote(event);
      return;
    }
    if (!canAcceptDroppedFiles()) return;
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void runImportAction('attach', () => props.onAttachFilePaths?.(files));
  }

  /**
   * A paste this big is reference material (a log, a diff, a doc section), not
   * a prompt the user is going to keep editing inline — so it becomes a quote
   * chip instead of flooding the textarea, and the model still receives it
   * verbatim. Below the threshold the paste stays a normal paste; the user is
   * writing, not attaching.
   */
  function pasteLongTextAsQuote(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!props.onPasteAsQuote || props.disabled) return;
    const text = event.clipboardData.getData('text/plain');
    if (!isReferenceSizedPaste(text)) return;
    event.preventDefault();
    props.onPasteAsQuote({ text, label: copy.pastedQuoteLabel });
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
    sendPending ||
    importActionBusy ||
    (!hasDraftText && skillDraft.skills.length === 0) ||
    noModelConnection;
  // The disabled Send is explanatory only in the no-model dead-end; other
  // disabled reasons (empty draft, in-flight import) keep the neutral label.
  const sendTitle = noModelConnection && !props.disabled ? copy.noModelSendTitle : copy.sendLabel;
  const modelChipLabel = props.modelLabel?.trim() || copy.selectModel;
  const modelSwitcherDisabledReason = props.streaming
    ? copy.switchDisabledStreaming
    : props.activeSession?.status === 'running'
      ? copy.switchDisabledRunning
      : props.activeSession?.status === 'waiting_for_user'
        ? copy.switchDisabledPermission
        : undefined;

  return (
    <>
      {/* U3: no-model dead-end guidance. Rendered OUTSIDE the <form> so it never
          contributes to the composer's constant footprint (#740); it honors the
          same `hidden` state as the box so it never lingers over a takeover. */}
      {!props.hidden && noModelConnection && (
        <div className="maka-composer-no-model-hint" role="status">
          <span>{copy.noModelHint}</span>
          {props.onOpenModelSettings && (
            <button
              type="button"
              className="maka-composer-no-model-hint-action"
              onClick={() => props.onOpenModelSettings?.()}
            >
              {copy.noModelAction}
            </button>
          )}
        </div>
      )}
      {!props.hidden && props.revisionNotice && (
        <div className="maka-composer-revision-notice" role="status" data-revision-notice="true">
          <Pencil size={13} aria-hidden="true" />
          <span className="maka-composer-revision-notice-text">
            {props.revisionNotice.title}
            {props.revisionNotice.detail ? <span className="maka-composer-revision-notice-detail">{props.revisionNotice.detail}</span> : null}
          </span>
          <button
            type="button"
            className="maka-composer-revision-notice-cancel"
            disabled={sendPending}
            aria-busy={sendPending ? 'true' : undefined}
            onClick={() => props.revisionNotice?.onCancel()}
          >
            {props.revisionNotice.cancelLabel}
          </button>
        </div>
      )}
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
      <div
        className="maka-composer-inner composerInner agents-parchment-paper-surface"
        data-streaming={props.streaming ? 'true' : undefined}
      >
        {/* No px on the chip row: `.maka-composer-inner` already pads the card,
            so an extra px-3 would sit the chips 12px right of the textarea. */}
        {props.pendingQuotes && props.pendingQuotes.length > 0 ? (
          <div className="flex flex-wrap items-start gap-1 pb-1">
            {props.pendingQuotes.map((quote, index) => (
              <QuoteRefChip
                key={`${quote.sourceTurnId ?? 'quote'}-${index}`}
                quote={quote}
                onRemove={props.onRemoveQuote ? () => props.onRemoveQuote?.(index) : undefined}
              />
            ))}
          </div>
        ) : null}
        {props.pendingAttachments && props.pendingAttachments.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2">
            {props.pendingAttachments.map((attachment, index) => (
              <AttachmentFileCard
                key={`${attachment.displayName}-${index}`}
                name={attachment.displayName}
                kind={attachment.kind}
                size={attachment.size}
                onRemove={props.onRemoveAttachment ? () => props.onRemoveAttachment?.(index) : undefined}
              />
            ))}
          </div>
        ) : null}
        {skillDraft.skills.length > 0 ? (
          <ul
            className="maka-composer-skill-chips"
            aria-label={copy.selectedSkillsAriaLabel}
          >
            {skillDraft.skills.map((skill) => (
              <li className="maka-composer-skill-chip" key={skill.ref ?? skill.id}>
                <span>{skill.name}</span>
                <UiButton
                  type="button"
                  variant="quiet"
                  size="icon"
                  shape="pill"
                  className="maka-composer-skill-chip-remove"
                  aria-label={copy.removeSkillAriaLabel(skill.name)}
                  onClick={() => {
                    skillDraft.remove(skill.ref ?? skill.id);
                    window.requestAnimationFrame(() => textareaRef.current?.focus());
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </UiButton>
              </li>
            ))}
          </ul>
        ) : null}
        <UiTextarea
          ref={textareaRef}
          unstyled
          name="text"
          className="maka-composer-textarea resize-none"
          placeholder={copy.placeholder}
          aria-label={copy.textareaAriaLabel}
          aria-controls={mentionPopupOpen ? mentionListboxId : undefined}
          aria-expanded={mentionPopupOpen ? true : undefined}
          aria-activedescendant={
            mentionPopupOpen && mentionItems.length > 0
              ? mentionOptionId(mentionListboxId, mentionActiveIndex)
              : undefined
          }
          disabled={props.disabled}
          onKeyDown={onTextareaKeyDown}
          onKeyUp={recomputeMention}
          onClick={recomputeMention}
          onPaste={onTextareaPaste}
          onCompositionStart={() => { compositionActiveRef.current = true; }}
          onCompositionEnd={() => { compositionActiveRef.current = false; recomputeMention(); }}
          onInput={onTextareaInput}
          rows={1}
          autoComplete="off"
          spellCheck={false}
        />
        {mention ? (
          <ComposerMentionPopup
            trigger={mention.trigger}
            items={mentionItems}
            activeIndex={mentionActiveIndex}
            loading={mentionLoading}
            listboxId={mentionListboxId}
            onSelect={selectMention}
            onHover={setMentionActiveIndex}
          />
        ) : null}
        {dragActive && (
          <span className="maka-visually-hidden" role="status" aria-live="polite">
            {copy.dropToImport}
          </span>
        )}
        <div className="maka-composer-toolbar composerActions" data-streaming={props.streaming ? 'true' : undefined}>
          <div className="maka-composer-left-controls">
            {/* #1444: keep the ＋ menu reachable while streaming. Import
                actions still no-op mid-turn (`runImportAction` / drop
                target), so the attach item is disabled rather than
                vanishing the whole menu (and Plan/Swarm / expert teams). */}
            {(props.onPickAttachments || (props.expertTeams?.length ?? 0) > 0 || props.onPlanModeChange || props.onSwarmModeChange) ? (
              <Menu>
                <MenuTrigger
                  render={({ onClick: menuToggleClick, ...triggerRest }) => (
                    <UiButton
                      {...triggerRest}
                      variant="quiet"
                      size="icon-sm"
                      shape="pill"
                      type="button"
                      disabled={props.disabled || importActionBusy}
                      onClick={(e) => { menuToggleClick?.(e); }}
                      aria-label={pendingImportAction === 'pick' ? copy.addingAttachment : copy.add}
                      aria-busy={importActionBusy ? 'true' : undefined}
                      data-pending={importActionBusy ? 'true' : undefined}
                      title={copy.addTitle}
                    >
                      <Plus size={15} aria-hidden="true" />
                    </UiButton>
                  )}
                />
                <MenuPopup className="maka-composer-context-menu" align="start" side="top" sideOffset={6}>
                  {props.onPickAttachments ? (
                    <MenuItem
                      disabled={props.disabled || props.streaming === true || importActionBusy}
                      onClick={() => void runImportAction('pick', props.onPickAttachments)}
                    >
                      <Paperclip size={13} aria-hidden="true" />
                      <span>{copy.addFileOrDirectory}</span>
                    </MenuItem>
                  ) : null}
                  {(props.expertTeams?.length ?? 0) > 0 ? (
                    <MenuSub>
                      <MenuSubTrigger disabled={props.disabled}>
                        <Blocks size={13} aria-hidden="true" />
                        <span>{copy.expertTeam}</span>
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        {props.expertTeams?.map((team) => (
                          <MenuItem
                            key={team.id}
                            disabled={props.disabled}
                            onClick={() => props.onStartExpertTeam?.(team.id)}
                            {...(team.description ? { title: team.description } : {})}
                          >
                            <span>{team.name}</span>
                          </MenuItem>
                        ))}
                      </MenuSubPopup>
                    </MenuSub>
                  ) : null}
                  {/* #1433 subtraction: Plan/Swarm live here as switch
                      items instead of standalone toolbar switches — the
                      toolbar keeps only add / permission / model / send. */}
                  {props.onPlanModeChange || props.onSwarmModeChange ? (
                    <>
                      {/* Separator only when an attachment/expert-team group
                          precedes it — a modes-only menu must not lead with
                          a divider (review P3). */}
                      {props.onPickAttachments || (props.expertTeams?.length ?? 0) > 0 ? (
                        <MenuSeparator />
                      ) : null}
                      {props.onPlanModeChange ? (
                        <MenuCheckboxItem
                          variant="switch"
                          checked={props.planModeActive === true}
                          disabled={
                            props.disabled
                            || props.planModePending === true
                            || Boolean(props.planModeDisabledReason)
                          }
                          onCheckedChange={(checked) => {
                            void props.onPlanModeChange?.(checked);
                          }}
                          title={
                            props.planModeDisabledReason
                            ?? (props.planModeActive ? copy.disablePlanMode : copy.enablePlanMode)
                          }
                        >
                          {copy.planModeLabel}
                        </MenuCheckboxItem>
                      ) : null}
                      {props.onSwarmModeChange ? (
                        <MenuCheckboxItem
                          variant="switch"
                          checked={props.swarmModeActive === true}
                          disabled={
                            props.disabled
                            || props.swarmModePending === true
                            || Boolean(props.swarmModeDisabledReason)
                          }
                          onCheckedChange={(checked) => {
                            void props.onSwarmModeChange?.(checked);
                          }}
                          title={
                            props.swarmModeDisabledReason
                            ?? (props.swarmModeActive ? copy.disableSwarmMode : copy.enableSwarmMode)
                          }
                        >
                          {copy.swarmModeLabel}
                        </MenuCheckboxItem>
                      ) : null}
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
            {/* PR-MOVE-PERMISSION-MODE: the static "通用" role chip
                was replaced by the permission-mode dropdown — that
                spot is where the reference Settings expects users to
                pick "Ask permissions" / "Auto mode" / "Bypass
                permissions". Maka exposes the user-facing modes
                `ask` / `execute` / `bypass`; `explore` collapses to `ask` in the
                display because Deep Research sessions use it
                internally but it's not a useful runtime toggle for
                normal chat. */}
            {props.onPermissionModeChange ? (
              <PermissionModeSelect
                appearance="quiet"
                activeMode={props.permissionMode ?? 'ask'}
                onSelect={(mode) => {
                  void props.onPermissionModeChange?.(mode);
                }}
                align="start"
                disabled={props.disabled || props.permissionModePending === true || Boolean(props.permissionModeDisabledReason)}
                disabledReason={props.permissionModeDisabledReason}
              />
            ) : null}
            {/* #1433: active-mode indicators. The Plan/Swarm toggles live in
                the ＋ menu (subtraction), so an ON mode would otherwise be
                easy to miss without opening the menu. The indicator uses the
                same quiet-text-button language as the permission select next
                to it, WITHOUT a chevron: it cannot drop down. Clicking turns
                the mode off directly; while streaming (or otherwise disabled)
                it stays visible but disabled with the reason as its title. */}
            {props.planModeActive ? (
              <button
                type="button"
                className="maka-composer-mode-indicator"
                data-mode="plan"
                disabled={
                  props.disabled
                  || props.planModePending === true
                  || Boolean(props.planModeDisabledReason)
                }
                onClick={() => {
                  void props.onPlanModeChange?.(false);
                }}
                aria-label={copy.planModeOnTitle}
                title={
                  props.planModeDisabledReason ?? copy.planModeOnTitle
                }
              >
                {copy.planModeLabel}
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
            {props.swarmModeActive ? (
              <button
                type="button"
                className="maka-composer-mode-indicator"
                data-mode="swarm"
                disabled={
                  props.disabled
                  || props.swarmModePending === true
                  || Boolean(props.swarmModeDisabledReason)
                }
                onClick={() => {
                  void props.onSwarmModeChange?.(false);
                }}
                aria-label={copy.swarmModeOnTitle}
                title={
                  props.swarmModeDisabledReason ?? copy.swarmModeOnTitle
                }
              >
                {copy.swarmModeLabel}
                <X size={12} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          <span className="maka-composer-status-slot">
            {props.disabled ? (
              // PR-COMPOSER-PERMISSION-PULSE-0 (WAWQAQ msg `ed67a267`,
              // skills round task #116): wrap the "等待权限确认" text
              // in a styled hint with a pulsing accent dot. Plain text
              // was easy to miss — the dot signals "system is waiting
              // on YOU" with the same visual weight as the streaming
              // 3-dot bounce on the other side of the disabled/active
              // boundary.
              <span className="maka-composer-permission-hint">
                <span className="maka-composer-permission-dot" aria-hidden="true" />
                {copy.awaitingPermission}
              </span>
            ) : sendPending ? (
              copy.sending
            ) : importActionBusy ? (
              copy.importing
            ) : props.streaming ? (
              <span className="maka-composer-streaming-hint">
                <span className="maka-composer-streaming-dot" aria-hidden="true" />
                {props.processing
                  ? copy.processing
                  : props.continuing
                    ? copy.continuing
                    : copy.streaming} <Kbd>Esc</Kbd> {copy.interruptHint}
              </span>
            ) : (
              null
            )}
          </span>
          <div className="maka-composer-right-controls">
            {!props.streaming && (
              <>
                {props.activeSession ? (
                  <ChatModelSwitcher
                    activeSession={props.activeSession}
                    activeModel={props.activeModel}
                    activeConnectionLabel={props.activeConnectionLabel}
                    activeModelLabel={props.activeModelLabel}
                    currentProviderType={props.activeProviderType}
                    choices={props.modelChoices ?? []}
                    pending={props.modelChangePending}
                    disabledReason={modelSwitcherDisabledReason}
                    renderProviderMark={props.renderProviderMark}
                    onChange={props.onModelChange}
                    thinkingLevels={props.activeThinkingLevels}
                    thinkingLevel={props.activeThinkingLevel}
                    onThinkingLevelChange={props.onThinkingLevelChange}
                  />
                ) : props.onPickNewChatModel && (props.modelChoices?.length ?? 0) > 0 ? (
                  <NewChatModelPicker
                    label={modelChipLabel}
                    choices={props.modelChoices ?? []}
                    currentValue={
                      props.newChatModel
                        ? modelChoiceValue(props.newChatModel.llmConnectionSlug, props.newChatModel.model)
                        : undefined
                    }
                    currentProviderType={props.newChatProviderType}
                    renderProviderMark={props.renderProviderMark}
                    onPick={props.onPickNewChatModel}
                    thinkingLevels={props.newChatThinkingLevels}
                    thinkingLevel={props.newChatThinkingLevel}
                    onThinkingLevelChange={props.onNewChatThinkingLevelChange}
                  />
                ) : (
                  <ModelChipStatic label={modelChipLabel} onOpenSettings={props.onOpenModelSettings} />
                )}
              </>
            )}
            {props.streaming ? (
              <UiButton
                variant="default"
                size="md"
                type="button"
                disabled={props.stopPending}
                onClick={() => {
                  if (props.stopPending) return;
                  void props.onStop();
                }}
                aria-busy={props.stopPending ? 'true' : undefined}
                data-pending={props.stopPending ? 'true' : undefined}
              >
                {props.stopPending ? copy.stopping : copy.stopLabel}
              </UiButton>
            ) : (
              <UiButton
                variant="default"
                size="icon"
                shape="pill"
                type="submit"
                disabled={sendDisabled}
                aria-label={copy.sendLabel}
                aria-busy={sendPending ? 'true' : undefined}
                data-pending={sendPending ? 'true' : undefined}
                title={sendTitle}
              >
                <ArrowUp size={16} aria-hidden="true" />
              </UiButton>
            )}
          </div>
        </div>
      </div>
      {props.workspacePicker ? (
        <ComposerWorkspaceRow workspacePicker={props.workspacePicker} branchPicker={props.branchPicker} />
      ) : null}
    </form>
    </>
  );
});
