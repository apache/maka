import {
  CombinedAutocompleteProvider,
  Editor,
  Key,
  SelectList,
  decodeKittyPrintable,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type Component,
  type SelectItem,
  type TUI,
} from '@earendil-works/pi-tui';
import type { UserQuestionOption } from '@maka/core/user-question';
import type { PermissionMode } from '@maka/core/permission';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { InvocableSkillEntry } from '@maka/runtime/skill-invocation';
import { PROVIDER_DEFAULTS, type ModelInfo, type ProviderType } from '@maka/core/llm-connections';
import type { ModelChoice, OnboardingProviderEntry } from './pi-tui-contracts.js';
import { skillInvocationPrefixAt } from './skill-token.js';
import { ansi, editorTheme, selectListTheme, stripAnsi } from './tui-ansi.js';

export class MakaAutocompleteProvider implements AutocompleteProvider {
  private readonly fileProvider: CombinedAutocompleteProvider | undefined;
  private readonly slashCommands: readonly MakaSlashCommandMetadata[];
  private readonly listSkills?: () => Promise<readonly InvocableSkillEntry[]>;

  // The kind of suggestions last returned by getSuggestions: 'skill' when the
  // active list was mid-message `/skill:` completions, null otherwise. The
  // Editor runs getSuggestions before applyCompletion and snapshot-guards the
  // request, so this reliably disambiguates a mid-message skill selection (no
  // `/` in prefix) from a file selection sharing the same prefix.
  private lastSlashKind: 'skill' | null = null;

  constructor(
    basePath: string | undefined,
    slashCommands: readonly MakaSlashCommandMetadata[],
    listSkills?: () => Promise<readonly InvocableSkillEntry[]>,
  ) {
    this.fileProvider = basePath ? new CombinedAutocompleteProvider([], basePath) : undefined;
    this.slashCommands = slashCommands;
    this.listSkills = listSkills;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    this.lastSlashKind = null;
    // `/skill:<query>` takes precedence everywhere - including at line start,
    // where it would otherwise parse as a (non-matching) slash command — and
    // it suppresses file completion: the token charset looks path-like.
    const skillPrefix = skillInvocationPrefixAt(lines, cursorLine, cursorCol);
    if (skillPrefix !== null && this.listSkills && !options.force) {
      // Skill completion is first-line only, matching pi-tui's isSlashMenuAllowed.
      if (cursorLine !== 0) return null;
      const query = skillPrefix.query.toLowerCase();
      const skills = await this.listSkills();
      if (options.signal.aborted) return null;
      const items = skills
        .filter(
          (skill) =>
            skill.id.toLowerCase().startsWith(query) || skill.name.toLowerCase().includes(query),
        )
        .map((skill) => ({
          value: skill.id,
          label: `/skill:${skill.id}`,
          description: skill.description ? `${skill.name} · ${skill.description}` : skill.name,
        }));
      if (items.length > 0) {
        // Line-start keeps `/skill:query` so pi-tui auto-submits on select (the
        // existing "select to invoke" UX). Mid-message drops the `/skill:` head
        // (just the query) so selection inserts and returns instead of
        // submitting - pi-tui submits only when `autocompletePrefix` starts with `/`.
        this.lastSlashKind = 'skill';
        const currentLine = lines[cursorLine] || '';
        const textBeforeCursor = currentLine.slice(0, cursorCol);
        const atLineStart =
          textBeforeCursor.slice(0, textBeforeCursor.length - skillPrefix.prefix.length).trim() ===
          '';
        return { items, prefix: atLineStart ? skillPrefix.prefix : skillPrefix.query };
      }
      return null;
    }
    if (skillPrefix !== null && !options.force) {
      // Inside a token but no skill surface: never fall through to path completion.
      return null;
    }
    const slashPrefix = slashCommandPrefix(lines, cursorLine, cursorCol);
    if (slashPrefix !== null && !options.force) {
      const query = slashPrefix.slice(1).toLowerCase();
      const items = this.slashCommands
        .filter((command) => command.name.startsWith(query))
        .map((command) => ({
          value: command.name,
          label: `/${command.name}`,
          description: command.description,
        }));
      return items.length > 0 ? { items, prefix: slashPrefix } : null;
    }
    // A bare mid-message `/`-token (not `/skill:`, handled above): offer
    // `/skill:xxx` completions so typing `/` surfaces skills immediately. Plain
    // commands are not offered here - they only execute at line start.
    const midSlash = midMessageSlashToken(lines, cursorLine, cursorCol);
    if (midSlash !== null && this.listSkills && !options.force) {
      // Keep the raw query as the replacement prefix; toLowerCase can change
      // UTF-16 length (e.g. "İ" -> "i̇", len 1 -> 2), and applyCompletion slices
      // by prefix.length, so a lowercased prefix would over-delete the original.
      const rawQuery = midSlash.slice(1);
      const query = rawQuery.toLowerCase();
      const skills = await this.listSkills();
      if (options.signal.aborted) return null;
      const items = skills
        .filter(
          (skill) =>
            skill.id.toLowerCase().startsWith(query) || skill.name.toLowerCase().includes(query),
        )
        .map((skill) => ({
          value: `skill:${skill.id}`,
          label: `/skill:${skill.id}`,
          description: skill.description ? `${skill.name} · ${skill.description}` : skill.name,
        }));
      if (items.length > 0) {
        // Prefix is the raw text after `/` (no leading `/`) so pi-tui's
        // select-confirm guard does not auto-submit. applyCompletion reuses the
        // mid-message skill path: beforePrefix ends with `/`, item.value is
        // `skill:<id>`, so `${beforePrefix}${item.value} ` yields `/skill:<id> `.
        this.lastSlashKind = 'skill';
        return { items, prefix: rawQuery };
      }
      // No skill matched. Do NOT fall through to the file provider: a mid-message
      // `/`-token's file completion would carry a `/`-prefixed prefix, and pi-tui's
      // select-confirm guard auto-submits when `prefix.startsWith("/")` - so
      // selecting it would send the unfinished message. Mid-message `/`-path
      // completion was not available before this PR either (pi-tui excludes `/`
      // from triggerCharacters), so returning null restores the prior behavior.
      return null;
    }
    return this.fileProvider?.getSuggestions(lines, cursorLine, cursorCol, options) ?? null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] || '';
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    if (prefix.startsWith('/skill:')) {
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}/skill:${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 8,
      };
    }
    if (prefix.startsWith('/') && beforePrefix.trim() === '') {
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}/${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 2,
      };
    }
    if (this.lastSlashKind === 'skill') {
      // Mid-message skill: prefix is just the query (no `/skill:`); the
      // `/skill:` head sits at the end of beforePrefix. Insert
      // `/skill:<value> ` and leave the cursor after the space; pi-tui will not
      // auto-submit because the prefix did not start with `/`.
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}${item.value} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + 1,
      };
    }
    return this.fileProvider
      ? this.fileProvider.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
      : { lines, cursorLine, cursorCol };
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    if (skillInvocationPrefixAt(lines, cursorLine, cursorCol) !== null) return false;
    return this.fileProvider?.shouldTriggerFileCompletion(lines, cursorLine, cursorCol) ?? false;
  }
}

/** Autocomplete surface for `/move`: reuse path completion but expose folders only. */
export class DirectoryAutocompleteProvider implements AutocompleteProvider {
  private readonly provider: CombinedAutocompleteProvider;

  constructor(basePath: string) {
    this.provider = new CombinedAutocompleteProvider([], basePath);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const suggestions = await this.provider.getSuggestions(lines, cursorLine, cursorCol, options);
    if (!suggestions) return null;
    const items = suggestions.items.filter((item) => item.label.endsWith('/'));
    return items.length > 0 ? { ...suggestions, items } : null;
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] || '';
    const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
    if (prefix.startsWith('/') && beforePrefix.trim() === '') {
      // Directory completion is path syntax even when the editor sees a
      // slash-prefixed token. Do not route an absolute path through the
      // slash-command completion rule, which would add a second slash.
      const completed = item.value.startsWith('/') ? item.value : `/${item.value}`;
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}${completed} ${currentLine.slice(cursorCol)}`;
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + completed.length + 1,
      };
    }
    return this.provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.provider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
  }
}

export interface MakaSlashCommandMetadata {
  name: string;
  description: string;
}

export interface MakaSlashCommand extends MakaSlashCommandMetadata {
  run(parts: string[], rawTail: string | undefined, context: { idleMs: number }): void;
  /** Alternate names that dispatch to this command without appearing in
   *  completion or the /help menu (e.g. /quit as an alias of /exit). */
  aliases?: readonly string[];
}

function slashCommandPrefix(lines: string[], cursorLine: number, cursorCol: number): string | null {
  const currentLine = lines[cursorLine] || '';
  const textBeforeCursor = currentLine.slice(0, cursorCol);
  return textBeforeCursor.startsWith('/') && !textBeforeCursor.includes(' ')
    ? textBeforeCursor
    : null;
}

// A `/`-token that begins mid-message (after whitespace) on the first line,
// excluding the `/skill:` form (handled by skillInvocationPrefixAt above) and
// line-start (handled by slashCommandPrefix). Used to offer `/skill:xxx`
// completions from a bare `/` so typing `/` surfaces skills immediately.
function midMessageSlashToken(
  lines: string[],
  cursorLine: number,
  cursorCol: number,
): string | null {
  if (cursorLine !== 0) return null;
  const currentLine = lines[cursorLine] || '';
  const textBeforeCursor = currentLine.slice(0, cursorCol);
  const match = /(?:\s)(\/\S*)$/.exec(textBeforeCursor);
  if (!match) return null;
  const token = match[1];
  return token.startsWith('/skill:') ? null : token;
}

export class PickerOverlay implements Component {
  constructor(
    private readonly list: SelectList,
    private readonly input: {
      title: string;
      rightLabel: string;
      hint?: string;
      onInput?: (data: string) => boolean;
    },
  ) {}

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    if (this.input.onInput?.(data)) return;
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    return [
      padLine(`${this.input.title} ${ansi.accent(this.input.rightLabel)}`, safeWidth),
      padLine(ansi.dim(this.input.hint ?? 'enter select / esc close'), safeWidth),
      padLine('', safeWidth),
      ...this.list.render(safeWidth).map((line) => formatPickerItemLine(line, safeWidth)),
      padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth),
    ];
  }
}

export class DirectoryPickerOverlay implements Component {
  private readonly editor: Editor;

  constructor(
    tui: TUI,
    private readonly input: {
      currentCwd: string;
      basePath: string;
      onSubmit: (cwd: string) => void;
      onCancel: () => void;
    },
  ) {
    this.editor = new Editor(tui, editorTheme(), { paddingX: 0, autocompleteMaxVisible: 8 });
    this.editor.setAutocompleteProvider(new DirectoryAutocompleteProvider(input.basePath));
    this.editor.onSubmit = (value) => {
      const cwd = value.trim();
      if (cwd) this.input.onSubmit(cwd);
    };
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.input.onCancel();
      return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.editor.focused = true;
    const label = 'Directory ';
    const labelWidth = visibleWidth(label);
    const editorLines = this.editor.render(Math.max(1, safeWidth - labelWidth)).slice(1, -1);
    return [
      padLine('Move Session', safeWidth),
      padLine(ansi.dim('Type a directory · Tab complete · Enter confirm · Esc cancel'), safeWidth),
      padLine(ansi.dim(`Current: ${this.input.currentCwd}`), safeWidth),
      padLine('', safeWidth),
      ...(editorLines.length > 0
        ? editorLines.map((line, index) =>
            padLine(`${index === 0 ? label : ' '.repeat(labelWidth)}${line}`, safeWidth),
          )
        : [padLine(label, safeWidth)]),
      padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth),
    ];
  }
}

const USER_QUESTION_ROW_PREFIX_WIDTH = 2;

/**
 * A single question's overlay: the preset options and a free-text "Other" row on
 * one screen. The free-text row is the list's last line — an inline {@link Editor}
 * that activates when the highlight lands on it. ↑↓ move the highlight through the
 * options and the input row as one ring; typing a printable character while on an
 * option jumps to the input row and starts the answer there (gemini-cli's
 * type-to-jump). Enter selects the highlighted option, or submits non-empty input
 * text; Esc leaves the whole question unanswered. Replaces the old two-step design
 * that swapped the option list out for a separate text overlay.
 */
export class UserQuestionOverlay implements Component {
  private readonly editor: Editor;
  // Highlight index over [0, options.length]. `options.length` is the input row.
  private activeIndex = 0;

  constructor(
    tui: TUI,
    private readonly input: {
      title: string;
      rightLabel: string;
      hint: string;
      placeholder: string;
      options: readonly UserQuestionOption[];
      onSelectOption(index: number): void;
      onSubmitText(value: string): void;
      onSkip(): void;
    },
  ) {
    // paddingX 0 so the inline row aligns under the `  `/`→ ` option prefix
    // instead of the editor's own gutter.
    this.editor = new Editor(tui, editorTheme(), { paddingX: 0 });
    // Submit through the Editor's own submitValue() path: it expands paste
    // markers (a large paste is stored as a `[paste #N …]` placeholder until
    // then) and trims, so the answer is the real pasted/typed text. An empty
    // submission is a no-op so Enter on the blank row can't send a blank answer.
    this.editor.onSubmit = (value) => {
      if (value) this.input.onSubmitText(value);
    };
  }

  private get inputRowIndex(): number {
    return this.input.options.length;
  }

  private get onInputRow(): boolean {
    return this.activeIndex === this.inputRowIndex;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    // Esc always abandons the whole question (advance unanswered), even with
    // text typed — one Esc level, matching the pre-inline behavior.
    if (matchesKey(data, Key.escape)) {
      this.input.onSkip();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.activeIndex = this.activeIndex === 0 ? this.inputRowIndex : this.activeIndex - 1;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.activeIndex = this.activeIndex === this.inputRowIndex ? 0 : this.activeIndex + 1;
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      // A held-key repeat must not double-advance onto the next question.
      if (isKeyRepeat(data)) return;
      if (!this.onInputRow) {
        this.input.onSelectOption(this.activeIndex);
        return;
      }
      // Fall through: on the input row even Enter goes to the Editor, whose own
      // key classification decides newline (LF/Ctrl-J, Shift+Enter, `\`+Enter)
      // vs submit — submitValue() then feeds the wired onSubmit above.
    }
    if (this.onInputRow) {
      this.editor.handleInput(data);
      return;
    }
    // Type-to-jump: a printable key (or an IME/legacy multi-byte sequence) while
    // an option is highlighted moves to the input row and starts the answer with
    // that key. Mirror the editor's own printable test — a Kitty CSI-u printable,
    // or a legacy sequence whose first byte is a non-control character — so
    // navigation/control keys (arrows, Enter, Esc, Ctrl/Alt combos) never trigger
    // the jump. The raw sequence is handed to the editor so its IME and paste
    // handling stay intact.
    const printable = decodeKittyPrintable(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
    if (printable !== undefined) {
      this.activeIndex = this.inputRowIndex;
      this.editor.handleInput(data);
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [
      padLine(`${this.input.title} ${ansi.accent(this.input.rightLabel)}`, safeWidth),
      padLine(ansi.dim(this.input.hint), safeWidth),
      padLine('', safeWidth),
    ];
    this.input.options.forEach((option, index) => {
      lines.push(this.renderOptionRow(option, index === this.activeIndex, safeWidth));
    });
    lines.push(...this.renderInputRow(safeWidth));
    lines.push(padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth));
    return lines;
  }

  private renderOptionRow(option: UserQuestionOption, active: boolean, width: number): string {
    const prefix = active ? '→ ' : '  ';
    const body = option.description
      ? `${option.label}  ${active ? option.description : ansi.dim(option.description)}`
      : option.label;
    return formatPickerItemLine(`${prefix}${body}`, width);
  }

  private renderInputRow(width: number): string[] {
    const prefix = this.onInputRow ? '→ ' : '  ';
    const contentWidth = Math.max(1, width - USER_QUESTION_ROW_PREFIX_WIDTH);
    // Focused only while the input row is highlighted: that both shows the block
    // cursor and emits the hardware-cursor marker (#1064) so IME candidate windows
    // anchor to the edited text instead of the terminal bottom.
    this.editor.focused = this.onInputRow;
    if (!this.onInputRow && this.editor.getText().length === 0) {
      return [padLine(`${prefix}${ansi.dim(this.input.placeholder)}`, width)];
    }
    // Drop the editor's own top/bottom border rows; keep just its content lines
    // so the answer reads as one row of the list.
    const editorLines = this.editor.render(contentWidth).slice(1, -1);
    if (editorLines.length === 0) {
      return [padLine(`${prefix}${ansi.dim(this.input.placeholder)}`, width)];
    }
    return editorLines.map((line, index) =>
      padLine(`${index === 0 ? prefix : '  '}${line}`, width),
    );
  }
}

export function modelPickerItems(
  currentModel: string,
  models: readonly string[] | undefined,
): SelectItem[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of [currentModel, ...(models ?? [])]) {
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.map((id) => ({
    value: id,
    label: id,
    ...(id === currentModel ? { description: 'current' } : {}),
  }));
}

/**
 * `/model` items across every ready connection. The value is the choice's index
 * (models can repeat across connections, so no id is unique on its own); the
 * caller maps it back to the {@link ModelChoice}. The description carries the
 * owning connection so identical model ids on different providers are readable.
 */
function modelChoicePickerItems(
  choices: readonly ModelChoice[],
  current: { model: string; connectionSlug: string },
): SelectItem[] {
  return choices.map((choice, index) => {
    const isCurrent =
      choice.model === current.model && choice.connectionSlug === current.connectionSlug;
    const tags = [choice.connectionName || choice.connectionSlug];
    if (isCurrent) tags.push('current');
    else if (choice.isDefaultConnection) tags.push('default');
    return { value: String(index), label: choice.model, description: tags.join(' · ') };
  });
}

/**
 * Case-insensitive substring match for the `/model` search field, against every
 * criterion the issue names: model id, provider label/type, and connection
 * name/slug. `ModelChoice` carries no display name, so the model id is the only
 * model-side match target; a display-name enrichment would slot in here.
 */
function matchesModelChoice(choice: ModelChoice, query: string): boolean {
  if (choice.model.toLowerCase().includes(query)) return true;
  if (choice.connectionName.toLowerCase().includes(query)) return true;
  if (choice.connectionSlug.toLowerCase().includes(query)) return true;
  if (choice.providerType.toLowerCase().includes(query)) return true;
  const providerLabel = PROVIDER_DEFAULTS[choice.providerType]?.label;
  if (providerLabel && providerLabel.toLowerCase().includes(query)) return true;
  return false;
}

export interface ModelSearchOverlayInput {
  choices: readonly ModelChoice[];
  current: { model: string; connectionSlug: string };
  onSelect: (choice: ModelChoice) => void;
  onCancel: () => void;
}

/**
 * One bottom search field + a bounded single-select list, for the cross-
 * connection `/model` picker (issue #1098 seam 2). Mirrors the OnboardingWizard
 * search phase — the same one-field-powers-the-list shape — but stays a focused
 * single-select: it is not a shared base for the setup multi-select. The list is
 * rebuilt in place on every keystroke (SelectList has no setItems), and Esc /
 * Ctrl-C close without rebinding. The `models`-only fallback (minimal hosts,
 * tests) stays on the non-searchable PickerOverlay.
 */
export class ModelSearchOverlay implements Component {
  private readonly searchEditor: Editor;
  private filtered: readonly ModelChoice[];
  private list: SelectList;
  private readonly initialIndex: number;

  constructor(
    private readonly tui: TUI,
    private readonly input: ModelSearchOverlayInput,
  ) {
    this.filtered = [...input.choices];
    this.initialIndex = input.choices.findIndex(
      (choice) =>
        choice.model === input.current.model &&
        choice.connectionSlug === input.current.connectionSlug,
    );
    this.list = this.buildList();
    if (this.initialIndex >= 0) this.list.setSelectedIndex(this.initialIndex);
    this.searchEditor = new Editor(tui, editorTheme(), { paddingX: 0 });
    this.searchEditor.onChange = (text) => this.applyQuery(text);
  }

  private buildList(): SelectList {
    const list = new SelectList(
      modelChoicePickerItems(this.filtered, this.input.current),
      10,
      selectListTheme(),
      { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 48 },
    );
    list.onSelect = (item) => {
      const choice = this.filtered[Number(item.value)];
      if (!choice) return;
      this.input.onSelect(choice);
    };
    list.onCancel = () => this.input.onCancel();
    return list;
  }

  private applyQuery(text: string): void {
    const query = text.trim().toLowerCase();
    const next = query
      ? this.input.choices.filter((choice) => matchesModelChoice(choice, query))
      : this.input.choices;
    if (next === this.filtered) return;
    this.filtered = next;
    this.list = this.buildList();
  }

  invalidate(): void {
    this.searchEditor.invalidate();
    this.list.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.input.onCancel();
      return;
    }
    // Arrows and Enter drive the list; everything else is typed into the search
    // field (mirrors the OnboardingWizard search phase).
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.list.handleInput(data);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      if (isKeyRepeat(data)) return;
      this.list.handleInput(data);
      return;
    }
    this.searchEditor.handleInput(data);
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    this.searchEditor.focused = true;
    return [
      padLine(`Select Model ${ansi.accent(String(this.filtered.length))}`, safeWidth),
      padLine(ansi.dim('搜索模型 / 服务商 / 连接 · ↑↓ 选择 · Enter 确认 · Esc 取消'), safeWidth),
      padLine('', safeWidth),
      ...this.renderFieldRow(this.searchEditor, '搜索', safeWidth),
      padLine('', safeWidth),
      ...(this.filtered.length === 0
        ? [padLine(ansi.dim('没有匹配的模型'), safeWidth)]
        : this.list.render(safeWidth).map((line) => formatPickerItemLine(line, safeWidth))),
      padLine(ansi.accent('-'.repeat(safeWidth)), safeWidth),
    ];
  }

  private renderFieldRow(editor: Editor, label: string, width: number): string[] {
    const prefix = `${label} `;
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(1, width - prefixWidth);
    const editorLines = editor.render(contentWidth).slice(1, -1);
    if (editorLines.length === 0) {
      return [padLine(prefix, width)];
    }
    return editorLines.map((line, index) =>
      padLine(`${index === 0 ? prefix : ' '.repeat(prefixWidth)}${line}`, width),
    );
  }
}

/**
 * #1611: `current` marks an option that is genuinely in force, so choosing it
 * is a no-op. A read-only session is neither of these options, and marking
 * Auto as current there turned "confirm what I already have" into a silent
 * widening of the boundary. Legacy `execute` has no boundary of its own and
 * really does resolve to Auto, so it still marks Auto.
 */
export function permissionModePickerItems(currentMode: PermissionMode): SelectItem[] {
  const autoIsCurrent = currentMode === 'ask' || currentMode === 'execute';
  return [
    {
      value: 'auto',
      label: 'Auto',
      description: autoIsCurrent ? 'current · protected' : 'protected',
    },
    {
      value: 'bypass',
      label: 'Full access',
      description:
        currentMode === 'bypass'
          ? 'current · your files and network, unprotected'
          : 'your files and network, unprotected',
    },
  ];
}

/**
 * `/skill` picker items (issue #1148). The value is the skill id (that's what
 * the inserted `/skill:<id>` token resolves by); the description carries the
 * id too, since CJK display names alone don't tell the user what to type.
 */
export function skillPickerItems(skills: readonly InvocableSkillEntry[]): SelectItem[] {
  return skills.map((skill) => ({
    value: skill.id,
    label: skill.name,
    description: skill.description ? `${skill.id} · ${skill.description}` : skill.id,
  }));
}

/** Provider search items for `/setup`, marking connections that already exist
 *  `已设置` so a re-onboard reads as edit/rotate rather than create. */
export function onboardingProviderPickerItems(
  providers: readonly OnboardingProviderEntry[],
): SelectItem[] {
  return providers.map((provider) => ({
    value: provider.providerType,
    label: provider.label,
    description: provider.hasConnection
      ? `${provider.providerType} · 已设置`
      : provider.providerType,
  }));
}

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: '关',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

export function thinkingLevelPickerItems(
  levels: readonly ThinkingLevel[],
  current: ThinkingLevel | undefined,
): SelectItem[] {
  return [
    {
      value: 'default',
      label: '默认',
      ...(current === undefined ? { description: 'current' } : {}),
    },
    ...levels.map((level) => ({
      value: level,
      label: THINKING_LEVEL_LABELS[level],
      ...(level === current ? { description: 'current' } : {}),
    })),
  ];
}

function formatPickerItemLine(line: string, width: number): string {
  const padded = padLine(line, width);
  return stripAnsi(line).startsWith('→ ') ? ansi.reverse(padded) : padded;
}

function padLine(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const trimmed = visibleWidth(text) > safeWidth ? truncateToWidth(text, safeWidth, '') : text;
  return `${trimmed}${' '.repeat(Math.max(0, safeWidth - visibleWidth(trimmed)))}`;
}

export type OnboardingWizardPhase = 'search' | 'key' | 'models' | 'success';

export type OnboardingWizardStatus =
  | { kind: 'prompt' }
  | { kind: 'verifying' }
  | { kind: 'error'; text: string }
  | { kind: 'saving' };

export interface OnboardingWizardInput {
  providers: readonly OnboardingProviderEntry[];
  /** search→key: the user picked a provider. The runner records it for verify/save. */
  onPickProvider: (providerType: ProviderType) => void;
  /** key submit. The value may be empty — an existing connection reuses the stored
   *   secret, while a new required-key provider is rejected by verify. */
  onSubmitKey: (apiKey: string) => void;
  /** models submit: save the curated enabled set (≥1 model). */
  onSubmitModels: (enabledModelIds: readonly string[]) => void;
  /** search Esc / Ctrl+C: close (first-run closes the TUI). */
  onCancel: () => void;
  /** key Esc → search; models Esc → key. The runner invalidates in-flight work. */
  onBack: () => void;
  /** success Enter/Esc: close. */
  onClose: () => void;
}

const ONBOARDING_MODELS_MAX_VISIBLE = 10;

/**
 * One input field, four phases. The same overlay is the provider search, the
 * API-key field, the searchable model multi-select, and the in-frame success —
 * so onboarding never pushes its prompt/verifying/failure/saving/success notices
 * into the transcript. Status lives in a single status line beside the field
 * instead of the top entry flow (#1098 UX). `Esc` always moves back exactly one
 * level (models → key → provider → close); late async results are ignored after
 * back/close/retry because the runner bumps its attempt id on every transition.
 */
export class OnboardingWizard implements Component {
  private phase: OnboardingWizardPhase = 'search';
  private picked: OnboardingProviderEntry | undefined;
  private status: OnboardingWizardStatus = { kind: 'prompt' };
  private readonly searchEditor: Editor;
  private readonly keyEditor: Editor;
  private readonly modelsSearchEditor: Editor;
  private filtered: readonly OnboardingProviderEntry[];
  private list: SelectList;
  // Models phase state. Selection seeds from the picked provider's enabled set
  // on first verify; a re-verify preserves the user's toggles (stale ids drop).
  private models: ModelInfo[] = [];
  private filteredModels: ModelInfo[] = [];
  private selectedIds: Set<string> = new Set();
  private modelsInitialized = false;
  private modelHighlight = 0;
  private modelScroll = 0;
  private successCount = 0;

  constructor(
    private readonly tui: TUI,
    private readonly input: OnboardingWizardInput,
  ) {
    this.filtered = input.providers;
    this.list = this.buildList();
    this.searchEditor = new Editor(tui, editorTheme(), { paddingX: 0 });
    // editor.onChange fires on every keystroke: refilter the provider list in
    // place. SelectList has no setItems, so rebuild it; the next render picks
    // the new instance up.
    this.searchEditor.onChange = (text) => this.applyQuery(text);
    this.keyEditor = new Editor(tui, editorTheme(), { paddingX: 0 });
    // Allow a blank submit: an existing connection reuses the stored secret; the
    // host's verify rejects a blank key for a new required-key provider.
    this.keyEditor.onSubmit = (value) => {
      if (this.picked) this.input.onSubmitKey(value);
    };
    this.modelsSearchEditor = new Editor(tui, editorTheme(), { paddingX: 0 });
    this.modelsSearchEditor.onChange = (text) => this.applyModelQuery(text);
  }

  private buildList(): SelectList {
    const list = new SelectList(
      onboardingProviderPickerItems(this.filtered),
      10,
      selectListTheme(),
      { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 32 },
    );
    list.onSelect = (item) => {
      const provider = this.filtered.find((p) => p.providerType === item.value);
      if (!provider) return;
      this.enterKeyPhase(provider);
    };
    return list;
  }

  private enterKeyPhase(provider: OnboardingProviderEntry): void {
    this.picked = provider;
    this.phase = 'key';
    this.status = { kind: 'prompt' };
    this.keyEditor.setText('');
    this.keyEditor.disableSubmit = false;
    this.searchEditor.setText('');
    // Reset the models phase for the new provider; selection seeds on first verify.
    this.models = [];
    this.filteredModels = [];
    this.selectedIds = new Set();
    this.modelsInitialized = false;
    this.modelHighlight = 0;
    this.modelScroll = 0;
    this.modelsSearchEditor.setText('');
    this.input.onPickProvider(provider.providerType);
  }

  private applyQuery(text: string): void {
    const query = text.trim().toLowerCase();
    const next = query
      ? this.input.providers.filter(
          (p) =>
            p.label.toLowerCase().includes(query) || p.providerType.toLowerCase().includes(query),
        )
      : this.input.providers;
    if (next === this.filtered) return;
    this.filtered = next;
    this.list = this.buildList();
  }

  private applyModelQuery(text: string): void {
    const query = text.trim().toLowerCase();
    this.filteredModels = query
      ? this.models.filter(
          (m) =>
            m.id.toLowerCase().includes(query) ||
            (m.displayName ?? '').toLowerCase().includes(query),
        )
      : this.models;
    this.modelHighlight = 0;
    this.modelScroll = 0;
  }

  /** Runner hook: verify is in flight. Lock the key field and show progress. */
  setVerifying(): void {
    if (this.phase !== 'key') return;
    this.status = { kind: 'verifying' };
    this.keyEditor.disableSubmit = true;
  }

  /** Runner hook: verify failed — re-arm the key field in place. */
  setKeyError(text: string): void {
    if (this.phase !== 'key') return;
    this.status = { kind: 'error', text };
    this.keyEditor.disableSubmit = false;
    this.keyEditor.setText('');
  }

  /** Runner hook: verify succeeded — advance to the models step with fresh
   *  discovered models. Selection seeds from the picked provider's enabled set
   *  on first entry (existing connections preserve it; new ones start empty);
   *  a re-verify preserves the user's toggles, dropping ids no longer discovered. */
  setModels(models: ModelInfo[]): void {
    if (this.phase !== 'key') return;
    this.models = models;
    if (!this.modelsInitialized) {
      this.selectedIds = new Set(
        (this.picked?.enabledModelIds ?? []).filter((id) => models.some((m) => m.id === id)),
      );
      this.modelsInitialized = true;
    } else {
      for (const id of [...this.selectedIds]) {
        if (!models.some((m) => m.id === id)) this.selectedIds.delete(id);
      }
    }
    this.applyModelQuery(this.modelsSearchEditor.getText());
    this.phase = 'models';
    this.status = { kind: 'prompt' };
  }

  /** Runner hook: save is in flight. */
  setSaving(): void {
    if (this.phase !== 'models') return;
    this.status = { kind: 'saving' };
  }

  /** Runner hook: save failed — stay in the models step with an error. */
  setModelError(text: string): void {
    if (this.phase !== 'models') return;
    this.status = { kind: 'error', text };
  }

  /** Runner hook: save succeeded — show the enabled-model count in-frame. */
  setSuccess(enabledCount: number): void {
    this.phase = 'success';
    this.successCount = enabledCount;
    this.status = { kind: 'prompt' };
  }

  invalidate(): void {
    this.searchEditor.invalidate();
    this.keyEditor.invalidate();
    this.modelsSearchEditor.invalidate();
    this.list.invalidate();
  }

  handleInput(data: string): void {
    switch (this.phase) {
      case 'search':
        return this.handleSearchInput(data);
      case 'key':
        return this.handleKeyInput(data);
      case 'models':
        return this.handleModelsInput(data);
      case 'success':
        return this.handleSuccessInput(data);
    }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
      this.input.onCancel();
      return;
    }
    // Arrows and Enter drive the list (selecting a provider); everything else
    // is typed into the search field. The search editor therefore never owns
    // history navigation during the wizard.
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.list.handleInput(data);
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      if (isKeyRepeat(data)) return;
      this.list.handleInput(data);
      return;
    }
    this.searchEditor.handleInput(data);
  }

  private handleKeyInput(data: string): void {
    // Ctrl+C cancels the whole wizard (the overlay cancel contract binds both
    // keys); Esc only returns to the provider search. Both fire while a probe
    // is in flight, matching pi-tui `tui.select.cancel = [escape, ctrl+c]`.
    if (matchesKey(data, Key.ctrl('c'))) {
      this.input.onCancel();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.phase = 'search';
      this.picked = undefined;
      this.status = { kind: 'prompt' };
      this.keyEditor.setText('');
      this.keyEditor.disableSubmit = false;
      this.input.onBack();
      return;
    }
    // The probe owns the key field while it is in flight: disableSubmit only
    // blocks Enter, so swallow the rest too — otherwise typed text renders and
    // is then silently wiped by the error path's setText('').
    if (this.status.kind === 'verifying') return;
    this.keyEditor.handleInput(data);
  }

  private handleModelsInput(data: string): void {
    if (matchesKey(data, Key.ctrl('c'))) {
      this.input.onCancel();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      // models → key (one level back); query/selection state survives.
      this.phase = 'key';
      this.status = { kind: 'prompt' };
      this.keyEditor.setText('');
      this.keyEditor.disableSubmit = false;
      this.input.onBack();
      return;
    }
    if (this.status.kind === 'saving') return;
    if (matchesKey(data, Key.up)) {
      this.moveModelHighlight(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveModelHighlight(1);
      return;
    }
    // Space toggles the highlighted model instead of entering the search query —
    // model ids never contain spaces, so the search field does not need it.
    if (matchesKey(data, Key.space)) {
      this.toggleHighlightedModel();
      return;
    }
    if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
      if (isKeyRepeat(data)) return;
      if (this.selectedIds.size === 0) {
        this.status = { kind: 'error', text: '至少选择一个模型再保存' };
        return;
      }
      this.input.onSubmitModels([...this.selectedIds]);
      return;
    }
    // Everything else (arrows, backspace, paste, printable text) goes to the
    // search editor — it owns editing semantics; the wizard only intercepts the
    // keys the list owns (Esc/Ctrl+C/up/down/Space/Enter). Mirrors handleSearchInput.
    this.modelsSearchEditor.handleInput(data);
  }

  private handleSuccessInput(data: string): void {
    if (
      matchesKey(data, Key.enter) ||
      matchesKey(data, Key.return) ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl('c'))
    ) {
      if (matchesKey(data, Key.enter) && isKeyRepeat(data)) return;
      this.input.onClose();
    }
  }

  private moveModelHighlight(delta: number): void {
    const count = this.filteredModels.length;
    if (count === 0) return;
    this.modelHighlight = (this.modelHighlight + delta + count) % count;
    // Keep the highlight inside the visible window.
    if (this.modelHighlight < this.modelScroll) this.modelScroll = this.modelHighlight;
    else if (this.modelHighlight >= this.modelScroll + ONBOARDING_MODELS_MAX_VISIBLE) {
      this.modelScroll = this.modelHighlight - ONBOARDING_MODELS_MAX_VISIBLE + 1;
    }
  }

  private toggleHighlightedModel(): void {
    const model = this.filteredModels[this.modelHighlight];
    if (!model) return;
    if (this.selectedIds.has(model.id)) this.selectedIds.delete(model.id);
    else this.selectedIds.add(model.id);
    // Clear a stale "至少选择一个模型" error once a selection exists.
    if (this.status.kind === 'error' && this.selectedIds.size > 0) {
      this.status = { kind: 'prompt' };
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    switch (this.phase) {
      case 'search':
        return this.renderSearch(safeWidth);
      case 'key':
        return this.renderKey(safeWidth);
      case 'models':
        return this.renderModels(safeWidth);
      case 'success':
        return this.renderSuccess(safeWidth);
    }
  }

  private renderSearch(width: number): string[] {
    this.searchEditor.focused = true;
    this.keyEditor.focused = false;
    this.modelsSearchEditor.focused = false;
    return [
      padLine(
        `Set Up Provider ${ansi.dim('· 1/3')} ${ansi.accent(String(this.filtered.length))}`,
        width,
      ),
      padLine(ansi.dim('搜索服务商，↑↓ 选择 · Enter 确认 · Esc 取消'), width),
      padLine('', width),
      ...this.renderFieldRow(this.searchEditor, '搜索', width),
      padLine('', width),
      ...(this.filtered.length === 0
        ? [padLine(ansi.dim('没有匹配的服务商'), width)]
        : this.list.render(width).map((line) => formatPickerItemLine(line, width))),
      padLine(ansi.accent('-'.repeat(width)), width),
    ];
  }

  private renderKey(width: number): string[] {
    this.searchEditor.focused = false;
    this.keyEditor.focused = this.status.kind === 'prompt' || this.status.kind === 'error';
    this.modelsSearchEditor.focused = false;
    const label = this.picked?.label ?? '';
    const hint = this.picked?.hasConnection
      ? '留空复用已保存的 key，或输入新 key 轮换 · Esc 返回选择服务商'
      : '输入 API key · 仅本机存储 · Esc 返回选择服务商';
    return [
      padLine(`Set Up Provider ${ansi.dim('· 2/3')} ${ansi.accent(label)}`, width),
      padLine(ansi.dim(hint), width),
      padLine('', width),
      ...this.renderFieldRow(this.keyEditor, 'API key', width),
      padLine('', width),
      padLine(this.renderKeyStatusLine(), width),
      padLine(ansi.accent('-'.repeat(width)), width),
    ];
  }

  private renderKeyStatusLine(): string {
    switch (this.status.kind) {
      case 'prompt':
        return ansi.dim('Enter 提交');
      case 'verifying':
        return `${ansi.yellow('⠋')} 正在验证 key…`;
      case 'error':
        return ansi.red(`✗ ${this.status.text}`);
      case 'saving':
        return ansi.dim('Enter 提交');
    }
  }

  private renderModels(width: number): string[] {
    this.searchEditor.focused = false;
    this.keyEditor.focused = false;
    this.modelsSearchEditor.focused = this.status.kind !== 'saving';
    const label = this.picked?.label ?? '';
    const lines = [
      padLine(`Set Up Provider ${ansi.dim('· 3/3')} ${ansi.accent(label)}`, width),
      padLine(ansi.dim('搜索模型，↑↓ 选择 · Space 切换 · Enter 保存 · Esc 返回'), width),
      padLine('', width),
      ...this.renderFieldRow(this.modelsSearchEditor, '搜索', width),
      padLine('', width),
    ];
    if (this.filteredModels.length === 0) {
      lines.push(padLine(ansi.dim('没有匹配的模型'), width));
    } else {
      const end = Math.min(
        this.modelScroll + ONBOARDING_MODELS_MAX_VISIBLE,
        this.filteredModels.length,
      );
      for (let i = this.modelScroll; i < end; i++) {
        const model = this.filteredModels[i]!;
        const highlighted = i === this.modelHighlight;
        const mark = this.selectedIds.has(model.id) ? '☑' : '☐';
        const body = model.displayName ? `${model.displayName} ${ansi.dim(model.id)}` : model.id;
        lines.push(formatPickerItemLine(`${highlighted ? '→ ' : '  '}${mark} ${body}`, width));
      }
    }
    lines.push(padLine('', width));
    lines.push(padLine(this.renderModelsStatusLine(), width));
    lines.push(padLine(ansi.accent('-'.repeat(width)), width));
    return lines;
  }

  private renderModelsStatusLine(): string {
    switch (this.status.kind) {
      case 'prompt':
        return ansi.dim(`已选 ${this.selectedIds.size} · Enter 保存`);
      case 'verifying':
        return ansi.dim(`已选 ${this.selectedIds.size}`);
      case 'saving':
        return `${ansi.yellow('⠋')} 正在保存…`;
      case 'error':
        return ansi.red(`✗ ${this.status.text}`);
    }
  }

  private renderSuccess(width: number): string[] {
    this.searchEditor.focused = false;
    this.keyEditor.focused = false;
    this.modelsSearchEditor.focused = false;
    const label = this.picked?.label ?? '';
    return [
      padLine(`Set Up Provider ${ansi.dim('· 完成')} ${ansi.accent(label)}`, width),
      padLine(ansi.green(`✓ 已启用 ${this.successCount} 个模型`), width),
      padLine('', width),
      padLine(ansi.dim('Enter 关闭'), width),
      padLine(ansi.accent('-'.repeat(width)), width),
    ];
  }

  private renderFieldRow(editor: Editor, label: string, width: number): string[] {
    const prefix = `${label} `;
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(1, width - prefixWidth);
    const editorLines = editor.render(contentWidth).slice(1, -1);
    if (editorLines.length === 0) {
      return [padLine(prefix, width)];
    }
    return editorLines.map((line, index) =>
      padLine(`${index === 0 ? prefix : ' '.repeat(prefixWidth)}${line}`, width),
    );
  }
}
