//! Text inputs: Windows' own text box, a windowless RichEdit control
//! ([`crate::richedit`]), hosted in the input's view at the content box the
//! core laid out (inside padding and border) and drawn with Direct2D into
//! the window's target. There are no child windows here, so the field
//! clips, transforms and fades with its view and nothing ever covers it.
//!
//! RichEdit does the editing as every Windows text box does it: caret
//! stops, words and lines, the keys (Ctrl+arrows, Ctrl+Backspace,
//! Shift+Delete, ...), selection by mouse (double and triple clicks,
//! drags that scroll), multilevel undo, the clipboard, the IME in place
//! with its candidate window at the caret, Text Services Framework input
//! (dictation, the emoji panel, the touch keyboard, reconversion), spell
//! checking (`autoCorrect`), password masking and scrolling. The text
//! keeps one character and paragraph format, RichEdit's defaults, which the
//! field makes from the config's font, color, alignment and line height.
//!
//! The view draws the decoration (background, border, corners) from the
//! core's style like any other view; the field ([`InputState`], a
//! [`Hosted`] item) draws the placeholder while the text is empty, has
//! RichEdit draw the text and selection, and draws the caret RichEdit
//! places, which blinks at the system's rate on a thread timer, not on the
//! frame ticker, so a focused field costs no frames.
//!
//! RichEdit's coordinates are the window's client pixels: its client
//! rectangle is the content box mapped to the window (moved again whenever
//! the field is pressed, focused or typed in), so the IME it places and the
//! pointer it is sent agree with the screen; drawing maps them back to the
//! view's coordinates through the current transform.
//!
//! Every user edit increments the input's edit count and reports
//! `onChangeText` with it (always, as the engine keeps the text); a value
//! from JS based on an older count is stale and dropped, so fast typing is
//! never overwritten. Programmatic changes (JS values) report nothing but
//! the selection. Lengths and offsets JS sees are UTF-16 units, as
//! RichEdit's.
//!
//! While the IME composes, RichEdit keeps the composition in its text;
//! the field reports it with `onCompositionChange` (the text between what
//! was before and after the selection the composition started at) and
//! reports `onChangeText` only for what is committed, when it ends (before
//! the composition's end). A `value` JS sets meanwhile is held and applied
//! when the composition ends, unless the user's commit made it stale.
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
//! methods) submits nothing. Tab moves between fields, never into the text.
//! RichEdit's formatting shortcuts (Ctrl+B, Ctrl+E, ...) are never sent:
//! the text keeps one format, and the app's shortcuts get those keys.
//!
//! Pastes go through the field (`onPaste`, `pasteBehavior`, line breaks of
//! a single line turned into spaces), then into RichEdit as a replacement
//! of the selection that undo takes back.
//!
//! `onKeyPress` reports what typing inserts and deletes, as UIKit does
//! (nothing for pasted text, no Backspace for a selection typed over), and
//! Escape, as on macOS and Linux.
//!
//! Input accessory views (`inputAccessoryViewID`) belong over a software
//! keyboard and have no meaning on the desktop: they are never shown.

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
};

use nsh_core::{
    Bounds, Color, EventKind, EventPayload, InputConfig, NodeId, PayloadValue, Points,
    SubmitBehavior, TextAlign,
    geometry::{Point, Size},
    tailwind::state,
    text_edit::{clip_chars, key_of, pasted},
};
use rustc_hash::FxHashMap;
use windows::{
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::{
            Direct2D::{
                Common::{
                    D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED, D2D1_COMPOSITE_MODE_SOURCE_OVER,
                    D2D1_PIXEL_FORMAT,
                },
                D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1,
                D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT, D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                ID2D1CommandList,
            },
            DirectWrite::{
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_ITALIC, DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_WEIGHT, DWRITE_LINE_SPACING_METHOD_UNIFORM, DWRITE_TEXT_ALIGNMENT,
                DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_JUSTIFIED,
                DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_TEXT_ALIGNMENT_TRAILING, DWRITE_TEXT_METRICS,
                DWRITE_TRIMMING, DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                DWRITE_WORD_WRAPPING_EMERGENCY_BREAK, DWRITE_WORD_WRAPPING_NO_WRAP,
                IDWriteTextFormat, IDWriteTextFormat1, IDWriteTextLayout,
            },
            Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
        },
        UI::{
            Controls::RichEdit::{
                CFE_ITALIC, CFM_BOLD, CFM_COLOR, CFM_FACE, CFM_ITALIC, CFM_SIZE, CFM_SPACING,
                CFM_WEIGHT, EM_CANREDO, EM_EXSETSEL, EM_GETLANGOPTIONS, EM_GETSCROLLPOS, EM_REDO,
                EM_SETEDITSTYLE, EM_SETEVENTMASK, EM_SETLANGOPTIONS, EM_SETSCROLLPOS,
                EM_SETTEXTMODE, EM_SETTYPOGRAPHYOPTIONS, EM_STOPGROUPTYPING, ENM_CHANGE,
                ENM_ENDCOMPOSITION, ENM_SELCHANGE, ENM_STARTCOMPOSITION, IMF_IMEALWAYSSENDNOTIFY,
                IMF_SPELLCHECKING, IMF_TKBPREDICTION, PFA_CENTER, PFA_JUSTIFY, PFA_LEFT, PFA_RIGHT,
                PFM_ALIGNMENT, PFM_LINESPACING, PFM_RTLPARA, SES_USECTF, TM_MULTICODEPAGE,
                TM_MULTILEVELUNDO, TM_RICHTEXT, TO_ADVANCEDTYPOGRAPHY, TXTBIT_AUTOWORDSEL,
                TXTBIT_CHARFORMATCHANGE, TXTBIT_CLIENTRECTCHANGE, TXTBIT_D2DDWRITE,
                TXTBIT_DISABLEDRAG, TXTBIT_HIDESELECTION, TXTBIT_MAXLENGTHCHANGE, TXTBIT_MULTILINE,
                TXTBIT_PARAFORMATCHANGE, TXTBIT_READONLY, TXTBIT_RICHTEXT, TXTBIT_SCROLLBARCHANGE,
                TXTBIT_USEPASSWORD, TXTBIT_WORDWRAP,
            },
            Input::{
                Ime::{
                    CPS_CANCEL, CPS_COMPLETE, HIMC, IACE_DEFAULT, ISC_SHOWUICOMPOSITIONWINDOW,
                    ImmAssociateContextEx, ImmGetContext, ImmNotifyIME, ImmReleaseContext,
                    NI_COMPOSITIONSTR, NOTIFY_IME_INDEX,
                },
                KeyboardAndMouse::{
                    GetKeyboardState, MAPVK_VK_TO_VSC, MapVirtualKeyW, SetKeyboardState, VK_BACK,
                    VK_CONTROL, VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_HOME, VK_INSERT, VK_LEFT,
                    VK_MENU, VK_NEXT, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SHIFT, VK_UP,
                },
            },
            WindowsAndMessaging::{
                DefWindowProcW, GetCaretBlinkTime, KillTimer, SetTimer, WM_CHAR, WM_CLEAR, WM_COPY,
                WM_CUT, WM_IME_COMPOSITION, WM_IME_ENDCOMPOSITION, WM_IME_SETCONTEXT,
                WM_IME_STARTCOMPOSITION, WM_KEYDOWN, WM_KEYUP, WM_LBUTTONDBLCLK, WM_LBUTTONDOWN,
                WM_LBUTTONUP, WM_MOUSEMOVE, WS_VSCROLL,
            },
        },
    },
    core::{HSTRING, Interface},
};
use windows_numerics::{Matrix3x2, Vector2};

use crate::{
    input::{KeyEvent, Modifiers, PointerKind},
    render::{DrawCx, rect_f},
    richedit::{self, Editor, Props},
    surface::Surface,
    view::{Hosted, ItemPointer, NshView, WeakView},
};

/// `EM_SETSEL`.
const EM_SETSEL: u32 = 0x00B1;
/// `EM_CANUNDO`.
const EM_CANUNDO: u32 = 0x00C6;
/// `EM_UNDO`.
const EM_UNDO: u32 = 0x00C7;
/// `EM_REPLACESEL`.
const EM_REPLACESEL: u32 = 0x00C2;
/// `ES_AUTOVSCROLL`, `ES_AUTOHSCROLL`: how RichEdit scrolls its text.
const ES_AUTOVSCROLL: u32 = 0x0040;
const ES_AUTOHSCROLL: u32 = 0x0080;
/// `MK_LBUTTON`, `MK_SHIFT`, `MK_CONTROL`.
const MK_LBUTTON: usize = 0x0001;
const MK_SHIFT: usize = 0x0004;
const MK_CONTROL: usize = 0x0008;

/// The text input `view` holds now (`None`: it is no input).
#[cfg(feature = "dev")]
pub(crate) fn current_text(view: &crate::view::NshView) -> Option<String> {
    let input = view.state().input.clone()?;
    Some(input.text())
}

/// The native side of an input view ([`crate::view::ViewState::input`]),
/// and the RichEdit control it hosts.
pub(crate) struct InputState {
    /// The surface's key ([`Surface::by_key`]): `focus()` and `blur()`
    /// come with the view only.
    surface: u64,
    /// The input view's node (`EngineControl::input_scroll`).
    id: NodeId,
    /// Weak references back to the view and self, used when recreating
    /// RichEdit to switch between DirectWrite and GDI custom-font rendering.
    view: WeakView,
    me: std::rc::Weak<InputState>,
    /// The control (`None` when RichEdit could not be made).
    editor: RefCell<Option<Editor>>,
    /// True while RichEdit runs in GDI mode (`TXTBIT_D2DDWRITE` cleared) so it
    /// can render an app-registered memory font loaded via `AddFontMemResourceEx`.
    use_gdi: Cell<bool>,
    config: RefCell<InputConfig>,
    /// A configuration was applied (auto focus happens on the first).
    configured: Cell<bool>,
    #[cfg(feature = "terminal")]
    terminal_replaced: RefCell<Option<String>>,
    /// Content box; the whole view until the core sends one.
    content: Cell<Option<Bounds<Points>>>,
    /// The size the field was hosted (and last drawn) at.
    size: Cell<(f32, f32)>,
    /// The content box's top left in the window's client pixels, and the
    /// scale the formats were made at.
    origin: Cell<(i32, i32)>,
    scale: Cell<f32>,
    /// User edits reported to the engine.
    count: Cell<u32>,
    /// The text as last reported to the engine (or set by it).
    reported_text: RefCell<String>,
    /// Selection as last reported (UTF-16).
    reported: Cell<(u32, u32)>,
    /// The caret as last reported, in the view.
    reported_caret: Cell<Bounds<Points>>,
    /// While the IME composes: the UTF-16 lengths of the text before and
    /// after the composition.
    composing: Cell<Option<(u32, u32)>>,
    /// The composition as last reported (`onCompositionChange`): its text
    /// while one is in progress.
    composed: RefCell<Option<String>>,
    /// A value from JS (text, count) that arrived while the IME composed,
    /// applied when the composition ends: replacing the text under a
    /// composition would drop it without the IME knowing.
    pending: RefCell<Option<(String, u32)>>,
    /// Changes RichEdit reports are the field's own (a JS value).
    programmatic: Cell<bool>,
    /// The animated text color, if a native animation sets one.
    anim_color: Cell<Option<Color>>,
    /// It has the surface's focus.
    focused: Cell<bool>,
    /// The surface's window is active (the caret shows).
    active: Cell<bool>,
    /// The blinking caret's phase.
    caret_on: Cell<bool>,
    /// The scroll of several lines as last reported to a bar of the app's
    /// (`InputConfig::report_scroll`): offset, text height, width, viewport
    /// height. `None` until reported (again).
    reported_scroll: Cell<Option<(f32, f32, f32, f32)>>,
    /// A press is selecting.
    dragging: Cell<bool>,
    /// The press that focused the field selects all its text when it ends
    /// (`selectTextOnFocus`), unless it made a selection itself.
    select_on_up: Cell<bool>,
    /// The text's format (the placeholder's and the line's height), made
    /// from the config's font at the recorded custom-font generation.
    format: RefCell<Option<(u64, IDWriteTextFormat)>>,
    /// The custom-font generation last applied to RichEdit's character format.
    font_generation: Cell<u64>,
    /// The placeholder, laid out.
    placeholder: RefCell<Option<IDWriteTextLayout>>,
    /// What RichEdit drew last (in the content box's points), shown again
    /// when it cannot draw.
    drawn: RefCell<Option<ID2D1CommandList>>,
}

/// Creates and configures a windowless RichEdit control with `bits`.
fn make_editor(
    hwnd: HWND,
    id: NodeId,
    view: WeakView,
    weak: std::rc::Weak<InputState>,
    bits: u32,
) -> Option<Editor> {
    let redraw = {
        let view = view.clone();
        move || {
            if let Some(view) = view.upgrade() {
                view.changed();
            }
        }
    };
    let after_timer = move || {
        if let (Some(view), Some(input)) = (view.upgrade(), weak.upgrade())
            && let Some(surface) = Surface::by_key(input.surface)
        {
            process(&surface, &view, &input);
        }
    };
    let editor = Editor::new(
        hwnd,
        Props {
            bits,
            ..Props::default()
        },
        Box::new(redraw),
        Box::new(after_timer),
    );
    if let Some(e) = &editor {
        // The text mode (only while empty), the notifications the
        // field follows, DirectWrite's shaping.
        e.send(EM_SETTEXTMODE, TEXT_MODE as usize, 0);
        let mask = ENM_CHANGE | ENM_SELCHANGE | ENM_STARTCOMPOSITION | ENM_ENDCOMPOSITION;
        e.send(EM_SETEVENTMASK, 0, mask as isize);
        // Text Services Framework input: dictation, the emoji
        // panel, the touch keyboard, reconversion, spelling.
        e.send(EM_SETEDITSTYLE, SES_USECTF as usize, SES_USECTF as isize);
        // Without `IMF_IMEALWAYSSENDNOTIFY`, RichEdit suppresses `EN_CHANGE`
        // and `EN_SELCHANGE` while an IME composes undetermined text, leaving
        // `onCompositionChange` (and a rich editor's inline preedit) empty
        // until commit.
        let (lang, _) = e.send(EM_GETLANGOPTIONS, 0, 0);
        e.send(
            EM_SETLANGOPTIONS,
            0,
            (lang.0 as u32 | IMF_IMEALWAYSSENDNOTIFY) as isize,
        );
        e.send(
            EM_SETTYPOGRAPHYOPTIONS,
            TO_ADVANCEDTYPOGRAPHY as usize,
            TO_ADVANCEDTYPOGRAPHY as isize,
        );
        e.take_notes();
    } else {
        log::error!("no RichEdit for input {id}");
    }
    editor
}

impl InputState {
    fn new(surface: &Surface, view: &NshView) -> Rc<Self> {
        Rc::new_cyclic(|weak: &std::rc::Weak<InputState>| {
            let weak_view = view.downgrade();
            let editor = make_editor(
                surface.hwnd(),
                view.id(),
                weak_view.clone(),
                weak.clone(),
                base_bits(&InputConfig::default()),
            );
            InputState {
                surface: surface.key(),
                id: view.id(),
                view: weak_view,
                me: weak.clone(),
                editor: RefCell::new(editor),
                use_gdi: Cell::new(false),
                config: RefCell::default(),
                configured: Cell::new(false),
                #[cfg(feature = "terminal")]
                terminal_replaced: RefCell::new(None),
                content: Cell::new(None),
                size: Cell::new((0.0, 0.0)),
                origin: Cell::new((0, 0)),
                scale: Cell::new(0.0),
                count: Cell::new(0),
                reported_text: RefCell::default(),
                reported: Cell::new((0, 0)),
                reported_caret: Cell::new(Bounds::default()),
                composing: Cell::new(None),
                composed: RefCell::new(None),
                pending: RefCell::new(None),
                programmatic: Cell::new(false),
                anim_color: Cell::new(None),
                focused: Cell::new(false),
                active: Cell::new(true),
                caret_on: Cell::new(true),
                reported_scroll: Cell::new(None),
                dragging: Cell::new(false),
                select_on_up: Cell::new(false),
                format: RefCell::new(None),
                font_generation: Cell::new(crate::text::font_generation()),
                placeholder: RefCell::new(None),
                drawn: RefCell::new(None),
            }
        })
    }

    pub(crate) fn editable(&self) -> bool {
        self.config.borrow().editable
    }

    fn multiline(&self) -> bool {
        self.config.borrow().multiline
    }

    fn with_editor<R>(&self, f: impl FnOnce(&Editor) -> R) -> Option<R> {
        let editor = self.editor.borrow();
        editor.as_ref().map(f)
    }

    /// Sends RichEdit a message (nothing without a control).
    fn send(&self, msg: u32, wparam: usize, lparam: isize) -> (LRESULT, bool) {
        self.with_editor(|e| e.send(msg, wparam, lparam))
            .unwrap_or((LRESULT(0), false))
    }

    /// The text, its line breaks `\n`, in UTF-16 units.
    fn units(&self) -> Vec<u16> {
        let Some(mut units) = self.with_editor(Editor::text_units) else {
            return Vec::new();
        };
        // RichEdit ends paragraphs with `\r`, one unit as `\n` is.
        for u in &mut units {
            if *u == u16::from(b'\r') {
                *u = u16::from(b'\n');
            }
        }
        units
    }

    fn text(&self) -> String {
        String::from_utf16_lossy(&self.units())
    }

    /// The text outside any composition in progress (all of it when none).
    fn committed_text(&self) -> String {
        let units = self.units();
        let Some((before, after)) = self.composing.get() else {
            return String::from_utf16_lossy(&units);
        };
        let Some(end) = units.len().checked_sub(after as usize) else {
            return String::from_utf16_lossy(&units);
        };
        let start = (before as usize).min(end);
        let mut committed = Vec::with_capacity(start + (units.len() - end));
        committed.extend_from_slice(&units[..start]);
        committed.extend_from_slice(&units[end..]);
        String::from_utf16_lossy(&committed)
    }

    fn selection(&self) -> (u32, u32) {
        self.with_editor(Editor::selection).unwrap_or((0, 0))
    }

    /// What of `text` may replace the selection: cut to what `maxLength`
    /// (characters, Unicode scalar values) leaves room for.
    fn fit<'a>(&self, text: &'a str) -> &'a str {
        let Some(max) = self.config.borrow().max_length else {
            return text;
        };
        let units = self.units();
        let (a, b) = self.selection();
        let start = (a.min(b) as usize).min(units.len());
        let end = (a.max(b) as usize).min(units.len());
        let kept = char_count(&units[..start]) + char_count(&units[end..]);
        clip_chars(text, (max as usize).saturating_sub(kept))
    }

    /// RichEdit's limit (`TxGetMaxLength`) for `maxLength`. RichEdit counts
    /// UTF-16 units, `maxLength` characters: the limit is the units the
    /// text has plus one per character of room left, set again after each
    /// edit, so what RichEdit inserts by itself (an input method's
    /// composition and commit, the emoji panel, a drop) stays within
    /// `maxLength` characters. A character of one unit leaves the limit as
    /// it was; one of two (an emoji) raises it by one, though RichEdit
    /// takes such a character by itself only while two characters of room
    /// are left. The field's own insertions (typing, pastes, `insertText`)
    /// cut their text by characters first ([`InputState::fit`]) and lift
    /// the limit ([`uncut`]), so they fill the room exactly.
    fn limit(&self) -> u32 {
        let Some(max) = self.config.borrow().max_length else {
            return i32::MAX as u32;
        };
        let units = self.units();
        let room = (max as usize).saturating_sub(char_count(&units));
        (units.len() + room).min(i32::MAX as usize) as u32
    }

    fn set_limit(&self, units: u32) {
        self.with_editor(|e| {
            if e.props().max_length != units {
                e.update(|p| p.max_length = units, TXTBIT_MAXLENGTHCHANGE);
            }
        });
    }

    /// Sets RichEdit's limit for the text it holds now
    /// ([`InputState::limit`]).
    fn follow_limit(&self) {
        if self.config.borrow().max_length.is_some() {
            self.set_limit(self.limit());
        }
    }

    /// The text being composed, while there is any.
    fn composed_text(&self) -> Option<String> {
        let (before, after) = self.composing.get()?;
        let units = self.units();
        let end = units.len().checked_sub(after as usize)?;
        let start = (before as usize).min(end);
        let text = String::from_utf16_lossy(&units[start..end]);
        (!text.is_empty()).then_some(text)
    }

    fn set_size(&self, size: (f32, f32)) {
        if self.size.replace(size) != size {
            self.placeholder.borrow_mut().take();
        }
    }

    /// Several lines too narrow for a character: the rich editor's sink, a
    /// point wide at its caret, which takes the typing and the input
    /// methods of an editor that draws its own text. Wrapped, RichEdit
    /// puts every character on a line of its own there, and input methods
    /// open their candidates by what they compose, which would go down a
    /// line with every character typed. Such a field keeps its text
    /// unwrapped and its caret at its left edge
    /// ([`InputState::keep_left`]).
    fn narrow(&self) -> bool {
        let width = self.size.get().0;
        let config = self.config.borrow();
        config.multiline && width > 0.0 && width < config.style.font_size.0
    }

    /// The property bits: the config's, unwrapped while the field is
    /// narrow, and without `TXTBIT_D2DDWRITE` while rendering a GDI-loaded
    /// custom memory font.
    fn bits(&self) -> u32 {
        let mut bits = base_bits(&self.config.borrow());
        if self.narrow() {
            bits &= !TXTBIT_WORDWRAP;
        }
        if self.use_gdi.get() {
            bits &= !TXTBIT_D2DDWRITE;
        }
        bits
    }

    /// A narrow field scrolls the start of what an input method composes,
    /// else the caret, to its left edge, which is where the field is: a
    /// composition starts there and runs on along the line, as in a field
    /// of any width, whatever the input method places its candidates by
    /// (the composition's start, its box or the caret). RichEdit scrolls
    /// several lines sideways only when told to (no `ES_AUTOHSCROLL`), so
    /// the composition stays put as it grows; it keeps the caret's line in
    /// view itself.
    fn keep_left(&self) {
        if !self.narrow() {
            return;
        }
        let at = match self.composing.get() {
            Some((before, _)) => before,
            None => self.selection().1,
        };
        self.with_editor(|e| e.scroll_to_left_edge(at));
    }

    fn keep_left_on(&self, e: &Editor) {
        if !self.narrow() {
            return;
        }
        let at = match self.composing.get() {
            Some((before, _)) => before,
            None => e.selection().1,
        };
        e.scroll_to_left_edge(at);
    }

    /// The text format of the config's font.
    fn format(&self) -> Option<IDWriteTextFormat> {
        let generation = crate::text::font_generation();
        if let Some((saved, f)) = &*self.format.borrow()
            && *saved == generation
        {
            return Some(f.clone());
        }
        let config = self.config.borrow();
        let s = &config.style;
        let resolved = crate::text::resolve_family(
            s.font_family.map(|f| f.name()).as_deref(),
            s.font_weight,
            s.italic,
        );
        let locale_name = config
            .locale
            .map(|locale| HSTRING::from(locale.as_str()))
            .unwrap_or_default();
        // SAFETY: COM calls with valid strings and live objects.
        let format = unsafe {
            crate::gfx::dwrite()
                .CreateTextFormat(
                    &resolved.name,
                    resolved.collection.as_ref(),
                    DWRITE_FONT_WEIGHT(s.font_weight as i32),
                    if s.italic {
                        DWRITE_FONT_STYLE_ITALIC
                    } else {
                        DWRITE_FONT_STYLE_NORMAL
                    },
                    DWRITE_FONT_STRETCH_NORMAL,
                    s.font_size.0.max(1.0),
                    &locale_name,
                )
                .ok()?
        };
        if let Some(fallback) = &resolved.fallback
            && let Ok(format1) = format.cast::<IDWriteTextFormat1>()
        {
            // SAFETY: COM call on the new format with a live fallback object.
            let _ = unsafe { format1.SetFontFallback(fallback) };
        }
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
        *self.format.borrow_mut() = Some((generation, format.clone()));
        Some(format)
    }

    /// A layout of `text` in the field's width.
    fn make_layout(
        &self,
        text: &[u16],
        align: DWRITE_TEXT_ALIGNMENT,
        multiline: bool,
    ) -> Option<IDWriteTextLayout> {
        let format = self.format()?;
        let width = self.size.get().0.max(1.0);
        // SAFETY: COM calls on the new layout.
        unsafe {
            let layout = crate::gfx::dwrite()
                .CreateTextLayout(text, &format, if multiline { width } else { 1.0e6 }, 1.0e6)
                .ok()?;
            let _ = layout.SetWordWrapping(if multiline {
                DWRITE_WORD_WRAPPING_EMERGENCY_BREAK
            } else {
                DWRITE_WORD_WRAPPING_NO_WRAP
            });
            let _ = layout.SetTextAlignment(align);
            Some(layout)
        }
    }

    /// The height of one line of the font (points).
    fn line_height(&self) -> f32 {
        self.make_layout(&[], DWRITE_TEXT_ALIGNMENT_LEADING, false)
            .map_or(self.config.borrow().style.font_size.0 * 1.3, |l| {
                metrics(&l).height
            })
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

    /// One line is centered vertically in the content box: how far down
    /// its client rectangle starts (points).
    fn inset(&self) -> f32 {
        if self.multiline() {
            return 0.0;
        }
        ((self.size.get().1 - self.line_height()) / 2.0).max(0.0)
    }

    /// A multiline field's vertical scroll in pixels: where it is and the
    /// farthest it goes (the last line at the content box's bottom).
    /// Clamp the wheel to the text's height rather than scrolling past its end.
    fn text_scroll(&self) -> Option<(i32, i32)> {
        let client = self.client();
        self.with_editor(|e| {
            let mut at = windows::Win32::Foundation::POINT::default();
            e.send(EM_GETSCROLLPOS, 0, &mut at as *mut _ as isize);
            let height = e.text_height(client.right - client.left)?;
            Some((at.y, (height - (client.bottom - client.top)).max(0)))
        })
        .flatten()
    }

    /// RichEdit's client rectangle: the content box in the window's client
    /// pixels (one line centered).
    fn client(&self) -> RECT {
        let (ox, oy) = self.origin.get();
        let s = self.scale.get().max(0.01);
        let (w, h) = self.size.get();
        let top = oy + (self.inset() * s).round() as i32;
        RECT {
            left: ox,
            top,
            right: ox + (w * s).round() as i32,
            bottom: top + (h * s).round() as i32,
        }
    }

    /// Moves RichEdit's client rectangle to where the content box of
    /// `view` is in the window now (it moves with scrolling and layout).
    fn follow(&self, view: &NshView) {
        let Some(surface) = Surface::by_key(self.surface) else {
            return;
        };
        let s = surface.scale();
        let content = content_rect(view, self);
        let origin = view
            .to_root()
            .and_then(|m| m.map(content.origin.x.0, content.origin.y.0))
            .map_or((0, 0), |(x, y)| {
                ((x * s).round() as i32, (y * s).round() as i32)
            });
        self.set_size((content.size.width.0, content.size.height.0));
        let scale_changed = self.scale.replace(s) != s;
        self.origin.set(origin);
        let shown = crate::app_window::hwnd_showing(&surface, view);
        self.with_editor(|e| e.show_in(shown));
        if scale_changed {
            self.apply_formats();
        }
        self.update_client();
    }

    /// Tells RichEdit its client rectangle if it changed, and whether the
    /// text wraps, which changes as the field becomes narrow or stops
    /// being narrow.
    fn update_client(&self) {
        self.with_editor(|e| self.update_client_on(e));
    }

    fn update_client_on(&self, e: &Editor) {
        let client = self.client();
        if e.props().client != client {
            e.update(|p| p.client = client, TXTBIT_CLIENTRECTCHANGE);
        }
        let bits = self.bits();
        if e.props().bits != bits {
            e.update(|p| p.bits = bits, 0);
            self.keep_left_on(e);
        }
    }

    /// Switches RichEdit between DirectWrite (`TXTBIT_D2DDWRITE`) and GDI
    /// (`TxDraw`) when the resolved font changes between system fonts and
    /// app-registered custom fonts. RichEdit commits to its rendering backend
    /// at `CreateTextServices` time, so changing the mode recreates the
    /// control while preserving its text, selection, scroll position and focus.
    fn ensure_editor_mode(&self, use_gdi: bool) {
        if self.use_gdi.get() == use_gdi {
            return;
        }
        let Some(surface) = Surface::by_key(self.surface) else {
            return;
        };
        let text = self.text();
        let state = self.with_editor(|e| {
            let mut scroll = windows::Win32::Foundation::POINT::default();
            e.send(EM_GETSCROLLPOS, 0, &mut scroll as *mut _ as isize);
            (e.selection(), scroll)
        });
        let Some((sel, scroll_pos)) = state else {
            self.use_gdi.set(use_gdi);
            return;
        };
        let shown_in = self.view.upgrade().map_or(surface.hwnd(), |v| {
            crate::app_window::hwnd_showing(&surface, &v)
        });
        let mut bits = base_bits(&self.config.borrow());
        if self.narrow() {
            bits &= !TXTBIT_WORDWRAP;
        }
        if use_gdi {
            bits &= !TXTBIT_D2DDWRITE;
        }
        let Some(new_editor) = make_editor(
            surface.hwnd(),
            self.id,
            self.view.clone(),
            self.me.clone(),
            bits,
        ) else {
            return;
        };
        new_editor.show_in(shown_in);
        self.use_gdi.set(use_gdi);
        self.composing.set(None);
        // Drop the previous editor before activating the replacement so its
        // timers and host state are cleaned up first.
        *self.editor.borrow_mut() = Some(new_editor);
        self.with_editor(|e| {
            if !text.is_empty() {
                self.programmatic.set(true);
                e.set_text(&text);
                self.programmatic.set(false);
            }
            let mut range = windows::Win32::UI::Controls::RichEdit::CHARRANGE {
                cpMin: sel.0.min(i32::MAX as u32) as i32,
                cpMax: sel.1.min(i32::MAX as u32) as i32,
            };
            e.send(EM_EXSETSEL, 0, &mut range as *mut _ as isize);
            if scroll_pos.x != 0 || scroll_pos.y != 0 {
                let mut pt = scroll_pos;
                e.send(EM_SETSCROLLPOS, 0, &mut pt as *mut _ as isize);
            }
            if self.focused.get() && self.active.get() {
                e.set_focus(true);
            }
            e.take_notes();
        });
    }

    fn resolve_font(&self) -> (u64, crate::text::ResolvedFamily) {
        let generation = crate::text::font_generation();
        let config = self.config.borrow();
        let style = &config.style;
        let resolved = crate::text::resolve_family(
            style.font_family.map(|f| f.name()).as_deref(),
            style.font_weight,
            style.italic,
        );
        (generation, resolved)
    }

    /// Makes RichEdit's formats and properties from the config at the
    /// current scale.
    fn apply_formats(&self) {
        let (generation, resolved) = self.resolve_font();
        self.ensure_editor_mode(resolved.gdi_custom);
        self.with_editor(|e| self.apply_formats_to(e, &resolved, generation));
    }

    fn apply_formats_to(
        &self,
        e: &Editor,
        resolved: &crate::text::ResolvedFamily,
        generation: u64,
    ) {
        let Some(surface) = Surface::by_key(self.surface) else {
            return;
        };
        let s = self.scale.get().max(0.01);
        // Points → pixels → the twips RichEdit converts back at GDI's DPI.
        let twips = 1440.0 / richedit::dpi(surface.hwnd());
        let config = self.config.borrow();
        let style = &config.style;
        let color = self.anim_color.get().unwrap_or(style.color);
        let bits = self.bits();
        let limit = self.limit_of(e);
        e.update(
            |p| {
                let cf = &mut p.char_format;
                cf.Base.dwMask = CFM_FACE
                    | CFM_SIZE
                    | CFM_WEIGHT
                    | CFM_BOLD
                    | CFM_ITALIC
                    | CFM_COLOR
                    | CFM_SPACING;
                cf.Base.yHeight = (style.font_size.0 * s * twips).round() as i32;
                cf.wWeight = style.font_weight;
                cf.Base.dwEffects = if style.italic {
                    CFE_ITALIC
                } else {
                    Default::default()
                };
                cf.Base.crTextColor = colorref(color);
                cf.sSpacing = (style.letter_spacing.0 * s * twips).round() as i16;
                copy_face_name(&mut cf.Base.szFaceName, &resolved.gdi_name);
                let pf = &mut p.para_format;
                pf.Base.dwMask = PFM_ALIGNMENT | PFM_LINESPACING | PFM_RTLPARA;
                pf.Base.wAlignment = match config.align {
                    TextAlign::Justify if config.multiline => PFA_JUSTIFY,
                    _ => match xalign(&config) {
                        a if a > 0.75 => PFA_RIGHT,
                        a if a > 0.25 => PFA_CENTER,
                        _ => PFA_LEFT,
                    },
                };
                pf.Base.Anonymous.wEffects = if config.rtl { 0x0001 } else { 0 };
                if config.multiline && style.line_height.0 > 0.0 {
                    // Exactly the line height.
                    pf.bLineSpacingRule = 4;
                    pf.dyLineSpacing = (style.line_height.0 * s * twips).round() as i32;
                } else {
                    pf.bLineSpacingRule = 0;
                    pf.dyLineSpacing = 0;
                }
                p.bits = bits;
                p.max_length = limit;
                p.scroll = scroll_flags(&config);
                p.highlight = config
                    .selection_color
                    .map(|c| (colorref(c), colorref(color)));
            },
            TXTBIT_CHARFORMATCHANGE
                | TXTBIT_PARAFORMATCHANGE
                | TXTBIT_MAXLENGTHCHANGE
                | TXTBIT_SCROLLBARCHANGE,
        );
        self.font_generation.set(generation);
        // Spelling (and the touch keyboard's suggestions) where the app
        // wants corrections: never in a password, shown or not.
        let spell =
            config.auto_correct && !config.secure && !config.visible_password() && config.editable;
        drop(config);
        let (options, _) = e.send(EM_GETLANGOPTIONS, 0, 0);
        let flags = IMF_SPELLCHECKING | IMF_TKBPREDICTION;
        let want = if spell {
            options.0 as u32 | flags
        } else {
            options.0 as u32 & !flags
        };
        if want != options.0 as u32 {
            e.send(EM_SETLANGOPTIONS, 0, want as isize);
        }
        self.update_client_on(e);
    }

    fn limit_of(&self, e: &Editor) -> u32 {
        let Some(max) = self.config.borrow().max_length else {
            return i32::MAX as u32;
        };
        let mut units = e.text_units();
        for u in &mut units {
            if *u == u16::from(b'\r') {
                *u = u16::from(b'\n');
            }
        }
        let room = (max as usize).saturating_sub(char_count(&units));
        (units.len() + room).min(i32::MAX as usize) as u32
    }

    /// Reports how far several lines scrolled, the text's height and the
    /// viewport's to a bar of the app's that follows them
    /// (`InputConfig::report_scroll`), when any of them changed since
    /// last reported.
    fn report_scroll(&self) {
        self.with_editor(|e| self.report_scroll_on(e));
    }

    fn report_scroll_on(&self, e: &Editor) {
        {
            let config = self.config.borrow();
            if !config.report_scroll || !config.multiline {
                return;
            }
        }
        let (w, h) = self.size.get();
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let s = self.scale.get().max(0.01);
        let (min, max, pos, _) = e.vscroll();
        let content = ((max - min) as f32 / s).max(h);
        let now = (pos as f32 / s, content, w, h);
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

    /// The caret in the content box (points: x, y, width, height).
    fn caret_rect(&self) -> Option<(f32, f32, f32, f32)> {
        self.with_editor(|e| self.caret_rect_on(e))
    }

    fn caret_rect_on(&self, e: &Editor) -> (f32, f32, f32, f32) {
        let caret = e.caret();
        let (ox, oy) = self.origin.get();
        let s = self.scale.get().max(0.01);
        (
            (caret.x - ox) as f32 / s,
            (caret.y - oy) as f32 / s,
            caret.width as f32 / s,
            caret.height as f32 / s,
        )
    }

    /// Records what RichEdit draws, in the content box's points, as
    /// `drawn`. While an input method's edit holds the text (committing a
    /// composition) RichEdit draws nothing: the last drawing stays, or the
    /// field would flash empty for a frame. Recorded with a context of
    /// its own, then drawn in the window's pass.
    fn record(&self, cx: &DrawCx<'_>, e: &Editor) {
        let (ox, oy) = self.origin.get();
        let s = cx.scale.max(0.01);
        let bounds = self.client();
        if self.use_gdi.get() {
            let bw = (bounds.right - bounds.left).max(0) as u32;
            let bh = (bounds.bottom - bounds.top).max(0) as u32;
            let Some(bgra) = e.draw_gdi_bgra(bounds) else {
                return;
            };
            let list = crate::decor::layer::with_context(cx.gfx, |dc| {
                // SAFETY: COM calls on a context nobody else draws with;
                // `bgra` holds `bw * 4 * bh` bytes and outlives `CreateBitmap`.
                unsafe {
                    let bmp_props = D2D1_BITMAP_PROPERTIES1 {
                        pixelFormat: D2D1_PIXEL_FORMAT {
                            format: DXGI_FORMAT_B8G8R8A8_UNORM,
                            alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                        },
                        dpiX: 96.0 * s,
                        dpiY: 96.0 * s,
                        bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                        colorContext: std::mem::ManuallyDrop::new(None),
                    };
                    let bmp = dc
                        .CreateBitmap(
                            D2D_SIZE_U {
                                width: bw,
                                height: bh,
                            },
                            Some(bgra.as_ptr().cast()),
                            bw * 4,
                            &bmp_props,
                        )
                        .ok()?;
                    let list = dc.CreateCommandList().ok()?;
                    dc.SetTarget(&list);
                    dc.SetDpi(96.0 * s, 96.0 * s);
                    dc.BeginDraw();
                    dc.SetTransform(&Matrix3x2::identity());
                    let dest = rect_f(
                        (bounds.left - ox) as f32 / s,
                        (bounds.top - oy) as f32 / s,
                        bw as f32 / s,
                        bh as f32 / s,
                    );
                    dc.DrawBitmap(
                        &bmp,
                        Some(&dest),
                        1.0,
                        D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                        None,
                        None,
                    );
                    let ended = dc.EndDraw(None, None);
                    dc.SetTarget(None);
                    (ended.is_ok() && list.Close().is_ok()).then_some(list)
                }
            })
            .flatten();
            if let Some(list) = list {
                self.drawn.replace(Some(list));
            }
            return;
        }
        let list = crate::decor::layer::with_context(cx.gfx, |dc| {
            // SAFETY: COM calls on a context nobody else draws with;
            // `EndDraw` follows `BeginDraw`, the list is closed before use.
            unsafe {
                let list = dc.CreateCommandList().ok()?;
                dc.SetTarget(&list);
                dc.SetDpi(96.0 * s, 96.0 * s);
                let params = cx.dc.GetTextRenderingParams().ok();
                dc.SetTextRenderingParams(params.as_ref());
                dc.BeginDraw();
                // RichEdit draws its client pixels in units of GDI's DPI,
                // not the target's: scaled to the target's (nothing on a
                // monitor at the system's scale), then the origin comes
                // back to the view's points.
                let k = Surface::by_key(self.surface)
                    .map_or(1.0, |surface| richedit::target_scale(surface.hwnd(), s));
                dc.SetTransform(&Matrix3x2 {
                    M11: k,
                    M12: 0.0,
                    M21: 0.0,
                    M22: k,
                    M31: -ox as f32 / s,
                    M32: -oy as f32 / s,
                });
                let drawn = e.draw(dc.as_raw(), bounds);
                let ended = dc.EndDraw(None, None);
                dc.SetTarget(None);
                (drawn && ended.is_ok() && list.Close().is_ok()).then_some(list)
            }
        })
        .flatten();
        if let Some(list) = list {
            self.drawn.replace(Some(list));
        }
    }
}

impl Hosted for InputState {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        self.set_size(size);
        let fonts_changed = self.font_generation.get() != crate::text::font_generation();
        let scale_changed = self.scale.get() != cx.scale;
        let resolved = if fonts_changed || scale_changed {
            if fonts_changed {
                self.format.borrow_mut().take();
                self.placeholder.borrow_mut().take();
            }
            let (generation, resolved) = self.resolve_font();
            self.ensure_editor_mode(resolved.gdi_custom);
            Some((generation, resolved))
        } else {
            None
        };
        let editor = self.editor.borrow();
        let Some(e) = editor.as_ref() else { return };
        // Inside the window's paint: what RichEdit invalidates while it
        // is told its size and drawn is drawn now (asking for another
        // paint here would be lost).
        let _drawing = e.drawing();
        if let Some((generation, resolved)) = resolved {
            self.scale.set(cx.scale);
            self.apply_formats_to(e, &resolved, generation);
        }
        self.update_client_on(e);
        self.record(cx, e);
        let (w, h) = size;
        let multiline = self.multiline();
        if multiline {
            cx.push_clip_rect(0.0, 0.0, w, h);
        } else {
            // One line may be taller than its box: it stays centered and the
            // view's bounds clip it.
            cx.push_clip_rect(0.0, -1.0e4, w, 2.0e4);
        }
        // Every change of the scroll, the text or the size draws again, so
        // a built-in bar hears of each here.
        self.report_scroll_on(e);
        let config = self.config.borrow();
        let color = self.anim_color.get().unwrap_or(config.style.color);
        let empty = e.text_units().is_empty();

        if empty && let Some(placeholder) = self.placeholder_layout() {
            let tint = config
                .placeholder_color
                .unwrap_or_else(|| color.with_alpha(0.5));
            let y = if multiline {
                0.0
            } else {
                (h - metrics(&placeholder).height) / 2.0
            };
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe {
                cx.dc.DrawTextLayout(
                    Vector2 { X: 0.0, Y: y },
                    &placeholder,
                    cx.solid(tint),
                    D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT,
                );
            }
        }
        // RichEdit lays the text out (and sizes its caret from the field's
        // format) only when it draws: an empty field is drawn too (nothing
        // shows, the background is transparent), or its first caret keeps
        // the height of the default font. The recording is in the content
        // box's points, as this item draws.
        // RichEdit takes the text color as a COLORREF, which has no alpha
        // (`colorref`): it would draw a transparent or translucent color
        // opaque. The color's alpha is applied to its drawing here instead,
        // so a field whose text is transparent (`OtpInput`'s, over its
        // cells) shows nothing of its text.
        let text_alpha = alpha(color);
        if text_alpha > 0.0
            && let Some(drawn) = &*self.drawn.borrow()
        {
            let faded = text_alpha < 1.0;
            if faded {
                cx.push_opacity(text_alpha);
            }
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe {
                cx.dc.DrawImage(
                    drawn,
                    None,
                    None,
                    D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                    D2D1_COMPOSITE_MODE_SOURCE_OVER,
                );
            }
            if faded {
                cx.pop();
            }
        }

        let caret = e.caret();
        let caret_shown = self.focused.get()
            && self.active.get()
            && self.caret_on.get()
            && caret.shown
            && config.editable
            && !config.caret_hidden;
        if caret_shown {
            let (x, y, cw, ch) = self.caret_rect_on(e);
            // On whole pixels, so that the caret stays sharp.
            let snap = |v: f32| (v * cx.scale).round() / cx.scale;
            let tint = config.caret_color.unwrap_or(color);
            // SAFETY: as above.
            unsafe {
                cx.dc.FillRectangle(
                    &rect_f(snap(x), y, cw.max(1.0 / cx.scale), ch),
                    cx.solid(tint),
                );
            }
        }
        let indicator = multiline && config.scrollbar_visible;
        drop(config);
        if indicator {
            // RichEdit has no window of its own: the `WS_VSCROLL` bar it
            // keeps the range of is never drawn, so the field draws the
            // platform's indicator over its text, as a scroll view does.
            let (min, max, pos, page) = e.vscroll();
            if let Some((x, y, bw, bh)) = indicator_thumb((w, h), min, max, pos, page, cx.scale) {
                crate::scroll::draw_knob(cx, x, y, bw, bh, 1.0);
            }
        }
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

/// RichEdit's text mode: rich text with many undo levels. Plain text mode
/// would suit the field's single format, but it ignores the paragraph
/// format's line spacing, which then drew lines at the font's height
/// instead of the line height the field is laid out with (#2655). The text
/// still keeps one format: the field never forwards the formatting
/// shortcuts, pastes insert plain text and RichEdit's drag and drop is off.
const TEXT_MODE: i32 = TM_RICHTEXT.0 | TM_MULTILEVELUNDO.0 | TM_MULTICODEPAGE.0;

/// The property bits of a config (DirectWrite drawing, rich text as
/// [`TEXT_MODE`] says, lines, read-only, password); RichEdit's own drag and
/// drop stays off (the window is the drop target of files).
fn base_bits(config: &InputConfig) -> u32 {
    // The selection shows only while the field has the keys, as on the
    // other platforms.
    let mut bits = TXTBIT_D2DDWRITE
        | TXTBIT_RICHTEXT
        | TXTBIT_AUTOWORDSEL
        | TXTBIT_DISABLEDRAG
        | TXTBIT_HIDESELECTION;
    if config.multiline {
        bits |= TXTBIT_MULTILINE | TXTBIT_WORDWRAP;
    }
    if !config.editable {
        bits |= TXTBIT_READONLY;
    }
    if config.secure {
        bits |= TXTBIT_USEPASSWORD;
    }
    bits
}

/// The alpha of a color, 0 to 1: what [`colorref`] leaves out.
fn alpha(c: Color) -> f32 {
    (c.0 & 0xff) as f32 / 255.0
}

fn colorref(c: Color) -> COLORREF {
    let v = c.0;
    let (r, g, b) = ((v >> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff);
    COLORREF(r | (g << 8) | (b << 16))
}

fn metrics(layout: &IDWriteTextLayout) -> DWRITE_TEXT_METRICS {
    let mut m = DWRITE_TEXT_METRICS::default();
    // SAFETY: a local out value.
    let _ = unsafe { layout.GetMetrics(&mut m) };
    m
}

/// Copies `face` into RichEdit's 32-unit `szFaceName` buffer, keeping a
/// trailing NUL and never splitting a UTF-16 surrogate pair.
fn copy_face_name(dst: &mut [u16; 32], face: &str) {
    *dst = [0; 32];
    let limit = dst.len() - 1;
    let mut pos = 0;
    for ch in face.chars() {
        let n = ch.len_utf16();
        if pos + n > limit {
            break;
        }
        ch.encode_utf16(&mut dst[pos..pos + n]);
        pos += n;
    }
}

/// The resolved face name of a `fontFamily` list at regular weight.
#[cfg(test)]
fn family(name: Option<&str>) -> String {
    crate::text::resolve_family(name, 400, false).gdi_name
}

/// Where a multiline field of `size` points draws its scroll indicator's
/// thumb, from RichEdit's vertical range (`min..max`, position `pos` and
/// page `page`, in pixels at `scale`); `None` when all the text fits.
fn indicator_thumb(
    size: (f32, f32),
    min: i32,
    max: i32,
    pos: i32,
    page: i32,
    scale: f32,
) -> Option<(f32, f32, f32, f32)> {
    use nsh_core::scroll::INDICATOR_THICK;
    const MARGIN: f32 = 2.0;
    const MIN_THUMB: f32 = 20.0;
    let (w, h) = size;
    let s = scale.max(0.01);
    let content = (max - min) as f32 / s;
    let viewport = if page > 0 { page as f32 / s } else { h };
    if content <= viewport + 0.5 || h <= 2.0 * MARGIN {
        return None;
    }
    let track = h - 2.0 * MARGIN;
    let thumb = (track * viewport / content).clamp(MIN_THUMB.min(track), track);
    let travel = (content - viewport).max(1.0);
    let at = ((pos - min) as f32 / s / travel).clamp(0.0, 1.0);
    let thick = INDICATOR_THICK.0;
    Some((
        w - thick - MARGIN,
        MARGIN + (track - thumb) * at,
        thick,
        thumb,
    ))
}

fn scroll_flags(config: &InputConfig) -> u32 {
    if !config.multiline {
        return ES_AUTOHSCROLL;
    }
    ES_AUTOVSCROLL | WS_VSCROLL.0
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

enum Held {
    Char(String),
    Key(KeyEvent),
    #[cfg(feature = "terminal")]
    Paste(nsh_core::PasteEvent),
    #[cfg(feature = "terminal")]
    TerminalComposition {
        expected: (u32, u64),
        commit: String,
        preedit: String,
        selection: Option<std::ops::Range<usize>>,
        active: bool,
    },
}

/// A surface's focused field, and whether its window is active.
#[derive(Default)]
struct Focus {
    view: Option<NshView>,
    inactive: bool,
    auto_focus: Option<NshView>,
    pending: VecDeque<Held>,
    armed: bool,
    after: u64,
    changing: bool,
    replaying: bool,
}

thread_local! {
    /// The focus of each surface of this thread, by surface key.
    static FOCUS: RefCell<FxHashMap<u64, Focus>> = RefCell::default();
}

/// An engine reload releases its old editor but keeps the window's activation state.
pub(crate) fn stopped(surface: &Surface) {
    let view = FOCUS.with(|focus| {
        focus
            .borrow_mut()
            .get_mut(&surface.key())
            .and_then(|focus| {
                focus.auto_focus = None;
                focus.pending.clear();
                focus.armed = false;
                focus.after = 0;
                focus.changing = false;
                focus.replaying = false;
                focus.view.take()
            })
    });
    if let Some(input) = view.as_ref().and_then(input_of) {
        input.focused.set(false);
        input.active.set(false);
        input.composing.set(None);
        input.with_editor(|e| e.set_focus(false));
    }
    blink::update();
}

/// Do not retain an editor after its owning native surface has gone away.
pub(crate) fn disposed(key: u64) {
    let _ = FOCUS.try_with(|focus| focus.borrow_mut().remove(&key));
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
            input.text()
        },
        read_only: !config.editable,
        password: config.secure,
    })
}

/// Replaces the field's text as typing it would (UI Automation's
/// `SetValue`): `maxLength` applies, undo takes it back and the change is
/// reported. False when it cannot (read-only).
#[allow(dead_code)] // For `crate::access`'s Value pattern.
pub(crate) fn set_accessible_value(surface: &Rc<Surface>, view: &NshView, text: &str) -> bool {
    let Some(input) = input_of(view) else {
        return false;
    };
    if !input.config.borrow().editable {
        return false;
    }
    let text = pasted(text, input.multiline());
    input.send(EM_SETSEL, 0, -1);
    replace_selection(&input, &text);
    process(surface, view, &input);
    true
}

/// `InputRef.insertText`: replaces the selection with `text` as a paste
/// would (`maxLength` applies, line breaks become spaces in a single-line
/// field, undo takes it back as one step and the change is reported), for
/// an app that took a paste over (`pasteBehavior: "report"`). Nothing
/// happens in a read-only field or during an IME composition.
pub(crate) fn insert_text(view: &NshView, text: &str) {
    let Some(input) = input_of(view) else {
        return;
    };
    if !input.config.borrow().editable || input.composing.get().is_some() {
        return;
    }
    let text = pasted(text, input.multiline());
    let (start, end) = input.selection();
    if text.is_empty() && start == end {
        return;
    }
    // A step of its own in the undo history, apart from typing around it.
    input.send(EM_STOPGROUPTYPING, 0, 0);
    replace_selection(&input, &text.replace('\n', "\r"));
    if let Some(surface) = surface_of(view) {
        process(&surface, view, &input);
    }
    view.changed();
}

/// The field that has the keyboard focus.
pub(crate) fn focused(surface: &Surface) -> Option<NshView> {
    focused_view(surface).filter(|view| view.state().input.is_some())
}

pub(crate) fn focused_has_selection(surface: &Surface) -> bool {
    focused(surface)
        .and_then(|view| input_of(&view))
        .is_some_and(|input| {
            let (start, end) = input.selection();
            start != end
        })
}

pub(crate) fn composing(view: &NshView) -> bool {
    input_of(view).is_some_and(|input| input.composing.get().is_some())
}

pub(crate) fn composing_focused(surface: &Surface) -> bool {
    focused(surface).is_some_and(|view| {
        if !is_replaying(surface) {
            #[cfg(feature = "terminal")]
            let expected = (view.id(), surface.terminal_focus_generation.get());
            if let Some(active) = FOCUS.with(|f| {
                f.borrow().get(&surface.key()).and_then(|focus| {
                    focus.pending.iter().rev().find_map(|held| match held {
                        #[cfg(feature = "terminal")]
                        Held::TerminalComposition {
                            expected: item_expected,
                            active,
                            ..
                        } if *item_expected == expected => Some(*active),
                        _ => None,
                    })
                })
            }) {
                return active;
            }
        }
        composing(&view)
    })
}

pub(crate) fn wants_text(surface: &Surface) -> bool {
    focused(surface)
        .and_then(|view| input_of(&view))
        .is_some_and(|input| input.config.borrow().editable)
}

fn can_hold_focus(surface: &Surface, view: &NshView) -> bool {
    if !view.attached() || !crate::navigation::in_focus_scope(surface, view) {
        return false;
    }
    let mut current = Some(view.clone());
    while let Some(node) = current {
        let state = node.state();
        if state.style.hidden
            || state.concealed
            || (node.kind() != nsh_core::ViewKind::Input
                && state.props.pointer_events == nsh_core::PointerEvents::None)
        {
            return false;
        }
        drop(state);
        current = node.parent_view();
    }
    true
}

pub(crate) fn focused_view(surface: &Surface) -> Option<NshView> {
    let view = FOCUS.with(|f| f.borrow().get(&surface.key()).and_then(|f| f.view.clone()))?;
    if can_hold_focus(surface, &view) {
        return Some(view);
    }
    drop_quietly(surface, &view);
    None
}

/// `view` was removed ([`crate::input::removed`]): a field in it loses the
/// focus without a blur, its `FOCUSED` state cleared.
pub(crate) fn removed(surface: &Surface, view: &NshView) {
    let field = FOCUS.with(|f| f.borrow().get(&surface.key()).and_then(|f| f.view.clone()));
    if let Some(field) = field
        && crate::input::holds(view, &field)
    {
        drop_quietly(surface, &field);
        crate::input::set_state(surface, &field, state::FOCUSED, false);
    }
}

/// The focused `field` loses the focus without a word.
fn drop_quietly(surface: &Surface, field: &NshView) {
    surface.terminal_focus_generation.set(
        surface
            .terminal_focus_generation
            .get()
            .checked_add(1)
            .expect("native focus generation exhausted"),
    );
    if let Some(input) = input_of(field) {
        input.focused.set(false);
        input.dragging.set(false);
        #[cfg(feature = "terminal")]
        cancel_terminal_preedit(&input);
        input.composing.set(None);
        input.with_editor(|e| e.set_focus(false));
    }
    FOCUS.with(|f| {
        if let Some(f) = f.borrow_mut().get_mut(&surface.key()) {
            f.view = None;
        }
    });
    crate::input::set_state(surface, field, state::FOCUSED, false);
    update_ime(surface);
    blink::update();
}

/// The surface's window was destroyed: forgets its focus entirely.
pub(crate) fn destroyed(surface: &Surface) {
    stopped(surface);
    FOCUS.with(|f| f.borrow_mut().remove(&surface.key()));
}

fn window_active(surface: &Surface) -> bool {
    FOCUS.with(|f| f.borrow().get(&surface.key()).is_none_or(|f| !f.inactive))
}

/// Moves the surface's focus to `view` (or nowhere), reporting the blur of
/// the field that had it, then the focus of the new one.
fn set_focus(surface: &Rc<Surface>, view: Option<&NshView>) {
    if let Some(target) = view
        && !can_hold_focus(surface, target)
    {
        return;
    }
    if let Some(view) = view {
        // A custom view of this window gives its keyboard focus to the
        // field, as the field's gives way to the view's
        // (`crate::keyboard`).
        crate::keyboard::blur_window(surface, crate::app_window::window_of(surface, view));
    }
    if view.is_some() {
        FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().auto_focus = None);
    }
    let old = focused_view(surface);
    set_changing(surface, true);
    if old.as_ref() != view {
        let moved_to = view.is_some();
        move_focus(surface, old, view);
        if wants_text(surface) && surface.events_handled() < surface.events_sent() {
            arm(surface);
        } else if moved_to && !behind(surface) && !has_pending(surface) {
            disarm(surface);
        }
    } else if view.is_some() {
        surface.sync_focus();
    }
    set_changing(surface, false);
    flush_pending(surface);
}

fn set_changing(surface: &Surface, changing: bool) {
    FOCUS.with(|f| {
        f.borrow_mut().entry(surface.key()).or_default().changing = changing;
    });
}

fn move_focus(surface: &Rc<Surface>, old: Option<NshView>, view: Option<&NshView>) {
    surface.terminal_focus_generation.set(
        surface
            .terminal_focus_generation
            .get()
            .checked_add(1)
            .expect("native focus generation exhausted"),
    );
    surface.chrome.context_area.take();
    crate::input::cancel_keyboard_press(surface);
    if let Some(old) = &old {
        notify_composition(surface, CPS_COMPLETE);
        if let Some(input) = input_of(old) {
            #[cfg(feature = "terminal")]
            cancel_terminal_preedit(&input);
            input.focused.set(false);
            input.dragging.set(false);
            input.composing.set(None);
            input.select_on_up.set(false);
            input.with_editor(|e| e.set_focus(false));
            process(surface, old, &input);
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
            input.follow(view);
            update_ime(surface);
            if input.active.get() {
                input.with_editor(|e| e.set_focus(true));
            }
            process(surface, view, &input);
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
}

pub(crate) fn arm(surface: &Surface) {
    let after = surface.events_sent();
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        focus.armed = true;
        focus.after = after;
    });
}

fn behind(surface: &Surface) -> bool {
    let after = FOCUS.with(|f| f.borrow().get(&surface.key()).map_or(0, |f| f.after));
    surface.events_handled() < after
}

pub(crate) fn engine_caught_up(surface: &Rc<Surface>) {
    if is_armed(surface) && !behind(surface) {
        flush_pending(surface);
        let has_auto = FOCUS.with(|f| {
            f.borrow()
                .get(&surface.key())
                .is_some_and(|focus| focus.auto_focus.is_some() || focus.changing)
        });
        if !behind(surface) && !has_pending(surface) && !has_auto {
            disarm(surface);
        }
    }
}

pub(crate) fn hold_key(surface: &Surface, event: &KeyEvent) -> bool {
    let m = event.modifiers;
    let vk = event.vk;
    let edits = matches!(
        vk,
        x if x == VK_RETURN.0
            || x == VK_BACK.0
            || x == VK_DELETE.0
            || x == 0x09
            || x == VK_LEFT.0
            || x == VK_RIGHT.0
            || x == VK_UP.0
            || x == VK_DOWN.0
            || x == VK_HOME.0
            || x == VK_END.0
            || x == VK_PRIOR.0
            || x == VK_NEXT.0
            || (0x70..=0x87).contains(&x)
    );
    let chord = (m.ctrl || m.alt || m.meta) && !crate::input::is_modifier(vk);
    if is_replaying(surface) || (event.down && !(edits || chord)) || !is_armed(surface) {
        return false;
    }
    let waiting_for_engine = behind(surface);
    FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let Some(focus) = map.get_mut(&surface.key()) else {
            return false;
        };
        if focus.pending.is_empty()
            && !waiting_for_engine
            && focus.auto_focus.is_none()
            && !focus.changing
        {
            return false;
        }
        if !event.down
            && !focus
                .pending
                .iter()
                .rev()
                .find_map(|held| match held {
                    Held::Key(key) if key.vk == vk => Some(key.down),
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

pub(crate) fn removing(surface: &Rc<Surface>, view: &NshView) {
    let inside = |candidate: &NshView| {
        let mut at = Some(candidate.clone());
        while let Some(node) = at {
            if node == *view {
                return true;
            }
            at = node.parent_view();
        }
        false
    };
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key())
            && focus.auto_focus.as_ref().is_some_and(inside)
        {
            focus.auto_focus = None;
        }
    });
    if let Some(old) = FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .and_then(|focus| focus.view.clone())
            .filter(inside)
    }) {
        set_changing(surface, true);
        move_focus(surface, Some(old), None);
        arm(surface);
        set_changing(surface, false);
    }
}

pub(crate) fn disarm(surface: &Surface) {
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.pending.clear();
            focus.armed = false;
        }
    });
}

pub(crate) fn is_armed(surface: &Surface) -> bool {
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

fn is_replaying(surface: &Surface) -> bool {
    FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .is_some_and(|focus| focus.replaying)
    })
}

fn with_replaying(surface: &Surface, run: impl FnOnce()) {
    let prev = FOCUS.with(|f| {
        let mut map = f.borrow_mut();
        let focus = map.entry(surface.key()).or_default();
        std::mem::replace(&mut focus.replaying, true)
    });
    run();
    FOCUS.with(|f| {
        if let Some(focus) = f.borrow_mut().get_mut(&surface.key()) {
            focus.replaying = prev;
        }
    });
}

fn queue_if_unsettled(surface: &Surface, operation: impl FnOnce() -> Held) -> bool {
    if is_replaying(surface) || !is_armed(surface) {
        return false;
    }
    let (changing, waits, has_auto) = FOCUS.with(|f| {
        f.borrow()
            .get(&surface.key())
            .map_or((false, false, false), |focus| {
                (
                    focus.changing,
                    !focus.pending.is_empty(),
                    focus.auto_focus.is_some(),
                )
            })
    });
    if !changing && !waits && !has_auto && !behind(surface) {
        disarm(surface);
        return false;
    }
    FOCUS.with(|f| {
        f.borrow_mut()
            .entry(surface.key())
            .or_default()
            .pending
            .push_back(operation());
    });
    true
}

fn flush_pending(surface: &Rc<Surface>) {
    if !is_armed(surface) && !wants_text(surface) {
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
        let needs_editable = match &next {
            Held::Char(_) => true,
            #[cfg(feature = "terminal")]
            Held::Paste(_) | Held::TerminalComposition { .. } => true,
            Held::Key(_) => false,
        };
        if needs_editable && !wants_text(surface) {
            if is_armed(surface) {
                FOCUS.with(|f| {
                    f.borrow_mut()
                        .entry(surface.key())
                        .or_default()
                        .pending
                        .push_front(next);
                });
            }
            return;
        }
        with_replaying(surface, || match next {
            Held::Char(text) => char_input_now(surface, &text),
            Held::Key(event) => {
                crate::input::key_now(surface, event);
            }
            #[cfg(feature = "terminal")]
            Held::Paste(content) => terminal_paste_now(surface, content),
            #[cfg(feature = "terminal")]
            Held::TerminalComposition {
                expected,
                commit,
                preedit,
                selection,
                active,
            } => {
                if focused(surface).map(|v| v.id()) == Some(expected.0)
                    && surface.terminal_focus_generation.get() == expected.1
                {
                    terminal_composition_now(surface, &commit, &preedit, selection, active);
                }
            }
        });
        taken = true;
    }
    if taken && !behind(surface) {
        disarm(surface);
    }
}

// --- The IME -----------------------------------------------------------------

/// Enables the IME on the window showing the focused editable, non-secure
/// field and on the host window RichEdit reads its input context from, and
/// detaches it from every other window of the surface.
fn update_ime(surface: &Surface) {
    let shown = FOCUS
        .with(|f| f.borrow().get(&surface.key()).and_then(|f| f.view.clone()))
        .filter(|v| {
            input_of(v).is_some_and(|input| {
                let c = input.config.borrow();
                c.editable && !c.secure
            })
        })
        .map(|v| crate::app_window::hwnd_showing(surface, &v));
    let host = surface.hwnd();
    for hwnd in crate::app_window::hwnds(surface).into_iter().chain([host]) {
        if hwnd.is_invalid() {
            continue;
        }
        let on = shown.is_some_and(|w| hwnd == w || hwnd == host);
        // SAFETY: plain calls on the surface's live windows; a null context
        // with no flags detaches the IME, IACE_DEFAULT restores the window's own.
        unsafe {
            let _ = ImmAssociateContextEx(hwnd, HIMC::default(), if on { IACE_DEFAULT } else { 0 });
        }
    }
}

/// Tells the IME to finish (`CPS_COMPLETE`) or drop (`CPS_CANCEL`) what it
/// composes.
fn notify_composition(surface: &Surface, action: NOTIFY_IME_INDEX) {
    let hwnd = surface.hwnd();
    if hwnd.is_invalid() {
        return;
    }
    // SAFETY: the context is released after use.
    unsafe {
        let himc = ImmGetContext(hwnd);
        if himc.is_invalid() {
            return;
        }
        let _ = ImmNotifyIME(himc, NI_COMPOSITIONSTR, action, 0);
        let _ = ImmReleaseContext(hwnd, himc);
    }
}

/// IME messages, which RichEdit handles for the focused field (it draws
/// the composition in place and places the candidates at its caret);
/// `None` for default handling.
pub(crate) fn ime(
    surface: &Rc<Surface>,
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> Option<LRESULT> {
    let view = focused(surface)?;
    let input = input_of(&view)?;
    let lparam = if msg == WM_IME_SETCONTEXT {
        // The composition is drawn in the field, not in the IME's own
        // window.
        LPARAM(lparam.0 & !(ISC_SHOWUICOMPOSITIONWINDOW as isize))
    } else {
        lparam
    };
    if msg == WM_IME_STARTCOMPOSITION {
        input.follow(&view);
    }
    let (result, handled) = input.send(msg, wparam.0, lparam.0);
    if matches!(
        msg,
        WM_IME_STARTCOMPOSITION | WM_IME_COMPOSITION | WM_IME_ENDCOMPOSITION
    ) {
        input.wake_caret();
        process(surface, &view, &input);
    }
    if handled {
        Some(result)
    } else {
        // SAFETY: default handling of the window's message.
        Some(unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) })
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
        let range = input.selection();
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

/// The caret in the input view's coordinates (`onCaretMove`'s `bounds`).
fn caret_bounds(view: &NshView, input: &InputState) -> Bounds<Points> {
    let Some((x, y, w, h)) = input.caret_rect() else {
        return Bounds::default();
    };
    let content = content_rect(view, input);
    Bounds {
        origin: Point::new(content.origin.x + Points(x), content.origin.y + Points(y)),
        size: Size::new(Points(w), Points(h)),
    }
}

/// Reports the composition if it started, changed or ended since last
/// reported (and JS listens).
fn report_composition(surface: &Surface, view: &NshView, input: &InputState) {
    let now = input.composed_text();
    if *input.composed.borrow() != now {
        input.composed.replace(now.clone());
        let shown = now.as_ref().map(|_| input.text());
        surface.control(|c| c.input_composing(view.id(), shown));
        send(surface, view, EventKind::CompositionChange, || {
            EventPayload::Map(vec![
                ("composing", PayloadValue::Bool(now.is_some())),
                ("text", PayloadValue::Str(now.unwrap_or_default())),
            ])
        });
    }
}

/// Reports the committed text with a new edit count if it differs from what
/// the engine has.
fn report_text(surface: &Surface, view: &NshView, input: &InputState) -> bool {
    let text = input.committed_text();
    if *input.reported_text.borrow() == text {
        return false;
    }
    let count = input.count.get() + 1;
    input.count.set(count);
    input.reported_text.replace(text.clone());
    // Always reported: the engine keeps the text for layout and for
    // dropping stale values, whether JS listens or not.
    surface.event(
        view.id(),
        EventKind::ChangeText,
        EventPayload::Text { text, count },
    );
    true
}

/// Turns what RichEdit noted since the last time into the field's events:
/// a composition's end, a new composition's start, edits (the text, or what
/// is composed), the selection and the caret. Returns whether the text changed.
fn process(surface: &Surface, view: &NshView, input: &InputState) -> bool {
    let Some(notes) = input.with_editor(Editor::take_notes) else {
        return false;
    };
    let started = notes
        .composition_start
        .map(|(start, end, len)| (start, len.saturating_sub(end)));
    let mut changed = false;
    if notes.composition_end {
        // The commit's `onChangeText`, then the composition's end; any
        // composition started since belongs to the next span, not the commit.
        input.composing.set(started);
        changed = report_text(surface, view, input);
        input.composing.set(None);
        report_composition(surface, view, input);
    }
    if started.is_some() {
        input.composing.set(started);
    }
    if (notes.changed || started.is_some()) && !input.programmatic.get() {
        if input.composing.get().is_some() {
            report_composition(surface, view, input);
        } else {
            changed |= report_text(surface, view, input);
        }
    }
    if input.composing.get().is_none() {
        let pending = input.pending.borrow_mut().take();
        if let Some((text, count)) = pending {
            set_value(view, input, &text, count);
        }
    }
    if notes.changed || notes.composition_end {
        input.follow_limit();
    }
    input.keep_left();
    if notes.changed || notes.selection {
        input.wake_caret();
        report_selection(surface, view, input);
    } else {
        report_caret(surface, view, input);
    }
    input.report_scroll();
    view.changed();
    changed
}

/// Replaces the selection with `text`, cut to what `maxLength` leaves room
/// for ([`InputState::fit`]); undo takes it back.
fn replace_selection(input: &InputState, text: &str) {
    let wide: Vec<u16> = input.fit(text).encode_utf16().chain(Some(0)).collect();
    uncut(input, || {
        input.send(EM_REPLACESEL, 1, wide.as_ptr() as isize);
    });
}

/// Runs `insert`, an insertion of text [`InputState::fit`] cut already, with
/// RichEdit's limit lifted, so that its count of UTF-16 units does not cut
/// it again; then sets the limit for the text it made.
fn uncut(input: &InputState, insert: impl FnOnce()) {
    if input.config.borrow().max_length.is_none() {
        insert();
        return;
    }
    input.set_limit(i32::MAX as u32);
    insert();
    input.set_limit(input.limit());
}

/// The characters (Unicode scalar values) of UTF-16 `units`; an unpaired
/// surrogate counts as one.
fn char_count(units: &[u16]) -> usize {
    char::decode_utf16(units.iter().copied()).count()
}

/// RichEdit owns native clipboard commands; terminal hosts supply the
/// clipboard through their transport instead of the hidden window.
fn edit_command(surface: &Surface, input: &InputState, msg: u32, wparam: usize, lparam: isize) {
    #[cfg(feature = "terminal")]
    if surface.terminal_active.get().is_some() && matches!(msg, WM_COPY | WM_CUT) {
        let config = input.config.borrow();
        if !config.secure && (msg != WM_CUT || config.editable) {
            let (start, end) = input.selection();
            if start != end {
                let text = input.units();
                crate::system::set_clipboard_text(&String::from_utf16_lossy(
                    &text[start as usize..end as usize],
                ));
                if msg == WM_CUT {
                    input.send(WM_CLEAR, 0, 0);
                }
            }
        }
        return;
    }
    let _ = surface;
    input.send(msg, wparam, lparam);
}

/// Return submitted the input (`blur`: and unfocuses it).
fn submit(surface: &Rc<Surface>, view: &NshView, input: &InputState, blur: bool) {
    key_press(surface, view, "Enter");
    let text = input.text();
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
    let input = InputState::new(surface, view);
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
    let (font_changed, editable_changed) = {
        let old = input.config.borrow();
        (
            old.style != config.style
                || old.multiline != config.multiline
                || old.locale != config.locale
                || input.font_generation.get() != crate::text::font_generation(),
            old.editable != config.editable || old.secure != config.secure,
        )
    };
    if font_changed {
        input.format.borrow_mut().take();
    }
    input.placeholder.borrow_mut().take();
    *input.config.borrow_mut() = config.clone();
    if input.scale.get() == 0.0 {
        input.scale.set(surface.scale());
    }
    input.apply_formats();
    if editable_changed && input.focused.get() {
        surface.terminal_focus_generation.set(
            surface
                .terminal_focus_generation
                .get()
                .checked_add(1)
                .expect("native focus generation exhausted"),
        );
        update_ime(surface);
    }
    let first = !input.configured.replace(true);
    if first && config.auto_focus {
        auto_focus(surface, view);
    }
    place(view, &input);
    // A built-in bar (newly) taking the indicator's place hears where the
    // text is now.
    input.reported_scroll.set(None);
    input.report_scroll();
    view.changed();
}

/// Focuses the field once it is on screen (the batch that made it may
/// insert it after configuring it).
fn auto_focus(surface: &Rc<Surface>, view: &NshView) {
    if can_hold_focus(surface, view) {
        return focus_selecting(surface, view);
    }
    FOCUS.with(|f| {
        f.borrow_mut().entry(surface.key()).or_default().auto_focus = Some(view.clone());
    });
}

pub(crate) fn end_batch(surface: &Rc<Surface>) {
    let view = FOCUS.with(|f| {
        f.borrow_mut()
            .get_mut(&surface.key())
            .and_then(|focus| focus.auto_focus.take())
    });
    let Some(view) = view else { return };
    if surface.view(view.id()).as_ref() != Some(&view) {
        return;
    }
    if can_hold_focus(surface, &view) {
        focus_selecting(surface, &view);
    } else {
        FOCUS.with(|f| {
            f.borrow_mut().entry(surface.key()).or_default().auto_focus = Some(view);
        });
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

/// Hosts the field at the content box.
fn place(view: &NshView, input: &Rc<InputState>) {
    let content = content_rect(view, input);
    if content.size.width.0 <= 0.0 || content.size.height.0 <= 0.0 {
        return;
    }
    input.follow(view);
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
    if input.composing.get().is_some() {
        input.pending.replace(Some((text.to_owned(), count)));
        return;
    }
    set_value(view, &input, text, count);
}

/// Applies JS's `text` unless the user edited since JS saw `count`. The
/// caret goes to the end of the new text.
fn set_value(view: &NshView, input: &InputState, text: &str, count: u32) {
    if count < input.count.get() {
        return;
    }
    if input.text() == text {
        input.reported_text.replace(text.to_owned());
        return;
    }
    if input.editor.borrow().is_none() {
        return;
    }
    input.programmatic.set(true);
    // The app's value is never cut to `maxLength`, as on every platform.
    uncut(input, || {
        input.with_editor(|e| e.set_text(text));
    });
    input.send(EM_SETSEL, usize::MAX >> 1, -1);
    input.programmatic.set(false);
    input.reported_text.replace(input.text());
    if let Some(surface) = surface_of(view) {
        process(&surface, view, input);
    } else {
        input.with_editor(Editor::take_notes);
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
        input.apply_formats();
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
    if input.focused.get()
        && let Some(surface) = surface_of(view)
    {
        report_caret(&surface, view, &input);
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
        focus_selecting(&surface, view);
    }
}

/// Focuses `view` without a press (`focus()`, `autoFocus`): with
/// `selectTextOnFocus`, its whole text selected as the focus arrives. A
/// press's own handling decides after it ([`pointer`]); Tab selects all
/// anyway ([`tab_to`]).
fn focus_selecting(surface: &Rc<Surface>, view: &NshView) {
    let arrives = focused(surface).as_ref() != Some(view);
    set_focus(surface, Some(view));
    if arrives
        && let Some(input) = input_of(view)
        && input.focused.get()
        && input.config.borrow().select_text_on_focus
    {
        input.send(EM_SETSEL, 0, -1);
        process(surface, view, &input);
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
    FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().auto_focus = None);
    set_focus(surface, None);
    if !has_pending(surface) {
        disarm(surface);
    }
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
        && !input.config.borrow().caret_hidden
    {
        input.send(EM_SETSEL, 0, -1);
        process(&surface, view, &input);
    }
}

/// `setSelection` (UTF-16 offsets).
pub(crate) fn set_selection(view: &NshView, start: u32, end: u32) {
    let Some(input) = input_of(view) else {
        return;
    };
    let mut range = windows::Win32::UI::Controls::RichEdit::CHARRANGE {
        cpMin: start.min(i32::MAX as u32) as i32,
        cpMax: end.min(i32::MAX as u32) as i32,
    };
    input.send(EM_EXSETSEL, 0, &mut range as *mut _ as isize);
    if input.focused.get() {
        input.wake_caret();
    }
    if let Some(surface) = surface_of(view) {
        process(&surface, view, &input);
    }
    view.changed();
}

/// Characters typed (`WM_CHAR`, the script's `type`). Control characters
/// are keys ([`key`] handles Return, Backspace and Tab).
pub(crate) fn char_input(surface: &Rc<Surface>, text: &str) {
    if queue_if_unsettled(surface, || Held::Char(text.to_owned())) {
        return;
    }
    char_input_now(surface, text);
}

fn char_input_now(surface: &Rc<Surface>, text: &str) {
    let Some(view) = focused(surface) else { return };
    let Some(input) = input_of(&view) else {
        return;
    };
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    if text.is_empty() || !input.config.borrow().editable {
        return;
    }
    input.follow(&view);
    let fit = input.fit(&text);
    uncut(&input, || {
        for unit in fit.encode_utf16() {
            input.send(WM_CHAR, unit as usize, 1);
        }
    });
    let changed = process(surface, &view, &input);
    if changed {
        key_press(surface, &view, key_of(fit));
    }
}

/// The window got (or lost) the keyboard focus: the focused field keeps
/// the focus (an app in the background keeps its field), without a caret.
pub(crate) fn window_focus(surface: &Rc<Surface>, focused_window: bool) {
    FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().inactive = !focused_window);
    if let Some(view) = focused(surface)
        && let Some(input) = input_of(&view)
    {
        input.active.set(focused_window);
        input.dragging.set(false);
        input.select_on_up.set(false);
        input.caret_on.set(true);
        input.with_editor(|e| e.set_focus(focused_window));
        process(surface, &view, &input);
        view.changed();
    }
    if focused_window {
        update_ime(surface);
    }
    blink::update();
}

/// `lparam` of a mouse message at the window's client pixel `(x, y)`.
fn mouse_lparam(x: i32, y: i32) -> isize {
    ((x as u16 as u32) | ((y as u16 as u32) << 16)) as i32 as isize
}

/// A pointer event on input `view` (its coordinates); true when handled.
pub(crate) fn pointer(surface: &Rc<Surface>, view: &NshView, event: &ItemPointer) -> bool {
    let Some(input) = input_of(view) else {
        return false;
    };
    if matches!(event.kind, PointerKind::Down) {
        let arrives = focused(surface).as_ref() != Some(view);
        // Focus scrolls RichEdit to its caret (the text's end after the
        // value was set); the press is hit against what shows, so the
        // field stays where it was until the press places the caret.
        let mut scroll = windows::Win32::Foundation::POINT::default();
        if arrives {
            input.send(EM_GETSCROLLPOS, 0, &mut scroll as *mut _ as isize);
        }
        set_focus(surface, Some(view));
        if arrives {
            input.send(EM_SETSCROLLPOS, 0, &mut scroll as *mut _ as isize);
        }
        // The press, sent to RichEdit after the focus arrived, places the
        // caret where it lands (or extends the selection, or starts a
        // drag): `selectTextOnFocus` waits for its release. A Shift or
        // double click selects for itself.
        input.select_on_up.set(
            arrives
                && input.focused.get()
                && input.config.borrow().select_text_on_focus
                && !event.modifiers.shift
                && event.clicks < 2,
        );
    }
    input.follow(view);
    let content = content_rect(view, &input);
    let (ox, oy) = input.origin.get();
    let s = input.scale.get().max(0.01);
    let x = ox + ((event.x - content.origin.x.0) * s).round() as i32;
    let y = oy + ((event.y - content.origin.y.0) * s).round() as i32;
    let mut keys = 0;
    if event.modifiers.shift {
        keys |= MK_SHIFT;
    }
    if event.modifiers.ctrl {
        keys |= MK_CONTROL;
    }
    let msg = match event.kind {
        PointerKind::Down => {
            if input.composing.get().is_some() {
                // What is composed is kept, where it was typed.
                notify_composition(surface, CPS_COMPLETE);
            }
            input.dragging.set(true);
            keys |= MK_LBUTTON;
            // RichEdit counts a third click itself (after a double one).
            if event.clicks == 2 {
                WM_LBUTTONDBLCLK
            } else {
                WM_LBUTTONDOWN
            }
        }
        PointerKind::Move => {
            if !input.dragging.get() {
                return false;
            }
            keys |= MK_LBUTTON;
            WM_MOUSEMOVE
        }
        PointerKind::Up | PointerKind::Cancel => {
            if !input.dragging.replace(false) {
                return false;
            }
            WM_LBUTTONUP
        }
        PointerKind::Leave => return false,
    };
    with_modifiers(event.modifiers, || {
        input.send(msg, keys, mouse_lparam(x, y));
    });
    if msg == WM_LBUTTONUP && input.select_on_up.take() {
        // A drag that selected a range keeps it.
        let (start, end) = input.selection();
        if start == end && matches!(event.kind, PointerKind::Up) {
            input.send(EM_SETSEL, 0, -1);
        }
    }
    process(surface, view, &input);
    true
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
    let Some((before, max)) = input.text_scroll() else {
        return false;
    };
    let s = input.scale.get().max(0.01);
    let to = (before as f32 + dy * s).round() as i32;
    // Up to the top; down to the last line, never further than it is.
    let y = if dy > 0.0 {
        to.min(max).max(before)
    } else {
        to.max(0)
    };
    if y == before {
        return false;
    }
    let mut at = windows::Win32::Foundation::POINT { x: 0, y };
    input.send(EM_SETSCROLLPOS, 0, &mut at as *mut _ as isize);
    view.changed();
    input.report_scroll();
    if input.focused.get()
        && let Some(surface) = surface_of(view)
    {
        report_caret(&surface, view, &input);
    }
    true
}

/// Whether `view` is a multiline input, which scrolls its own text under
/// a vertical wheel ([`can_wheel`]).
pub(crate) fn scrolls_text(view: &NshView) -> bool {
    input_of(view).is_some_and(|i| i.multiline())
}

/// Whether multiline input `view` has lines left to scroll towards `dy`
/// (down when positive): a wheel over it scrolls its text before the
/// scroll views around it, as a textarea does in browsers and on macOS.
pub(crate) fn can_wheel(view: &NshView, dy: f32) -> bool {
    let Some(input) = input_of(view) else {
        return false;
    };
    if dy == 0.0 || !input.multiline() {
        return false;
    }
    input
        .text_scroll()
        .is_some_and(|(at, max)| if dy > 0.0 { at < max } else { at > 0 })
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
    let s = input.scale.get().max(0.01);
    let mut at = windows::Win32::Foundation::POINT {
        x: 0,
        y: (y.0 * s).round().max(0.0) as i32,
    };
    input.send(EM_SETSCROLLPOS, 0, &mut at as *mut _ as isize);
    view.changed();
    input.report_scroll();
    if input.focused.get()
        && let Some(surface) = surface_of(view)
    {
        report_caret(&surface, view, &input);
    }
}

/// A right click on field `view`, or the Menu key or Shift+F10 in it: it
/// takes the focus (keeping its selection) and shows Windows' edit menu,
/// each item RichEdit's own command, at `at` (in the window's points) or
/// at the pointer.
pub(crate) fn context_menu(surface: &Rc<Surface>, view: &NshView, at: Option<(f32, f32)>) {
    use nsh_core::desktop::MenuRole;

    use crate::chrome::{Action, LocalItem};
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
    let (start, end) = input.selection();
    let len = input.units().len() as u32;
    let selected = start != end;
    let can_undo = input.send(EM_CANUNDO, 0, 0).0.0 != 0;
    let target = view.clone();
    let command = move |msg: u32, wparam: usize, lparam: isize| -> Action {
        let view = target.clone();
        Rc::new(move |s: &Rc<Surface>| {
            if let Some(input) = input_of(&view) {
                edit_command(s, &input, msg, wparam, lparam);
                process(s, &view, &input);
            }
        })
    };
    let paste_action: Action = {
        let view = view.clone();
        Rc::new(move |s: &Rc<Surface>| {
            if let Some(input) = input_of(&view) {
                paste(s, &view, &input);
            }
        })
    };
    let delete = surface.chrome.labels.borrow().delete.clone();
    let item =
        |role: Option<MenuRole>, label: &str, enabled: bool, action: Action| LocalItem::Item {
            role,
            label: label.to_owned(),
            enabled,
            action,
        };
    crate::chrome::popup_actions_at(
        surface,
        vec![
            item(
                Some(MenuRole::Undo),
                "",
                editable && can_undo,
                command(EM_UNDO, 0, 0),
            ),
            LocalItem::Separator,
            item(
                Some(MenuRole::Cut),
                "",
                editable && selected && !secure,
                command(WM_CUT, 0, 0),
            ),
            item(
                Some(MenuRole::Copy),
                "",
                selected && !secure,
                command(WM_COPY, 0, 0),
            ),
            item(
                Some(MenuRole::Paste),
                "",
                editable
                    && (crate::system::clipboard_has_text()
                        || (view.state().events.contains(EventKind::Paste)
                            && crate::system::clipboard_has_image())),
                paste_action,
            ),
            item(
                None,
                delete.as_deref().unwrap_or("Delete"),
                editable && selected,
                command(WM_CLEAR, 0, 0),
            ),
            LocalItem::Separator,
            item(
                Some(MenuRole::SelectAll),
                "",
                len > 0 && !(start == 0 && end >= len),
                command(EM_SETSEL, 0, -1),
            ),
        ],
        at,
        // At a corner of the field (the keyboard's menu): a right-to-left
        // layout's is its bottom-end one, which the menu opens leftwards from.
        at.is_some() && surface.mounter.try_borrow().is_ok_and(|m| m.rtl),
    );
}

/// Runs `f` with the keyboard state's Shift, Ctrl and Alt as `modifiers`
/// say (RichEdit reads them with `GetKeyState`): keys and clicks that do
/// not come from the keyboard (the test agent's, a menu's) carry theirs.
fn with_modifiers<R>(modifiers: Modifiers, f: impl FnOnce() -> R) -> R {
    let mut state = [0u8; 256];
    // SAFETY: a 256-byte buffer, as the call requires.
    if unsafe { GetKeyboardState(&mut state) }.is_err() {
        return f();
    }
    let held = |vk: u16| state[vk as usize] & 0x80 != 0;
    let wanted = [
        (VK_SHIFT.0, modifiers.shift),
        (VK_CONTROL.0, modifiers.ctrl),
        (VK_MENU.0, modifiers.alt),
    ];
    if wanted.iter().all(|&(vk, on)| held(vk) == on) {
        return f();
    }
    let mut changed = state;
    for (vk, on) in wanted {
        if on {
            changed[vk as usize] |= 0x80;
        } else {
            changed[vk as usize] &= !0x80;
        }
    }
    // SAFETY: the thread's keyboard state, restored after the call.
    unsafe {
        let _ = SetKeyboardState(&changed);
        let r = f();
        let _ = SetKeyboardState(&state);
        r
    }
}

/// Sends RichEdit key `vk` as the keyboard would (down, then up).
fn send_key(input: &InputState, vk: u16, modifiers: Modifiers) {
    // SAFETY: a plain query.
    let scan = unsafe { MapVirtualKeyW(vk.into(), MAPVK_VK_TO_VSC) };
    let extended = [
        VK_LEFT, VK_RIGHT, VK_UP, VK_DOWN, VK_HOME, VK_END, VK_PRIOR, VK_NEXT, VK_INSERT, VK_DELETE,
    ]
    .iter()
    .any(|k| k.0 == vk);
    let lparam = 1 | ((scan as isize) << 16) | if extended { 1 << 24 } else { 0 };
    with_modifiers(modifiers, || {
        input.send(WM_KEYDOWN, vk as usize, lparam);
        input.send(WM_KEYUP, vk as usize, lparam | (3 << 30));
    });
}

/// True when a Copy key (Ctrl+C, Ctrl+Insert) is for a selection outside the
/// field: it selects nothing itself, and a text or a selectable view of the
/// surface selects something.
fn copy_is_elsewhere(surface: &Surface, input: &InputState) -> bool {
    let (start, end) = input.selection();
    start == end
        && (crate::text::has_selection(surface) || crate::selectable_view::has_selection(surface))
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
    let (editable, multiline) = {
        let c = input.config.borrow();
        (c.editable, c.multiline)
    };
    let vk = event.vk;
    input.follow(&view);
    // Keys RichEdit takes as they are.
    let forward = |input: &InputState| {
        send_key(input, vk, m);
        process(surface, &view, input);
        true
    };
    match vk {
        // Alt+Left goes back, from a field too (`navigation::key_pressed`).
        _ if (vk == VK_LEFT.0 || vk == VK_RIGHT.0) && !m.alt => forward(&input),
        _ if (vk == VK_HOME.0 || vk == VK_END.0) && !m.alt => forward(&input),
        _ if multiline
            && !m.alt
            && (vk == VK_UP.0 || vk == VK_DOWN.0 || vk == VK_PRIOR.0 || vk == VK_NEXT.0) =>
        {
            forward(&input)
        }
        _ if vk == VK_BACK.0 || vk == VK_DELETE.0 => {
            if !editable {
                return true;
            }
            let empty = input.units().is_empty();
            if vk == VK_DELETE.0 && m.shift && !m.ctrl {
                edit_command(surface, &input, WM_CUT, 0, 0);
            } else {
                send_key(&input, vk, m);
            }
            // Backspace in an empty field deletes nothing but is still a
            // key press; Shift+Delete cuts, which is no key press.
            let changed = process(surface, &view, &input);
            let cut = vk == VK_DELETE.0 && m.shift && !m.ctrl;
            if (changed || empty) && !cut {
                key_press(surface, &view, "Backspace");
            }
            true
        }
        _ if vk == VK_RETURN.0 => {
            if input.composing.get().is_some() {
                // The IME takes the return that commits a composition (it
                // comes as `VK_PROCESSKEY`); one that comes anyway only
                // commits it.
                notify_composition(surface, CPS_COMPLETE);
                return true;
            }
            let behavior = input.config.borrow().submit();
            match return_key(behavior, multiline, m) {
                None => {
                    if editable {
                        replace_selection(&input, "\r");
                        if process(surface, &view, &input) {
                            key_press(surface, &view, "Enter");
                        }
                    }
                }
                Some(blur) => submit(surface, &view, &input, blur),
            }
            true
        }
        // Reported as on macOS and Linux; navigation then takes the focus
        // from the field (`navigation::key_pressed`).
        _ if vk == VK_ESCAPE.0 => {
            if input.composing.get().is_some() {
                notify_composition(surface, CPS_CANCEL);
                return true;
            }
            if !m.ctrl && !m.alt && !event.repeat {
                key_press(surface, &view, "Escape");
            }
            false
        }
        _ if m.ctrl && !m.alt => match vk {
            // A copy with nothing selected in the field is for the selection
            // of the text around it, which goes on to `text::key` and
            // `selectable_view::key`: a chat's composer keeps the focus
            // while the messages above it are selected. What the field
            // selects itself still copies first.
            0x43 if copy_is_elsewhere(surface, &input) => false,
            _ if vk == VK_INSERT.0 && !m.shift && copy_is_elsewhere(surface, &input) => false,
            // Select all, copy, cut, undo: RichEdit's (a password copies
            // and cuts nothing).
            0x41 => forward(&input),
            0x43 | 0x58 => {
                edit_command(
                    surface,
                    &input,
                    if vk == 0x43 { WM_COPY } else { WM_CUT },
                    0,
                    0,
                );
                process(surface, &view, &input);
                true
            }
            _ if vk == VK_INSERT.0 && !m.shift => {
                edit_command(surface, &input, WM_COPY, 0, 0);
                process(surface, &view, &input);
                true
            }
            0x56 => {
                if editable {
                    paste(surface, &view, &input);
                }
                true
            }
            0x5A if !m.shift => {
                if editable {
                    input.send(EM_UNDO, 0, 0);
                    process(surface, &view, &input);
                }
                true
            }
            0x59 | 0x5A => {
                if editable && input.send(EM_CANREDO, 0, 0).0.0 != 0 {
                    input.send(EM_REDO, 0, 0);
                    process(surface, &view, &input);
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
        replace_selection(input, &text.replace('\n', "\r"));
        process(surface, view, input);
    }
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
                .filter_map(|f| f.view.clone())
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

/// The terminal input method edits the same windowless RichEdit control.
#[cfg(feature = "terminal")]
pub(crate) fn terminal_target(surface: &Surface) -> Option<(u64, Bounds<Points>)> {
    let view = focused(surface)?;
    let input = input_of(&view)?;
    if !input.config.borrow().editable {
        return None;
    }
    let caret = caret_bounds(&view, &input);
    let (x, y, w, h) = view.to_root()?.bounds(
        caret.origin.x.0,
        caret.origin.y.0,
        caret.size.width.0,
        caret.size.height.0,
    )?;
    Some((u64::from(view.id()), crate::geom::rect(x, y, w, h)))
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_candidate(surface: &Surface) -> Option<Bounds<Points>> {
    use windows::Win32::{Foundation::POINTL, UI::WindowsAndMessaging::WM_USER};

    // RichEdit.h's message; win32metadata exposes only the plain Edit variant.
    const EM_POSFROMCHAR: u32 = WM_USER + 38;

    let view = focused(surface)?;
    let input = input_of(&view)?;
    if !input.config.borrow().editable {
        return None;
    }
    let (mut x, mut y, width, height) = input.caret_rect()?;
    if let Some((start, _)) = input.composing.get() {
        let mut position = POINTL::default();
        // RichEdit owns the layout and scrolling; a candidate window follows
        // the composition's start, independently of its selected range.
        let (_, handled) = input.send(
            EM_POSFROMCHAR,
            (&mut position as *mut POINTL) as usize,
            start as isize,
        );
        if !handled {
            return None;
        }
        let (ox, oy) = input.origin.get();
        let scale = input.scale.get();
        x = (position.x - ox) as f32 / scale;
        y = (position.y - oy) as f32 / scale;
    }
    let content = content_rect(&view, &input);
    let (x, y, width, height) = view.to_root()?.bounds(
        content.origin.x.0 + x,
        content.origin.y.0 + y,
        width,
        height,
    )?;
    Some(crate::geom::rect(x, y, width, height))
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_composition(
    surface: &Rc<Surface>,
    commit: &str,
    preedit: &str,
    selection: Option<std::ops::Range<usize>>,
    active: bool,
) -> Result<(), String> {
    let check = selection.clone().unwrap_or(preedit.len()..preedit.len());
    if check.start > check.end
        || check.end > preedit.len()
        || !preedit.is_char_boundary(check.start)
        || !preedit.is_char_boundary(check.end)
    {
        return Err("composition selection is not a UTF-8 boundary".into());
    }
    if commit.is_empty() && preedit.is_empty() && !active && !has_pending(surface) {
        terminal_composition_now(surface, commit, preedit, selection, active);
        return Ok(());
    }
    let Some(expected_view) = focused(surface) else {
        return Ok(());
    };
    let expected = (expected_view.id(), surface.terminal_focus_generation.get());
    if queue_if_unsettled(surface, || Held::TerminalComposition {
        expected,
        commit: commit.to_owned(),
        preedit: preedit.to_owned(),
        selection: selection.clone(),
        active,
    }) {
        return Ok(());
    }
    terminal_composition_now(surface, commit, preedit, selection, active);
    Ok(())
}

#[cfg(feature = "terminal")]
fn terminal_composition_now(
    surface: &Rc<Surface>,
    commit: &str,
    preedit: &str,
    selection: Option<std::ops::Range<usize>>,
    active: bool,
) {
    let Some(view) = focused(surface) else { return };
    let Some(input) = input_of(&view) else { return };
    if !input.editable() {
        return;
    }
    input.follow(&view);
    let events_before = surface.events_sent();
    // Replace only the previous preedit. Preserve the selected text so a
    // cancelled terminal composition restores it without a user edit.
    if let Some((before, after)) = input.composing.get() {
        let end = input.units().len().saturating_sub(after as usize) as u32;
        input.send(EM_SETSEL, before as usize, end as isize);
        replace_preedit(&input, "");
    } else if active || !commit.is_empty() {
        let (start, end) = input.selection();
        let units = input.units();
        input
            .terminal_replaced
            .replace(Some(String::from_utf16_lossy(
                &units[start as usize..end as usize],
            )));
    }
    if !commit.is_empty() {
        input.composing.set(None);
        replace_selection(&input, &commit.replace('\n', "\r"));
        process(surface, &view, &input);
        input.terminal_replaced.borrow_mut().take();
    }
    if active {
        if input.terminal_replaced.borrow().is_none() {
            input.terminal_replaced.replace(Some(String::new()));
        }
        let (start, end) = input.selection();
        let after = input.units().len().saturating_sub(end as usize) as u32;
        input.composing.set(Some((start, after)));
        replace_preedit(&input, &preedit.replace('\n', "\r"));
        let selection = selection.unwrap_or(preedit.len()..preedit.len());
        let selected_start = start + preedit[..selection.start].encode_utf16().count() as u32;
        let selected_end = start + preedit[..selection.end].encode_utf16().count() as u32;
        input.send(EM_SETSEL, selected_start as usize, selected_end as isize);
    } else {
        if commit.is_empty()
            && let Some(replaced) = input.terminal_replaced.borrow_mut().take()
        {
            replace_preedit(&input, &replaced.replace('\n', "\r"));
        }
        input.composing.set(None);
    }
    process(surface, &view, &input);
    report_composition(surface, &view, &input);
    if !active && surface.events_sent() > events_before {
        arm(surface);
    }
}

#[cfg(feature = "terminal")]
fn replace_preedit(input: &InputState, text: &str) {
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    input.send(EM_REPLACESEL, 0, wide.as_ptr() as isize);
}

#[cfg(feature = "terminal")]
fn cancel_terminal_preedit(input: &InputState) {
    if let Some(replaced) = input.terminal_replaced.borrow_mut().take()
        && let Some((before, after)) = input.composing.get()
    {
        let end = input.units().len().saturating_sub(after as usize) as u32;
        input.send(EM_SETSEL, before as usize, end as isize);
        replace_preedit(input, &replaced.replace('\n', "\r"));
    }
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_paste(surface: &Rc<Surface>, content: nsh_core::PasteEvent) {
    if queue_if_unsettled(surface, || Held::Paste(content.clone())) {
        return;
    }
    terminal_paste_now(surface, content);
}

#[cfg(feature = "terminal")]
fn terminal_paste_now(surface: &Surface, content: nsh_core::PasteEvent) {
    let Some(view) = focused(surface) else {
        return;
    };
    let Some(input) = input_of(&view) else {
        return;
    };
    if view.state().events.contains(EventKind::Paste) {
        surface.event(
            view.id(),
            EventKind::Paste,
            EventPayload::Paste(Box::new(content.clone())),
        );
    }
    if input.config.borrow().paste_behavior == nsh_core::PasteBehavior::Insert {
        let text = pasted(&content.text, input.multiline());
        if !text.is_empty() {
            replace_selection(&input, &text.replace('\n', "\r"));
            process(surface, &view, &input);
        }
    }
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_text(surface: &Surface) -> Option<String> {
    let view = focused(surface)?;
    let input = input_of(&view)?;
    if input.config.borrow().secure {
        return None;
    }
    let text = input.reported_text.borrow().clone();
    Some(text)
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_validate_selection(
    surface: &Surface,
    range: &std::ops::Range<usize>,
) -> Result<(), String> {
    let view = focused(surface).ok_or("no focused native editor")?;
    let input = input_of(&view).ok_or("no focused native editor")?;
    let text = input.text();
    if range.start > range.end {
        return Err("inverted text selection".into());
    }
    crate::terminal::utf16_offset(&text, range.start)?;
    crate::terminal::utf16_offset(&text, range.end)?;
    Ok(())
}

#[cfg(feature = "terminal")]
pub(crate) fn terminal_is_composing(surface: &Surface) -> bool {
    composing_focused(surface)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indicator_thumb_follows_the_text_scroll() {
        // All the text fits: no thumb.
        assert_eq!(indicator_thumb((100.0, 50.0), 0, 50, 0, 50, 1.0), None);
        // 4 pages of text at 175%: a quarter of the track, at the top, then at the bottom.
        let s = 1.75;
        let page = (50.0 * s) as i32;
        let max = page * 4;
        let (x, y, _, h) = indicator_thumb((100.0, 50.0), 0, max, 0, page, s).unwrap();
        assert!(x > 90.0 && (y - 2.0).abs() < 0.01 && (h - 20.0).abs() < 0.5);
        let (_, y, _, h) = indicator_thumb((100.0, 50.0), 0, max, max - page, page, s).unwrap();
        assert!((y + h - 48.0).abs() < 0.01);
    }

    #[test]
    fn multiline_scrollbars_have_native_overflow_ranges() {
        for editable in [false, true] {
            let config = InputConfig {
                multiline: true,
                editable,
                ..Default::default()
            };
            let editor = Editor::new(
                HWND::default(),
                Props {
                    client: RECT {
                        right: 160,
                        bottom: 80,
                        ..Default::default()
                    },
                    bits: base_bits(&config),
                    scroll: scroll_flags(&config),
                    ..Default::default()
                },
                Box::new(|| {}),
                Box::new(|| {}),
            )
            .expect("RichEdit");
            let line =
                "<entry name=\"a-long-xml-attribute-that-overflows-the-report-viewport\" />\r\n";
            editor.set_text(&line.repeat(40));
            editor.send(0x00BA, 0, 0); // EM_GETLINECOUNT forces text layout.
            let (min, max, _, _) = editor.vscroll();
            assert!(max - min > 80, "vertical overflow missing: {min}..{max}");
        }
    }

    /// Several lines are as far apart as the line height says, the same
    /// height the field is laid out with, also for text the field held
    /// before the line height was set (#2655).
    #[test]
    fn multiline_lines_follow_the_line_height() {
        // Where the 12th of 12 lines starts below the first, in pixels.
        let travel = |twips: i32| {
            let config = InputConfig {
                multiline: true,
                ..Default::default()
            };
            let editor = Editor::new(
                HWND::default(),
                Props {
                    client: RECT {
                        right: 800,
                        bottom: 2000,
                        ..Default::default()
                    },
                    bits: base_bits(&config),
                    ..Default::default()
                },
                Box::new(|| {}),
                Box::new(|| {}),
            )
            .expect("RichEdit");
            editor.send(EM_SETTEXTMODE, TEXT_MODE as usize, 0);
            editor.set_text(&["The quick brown fox"; 12].join("\r"));
            editor.update(
                |p| {
                    let pf = &mut p.para_format;
                    pf.Base.dwMask = PFM_LINESPACING;
                    pf.bLineSpacingRule = 4;
                    pf.dyLineSpacing = twips;
                },
                TXTBIT_PARAFORMATCHANGE,
            );
            let y = |line: usize| {
                let (index, _) = editor.send(0x00BB, line, 0); // EM_LINEINDEX
                let mut at = windows::Win32::Foundation::POINTL::default();
                editor.send(0x00D6, &mut at as *mut _ as usize, index.0); // EM_POSFROMCHAR
                at.y
            };
            y(11) - y(0)
        };
        let (single, double) = (travel(400), travel(800));
        assert!(single > 0, "lines not laid out: {single}");
        assert!(
            (double - 2 * single).abs() <= 11,
            "line spacing ignored: {single} px at 400 twips, {double} px at 800"
        );
    }

    /// The font the field sets reaches the text it already holds: one
    /// format for all of it, as the text mode promises ([`TEXT_MODE`]).
    #[test]
    fn rich_text_mode_reads_back_only_the_text_typed() {
        for multiline in [false, true] {
            let config = InputConfig {
                multiline,
                ..Default::default()
            };
            let editor = Editor::new(
                HWND::default(),
                Props {
                    client: RECT {
                        right: 800,
                        bottom: 200,
                        ..Default::default()
                    },
                    bits: base_bits(&config),
                    ..Default::default()
                },
                Box::new(|| {}),
                Box::new(|| {}),
            )
            .expect("RichEdit");
            editor.send(EM_SETTEXTMODE, TEXT_MODE as usize, 0);
            // RichEdit's own end of the story is not the field's text.
            assert_eq!(editor.text_units(), Vec::<u16>::new(), "empty");
            editor.set_text("/");
            assert_eq!(String::from_utf16_lossy(&editor.text_units()), "/");
            if multiline {
                // A line break the user typed at the end stays.
                editor.set_text("a\r");
                assert_eq!(String::from_utf16_lossy(&editor.text_units()), "a\r");
            }
        }
    }

    #[test]
    fn font_changes_reach_held_text() {
        let config = InputConfig {
            multiline: true,
            ..Default::default()
        };
        let editor = Editor::new(
            HWND::default(),
            Props {
                client: RECT {
                    right: 800,
                    bottom: 2000,
                    ..Default::default()
                },
                bits: base_bits(&config),
                ..Default::default()
            },
            Box::new(|| {}),
            Box::new(|| {}),
        )
        .expect("RichEdit");
        editor.send(EM_SETTEXTMODE, TEXT_MODE as usize, 0);
        editor.set_text(&["The quick brown fox"; 12].join("\r"));
        // Where the 12th of 12 lines starts below the first, in pixels.
        let travel = || {
            let y = |line: usize| {
                let (index, _) = editor.send(0x00BB, line, 0); // EM_LINEINDEX
                let mut at = windows::Win32::Foundation::POINTL::default();
                editor.send(0x00D6, &mut at as *mut _ as usize, index.0); // EM_POSFROMCHAR
                at.y
            };
            y(11) - y(0)
        };
        let size = |twips: i32| {
            editor.update(
                |p| {
                    p.char_format.Base.dwMask = CFM_SIZE;
                    p.char_format.Base.yHeight = twips;
                },
                TXTBIT_CHARFORMATCHANGE,
            );
            travel()
        };
        let (small, large) = (size(200), size(600));
        assert!(small > 0, "lines not laid out: {small}");
        assert!(
            large > 2 * small,
            "font size ignored: {small} px at 10 pt, {large} px at 30 pt"
        );
    }

    /// Rich text's final paragraph mark ([`TEXT_MODE`]) is not the
    /// field's: its text, selection and limit leave it out.
    #[test]
    fn rich_text_keeps_its_final_mark_out_of_the_text() {
        for multiline in [false, true] {
            let config = InputConfig {
                multiline,
                ..Default::default()
            };
            let editor = Editor::new(
                HWND::default(),
                Props {
                    client: RECT {
                        right: 800,
                        bottom: 200,
                        ..Default::default()
                    },
                    bits: base_bits(&config),
                    ..Default::default()
                },
                Box::new(|| {}),
                Box::new(|| {}),
            )
            .expect("RichEdit");
            editor.send(EM_SETTEXTMODE, TEXT_MODE as usize, 0);
            let text = || String::from_utf16_lossy(&editor.text_units());
            assert_eq!(text(), "", "multiline {multiline}");
            editor.send(EM_SETSEL, 0, -1);
            assert_eq!(editor.selection(), (0, 0), "multiline {multiline}");
            editor.set_text("own words");
            assert_eq!(text(), "own words", "multiline {multiline}");
            editor.send(EM_SETSEL, 0, -1);
            assert_eq!(editor.selection(), (0, 9), "multiline {multiline}");
            if multiline {
                editor.set_text("a\rb\r");
                assert_eq!(text(), "a\rb\r");
            }
            // As many units as the limit says, typed.
            editor.set_text("");
            editor.update(|p| p.max_length = 5, TXTBIT_MAXLENGTHCHANGE);
            for _ in 0..7 {
                editor.send(WM_CHAR, 'a' as usize, 1);
            }
            assert_eq!(text(), "aaaaa", "multiline {multiline}");
        }
    }

    #[test]
    fn stop_and_destroy_forget_the_focus() {
        let surface = Surface::new(Default::default());
        FOCUS.with(|f| f.borrow_mut().entry(surface.key()).or_default().inactive = true);
        stopped(&surface);
        // Stopping keeps whether the window is active (the app may restart).
        assert!(!window_active(&surface));
        destroyed(&surface);
        assert!(FOCUS.with(|f| !f.borrow().contains_key(&surface.key())));
        assert!(window_active(&surface));
    }

    /// The rich editor's sink: a multiline input a point wide. However
    /// much it holds, the caret stays at its top left, and what an input
    /// method composes starts there and runs on along one line, where the
    /// input method opens its candidates; a field of any other width wraps
    /// as before.
    #[test]
    fn a_point_wide_input_keeps_a_composition_at_its_corner() {
        let surface = Surface::new(Default::default());
        let view = NshView::new(5, nsh_core::ViewKind::Input);
        create(&surface, &view);
        let input = input_of(&view).expect("input");
        config(
            &surface,
            &view,
            &InputConfig {
                multiline: true,
                ..Default::default()
            },
        );
        let at = |w: f32| {
            content(
                &view,
                Bounds::new(Point::default(), Size::new(Points(w), Points(16.0))),
            );
        };
        at(1.0);
        let editor = input.editor.borrow();
        let e = editor.as_ref().expect("RichEdit");
        assert_eq!(
            e.props().bits & TXTBIT_WORDWRAP,
            0,
            "a point-wide input wraps"
        );
        let client = e.props().client;
        let at_corner = |p: windows::Win32::Foundation::POINT| {
            (p.x - client.left).abs() <= 1 && (p.y - client.top).abs() <= 1
        };
        let mut text = String::new();
        for (count, c) in "你好世界，再见".chars().enumerate() {
            text.push(c);
            value(&view, &text, count as u32 + 1);
            let caret = e.position(input.selection().1);
            assert!(
                at_corner(caret),
                "after {text:?} the caret is at {caret:?}, the field at {client:?}"
            );
        }
        // An input method composes at the caret (as Text Services Framework
        // would, with no message of the field's).
        let start = input.selection().1;
        input.composing.set(Some((start, 0)));
        for letter in ["n", "i", "h", "a", "o"] {
            replace_selection(&input, letter);
            process(&surface, &view, &input);
            let (first, end) = (e.position(start), e.position(input.selection().1));
            assert!(
                at_corner(first),
                "the composition starts at {first:?}, the field at {client:?}"
            );
            assert_eq!(end.y, first.y, "the composition goes on to another line");
        }
        input.composing.set(None);
        at(200.0);
        assert_ne!(
            e.props().bits & TXTBIT_WORDWRAP,
            0,
            "a wide input does not wrap"
        );
    }

    fn composition_payload(composing: bool, text: &str) -> EventPayload {
        EventPayload::Map(vec![
            ("composing", PayloadValue::Bool(composing)),
            ("text", PayloadValue::Str(text.to_owned())),
        ])
    }

    #[test]
    fn an_input_asks_richedit_for_notes_while_composing() {
        let surface = Surface::new(Default::default());
        let view = NshView::new(6, nsh_core::ViewKind::Input);
        create(&surface, &view);
        let input = input_of(&view).expect("input");
        let has_flag = || {
            let (lang, _) = input
                .with_editor(|e| e.send(EM_GETLANGOPTIONS, 0, 0))
                .expect("RichEdit");
            lang.0 as u32 & IMF_IMEALWAYSSENDNOTIFY != 0
        };
        assert!(has_flag(), "IMF_IMEALWAYSSENDNOTIFY missing after create");
        for auto_correct in [false, true] {
            config(
                &surface,
                &view,
                &InputConfig {
                    auto_correct,
                    ..Default::default()
                },
            );
            assert!(
                has_flag(),
                "IMF_IMEALWAYSSENDNOTIFY missing with auto_correct={auto_correct}"
            );
        }
        input.ensure_editor_mode(true);
        assert!(
            has_flag(),
            "IMF_IMEALWAYSSENDNOTIFY missing after GDI rebuild"
        );
    }

    #[test]
    fn a_composition_is_reported_as_it_is_typed() {
        let surface = Surface::new(Default::default());
        surface.record_events();
        let view = NshView::new(7, nsh_core::ViewKind::Input);
        view.state_mut()
            .events
            .set(EventKind::CompositionChange, true);
        create(&surface, &view);
        let input = input_of(&view).expect("input");
        let id = view.id();

        input.with_editor(Editor::start_composition);
        replace_selection(&input, "n");
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![(
                id,
                EventKind::CompositionChange,
                composition_payload(true, "n")
            )]
        );
        assert_eq!(input.count.get(), 0);

        replace_selection(&input, "i");
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![(
                id,
                EventKind::CompositionChange,
                composition_payload(true, "ni")
            )]
        );
        assert_eq!(input.count.get(), 0);

        input.send(EM_SETSEL, 0, 2);
        replace_selection(&input, "你");
        input.with_editor(Editor::end_composition);
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![
                (
                    id,
                    EventKind::ChangeText,
                    EventPayload::Text {
                        text: "你".into(),
                        count: 1,
                    },
                ),
                (
                    id,
                    EventKind::CompositionChange,
                    composition_payload(false, "")
                ),
            ]
        );

        // Replacing a selection while composing reports only the composition
        // text until commit.
        value(&view, "ab", 1);
        surface.take_events();
        input.send(EM_SETSEL, 1, 2);
        input.with_editor(Editor::take_notes);
        input.with_editor(Editor::start_composition);
        replace_selection(&input, "n");
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![(
                id,
                EventKind::CompositionChange,
                composition_payload(true, "n")
            )]
        );
        assert_eq!(input.count.get(), 1);

        input.send(EM_SETSEL, 1, 2);
        replace_selection(&input, "你");
        input.with_editor(Editor::end_composition);
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![
                (
                    id,
                    EventKind::ChangeText,
                    EventPayload::Text {
                        text: "a你".into(),
                        count: 2,
                    },
                ),
                (
                    id,
                    EventKind::CompositionChange,
                    composition_payload(false, "")
                ),
            ]
        );

        // Cancelling a composition emits no `ChangeText`.
        input.with_editor(Editor::start_composition);
        replace_selection(&input, "x");
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![(
                id,
                EventKind::CompositionChange,
                composition_payload(true, "x")
            )]
        );

        input.send(EM_SETSEL, 2, 3);
        replace_selection(&input, "");
        input.with_editor(Editor::end_composition);
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![(
                id,
                EventKind::CompositionChange,
                composition_payload(false, "")
            )]
        );
        assert_eq!(input.count.get(), 2);
    }

    #[test]
    fn a_commit_followed_at_once_by_the_next_composition_reports_both() {
        let surface = Surface::new(Default::default());
        surface.record_events();
        let view = NshView::new(8, nsh_core::ViewKind::Input);
        view.state_mut()
            .events
            .set(EventKind::CompositionChange, true);
        create(&surface, &view);
        let input = input_of(&view).expect("input");
        let id = view.id();

        value(&view, "ab", 0);
        surface.take_events();
        input.send(EM_SETSEL, 1, 1);
        input.with_editor(Editor::take_notes);

        input.with_editor(Editor::start_composition);
        replace_selection(&input, "n");
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![(
                id,
                EventKind::CompositionChange,
                composition_payload(true, "n")
            )]
        );

        // One coalesced batch: commit "你", end the first composition, start
        // the next one at the caret before "b", and type "h".
        input.send(EM_SETSEL, 1, 2);
        replace_selection(&input, "你");
        input.with_editor(Editor::end_composition);
        input.with_editor(Editor::start_composition);
        replace_selection(&input, "h");
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![
                (
                    id,
                    EventKind::ChangeText,
                    EventPayload::Text {
                        text: "a你b".into(),
                        count: 1,
                    },
                ),
                (
                    id,
                    EventKind::CompositionChange,
                    composition_payload(false, "")
                ),
                (
                    id,
                    EventKind::CompositionChange,
                    composition_payload(true, "h")
                ),
            ]
        );

        // Commit the second composition.
        input.send(EM_SETSEL, 2, 3);
        replace_selection(&input, "好");
        input.with_editor(Editor::end_composition);
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![
                (
                    id,
                    EventKind::ChangeText,
                    EventPayload::Text {
                        text: "a你好b".into(),
                        count: 2,
                    },
                ),
                (
                    id,
                    EventKind::CompositionChange,
                    composition_payload(false, "")
                ),
            ]
        );

        // A composition that starts and ends before `process` runs commits as
        // plain text without spurious composition events.
        input.with_editor(Editor::start_composition);
        replace_selection(&input, "!");
        input.with_editor(Editor::end_composition);
        process(&surface, &view, &input);
        assert_eq!(
            surface.take_events(),
            vec![(
                id,
                EventKind::ChangeText,
                EventPayload::Text {
                    text: "a你好!b".into(),
                    count: 3,
                },
            )]
        );
    }

    #[test]
    fn a_value_set_while_composing_waits_for_the_last_composition() {
        let surface = Surface::new(Default::default());
        let view = NshView::new(9, nsh_core::ViewKind::Input);
        create(&surface, &view);
        let input = input_of(&view).expect("input");

        input.with_editor(Editor::start_composition);
        replace_selection(&input, "n");
        process(&surface, &view, &input);
        value(&view, "from-js", 0);
        assert_eq!(input.text(), "n");

        // Cancel the first composition and immediately start a second one in
        // the same batch: the pending value stays deferred while composing.
        input.send(EM_SETSEL, 0, 1);
        replace_selection(&input, "");
        input.with_editor(Editor::end_composition);
        input.with_editor(Editor::start_composition);
        replace_selection(&input, "h");
        process(&surface, &view, &input);
        assert_eq!(input.text(), "h");
        assert_eq!(input.composed.borrow().as_deref(), Some("h"));
        assert_eq!(input.count.get(), 0);

        // Once the final composition ends, the deferred value applies.
        input.send(EM_SETSEL, 0, 1);
        replace_selection(&input, "");
        input.with_editor(Editor::end_composition);
        process(&surface, &view, &input);
        assert!(input.composing.get().is_none());
        assert!(input.composed.borrow().is_none());
        assert_eq!(input.text(), "from-js");
    }

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

    /// Replaces the 8-byte family name `"Pacifico"` inside a copy of the
    /// bundled TrueType font and updates its `name` and `head` checksums so
    /// tests can register a unique family without racing other tests.
    fn renamed_pacifico(name: &str) -> Vec<u8> {
        assert_eq!(name.len(), "Pacifico".len());
        let mut data =
            include_bytes!("../../../examples/gallery/fonts/Pacifico-Regular.ttf").to_vec();
        let num_tables = u16::from_be_bytes([data[4], data[5]]) as usize;
        let mut name_table = None;
        let mut head_table = None;
        for i in 0..num_tables {
            let entry = 12 + i * 16;
            let tag = &data[entry..entry + 4];
            let offset =
                u32::from_be_bytes(data[entry + 8..entry + 12].try_into().unwrap()) as usize;
            let length =
                u32::from_be_bytes(data[entry + 12..entry + 16].try_into().unwrap()) as usize;
            if tag == b"name" {
                name_table = Some((entry, offset, length));
            } else if tag == b"head" {
                head_table = Some((entry, offset, length));
            }
        }
        let (name_entry, name_off, name_len) = name_table.expect("name table");
        let old_ascii = b"Pacifico";
        let new_ascii = name.as_bytes();
        let old_utf16: Vec<u8> = "Pacifico"
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect();
        let new_utf16: Vec<u8> = name.encode_utf16().flat_map(u16::to_be_bytes).collect();
        let slice = &mut data[name_off..name_off + name_len];
        for i in 0..=slice.len().saturating_sub(old_utf16.len()) {
            if &slice[i..i + old_utf16.len()] == old_utf16.as_slice() {
                slice[i..i + new_utf16.len()].copy_from_slice(&new_utf16);
            }
        }
        for i in 0..=slice.len().saturating_sub(old_ascii.len()) {
            if &slice[i..i + old_ascii.len()] == old_ascii.as_slice() {
                slice[i..i + new_ascii.len()].copy_from_slice(new_ascii);
            }
        }
        let checksum = |bytes: &[u8]| -> u32 {
            let mut sum = 0u32;
            for chunk in bytes.chunks(4) {
                let mut buf = [0u8; 4];
                buf[..chunk.len()].copy_from_slice(chunk);
                sum = sum.wrapping_add(u32::from_be_bytes(buf));
            }
            sum
        };
        let name_sum = checksum(&data[name_off..name_off + name_len]);
        data[name_entry + 4..name_entry + 8].copy_from_slice(&name_sum.to_be_bytes());
        if let Some((head_entry, head_off, head_len)) = head_table {
            data[head_off + 8..head_off + 12].copy_from_slice(&0u32.to_be_bytes());
            let head_sum = checksum(&data[head_off..head_off + head_len]);
            data[head_entry + 4..head_entry + 8].copy_from_slice(&head_sum.to_be_bytes());
            let adj = 0xB1B0_AFBAu32.wrapping_sub(checksum(&data));
            data[head_off + 8..head_off + 12].copy_from_slice(&adj.to_be_bytes());
        }
        data
    }

    fn face_name(input: &InputState) -> String {
        let editor = input.editor.borrow();
        let face = editor
            .as_ref()
            .expect("RichEdit")
            .props()
            .char_format
            .Base
            .szFaceName;
        let len = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        String::from_utf16_lossy(&face[..len])
    }

    fn format_family(input: &InputState) -> String {
        let format = input.format().expect("DirectWrite format");
        // SAFETY: COM calls on a live format with a buffer sized from its length.
        unsafe {
            let len = format.GetFontFamilyNameLength() as usize;
            let mut buf = vec![0u16; len + 1];
            format.GetFontFamilyName(&mut buf).expect("family name");
            String::from_utf16_lossy(&buf[..len])
        }
    }

    type InkBounds = (u32, u32, u32, u32);

    /// Renders `input`'s RichEdit text into an offscreen Direct2D bitmap using
    /// the same D2D / GDI rendering path as [`InputState::record`], and returns
    /// its alpha plane and ink bounding box `(left, top, right, bottom)`.
    fn render_input(input: &InputState) -> (Vec<u8>, Option<InkBounds>) {
        use windows::Win32::Graphics::{
            Direct2D::{
                Common::{
                    D2D_POINT_2U, D2D_RECT_U, D2D_SIZE_U, D2D1_ALPHA_MODE_PREMULTIPLIED,
                    D2D1_PIXEL_FORMAT,
                },
                D2D1_BITMAP_OPTIONS, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_CPU_READ,
                D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1, D2D1_MAP_OPTIONS_READ,
            },
            Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM,
        };
        let gfx = crate::gfx::get().expect("gfx");
        let editor = input.editor.borrow();
        let e = editor.as_ref().expect("RichEdit");
        let client = e.props().client;
        let (w, h) = (360u32, 120u32);
        let props = |options: D2D1_BITMAP_OPTIONS| D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: D2D1_PIXEL_FORMAT {
                format: DXGI_FORMAT_B8G8R8A8_UNORM,
                alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
            },
            dpiX: 96.0,
            dpiY: 96.0,
            bitmapOptions: options,
            colorContext: std::mem::ManuallyDrop::new(None),
        };
        let size = D2D_SIZE_U {
            width: w,
            height: h,
        };
        let s = input.scale.get().max(0.01);
        // SAFETY: COM calls on live objects; mapped memory is read before Unmap.
        unsafe {
            let dc = &gfx.dc;
            let target = dc
                .CreateBitmap(size, None, 0, &props(D2D1_BITMAP_OPTIONS_TARGET))
                .expect("target bitmap");
            dc.SetTarget(&target);
            dc.SetDpi(96.0 * s, 96.0 * s);
            dc.BeginDraw();
            dc.Clear(None);
            if input.use_gdi.get() {
                let bw = (client.right - client.left).max(0) as u32;
                let bh = (client.bottom - client.top).max(0) as u32;
                let bgra = e.draw_gdi_bgra(client).expect("GDI TxDraw");
                let bmp_props = D2D1_BITMAP_PROPERTIES1 {
                    pixelFormat: D2D1_PIXEL_FORMAT {
                        format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        alphaMode: D2D1_ALPHA_MODE_PREMULTIPLIED,
                    },
                    dpiX: 96.0 * s,
                    dpiY: 96.0 * s,
                    bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                    colorContext: std::mem::ManuallyDrop::new(None),
                };
                let bmp = dc
                    .CreateBitmap(
                        D2D_SIZE_U {
                            width: bw,
                            height: bh,
                        },
                        Some(bgra.as_ptr().cast()),
                        bw * 4,
                        &bmp_props,
                    )
                    .expect("GDI bitmap");
                dc.SetTransform(&Matrix3x2::identity());
                let dest = rect_f(
                    client.left as f32 / s,
                    client.top as f32 / s,
                    bw as f32 / s,
                    bh as f32 / s,
                );
                dc.DrawBitmap(
                    &bmp,
                    Some(&dest),
                    1.0,
                    D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
                    None,
                    None,
                );
            } else {
                let k = richedit::target_scale(HWND::default(), s);
                dc.SetTransform(&Matrix3x2 {
                    M11: k,
                    M12: 0.0,
                    M21: 0.0,
                    M22: k,
                    M31: 0.0,
                    M32: 0.0,
                });
                assert!(e.draw(dc.as_raw(), client));
            }
            dc.SetTransform(&Matrix3x2::identity());
            dc.EndDraw(None, None).expect("EndDraw");
            dc.SetTarget(None);
            dc.SetDpi(96.0, 96.0);
            let read = dc
                .CreateBitmap(
                    size,
                    None,
                    0,
                    &props(D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW),
                )
                .expect("read bitmap");
            read.CopyFromBitmap(
                Some(&D2D_POINT_2U { x: 0, y: 0 }),
                &target,
                Some(&D2D_RECT_U {
                    left: 0,
                    top: 0,
                    right: w,
                    bottom: h,
                }),
            )
            .expect("CopyFromBitmap");
            let mapped = read.Map(D2D1_MAP_OPTIONS_READ).expect("Map");
            let mut alpha = Vec::with_capacity((w * h) as usize);
            let mut bounds: Option<(u32, u32, u32, u32)> = None;
            for y in 0..h {
                let row = std::slice::from_raw_parts(
                    mapped.bits.add((y * mapped.pitch) as usize),
                    (w * 4) as usize,
                );
                for x in 0..w {
                    let a = row[(x * 4 + 3) as usize];
                    alpha.push(a);
                    if a > 40 {
                        bounds = Some(match bounds {
                            None => (x, y, x, y),
                            Some((l, t, r, b)) => (l.min(x), t.min(y), r.max(x), b.max(y)),
                        });
                    }
                }
            }
            read.Unmap().expect("Unmap");
            (alpha, bounds)
        }
    }

    fn make_input_with_family(
        surface: &Rc<Surface>,
        id: NodeId,
        font_family: &str,
        text: &str,
    ) -> (NshView, Rc<InputState>, InputConfig) {
        let view = NshView::new(id, nsh_core::ViewKind::Input);
        create(surface, &view);
        let input = input_of(&view).expect("input");
        let mut cfg = InputConfig {
            multiline: true,
            placeholder: "Placeholder".to_owned(),
            ..Default::default()
        };
        cfg.style.font_family = Some(nsh_core::FontFamily::new(font_family));
        cfg.style.font_size = Points(24.0);
        cfg.style.color = Color::BLACK;
        config(surface, &view, &cfg);
        content(
            &view,
            Bounds::new(Point::default(), Size::new(Points(340.0), Points(100.0))),
        );
        value(&view, text, 1);
        (view, input, cfg)
    }

    #[test]
    fn families() {
        assert_eq!(family(Some("ui-monospace")), "Consolas");
        assert_eq!(family(Some("'No Such Family', serif")), "Times New Roman");
        assert_eq!(family(Some("'Segoe UI', serif")), "Segoe UI");
        assert_eq!(family(Some("serif")), "Times New Roman");
        assert_eq!(family(Some("SF Mono, monospace")), "Consolas");
        assert_eq!(family(Some("Menlo")), "Consolas");
        assert!(!family(None).is_empty());
    }

    #[test]
    fn face_name_respects_limit_without_splitting_surrogates() {
        let mut buf = [0xFFFFu16; 32];
        // 30 ASCII units + a 2-unit emoji (total 32): the emoji must be omitted
        // rather than leaving an unpaired high surrogate at index 30.
        let long = format!("{}😀", "a".repeat(30));
        copy_face_name(&mut buf, &long);
        assert_eq!(buf[30], 0);
        assert_eq!(buf[31], 0);
        assert_eq!(String::from_utf16(&buf[..30]).unwrap(), "a".repeat(30));

        // 31 ASCII units fit exactly with NUL at index 31.
        copy_face_name(&mut buf, &"b".repeat(40));
        assert_eq!(buf[31], 0);
        assert_eq!(String::from_utf16(&buf[..31]).unwrap(), "b".repeat(31));
    }

    #[test]
    fn family_stacks_and_aliases_resolve_and_render_in_richedit() {
        let surface = Surface::new(Default::default());
        let (_, fallback, _) = make_input_with_family(
            &surface,
            101,
            "No Such Family, Consolas, monospace",
            "Il1 0O",
        );
        let (_, consolas, _) = make_input_with_family(&surface, 102, "Consolas", "Il1 0O");
        let (_, segoe, _) = make_input_with_family(&surface, 103, "Segoe UI", "Il1 0O");
        let (_, alias_stack, _) =
            make_input_with_family(&surface, 104, "SF Mono, monospace", "Il1 0O");
        let (_, alias_only, _) =
            make_input_with_family(&surface, 105, "No Such Family, SF Mono", "Il1 0O");
        let (_, quoted_comma, _) =
            make_input_with_family(&surface, 106, "'ACME, Inc', Consolas", "Il1 0O");
        let (_, missing_only, _) =
            make_input_with_family(&surface, 107, "No Such Family", "Il1 0O");

        assert_eq!(face_name(&fallback), "Consolas");
        assert_eq!(format_family(&fallback), "Consolas");
        assert_eq!(face_name(&alias_stack), "Consolas");
        assert_eq!(format_family(&alias_stack), "Consolas");
        assert_eq!(face_name(&alias_only), "Consolas");
        assert_eq!(format_family(&alias_only), "Consolas");
        assert_eq!(face_name(&quoted_comma), "Consolas");
        assert_eq!(format_family(&quoted_comma), "Consolas");
        assert_eq!(face_name(&missing_only), &*crate::text::ui_family());

        let (fallback_px, fallback_ink) = render_input(&fallback);
        let (consolas_px, consolas_ink) = render_input(&consolas);
        let (segoe_px, _) = render_input(&segoe);
        let (alias_px, _) = render_input(&alias_only);
        assert!(fallback_ink.is_some(), "fallback input drew no ink");
        assert_eq!(fallback_ink, consolas_ink);
        assert_eq!(fallback_px, consolas_px);
        assert_eq!(alias_px, consolas_px);
        assert_ne!(
            fallback_px, segoe_px,
            "fallback stack rendered as Segoe UI instead of Consolas"
        );
    }

    #[test]
    fn registered_font_resolves_and_renders_after_input_creation() {
        use nsh_core::TextEngine;

        let surface = Surface::new(Default::default());
        let (view, input, cfg) =
            make_input_with_family(&surface, 201, "PacifInp, Consolas, monospace", "gpMM");
        let (_, segoe, _) = make_input_with_family(&surface, 202, "Segoe UI", "gpMM");

        // Before registration: falls back to Consolas and caches DirectWrite format.
        assert!(!input.use_gdi.get());
        assert_eq!(face_name(&input), "Consolas");
        assert_eq!(format_family(&input), "Consolas");
        let line_height_before = input.line_height();
        let _ = input.placeholder_layout();
        let (pixels_before, ink_before) = render_input(&input);
        assert!(ink_before.is_some());

        // Register the custom font after the input was already created and configured.
        let font_data = renamed_pacifico("PacifInp");
        crate::text::DWriteTextEngine::default()
            .register_font(&font_data)
            .expect("register custom font");

        // Core::fonts_changed() re-sends the same InputConfig to the platform.
        config(&surface, &view, &cfg);

        assert!(
            input.use_gdi.get(),
            "custom font should switch RichEdit to GDI mode"
        );
        assert_eq!(
            input.text(),
            "gpMM",
            "switching RichEdit mode must preserve held text"
        );
        assert_eq!(face_name(&input), "PacifInp");
        assert_eq!(format_family(&input), "PacifInp");
        let line_height_after = input.line_height();
        // Pacifico is over 1.5 ems tall (at 24 pt, > 36 pt), much taller than Consolas.
        assert!(
            line_height_after > 36.0 && line_height_after > line_height_before + 4.0,
            "DirectWrite format did not switch to registered font: before={line_height_before}, after={line_height_after}"
        );

        let (pixels_after, ink_after) = render_input(&input);
        let (segoe_pixels, ink_segoe) = render_input(&segoe);
        // Also compare against RichEdit's own raw fallback for an unregistered
        // face name (both D2D and GDI), proving AddFontMemResourceEx actually
        // resolved the custom font rather than hitting default font substitution.
        let (_, raw_missing, _) = make_input_with_family(&surface, 203, "Segoe UI", "gpMM");
        raw_missing.with_editor(|e| {
            e.update(
                |p| copy_face_name(&mut p.char_format.Base.szFaceName, "UnregFont"),
                TXTBIT_CHARFORMATCHANGE,
            );
        });
        let (unreg_pixels, ink_unreg) = render_input(&raw_missing);
        assert!(ink_after.is_some(), "custom font input drew no ink");
        assert_ne!(
            pixels_after, pixels_before,
            "RichEdit did not render with the registered font (matched pre-registration Consolas): before={ink_before:?}, after={ink_after:?}"
        );
        assert_ne!(
            pixels_after, segoe_pixels,
            "RichEdit fell back to Segoe UI instead of the registered font: segoe={ink_segoe:?}, after={ink_after:?}"
        );
        assert_ne!(
            pixels_after, unreg_pixels,
            "RichEdit fell back to its unknown-font default instead of the registered font: unreg={ink_unreg:?}, after={ink_after:?}"
        );
        let (_, t, _, b) = ink_after.expect("custom ink");
        let (_, ut, _, ub) = ink_unreg.expect("unregistered ink");
        let custom_h = b - t;
        let unreg_h = ub - ut;
        // Pacifico's cursive glyphs are substantially taller than Windows'
        // default fallback font at 24 pt (~30 px vs ~18 px).
        assert!(
            custom_h > unreg_h + 6,
            "custom ink height did not reflect Pacifico's taller glyphs: after={ink_after:?}, unreg={ink_unreg:?}"
        );

        // Verify dark-mode white text also recovers non-empty alpha via dual-pass matting.
        let mut white_cfg = cfg.clone();
        white_cfg.style.color = Color::rgba(255, 255, 255, 255);
        config(&surface, &view, &white_cfg);
        let (_, white_ink) = render_input(&input);
        assert_eq!(
            white_ink, ink_after,
            "white custom-font text ink bounds differed from black"
        );

        // Switching back to a system font restores D2D mode and preserves text.
        let mut sys_cfg = cfg.clone();
        sys_cfg.style.font_family = Some(nsh_core::FontFamily::new("Consolas"));
        config(&surface, &view, &sys_cfg);
        assert!(!input.use_gdi.get());
        assert_eq!(input.text(), "gpMM");
        assert_eq!(face_name(&input), "Consolas");
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
    fn colors() {
        assert_eq!(
            colorref(Color::rgba(0x11, 0x22, 0x33, 0xff)),
            COLORREF(0x332211)
        );
        // A COLORREF has no alpha: transparent comes out black, so the
        // drawing takes the alpha apart.
        assert_eq!(colorref(Color::rgba(0, 0, 0, 0)), COLORREF(0));
        assert_eq!(alpha(Color::rgba(0, 0, 0, 0)), 0.0);
        assert_eq!(alpha(Color::rgba(0x11, 0x22, 0x33, 0xff)), 1.0);
        assert!((alpha(Color::rgba(0, 0, 0, 0x80)) - 0.502).abs() < 0.001);
    }

    #[test]
    fn mouse_positions() {
        assert_eq!(mouse_lparam(3, 4), 0x0004_0003);
        // Negative coordinates are signed words.
        assert_eq!(mouse_lparam(-1, 0) & 0xffff, 0xffff);
    }

    #[test]
    fn bits() {
        let mut c = InputConfig {
            editable: true,
            ..Default::default()
        };
        assert_eq!(base_bits(&c) & TXTBIT_MULTILINE, 0);
        c.multiline = true;
        c.secure = true;
        c.editable = false;
        let b = base_bits(&c);
        assert_ne!(b & TXTBIT_WORDWRAP, 0);
        assert_ne!(b & TXTBIT_USEPASSWORD, 0);
        assert_ne!(b & TXTBIT_READONLY, 0);
        assert_ne!(b & TXTBIT_D2DDWRITE, 0);
    }
}
