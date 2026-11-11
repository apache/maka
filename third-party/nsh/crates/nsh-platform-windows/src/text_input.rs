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
//! checking (`autoCorrect`), password masking and scrolling. The field
//! keeps it in plain text mode with one character and paragraph format,
//! made from the config's font, color, alignment and line height.
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
//! the text is plain, and the app's shortcuts get those keys.
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
    text_edit::{key_of, pasted},
};
use rustc_hash::FxHashMap;
use windows::{
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM},
        Graphics::{
            Direct2D::{
                Common::D2D1_COMPOSITE_MODE_SOURCE_OVER, D2D1_DRAW_TEXT_OPTIONS_ENABLE_COLOR_FONT,
                D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR, ID2D1CommandList,
            },
            DirectWrite::{
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_ITALIC, DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_WEIGHT, DWRITE_LINE_SPACING_METHOD_UNIFORM, DWRITE_TEXT_ALIGNMENT,
                DWRITE_TEXT_ALIGNMENT_CENTER, DWRITE_TEXT_ALIGNMENT_JUSTIFIED,
                DWRITE_TEXT_ALIGNMENT_LEADING, DWRITE_TEXT_ALIGNMENT_TRAILING, DWRITE_TEXT_METRICS,
                DWRITE_TRIMMING, DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                DWRITE_WORD_WRAPPING_NO_WRAP, DWRITE_WORD_WRAPPING_WRAP, IDWriteTextFormat,
                IDWriteTextLayout,
            },
        },
        UI::{
            Controls::RichEdit::{
                CFE_ITALIC, CFM_BOLD, CFM_COLOR, CFM_FACE, CFM_ITALIC, CFM_SIZE, CFM_SPACING,
                CFM_WEIGHT, EM_CANREDO, EM_EXSETSEL, EM_GETLANGOPTIONS, EM_GETSCROLLPOS, EM_REDO,
                EM_SETEDITSTYLE, EM_SETEVENTMASK, EM_SETLANGOPTIONS, EM_SETSCROLLPOS,
                EM_SETTEXTMODE, EM_SETTYPOGRAPHYOPTIONS, ENM_CHANGE, ENM_ENDCOMPOSITION,
                ENM_SELCHANGE, ENM_STARTCOMPOSITION, IMF_SPELLCHECKING, IMF_TKBPREDICTION,
                PFA_CENTER, PFA_JUSTIFY, PFA_LEFT, PFA_RIGHT, PFM_ALIGNMENT, PFM_LINESPACING,
                PFM_RTLPARA, SES_USECTF, TM_MULTICODEPAGE, TM_MULTILEVELUNDO, TM_PLAINTEXT,
                TO_ADVANCEDTYPOGRAPHY, TXTBIT_AUTOWORDSEL, TXTBIT_CHARFORMATCHANGE,
                TXTBIT_CLIENTRECTCHANGE, TXTBIT_D2DDWRITE, TXTBIT_DISABLEDRAG,
                TXTBIT_HIDESELECTION, TXTBIT_MAXLENGTHCHANGE, TXTBIT_MULTILINE,
                TXTBIT_PARAFORMATCHANGE, TXTBIT_READONLY, TXTBIT_SCROLLBARCHANGE,
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
                WM_LBUTTONUP, WM_MOUSEMOVE,
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
    view::{Hosted, ItemPointer, NshView},
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
    /// The control (`None` when RichEdit could not be made).
    editor: Option<Editor>,
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
    /// The scroll of several lines as last reported to a built-in bar
    /// (`InputConfig::replaced`): offset, text height, width, viewport
    /// height. `None` until reported (again).
    reported_scroll: Cell<Option<(f32, f32, f32, f32)>>,
    /// A press is selecting.
    dragging: Cell<bool>,
    /// The text's format (the placeholder's and the line's height), made
    /// from the config's font.
    format: RefCell<Option<IDWriteTextFormat>>,
    /// The placeholder, laid out.
    placeholder: RefCell<Option<IDWriteTextLayout>>,
    /// What RichEdit drew last (in the content box's points), shown again
    /// when it cannot draw.
    drawn: RefCell<Option<ID2D1CommandList>>,
}

impl InputState {
    fn new(surface: &Surface, view: &NshView) -> Rc<Self> {
        Rc::new_cyclic(|weak: &std::rc::Weak<InputState>| {
            let hwnd = surface.hwnd();
            let redraw = {
                let view = view.downgrade();
                move || {
                    if let Some(view) = view.upgrade() {
                        view.changed();
                    }
                }
            };
            let after_timer = {
                let view = view.downgrade();
                let weak = weak.clone();
                move || {
                    if let (Some(view), Some(input)) = (view.upgrade(), weak.upgrade())
                        && let Some(surface) = Surface::by_key(input.surface)
                    {
                        process(&surface, &view, &input);
                    }
                }
            };
            let editor = Editor::new(
                hwnd,
                Props {
                    bits: base_bits(&InputConfig::default()),
                    ..Props::default()
                },
                Box::new(redraw),
                Box::new(after_timer),
            );
            if let Some(e) = &editor {
                // Plain text with many undo levels (only while empty), the
                // notifications the field follows, DirectWrite's shaping.
                let mode = TM_PLAINTEXT.0 | TM_MULTILEVELUNDO.0 | TM_MULTICODEPAGE.0;
                e.send(EM_SETTEXTMODE, mode as usize, 0);
                let mask = ENM_CHANGE | ENM_SELCHANGE | ENM_STARTCOMPOSITION | ENM_ENDCOMPOSITION;
                e.send(EM_SETEVENTMASK, 0, mask as isize);
                // Text Services Framework input: dictation, the emoji
                // panel, the touch keyboard, reconversion, spelling.
                e.send(EM_SETEDITSTYLE, SES_USECTF as usize, SES_USECTF as isize);
                e.send(
                    EM_SETTYPOGRAPHYOPTIONS,
                    TO_ADVANCEDTYPOGRAPHY as usize,
                    TO_ADVANCEDTYPOGRAPHY as isize,
                );
                e.take_notes();
            } else {
                log::error!("no RichEdit for input {}", view.id());
            }
            InputState {
                surface: surface.key(),
                id: view.id(),
                editor,
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
                format: RefCell::new(None),
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

    /// Sends RichEdit a message (nothing without a control).
    fn send(&self, msg: u32, wparam: usize, lparam: isize) -> (LRESULT, bool) {
        match &self.editor {
            Some(e) => e.send(msg, wparam, lparam),
            None => (LRESULT(0), false),
        }
    }

    /// The text, its line breaks `\n`, in UTF-16 units.
    fn units(&self) -> Vec<u16> {
        let Some(e) = &self.editor else {
            return Vec::new();
        };
        // RichEdit ends paragraphs with `\r`, one unit as `\n` is.
        let mut units = e.text_units();
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

    fn selection(&self) -> (u32, u32) {
        self.editor.as_ref().map_or((0, 0), Editor::selection)
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
                DWRITE_WORD_WRAPPING_WRAP
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
        if scale_changed {
            self.apply_formats();
        }
        self.update_client();
    }

    /// Tells RichEdit its client rectangle if it changed.
    fn update_client(&self) {
        let client = self.client();
        if let Some(e) = &self.editor
            && e.props().client != client
        {
            e.update(|p| p.client = client, TXTBIT_CLIENTRECTCHANGE);
        }
    }

    /// Makes RichEdit's formats and properties from the config at the
    /// current scale.
    fn apply_formats(&self) {
        let Some(e) = &self.editor else { return };
        let Some(surface) = Surface::by_key(self.surface) else {
            return;
        };
        let s = self.scale.get().max(0.01);
        // Points → pixels → the twips RichEdit converts back at GDI's DPI.
        let twips = 1440.0 / richedit::dpi(surface.hwnd());
        let config = self.config.borrow();
        let style = &config.style;
        let color = self.anim_color.get().unwrap_or(style.color);
        let face = family(style.font_family.map(|f| f.name()).as_deref());
        let bits = base_bits(&config);
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
                cf.Base.szFaceName = [0; 32];
                for (d, u) in cf
                    .Base
                    .szFaceName
                    .iter_mut()
                    .zip(face.encode_utf16().take(31))
                {
                    *d = u;
                }
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
                p.max_length = config.max_length.unwrap_or(i32::MAX as u32);
                p.scroll = if config.multiline {
                    ES_AUTOVSCROLL
                } else {
                    ES_AUTOHSCROLL
                };
                p.highlight = config
                    .selection_color
                    .map(|c| (colorref(c), colorref(color)));
            },
            TXTBIT_CHARFORMATCHANGE
                | TXTBIT_PARAFORMATCHANGE
                | TXTBIT_MAXLENGTHCHANGE
                | TXTBIT_SCROLLBARCHANGE,
        );
        // Spelling (and the touch keyboard's suggestions) where the app
        // wants corrections: never in a password.
        let spell = config.auto_correct && !config.secure && config.editable;
        drop(config);
        let (options, _) = self.send(EM_GETLANGOPTIONS, 0, 0);
        let flags = IMF_SPELLCHECKING | IMF_TKBPREDICTION;
        let want = if spell {
            options.0 as u32 | flags
        } else {
            options.0 as u32 & !flags
        };
        if want != options.0 as u32 {
            self.send(EM_SETLANGOPTIONS, 0, want as isize);
        }
        self.update_client();
    }

    /// Reports how far several lines scrolled, the text's height and the
    /// viewport's to the built-in bar that takes the place of an
    /// indicator (`InputConfig::replaced`), when any of them changed since
    /// last reported.
    fn report_scroll(&self) {
        {
            let config = self.config.borrow();
            if !config.replaced || !config.multiline {
                return;
            }
        }
        let Some(e) = &self.editor else { return };
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
        let caret = self.editor.as_ref()?.caret();
        let (ox, oy) = self.origin.get();
        let s = self.scale.get().max(0.01);
        Some((
            (caret.x - ox) as f32 / s,
            (caret.y - oy) as f32 / s,
            caret.width as f32 / s,
            caret.height as f32 / s,
        ))
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
        let list = crate::decor::layer::with_context(cx.gfx, |dc| {
            // SAFETY: COM calls on a context nobody else draws with;
            // `EndDraw` follows `BeginDraw`, the list is closed before use.
            unsafe {
                let list = dc.CreateCommandList().ok()?;
                dc.SetTarget(&list);
                dc.SetDpi(96.0 * s, 96.0 * s);
                dc.BeginDraw();
                // RichEdit draws in the window's client pixels.
                dc.SetTransform(
                    &(Matrix3x2::translation(-ox as f32, -oy as f32)
                        * Matrix3x2::scale(1.0 / s, 1.0 / s)),
                );
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
        // Inside the window's paint: what RichEdit invalidates while it
        // is told its size and drawn is drawn now (asking for another
        // paint here would be lost).
        let _drawing = self.editor.as_ref().map(|e| e.drawing());
        self.set_size(size);
        if self.scale.get() != cx.scale {
            self.scale.set(cx.scale);
            self.apply_formats();
        }
        self.update_client();
        let Some(e) = &self.editor else { return };
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
        self.report_scroll();
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
        if let Some(drawn) = &*self.drawn.borrow() {
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
        }

        let caret = e.caret();
        let caret_shown = self.focused.get()
            && self.active.get()
            && self.caret_on.get()
            && caret.shown
            && config.editable
            && !config.caret_hidden;
        if caret_shown && let Some((x, y, cw, ch)) = self.caret_rect() {
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

/// The property bits of a config (DirectWrite drawing, lines, read-only,
/// password); RichEdit's own drag and drop stays off (the window is the
/// drop target of files).
fn base_bits(config: &InputConfig) -> u32 {
    // The selection shows only while the field has the keys, as on the
    // other platforms.
    let mut bits =
        TXTBIT_D2DDWRITE | TXTBIT_AUTOWORDSEL | TXTBIT_DISABLEDRAG | TXTBIT_HIDESELECTION;
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
        if let Some(e) = &input.editor {
            e.set_focus(false);
        }
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
    surface.terminal_focus_generation.set(
        surface
            .terminal_focus_generation
            .get()
            .checked_add(1)
            .expect("native focus generation exhausted"),
    );
    if let Some(input) = input_of(&view) {
        input.focused.set(false);
        input.dragging.set(false);
        #[cfg(feature = "terminal")]
        cancel_terminal_preedit(&input);
        input.composing.set(None);
        if let Some(e) = &input.editor {
            e.set_focus(false);
        }

        report_composition(surface, &view, &input);
    }
    FOCUS.with(|f| {
        if let Some(f) = f.borrow_mut().get_mut(&surface.key()) {
            f.view = None;
        }
    });
    crate::input::set_state(surface, &view, state::FOCUSED, false);
    send(surface, &view, EventKind::Blur, || EventPayload::None);
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
    if let Some(target) = view
        && !can_hold_focus(surface, target)
    {
        return;
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
            if let Some(e) = &input.editor {
                e.set_focus(false);
            }

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
            if input.active.get()
                && let Some(e) = &input.editor
            {
                e.set_focus(true);
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
/// reported (and JS listens); once it ended, applies the value JS set
/// meanwhile.
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
    if input.composing.get().is_none() {
        let pending = input.pending.borrow_mut().take();
        if let Some((text, count)) = pending {
            set_value(view, input, &text, count);
        }
    }
}

/// Reports the text with a new edit count if it differs from what the
/// engine has.
fn report_text(surface: &Surface, view: &NshView, input: &InputState) -> bool {
    let text = input.text();
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
/// a composition's start, edits (the text, or what is composed), its end,
/// the selection and the caret. Returns whether the text changed.
fn process(surface: &Surface, view: &NshView, input: &InputState) -> bool {
    let Some(e) = &input.editor else {
        return false;
    };
    let notes = e.take_notes();
    if let Some((start, end, len)) = notes.composition_start {
        input.composing.set(Some((start, len.saturating_sub(end))));
    }
    let mut changed = false;
    if notes.changed && !input.programmatic.get() {
        if input.composing.get().is_some() {
            report_composition(surface, view, input);
        } else {
            changed = report_text(surface, view, input);
        }
    }
    if notes.composition_end {
        // The commit's `onChangeText`, then the composition's end.
        changed |= report_text(surface, view, input);
        input.composing.set(None);
        report_composition(surface, view, input);
    } else if notes.composition_start.is_some() {
        report_composition(surface, view, input);
    }
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

/// Replaces the selection with `text` (undo takes it back; `maxLength`
/// clips it).
fn replace_selection(input: &InputState, text: &str) {
    let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    input.send(EM_REPLACESEL, 1, wide.as_ptr() as isize);
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
            old.style != config.style || old.multiline != config.multiline,
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
        return set_focus(surface, Some(view));
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
        set_focus(surface, Some(&view));
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
    let Some(e) = &input.editor else { return };
    input.programmatic.set(true);
    e.set_text(text);
    input.send(EM_SETSEL, usize::MAX >> 1, -1);
    input.programmatic.set(false);
    input.reported_text.replace(input.text());
    if let Some(surface) = surface_of(view) {
        process(&surface, view, input);
    } else {
        e.take_notes();
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
    for unit in text.encode_utf16() {
        input.send(WM_CHAR, unit as usize, 1);
    }
    let changed = process(surface, &view, &input);
    if changed {
        key_press(surface, &view, key_of(&text));
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
        input.caret_on.set(true);
        if let Some(e) = &input.editor {
            e.set_focus(focused_window);
        }
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
        set_focus(surface, Some(view));
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
    process(surface, view, &input);
    true
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
    let s = input.scale.get().max(0.01);
    let mut at = windows::Win32::Foundation::POINT::default();
    input.send(EM_GETSCROLLPOS, 0, &mut at as *mut _ as isize);
    let before = at.y;
    at.y = (at.y as f32 + dy * s).round().max(0.0) as i32;
    input.send(EM_SETSCROLLPOS, 0, &mut at as *mut _ as isize);
    let mut now = windows::Win32::Foundation::POINT::default();
    input.send(EM_GETSCROLLPOS, 0, &mut now as *mut _ as isize);
    let moved = now.y != before;
    if moved {
        view.changed();
        input.report_scroll();
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

/// A right click on field `view`: it takes the focus (keeping its
/// selection) and shows Windows' edit menu, each item RichEdit's own
/// command.
pub(crate) fn context_menu(surface: &Rc<Surface>, view: &NshView) {
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
    let item = |role: Option<MenuRole>, label: &'static str, enabled: bool, action: Action| {
        LocalItem::Item {
            role,
            label,
            enabled,
            action,
        }
    };
    crate::chrome::popup_actions(
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
                "Delete",
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
    terminal_target(surface).map(|(_, bounds)| bounds)
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
    fn colors() {
        assert_eq!(
            colorref(Color::rgba(0x11, 0x22, 0x33, 0xff)),
            COLORREF(0x332211)
        );
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
