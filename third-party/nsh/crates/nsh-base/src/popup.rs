//! What the popups of `nsh/base` share (`Popover`, `Menu`, `ContextMenu`,
//! `Tooltip`, `Sheet`): their open state, controlled or not, and why it
//! changed. They show their content in the core's overlays
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
//! submenus replace its items, and a press outside a popup only closes it
//! (a transparent backdrop takes it). A popover stays anchored to its
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
    /// tooltip's).
    Hover,
    /// A finger was held on its trigger (a context menu's on touch
    /// screens).
    LongPress,
    /// The secondary button was pressed on its trigger (a context menu's).
    ContextMenu,
}

/// Whether a popup is open: the app's `open` when it sets one, else its own
/// state (from `defaultOpen`).
#[derive(Clone, Copy)]
pub(crate) struct OpenState {
    controlled: Prop<Option<bool>>,
    own: Signal<bool>,
}

impl OpenState {
    pub(crate) fn new(open: Prop<Option<bool>>, default_open: Prop<bool>) -> Self {
        Self {
            controlled: open,
            own: signal(default_open.get_untracked()),
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

    /// The user asks for it to be `open`: when that is a change, `report`
    /// runs (the popup emits `OpenChange`), then its own state follows when
    /// the app does not control it. Reported first: the lifecycle
    /// ([`lifecycle`]) emits `Open` / `Close` as what is shown changes, at
    /// once where the popup has no motion (no ending look, reduced motion),
    /// and the app hears `onOpenChange` before them.
    pub(crate) fn request(self, open: bool, report: impl FnOnce()) {
        if self.get_untracked() == open {
            return;
        }
        report();
        if self.controlled.get_untracked().is_none() {
            self.own.set(open);
        }
    }
}

/// A popup's lifecycle, the same for every one (as `Dialog`'s): `open` once
/// it is all there (a sheet after it came in), `close` once it is all gone
/// (after it went: a sheet's motion, a popup's exit), whoever opened or
/// closed it. `shown` is tracked; its
/// first value only counts when it is shown.
pub(crate) fn lifecycle(
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

/// A popup's presence (`Popover`'s, a desktop menu's and its submenus',
/// `Tooltip`'s), as a toast's `transitionStatus` and Base UI's
/// `data-starting-style` / `data-ending-style`: opened, it is mounted with
/// its starting look until its first display frame, so the app's
/// `transition-*` classes run its entrance; closed, it stays mounted with
/// its ending look (taking no presses) for as long as its transitions then
/// run (the core says, [`ElementRef::transition_time`]; two seconds at
/// most), then goes. Opened again on its way out, it is taken back (its
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

    /// The ref its popup part carries.
    pub(crate) fn popup(self) -> ElementRef {
        self.popup
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
            self.drag_y.set(0.0);
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
            self.drag_y.timing(0.0, SHEET_OUT_MS, Easing::EaseIn);
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
        if reduce_motion() {
            self.drag_y.set(0.0);
            self.fade.set(1.0);
            self.settled.set(true);
            return;
        }
        self.drag_y.timing(0.0, SHEET_IN_MS, Easing::EaseOut);
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
    pub(crate) backdrop_class: Prop<Option<SharedString>>,
    pub(crate) backdrop_style: Prop<Style>,
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
}

/// A dropdown while it is open (`Select`'s list, `DatePicker`'s calendar):
/// on the desktops a popup anchored to the trigger `anchor` names, at least
/// `width` wide (its width, once it is laid out), never past the room on
/// its side; on touch screens a sheet at the bottom over a backdrop. It
/// holds what `content` makes (`true` in a sheet).
pub(crate) fn dropdown(
    anchor: ElementRef,
    width: Signal<Option<Points>>,
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
    let shown = {
        let open = presence.open.clone();
        move || {
            if sheet {
                motion.shown.get()
            } else {
                open() && width.with(Option::is_some)
            }
        }
    };
    {
        let open = presence.open.clone();
        let (opened, closed) = (presence.shown.clone(), presence.shown.clone());
        lifecycle(
            move || {
                if sheet {
                    motion.there()
                } else {
                    open() && width.with(Option::is_some)
                }
            },
            move || opened(true),
            move || closed(false),
        );
    }
    when(shown, move || {
        // The trigger may be a toolbar's item; the content is not.
        leave_bar();
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
                .bottom_0()
                // Below the status bar, whatever the rows.
                .max_h(move || Length::from(window().height - safe_area().top))
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
        let popup = overlay()
            // The trigger itself: in a TSX app the app's element, whose
            // box is what shows (not the slot's view, which a column
            // stretches).
            .anchor(&anchor)
            .placement(frame.placement)
            .align(frame.align)
            .offset(frame.offset)
            .margin(frame.margin)
            .min_w(move || Length::from(width.get().unwrap_or_default()))
            // Never past the room on its side: its rows scroll. Until
            // the core says where it went, the window bounds it, so the
            // first layout already gives the rows a viewport to
            // virtualize against (unbounded, a list of thousands would
            // make every row).
            .max_h(move || Length::from(room.get().unwrap_or_else(|| window().height)))
            .app_class(frame.popup_class)
            .inline_style(frame.popup_style)
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
