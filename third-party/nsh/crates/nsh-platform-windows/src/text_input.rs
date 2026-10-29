//! Text inputs: an editor of nsh's own, drawn with Direct2D and laid out
//! with DirectWrite, hosted in the input's view at the content box the
//! core laid out (inside padding and border). Windows has no child windows
//! here, so the editor clips and transforms with its view and nothing ever
//! covers it.
//!
//! The view draws the decoration (background, border, corners) from the
//! core's style like any other view; the editor ([`InputState`], a
//! [`Hosted`] item) draws the selection, the text or the placeholder, the
//! IME's composition (underlined, at the caret) and the caret, which
//! blinks at the system's rate on a thread timer, not on the frame ticker,
//! so a focused field costs no frames.
//!
//! The editing itself (text, selection, caret stops, words, undo) is
//! [`model`], free of Win32; this file turns pointer, key, character and
//! IME messages into its operations and its changes into events.
//!
//! Every user edit increments the input's edit count and reports
//! `onChangeText` with it (always, as the engine keeps the text); a value
//! from JS based on an older count is stale and dropped, so fast typing is
//! never overwritten. Programmatic changes (JS values) report nothing but
//! the selection. Lengths and offsets JS sees are UTF-16 units.
//!
//! Focus is one field per surface. The window's focus is followed apart
//! from it, as on Linux: an inactive window keeps its focused field (with
//! no caret) and gets it back when activated. The IME is enabled only
//! while an editable, non-secure field has the focus
//! (`ImmAssociateContextEx`), so typing elsewhere never opens a
//! composition with nowhere to go.
//!
//! Return follows the config's `submit()`: a single line submits; a
//! multiline input whose return submits does so on a plain return (or
//! Ctrl+Return), while Shift+Return and Alt+Return still insert a line
//! break. The IME takes the keys it uses while it composes (they come as
//! `VK_PROCESSKEY`), so a return that commits a composition (CJK input
//! methods) submits nothing.
//!
//! `onKeyPress` reports what typing inserts and deletes, as UIKit does
//! (nothing for pasted text, no Backspace for a selection typed over), and
//! Escape, as on macOS and Linux.
//!
//! Input accessory views (`inputAccessoryViewID`) belong over a software
//! keyboard and have no meaning on the desktop: they are never shown.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use nsh_core::{
    Bounds, Color, EventKind, EventPayload, InputConfig, NodeId, PayloadValue, Points,
    SubmitBehavior, TextAlign,
    geometry::{Point, Size},
    tailwind::state,
    text_edit::{self as model, Composition, Model, Unit, key_of, pasted, utf16_to_byte},
};
use rustc_hash::FxHashMap;
use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::{
            Direct2D::D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT,
            DirectWrite::{
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_ITALIC, DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_WEIGHT, DWRITE_HIT_TEST_METRICS, DWRITE_LINE_SPACING_METHOD_UNIFORM,
                DWRITE_TEXT_ALIGNMENT, DWRITE_TEXT_ALIGNMENT_CENTER,
                DWRITE_TEXT_ALIGNMENT_JUSTIFIED, DWRITE_TEXT_ALIGNMENT_LEADING,
                DWRITE_TEXT_ALIGNMENT_TRAILING, DWRITE_TEXT_METRICS, DWRITE_TEXT_RANGE,
                DWRITE_TRIMMING, DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                DWRITE_WORD_WRAPPING_NO_WRAP, DWRITE_WORD_WRAPPING_WRAP, IDWriteTextFormat,
                IDWriteTextLayout, IDWriteTextLayout1,
            },
        },
        UI::{
            Input::{
                Ime::{
                    ATTR_TARGET_CONVERTED, ATTR_TARGET_NOTCONVERTED, CANDIDATEFORM, CFS_EXCLUDE,
                    CFS_POINT, COMPOSITIONFORM, CPS_CANCEL, CPS_COMPLETE, GCS_COMPATTR,
                    GCS_COMPSTR, GCS_CURSORPOS, GCS_RESULTSTR, HIMC, IACE_DEFAULT,
                    IME_COMPOSITION_STRING, ISC_SHOWUICOMPOSITIONWINDOW, ImmAssociateContextEx,
                    ImmGetCompositionStringW, ImmGetContext, ImmNotifyIME, ImmReleaseContext,
                    ImmSetCandidateWindow, ImmSetCompositionWindow, NI_COMPOSITIONSTR,
                    NOTIFY_IME_INDEX,
                },
                KeyboardAndMouse::{
                    VK_BACK, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_INSERT, VK_LEFT,
                    VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_UP,
                },
            },
            WindowsAndMessaging::{
                DefWindowProcW, GetCaretBlinkTime, KillTimer, SPI_GETCARETWIDTH,
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, SetTimer, SystemParametersInfoW,
                WM_IME_COMPOSITION, WM_IME_ENDCOMPOSITION, WM_IME_SETCONTEXT,
                WM_IME_STARTCOMPOSITION,
            },
        },
    },
    core::{HSTRING, Interface},
};
use windows_numerics::Vector2;

use crate::{
    input::{KeyEvent, Modifiers, PointerKind},
    render::{DrawCx, rect_f},
    surface::Surface,
    view::{Hosted, ItemPointer, NshView},
};

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
    /// The input view's node (`EngineControl::input_scroll`).
    id: NodeId,
    model: RefCell<Model>,
    config: RefCell<InputConfig>,
    /// A configuration was applied (auto focus happens on the first).
    configured: Cell<bool>,
    /// The first configuration's scheduled auto-focus task is still live.
    auto_focus_pending: Cell<bool>,
    /// Content box; the whole view until the core sends one.
    content: Cell<Option<Bounds<Points>>>,
    /// The size the editor was hosted (and last drawn) at.
    size: Cell<(f32, f32)>,
    /// User edits reported to the engine.
    count: Cell<u32>,
    /// Selection as last reported (UTF-16).
    reported: Cell<(u32, u32)>,
    /// The caret as last reported, in the view.
    reported_caret: Cell<Bounds<Points>>,
    /// The composition as last reported (`onCompositionChange`): its text
    /// while one is in progress.
    composed: RefCell<Option<String>>,
    /// A value from JS (text, count) that arrived while the IME composed,
    /// applied when the composition ends: replacing the text under a
    /// composition would drop it without the IME knowing.
    pending: RefCell<Option<(String, u32)>>,
    /// The animated text color, if a native animation sets one.
    anim_color: Cell<Option<Color>>,
    /// It has the surface's focus.
    focused: Cell<bool>,
    /// The surface's window is active (the caret shows).
    active: Cell<bool>,
    /// The blinking caret's phase.
    caret_on: Cell<bool>,
    /// Scroll offset of the text: horizontal for one line, vertical for
    /// several.
    scroll: Cell<f32>,
    /// The scroll of several lines as last reported to a built-in bar
    /// (`InputConfig::replaced`): offset, text height, width, viewport
    /// height. `None` until reported (again).
    reported_scroll: Cell<Option<(f32, f32, f32, f32)>>,
    /// The x the caret keeps while it moves up and down lines.
    goal_x: Cell<Option<f32>>,
    /// A press is selecting.
    drag: Cell<Option<Drag>>,
    /// The text's format, made from the config's font.
    format: RefCell<Option<IDWriteTextFormat>>,
    /// The shown text, laid out (cleared by every change).
    layout: RefCell<Option<IDWriteTextLayout>>,
    /// The placeholder, laid out.
    placeholder: RefCell<Option<IDWriteTextLayout>>,
}

impl InputState {
    fn new(surface: u64, id: NodeId) -> Self {
        InputState {
            surface,
            id,
            model: RefCell::default(),
            config: RefCell::default(),
            configured: Cell::new(false),
            auto_focus_pending: Cell::new(false),
            content: Cell::new(None),
            size: Cell::new((0.0, 0.0)),
            count: Cell::new(0),
            reported: Cell::new((0, 0)),
            reported_caret: Cell::new(Bounds::default()),
            composed: RefCell::new(None),
            pending: RefCell::new(None),
            anim_color: Cell::new(None),
            focused: Cell::new(false),
            active: Cell::new(true),
            caret_on: Cell::new(true),
            scroll: Cell::new(0.0),
            reported_scroll: Cell::new(None),
            goal_x: Cell::new(None),
            drag: Cell::new(None),
            format: RefCell::new(None),
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

    /// The text being composed, while there is any.
    fn composed_text(&self) -> Option<String> {
        self.model
            .borrow()
            .composition
            .as_ref()
            .filter(|c| !c.text.is_empty())
            .map(|c| c.text.clone())
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

    /// The text format of the config's font.
    fn format(&self) -> Option<IDWriteTextFormat> {
        if let Some(f) = &*self.format.borrow() {
            return Some(f.clone());
        }
        let config = self.config.borrow();
        let s = &config.style;
        let family = HSTRING::from(&*family(s.font_family.map(|f| f.name()).as_deref()));
        // SAFETY: COM calls with valid strings.
        let format = unsafe {
            crate::gfx::dwrite()
                .CreateTextFormat(
                    &family,
                    None,
                    DWRITE_FONT_WEIGHT(s.font_weight as i32),
                    if s.italic {
                        DWRITE_FONT_STYLE_ITALIC
                    } else {
                        DWRITE_FONT_STYLE_NORMAL
                    },
                    DWRITE_FONT_STRETCH_NORMAL,
                    s.font_size.0.max(1.0),
                    &HSTRING::new(),
                )
                .ok()?
        };
        if config.multiline && s.line_height.0 > 0.0 {
            // SAFETY: a COM call on the new format.
            let _ = unsafe {
                format.SetLineSpacing(
                    DWRITE_LINE_SPACING_METHOD_UNIFORM,
                    s.line_height.0,
                    s.line_height.0 * 0.8,
                )
            };
        }
        *self.format.borrow_mut() = Some(format.clone());
        Some(format)
    }

    /// A layout of `text` in the editor's width: one unwrapped line,
    /// placed by [`InputState::origin`], or wrapped lines aligned by
    /// DirectWrite.
    fn make_layout(
        &self,
        text: &[u16],
        align: DWRITE_TEXT_ALIGNMENT,
        multiline: bool,
    ) -> Option<IDWriteTextLayout> {
        let format = self.format()?;
        let width = self.size.get().0.max(1.0);
        let spacing = self.config.borrow().style.letter_spacing.0;
        // SAFETY: COM calls on the new layout with ranges inside the text.
        unsafe {
            let layout = crate::gfx::dwrite()
                .CreateTextLayout(text, &format, if multiline { width } else { 1.0e6 }, 1.0e6)
                .ok()?;
            let _ = layout.SetWordWrapping(if multiline {
                DWRITE_WORD_WRAPPING_WRAP
            } else {
                DWRITE_WORD_WRAPPING_NO_WRAP
            });
            let _ = layout.SetTextAlignment(align);
            if spacing != 0.0
                && let Ok(l1) = layout.cast::<IDWriteTextLayout1>()
            {
                let all = DWRITE_TEXT_RANGE {
                    startPosition: 0,
                    length: text.len() as u32,
                };
                let _ = l1.SetCharacterSpacing(0.0, spacing, 0.0, all);
            }
            Some(layout)
        }
    }

    /// The shown text, laid out.
    fn layout(&self) -> Option<IDWriteTextLayout> {
        if let Some(l) = &*self.layout.borrow() {
            return Some(l.clone());
        }
        let multiline = self.multiline();
        let text: Vec<u16> = {
            let model = self.model.borrow();
            if self.secure() {
                // UIKit's and Android's bullet.
                std::iter::repeat_n(0x2022, model.text().chars().count()).collect()
            } else {
                model.display().encode_utf16().collect()
            }
        };
        let align = if multiline {
            dwrite_align(&self.config.borrow())
        } else {
            DWRITE_TEXT_ALIGNMENT_LEADING
        };
        let layout = self.make_layout(&text, align, multiline)?;
        *self.layout.borrow_mut() = Some(layout.clone());
        Some(layout)
    }

    /// The placeholder, laid out (trimmed with an ellipsis on one line).
    fn placeholder_layout(&self) -> Option<IDWriteTextLayout> {
        if let Some(l) = &*self.placeholder.borrow() {
            return Some(l.clone());
        }
        let (text, align, multiline) = {
            let c = self.config.borrow();
            if c.placeholder.is_empty() {
                return None;
            }
            let text: Vec<u16> = c.placeholder.encode_utf16().collect();
            (text, dwrite_align(&c), c.multiline)
        };
        let layout = self.make_layout(&text, align, multiline)?;
        if !multiline {
            let width = self.size.get().0.max(1.0);
            // SAFETY: COM calls on the new layout.
            unsafe {
                let _ = layout.SetMaxWidth(width);
                let trimming = DWRITE_TRIMMING {
                    granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                    delimiter: 0,
                    delimiterCount: 0,
                };
                if let Ok(sign) = crate::gfx::dwrite().CreateEllipsisTrimmingSign(&layout) {
                    let _ = layout.SetTrimming(&trimming, &sign);
                }
            }
        }
        *self.placeholder.borrow_mut() = Some(layout.clone());
        Some(layout)
    }

    /// Where the layout's origin goes in the editor (and the text's
    /// metrics): one line is centered vertically, aligned while it fits
    /// and scrolled when it does not; several lines scroll vertically.
    fn origin(&self, layout: &IDWriteTextLayout) -> (f32, f32) {
        let (w, h) = self.size.get();
        let m = metrics(layout);
        if self.multiline() {
            let max = (m.height - h).max(0.0);
            let scroll = self.scroll.get().clamp(0.0, max);
            self.scroll.set(scroll);
            return (0.0, -scroll);
        }
        let text_w = m.widthIncludingTrailingWhitespace;
        let caret = caret_width();
        let y = (h - m.height) / 2.0;
        if text_w + caret <= w {
            self.scroll.set(0.0);
            let align = xalign(&self.config.borrow());
            let x = ((w - text_w) * align).min(w - text_w - caret).max(0.0);
            return (x, y);
        }
        let max = text_w + caret - w;
        let scroll = self.scroll.get().clamp(0.0, max);
        self.scroll.set(scroll);
        (-scroll, y)
    }

    /// The caret's top and height at shown position `pos`, in layout
    /// coordinates.
    fn caret_at(&self, layout: &IDWriteTextLayout, pos: u32) -> (f32, f32, f32) {
        let (mut x, mut y) = (0.0, 0.0);
        let mut m = DWRITE_HIT_TEST_METRICS::default();
        // SAFETY: local out values.
        let _ = unsafe { layout.HitTestTextPosition(pos, false, &mut x, &mut y, &mut m) };
        (x, y, m.height)
    }

    /// The caret's rectangle in editor coordinates (x, y, height).
    fn caret_rect(&self) -> Option<(f32, f32, f32)> {
        let layout = self.layout()?;
        let pos = self.model.borrow().display_caret(self.secure());
        let (ox, oy) = self.origin(&layout);
        let (x, y, h) = self.caret_at(&layout, pos);
        Some((ox + x, oy + y, h))
    }

    /// The shown position at layout point `(x, y)`.
    fn hit_layout(&self, layout: &IDWriteTextLayout, x: f32, y: f32) -> u32 {
        let mut trailing = windows_core::BOOL(0);
        let mut inside = windows_core::BOOL(0);
        let mut m = DWRITE_HIT_TEST_METRICS::default();
        // SAFETY: local out values.
        let _ = unsafe { layout.HitTestPoint(x, y, &mut trailing, &mut inside, &mut m) };
        m.textPosition + if trailing.as_bool() { m.length } else { 0 }
    }

    /// The text offset at editor point `(x, y)`.
    fn hit(&self, x: f32, y: f32) -> usize {
        let Some(layout) = self.layout() else {
            return 0;
        };
        let (ox, oy) = self.origin(&layout);
        let pos = self.hit_layout(&layout, x - ox, y - oy);
        self.model.borrow().text_at(pos, self.secure())
    }

    /// Scrolls so that the caret shows.
    fn reveal(&self) {
        let Some(layout) = self.layout() else { return };
        let pos = self.model.borrow().display_caret(self.secure());
        let (x, y, h) = self.caret_at(&layout, pos);
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
        } else {
            let caret = caret_width();
            if x < scroll {
                x
            } else if x + caret > scroll + w {
                x + caret - w
            } else {
                scroll
            }
        };
        self.scroll.set(scroll);
        // Clamped to the text.
        self.origin(&layout);
    }

    /// Reports how far several lines scrolled, the text's height and the
    /// viewport's to the built-in bar that takes the place of an
    /// indicator (`InputConfig::replaced`), when any of them changed since
    /// last reported. Called with the clamped scroll ([`InputState::origin`]).
    fn report_scroll(&self, layout: &IDWriteTextLayout) {
        {
            let config = self.config.borrow();
            if !config.replaced || !config.multiline {
                return;
            }
        }
        let (w, h) = self.size.get();
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let content = metrics(layout).height.max(h);
        let now = (self.scroll.get(), content, w, h);
        if self.reported_scroll.replace(Some(now)) == Some(now) {
            return;
        }
        let Some(surface) = Surface::by_key(self.surface) else {
            return;
        };
        surface.control(|c| {
            c.input_scroll(
                self.id,
                Point::new(Points::ZERO, Points(now.0)),
                Size::new(Points(w), Points(content)),
                Size::new(Points(w), Points(h)),
            );
        });
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
        // Every change of the scroll, the text or the size draws again, so
        // a built-in bar hears of each here.
        self.report_scroll(&layout);
        let config = self.config.borrow();
        let model = self.model.borrow();
        let secure = config.secure;
        let color = self.text_color();
        let focused = self.focused.get();

        if focused && model.has_selection() {
            let (s, e) = model.selection();
            let (s, e) = (model.to_display(s, secure), model.to_display(e, secure));
            // iOS tints the selection with the system blue when there is
            // no `selectionColor`.
            let tint = config
                .selection_color
                .unwrap_or(Color::rgba(0x00, 0x7a, 0xff, 0xff))
                .with_alpha(0.3);
            for r in hit_rects(&layout, s, e - s, ox, oy) {
                // An empty line of the selection still shows a sliver.
                let width = r.width.max(4.0);
                // SAFETY: a COM call between BeginDraw and EndDraw.
                unsafe {
                    cx.dc
                        .FillRectangle(&rect_f(r.left, r.top, width, r.height), cx.solid(tint));
                }
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
                    (h - metrics(&placeholder).height) / 2.0
                };
                // SAFETY: as above.
                unsafe {
                    cx.dc.DrawTextLayout(
                        Vector2 { X: 0.0, Y: y },
                        &placeholder,
                        cx.solid(tint),
                        D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT,
                    );
                }
            }
        } else {
            // SAFETY: as above.
            unsafe {
                cx.dc.DrawTextLayout(
                    Vector2 { X: ox, Y: oy },
                    &layout,
                    cx.solid(color),
                    D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT,
                );
            }
        }

        if let Some(c) = model.composition.as_ref().filter(|c| !c.text.is_empty()) {
            let start = model.to_display(model.caret(), secure);
            let len = model::utf16_len(&c.text) as u32;
            let thin = 1.0 / cx.scale.max(1.0);
            let underline = |from: u32, len: u32, width: f32| {
                for r in hit_rects(&layout, from, len, ox, oy) {
                    let y = r.top + r.height - width / 2.0 - thin;
                    // SAFETY: as above.
                    unsafe {
                        cx.dc.DrawLine(
                            Vector2 {
                                X: r.left + thin,
                                Y: y,
                            },
                            Vector2 {
                                X: r.left + r.width - thin,
                                Y: y,
                            },
                            cx.solid(color),
                            width,
                            None,
                        );
                    }
                }
            };
            underline(start, len, thin.max(1.0));
            if let Some((ts, te)) = c.target {
                let from = start + model::utf16_len(&c.text[..ts]) as u32;
                let len = model::utf16_len(&c.text[ts..te]) as u32;
                underline(from, len, 2.0);
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
            let (x, y, ch) = self.caret_at(&layout, pos);
            let width = caret_width();
            // On whole pixels, so that the caret stays sharp.
            let snap = |v: f32| (v * cx.scale).round() / cx.scale;
            let x = snap(ox + x);
            let tint = config.caret_color.unwrap_or(color);
            // SAFETY: as above.
            unsafe {
                cx.dc
                    .FillRectangle(&rect_f(x, oy + y, width, ch), cx.solid(tint));
            }
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

/// The hit-test rectangles of shown range `from..from + len`, offset by
/// the layout's origin.
fn hit_rects(
    layout: &IDWriteTextLayout,
    from: u32,
    len: u32,
    ox: f32,
    oy: f32,
) -> Vec<DWRITE_HIT_TEST_METRICS> {
    if len == 0 {
        return Vec::new();
    }
    let mut count = 0;
    // SAFETY: the first call asks for the count (it fails with "not
    // enough buffer", which is expected), the second fills a buffer of
    // that size.
    unsafe {
        let _ = layout.HitTestTextRange(from, len, ox, oy, None, &mut count);
        let mut rects = vec![DWRITE_HIT_TEST_METRICS::default(); count as usize];
        if layout
            .HitTestTextRange(from, len, ox, oy, Some(&mut rects), &mut count)
            .is_err()
        {
            return Vec::new();
        }
        rects.truncate(count as usize);
        rects
    }
}

fn metrics(layout: &IDWriteTextLayout) -> DWRITE_TEXT_METRICS {
    let mut m = DWRITE_TEXT_METRICS::default();
    // SAFETY: a local out value.
    let _ = unsafe { layout.GetMetrics(&mut m) };
    m
}

/// The caret's width: the system's setting (Ease of Access), in points
/// at 100%.
fn caret_width() -> f32 {
    thread_local! {
        static WIDTH: Cell<Option<f32>> = const { Cell::new(None) };
    }
    if let Some(w) = WIDTH.with(Cell::get) {
        return w;
    }
    let mut px: u32 = 1;
    // SAFETY: a u32 out value, as SPI_GETCARETWIDTH expects.
    let _ = unsafe {
        SystemParametersInfoW(
            SPI_GETCARETWIDTH,
            0,
            Some(&mut px as *mut u32 as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    };
    let w = px.clamp(1, 20) as f32;
    WIDTH.with(|c| c.set(Some(w)));
    w
}

/// The first family of a `fontFamily` list as DirectWrite knows it: the
/// generic names map to Windows' fonts, the UI font when there is none.
fn family(name: Option<&str>) -> String {
    thread_local! {
        static UI: std::sync::Arc<str> = crate::text::ui_family();
    }
    let first = name
        .into_iter()
        .flat_map(|n| n.split(','))
        .map(|f| f.trim().trim_matches(['"', '\'']))
        .find(|f| !f.is_empty());
    match first {
        None | Some("system-ui" | "sans-serif" | "ui-sans-serif" | "-apple-system") => {
            UI.with(|u| u.to_string())
        }
        Some("ui-monospace" | "monospace") => "Consolas".to_owned(),
        Some("ui-serif" | "serif") => "Times New Roman".to_owned(),
        Some(f) => f.to_owned(),
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

fn dwrite_align(config: &InputConfig) -> DWRITE_TEXT_ALIGNMENT {
    match config.align {
        TextAlign::Justify => DWRITE_TEXT_ALIGNMENT_JUSTIFIED,
        _ => match xalign(config) {
            a if a > 0.75 => DWRITE_TEXT_ALIGNMENT_TRAILING,
            a if a > 0.25 => DWRITE_TEXT_ALIGNMENT_CENTER,
            _ => DWRITE_TEXT_ALIGNMENT_LEADING,
        },
    }
}

// --- Focus -------------------------------------------------------------------

/// A surface's focused field, and whether its window is active.
#[derive(Default)]
struct Focus {
    view: Option<NshView>,
    inactive: bool,
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
/// UI Automation's Value pattern ([`crate::access`]).
#[allow(dead_code)] // For `crate::access`'s Value pattern.
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

/// Replaces the field's text as typing it would (UI Automation's
/// `SetValue`): `maxLength` applies and the change is reported. False
/// when it cannot (read-only).
#[allow(dead_code)] // For `crate::access`'s Value pattern.
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

/// The field that has the keyboard focus.
pub(crate) fn focused(surface: &Surface) -> Option<NshView> {
    focused_view(surface).filter(|view| view.state().input.is_some())
}

pub(crate) fn focused_view(surface: &Surface) -> Option<NshView> {
    let view = FOCUS.with(|f| f.borrow().get(&surface.key()).and_then(|f| f.view.clone()))?;
    if view.attached() {
        return Some(view);
    }
    if let Some(input) = input_of(&view) {
        input.focused.set(false);
    }
    FOCUS.with(|f| {
        if let Some(f) = f.borrow_mut().get_mut(&surface.key()) {
            f.view = None;
        }
    });
    update_ime(surface);
    blink::update();
    None
}

fn window_active(surface: &Surface) -> bool {
    FOCUS.with(|f| f.borrow().get(&surface.key()).is_none_or(|f| !f.inactive))
}

/// Moves the surface's focus to `view` (or nowhere), reporting the blur of
/// the field that had it, then the focus of the new one.
fn set_focus(surface: &Rc<Surface>, view: Option<&NshView>) {
    let old = focused_view(surface);
    if old.as_ref() == view {
        return;
    }
    if let Some(old) = &old {
        cancel_composition(surface);
        if let Some(input) = input_of(old) {
            input.focused.set(false);
            input.drag.set(None);
            input.model.borrow_mut().composition = None;
            input.relayout();
            report_composition(surface, old, &input);
        }
        FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().view = None);
        crate::input::set_state(surface, old, state::FOCUSED, false);
        send(surface, old, EventKind::Blur, || EventPayload::None);
        old.changed();
    }
    if let Some(view) = view {
        FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().view = Some(view.clone()));
        if let Some(input) = input_of(view) {
            input.focused.set(true);
            input.active.set(window_active(surface));
            input.wake_caret();
            input.reveal();
        }
        crate::input::set_state(surface, view, state::FOCUSED, true);
        send(surface, view, EventKind::Focus, || EventPayload::None);
        // The scroll views around bring the field into view.
        crate::scroll::reveal(surface, view);
        crate::access::focus_changed(surface, view);
        view.changed();
    }
    surface.sync_focus();
    update_ime(surface);
    blink::update();
    place_ime(surface);
}

// --- The IME -----------------------------------------------------------------

/// Enables the IME while an editable, non-secure field has the focus.
fn update_ime(surface: &Surface) {
    let hwnd = surface.hwnd();
    if hwnd.is_invalid() {
        return;
    }
    let wants = FOCUS
        .with(|f| f.borrow().get(&surface.key()).and_then(|f| f.view.clone()))
        .and_then(|v| input_of(&v))
        .is_some_and(|input| {
            let c = input.config.borrow();
            c.editable && !c.secure
        });
    // SAFETY: plain calls on the surface's window; a null context with no
    // flags detaches the IME, IACE_DEFAULT restores the window's own.
    unsafe {
        let _ = ImmAssociateContextEx(hwnd, HIMC::default(), if wants { IACE_DEFAULT } else { 0 });
    }
}

/// Runs `f` with the window's input context.
fn with_context<R>(hwnd: HWND, f: impl FnOnce(HIMC) -> R) -> Option<R> {
    // SAFETY: the context is released after use, as the call requires.
    unsafe {
        let himc = ImmGetContext(hwnd);
        if himc.is_invalid() {
            return None;
        }
        let r = f(himc);
        let _ = ImmReleaseContext(hwnd, himc);
        Some(r)
    }
}

/// Tells the IME to drop what it composes (the field lost the focus).
fn cancel_composition(surface: &Surface) {
    notify_composition(surface, CPS_CANCEL);
}

fn notify_composition(surface: &Surface, action: NOTIFY_IME_INDEX) {
    let hwnd = surface.hwnd();
    if hwnd.is_invalid() {
        return;
    }
    with_context(hwnd, |himc| {
        // SAFETY: a live context.
        unsafe { ImmNotifyIME(himc, NI_COMPOSITIONSTR, action, 0) }
    });
}

/// Moves the IME's composition and candidate windows to the focused
/// field's caret (window pixels).
fn place_ime(surface: &Surface) {
    let hwnd = surface.hwnd();
    let Some(view) = focused(surface) else { return };
    if hwnd.is_invalid() {
        return;
    }
    let Some(input) = input_of(&view) else {
        return;
    };
    let Some((x, y, h)) = input.caret_rect() else {
        return;
    };
    let content = content_rect(&view, &input);
    let Some(m) = view.to_root() else { return };
    let s = surface.scale();
    let px = |(x, y): (f32, f32)| POINT {
        x: (x * s).round() as i32,
        y: (y * s).round() as i32,
    };
    let (Some(top), Some(bottom)) = (
        m.map(content.origin.x.0 + x, content.origin.y.0 + y),
        m.map(content.origin.x.0 + x, content.origin.y.0 + y + h),
    ) else {
        return;
    };
    let (top, bottom) = (px(top), px(bottom));
    let caret = RECT {
        left: top.x,
        top: top.y,
        right: top.x + 1,
        bottom: bottom.y,
    };
    with_context(hwnd, |himc| {
        let composition = COMPOSITIONFORM {
            dwStyle: CFS_POINT,
            ptCurrentPos: top,
            rcArea: RECT::default(),
        };
        // The candidates go below the caret, never over it.
        let candidate = CANDIDATEFORM {
            dwIndex: 0,
            dwStyle: CFS_EXCLUDE,
            ptCurrentPos: bottom,
            rcArea: caret,
        };
        // SAFETY: a live context and valid structures.
        unsafe {
            let _ = ImmSetCompositionWindow(himc, &composition);
            let _ = ImmSetCandidateWindow(himc, &candidate);
        }
    });
}

/// A composition string of the context (`GCS_COMPSTR`, `GCS_RESULTSTR`)
/// as UTF-16 units.
fn composition_units(himc: HIMC, which: IME_COMPOSITION_STRING) -> Vec<u16> {
    // SAFETY: the first call asks for the size in bytes, the second fills
    // a buffer of that size.
    unsafe {
        let bytes = ImmGetCompositionStringW(himc, which, None, 0);
        if bytes <= 0 {
            return Vec::new();
        }
        let mut units = vec![0u16; bytes as usize / 2];
        let got =
            ImmGetCompositionStringW(himc, which, Some(units.as_mut_ptr().cast()), bytes as u32);
        units.truncate(got.max(0) as usize / 2);
        units
    }
}

/// The attributes of the composition (one byte per UTF-16 unit).
fn composition_attributes(himc: HIMC) -> Vec<u8> {
    // SAFETY: as in `composition_units`.
    unsafe {
        let bytes = ImmGetCompositionStringW(himc, GCS_COMPATTR, None, 0);
        if bytes <= 0 {
            return Vec::new();
        }
        let mut attrs = vec![0u8; bytes as usize];
        let got = ImmGetCompositionStringW(
            himc,
            GCS_COMPATTR,
            Some(attrs.as_mut_ptr().cast()),
            bytes as u32,
        );
        attrs.truncate(got.max(0) as usize);
        attrs
    }
}

/// The composition the IME reports: its text, caret and converted clause.
fn read_composition(himc: HIMC) -> Composition {
    let units = composition_units(himc, GCS_COMPSTR);
    let text = String::from_utf16_lossy(&units);
    // SAFETY: GCS_CURSORPOS returns the position without a buffer.
    let cursor = unsafe { ImmGetCompositionStringW(himc, GCS_CURSORPOS, None, 0) };
    let cursor = if cursor < 0 {
        text.len()
    } else {
        utf16_to_byte(&text, cursor as u32)
    };
    let attrs = composition_attributes(himc);
    let target =
        target_clause(&attrs).map(|(s, e)| (utf16_to_byte(&text, s), utf16_to_byte(&text, e)));
    Composition::new(text, cursor, target)
}

/// The clause being converted (UTF-16 range) from composition attributes.
fn target_clause(attrs: &[u8]) -> Option<(u32, u32)> {
    let is_target = |a: &u8| {
        u32::from(*a) == ATTR_TARGET_CONVERTED || u32::from(*a) == ATTR_TARGET_NOTCONVERTED
    };
    let start = attrs.iter().position(is_target)?;
    let len = attrs[start..].iter().take_while(|a| is_target(a)).count();
    Some((start as u32, (start + len) as u32))
}

/// IME messages; `None` for default handling.
pub(crate) fn ime(
    surface: &Rc<Surface>,
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<LRESULT> {
    let view = focused(surface)?;
    let input = input_of(&view)?;
    match msg {
        WM_IME_SETCONTEXT => {
            // The composition is drawn in the field, not in the IME's own
            // window.
            let lparam = LPARAM(lparam.0 & !(ISC_SHOWUICOMPOSITIONWINDOW as isize));
            // SAFETY: default handling with the adjusted flags.
            Some(unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) })
        }
        WM_IME_STARTCOMPOSITION => {
            // What is composed replaces the selection.
            if input.config.borrow().editable && input.model.borrow().has_selection() {
                let deleted = input.model.borrow_mut().delete(Unit::Char, false);
                after_edit(surface, &view, &input, deleted);
            }
            input.model.borrow_mut().composition = Some(Composition::default());
            place_ime(surface);
            // Reported once there is text: the IME may open a composition
            // and end it with nothing composed.
            Some(LRESULT(0))
        }
        WM_IME_COMPOSITION => {
            let flags = lparam.0 as u32;
            let read = with_context(hwnd, |himc| {
                let result = (flags & GCS_RESULTSTR.0 != 0)
                    .then(|| String::from_utf16_lossy(&composition_units(himc, GCS_RESULTSTR)));
                let composition = (flags & GCS_COMPSTR.0 != 0).then(|| read_composition(himc));
                (result, composition)
            });
            let (result, composition) = read.unwrap_or_default();
            if let Some(result) = result.filter(|r| !r.is_empty()) {
                // A commit ends the composition it came from, even when
                // the IME starts the next one in the same message (as
                // GPUI's input handler brings them, one call each): the
                // committed text's `onChangeText`, the end, then the
                // composition that follows.
                input.model.borrow_mut().composition = Some(Composition::default());
                input.relayout();
                insert(surface, &view, &input, &result, true);
                report_composition(surface, &view, &input);
            }
            input.model.borrow_mut().composition = composition
                .filter(|c| !c.text.is_empty())
                .or(Some(Composition::default()));
            input.relayout();
            input.wake_caret();
            input.reveal();
            view.changed();
            report_composition(surface, &view, &input);
            place_ime(surface);
            Some(LRESULT(0))
        }
        WM_IME_ENDCOMPOSITION => {
            input.model.borrow_mut().composition = None;
            input.relayout();
            input.reveal();
            view.changed();
            report_composition(surface, &view, &input);
            Some(LRESULT(0))
        }
        _ => None,
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
    let caret: Bounds<Points> = caret_bounds(view, input);
    if input.reported_caret.replace(caret) != caret {
        send(surface, view, EventKind::CaretMove, || {
            EventPayload::caret(caret)
        });
    }
}

/// The caret in the input view's coordinates (`onCaretMove`'s `bounds`):
/// in the content box, scrolled with the text.
fn caret_bounds(view: &NshView, input: &InputState) -> Bounds<Points> {
    let Some((x, y, h)) = input.caret_rect() else {
        return Bounds::default();
    };
    let content = content_rect(view, input);
    Bounds {
        origin: Point::new(content.origin.x + Points(x), content.origin.y + Points(y)),
        size: Size::new(Points(caret_width()), Points(h)),
    }
}

/// Reports the composition if it started, changed or ended since last
/// reported (and JS listens); once it ended, applies the value JS set
/// meanwhile. Called after every change of the composition, after the
/// `onChangeText` of what it committed.
fn report_composition(surface: &Surface, view: &NshView, input: &InputState) {
    let now = input.composed_text();
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
    place_ime(surface);
}

/// Inserts typed, pasted or composed text (clipped to `maxLength`);
/// `typed` text is reported as a key press.
fn insert(surface: &Surface, view: &NshView, input: &InputState, text: &str, typed: bool) {
    if !input.config.borrow().editable {
        return;
    }
    let max = input.config.borrow().max_length;
    let inserted = input.model.borrow_mut().insert(text, max);
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
    let input = Rc::new(InputState::new(surface.key(), view.id()));
    input.active.set(window_active(surface));
    view.state_mut().input = Some(input);
    // Nothing has the focus yet: typing must not open a composition.
    if focused(surface).is_none() {
        update_ime(surface);
    }
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
            input.format.borrow_mut().take();
        }
        if shown_changed {
            input.relayout();
        }
        input.placeholder.borrow_mut().take();
        if config.multiline != input.multiline() {
            input.scroll.set(0.0);
        }
    }
    let editable_changed = {
        let old = input.config.borrow();
        old.editable != config.editable || old.secure != config.secure
    };
    *input.config.borrow_mut() = config.clone();
    if editable_changed && input.focused.get() {
        update_ime(surface);
    }
    let first = !input.configured.replace(true);
    if first && config.auto_focus {
        auto_focus(surface, view);
    }
    place(view, &input);
    // A built-in bar (newly) taking the indicator's place hears where the
    // text is now, once placed (else on the first draw).
    input.reported_scroll.set(None);
    if config.replaced
        && config.multiline
        && let Some(layout) = input.layout()
    {
        input.origin(&layout);
        input.report_scroll(&layout);
    }
}

/// Focuses the field once it is on screen (the batch that made it may
/// insert it after configuring it).
fn auto_focus(surface: &Rc<Surface>, view: &NshView) {
    if view.attached() {
        return set_focus(surface, Some(view));
    }
    let Some(input) = input_of(view) else { return };
    input.auto_focus_pending.set(true);
    let pending = Rc::downgrade(&input);
    let view = view.clone();
    let mut frames = 0;
    surface.on_frame(move |surface, _| {
        let Some(input) = pending.upgrade() else {
            return false;
        };
        if !input.auto_focus_pending.get() {
            return false;
        }
        frames += 1;
        if view.attached() {
            input.auto_focus_pending.set(false);
            set_focus(surface, Some(&view));
            return false;
        }
        let waiting = frames < 30 && view.state().input.is_some();
        if !waiting {
            input.auto_focus_pending.set(false);
        }
        waiting
    });
}

/// Cancels scheduled focus when a subtree leaves the native input tree.
pub(crate) fn retire_cell(view: &NshView) {
    if let Some(input) = input_of(view) {
        input.auto_focus_pending.set(false);
    }
    for child in view.child_views() {
        retire_cell(&child);
    }
}

/// The content box in the view.
fn content_rect(view: &NshView, input: &InputState) -> Bounds<Points> {
    input.content.get().unwrap_or_else(|| {
        let f = view.state().frame;
        Bounds {
            origin: Point {
                x: Points(0.0),
                y: Points(0.0),
            },
            size: Size {
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
/// While the IME composes, the value waits for the composition to end
/// (the newest one; whether it is stale is decided then).
pub(crate) fn value(view: &NshView, text: &str, count: u32) {
    let Some(input) = input_of(view) else {
        return;
    };
    if input.composed_text().is_some() {
        input.pending.replace(Some((text.to_owned(), count)));
        return;
    }
    set_value(view, &input, text, count);
}

/// Applies JS's `text` unless the user edited since JS saw `count`.
fn set_value(view: &NshView, input: &InputState, text: &str, count: u32) {
    if count < input.count.get() || input.model.borrow().text() == text {
        return;
    }
    {
        let mut model = input.model.borrow_mut();
        // A composition the IME opened with nothing in it yet stays open
        // (a click or a return still completes it).
        let open = model.composition.is_some();
        model.set_text(text);
        if open {
            model.composition = Some(Composition::default());
        }
    }
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
pub(crate) fn content(view: &NshView, content: Bounds<Points>) {
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
    log::debug!("input accessory {} is not shown on Windows", child.id());
}

/// The surface of an input view.
fn surface_of(view: &NshView) -> Option<Rc<Surface>> {
    let key = view.state().input.as_ref()?.surface;
    Surface::by_key(key)
}

/// `focus()`.
pub(crate) fn focus(view: &NshView) {
    if let Some(surface) = surface_of(view) {
        set_focus(&surface, Some(view));
    }
}

pub(crate) fn focus_view(surface: &Rc<Surface>, view: &NshView) {
    set_focus(surface, Some(view));
}

/// `blur()`.
pub(crate) fn blur(view: &NshView) {
    if let Some(surface) = surface_of(view)
        && focused(&surface).as_ref() == Some(view)
    {
        set_focus(&surface, None);
    }
}

/// Blurs whatever field has the focus.
pub(crate) fn blur_all(surface: &Rc<Surface>) {
    set_focus(surface, None);
}

/// Focuses `view`, reached with Tab: as in Windows' dialogs, its text is
/// selected.
pub(crate) fn tab_to(view: &NshView) {
    let Some(surface) = surface_of(view) else {
        return;
    };
    set_focus(&surface, Some(view));
    if let Some(input) = input_of(view)
        && input.focused.get()
    {
        input.model.borrow_mut().select_all();
        after_edit(&surface, view, &input, false);
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

/// Characters typed (`WM_CHAR`, the script's `type`). Control characters
/// are keys ([`key`] handles Return, Backspace and Tab).
pub(crate) fn char_input(surface: &Rc<Surface>, text: &str) {
    let Some(view) = focused(surface) else { return };
    let Some(input) = input_of(&view) else {
        return;
    };
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    if text.is_empty() {
        return;
    }
    insert(surface, &view, &input, &text, true);
}

/// The window got (or lost) the keyboard focus: the focused field keeps
/// the focus (an app in the background keeps its field), without a caret.
pub(crate) fn window_focus(surface: &Rc<Surface>, focused_window: bool) {
    FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().inactive = !focused_window);
    if let Some(view) = focused(surface)
        && let Some(input) = input_of(&view)
    {
        input.active.set(focused_window);
        input.drag.set(None);
        input.caret_on.set(true);
        view.changed();
    }
    if focused_window {
        update_ime(surface);
        place_ime(surface);
    }
    blink::update();
    surface.sync_focus();
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
            if input.model.borrow().composition.is_some() {
                // What is composed is kept, where it was typed.
                notify_composition(surface, CPS_COMPLETE);
            }
            set_focus(surface, Some(view));
            let at = input.hit(x, y);
            let secure = input.secure();
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
            let at = input.hit(x, y);
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
#[allow(dead_code)] // For `crate::input`'s wheel routing.
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
        input.report_scroll(&layout);
        if input.focused.get()
            && let Some(surface) = surface_of(view)
        {
            report_caret(&surface, view, &input);
        }
    }
    moved
}

/// `Command::ScrollTo` for a multiline input: scrolls its text to `y`,
/// clamped to the lines that do not fit (a built-in bar's drags).
pub(crate) fn scroll_to(view: &NshView, y: Points) {
    let Some(input) = input_of(view) else {
        return;
    };
    if !input.multiline() {
        return;
    }
    let Some(layout) = input.layout() else {
        return;
    };
    let before = input.scroll.get();
    input.scroll.set(y.0);
    // Clamped to the text.
    input.origin(&layout);
    if input.scroll.get() != before {
        view.changed();
        input.report_scroll(&layout);
        if input.focused.get()
            && let Some(surface) = surface_of(view)
        {
            report_caret(&surface, view, &input);
        }
    }
}

/// A right click on field `view`: it takes the focus (keeping its
/// selection) and shows Windows' edit menu, each item the field's own key.
pub(crate) fn context_menu(surface: &Rc<Surface>, view: &NshView) {
    use nsh_core::desktop::MenuRole;

    use crate::chrome::LocalItem;
    let Some(input) = input_of(view) else {
        return;
    };
    if focused(surface).as_ref() != Some(view) {
        set_focus(surface, Some(view));
    }
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
    let item = |role: Option<MenuRole>, label: &'static str, enabled: bool, vk: u16, ctrl: bool| {
        LocalItem::Item {
            role,
            label,
            enabled,
            action: Rc::new(move |s: &Rc<Surface>| {
                let event = KeyEvent {
                    vk,
                    down: true,
                    repeat: false,
                    modifiers: crate::input::Modifiers {
                        ctrl,
                        ..Default::default()
                    },
                };
                key(s, &event);
            }),
        }
    };
    crate::chrome::popup_actions(
        surface,
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
            item(
                Some(MenuRole::Paste),
                "",
                editable
                    && (crate::system::clipboard_has_text()
                        || (view.state().events.contains(EventKind::Paste)
                            && crate::system::clipboard_has_image())),
                0x56,
                true,
            ),
            item(None, "Delete", editable && selected, 0x2E, false),
            LocalItem::Separator,
            item(Some(MenuRole::SelectAll), "", !empty && !all, 0x41, true),
        ],
    );
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
    let unit = if m.ctrl { Unit::Word } else { Unit::Char };
    let vk = event.vk;
    // Movements: the caret goes, the text stays.
    let moved = |f: &dyn Fn(&mut Model)| {
        f(&mut input.model.borrow_mut());
        after_edit(surface, &view, &input, false);
        true
    };
    match vk {
        // Alt+Left goes back, from a field too (`navigation::key_pressed`).
        _ if (vk == VK_LEFT.0 || vk == VK_RIGHT.0) && !m.alt => {
            input.goal_x.set(None);
            moved(&|model| model.step(unit, vk == VK_RIGHT.0, m.shift))
        }
        _ if vk == VK_HOME.0 || vk == VK_END.0 => {
            input.goal_x.set(None);
            let end = vk == VK_END.0;
            let to = if multiline && !m.ctrl {
                line_edge(&input, end)
            } else if end {
                input.model.borrow().text().len()
            } else {
                0
            };
            moved(&|model| model.move_to(to, m.shift))
        }
        _ if multiline
            && (vk == VK_UP.0 || vk == VK_DOWN.0 || vk == VK_PRIOR.0 || vk == VK_NEXT.0) =>
        {
            let page = vk == VK_PRIOR.0 || vk == VK_NEXT.0;
            let down = vk == VK_DOWN.0 || vk == VK_NEXT.0;
            let to = vertical(&input, down, page);
            moved(&|model| model.move_to(to, m.shift))
        }
        _ if vk == VK_BACK.0 || vk == VK_DELETE.0 => {
            if !editable {
                return true;
            }
            if vk == VK_DELETE.0 && m.shift && !m.ctrl {
                // Shift+Delete cuts, as in every Windows editor.
                return cut(surface, &view, &input, secure);
            }
            let (deleted, empty) = {
                let mut model = input.model.borrow_mut();
                let empty = model.text().is_empty();
                (model.delete(unit, vk == VK_DELETE.0), empty)
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
        _ if vk == VK_RETURN.0 => {
            let composing = input
                .model
                .borrow()
                .composition
                .as_ref()
                .is_some_and(|c| !c.text.is_empty());
            if composing {
                // The IME takes the return that commits a composition (it
                // comes as `VK_PROCESSKEY`); one that comes anyway only
                // commits it.
                notify_composition(surface, CPS_COMPLETE);
                return true;
            }
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
        // Reported as on macOS and Linux; navigation then takes the focus
        // from the field (`navigation::key_pressed`).
        _ if vk == VK_ESCAPE.0 => {
            if !m.ctrl && !m.alt && !event.repeat {
                key_press(surface, &view, "Escape");
            }
            false
        }
        _ if m.ctrl && !m.alt => match vk {
            0x41 => moved(&|model| model.select_all()),
            0x43 => {
                copy(&input, secure);
                true
            }
            _ if vk == VK_INSERT.0 && !m.shift => {
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
                    paste(surface, &view, &input);
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
        _ if vk == VK_INSERT.0 && m.shift && !m.ctrl => {
            if editable {
                paste(surface, &view, &input);
            }
            true
        }
        _ => false,
    }
}

/// Copies the selection (never a password's).
fn copy(input: &InputState, secure: bool) {
    let model = input.model.borrow();
    if secure || !model.has_selection() {
        return;
    }
    crate::system::set_clipboard_text(
        &model.selected().replace("\r\n", "\n").replace('\n', "\r\n"),
    );
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

/// A paste (Ctrl+V, Shift+Insert, the menu): reports what the clipboard
/// holds (`onPaste`) if the app listens, then inserts its text as
/// `pasteBehavior` says. The clipboard is read only here, on the user's
/// paste.
fn paste(surface: &Surface, view: &NshView, input: &InputState) {
    let text = crate::system::clipboard_text();
    if view.state().events.contains(EventKind::Paste) {
        let mut paste = nsh_core::PasteEvent::new(text.clone().unwrap_or_default());
        if let Some(image) = crate::system::clipboard_image() {
            paste.files.push(nsh_core::PastedFile::image(image));
        }
        paste.uris = crate::system::clipboard_files();
        surface.event(
            view.id(),
            EventKind::Paste,
            EventPayload::Paste(Box::new(paste)),
        );
    }
    if input.config.borrow().paste_behavior != nsh_core::PasteBehavior::Insert {
        return;
    }
    let Some(text) = text else {
        return;
    };
    let text = pasted(&text, input.multiline());
    if !text.is_empty() {
        insert(surface, view, input, &text, false);
    }
}

/// The start or end of the caret's visual line (wrapped lines included).
fn line_edge(input: &InputState, end: bool) -> usize {
    let Some(layout) = input.layout() else {
        return 0;
    };
    let secure = input.secure();
    let pos = input.model.borrow().display_caret(secure);
    let (_, y, h) = input.caret_at(&layout, pos);
    let x = if end { 1.0e6 } else { -1.0e6 };
    let mut at = input.hit_layout(&layout, x, y + h / 2.0);
    if end {
        // A wrapped line ends before the break, not after it on the next
        // line's start.
        let model = input.model.borrow();
        let byte = model.text_at(at, secure);
        let text = model.text();
        if byte > 0 && text[..byte].ends_with(['\r', '\n']) {
            at = at.saturating_sub(1);
        }
    }
    input.model.borrow().text_at(at, secure)
}

/// Where Up / Down (a line) or Page Up / Down (a box) takes the caret,
/// keeping its x.
fn vertical(input: &InputState, down: bool, page: bool) -> usize {
    let Some(layout) = input.layout() else {
        return 0;
    };
    let secure = input.secure();
    let pos = input.model.borrow().display_caret(secure);
    let (x, y, h) = input.caret_at(&layout, pos);
    let goal = *input.goal_x.get().get_or_insert(x);
    input.goal_x.set(Some(goal));
    let step = if page { input.size.get().1.max(h) } else { h };
    let target = if down {
        y + h / 2.0 + step
    } else {
        y + h / 2.0 - step
    };
    let height = metrics(&layout).height;
    let model = input.model.borrow();
    if target < 0.0 {
        return 0;
    }
    if target > height {
        return model.text().len();
    }
    let at = input.hit_layout(&layout, goal, target);
    model.text_at(at, secure)
}

// --- The caret's blinking ----------------------------------------------------

/// The caret blinks on one thread timer for all surfaces (a `TIMERPROC`,
/// so no window procedure is involved), running only while some field
/// has the focus of an active window.
mod blink {
    use std::cell::Cell;

    use super::*;

    thread_local! {
        /// The timer's id (0: none).
        static TIMER: Cell<usize> = const { Cell::new(0) };
    }

    /// The system's blink time, `None` when the caret does not blink.
    fn period() -> Option<u32> {
        // SAFETY: a plain query.
        let ms = unsafe { GetCaretBlinkTime() };
        (ms != 0 && ms != u32::MAX).then_some(ms)
    }

    /// The fields whose caret shows now.
    fn carets() -> Vec<NshView> {
        FOCUS.with(|f| {
            f.borrow()
                .values()
                .filter(|f| !f.inactive)
                .filter_map(|f| f.view.clone().filter(|view| input_of(view).is_some()))
                .collect()
        })
    }

    /// Starts or stops the timer as fields gain and lose the focus.
    pub(super) fn update() {
        let wanted = !carets().is_empty();
        let timer = TIMER.with(Cell::get);
        if wanted && timer == 0 {
            restart();
        } else if !wanted && timer != 0 {
            // SAFETY: a thread timer made by `restart`.
            let _ = unsafe { KillTimer(None, timer) };
            TIMER.with(|t| t.set(0));
        }
    }

    /// Starts the timer over, so a caret just shown stays for a period.
    pub(super) fn restart() {
        let Some(ms) = period() else { return };
        if carets().is_empty() {
            return;
        }
        let timer = TIMER.with(Cell::get);
        // SAFETY: a thread timer: an existing id is replaced (restarted),
        // 0 makes a new one; `tick` lives for the program.
        let id = unsafe { SetTimer(None, timer, ms, Some(tick)) };
        TIMER.with(|t| t.set(if id != 0 { id } else { timer }));
    }

    unsafe extern "system" fn tick(_: HWND, _: u32, _: usize, _: u32) {
        let views = carets();
        if views.is_empty() {
            update();
            return;
        }
        for view in views {
            let input = input_of(&view);
            if let Some(input) = input {
                input.caret_on.set(!input.caret_on.get());
                view.changed();
            }
        }
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
        assert_eq!(dwrite_align(&c), DWRITE_TEXT_ALIGNMENT_TRAILING);
        c.align = TextAlign::Center;
        assert_eq!(xalign(&c), 0.5);
        assert_eq!(dwrite_align(&c), DWRITE_TEXT_ALIGNMENT_CENTER);
        c.align = TextAlign::Justify;
        assert_eq!(dwrite_align(&c), DWRITE_TEXT_ALIGNMENT_JUSTIFIED);
    }

    #[test]
    fn families() {
        assert_eq!(family(Some("ui-monospace")), "Consolas");
        assert_eq!(family(Some("'Noto Sans', serif")), "Noto Sans");
        assert_eq!(family(Some("serif")), "Times New Roman");
        assert!(!family(None).is_empty());
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
    fn composition_clauses() {
        assert_eq!(target_clause(&[0, 0, 1, 1, 2]), Some((2, 4)));
        assert_eq!(target_clause(&[3, 0]), Some((0, 1)));
        assert_eq!(target_clause(&[0, 2]), None);
    }
}
