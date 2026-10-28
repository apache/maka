//! Tailwind classes on nodes: resolving them into styles (with the inline
//! `style` applied on top) and resolving them again when what they depend
//! on changes: the appearance, the window size, the layout direction, the
//! node's interaction states, its group's states or its sibling position.

use super::{Core, Key, Kind, NO_KEY, dirty, disabling_changes};
use crate::{
    geometry::{Points, Size},
    mount::MountItem,
    ops::NodeId,
    platform::{Appearance, ColorScheme},
    props::PointerEvents,
    style::{Color, Style, StylePatch, ViewStyle},
    tailwind::{
        ClassEnvironment, ClassList, ClassProps, Context, Rule, Theme, deps, position, rank, state,
    },
    text::TextEngine,
};

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
            _ => return None,
        })
    }
}

/// What only some nodes have ([`super::Node`]'s `parts`).
#[derive(Debug, Default)]
pub(super) struct NodeParts {
    /// The classes as set, before the state styles are merged in.
    base: Option<std::rc::Rc<ClassList>>,
    /// The state styles, by [`Part`] (the first eight).
    states: [Option<std::rc::Rc<StylePatch>>; 8],
    /// The state styles as rules (none without any).
    state_rules: Option<std::rc::Rc<ClassList>>,
    /// The inline styles of the other parts.
    styles: Vec<(Part, std::rc::Rc<StylePatch>)>,
    /// The classes of the other parts.
    classes: Vec<(Part, std::rc::Rc<ClassList>)>,
}

/// The state style parts, by their index in [`NodeParts::states`].
const STATE_PARTS: [Part; 8] = [
    Part::Active,
    Part::Hover,
    Part::Focus,
    Part::Disabled,
    Part::Selected,
    Part::Checked,
    Part::Indeterminate,
    Part::Expanded,
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
            // `ios:` / `android:` never change at run time, but a new
            // platform must reach classes resolved before it was known.
            | (if env.platform != self.class_env.platform { u16::MAX } else { 0 });
        self.class_env = env;
        self.restyle_where(changed);
        self.parts_restyled();
    }

    /// The platform reports interaction states of view `id` (`active:`,
    /// `hover:`, `focus:`): state bits for the states it
    /// tracks ([`MountItem::TrackStates`]); see [`crate::tailwind::state`].
    pub fn set_states(&mut self, id: NodeId, states: u16) {
        let Ok(key) = self.key(id) else { return };
        if let Some(list) = self.nodes[key as usize].list.as_mut() {
            list.interaction(states);
        }
        self.set_node_states(key, states);
    }

    /// [`Self::set_states`] by key.
    fn set_node_states(&mut self, key: Key, states: u16) {
        let held = self.held_pressed() == Some(key);
        let node = &mut self.nodes[key as usize];
        let mut new = node.states & !REPORTED | states & REPORTED;
        if held {
            new |= state::PRESSED;
        }
        if new == node.states {
            return;
        }
        let focus_changed = (new ^ node.states) & state::FOCUSED != 0;
        node.states = new;
        self.states_changed(key);
        if focus_changed {
            // `focus-within:` on the node and its ancestors.
            let focused = new & state::FOCUSED != 0;
            let mut k = key;
            while k != NO_KEY {
                let node = &mut self.nodes[k as usize];
                let before = node.states;
                if focused {
                    node.states |= state::FOCUS_WITHIN;
                } else {
                    node.states &= !state::FOCUS_WITHIN;
                }
                let parent = node.parent;
                if node.states != before && k != key {
                    self.states_changed(k);
                }
                k = parent;
            }
        }
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
            let node = &mut self.nodes[key as usize];
            if node.states & state::PRESSED != 0 {
                node.states &= !state::PRESSED;
                self.states_changed(key);
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
    fn states_changed(&mut self, key: Key) {
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

    /// `selected` of `key`'s accessibility state: the `selected:` variant.
    pub(super) fn set_selected(&mut self, key: Key, selected: bool) {
        let node = &mut self.nodes[key as usize];
        let before = node.states;
        if selected {
            node.states |= state::SELECTED;
        } else {
            node.states &= !state::SELECTED;
        }
        if node.states != before {
            self.states_changed(key);
        }
    }

    /// `checked` of `key`'s accessibility state (true, not mixed): the
    /// `checked:` variant.
    pub(super) fn set_checked(&mut self, key: Key, checked: bool) {
        let node = &mut self.nodes[key as usize];
        let before = node.states;
        if checked {
            node.states |= state::CHECKED;
        } else {
            node.states &= !state::CHECKED;
        }
        if node.states != before {
            self.states_changed(key);
        }
    }

    /// `expanded` of `key`'s accessibility state: the `aria-expanded:`
    /// variant (a `Popover`'s or `Menu`'s trigger while its popup is open).
    pub(super) fn set_expanded(&mut self, key: Key, expanded: bool) {
        let node = &mut self.nodes[key as usize];
        let before = node.states;
        if expanded {
            node.states |= state::EXPANDED;
        } else {
            node.states &= !state::EXPANDED;
        }
        if node.states != before {
            self.states_changed(key);
        }
    }

    /// `checked` of `key`'s accessibility state is mixed: the
    /// `indeterminate:` variant.
    pub(super) fn set_indeterminate(&mut self, key: Key, indeterminate: bool) {
        let node = &mut self.nodes[key as usize];
        let before = node.states;
        if indeterminate {
            node.states |= state::INDETERMINATE;
        } else {
            node.states &= !state::INDETERMINATE;
        }
        if node.states != before {
            self.states_changed(key);
        }
    }

    /// The states `key` shows as a part of a control: its classes and
    /// state styles read them, its events and accessibility do not.
    pub(super) fn set_projected_states(&mut self, key: Key, states: u16) {
        let node = &mut self.nodes[key as usize];
        if node.projected != states {
            node.projected = states;
            self.states_changed(key);
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
            style.hidden |= self.layout.style(layout).display == taffy::Display::None;
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
        self.set_part_class_list(key, part, classes);
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
                if let Some(list) = self.nodes[key as usize].list.as_mut() {
                    list.set_class_content(content);
                }
            }
            _ => {}
        }
    }

    /// The padding and gaps a list's `contentClass` sets.
    fn list_content(&self, key: Key) -> crate::ListContentStyle {
        let Some(style) = self.part_resolved(key, Part::Content) else {
            return crate::ListContentStyle::default();
        };
        let px = |l: taffy::LengthPercentage| match l.expand() {
            taffy::style::ExpandedLengthPercentage::Length(v) => crate::geometry::Points(v),
            _ => crate::geometry::Points::ZERO,
        };
        let p = &style.layout.padding;
        crate::ListContentStyle {
            padding: crate::EdgeInsets {
                top: px(p.top),
                right: px(p.right),
                bottom: px(p.bottom),
                left: px(p.left),
            },
            row_gap: px(style.layout.gap.height),
            column_gap: px(style.layout.gap.width),
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
        let mut combined = String::with_capacity(current.class.len() + 16 * current.list.len());
        combined.push_str(&current.class);
        for name in &current.list {
            combined.push(' ');
            combined.push_str(name);
        }
        let classes = if combined.trim().is_empty() {
            None
        } else {
            let (classes, fresh) = self.tailwind.get(&combined);
            if fresh && !classes.unknown().is_empty() {
                log::warn!(
                    "unknown classes: {}",
                    classes
                        .unknown()
                        .iter()
                        .map(|s| &**s)
                        .collect::<Vec<_>>()
                        .join(" ")
                );
            }
            Some(classes)
        };
        self.set_class_list(key, classes);
    }

    /// Sets the resolved classes of `key` (a Rust component's styles go
    /// straight here).
    pub(super) fn set_class_list(&mut self, key: Key, classes: Option<std::rc::Rc<ClassList>>) {
        let node = &mut self.nodes[key as usize];
        // The state styles go over the classes.
        let classes = match node.parts.as_deref_mut() {
            Some(parts) => {
                parts.base = classes.clone();
                match (classes, &parts.state_rules) {
                    (Some(c), Some(s)) => Some(std::rc::Rc::new(c.merged(s))),
                    (None, Some(s)) => Some(s.clone()),
                    (c, None) => c,
                }
            }
            None => classes,
        };
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

    /// Replaces the theme: every class is resolved again.
    pub(super) fn set_tailwind_theme(&mut self, json: &str) {
        let theme = match Theme::from_json(json) {
            Ok(t) => t,
            Err(e) => {
                log::warn!("tailwind theme: {e}");
                return;
            }
        };
        self.tailwind.set_theme(theme);
        let keys: Vec<Key> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.class_names.is_some())
            .map(|(k, _)| k as Key)
            .collect();
        for key in keys {
            self.set_classes(key, None, None);
        }
    }

    /// The design tokens changed: classes naming them
    /// (`bg-primary`) are resolved again, on nodes and on Rust components.
    pub(super) fn class_tokens_changed(&mut self) {
        let tokens = self.components.tokens.clone();
        let Some(changed) = self.tailwind.set_tokens(&tokens) else {
            return;
        };
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
            let list = match (own, user) {
                (Some(a), Some(b)) => Some(std::rc::Rc::new(a.merged(&b))),
                (a, b) => a.or(b),
            };
            if let Ok(key) = self.key(id) {
                self.set_class_list(key, list);
            }
        }
    }

    /// Tells the platform which states of `key` to report.
    pub(super) fn update_tracking(&mut self, key: Key) {
        let node = &mut self.nodes[key as usize];
        let tracked = node.classes.as_ref().map_or(0, |c| c.tracked_states())
            | if node.list.as_ref().is_some_and(|list| list.automatic) {
                state::HOVERED | state::FOCUS_WITHIN
            } else {
                0
            }
            | if node.overlay_watched & super::overlay::watch::HINT_FOCUS != 0 {
                state::FOCUSED
            } else {
                0
            };
        if tracked != node.tracked {
            node.tracked = tracked;
            // The platform stops reporting the states it no longer tracks,
            // and keeps the rest as they are: forget them here too, or a
            // state set before (a hover, a press) would outlive the pointer
            // and come back when the classes read it again.
            let stale = node.states & REPORTED & !tracked;
            let states = node.states & REPORTED & tracked;
            if node.created {
                let id = node.id;
                self.mount.push(MountItem::TrackStates {
                    id,
                    states: tracked,
                });
            }
            if stale != 0 {
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
            if node
                .classes
                .as_ref()
                .is_some_and(|c| c.deps() & changed != 0)
            {
                self.restyle(k);
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
            if n.states | n.projected != 0
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

    /// Restyles the children of `parent` that depend on their position.
    pub(super) fn positions_changed(&mut self, parent: Key) {
        let children = self.nodes[parent as usize].children.clone();
        for c in children {
            if self.nodes[c as usize]
                .classes
                .as_ref()
                .is_some_and(|c| c.deps() & deps::POSITION != 0)
            {
                self.restyle(c);
            }
        }
    }

    /// Whether `key`'s classes depend on the layout direction.
    pub(super) fn reads_direction(&self, key: Key) -> bool {
        self.nodes[key as usize]
            .classes
            .as_ref()
            .is_some_and(|c| c.deps() & deps::RTL != 0)
    }

    /// [`position`] bits of `key` among its parent's element children.
    fn position_bits(&self, key: Key) -> u8 {
        let parent = self.nodes[key as usize].parent;
        if parent == NO_KEY {
            return position::FIRST | position::LAST | position::ONLY | position::ODD;
        }
        let siblings: Vec<Key> = self.nodes[parent as usize]
            .children
            .iter()
            .copied()
            .filter(|&c| self.is_element_child(c))
            .collect();
        let i = siblings.iter().position(|&c| c == key).unwrap_or(0);
        let n = siblings.len();
        let mut bits = if i % 2 == 0 {
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
                return node.states | node.projected;
            }
            k = node.parent;
        }
        0
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
        let mut base = Style::default();
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
        let mut style;
        let mut props;
        match inherited_font {
            None => {
                style = base;
                props = ClassProps::default();
                self.resolve_classes(key, ch, &mut style, &mut props);
            }
            // Again with its own font's, once its classes set one.
            Some(inherited) => loop {
                style = base.clone();
                props = ClassProps::default();
                self.resolve_classes(key, ch, &mut style, &mut props);
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
    fn resolve_classes(&mut self, key: Key, ch: f32, style: &mut Style, props: &mut ClassProps) {
        let node = &self.nodes[key as usize];
        if let Some(classes) = node.classes.clone() {
            let group = |name: &str| self.group_states(key, name);
            let pos = if classes.deps() & deps::POSITION != 0 {
                self.position_bits(key)
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
                states: node.states | node.projected,
                position: pos,
                group: &group,
            };
            let inline = &node.inline_style;
            let current = crate::tailwind::CurrentColor {
                inherited: node.inherited_color,
                inline: inline_color(inline),
            };
            let text_color = classes.current_color(&cx, current);
            inline.apply_defaults(style, text_color);
            let rtl = cx.rtl;
            classes.apply_with(&cx, self.tailwind.theme(), current, ch, style, props, |s| {
                inline.apply(s);
                s.apply_current_color(text_color);
                if let Some(space) = self.space_of(key) {
                    space.apply(s, true, rtl);
                }
            });
            if positional {
                let parent = self.nodes[key as usize].parent;
                self.nodes[parent as usize].positional_children = true;
            }
        } else {
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

    /// `parent` gained or lost a child: the region it is in follows.
    pub(super) fn pointer_events_moved(&mut self, parent: Key) {
        if let Some(top) = self.pointer_region(parent) {
            self.update_pointer_events(top);
        }
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
        let node = &mut self.nodes[key as usize];
        let old = node.class_props.take().map(|b| *b).unwrap_or_default();
        if old == props {
            node.class_props = (props != ClassProps::default()).then(|| Box::new(props));
            return;
        }
        let paragraph = old.number_of_lines != props.number_of_lines
            || old.selectable != props.selectable
            || old.ellipsize != props.ellipsize
            || old.no_wrap != props.no_wrap;
        let pointer = old.pointer_events != props.pointer_events;
        let none = Some(crate::props::PointerEvents::None);
        match (old.pointer_events == none, props.pointer_events == none) {
            (false, true) => self.pointer_none_classes += 1,
            (true, false) => self.pointer_none_classes -= 1,
            _ => {}
        }
        let node = &mut self.nodes[key as usize];
        let space = old.space != props.space;
        let input = old.placeholder_color != props.placeholder_color
            || old.caret_color != props.caret_color
            || old.selection_color != props.selection_color;
        let selection = old.selection_color != props.selection_color;
        let (props_no_wrap, props_selectable) = (props.no_wrap, props.selectable);
        node.class_props = (props != ClassProps::default()).then(|| Box::new(props));
        let kind = node.kind;
        if paragraph && kind == Kind::Text {
            self.mark_text_block(key);
        }
        if (old.no_wrap != props_no_wrap || old.selectable != props_selectable || selection)
            && kind != Kind::Text
        {
            // The texts inside inherit them.
            self.mark_inheriting_text(key);
        }
        if pointer {
            let top = self.pointer_region(key).unwrap_or(key);
            self.update_pointer_events(top);
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
