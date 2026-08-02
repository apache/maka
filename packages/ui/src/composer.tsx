import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useMountedRef } from './use-mounted-ref.js';
import {
  ArrowUp,
  FileText,
  ListTodo,
  Mic,
  Network,
  Pencil,
  Plus,
  Sparkles,
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
import { type ChatModelChoice, modelChoiceValue } from './chat-model-helpers.js';
import { appendPromptContextDraft, isReferenceSizedPaste } from './composer-helpers.js';
import { useComposerDraft } from './use-composer-draft.js';
import { useComposerHistory } from './use-composer-history.js';
import {
  composerWireText,
  createChatInputActionOwner,
  createTriggerSearchSource,
  fileTransferContainsFiles,
  isChatInputComposing,
  mentionQueryMatches,
  skillMentionQuery,
  type ChatInputActionOwner,
  type ComposerTextPort,
} from './chat-input-behavior.js';
import { ComposerWorkspaceRow, type ComposerBranchPicker, type ComposerWorkspacePicker } from './composer-workspace-row.js';
import { SKILL_INVOCATION_TOKEN_SOURCE } from '@maka/core';
import type { AttachmentRef, PermissionMode, ProviderType, QuoteRef, SessionSummary } from '@maka/core';
import {
  Button as UiButton,
  ChatComposer as AstryxChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  IconButton,
  Token,
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
  DropdownMenuItem,
} from '@astryxdesign/core/DropdownMenu';
import { PermissionModeSelect } from './permission-mode-menu.js';

/** A Skill as the composer offers it: what the `/` menu lists and what a
 * chosen entry writes into the draft. */
export interface ComposerSkillOption {
  /** The id the `/skill:<id>` token carries, and what Runtime resolves. */
  id: string;
  name: string;
  description?: string;
}

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

/** Last path segment of a POSIX-style relative path — the mention row's primary label. */
function fileBasename(relativePath: string): string {
  const segments = relativePath.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? relativePath;
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
  /** Append to a specific session draft without replacing newer text. */
  appendDraft?(draftKey: string, text: string): void;
  /** Move focus to the input without changing its content. */
  focus(): void;
}

type ComposerImportActionId = 'pick' | 'attach';

export const Composer = forwardRef<
  ComposerHandle,
  {
    disabled?: boolean;
    hidden?: boolean;
    /**
     * When true, a turn is in flight — live output OR the pre-first-token wait.
     * Send becomes Stop. The ＋ menu and permission control stay reachable
     * (#1444); import stays blocked mid-turn.
     */
    streaming?: boolean;
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
    /** Runtime-only key used to keep unsent drafts isolated per session. */
    draftKey?: string;
    onSend(text: string): boolean | void | Promise<boolean | void>;
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
    modelLabel?: string;
    activeSession?: SessionSummary;
    activeConnectionLabel?: string;
    activeModel?: string;
    activeModelLabel?: string;
    activeProviderType?: ProviderType;
    modelChoices?: ChatModelChoice[];
    /** Renders the provider brand mark beside each model option;
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
     * by the mode the session's boundary is actually in (只读 / 自动 /
     * 完全权限); selecting an option fires `onPermissionModeChange`.
     * A read-only session displays 只读 without it becoming a third
     * option (#1611).
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
    graphModeActive?: boolean;
    graphModePending?: boolean;
    graphModeDisabledReason?: string;
    onGraphModeChange?(active: boolean): void | Promise<void>;
    voiceCaptureState?: 'idle' | 'requesting' | 'recording' | 'processing' | 'native_ready' | 'sending';
    /** @deprecated Quiet composer drops realtime chrome; retained for host compatibility. */
    realtimeVoiceState?: 'idle' | 'connecting' | 'connected';
    voiceProviderLabel?: string;
    /**
     * When provided (and the host has recognition configured), a single mic
     * appears left of Send. Omitted by default so unconfigured voice is not a
     * dead control.
     */
    onToggleVoiceCapture?(input?: { dictate?: boolean }): void | Promise<void>;
    onCancelVoiceCapture?(): void;
    /** @deprecated Realtime voice is not rendered in the quiet composer. */
    onToggleRealtimeVoice?(): void | Promise<void>;
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
    onSearchMentionFiles?(query: string): Promise<ReadonlyArray<{ relativePath: string }>>;
  }
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
   */
  function caretToContentEnd() {
    const editable = editableNode();
    if (!editable) return;
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
      inputHandleRef.current?.insertToken({
        value: match[0],
        label: skill.name,
        icon: <Sparkles size={12} aria-hidden="true" />,
      });
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
   */
  useEffect(() => {
    let restoreCaret = caretToEndRef.current;
    caretToEndRef.current = false;
    if (redrawPendingRef.current && redrawSkillTokens()) {
      redrawPendingRef.current = false;
      restoreCaret = true;
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
    appendDraft,
    activeDraftKey,
  } = useComposerDraft({
    text: textPort,
    draftKey: props.draftKey,
    onDraftKeyChange: resetPromptHistoryNavigation,
  });
  const { resetNavigation, rememberSentEntry, handleArrowKey } = useComposerHistory({
    text: textPort,
    saveCurrentDraft,
  });
  // PR-UI-15: locale-aware copy for placeholder + toolbar states.
  const locale = useUiLocale();
  const copy = getConversationCopy(locale).composer;
  const mentionCopy = getConversationCopy(locale).mentions;
  const voiceCaptureLabel = props.voiceCaptureState === 'recording'
    ? copy.voiceStopRecording
    : props.voiceCaptureState === 'native_ready'
      ? copy.voiceSend
      : copy.voiceStart;

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
    onSearchMentionFiles: props.onSearchMentionFiles,
  });
  useEffect(() => {
    mentionSourceRef.current = {
      mentionSkills: props.mentionSkills,
      onSearchMentionFiles: props.onSearchMentionFiles,
    };
  });

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
    const listSkills = (rawQuery: string): SearchableItem[] => {
      const skills = mentionSourceRef.current.mentionSkills ?? [];
      const query = skillMentionQuery(rawQuery);
      return skills
        .filter((skill) =>
          mentionQueryMatches(query, `${skill.id} ${skill.name} ${skill.description ?? ''}`),
        )
        .slice(0, 50)
        .map((skill) => ({ id: skill.id, label: skill.name, auxiliaryData: skill }));
    };
    // `bootstrap` is required by SearchSource but never called by
    // `useTriggerMenu`; the menu opens straight into `search`.
    searchSourcesRef.current = {
      files,
      skills: { bootstrap: () => listSkills(''), search: listSkills },
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
            <FileText size={14} aria-hidden="true" className="maka-composer-mention-icon" />
            <span className="maka-composer-mention-text">
              <span className="maka-composer-mention-name">{fileBasename(item.id)}</span>
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
        onSelect: (item): ChatComposerToken => ({ value: `@${item.id}`, label: fileBasename(item.id) }),
      });
    }
    if (props.mentionSkills !== undefined) {
      list.push({
        character: '/',
        searchSource: sources.skills,
        menuLabel: mentionCopy.skillsAriaLabel,
        emptySearchResultsText: mentionCopy.noSkills,
        loadingText: mentionCopy.loading,
        // Name over description, and no id: the second line is one line wide,
        // and the id spent a dozen characters of it on a string nobody types
        // here — the menu is how you avoid typing it. It stays searchable
        // (`listSkills` matches against it) and it is still what the chip
        // serializes to; it just no longer crowds out the sentence that tells
        // two Skills apart.
        //
        // Visible, not a tooltip: every menu item in Astryx — dropdown, radio,
        // checkbox, submenu — carries its explanation as a `description` line,
        // and none carries one on hover. A `/` menu is driven with ↑↓, so a
        // hover-only description would be invisible to the way it is used.
        renderItem: (item) => {
          const skill = item.auxiliaryData as ComposerSkillOption;
          return (
            <>
              <Sparkles size={14} aria-hidden="true" className="maka-composer-mention-icon" />
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
        onSelect: (item): ChatComposerToken => ({
          value: skillTokenValue(item.id),
          label: (item.auxiliaryData as ComposerSkillOption).name,
          icon: <Sparkles size={12} aria-hidden="true" />,
        }),
      });
    }
    return list;
    // The sources live in a ref, so only the localized copy, provider presence,
    // and the Skill projection identity (see the refresh effect below) matter.
  }, [locale, Boolean(props.onSearchMentionFiles), props.mentionSkills]);

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
  }, [props.mentionSkills]);

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
    }),
    [],
  );

  async function sendCurrent() {
    if (props.disabled || sendPendingRef.current || importActionOwnerRef.current?.pending) return;
    // One argument, because there is one draft: staged Skills ride inside the
    // text as `/skill:<id>` tokens, and Runtime resolves and strips them before
    // the model sees the message.
    const text = composerWireText(textPort.getValue());
    if (!text) return;
    const submittedDraftKey = activeDraftKey();
    sendPendingRef.current = true;
    setSendPending(true);
    let sent: boolean | void;
    try {
      sent = await props.onSend(text);
    } finally {
      sendPendingRef.current = false;
      if (composerMountedRef.current) setSendPending(false);
    }
    if (!composerMountedRef.current) return;
    if (sent === false) return;
    // Save to both local ref and global persistence so the history
    // survives page reloads and is shared across all input surfaces.
    rememberSentEntry(text);
    clearDraft(submittedDraftKey);
    // The owner may have changed while onSend awaited (new-session creation,
    // revision branch, or user navigation). Never erase a foreign draft.
    if (activeDraftKey() !== submittedDraftKey) return;
    textPort.setValue('');
    saveCurrentDraft('');
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
    if (
      event.key === 'Escape' &&
      props.voiceCaptureState &&
      props.voiceCaptureState !== 'idle'
    ) {
      event.preventDefault();
      props.onCancelVoiceCapture?.();
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
    // Shift+Enter / Alt+Enter insert a line break instead of sending. We have
    // to insert it ourselves rather than fall through: ChatComposerInput's own
    // Enter branch only exempts Shift, so a bare `return` here would hand it
    // Alt+Enter as a submit — and that path clears the editor even when it
    // sends nothing, silently dropping the draft.
    if (event.shiftKey || event.altKey) {
      event.preventDefault();
      document.execCommand('insertLineBreak');
      return;
    }
    event.preventDefault();
    void sendCurrent();
  }

  function onInputChange(next: string) {
    applyText(next);
    resetPromptHistoryNavigation();
    saveCurrentDraft(next);
  }

  function canAcceptDroppedFiles(): boolean {
    return Boolean(props.onAttachFilePaths && !props.disabled && !props.streaming && !importActionOwnerRef.current?.pending);
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
    sendPending ||
    importActionBusy ||
    !text.trim() ||
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
    (props.pendingQuotes?.length ?? 0) + (props.pendingAttachments?.length ?? 0);
  /**
   * The session modes that are currently on, in the order the ＋ menu lists
   * them. The menu stays the switch — it turns each mode on *and* off; these
   * marks are the resting state readout, plus one nearby way out. They sit at
   * the tail of the footer's left controls, after the model and thinking
   * pickers, so switching a mode never shifts those two.
   *
   * Which mode a mark is comes from its icon, never from a hue. Maka blue is
   * the single product accent (DESIGN.md), so a per-mode colour would be a
   * second and third accent carrying no semantic — and a coloured pill per
   * status is on the same file's Don't list.
   */
  const modes: ReadonlyArray<{
    id: 'plan' | 'swarm' | 'graph';
    active: boolean;
    icon: ReactNode;
    label: string;
    onTitle: string;
    isDisabled: boolean;
    disabledReason: string | undefined;
    onDeactivate(): void;
  }> = [
    {
      id: 'plan',
      active: props.planModeActive === true && props.onPlanModeChange !== undefined,
      icon: <ListTodo size={15} aria-hidden="true" />,
      label: copy.planModeLabel,
      onTitle: copy.planModeOnTitle,
      isDisabled:
        props.disabled === true
        || props.planModePending === true
        || Boolean(props.planModeDisabledReason),
      disabledReason: props.planModeDisabledReason,
      onDeactivate: () => { void props.onPlanModeChange?.(false); },
    },
    {
      id: 'swarm',
      active: props.swarmModeActive === true && props.onSwarmModeChange !== undefined,
      icon: <Network size={15} aria-hidden="true" />,
      label: copy.swarmModeLabel,
      onTitle: copy.swarmModeOnTitle,
      isDisabled:
        props.disabled === true
        || props.swarmModePending === true
        || Boolean(props.swarmModeDisabledReason),
      disabledReason: props.swarmModeDisabledReason,
      onDeactivate: () => { void props.onSwarmModeChange?.(false); },
    },
    {
      id: 'graph',
      active: props.graphModeActive === true && props.onGraphModeChange !== undefined,
      icon: <Workflow size={15} aria-hidden="true" />,
      label: copy.graphModeLabel,
      onTitle: copy.graphModeOnTitle,
      isDisabled:
        props.disabled === true
        || props.graphModePending === true
        || Boolean(props.graphModeDisabledReason),
      disabledReason: props.graphModeDisabledReason,
      onDeactivate: () => { void props.onGraphModeChange?.(false); },
    },
  ];
  const activeModes = modes.filter((mode) => mode.active);
  const showPlusMenu = Boolean(
    props.onPickAttachments
    || props.mentionSkills
    || props.onPlanModeChange
    || props.onSwarmModeChange
    || props.onGraphModeChange,
  );
  const showVoiceCapture = Boolean(props.onToggleVoiceCapture) && !props.streaming;

  return (
    <>
      {/* U3: no-model dead-end guidance. Outside the form so it never grows
          the composer's constant footprint (#740). */}
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
      {/* New-chat project/branch bar sits above the card (quiet chrome). */}
      {!props.activeSession && props.workspacePicker ? (
        <div className="maka-composer-workspace-dock" hidden={props.hidden}>
          <ComposerWorkspaceRow workspacePicker={props.workspacePicker} branchPicker={props.branchPicker} />
        </div>
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
          data-streaming={props.streaming ? 'true' : undefined}
          // Unreachable, and required. The shell only submits its own value,
          // and it never has one: `value` is passed straight to the controlled
          // ChatComposerInput, so the shell's copy stays empty and its submit
          // short-circuits. Sending is owned by the form (the send button) and
          // by `onInputKeyDown` (Enter). Same for the shell's stop button — we
          // render our own into the `sendButton` slot.
          onSubmit={() => {}}
          isDisabled={props.disabled}
          drawer={drawerTokenCount > 0 ? (
            <ChatComposerDrawer count={drawerTokenCount} label={copy.addContext}>
              <div className="maka-composer-context-drawer" aria-label={copy.addContext}>
                {props.pendingQuotes?.map((quote, index) => (
                  <Token
                    key={`${quote.sourceTurnId ?? 'quote'}-${index}`}
                    size="sm"
                    label={quote.label?.trim() || quote.text.slice(0, 48) || copy.pastedQuoteLabel}
                    onRemove={props.onRemoveQuote ? () => props.onRemoveQuote?.(index) : undefined}
                  />
                ))}
                {props.pendingAttachments?.map((attachment, index) => (
                  <Token
                    key={`${attachment.displayName}-${index}`}
                    size="sm"
                    label={attachment.displayName}
                    onRemove={props.onRemoveAttachment ? () => props.onRemoveAttachment?.(index) : undefined}
                  />
                ))}
              </div>
            </ChatComposerDrawer>
          ) : undefined}
          input={(
            <div
              className="maka-composer-input"
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
            <div className="maka-composer-left-controls" data-streaming={props.streaming ? 'true' : undefined}>
              {/* Resting order: ＋ leftmost, then permission icon. */}
              {showPlusMenu ? (
                <span className="maka-composer-plus-menu">
                  <DropdownMenu
                    placement="above"
                    hasChevron={false}
                    className="maka-composer-quiet-menu"
                    button={{
                      label: copy.addContext,
                      icon: <Plus size={15} aria-hidden="true" />,
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
                        icon={<Upload size={15} aria-hidden="true" />}
                        isDisabled={props.disabled || props.streaming === true || importActionBusy}
                        onClick={() => {
                          void runImportAction('pick', props.onPickAttachments);
                        }}
                      />
                    ) : null}
                    {props.mentionSkills ? (
                      <DropdownMenuItem
                        label={copy.chooseSkill}
                        icon={<Sparkles size={15} aria-hidden="true" />}
                        // Nothing to choose from means nothing to open. The
                        // entry types `/` into the draft, so an enabled item
                        // with an empty catalog spends the user's click writing
                        // a stray slash and popping an empty menu. Say why it is
                        // unavailable: the panel this replaced showed "no skills
                        // available", and a silent grey row answers nothing.
                        isDisabled={props.disabled || props.mentionSkills.length === 0}
                        description={
                          props.mentionSkills.length === 0 ? copy.noSkillsAvailable : undefined
                        }
                        onClick={openSkillMenu}
                      />
                    ) : null}
                    {props.onPlanModeChange ? (
                      <DropdownMenuCheckboxItem
                        label={copy.planModeLabel}
                        icon={<ListTodo size={15} aria-hidden="true" />}
                        value={props.planModeActive === true}
                        isDisabled={
                          props.disabled
                          || props.planModePending === true
                          || Boolean(props.planModeDisabledReason)
                        }
                        onChange={(checked) => {
                          void props.onPlanModeChange?.(checked);
                        }}
                        aria-description={props.planModeDisabledReason
                          ?? (props.planModeActive ? copy.disablePlanMode : copy.enablePlanMode)}
                      />
                    ) : null}
                    {props.onSwarmModeChange ? (
                      <DropdownMenuCheckboxItem
                        label={copy.swarmModeLabel}
                        icon={<Network size={15} aria-hidden="true" />}
                        value={props.swarmModeActive === true}
                        isDisabled={
                          props.disabled
                          || props.swarmModePending === true
                          || Boolean(props.swarmModeDisabledReason)
                        }
                        onChange={(checked) => {
                          void props.onSwarmModeChange?.(checked);
                        }}
                        aria-description={props.swarmModeDisabledReason
                          ?? (props.swarmModeActive ? copy.disableSwarmMode : copy.enableSwarmMode)}
                      />
                    ) : null}
                    {props.onGraphModeChange ? (
                      <DropdownMenuCheckboxItem
                        label={copy.graphModeLabel}
                        icon={<Workflow size={15} aria-hidden="true" />}
                        value={props.graphModeActive === true}
                        isDisabled={
                          props.disabled
                          || props.graphModePending === true
                          || Boolean(props.graphModeDisabledReason)
                        }
                        onChange={(checked) => {
                          void props.onGraphModeChange?.(checked);
                        }}
                        aria-description={props.graphModeDisabledReason
                          ?? (props.graphModeActive ? copy.disableGraphMode : copy.enableGraphMode)}
                      />
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
                    || props.permissionModePending === true
                    || Boolean(props.permissionModeDisabledReason)
                  }
                  disabledReason={props.permissionModeDisabledReason}
                />
              ) : null}
              {/* Model + thinking sit left after permission (adjacent pair), not
                  in the send cluster. Thinking is its own Selector, only when
                  the active/new-chat model offers levels. */}
              {!props.streaming ? (
                <div className="maka-model-selection-controls">
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
                    />
                  ) : (
                    <ModelChipStatic label={modelChipLabel} onOpenSettings={props.onOpenModelSettings} />
                  )}
                  {props.activeSession ? (
                    <ThinkingLevelSelector
                      levels={props.activeThinkingLevels ?? []}
                      current={props.activeThinkingLevel}
                      onChange={props.onThinkingLevelChange}
                      disabled={Boolean(modelSwitcherDisabledReason) || props.modelChangePending}
                      loading={props.modelChangePending}
                    />
                  ) : (
                    <ThinkingLevelSelector
                      levels={props.newChatThinkingLevels ?? []}
                      current={props.newChatThinkingLevel}
                      onChange={props.onNewChatThinkingLevelChange}
                    />
                  )}
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
              {activeModes.map((mode) => (
                <IconButton
                  key={mode.id}
                  variant="ghost"
                  type="button"
                  size="sm"
                  className="maka-composer-mode-button"
                  data-mode={mode.id}
                  label={mode.label}
                  tooltip={mode.disabledReason ?? mode.onTitle}
                  isDisabled={mode.isDisabled}
                  onClick={() => {
                    mode.onDeactivate();
                    window.requestAnimationFrame(() => focusInput());
                  }}
                  icon={mode.icon}
                />
              ))}
            </div>
          )}
          sendActions={(
            <div className="maka-composer-right-controls">
              {showVoiceCapture ? (
                <IconButton
                  variant="ghost"
                  type="button"
                  size="sm"
                  className="maka-composer-voice-button"
                  data-state={props.voiceCaptureState ?? 'idle'}
                  isDisabled={
                    props.disabled
                    || props.voiceCaptureState === 'requesting'
                    || props.voiceCaptureState === 'processing'
                    || props.voiceCaptureState === 'sending'
                  }
                  label={voiceCaptureLabel}
                  tooltip={`${voiceCaptureLabel}${props.voiceProviderLabel ? ` · ${props.voiceProviderLabel}` : ''}`}
                  onClick={(event) => {
                    void props.onToggleVoiceCapture?.({ dictate: event.shiftKey });
                  }}
                  icon={<Mic size={15} aria-hidden="true" />}
                />
              ) : null}
            </div>
          )}
          sendButton={props.streaming ? (
            <UiButton
              variant="primary"
              isDisabled={props.stopPending}
              onClick={() => {
                if (props.stopPending) return;
                void props.onStop();
              }}
              aria-busy={props.stopPending ? 'true' : undefined}
              data-pending={props.stopPending ? 'true' : undefined}
              label={props.stopPending ? copy.stopping : copy.stopLabel}
            />
          ) : (
            <IconButton
              variant="primary"
              type="submit"
              isDisabled={sendDisabled}
              label={copy.sendLabel}
              aria-busy={sendPending ? 'true' : undefined}
              data-pending={sendPending ? 'true' : undefined}
              tooltip={sendTitle}
              icon={<ArrowUp size={16} aria-hidden="true" />}
            />
          )}
        />
      </form>
    </>
  );
});
