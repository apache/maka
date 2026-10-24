//! Screen and modal presentation without a JavaScript round trip.
//!
//! A departing root keeps its retained subtree until the transition ends.
//! Layout targets stay unchanged: presentation shifts and opacity are sampled
//! by both drawing and input. Dialogs are transparent viewport-sized layers;
//! their popup, backdrop and screen headers are rendered by the app.

use nsh_core::{
    Bounds, EdgeInsets, EventKind, EventPayload, ModalAnimation, MountBatch, MountItem, NodeId,
    PayloadValue, Point, Points, ScreenAnimation, Size, ViewKind, geometry::px,
};

use crate::surface::{Surface, SurfaceEvent};

const SLIDE_SECONDS: f64 = 0.3;
const FADE_SECONDS: f64 = 0.2;
const PARALLAX: f32 = 0.3;
const DIM: f32 = 0.12;

/// Per-surface navigation records. Dense node slots hold only running tracks.
#[derive(Default)]
pub(crate) struct Navigation {
    tracks: Vec<Option<Track>>,
    stacks: Vec<(NodeId, NodeId)>,
    modals: Vec<NodeId>,
    reports: Vec<Option<(Size<Points>, EdgeInsets)>>,
    moving: Vec<NodeId>,
    presentations: Vec<NodeId>,
    /// Detached list-owned roots retain their native presentation slot
    /// until they are reinserted or their source nodes are deleted.
    parked: Vec<NodeId>,
    gesture: Option<Gesture>,
}

impl Navigation {
    fn track(&self, id: NodeId) -> Option<&Track> {
        self.tracks.get(id as usize)?.as_ref()
    }

    fn track_mut(&mut self, id: NodeId) -> Option<&mut Track> {
        self.tracks.get_mut(id as usize)?.as_mut()
    }

    fn set_track(&mut self, id: NodeId, track: Option<Track>) {
        if track.is_none() && self.tracks.len() <= id as usize {
            return;
        }
        self.tracks
            .resize_with(self.tracks.len().max(id as usize + 1), || None);
        self.tracks[id as usize] = track;
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Movement {
    Horizontal,
    Vertical,
    Fade,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Completion {
    Enter,
    Restore,
    Detach,
    Pop,
}

impl Completion {
    fn exiting(self) -> bool {
        matches!(self, Self::Detach | Self::Pop)
    }
}

struct Track {
    movement: Movement,
    position: Position,
    below: Option<NodeId>,
    completion: Completion,
    modal: bool,
}

impl Track {
    fn fraction(&self, now: f64) -> f32 {
        self.position.value(now).clamp(0.0, 1.0)
    }
}

enum Position {
    Timed {
        from: f32,
        to: f32,
        started: f64,
        duration: f64,
    },
    Interactive(f32),
}

impl Position {
    fn value(&self, now: f64) -> f32 {
        match *self {
            Self::Interactive(value) => value,
            Self::Timed {
                from,
                to,
                started,
                duration,
            } => {
                let progress = if duration <= 0.0 {
                    1.0
                } else {
                    ((now - started) / duration).clamp(0.0, 1.0)
                };
                let remaining = 1.0 - progress;
                let eased = (1.0 - remaining * remaining * remaining) as f32;
                from + (to - from) * eased
            }
        }
    }

    fn finished(&self, now: f64) -> bool {
        match *self {
            Self::Interactive(_) => false,
            Self::Timed {
                started, duration, ..
            } => now - started >= duration,
        }
    }
}

struct Gesture {
    id: NodeId,
    below: Option<NodeId>,
    origin: (f32, f32),
    last: (f32, f32),
    started: f64,
    last_time: f64,
    velocity: f32,
    extent: f32,
    claimed: bool,
}

impl Surface {
    /// Protects complete outgoing trees before descendants can be released
    /// earlier in the batch than their screen or modal.
    pub(crate) fn navigation_prepare(&mut self, batch: &MountBatch) {
        self.navigation.presentations.clear();
        self.navigation.moving = batch
            .items
            .iter()
            .filter_map(|item| match item {
                MountItem::Insert { child, .. } => Some(*child),
                MountItem::ProjectRoot { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        let mut roots = Vec::new();
        for item in &batch.items {
            let id = match item {
                MountItem::Remove { id } | MountItem::Delete { id } => *id,
                _ => continue,
            };
            if self
                .node(id)
                .is_some_and(|node| matches!(node.kind, ViewKind::Screen | ViewKind::Modal))
            {
                roots.push(id);
            }
        }
        // Outer roots retain their children rather than running each nested
        // navigation controller's exit independently.
        roots.sort_by_key(|&id| self.navigation_depth(id));
        roots.dedup();
        for id in roots {
            self.navigation_removing(id);
        }
    }

    fn navigation_depth(&self, id: NodeId) -> usize {
        let mut depth = 0;
        let mut current = self.node(id).and_then(|node| node.parent);
        while let Some(id) = current {
            depth += 1;
            current = self.node(id).and_then(|node| node.parent);
        }
        depth
    }

    pub(crate) fn navigation_attached(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            if id == nsh_core::ROOT_ID {
                return true;
            }
            let Some(node) = self.node(id) else {
                return false;
            };
            if node.popped || node.style.hidden {
                return false;
            }
            current = node.parent;
        }
        false
    }

    /// Cancels an app removal when it moves or reinserts the same root.
    pub(crate) fn navigation_reinserted(&mut self, id: NodeId) -> bool {
        if let Some(index) = self.navigation.parked.iter().position(|&root| root == id) {
            self.navigation.parked.swap_remove(index);
            return true;
        }
        let exiting = self
            .navigation
            .track(id)
            .is_some_and(|track| track.completion.exiting());
        let presenting = self.node(id).is_some_and(|node| {
            node.kind == ViewKind::Modal && (exiting || node.popped || node.parent.is_none())
        });
        if presenting {
            self.navigation.presentations.retain(|&modal| modal != id);
            self.navigation.presentations.push(id);
            self.navigation.modals.retain(|&modal| modal != id);
        }
        if exiting {
            self.navigation.set_track(id, None);
        }
        if let Some(node) = self.node_mut(id) {
            node.popped = false;
            node.delete_pending = false;
        }
        false
    }

    pub(crate) fn navigation_is_parked(&self, id: NodeId) -> bool {
        self.ancestors(id)
            .iter()
            .any(|id| self.navigation.parked.contains(id))
    }

    /// Parks Core's native root snapshot without ending a popup or modal
    /// lifetime, animating it out, or changing its presentation order.
    pub(crate) fn navigation_park(&mut self, roots: &[NodeId]) {
        let mut nodes = roots.to_vec();
        let mut index = 0;
        while index < nodes.len() {
            let children = self
                .node(nodes[index])
                .map_or_else(Vec::new, |node| node.children.clone());
            for child in children {
                if !nodes.contains(&child) {
                    nodes.push(child);
                }
            }
            index += 1;
        }
        for &id in &nodes {
            if self.navigation.track(id).is_some_and(|track| {
                track.completion == Completion::Pop
                    || (track.completion == Completion::Detach && track.modal)
            }) {
                self.navigation.modals.retain(|&modal| modal != id);
                self.emit(id, EventKind::Dismiss, EventPayload::None);
            }
            self.navigation.set_track(id, None);
            if let Some(node) = self.node_mut(id) {
                node.motion = None;
            }
            if self
                .node(id)
                .is_some_and(|node| node.kind == ViewKind::Input && node.input.auto_focus)
                && !self.autofocus_seen.contains(&id)
            {
                self.autofocus_seen.push(id);
            }
        }
        self.navigation
            .presentations
            .retain(|id| !nodes.contains(id));
        self.navigation.moving.retain(|id| !nodes.contains(id));
        for &root in roots {
            if self.node(root).is_some() && !self.navigation.parked.contains(&root) {
                self.navigation.parked.push(root);
            }
            self.detach(root);
        }
    }

    pub(crate) fn navigation_deleted(&mut self, id: NodeId) {
        self.navigation.parked.retain(|&root| root != id);
        self.navigation.set_track(id, None);
    }

    /// Whether this node must stay mounted for its own or an ancestor's exit.
    pub(crate) fn navigation_retains(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            if self
                .navigation
                .track(id)
                .is_some_and(|track| track.completion.exiting())
            {
                return true;
            }
            current = self.node(id).and_then(|node| node.parent);
        }
        false
    }

    /// Starts an exit if this is a visible navigation root, otherwise inherits
    /// an ancestor's exit. The caller defers both Remove and Delete while true.
    pub(crate) fn navigation_removing(&mut self, id: NodeId) -> bool {
        if self.navigation.moving.contains(&id) {
            return false;
        }
        if self.navigation_retains(id) {
            if let Some(track) = self.navigation.track_mut(id)
                && track.completion == Completion::Pop
            {
                track.completion = Completion::Detach;
            }
            return true;
        }
        let Some(node) = self.node(id) else {
            return false;
        };
        if node.parent.is_none() || node.popped {
            return false;
        }
        let modal = node.kind == ViewKind::Modal;
        if !modal && node.kind != ViewKind::Screen {
            return false;
        }
        let below = if modal {
            None
        } else {
            let Some(parent) = node.parent else {
                return false;
            };
            if self.navigation_top(parent) != Some(id) {
                return false;
            }
            self.navigation_previous(id)
        };
        let motion = if modal {
            modal_motion(node.modal.animation, self.reduce_motion)
        } else {
            screen_motion(node.screen.animation, self.reduce_motion)
        };
        let from = self
            .navigation
            .track(id)
            .map_or(0.0, |track| track.fraction(self.now));
        let Some((movement, duration)) = motion else {
            self.navigation.set_track(id, None);
            self.navigation_complete_subtree(id);
            if modal && self.navigation.modals.contains(&id) {
                self.navigation.modals.retain(|&modal| modal != id);
                self.emit(id, EventKind::Dismiss, EventPayload::None);
            }
            return false;
        };
        self.navigation.set_track(
            id,
            Some(Track {
                movement,
                position: Position::Timed {
                    from,
                    to: 1.0,
                    started: self.now,
                    duration: duration * (1.0 - from) as f64,
                },
                below,
                completion: Completion::Detach,
                modal,
            }),
        );
        true
    }

    /// Applies the final state of a commit, after configs, frames and children
    /// have arrived. First screens appear directly; subsequent pushes animate.
    pub(crate) fn navigation_reconcile(&mut self) {
        self.navigation.moving.clear();
        let stacks: Vec<_> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(id, node)| {
                let node = node.as_ref()?;
                (node.kind == ViewKind::Stack && self.navigation_attached(id as NodeId))
                    .then_some(id as NodeId)
            })
            .collect();
        let mut next_stacks = Vec::new();
        for stack in stacks {
            let Some(top) = self.navigation_top(stack) else {
                continue;
            };
            let old = self
                .navigation
                .stacks
                .iter()
                .find(|(id, _)| *id == stack)
                .map(|(_, top)| *top);
            if let Some(old) = old.filter(|&old| old != top)
                && !self.navigation_retains(old)
                && self.node(old).is_some_and(|node| !node.popped)
                && self.navigation.track(top).is_none()
                && let Some((movement, duration)) = self
                    .node(top)
                    .and_then(|node| screen_motion(node.screen.animation, self.reduce_motion))
            {
                self.navigation.set_track(
                    top,
                    Some(Track {
                        movement,
                        position: Position::Timed {
                            from: 1.0,
                            to: 0.0,
                            started: self.now,
                            duration,
                        },
                        below: self
                            .node(old)
                            .filter(|node| node.parent == Some(stack))
                            .map(|_| old),
                        completion: Completion::Enter,
                        modal: false,
                    }),
                );
            }
            next_stacks.push((stack, top));
        }
        self.navigation.stacks = next_stacks;

        let mut modals: Vec<_> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(id, node)| {
                let node = node.as_ref()?;
                (node.kind == ViewKind::Modal
                    && self.navigation_attached(id as NodeId)
                    && !node.popped
                    && !self.navigation_retains(id as NodeId))
                .then_some(id as NodeId)
            })
            .collect();
        modals.sort_by_key(|id| {
            self.navigation
                .presentations
                .iter()
                .position(|modal| modal == id)
                .unwrap_or(usize::MAX)
        });
        for &id in &modals {
            if self.navigation.modals.contains(&id) {
                continue;
            }
            self.navigation.modals.push(id);
            let config = self.node(id).expect("modal collected above").modal;
            if let Some((movement, duration)) = modal_motion(config.animation, self.reduce_motion) {
                self.navigation.set_track(
                    id,
                    Some(Track {
                        movement,
                        position: Position::Timed {
                            from: 1.0,
                            to: 0.0,
                            started: self.now,
                            duration,
                        },
                        below: None,
                        completion: Completion::Enter,
                        modal: true,
                    }),
                );
            } else {
                self.emit(id, EventKind::Show, EventPayload::None);
            }
        }
        let mut dismissed = Vec::new();
        let retained_modals: Vec<_> = self
            .navigation
            .modals
            .iter()
            .copied()
            .filter(|&id| self.navigation_retains(id))
            .collect();
        self.navigation.modals.retain(|id| {
            let alive = modals.contains(id)
                || retained_modals.contains(id)
                || self.navigation.parked.contains(id);
            if !alive {
                dismissed.push(*id);
            }
            alive
        });
        for id in dismissed {
            self.navigation.set_track(id, None);
            self.emit(id, EventKind::Dismiss, EventPayload::None);
        }
        self.navigation_report_geometry();
    }

    fn navigation_report_geometry(&mut self) {
        let roots: Vec<_> = self
            .nodes
            .iter()
            .enumerate()
            .filter_map(|(id, node)| {
                let node = node.as_ref()?;
                (self.navigation_attached(id as NodeId)
                    && matches!(node.kind, ViewKind::Screen | ViewKind::Modal)
                    && !node.popped)
                    .then_some(id as NodeId)
            })
            .collect();
        for id in roots {
            let node = self.node(id).expect("navigation root collected above");
            let size = if node.kind == ViewKind::Modal {
                self.viewport()
            } else {
                node.parent
                    .and_then(|id| self.node(id))
                    .map_or(node.frame.size, |parent| parent.frame.size)
            };
            let insets = EdgeInsets::default();
            if size.width <= Points::ZERO || size.height <= Points::ZERO {
                continue;
            }
            self.navigation
                .reports
                .resize(self.navigation.reports.len().max(id as usize + 1), None);
            let old = self.navigation.reports[id as usize];
            if old == Some((size, insets)) {
                continue;
            }
            self.navigation.reports[id as usize] = Some((size, insets));
            self.events.push(SurfaceEvent::RootSize(id, size, insets));
            if old.is_none_or(|(_, old)| old != insets) {
                let value = |value: Points| PayloadValue::Number(value.0 as f64);
                self.emit(
                    id,
                    EventKind::Insets,
                    EventPayload::Map(vec![
                        ("top", value(insets.top)),
                        ("right", value(insets.right)),
                        ("bottom", value(insets.bottom)),
                        ("left", value(insets.left)),
                    ]),
                );
            }
        }
    }

    /// Advances the presentation clock and reports lifecycle completions once.
    pub(crate) fn navigation_tick(&mut self) -> bool {
        let mut due = Vec::new();
        let mut active = false;
        for (id, track) in self.navigation.tracks.iter().enumerate() {
            let Some(track) = track else { continue };
            active = true;
            if track.position.finished(self.now) {
                due.push(id as NodeId);
            }
        }
        due.sort_by_key(|&id| self.navigation_depth(id));
        for id in due {
            let Some(track) = self.navigation.tracks[id as usize].take() else {
                continue;
            };
            match track.completion {
                Completion::Enter if track.modal => {
                    if self.navigation_attached(id) && !self.navigation_retains(id) {
                        self.emit(id, EventKind::Show, EventPayload::None);
                    }
                }
                Completion::Enter | Completion::Restore => {}
                Completion::Detach => {
                    if track.modal {
                        self.navigation.modals.retain(|&modal| modal != id);
                        self.emit(id, EventKind::Dismiss, EventPayload::None);
                    }
                    self.navigation_complete_subtree(id);
                    self.finish_retained_removal(id);
                }
                Completion::Pop => {
                    if track.modal {
                        self.navigation.modals.retain(|&modal| modal != id);
                    }
                    self.navigation_complete_subtree(id);
                    self.emit(id, EventKind::Dismiss, EventPayload::None);
                }
            }
        }
        if active {
            self.reconcile_focus(false);
        }
        active
    }

    fn navigation_complete_subtree(&mut self, root: NodeId) {
        let mut descendants = self
            .node(root)
            .map_or_else(Vec::new, |node| node.children.clone());
        let mut index = 0;
        while index < descendants.len() {
            if let Some(node) = self.node(descendants[index]) {
                descendants.extend(node.children.iter().copied());
            }
            index += 1;
        }
        for &id in &descendants {
            let native_pop = self
                .navigation
                .track(id)
                .is_some_and(|track| track.completion == Completion::Pop);
            let modal = self.navigation.modals.contains(&id);
            self.navigation.set_track(id, None);
            if modal {
                self.navigation.modals.retain(|&modal| modal != id);
            }
            if modal || native_pop {
                self.emit(id, EventKind::Dismiss, EventPayload::None);
            }
            if let Some(report) = self.navigation.reports.get_mut(id as usize) {
                *report = None;
            }
        }
        self.navigation
            .stacks
            .retain(|(id, _)| !descendants.contains(id));
        if self
            .navigation
            .gesture
            .as_ref()
            .is_some_and(|gesture| gesture.id == root || descendants.contains(&gesture.id))
        {
            self.navigation.gesture = None;
        }
    }

    /// Whether the terminal needs another presentation frame.
    pub(crate) fn navigation_animating(&self) -> bool {
        self.navigation.tracks.iter().any(Option::is_some)
    }

    /// Orders pending modal layers by when they were presented. Apply to
    /// the unpainted suffix again after discovering a nested modal: its
    /// presentation may precede another pending sibling's. Retained exits
    /// keep their original position until the departure finishes.
    pub(crate) fn navigation_order_modals(&self, modals: &mut [NodeId]) {
        modals.sort_by_key(|id| {
            self.navigation
                .modals
                .iter()
                .position(|modal| modal == id)
                .unwrap_or(usize::MAX)
        });
    }

    /// The local presentation shift and opacity on a root or underlying screen.
    pub(crate) fn navigation_values(&self, id: NodeId) -> (f32, f32, f32) {
        let mut result = (0.0, 0.0, 1.0);
        if let Some(track) = self.navigation.track(id) {
            let position = track.fraction(self.now);
            match track.movement {
                Movement::Horizontal => {
                    result.0 += self.node(id).map_or(0.0, |node| node.frame.size.width.0) * position
                }
                Movement::Vertical => {
                    let frame = self
                        .node(id)
                        .map_or(Bounds::default(), |node| self.modal_frame(id, node.frame));
                    result.1 += (self.viewport().height - frame.origin.y)
                        .max(Points::ZERO)
                        .0
                        * position;
                }
                Movement::Fade => result.2 *= 1.0 - position,
            }
        }
        // Only screens can be another track's underlying route. Ordinary
        // nodes are sampled repeatedly while walking their ancestors; a
        // modal with a high id must not make each sample scan its dense slots.
        if !self
            .node(id)
            .is_some_and(|node| node.kind == ViewKind::Screen)
        {
            return result;
        }
        for track in self
            .navigation
            .tracks
            .iter()
            .flatten()
            .filter(|track| track.below == Some(id))
        {
            if track.movement == Movement::Horizontal {
                let covered = 1.0 - track.fraction(self.now);
                result.0 -=
                    self.node(id).map_or(0.0, |node| node.frame.size.width.0) * PARALLAX * covered;
                result.2 *= 1.0 - DIM * covered;
            }
        }
        result
    }

    /// The top screen and a transition's departing/underlying screen paint.
    pub(crate) fn navigation_draws_screen(&self, stack: NodeId, id: NodeId) -> bool {
        self.navigation_top(stack) == Some(id)
            || self.navigation.track(id).is_some()
            || self
                .navigation
                .tracks
                .iter()
                .flatten()
                .any(|track| track.below == Some(id))
    }

    /// Departing trees retain their pixels, but leave the active input scope.
    pub(crate) fn navigation_accepts(&self, id: NodeId) -> bool {
        let id = self.focus_owner(id).unwrap_or(id);
        if self.navigation_retains(id) {
            return false;
        }
        let mut current = Some(id);
        while let Some(id) = current {
            let Some(node) = self.node(id) else {
                return false;
            };
            if node.popped {
                return false;
            }
            if node.kind == ViewKind::Screen
                && let Some(stack) = node.parent
                && self
                    .node(stack)
                    .is_some_and(|node| node.kind == ViewKind::Stack)
                && self.navigation_top(stack) != Some(id)
            {
                return false;
            }
            current = node.parent;
        }
        true
    }

    fn navigation_top(&self, stack: NodeId) -> Option<NodeId> {
        self.node(stack)?
            .children
            .iter()
            .rev()
            .copied()
            .find(|&id| {
                self.node(id)
                    .is_some_and(|node| node.kind == ViewKind::Screen && !node.popped)
                    && !self.navigation_retains(id)
            })
    }

    fn navigation_previous(&self, screen: NodeId) -> Option<NodeId> {
        let stack = self.node(screen)?.parent?;
        let mut previous = None;
        for &id in &self.node(stack)?.children {
            if id == screen {
                return previous;
            }
            if self
                .node(id)
                .is_some_and(|node| node.kind == ViewKind::Screen && !node.popped)
                && !self.navigation_retains(id)
            {
                previous = Some(id);
            }
        }
        None
    }

    /// Whether a screen has an earlier route for its native back button.
    pub(crate) fn navigation_can_back(&self, screen: NodeId) -> bool {
        self.navigation_previous(screen).is_some()
    }

    /// Goes back in the innermost active stack, then asks its modal to close.
    /// Mounted preventBack/closeOnEscape props decide before JS receives events.
    pub(crate) fn navigation_back(&mut self) {
        let ids = self.visible_ids();
        let screen = ids.iter().rev().copied().find(|&id| {
            self.node(id)
                .is_some_and(|node| node.kind == ViewKind::Screen)
                && (self.navigation_can_back(id)
                    || self.node(id).is_some_and(|node| node.screen.prevent_back))
        });
        if let Some(screen) = screen {
            self.emit(screen, EventKind::BackRequest, EventPayload::None);
            if !self
                .node(screen)
                .is_some_and(|node| node.screen.prevent_back)
            {
                self.navigation_pop(screen, None);
            }
            return;
        }
        if let Some(modal) = ids.into_iter().rev().find(|&id| {
            self.node(id)
                .is_some_and(|node| node.kind == ViewKind::Modal)
        }) {
            self.navigation_request_close(modal);
        }
    }

    /// Escape asks a dialog to close, even when its mounted gate prevents it.
    /// App backdrop presses remain ordinary app input, as on other desktops.
    pub(crate) fn navigation_request_close(&mut self, id: NodeId) {
        if !self
            .node(id)
            .is_some_and(|node| node.kind == ViewKind::Modal && !node.popped)
        {
            return;
        }
        self.emit(
            id,
            EventKind::RequestClose,
            EventPayload::Map(vec![("reason", PayloadValue::Str("cancel".into()))]),
        );
        if self.node(id).is_some_and(|node| node.modal.close_on_escape) {
            self.navigation_pop(id, None);
        }
    }

    fn navigation_pop(&mut self, id: NodeId, position: Option<f32>) {
        let Some(node) = self.node(id) else { return };
        if node.popped {
            return;
        }
        let modal = node.kind == ViewKind::Modal;
        let below = if modal {
            None
        } else {
            self.navigation_previous(id)
        };
        let configured = if modal {
            modal_motion(node.modal.animation, self.reduce_motion)
        } else {
            screen_motion(node.screen.animation, self.reduce_motion)
        };
        let motion = if position.is_some() {
            // An interactive drag continues in its current direction even
            // when the configured noninteractive transition is a fade.
            self.navigation
                .track(id)
                .map(|track| {
                    let duration = if track.movement == Movement::Fade {
                        FADE_SECONDS
                    } else {
                        SLIDE_SECONDS
                    };
                    (track.movement, duration)
                })
                .or(configured)
        } else {
            configured
        };
        let from = position.unwrap_or_else(|| {
            self.navigation
                .track(id)
                .map_or(0.0, |track| track.fraction(self.now))
        });
        if let Some(node) = self.node_mut(id) {
            node.popped = true;
        }
        match motion {
            Some((movement, duration)) => self.navigation.set_track(
                id,
                Some(Track {
                    movement,
                    position: Position::Timed {
                        from,
                        to: 1.0,
                        started: self.now,
                        duration: (duration * (1.0 - from) as f64).max(0.01),
                    },
                    below,
                    completion: Completion::Pop,
                    modal,
                }),
            ),
            None => {
                self.navigation.set_track(id, None);
                self.navigation_complete_subtree(id);
                if modal {
                    self.navigation.modals.retain(|&modal| modal != id);
                }
                self.emit(id, EventKind::Dismiss, EventPayload::None);
            }
        }
        self.reconcile_focus(false);
    }

    /// Dialogs cover the viewport; their appearance belongs to the app.
    pub(crate) fn modal_frame(&self, id: NodeId, target: Bounds<Points>) -> Bounds<Points> {
        if self
            .node(id)
            .is_some_and(|node| node.kind == ViewKind::Modal)
        {
            Bounds::new(Point::default(), self.viewport())
        } else {
            target
        }
    }

    /// Starts a candidate; presses still belong to the app until a directional
    /// drag passes a cell. Screen gestures respect the mounted back gates.
    pub(crate) fn navigation_pointer_down(&mut self, x: f32, y: f32) -> bool {
        self.navigation.gesture = None;
        if self.dialog.is_some() {
            return false;
        }
        let ids = self.visible_ids();
        for id in ids.into_iter().rev() {
            let Some(node) = self.node(id).filter(|node| node.kind == ViewKind::Screen) else {
                continue;
            };
            if !node.screen.gesture_enabled
                || node.screen.prevent_back
                || self.navigation.track(id).is_some()
            {
                continue;
            }
            let Some(below) = self.navigation_previous(id) else {
                continue;
            };
            let Some(frame) = self.global_frame(id) else {
                continue;
            };
            if contains(frame, x, y) && x < (frame.origin.x + self.metrics.width() * 3.0).0 {
                self.navigation.gesture = Some(Gesture {
                    id,
                    below: Some(below),
                    origin: (x, y),
                    last: (x, y),
                    started: self.now,
                    last_time: self.now,
                    velocity: 0.0,
                    extent: frame.size.width.max(self.metrics.width()).0,
                    claimed: false,
                });
                return true;
            }
        }
        false
    }

    /// Returns true once navigation owns this drag and the app's press cancels.
    pub(crate) fn navigation_pointer_drag(&mut self, x: f32, y: f32) -> bool {
        let Some(mut gesture) = self.navigation.gesture.take() else {
            return false;
        };
        let (dx, dy) = (x - gesture.origin.0, y - gesture.origin.1);
        let (distance, other, cell) = (dx, dy.abs(), self.metrics.width().0);
        if !gesture.claimed {
            if other > distance.max(cell) || distance < -cell {
                return false;
            }
            if distance < cell {
                self.navigation.gesture = Some(gesture);
                return false;
            }
            gesture.claimed = true;
        }
        let last = gesture.last.0;
        let current = x;
        let elapsed = self.now - gesture.last_time;
        if elapsed > 0.0 {
            gesture.velocity = (current - last) / elapsed as f32;
        }
        gesture.last = (x, y);
        gesture.last_time = self.now;
        let position = (distance / gesture.extent).clamp(0.0, 1.0);
        self.navigation.set_track(
            gesture.id,
            Some(Track {
                movement: if self.reduce_motion {
                    Movement::Fade
                } else {
                    Movement::Horizontal
                },
                position: Position::Interactive(position),
                below: gesture.below,
                completion: Completion::Restore,
                modal: false,
            }),
        );
        self.navigation.gesture = Some(gesture);
        true
    }

    /// Completes a directional gesture or returns to the current route.
    pub(crate) fn navigation_pointer_up(&mut self, x: f32, _y: f32) -> bool {
        let Some(gesture) = self.navigation.gesture.take() else {
            return false;
        };
        if !gesture.claimed {
            return false;
        }
        let distance = x - gesture.origin.0;
        let position = (distance / gesture.extent).clamp(0.0, 1.0);
        let elapsed = (self.now - gesture.started).max(0.001) as f32;
        let velocity = if self.now - gesture.last_time < 0.1 {
            gesture.velocity
        } else {
            distance / elapsed
        };
        if position >= 0.35 || (position > 0.05 && velocity > gesture.extent * 0.5) {
            self.emit(gesture.id, EventKind::BackRequest, EventPayload::None);
            if self
                .node(gesture.id)
                .is_some_and(|node| node.screen.prevent_back)
            {
                self.navigation_restore(gesture.id, position);
            } else {
                self.navigation_pop(gesture.id, Some(position));
            }
        } else {
            self.navigation_restore(gesture.id, position);
        }
        true
    }

    fn navigation_restore(&mut self, id: NodeId, position: f32) {
        if let Some(track) = self.navigation.track_mut(id) {
            track.position = Position::Timed {
                from: position,
                to: 0.0,
                started: self.now,
                duration: FADE_SECONDS,
            };
            track.completion = Completion::Restore;
        }
    }

    /// Removal revokes a held route. Keep an actual exit; restore a screen
    /// which survives, including one reinserted in this batch.
    pub(crate) fn retire_navigation_pointer(&mut self, root: NodeId) -> bool {
        let within = |id| self.ancestors(id).contains(&root);
        let Some(gesture) = self.navigation.gesture.as_ref() else {
            return false;
        };
        if !within(gesture.id) && !gesture.below.is_some_and(within) {
            return false;
        }
        if self.navigation_retains(gesture.id) {
            self.navigation.gesture = None;
        } else {
            self.navigation_pointer_cancel();
        }
        true
    }

    pub(crate) fn navigation_pointer_owner(&self) -> Option<NodeId> {
        self.navigation
            .gesture
            .as_ref()
            .filter(|gesture| gesture.claimed)
            .map(|gesture| gesture.id)
    }

    /// Losing pointer capture restores an interactive route without dismissing.
    pub(crate) fn navigation_pointer_cancel(&mut self) {
        if let Some(gesture) = self.navigation.gesture.take()
            && gesture.claimed
        {
            let position = self
                .navigation
                .track(gesture.id)
                .map_or(0.0, |track| track.fraction(self.now));
            self.navigation_restore(gesture.id, position);
        }
    }
}

fn screen_motion(animation: ScreenAnimation, reduce_motion: bool) -> Option<(Movement, f64)> {
    match animation {
        ScreenAnimation::None => None,
        ScreenAnimation::Fade => Some((Movement::Fade, FADE_SECONDS)),
        ScreenAnimation::Default if reduce_motion => Some((Movement::Fade, FADE_SECONDS)),
        ScreenAnimation::Default => Some((Movement::Horizontal, SLIDE_SECONDS)),
    }
}

fn modal_motion(animation: ModalAnimation, reduce_motion: bool) -> Option<(Movement, f64)> {
    match animation {
        ModalAnimation::None => None,
        ModalAnimation::Fade => Some((Movement::Fade, FADE_SECONDS)),
        ModalAnimation::Slide if reduce_motion => Some((Movement::Fade, FADE_SECONDS)),
        ModalAnimation::Slide => Some((Movement::Vertical, SLIDE_SECONDS)),
    }
}

fn contains(frame: Bounds<Points>, x: f32, y: f32) -> bool {
    frame.contains(&Point::new(px(x), px(y)))
}

#[cfg(test)]
mod tests {
    use nsh_core::{ModalConfig, ModalPresentation, ROOT_ID, ScreenConfig};

    use super::*;
    use crate::CellMetrics;

    fn frame() -> Bounds<Points> {
        Bounds::new(Point::default(), Size::new(px(800.0), px(640.0)))
    }

    fn stack() -> Surface {
        let mut surface = Surface::new(100, 40, CellMetrics::default());
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 2,
                    kind: ViewKind::Stack,
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
                MountItem::Frame {
                    id: 2,
                    frame: frame(),
                },
                MountItem::Create {
                    id: 4,
                    kind: ViewKind::Screen,
                },
                MountItem::Insert {
                    parent: 2,
                    child: 4,
                    before: None,
                },
                MountItem::Frame {
                    id: 4,
                    frame: frame(),
                },
            ],
        });
        surface.drain_events().for_each(drop);
        surface
    }

    fn push(surface: &mut Surface, animation: ScreenAnimation) {
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 6,
                    kind: ViewKind::Screen,
                },
                MountItem::ScreenConfig {
                    id: 6,
                    config: Box::new(ScreenConfig {
                        animation,
                        ..ScreenConfig::default()
                    }),
                },
                MountItem::Insert {
                    parent: 2,
                    child: 6,
                    before: None,
                },
                MountItem::Frame {
                    id: 6,
                    frame: frame(),
                },
            ],
        });
    }

    fn events(surface: &mut Surface, kind: EventKind) -> Vec<NodeId> {
        surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, event, _) if event == kind => Some(id),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_push_moves_the_new_screen_and_retains_the_previous_during_motion() {
        let mut surface = stack();
        assert!(!surface.navigation_animating());
        push(&mut surface, ScreenAnimation::Default);
        assert_eq!(surface.navigation_values(6).0, 800.0);
        assert!(surface.navigation_draws_screen(2, 4));
        surface.tick(0.15);
        assert!((surface.navigation_values(6).0 - 100.0).abs() < 0.01);
        assert!(surface.navigation_values(4).0 < 0.0);
        surface.tick(0.31);
        assert_eq!(surface.navigation_values(6), (0.0, 0.0, 1.0));
        assert!(!surface.navigation_draws_screen(2, 4));
        assert!(!surface.navigation_animating());
    }

    #[test]
    fn mounted_back_gates_apply_before_any_javascript_response() {
        let mut surface = stack();
        push(&mut surface, ScreenAnimation::None);
        surface.node_mut(6).unwrap().screen.prevent_back = true;
        surface.navigation_back();
        assert!(!surface.node(6).unwrap().popped);
        assert_eq!(events(&mut surface, EventKind::BackRequest), vec![6]);
        assert!(!surface.navigation_pointer_down(0.0, 80.0));
        surface.node_mut(6).unwrap().screen.prevent_back = false;
        surface.navigation_back();
        assert!(surface.node(6).unwrap().popped);
        assert_eq!(events(&mut surface, EventKind::Dismiss), vec![6]);
    }

    #[test]
    fn the_first_screen_can_request_back_without_being_popped() {
        let mut surface = stack();
        surface.node_mut(4).unwrap().screen.prevent_back = true;
        surface.navigation_back();
        assert!(!surface.node(4).unwrap().popped);
        assert_eq!(events(&mut surface, EventKind::BackRequest), vec![4]);
    }

    #[test]
    fn native_pop_stays_visible_until_exit_finishes_and_reports_once() {
        let mut surface = stack();
        push(&mut surface, ScreenAnimation::Default);
        surface.tick(0.31);
        surface.navigation_back();
        assert!(surface.node(6).unwrap().popped);
        assert!(surface.navigation_draws_screen(2, 6));
        assert!(!surface.navigation_accepts(6));
        assert!(events(&mut surface, EventKind::Dismiss).is_empty());
        surface.tick(0.62);
        assert_eq!(events(&mut surface, EventKind::Dismiss), vec![6]);
        surface.tick(1.0);
        assert!(events(&mut surface, EventKind::Dismiss).is_empty());
        assert!(surface.node(6).is_some());
    }

    #[test]
    fn parking_during_a_native_pop_completes_its_existing_dismiss_once() {
        let mut surface = stack();
        push(&mut surface, ScreenAnimation::Default);
        surface.tick(0.31);
        surface.drain_events().for_each(drop);
        surface.navigation_back();
        assert!(surface.node(6).unwrap().popped);
        surface.apply(MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 2,
                request: 1,
                roots: vec![2, 4, 6],
            }],
        });
        assert_eq!(events(&mut surface, EventKind::Dismiss), vec![6]);
        surface.tick(1.0);
        assert!(events(&mut surface, EventKind::Dismiss).is_empty());
        surface.apply(MountBatch {
            items: vec![
                MountItem::ProjectRoot {
                    parent: ROOT_ID,
                    id: 2,
                    following: vec![],
                },
                MountItem::ProjectRoot {
                    parent: 2,
                    id: 4,
                    following: vec![6],
                },
                MountItem::ProjectRoot {
                    parent: 2,
                    id: 6,
                    following: vec![],
                },
            ],
        });
        assert!(surface.node(6).unwrap().popped);
        assert!(events(&mut surface, EventKind::Dismiss).is_empty());
        assert!(!surface.visible_ids().contains(&6));
    }

    #[test]
    fn descendant_deletes_before_their_screen_keep_pixels_until_exit() {
        let mut surface = stack();
        push(&mut surface, ScreenAnimation::Default);
        surface.tick(0.31);
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 8,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: 6,
                    child: 8,
                    before: None,
                },
            ],
        });
        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 8 }, MountItem::Delete { id: 6 }],
        });
        assert!(surface.node(8).is_some());
        assert!(surface.node(6).is_some());
        assert!(!surface.navigation_accepts(8));
        surface.tick(0.62);
        assert!(surface.node(8).is_none());
        assert!(surface.node(6).is_none());
        assert_eq!(surface.node(2).unwrap().children, vec![4]);
    }

    #[test]
    fn moving_a_screen_does_not_preserve_children_removed_in_the_same_commit() {
        let mut surface = stack();
        push(&mut surface, ScreenAnimation::Default);
        surface.tick(0.31);
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 8,
                    kind: ViewKind::View,
                },
                MountItem::Insert {
                    parent: 6,
                    child: 8,
                    before: None,
                },
            ],
        });
        surface.apply(MountBatch {
            items: vec![
                MountItem::Remove { id: 8 },
                MountItem::Remove { id: 6 },
                MountItem::Insert {
                    parent: 2,
                    child: 6,
                    before: None,
                },
            ],
        });
        assert_eq!(surface.node(8).unwrap().parent, None);
        assert_eq!(surface.node(6).unwrap().parent, Some(2));
        assert!(!surface.navigation_retains(6));
    }

    #[test]
    fn modal_lifecycle_follows_finite_fades_and_escape_gate() {
        let mut surface = stack();
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 8,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig {
                    id: 8,
                    config: ModalConfig {
                        animation: ModalAnimation::Fade,
                        close_on_escape: false,
                        ..ModalConfig::default()
                    },
                },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 8,
                    before: None,
                },
                MountItem::Frame {
                    id: 8,
                    frame: frame(),
                },
            ],
        });
        assert!(events(&mut surface, EventKind::Show).is_empty());
        surface.tick(0.1);
        assert!(surface.navigation_values(8).2 > 0.5);
        surface.tick(0.21);
        assert_eq!(events(&mut surface, EventKind::Show), vec![8]);
        surface.navigation_request_close(8);
        assert!(!surface.node(8).unwrap().popped);
        let close = surface.drain_events().find_map(|event| match event {
            SurfaceEvent::Event(8, EventKind::RequestClose, payload) => Some(payload),
            _ => None,
        });
        assert_eq!(
            close,
            Some(EventPayload::Map(vec![(
                "reason",
                PayloadValue::Str("cancel".into())
            )]))
        );
        surface.node_mut(8).unwrap().modal.close_on_escape = true;
        surface.navigation_request_close(8);
        assert!(surface.node(8).unwrap().popped);
        surface.tick(0.42);
        assert_eq!(events(&mut surface, EventKind::Dismiss), vec![8]);
    }

    #[test]
    fn reopened_earlier_sibling_is_the_top_modal_and_active_scope() {
        let mut surface = stack();
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 8,
                    kind: ViewKind::Modal,
                },
                MountItem::Create {
                    id: 10,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig {
                    id: 8,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        ..ModalConfig::default()
                    },
                },
                MountItem::ModalConfig {
                    id: 10,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        ..ModalConfig::default()
                    },
                },
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 10,
                    before: None,
                },
            ],
        });
        for _ in 0..2 {
            surface.apply(MountBatch {
                items: vec![MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 8,
                    before: Some(10),
                }],
            });
            let layers: Vec<_> = surface
                .paint_ids()
                .into_iter()
                .filter(|&id| {
                    surface
                        .node(id)
                        .is_some_and(|node| node.kind == ViewKind::Modal)
                })
                .collect();
            assert_eq!(layers, vec![10, 8]);
            assert_eq!(surface.visible_ids().first(), Some(&8));
            assert!(!surface.visible_ids().contains(&10));
            surface.apply(MountBatch {
                items: vec![MountItem::Remove { id: 8 }],
            });
            assert_eq!(surface.visible_ids().first(), Some(&10));
        }
        surface.apply(MountBatch {
            items: vec![MountItem::Insert {
                parent: nsh_core::ROOT_ID,
                child: 8,
                before: Some(10),
            }],
        });
        surface.apply(MountBatch {
            items: vec![MountItem::ModalConfig {
                id: 8,
                config: ModalConfig {
                    animation: ModalAnimation::Fade,
                    ..ModalConfig::default()
                },
            }],
        });
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 8 }],
        });
        assert_eq!(surface.paint_ids().last(), Some(&8));
        assert!(surface.visible_ids().is_empty());
        surface.tick(0.21);
        assert_eq!(surface.visible_ids().first(), Some(&10));
    }

    #[test]
    fn a_nested_modal_opened_before_a_sibling_stays_below_that_sibling() {
        let mut surface = stack();
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 8,
                    kind: ViewKind::Modal,
                },
                MountItem::Create {
                    id: 12,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig {
                    id: 8,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        ..ModalConfig::default()
                    },
                },
                MountItem::ModalConfig {
                    id: 12,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        ..ModalConfig::default()
                    },
                },
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 8,
                    before: None,
                },
                MountItem::Insert {
                    parent: 8,
                    child: 12,
                    before: None,
                },
            ],
        });
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 10,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig {
                    id: 10,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        ..ModalConfig::default()
                    },
                },
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 10,
                    before: None,
                },
            ],
        });
        let layers: Vec<_> = surface
            .paint_ids()
            .into_iter()
            .filter(|&id| {
                surface
                    .node(id)
                    .is_some_and(|node| node.kind == ViewKind::Modal)
            })
            .collect();
        assert_eq!(layers, vec![8, 12, 10]);
        assert_eq!(surface.visible_ids().first(), Some(&10));
        assert!(!surface.visible_ids().contains(&12));
    }

    #[test]
    fn modal_insert_order_and_reopening_during_exit_both_bring_the_last_to_front() {
        let mut surface = stack();
        surface.apply(MountBatch {
            items: vec![
                MountItem::Create {
                    id: 8,
                    kind: ViewKind::Modal,
                },
                MountItem::Create {
                    id: 10,
                    kind: ViewKind::Modal,
                },
                MountItem::ModalConfig {
                    id: 8,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        ..ModalConfig::default()
                    },
                },
                MountItem::ModalConfig {
                    id: 10,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        ..ModalConfig::default()
                    },
                },
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 10,
                    before: None,
                },
                MountItem::Insert {
                    parent: nsh_core::ROOT_ID,
                    child: 8,
                    before: Some(10),
                },
            ],
        });
        assert_eq!(surface.navigation.modals, vec![10, 8]);
        assert_eq!(surface.visible_ids().first(), Some(&8));
        surface.apply(MountBatch {
            items: vec![MountItem::ModalConfig {
                id: 10,
                config: ModalConfig {
                    animation: ModalAnimation::Fade,
                    ..ModalConfig::default()
                },
            }],
        });
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        assert!(surface.navigation_retains(10));
        assert_eq!(surface.visible_ids().first(), Some(&8));
        surface.apply(MountBatch {
            items: vec![MountItem::Insert {
                parent: nsh_core::ROOT_ID,
                child: 10,
                before: Some(8),
            }],
        });
        assert!(!surface.navigation_retains(10));
        assert_eq!(surface.navigation.modals, vec![8, 10]);
        assert_eq!(surface.visible_ids().first(), Some(&10));
        surface.tick(0.21);
        assert_eq!(surface.paint_ids().last(), Some(&10));
    }

    #[test]
    fn dialog_presentations_all_cover_the_viewport_without_a_native_card() {
        let mut surface = Surface::new(150, 50, CellMetrics::default());
        surface.apply(MountBatch {
            items: vec![MountItem::Create {
                id: 8,
                kind: ViewKind::Modal,
            }],
        });
        for presentation in [
            ModalPresentation::PageSheet,
            ModalPresentation::FormSheet,
            ModalPresentation::FullScreen,
        ] {
            surface.node_mut(8).unwrap().modal.presentation = presentation;
            assert_eq!(
                surface.modal_frame(8, frame()),
                Bounds::new(Point::default(), Size::new(px(1200.0), px(800.0)))
            );
        }
    }

    #[test]
    fn reduced_motion_uses_a_fade_and_none_is_immediate() {
        assert_eq!(
            screen_motion(ScreenAnimation::Default, true),
            Some((Movement::Fade, FADE_SECONDS))
        );
        assert_eq!(
            modal_motion(ModalAnimation::Slide, true),
            Some((Movement::Fade, FADE_SECONDS))
        );
        assert_eq!(screen_motion(ScreenAnimation::None, true), None);
        let mut surface = stack();
        surface.reduce_motion = true;
        push(&mut surface, ScreenAnimation::Default);
        assert_eq!(surface.navigation_values(6), (0.0, 0.0, 0.0));
        surface.tick(0.21);
        assert!(!surface.navigation_animating());
    }

    #[test]
    fn interactive_back_can_cancel_then_complete_without_app_callbacks() {
        let mut surface = stack();
        push(&mut surface, ScreenAnimation::Default);
        surface.tick(0.31);
        assert!(surface.navigation_pointer_down(0.0, 80.0));
        surface.tick(0.5);
        assert!(surface.navigation_pointer_drag(80.0, 80.0));
        surface.tick(1.0);
        assert!(surface.navigation_pointer_up(80.0, 80.0));
        assert!(!surface.node(6).unwrap().popped);
        surface.tick(1.21);
        assert_eq!(surface.navigation_values(6), (0.0, 0.0, 1.0));
        assert!(surface.navigation_pointer_down(0.0, 80.0));
        surface.tick(1.5);
        assert!(surface.navigation_pointer_drag(400.0, 80.0));
        assert!(surface.navigation_pointer_up(400.0, 80.0));
        assert!(surface.node(6).unwrap().popped);
        surface.tick(1.8);
        assert_eq!(events(&mut surface, EventKind::Dismiss), vec![6]);

        for change in ["move", "below", "owner", "reinsert", "both"] {
            let mut surface = stack();
            push(&mut surface, ScreenAnimation::Default);
            surface.tick(0.31);
            assert!(surface.navigation_pointer_down(0.0, 80.0));
            assert!(surface.navigation_pointer_drag(80.0, 80.0));
            let items = match change {
                "move" => vec![MountItem::Insert {
                    parent: 2,
                    child: 6,
                    before: None,
                }],
                "below" => vec![MountItem::Remove { id: 4 }],
                "owner" => vec![MountItem::Remove { id: 6 }],
                "reinsert" => vec![
                    MountItem::Remove { id: 6 },
                    MountItem::Insert {
                        parent: 2,
                        child: 6,
                        before: None,
                    },
                ],
                "both" => vec![MountItem::Remove { id: 4 }, MountItem::Remove { id: 6 }],
                _ => unreachable!(),
            };
            surface.apply(MountBatch { items });
            assert_eq!(
                surface.navigation_pointer_drag(400.0, 80.0),
                change == "move"
            );
            if change != "move" {
                surface.tick(1.0);
                if matches!(change, "owner" | "both") {
                    assert_eq!(surface.node(6).unwrap().parent, None);
                } else {
                    assert_eq!(surface.navigation_values(6), (0.0, 0.0, 1.0));
                }
                assert!(!surface.navigation_animating());
            } else {
                assert!(surface.navigation_pointer_up(400.0, 80.0));
                assert!(surface.node(6).unwrap().popped);
            }
        }
    }

    #[test]
    fn native_header_options_do_not_change_screen_geometry_or_insets() {
        let mut surface = stack();
        surface.apply(MountBatch {
            items: vec![
                MountItem::ScreenConfig {
                    id: 4,
                    config: Box::new(ScreenConfig {
                        large_title: true,
                        header_transparent: true,
                        header_height: px(48.0),
                        ..ScreenConfig::default()
                    }),
                },
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(Point::default(), Size::new(px(960.0), px(640.0))),
                },
            ],
        });
        assert!(surface.drain_events().any(|event| matches!(
            event,
            SurfaceEvent::RootSize(4, size, insets)
                if size == Size::new(px(960.0), px(640.0))
                    && insets == EdgeInsets::default()
        )));
    }
}
