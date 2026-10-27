//! The editor's controller: the state, the revisions bindings subscribe
//! to, and what keys, typing, presses, props and the ref do to them.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use nsh_core::{element::Os, keymap::When, prelude::*};

use super::{
    EditorCommand, EditorContextMenuEvent, EditorEvent, EditorFoldRange, EditorProps,
    EditorSelection,
    commands::{Case, Command, EditOptions, Outcome},
    diagnostics,
    fold::FoldRange,
    highlight::{GUESS_CONTEXT, GUESS_DISTANCE, Highlighter, LOOKAHEAD, SLICE, off_thread},
    keymap,
    layout::{self, AutoScroll},
    search,
    select::{ExpandStack, SelectionHistory},
    state::{Font, State},
    types::{Selection, Selections},
};

/// The sink is emptied once it holds this many bytes (and no composition
/// is in progress).
const SINK_LIMIT: usize = 256;

/// A press being dragged: where it started and what it selects by.
#[derive(Debug, Clone, Copy)]
struct Drag {
    /// The selection the press made (a word or a line for double and
    /// triple presses), which the drag extends from.
    origin: Selection,
    /// 1: characters, 2: words, 3: lines.
    clicks: u32,
    /// The press in the rows' box less the press in the root view: what
    /// turns the pointer's root position into the rows' while it drags.
    shift: Point<Points>,
    /// The scroll offsets at the press (the rows move under the pointer as
    /// they scroll).
    scroll: Point<Points>,
    /// Where an Alt+Shift press was in the rows' box: the drag makes a block
    /// selection from there.
    block: Option<Point<Points>>,
}

/// What the native input that takes typed text holds.
#[derive(Debug, Default)]
struct Sink {
    /// The text it holds, as last reported.
    text: String,
    /// What it held before the editor emptied it, until the platform shows
    /// it took the empty value (a change that does not extend this text).
    emptied: Option<String>,
    /// An input method is composing.
    composing: bool,
}

/// The editor's controller. Cloned into the closures that need it.
#[derive(Clone)]
pub(crate) struct Ed {
    pub(crate) st: Rc<RefCell<State>>,
    pub(crate) props: EditorProps,
    pub(crate) cx: Scope<EditorEvent>,
    /// The text or its layout changed: rows' content and positions.
    pub(crate) text_rev: Signal<u64>,
    /// Highlighting progressed (tokens of rows changed).
    pub(crate) hl_rev: Signal<u64>,
    /// The selections changed.
    pub(crate) sel_rev: Signal<u64>,
    /// Diagnostics, decorations or search matches changed.
    pub(crate) marks_rev: Signal<u64>,
    /// The vertical scroll view's offset.
    pub(crate) scroll_y: Signal<Points>,
    /// The horizontal scroll view's offset.
    pub(crate) scroll_x: Signal<Points>,
    /// The vertical scroll view's size.
    pub(crate) viewport: Signal<Size<Points>>,
    /// The width the text area shows (wrapping and horizontal scrolling).
    pub(crate) text_width: Signal<Points>,
    /// Where the rows' box is in the vertical scroll view's content.
    pub(crate) rows_top: Signal<Points>,
    /// The editor has the keyboard focus.
    pub(crate) focused: Signal<bool>,
    /// The carets show (they blink while the editor has the focus).
    pub(crate) blink: Signal<bool>,
    /// What the sink input holds (its controlled value).
    pub(crate) sink_value: Signal<String>,
    sink: Rc<RefCell<Sink>>,
    drag: Rc<Cell<Option<Drag>>>,
    /// The last text copied from carets (whole lines), to paste it as
    /// lines again.
    line_copy: Rc<RefCell<Option<String>>>,
    /// Whether a highlighting pass is scheduled.
    highlighting: Rc<Cell<bool>>,
    pub(crate) vscroll: ElementRef,
    pub(crate) hscroll: ElementRef,
    pub(crate) input: ElementRef,
    blink_task: Rc<RefCell<Option<Spawned<()>>>>,
    /// What language features are built on (`hooks.rs`).
    pub(crate) hooks: super::hooks::Hooks,
    /// The selections moves left, for `undoSelection`.
    pub(crate) sel_history: Rc<RefCell<SelectionHistory>>,
    /// What `expandSelection` grew from, for `shrinkSelection`.
    pub(crate) expansions: Rc<RefCell<ExpandStack>>,
    /// Where the rows' box starts in the text area (the content's padding):
    /// what turns an x of the rows into the horizontal scroll view's.
    pub(crate) rows_left: Signal<Points>,
    /// The height of the vertical scroll view's content.
    pub(crate) content_height: Signal<Points>,
    /// Scrolling while a drag selects past the viewport's edge.
    autoscroll: Rc<RefCell<AutoScroll>>,
    /// The selection a touch made, its handles and their drag.
    pub(crate) touch: super::touch::Touch,
    /// The rows made last.
    rows_window: crate::window::RowWindow,
    /// Completion: the session, the list, inline completion.
    pub(crate) completion: super::completion::Completion,
    /// The definition link: the hover request out, the range underlined.
    pub(crate) definition: super::definition::Definition,
}

impl Ed {
    pub(crate) fn new(props: EditorProps, cx: Scope<EditorEvent>) -> Ed {
        let font = Font {
            family: font_family(props.font_family.get_untracked()),
            size: props.font_size.get_untracked(),
            line_height: props.line_height.get_untracked(),
        };
        let measure = measurer(&font);
        let text = props
            .value
            .get_untracked()
            .or_else(|| props.default_value.get_untracked())
            .unwrap_or_default();
        let name = props.language.get_untracked();
        let (language, syntax) =
            untracked(|| super::languages::resolve(name.as_deref().unwrap_or("")));
        let options = options_of(&props, language);
        let mut state = State::new(&text, language, options, font, measure);
        state.set_language(language, syntax);
        state.reported = Some((state.buffer.version(), text));
        let sel_history = SelectionHistory::new(&state.selections);
        let ed = Ed {
            st: Rc::new(RefCell::new(state)),
            props,
            cx,
            text_rev: signal(0),
            hl_rev: signal(0),
            sel_rev: signal(0),
            marks_rev: signal(0),
            scroll_y: signal(px(0.0)),
            scroll_x: signal(px(0.0)),
            viewport: signal(Size::default()),
            text_width: signal(px(0.0)),
            rows_top: signal(px(0.0)),
            focused: signal(false),
            blink: signal(true),
            sink_value: signal(String::new()),
            sink: Rc::default(),
            drag: Rc::default(),
            line_copy: Rc::default(),
            highlighting: Rc::default(),
            vscroll: element_ref(),
            hscroll: element_ref(),
            input: element_ref(),
            blink_task: Rc::default(),
            hooks: super::hooks::Hooks::new(),
            sel_history: Rc::new(RefCell::new(sel_history)),
            expansions: Rc::default(),
            rows_left: signal(px(0.0)),
            content_height: signal(px(0.0)),
            autoscroll: Rc::default(),
            touch: super::touch::Touch::new(),
            rows_window: Default::default(),
            completion: super::completion::Completion::new(),
            definition: super::definition::Definition::new(),
        };
        ed.follow_props();
        ed.follow_hooks();
        ed.follow_completion();
        ed.follow_definition();
        ed.bind_keys();
        ed.load_syntaxes();
        ed
    }

    // Props.

    /// Effects carrying the props into the state, each read on its own so a
    /// prop's change does only its own work.
    fn follow_props(&self) {
        let ed = self.clone();
        effect(move || {
            let value = ed.props.value.get();
            if let Some(value) = value {
                ed.take_value(&value);
            }
        });
        let ed = self.clone();
        effect(move || {
            let name = ed.props.language.get();
            // The engine's languages too: a registration since finds the
            // language again.
            let (language, syntax) = super::languages::resolve(name.as_deref().unwrap_or(""));
            let changed = {
                let mut st = ed.st.borrow_mut();
                let changed = !std::ptr::eq(st.language, language) || !st.syntax.same(&syntax);
                st.set_language(language, syntax);
                st.options = options_of(&ed.props, language);
                changed
            };
            if changed {
                ed.load_syntaxes();
                ed.bump_text();
                ed.schedule_highlight();
            }
        });
        let ed = self.clone();
        effect(move || {
            // Every option that is not the text's.
            let _ = (
                ed.props.read_only.get(),
                ed.props.tab_size.get(),
                ed.props.hard_tabs.get(),
                ed.props.auto_close.get(),
                ed.props.auto_indent.get(),
            );
            let mut st = ed.st.borrow_mut();
            let options = options_of(&ed.props, st.language);
            let relayout = options.tab_size != st.options.tab_size;
            st.options = options;
            if relayout {
                let tab = st.options.tab_size;
                st.display.set_tab_size(tab);
                st.relayout();
                drop(st);
                ed.bump_text();
            }
        });
        let ed = self.clone();
        effect(move || {
            let folding = ed.props.folding.get();
            let mut st = ed.st.borrow_mut();
            if st.folding != folding {
                st.folding = folding;
                // Also forgets where folds could start while it was off.
                st.clear_folds();
                if !folding {
                    st.relayout();
                }
                drop(st);
                ed.bump_text();
                ed.report_folds();
            }
        });
        let ed = self.clone();
        effect(move || {
            let on = ed.props.highlighting.get();
            let changed = {
                let mut st = ed.st.borrow_mut();
                let changed = st.highlighting != on;
                st.highlighting = on;
                if changed && !on {
                    st.highlighter = None;
                }
                changed
            };
            if changed {
                if on {
                    ed.load_syntaxes();
                }
                ed.hl_rev.update(|r| *r += 1);
            }
        });
        let ed = self.clone();
        effect(move || {
            let ranges = ed.props.fold_ranges.get();
            ed.st
                .borrow_mut()
                .set_app_folds(ranges.map(|ranges| ranges.iter().map(fold_range).collect()));
            // The gutter's markers.
            ed.bump_text();
        });
        let ed = self.clone();
        effect(move || {
            let font = Font {
                family: font_family(ed.props.font_family.get()),
                size: ed.props.font_size.get(),
                line_height: ed.props.line_height.get(),
            };
            let mut st = ed.st.borrow_mut();
            if st.font != font {
                st.display.set_measure(measurer(&font));
                st.font = font;
                st.relayout();
                drop(st);
                ed.bump_text();
            }
        });
        let ed = self.clone();
        effect(move || {
            let wrap = ed.props.soft_wrap.get();
            let width = ed.text_width.get();
            let mut st = ed.st.borrow_mut();
            let st = &mut *st;
            let wrap_width = (wrap && width.0 > 0.0).then_some(width);
            st.display.set_wrap_width(wrap_width);
            st.display.rebuild(&st.buffer);
            ed.bump_text();
        });
        let ed = self.clone();
        effect(move || {
            let search = ed.props.search.get();
            let result = {
                let mut st = ed.st.borrow_mut();
                st.set_search(search);
                st.search_result()
            };
            ed.marks_rev.update(|r| *r += 1);
            ed.cx.emit(EditorEvent::SearchChange(result));
        });
        let ed = self.clone();
        effect(move || {
            let items = ed.props.diagnostics.get();
            {
                let mut st = ed.st.borrow_mut();
                let marks = diagnostics::resolve(&st.buffer, &items, |d| d.range);
                st.set_diagnostics(marks);
            }
            ed.marks_rev.update(|r| *r += 1);
        });
        let ed = self.clone();
        effect(move || {
            let items = ed.props.decorations.get();
            {
                let mut st = ed.st.borrow_mut();
                let indexes: Vec<usize> = (0..items.len()).collect();
                let marks = diagnostics::resolve(&st.buffer, &indexes, |i| items[*i].range);
                st.set_decorations(marks, items);
            }
            ed.marks_rev.update(|r| *r += 1);
            ed.bump_text();
        });
        let ed = self.clone();
        effect(move || {
            if ed.props.auto_focus.get() {
                ed.focus();
            }
        });
    }

    /// The app's `value`: taken as an edit unless it is the text already
    /// (the app passing back what `onChange` reported).
    fn take_value(&self, value: &str) {
        let changes = {
            let mut st = self.st.borrow_mut();
            let version = st.buffer.version();
            if st
                .reported
                .as_ref()
                .is_some_and(|(v, text)| *v == version && text.as_ref() == value)
            {
                return;
            }
            let before = st.selections.clone();
            let changes = st.buffer.set_text(value, &before, &before);
            st.changed(&changes);
            st.reported = Some((st.buffer.version(), value.to_owned().into()));
            changes
        };
        if !changes.is_empty() {
            self.bump_text();
            self.bump_selection();
            self.schedule_highlight();
        }
    }

    // Revisions.

    pub(crate) fn bump_text(&self) {
        self.text_rev.update(|r| *r += 1);
    }

    pub(crate) fn bump_selection(&self) {
        self.sel_rev.update(|r| *r += 1);
    }

    // Keys.

    /// The editor's keys, bound while it has the focus (they would take
    /// arrows and Tab from every other input otherwise).
    fn bind_keys(&self) {
        let ed = self.clone();
        effect(move || {
            if !ed.focused.get() {
                return;
            }
            let apple = matches!(os(), Os::Ios | Os::MacOs);
            for binding in keymap::default_bindings(apple) {
                let e = ed.clone();
                let command = binding.command;
                on_key_with(
                    binding.keys,
                    KeyOptions {
                        when: When::Always,
                        repeat: binding.repeat,
                    },
                    move |_| e.run(command),
                );
            }
            for binding in keymap::editor_bindings(apple) {
                let e = ed.clone();
                let command = binding.command;
                on_key_with(binding.keys, always(binding.repeat), move |_| {
                    e.run_public(command)
                });
            }
            let e = ed.clone();
            on_key_with("mod+c", always(false), move |_| e.copy());
            let e = ed.clone();
            on_key_with("mod+x", always(false), move |_| e.cut());
        });
    }

    // Running commands.

    /// Runs `command` at the selections.
    pub(crate) fn run(&self, command: Command) {
        let outcome = {
            let mut st = self.st.borrow_mut();
            let page = st.page_rows(self.viewport.get_untracked().height);
            st.editing(page, |e| e.run(command))
        };
        self.after(outcome);
    }

    /// What follows a command: the state brought up to date, the view
    /// told, the app told, the caret shown.
    pub(crate) fn after(&self, outcome: Outcome) {
        match outcome {
            Outcome::Nothing => {}
            Outcome::Moved => {
                {
                    let mut st = self.st.borrow_mut();
                    st.buffer.break_undo_group();
                    let head = st.primary_head();
                    st.reveal(head);
                    self.sel_history.borrow_mut().record(&st.selections);
                }
                self.empty_sink();
                self.bump_text_if_folds_changed();
                self.bump_selection();
                self.report_selections();
                self.report_search_position();
                self.report_folds();
                self.show_caret();
                self.completion_moved();
            }
            Outcome::Edited(changes) => {
                {
                    let mut st = self.st.borrow_mut();
                    st.changed(&changes);
                    let head = st.primary_head();
                    st.reveal(head);
                    self.sel_history.borrow_mut().reset(&st.selections);
                }
                self.bump_text();
                self.bump_selection();
                self.marks_rev.update(|r| *r += 1);
                self.report_text();
                self.report_selections();
                self.report_search();
                self.report_folds();
                self.schedule_highlight();
                self.show_caret();
                self.completion_edited(&changes);
            }
        }
        self.restart_blink();
    }

    fn bump_text_if_folds_changed(&self) {
        // Revealing a caret may unfold: the rows changed then.
        self.bump_text();
    }

    /// Runs a public command.
    pub(crate) fn run_public(&self, command: EditorCommand) {
        use EditorCommand as E;
        let c = |c: Command| Some(c);
        let command = match command {
            E::MoveLeft => c(Command::Left { select: false }),
            E::MoveRight => c(Command::Right { select: false }),
            E::MoveUp => c(Command::Up { select: false }),
            E::MoveDown => c(Command::Down { select: false }),
            E::MoveWordLeft => c(Command::WordLeft { select: false }),
            E::MoveWordRight => c(Command::WordRight { select: false }),
            E::MoveLineStart => c(Command::LineStart { select: false }),
            E::MoveLineEnd => c(Command::LineEnd { select: false }),
            E::MovePageUp => c(Command::PageUp { select: false }),
            E::MovePageDown => c(Command::PageDown { select: false }),
            E::MoveDocumentStart => c(Command::DocumentStart { select: false }),
            E::MoveDocumentEnd => c(Command::DocumentEnd { select: false }),
            E::SelectLeft => c(Command::Left { select: true }),
            E::SelectRight => c(Command::Right { select: true }),
            E::SelectUp => c(Command::Up { select: true }),
            E::SelectDown => c(Command::Down { select: true }),
            E::SelectWordLeft => c(Command::WordLeft { select: true }),
            E::SelectWordRight => c(Command::WordRight { select: true }),
            E::SelectLineStart => c(Command::LineStart { select: true }),
            E::SelectLineEnd => c(Command::LineEnd { select: true }),
            E::SelectPageUp => c(Command::PageUp { select: true }),
            E::SelectPageDown => c(Command::PageDown { select: true }),
            E::SelectDocumentStart => c(Command::DocumentStart { select: true }),
            E::SelectDocumentEnd => c(Command::DocumentEnd { select: true }),
            E::MoveToMatchingBracket => c(Command::MatchingBracket),
            E::SelectAll => c(Command::SelectAll),
            E::SelectLine => c(Command::SelectLine),
            E::SelectWord => c(Command::SelectWord),
            E::SelectNextOccurrence => c(Command::SelectNextOccurrence),
            E::SelectAllOccurrences => c(Command::SelectAllOccurrences),
            E::AddCaretAbove => c(Command::AddCaretAbove),
            E::AddCaretBelow => c(Command::AddCaretBelow),
            E::SingleSelection => c(Command::SingleSelection),
            E::DeleteBackward => c(Command::Backspace),
            E::DeleteForward => c(Command::Delete),
            E::DeleteWordLeft => c(Command::DeleteWordLeft),
            E::DeleteWordRight => c(Command::DeleteWordRight),
            E::DeleteToLineStart => c(Command::DeleteToLineStart),
            E::DeleteToLineEnd => c(Command::DeleteToLineEnd),
            E::DeleteLine => c(Command::DeleteLine),
            E::Newline => c(Command::Newline),
            E::NewlineBelow => c(Command::NewlineBelow),
            E::NewlineAbove => c(Command::NewlineAbove),
            E::Indent => c(Command::Indent),
            E::Outdent => c(Command::Outdent),
            E::ToggleComment => c(Command::ToggleComment),
            E::MoveLinesUp => c(Command::MoveLinesUp),
            E::MoveLinesDown => c(Command::MoveLinesDown),
            E::DuplicateLinesUp => c(Command::DuplicateLinesUp),
            E::DuplicateLinesDown => c(Command::DuplicateLinesDown),
            E::JoinLines => c(Command::JoinLines),
            E::TransposeCharacters => c(Command::TransposeChars),
            E::Undo => c(Command::Undo),
            E::Redo => c(Command::Redo),
            E::Fold => {
                let line = self.primary_line();
                self.fold(line, Some(true));
                None
            }
            E::Unfold => {
                let line = self.primary_line();
                self.fold(line, Some(false));
                None
            }
            E::FoldAll => {
                self.fold_all(true);
                None
            }
            E::UnfoldAll => {
                self.fold_all(false);
                None
            }
            E::FoldRecursive => {
                let line = self.primary_line();
                self.fold_with(|st| st.fold_recursive(line));
                None
            }
            E::UnfoldRecursive => {
                let line = self.primary_line();
                self.fold_with(|st| st.unfold_recursive(line));
                None
            }
            E::FoldSelection => {
                self.fold_with(State::fold_selections);
                None
            }
            E::FindNext => {
                self.find(true);
                None
            }
            E::FindPrevious => {
                self.find(false);
                None
            }
            E::Copy => {
                self.copy();
                None
            }
            E::Cut => {
                self.cut();
                None
            }
            E::Paste => {
                self.paste_clipboard();
                None
            }
            E::SelectPreviousOccurrence => c(Command::SelectPreviousOccurrence),
            E::UndoSelection => {
                self.undo_selection(true);
                None
            }
            E::RedoSelection => {
                self.undo_selection(false);
                None
            }
            E::ExpandSelection => {
                self.expand_selection(true);
                None
            }
            E::ShrinkSelection => {
                self.expand_selection(false);
                None
            }
            E::SplitSelectionIntoLines => c(Command::SplitSelectionIntoLines),
            E::FindWithSelection => {
                self.find_with_selection();
                None
            }
            E::MoveSubwordLeft => c(Command::SubwordLeft { select: false }),
            E::MoveSubwordRight => c(Command::SubwordRight { select: false }),
            E::SelectSubwordLeft => c(Command::SubwordLeft { select: true }),
            E::SelectSubwordRight => c(Command::SubwordRight { select: true }),
            E::MoveParagraphUp => c(Command::ParagraphUp { select: false }),
            E::MoveParagraphDown => c(Command::ParagraphDown { select: false }),
            E::SelectParagraphUp => c(Command::ParagraphUp { select: true }),
            E::SelectParagraphDown => c(Command::ParagraphDown { select: true }),
            E::SortLinesAscending => c(Command::SortLines { descending: false }),
            E::SortLinesDescending => c(Command::SortLines { descending: true }),
            E::TransformToUppercase => c(Command::ChangeCase(Case::Upper)),
            E::TransformToLowercase => c(Command::ChangeCase(Case::Lower)),
            E::TransformToTitleCase => c(Command::ChangeCase(Case::Title)),
            E::TrimTrailingWhitespace => c(Command::TrimTrailingWhitespace),
            E::ToggleBlockComment => c(Command::ToggleBlockComment),
            E::ShowCompletions => {
                self.show_completions();
                None
            }
            E::GoToDefinition => {
                self.go_to_definition();
                None
            }
            E::ShowCodeActions => {
                self.show_code_actions();
                None
            }
        };
        if let Some(command) = command {
            self.run(command);
        }
    }

    fn primary_line(&self) -> usize {
        let st = self.st.borrow();
        st.buffer.line_of(st.primary_head())
    }

    // Typing.

    /// Typed text (the sink's), at every selection.
    pub(crate) fn type_text(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let outcome = {
            let mut st = self.st.borrow_mut();
            st.composition = None;
            st.editing(1, |e| e.insert(text))
        };
        let edited = matches!(outcome, Outcome::Edited(_));
        self.after_typing(outcome);
        if edited {
            self.completion_typed(text);
        }
    }

    /// [`Self::after`] for typing, which keeps the sink as it is (the text
    /// it holds is what was just typed, which an input method may still
    /// replace).
    fn after_typing(&self, outcome: Outcome) {
        if let Outcome::Edited(changes) = outcome {
            {
                let mut st = self.st.borrow_mut();
                st.changed(&changes);
                self.sel_history.borrow_mut().reset(&st.selections);
            }
            self.bump_text();
            self.bump_selection();
            self.marks_rev.update(|r| *r += 1);
            self.report_text();
            self.report_selections();
            self.report_search();
            self.schedule_highlight();
            self.show_caret();
            self.restart_blink();
        }
    }

    /// The sink's text changed to `text`: what was typed (or replaced by an
    /// input method, or autocorrected) at the caret.
    pub(crate) fn sink_changed(&self, text: &str) {
        let (deleted, inserted) = {
            let mut sink = self.sink.borrow_mut();
            let base = match sink.emptied.take() {
                // The platform dropped the empty value: the text still
                // extends what it held.
                Some(old) if text.starts_with(old.as_str()) => old,
                Some(_) => String::new(),
                None => std::mem::take(&mut sink.text),
            };
            let prefix = common_prefix(&base, text);
            let deleted = base[prefix..].chars().count();
            let inserted = text[prefix..].to_owned();
            sink.text = text.to_owned();
            (deleted, inserted)
        };
        self.sink_value.set(text.to_owned());
        for _ in 0..deleted {
            self.run(Command::Backspace);
        }
        if inserted == "\n" {
            self.run(Command::Newline);
        } else if !inserted.is_empty() {
            // A line break typed on a soft keyboard comes as text.
            let mut parts = inserted.split('\n').peekable();
            while let Some(part) = parts.next() {
                self.type_text(part);
                if parts.peek().is_some() {
                    self.run(Command::Newline);
                }
            }
        }
        let long = self.sink.borrow().text.len() > SINK_LIMIT;
        if long {
            self.empty_sink();
        }
    }

    /// Empties the sink (the caret moved away from what it holds), unless
    /// an input method is composing there.
    pub(crate) fn empty_sink(&self) {
        let mut sink = self.sink.borrow_mut();
        if sink.composing || sink.text.is_empty() {
            return;
        }
        sink.emptied = Some(std::mem::take(&mut sink.text));
        drop(sink);
        self.sink_value.set(String::new());
    }

    /// An input method's composition started, changed or ended.
    pub(crate) fn composition(&self, composing: bool, text: &str) {
        self.sink.borrow_mut().composing = composing;
        {
            let mut st = self.st.borrow_mut();
            st.composition = (composing && !text.is_empty()).then(|| text.to_owned());
        }
        self.bump_selection();
    }

    /// A key the sink reports (soft keyboards: Backspace in an empty
    /// sink, which changes nothing there).
    pub(crate) fn sink_key(&self, key: &str) {
        if key == "Backspace" && self.sink.borrow().text.is_empty() {
            self.run(Command::Backspace);
        }
    }

    /// Text the app inserts (`insert`): plain, at every selection.
    pub(crate) fn insert_plain(&self, text: &str) {
        let outcome = {
            let mut st = self.st.borrow_mut();
            let ranges: Vec<_> = st
                .selections
                .all()
                .iter()
                .map(|s| (s.range(), text.to_owned()))
                .collect();
            st.editing(1, |e| e.replace(ranges))
        };
        self.after(outcome);
    }

    // The clipboard.

    pub(crate) fn copy(&self) {
        let (text, line_wise) = {
            let mut st = self.st.borrow_mut();
            st.editing(1, |e| e.copy())
        };
        *self.line_copy.borrow_mut() = line_wise.then(|| text.clone());
        set_clipboard(text);
    }

    pub(crate) fn cut(&self) {
        let (text, line_wise, outcome) = {
            let mut st = self.st.borrow_mut();
            st.editing(1, |e| e.cut())
        };
        *self.line_copy.borrow_mut() = line_wise.then(|| text.clone());
        set_clipboard(text);
        self.after(outcome);
    }

    /// Pastes `text` (what the sink reports a paste of).
    pub(crate) fn paste(&self, text: &str) {
        let line_wise = self.line_copy.borrow().as_deref() == Some(text);
        let outcome = {
            let mut st = self.st.borrow_mut();
            st.editing(1, |e| e.paste(text, line_wise))
        };
        self.after(outcome);
    }

    /// Pastes the clipboard's text (the `paste` command).
    pub(crate) fn paste_clipboard(&self) {
        let ed = self.clone();
        spawn(async move {
            let text = clipboard_string().await;
            ed.paste(&text);
        });
    }

    // Presses.

    /// A press at `at` in the rows' box.
    pub(crate) fn press(
        &self,
        at: Point<Points>,
        page: Point<Points>,
        modifiers: nsh_core::keymap::Modifiers,
        clicks: u32,
    ) {
        self.focus();
        let selection = {
            let mut st = self.st.borrow_mut();
            let offset = st.offset_at(at);
            let word_chars = st.language.word_chars;
            let selection = match clicks {
                2 => {
                    let range = super::movement::word_range(&st.buffer, offset, word_chars);
                    Selection::new(range.start, range.end)
                }
                n if n >= 3 => {
                    let line = st.buffer.line_of(offset);
                    let range = super::movement::lines_range(&st.buffer, line, line);
                    let end = if line + 1 < st.buffer.line_count() {
                        st.buffer.line_start(line + 1)
                    } else {
                        st.buffer.len()
                    };
                    Selection::new(range.start.min(st.buffer.line_start(line)), end)
                }
                _ => Selection::caret(offset),
            };
            let added = modifiers.alt;
            // Alt+Shift drags a block; Linux also takes Control+Alt, as
            // GPUI Kit does, where window managers keep Alt drags.
            let block = modifiers.alt
                && clicks <= 1
                && (modifiers.shift || (modifiers.ctrl && matches!(os(), Os::Linux)));
            if block {
                st.selections = Selections::single(Selection::caret(offset));
            } else if modifiers.shift && clicks <= 1 {
                let primary = st.selections.primary();
                let mut all = st.selections.all().to_vec();
                let index = st.selections.primary_index();
                all[index] = primary.extend_to(offset);
                st.selections = Selections::new(all, index);
            } else if added {
                st.selections.push(selection);
            } else {
                st.selections = Selections::single(selection);
            }
            st.buffer.break_undo_group();
            self.drag.set(Some(Drag {
                origin: if modifiers.shift {
                    st.selections.primary()
                } else {
                    selection
                },
                clicks: clicks.max(1),
                shift: at - page,
                scroll: self.scroll_offset(),
                block: block.then_some(at),
            }));
            st.selections.primary()
        };
        let _ = selection;
        self.after(Outcome::Moved);
    }

    /// The scroll views' offsets.
    pub(crate) fn scroll_offset(&self) -> Point<Points> {
        Point::new(self.scroll_x.get_untracked(), self.scroll_y.get_untracked())
    }

    /// The pointer moved to `page` (in the root view) while pressed.
    pub(crate) fn drag_to(&self, page: Point<Points>) {
        let Some(drag) = self.drag.get() else { return };
        let at = page + drag.shift + (self.scroll_offset() - drag.scroll);
        if let Some(from) = drag.block {
            {
                let mut st = self.st.borrow_mut();
                let block = st.block_selection(from, at);
                st.selections = block;
            }
            self.bump_selection();
            self.report_selections();
            self.show_caret();
            return;
        }
        {
            let mut st = self.st.borrow_mut();
            let offset = st.offset_at(at);
            let word_chars = st.language.word_chars;
            let origin = drag.origin;
            let selection = match drag.clicks {
                1 => origin.extend_to(offset),
                2 => {
                    let word = super::movement::word_range(&st.buffer, offset, word_chars);
                    extend_by(origin, word.start, word.end, offset)
                }
                _ => {
                    let line = st.buffer.line_of(offset);
                    let start = st.buffer.line_start(line);
                    let end = if line + 1 < st.buffer.line_count() {
                        st.buffer.line_start(line + 1)
                    } else {
                        st.buffer.len()
                    };
                    extend_by(origin, start, end, offset)
                }
            };
            let index = st.selections.primary_index();
            let mut all = st.selections.all().to_vec();
            all[index] = selection;
            st.selections = Selections::new(all, index);
        }
        self.bump_selection();
        self.report_selections();
        // Past the viewport's edge the view scrolls on its own, rather than
        // jumping to the caret.
        self.follow_drag_edge(page);
    }

    /// The press ended.
    pub(crate) fn release(&self) {
        self.autoscroll.borrow_mut().stop();
        if self.drag.take().is_some() {
            // What the drag selected is a step `undoSelection` goes back from.
            let st = self.st.borrow();
            self.sel_history.borrow_mut().record(&st.selections);
        }
    }

    /// A secondary press at `at` (in the rows' box), `page` in the root
    /// view.
    pub(crate) fn context_menu(&self, at: Point<Points>, page: Point<Points>) {
        let position = {
            let st = self.st.borrow();
            let offset = st.offset_at(at);
            st.position(offset)
        };
        let event = EditorContextMenuEvent {
            position,
            x: page.x,
            y: page.y,
            ..Default::default()
        };
        self.cx.emit(EditorEvent::ContextMenu(event));
    }

    /// A press on the gutter's row `row`: the number selects its line.
    pub(crate) fn line_number_press(&self, row: usize) {
        let line = {
            let st = self.st.borrow();
            st.display.row(row).line
        };
        self.cx.emit(EditorEvent::LineNumberPress(line as u32));
    }

    // Focus.

    pub(crate) fn focus(&self) {
        self.input.focus();
    }

    pub(crate) fn blur(&self) {
        self.input.blur();
    }

    pub(crate) fn focus_changed(&self, focused: bool) {
        if self.focused.get_untracked() == focused {
            return;
        }
        self.focused.set(focused);
        self.cx.emit(if focused {
            EditorEvent::Focus
        } else {
            EditorEvent::Blur
        });
        if !focused {
            self.drag.set(None);
            self.completion_blurred();
        }
        self.restart_blink();
    }

    /// Shows the carets and blinks them while the editor has the focus.
    fn restart_blink(&self) {
        if let Some(task) = self.blink_task.borrow_mut().take() {
            task.cancel();
        }
        self.blink.set(true);
        if !self.focused.get_untracked() {
            return;
        }
        let blink = self.blink;
        let task = set_interval(Duration::from_millis(530), move || {
            blink.update(|b| *b = !*b);
        });
        *self.blink_task.borrow_mut() = Some(task);
    }

    // The ref's other methods.

    pub(crate) fn text(&self) -> String {
        self.st.borrow().buffer.text()
    }

    pub(crate) fn set_text(&self, text: &str) {
        let changes = {
            let mut st = self.st.borrow_mut();
            let before = st.selections.clone();
            let changes = st.buffer.set_text(text, &before, &before);
            st.changed(&changes);
            changes
        };
        if !changes.is_empty() {
            self.bump_text();
            self.bump_selection();
            self.report_text();
            self.schedule_highlight();
        }
    }

    pub(crate) fn selections(&self) -> Vec<EditorSelection> {
        self.st.borrow().editor_selections()
    }

    pub(crate) fn set_selections(&self, selections: &[EditorSelection]) {
        if selections.is_empty() {
            return;
        }
        self.st.borrow_mut().set_editor_selections(selections);
        self.after(Outcome::Moved);
    }

    pub(crate) fn can_undo(&self) -> bool {
        self.st.borrow().buffer.can_undo()
    }

    pub(crate) fn can_redo(&self) -> bool {
        self.st.borrow().buffer.can_redo()
    }

    // Search.

    /// Selects the next (or previous) match after the primary selection.
    pub(crate) fn find(&self, forward: bool) {
        {
            let mut st = self.st.borrow_mut();
            if st.matches.is_empty() {
                return;
            }
            let primary = st.selections.primary();
            let index = if forward {
                // From after the match the selection is on, else from the
                // selection.
                let from = if st.current_match().is_some() {
                    primary.end()
                } else {
                    primary.start()
                };
                search::next_match(&st.matches, from)
            } else {
                search::previous_match(&st.matches, primary.start())
            };
            let Some(index) = index else { return };
            let range = st.matches[index].clone();
            st.selections = Selections::single(Selection::new(range.start, range.end));
        }
        self.after(Outcome::Moved);
    }

    pub(crate) fn replace_current(&self, with: &str) {
        let outcome = {
            let mut st = self.st.borrow_mut();
            let Some(index) = st.current_match() else {
                drop(st);
                self.find(true);
                return;
            };
            let range = st.matches[index].clone();
            let Some(search) = st.search.clone() else {
                return;
            };
            let text = search::replacement(&st.buffer, range.clone(), &search, with);
            st.editing(1, |e| e.replace(vec![(range, text)]))
        };
        self.after(outcome);
        self.find(true);
    }

    pub(crate) fn replace_all(&self, with: &str) -> u32 {
        let (count, outcome) = {
            let mut st = self.st.borrow_mut();
            let Some(search) = st.search.clone() else {
                return 0;
            };
            let ranges: Vec<_> = st
                .matches
                .iter()
                .map(|r| {
                    (
                        r.clone(),
                        search::replacement(&st.buffer, r.clone(), &search, with),
                    )
                })
                .collect();
            let count = ranges.len() as u32;
            if ranges.is_empty() {
                return 0;
            }
            (count, st.editing(1, |e| e.replace(ranges)))
        };
        self.after(outcome);
        count
    }

    // Folding.

    pub(crate) fn fold(&self, line: usize, fold: Option<bool>) {
        self.fold_with(|st| st.set_fold(line, fold));
    }

    pub(crate) fn fold_all(&self, fold: bool) {
        self.st.borrow_mut().fold_all(fold);
        self.bump_text();
        self.bump_selection();
        self.report_selections();
        self.report_folds();
    }

    /// Runs `f`, a change of the folds, and tells the view and the app
    /// when it changed them.
    pub(crate) fn fold_with(&self, f: impl FnOnce(&mut State) -> bool) {
        let changed = f(&mut self.st.borrow_mut());
        if changed {
            self.bump_text();
            self.bump_selection();
            self.report_selections();
            self.report_folds();
        }
    }

    /// The folded ranges, nested ones included.
    pub(crate) fn folds(&self) -> Vec<EditorFoldRange> {
        self.st
            .borrow()
            .folded()
            .iter()
            .map(|f| EditorFoldRange::new(f.start as u32, f.end as u32))
            .collect()
    }

    /// Replaces the folded ranges.
    pub(crate) fn set_folds(&self, ranges: &[EditorFoldRange]) {
        let ranges = ranges.iter().map(fold_range).collect();
        self.fold_with(|st| st.set_folds(ranges));
    }

    /// Tells the app the folded ranges when they changed (`onFoldChange`).
    fn report_folds(&self) {
        {
            let mut st = self.st.borrow_mut();
            if st.reported_folds.as_slice() == st.folded() {
                return;
            }
            let folded = st.folded().to_vec();
            st.reported_folds = folded;
        }
        self.cx.emit(EditorEvent::FoldChange(self.folds()));
    }

    // Reports.

    fn report_text(&self) {
        let text = {
            let mut st = self.st.borrow_mut();
            let version = st.buffer.version();
            if st.reported.as_ref().is_some_and(|(v, _)| *v == version) {
                return;
            }
            let text = SharedString::from(st.buffer.text());
            st.reported = Some((version, text.clone()));
            text
        };
        self.cx.emit(EditorEvent::Change(text));
    }

    pub(crate) fn report_selections(&self) {
        let selections = {
            let mut st = self.st.borrow_mut();
            let selections = st.editor_selections();
            if st.reported_selections == selections {
                return;
            }
            st.reported_selections = selections.clone();
            selections
        };
        self.cx.emit(EditorEvent::SelectionChange(selections));
    }

    fn report_search(&self) {
        let result = {
            let st = self.st.borrow();
            if st.search.is_none() {
                return;
            }
            st.search_result()
        };
        self.cx.emit(EditorEvent::SearchChange(result));
    }

    fn report_search_position(&self) {
        let has = self.st.borrow().search.is_some();
        if has {
            self.marks_rev.update(|r| *r += 1);
            self.report_search();
        }
    }

    // Scrolling.

    /// Scrolls the primary caret into view.
    pub(crate) fn show_caret(&self) {
        let (point, lh) = {
            let st = self.st.borrow();
            (st.caret_point(st.primary_head()), st.line_height())
        };
        self.scroll_into_view(point, lh);
    }

    /// Scrolls so that a caret at `point` of the rows' box (a line `lh`
    /// tall) shows, with a row of margin.
    pub(crate) fn scroll_into_view(&self, point: Point<Points>, lh: Points) {
        let viewport = self.viewport.get_untracked();
        if viewport.height.0 <= 0.0 {
            return;
        }
        let top = self.rows_top.get_untracked() + point.y;
        let y = self.scroll_y.get_untracked();
        let margin = layout::surrounding_margin(
            self.props.cursor_surrounding_lines.get_untracked(),
            viewport.height,
            lh,
        );
        let target_y = if top - margin < y {
            Some((top - margin).max(px(0.0)))
        } else if top + lh + margin > y + viewport.height {
            Some(top + lh + margin - viewport.height)
        } else {
            None
        }
        .filter(|&target| target != y);
        if let Some(target) = target_y {
            self.scroll_y.set(target);
            self.vscroll.scroll_to(Point::new(px(0.0), target), false);
            self.schedule_highlight();
        }
        if self.props.soft_wrap.get_untracked() {
            return;
        }
        let width = self.text_width.get_untracked();
        if width.0 <= 0.0 {
            return;
        }
        let x = self.scroll_x.get_untracked();
        let space = lh / 2.0;
        let target_x = if point.x - space < x {
            Some((point.x - space * 4.0).max(px(0.0)))
        } else if point.x + space > x + width {
            Some(point.x + space * 4.0 - width)
        } else {
            None
        }
        .filter(|&target| target != x);
        if let Some(target) = target_x {
            self.scroll_x.set(target);
            self.hscroll.scroll_to(Point::new(target, px(0.0)), false);
        }
    }

    pub(crate) fn scroll_to_line(&self, line: usize) {
        let (point, lh) = {
            let mut st = self.st.borrow_mut();
            let offset = st.buffer.line_start(line);
            st.reveal(offset);
            (st.caret_point(offset), st.line_height())
        };
        self.bump_text();
        self.report_folds();
        self.scroll_into_view(point, lh);
    }

    /// The display rows to make: those in view and a few around them.
    pub(crate) fn visible_rows(&self) -> std::ops::Range<usize> {
        let lh = self.st.borrow().line_height().0.max(1.0);
        let count = self.st.borrow().display.row_count();
        let y = (self.scroll_y.get() - self.rows_top.get()).0.max(0.0);
        let height = self.viewport.get().height.0.max(lh * 40.0);
        let last = (((y + height) / lh).ceil() as usize).min(count);
        let first = ((y / lh).floor() as usize).min(last);
        self.rows_window.rows(first..last, count)
    }

    // Highlighting.

    /// Loads the syntaxes off the engine thread the first time a language
    /// needs them, then highlights.
    fn load_syntaxes(&self) {
        let needs = {
            let st = self.st.borrow();
            st.highlighting && st.highlighter.is_none() && !st.syntax.is_plain()
        };
        if !needs {
            self.schedule_highlight();
            return;
        }
        if self.st.borrow().syntax.ready() {
            self.make_highlighter();
            return;
        }
        let ed = self.clone();
        spawn(async move {
            #[cfg(not(target_arch = "wasm32"))]
            {
                let _ = blocking(Highlighter::load).await;
            }
            #[cfg(target_arch = "wasm32")]
            {
                next_frame().await;
                Highlighter::load();
            }
            ed.make_highlighter();
        });
    }

    fn make_highlighter(&self) {
        {
            let mut st = self.st.borrow_mut();
            if st.highlighter.is_some() || !st.highlighting {
                return;
            }
            let st = &mut *st;
            st.highlighter = Highlighter::with(&st.syntax);
            if let Some(h) = &mut st.highlighter {
                h.reset(&st.buffer);
            }
        }
        self.schedule_highlight();
    }

    /// Highlights the lines up to the last one in view, a budget per
    /// frame, until they are current.
    pub(crate) fn schedule_highlight(&self) {
        if self.highlighting.replace(true) {
            return;
        }
        let ed = self.clone();
        spawn(async move {
            loop {
                // A guess of the lines in view when they are far past the
                // parse from the start, then the parse on towards them,
                // both off the engine thread.
                let (guess, job, version) = {
                    let rows = untracked(|| ed.visible_rows());
                    let mut st = ed.st.borrow_mut();
                    let st = &mut *st;
                    let count = st.display.row_count();
                    if count == 0 {
                        break;
                    }
                    let first_line = st.display.row(rows.start.min(count - 1)).line;
                    let last_line = st
                        .display
                        .row(rows.end.saturating_sub(1).min(count - 1))
                        .line;
                    let start = first_line.saturating_sub(GUESS_CONTEXT);
                    let start_offset = st.buffer.line_start(start);
                    let version = st.buffer.version();
                    let rope = st.buffer.rope().clone();
                    let Some(h) = &mut st.highlighter else {
                        break;
                    };
                    let guess = (first_line > h.frontier().saturating_add(GUESS_DISTANCE))
                        .then(|| h.guess(&rope, start, start_offset, last_line))
                        .flatten();
                    let job = h.job(&rope, last_line + LOOKAHEAD, SLICE);
                    (guess, job, version)
                };
                if guess.is_none() && job.is_none() {
                    break;
                }
                if let Some(guess) = guess {
                    let guessed = off_thread(move || guess.run()).await;
                    let changed = {
                        let mut st = ed.st.borrow_mut();
                        let current = st.buffer.version() == version;
                        match &mut st.highlighter {
                            Some(h) if current => !h.guessed(guessed).is_empty(),
                            _ => false,
                        }
                    };
                    if changed {
                        ed.hl_rev.update(|r| *r += 1);
                    }
                }
                if let Some(job) = job {
                    let done = off_thread(move || job.run()).await;
                    let changed = match &mut ed.st.borrow_mut().highlighter {
                        Some(h) => !h.finish(done).0.is_empty(),
                        None => false,
                    };
                    if changed {
                        ed.hl_rev.update(|r| *r += 1);
                    }
                }
                // Without threads the parse ran here: the frame goes on.
                #[cfg(target_arch = "wasm32")]
                next_frame().await;
            }
            ed.highlighting.set(false);
        });
    }

    // Scrolling while dragging.

    /// Starts, changes or stops scrolling on its own as a drag at `page`
    /// (in the root view) nears or leaves the viewport's edges.
    fn follow_drag_edge(&self, page: Point<Points>) {
        let Some(drag) = self.drag.get() else {
            self.autoscroll.borrow_mut().stop();
            return;
        };
        let at = page + drag.shift + (self.scroll_offset() - drag.scroll);
        let viewport = self.viewport.get_untracked();
        let y = at.y + self.rows_top.get_untracked() - self.scroll_y.get_untracked();
        let dy = layout::edge_speed(y, viewport.height, layout::AUTOSCROLL_INNER_ZONE);
        // Sideways only past the text area's edges: the gutter is left of
        // it, and the pointer often rests near its right edge.
        let dx = if self.props.soft_wrap.get_untracked() {
            px(0.0)
        } else {
            let x = at.x + self.rows_left.get_untracked() - self.scroll_x.get_untracked();
            layout::edge_speed(x, self.text_width.get_untracked(), px(0.0))
        };
        let mut auto = self.autoscroll.borrow_mut();
        auto.page = page;
        if dx.0 == 0.0 && dy.0 == 0.0 {
            auto.stop();
            return;
        }
        auto.speed = Point::new(dx, dy);
        if auto.task.is_none() {
            let ed = self.clone();
            let period = Duration::from_millis(layout::AUTOSCROLL_PERIOD_MS);
            auto.task = Some(set_interval(period, move || ed.autoscroll_tick()));
        }
    }

    /// A period of scrolling while dragging: the scroll views move by the
    /// speed (within their content) and the selection follows the pointer.
    fn autoscroll_tick(&self) {
        if self.drag.get().is_none() {
            self.autoscroll.borrow_mut().stop();
            return;
        }
        let (page, speed) = {
            let auto = self.autoscroll.borrow();
            (auto.page, auto.speed)
        };
        let viewport = self.viewport.get_untracked();
        let mut moved = false;
        if speed.y.0 != 0.0 {
            let max = (self.content_height.get_untracked() - viewport.height).max(px(0.0));
            let from = self.scroll_y.get_untracked();
            let to = (from + speed.y).min(max).max(px(0.0));
            if to != from {
                self.scroll_y.set(to);
                self.vscroll.scroll_to(Point::new(px(0.0), to), false);
                moved = true;
            }
        }
        if speed.x.0 != 0.0 {
            let width = self.st.borrow().content_size().width;
            let max = (self.rows_left.get_untracked() + width - self.text_width.get_untracked())
                .max(px(0.0));
            let from = self.scroll_x.get_untracked();
            let to = (from + speed.x).min(max).max(px(0.0));
            if to != from {
                self.scroll_x.set(to);
                self.hscroll.scroll_to(Point::new(to, px(0.0)), false);
                moved = true;
            }
        }
        if moved {
            self.drag_to(page);
        }
    }
}

/// The editing options of `props` for `language`.
fn options_of(
    props: &EditorProps,
    language: &'static super::language::LanguageConfig,
) -> EditOptions {
    EditOptions {
        tab_size: props
            .tab_size
            .get_untracked()
            .unwrap_or(language.tab_size)
            .clamp(1, 16),
        hard_tabs: props
            .hard_tabs
            .get_untracked()
            .unwrap_or(language.hard_tabs),
        auto_close: props.auto_close.get_untracked(),
        auto_indent: props.auto_indent.get_untracked(),
        read_only: props.read_only.get_untracked(),
    }
}

/// The font family to draw in: the app's, else the theme's monospaced one,
/// else the system's.
pub(crate) fn font_family(family: Option<SharedString>) -> SharedString {
    family
        .or_else(|| crate::theme().font_mono.clone())
        .unwrap_or_else(|| SharedString::from("monospace"))
}

/// The width of a string in `font`, by the platform's text engine.
fn measurer(font: &Font) -> Rc<dyn Fn(&str) -> Points> {
    let css = font.css();
    Rc::new(move |text: &str| text_width(&css, text))
}

/// How many copies of a short text are measured at once.
const COPIES: usize = 64;

/// The width of `text` in `css` (a CSS `font`), exact enough to sum: text
/// engines round a measured width up to a whole point, so a char measured
/// alone is up to a point wider than it draws, and a row of them drifts
/// right of the text. A short text is measured as `COPIES` copies of it.
pub(crate) fn text_width(css: &str, text: &str) -> Points {
    if text.is_empty() || text.len() > 8 {
        return measure_text(css, text);
    }
    measure_text(css, &text.repeat(COPIES)) / COPIES as f32
}

/// The app's fold range as the editor's lines.
fn fold_range(range: &EditorFoldRange) -> FoldRange {
    FoldRange {
        start: range.start_line as usize,
        end: range.end_line as usize,
    }
}

/// Key options of a binding that works while the editor's sink has the
/// focus.
fn always(repeat: bool) -> KeyOptions {
    KeyOptions {
        when: When::Always,
        repeat,
    }
}

/// The bytes `a` and `b` start with alike, on a char boundary.
fn common_prefix(a: &str, b: &str) -> usize {
    a.char_indices()
        .zip(b.chars())
        .find(|((_, x), y)| x != y)
        .map(|((i, _), _)| i)
        .unwrap_or_else(|| a.len().min(b.len()))
}

/// The selection a drag by words or lines makes: from `origin` to the unit
/// `start..end` the pointer is on, toward `at`.
fn extend_by(origin: Selection, start: usize, end: usize, at: usize) -> Selection {
    if at < origin.start() {
        Selection::new(origin.end(), start)
    } else {
        Selection::new(origin.start(), end.max(origin.end()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_prefixes_stop_on_char_boundaries() {
        assert_eq!(common_prefix("abc", "abd"), 2);
        assert_eq!(common_prefix("ab", "abc"), 2);
        assert_eq!(common_prefix("中a", "中b"), 3);
        assert_eq!(common_prefix("", "x"), 0);
    }
}
