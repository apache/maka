//! Keyboard: what a focused view hears and consumes (as the TSX gallery's
//! keyboard demo). Four sections of the same contract:
//!
//! - Held arrows: a canvas sprite driven by a held-key set. Repeats never
//!   accelerate it, and a blur, a window that stops taking input or the
//!   demo's disposal clears the set.
//! - Modifier chords: a focusable, terminal-like console that mounts
//!   `capture_keys`, shows the source's key, code, repeats and the mounted
//!   policy's `default_prevented` decision, and keeps a short transition
//!   log. It is not a PTY.
//! - Capture and bubbling: a child captures one chord; its parent still
//!   hears every transition and declines its own action because
//!   `default_prevented` is true. No listener can veto a native default.
//! - Typing stays in Input: a native Input inside an ancestor that mounts
//!   `captureKeys(All)` keeps its typing and composition. The ancestor's
//!   custom raw-key action stays idle while the Input owns the keys, and
//!   runs on a focusable pad beside it for contrast.

use std::f32::consts::TAU;

use nsh_core::{
    Bounds, Points,
    canvas::{CanvasOp, PathOp},
    element::{AdaptiveColor, KeyCapture, KeyEvent, SharedString, View},
    keymap::{Key, Keystroke, Modifiers},
    platform::Lifecycle,
    prelude::*,
    time::Instant,
};

use crate::ui::{
    Badge, Button, ButtonVariant, Card, DemoPage, Finish, Finished, IconName, MONO, Stat, Tone,
    colors, radius,
};

/// The playfield's height and the sprite's side, in points.
const STAGE: f32 = 216.0;
const SPRITE: f32 = 34.0;
/// The inset between the sprite and the stage's rim.
const PAD: f32 = 14.0;
/// The sprite's speed, in points per second (a diagonal is not faster).
const SPEED: f32 = 190.0;

/// The held-key set's bits.
const LEFT: u8 = 1 << 0;
const RIGHT: u8 = 1 << 1;
const UP: u8 = 1 << 2;
const DOWN: u8 = 1 << 3;

/// No modifiers held.
const NONE: Modifiers = Modifiers {
    ctrl: false,
    alt: false,
    shift: false,
    cmd: false,
};

/// The arrows the playfield consumes, so a scroll view around it never
/// sees them.
const ARROWS: [Keystroke; 4] = [
    Keystroke {
        modifiers: NONE,
        key: Key::Left,
    },
    Keystroke {
        modifiers: NONE,
        key: Key::Right,
    },
    Keystroke {
        modifiers: NONE,
        key: Key::Up,
    },
    Keystroke {
        modifiers: NONE,
        key: Key::Down,
    },
];

/// The console's example chords, as the TSX gallery's: `mod` is Command on
/// Apple platforms and Control elsewhere, and none is one the system keeps
/// for itself.
fn captured_chords() -> [Keystroke; 3] {
    [
        Keystroke::parse_with("mod+shift+y", apple_keys()).expect("a valid chord"),
        Keystroke {
            modifiers: Modifiers {
                shift: true,
                ..NONE
            },
            key: Key::Char(' '),
        },
        Keystroke {
            modifiers: Modifiers { alt: true, ..NONE },
            key: Key::Enter,
        },
    ]
}

fn yes(flag: bool) -> &'static str {
    if flag { "yes" } else { "no" }
}

fn note(content: &'static str) -> impl IntoElement {
    text(content)
        .text_size(px(13.0))
        .line_height(px(18.0))
        .text_color(colors::MUTED)
}

/// A small label in a raised capsule.
fn keycap(label: &'static str, on: impl Fn() -> bool + 'static) -> View {
    let on = computed(on);
    view()
        .min_w(px(36.0))
        .h(px(30.0))
        .px(px(8.0))
        .items_center()
        .justify_center()
        .rounded(px(7.0))
        .border_1()
        .border_color(colors::BORDER)
        .bg(move || {
            if on.get() {
                colors::ACCENT_FILL
            } else {
                colors::RAISED
            }
        })
        .child(
            text(label)
                .font_family(MONO)
                .font_weight(FontWeight::SEMIBOLD)
                .text_size(px(13.0))
                .text_color(move || {
                    if on.get() {
                        colors::ON_ACCENT
                    } else {
                        colors::MUTED
                    }
                }),
        )
}

/// A row of a console readout: the label, then the value in monospace.
fn readout(
    label: &'static str,
    value: impl IntoReactive<SharedString>,
    value_color: impl IntoReactive<AdaptiveColor>,
) -> View {
    view()
        .flex_row()
        .items_baseline()
        .gap_3()
        .min_h(px(24.0))
        .child(
            text(label)
                .flex_1()
                .text_size(px(13.0))
                .text_color(colors::MUTED),
        )
        .child(
            text(value)
                .font_family(MONO)
                .text_size(px(13.0))
                .font_weight(FontWeight::MEDIUM)
                .text_color(value_color)
                .number_of_lines(1),
        )
}

/// The playfield's state: the sprite's native position (drawn without a
/// render per frame), the held set, and the frame loop that moves it.
#[derive(Clone)]
struct Playfield {
    /// The sprite's top-left corner, read by the canvas while it draws.
    x: AnimatedValue,
    y: AnimatedValue,
    /// The same corner in Rust, to clamp at the stage's edges.
    x_at: Stored<f32>,
    y_at: Stored<f32>,
    /// The stage's width as laid out.
    width: Signal<f32>,
    /// [`LEFT`], [`RIGHT`], [`UP`], [`DOWN`] while held.
    held: Signal<u8>,
    /// The scheduled display frame, while arrows are held.
    frame: Stored<Option<Spawned<()>>>,
    /// The previous frame's time (a gap across sleep is clamped).
    last: Stored<Option<Instant>>,
    /// Whether the first layout placed the sprite.
    placed: Stored<bool>,
    /// The demo's owner: a frame it makes ends with the demo.
    owner: Owner,
    /// The focusable stage, for the Start button.
    stage: ElementRef,
}

impl Playfield {
    fn place(&self, width: f32) {
        self.width.set(width);
        let max_x = (width - SPRITE - PAD).max(PAD);
        let max_y = (STAGE - SPRITE - PAD).max(PAD);
        let (x, y) = if self.placed.replace(true) {
            (
                self.x_at.get().clamp(PAD, max_x),
                self.y_at.get().clamp(PAD, max_y),
            )
        } else {
            (
                ((width - SPRITE) / 2.0).clamp(PAD, max_x),
                ((STAGE - SPRITE) / 2.0).clamp(PAD, max_y),
            )
        };
        self.x_at.replace(x);
        self.y_at.replace(y);
        self.x.set(x);
        self.y.set(y);
    }

    /// Adds one arrow to the held set (a fresh press, never a repeat).
    fn press(&self, bit: u8) {
        self.held.update(|held| *held |= bit);
        self.start();
    }

    /// Takes one arrow out; the frame loop ends with the last one.
    fn release(&self, bit: u8) {
        self.held.update(|held| *held &= !bit);
        if self.held.get_untracked() == 0 {
            self.stop();
        }
    }

    /// Empties the held set and ends the frame loop (a blur, a window that
    /// stopped taking input, disposal).
    fn clear(&self) {
        self.held.set(0);
        self.stop();
    }

    fn start(&self) {
        if self.held.get_untracked() == 0 || self.frame.with(|frame| frame.is_some()) {
            return;
        }
        self.last.replace(None);
        self.schedule();
    }

    fn stop(&self) {
        self.last.replace(None);
        if let Some(frame) = self.frame.with(Option::take) {
            frame.cancel();
        }
    }

    /// Waits for the next display frame, which moves the sprite.
    fn schedule(&self) {
        let state = self.clone();
        let frame = self
            .owner
            .run(move || request_animation_frame(move |at| advance(state.clone(), at)));
        self.frame.with(|slot| *slot = Some(frame));
    }

    /// One frame's movement: the direction from the held set, normalized
    /// so diagonals are not faster, over the frame's own time.
    fn step(&self, held: u8, seconds: f32) {
        let width = self.width.get_untracked();
        if width <= 0.0 {
            return;
        }
        let mut dx = 0.0_f32;
        let mut dy = 0.0_f32;
        if held & LEFT != 0 {
            dx -= 1.0;
        }
        if held & RIGHT != 0 {
            dx += 1.0;
        }
        if held & UP != 0 {
            dy -= 1.0;
        }
        if held & DOWN != 0 {
            dy += 1.0;
        }
        if dx == 0.0 && dy == 0.0 {
            return;
        }
        let step = SPEED * seconds / (dx * dx + dy * dy).sqrt();
        let max_x = (width - SPRITE - PAD).max(PAD);
        let max_y = (STAGE - SPRITE - PAD).max(PAD);
        let x = (self.x_at.get() + dx * step).clamp(PAD, max_x);
        let y = (self.y_at.get() + dy * step).clamp(PAD, max_y);
        self.x_at.replace(x);
        self.y_at.replace(y);
        self.x.set(x);
        self.y.set(y);
    }
}

/// A display frame: move, then ask for the next one while arrows are held.
fn advance(state: Playfield, at: Instant) {
    let held = state.held.get_untracked();
    if held == 0 {
        state.last.replace(None);
        state.frame.with(|slot| {
            slot.take();
        });
        return;
    }
    let seconds = state.last.with(|last| {
        let previous = last.replace(at);
        previous.map_or(1.0 / 60.0, |previous| {
            at.duration_since(previous).as_secs_f32().clamp(0.001, 0.05)
        })
    });
    state.step(held, seconds);
    state.schedule();
}

/// The playfield's drawing: a dot grid, the axes, and the sprite at its
/// animated position. Animated numbers are canvas slots, so frames move it
/// without rebuilding the drawing.
fn draw_stage(width: f32, x: &AnimatedValue, y: &AnimatedValue) -> Painter {
    let line = color(colors::LINE);
    let accent = color(colors::ACCENT);
    let mark = color(colors::ON_ACCENT);
    let mut p = Painter::new()
        .fill_color(color(colors::INSET))
        .fill_rect(0.0, 0.0, width, STAGE);
    let mut top = 18.0;
    while top < STAGE {
        let mut left = 18.0;
        while left < width {
            p = p
                .fill_color(line.opacity(0.7))
                .fill_rect(left, top, 1.6, 1.6);
            left += 24.0;
        }
        top += 24.0;
    }
    p = p
        .stroke_color(line)
        .line_width(1.0)
        .begin_path()
        .move_to(width / 2.0, 0.0)
        .line_to(width / 2.0, STAGE)
        .move_to(0.0, STAGE / 2.0)
        .line_to(width, STAGE / 2.0)
        .stroke();
    // A soft accent halo under the sprite, then the sprite itself, a
    // specular top and a mark at its center.
    let halo = PathOp::RoundRect(
        [
            p.num(&x.sub(8.0)),
            p.num(&y.sub(8.0)),
            p.num(SPRITE + 16.0),
            p.num(SPRITE + 16.0),
        ],
        [p.num(19.0); 4],
    );
    p = p
        .fill_color(accent.opacity(0.18))
        .begin_path()
        .op(CanvasOp::Path(halo))
        .fill();
    let body = PathOp::RoundRect(
        [p.num(x), p.num(y), p.num(SPRITE), p.num(SPRITE)],
        [p.num(11.0); 4],
    );
    p = p
        .fill_color(accent)
        .begin_path()
        .op(CanvasOp::Path(body))
        .fill();
    let sheen = PathOp::RoundRect(
        [
            p.num(&x.add(4.0)),
            p.num(&y.add(4.0)),
            p.num(SPRITE - 8.0),
            p.num((SPRITE - 8.0) * 0.45),
        ],
        [p.num(5.0); 4],
    );
    p = p
        .fill_color(mark.opacity(0.16))
        .begin_path()
        .op(CanvasOp::Path(sheen))
        .fill();
    let dot = PathOp::Arc {
        x: p.num(&x.add(SPRITE / 2.0)),
        y: p.num(&y.add(SPRITE / 2.0)),
        radius: p.num(2.2),
        start: p.num(0.0),
        end: p.num(TAU),
        ccw: false,
    };
    p.fill_color(mark)
        .begin_path()
        .op(CanvasOp::Path(dot))
        .fill()
}

/// Section 1: the held-arrow playfield and its focus entry.
fn held_arrows(play: Playfield) -> Card {
    let stage = play.stage;
    let start = stage;
    let card = Card::new()
        .icon(IconName::Keyboard)
        .title("Held arrows")
        .subtitle("Hold an arrow to move; repeats never accelerate");
    card.child(
        view()
            .gap_3()
            .child(
                view()
                    .w_full()
                    .rounded(px(radius::INSET))
                    .border_1()
                    .border_color(colors::BORDER)
                    .overflow_hidden()
                    .finish(Finish::Inset)
                    .focusable(true)
                    .label("Playfield")
                    .element_ref(&stage)
                    .focus(|s| s.border_color(colors::ACCENT))
                    .capture_keys(KeyCapture::keys(ARROWS))
                    .on_press({
                        let stage = start;
                        move || stage.focus()
                    })
                    .on_key_down({
                        let play = play.clone();
                        move |event: &KeyEvent| {
                            if event.repeat {
                                return;
                            }
                            if let Some(bit) = arrow_bit(event) {
                                play.press(bit);
                            }
                        }
                    })
                    .on_key_up({
                        let play = play.clone();
                        move |event: &KeyEvent| {
                            if let Some(bit) = arrow_bit(event) {
                                play.release(bit);
                            }
                        }
                    })
                    .on_blur({
                        let play = play.clone();
                        move || play.clear()
                    })
                    .child(
                        canvas({
                            let play = play.clone();
                            move || {
                                let width = play.width.get();
                                if width <= 0.0 {
                                    Painter::new()
                                } else {
                                    draw_stage(width, &play.x, &play.y)
                                }
                            }
                        })
                        .h(px(STAGE))
                        .w_full()
                        .on_layout({
                            let play = play.clone();
                            move |frame: &Bounds<Points>| play.place(frame.size.width.0)
                        }),
                    ),
            )
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        Button::new("Start", move |_: &()| stage.focus())
                            .variant(ButtonVariant::Accent),
                    )
                    .child(
                        view()
                            .flex_1()
                            .flex_row()
                            .flex_wrap()
                            .items_center()
                            .gap_2()
                            .child(keycap("←", {
                                let play = play.clone();
                                move || play.held.get() & LEFT != 0
                            }))
                            .child(keycap("→", {
                                let play = play.clone();
                                move || play.held.get() & RIGHT != 0
                            }))
                            .child(keycap("↑", {
                                let play = play.clone();
                                move || play.held.get() & UP != 0
                            }))
                            .child(keycap("↓", {
                                let play = play.clone();
                                move || play.held.get() & DOWN != 0
                            })),
                    )
                    .child(
                        text({
                            let play = play.clone();
                            move || {
                                let held = play.held.get().count_ones();
                                if held == 0 {
                                    "idle".to_owned()
                                } else {
                                    format!("{held} held")
                                }
                            }
                        })
                        .text_size(px(13.0))
                        .text_color(colors::MUTED)
                        .tabular_nums(),
                    ),
            )
            .child(note(
                "Start focuses the playfield. A blur, an inactive window or leaving the demo clears every held arrow.",
            )),
    )
}

/// The arrow a logical key names (the physical code may be unknown).
fn arrow_bit(event: &KeyEvent) -> Option<u8> {
    match event.key.as_str() {
        "ArrowLeft" => Some(LEFT),
        "ArrowRight" => Some(RIGHT),
        "ArrowUp" => Some(UP),
        "ArrowDown" => Some(DOWN),
        _ => None,
    }
}

/// One transition the console shows.
#[derive(Clone, PartialEq)]
struct Seen {
    key: SharedString,
    code: SharedString,
    repeat: bool,
    prevented: bool,
}

/// The console's state.
#[derive(Clone)]
struct Console {
    last: Signal<Option<Seen>>,
    log: Signal<Vec<String>>,
    modifiers: Signal<Modifiers>,
    keys: ElementRef,
}

impl Console {
    fn record(&self, event: &KeyEvent, down: bool) {
        self.modifiers.set(event.modifiers);
        let code = if event.code.is_empty() {
            SharedString::from("—")
        } else {
            event.code.clone()
        };
        let seen = Seen {
            key: if event.key == " " {
                SharedString::new_static("Space")
            } else {
                event.key.clone()
            },
            code,
            repeat: event.repeat,
            prevented: event.default_prevented,
        };
        self.log.update(|log| {
            log.insert(
                0,
                format!(
                    "{} {}  code {}  repeat {}  defaultPrevented {}",
                    if down { "↓" } else { "↑" },
                    seen.key,
                    seen.code,
                    yes(seen.repeat),
                    yes(seen.prevented)
                ),
            );
            log.truncate(3);
        });
        self.last.set(Some(seen));
    }
}

/// Section 2: the focusable console that mounts the example chords.
fn modifier_chords(console: Console, chords: [Keystroke; 3], labels: [String; 3]) -> Card {
    let last = console.last;
    let prevented = computed(move || last.with(|last| last.as_ref().is_some_and(|s| s.prevented)));
    let repeated = computed(move || last.with(|last| last.as_ref().is_some_and(|s| s.repeat)));
    let modifiers = console.modifiers;
    let log = console.log;
    let keys = console.keys;
    let focus = keys;
    let blur = console.modifiers;
    Card::new()
        .icon(IconName::Keyboard)
        .title("Modifier chords")
        .subtitle("Key, code, repeats and the mounted capture decision")
        .child(
            view()
                .gap_3()
                .child(
                    view()
                        .flex_row()
                        .items_center()
                        .gap_2()
                        .child(
                            text("keys ›")
                                .font_family(MONO)
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_size(px(12.0))
                                .text_color(colors::ACCENT),
                        )
                        .child(
                            text("chord console")
                                .flex_1()
                                .font_family(MONO)
                                .text_size(px(12.0))
                                .text_color(colors::FAINT),
                        )
                        .child(Badge::new("captureKeys").tone(Tone::Accent).outline()),
                )
                .child(
                    view()
                        .gap_2()
                        .p_3()
                        .rounded(px(radius::CONTROL))
                        .border_1()
                        .border_color(colors::BORDER)
                        .bg(colors::INSET)
                        .finish(Finish::Inset)
                        .focusable(true)
                        .label("Chord console")
                        .element_ref(&keys)
                        .focus(|s| s.border_color(colors::ACCENT))
                        .capture_keys(KeyCapture::keys(chords))
                        .on_key_down({
                            let console = console.clone();
                            move |event: &KeyEvent| console.record(event, true)
                        })
                        .on_key_up({
                            let console = console.clone();
                            move |event: &KeyEvent| console.record(event, false)
                        })
                        .on_blur(move || blur.set(Modifiers::default()))
                        .child(
                            view()
                                .flex_row()
                                .flex_wrap()
                                .items_center()
                                .gap(px(6.0))
                                .child(keycap("Ctrl", move || modifiers.get().ctrl))
                                .child(keycap("Alt", move || modifiers.get().alt))
                                .child(keycap("Shift", move || modifiers.get().shift))
                                .child(keycap("Meta", move || modifiers.get().cmd))
                                .child(
                                    text("modifiers")
                                        .text_size(px(12.0))
                                        .text_color(colors::FAINT),
                                ),
                        )
                        .child(readout(
                            "Key",
                            move || {
                                last.with(|last| {
                                    last.as_ref()
                                        .map_or_else(|| "—".to_owned(), |s| s.key.to_string())
                                })
                            },
                            colors::TEXT,
                        ))
                        .child(readout(
                            "Code",
                            move || {
                                last.with(|last| {
                                    last.as_ref()
                                        .map_or_else(|| "—".to_owned(), |s| s.code.to_string())
                                })
                            },
                            colors::TEXT,
                        ))
                        .child(readout(
                            "Repeat",
                            move || {
                                last.with(|last| {
                                    last.as_ref().map_or("—", |s| yes(s.repeat)).to_owned()
                                })
                            },
                            move || {
                                if repeated.get() {
                                    colors::WARN
                                } else {
                                    colors::MUTED
                                }
                            },
                        ))
                        .child(readout(
                            "defaultPrevented",
                            move || {
                                last.with(|last| {
                                    last.as_ref().map_or("—", |s| yes(s.prevented)).to_owned()
                                })
                            },
                            move || {
                                if prevented.get() {
                                    colors::ACCENT
                                } else {
                                    colors::MUTED
                                }
                            },
                        ))
                        .child(
                            view()
                                .gap_1()
                                .pt_2()
                                .border_t_1()
                                .border_t_color(colors::LINE)
                                .children((0..3).map(|i| {
                                    text(move || {
                                        log.with(|log| {
                                            log.get(i)
                                                .cloned()
                                                .unwrap_or_else(|| "·".to_owned())
                                        })
                                    })
                                    .font_family(MONO)
                                    .text_size(px(11.0))
                                    .line_height(px(16.0))
                                    .text_color(move || {
                                        if log.with(|log| log.get(i).is_some()) {
                                            colors::TEXT
                                        } else {
                                            colors::FAINT
                                        }
                                    })
                                    .number_of_lines(1)
                                })),
                        )
                        .child(
                            view()
                                .flex_row()
                                .flex_wrap()
                                .items_center()
                                .gap_2()
                                .child(
                                    text("↓/↑ transitions · captured chords consume native defaults")
                                        .text_size(px(12.0))
                                        .text_color(colors::FAINT),
                                ),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(
                            Button::new("Focus keys", move |_: &()| focus.focus())
                                .variant(ButtonVariant::Secondary),
                        )
                        .children(
                            labels.map(|label| Badge::new(label).outline().into_element()),
                        ),
                )
                .child(note(
                    "Focus the console and press mod+shift+y, shift+space or alt+enter. They are captured (defaultPrevented yes); other named keys still arrive. The console is a view of events, not a PTY.",
                )),
        )
}

/// The nested demo's state.
#[derive(Clone)]
struct Nested {
    observed: Signal<u32>,
    acted: Signal<u32>,
    declined: Signal<u32>,
    note: Signal<(String, Tone)>,
    child_last: Signal<String>,
    child: ElementRef,
}

impl Nested {
    fn child_event(&self, event: &KeyEvent, down: bool) {
        self.child_last.set(format!(
            "Child saw {} {}  defaultPrevented {}",
            if down { "↓" } else { "↑" },
            event.key,
            yes(event.default_prevented)
        ));
    }

    fn parent_down(&self, event: &KeyEvent) {
        self.observed.update(|n| *n += 1);
        if event.repeat {
            return;
        }
        if is_action_chord(event) {
            if event.default_prevented {
                self.declined.update(|n| *n += 1);
                self.note
                    .set(("Parent did not act: defaultPrevented".into(), Tone::Warn));
            } else {
                self.acted.update(|n| *n += 1);
                self.note.set((
                    "Parent acted: mod+shift+y was not captured".into(),
                    Tone::Accent,
                ));
            }
        } else if event.key.eq_ignore_ascii_case("Enter") {
            if event.default_prevented {
                self.declined.update(|n| *n += 1);
                self.note
                    .set(("Parent did not act: defaultPrevented".into(), Tone::Warn));
            } else {
                self.acted.update(|n| *n += 1);
                self.note.set(("Parent acted: Enter".into(), Tone::Accent));
            }
        } else {
            self.note.set((
                format!("Parent observed only: {}", event.key),
                Tone::Neutral,
            ));
        }
    }
}

/// Whether the transition is the platform's `mod+shift+y`: what the child
/// captures and the parent would act on.
fn is_action_chord(event: &KeyEvent) -> bool {
    let apple = apple_keys();
    let platform = if apple {
        event.modifiers.cmd
    } else {
        event.modifiers.ctrl
    };
    let other = if apple {
        event.modifiers.ctrl
    } else {
        event.modifiers.cmd
    };
    platform
        && event.modifiers.shift
        && !event.modifiers.alt
        && !other
        && event.key.eq_ignore_ascii_case("y")
}

/// Section 3: child capture, parent observation, and a declined action.
fn capture_and_bubbling(nested: Nested, action: Keystroke) -> Card {
    let child = nested.child;
    let child_event = nested.clone();
    let parent = nested.clone();
    let child_ref = nested.child;
    Card::new()
        .icon(IconName::Keyboard)
        .title("Capture and bubbling")
        .subtitle("The child consumes a chord; the parent hears it and declines")
        .child(
            view()
                .gap_3()
                .child(
                    view()
                        .gap_2()
                        .p_3()
                        .rounded(px(radius::CONTROL))
                        .border_1()
                        .border_color(colors::BORDER)
                        .bg(colors::INSET)
                        .finish(Finish::Inset)
                        .label("Parent")
                        .on_key_down(move |event: &KeyEvent| parent.parent_down(event))
                        .on_key_up({
                            let parent = nested.clone();
                            move |_: &KeyEvent| parent.observed.update(|n| *n += 1)
                        })
                        .child(
                            view()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .child(
                                    text("Parent")
                                        .flex_1()
                                        .text_size(px(13.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::TEXT),
                                )
                                .child(Badge::new("onKeyDown · onKeyUp").outline()),
                        )
                        .child(
                            view()
                                .gap_1()
                                .p_3()
                                .rounded(px(radius::INSET))
                                .border_1()
                                .border_color(colors::BORDER)
                                .bg(colors::RAISED)
                                .focusable(true)
                                .label("Child capture")
                                .element_ref(&child_ref)
                                .focus(|s| s.border_color(colors::ACCENT))
                                .capture_keys(KeyCapture::keys([action]))
                                .on_key_down({
                                    let child_event = child_event.clone();
                                    move |event: &KeyEvent| child_event.child_event(event, true)
                                })
                                .on_key_up({
                                    let child_event = child_event.clone();
                                    move |event: &KeyEvent| child_event.child_event(event, false)
                                })
                                .child(
                                    text("Child capture")
                                        .text_size(px(13.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::TEXT),
                                )
                                .child(
                                    text("captureKeys(mod+shift+y)")
                                        .font_family(MONO)
                                        .text_size(px(11.0))
                                        .text_color(colors::FAINT),
                                ),
                        )
                        .child(
                            text({
                                let nested = nested.clone();
                                move || nested.child_last.get()
                            })
                            .font_family(MONO)
                            .text_size(px(11.0))
                            .line_height(px(16.0))
                            .text_color(colors::FAINT)
                            .number_of_lines(1),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .child(Stat::new("Observed", {
                            let nested = nested.clone();
                            move || nested.observed.get().to_string()
                        })
                        .width(0.34))
                        .child(Stat::new("Acted", {
                            let nested = nested.clone();
                            move || nested.acted.get().to_string()
                        })
                        .tone(Tone::Accent)
                        .width(0.33))
                        .child(Stat::new("Declined", {
                            let nested = nested.clone();
                            move || nested.declined.get().to_string()
                        })
                        .tone(Tone::Warn)
                        .width(0.33)),
                )
                .child(
                    text({
                        let nested = nested.clone();
                        move || nested.note.get().0
                    })
                    .font_family(MONO)
                    .text_size(px(12.0))
                    .line_height(px(16.0))
                    .text_color({
                        let nested = nested.clone();
                        move || nested.note.get().1.color()
                    })
                    .number_of_lines(2),
                )
                .child(
                    Button::new("Focus child", move |_: &()| child.focus())
                        .variant(ButtonVariant::Secondary),
                )
                .child(note(
                    "With the child focused, mod+shift+y is captured: the parent still hears the transition and its own action declines on defaultPrevented. Enter is not captured, so the parent acts. A listener cannot synchronously veto the native default; the mounted capture rule decides before callbacks run.",
                )),
        )
}

/// The native-Input section's state.
#[derive(Clone)]
struct Ownership {
    value: Signal<String>,
    input_events: Signal<u32>,
    raw_actions: Signal<u32>,
    last_raw: Signal<String>,
    focused: Signal<bool>,
    last: Signal<Option<Seen>>,
    input: ElementRef,
    pad: ElementRef,
}

/// Section 4: a native Input inside a capture ancestry, beside a raw pad.
fn typing_in_input(state: Ownership) -> Card {
    let input = state.input;
    let pad = state.pad;
    let focused = state.focused;
    let raw = state.clone();
    let last = state.last;
    let events = state.input_events;
    let value = state.value;
    let raw_actions = state.raw_actions;
    let last_raw = state.last_raw;
    Card::new()
        .icon(IconName::Keyboard)
        .title("Typing stays in Input")
        .subtitle("A native Input owns its keys inside a capture ancestry")
        .child(
            view()
                .gap_3()
                .child(
                    view()
                        .gap_2()
                        .p_3()
                        .rounded(px(radius::CONTROL))
                        .border_1()
                        .border_color(colors::BORDER)
                        .bg(colors::INSET)
                        .finish(Finish::Inset)
                        .label("Capture ancestry")
                        .capture_keys(KeyCapture::All)
                        .on_key_down(move |event: &KeyEvent| {
                            raw.observe(event);
                        })
                        .child(
                            view()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .child(
                                    text("Capture ancestry")
                                        .flex_1()
                                        .text_size(px(13.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::TEXT),
                                )
                                .child(Badge::new("captureKeys(All)").tone(Tone::Accent).outline())
                                .child(Badge::new("Input owns its text").outline()),
                        )
                        .child(
                            view()
                                .flex_row()
                                .items_center()
                                .gap_2()
                                .p_3()
                                .rounded(px(radius::INSET))
                                .border_1()
                                .border_color(colors::BORDER)
                                .bg(colors::RAISED)
                                .focusable(true)
                                .label("Raw key pad")
                                .element_ref(&pad)
                                .focus(|s| s.border_color(colors::ACCENT))
                                .child(
                                    text("Raw key pad")
                                        .text_size(px(13.0))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(colors::TEXT),
                                )
                                .child(
                                    text("type letters: the raw action runs")
                                        .flex_1()
                                        .text_size(px(12.0))
                                        .text_color(colors::FAINT),
                                ),
                        )
                        .child(
                            view()
                                .flex_row()
                                .items_center()
                                .rounded(px(radius::CONTROL))
                                .border_1()
                                .border_color(colors::BORDER)
                                .focus_within(|s| s.border_color(colors::ACCENT))
                                .bg(colors::RAISED)
                                .child(
                                    nsh_base::input()
                                        .flex_1()
                                        .h(px(46.0))
                                        .px(px(14.0))
                                        .text_size(px(15.0))
                                        .text_color(colors::TEXT)
                                        .placeholder("Type here")
                                        .placeholder_color(|| color(colors::FAINT))
                                        .caret_color(|| color(colors::ACCENT))
                                        .selection_color(|| color(colors::ACCENT))
                                        .element_ref(&input)
                                        .value({
                                            move || value.get()
                                        })
                                        .on_change({
                                            move |text: &str| value.set(text.to_owned())
                                        })
                                        .on_key_press(move |_: &str| {
                                            events.update(|n| *n += 1);
                                        })
                                        .on_focus(move || focused.set(true))
                                        .on_blur(move || focused.set(false)),
                                ),
                        )
                        .child(
                            view()
                                .flex_row()
                                .items_baseline()
                                .gap_2()
                                .child(
                                    text("Value")
                                        .text_size(px(12.0))
                                        .text_color(colors::MUTED),
                                )
                                .child(
                                    text({
                                        move || value.get()
                                    })
                                    .flex_1()
                                    .font_family(MONO)
                                    .text_size(px(12.0))
                                    .text_color(colors::TEXT)
                                    .number_of_lines(1),
                                )
                                .child(
                                    text({
                                        move || format!("{} chars", value.get().chars().count())
                                    })
                                    .text_size(px(12.0))
                                    .text_color(colors::FAINT)
                                    .tabular_nums(),
                                ),
                        ),
                )
                .child(
                    view()
                        .flex_row()
                        .child(Stat::new("Input events", move || {
                            events.get().to_string()
                        })
                        .width(0.34))
                        .child(Stat::new("Raw actions", move || {
                            raw_actions.get().to_string()
                        })
                        .tone_when(
                            move || raw_actions.get() > 0,
                            Tone::Accent,
                        )
                        .width(0.33))
                        .child(Stat::new("defaultPrevented", move || {
                            last.with(|last| {
                                last.as_ref().map_or("—", |s| yes(s.prevented)).to_owned()
                            })
                        })
                        .width(0.33)),
                )
                .child(
                    text({
                        move || last_raw.get()
                    })
                    .font_family(MONO)
                    .text_size(px(12.0))
                    .text_color(colors::FAINT)
                    .number_of_lines(1),
                )
                .child(
                    view()
                        .flex_row()
                        .flex_wrap()
                        .items_center()
                        .gap_2()
                        .child(
                            Button::new("Focus pad", move |_: &()| pad.focus())
                                .variant(ButtonVariant::Secondary),
                        )
                        .child(
                            Button::new("Focus input", move |_: &()| input.focus())
                                .variant(ButtonVariant::Accent),
                        ),
                )
                .child(note(
                    "Input owns its text: typing changes only its value, and its IME composition stays its own. While the Input has the keys, the ancestor's capture rule does not intercept them and the custom raw action stays idle. The pad beside it shows that action running when it has the focus.",
                )),
        )
}

impl Ownership {
    fn observe(&self, event: &KeyEvent) {
        let code = if event.code.is_empty() {
            SharedString::from("—")
        } else {
            event.code.clone()
        };
        self.last.set(Some(Seen {
            key: event.key.clone(),
            code,
            repeat: event.repeat,
            prevented: event.default_prevented,
        }));
        if self.focused.get_untracked() || event.repeat {
            return;
        }
        let mut chars = event.key.chars();
        if let (Some(first), None) = (chars.next(), chars.next())
            && first.is_ascii_alphabetic()
        {
            self.raw_actions.update(|n| *n += 1);
            self.last_raw
                .set(format!("Raw action: {first} (the ancestor's own handler)"));
        }
    }
}

/// The demo's four sections.
#[component]
pub(crate) fn KeyboardDemo() -> impl IntoElement {
    let play = Playfield {
        x: animated_value(0.0),
        y: animated_value(0.0),
        x_at: stored(0.0_f32),
        y_at: stored(0.0_f32),
        width: signal(0.0_f32),
        held: signal(0_u8),
        frame: stored(None::<Spawned<()>>),
        last: stored(None::<Instant>),
        placed: stored(false),
        owner: Owner::current(),
        stage: element_ref(),
    };
    // A window that stops taking input reports no key releases: it is a
    // blur as far as the held set is concerned.
    effect({
        let play = play.clone();
        move || {
            if lifecycle() != Lifecycle::Active {
                play.clear();
            }
        }
    });
    let console = Console {
        last: signal(None::<Seen>),
        log: signal(Vec::<String>::new()),
        modifiers: signal(Modifiers::default()),
        keys: element_ref(),
    };
    let nested = Nested {
        observed: signal(0_u32),
        acted: signal(0_u32),
        declined: signal(0_u32),
        note: signal(("—".to_owned(), Tone::Neutral)),
        child_last: signal("Child saw —".to_owned()),
        child: element_ref(),
    };
    let ownership = Ownership {
        value: signal(String::new()),
        input_events: signal(0_u32),
        raw_actions: signal(0_u32),
        last_raw: signal("Raw action: —".to_owned()),
        focused: signal(false),
        last: signal(None::<Seen>),
        input: element_ref(),
        pad: element_ref(),
    };
    let chords = captured_chords();
    let labels = chords.map(keystroke_label);
    let action = chords[0];
    DemoPage::new()
        .columns(2)
        .card({
            let play = play.clone();
            move || held_arrows(play.clone())
        })
        .card({
            let console = console.clone();
            move || modifier_chords(console.clone(), chords, labels.clone())
        })
        .card({
            let nested = nested.clone();
            move || capture_and_bubbling(nested.clone(), action)
        })
        .card({
            let ownership = ownership.clone();
            move || typing_in_input(ownership.clone())
        })
        .into_element()
}
