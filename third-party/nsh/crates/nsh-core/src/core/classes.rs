//! Tailwind classes on nodes: resolving them into styles (with the inline
//! `style` applied on top) and resolving them again when what they depend
//! on changes: the appearance, the window size, the layout direction, the
//! node's interaction states, its group's states or its sibling position.
//! A sibling-position change restyles, in one pass over the parent's
//! children (`positions_changed`), only those whose position bits moved:
//! once per parent before the next flush (`flush_positions`), however many
//! children joined or left, so mounting a long list styles each row once.
//! Ordinary restyling takes the position its node was last styled at while
//! its parent's children did not move since (`known_position`).

use super::{Core, Key, Kind, NO_KEY, Positional, dirty, disabling_changes};
use crate::{
    element::JsEvent,
    geometry::{Points, Size},
    mount::MountItem,
    ops::{EventKind, EventPayload, NodeId, ResizeMode},
    platform::{Appearance, ColorScheme, InputModality},
    props::PointerEvents,
    style::{Color, PaintStyle, Style, StylePatch, TextStyle, VerticalAlign, ViewStyle},
    tailwind::{
        ClassEnvironment, ClassList, ClassProps, Context, Pointer, Rule, Theme, deps, position,
        rank, state,
    },
    text::TextEngine,
};

/// Maximum entries kept in [`Core::resolved_styles`] before clearing.
pub(super) const RESOLVED_STYLE_CACHE: usize = 4096;

/// Cache key for [`Core::resolved_styles`], normalized to the dependency bits of `ClassList`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(super) struct ResolvedKey {
    classes: usize,
    states: u16,
    position: u8,
    flags: u8,
    width: u32,
    height: u32,
    inherited_color: u32,
}

impl ResolvedKey {
    fn new(
        classes: &ClassList,
        env: &ClassEnvironment,
        viewport: Size<Points>,
        rtl: bool,
        states: u16,
        position: u8,
        inherited_color: Option<Color>,
    ) -> Self {
        let deps = classes.deps();
        let has_current = deps & deps::CURRENT_COLOR != 0;
        let flags = u8::from(rtl)
            | (u8::from(deps & deps::DARK != 0 && env.dark) << 1)
            | (u8::from(deps & deps::MOTION != 0 && env.reduce_motion) << 2)
            | (u8::from(deps & deps::DEVICE != 0 && env.pointer == Pointer::Fine) << 3)
            | (u8::from(deps & deps::DEVICE != 0 && env.terminal) << 4)
            | (u8::from(has_current && inherited_color.is_some()) << 5);
        Self {
            classes: std::ptr::from_ref(classes) as usize,
            states: if deps & deps::STATE != 0 { states } else { 0 },
            position: if deps & deps::POSITION != 0 {
                position
            } else {
                0
            },
            flags,
            width: if deps & deps::WIDTH != 0 {
                viewport.width.0.to_bits()
            } else {
                0
            },
            height: if deps & deps::HEIGHT != 0 {
                viewport.height.0.to_bits()
            } else {
                0
            },
            inherited_color: if has_current {
                inherited_color.map_or(0, |c| c.0)
            } else {
                0
            },
        }
    }
}

/// Cached resolved style fields ready to apply via [`Core::apply_resolved_style`].
pub(super) struct ResolvedClassStyle {
    /// The classes resolved: kept so that [`ResolvedKey::classes`], their
    /// address, names no other list while the entry is cached.
    pub(super) classes: std::rc::Rc<ClassList>,
    pub(super) layout: std::rc::Rc<taffy::Style>,
    pub(super) view: Option<std::rc::Rc<ViewStyle>>,
    pub(super) text: Option<std::rc::Rc<TextStyle>>,
    pub(super) paint: Option<std::rc::Rc<PaintStyle>>,
    pub(super) props: Option<std::rc::Rc<ClassProps>>,
    pub(super) sticky: Option<taffy::Rect<taffy::LengthPercentageAuto>>,
    pub(super) object_fit: Option<ResizeMode>,
    pub(super) perspective: Option<Points>,
    pub(super) z_index: i32,
    pub(super) vertical_align: VerticalAlign,
    pub(super) wants_fixed: bool,
    pub(super) rtl: bool,
    pub(super) has_logical: bool,
}

/// The text color an inline style sets (`color`).
fn inline_color(patch: &StylePatch) -> Option<Color> {
    patch.decls().iter().rev().find_map(|d| match d {
        crate::style::StyleDecl::Set(crate::style::StyleKey::Color, value) => Some(match value {
            crate::style::PropertyValue::Color(c) => *c,
            _ => None,
        }),
        _ => None,
    })?
}

/// The states the platform reports ([`Core::set_states`]).
const REPORTED: u16 = state::PRESSED | state::HOVERED | state::FOCUSED;

/// The states the platform reports whatever a view tracks
/// ([`crate::input::reported_states`]): never forgotten when its tracking
/// changes.
const ALWAYS_REPORTED: u16 = state::FOCUSED;

/// The states a view is in for a moment, by the user's hand: a terminal
/// lays a view out as it rests, without them (`Node::resting_fill`).
const INTERACTION: u16 =
    state::PRESSED | state::HOVERED | state::FOCUSED | state::FOCUS_VISIBLE | state::FOCUS_WITHIN;

/// The `class` and `classList` props as set.
#[derive(Debug, Default)]
pub(super) struct ClassNames {
    class: Box<str>,
    list: Vec<Box<str>>,
}

/// A styled part of a node, besides the node itself: a state style
/// (`activeStyle`, ...) or a part of a page or list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Part {
    /// `activeStyle`.
    Active,
    /// `hoverStyle`.
    Hover,
    /// `focusStyle`.
    Focus,
    /// `disabledStyle`.
    Disabled,
    /// `selectedStyle`.
    Selected,
    /// `checkedStyle`.
    Checked,
    /// `indeterminateStyle`.
    Indeterminate,
    /// `expandedStyle`.
    Expanded,
    /// `pressedStyle`.
    Pressed,
    /// `focusWithinStyle`.
    FocusWithin,
    /// `focusVisibleStyle`.
    FocusVisible,
    /// A page's `headerStyle` / `headerClass`.
    Header,
    /// A list's `contentClass`.
    Content,
}

impl Part {
    /// The state bits and rank of a state style.
    fn state(self) -> Option<(u16, crate::tailwind::Key)> {
        Some(match self {
            Part::Active => (state::PRESSED, rank::ACTIVE),
            Part::Hover => (state::HOVERED, rank::HOVER),
            Part::Focus => (state::FOCUSED, rank::FOCUS),
            Part::Disabled => (state::DISABLED, rank::DISABLED),
            Part::Selected => (state::SELECTED, rank::SELECTED),
            Part::Checked => (state::CHECKED, rank::CHECKED),
            Part::Indeterminate => (state::INDETERMINATE, rank::INDETERMINATE),
            Part::Expanded => (state::EXPANDED, rank::EXPANDED),
            Part::Pressed => (state::ARIA_PRESSED, rank::ARIA_PRESSED),
            Part::FocusWithin => (state::FOCUS_WITHIN, rank::FOCUS_WITHIN),
            Part::FocusVisible => (state::FOCUS_VISIBLE, rank::FOCUS_VISIBLE),
            _ => return None,
        })
    }
}

/// What only some nodes have ([`super::Node`]'s `parts`).
#[derive(Debug, Default)]
pub(super) struct NodeParts {
    /// The classes as set, before the state styles are merged in.
    base: Option<std::rc::Rc<ClassList>>,
    /// The state styles, by [`Part`] (the first eleven).
    states: [Option<std::rc::Rc<StylePatch>>; 11],
    /// The state styles as rules (none without any).
    state_rules: Option<std::rc::Rc<ClassList>>,
    /// The inline styles of the other parts.
    styles: Vec<(Part, std::rc::Rc<StylePatch>)>,
    /// The classes of the other parts.
    classes: Vec<(Part, std::rc::Rc<ClassList>)>,
    /// The names a part's classes were set by (`headerClass`,
    /// `contentClass`; a typed list has none): they are parsed again when
    /// the theme or the design tokens they read change.
    class_names: Vec<(Part, Box<str>)>,
    /// The group whose press it shows as a part (`Prop::ProjectedActive`).
    active_group: Option<&'static str>,
    /// It was last styled with that group's press.
    group_pressed: bool,
}

impl NodeParts {
    /// The group whose press it shows as a part.
    pub(super) fn active_group(&self) -> Option<&'static str> {
        self.active_group
    }
}

/// The [`state`] bits an element is in by its accessibility state `s`:
/// selected, checked (true), indeterminate (checked mixed), expanded,
/// pressed (true: a toggle button that is on), busy and invalid.
pub(super) fn accessibility_states(s: &crate::AccessibilityState) -> u16 {
    use crate::Checked;
    let mut states = 0;
    if s.selected {
        states |= state::SELECTED;
    }
    match s.checked {
        Some(Checked::True) => states |= state::CHECKED,
        Some(Checked::Mixed) => states |= state::INDETERMINATE,
        _ => {}
    }
    if s.expanded == Some(true) {
        states |= state::EXPANDED;
    }
    if s.pressed == Some(Checked::True) {
        states |= state::ARIA_PRESSED;
    }
    if s.busy {
        states |= state::BUSY;
    }
    if s.invalid {
        states |= state::INVALID;
    }
    states
}

/// The state style parts, by their index in [`NodeParts::states`].
const STATE_PARTS: [Part; 11] = [
    Part::Active,
    Part::Hover,
    Part::Focus,
    Part::Disabled,
    Part::Selected,
    Part::Checked,
    Part::Indeterminate,
    Part::Expanded,
    Part::Pressed,
    Part::FocusWithin,
    Part::FocusVisible,
];

impl<M: TextEngine> Core<M> {
    /// Sets the environment class variants depend on (`dark:`, `ios:`,
    /// `motion-reduce:`): nodes whose classes depend on it are styled again.
    pub fn set_class_environment(&mut self, mut env: ClassEnvironment) {
        self.system_dark = env.dark;
        env.dark = self.shown_dark();
        self.apply_class_environment(env);
    }

    /// Dark appearance as shown: the app's, else the system's.
    pub(super) fn shown_dark(&self) -> bool {
        let system = if self.system_dark {
            ColorScheme::Dark
        } else {
            ColorScheme::Light
        };
        self.appearance.resolve(system) == ColorScheme::Dark
    }

    /// The appearance the app asks for (`nsh.json` `"appearance"`, TS
    /// `setColorScheme`, [`crate::element::set_color_scheme`]): what
    /// `dark:` variants and the components' theme follow in place of the
    /// system's; the platform applies it to its own controls
    /// ([`MountItem::Appearance`]).
    pub fn set_appearance(&mut self, appearance: Appearance) {
        if self.appearance == appearance {
            return;
        }
        self.appearance = appearance;
        self.mount.push(MountItem::Appearance { appearance });
        let dark = self.shown_dark();
        let mut env = self.class_env;
        env.dark = dark;
        self.apply_class_environment(env);
        let mut environment = self.components.environment;
        environment.dark = dark;
        self.apply_environment(environment);
    }

    fn apply_class_environment(&mut self, env: ClassEnvironment) {
        if self.class_env == env {
            return;
        }
        let changed = (if env.dark != self.class_env.dark { deps::DARK } else { 0 })
            | (if env.reduce_motion != self.class_env.reduce_motion { deps::MOTION } else { 0 })
            | (if env.pointer != self.class_env.pointer || env.terminal != self.class_env.terminal {
                deps::DEVICE
            } else {
                0
            })
            // `ios:` / `android:` never change at run time, but a new
            // platform must reach classes resolved before it was known.
            | (if env.platform != self.class_env.platform { deps::PLATFORM } else { 0 });
        if env.platform != self.class_env.platform {
            self.resolved_styles.clear();
        }
        self.class_env = env;
        if env.reduce_motion {
            self.clear_pressed_impulses();
        }
        self.restyle_where(changed);
        self.parts_restyled();
    }

    /// The platform reports interaction states of view `id` (`active:`,
    /// `hover:`, `focus:`): state bits for the states it
    /// tracks ([`MountItem::TrackStates`]), and `FOCUSED` whatever it
    /// tracks ([`crate::input::reported_states`]); see
    /// [`crate::tailwind::state`].
    pub fn set_states(&mut self, id: NodeId, states: u16) {
        let Ok(key) = self.key(id) else { return };
        if let Some(list) = self.nodes[key as usize].list.as_mut() {
            list.interaction(states);
        }
        self.set_node_states(key, states);
    }

    /// Reports the interaction states of view `id` after a short completed
    /// press, holding `state::PRESSED` for `hold` so same-turn tap-to-click
    /// releases still render `:active` feedback before settling to `states`.
    /// Any subsequent state report for `id` (including a new press or
    /// cancellation) supersedes the pending release.
    pub fn release_states_after(&mut self, id: NodeId, states: u16, hold: std::time::Duration) {
        let Ok(key) = self.key(id) else { return };
        self.pressed_impulses.retain(|&(k, _, _)| k != key);
        if self.class_env.reduce_motion
            || hold.is_zero()
            || crate::time::manual()
            || states & state::PRESSED != 0
            || self.press_cancelled(key)
        {
            self.set_node_states(key, states);
            return;
        }
        self.set_node_states(key, states | state::PRESSED);
        if self.nodes[key as usize].states & state::PRESSED != 0 {
            self.pressed_impulses
                .push((key, id, crate::time::now() + hold));
        }
    }

    /// Earliest deadline at which a short press's held `PRESSED` state ends.
    pub fn next_state_timer(&self) -> Option<crate::time::Instant> {
        self.pressed_impulses.iter().map(|&(_, _, due)| due).min()
    }

    /// Releases any short-press `PRESSED` impulses due by `now`; returns
    /// whether any state changed.
    pub fn expire_state_timers(&mut self, now: crate::time::Instant) -> bool {
        if self.pressed_impulses.iter().all(|&(_, _, due)| due > now) {
            return false;
        }
        let mut due = Vec::new();
        self.pressed_impulses.retain(|&(k, id, at)| {
            if at <= now {
                due.push((k, id));
                false
            } else {
                true
            }
        });
        let mut changed = false;
        for (key, id) in due {
            let Some(current) = self
                .nodes
                .get(key as usize)
                .filter(|n| n.id == id)
                .map(|n| n.states & REPORTED)
            else {
                continue;
            };
            if current & state::PRESSED != 0 {
                let before = self.nodes[key as usize].states;
                self.set_node_states(key, current & !state::PRESSED);
                changed |= self.nodes[key as usize].states != before;
            }
        }
        changed
    }

    fn clear_pressed_impulses(&mut self) {
        let pending = std::mem::take(&mut self.pressed_impulses);
        for (key, id, _) in pending {
            if let Some(current) = self
                .nodes
                .get(key as usize)
                .filter(|n| n.id == id)
                .map(|n| n.states & REPORTED)
                && current & state::PRESSED != 0
            {
                self.set_node_states(key, current & !state::PRESSED);
            }
        }
    }

    /// [`Self::set_states`] by key.
    fn set_node_states(&mut self, key: Key, states: u16) {
        if states & state::PRESSED != 0 || self.press_cancelled(key) {
            self.pressed_impulses.retain(|&(k, _, _)| k != key);
        }
        let id = self.nodes[key as usize].id;
        let impulse_held = self
            .pressed_impulses
            .iter()
            .any(|&(k, imp_id, _)| k == key && imp_id == id);
        let held = self.held_pressed() == Some(key) || impulse_held;
        let node = &mut self.nodes[key as usize];
        let mut new = node.states & !REPORTED | states & REPORTED;
        if held {
            new |= state::PRESSED;
        }
        if !held && self.press_cancelled(key) {
            new &= !state::PRESSED;
        }
        let node = &mut self.nodes[key as usize];
        if new == node.states {
            return;
        }
        let focus_changed = (new ^ node.states) & state::FOCUSED != 0;
        node.states = new;
        self.states_changed(key);
        if focus_changed {
            self.focus_reported(key, new & state::FOCUSED != 0);
        }
    }

    /// A span of a text heard the pointer come or go, or a press go in or
    /// out (`kind`): its hover and press states, which no view reports
    /// for it.
    pub(super) fn span_state(&mut self, id: NodeId, kind: crate::ops::EventKind) {
        use crate::ops::EventKind;
        let (bit, on) = match kind {
            EventKind::MouseEnter => (state::HOVERED, true),
            EventKind::MouseLeave => (state::HOVERED, false),
            EventKind::PressDown => (state::PRESSED, true),
            EventKind::PressUp => (state::PRESSED, false),
            _ => return,
        };
        let Ok(key) = self.key(id) else { return };
        let tracked = self.nodes[key as usize]
            .classes
            .as_ref()
            .map_or(0, |c| c.tracked_states());
        if tracked & bit == 0 || !self.is_text_span(key) {
            return;
        }
        let node = &mut self.nodes[key as usize];
        let new = if on {
            node.states | bit
        } else {
            node.states & !bit
        };
        if new != node.states {
            node.states = new;
            self.states_changed(key);
        }
    }

    /// View `key` took (or lost) the keyboard focus. A surface has one: a
    /// view taking it is the focus whether or not the one before reported
    /// losing it yet, and a view losing it that is not the focus changes
    /// nothing. The chain is worked out in the next commit round, once for
    /// all the reports before it, so a move reported as a blur then a
    /// focus leaves the views both chains share as they were; a blur no
    /// focus follows in that round waits for the next display frame
    /// (`blur_held`), so the focus arriving in a later message is still
    /// the same move. The root
    /// view taking it (macOS's first responder when no view has it) is no
    /// focus.
    fn focus_reported(&mut self, key: Key, focused: bool) {
        let id = self.nodes[key as usize].id;
        if focused {
            self.focus = (key != self.root).then_some((key, id));
            self.focus_visible = self.focus_shows(key);
            self.focus_by_keyboard = self.keyboard_moves_focus() && !self.restoring_modal_focus;
            // A popup a pointer opened gave it back (`pointer_focus_back`):
            // still the pointer's, whatever closed the popup.
            let given_back = self.pointer_focus_back.take() == Some(id);
            self.focus_by_pointer = given_back || self.modality == Some(InputModality::Pointer);
            self.blur_held = false;
        } else if self.focus == Some((key, id)) {
            self.focus = None;
            self.blur_held = true;
        } else {
            return;
        }
        self.focus_moved = true;
    }

    /// The platform reports what the user gave the surface input with
    /// last ([`InputModality`]), before the focus moves it causes: a key
    /// typed while the focus does not show makes it show, as browsers
    /// do. A pointer leaves a focus that shows as it is: only a move of
    /// the focus decides again ([`Self::focus_shows`]). A hint the focus
    /// shows is decided only as the focus moves
    /// ([`Self::keyboard_moves_focus`]): a key typed after a press shows
    /// the focus, never the hint of the view it is on.
    pub fn set_input_modality(&mut self, modality: InputModality) {
        self.restoring_modal_focus = false;
        self.modality = Some(modality);
        if modality == InputModality::Keyboard && self.focus.is_some() && !self.focus_visible {
            self.focus_visible = true;
            self.focus_visible_moved = true;
        }
    }

    /// Whether the focus coming to `key` shows (`focus-visible:`), the
    /// one rule every platform follows, after CSS's `:focus-visible`: an
    /// input that edits always shows it (it takes typing), any other view
    /// when the keyboard moved the focus ([`Self::keyboard_moves_focus`]).
    pub(super) fn focus_shows(&self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        let edits = node.kind == Kind::Input
            && node
                .input
                .as_ref()
                .is_some_and(|input| input.config.editable);
        edits || self.keyboard_moves_focus()
    }

    /// Whether the focus moving now is the keyboard's, by the surface's
    /// last input: unless that was a pointer, so the keyboard's moves
    /// count (Tab, a group's arrows, a shortcut) and so does a move the
    /// app makes (`focus()`, a calendar or a dialog moving it as it opens)
    /// after a key, while a press, a tap or a move after one do not.
    /// Before any input it counts, as a browser's `autofocus` shows its
    /// focus. `focus-visible:` ([`Self::focus_shows`]) and the hints the
    /// focus shows (`Core::focus_hints`) follow it; a hint has no
    /// exception for an input that edits, so a click into a field leaves
    /// its tooltip to the pointer.
    fn keyboard_moves_focus(&self) -> bool {
        self.modality != Some(InputModality::Pointer)
    }

    /// Puts `FOCUS_VISIBLE` on the focus while it shows and takes it off
    /// the view that had it: one view changes, the rest are not touched.
    pub(super) fn update_focus_visible(&mut self) {
        let alive = |this: &Self, (k, id): (Key, NodeId)| {
            this.nodes.get(k as usize).is_some_and(|n| n.id == id)
        };
        let target = self.focus.filter(|&f| self.focus_visible && alive(self, f));
        if target == self.focus_visible_on {
            return;
        }
        let flipped = target.is_some() != self.focus_visible_on.is_some();
        if let Some(old) = self.focus_visible_on.take()
            && alive(self, old)
        {
            let node = &mut self.nodes[old.0 as usize];
            if node.states & state::FOCUS_VISIBLE != 0 {
                node.states &= !state::FOCUS_VISIBLE;
                self.states_changed(old.0);
            }
        }
        if let Some((k, _)) = target {
            let node = &mut self.nodes[k as usize];
            if node.states & state::FOCUS_VISIBLE == 0 {
                node.states |= state::FOCUS_VISIBLE;
                self.states_changed(k);
            }
        }
        self.focus_visible_on = target;
        if flipped {
            self.restyle_projected_focus();
        }
    }

    /// The states `key` is styled by: its own, those it shows as a part
    /// of a control and a hover a component passes on to it, with
    /// `FOCUS_VISIBLE` on a part projected focused while the focus shows.
    /// Virtual focus is projected while its control has the focus, so on
    /// its rows `focus:` is the cursor and `focus-visible:` the cursor the
    /// keyboard is on.
    pub(super) fn styled_states(&self, key: Key) -> u16 {
        let node = &self.nodes[key as usize];
        let passed = if node.passed_hover { state::HOVERED } else { 0 };
        let mut states = node.states | node.projected | passed;
        if let Some(group) = node.parts.as_ref().and_then(|p| p.active_group) {
            states |= self.group_states(key, group) & state::PRESSED;
        }
        if node.projected & state::FOCUSED != 0 && self.focus_visible_on.is_some() {
            states | state::FOCUS_VISIBLE
        } else {
            states
        }
    }

    /// Restyles the parts projected focused: the focus started or stopped
    /// showing. Those released since are dropped.
    fn restyle_projected_focus(&mut self) {
        let mut parts = std::mem::take(&mut self.projected_focus);
        parts.retain(|&(k, id)| {
            self.nodes
                .get(k as usize)
                .is_some_and(|n| n.id == id && n.projected & state::FOCUSED != 0)
        });
        for &(k, _) in &parts {
            self.states_changed(k);
        }
        self.projected_focus = parts;
    }

    /// Puts `focus-within` on the focus and the views around it, and takes
    /// it off the views it left (those first, then the new ones): the old
    /// chain and the new one are walked, nothing else, and the views on
    /// both are not touched. The views around are the parents in the core's tree,
    /// where an overlay is its parent's child (whatever root view shows
    /// it), so the focus in a popup is within the view the popup's overlay
    /// is in, as in a React portal.
    pub(super) fn update_focus_within(&mut self) {
        self.focus_moved = false;
        self.blur_held = false;
        let focus = self
            .focus
            .filter(|&(k, id)| self.nodes.get(k as usize).is_some_and(|n| n.id == id));
        if focus.is_none() {
            self.focus = None;
        }
        let mut chain = std::mem::take(&mut self.focus_scratch);
        chain.clear();
        if let Some((mut k, _)) = focus {
            while k != NO_KEY {
                let node = &self.nodes[k as usize];
                chain.push((k, node.id));
                k = node.parent;
            }
        }
        if chain == self.focus_chain {
            self.focus_scratch = chain;
            return;
        }
        let old = std::mem::replace(&mut self.focus_chain, chain);
        for &(k, id) in &old {
            if self.focus_chain.contains(&(k, id)) {
                continue;
            }
            // A view released since (its key perhaps another's now).
            let Some(node) = self.nodes.get_mut(k as usize).filter(|n| n.id == id) else {
                continue;
            };
            if node.states & state::FOCUS_WITHIN != 0 {
                node.states &= !state::FOCUS_WITHIN;
                let hears = node.events.contains(EventKind::FocusOut);
                self.states_changed(k);
                if hears {
                    self.events
                        .push(JsEvent::Event(id, EventKind::FocusOut, EventPayload::None));
                }
            }
        }
        for i in 0..self.focus_chain.len() {
            let k = self.focus_chain[i].0;
            let node = &mut self.nodes[k as usize];
            if node.states & state::FOCUS_WITHIN == 0 {
                node.states |= state::FOCUS_WITHIN;
                let (id, hears) = (node.id, node.events.contains(EventKind::FocusIn));
                self.states_changed(k);
                if hears {
                    self.events
                        .push(JsEvent::Event(id, EventKind::FocusIn, EventPayload::None));
                }
            }
        }
        self.focus_scratch = old;
        self.focus_within_changed = true;
    }

    /// Whether the keyboard focus is on view `id` or a view inside it
    /// (`focus-within`; an overlay is inside the view the app put it in).
    pub(super) fn has_focus_within(&self, id: NodeId) -> bool {
        self.key(id)
            .is_ok_and(|k| self.nodes[k as usize].states & state::FOCUS_WITHIN != 0)
    }

    /// The node whose pressed state the touch responder holds.
    fn held_pressed(&self) -> Option<Key> {
        self.components
            .touch
            .pressed
            .and_then(|id| self.key(id).ok())
    }

    /// Holds the `active:` (and `group-active:`) state on the components'
    /// touch responder `id` until its touches end (`None`): a drag that
    /// leaves its view, which the platform stops reporting as pressed,
    /// keeps it pressed, as CSS's `:active` holds until the button is
    /// released. The one held before is released.
    pub(super) fn hold_pressed(&mut self, id: Option<NodeId>) {
        let before = self.held_pressed();
        self.components.touch.pressed = id;
        if let Some(key) = before {
            let prev_id = self.nodes[key as usize].id;
            let impulse_held = self
                .pressed_impulses
                .iter()
                .any(|&(k, imp_id, _)| k == key && imp_id == prev_id);
            if !impulse_held {
                let node = &mut self.nodes[key as usize];
                if node.states & state::PRESSED != 0 {
                    node.states &= !state::PRESSED;
                    self.states_changed(key);
                }
            }
        }
        if let Some(key) = self.held_pressed() {
            let node = &mut self.nodes[key as usize];
            if node.states & state::PRESSED == 0 {
                node.states |= state::PRESSED;
                self.states_changed(key);
            }
        }
    }

    /// `disabled` on a host element: the `disabled:` variant.
    pub(super) fn set_disabled(&mut self, key: Key, disabled: bool) {
        let node = &mut self.nodes[key as usize];
        let before = node.states;
        if disabled {
            node.states |= state::DISABLED;
        } else {
            node.states &= !state::DISABLED;
        }
        if node.states != before {
            if disabling_changes(node.events) {
                self.mark(key, dirty::EVENTS);
            }
            // Its accessibility state says it.
            self.mark(key, dirty::VIEW_PROPS);
            self.states_changed(key);
        }
    }

    /// Restyles `key` if its classes read its states, and the nodes inside
    /// it that read its group states.
    pub(super) fn states_changed(&mut self, key: Key) {
        let Some(classes) = self.nodes[key as usize].classes.clone() else {
            return;
        };
        if classes.deps() & deps::STATE != 0 {
            self.restyle(key);
        }
        if !classes.groups().is_empty() {
            self.restyle_subtree(key, deps::GROUP);
        }
    }

    /// The states `key`'s accessibility state puts it in
    /// ([`accessibility_states`]): the `selected:`, `checked:`,
    /// `indeterminate:` and `aria-*:` variants.
    pub(super) fn set_accessibility_states(&mut self, key: Key, states: u16) {
        let node = &mut self.nodes[key as usize];
        let now = (node.states & !state::ACCESSIBILITY) | states;
        if node.states != now {
            node.states = now;
            self.states_changed(key);
        }
    }

    /// The states `key` shows as a part of a control: its classes and
    /// state styles read them, its events and accessibility do not.
    pub(super) fn set_projected_states(&mut self, key: Key, states: u16) {
        let node = &mut self.nodes[key as usize];
        if node.projected != states {
            let focus_changed = (node.projected ^ states) & state::FOCUSED != 0;
            node.projected = states;
            let id = node.id;
            if self.mount_projected && node.created {
                self.mount.push(MountItem::ProjectStates { id, states });
            }
            if focus_changed {
                // The key's entry before, and those released since, go.
                let nodes = &self.nodes;
                self.projected_focus
                    .retain(|&(k, i)| k != key && nodes.get(k as usize).is_some_and(|n| n.id == i));
                if states & state::FOCUSED != 0 {
                    self.projected_focus.push((key, id));
                }
            }
            self.states_changed(key);
        }
    }

    /// The group whose press `key` shows as a part of a control
    /// (`Prop::ProjectedActive`).
    pub(super) fn set_projected_active(&mut self, key: Key, group: Option<&'static str>) {
        let node = &mut self.nodes[key as usize];
        if node.parts.as_ref().and_then(|p| p.active_group) == group {
            return;
        }
        let base = node.classes.clone();
        let parts = node.parts.get_or_insert_with(|| {
            Box::new(NodeParts {
                base,
                ..NodeParts::default()
            })
        });
        parts.active_group = group;
        parts.group_pressed = false;
        self.states_changed(key);
    }

    /// A group around part `key` that shows its press changed its states:
    /// restyled when the press it shows came or went.
    fn group_press_changed(&mut self, key: Key) {
        let Some(group) = self.nodes[key as usize]
            .parts
            .as_ref()
            .and_then(|p| p.active_group)
        else {
            return;
        };
        let pressed = self.group_states(key, group) & state::PRESSED != 0;
        let node = &mut self.nodes[key as usize];
        let parts = node.parts.as_mut().expect("a part with its group");
        if parts.group_pressed == pressed {
            return;
        }
        parts.group_pressed = pressed;
        if !node
            .classes
            .as_ref()
            .is_some_and(|c| c.deps() & deps::STATE != 0)
        {
            return;
        }
        self.restyle(key);
    }

    /// The `data-*` attributes `key` shows as a part of a component
    /// (`Prop::ProjectedData`): its `data-*:` classes read them, and the
    /// `group-data-*:` classes inside it when it is a group. A node whose
    /// classes read none sends nothing.
    pub(super) fn set_projected_data(&mut self, key: Key, data: Box<[&'static str]>) {
        let node = &mut self.nodes[key as usize];
        if node.data == data {
            return;
        }
        node.data = data;
        let Some(classes) = node.classes.clone() else {
            return;
        };
        if classes.deps() & deps::DATA != 0 {
            self.restyle(key);
        }
        if !classes.groups().is_empty() {
            self.restyle_subtree(key, deps::GROUP);
        }
    }

    /// The steps of its parent's perspective that `key`'s transform starts
    /// with as mounted ([`Self::mounted_view_style`]): 5, or 0 without one.
    /// Only a view that turns out of its plane (`rotateX`, `rotateY`) shows
    /// a perspective; a flat one stays as it is.
    pub(super) fn perspective_steps(&self, key: Key) -> u8 {
        let node = &self.nodes[key as usize];
        let has = node.parent != NO_KEY
            && !node.inline
            && self.nodes[node.parent as usize].child_perspective.is_some()
            && node.view_style.transform.ops().iter().any(|op| {
                matches!(
                    op.kind,
                    crate::transform::TransformKind::RotateX
                        | crate::transform::TransformKind::RotateY
                )
            });
        if has { 5 } else { 0 }
    }

    /// The view style of `key` as platforms take it: fractional
    /// translations resolved, hidden layout excluded, and parent perspective composed in.
    pub(super) fn mounted_view_style(&self, key: Key) -> Box<ViewStyle> {
        let node = &self.nodes[key as usize];
        let mut style = node.mounted_view_style();
        if let Some(layout) = node.layout {
            style.hidden |= self.layout.displays_none(layout);
        }
        let parent = node.parent;
        if parent == NO_KEY || node.inline {
            return style;
        }
        let parent = &self.nodes[parent as usize];
        let Some(distance) = parent
            .child_perspective
            .filter(|_| self.perspective_steps(key) > 0)
        else {
            return style;
        };
        // CSS: the parent's perspective, around its center, applies to the
        // child's plane: `translate(-d) perspective() translate(d)` before
        // its own transform, `d` its origin's distance from that center.
        let size = |s: Size<Points>| if s.width.is_nan() { Size::default() } else { s };
        let (own, parent_size) = (size(node.frame.size), size(parent.frame.size));
        let origin = if node.frame.size.width.is_nan() {
            crate::geometry::Point::default()
        } else {
            node.frame.origin
        };
        let (offset, _) = style.transform_origin.offset(own);
        let dx = origin.x.0 + own.width.0 / 2.0 + offset.x.0 - parent_size.width.0 / 2.0;
        let dy = origin.y.0 + own.height.0 / 2.0 + offset.y.0 - parent_size.height.0 / 2.0;
        use crate::transform::{Transform, TransformKind as T};
        let mut composed = Transform::IDENTITY;
        for (kind, value) in [
            (T::TranslateX, -dx),
            (T::TranslateY, -dy),
            (T::Perspective, distance.0),
            (T::TranslateX, dx),
            (T::TranslateY, dy),
        ] {
            let _ = composed.push(kind, value);
        }
        for op in style.transform.ops() {
            let _ = composed.push(op.kind, op.value);
        }
        style.transform = composed;
        style
    }

    /// Sets the inline style of `key`'s `part` (`None`: removes it).
    pub(super) fn set_part_style(
        &mut self,
        key: Key,
        part: Part,
        patch: Option<std::rc::Rc<StylePatch>>,
    ) {
        let node = &mut self.nodes[key as usize];
        let base = node.classes.clone();
        let parts = node.parts.get_or_insert_with(|| {
            Box::new(NodeParts {
                base,
                ..NodeParts::default()
            })
        });
        let patch = patch.filter(|p| !p.is_empty());
        match part.state() {
            Some(_) => {
                let slot = &mut parts.states[part as usize];
                if *slot == patch {
                    return;
                }
                *slot = patch;
                let rules: Vec<Rule> = parts
                    .states
                    .iter()
                    .enumerate()
                    .filter_map(|(i, p)| {
                        let p = p.as_ref()?;
                        let (states, rank) = STATE_PARTS[i].state()?;
                        Some(Rule::state_style(states, rank, p.decls().to_vec()))
                    })
                    .collect();
                parts.state_rules = (!rules.is_empty())
                    .then(|| std::rc::Rc::new(ClassList::from_rules(rules, Vec::new())));
                let base = parts.base.clone();
                self.set_class_list(key, base);
            }
            None => {
                let at = parts.styles.iter().position(|(p, _)| *p == part);
                match (at, patch) {
                    (Some(i), Some(p)) => parts.styles[i].1 = p,
                    (Some(i), None) => {
                        parts.styles.remove(i);
                    }
                    (None, Some(p)) => parts.styles.push((part, p)),
                    (None, None) => return,
                }
                self.part_changed(key, part);
            }
        }
    }

    /// Sets the classes of `key`'s `part` (a page's header, a list's
    /// content).
    pub(super) fn set_part_class(&mut self, key: Key, part: Part, names: &str) {
        let classes = (!names.trim().is_empty()).then(|| self.tailwind.classes(names));
        let named = classes.is_some();
        self.set_part_class_list(key, part, classes);
        if named && let Some(parts) = self.nodes[key as usize].parts.as_deref_mut() {
            parts.class_names.push((part, names.into()));
        }
    }

    /// Parses again the parts' classes set by name whose rules `reads`
    /// (the theme was replaced, or design tokens they name changed).
    fn part_classes_again(&mut self, reads: impl Fn(&ClassList) -> bool) {
        let named: Vec<(Key, Part, Box<str>)> = self
            .nodes
            .iter()
            .filter_map(|(k, n)| Some((k as Key, n.parts.as_deref()?)))
            .flat_map(|(k, p)| {
                let reads = &reads;
                p.class_names
                    .iter()
                    .filter(move |(part, _)| {
                        p.classes.iter().any(|(of, list)| of == part && reads(list))
                    })
                    .map(move |(part, names)| (k, *part, names.clone()))
            })
            .collect();
        for (key, part, names) in named {
            self.set_part_class(key, part, &names);
        }
    }

    /// Sets `part`'s classes of `key` to `classes`, already parsed (typed
    /// styles lowered); none clears them.
    pub(super) fn set_part_class_list(
        &mut self,
        key: Key,
        part: Part,
        classes: Option<std::rc::Rc<ClassList>>,
    ) {
        let node = &mut self.nodes[key as usize];
        let base = node.classes.clone();
        let parts = node.parts.get_or_insert_with(|| {
            Box::new(NodeParts {
                base,
                ..NodeParts::default()
            })
        });
        parts.class_names.retain(|(p, _)| *p != part);
        let at = parts.classes.iter().position(|(p, _)| *p == part);
        match (at, classes) {
            (Some(i), Some(c)) => parts.classes[i].1 = c,
            (Some(i), None) => {
                parts.classes.remove(i);
            }
            (None, Some(c)) => parts.classes.push((part, c)),
            (None, None) => return,
        }
        self.part_changed(key, part);
    }

    /// `part` of `key` changed: what shows it is sent again.
    fn part_changed(&mut self, key: Key, part: Part) {
        match part {
            Part::Header => {
                if self.nodes[key as usize].kind == Kind::Screen {
                    self.mark(key, dirty::SCREEN);
                }
            }
            Part::Content => {
                let content = self.list_content(key);
                if let Some(list) = self.nodes[key as usize].list.as_mut()
                    && list.set_class_content(content)
                {
                    self.needs_layout = true;
                }
            }
            _ => {}
        }
    }

    /// The padding, gaps and cell alignment a list's `contentClass` sets.
    fn list_content(&self, key: Key) -> crate::ListContentStyle {
        let Some(style) = self.part_resolved(key, Part::Content) else {
            return crate::ListContentStyle::default();
        };
        let px = |l: taffy::LengthPercentage| match l.expand() {
            taffy::style::ExpandedLengthPercentage::Length(v) => crate::geometry::Points(v),
            _ => crate::geometry::Points::ZERO,
        };
        let p = &style.layout.padding;
        let align = style.layout.align_items;
        let align_items = (align == taffy::AlignItems::STRETCH
            || align == taffy::AlignItems::FLEX_START
            || align == taffy::AlignItems::CENTER
            || align == taffy::AlignItems::FLEX_END)
            .then_some(align);
        crate::ListContentStyle {
            padding: crate::EdgeInsets {
                top: px(p.top),
                right: px(p.right),
                bottom: px(p.bottom),
                left: px(p.left),
            },
            row_gap: px(style.layout.gap.height),
            column_gap: px(style.layout.gap.width),
            align_items,
        }
    }

    /// The style of `key`'s `part`: its classes, then its inline style, as
    /// they resolve now; `None` when the part has neither.
    pub(super) fn part_resolved(&self, key: Key, part: Part) -> Option<Style> {
        let node = &self.nodes[key as usize];
        let parts = node.parts.as_deref()?;
        let classes = parts.classes.iter().find(|(p, _)| *p == part).map(|c| &c.1);
        let inline = parts.styles.iter().find(|(p, _)| *p == part).map(|s| &s.1);
        if classes.is_none() && inline.is_none() {
            return None;
        }
        let mut style = Style::default();
        let current = inline.and_then(|i| inline_color(i)).unwrap_or(Color::BLACK);
        if let Some(i) = inline {
            i.apply_defaults(&mut style, current);
        }
        let apply = |s: &mut Style| {
            if let Some(i) = inline {
                i.apply(s);
                s.apply_current_color(current);
            }
        };
        match classes {
            Some(classes) => {
                let group = |_: &str| 0;
                let cx = Context {
                    env: self.class_env,
                    window: self.viewport,
                    rtl: node.rtl,
                    states: 0,
                    position: 0,
                    group: &group,
                };
                let mut props = ClassProps::default();
                classes.apply(&cx, self.tailwind.theme(), &mut style, &mut props, apply);
            }
            None => apply(&mut style),
        }
        Some(style)
    }

    /// The parts whose classes resolve again when the environment changes
    /// (a header's `dark:` colors).
    fn parts_restyled(&mut self) {
        let keys: Vec<(Key, Part)> = self
            .nodes
            .iter()
            .filter_map(|(k, n)| Some((k as Key, n.parts.as_deref()?)))
            .flat_map(|(k, p)| p.classes.iter().map(move |(part, _)| (k, *part)))
            .collect();
        for (key, part) in keys {
            self.part_changed(key, part);
        }
    }

    /// Sets `class` (`list == false`) or `classList` of `key`.
    pub(super) fn set_classes(
        &mut self,
        key: Key,
        names: Option<Box<str>>,
        list: Option<Vec<Box<str>>>,
    ) {
        let node = &mut self.nodes[key as usize];
        let current = node.class_names.get_or_insert_default();
        if let Some(n) = names {
            current.class = n;
        }
        if let Some(l) = list {
            current.list = l;
        }
        let (classes, fresh) = if current.list.is_empty() {
            if current.class.trim().is_empty() {
                (None, false)
            } else {
                let (classes, fresh) = self.tailwind.get(&current.class);
                (Some(classes), fresh)
            }
        } else {
            let mut combined = String::with_capacity(current.class.len() + 16 * current.list.len());
            combined.push_str(&current.class);
            for name in &current.list {
                combined.push(' ');
                combined.push_str(name);
            }
            if combined.trim().is_empty() {
                (None, false)
            } else {
                let (classes, fresh) = self.tailwind.get(&combined);
                (Some(classes), fresh)
            }
        };
        if fresh
            && let Some(c) = &classes
            && !c.unknown().is_empty()
        {
            log::warn!(
                "unknown classes: {}",
                c.unknown()
                    .iter()
                    .map(|s| &**s)
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }
        self.set_class_list(key, classes);
    }

    /// Sets the resolved classes of `key` (a Rust component's styles go
    /// straight here).
    pub(super) fn set_class_list(&mut self, key: Key, classes: Option<std::rc::Rc<ClassList>>) {
        let state_rules = self.nodes[key as usize]
            .parts
            .as_deref_mut()
            .and_then(|parts| {
                parts.base = classes.clone();
                parts.state_rules.clone()
            });
        // The state styles go over the classes.
        let classes = if let Some(state_rules) = state_rules {
            self.merge_user(classes, Some(state_rules))
        } else {
            classes
        };
        let node = &mut self.nodes[key as usize];
        let unchanged = match (&node.classes, &classes) {
            (None, None) => true,
            (Some(a), Some(b)) => std::rc::Rc::ptr_eq(a, b),
            _ => false,
        };
        if unchanged {
            return;
        }
        let had_groups = node
            .classes
            .as_ref()
            .is_some_and(|c| !c.groups().is_empty());
        node.classes = classes;
        let has_groups = node
            .classes
            .as_ref()
            .is_some_and(|c| !c.groups().is_empty());
        self.update_tracking(key);
        self.restyle(key);
        if had_groups || has_groups {
            self.restyle_subtree(key, deps::GROUP);
        }
    }

    /// How long the transitions of view `id` run, its delay included, with
    /// its styles now (a component waiting for its exit,
    /// [`crate::element::ElementRef::transition_time`]); zero for a view
    /// with none, or gone.
    pub(super) fn transition_time(&self, id: NodeId) -> std::time::Duration {
        let Ok(key) = self.key(id) else {
            return std::time::Duration::ZERO;
        };
        self.nodes[key as usize]
            .view_style
            .transition
            .filter(|t| t.properties.0 != 0)
            .map_or(std::time::Duration::ZERO, |t| {
                std::time::Duration::from_secs_f32((t.run_ms() + t.delay.max(0.0)) / 1000.0)
            })
    }

    /// Replaces the theme: every class is resolved again.
    pub(super) fn set_tailwind_theme(&mut self, json: &str) {
        // A newer NSH's theme: what this one cannot read is left out, the
        // rest applies.
        let theme = match Theme::from_json_lenient(json) {
            Ok((theme, ignored)) => {
                for what in ignored {
                    log::warn!("tailwind theme: {what}, ignored");
                }
                theme
            }
            Err(e) => {
                log::warn!("tailwind theme: {e}");
                return;
            }
        };
        self.tailwind.set_theme(theme);
        self.resolved_styles.clear();
        self.components.merges.clear();
        let keys: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.class_names.is_some())
            .map(|(k, _)| k as Key)
            .collect();
        for key in keys {
            self.set_classes(key, None, None);
        }
        self.part_classes_again(|_| true);
    }

    /// The design tokens changed: classes naming them
    /// (`bg-primary`) are resolved again, on nodes, on their parts (a
    /// page's header, a list's content) and on Rust components.
    pub(super) fn class_tokens_changed(&mut self) {
        let tokens = self.components.tokens.clone();
        let Some(changed) = self.tailwind.set_tokens(&tokens) else {
            return;
        };
        if changed == u16::MAX {
            self.resolved_styles.clear();
            self.components.merges.clear();
        } else {
            self.resolved_styles
                .retain(|_, entry| entry.classes.deps() & changed == 0);
            self.components
                .merges
                .retain(|_, [a, b, merged]| (a.deps() | b.deps() | merged.deps()) & changed == 0);
        }
        let reads = |c: &Option<std::rc::Rc<ClassList>>| {
            c.as_ref().is_some_and(|c| c.deps() & changed != 0)
        };
        let keys: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.class_names.is_some() && (changed == u16::MAX || reads(&n.classes)))
            .map(|(k, _)| k as Key)
            .collect();
        for key in keys {
            self.set_classes(key, None, None);
        }
        self.part_classes_again(|c| changed == u16::MAX || c.deps() & changed != 0);
        let hosts: Vec<NodeId> = self
            .components
            .instances
            .iter()
            .filter(|(_, inst)| {
                (!inst.class.is_empty() || !inst.class_list.is_empty())
                    && (changed == u16::MAX || reads(&inst.user))
            })
            .map(|(host, _)| *host)
            .collect();
        for host in hosts {
            self.update_user_class(host);
        }
        // The app's classes on the views' elements (`app_class`).
        let nodes: Vec<_> = self
            .components
            .app_classes
            .iter()
            .map(|(&id, entry)| (id, entry.clone()))
            .collect();
        for (id, (own, class, outer)) in nodes {
            let app = self.app_class_list(&class);
            let user = self.merge_user(Some(app), outer);
            let list = self.merge_user(own, user);
            if let Ok(key) = self.key(id) {
                self.set_class_list(key, list);
            }
        }
    }

    /// Tells the platform which states of `key` to report.
    pub(super) fn update_tracking(&mut self, key: Key) {
        let node = &mut self.nodes[key as usize];
        // `focus-within` is the core's own (`update_focus_within`): the
        // platform reports only the states of the view itself. An automatic
        // list still takes the platform's own `focus-within`, which holds
        // while the focus moves between its rows.
        let tracked = node
            .classes
            .as_ref()
            .map_or(0, |c| c.tracked_states() & REPORTED)
            | if node.list.as_ref().is_some_and(|list| list.automatic) {
                state::HOVERED | state::FOCUS_WITHIN
            } else {
                0
            };
        if tracked != node.tracked {
            node.tracked = tracked;
            // The platform stops reporting the states it no longer tracks,
            // and keeps the rest as they are: forget them here too, or a
            // state set before (a hover, a press) would outlive the pointer
            // and come back when the classes read it again. The focus it
            // reports always, so it stays.
            let kept = tracked | ALWAYS_REPORTED;
            let stale = node.states & REPORTED & !kept;
            let states = node.states & REPORTED & kept;
            if node.created {
                let id = node.id;
                self.mount.push(MountItem::TrackStates {
                    id,
                    states: tracked,
                });
            }
            if stale != 0 {
                if stale & state::PRESSED != 0 {
                    self.pressed_impulses.retain(|&(k, _, _)| k != key);
                }
                self.set_node_states(key, states);
            }
        }
    }

    /// The tracking item of a view that was just created.
    pub(super) fn creation_tracking(&self, key: Key) -> Option<MountItem> {
        let node = &self.nodes[key as usize];
        (node.tracked != 0).then(|| MountItem::TrackStates {
            id: node.id,
            states: node.tracked,
        })
    }

    /// Restyles the nodes whose classes depend on any of `changed`.
    pub(super) fn restyle_where(&mut self, changed: u16) {
        if changed == 0 {
            return;
        }
        let keys: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.classes.as_ref().is_some_and(|c| c.deps() & changed != 0))
            .map(|(k, _)| k as Key)
            .collect();
        for key in keys {
            self.restyle(key);
        }
    }

    /// Restyles the nodes inside `key` whose classes depend on `changed`.
    fn restyle_subtree(&mut self, key: Key, changed: u16) {
        let mut stack: Vec<Key> = self.nodes[key as usize].children.clone();
        while let Some(k) = stack.pop() {
            let node = &self.nodes[k as usize];
            stack.extend_from_slice(&node.children);
            let follows = changed & deps::GROUP != 0
                && node
                    .parts
                    .as_ref()
                    .is_some_and(|p| p.active_group.is_some());
            if node
                .classes
                .as_ref()
                .is_some_and(|c| c.deps() & changed != 0)
            {
                self.restyle(k);
            }
            if follows {
                self.group_press_changed(k);
            }
        }
    }

    /// `key` joined `parent`, or left it (`parent` is where it was): the
    /// `group-*:` classes in it were resolved with the groups it had, which
    /// only matters while one of them, or of the new ones, is in a state (a
    /// disabled row, a pressed card). A leaf that reads no group skips the
    /// walk.
    pub(super) fn groups_changed(&mut self, key: Key, parent: Key) {
        let node = &self.nodes[key as usize];
        let reads = node
            .classes
            .as_ref()
            .is_some_and(|c| c.deps() & deps::GROUP != 0);
        if !reads && node.children.is_empty() {
            return;
        }
        let mut k = parent;
        loop {
            if k == NO_KEY {
                return;
            }
            let n = &self.nodes[k as usize];
            if (n.states | n.projected != 0 || n.passed_hover || !n.data.is_empty())
                && n.classes.as_ref().is_some_and(|c| !c.groups().is_empty())
            {
                break;
            }
            k = n.parent;
        }
        if reads {
            self.restyle(key);
        }
        self.restyle_subtree(key, deps::GROUP);
    }

    /// `parent`'s children moved (one joined or left): their positions are
    /// looked at before the next flush, once ([`Core::flush_positions`]).
    pub(super) fn queue_positions(&mut self, parent: Key) {
        let node = &mut self.nodes[parent as usize];
        if !node.positional.has(Positional::QUEUED) {
            node.positional |= Positional::QUEUED;
            self.position_parents.push(parent);
        }
    }

    /// Restyles the children whose position moved, of each parent queued
    /// since ([`Core::queue_positions`]).
    pub(super) fn flush_positions(&mut self) {
        if self.position_parents.is_empty() {
            return;
        }
        let mut parents = std::mem::take(&mut self.position_parents);
        for &parent in &parents {
            // A released key is vacant, or another node's: that one is
            // looked at only if it was queued itself.
            let Some(node) = self.nodes.get_mut(parent as usize) else {
                continue;
            };
            if node.positional.has(Positional::QUEUED) {
                node.positional.remove(Positional::QUEUED);
                self.positions_changed(parent);
            }
        }
        parents.clear();
        if self.position_parents.is_empty() {
            self.position_parents = parents;
        }
    }

    /// `n` more siblings looked at for positions
    /// ([`super::components::Components::position_work`]).
    #[cfg(test)]
    fn positioning(&self, n: usize) {
        let work = &self.components.position_work;
        work.set(work.get() + n);
    }

    #[cfg(not(test))]
    #[inline(always)]
    fn positioning(&self, _n: usize) {}

    /// Restyles the children of `parent` that depend on their position.
    pub(super) fn positions_changed(&mut self, parent: Key) {
        if self.passes_position(parent) {
            // Its children take its own position, which theirs among
            // them do not change.
            let bits = self.known_position(parent);
            self.pass_to_children(parent, bits);
            return;
        }
        let children = self.nodes[parent as usize].children.clone();
        self.positioning(children.len());
        let count = children
            .iter()
            .filter(|&&c| self.is_element_child(c))
            .count();
        let mut next = 0;
        for c in children {
            let index = if self.is_element_child(c) {
                let index = next;
                next += 1;
                index
            } else {
                // Keep position_bits' fallback for a child that does not count.
                0
            };
            self.position_moved(c, Self::position_at(index, count));
        }
    }

    /// Restyles `key`, now at position `bits`, if its classes read its
    /// position and it moved; a view passing its position on passes it.
    fn position_moved(&mut self, key: Key, bits: u8) {
        let node = &self.nodes[key as usize];
        // Only the children whose bits moved: an append restyles the old
        // last row and the new one, not every sibling.
        if node.position_used == bits {
            return;
        }
        if node.positional.has(Positional::PASS) {
            self.nodes[key as usize].position_used = bits;
            if self.nodes[key as usize]
                .positional
                .has(Positional::CHILDREN)
            {
                self.pass_to_children(key, bits);
            }
        }
        if self.nodes[key as usize]
            .classes
            .as_ref()
            .is_some_and(|c| c.deps() & deps::POSITION != 0)
        {
            self.restyle_at(key, Some(bits));
        }
    }

    /// Gives `key`'s element children the position `bits`, its own.
    fn pass_to_children(&mut self, key: Key, bits: u8) {
        let children = self.nodes[key as usize].children.clone();
        self.positioning(children.len());
        for c in children {
            if self.is_element_child(c) {
                self.position_moved(c, bits);
            }
        }
    }

    /// Whether `key`'s children take its position ([`Prop::PassPosition`]).
    ///
    /// [`Prop::PassPosition`]: crate::ops::Prop::PassPosition
    fn passes_position(&self, key: Key) -> bool {
        self.nodes[key as usize].positional.has(Positional::PASS)
    }

    /// A child of `parent` reads its position: `parent` looks at its
    /// children's when they move, and so does each view whose position
    /// it passes on.
    pub(super) fn reads_positions(&mut self, parent: Key) {
        let mut k = parent;
        while k != NO_KEY {
            let node = &mut self.nodes[k as usize];
            node.positional |= Positional::CHILDREN;
            if !node.positional.has(Positional::PASS) {
                break;
            }
            k = node.parent;
        }
    }

    /// Sets whether `key`'s children take its position among its
    /// siblings ([`Prop::PassPosition`]); those that read theirs are
    /// styled again.
    ///
    /// [`Prop::PassPosition`]: crate::ops::Prop::PassPosition
    pub(super) fn set_pass_position(&mut self, key: Key, pass: bool) {
        if self.passes_position(key) == pass {
            return;
        }
        let node = &mut self.nodes[key as usize];
        if pass {
            node.positional |= Positional::PASS;
        } else {
            node.positional.remove(Positional::PASS);
        }
        // Not yet known: counted again when asked for (`known_position`).
        node.position_used = 0;
        if node.positional.has(Positional::CHILDREN) {
            let parent = node.parent;
            if pass && parent != NO_KEY {
                self.reads_positions(parent);
            }
            self.queue_positions(key);
        }
    }

    /// Whether `key`'s classes depend on the layout direction.
    pub(super) fn reads_direction(&self, key: Key) -> bool {
        self.nodes[key as usize]
            .classes
            .as_ref()
            .is_some_and(|c| c.deps() & deps::RTL != 0)
    }

    /// [`position`] bits of `key`: those it was last styled at while its
    /// parent's children did not move since, so that restyling a row (its
    /// hover, its press) does not count its siblings; otherwise counted
    /// ([`Core::position_bits`]).
    fn known_position(&self, key: Key) -> u8 {
        let node = &self.nodes[key as usize];
        let parent = node.parent;
        if node.position_used != 0
            && parent != NO_KEY
            && !self.nodes[parent as usize]
                .positional
                .has(Positional::QUEUED)
        {
            return node.position_used;
        }
        self.position_bits(key)
    }

    /// [`position`] bits of `key` among its parent's element children, or
    /// its parent's own when the parent passes its position on.
    fn position_bits(&self, key: Key) -> u8 {
        let parent = self.nodes[key as usize].parent;
        if parent == NO_KEY {
            return position::FIRST | position::LAST | position::ONLY | position::ODD;
        }
        if self.passes_position(parent) {
            return self.known_position(parent);
        }
        self.positioning(self.nodes[parent as usize].children.len());
        let siblings: Vec<Key> = self.nodes[parent as usize]
            .children
            .iter()
            .copied()
            .filter(|&c| self.is_element_child(c))
            .collect();
        let i = siblings.iter().position(|&c| c == key).unwrap_or(0);
        Self::position_at(i, siblings.len())
    }

    fn position_at(i: usize, n: usize) -> u8 {
        let mut bits = if i.is_multiple_of(2) {
            position::ODD
        } else {
            position::EVEN
        };
        if i == 0 {
            bits |= position::FIRST;
        }
        if i + 1 == n {
            bits |= position::LAST;
        }
        if n == 1 {
            bits |= position::ONLY;
        }
        bits
    }

    /// The states of the nearest ancestor of `key` that is group `name`.
    fn group_states(&self, key: Key, name: &str) -> u16 {
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            let node = &self.nodes[k as usize];
            if node
                .classes
                .as_ref()
                .is_some_and(|c| c.groups().iter().any(|g| **g == *name))
            {
                return self.styled_states(k);
            }
            k = node.parent;
        }
        0
    }

    /// The `data-*` attributes of the nearest ancestor of `key` that is
    /// group `name`.
    fn group_data(&self, key: Key, name: &str) -> &[&'static str] {
        let mut k = self.nodes[key as usize].parent;
        while k != NO_KEY {
            let node = &self.nodes[k as usize];
            if node
                .classes
                .as_ref()
                .is_some_and(|c| c.groups().iter().any(|g| **g == *name))
            {
                return &node.data;
            }
            k = node.parent;
        }
        &[]
    }

    /// The margins `key`'s parent gives it (`space-*`): it is an element
    /// child, and not the last.
    fn space_of(&self, key: Key) -> Option<&crate::tailwind::Space> {
        let node = &self.nodes[key as usize];
        let parent = node.parent;
        if parent == NO_KEY || node.inline {
            return None;
        }
        let space = self.nodes[parent as usize]
            .class_props
            .as_ref()?
            .space
            .as_ref()?;
        let last = self.nodes[parent as usize]
            .children
            .iter()
            .rev()
            .find(|&&c| self.is_element_child(c))?;
        (*last != key && self.is_element_child(key)).then_some(space)
    }

    /// A child that counts among its siblings (`:last-child`, `first:`):
    /// not a raw text, a tooltip's overlay or a scroll view's built-in bar.
    fn is_element_child(&self, key: Key) -> bool {
        let node = &self.nodes[key as usize];
        node.kind != Kind::RawText && !node.decoration && !self.is_tooltip_overlay(key)
    }

    /// `parent`'s children changed (`moved` joined it, or one left): the
    /// ones whose `space-*` margin that changes are styled again, the one
    /// that joined, and the last two, one of which was last before.
    pub(super) fn spacing_changed(&mut self, parent: Key, moved: Key) {
        let spacing = self.nodes[parent as usize]
            .class_props
            .as_ref()
            .is_some_and(|p| p.space.is_some());
        if !spacing && (moved == NO_KEY || !self.nodes[moved as usize].spaced) {
            return;
        }
        let mut keys = [moved, NO_KEY, NO_KEY];
        let mut elements = self.nodes[parent as usize]
            .children
            .iter()
            .rev()
            .filter(|&&c| self.is_element_child(c));
        keys[1] = elements.next().copied().unwrap_or(NO_KEY);
        keys[2] = elements.next().copied().unwrap_or(NO_KEY);
        for (i, k) in keys.into_iter().enumerate() {
            if k == NO_KEY || keys[..i].contains(&k) {
                continue;
            }
            let (now, was) = (self.space_of(k).is_some(), self.nodes[k as usize].spaced);
            // The one that moved may have left another `space-*` parent,
            // whose margin it still has.
            if now != was || i == 0 && now {
                self.restyle(k);
            }
        }
    }

    /// Resolves `key`'s style from its classes and inline style.
    pub(super) fn restyle(&mut self, key: Key) {
        self.restyle_at(key, None);
    }

    fn finish_restyle_metadata(&mut self, key: Key, pos: u8, positional: bool) {
        let node = &mut self.nodes[key as usize];
        node.spaced = false;
        node.color_used = node.inherited_color;
        let cleared_ch = node.reads_ch;
        node.reads_ch = false;
        node.resting_fill = None;
        node.position_used = if positional { pos } else { 0 };
        let parent = node.parent;
        if cleared_ch {
            self.ch_readers -= 1;
        }
        if positional {
            self.reads_positions(parent);
        }
    }

    /// Resolves `key`'s classes through [`Core::resolved_styles`]. Returns
    /// `false` when more than the inputs of [`ResolvedKey`] decide its style
    /// (the root, an inline style, `direction`, insets, an input, `group-*`,
    /// `data-*`, `ch`, a `space-*` parent, a terminal box's resting fill under
    /// interaction): [`Self::restyle_at`] resolves it alone.
    fn try_resolve_cached(&mut self, key: Key, position: Option<u8>) -> bool {
        #[cfg(test)]
        if self.resolve_uncached {
            return false;
        }
        let node = &self.nodes[key as usize];
        if key == self.root
            || !node.inline_style.is_empty()
            || node.direction.is_some()
            || node.insets.is_some()
            || node.kind == Kind::Input
        {
            return false;
        }
        let Some(classes) = node.classes.clone() else {
            return false;
        };
        let d = classes.deps();
        if d & (deps::GROUP | deps::DATA | deps::CH) != 0 {
            return false;
        }
        if self.space_of(key).is_some() {
            return false;
        }
        let states = if d & deps::STATE != 0 {
            self.styled_states(key)
        } else {
            0
        };
        if self.layout.grid().is_some() && d & deps::STATE != 0 && states & INTERACTION != 0 {
            return false;
        }
        let pos = if d & deps::POSITION != 0 {
            position.unwrap_or_else(|| self.known_position(key))
        } else {
            0
        };
        let node = &self.nodes[key as usize];
        let positional = pos != 0 && node.parent != NO_KEY;
        let inherited_color = node.inherited_color;
        let rtl = self.resolved_rtl(key);
        let cache_key = ResolvedKey::new(
            &classes,
            &self.class_env,
            self.viewport,
            rtl,
            states,
            pos,
            inherited_color,
        );
        let resolved = if let Some(cached) = self.resolved_styles.get(&cache_key) {
            cached.clone()
        } else {
            let group = |_: &str| 0;
            let cx = Context {
                env: self.class_env,
                window: self.viewport,
                rtl,
                states,
                position: pos,
                group: &group,
            };
            let mut style = Style::default();
            let mut props = ClassProps::default();
            classes.apply_with_current(
                &cx,
                &crate::tailwind::no_data,
                self.tailwind.theme(),
                crate::tailwind::CurrentColor {
                    inherited: inherited_color,
                    inline: None,
                },
                None,
                crate::tailwind::DEFAULT_CH,
                &mut style,
                &mut props,
                |_| {},
            );
            style.node_props(&mut props);
            if !style.animated.is_empty()
                || style.direction.is_some()
                || !style.pending.env.is_empty()
            {
                self.finish_restyle_metadata(key, pos, positional);
                self.set_class_props(key, props);
                let id = self.nodes[key as usize].id;
                let _ = self.set_style(id, style);
                return true;
            }
            let Style {
                mut layout,
                mut view,
                text,
                paint,
                animated: _,
                z_index,
                vertical_align,
                direction: _,
                logical,
                pending,
                perspective,
            } = style;
            let has_logical = !logical.is_empty();
            let sticky = super::prepare_layout(
                &mut layout,
                &mut view,
                &logical,
                rtl,
                pending.sticky_position,
            );
            // An input clips whatever it sets; inputs never reach here.
            super::clip_overflow(&mut layout, view.overflow_hidden);
            let layout = self.layout.share(layout);
            let view = (view != ViewStyle::DEFAULT).then(|| std::rc::Rc::new(view));
            let text = (text != TextStyle::DEFAULT).then(|| std::rc::Rc::new(text));
            let paint = (paint != PaintStyle::default()).then(|| std::rc::Rc::new(paint));
            let props = (props != ClassProps::default()).then(|| std::rc::Rc::new(props));
            let entry = std::rc::Rc::new(ResolvedClassStyle {
                classes,
                layout,
                view,
                text,
                paint,
                props,
                sticky,
                object_fit: pending.object_fit,
                perspective,
                z_index,
                vertical_align,
                wants_fixed: pending.fixed_position,
                rtl,
                has_logical,
            });
            if self.resolved_styles.len() >= RESOLVED_STYLE_CACHE {
                self.resolved_styles.clear();
            }
            self.resolved_styles.insert(cache_key, entry.clone());
            entry
        };
        self.finish_restyle_metadata(key, pos, positional);
        self.apply_resolved_style(key, &resolved);
        true
    }

    /// [`Self::restyle`] with `position` already known (`None`: query it).
    fn restyle_at(&mut self, key: Key, position: Option<u8>) {
        if self.try_resolve_cached(key, position) {
            return;
        }
        let mut base = Style::default();
        // The synthetic root stays sized to the host's viewport when restyled.
        if key == self.root {
            base.layout = super::root_style(self.viewport);
        }
        // Under its own classes and style, as `:where()` is in CSS.
        let space = self.space_of(key);
        if let Some(space) = space {
            space.apply(&mut base, false, self.resolved_rtl(key));
        }
        let spaced = space.is_some();
        let node = &mut self.nodes[key as usize];
        node.spaced = spaced;
        // The color it is styled with (`currentColor`, `sync_colors`).
        node.color_used = node.inherited_color;
        // CSS's `ch` (`max-w-prose`): the `0` of the font it inherits, or of
        // its own once its classes set one.
        let reads_ch = self.nodes[key as usize]
            .classes
            .as_ref()
            .is_some_and(|c| c.deps() & deps::CH != 0);
        let node = &mut self.nodes[key as usize];
        if node.reads_ch != reads_ch {
            if reads_ch {
                self.ch_readers += 1;
            } else {
                self.ch_readers -= 1;
            }
            node.reads_ch = reads_ch;
        }
        let inherited_font = reads_ch.then(|| self.inherited_text_style(key));
        let mut ch = match inherited_font {
            Some(font) => self.zero_advance(font),
            None => crate::tailwind::DEFAULT_CH,
        };
        // In a terminal, a box's fill decides its layout (a band or a
        // line, [`terminal_layout::Surface`]): only needed under active interaction.
        let need_rest = self.layout.grid().is_some()
            && self.styled_states(key) & INTERACTION != 0
            && self.nodes[key as usize]
                .classes
                .as_ref()
                .is_some_and(|c| c.deps() & deps::STATE != 0);
        let base_for_rest = need_rest.then(|| base.clone());
        let mut style;
        let mut props;
        match inherited_font {
            None => {
                style = base;
                props = ClassProps::default();
                self.resolve_classes(key, ch, position, &mut style, &mut props);
            }
            // Again with its own font's, once its classes set one.
            Some(inherited) => loop {
                style = base.clone();
                props = ClassProps::default();
                self.resolve_classes(key, ch, position, &mut style, &mut props);
                let own = self.zero_advance(inherited.inherit(&style.text));
                if own == ch {
                    break;
                }
                ch = own;
            },
        }
        if reads_ch {
            let node = &mut self.nodes[key as usize];
            node.ch = ch;
            let id = node.id;
            self.ch_styled.push((key, id));
        }
        let resting = base_for_rest
            .map(|mut rest| {
                let mut rest_props = ClassProps::default();
                self.resolve_classes_in(key, ch, position, INTERACTION, &mut rest, &mut rest_props);
                rest.view.background_color
            })
            .filter(|&fill| fill != style.view.background_color);
        self.nodes[key as usize].resting_fill = resting;
        style.node_props(&mut props);
        self.set_class_props(key, props);
        let id = self.nodes[key as usize].id;
        let _ = self.set_style(id, style);
    }

    /// A moved subtree or a changed font can change every descendant's `ch`.
    pub(super) fn ch_changed(&mut self, key: Key) {
        if self.ch_readers == 0 {
            return;
        }
        let mut stack = vec![key];
        while let Some(k) = stack.pop() {
            let node = &self.nodes[k as usize];
            if node
                .classes
                .as_ref()
                .is_some_and(|c| c.deps() & deps::CH != 0)
            {
                self.ch_styled.push((k, node.id));
            }
            stack.extend_from_slice(&node.children);
        }
    }

    /// The nodes with lengths in `ch` styled since the last commit are
    /// styled again where the font they now inherit (the tree complete)
    /// gives another `ch` than they were styled with.
    pub(super) fn sync_ch(&mut self) {
        if self.ch_styled.is_empty() {
            return;
        }
        let styled = std::mem::take(&mut self.ch_styled);
        for (key, id) in styled {
            if self.nodes.get(key as usize).is_none_or(|n| n.id != id) {
                continue;
            }
            let font = self.inherited_text_style(key);
            let font = font.inherit(&self.nodes[key as usize].text_style);
            if self.zero_advance(font) != self.nodes[key as usize].ch {
                self.restyle(key);
            }
        }
        // Styled just now, with the fonts in place.
        self.ch_styled.clear();
    }

    /// The nodes queued by [`Self::inherit_color`] are styled again where
    /// the text color they inherit is not the one they were styled with.
    pub(super) fn sync_colors(&mut self) {
        if self.color_changed.is_empty() {
            return;
        }
        for (key, id) in std::mem::take(&mut self.color_changed) {
            let Some(node) = self.nodes.get_mut(key as usize) else {
                continue;
            };
            if node.id != id {
                continue;
            }
            node.color_queued = false;
            if node.inherited_color != node.color_used {
                self.restyle(key);
            }
        }
    }

    /// The advance of `font`'s `0`, CSS's `ch` (cached per font).
    pub(super) fn zero_advance(&mut self, font: crate::text::ResolvedTextStyle) -> f32 {
        let at = (
            font.font_family,
            font.font_size.0.to_bits(),
            font.font_weight,
            font.italic,
        );
        if let Some(&w) = self.zero_advances.get(&at) {
            return w;
        }
        let mut text = crate::text::AttributedText::default();
        text.push("0", font);
        let prepared = self.text_engine.prepare(&text);
        let w = self.text_engine.measure(&prepared, None).width.0;
        // Fonts are few; a bound keeps scaled sizes from growing it.
        if self.zero_advances.len() >= 64 {
            self.zero_advances.clear();
        }
        self.zero_advances.insert(at, w);
        w
    }

    /// `key`'s classes and inline style over `style`, `ch` the advance of
    /// its font's `0`.
    fn resolve_classes(
        &mut self,
        key: Key,
        ch: f32,
        position: Option<u8>,
        style: &mut Style,
        props: &mut ClassProps,
    ) {
        self.resolve_classes_in(key, ch, position, 0, style, props);
    }

    /// [`Self::resolve_classes`] as if `key` were not in the states
    /// `without`.
    fn resolve_classes_in(
        &mut self,
        key: Key,
        ch: f32,
        position: Option<u8>,
        without: u16,
        style: &mut Style,
        props: &mut ClassProps,
    ) {
        let node = &self.nodes[key as usize];
        if let Some(classes) = node.classes.clone() {
            let group = |name: &str| self.group_states(key, name);
            let data = |group: Option<&str>, name: &str| match group {
                None => node.data.contains(&name),
                Some(group) => self.group_data(key, group).contains(&name),
            };
            let pos = if classes.deps() & deps::POSITION != 0 {
                position.unwrap_or_else(|| self.known_position(key))
            } else {
                0
            };
            let positional = pos != 0 && node.parent != NO_KEY;
            let window = self.viewport;
            let cx = Context {
                env: self.class_env,
                window,
                // The direction it lays out in once styled (a node created
                // detached takes the root's), so its sided classes land
                // right the first time.
                rtl: self.resolved_rtl(key),
                states: self.styled_states(key) & !without,
                position: pos,
                group: &group,
            };
            let inline = &node.inline_style;
            let has_inline = !inline.is_empty();
            let current = crate::tailwind::CurrentColor {
                inherited: node.inherited_color,
                inline: if has_inline {
                    inline_color(inline)
                } else {
                    None
                },
            };
            let rtl = cx.rtl;
            if has_inline {
                let text_color = classes.current_color(&cx, &data, current);
                inline.apply_defaults(style, text_color);
                classes.apply_with_current(
                    &cx,
                    &data,
                    self.tailwind.theme(),
                    current,
                    Some(text_color),
                    ch,
                    style,
                    props,
                    |s| {
                        inline.apply(s);
                        s.apply_current_color(text_color);
                        if let Some(space) = self.space_of(key) {
                            space.apply(s, true, rtl);
                        }
                    },
                );
            } else {
                classes.apply_with_current(
                    &cx,
                    &data,
                    self.tailwind.theme(),
                    current,
                    None,
                    ch,
                    style,
                    props,
                    |s| {
                        if let Some(space) = self.space_of(key) {
                            space.apply(s, true, rtl);
                        }
                    },
                );
            }
            self.nodes[key as usize].position_used = if positional { pos } else { 0 };
            if positional {
                self.reads_positions(self.nodes[key as usize].parent);
            }
        } else {
            // Without classes it reads no position: the bits it was styled
            // at before are no longer kept up to date (`known_position`).
            self.nodes[key as usize].position_used = 0;
            let node = &self.nodes[key as usize];
            let current = inline_color(&node.inline_style)
                .or(node.inherited_color)
                .unwrap_or(Color::BLACK);
            node.inline_style.apply_defaults(style, current);
            node.inline_style.apply(style);
            style.apply_current_color(current);
            if let Some(space) = self.space_of(key) {
                space.apply(style, true, self.resolved_rtl(key));
            }
        }
    }

    /// `key`'s children inherit text color `color` (`None`: React Native's
    /// black) from it: those whose `currentColor` it changes are styled
    /// again, and the change goes on below those that set no color of their
    /// own.
    pub(super) fn inherit_color(&mut self, key: Key, color: Option<Color>) {
        let stack = self.nodes[key as usize].children.clone();
        self.pass_color(stack, color);
    }

    /// [`Self::inherit_color`] for `key` itself, which joined a parent
    /// passing `color`.
    pub(super) fn inherit_color_from(&mut self, key: Key, color: Option<Color>) {
        self.pass_color(vec![key], color);
    }

    fn pass_color(&mut self, mut stack: Vec<Key>, color: Option<Color>) {
        while let Some(k) = stack.pop() {
            let node = &mut self.nodes[k as usize];
            if node.inherited_color == color {
                continue;
            }
            node.inherited_color = color;
            // Styled again as the commit starts, where the color it was
            // styled with is not the one it inherits then (a subtree built
            // from the inside out passes through several).
            if !node.color_queued
                && (node.inline_style.reads_current_color()
                    || node
                        .classes
                        .as_ref()
                        .is_some_and(|c| c.deps() & deps::CURRENT_COLOR != 0))
            {
                node.color_queued = true;
                let id = node.id;
                self.color_changed.push((k, id));
            }
            let node = &self.nodes[k as usize];
            if node.text_style.color.is_none() {
                stack.extend_from_slice(&node.children);
            }
        }
    }

    /// The outermost of `key` and its ancestors whose classes say
    /// `pointer-events-none`, with no `pointer-events-auto` above it: the
    /// top of the region `key`'s class `pointer-events` depends on.
    pub(super) fn pointer_region(&self, key: Key) -> Option<Key> {
        let mut top = None;
        let mut k = key;
        while k != NO_KEY {
            let node = &self.nodes[k as usize];
            match node.class_props.as_ref().and_then(|c| c.pointer_events) {
                Some(PointerEvents::None) => top = Some(k),
                // Above an `auto`, nothing reaches below it.
                Some(_) if top.is_some() => return top,
                _ => {}
            }
            k = node.parent;
        }
        top
    }

    /// `parent` gained or lost a child: the region it is in follows, at
    /// the round's end ([`Self::flush_pointer_events`]).
    pub(super) fn pointer_events_moved(&mut self, parent: Key) {
        if let Some(top) = self.pointer_region(parent) {
            self.pointer_pending.push(top);
        }
    }

    /// Works out the regions views joined, left or changed in this round
    /// ([`Self::update_pointer_events`]), each once, with the tree as the
    /// round left it: each view noted is taken to the top of the region it
    /// is in now (a view taken out of a region and put into another is
    /// worked out from that one's top, as the views above it block). A
    /// view released since is skipped; a key reused by another view is
    /// worked out where that view is.
    pub(super) fn flush_pointer_events(&mut self) {
        if self.pointer_pending.is_empty() {
            return;
        }
        let mut pending = std::mem::take(&mut self.pointer_pending);
        pending.retain(|&k| self.nodes.contains(k as usize));
        for k in &mut pending {
            *k = self.pointer_region(*k).unwrap_or(*k);
        }
        pending.sort_unstable();
        pending.dedup();
        for &top in &pending {
            self.update_pointer_events(top);
        }
        // The buffer, for the next round.
        pending.clear();
        self.pointer_pending = pending;
    }

    /// What the views of `top`'s subtree mount for the `pointer-events-*`
    /// classes, as CSS's inherited `pointer-events`: a view that is
    /// `none` (its own class, else the nearest one above) is no target;
    /// it mounts `box-none` when a `pointer-events-auto` inside it is one,
    /// `none` when it holds none and the view above it lets touches
    /// through (the top of the region), and nothing more below a `none`.
    /// Only the views whose value changed are mounted again.
    pub(super) fn update_pointer_events(&mut self, top: Key) {
        let inherited = {
            let parent = self.nodes[top as usize].parent;
            let mut k = parent;
            let mut found = None;
            while k != NO_KEY {
                let node = &self.nodes[k as usize];
                if let Some(v) = node.class_props.as_ref().and_then(|c| c.pointer_events) {
                    found = Some(v);
                    break;
                }
                k = node.parent;
            }
            found
        };
        self.mark_pointer_auto(top, inherited);
        // `top` is the outermost `none` (or a view without one): nothing
        // above it blocks touches natively.
        let mut stack = vec![(top, inherited, false)];
        while let Some((k, inherited, blocked)) = stack.pop() {
            let node = &self.nodes[k as usize];
            let own = node.class_props.as_ref().and_then(|c| c.pointer_events);
            let effective = own.or(inherited);
            let mounted = match effective {
                // React Native's: the view's own, natively; what is in it
                // takes touches (`box-none`) or none (`box-only`).
                Some(p @ (PointerEvents::BoxNone | PointerEvents::BoxOnly)) if own.is_some() => p,
                Some(PointerEvents::None) if node.pointer_auto_inside => PointerEvents::BoxNone,
                // A view above already blocks the subtree.
                Some(PointerEvents::None) if blocked => PointerEvents::Auto,
                Some(PointerEvents::None) => PointerEvents::None,
                _ => PointerEvents::Auto,
            };
            let blocked =
                blocked || matches!(mounted, PointerEvents::None | PointerEvents::BoxOnly);
            // Neither is inherited: the views in a `box-none` take touches,
            // and those in a `box-only` are blocked natively.
            let effective = match effective {
                Some(PointerEvents::BoxNone | PointerEvents::BoxOnly) => Some(PointerEvents::Auto),
                e => e,
            };
            for &c in &node.children {
                stack.push((c, effective, blocked));
            }
            if self.nodes[k as usize].class_pointer != mounted {
                self.nodes[k as usize].class_pointer = mounted;
                self.mark(k, dirty::VIEW_PROPS);
            }
        }
    }

    /// Sets `pointer_auto_inside` over `key`'s subtree (`inherited`: the
    /// class value above it); returns whether a `pointer-events-auto` is in
    /// it or it is one under a `none`.
    fn mark_pointer_auto(&mut self, key: Key, inherited: Option<PointerEvents>) -> bool {
        let own = self.nodes[key as usize]
            .class_props
            .as_ref()
            .and_then(|c| c.pointer_events);
        let effective = match own.or(inherited) {
            // Not inherited (`update_pointer_events`).
            Some(PointerEvents::BoxNone | PointerEvents::BoxOnly) => Some(PointerEvents::Auto),
            e => e,
        };
        let children = std::mem::take(&mut self.nodes[key as usize].children);
        let mut inside = false;
        for &c in &children {
            inside |= self.mark_pointer_auto(c, effective);
        }
        self.nodes[key as usize].children = children;
        self.nodes[key as usize].pointer_auto_inside = inside;
        // Any value of its own but `none` takes some touches under a `none`.
        inside
            || own.is_some_and(|o| o != PointerEvents::None)
                && inherited == Some(PointerEvents::None)
    }

    /// Applies the node props classes and styles set.
    pub(super) fn set_class_props(&mut self, key: Key, props: ClassProps) {
        let is_default = props == ClassProps::default();
        match (&self.nodes[key as usize].class_props, is_default) {
            (None, true) => return,
            (Some(old), false) if **old == props => return,
            (Some(old), true) if **old == ClassProps::default() => {
                self.nodes[key as usize].class_props = None;
                return;
            }
            _ => {}
        }
        let old = self.nodes[key as usize].class_props.take();
        let next = (!is_default).then(|| std::rc::Rc::new(props));
        self.nodes[key as usize].class_props = next.clone();
        self.diff_class_props(key, old.as_deref(), next.as_deref());
    }

    /// Applies a shared `Rc<ClassProps>` from a cached resolved style,
    /// skipping comparison when the same pointer is already installed.
    pub(super) fn set_class_props_shared(
        &mut self,
        key: Key,
        props: Option<&std::rc::Rc<ClassProps>>,
    ) {
        match (&self.nodes[key as usize].class_props, props) {
            (None, None) => return,
            (Some(a), Some(b)) if std::rc::Rc::ptr_eq(a, b) => return,
            (Some(old), None) if **old == ClassProps::default() => {
                self.nodes[key as usize].class_props = None;
                return;
            }
            (Some(old), Some(new)) if **old == **new => {
                self.nodes[key as usize].class_props = Some(new.clone());
                return;
            }
            _ => {}
        }
        let old = self.nodes[key as usize].class_props.take();
        self.nodes[key as usize].class_props = props.cloned();
        self.diff_class_props(key, old.as_deref(), props.map(|p| &**p));
    }

    fn diff_class_props(&mut self, key: Key, old: Option<&ClassProps>, new: Option<&ClassProps>) {
        let def = ClassProps::default();
        let old = old.unwrap_or(&def);
        let props = new.unwrap_or(&def);
        let paragraph = old.number_of_lines != props.number_of_lines
            || old.selectable != props.selectable
            || old.ellipsize != props.ellipsize
            || old.no_wrap != props.no_wrap
            || old.pretty != props.pretty;
        let pointer = old.pointer_events != props.pointer_events;
        let none = Some(crate::props::PointerEvents::None);
        match (old.pointer_events == none, props.pointer_events == none) {
            (false, true) => self.pointer_none_classes += 1,
            (true, false) => self.pointer_none_classes -= 1,
            _ => {}
        }
        let space = old.space != props.space;
        let input = old.placeholder_color != props.placeholder_color
            || old.caret_color != props.caret_color
            || old.selection_color != props.selection_color;
        let selection = old.selection_color != props.selection_color;
        let kind = self.nodes[key as usize].kind;
        if paragraph && kind == Kind::Text {
            self.mark_text_block(key);
        }
        if (old.no_wrap != props.no_wrap
            || old.selectable != props.selectable
            || selection
            || old.pretty != props.pretty)
            && kind != Kind::Text
        {
            // The texts inside inherit them.
            self.mark_inheriting_text(key);
        }
        if pointer {
            let top = self.pointer_region(key).unwrap_or(key);
            self.pointer_pending.push(top);
        }
        if selection && kind == Kind::Text {
            self.mark_text_block(key);
        }
        if input && kind == Kind::Input {
            self.mark(key, dirty::INPUT);
        }
        if space {
            // The margins of its children.
            let children = self.nodes[key as usize].children.clone();
            for child in children {
                if self.is_element_child(child) && !self.nodes[child as usize].inline {
                    self.restyle(child);
                }
            }
        }
    }
}
