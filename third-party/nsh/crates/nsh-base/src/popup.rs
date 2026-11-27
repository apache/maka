//! What the popups of `nsh/base` share (`Popover`, `HoverCard`, `Menu`,
//! `ContextMenu`, `Tooltip`, `Sheet`, and the dropdowns of `Select`,
//! `Combobox` and `DatePicker`): their open state, controlled or not, and
//! why it changed. They show their content in the core's overlays
//! (`nsh_core::element::overlay`), which place it and report presses outside,
//! Escape and the back button; deciding to close is theirs. A sheet comes
//! and goes with its own motion ([`SheetMotion`]); a popup's entrance and
//! exit are the app's transitions between its look and its states' looks
//! ([`PopupPresence`]).
//!
//! How a popup presents itself follows the device (`auto`, the only
//! presentation for now): on the desktops (and desktop browsers) a menu is
//! a popup at its trigger or the pointer, with cascading submenus, and a
//! press outside closes a popup and goes on to what is under it; on phones
//! and tablets a menu is a sheet at the bottom of the screen whose
//! submenus replace its items (an iPad in a regular width shows the
//! desktops' popup: `menu.rs`'s `as_sheet`), and a press outside a popup
//! only closes it (a transparent backdrop takes it). A popover stays anchored to its
//! trigger everywhere: what it shows belongs next to it.

use std::{rc::Rc, time::Duration};

use nsh_core::{element::Style, prelude::*};

use crate::roving::leave_bar;

/// Why a popup opened or closed (`onOpenChange`'s `reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub enum OpenChangeReason {
    /// Its trigger was pressed.
    TriggerPress,
    /// A press went down outside it.
    PressOutside,
    /// Its backdrop was pressed (a sheet's).
    BackdropPress,
    /// A sheet was swiped toward its edge.
    Swipe,
    /// Escape or the Android back button.
    Cancel,
    /// An item was chosen (a menu's).
    Select,
    /// The pointer rested on its trigger, or left or pressed it (a
    /// tooltip's); left its trigger and itself (a hover card's).
    Hover,
    /// The keyboard focus moved to another item of its menu (a
    /// submenu's); Tab or
    /// Shift+Tab moved it on from a select or combobox whose list was open
    /// (the focus goes where Tab takes it).
    Focus,
    /// A finger was held on its trigger (a context menu's on touch
    /// screens).
    LongPress,
    /// A context menu was asked for on its trigger (a context menu's): the
    /// secondary button, the keyboard's menu keys or an assistive
    /// technology's "show menu" action.
    ContextMenu,
    /// The user typed in its input (a combobox's).
    InputChange,
}

/// Whether a popup is open: the app's `open` when it sets one, else its own
/// state (from `defaultOpen`).
#[derive(Clone, Copy)]
pub(crate) struct OpenState {
    controlled: Prop<Option<bool>>,
    own: Signal<bool>,
    /// What was last reported to the app that controls it, until its
    /// answer reached the popup: a request before then is a change from
    /// that (a secondary click on an open context menu's trigger closes
    /// it and opens it again, both reported).
    asked: Stored<Option<bool>>,
    /// Why the user last asked it to close ([`Self::request_for`]), until
    /// the popup reads it as it goes ([`Self::take_closed_by`]) or the app
    /// that controls it keeps it open.
    closed_by: Stored<Option<OpenChangeReason>>,
    /// The popup's own owner, which lets go of `asked`: a request comes
    /// from what it shows (Escape, an item chosen), which the answer
    /// closing it takes away before the answer reaches the popup.
    owner: Owner,
}

impl OpenState {
    pub(crate) fn new(open: Prop<Option<bool>>, default_open: Prop<bool>) -> Self {
        Self {
            controlled: open,
            own: signal(default_open.get_untracked()),
            asked: stored(None),
            closed_by: stored(None),
            owner: Owner::current(),
        }
    }

    /// Whether it is open (tracked).
    pub(crate) fn get(self) -> bool {
        self.controlled.get().unwrap_or_else(|| self.own.get())
    }

    pub(crate) fn get_untracked(self) -> bool {
        self.controlled
            .get_untracked()
            .unwrap_or_else(|| self.own.get_untracked())
    }

    /// Opened by the app that controls it, not in answer to the user's
    /// request (`asked`): read as it opens.
    pub(crate) fn opened_by_app(self) -> bool {
        self.controlled.get_untracked() == Some(true) && self.asked.get() != Some(true)
    }

    /// The user asks for it to be `open`: when that is a change, `report`
    /// runs (the popup emits `OpenChange`), then its own state follows when
    /// the app does not control it. Reported first: the lifecycle
    /// ([`lifecycle`]) emits `Open` / `Close` as what is shown changes, at
    /// once where the popup has no motion (no ending look, reduced motion),
    /// and the app hears `onOpenChange` before them.
    pub(crate) fn request(self, open: bool, report: impl FnOnce()) {
        if self.asked.get().unwrap_or_else(|| self.get_untracked()) == open {
            return;
        }
        report();
        if self.controlled.get_untracked().is_none() {
            self.own.set(open);
        } else {
            self.asked.replace(Some(open));
            self.owner.run(|| {
                after_answer(move || {
                    self.asked.replace(None);
                    // The app kept it open (a press outside it asks to
                    // confirm first): the reason goes with the refusal, or
                    // the app's own close later would read it.
                    if !open && self.get_untracked() {
                        self.closed_by.replace(None);
                    }
                })
            });
        }
    }

    /// [`Self::request`] for `reason`, which a close keeps until the popup
    /// reads it as it goes ([`Self::take_closed_by`]): where the keyboard
    /// focus goes then depends on what closed it (a press outside put it
    /// where it pressed).
    pub(crate) fn request_for(self, open: bool, reason: OpenChangeReason, report: impl FnOnce()) {
        if !open {
            self.closed_by.replace(Some(reason));
        }
        self.request(open, report);
    }

    /// Why the user asked it to close, read once as it goes: none when the
    /// app closed it, or when the app kept it open after the user asked.
    pub(crate) fn take_closed_by(self) -> Option<OpenChangeReason> {
        self.closed_by.replace(None)
    }
}

/// A popup's lifecycle, the same for every one (as `Dialog`'s): `open` once
/// it is all there (a sheet after it came in), `close` once it is all gone
/// (after it went: a sheet's motion, a popup's exit), whoever opened or
/// closed it. `shown` is tracked; its
/// first value only counts when it is shown.
///
/// All there is rendered: `open` waits for the commit after the one that
/// made the content, whose refs then name its views, so the app's
/// `focus()` in `onOpen` reaches them. A popup gone before then neither
/// opens nor closes.
pub(crate) fn lifecycle(
    shown: impl Fn() -> bool + 'static,
    open: impl Fn() + 'static,
    close: impl Fn() + 'static,
) {
    let open = Rc::new(open);
    // A newer flip ends an opening still waiting.
    let generation = stored(0u64);
    let opened = stored(false);
    flips(
        shown,
        move || {
            let current = generation.get().wrapping_add(1);
            generation.replace(current);
            let open = open.clone();
            after_answer(move || {
                if generation.get() == current {
                    opened.replace(true);
                    untracked(|| open());
                }
            });
        },
        move || {
            generation.replace(generation.get().wrapping_add(1));
            if opened.replace(false) {
                close();
            }
        },
    );
}

/// `open` as `shown` turns true and `close` as it turns false, in the
/// change itself; its first value only counts when it is true.
fn flips(
    shown: impl Fn() -> bool + 'static,
    open: impl Fn() + 'static,
    close: impl Fn() + 'static,
) {
    let was = stored(false);
    effect(move || {
        let now = shown();
        match (was.replace(now), now) {
            (false, true) => untracked(&open),
            (true, false) => untracked(&close),
            _ => {}
        }
    });
}

/// How long a popup waits for its first display frame before it counts as
/// past it without one (a surface not on screen), as a toast does.
const FIRST_FRAME_MS: u64 = 50;
/// The longest a popup stays mounted through its exit, whatever its
/// transitions say.
const EXIT_CAP: Duration = Duration::from_secs(2);

/// `class` with every utility important (`opacity-0` is `opacity-0!`): a
/// state's classes win over the part's `class` and `style`, as a state's
/// styles do (`activeStyle`) and as CSS's state selectors do by their
/// specificity.
pub(crate) fn important(class: &str) -> SharedString {
    class
        .split_whitespace()
        .map(|t| {
            if t.ends_with('!') || t.split(':').next_back().is_some_and(|u| u.starts_with('!')) {
                t.to_owned()
            } else {
                format!("{t}!")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
        .into()
}

/// Where a popup is in its life, which its state looks follow (Base UI's
/// `data-starting-style` / `data-ending-style`, a toast's
/// `transitionStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Status {
    /// Just mounted: its first frame, with its starting look.
    Starting,
    /// Open.
    Open,
    /// Closed, mounted until its exit's transitions ran.
    Ending,
}

/// The app's looks of a popup part's states: `<part>StartingClass` /
/// `<part>StartingStyle` in its first frame, `<part>EndingClass` /
/// `<part>EndingStyle` while it goes, over the part's own `class` /
/// `style` (none: the component's root, which the core gives the app's
/// `class` and `style` itself).
#[derive(Clone, Copy)]
pub(crate) struct StateLooks {
    pub(crate) class: Option<Prop<Option<SharedString>>>,
    pub(crate) style: Option<Prop<Style>>,
    pub(crate) starting_class: Prop<Option<SharedString>>,
    pub(crate) starting_style: Prop<Style>,
    pub(crate) ending_class: Prop<Option<SharedString>>,
    pub(crate) ending_style: Prop<Style>,
}

impl StateLooks {
    fn has_starting(self) -> bool {
        self.starting_class.with_untracked(|c| c.is_some())
            || self
                .starting_style
                .with_untracked(|s| *s != Style::default())
    }

    fn has_ending(self) -> bool {
        self.ending_class.with_untracked(|c| c.is_some())
            || self.ending_style.with_untracked(|s| *s != Style::default())
    }
}

/// The core notes the keyboard focus and the input each time `open` turns
/// true, the popup that gives the focus back to `trigger` opening
/// ([`ElementRef::focus_back_origin`]): on macOS and iOS, a popup a
/// pointer opened gives it back where it was, as AppKit and UIKit do (a pointer's press leaves the
/// focus where it is), one the keyboard opened to its trigger. `open` is
/// tracked.
pub(crate) fn note_focus_origin(open: impl Fn() -> bool + 'static, trigger: ElementRef) {
    let was = stored(false);
    effect(move || {
        let now = open();
        if !was.replace(now) && now {
            untracked(|| trigger.focus_back_origin());
        }
    });
}

/// A popup's presence (`Popover`'s, `HoverCard`'s, a desktop menu's and
/// its submenus', `Tooltip`'s, a desktop dropdown's), as a toast's `transitionStatus` and Base UI's
/// `data-starting-style` / `data-ending-style`: opened, it is mounted with
/// its starting look until its first display frame, so the app's
/// `transition-*` classes run its entrance; closed, it stays mounted with
/// its ending look (taking no presses, nor keys once its component gave
/// the focus back: [`Self::focus_back_on_close`]) for as long as its
/// transitions then run (the core says, [`ElementRef::transition_time`];
/// two seconds at most), then goes. Opened again on its way out, it is taken back (its
/// transitions run back). Without a look for a state, or when the user
/// asked for less motion, it skips that state: a popup with no ending look
/// goes at once, as one with no motion did.
#[derive(Clone, Copy)]
pub(crate) struct PopupPresence {
    /// Mounted: open, or on its way out.
    mounted: Signal<bool>,
    status: Signal<Status>,
    looks: StateLooks,
    /// The popup part, whose transitions its exit waits for.
    popup: ElementRef,
    /// A stale frame, timer or exit cannot finish a newer change.
    generation: Stored<u64>,
}

impl PopupPresence {
    /// The presence of a popup that is open while `open` says so, its
    /// part carrying `popup` ([`Self::popup`]).
    pub(crate) fn new(open: impl Fn() -> bool + 'static, looks: StateLooks) -> Self {
        let presence = Self {
            mounted: signal(false),
            status: signal(Status::Open),
            looks,
            popup: element_ref(),
            generation: stored(0),
        };
        // Runs again only when it opens or closes (not when what `open`
        // reads changes and it stays as it was): each run is a change, and
        // the frames, timers and exit it starts belong to it, ended by the
        // next.
        let open = computed(open);
        effect(move || {
            let open = open.get();
            untracked(|| presence.follow(open));
        });
        presence
    }

    fn follow(self, open: bool) {
        let status = self.status.get_untracked();
        if open {
            if self.mounted.get_untracked() {
                // Opened again on its way out: back to open.
                if status == Status::Ending {
                    self.next_change();
                    self.status.set(Status::Open);
                }
                return;
            }
            let generation = self.next_change();
            let starting = !reduce_motion() && self.looks.has_starting();
            self.status.set(if starting {
                Status::Starting
            } else {
                Status::Open
            });
            self.mounted.set(true);
            if starting {
                // Open from the next display frame, or a frame's time
                // where none comes, whichever is first.
                let enter = move || {
                    if self.generation.get() == generation
                        && self.status.get_untracked() == Status::Starting
                    {
                        self.status.set(Status::Open);
                    }
                };
                request_animation_frame(move |_| enter());
                set_timeout(Duration::from_millis(FIRST_FRAME_MS), enter);
            }
        } else if self.mounted.get_untracked() && status != Status::Ending {
            let generation = self.next_change();
            if reduce_motion() || !self.looks.has_ending() {
                self.mounted.set(false);
                self.status.set(Status::Open);
                return;
            }
            self.status.set(Status::Ending);
            // Gone once: a later change, or the other way here, finds it
            // gone already.
            let finish = move || {
                if self.generation.get() == generation
                    && self.status.get_untracked() == Status::Ending
                {
                    self.mounted.set(false);
                    // Its look while closed (a tooltip's view stays).
                    self.status.set(Status::Open);
                }
            };
            // Gone once its transitions with its ending look ran: the core
            // answers once this change is styled.
            let popup = self.popup;
            spawn(async move {
                let time = popup.transition_time().await.min(EXIT_CAP);
                if !time.is_zero() {
                    timer(time).await;
                }
                finish();
            });
            // And at the latest after the cap, whatever the answer.
            set_timeout(EXIT_CAP, finish);
        }
    }

    /// A new change: what an older one left pending no longer acts.
    fn next_change(self) -> u64 {
        let next = self.generation.get().wrapping_add(1);
        self.generation.replace(next);
        next
    }

    /// Whether the popup is mounted (tracked): open, or on its way out.
    pub(crate) fn mounted(self) -> bool {
        self.mounted.get()
    }

    /// [`Self::mounted`], untracked.
    pub(crate) fn mounted_untracked(self) -> bool {
        self.mounted.get_untracked()
    }

    /// The ref its popup part carries.
    pub(crate) fn popup(self) -> ElementRef {
        self.popup
    }

    /// The keyboard focus in the popup as it closes (Escape, a choice in
    /// it, the app closing it) goes back where `back` puts it (its
    /// trigger) at once, not once the popup is gone: on its way out the
    /// popup takes no keys, as it takes no presses, so a key pressed
    /// during its exit cannot act in it again. `open` is tracked; `back`
    /// runs as it turns false while the focus is inside.
    pub(crate) fn focus_back_on_close(
        self,
        open: impl Fn() -> bool + 'static,
        back: impl Fn() + 'static,
    ) {
        let inside = stored(false);
        self.popup.on_focus_in(move || {
            inside.replace(true);
        });
        self.popup.on_focus_out(move || {
            inside.replace(false);
        });
        let was = stored(false);
        effect(move || {
            let now = open();
            // Not cleared here: the focus watch says when the focus leaves,
            // the popup part's removal on close included.
            if was.replace(now) && !now && inside.get() {
                untracked(&back);
            }
        });
    }

    /// The part's classes now: its own with its state's over them
    /// (important), and none of its presses while it goes.
    pub(crate) fn class(self) -> Option<SharedString> {
        let own = self.looks.class.and_then(|c| c.get());
        let state = match self.status.get() {
            Status::Open => return own,
            Status::Starting => self.looks.starting_class.get().map(|c| important(&c)),
            Status::Ending => Some(
                match self.looks.ending_class.get() {
                    Some(c) => format!("{} pointer-events-none!", important(&c)),
                    None => "pointer-events-none!".to_owned(),
                }
                .into(),
            ),
        };
        match (own, state) {
            (Some(own), Some(state)) => Some(format!("{own} {state}").into()),
            (own, state) => state.or(own),
        }
    }

    /// The part's inline style now: its own with its state's over it.
    pub(crate) fn style(self) -> Style {
        let own = self.looks.style.map(|s| s.get()).unwrap_or_default();
        match self.status.get() {
            Status::Open => own,
            Status::Starting => own.then(&self.looks.starting_style.get()),
            Status::Ending => own.then(&self.looks.ending_style.get()),
        }
    }
}

/// How far a panel docked to the bottom of the screen (a sheet, a drawer,
/// a menu or a list shown as a sheet) stands above it while the software
/// keyboard is up: as far as the keyboard reaches past the bottom safe
/// area, which its height includes. The panel pads its bottom by the safe
/// area with or without a keyboard, so its content ends right above the
/// keyboard, as a page padded by the larger of `env(safe-area-inset-bottom)`
/// and `env(keyboard-inset-height)` does. Read in a style: a change of the
/// keyboard's height moves the panel with the keyboard's own motion.
pub(crate) fn keyboard_lift() -> Points {
    (keyboard_height() - safe_area().bottom).max(Points::ZERO)
}

/// The tallest a panel docked to the bottom of the screen gets: below the
/// status bar, above the keyboard ([`keyboard_lift`]).
pub(crate) fn bottom_panel_max_height() -> Length {
    Length::from(window().height - safe_area().top - keyboard_lift())
}

/// How long a sheet takes to come in and to go, in milliseconds.
const SHEET_IN_MS: f32 = 280.0;
const SHEET_OUT_MS: f32 = 200.0;

/// How a sheet comes and goes (`Sheet`, and menus presented as sheets): its
/// backdrop fades while its panel slides in from its edge, and out again
/// before they leave the view; at once when the user asked for less motion.
/// The motion is the sheet's behavior, not a look: native animated values,
/// bound to the parts the app styles.
#[derive(Clone, Copy)]
pub(crate) struct SheetMotion {
    /// The parts are in the view: while open, and while they go.
    pub(crate) shown: Signal<bool>,
    /// It is all there: it came in and has not started to go.
    pub(crate) settled: Signal<bool>,
    /// The backdrop's opacity.
    pub(crate) fade: AnimatedValue,
    /// The panel's translation.
    pub(crate) x: AnimatedNode,
    pub(crate) y: AnimatedNode,
    /// Downward dragging is in points, independently of the entrance's
    /// fraction of the current panel size.
    pub(crate) drag_y: AnimatedValue,
    /// Where `drag_y` rests while it is there: 0, or how far below its
    /// top a sheet at a smaller detent stands.
    rest_y: Stored<f32>,
    /// `drag_y` stays where it is as it goes (a sheet with detents, whose
    /// translation reads it scaled by the backdrop's fade).
    hold_drag: Stored<bool>,
    away_x: AnimatedValue,
    away_y: AnimatedValue,
    away: Stored<(f32, f32)>,
    side: Stored<Placement>,
    /// Laid out once open: the panel's size, where it comes from.
    entering: Stored<bool>,
    /// The panel's size as last laid out, where it goes back to.
    panel: Stored<Option<Size<Points>>>,
    /// Going: it leaves the view once its motion's time is over.
    closing: Stored<bool>,
    /// The panel stays mounted while closed ([`Self::keeping_panel`]).
    kept: Stored<bool>,
    /// Stale animation ends and fallback timers cannot finish a newer motion.
    generation: Stored<u64>,
}

impl SheetMotion {
    /// A motion that follows `open`, the panel on `side`.
    pub(crate) fn new(
        open: impl Fn() -> bool + 'static,
        side: impl Fn() -> Placement + 'static,
    ) -> Self {
        let fade = animated_value(0.0);
        let remaining = fade.interpolate(&[0.0, 1.0], &[1.0, 0.0]);
        let away_x = animated_value(0.0);
        let away_y = animated_value(0.0);
        let drag_y = animated_value(0.0);
        let motion = Self {
            shown: signal(false),
            settled: signal(false),
            fade,
            x: away_x.mul(&remaining),
            y: away_y.mul(&remaining).add(&drag_y),
            drag_y,
            rest_y: stored(0.0),
            hold_drag: stored(false),
            away_x,
            away_y,
            away: stored((0.0, 0.0)),
            side: stored(Placement::Bottom),
            entering: stored(false),
            panel: stored(None),
            closing: stored(false),
            kept: stored(false),
            generation: stored(0),
        };
        effect(move || {
            let open = open();
            let side = side();
            untracked(|| motion.follow(open, side));
        });
        motion
    }

    /// For a panel that stays mounted while closed (a dock's drawer, which
    /// keeps its panels' state): it keeps its frame, so no layout comes
    /// to say its size when it opens again, and it comes in from as far
    /// as it was last laid out.
    pub(crate) fn keeping_panel(self) -> Self {
        self.kept.replace(true);
        self
    }

    /// Where `drag_y` rests once it came in ([`Self::come_in`]).
    pub(crate) fn rest_at(self, y: f32) {
        self.rest_y.replace(y);
    }

    /// Whether `drag_y` stays where it is as the sheet goes.
    pub(crate) fn hold_drag(self, hold: bool) {
        self.hold_drag.replace(hold);
    }

    fn follow(self, open: bool, side: Placement) {
        self.side.replace(side);
        if open {
            if self.closing.replace(false) {
                // Opened again on its way out: back in from where it is.
                self.come_in();
                return;
            }
            if self.shown.get_untracked() {
                return;
            }
            self.fade.set(0.0);
            self.drag_y.set(self.rest_y.get());
            self.shown.set(true);
            // A kept panel laid out before says its size no more.
            let known = self.kept.get().then(|| self.panel.with(|p| *p)).flatten();
            if let Some(size) = known {
                self.set_away(size);
                self.come_in();
                return;
            }
            // Out of sight until the panel is laid out: as far as the window.
            self.set_away(window());
            self.entering.replace(true);
        } else if self.shown.get_untracked() && !self.closing.with(|c| *c) {
            let generation = self.next_motion();
            self.entering.replace(false);
            if reduce_motion() {
                self.settled.set(false);
                self.shown.set(false);
                return;
            }
            // Going before it stops being settled: it is there until gone.
            self.closing.replace(true);
            self.settled.set(false);
            if !self.hold_drag.get() {
                self.drag_y.timing(0.0, SHEET_OUT_MS, Easing::EaseIn);
            }
            let end = self.fade.timing(0.0, SHEET_OUT_MS, Easing::EaseIn);
            let (shown, closing) = (self.shown, self.closing);
            // Gone when the motion ends: the platform runs it and reports
            // its end, whatever clock the app's timers follow (a test's
            // manual one moves only as the test says).
            spawn(async move {
                if end.await && self.generation.get() == generation && closing.replace(false) {
                    shown.set(false);
                }
            });
            // Or after the motion's time, whether or not its end is
            // reported (a platform that stops it, one that runs none).
            set_timeout(
                std::time::Duration::from_millis(SHEET_OUT_MS as u64),
                move || {
                    if self.generation.get() == generation && closing.replace(false) {
                        shown.set(false);
                    }
                },
            );
        }
    }

    /// Whether it is there for its lifecycle (tracked): from when it came
    /// in until it is gone.
    pub(crate) fn there(self) -> bool {
        self.settled.get() || (self.shown.get() && self.closing.with(|c| *c))
    }

    fn set_away(self, size: Size<Points>) {
        let (x, y) = away(self.side.get(), size);
        let before = self.away.replace((x, y));
        if before.0 != x {
            self.away_x.set(x);
        }
        if before.1 != y {
            self.away_y.set(y);
        }
    }

    /// The panel was laid out at `size`: it comes in from as far.
    pub(crate) fn laid_out(self, size: Size<Points>) {
        self.panel.replace(Some(size));
        // Lazy children can fill in over several layout rounds, even in
        // one native batch. Keep the distance live: the same entrance
        // fraction then uses the complete size without restarting time.
        self.set_away(size);
        if !self.entering.replace(false) {
            return;
        }
        self.come_in();
    }

    /// From where it is to its place, the backdrop to opaque; settled once
    /// it is there.
    pub(crate) fn come_in(self) {
        let generation = self.next_motion();
        let rest = self.rest_y.get();
        if reduce_motion() {
            self.drag_y.set(rest);
            self.fade.set(1.0);
            self.settled.set(true);
            return;
        }
        self.drag_y.timing(rest, SHEET_IN_MS, Easing::EaseOut);
        let end = self.fade.timing(1.0, SHEET_IN_MS, Easing::EaseOut);
        let (settled, closing) = (self.settled, self.closing);
        // There when the motion ends, or after its time (as it goes).
        spawn(async move {
            if end.await && self.generation.get() == generation && !closing.with(|c| *c) {
                settled.set(true);
            }
        });
        set_timeout(
            std::time::Duration::from_millis(SHEET_IN_MS as u64),
            move || {
                if self.generation.get() == generation && !closing.with(|c| *c) {
                    settled.set(true);
                }
            },
        );
    }

    fn next_motion(self) -> u64 {
        let next = self.generation.get().wrapping_add(1);
        self.generation.replace(next);
        next
    }
}

/// The translation that puts a panel of `size` out of sight past `side`.
fn away(side: Placement, size: Size<Points>) -> (f32, f32) {
    match side {
        Placement::Bottom => (0.0, size.height.0),
        Placement::Top => (0.0, -size.height.0),
        Placement::Left => (-size.width.0, 0.0),
        Placement::Right => (size.width.0, 0.0),
    }
}

/// Where a dropdown goes and the parts of its frame (`Select`'s,
/// `Combobox`'s and `DatePicker`'s props).
#[derive(Clone, Copy)]
pub(crate) struct DropdownFrame {
    pub(crate) placement: Prop<Placement>,
    pub(crate) align: Prop<Align>,
    pub(crate) offset: Prop<Points>,
    pub(crate) margin: Prop<Points>,
    pub(crate) popup_class: Prop<Option<SharedString>>,
    pub(crate) popup_style: Prop<Style>,
    /// The desktop popup's states' looks (a sheet keeps its motion).
    pub(crate) popup_starting_class: Prop<Option<SharedString>>,
    pub(crate) popup_starting_style: Prop<Style>,
    pub(crate) popup_ending_class: Prop<Option<SharedString>>,
    pub(crate) popup_ending_style: Prop<Style>,
    pub(crate) backdrop_class: Prop<Option<SharedString>>,
    pub(crate) backdrop_style: Prop<Style>,
}

impl DropdownFrame {
    /// The desktop popup's looks.
    fn looks(self) -> StateLooks {
        StateLooks {
            class: Some(self.popup_class),
            style: Some(self.popup_style),
            starting_class: self.popup_starting_class,
            starting_style: self.popup_starting_style,
            ending_class: self.popup_ending_class,
            ending_style: self.popup_ending_style,
        }
    }
}

/// A view inside a dropdown laid over its trigger (`Select`'s selected
/// item) while `on` says so.
#[derive(Clone, Copy)]
pub(crate) struct Cover {
    /// The view.
    pub(crate) view: ElementRef,
    /// It is rendered and laid out (refs are not tracked).
    pub(crate) shown: Signal<bool>,
    /// The dropdown lays it over the trigger (tracked); else the dropdown
    /// goes on a side of the trigger.
    pub(crate) on: Memo<bool>,
}

impl Cover {
    pub(crate) fn new(on: impl Fn() -> bool + 'static) -> Self {
        Self {
            view: element_ref(),
            shown: signal(false),
            on: computed(on),
        }
    }
}

/// What a dropdown asks of its component.
#[derive(Clone)]
pub(crate) struct Presence {
    /// Whether it is open (tracked).
    pub(crate) open: Rc<dyn Fn() -> bool>,
    /// The user tried to close it, for this reason.
    pub(crate) dismiss: Rc<dyn Fn(OpenChangeReason)>,
    /// It is all there (`true`) or all gone (`false`).
    pub(crate) shown: Rc<dyn Fn(bool)>,
    /// The desktops: it closed and starts to go (a popup that was made);
    /// the keyboard focus goes from the popup it is given where the
    /// component puts it (its trigger, unless what closed it took the
    /// focus elsewhere: [`ElementRef::focus_back`]).
    pub(crate) back: Rc<dyn Fn(ElementRef)>,
}

/// A dropdown while it is open (`Select`'s list, `DatePicker`'s calendar):
/// on the desktops a popup anchored to the trigger `anchor` names, `width`
/// wide (the trigger's, once it is laid out: a list, as shadcn/ui's and
/// `gpui-component`'s, unless the app's popup style sets a width) or at
/// least that wide (`fit`: a calendar, as wide as it needs), never past the
/// room on its side; on touch screens a sheet at the bottom over a
/// backdrop. It holds what `content` makes (`true` in a sheet). The popup
/// comes in and goes with the app's transitions between its look and its
/// states' looks ([`PopupPresence`]), the sheet with its motion.
pub(crate) fn dropdown(
    anchor: ElementRef,
    width: Signal<Option<Points>>,
    fit: bool,
    cover: Option<Cover>,
    frame: DropdownFrame,
    presence: Presence,
    content: Rc<dyn Fn(bool) -> Vec<AnyElement>>,
) -> AnyElement {
    let sheet = !is_desktop();
    let open = presence.open.clone();
    let motion = SheetMotion::new(move || sheet && open(), || Placement::Bottom);
    // The popup waits for the trigger's first layout: open at first
    // (`defaultOpen`), it would be made before the trigger is (a slot is
    // filled after the first render) and placed against nothing.
    let popup = {
        let open = presence.open.clone();
        PopupPresence::new(
            move || !sheet && open() && width.with(Option::is_some),
            frame.looks(),
        )
    };
    let shown = move || {
        if sheet {
            motion.shown.get()
        } else {
            popup.mounted()
        }
    };
    {
        let (opened, closed) = (presence.shown.clone(), presence.shown.clone());
        lifecycle(
            move || {
                if sheet {
                    motion.there()
                } else {
                    popup.mounted()
                }
            },
            move || opened(true),
            move || closed(false),
        );
    }
    // The keyboard focus goes back as the popup closes, not once it is
    // gone: on its way out it takes no presses, nor keys. Only a popup
    // that was made: one closed before the trigger's first layout never
    // took the focus, so it has none to give back.
    if !sheet {
        let open = presence.open.clone();
        let back = presence.back.clone();
        let made = stored(false);
        effect(move || {
            if open() {
                if popup.mounted() {
                    made.replace(true);
                }
            } else if made.replace(false) {
                untracked(|| back(popup.popup()));
            }
        });
    }
    // An attempt to close it: none while it goes.
    let presence = Presence {
        dismiss: {
            let (open, dismiss) = (presence.open.clone(), presence.dismiss.clone());
            Rc::new(move |reason| {
                if untracked(|| open()) {
                    dismiss(reason);
                }
            })
        },
        ..presence
    };
    when(shown, move || {
        // The trigger may be a toolbar's item; the content is not.
        leave_bar();
        // Each opening lays its own cover view out again.
        if let Some(cover) = cover {
            cover.shown.set(false);
        }
        let content = content(sheet);
        let cancel = {
            let dismiss = presence.dismiss.clone();
            move || dismiss(OpenChangeReason::Cancel)
        };
        if sheet {
            let dismiss = presence.dismiss.clone();
            let backdrop = overlay()
                .inset_0()
                .bind_opacity(&motion.fade)
                .focusable(false)
                .app_class(frame.backdrop_class)
                .inline_style(frame.backdrop_style)
                .on_press(move || dismiss(OpenChangeReason::BackdropPress));
            let panel = overlay()
                .left_0()
                .right_0()
                // Above the keyboard, below the status bar, whatever the
                // rows.
                .bottom(move || Length::from(keyboard_lift()))
                .max_h(bottom_panel_max_height)
                .app_class(frame.popup_class)
                .inline_style(frame.popup_style)
                .bind_translate_y(&motion.y)
                .on_layout(move |frame: &Bounds<Points>| motion.laid_out(frame.size))
                .on_cancel(cancel)
                .children(content);
            return vec![backdrop.into_element(), panel.into_element()];
        }
        let room = signal(None::<Points>);
        let dismiss = presence.dismiss.clone();
        // A terminal's trigger is only as wide as its value: a list there
        // is at least that wide, so its rows keep what is beside their
        // titles (the chosen item's mark).
        let terminal = crate::terminal::is_terminal();
        let fit = fit || terminal;
        // A terminal draws a popup's line a Cell outside its box on each
        // side (the core places it with that frame): the list there is two
        // Cells narrower than the trigger, so its frame, lines included,
        // runs from the trigger's first column to its last, whichever side
        // it is aligned on.
        let ring = if terminal {
            crate::terminal::cell_width() * 2.0
        } else {
            Points::ZERO
        };
        let least = move || {
            let width = width.get().unwrap_or_default();
            if width > ring {
                width - ring
            } else {
                Points::ZERO
            }
        };
        let popup = overlay()
            // The trigger itself: in a TSX app the app's element, whose
            // box is what shows (not the slot's view, which a column
            // stretches).
            .anchor(&anchor)
            .placement(frame.placement)
            .align(frame.align)
            .offset(frame.offset)
            .margin(frame.margin)
            // A list as wide as the trigger, unless the app's popup style
            // sets a width (`gpui-component`'s `menu_width`); a calendar
            // at least that wide.
            .when(fit, |p| p.min_w(move || Length::from(least())))
            .when(!fit, |p| {
                p.w(move || Length::from(width.get().unwrap_or_default()))
            })
            // A view inside over the trigger (a select's selected item);
            // on a side of it while there is none.
            .when_some(cover, |p, cover| {
                p.cover(&cover.view, move || cover.on.get() && cover.shown.get())
            })
            // Never past the room on its side: its rows scroll. Until
            // the core says where it went, the window bounds it, so the
            // first layout already gives the rows a viewport to
            // virtualize against (unbounded, a list of thousands would
            // make every row).
            .max_h(move || Length::from(room.get().unwrap_or_else(|| window().height)))
            .element_ref(&popup.popup())
            .app_class(move || popup.class())
            .state_inline_style(move || popup.style())
            .on_position(move |p: &OverlayPosition| room.set(Some(p.available.height)))
            .on_press_outside(move |_: &Point<Points>| dismiss(OpenChangeReason::PressOutside))
            .on_cancel(cancel)
            .children(content);
        vec![popup.into_element()]
    })
    .into_element()
}

#[cfg(test)]
mod tests {
    #[test]
    fn state_classes_are_important() {
        assert_eq!(
            &*super::important("opacity-0 dark:bg-black/50 !p-2 m-1!"),
            "opacity-0! dark:bg-black/50! !p-2 m-1!"
        );
    }
}
