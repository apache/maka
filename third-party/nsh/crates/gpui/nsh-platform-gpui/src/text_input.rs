//! Text inputs: an editor of nsh's own, laid out with GPUI's text system
//! ([`layout`]) and painted through [`DrawCx`], hosted in the input's view
//! at the content box the core laid out (inside padding and border), so
//! the editor clips and transforms with its view and nothing ever covers
//! it.
//!
//! The view draws the decoration (background, border, corners) from the
//! core's style like any other view; the editor ([`InputState`], a
//! [`Hosted`] item) draws the selection, the text or the placeholder, the
//! IME's composition (underlined, at the caret) and the caret, which
//! blinks on a main-thread timer ([`crate::rt::after_ms`]), not on the
//! frame ticker, so a focused field costs no frames between blinks.
//!
//! The editing itself (text, selection, caret stops, words, undo) is
//! [`model`], shared with the Windows backend; this file turns pointer,
//! key and input method calls into its operations and its changes into
//! events.
//!
//! Text arrives through GPUI's input handler, never as key downs: while
//! an editable field has the focus, the surface's element registers its
//! [`crate::app::AppView`] as the window's input handler
//! (`Window::handle_input`), and the view hands every call to [`ime`]
//! here. Typed characters come as `replace_text_in_range` once the key
//! down was not taken (keys the field takes, as Backspace or Ctrl+A, stop
//! there); input methods mark text (`replace_and_mark_text_in_range`, the
//! composition shown underlined at the caret, the clause being converted
//! thicker) and commit it, and ask where the caret is
//! (`bounds_for_range`) to place their candidate window.
//!
//! Every user edit increments the input's edit count and reports
//! `onChangeText` with it (always, as the engine keeps the text); a value
//! from JS based on an older count is stale and dropped, so fast typing is
//! never overwritten. Programmatic changes (JS values) report nothing but
//! the selection. Lengths and offsets JS sees are UTF-16 units.
//!
//! Focus is one view per surface. The window's (and the embedding app's)
//! focus is followed apart from it: a surface that is not focused keeps
//! its focused view (an input's caret is hidden) and gets it back when
//! focused again. Text typed after Enter, a binding, or a focus move
//! waits until the engine has handled that key, then goes to the field
//! that has the keyboard.
//!
//! Return follows the config's `submit()`: a single line submits; a
//! multiline input whose return submits does so on a plain return (or
//! Ctrl+Return), while Shift+Return and Alt+Return still insert a line
//! break. Input methods take the keys they use while they compose, so a
//! return that commits a composition submits nothing.
//!
//! `onKeyPress` reports what typing inserts and deletes, as UIKit does
//! (nothing for pasted text, no Backspace for a selection typed over), and
//! Escape, as on the other desktops.
//!
//! Shortcuts use the platform's command key: Ctrl, or Command on macOS
//! (where Option moves by words and Command to the line's edges).
//!
//! Input accessory views (`inputAccessoryViewID`) belong over a software
//! keyboard and have no meaning on the desktop: they are never shown.

mod layout;

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    ops::Range,
    rc::Rc,
    sync::Arc,
};

use gpui::{Font, FontFeatures, FontStyle, FontWeight, SharedString, TextSystem, px};
use nsh_core::{
    AutoCapitalize, Color, EventKind, EventPayload, InputConfig, NodeId, PayloadValue, Points,
    ReturnKeyType, SubmitBehavior, TextAlign,
    input_tokens::InputTokenStyle,
    tailwind::state,
    text_edit::{self as model, Composition, Model, Unit, key_of, pasted, utf16_to_byte},
};
use rustc_hash::FxHashMap;

use self::layout::{Layout, Style};
use crate::{
    input::{KeyEvent, Modifiers, PointerKind},
    keys::{
        VK_BACK, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_INSERT, VK_LEFT, VK_NEXT,
        VK_PRIOR, VK_RETURN, VK_RIGHT, VK_TAB, VK_UP,
    },
    render::DrawCx,
    surface::Surface,
    view::{Hosted, ItemPointer, NshView},
};

/// The caret's width (points).
const CARET_WIDTH: f32 = 1.0;

/// How long the caret shows, and then hides, while it blinks (ms).
const BLINK_MS: u64 = 530;

/// What a drag that started with a press selects by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Drag {
    /// Characters, from where it was pressed.
    Char,
    /// Whole words, from the word double-clicked (its range).
    Word(usize, usize),
    /// Whole lines, from the line triple-clicked.
    Line(usize, usize),
}

/// The text input `view` holds now (`None`: it is no input).
#[cfg(feature = "dev")]
pub(crate) fn current_text(view: &crate::view::NshView) -> Option<String> {
    let input = view.state().input.clone()?;
    let text = input.model.borrow().text().to_owned();
    Some(text)
}

/// The native side of an input view ([`crate::view::ViewState::input`]),
/// and the editor it hosts.
pub(crate) struct InputState {
    /// The surface's key ([`Surface::by_key`]): `focus()` and `blur()`
    /// come with the view only.
    surface: u64,
    /// The app's text system (`None` outside a GPUI app: nothing is laid
    /// out).
    system: Option<Arc<TextSystem>>,
    model: RefCell<Model>,
    config: RefCell<InputConfig>,
    /// A configuration was applied (auto focus happens on the first).
    configured: Cell<bool>,
    /// Content box; the whole view until the core sends one.
    content: Cell<Option<nsh_core::Bounds<Points>>>,
    /// The size the editor was hosted (and last drawn) at.
    size: Cell<(f32, f32)>,
    /// User edits reported to the engine.
    count: Cell<u32>,
    /// Selection as last reported (UTF-16).
    reported: Cell<(u32, u32)>,
    /// The caret as last reported, in the view.
    reported_caret: Cell<nsh_core::Bounds<Points>>,
    /// The composition as last reported (`onCompositionChange`): its text
    /// while one is in progress.
    composed: RefCell<Option<String>>,
    /// A value from JS (text, count) that arrived while the input method
    /// composed, applied when the composition ends: replacing the text
    /// under a composition would drop it without the input method knowing.
    pending: RefCell<Option<(String, u32)>>,
    /// The animated text color, if a native animation sets one.
    anim_color: Cell<Option<Color>>,
    /// It has the surface's focus.
    focused: Cell<bool>,
    /// The surface has the window's focus (the caret shows).
    active: Cell<bool>,
    /// The blinking caret's phase.
    caret_on: Cell<bool>,
    /// Scroll offset of the text: horizontal for one line, vertical for
    /// several.
    scroll: Cell<f32>,
    /// The x the caret keeps while it moves up and down lines.
    goal_x: Cell<Option<f32>>,
    /// A press is selecting.
    drag: Cell<Option<Drag>>,
    /// The font, made from the config's style.
    style: RefCell<Option<Style>>,
    /// The shown text, laid out (cleared by every change).
    layout: RefCell<Option<Rc<Layout>>>,
    /// The placeholder, laid out.
    placeholder: RefCell<Option<Rc<Layout>>>,
}

impl InputState {
    fn new(surface: u64, system: Option<Arc<TextSystem>>) -> Self {
        InputState {
            surface,
            system,
            model: RefCell::default(),
            config: RefCell::default(),
            configured: Cell::new(false),
            content: Cell::new(None),
            size: Cell::new((0.0, 0.0)),
            count: Cell::new(0),
            reported: Cell::new((0, 0)),
            reported_caret: Cell::new(nsh_core::Bounds::default()),
            composed: RefCell::new(None),
            pending: RefCell::new(None),
            anim_color: Cell::new(None),
            focused: Cell::new(false),
            active: Cell::new(true),
            caret_on: Cell::new(true),
            scroll: Cell::new(0.0),
            goal_x: Cell::new(None),
            drag: Cell::new(None),
            style: RefCell::new(None),
            layout: RefCell::new(None),
            placeholder: RefCell::new(None),
        }
    }

    fn multiline(&self) -> bool {
        self.config.borrow().multiline
    }

    fn secure(&self) -> bool {
        self.config.borrow().secure
    }

    fn composing(&self) -> bool {
        self.model
            .borrow()
            .composition
            .as_ref()
            .is_some_and(|c| !c.text.is_empty())
    }

    /// The text changed what it shows.
    fn relayout(&self) {
        self.layout.borrow_mut().take();
    }

    fn set_size(&self, size: (f32, f32)) {
        if self.size.replace(size) != size {
            self.relayout();
            self.placeholder.borrow_mut().take();
        }
    }

    /// The font of the config's style.
    fn style(&self) -> Style {
        if let Some(s) = &*self.style.borrow() {
            return s.clone();
        }
        let config = self.config.borrow();
        let s = &config.style;
        let line_height = if !config.multiline {
            0.0
        } else if s.line_height.0 > 0.0 {
            s.line_height.0
        } else if s.line_height_multiple > 0.0 {
            s.line_height_multiple * s.font_size.0
        } else {
            0.0
        };
        let style = Style {
            font: font(s),
            size: s.font_size.0.max(1.0),
            line_height,
            spacing: s.letter_spacing.0,
        };
        *self.style.borrow_mut() = Some(style.clone());
        style
    }

    /// The shown text, laid out: one unwrapped line, placed by
    /// [`InputState::origin`], or lines wrapped in the editor's width and
    /// aligned.
    fn layout(&self) -> Option<Rc<Layout>> {
        if let Some(l) = &*self.layout.borrow() {
            return Some(l.clone());
        }
        let system = self.system.as_ref()?;
        let multiline = self.multiline();
        let text: String = {
            let model = self.model.borrow();
            if self.secure() {
                // UIKit's and Android's bullet.
                "\u{2022}".repeat(model.display().chars().count())
            } else {
                model.display().into_owned()
            }
        };
        let width = self.size.get().0.max(1.0);
        let align = xalign(&self.config.borrow());
        let layout = Rc::new(layout::layout(
            system,
            &text,
            &self.style(),
            multiline.then_some(width),
            align,
            None,
        ));
        *self.layout.borrow_mut() = Some(layout.clone());
        Some(layout)
    }

    /// The placeholder, laid out (cut with an ellipsis on one line).
    fn placeholder_layout(&self) -> Option<Rc<Layout>> {
        if let Some(l) = &*self.placeholder.borrow() {
            return Some(l.clone());
        }
        let system = self.system.as_ref()?;
        let (text, align, multiline) = {
            let c = self.config.borrow();
            if c.placeholder.is_empty() {
                return None;
            }
            (c.placeholder.clone(), xalign(&c), c.multiline)
        };
        let width = self.size.get().0.max(1.0);
        let text = if multiline {
            text
        } else {
            text.replace('\n', " ")
        };
        let layout = Rc::new(layout::layout(
            system,
            &text,
            &self.style(),
            multiline.then_some(width),
            align,
            (!multiline).then_some(width),
        ));
        *self.placeholder.borrow_mut() = Some(layout.clone());
        Some(layout)
    }

    /// Where the layout's origin goes in the editor: one line is centered
    /// vertically, aligned while it fits and scrolled when it does not;
    /// several lines scroll vertically.
    fn origin(&self, layout: &Layout) -> (f32, f32) {
        let (w, h) = self.size.get();
        if self.multiline() {
            let max = (layout.height - h).max(0.0);
            let scroll = self.scroll.get().clamp(0.0, max);
            self.scroll.set(scroll);
            return (0.0, -scroll);
        }
        let text_w = layout.width;
        let y = (h - layout.height) / 2.0;
        if text_w + CARET_WIDTH <= w {
            self.scroll.set(0.0);
            let align = xalign(&self.config.borrow());
            let x = ((w - text_w) * align)
                .min(w - text_w - CARET_WIDTH)
                .max(0.0);
            return (x, y);
        }
        let max = text_w + CARET_WIDTH - w;
        let scroll = self.scroll.get().clamp(0.0, max);
        self.scroll.set(scroll);
        (-scroll, y)
    }

    /// The caret's rectangle in editor coordinates (x, y, height) at
    /// shown position `pos`, or at the caret.
    fn caret_rect(&self, pos: Option<u32>) -> Option<(f32, f32, f32)> {
        let layout = self.layout()?;
        let pos = pos.unwrap_or_else(|| self.model.borrow().display_caret(self.secure()));
        let (ox, oy) = self.origin(&layout);
        let (x, y, h) = layout.caret(pos);
        Some((ox + x, oy + y, h))
    }

    /// The text offset at editor point `(x, y)`.
    fn hit(&self, x: f32, y: f32, caret: bool) -> usize {
        let Some(layout) = self.layout() else {
            return 0;
        };
        let (ox, oy) = self.origin(&layout);
        let model = self.model.borrow();
        let secure = self.secure();
        let pos = layout.hit(x - ox, y - oy, |at| {
            !caret || model.tokens().is_caret(model.text_at(at, secure))
        });
        model.text_at(pos, secure)
    }

    /// Scrolls so that the caret shows.
    fn reveal(&self) {
        let Some(layout) = self.layout() else { return };
        let pos = self.model.borrow().display_caret(self.secure());
        let (x, y, h) = layout.caret(pos);
        let (w, height) = self.size.get();
        let scroll = self.scroll.get();
        let scroll = if self.multiline() {
            if y < scroll {
                y
            } else if y + h > scroll + height {
                y + h - height
            } else {
                scroll
            }
        } else if x < scroll {
            x
        } else if x + CARET_WIDTH > scroll + w {
            x + CARET_WIDTH - w
        } else {
            scroll
        };
        self.scroll.set(scroll);
        // Clamped to the text.
        self.origin(&layout);
    }

    /// The caret shows (again) for a whole blink: typing and moving never
    /// leave it hidden.
    fn wake_caret(&self) {
        self.caret_on.set(true);
        blink::restart();
    }

    fn text_color(&self) -> Color {
        self.anim_color
            .get()
            .unwrap_or_else(|| self.config.borrow().style.color)
    }
}

impl Hosted for InputState {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        self.set_size(size);
        let Some(layout) = self.layout() else { return };
        let (w, h) = size;
        let multiline = self.multiline();
        if multiline {
            cx.push_clip_rect(0.0, 0.0, w, h);
        } else {
            // One line may be taller than its box: it stays centered and the
            // view's bounds clip it.
            cx.push_clip_rect(0.0, -1.0e4, w, 2.0e4);
        }
        let (ox, oy) = self.origin(&layout);
        let config = self.config.borrow();
        let model = self.model.borrow();
        let secure = config.secure;
        let color = self.text_color();
        let focused = self.focused.get();
        let tokens = if secure {
            Vec::new()
        } else {
            display_tokens(&model)
        };

        for (range, style) in &tokens {
            let Some(tint) = style.background_color else {
                continue;
            };
            for (x, y, rw, rh) in layout.rects(range.start, range.end) {
                cx.fill_rect(
                    crate::geom::rect(ox + x, oy + y, rw, rh),
                    [style.border_radius.0; 4],
                    tint,
                );
            }
        }

        if focused && model.has_selection() {
            let (s, e) = model.selection();
            let (s, e) = (model.to_display(s, secure), model.to_display(e, secure));
            // iOS tints the selection with the system blue when there is
            // no `selectionColor`.
            let tint = config
                .selection_color
                .unwrap_or(Color::rgba(0x00, 0x7a, 0xff, 0xff))
                .with_alpha(0.3);
            for (x, y, rw, rh) in layout.rects(s, e) {
                // An empty line of the selection still shows a sliver.
                cx.fill_rect(
                    crate::geom::rect(ox + x, oy + y, rw.max(4.0), rh),
                    [0.0; 4],
                    tint,
                );
            }
        }

        let composing = model
            .composition
            .as_ref()
            .is_some_and(|c| !c.text.is_empty());
        if model.text().is_empty() && !composing {
            if let Some(placeholder) = self.placeholder_layout() {
                let tint = config
                    .placeholder_color
                    .unwrap_or_else(|| color.with_alpha(0.5));
                let y = if multiline {
                    oy
                } else {
                    (h - placeholder.height) / 2.0
                };
                paint_glyphs(cx, &placeholder, 0.0, y, tint, &[]);
            }
        } else {
            paint_glyphs(cx, &layout, ox, oy, color, &tokens);
        }

        if let Some(c) = model.composition.as_ref().filter(|c| !c.text.is_empty()) {
            let start = model.to_display(model.caret(), secure);
            let len = if secure {
                c.text.chars().count() as u32
            } else {
                model::utf16_len(&c.text) as u32
            };
            let thin = 1.0 / cx.scale.max(1.0);
            let underline = |cx: &mut DrawCx<'_>, from: u32, len: u32, width: f32| {
                for (x, y, rw, rh) in layout.rects(from, from + len) {
                    let y = oy + y + rh - width - thin;
                    let w = (rw - 2.0 * thin).max(0.0);
                    cx.fill_rect(
                        crate::geom::rect(ox + x + thin, y, w, width),
                        [0.0; 4],
                        color,
                    );
                }
            };
            underline(cx, start, len, thin.max(1.0));
            if let Some((ts, te)) = c.target.filter(|_| !secure) {
                let from = start + model::utf16_len(&c.text[..ts]) as u32;
                let len = model::utf16_len(&c.text[ts..te]) as u32;
                underline(cx, from, len, 2.0);
            }
        }

        let caret_shown = focused
            && self.active.get()
            && self.caret_on.get()
            && config.editable
            && !config.caret_hidden
            && (!model.has_selection() || composing);
        if caret_shown {
            let pos = model.display_caret(secure);
            let (x, y, ch) = layout.caret(pos);
            // On whole pixels, so that the caret stays sharp.
            let snap = |v: f32| (v * cx.scale).round() / cx.scale;
            let x = snap(ox + x);
            let tint = config.caret_color.unwrap_or(color);
            cx.fill_rect(
                crate::geom::rect(x, oy + y, CARET_WIDTH, ch),
                [0.0; 4],
                tint,
            );
        }
        drop(model);
        drop(config);
        cx.pop();
    }

    fn hit(&self, _x: f32, _y: f32, _size: (f32, f32)) -> bool {
        // The pointer goes to the input's view ([`pointer`]), padding
        // included, so that a press anywhere in the field places the caret.
        false
    }

    fn cursor(&self, _x: f32, _y: f32) -> Option<crate::input::Cursor> {
        Some(crate::input::Cursor::Text)
    }
}

/// Paints `layout`'s glyphs with its origin at `(ox, oy)` (current
/// coordinates).
fn paint_glyphs(
    cx: &mut DrawCx<'_>,
    layout: &Layout,
    ox: f32,
    oy: f32,
    color: Color,
    tokens: &[(Range<u32>, InputTokenStyle)],
) {
    if cx.culled() || layout.glyphs.is_empty() {
        return;
    }
    let size = px(layout.size * cx.transform_scale());
    let tint = cx.color(color);
    let colors: Vec<_> = tokens
        .iter()
        .filter_map(|(range, style)| style.color.map(|color| (range, cx.color(color))))
        .collect();
    let mut glyphs = Vec::with_capacity(layout.glyphs.len());
    for line in &layout.lines {
        let y = oy + line.y + line.baseline;
        for g in &layout.glyphs[line.glyphs.clone()] {
            let index = colors.partition_point(|(range, _)| range.end <= g.offset);
            let tint = colors
                .get(index)
                .filter(|(range, _)| range.contains(&g.offset))
                .map_or(tint, |(_, color)| *color);
            glyphs.push((cx.map(ox + line.x + g.x, y), *g, tint));
        }
    }
    cx.paint(|window, _| {
        for (p, g, tint) in glyphs {
            let result = if g.emoji {
                window.paint_emoji(p, g.font, g.id, size)
            } else {
                window.paint_glyph(p, g.font, g.id, size, tint)
            };
            if let Err(err) = result {
                log::debug!("text input: cannot paint a glyph: {err}");
            }
        }
    });
}

/// Project committed source ranges into the shown text, leaving the IME's
/// preedit unstyled even when it sits inside the token being typed.
fn display_tokens(model: &Model) -> Vec<(Range<u32>, InputTokenStyle)> {
    let mut shown = Vec::new();
    let caret = model.caret();
    let composition = model
        .composition
        .as_ref()
        .filter(|c| !c.text.is_empty())
        .map_or(0, |c| model::utf16_len(&c.text) as u32);
    for span in model.tokens().spans() {
        let start = model.to_display(span.range.start, false);
        let end = model.to_display(span.range.end, false);
        if composition > 0 && span.range.start <= caret && caret < span.range.end {
            let at = model.to_display(caret, false);
            if start < at {
                shown.push((start..at, span.style));
            }
            shown.push((at + composition..end, span.style));
        } else {
            shown.push((start..end, span.style));
        }
    }
    shown
}

/// The font of a text style, resolved as the engine's text resolves it
/// ([`crate::text`]), so that a field's text measures as the core
/// measured it.
fn font(s: &nsh_core::ResolvedTextStyle) -> Font {
    let family = match &s.font_family {
        Some(f) => SharedString::from(f.name().to_string()),
        None => SharedString::from(crate::text::ui_family().to_string()),
    };
    Font {
        family,
        features: FontFeatures::default(),
        fallbacks: None,
        weight: FontWeight(s.font_weight as f32),
        style: if s.italic {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        },
    }
}

/// The horizontal alignment of the text (0: left, 1: right).
fn xalign(config: &InputConfig) -> f32 {
    match config.align {
        TextAlign::Center => 0.5,
        TextAlign::Right => 1.0,
        TextAlign::Left | TextAlign::Justify => 0.0,
        TextAlign::Auto if config.rtl => 1.0,
        TextAlign::Auto => 0.0,
    }
}

// --- Focus -------------------------------------------------------------------

/// What waits for the next field.
enum Held {
    Replace {
        range: Option<Range<usize>>,
        text: String,
    },
    Mark {
        range: Option<Range<usize>>,
        text: String,
        selected: Option<Range<usize>>,
    },
    Unmark,
    Key(KeyEvent),
}

/// A keyboard target lives in one native view. Inline links retain their
/// own node identity without adding a view or another focus owner.
#[derive(Clone, PartialEq)]
pub(crate) enum FocusTarget {
    View(NshView),
    TextLink(NshView, NodeId),
}

impl FocusTarget {
    pub(crate) fn view(&self) -> &NshView {
        match self {
            Self::View(view) | Self::TextLink(view, _) => view,
        }
    }

    pub(crate) fn id(&self) -> NodeId {
        match self {
            Self::View(view) => view.id(),
            Self::TextLink(_, node) => *node,
        }
    }

    pub(crate) fn link(&self) -> Option<nsh_core::TextLink> {
        let Self::TextLink(view, node) = self else {
            return None;
        };
        view.state()
            .text
            .as_ref()?
            .text
            .links
            .iter()
            .find(|link| link.node == *node)
            .cloned()
    }

    pub(crate) fn valid(&self, surface: &Surface) -> bool {
        crate::input::focusable(surface, self.view())
            && match self {
                Self::View(_) => true,
                Self::TextLink(..) => self.link().is_some_and(|link| link.is_enabled()),
            }
    }

    fn event(&self, surface: &Surface, kind: EventKind) {
        match self {
            Self::View(view) => send(surface, view, kind, || EventPayload::None),
            Self::TextLink(..) => {
                if self.link().is_some_and(|link| link.events.contains(kind)) {
                    surface.event(self.id(), kind, EventPayload::None);
                }
            }
        }
    }

    fn focused_state(&self, surface: &Surface, on: bool) {
        match self {
            Self::View(view) => crate::input::set_state(surface, view, state::FOCUSED, on),
            Self::TextLink(..) => {
                surface.control(|c| c.set_states(self.id(), if on { state::FOCUSED } else { 0 }))
            }
        }
    }
}

/// A surface's sole keyboard target and its window activation.
#[derive(Default)]
struct Focus {
    target: Option<FocusTarget>,
    inactive: bool,
    /// Revoked by this sole owner whenever its focus admission changes.
    admission: Rc<()>,
    /// Text typed after an action that can move focus, and the editing
    /// keys typed after that text. The field that has the keyboard when
    /// the engine catches up takes them, in order.
    pending: VecDeque<Held>,
    /// An action may still deliver the field that takes the keyboard.
    armed: bool,
    /// The events sent up to the action that armed the queue
    /// ([`Surface::events_sent`]). Until the engine has handled them, the
    /// field with the keyboard may be about to lose it.
    after: u64,
    /// `set_focus` is on the stack. Text typed now waits for the field it
    /// settles on.
    changing: bool,
}

thread_local! {
    /// The focus of each surface of this thread, by surface key.
    static FOCUS: RefCell<FxHashMap<u64, Focus>> = RefCell::default();
}

/// The input of a view: a function, so that the view's state is not
/// borrowed through an `if let` block (focusing borrows it mutably).
fn input_of(view: &NshView) -> Option<Rc<InputState>> {
    view.state().input.clone()
}

/// The field's text, whether it is read-only and whether it is secure, for
/// accessibility's value ([`crate::access`]).
pub(crate) fn accessible_value(view: &NshView) -> Option<crate::access::FieldValue> {
    let input = input_of(view)?;
    let config = input.config.borrow();
    Some(crate::access::FieldValue {
        text: if config.secure {
            String::new()
        } else {
            input.model.borrow().text().to_owned()
        },
        read_only: !config.editable,
        password: config.secure,
    })
}

/// Replaces the field's text as typing it would (an assistive
/// technology's set value): `maxLength` applies and the change is
/// reported. False when it cannot (read-only).
pub(crate) fn set_accessible_value(surface: &Rc<Surface>, view: &NshView, text: &str) -> bool {
    let Some(input) = input_of(view) else {
        return false;
    };
    if !input.config.borrow().editable {
        return false;
    }
    let text = pasted(text, input.multiline());
    input.model.borrow_mut().select_all();
    if text.is_empty() {
        let deleted = input.model.borrow_mut().delete(Unit::Char, false);
        after_edit(surface, view, &input, deleted);
    } else {
        insert(surface, view, &input, &text, false);
    }
    true
}

/// The view that has the surface's keyboard focus.
pub(crate) fn focused_view(surface: &Surface) -> Option<NshView> {
    focused_target(surface).map(|target| target.view().clone())
}

/// The mounted view or inline link that owns the keyboard focus.
pub(crate) fn focused_target(surface: &Surface) -> Option<FocusTarget> {
    let target = FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .and_then(|f| f.target.clone())
    })?;
    let view = target.view();
    // A view the app removed loses the focus quietly (its node is gone).
    if target.valid(surface) {
        return Some(target);
    }
    if let Some(input) = input_of(view) {
        input.focused.set(false);
    }
    target.focused_state(surface, false);
    FOCUS.with(|f| {
        if let Some(f) = f.borrow_mut().get_mut(&surface.key()) {
            f.target = None;
            f.admission = Rc::new(());
        }
    });
    blink::update();
    None
}

/// Resolves a span from the current mounted text, never a retained range.
pub(crate) fn link_target(surface: &Surface, node: NodeId) -> Option<FocusTarget> {
    fn find(view: &NshView, node: NodeId) -> Option<FocusTarget> {
        if view
            .state()
            .text
            .as_ref()
            .is_some_and(|text| text.text.links.iter().any(|link| link.node == node))
        {
            return Some(FocusTarget::TextLink(view.clone(), node));
        }
        view.child_views()
            .iter()
            .find_map(|child| find(child, node))
    }
    find(&surface.root, node)
}

/// The focused input, if the surface's keyboard focus belongs to one.
/// Other focus owners must not register an input handler or accept IME text.
pub(crate) fn focused(surface: &Surface) -> Option<NshView> {
    focused_view(surface).filter(|view| input_of(view).is_some())
}

pub(crate) fn window_active(surface: &Surface) -> bool {
    FOCUS.with(|f| f.borrow().get(&surface.key()).is_none_or(|f| !f.inactive))
}

/// The focused inline range of this view, derived from the sole owner.
pub(crate) fn focused_link(view: &NshView) -> Option<nsh_core::TextLink> {
    FOCUS.with_borrow(|focuses| {
        focuses.values().find_map(|focus| {
            let target = focus.target.as_ref()?;
            (!focus.inactive && target.view() == view)
                .then(|| target.link())
                .flatten()
        })
    })
}

pub(crate) fn reveal_target(surface: &Rc<Surface>, target: &FocusTarget) {
    if let Some(link) = target.link() {
        if let Some(rect) = crate::text::range_rect(&target.view().state(), link.start, link.end) {
            crate::scroll::reveal_rect(surface, target.view(), rect);
        }
    } else {
        crate::scroll::reveal(surface, target.view());
    }
}

/// Moves the surface's focus to `view` (or nowhere), reporting the blur of
/// the view that had it, then the focus of the new one. Callers validate
/// eligibility and navigation scope before entering this transition.
fn set_focus(surface: &Rc<Surface>, view: Option<&NshView>) {
    set_focus_target(surface, view.cloned().map(FocusTarget::View));
}

/// All view and span transitions use the same native focus lifecycle.
/// Text typed while this runs, or while the queue is armed, is given to
/// the field that ends up focused, ahead of text it receives later.
pub(crate) fn set_focus_target(surface: &Rc<Surface>, target: Option<FocusTarget>) {
    if target.as_ref().is_some_and(|target| !target.valid(surface)) {
        return;
    }
    // A native focus intent (pointer, Tab or explicit focus) supersedes
    // an earlier autoFocus request that has not mounted yet.
    surface.pending_auto_focus.borrow_mut().take();
    if target.is_some() {
        crate::native::focus_surface(surface);
    }
    let old = focused_target(surface);
    set_changing(surface, true);
    if old != target {
        let moved_to = target.is_some();
        let events_before = surface.events_sent();
        move_focus(surface, old, target);
        // The new field's value may still be on its way from the engine,
        // after what the old one reported. Text typed now waits for it.
        if wants_text(surface) && surface.events_sent() > events_before {
            arm(surface);
        } else if moved_to && !has_pending(surface) {
            disarm(surface);
        }
    } else if target.is_some() {
        // The host can own the window's focus while this view keeps the surface's.
        // Draw again to apply the explicit surface focus intent queued above.
        surface.sync_focus();
        surface.invalidate();
    }
    set_changing(surface, false);
    flush_pending(surface);
}

fn set_changing(surface: &Surface, changing: bool) {
    FOCUS.with(|f| {
        f.borrow_mut().entry(surface.key()).or_default().changing = changing;
    });
}

fn move_focus(surface: &Rc<Surface>, old: Option<FocusTarget>, target: Option<FocusTarget>) {
    let previous = crate::input::focus_chain(surface);
    FOCUS.with(|f| {
        f.borrow_mut().entry(surface.key()).or_default().admission = Rc::new(());
    });
    if let Some(old) = &old {
        let view = old.view();
        if let Some(input) = input_of(view) {
            input.focused.set(false);
            input.drag.set(None);
            // What the input method composed is dropped with the focus
            // (the handler that would commit it is no longer registered).
            input.model.borrow_mut().composition = None;
            input.relayout();
            report_composition(surface, view, &input);
        }
        FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().target = None);
        old.focused_state(surface, false);
        old.event(surface, EventKind::Blur);
        view.changed();
    }
    if let Some(target) = target {
        let view = target.view();
        FOCUS.with(|f| {
            f.borrow_mut().entry(surface.key()).or_default().target = Some(target.clone())
        });
        if let Some(input) = input_of(view) {
            input.focused.set(true);
            input.active.set(window_active(surface));
            input.wake_caret();
            input.reveal();
        }
        target.focused_state(surface, true);
        target.event(surface, EventKind::Focus);
        // The scroll views around bring the focused view into sight.
        reveal_target(surface, &target);
        crate::access::focus_changed(surface, view);
        view.changed();
    }
    crate::input::focus_within_changed(surface, &previous);
    surface.sync_focus();
    blink::update();
    // The input handler is registered (or not) by the next frame.
    surface.invalidate();
}

/// An action that can move focus just ran. Text typed now waits for the
/// field that takes the keyboard.
pub(crate) fn arm(surface: &Surface) {
    let after = surface.events_sent();
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        focus.armed = true;
        focus.after = after;
    });
}

/// The engine has not yet handled the action that armed the queue. The
/// field with the keyboard may be about to lose it.
fn behind(surface: &Surface) -> bool {
    let after = FOCUS.with(|f| f.borrow().get(&surface.key()).map_or(0, |f| f.after));
    surface.events_handled() < after
}

/// The engine handled more events ([`Surface::events_handled`]), and what
/// they changed is applied. What waits goes to the field that now has the
/// keyboard.
pub(crate) fn engine_caught_up(surface: &Rc<Surface>) {
    if armed(surface) && !behind(surface) {
        flush_pending(surface);
    }
}

/// Keeps editing keys and their releases behind the text waiting for the
/// next field. Character keys deliver their text through the input method.
pub(crate) fn hold_key(surface: &Surface, event: &KeyEvent) -> bool {
    let m = event.modifiers;
    let edits = matches!(
        event.vk,
        VK_RETURN
            | VK_BACK
            | VK_DELETE
            | VK_TAB
            | VK_LEFT
            | VK_RIGHT
            | VK_UP
            | VK_DOWN
            | VK_HOME
            | VK_END
            | VK_PRIOR
            | VK_NEXT
    );
    let chord = (m.ctrl || m.alt || m.meta) && !crate::keymap::modifier(event.vk);
    if (event.down && !(edits || chord)) || !armed(surface) {
        return false;
    }
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let Some(focus) = map.get_mut(&surface.key()) else {
            return false;
        };
        if focus.pending.is_empty() {
            return false;
        }
        if !event.down
            && !focus
                .pending
                .iter()
                .rev()
                .find_map(|held| match held {
                    Held::Key(key) if key.vk == event.vk => Some(key.down),
                    _ => None,
                })
                .unwrap_or(false)
        {
            return false;
        }
        focus.pending.push_back(Held::Key(*event));
        true
    })
}

/// The app is taking `view` out. When the field with the keyboard is in
/// it, text typed before the next field takes the keyboard waits for that
/// field, as after an action that can move focus.
pub(crate) fn removing(surface: &Surface, view: &NshView) {
    let Some(field) = FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .and_then(|f| f.target.as_ref().map(|target| target.view().clone()))
    }) else {
        return;
    };
    let mut at = Some(field);
    while let Some(node) = at {
        if node == *view {
            arm(surface);
            return;
        }
        at = node.parent_view();
    }
}

/// Drops text waiting for a field. Escape, or the window going inactive.
pub(crate) fn disarm(surface: &Surface) {
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.pending.clear();
            focus.armed = false;
        }
    });
}

/// True while focus is moving or an action may deliver the next field.
fn armed(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .is_some_and(|focus| focus.changing || focus.armed)
    })
}

pub(crate) fn has_pending(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .is_some_and(|focus| !focus.pending.is_empty())
    })
}

/// Keeps an input operation while focus is moving or the engine has not
/// handled the action that can move it. IME ranges and composition updates
/// retain their meaning when replayed onto the settled field.
fn queue_if_unsettled(surface: &Surface, operation: impl FnOnce() -> Held) -> bool {
    if !armed(surface) {
        return false;
    }
    if focused_target(surface).is_some() {
        let (changing, waits) = FOCUS.with(|f| {
            f.borrow()
                .get(&surface.key())
                .map_or((false, false), |focus| {
                    (focus.changing, !focus.pending.is_empty())
                })
        });
        if !changing && !waits && !behind(surface) {
            // The target has the keyboard. It handles later input itself,
            // including ignoring text when it is not an editor.
            disarm(surface);
            return false;
        }
    }
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        map.entry(surface.key())
            .or_default()
            .pending
            .push_back(operation());
    });
    true
}

/// Gives what waits to the focused field, in order. IME operations retain
/// their composition and replacement semantics; keys run as if typed now.
/// It stops while the engine has not handled a key that armed the queue
/// again, and with no field yet,
/// while the queue is armed. A field taking the last of it ends the wait.
fn flush_pending(surface: &Rc<Surface>) {
    if !armed(surface) && !wants_text(surface) {
        disarm(surface);
    }
    let mut taken = false;
    loop {
        if behind(surface) {
            return;
        }
        let next = FOCUS.with(|f| {
            f.borrow_mut()
                .get_mut(&surface.key())
                .and_then(|focus| focus.pending.pop_front())
        });
        let Some(next) = next else {
            break;
        };
        if matches!(&next, Held::Replace { .. } | Held::Mark { .. })
            && !ime::field(surface).is_some_and(|(_, input)| input.config.borrow().editable)
        {
            if armed(surface) {
                FOCUS.with(|f| {
                    let mut map = f.borrow_mut();
                    map.entry(surface.key())
                        .or_default()
                        .pending
                        .push_front(next);
                });
            }
            return;
        }
        match next {
            Held::Replace { range, text } => ime::replace_text_now(surface, range, &text),
            Held::Mark {
                range,
                text,
                selected,
            } => ime::mark_text_now(surface, range, &text, selected),
            Held::Unmark => ime::unmark_text_now(surface),
            Held::Key(event) => {
                crate::input::key_now(surface, event);
            }
        }
        taken = true;
    }
    if taken && !behind(surface) {
        disarm(surface);
    }
}

/// The surface's focus in its window (the window is active and the
/// surface's view has GPUI's focus): the focused field keeps the focus
/// when it goes (an app in the background keeps its field), without a
/// caret. Called on every frame; only changes act (true: the field drawn
/// in this frame shows its caret wrong, draw another).
pub(crate) fn window_focus(surface: &Rc<Surface>, has_focus: bool) -> bool {
    let changed = FOCUS.with(|f| {
        let mut f = f.borrow_mut();
        let entry = f.entry(surface.key()).or_default();
        let changed = entry.inactive == has_focus;
        entry.inactive = !has_focus;
        if changed {
            entry.admission = Rc::new(());
        }
        changed
    });
    if changed && !has_focus {
        disarm(surface);
    }
    if !changed {
        return false;
    }
    blink::update();
    let Some(view) = focused(surface) else {
        return false;
    };
    let Some(input) = input_of(&view) else {
        return false;
    };
    input.active.set(has_focus);
    input.drag.set(None);
    input.caret_on.set(true);
    view.changed();
    true
}

/// The surface with `key` stopped (its app or its view went): its focus
/// is forgotten, so neither the field nor the caret's timer outlive it.
pub(crate) fn surface_stopped(key: u64) {
    FOCUS.with(|f| f.borrow_mut().remove(&key));
    blink::update();
}

/// True while the surface's current focused field accepts text input.
pub(crate) fn wants_text(surface: &Surface) -> bool {
    focused(surface)
        .and_then(|v| input_of(&v))
        .is_some_and(|input| input.config.borrow().editable)
}

// --- The input method ---------------------------------------------------------

/// GPUI's input handler calls ([`crate::app::AppView`]'s
/// `EntityInputHandler`), for the surface's focused field. Ranges are
/// UTF-16 offsets of the field's text with the composition in it at the
/// caret (what the input method sees); the marked range is the
/// composition.
pub(crate) mod ime {
    use super::*;

    /// The focused field and its input.
    pub(super) fn field(surface: &Surface) -> Option<(NshView, Rc<InputState>)> {
        let view = focused(surface)?;
        let input = input_of(&view)?;
        Some((view, input))
    }

    /// The live native field, independent of the surface's shared GPUI focus.
    pub(crate) fn target(surface: &Surface) -> Option<gpui::TextInputTarget> {
        let (_, input) = field(surface)?;
        FOCUS.with(|focuses| {
            focuses
                .borrow()
                .get(&surface.key())
                .map(|focus| gpui::TextInputTarget::from_field(&input, &focus.admission))
        })
    }

    /// The UTF-16 range of the composition, if there is one.
    pub(super) fn marked(model: &Model) -> Option<Range<usize>> {
        let c = model.composition.as_ref().filter(|c| !c.text.is_empty())?;
        let start = model::byte_to_utf16(model.text(), model.caret()) as usize;
        Some(start..start + model::utf16_len(&c.text))
    }

    /// The byte range of the text (without the composition) at UTF-16
    /// range `range` of what the input method sees.
    fn text_range(model: &Model, range: &Range<usize>) -> (usize, usize) {
        let at = |u: usize| model.text_at(u as u32, false);
        let (s, e) = (at(range.start), at(range.end));
        (s.min(e), s.max(e))
    }

    /// `text_for_range`: nothing of a password.
    pub(crate) fn text_for_range(
        surface: &Surface,
        range: Range<usize>,
        adjusted: &mut Option<Range<usize>>,
    ) -> Option<String> {
        let (_, input) = field(surface)?;
        if input.secure() {
            return None;
        }
        let model = input.model.borrow();
        let shown = model.display();
        let s = utf16_to_byte(&shown, range.start as u32);
        let e = utf16_to_byte(&shown, range.end as u32).max(s);
        *adjusted = Some(
            model::byte_to_utf16(&shown, s) as usize..model::byte_to_utf16(&shown, e) as usize,
        );
        Some(shown[s..e].to_owned())
    }

    /// `selected_text_range`: the selection, or the caret in the
    /// composition while there is one.
    pub(crate) fn selected_text_range(surface: &Surface) -> Option<gpui::UTF16Selection> {
        let (_, input) = field(surface)?;
        let model = input.model.borrow();
        if marked(&model).is_some() {
            let at = model.display_caret(false) as usize;
            return Some(gpui::UTF16Selection {
                range: at..at,
                reversed: false,
            });
        }
        let text = model.text();
        let (s, e) = model.selection();
        Some(gpui::UTF16Selection {
            range: model::byte_to_utf16(text, s) as usize..model::byte_to_utf16(text, e) as usize,
            reversed: s < e && model.caret() == s,
        })
    }

    /// `marked_text_range`.
    pub(crate) fn marked_text_range(surface: &Surface) -> Option<Range<usize>> {
        let (_, input) = field(surface)?;
        let model = input.model.borrow();
        marked(&model)
    }

    /// `unmark_text`: what is composed is kept, as typed.
    pub(crate) fn unmark_text(surface: &Rc<Surface>) {
        if super::has_pending(surface) && super::queue_if_unsettled(surface, || Held::Unmark) {
            return;
        }
        unmark_text_now(surface);
    }

    pub(super) fn unmark_text_now(surface: &Rc<Surface>) {
        let Some((view, input)) = field(surface) else {
            return;
        };
        let text = input
            .model
            .borrow_mut()
            .composition
            .take()
            .map(|c| c.text)
            .unwrap_or_default();
        input.relayout();
        if text.is_empty() {
            input.reveal();
            view.changed();
        } else {
            insert(surface, &view, &input, &text, true);
        }
        report_composition(surface, &view, &input);
    }

    /// `replace_text_in_range`: typed or committed text replaces the
    /// composition, else `range` (if given), else the selection.
    pub(crate) fn replace_text_in_range(
        surface: &Rc<Surface>,
        range: Option<Range<usize>>,
        text: &str,
    ) {
        // Control characters are keys; an empty replacement can end a composition.
        if !text.is_empty() && text.chars().all(char::is_control) {
            replace_text_now(surface, range, text);
            return;
        }
        if text.is_empty() && range.is_none() && !super::has_pending(surface) {
            replace_text_now(surface, range, text);
            return;
        }
        if super::queue_if_unsettled(surface, || Held::Replace {
            range: range.clone(),
            text: text.to_owned(),
        }) {
            return;
        }
        replace_text_now(surface, range, text);
    }

    pub(super) fn replace_text_now(surface: &Rc<Surface>, range: Option<Range<usize>>, text: &str) {
        let Some((view, input)) = field(surface) else {
            return;
        };
        let composed = input.model.borrow_mut().composition.take().is_some();
        if composed {
            input.relayout();
        } else if let Some(range) = &range {
            let mut model = input.model.borrow_mut();
            let (s, e) = text_range(&model, range);
            model.select(s, e);
        }
        // Control characters are keys (Return, Backspace, Tab, Escape),
        // handled (or not) as such.
        let text: String = text.chars().filter(|c| !c.is_control()).collect();
        if text.is_empty() {
            if composed {
                input.reveal();
                view.changed();
                report_composition(surface, &view, &input);
            }
            return;
        }
        insert(surface, &view, &input, &text, true);
        if composed {
            // After the committed text's `onChangeText`.
            report_composition(surface, &view, &input);
        }
    }

    /// `replace_and_mark_text_in_range`: the composition becomes
    /// `text`, its caret (and converted clause) at `selected` (UTF-16 in
    /// `text`); empty text ends it. What starts a composition replaces
    /// the selection (or `range`).
    pub(crate) fn replace_and_mark_text_in_range(
        surface: &Rc<Surface>,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
    ) {
        if text.is_empty() && range.is_none() && !super::has_pending(surface) {
            mark_text_now(surface, range, text, selected);
            return;
        }
        if super::queue_if_unsettled(surface, || Held::Mark {
            range: range.clone(),
            text: text.to_owned(),
            selected: selected.clone(),
        }) {
            return;
        }
        mark_text_now(surface, range, text, selected);
    }

    pub(super) fn mark_text_now(
        surface: &Rc<Surface>,
        range: Option<Range<usize>>,
        text: &str,
        selected: Option<Range<usize>>,
    ) {
        let Some((view, input)) = field(surface) else {
            return;
        };
        if !input.config.borrow().editable {
            return;
        }
        let starts = input.model.borrow().composition.is_none();
        if starts && !text.is_empty() {
            if let Some(range) = &range {
                let mut model = input.model.borrow_mut();
                let (s, e) = text_range(&model, range);
                model.select(s, e);
            }
            if input.model.borrow().has_selection() {
                let deleted = input.model.borrow_mut().delete(Unit::Char, false);
                after_edit(surface, &view, &input, deleted);
            }
        }
        input.model.borrow_mut().composition = composition(text, selected);
        input.relayout();
        input.goal_x.set(None);
        input.wake_caret();
        input.reveal();
        view.changed();
        report_composition(surface, &view, &input);
    }

    /// `bounds_for_range`: where the range shows, in window coordinates
    /// (input methods put their candidates below it).
    pub(crate) fn bounds_for_range(
        surface: &Surface,
        range: Range<usize>,
    ) -> Option<gpui::Bounds<gpui::Pixels>> {
        let (view, input) = field(surface)?;
        let (start, end) = {
            let model = input.model.borrow();
            if input.secure() {
                // Bullets: one shown unit per character.
                let shown = model.display();
                let units = |u: usize| {
                    let b = utf16_to_byte(&shown, u as u32);
                    shown[..b].chars().count() as u32
                };
                (units(range.start), units(range.end))
            } else {
                (range.start as u32, range.end as u32)
            }
        };
        let (x0, y0, h) = input.caret_rect(Some(start))?;
        let (x1, y1, _) = input.caret_rect(Some(end))?;
        let x1 = if y1 == y0 { x1.max(x0) } else { x0 };
        let content = content_rect(&view, &input);
        let caret = crate::geom::rect(
            content.origin.x.0 + x0,
            content.origin.y.0 + y0,
            x1 - x0 + CARET_WIDTH,
            h,
        )
        .intersect(&content);
        if caret.size.width.0 <= 0.0 || caret.size.height.0 <= 0.0 {
            return None;
        }
        let rectangle =
            |x: f32, y: f32, w: f32, h: f32| [(x, y), (x + w, y), (x + w, y + h), (x, y + h)];
        let mut polygon = rectangle(
            caret.origin.x.0,
            caret.origin.y.0,
            caret.size.width.0,
            caret.size.height.0,
        )
        .to_vec();
        let mut current = view;
        loop {
            let state = current.state();
            if state.opacity() <= 0.0 {
                return None;
            }
            if state.clips() {
                polygon = crate::decor::shape::clip_convex(
                    &polygon,
                    &rectangle(
                        0.0,
                        0.0,
                        state.frame.size.width.0,
                        state.frame.size.height.0,
                    ),
                );
                if polygon.is_empty() {
                    return None;
                }
            }
            let Some(parent) = current.parent_view() else {
                break;
            };
            let (x, y) = parent.state().child_origin(state.frame, state.shift);
            let mut transform = crate::geom::Mat4::new().translate(x, y);
            if let Some(local) = state.transform() {
                transform = crate::geom::Mat4::mul(&local, &transform);
            }
            drop(state);
            for point in &mut polygon {
                *point = transform.map(point.0, point.1)?;
            }
            current = parent;
        }
        let (width, height) = surface.size();
        let polygon =
            crate::decor::shape::clip_convex(&polygon, &rectangle(0.0, 0.0, width, height));
        let (mut left, mut top, mut right, mut bottom) = (
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        );
        for (x, y) in polygon {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
        if left >= right || top >= bottom {
            return None;
        }
        let (ox, oy) = surface.origin.get();
        Some(crate::render::bounds(
            ox + left,
            oy + top,
            right - left,
            bottom - top,
        ))
    }

    /// `character_index_for_point` (window coordinates).
    pub(crate) fn character_index_for_point(
        surface: &Surface,
        point: gpui::Point<gpui::Pixels>,
    ) -> Option<usize> {
        let (view, input) = field(surface)?;
        let (ox, oy) = surface.origin.get();
        let m = view.to_root()?;
        let (x, y) = m.unproject(f32::from(point.x) - ox, f32::from(point.y) - oy)?;
        let content = content_rect(&view, &input);
        let at = input.hit(x - content.origin.x.0, y - content.origin.y.0, true);
        let model = input.model.borrow();
        Some(model::byte_to_utf16(model.text(), at) as usize)
    }

    /// `set_selected_text_range`.
    pub(crate) fn set_selected_text_range(surface: &Rc<Surface>, range: Range<usize>) {
        let Some((view, input)) = field(surface) else {
            return;
        };
        if input.composing() {
            return;
        }
        {
            let mut model = input.model.borrow_mut();
            let (s, e) = text_range(&model, &range);
            model.select(s, e);
        }
        input.goal_x.set(None);
        after_edit(surface, &view, &input, false);
    }

    /// `text_length_utf16`.
    pub(crate) fn text_length_utf16(surface: &Surface) -> Option<usize> {
        let (_, input) = field(surface)?;
        let model = input.model.borrow();
        Some(model::utf16_len(&model.display()))
    }

    /// `text_input_configuration`: what the field wants of input methods
    /// and on-screen keyboards.
    pub(crate) fn configuration(surface: &Surface) -> gpui::TextInputConfiguration {
        let Some((_, input)) = field(surface) else {
            return Default::default();
        };
        let c = input.config.borrow();
        configuration_of(&c)
    }
}

/// The composition `text` with its caret (and converted clause) at
/// `selected` (UTF-16 in `text`); `None` when the text is empty.
fn composition(text: &str, selected: Option<Range<usize>>) -> Option<Composition> {
    if text.is_empty() {
        return None;
    }
    let (cursor, target) = match selected {
        Some(r) => {
            let (s, e) = (
                utf16_to_byte(text, r.start as u32),
                utf16_to_byte(text, r.end as u32),
            );
            (e, (s < e).then_some((s, e)))
        }
        None => (text.len(), None),
    };
    Some(Composition::new(text.to_owned(), cursor, target))
}

/// What a field's config asks of input methods and on-screen keyboards.
fn configuration_of(c: &InputConfig) -> gpui::TextInputConfiguration {
    use gpui::{Autocapitalize, TextInputAction};
    let plain = !c.secure;
    gpui::TextInputConfiguration {
        autocorrect: c.auto_correct && plain,
        autocapitalize: match c.auto_capitalize {
            _ if !plain => Autocapitalize::None,
            AutoCapitalize::None => Autocapitalize::None,
            AutoCapitalize::Sentences => Autocapitalize::Sentences,
            AutoCapitalize::Words => Autocapitalize::Words,
            AutoCapitalize::Characters => Autocapitalize::Characters,
        },
        suggestions: c.auto_correct && plain,
        input_action: match c.return_key {
            ReturnKeyType::Default if c.multiline => TextInputAction::Enter,
            ReturnKeyType::Default => TextInputAction::Unspecified,
            ReturnKeyType::Done => TextInputAction::Done,
            ReturnKeyType::Go => TextInputAction::Go,
            ReturnKeyType::Next => TextInputAction::Next,
            ReturnKeyType::Search => TextInputAction::Search,
            ReturnKeyType::Send => TextInputAction::Send,
        },
    }
}

// --- Edits and events ----------------------------------------------------------

/// Sends `kind` if JS listens to it.
fn send(
    surface: &Surface,
    view: &NshView,
    kind: EventKind,
    payload: impl FnOnce() -> EventPayload,
) {
    let (id, listens) = {
        let s = view.state();
        (s.id, s.events.contains(kind))
    };
    if listens {
        surface.event(id, kind, payload());
    }
}

fn key_press(surface: &Surface, view: &NshView, key: &str) {
    send(surface, view, EventKind::KeyPress, || {
        EventPayload::Map(vec![("key", PayloadValue::Str(key.to_owned()))])
    });
}

/// Reports the selection if it moved and JS listens, then the caret.
fn report_selection(surface: &Surface, view: &NshView, input: &InputState) {
    if view.state().events.contains(EventKind::SelectionChange) {
        let range = {
            let model = input.model.borrow();
            let (s, e) = model.selection();
            let text = model.text();
            (model::byte_to_utf16(text, s), model::byte_to_utf16(text, e))
        };
        if input.reported.replace(range) != range {
            send(surface, view, EventKind::SelectionChange, || {
                EventPayload::Map(vec![
                    ("start", PayloadValue::Number(range.0 as f64)),
                    ("end", PayloadValue::Number(range.1 as f64)),
                ])
            });
        }
    }
    report_caret(surface, view, input);
}

/// `onCaretMove` if the caret moved (with the selection, or as the text
/// scrolled or wrapped again) and JS listens.
fn report_caret(surface: &Surface, view: &NshView, input: &InputState) {
    // Only an input that edits shows a caret.
    if !input.focused.get() || !view.state().events.contains(EventKind::CaretMove) {
        return;
    }
    let caret: nsh_core::Bounds<Points> = caret_bounds(view, input);
    if input.reported_caret.replace(caret) != caret {
        send(surface, view, EventKind::CaretMove, || {
            EventPayload::caret(caret)
        });
    }
}

/// The caret in the input view's coordinates (`onCaretMove`'s `bounds`):
/// in the content box, scrolled with the text.
fn caret_bounds(view: &NshView, input: &InputState) -> nsh_core::Bounds<Points> {
    let Some((x, y, h)) = input.caret_rect(None) else {
        return nsh_core::Bounds::default();
    };
    let content = content_rect(view, input);
    nsh_core::Bounds {
        origin: nsh_core::geometry::point(
            content.origin.x + Points(x),
            content.origin.y + Points(y),
        ),
        size: nsh_core::geometry::size(Points(CARET_WIDTH), Points(h)),
    }
}

/// Reports the composition if it started, changed or ended since last
/// reported (and JS listens); once it ended, applies the value JS set
/// meanwhile. Called after every change of the composition, after the
/// `onChangeText` of what it committed.
fn report_composition(surface: &Surface, view: &NshView, input: &InputState) {
    let now = input
        .model
        .borrow()
        .composition
        .as_ref()
        .filter(|c| !c.text.is_empty())
        .map(|c| c.text.clone());
    if *input.composed.borrow() != now {
        input.composed.replace(now.clone());
        send(surface, view, EventKind::CompositionChange, || {
            EventPayload::Map(vec![
                ("composing", PayloadValue::Bool(now.is_some())),
                ("text", PayloadValue::Str(now.unwrap_or_default())),
            ])
        });
    }
    if input.composed.borrow().is_none() {
        let pending = input.pending.borrow_mut().take();
        if let Some((text, count)) = pending {
            set_value(view, input, &text, count);
        }
    }
}

/// After a user edit (`changed`: the text changed) or a caret movement:
/// reports the text with a new edit count, then the selection, and shows
/// the caret.
fn after_edit(surface: &Surface, view: &NshView, input: &InputState, changed: bool) {
    if changed {
        input.relayout();
        let count = input.count.get() + 1;
        input.count.set(count);
        let text = input.model.borrow().text().to_owned();
        // Always reported: the engine keeps the text for layout and for
        // dropping stale values, whether JS listens or not.
        surface.event(
            view.id(),
            EventKind::ChangeText,
            EventPayload::Text { text, count },
        );
    }
    input.wake_caret();
    input.reveal();
    report_selection(surface, view, input);
    view.changed();
}

/// Inserts typed, pasted or composed text (clipped to `maxLength`);
/// `typed` text is reported as a key press.
fn insert(surface: &Surface, view: &NshView, input: &InputState, text: &str, typed: bool) {
    if !input.config.borrow().editable {
        return;
    }
    let max = input.config.borrow().max_length;
    let inserted = input.model.borrow_mut().insert_input(text, max, typed);
    input.goal_x.set(None);
    if let Some(fit) = &inserted
        && !fit.is_empty()
        && typed
    {
        key_press(surface, view, key_of(fit));
    }
    after_edit(surface, view, input, inserted.is_some());
}

/// Return submitted the input (`blur`: and unfocuses it).
fn submit(surface: &Rc<Surface>, view: &NshView, input: &InputState, blur: bool) {
    key_press(surface, view, "Enter");
    let text = input.model.borrow().text().to_owned();
    let count = input.count.get();
    send(surface, view, EventKind::SubmitEditing, || {
        EventPayload::Text { text, count }
    });
    // A submit may move focus, so text typed after it waits.
    arm(surface);
    if blur {
        set_focus(surface, None);
    }
}

/// What a return with `modifiers` does in an input whose return does
/// `behavior`: `None` inserts a line break, `Some(blur)` submits (and
/// unfocuses). Shift+Return and Alt+Return break the line of a multiline
/// input that submits, as in desktop chat apps.
fn return_key(behavior: SubmitBehavior, multiline: bool, modifiers: Modifiers) -> Option<bool> {
    match behavior {
        _ if multiline && (modifiers.shift || modifiers.alt) => None,
        SubmitBehavior::Newline if multiline => None,
        SubmitBehavior::Submit => Some(false),
        SubmitBehavior::BlurAndSubmit | SubmitBehavior::Newline => Some(true),
    }
}

// --- Contracts -----------------------------------------------------------------

/// Sets up an input view.
pub(crate) fn create(surface: &Rc<Surface>, view: &NshView) {
    let system = surface.text_system.borrow().clone();
    let input = Rc::new(InputState::new(surface.key(), system));
    input.active.set(window_active(surface));
    view.state_mut().input = Some(input);
}

/// `Input`.
pub(crate) fn config(surface: &Rc<Surface>, view: &NshView, config: &InputConfig) {
    let Some(input) = input_of(view) else {
        return;
    };
    {
        let old = input.config.borrow();
        let font_changed = old.style != config.style || old.multiline != config.multiline;
        let shown_changed = font_changed
            || old.secure != config.secure
            || old.align != config.align
            || old.rtl != config.rtl;
        drop(old);
        if font_changed {
            input.style.borrow_mut().take();
        }
        if shown_changed {
            input.relayout();
        }
        input.placeholder.borrow_mut().take();
        if config.multiline != input.multiline() {
            input.scroll.set(0.0);
        }
    }
    let editable_changed = input.config.borrow().editable != config.editable;
    let tokens_changed = input.model.borrow_mut().set_tokens(&config.tokens);
    *input.config.borrow_mut() = config.clone();
    if tokens_changed {
        // Token styles leave shaping and line metrics intact. The model
        // may move a selection off a newly atomic range.
        input.reveal();
        report_selection(surface, view, &input);
        view.changed();
    }
    if editable_changed && input.focused.get() {
        // The input handler comes or goes with the next frame.
        surface.invalidate();
    }
    let first = !input.configured.replace(true);
    if first && config.auto_focus {
        auto_focus(surface, view);
    }
    place(view, &input);
}

/// Focuses the field once it is mounted. An input may be configured before
/// insertion; reconcile that request after the batch, in command order.
fn auto_focus(surface: &Rc<Surface>, view: &NshView) {
    surface.pending_auto_focus.borrow_mut().take();
    if view.attached() {
        return set_focus(surface, Some(view));
    }
    *surface.pending_auto_focus.borrow_mut() = Some(view.clone());
}

/// Applies the latest still-live request before navigation chooses a
/// default focus. Detached inputs wait for an insertion, not a frame retry.
pub(crate) fn apply_auto_focus(surface: &Rc<Surface>) {
    let Some(view) = surface.pending_auto_focus.borrow_mut().take() else {
        return;
    };
    if surface.view(view.id()).as_ref() != Some(&view) {
        return;
    }
    if view.attached() {
        crate::input::focus_view(surface, &view);
    } else {
        *surface.pending_auto_focus.borrow_mut() = Some(view);
    }
}

/// The content box in the view.
fn content_rect(view: &NshView, input: &InputState) -> nsh_core::Bounds<Points> {
    input.content.get().unwrap_or_else(|| {
        let f = view.state().frame;
        nsh_core::Bounds {
            origin: nsh_core::Point {
                x: Points(0.0),
                y: Points(0.0),
            },
            size: nsh_core::Size {
                width: f.size.width,
                height: f.size.height,
            },
        }
    })
}

/// Hosts the editor at the content box.
fn place(view: &NshView, input: &Rc<InputState>) {
    let content = content_rect(view, input);
    if content.size.width.0 <= 0.0 || content.size.height.0 <= 0.0 {
        return;
    }
    input.set_size((content.size.width.0, content.size.height.0));
    let item: Rc<dyn Hosted> = input.clone();
    view.set_native(&item, content);
}

/// `InputValue`: JS's text, unless the user typed since JS saw `count`.
/// While the input method composes, the value waits for the composition
/// to end (the newest one; whether it is stale is decided then).
pub(crate) fn value(view: &NshView, text: &str, count: u32) {
    let Some(input) = input_of(view) else {
        return;
    };
    if input.composing() {
        input.pending.replace(Some((text.to_owned(), count)));
        return;
    }
    set_value(view, &input, text, count);
}

/// The value JS set that waits for the composition to end (tests).
#[cfg(all(test, feature = "shot"))]
pub(crate) fn pending_value(view: &NshView) -> Option<String> {
    let input = input_of(view)?;
    let pending = input.pending.borrow();
    pending.as_ref().map(|(text, _)| text.clone())
}

/// Applies JS's `text` unless the user edited since JS saw `count`.
fn set_value(view: &NshView, input: &InputState, text: &str, count: u32) {
    if count < input.count.get() || input.model.borrow().text() == text {
        return;
    }
    input.model.borrow_mut().set_text(text);
    input.relayout();
    if input.focused.get() {
        input.reveal();
    }
    view.changed();
}

/// The view's animated values changed (a frame of a native animation):
/// the text takes an animated color.
pub(crate) fn animated(view: &NshView) {
    let (input, color) = {
        let s = view.state();
        let Some(input) = s.input.clone() else { return };
        (input, s.anim.color)
    };
    if input.anim_color.replace(color) != color {
        view.changed();
    }
}

/// `InputContent`: where the text goes inside the view.
pub(crate) fn content(view: &NshView, content: nsh_core::Bounds<Points>) {
    let Some(input) = input_of(view) else {
        return;
    };
    input.content.set(Some(content));
    place(view, &input);
    if input.focused.get() {
        input.reveal();
        if let Some(surface) = surface_of(view) {
            report_caret(&surface, view, &input);
        }
    }
}

/// An input accessory inserted into `parent`. There is no software
/// keyboard to show it over on the desktop, so it stays unmounted.
pub(crate) fn accessory(_surface: &Rc<Surface>, _parent: &NshView, child: &NshView) {
    log::debug!("input accessory {} is not shown on the desktop", child.id());
}

/// The surface of an input view.
fn surface_of(view: &NshView) -> Option<Rc<Surface>> {
    let key = view.state().input.as_ref()?.surface;
    Surface::by_key(key)
}

/// `focus()`.
pub(crate) fn focus(view: &NshView) {
    if let Some(surface) = surface_of(view) {
        focus_view(&surface, view);
    }
}

/// Focuses a caller-eligible view in its supplied surface.
pub(crate) fn focus_view(surface: &Rc<Surface>, view: &NshView) {
    set_focus(surface, Some(view));
}

/// `blur()`.
pub(crate) fn blur(view: &NshView) {
    if let Some(surface) = surface_of(view) {
        blur_view(&surface, view);
    }
}

/// Blurs `view` only while it owns its supplied surface's focus.
pub(crate) fn blur_view(surface: &Rc<Surface>, view: &NshView) {
    if focused_view(surface).as_ref() == Some(view) {
        set_focus(surface, None);
    }
}

/// Blurs whatever view has the focus.
pub(crate) fn blur_all(surface: &Rc<Surface>) {
    set_focus(surface, None);
    if !has_pending(surface) {
        disarm(surface);
    }
}

/// Focuses a caller-eligible Tab stop, selecting text only for an input.
pub(crate) fn tab_to_view(surface: &Rc<Surface>, view: &NshView) {
    set_focus(surface, Some(view));
    if let Some(input) = input_of(view)
        && input.focused.get()
    {
        input.model.borrow_mut().select_all();
        after_edit(surface, view, &input, false);
    }
}

/// `setSelection` (UTF-16 offsets).
pub(crate) fn set_selection(view: &NshView, start: u32, end: u32) {
    let Some(input) = input_of(view) else {
        return;
    };
    {
        let mut model = input.model.borrow_mut();
        let text = model.text();
        let (s, e) = (utf16_to_byte(text, start), utf16_to_byte(text, end));
        model.select(s, e);
    }
    input.goal_x.set(None);
    if input.focused.get() {
        input.wake_caret();
        input.reveal();
    }
    if let Some(surface) = surface_of(view) {
        report_selection(&surface, view, &input);
    }
    view.changed();
}

/// One guarded, undoable application edit of this native input.
pub(crate) fn replace_range(surface: &Rc<Surface>, view: &NshView, command: &nsh_core::Command) {
    let nsh_core::Command::ReplaceRange {
        range,
        text,
        expected_text,
        expected_selection,
        count,
    } = command
    else {
        return;
    };
    let Some(input) = input_of(view) else {
        return;
    };
    if !input.focused.get()
        || !input.active.get()
        || !input.config.borrow().editable
        || !crate::input::focusable(surface, view)
        || input.count.get() != *count
    {
        return;
    }
    let (changed, selection_changed) = {
        let mut model = input.model.borrow_mut();
        let before = model.selection();
        let observed = model::byte_to_utf16(model.text(), before.0)
            ..model::byte_to_utf16(model.text(), before.1);
        if model.composition.is_some()
            || model.text() != expected_text
            || observed != *expected_selection
            || range.start > range.end
        {
            return;
        }
        let start = model::utf16_to_byte(model.text(), range.start);
        let end = model::utf16_to_byte(model.text(), range.end);
        if model::byte_to_utf16(model.text(), start) != range.start
            || model::byte_to_utf16(model.text(), end) != range.end
        {
            return;
        }
        let changed = model.replace_range(start..end, text, input.config.borrow().max_length);
        (changed, model.selection() != before)
    };
    if changed || selection_changed {
        input.goal_x.set(None);
        after_edit(surface, view, &input, changed);
    }
}

/// Characters typed into the focused field (the test agent's), as the
/// input handler's `replace_text_in_range` brings them.
#[cfg(any(feature = "dev", test))]
pub(crate) fn char_input(surface: &Rc<Surface>, text: &str) {
    ime::replace_text_in_range(surface, None, text);
}

/// An input method's composition in the focused field, as
/// `replace_and_mark_text_in_range` makes it; empty text ends it.
#[cfg(all(test, feature = "shot"))]
pub(crate) fn mark(surface: &Rc<Surface>, text: &str) {
    ime::replace_and_mark_text_in_range(surface, None, text, None);
}

/// A pointer event on input `view` (its coordinates); true when handled.
pub(crate) fn pointer(surface: &Rc<Surface>, view: &NshView, event: &ItemPointer) -> bool {
    let Some(input) = input_of(view) else {
        return false;
    };
    let content = content_rect(view, &input);
    let (x, y) = (event.x - content.origin.x.0, event.y - content.origin.y.0);
    match event.kind {
        PointerKind::Down => {
            if input.composing() && focused(surface).as_ref() == Some(view) {
                // What is composed is kept, where it was typed (GPUI resets
                // the input method on a press).
                ime::unmark_text(surface);
            }
            set_focus(surface, Some(view));
            let secure = input.secure();
            // Word/line selection needs the point inside the token; its
            // resulting range is made whole by the model. A single caret
            // instead targets only legal atomic boundaries.
            let at = input.hit(x, y, event.clicks <= 1 || secure);
            let drag = {
                let mut model = input.model.borrow_mut();
                match event.clicks {
                    0 | 1 => {
                        model.move_to(at, event.modifiers.shift);
                        Drag::Char
                    }
                    // A double click in a password selects it all: words
                    // would tell where its spaces are.
                    2 if !secure => {
                        let (s, e) = model.word_at(at);
                        model.select(s, e);
                        Drag::Word(s, e)
                    }
                    _ => {
                        let (s, e) = if input.multiline() && !secure {
                            model.line_at(at)
                        } else {
                            (0, model.text().len())
                        };
                        model.select(s, e);
                        Drag::Line(s, e)
                    }
                }
            };
            input.drag.set(Some(drag));
            input.goal_x.set(None);
            after_edit(surface, view, &input, false);
            true
        }
        PointerKind::Move => {
            let Some(drag) = input.drag.get() else {
                return false;
            };
            let at = input.hit(x, y, matches!(drag, Drag::Char));
            {
                let mut model = input.model.borrow_mut();
                match drag {
                    Drag::Char => model.move_to(at, true),
                    Drag::Word(s, e) | Drag::Line(s, e) => {
                        let (ws, we) = match drag {
                            Drag::Word(..) => model.word_at(at),
                            _ if input.multiline() => model.line_at(at),
                            _ => (0, model.text().len()),
                        };
                        if at < s {
                            model.select(e, ws);
                        } else {
                            model.select(s, we.max(e));
                        }
                    }
                }
            }
            after_edit(surface, view, &input, false);
            true
        }
        PointerKind::Up | PointerKind::Cancel => input.drag.take().is_some(),
        PointerKind::Leave => false,
    }
}

/// A wheel over input `view`: scrolls the lines of a multiline field that
/// do not fit. True when it scrolled (an outer scroll view does not).
pub(crate) fn wheel(view: &NshView, dy: f32) -> bool {
    let Some(input) = input_of(view) else {
        return false;
    };
    if !input.multiline() {
        return false;
    }
    let Some(layout) = input.layout() else {
        return false;
    };
    let before = input.scroll.get();
    input.scroll.set(before + dy);
    input.origin(&layout);
    let moved = input.scroll.get() != before;
    if moved {
        view.changed();
        if input.focused.get()
            && let Some(surface) = surface_of(view)
        {
            report_caret(&surface, view, &input);
        }
    }
    moved
}

/// A right click on field `view`: it takes the focus (keeping its
/// selection) and shows the edit menu, each item the field's own key.
/// The menu is made once the app is at hand (Paste is enabled by what
/// the clipboard holds).
pub(crate) fn context_menu(surface: &Rc<Surface>, view: &NshView) {
    if input_of(view).is_none() {
        return;
    }
    if focused(surface).as_ref() != Some(view) {
        set_focus(surface, Some(view));
    }
    let key = surface.key();
    let view = view.clone();
    crate::rt::on_app(move |cx| {
        let item = cx.read_from_clipboard();
        // Images and files paste too while the app listens to pastes.
        let listens = view.state().events.contains(EventKind::Paste);
        let has_text = item
            .as_ref()
            .and_then(|item| item.text())
            .is_some_and(|t| !t.is_empty())
            || (listens
                && item.iter().flat_map(|item| item.entries()).any(|entry| {
                    matches!(
                        entry,
                        gpui::ClipboardEntry::Image(_) | gpui::ClipboardEntry::ExternalPaths(_)
                    )
                }));
        if let Some(surface) = Surface::by_key(key)
            && let Some(input) = input_of(&view)
        {
            crate::chrome::popup_actions(&surface, menu_items(&input, has_text));
        }
    });
}

/// The edit menu of a field (`has_text`: the clipboard holds text).
fn menu_items(input: &InputState, has_text: bool) -> Vec<crate::chrome::LocalItem> {
    use nsh_core::desktop::MenuRole;

    use crate::chrome::LocalItem;
    let (editable, secure) = {
        let c = input.config.borrow();
        (c.editable, c.secure)
    };
    let (selected, can_undo, empty, all) = {
        let m = input.model.borrow();
        let (s, e) = m.selection();
        (
            m.has_selection(),
            m.can_undo(),
            m.text().is_empty(),
            s == 0 && e == m.text().len(),
        )
    };
    let item = |role: Option<MenuRole>, label: &'static str, enabled: bool, vk: u16, cmd: bool| {
        LocalItem::Item {
            role,
            label,
            enabled,
            action: Rc::new(move |s: &Rc<Surface>| {
                let event = KeyEvent {
                    vk,
                    down: true,
                    repeat: false,
                    modifiers: if cmd {
                        command(s.environment.get().uses_apple_keys())
                    } else {
                        Modifiers::default()
                    },
                };
                key(s, &event);
            }),
        }
    };
    vec![
        item(Some(MenuRole::Undo), "", editable && can_undo, 0x5A, true),
        LocalItem::Separator,
        item(
            Some(MenuRole::Cut),
            "",
            editable && selected && !secure,
            0x58,
            true,
        ),
        item(Some(MenuRole::Copy), "", selected && !secure, 0x43, true),
        item(Some(MenuRole::Paste), "", editable && has_text, 0x56, true),
        item(None, "Delete", editable && selected, VK_DELETE, false),
        LocalItem::Separator,
        item(Some(MenuRole::SelectAll), "", !empty && !all, 0x41, true),
    ]
}

/// The modifiers of the platform's command key alone.
fn command(apple: bool) -> Modifiers {
    if apple {
        Modifiers {
            meta: true,
            ..Default::default()
        }
    } else {
        Modifiers {
            ctrl: true,
            ..Default::default()
        }
    }
}

/// The platform's command key (Ctrl; Command on macOS) is held, with no
/// Alt.
fn is_command(m: Modifiers, apple: bool) -> bool {
    !m.alt
        && if apple {
            m.meta && !m.ctrl
        } else {
            m.ctrl && !m.meta
        }
}

/// How far the arrows and deletions with `m` go: a word with Ctrl (Option
/// on macOS).
fn unit_of(m: Modifiers, apple: bool) -> Unit {
    let word = if apple { m.alt } else { m.ctrl };
    if word { Unit::Word } else { Unit::Char }
}

/// A key for the focused field; true when handled.
pub(crate) fn key(surface: &Rc<Surface>, event: &KeyEvent) -> bool {
    if !event.down {
        return false;
    }
    let Some(view) = focused(surface) else {
        return false;
    };
    let Some(input) = input_of(&view) else {
        return false;
    };
    let m = event.modifiers;
    let (editable, secure, multiline) = {
        let c = input.config.borrow();
        (c.editable, c.secure, c.multiline)
    };
    let mac = surface.environment.get().uses_apple_keys();
    let unit = unit_of(m, mac);
    let vk = event.vk;
    // Movements: the caret goes, the text stays.
    let moved = |f: &dyn Fn(&mut Model)| {
        f(&mut input.model.borrow_mut());
        after_edit(surface, &view, &input, false);
        true
    };
    // Command+Left / Right on macOS: the line's edges (Home / End's).
    let edge = mac && m.meta && (vk == VK_LEFT || vk == VK_RIGHT);
    match vk {
        // The input method takes the keys it composes with.
        _ if input.composing() => false,
        // Alt+Left goes back, from a field too (`navigation::key_pressed`),
        // except on macOS where Option moves by words.
        _ if (vk == VK_LEFT || vk == VK_RIGHT) && !edge && (!m.alt || mac) => {
            input.goal_x.set(None);
            moved(&|model| model.step(unit, vk == VK_RIGHT, m.shift))
        }
        _ if vk == VK_HOME || vk == VK_END || edge => {
            input.goal_x.set(None);
            let end = vk == VK_END || vk == VK_RIGHT;
            let to = if multiline && !(m.ctrl && !mac) {
                line_edge(&input, end)
            } else if end {
                input.model.borrow().text().len()
            } else {
                0
            };
            moved(&|model| model.move_to(to, m.shift))
        }
        // Command+Up / Down on macOS: the text's edges.
        _ if mac && m.meta && (vk == VK_UP || vk == VK_DOWN) => {
            input.goal_x.set(None);
            let to = if vk == VK_DOWN {
                input.model.borrow().text().len()
            } else {
                0
            };
            moved(&|model| model.move_to(to, m.shift))
        }
        _ if multiline && (vk == VK_UP || vk == VK_DOWN || vk == VK_PRIOR || vk == VK_NEXT) => {
            let page = vk == VK_PRIOR || vk == VK_NEXT;
            let down = vk == VK_DOWN || vk == VK_NEXT;
            let to = vertical(&input, down, page);
            moved(&|model| model.move_to(to, m.shift))
        }
        _ if vk == VK_BACK || vk == VK_DELETE => {
            if !editable {
                return true;
            }
            if vk == VK_DELETE && m.shift && !m.ctrl {
                // Shift+Delete cuts, as in Windows' and GTK's editors.
                return cut(surface, &view, &input, secure);
            }
            let (deleted, empty) = {
                let mut model = input.model.borrow_mut();
                let empty = model.text().is_empty();
                if mac && m.meta && !model.has_selection() {
                    // Command+Backspace deletes to the line's start.
                    let caret = model.caret();
                    let (start, end) = model.line_at(caret);
                    let to = if vk == VK_BACK { start } else { end };
                    model.move_to(to, true);
                }
                (model.delete(unit, vk == VK_DELETE), empty)
            };
            // Backspace in an empty field deletes nothing but is still a
            // key press.
            if deleted || empty {
                key_press(surface, &view, "Backspace");
            }
            input.goal_x.set(None);
            after_edit(surface, &view, &input, deleted);
            true
        }
        _ if vk == VK_RETURN => {
            let behavior = input.config.borrow().submit();
            match return_key(behavior, multiline, m) {
                None => {
                    let ending = model::line_ending(input.model.borrow().text());
                    insert(surface, &view, &input, ending, true);
                }
                Some(blur) => submit(surface, &view, &input, blur),
            }
            true
        }
        // Reported as on the other desktops; navigation then takes the
        // focus from the field (`navigation::key_pressed`).
        _ if vk == VK_ESCAPE => {
            if !m.ctrl && !m.alt && !event.repeat {
                key_press(surface, &view, "Escape");
            }
            false
        }
        _ if is_command(m, mac) => match vk {
            0x41 => moved(&|model| model.select_all()),
            0x43 => {
                if !input.model.borrow().has_selection() {
                    return crate::keymap::empty_copy_consumed(surface, event);
                }
                copy(&input, secure);
                true
            }
            _ if vk == VK_INSERT && !m.shift => {
                if !input.model.borrow().has_selection() {
                    return crate::keymap::empty_copy_consumed(surface, event);
                }
                copy(&input, secure);
                true
            }
            0x58 => {
                if editable {
                    cut(surface, &view, &input, secure);
                }
                true
            }
            0x56 => {
                if editable {
                    paste(surface, &view);
                }
                true
            }
            0x5A if !m.shift => {
                if editable && input.model.borrow_mut().undo() {
                    after_edit(surface, &view, &input, true);
                }
                true
            }
            0x59 | 0x5A => {
                if editable && input.model.borrow_mut().redo() {
                    after_edit(surface, &view, &input, true);
                }
                true
            }
            _ => false,
        },
        _ if vk == VK_INSERT && m.shift && !m.ctrl => {
            if editable {
                paste(surface, &view);
            }
            true
        }
        _ => false,
    }
}

/// Copies the selection (never a password's).
fn copy(input: &InputState, secure: bool) {
    let text = {
        let model = input.model.borrow();
        if secure || !model.has_selection() {
            return;
        }
        model.selected().to_owned()
    };
    crate::rt::on_app(move |cx| cx.write_to_clipboard(gpui::ClipboardItem::new_string(text)));
}

fn cut(surface: &Surface, view: &NshView, input: &InputState, secure: bool) -> bool {
    if secure || !input.model.borrow().has_selection() {
        return true;
    }
    copy(input, secure);
    let deleted = input.model.borrow_mut().delete(Unit::Char, false);
    if deleted {
        key_press(surface, view, "Backspace");
    }
    after_edit(surface, view, input, deleted);
    true
}

/// Pastes the clipboard into `view` (once the app is at hand: the
/// clipboard is read with it, only on the user's paste), if it still has
/// the focus then: reports what it holds (`onPaste`) if the app listens,
/// then inserts its text as `pasteBehavior` says.
fn paste(surface: &Surface, view: &NshView) {
    let key = surface.key();
    let view = view.clone();
    crate::rt::on_app(move |cx| {
        let item = cx.read_from_clipboard();
        let Some(surface) = Surface::by_key(key) else {
            return;
        };
        let text = item.as_ref().and_then(|item| item.text());
        paste_content(&surface, &view, pasted_content(text, item));
    });
}

pub(crate) fn paste_content(
    surface: &Surface,
    view: &NshView,
    mut paste: nsh_core::PasteEvent,
) -> bool {
    if surface.input_paused.get() {
        return false;
    }
    if !window_active(surface) || focused(surface).as_ref() != Some(view) {
        return false;
    }
    let Some(input) = input_of(view) else {
        return false;
    };
    let config = input.config.borrow();
    if !config.editable {
        return false;
    }
    let events = view.state().events;
    let inferred_files = if events.contains(EventKind::FileDrop)
        && paste.files.is_empty()
        && paste.uris.is_empty()
        && let Some(uris) = nsh_core::platform::clipboard::files_from_text(&paste.text)
    {
        paste.text.clear();
        paste.uris = uris;
        true
    } else {
        false
    };
    let text = (config.paste_behavior == nsh_core::PasteBehavior::Insert)
        .then(|| pasted(&paste.text, input.multiline()));
    drop(config);
    if events.contains(EventKind::Paste) {
        surface.event(
            view.id(),
            EventKind::Paste,
            EventPayload::Paste(Box::new(paste)),
        );
    } else if inferred_files {
        surface.event(
            view.id(),
            EventKind::FileDrop,
            EventPayload::FileDrop(paste.uris),
        );
    }
    if let Some(text) = text.filter(|text| !text.is_empty()) {
        insert(surface, view, &input, &text, false);
    }
    true
}

/// What clipboard `item` holds, for `onPaste`: `text`, its images and its
/// local files' `file:` URLs.
fn pasted_content(text: Option<String>, item: Option<gpui::ClipboardItem>) -> nsh_core::PasteEvent {
    let mut paste = nsh_core::PasteEvent::new(text.unwrap_or_default());
    for entry in item.into_iter().flat_map(|item| item.into_entries()) {
        match entry {
            gpui::ClipboardEntry::Image(image) => {
                paste.files.push(nsh_core::PastedFile::image(image.bytes));
            }
            gpui::ClipboardEntry::ExternalPaths(paths) => paste.uris.extend(
                paths
                    .paths()
                    .iter()
                    .filter(|path| path.is_absolute())
                    .map(|path| nsh_core::platform::clipboard::file_url(&path.to_string_lossy())),
            ),
            _ => {}
        }
    }
    paste
}

/// The start or end of the caret's visual line (wrapped lines included).
fn line_edge(input: &InputState, end: bool) -> usize {
    let Some(layout) = input.layout() else {
        return 0;
    };
    let secure = input.secure();
    let pos = input.model.borrow().display_caret(secure);
    let (start, stop) = layout.line_edges(pos);
    let model = input.model.borrow();
    let at = model.text_at(if end { stop } else { start }, secure);
    model.tokens().step(at, end)
}

/// Where Up / Down (a line) or Page Up / Down (a box) takes the caret,
/// keeping its x.
fn vertical(input: &InputState, down: bool, page: bool) -> usize {
    let Some(layout) = input.layout() else {
        return 0;
    };
    let secure = input.secure();
    let pos = input.model.borrow().display_caret(secure);
    let (x, y, h) = layout.caret(pos);
    let goal = *input.goal_x.get().get_or_insert(x);
    input.goal_x.set(Some(goal));
    let step = if page { input.size.get().1.max(h) } else { h };
    let target = if down {
        y + h / 2.0 + step
    } else {
        y + h / 2.0 - step
    };
    let model = input.model.borrow();
    if target < 0.0 {
        return 0;
    }
    if target > layout.height {
        return model.text().len();
    }
    let at = layout.hit(goal, target, |_| true);
    // A directional key entering a wrapped atom must cross it, rather
    // than snap back to the endpoint the caret just left.
    model.tokens().step(model.text_at(at, secure), down)
}

// --- The caret's blinking ----------------------------------------------------

/// The caret blinks on one main-thread timer for all surfaces, running
/// only while some field has the focus of a focused surface; restarting
/// it (typing, moving) starts a new generation, and older timers stop.
mod blink {
    use std::cell::Cell;

    use super::*;

    thread_local! {
        /// The current timer's generation.
        static GENERATION: Cell<u64> = const { Cell::new(0) };
        /// A timer runs.
        static RUNNING: Cell<bool> = const { Cell::new(false) };
    }

    /// The fields whose caret shows now.
    pub(super) fn carets() -> Vec<NshView> {
        FOCUS.with(|f| {
            f.borrow()
                .iter()
                .filter(|(key, f)| !f.inactive && Surface::by_key(**key).is_some())
                .filter_map(|(_, f)| f.target.as_ref().map(|target| target.view().clone()))
                .filter(|view| view.attached() && input_of(view).is_some())
                .collect()
        })
    }

    /// Starts or stops the timer as fields gain and lose the focus.
    pub(super) fn update() {
        let wanted = !carets().is_empty();
        if wanted && !RUNNING.with(Cell::get) {
            restart();
        } else if !wanted {
            GENERATION.with(|g| g.set(g.get() + 1));
            RUNNING.with(|r| r.set(false));
        }
    }

    /// Starts the timer over, so a caret just shown stays for a period.
    pub(super) fn restart() {
        if carets().is_empty() {
            return;
        }
        let generation = GENERATION.with(|g| {
            g.set(g.get() + 1);
            g.get()
        });
        RUNNING.with(|r| r.set(true));
        schedule(generation);
    }

    fn schedule(generation: u64) {
        crate::rt::after_ms(BLINK_MS, move || {
            if GENERATION.with(Cell::get) != generation {
                return;
            }
            let views = carets();
            if views.is_empty() {
                RUNNING.with(|r| r.set(false));
                return;
            }
            for view in views {
                if let Some(input) = input_of(&view) {
                    input.caret_on.set(!input.caret_on.get());
                    view.changed();
                }
            }
            schedule(generation);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alignment() {
        let mut c = InputConfig::default();
        assert_eq!(xalign(&c), 0.0);
        c.rtl = true;
        assert_eq!(xalign(&c), 1.0);
        c.align = TextAlign::Center;
        assert_eq!(xalign(&c), 0.5);
        c.align = TextAlign::Justify;
        assert_eq!(xalign(&c), 0.0);
    }

    #[test]
    fn returns() {
        use SubmitBehavior::*;
        let none = Modifiers::default();
        let shift = Modifiers {
            shift: true,
            ..none
        };
        let alt = Modifiers { alt: true, ..none };
        let ctrl = Modifiers { ctrl: true, ..none };
        // A single line always submits.
        assert_eq!(return_key(BlurAndSubmit, false, none), Some(true));
        assert_eq!(return_key(Submit, false, shift), Some(false));
        // Several lines: as `submitBehavior` says; Shift and Alt break the
        // line.
        assert_eq!(return_key(Newline, true, none), None);
        assert_eq!(return_key(Submit, true, none), Some(false));
        assert_eq!(return_key(BlurAndSubmit, true, ctrl), Some(true));
        assert_eq!(return_key(Submit, true, shift), None);
        assert_eq!(return_key(BlurAndSubmit, true, alt), None);
    }

    #[test]
    fn compositions() {
        assert_eq!(composition("", None), None);
        let c = composition("nǐ hǎo", None).unwrap();
        assert_eq!(c.cursor, c.text.len());
        assert_eq!(c.target, None);
        // The caret after "nǐ" (UTF-16 2), a clause over "hǎo".
        let c = composition("nǐ hǎo", Some(2..2)).unwrap();
        assert_eq!((c.cursor, c.target), (3, None));
        let c = composition("nǐ hǎo", Some(3..6)).unwrap();
        assert_eq!((c.cursor, c.target), (8, Some((4, 8))));
    }

    #[test]
    fn input_configuration() {
        use gpui::{Autocapitalize, TextInputAction};
        let mut c = InputConfig::default();
        let g = configuration_of(&c);
        assert!(g.autocorrect);
        assert_eq!(g.autocapitalize, Autocapitalize::Sentences);
        assert_eq!(g.input_action, TextInputAction::Unspecified);
        c.multiline = true;
        assert_eq!(configuration_of(&c).input_action, TextInputAction::Enter);
        c.return_key = ReturnKeyType::Send;
        assert_eq!(configuration_of(&c).input_action, TextInputAction::Send);
        // Passwords get no corrections or capitals.
        c.secure = true;
        let g = configuration_of(&c);
        assert!(!g.autocorrect && !g.suggestions);
        assert_eq!(g.autocapitalize, Autocapitalize::None);
    }

    #[test]
    fn command_keys() {
        let apple = cfg!(target_os = "macos");
        let cmd = command(apple);
        assert!(is_command(cmd, apple));
        assert!(!is_command(Modifiers { alt: true, ..cmd }, apple));
        assert!(!is_command(Modifiers::default(), apple));
        assert_eq!(unit_of(Modifiers::default(), apple), Unit::Char);
    }

    /// A stopped surface's focus is dropped, and carets of surfaces that
    /// are gone never blink.
    #[test]
    fn stopped_surfaces_forget_their_focus() {
        let key = u64::MAX - 7;
        let view = NshView::new(2, nsh_core::ViewKind::Input);
        FOCUS.with(|f| {
            f.borrow_mut().insert(
                key,
                Focus {
                    target: Some(FocusTarget::View(view)),
                    inactive: false,
                    ..Default::default()
                },
            )
        });
        // No surface has that key: its field shows no caret.
        assert!(blink::carets().is_empty());
        surface_stopped(key);
        assert!(FOCUS.with(|f| !f.borrow().contains_key(&key)));
    }

    /// What the input method sees of a composition.
    #[test]
    fn ime_ranges() {
        let mut m = Model::default();
        m.set_text("ab");
        m.select(1, 1);
        m.composition = composition("中文", None);
        assert_eq!(ime::marked(&m), Some(1..3));
        assert_eq!(m.display(), "a中文b");
        assert_eq!(m.display_caret(false), 3);
        // Offsets in the composition go to the caret; after it, back to
        // the text.
        assert_eq!(m.text_at(2, false), 1);
        assert_eq!(m.text_at(4, false), 2);

        m.composition = None;
        m.set_tokens(&[nsh_core::input_tokens::InputTokenRule::new(
            "(?P<token>ab)",
            InputTokenStyle::default(),
            false,
        )
        .unwrap()]);
        m.composition = composition("中", None);
        assert_eq!(
            display_tokens(&m)
                .into_iter()
                .map(|(r, _)| r)
                .collect::<Vec<_>>(),
            vec![0..1, 2..3]
        );
        m.composition = None;
        m.select(0, 0);
        m.composition = composition("中", None);
        assert_eq!(
            display_tokens(&m)
                .into_iter()
                .map(|(r, _)| r)
                .collect::<Vec<_>>(),
            vec![1..3]
        );
    }
}
