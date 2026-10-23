//! Main-thread terminal interaction. Keymaps, editing limits, focus scopes
//! and gesture decisions read mounted state without waiting for JavaScript.

use std::{ops::Range, time::Instant};

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use nsh_core::{
    EventKind, EventPayload, NodeId, PayloadValue, PointerEvents, ROOT_ID, SubmitBehavior,
    TouchEvent, TouchPhase, TouchPoint, ViewKind,
    geometry::{point, px},
    keymap::{Key, KeyMatch, Keystroke, Modifiers},
    overlay::HintObservation,
    tailwind::state,
};

use crate::surface::{Surface, SurfaceEvent};

#[derive(Clone, Copy, PartialEq, Eq)]
struct FocusTarget(NodeId, u64);

#[derive(Clone, Copy, PartialEq, Eq)]
enum FocusScopeKind {
    Popup,
    Modal,
}

#[derive(Clone, Copy)]
pub(crate) struct FocusReturn {
    scope: FocusTarget,
    parent: FocusTarget,
    opener: Option<FocusTarget>,
    kind: FocusScopeKind,
}

pub(crate) struct FocusReturnBatch {
    focus: Option<FocusTarget>,
    owner: Option<FocusTarget>,
    candidates: Vec<NodeId>,
    explicit_focus: bool,
    blurred: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum FocusSource {
    Navigation,
    Pointer,
    Mount,
}

/// A focused input's native editing context for a host's completion,
/// autocorrection or autofill service. Terminal keys remain literal;
/// hosts decide which services to offer from these mounted hints.
#[derive(Clone, Debug, PartialEq)]
pub struct InputContext {
    /// The focused input.
    pub node: NodeId,
    /// Current text, redacted for secure inputs.
    pub text: Option<String>,
    /// Selected UTF-16 range, or the caret when empty.
    pub selection: Range<u32>,
    /// Native edit generation that a replacement must acknowledge.
    pub event_count: u32,
    /// Intended keyboard content.
    pub keyboard: nsh_core::KeyboardType,
    /// Capitalization hint for a host keyboard.
    pub auto_capitalize: nsh_core::AutoCapitalize,
    /// Whether the app requests correction suggestions.
    pub auto_correct: bool,
    /// Autofill content hint.
    pub auto_fill: nsh_core::AutoFill,
    /// The input hides its text; hosts keep automatic suggestions private.
    pub secure: bool,
    /// The mounted input currently accepts edits.
    pub editable: bool,
    /// The input accepts line breaks.
    pub multiline: bool,
    /// Maximum text length in UTF-16 units.
    pub max_length: Option<u32>,
}

/// A literal host-provided replacement. The surface checks its generation,
/// focus, editability, grapheme boundaries and mounted length limit before
/// reporting a native edit to the app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InputEdit {
    /// Input that the host inspected.
    pub node: NodeId,
    /// Native edit generation supplied by [`InputContext`].
    pub expected_event_count: u32,
    /// UTF-16 range to replace.
    pub selection: Range<u32>,
    /// Literal replacement, without automatic capitalization.
    pub replacement: String,
}

/// A terminal reports one mouse pointer. Its retained context also drives
/// long presses while the event loop is otherwise idle.
#[derive(Debug)]
pub(crate) struct Pointer {
    pub(crate) target: NodeId,
    /// The original JS touch stream has not been cancelled.
    reporting: bool,
    /// Touch listeners admitted when this physical contact began.
    touch_path: Vec<NodeId>,
    pressable: Option<NodeId>,
    origin: (f32, f32),
    pub(crate) last: (f32, f32),
    started: Instant,
    pub(crate) moved: bool,
    long_fired: bool,
    pan_candidate: Option<NodeId>,
    pan: Option<NodeId>,
    pan_base: (f32, f32),
    native: Option<NodeId>,
    link: Option<NodeId>,
    scroll: Option<NodeId>,
    button: MouseButton,
    navigation: bool,
    navigation_claimed: bool,
}

impl Surface {
    pub(crate) fn text_link(&self, id: NodeId) -> Option<(NodeId, &nsh_core::TextLink)> {
        if self.node(id).is_some() {
            return None;
        }
        let &(owner, index) = self.text_links.get(&id)?;
        let (text, ..) = self.node(owner)?.text.as_ref()?;
        let link = text.links.get(index)?;
        (link.node == id).then_some((owner, link))
    }

    pub(crate) fn focus_owner(&self, id: NodeId) -> Option<NodeId> {
        self.node(id)
            .map(|_| id)
            .or_else(|| self.text_link(id).map(|(owner, _)| owner))
    }

    pub(crate) fn text_link_bounds(
        &self,
        id: NodeId,
    ) -> Option<(NodeId, nsh_core::Bounds<nsh_core::Points>)> {
        let (owner, link) = self.text_link(id)?;
        let node = self.node(owner)?;
        let (text, layout, content) = node.text.as_ref()?;
        let layout = layout.downcast::<crate::text::TerminalLayout>()?;
        let frame = self.presentation_frame(owner)?;
        let sx = if node.frame.size.width.0 > 0.0 {
            frame.size.width.0 / node.frame.size.width.0
        } else {
            1.0
        };
        let sy = if node.frame.size.height.0 > 0.0 {
            frame.size.height.0 / node.frame.size.height.0
        } else {
            1.0
        };
        let runs = layout
            .runs
            .iter()
            .filter(|run| run.width > 0 && run.start < link.end && run.end > link.start)
            .map(|run| {
                nsh_core::Bounds::new(
                    nsh_core::Point::new(
                        content.origin.x * sx + run.x,
                        content.origin.y * sy + run.y,
                    ),
                    nsh_core::Size::new(
                        f32::from(run.width) * self.metrics.width(),
                        self.metrics.height(),
                    ),
                )
            });
        let attachments = layout
            .attachment_rects(text)
            .filter(|(index, _)| *index >= link.start && *index < link.end)
            .map(|(_, rect)| {
                nsh_core::Bounds::new(
                    nsh_core::Point::new(
                        content.origin.x + rect.origin.x,
                        content.origin.y + rect.origin.y,
                    ),
                    rect.size,
                )
            });
        let mut bounds: Option<nsh_core::Bounds<nsh_core::Points>> = None;
        for rect in runs.chain(attachments) {
            bounds = Some(match bounds {
                None => rect,
                Some(old) => {
                    let x = old.origin.x.min(rect.origin.x);
                    let y = old.origin.y.min(rect.origin.y);
                    nsh_core::Bounds::new(
                        nsh_core::Point::new(x, y),
                        nsh_core::Size::new(
                            (old.origin.x + old.size.width).max(rect.origin.x + rect.size.width)
                                - x,
                            (old.origin.y + old.size.height).max(rect.origin.y + rect.size.height)
                                - y,
                        ),
                    )
                }
            });
        }
        bounds.map(|bounds| (owner, bounds))
    }

    fn within_popup(&self, id: NodeId, root: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            if id == root {
                return true;
            }
            current = self
                .node(id)
                .map(|node| node.parent)
                .unwrap_or_else(|| self.text_link(id).map(|(owner, _)| owner));
        }
        false
    }

    fn focus_target(&self, id: NodeId) -> Option<FocusTarget> {
        self.focus_owner(id)
            .and_then(|owner| self.node(owner))
            .map(|node| FocusTarget(id, node.generation))
    }

    fn current_focus_target(&self) -> Option<FocusTarget> {
        self.focus.and_then(|id| self.focus_target(id))
    }

    fn current_popup_owner(&self) -> Option<&FocusReturn> {
        self.focus_returns.iter().rev().find(|scope| {
            self.focus
                .is_some_and(|id| self.within_popup(id, scope.scope.0))
        })
    }

    fn returnable_focus(&self, target: FocusTarget, shown: &[NodeId]) -> bool {
        self.focus_target(target.0) == Some(target)
            && self
                .focus_owner(target.0)
                .is_some_and(|owner| shown.contains(&owner))
            && !self.is_dying(target.0)
            && self.navigation_accepts(self.focus_owner(target.0).unwrap_or(target.0))
            && self.focusable(target.0)
    }

    /// Follow captured scope owners even after their controls were deleted.
    /// The paint tree keeps a covered opener alive; the input scope decides
    /// separately when focus can actually return to it.
    fn inherited_focus(
        &self,
        scopes: &[FocusReturn],
        mut owner: FocusTarget,
        shown: &[NodeId],
    ) -> Option<FocusTarget> {
        while let Some(scope) = scopes.iter().find(|scope| scope.scope == owner) {
            if let Some(opener) = scope.opener
                && self.returnable_focus(opener, shown)
            {
                return Some(opener);
            }
            owner = scope.parent;
        }
        None
    }

    /// Capture before a batch can autofocus a child or delete its owner.
    pub(crate) fn prepare_focus_return(
        &self,
        batch: &nsh_core::MountBatch,
    ) -> Option<FocusReturnBatch> {
        use nsh_core::{Command, MountItem};
        let mut candidates = Vec::new();
        let mut explicit_focus = false;
        let mut blurred = false;
        let mut changed = false;
        for item in &batch.items {
            match item {
                MountItem::Create {
                    id,
                    kind: ViewKind::Modal,
                } => candidates.push(*id),
                MountItem::ViewProps { id, props } if props.focus_return_parent.is_some() => {
                    candidates.push(*id);
                }
                MountItem::Insert { child, .. }
                | MountItem::ProjectRoot { id: child, .. }
                | MountItem::ViewStyle { id: child, .. }
                    if self.node(*child).is_some_and(|n| {
                        n.kind == ViewKind::Modal || n.props.focus_return_parent.is_some()
                    }) =>
                {
                    candidates.push(*child);
                }
                MountItem::Command {
                    command: Command::Focus | Command::AccessibilityFocus,
                    ..
                } => {
                    explicit_focus = true;
                    blurred = false;
                }
                MountItem::Command {
                    command: Command::Blur,
                    ..
                } => {
                    explicit_focus = true;
                    blurred = true;
                }
                _ => {}
            }
            let changed_id = match item {
                MountItem::Remove { id }
                | MountItem::Delete { id }
                | MountItem::ViewStyle { id, .. }
                | MountItem::ViewProps { id, .. } => Some(*id),
                MountItem::Insert { child, .. } => Some(*child),
                MountItem::ProjectRoot { id, .. } => Some(*id),
                _ => None,
            };
            changed |= changed_id.is_some_and(|id| {
                self.focus_returns
                    .iter()
                    .any(|scope| self.within_popup(scope.scope.0, id))
                    // A pane can lose its focused child without changing
                    // the popup itself. Capture that owner before removal.
                    || (matches!(item, MountItem::Remove { .. } | MountItem::Delete { .. })
                        && self.focus.is_some_and(|focus| self.within_popup(focus, id))
                        && self.current_popup_owner().is_some())
            });
        }
        if candidates.is_empty() && !changed {
            return None;
        }
        Some(FocusReturnBatch {
            focus: self.current_focus_target(),
            owner: self.current_popup_owner().map(|scope| scope.scope),
            candidates,
            explicit_focus,
            blurred,
        })
    }

    /// Only scope records participate: streamed content does not walk the
    /// whole surface to rediscover its scopes on every mount batch.
    pub(crate) fn reconcile_focus_return(
        &mut self,
        batch: Option<FocusReturnBatch>,
    ) -> Vec<NodeId> {
        let Some(mut batch) = batch else {
            return Vec::new();
        };
        let visible = self.visible_ids();
        // A modal covers background popups without ending their lifetime.
        let shown = self.paint_ids();
        let old = std::mem::take(&mut self.focus_returns);
        let blurred = batch.blurred && self.focus.is_none();
        let active = |scope: &FocusReturn| {
            if self.focus_target(scope.scope.0) != Some(scope.scope) {
                return false;
            }
            if self.navigation_is_parked(scope.scope.0) {
                return true;
            }
            shown.contains(&scope.scope.0)
                && (scope.kind == FocusScopeKind::Modal
                    || (!self.is_dying(scope.scope.0)
                        && self.navigation_accepts(scope.scope.0)
                        && self.focus_target(scope.parent.0) == Some(scope.parent)
                        && self
                            .node(scope.scope.0)
                            .is_some_and(|n| n.props.focus_return_parent == Some(scope.parent.0))))
        };
        let mut retained = old
            .iter()
            .filter(|scope| active(scope))
            .map(|scope| {
                let mut next = *scope;
                if scope.kind == FocusScopeKind::Modal && !self.navigation_is_parked(scope.scope.0)
                {
                    if blurred && !self.navigation_accepts(scope.scope.0) {
                        // An explicit blur also cancels a retiring modal's
                        // later return after its animation completes.
                        next.opener = None;
                        next.parent = self.focus_target(ROOT_ID).unwrap();
                    } else {
                        next.opener = self.inherited_focus(&old, scope.scope, &shown);
                    }
                }
                next
            })
            .collect::<Vec<_>>();
        let current = self.current_focus_target();
        if !blurred && (current == batch.focus || current.is_none()) {
            let mut owner = batch.owner;
            while let Some(target) = owner {
                let Some(scope) = old.iter().find(|scope| scope.scope == target) else {
                    break;
                };
                if retained.iter().any(|scope| scope.scope == target) {
                    if (Some(target) != batch.owner
                        || current.is_none_or(|focus| {
                            !visible.contains(&focus.0) || !self.focusable(focus.0)
                        }))
                        && let Some(first) = self
                            .fresh_autofocus(target.0, &visible)
                            .or_else(|| self.popup_focus_target(target))
                    {
                        self.set_focus(Some(first));
                    }
                    break;
                }
                if let Some(opener) = scope.opener
                    && self.focus_target(opener.0) == Some(opener)
                    && visible.contains(&opener.0)
                    && self.focusable(opener.0)
                {
                    self.set_focus(Some(opener.0));
                    break;
                }
                owner = Some(scope.parent);
            }
        }
        let opener = if blurred {
            None
        } else if batch
            .owner
            .is_some_and(|owner| !retained.iter().any(|scope| scope.scope == owner))
        {
            batch
                .owner
                .and_then(|owner| self.inherited_focus(&old, owner, &shown))
        } else {
            batch.focus
        };
        let mut opened = Vec::new();
        batch.candidates.sort_unstable();
        batch.candidates.dedup();
        batch.candidates.sort_by_key(|id| {
            let mut depth = 0;
            let mut parent = self.node(*id).and_then(|n| n.props.focus_return_parent);
            while let Some(id) = parent {
                depth += 1;
                parent = self.node(id).and_then(|n| n.props.focus_return_parent);
            }
            depth
        });
        for id in batch.candidates {
            let Some(scope) = self.focus_target(id).filter(|_| {
                shown.contains(&id) && !self.is_dying(id) && self.navigation_accepts(id)
            }) else {
                continue;
            };
            if retained.iter().any(|record| record.scope == scope) {
                continue;
            }
            let (kind, parent) = match self.node(id) {
                Some(node) if node.kind == ViewKind::Modal => (
                    FocusScopeKind::Modal,
                    batch
                        .owner
                        .filter(|_| !blurred)
                        .or_else(|| self.focus_target(ROOT_ID)),
                ),
                Some(node) => (
                    FocusScopeKind::Popup,
                    node.props
                        .focus_return_parent
                        .and_then(|id| self.focus_target(id)),
                ),
                None => continue,
            };
            let Some(parent) = parent else { continue };
            let opener = if opened.contains(&parent.0) {
                self.fresh_autofocus(parent.0, &visible)
                    .or_else(|| self.popup_focus_target(parent))
                    .and_then(|id| self.focus_target(id))
            } else {
                opener
                    .filter(|target| {
                        self.returnable_focus(*target, &shown) && !self.within_popup(target.0, id)
                    })
                    .or_else(|| {
                        // A screen and its popup can mount in one batch. Its
                        // background autoFocus is the return target when no
                        // actual opener survives, rather than a competing
                        // request that may steal focus from the popup later.
                        self.fresh_autofocus(parent.0, &visible)
                            .and_then(|id| self.focus_target(id))
                    })
            }
            .filter(|target| !self.within_popup(target.0, id));
            retained.push(FocusReturn {
                scope,
                parent,
                opener,
                kind,
            });
            opened.push(id);
        }
        self.focus_returns = retained;
        if batch.explicit_focus && (self.focus.is_some() || blurred) {
            // Core sends explicit commands after the input configurations.
            // Their chosen owner wins over a just-mounted input's autoFocus.
            for id in &visible {
                if self
                    .node(*id)
                    .is_some_and(|n| n.kind == ViewKind::Input && n.input.auto_focus)
                    && !self.autofocus_seen.contains(id)
                {
                    self.autofocus_seen.push(*id);
                }
            }
            if blurred {
                self.focus_history.clear();
                if !self.autofocus_seen.contains(&ROOT_ID) {
                    self.autofocus_seen.push(ROOT_ID);
                }
            }
            opened.clear();
        }
        opened
    }

    pub(crate) fn focus_opened_popups(&mut self, opened: &[NodeId]) {
        for &id in opened {
            let mut owner = self.current_popup_owner();
            let mut owns = false;
            while let Some(scope) = owner {
                if scope.scope.0 == id {
                    owns = true;
                    break;
                }
                owner = self
                    .focus_returns
                    .iter()
                    .find(|parent| parent.scope == scope.parent);
            }
            if owns {
                continue;
            }
            if let Some(first) = self
                .focus_target(id)
                .and_then(|scope| self.popup_focus_target(scope))
            {
                self.set_focus(Some(first));
            }
        }
    }

    fn in_focus_scope(&self, id: NodeId, root: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            if id == root {
                return true;
            }
            let Some(node) = self.node(id) else {
                current = self.text_link(id).map(|(owner, _)| owner);
                continue;
            };
            if node.props.focus_return_parent.is_some() {
                return false;
            }
            current = node.parent;
        }
        false
    }

    fn fresh_autofocus(&self, root: NodeId, visible: &[NodeId]) -> Option<NodeId> {
        visible.iter().copied().find(|id| {
            self.node(*id)
                .is_some_and(|n| n.kind == ViewKind::Input && n.input.auto_focus)
                && !self.autofocus_seen.contains(id)
                && self.focusable(*id)
                && self.in_focus_scope(*id, root)
        })
    }

    fn keyboard_stop(&self, id: NodeId) -> bool {
        self.focusable(id)
            && (self
                .text_link(id)
                .is_some_and(|(_, link)| link.is_tab_stop())
                || self.node(id).is_some_and(|n| {
                    n.props
                        .focusable
                        .unwrap_or(n.props.focus_return_parent.is_none())
                }))
    }

    fn popup_focus_target(&self, scope: FocusTarget) -> Option<NodeId> {
        if self.focus_target(scope.0) != Some(scope) {
            return None;
        }
        let visible = self.visible_ids();
        visible
            .iter()
            .copied()
            .find(|id| self.keyboard_stop(*id) && self.in_focus_scope(*id, scope.0))
            // A loading or busy popup still owns native keyboard focus when
            // none of its controls can receive it yet.
            .or_else(|| (visible.contains(&scope.0) && self.focusable(scope.0)).then_some(scope.0))
    }

    /// The focused node followed by its mounted ancestors, including itself.
    /// Native system dialogs and menus own focus while open, so their path
    /// contains no application nodes. Hosts publish this same path before
    /// delivering application input and environment changes.
    pub fn focus_path(&self) -> Vec<NodeId> {
        if self.dialog.is_some() || self.service_overlay_open() {
            return Vec::new();
        }
        self.focus
            .filter(|id| self.focus_owner(*id).is_some())
            .map(|id| self.ancestors(id))
            .unwrap_or_default()
    }

    /// Returns the focused input's hints and current generation. Secure
    /// fields expose their selection and hints while redacting text.
    pub fn input_context(&self) -> Option<InputContext> {
        if self.dialog.is_some() {
            return None;
        }
        let id = self.focus?;
        let node = self.node(id).filter(|node| node.kind == ViewKind::Input)?;
        let (start, end) = node.editor.selection();
        Some(InputContext {
            node: id,
            text: (!node.input.secure).then(|| node.editor.text().to_owned()),
            selection: start..end,
            event_count: node.editor.count(),
            keyboard: node.input.keyboard,
            auto_capitalize: node.input.auto_capitalize,
            auto_correct: node.input.auto_correct,
            auto_fill: node.input.auto_fill,
            secure: node.input.secure,
            editable: node.input.editable,
            multiline: node.input.multiline,
            max_length: node.input.max_length,
        })
    }

    /// Applies a completion, correction, paste or authorized autofill
    /// result only while its original input generation is still current.
    /// Returns whether the text or selection changed.
    pub fn apply_input_edit(&mut self, edit: InputEdit) -> bool {
        if self.dialog.is_some() || self.focus != Some(edit.node) {
            return false;
        }
        let Some(node) = self.node(edit.node) else {
            return false;
        };
        if node.kind != ViewKind::Input
            || !node.input.editable
            || node.editor.count() != edit.expected_event_count
            || edit.selection.start > edit.selection.end
            || !node.editor.is_boundary_utf16(edit.selection.start)
            || !node.editor.is_boundary_utf16(edit.selection.end)
        {
            return false;
        }
        let before = (node.editor.count(), node.editor.selection());
        self.edit_input(edit.node, |editor, config| {
            editor.replace_range(
                edit.selection.start,
                edit.selection.end,
                &edit.replacement,
                config,
            )
        });
        self.node(edit.node)
            .is_some_and(|node| (node.editor.count(), node.editor.selection()) != before)
    }

    /// Inserts text through the mounted capitalization policy for a host
    /// keyboard. Physical terminal keys and bracketed paste stay literal;
    /// an embedding host calls this when it provides keyboard assistance.
    pub fn type_text(&mut self, text: &str) -> bool {
        if self.dialog.is_some() {
            return false;
        }
        let Some(id) = self.focus.filter(|id| {
            self.node(*id)
                .is_some_and(|node| node.kind == ViewKind::Input && node.input.editable)
        }) else {
            return false;
        };
        let count = self.node(id).map_or(0, |node| node.editor.count());
        self.edit_input(id, |editor, config| editor.typed(text, config));
        self.node(id)
            .is_some_and(|node| node.editor.count() != count)
    }

    /// Handles an event in this surface's terminal coordinates. Embedded
    /// hosts translate mouse coordinates to the surface before forwarding.
    pub fn handle_event(&mut self, event: Event) -> bool {
        if let Event::Mouse(mouse) = &event
            && matches!(
                mouse.kind,
                MouseEventKind::ScrollUp
                    | MouseEventKind::ScrollDown
                    | MouseEventKind::ScrollLeft
                    | MouseEventKind::ScrollRight
            )
        {
            return self.handle_wheel(*mouse, 1) != 0;
        }
        if self.service_event(&event) {
            return true;
        }
        match event {
            Event::Resize(columns, rows) => {
                self.resize(columns, rows);
                true
            }
            Event::Key(key) => self.key_event(key),
            Event::Mouse(mouse) => self.mouse_event(mouse),
            Event::Paste(text) => {
                if self.dialog.is_some() {
                    return true;
                }
                if let Some(id) = self.focus
                    && self.node(id).is_some_and(|node| node.native.is_some())
                    && self.native_event(id, &Event::Paste(text.clone()))
                {
                    return true;
                }
                let Some(id) = self
                    .focus
                    .filter(|id| self.node(*id).is_some_and(|n| n.kind == ViewKind::Input))
                else {
                    return false;
                };
                self.paste_input(id, text);
                true
            }
            Event::FocusLost => {
                if let Some(id) = self.focus {
                    self.remember_focus(id);
                }
                self.set_focus(None);
                self.set_hover(None);
                self.cancel_pointer();
                true
            }
            Event::FocusGained => {
                self.reconcile_focus(false);
                true
            }
        }
    }

    pub(crate) fn set_focus(&mut self, id: Option<NodeId>) {
        self.set_focus_from(id, FocusSource::Navigation);
    }

    /// Retire only owners within a real removal before its ancestry changes.
    /// Insert-only moves retain their captures, caret and logical return chain.
    pub(crate) fn retire_input_within(
        &mut self,
        root: NodeId,
        before: Option<&mut FocusReturnBatch>,
    ) {
        let mut returns = std::mem::take(&mut self.focus_returns);
        for scope in &mut returns {
            if scope
                .opener
                .is_some_and(|target| self.within_popup(target.0, root))
            {
                scope.opener = None;
            }
        }
        self.focus_returns = returns;
        if let Some(before) = before
            && before
                .focus
                .is_some_and(|target| self.within_popup(target.0, root))
        {
            before.focus = None;
        }
        self.cancel_input_within(root);
        let mut history = std::mem::take(&mut self.focus_history);
        history.retain(|id| !self.ancestors(*id).contains(&root));
        self.focus_history = history;
    }

    /// Cancels native contacts without revoking a parked scope's saved
    /// focus-return lifetime.
    pub(crate) fn cancel_input_within(&mut self, root: NodeId) {
        let navigation = self.retire_navigation_pointer(root);
        let affected = navigation
            || self.pointer.as_ref().is_some_and(|pointer| {
                [
                    Some(pointer.target),
                    pointer.pressable,
                    pointer.pan_candidate,
                    pointer.pan,
                    pointer.native,
                    pointer.link,
                    pointer.scroll,
                ]
                .into_iter()
                .flatten()
                .any(|id| self.within_popup(id, root))
                    || pointer
                        .touch_path
                        .iter()
                        .any(|&id| self.within_popup(id, root))
            })
            || self
                .drag_input
                .is_some_and(|id| self.within_popup(id, root))
            || (self.selection_area_dragging()
                && self
                    .selection_area_owner()
                    .is_some_and(|id| self.within_popup(id, root)));
        if affected {
            let owner = self
                .pointer
                .as_ref()
                .and_then(|pointer| {
                    self.navigation_pointer_owner()
                        .or(pointer.scroll)
                        .or(pointer.native)
                        .or(pointer.pan)
                })
                .filter(|&owner| !self.within_popup(owner, root));
            if !navigation && let Some(owner) = owner {
                let (x, y) = self.pointer.as_ref().unwrap().last;
                self.raw_touch(TouchPhase::Cancel, x, y, None);
                let mut pointer = self.pointer.take().unwrap();
                if pointer
                    .pressable
                    .is_some_and(|id| self.within_popup(id, root))
                {
                    self.emit_if(
                        pointer.pressable.take().unwrap(),
                        EventKind::PressUp,
                        EventPayload::None,
                    );
                }
                if pointer
                    .pan_candidate
                    .is_some_and(|id| self.within_popup(id, root))
                {
                    pointer.pan_candidate = None;
                }
                if pointer.link.is_some_and(|id| self.within_popup(id, root)) {
                    pointer.link = None;
                }
                pointer.target = owner;
                pointer.reporting = false;
                pointer.touch_path.clear();
                self.pointer = Some(pointer);
                if self.pressed.is_some_and(|id| self.within_popup(id, root)) {
                    self.set_pressed(None);
                }
                if self
                    .drag_input
                    .is_some_and(|id| self.within_popup(id, root))
                {
                    self.drag_input = None;
                    self.selection_area_release();
                }
            } else {
                self.cancel_pointer();
            }
        }
        if self.hovered_path.contains(&root)
            || self.hovered.is_some_and(|id| self.within_popup(id, root))
        {
            self.set_hover(None);
        }
        let mut pending = vec![root];
        while let Some(id) = pending.pop() {
            let Some(node) = self.node_mut(id) else {
                continue;
            };
            pending.extend(node.children.iter().copied());
            node.scroll.physics.retire_input();
            let autofocus = node.kind == ViewKind::Input && node.input.auto_focus;
            if autofocus && !self.autofocus_seen.contains(&id) {
                self.autofocus_seen.push(id);
            }
        }
    }

    /// Remove can rebind the same slot. Report an ordinary displaced focus
    /// for this batch; a popup/modal keeps ownership of its own return chain.
    /// Delete's logical node focus is reconciled against the final tree.
    pub(crate) fn retire_recycled_focus(&mut self, root: NodeId) -> bool {
        if !self.focus.is_some_and(|id| self.within_popup(id, root)) {
            return false;
        }
        let ordinary = self.current_popup_owner().is_none();
        self.set_focus(None);
        ordinary
    }

    pub(crate) fn set_focus_from(&mut self, id: Option<NodeId>, source: FocusSource) {
        let visible = self.visible_ids();
        let id = id.filter(|id| visible.contains(id) && self.focusable(*id));
        if !matches!(source, FocusSource::Pointer)
            && let Some(node) = id.and_then(|id| self.node(id))
            && node.kind == ViewKind::Input
        {
            node.request_input_reveal();
        }
        if self.focus == id {
            return;
        }
        let old = self.focus;
        let old_hover = self.hovered_path.clone();
        self.focus = id;
        if let Some(old) = old {
            self.emit_if(old, EventKind::Blur, EventPayload::None);
        }
        if let Some(id) = id {
            self.emit_if(id, EventKind::Focus, EventPayload::None);
        }
        self.report_states(old, self.pressed, &old_hover);
        if let Some(id) = id
            && matches!(source, FocusSource::Navigation)
        {
            // Pointer focus keeps the hit content still until Up. Mount
            // focus reveals after the batch finishes positioning its cells.
            self.reveal_focus(id, &[]);
        }
    }

    /// A batch may remove the focused field or cover it with a modal.
    /// Focus follows the active scope and returns when that scope closes.
    pub(crate) fn reconcile_focus(&mut self, removed_focus: bool) {
        let visible = self.visible_ids();
        let popup = self
            .current_popup_owner()
            .map(|scope| scope.scope)
            .filter(|scope| {
                visible.contains(&scope.0) && self.focus_target(scope.0) == Some(*scope)
            });
        let displaced = self
            .focus
            .is_some_and(|id| !visible.contains(&id) || !self.focusable(id));
        if displaced {
            if let Some(id) = self.focus.filter(|id| self.focus_owner(*id).is_some()) {
                self.remember_focus(id);
            }
            self.set_focus(None);
        }
        // Animated modals retain their return scope while they paint out.
        // Consume it when navigation finishes, even though their focused
        // control became ineligible at the start of the animation.
        let retired_modals = self
            .focus_returns
            .iter()
            .filter(|scope| {
                scope.kind == FocusScopeKind::Modal
                    && !self.navigation_is_parked(scope.scope.0)
                    && (self.focus_target(scope.scope.0) != Some(scope.scope)
                        || !(self.navigation_retains(scope.scope.0)
                            || (self.navigation_attached(scope.scope.0)
                                && self.navigation_accepts(scope.scope.0))))
            })
            .copied()
            .collect::<Vec<_>>();
        if self.focus.is_none()
            && let Some(target) = retired_modals
                .iter()
                .rev()
                .find_map(|scope| self.inherited_focus(&self.focus_returns, scope.scope, &visible))
        {
            self.set_focus(Some(target.0));
        }
        self.focus_returns.retain(|scope| {
            !retired_modals
                .iter()
                .any(|retired| retired.scope == scope.scope)
        });
        self.autofocus_seen.retain(|id| {
            *id == ROOT_ID || self.nodes.get(*id as usize).is_some_and(Option::is_some)
        });
        let fresh_auto = self
            .focus_returns
            .iter()
            .rev()
            .find_map(|scope| self.fresh_autofocus(scope.scope.0, &visible))
            .or_else(|| {
                popup
                    .is_none()
                    .then(|| self.fresh_autofocus(ROOT_ID, &visible))
                    .flatten()
            });
        for id in &visible {
            if self
                .node(*id)
                .is_some_and(|n| n.kind == ViewKind::Input && n.input.auto_focus)
                && !self.autofocus_seen.contains(id)
            {
                self.autofocus_seen.push(*id);
            }
        }
        if let Some(id) = fresh_auto {
            self.set_focus(Some(id));
        } else if self.focus.is_none() {
            if let Some(id) = popup.and_then(|scope| self.popup_focus_target(scope)) {
                self.set_focus(Some(id));
            } else {
                let restore = self
                    .focus_history
                    .iter()
                    .rposition(|id| visible.contains(id) && self.focusable(*id));
                if let Some(index) = restore {
                    let id = self.focus_history.remove(index);
                    self.set_focus(Some(id));
                } else if displaced || removed_focus || !self.autofocus_seen.contains(&ROOT_ID) {
                    let first = visible.iter().copied().find(|id| self.focusable(*id));
                    self.set_focus(first);
                }
            }
        }
        if !self.autofocus_seen.contains(&ROOT_ID) {
            self.autofocus_seen.push(ROOT_ID);
        }
        if self
            .pointer
            .as_ref()
            .is_some_and(|p| !visible.contains(&p.target))
        {
            self.cancel_pointer();
        }
        if self.hovered.is_some_and(|id| !visible.contains(&id)) {
            self.set_hover(None);
        }
    }

    fn remember_focus(&mut self, id: NodeId) {
        let mut history = std::mem::take(&mut self.focus_history);
        history.retain(|old| *old != id && self.focus_owner(*old).is_some());
        self.focus_history = history;
        self.focus_history.push(id);
    }

    pub(crate) fn input_value(&mut self, id: NodeId, text: String, count: u32) {
        let focused = self.focus == Some(id);
        if self.node_mut(id).is_some_and(|n| {
            let changed = n.editor.controlled(text, count);
            if changed && focused {
                n.request_input_reveal();
            }
            changed
        }) {
            self.report_selection(id);
        }
    }

    pub(crate) fn selection(&mut self, id: NodeId, start: u32, end: u32) {
        if self.node_mut(id).is_some_and(|n| {
            n.request_input_reveal();
            n.editor.set_selection(start, end)
        }) {
            self.report_selection(id);
        }
    }

    fn emit_if(&mut self, id: NodeId, kind: EventKind, payload: EventPayload) {
        let events = self.node(id).map(|n| n.events).or_else(|| {
            self.nodes
                .iter()
                .flatten()
                .filter_map(|n| n.text.as_ref())
                .flat_map(|(text, _, _)| &text.links)
                .find(|link| link.node == id)
                .map(|link| link.events)
        });
        if let Some(events) = events.filter(|events| events.contains(kind)) {
            if matches!(kind, EventKind::HoverIn | EventKind::HoverOut)
                && !events.contains_listener(kind)
            {
                if let Some(watch) = events.hint_watch() {
                    let observation = if kind == EventKind::HoverIn {
                        HintObservation::Enter(watch)
                    } else {
                        HintObservation::Leave(watch)
                    };
                    self.events.push(SurfaceEvent::HintObservation(observation));
                }
            } else {
                self.emit(id, kind, payload);
            }
        }
    }

    fn report_selection(&mut self, id: NodeId) {
        let Some(node) = self.node(id) else { return };
        let (start, end) = node.editor.selection();
        self.emit_if(
            id,
            EventKind::SelectionChange,
            EventPayload::Map(vec![
                ("start", PayloadValue::Number(start as f64)),
                ("end", PayloadValue::Number(end as f64)),
            ]),
        );
    }

    /// A native paste reports its original text before any edit; the
    /// mounted policy decides insertion without waiting for app code.
    pub(crate) fn paste_input(&mut self, id: NodeId, text: String) {
        let Some(node) = self.node(id) else {
            return;
        };
        if node.kind != ViewKind::Input || !node.input.editable {
            return;
        }
        let insert = node.input.paste_behavior == nsh_core::PasteBehavior::Insert;
        if node.events.contains(EventKind::Paste) {
            self.emit(
                id,
                EventKind::Paste,
                EventPayload::Paste(Box::new(nsh_core::PasteEvent::new(text.clone()))),
            );
        }
        if insert {
            self.edit_input(id, |editor, config| editor.replace(&text, config));
        }
    }

    pub(crate) fn edit_input(
        &mut self,
        id: NodeId,
        edit: impl FnOnce(&mut crate::editor::Editor, &nsh_core::InputConfig) -> bool,
    ) {
        let Some(node) = self.node_mut(id) else {
            return;
        };
        let old_selection = node.editor.selection();
        let changed = edit(&mut node.editor, &node.input);
        node.request_input_reveal();
        let selection_changed = old_selection != node.editor.selection();
        if changed {
            let payload = EventPayload::Text {
                text: node.editor.text().to_owned(),
                count: node.editor.count(),
            };
            // The core needs every native edit for input measurement and
            // event counts, even without a JS change listener.
            self.emit(id, EventKind::ChangeText, payload);
        }
        if changed || selection_changed {
            self.report_selection(id);
        }
    }

    pub(crate) fn focusable(&self, id: NodeId) -> bool {
        if let Some((owner, link)) = self.text_link(id) {
            return link.is_enabled()
                && self.text_link_bounds(id).is_some()
                && self.node(owner).is_some_and(|node| {
                    !node.style.hidden
                        && !node.props.accessibility.state.disabled
                        && node.props.pointer_events != PointerEvents::None
                })
                && !self.ancestors(owner).into_iter().skip(1).any(|id| {
                    self.node(id)
                        .is_some_and(|node| node.props.pointer_events == PointerEvents::None)
                });
        }
        let Some(node) = self.node(id) else {
            return false;
        };
        if node.style.hidden
            || node.props.accessibility.state.disabled
            || node.props.pointer_events == PointerEvents::None
        {
            return false;
        }
        if self.ancestors(id).into_iter().skip(1).any(|id| {
            self.node(id)
                .is_some_and(|n| n.props.pointer_events == PointerEvents::None)
        }) {
            return false;
        }
        node.props.focus_return_parent.is_some()
            || node.kind == ViewKind::Input
            || node
                .text
                .as_ref()
                .is_some_and(|(text, _, _)| text.is_selectable())
            || (node.kind == ViewKind::Scroll && node.scroll.enabled)
            || node
                .native
                .as_ref()
                .is_some_and(|native| native.focusable())
            || node.media.is_some()
            || self.pressable(id)
    }

    pub(crate) fn pressable(&self, id: NodeId) -> bool {
        if let Some((_, link)) = self.text_link(id) {
            return link.is_enabled()
                && [
                    EventKind::Press,
                    EventKind::LongPress,
                    EventKind::PressDown,
                    EventKind::PressUp,
                ]
                .into_iter()
                .any(|event| link.events.contains(event));
        }
        self.node(id).is_some_and(|n| {
            !n.props.accessibility.state.disabled
                && [
                    EventKind::Press,
                    EventKind::LongPress,
                    EventKind::PressDown,
                    EventKind::PressUp,
                ]
                .into_iter()
                .any(|e| n.events.contains(e))
        })
    }

    pub(crate) fn ancestors(&self, id: NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        let mut next = Some(id);
        while let Some(id) = next {
            if result.contains(&id) {
                break;
            }
            result.push(id);
            next = self
                .node(id)
                .map(|n| n.parent)
                .unwrap_or_else(|| self.text_link(id).map(|(owner, _)| owner));
        }
        result
    }

    fn focus_next(&mut self, backwards: bool) -> bool {
        let scope = self.current_popup_owner().map(|scope| scope.scope.0);
        let stops: Vec<_> = self
            .visible_ids()
            .into_iter()
            .filter(|id| {
                self.keyboard_stop(*id) && scope.is_none_or(|scope| self.within_popup(*id, scope))
            })
            .collect();
        if stops.is_empty() {
            return false;
        }
        let current = self
            .focus
            .and_then(|id| stops.iter().position(|stop| *stop == id));
        let next = match (current, backwards) {
            (Some(i), false) => (i + 1) % stops.len(),
            (Some(i), true) => (i + stops.len() - 1) % stops.len(),
            (None, false) => 0,
            (None, true) => stops.len() - 1,
        };
        let id = stops[next];
        self.set_focus(Some(id));
        if self
            .node(id)
            .is_some_and(|n| n.kind == ViewKind::Input && !n.input.multiline)
        {
            self.edit_input(id, |editor, _| {
                editor.select_all();
                false
            });
        }
        true
    }

    pub(crate) fn reveal_focus(&mut self, id: NodeId, overridden: &[(NodeId, u64)]) {
        let (geometry, target) = if let Some(link) = self.text_link_bounds(id) {
            link
        } else if let Some(frame) = self.presentation_frame(id) {
            (
                id,
                nsh_core::Bounds::new(nsh_core::Point::default(), frame.size),
            )
        } else {
            return;
        };
        let ancestors = self.ancestors(id);
        for scroll in ancestors.into_iter().skip(1) {
            let Some(node) = self.node(scroll) else {
                continue;
            };
            if node.kind != ViewKind::Scroll
                || !node.scroll.enabled
                || overridden.contains(&(scroll, node.generation))
            {
                continue;
            }
            let (x, y) = (node.scroll.x.0, node.scroll.y.0);
            let mirrored = node.scroll.mirrored;
            let viewport = (node.frame.size.width.0, node.frame.size.height.0);
            let Some(matrix) = self.local_to_surface(geometry) else {
                continue;
            };
            let points = [
                (target.origin.x.0, target.origin.y.0),
                (target.origin.x.0 + target.size.width.0, target.origin.y.0),
                (target.origin.x.0, target.origin.y.0 + target.size.height.0),
                (
                    target.origin.x.0 + target.size.width.0,
                    target.origin.y.0 + target.size.height.0,
                ),
            ];
            let mut bounds = (
                f32::INFINITY,
                f32::INFINITY,
                f32::NEG_INFINITY,
                f32::NEG_INFINITY,
            );
            for point in points {
                if let Some(point) = crate::geometry::project(&matrix, point.0, point.1)
                    && let Some(point) = self.surface_to_local(scroll, point.0, point.1)
                {
                    bounds.0 = bounds.0.min(point.0);
                    bounds.1 = bounds.1.min(point.1);
                    bounds.2 = bounds.2.max(point.0);
                    bounds.3 = bounds.3.max(point.1);
                }
            }
            if !bounds.0.is_finite() {
                continue;
            }
            let dx = if bounds.0 < 0.0 {
                bounds.0
            } else {
                (bounds.0 + (bounds.2 - bounds.0).min(viewport.0) - viewport.0).max(0.0)
            };
            let dy = if bounds.1 < 0.0 {
                bounds.1
            } else {
                (bounds.1 + (bounds.3 - bounds.1).min(viewport.1) - viewport.1).max(0.0)
            };
            if dx != 0.0 || dy != 0.0 {
                self.scroll_to(scroll, px(x + if mirrored { -dx } else { dx }), px(y + dy));
            }
        }
    }

    fn key_event(&mut self, key: KeyEvent) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        let command = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER);
        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('q') {
            self.quit = true;
            return true;
        }
        if self.dialog.is_some() {
            return self.dialog_key(key);
        }
        let visible = std::cell::OnceCell::new();
        let selection_area = self.selection_area_owner().is_some_and(|area| {
            visible.get_or_init(|| self.visible_ids()).contains(&area)
                && self
                    .current_popup_owner()
                    .is_none_or(|scope| self.within_popup(area, scope.scope.0))
        });
        let editing = selection_area
            || self.focus.is_some_and(|id| {
                self.node(id).is_some_and(|n| {
                    n.kind == ViewKind::Input
                        || n.native.is_some()
                        || n.kind == ViewKind::WebView
                        || n.text
                            .as_ref()
                            .is_some_and(|(text, _, _)| text.is_selectable())
                })
            });
        if let Some(stroke) = keystroke(key) {
            let focus_path = self.focus_path();
            match self
                .keymap
                .find_with(stroke, editing, key.kind == KeyEventKind::Repeat, |node| {
                    focus_path.contains(&node)
                        && visible.get_or_init(|| self.visible_ids()).contains(&node)
                }) {
                KeyMatch::Fire(id) => {
                    self.emit(
                        ROOT_ID,
                        EventKind::KeyCommand,
                        EventPayload::Value(PayloadValue::Number(id as f64)),
                    );
                    return true;
                }
                KeyMatch::Held => return true,
                KeyMatch::None => {}
            }
        }
        if let Some(id) = self.focus
            && self.node(id).is_some_and(|node| node.native.is_some())
            && self.native_event(id, &Event::Key(key))
        {
            return true;
        }
        if let Some(id) = self.focus
            && self.node(id).is_some_and(|node| node.media.is_some())
            && self.media_key(id, key)
        {
            return true;
        }
        if matches!(key.code, KeyCode::Tab | KeyCode::BackTab)
            && !command
            && !key.modifiers.contains(KeyModifiers::ALT)
        {
            return self.focus_next(
                key.code == KeyCode::BackTab || key.modifiers.contains(KeyModifiers::SHIFT),
            );
        }
        if self
            .focus
            .is_some_and(|id| self.node(id).is_some_and(|n| n.kind == ViewKind::Input))
            && self.input_key(self.focus.unwrap_or(ROOT_ID), key)
        {
            return true;
        }
        if selection_area
            && !self
                .focus
                .is_some_and(|id| self.node(id).is_some_and(|n| n.kind == ViewKind::Input))
            && self.selection_area_key(key)
        {
            return true;
        }
        if let Some(id) = self.focus
            && self.text_key(id, key)
        {
            return true;
        }
        if key.code == KeyCode::Esc
            || (key.code == KeyCode::Left && key.modifiers.contains(KeyModifiers::ALT))
        {
            self.back();
            return true;
        }
        if !command
            && !key.modifiers.contains(KeyModifiers::ALT)
            && matches!(key.code, KeyCode::Enter | KeyCode::Char(' '))
            && let Some(id) = self.focus.filter(|id| self.pressable(*id))
        {
            if key.kind != KeyEventKind::Repeat {
                self.activate(id);
            }
            return true;
        }
        if self.scroll_key(key) {
            return true;
        }
        if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('c') {
            self.quit = true;
            return true;
        }
        false
    }

    fn input_key(&mut self, id: NodeId, key: KeyEvent) -> bool {
        let Some(node) = self.node(id) else {
            return false;
        };
        let config = node.input.clone();
        let command = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let lower = match key.code {
            KeyCode::Char(c) => Some(c.to_ascii_lowercase()),
            _ => None,
        };
        let columns = if config.multiline {
            self.input_hit_geometry(id)
                .map_or(1, |geometry| geometry.columns.max(1))
        } else {
            usize::MAX
        };
        if command {
            match lower {
                Some('a') => self.edit_input(id, |editor, _| {
                    editor.select_all();
                    false
                }),
                Some('c') => {
                    if !config.secure {
                        self.write_clipboard(node.editor.selected().to_owned());
                    }
                }
                Some('x') => {
                    if !config.secure {
                        self.write_clipboard(node.editor.selected().to_owned());
                        self.edit_input(id, |editor, config| {
                            if editor.selected_range().is_empty() {
                                false
                            } else {
                                editor.replace("", config)
                            }
                        });
                    }
                }
                Some('v') => {
                    self.request_paste(id);
                }
                Some('z') if shift => self.edit_input(id, |editor, config| editor.redo(config)),
                Some('z') => self.edit_input(id, |editor, config| editor.undo(config)),
                Some('y') => self.edit_input(id, |editor, config| editor.redo(config)),
                Some('w') => {
                    self.edit_input(id, |editor, config| editor.delete(true, true, config))
                }
                Some('k' | 'u') => {
                    let end = lower == Some('k');
                    self.edit_input(id, |editor, config| {
                        editor.home_end(end, false, true);
                        editor.replace("", config)
                    });
                }
                _ => return self.input_navigation(id, key, columns, config.secure),
            }
            return true;
        }
        match key.code {
            KeyCode::Enter => {
                self.key_press(id, "Enter".into());
                let submit = config.submit();
                if config.multiline && (shift || alt || submit == SubmitBehavior::Newline) {
                    self.edit_input(id, |editor, config| {
                        editor.replace(nsh_core::text_edit::line_ending(editor.text()), config)
                    });
                } else {
                    if let Some(node) = self.node(id) {
                        let payload = EventPayload::Text {
                            text: node.editor.text().to_owned(),
                            count: node.editor.count(),
                        };
                        self.emit_if(id, EventKind::SubmitEditing, payload);
                    }
                    if submit == SubmitBehavior::BlurAndSubmit {
                        self.set_focus(None);
                    }
                }
                true
            }
            KeyCode::Backspace | KeyCode::Delete => {
                self.key_press(
                    id,
                    if key.code == KeyCode::Backspace {
                        "Backspace"
                    } else {
                        "Delete"
                    }
                    .into(),
                );
                self.edit_input(id, |editor, config| {
                    editor.delete(key.code == KeyCode::Backspace, alt, config)
                });
                true
            }
            KeyCode::Char(c) if !alt && !c.is_control() => {
                let text = c.to_string();
                self.key_press(id, text.clone());
                self.edit_input(id, |editor, config| editor.replace(&text, config));
                true
            }
            KeyCode::Insert if shift => {
                self.request_paste(id);
                true
            }
            _ => self.input_navigation(id, key, columns, config.secure),
        }
    }

    fn input_navigation(
        &mut self,
        id: NodeId,
        key: KeyEvent,
        columns: usize,
        secure: bool,
    ) -> bool {
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        let command = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER);
        let word = command || key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Left | KeyCode::Right => self.edit_input(id, |editor, _| {
                editor.horizontal(key.code == KeyCode::Right, word, shift);
                false
            }),
            KeyCode::Home | KeyCode::End => self.edit_input(id, |editor, _| {
                editor.home_end(key.code == KeyCode::End, command, shift);
                false
            }),
            KeyCode::Up | KeyCode::Down if columns != usize::MAX => {
                let alignments = self.node(id).map_or((0, 0), |node| {
                    let row = node.editor.cursor_cell(columns, secure).0;
                    let next = if key.code == KeyCode::Down {
                        row.saturating_add(1)
                    } else {
                        row.saturating_sub(1)
                    };
                    let offsets = crate::render::input_line_offsets(node, true, columns);
                    (
                        offsets.get(row).copied().unwrap_or(0),
                        offsets.get(next).copied().unwrap_or(0),
                    )
                });
                self.edit_input(id, |editor, _| {
                    editor.vertical(
                        key.code == KeyCode::Down,
                        shift,
                        columns,
                        secure,
                        alignments,
                    );
                    false
                })
            }
            KeyCode::Backspace | KeyCode::Delete if command => self
                .edit_input(id, |editor, config| {
                    editor.delete(key.code == KeyCode::Backspace, true, config)
                }),
            KeyCode::Insert if command => {
                if let Some(node) = self.node(id).filter(|n| !n.input.secure) {
                    self.write_clipboard(node.editor.selected().to_owned());
                }
            }
            KeyCode::Esc => {
                self.key_press(id, "Escape".into());
                self.set_focus(None);
                return false;
            }
            _ => return false,
        }
        true
    }

    fn key_press(&mut self, id: NodeId, text: String) {
        self.emit_if(
            id,
            EventKind::KeyPress,
            EventPayload::Map(vec![("key", PayloadValue::Str(text))]),
        );
    }

    fn text_key(&mut self, id: NodeId, key: KeyEvent) -> bool {
        let Some(node) = self.node(id) else {
            return false;
        };
        if !node
            .text
            .as_ref()
            .is_some_and(|(text, _, _)| text.is_selectable())
        {
            return false;
        }
        let command = key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::SUPER);
        let extend = key.modifiers.contains(KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Char('c' | 'C') if command => {
                let text = node
                    .editor
                    .selected()
                    .chars()
                    .filter(|c| {
                        *c != nsh_core::ATTACHMENT_CHAR
                            && (!c.is_control() || matches!(*c, '\n' | '\t'))
                    })
                    .collect();
                self.write_clipboard(text);
            }
            KeyCode::Char('a' | 'A') if command => {
                self.node_mut(id).unwrap().editor.select_all();
            }
            KeyCode::Left | KeyCode::Right => {
                self.node_mut(id).unwrap().editor.horizontal(
                    key.code == KeyCode::Right,
                    command || key.modifiers.contains(KeyModifiers::ALT),
                    extend,
                );
            }
            KeyCode::Home | KeyCode::End => {
                self.node_mut(id).unwrap().editor.home_end(
                    key.code == KeyCode::End,
                    command,
                    extend,
                );
            }
            KeyCode::Esc => {
                let cursor = node.editor.selection().1;
                self.node_mut(id)
                    .unwrap()
                    .editor
                    .set_selection(cursor, cursor);
                self.set_focus(None);
            }
            _ => return false,
        }
        true
    }

    fn activate(&mut self, id: NodeId) {
        self.set_pressed(Some(id));
        self.emit_if(id, EventKind::PressDown, EventPayload::None);
        self.emit_if(id, EventKind::Press, EventPayload::None);
        self.emit_if(id, EventKind::PressUp, EventPayload::None);
        self.set_pressed(None);
    }

    fn dialog_key(&mut self, key: KeyEvent) -> bool {
        let Some(dialog) = self.dialog.as_ref() else {
            return false;
        };
        let len = dialog.buttons.len().max(1);
        match key.code {
            KeyCode::Tab if key.modifiers.contains(KeyModifiers::SHIFT) => {
                self.dialog_selection = (self.dialog_selection + len - 1) % len
            }
            KeyCode::Tab | KeyCode::Right | KeyCode::Down => {
                self.dialog_selection = (self.dialog_selection + 1) % len
            }
            KeyCode::BackTab | KeyCode::Left | KeyCode::Up => {
                self.dialog_selection = (self.dialog_selection + len - 1) % len
            }
            KeyCode::Enter | KeyCode::Char(' ') => self.answer_dialog(self.dialog_selection as i32),
            KeyCode::Char(c) if ('1'..='9').contains(&c) && (c as usize - '1' as usize) < len => {
                self.answer_dialog(c as i32 - '1' as i32)
            }
            KeyCode::Esc if dialog.cancelable => self.answer_dialog(-1),
            _ => {}
        }
        true
    }

    fn answer_dialog(&mut self, index: i32) {
        let Some(dialog) = self.dialog.take() else {
            return;
        };
        self.dialog_selection = 0;
        self.emit(
            ROOT_ID,
            EventKind::Dialog,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(dialog.id as f64)),
                ("index", PayloadValue::Number(index as f64)),
            ]),
        );
    }

    fn scroll_ancestor(&self, start: Option<NodeId>) -> Option<NodeId> {
        let visible = self.visible_ids();
        let ancestors = start.map(|id| self.ancestors(id)).unwrap_or_default();
        ancestors
            .into_iter()
            .find(|id| {
                visible.contains(id)
                    && self
                        .node(*id)
                        .is_some_and(|n| n.kind == ViewKind::Scroll && n.scroll.enabled)
            })
            .or_else(|| {
                visible.into_iter().find(|id| {
                    self.node(*id)
                        .is_some_and(|n| n.kind == ViewKind::Scroll && n.scroll.enabled)
                })
            })
    }

    fn scroll_key(&mut self, key: KeyEvent) -> bool {
        if key
            .modifiers
            .intersects(KeyModifiers::ALT | KeyModifiers::SUPER)
        {
            return false;
        }
        let Some(id) = self.scroll_ancestor(self.focus.or(self.hovered)) else {
            return false;
        };
        let Some(node) = self.node(id) else {
            return false;
        };
        if key.modifiers.contains(KeyModifiers::CONTROL)
            && matches!(key.code, KeyCode::Char('+' | '=' | '-' | '0'))
        {
            if !node.scroll.behavior.zooms() || !node.scroll.behavior.pinch {
                return false;
            }
            let Some(matrix) = self.local_to_surface(id) else {
                return false;
            };
            let Some(center) = crate::geometry::project(
                &matrix,
                node.frame.size.width.0 * 0.5,
                node.frame.size.height.0 * 0.5,
            ) else {
                return false;
            };
            if key.code == KeyCode::Char('0') {
                self.zoom_scroll(id, 1.0, None, true);
                return true;
            }
            return self.zoom_scroll_at(
                id,
                if key.code == KeyCode::Char('-') {
                    1.0 / 1.1
                } else {
                    1.1
                },
                center.0,
                center.1,
            );
        }
        let (x, y) = (node.scroll.x.0, node.scroll.y.0);
        let (width, height) = (node.frame.size.width.0, node.frame.size.height.0);
        let (content_w, content_h) = (
            node.scroll.content.width.0 * node.scroll.physics.zoom,
            node.scroll.content.height.0 * node.scroll.physics.zoom,
        );
        let horizontal = node.scroll.horizontal;
        let step_x = self.metrics.width().0 * 3.0 * if node.scroll.mirrored { -1.0 } else { 1.0 };
        let step_y = self.metrics.height().0;
        let (x, y) = match key.code {
            KeyCode::Up => (x, y - step_y),
            KeyCode::Down => (x, y + step_y),
            KeyCode::Left => (x - step_x, y),
            KeyCode::Right => (x + step_x, y),
            KeyCode::PageUp if horizontal => (x - width, y),
            KeyCode::PageDown if horizontal => (x + width, y),
            KeyCode::PageUp => (x, y - height),
            KeyCode::PageDown => (x, y + height),
            KeyCode::Home if horizontal => (0.0, y),
            KeyCode::End if horizontal => (content_w, y),
            KeyCode::Home => (x, 0.0),
            KeyCode::End => (x, content_h),
            _ => return false,
        };
        self.scroll_intent(
            id,
            match key.code {
                KeyCode::Home => "start",
                KeyCode::End => "end",
                _ => "scroll",
            },
        );
        self.user_scroll(id, x, y);
        true
    }

    fn user_scroll(&mut self, id: NodeId, x: f32, y: f32) {
        let (mut x, mut y) = (px(x), px(y));
        if let Some(node) = self.node(id) {
            if node.scroll.horizontal {
                x = node
                    .scroll
                    .behavior
                    .snap_target(
                        node.scroll.x,
                        x,
                        (x - node.scroll.x).0.signum(),
                        node.frame.size.width,
                        node.scroll.content.width * node.scroll.physics.zoom,
                    )
                    .unwrap_or(x);
            } else {
                y = node
                    .scroll
                    .behavior
                    .snap_target(
                        node.scroll.y,
                        y,
                        (y - node.scroll.y).0.signum(),
                        node.frame.size.height,
                        node.scroll.content.height * node.scroll.physics.zoom,
                    )
                    .unwrap_or(y);
            }
        }
        self.scroll_to(id, x, y);
        self.scroll_settled(id);
        if let Some(node) = self.node(id) {
            let payload = EventPayload::Scroll(point(node.scroll.x, node.scroll.y));
            self.emit_if(id, EventKind::ScrollEnd, payload);
        }
    }

    pub(crate) fn horizontal_wheel(mouse: MouseEvent) -> bool {
        matches!(
            mouse.kind,
            MouseEventKind::ScrollLeft | MouseEventKind::ScrollRight
        ) || mouse.modifiers.contains(KeyModifiers::SHIFT)
    }

    pub(crate) fn wheel_scroll_target(
        &self,
        path: Vec<NodeId>,
        horizontal: bool,
    ) -> Option<NodeId> {
        let axis = |id: &NodeId| {
            self.node(*id)
                .filter(|node| node.kind == ViewKind::Scroll && node.scroll.enabled)
                .map(|node| node.scroll.horizontal)
        };
        // Detents retain their owner at content edges.
        nsh_core::input::scroll_target(
            path,
            px(if horizontal { 1.0 } else { 0.0 }),
            px(if horizontal { 0.0 } else { 1.0 }),
            axis,
            |id| axis(id).is_some(),
        )
    }

    /// Handles consecutive identical wheel detents against one hit-tested target.
    ///
    /// The host groups only events with the same coordinates, direction and
    /// modifiers. Native scrolling applies their total
    /// delta once, so moving content cannot retarget later detents to a nested
    /// scroll view. Returns the number consumed; zero steps and non-wheel events
    /// do nothing. Host components accept only one detent per call, allowing the
    /// host to dispatch their events before admitting more input.
    pub fn handle_wheel(&mut self, mouse: MouseEvent, mut steps: u16) -> u16 {
        if steps == 0
            || !matches!(
                mouse.kind,
                MouseEventKind::ScrollUp
                    | MouseEventKind::ScrollDown
                    | MouseEventKind::ScrollLeft
                    | MouseEventKind::ScrollRight
            )
        {
            return 0;
        }
        if self.service_wheel(mouse, steps) {
            return steps;
        }
        if self.dialog.is_some() {
            self.dialog_mouse(mouse);
            return steps;
        }
        let x = (mouse.column as f32 + 0.5) * self.metrics.width().0;
        let y = (mouse.row as f32 + 0.5) * self.metrics.height().0;
        let hit = self.hit_test(x, y);
        self.set_hover(hit);
        let native = self
            .pointer
            .as_ref()
            .and_then(|pointer| pointer.native)
            .or_else(|| {
                hit.and_then(|id| {
                    self.ancestors(id)
                        .into_iter()
                        .find(|id| self.node(*id).is_some_and(|node| node.native.is_some()))
                })
            });
        if let Some(id) = native {
            steps = 1;
            let captured = self
                .pointer
                .as_ref()
                .is_some_and(|pointer| pointer.native == Some(id));
            if self.native_event(id, &Event::Mouse(mouse)) || captured {
                return 1;
            }
        }
        if !mouse
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::SHIFT)
            && matches!(
                mouse.kind,
                MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            )
            && let Some(id) = hit.filter(|id| {
                self.node(*id)
                    .is_some_and(|n| n.kind == ViewKind::Input && n.input.multiline)
            })
            && self.wheel_input(id, mouse.kind, steps)
        {
            return steps;
        }
        if !mouse.modifiers.contains(KeyModifiers::CONTROL)
            && let Some(media) = hit.and_then(|id| {
                self.ancestors(id)
                    .into_iter()
                    .find(|id| self.node(*id).is_some_and(|node| node.media.is_some()))
            })
            && matches!(
                mouse.kind,
                MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
            )
            && self.media_scroll(
                media,
                if mouse.kind == MouseEventKind::ScrollUp {
                    -3 * i32::from(steps)
                } else {
                    3 * i32::from(steps)
                },
            )
        {
            return steps;
        }
        let scroll = if mouse.modifiers.contains(KeyModifiers::CONTROL) {
            self.scroll_ancestor(hit.or(self.focus))
        } else {
            let visible = self.visible_ids();
            let path = hit
                .or(self.focus)
                .map(|id| self.ancestors(id))
                .unwrap_or_default()
                .into_iter()
                .filter(|id| visible.contains(id))
                .collect();
            self.wheel_scroll_target(path, Self::horizontal_wheel(mouse))
                .or_else(|| self.scroll_ancestor(None))
        };
        if mouse.modifiers.contains(KeyModifiers::CONTROL)
            && let Some(hit) = hit
        {
            let path = self.ancestors(hit);
            if let Some(id) = scroll.filter(|id| path.contains(id)) {
                let consumed = self.scroll_wheel_owner(id, mouse, steps);
                if consumed != 0 {
                    return consumed;
                }
            }
            if let Some(id) = path.into_iter().find(|id| {
                self.node(*id)
                    .is_some_and(|node| nsh_core::input::transforms(&node.gestures, node.events).0)
            }) {
                return self.pinch_wheel(id, mouse.kind, steps);
            }
        }
        let Some(id) = scroll else {
            return 0;
        };
        self.scroll_wheel_owner(id, mouse, steps)
    }

    fn wheel_input(&mut self, id: NodeId, direction: MouseEventKind, steps: u16) -> bool {
        let (Some(node), Some(geometry)) = (self.node(id), self.input_hit_geometry(id)) else {
            return false;
        };
        let before = crate::render::input_scroll(
            node,
            self.focus == Some(id),
            geometry.columns,
            geometry.rows,
        );
        let maximum = node
            .editor
            .cell_extent(geometry.columns, node.input.secure)
            .0
            .saturating_sub(geometry.rows.saturating_sub(1));
        let delta = usize::from(steps) * 3;
        let row = if direction == MouseEventKind::ScrollUp {
            before.0.saturating_sub(delta)
        } else {
            before.0.saturating_add(delta).min(maximum)
        };
        node.input_viewport.set(crate::surface::InputViewport {
            origin: (row, 0),
            reveal: false,
            ..node.input_viewport.get()
        });
        row != before.0
    }

    pub(crate) fn pinch_wheel(&mut self, id: NodeId, kind: MouseEventKind, mut steps: u16) -> u16 {
        let Some(node) = self.node(id) else {
            return 0;
        };
        // Detents have no begin/end phases. As with terminal Scroll zoom,
        // each delivery is a complete gesture. Let real callbacks run before
        // the host admits another detent against their possibly changed view.
        if node.events.contains(EventKind::PinchStart) || node.events.contains(EventKind::PinchEnd)
        {
            steps = 1;
        }
        let value = node.gestures.pinch;
        let scale = nsh_core::input::zoom_factor(
            f32::from(steps)
                * if matches!(kind, MouseEventKind::ScrollUp | MouseEventKind::ScrollRight) {
                    -1.0
                } else {
                    1.0
                },
        );
        if !scale.is_finite() || scale == 0.0 {
            return 0;
        }
        let next = value.and_then(|value| {
            self.animation
                .value(value)
                .map(|old| (value, old, old * scale))
        });
        if next.is_some_and(|(_, old, next)| !next.is_finite() || (old != 0.0 && next == 0.0)) {
            return 0;
        }
        let payload = |scale: f32| {
            EventPayload::Map(vec![
                ("scale", PayloadValue::Number(f64::from(scale))),
                ("velocity", PayloadValue::Number(0.0)),
            ])
        };
        self.emit_if(id, EventKind::PinchStart, payload(1.0));
        if let Some((value, _, next)) = next {
            let mut finished = Vec::new();
            self.animation.set(value, next, &mut finished);
            if !finished.is_empty() {
                self.events.push(SurfaceEvent::AnimationsFinished(finished));
            }
        }
        self.emit_if(id, EventKind::PinchEnd, payload(scale));
        steps
    }

    pub(crate) fn scroll_wheel_owner(&mut self, id: NodeId, mouse: MouseEvent, steps: u16) -> u16 {
        if mouse.modifiers.contains(KeyModifiers::CONTROL) {
            let factor: f32 = if matches!(
                mouse.kind,
                MouseEventKind::ScrollUp | MouseEventKind::ScrollRight
            ) {
                1.1
            } else {
                1.0 / 1.1
            };
            let x = (mouse.column as f32 + 0.5) * self.metrics.width().0;
            let y = (mouse.row as f32 + 0.5) * self.metrics.height().0;
            return if self.zoom_scroll_at(id, factor.powi(i32::from(steps)), x, y) {
                steps
            } else {
                0
            };
        }
        let Some(node) = self.node(id) else {
            return 0;
        };
        let (mut x, mut y) = (node.scroll.x.0, node.scroll.y.0);
        let horizontal = node.scroll.horizontal || mouse.modifiers.contains(KeyModifiers::SHIFT);
        let horizontal_step = self.metrics.width().0 * 3.0 * f32::from(steps);
        let vertical_step = self.metrics.height().0 * 3.0 * f32::from(steps);
        let physical_step = horizontal_step * if node.scroll.mirrored { -1.0 } else { 1.0 };
        match mouse.kind {
            MouseEventKind::ScrollLeft => x -= physical_step,
            MouseEventKind::ScrollRight => x += physical_step,
            MouseEventKind::ScrollUp if horizontal => x -= horizontal_step,
            MouseEventKind::ScrollDown if horizontal => x += horizontal_step,
            MouseEventKind::ScrollUp => y -= vertical_step,
            MouseEventKind::ScrollDown => y += vertical_step,
            _ => {}
        }
        self.scroll_intent(id, "scroll");
        self.user_scroll(id, x, y);
        steps
    }

    fn mouse_event(&mut self, mouse: MouseEvent) -> bool {
        let x = (mouse.column as f32 + 0.5) * self.metrics.width().0;
        let y = (mouse.row as f32 + 0.5) * self.metrics.height().0;
        if self.dialog.is_some() {
            return self.dialog_mouse(mouse);
        }
        let hit = self.hit_test(x, y);
        self.set_hover(hit);
        if matches!(mouse.kind, MouseEventKind::Down(_)) {
            self.selection_area_window_press(hit);
        }
        if let Some((id, button)) = self
            .pointer
            .as_ref()
            .and_then(|pointer| pointer.scroll.map(|id| (id, pointer.button)))
        {
            match mouse.kind {
                MouseEventKind::Drag(pressed) if pressed == button => {
                    self.move_scroll_drag(id, x, y);
                    if let Some(pointer) = &mut self.pointer {
                        pointer.last = (x, y);
                    }
                    return true;
                }
                MouseEventKind::Up(released) if released == button => {
                    if self
                        .pointer
                        .as_ref()
                        .is_some_and(|pointer| pointer.last != (x, y))
                    {
                        self.move_scroll_drag(id, x, y);
                    }
                    self.end_scroll_drag(id, false);
                    self.pointer = None;
                    return true;
                }
                MouseEventKind::Down(_) => self.cancel_pointer(),
                _ => {}
            }
        }
        if let MouseEventKind::Down(button) = mouse.kind
            && let Some(id) = self.scroll_ancestor(hit)
            && (button == MouseButton::Middle
                || (button == MouseButton::Left && self.scrollbar_hit(id, x, y)))
        {
            self.cancel_pointer();
            if self.begin_scroll_drag(id, x, y, button == MouseButton::Left) {
                self.pointer = Some(Pointer {
                    target: id,
                    reporting: false,
                    touch_path: Vec::new(),
                    pressable: None,
                    origin: (x, y),
                    last: (x, y),
                    started: Instant::now(),
                    moved: true,
                    long_fired: false,
                    pan_candidate: None,
                    pan: None,
                    pan_base: (0.0, 0.0),
                    native: None,
                    link: None,
                    scroll: Some(id),
                    button,
                    navigation: false,
                    navigation_claimed: false,
                });
                return true;
            }
        }
        let native = self.pointer.as_ref().and_then(|p| p.native).or_else(|| {
            hit.and_then(|id| {
                self.ancestors(id)
                    .into_iter()
                    .find(|id| self.node(*id).is_some_and(|n| n.native.is_some()))
            })
        });
        if let Some(id) = native {
            if mouse.kind == MouseEventKind::Down(MouseButton::Left) && self.focusable(id) {
                self.set_focus_from(Some(id), FocusSource::Pointer);
            }
            let captured = self.pointer.as_ref().is_some_and(|p| p.native == Some(id));
            let handled = self.native_event(id, &Event::Mouse(mouse));
            if handled && mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                self.cancel_pointer();
                self.pointer = Some(Pointer {
                    target: id,
                    reporting: false,
                    touch_path: Vec::new(),
                    pressable: None,
                    origin: (x, y),
                    last: (x, y),
                    started: Instant::now(),
                    moved: false,
                    long_fired: false,
                    pan_candidate: None,
                    pan: None,
                    pan_base: (0.0, 0.0),
                    native: Some(id),
                    link: None,
                    scroll: None,
                    button: MouseButton::Left,
                    navigation: false,
                    navigation_claimed: false,
                });
            }
            if captured && mouse.kind == MouseEventKind::Up(MouseButton::Left) {
                self.pointer = None;
            }
            if handled || captured {
                return true;
            }
        }
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                self.cancel_pointer();
                let Some(target) = hit else {
                    self.area_selection = None;
                    self.set_focus_from(None, FocusSource::Pointer);
                    return false;
                };
                let path = self.ancestors(target);
                // A concrete attachment handles its own presses before an
                // enclosing paragraph's link gets a chance to handle them.
                let (pressable, link) = path
                    .iter()
                    .copied()
                    .find_map(|id| {
                        self.text_link_at(id, x, y)
                            .map(|link| (Some(link), Some(link)))
                            .or_else(|| self.pressable(id).then_some((Some(id), None)))
                    })
                    .unwrap_or((None, None));
                let field = path.iter().copied().find(|id| {
                    self.node(*id).is_some_and(|n| {
                        n.kind == ViewKind::Input
                            || n.text
                                .as_ref()
                                .is_some_and(|(text, _, _)| text.is_selectable())
                    })
                });
                // An inline control owns its contact before the surrounding
                // selectable paragraph. A text link still permits dragging
                // through its text, as does a field inside a pressable view.
                let control = pressable.filter(|id| {
                    link.is_none()
                        && path
                            .iter()
                            .take_while(|node| Some(**node) != field)
                            .any(|node| node == id)
                });
                let selects_area = control.is_none()
                    && self.selection_area_press(
                        target,
                        x,
                        y,
                        mouse.modifiers.contains(KeyModifiers::SHIFT),
                    );
                if let Some(id) = control {
                    self.selection_area_release();
                    self.set_focus_from(Some(id), FocusSource::Pointer);
                } else if selects_area {
                    self.set_focus_from(field, FocusSource::Pointer);
                } else if let Some(id) = field {
                    // Focus changes the editor's scrolling and caret spacing.
                    // Resolve this contact using its native focus before Down.
                    let focused = self.focus == Some(id);
                    self.set_focus_from(Some(id), FocusSource::Pointer);
                    self.drag_input = Some(id);
                    self.place_caret(
                        id,
                        x,
                        y,
                        focused,
                        mouse.modifiers.contains(KeyModifiers::SHIFT),
                    );
                } else if let Some(id) = pressable {
                    self.set_focus_from(Some(id), FocusSource::Pointer);
                } else if let Some(id) = path
                    .iter()
                    .copied()
                    .find(|id| self.node(*id).is_some_and(|node| node.media.is_some()))
                {
                    self.set_focus_from(Some(id), FocusSource::Pointer);
                } else if let Some(id) = path.iter().copied().find(|id| {
                    self.node(*id)
                        .is_some_and(|node| node.kind == ViewKind::Scroll && node.scroll.enabled)
                }) {
                    self.set_focus_from(Some(id), FocusSource::Pointer);
                }
                let touch_path = path
                    .iter()
                    .copied()
                    .filter(|id| {
                        self.node(*id)
                            .is_some_and(|node| node.events.contains(EventKind::Touch))
                    })
                    .collect();
                let pan_candidate = path.into_iter().find(|id| {
                    self.node(*id).is_some_and(|n| {
                        n.gestures.pan_x.is_some()
                            || n.gestures.pan_y.is_some()
                            || n.events.contains(EventKind::PanStart)
                            || n.events.contains(EventKind::PanEnd)
                            || n.props.pan_activation.is_some()
                    })
                });
                let pan_base = pan_candidate
                    .and_then(|id| self.node(id))
                    .map_or((0.0, 0.0), |n| {
                        (
                            n.gestures
                                .pan_x
                                .and_then(|id| self.animation.value(id))
                                .unwrap_or(0.0),
                            n.gestures
                                .pan_y
                                .and_then(|id| self.animation.value(id))
                                .unwrap_or(0.0),
                        )
                    });
                let navigation = self.navigation_pointer_down(x, y);
                self.pointer = Some(Pointer {
                    target,
                    reporting: true,
                    touch_path,
                    pressable,
                    origin: (x, y),
                    last: (x, y),
                    started: Instant::now(),
                    moved: false,
                    long_fired: false,
                    pan_candidate,
                    pan: None,
                    pan_base,
                    native: None,
                    link,
                    scroll: None,
                    button: MouseButton::Left,
                    navigation,
                    navigation_claimed: false,
                });
                self.set_pressed(pressable);
                if let Some(id) = pressable {
                    self.emit_if(id, EventKind::PressDown, EventPayload::None);
                }
                self.raw_touch(TouchPhase::Start, x, y, None);
                true
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                if self.pointer.is_none() {
                    return false;
                }
                if self
                    .pointer
                    .as_ref()
                    .is_some_and(|pointer| pointer.navigation)
                    && self.navigation_pointer_drag(x, y)
                {
                    if !self
                        .pointer
                        .as_ref()
                        .is_some_and(|pointer| pointer.navigation_claimed)
                    {
                        self.raw_touch(TouchPhase::Cancel, x, y, None);
                        if let Some(id) =
                            self.pointer.as_ref().and_then(|pointer| pointer.pressable)
                        {
                            self.emit_if(id, EventKind::PressUp, EventPayload::None);
                        }
                        self.set_pressed(None);
                        self.drag_input = None;
                    }
                    if let Some(pointer) = &mut self.pointer {
                        pointer.navigation_claimed = true;
                        pointer.moved = true;
                        pointer.pressable = None;
                        pointer.last = (x, y);
                    }
                    return true;
                }
                if self.selection_area_drag(x, y) {
                    self.set_pressed(None);
                    if let Some(pointer) = &mut self.pointer {
                        pointer.moved = true;
                        pointer.pan_candidate = None;
                    }
                } else if let Some(id) = self.drag_input {
                    self.place_caret(id, x, y, self.focus == Some(id), true);
                }
                self.drag_pointer(x, y, true);
                true
            }
            MouseEventKind::Up(MouseButton::Left) => {
                if self
                    .pointer
                    .as_ref()
                    .is_some_and(|pointer| pointer.navigation)
                    && self.navigation_pointer_up(x, y)
                {
                    self.pointer = None;
                    self.drag_input = None;
                    self.set_pressed(None);
                    return true;
                }
                self.input_tick();
                if self.pointer.is_none() {
                    return false;
                }
                if self.selection_area_drag(x, y)
                    && let Some(pointer) = &mut self.pointer
                {
                    pointer.moved = true;
                }
                self.raw_touch(TouchPhase::End, x, y, None);
                let pointer = self.pointer.take().unwrap();
                if let Some(id) = pointer.pan {
                    self.pan_event(id, EventKind::PanEnd, &pointer, x, y);
                }
                if let Some(id) = pointer.pressable {
                    self.emit_if(id, EventKind::PressUp, EventPayload::None);
                    let released_inside = pointer.link.map_or_else(
                        || self.ancestors(hit.unwrap_or(ROOT_ID)).contains(&id),
                        |link| {
                            hit.is_some_and(|hit| {
                                self.ancestors(hit)
                                    .into_iter()
                                    .any(|id| self.text_link_at(id, x, y) == Some(link))
                            })
                        },
                    );
                    if !pointer.moved && !pointer.long_fired && released_inside {
                        self.emit_if(id, EventKind::Press, EventPayload::None);
                    }
                }
                self.set_pressed(None);
                self.drag_input = None;
                self.selection_area_release();
                true
            }
            MouseEventKind::Moved => hit.is_some(),
            _ => false,
        }
    }

    fn dialog_mouse(&mut self, mouse: MouseEvent) -> bool {
        let Some(dialog) = self.dialog.as_ref() else {
            return false;
        };
        let (area, buttons) =
            crate::render::dialog_geometry(self.columns, self.rows, dialog, self.dialog_selection);
        if let Some(index) = buttons.iter().find_map(|(index, rect)| {
            rect.contains(ratatui::layout::Position::new(mouse.column, mouse.row))
                .then_some(*index)
        }) {
            self.dialog_selection = index;
            if mouse.kind == MouseEventKind::Up(MouseButton::Left) {
                self.answer_dialog(index as i32);
            }
        } else if dialog.cancelable
            && mouse.kind == MouseEventKind::Up(MouseButton::Left)
            && !area.contains(ratatui::layout::Position::new(mouse.column, mouse.row))
        {
            self.answer_dialog(-1);
        }
        true
    }

    fn place_caret(&mut self, id: NodeId, x: f32, y: f32, focused: bool, extend: bool) {
        if self.node(id).is_some_and(|n| n.kind == ViewKind::Text) {
            if let Some(offset) = self.text_offset_at(id, x, y)
                && let Some(node) = self.node_mut(id)
            {
                node.editor.move_to(offset, extend);
            }
            return;
        }
        let (Some(node), Some(geometry)) = (self.node(id), self.input_hit_geometry(id)) else {
            return;
        };
        let (x, y) = if self.composite_ancestor(id) {
            let Some(point) = self.surface_to_local(id, x, y) else {
                return;
            };
            point
        } else {
            (x, y)
        };
        let cols = geometry.columns.max(1);
        let rows = geometry.rows.max(1);
        let columns = if node.input.multiline {
            cols
        } else {
            usize::MAX
        };
        let (origin_row, origin_col) = crate::render::input_scroll(node, focused, cols, rows);
        let row = ((y / self.metrics.height().0).floor() as i64 - geometry.row).max(0) as usize
            + origin_row;
        let col = ((x / self.metrics.width().0).floor() as i64 - geometry.column).max(0) as usize
            + origin_col;
        let offsets = crate::render::input_line_offsets(node, focused, cols);
        let col = col.saturating_sub(offsets.get(row).copied().unwrap_or(0));
        let offset = node.editor.offset_at(row, col, columns, node.input.secure);
        self.edit_input(id, |editor, _| {
            editor.move_to(offset, extend);
            false
        });
    }

    pub(crate) fn input_hit_geometry(&self, id: NodeId) -> Option<crate::render::InputGeometry> {
        let node = self.node(id)?;
        if self.composite_ancestor(id) {
            let mut frame = self.presentation_frame(id)?;
            frame.origin.x.0 = 0.0;
            frame.origin.y.0 = 0.0;
            let area = ratatui::layout::Rect::new(
                0,
                0,
                (frame.size.width.0 / self.metrics.width().0)
                    .ceil()
                    .clamp(1.0, u16::MAX as f32) as u16,
                (frame.size.height.0 / self.metrics.height().0)
                    .ceil()
                    .clamp(1.0, u16::MAX as f32) as u16,
            );
            Some(crate::render::input_geometry(
                node,
                frame,
                self.metrics,
                area,
            ))
        } else {
            Some(crate::render::input_geometry(
                node,
                self.global_frame(id)?,
                self.metrics,
                ratatui::layout::Rect::new(0, 0, self.columns, self.rows),
            ))
        }
    }

    fn text_link_at(&self, id: NodeId, x: f32, y: f32) -> Option<NodeId> {
        let (text, layout, content) = self.node(id)?.text.as_ref()?;
        let attachment = (!text.attachments.is_empty())
            .then(|| {
                let layout = layout.downcast::<crate::text::TerminalLayout>()?;
                let (x, y) = self.surface_to_local(id, x, y)?;
                layout.attachment_rects(text).find_map(|(index, rect)| {
                    crate::surface::contains(rect, x - content.origin.x.0, y - content.origin.y.0)
                        .then_some(index)
                })
            })
            .flatten();
        let index = match attachment {
            Some(index) => index,
            None => {
                let (run, x, y, _) = self.text_run_at(id, x, y)?;
                if x < run.x.0
                    || x >= run.x.0 + run.width as f32 * self.metrics.width().0
                    || y < run.y.0
                    || y >= run.y.0 + self.metrics.height().0
                {
                    return None;
                }
                run.start
            }
        };
        text.link_at(index)
            .filter(|link| link.is_enabled())
            .map(|link| link.node)
    }

    pub(crate) fn text_offset_at(&self, id: NodeId, x: f32, y: f32) -> Option<u32> {
        self.text_run_at(id, x, y).map(|(_, _, _, offset)| offset)
    }

    fn text_run_at(
        &self,
        id: NodeId,
        x: f32,
        y: f32,
    ) -> Option<(&crate::text::TerminalRun, f32, f32, u32)> {
        let node = self.node(id)?;
        let (_, layout, content) = node.text.as_ref()?;
        let layout = layout.downcast::<crate::text::TerminalLayout>()?;
        let (frame, x, y) = if self.composite_ancestor(id) {
            let (x, y) = self.surface_to_local(id, x, y)?;
            let mut frame = self.presentation_frame(id)?;
            frame.origin.x.0 = 0.0;
            frame.origin.y.0 = 0.0;
            (frame, x, y)
        } else {
            (self.global_frame(id)?, x, y)
        };
        let sx = if node.frame.size.width.0 > 0.0 {
            frame.size.width.0 / node.frame.size.width.0
        } else {
            1.0
        };
        let sy = if node.frame.size.height.0 > 0.0 {
            frame.size.height.0 / node.frame.size.height.0
        } else {
            1.0
        };
        let origin = (
            frame.origin.x.0 + content.origin.x.0 * sx,
            frame.origin.y.0 + content.origin.y.0 * sy,
        );
        let column = (x / self.metrics.width().0).floor();
        let row = (y / self.metrics.height().0).floor();
        let run_position = |run: &crate::text::TerminalRun| {
            (
                self.metrics.column_at(px(origin.0 + run.x.0)),
                self.metrics.row_at(px(origin.1 + run.y.0)),
            )
        };
        let (index, run) = layout.runs.iter().enumerate().min_by(|(_, a), (_, b)| {
            let distance = |run: &crate::text::TerminalRun| {
                let (left, top) = run_position(run);
                let dy = (row - top).abs();
                let dx = (left - column)
                    .max(column - left - run.width.max(1) as f32 + 1.0)
                    .max(0.0);
                (dy, dx)
            };
            let (ay, ax) = distance(a);
            let (by, bx) = distance(b);
            ay.total_cmp(&by).then_with(|| ax.total_cmp(&bx))
        })?;
        let (left, top) = run_position(run);
        let cell_x = run.x.0 + (column - left + 0.5) * self.metrics.width().0;
        // A cell-only pointer must be able to reach a line's leading caret,
        // including a SelectionModel point clamped to a fractional text origin.
        let leading_cell = column <= left && (index == 0 || layout.runs[index - 1].y != run.y);
        let right = x >= origin.0 + content.size.width.0 * sx
            || (!leading_cell
                && cell_x >= run.x.0 + run.width as f32 * self.metrics.width().0 * 0.5);
        Some((
            run,
            cell_x,
            run.y.0 + (row - top + 0.5) * self.metrics.height().0,
            if right != run.rtl { run.end } else { run.start },
        ))
    }

    fn set_pressed(&mut self, pressed: Option<NodeId>) {
        if self.pressed == pressed {
            return;
        }
        let previous = self.pressed;
        let hover = self.hovered_path.clone();
        self.pressed = pressed;
        self.report_states(self.focus, previous, &hover);
    }

    pub(crate) fn set_hover(&mut self, target: Option<NodeId>) {
        let next: Vec<_> = target
            .map(|id| self.ancestors(id))
            .unwrap_or_default()
            .into_iter()
            .filter(|id| {
                self.node(*id).is_some_and(|n| {
                    n.tracked & state::HOVERED != 0
                        || n.events.contains(EventKind::HoverIn)
                        || n.events.contains(EventKind::HoverOut)
                })
            })
            .collect();
        let previous = std::mem::replace(&mut self.hovered_path, next);
        self.hovered = target;
        for id in &previous {
            if !self.hovered_path.contains(id) {
                self.emit_if(*id, EventKind::HoverOut, EventPayload::None);
            }
        }
        let entering: Vec<_> = self
            .hovered_path
            .iter()
            .rev()
            .copied()
            .filter(|id| !previous.contains(id))
            .collect();
        for id in entering {
            self.emit_if(id, EventKind::HoverIn, EventPayload::None);
        }
        self.report_states(self.focus, self.pressed, &previous);
    }

    fn interaction_states(
        id: NodeId,
        focus: Option<NodeId>,
        focus_chain: &[NodeId],
        pressed: Option<NodeId>,
        hover: &[NodeId],
    ) -> u8 {
        let mut states = 0;
        if focus == Some(id) {
            states |= state::FOCUSED;
        }
        if focus_chain.contains(&id) {
            states |= state::FOCUS_WITHIN;
        }
        if pressed == Some(id) {
            states |= state::PRESSED;
        }
        if hover.contains(&id) {
            states |= state::HOVERED;
        }
        states
    }

    fn report_states(
        &mut self,
        old_focus: Option<NodeId>,
        old_pressed: Option<NodeId>,
        old_hover: &[NodeId],
    ) {
        let old_chain = old_focus.map(|id| self.ancestors(id)).unwrap_or_default();
        let new_chain = self.focus.map(|id| self.ancestors(id)).unwrap_or_default();
        let mut affected = old_chain.clone();
        affected.extend_from_slice(&new_chain);
        affected.extend_from_slice(old_hover);
        affected.extend_from_slice(&self.hovered_path);
        affected.extend(old_pressed);
        affected.extend(self.pressed);
        affected.sort_unstable();
        affected.dedup();
        for id in affected {
            let tracked = self.node(id).map_or(0, |n| n.tracked);
            let before =
                Self::interaction_states(id, old_focus, &old_chain, old_pressed, old_hover)
                    & tracked;
            let after = Self::interaction_states(
                id,
                self.focus,
                &new_chain,
                self.pressed,
                &self.hovered_path,
            ) & tracked;
            if before != after {
                self.events.push(SurfaceEvent::States(id, after));
            }
        }
    }

    /// A newly mounted state mask must receive the current state even
    /// when no pointer or focus transition followed the batch.
    pub(crate) fn refresh_input_states(&mut self, id: NodeId) {
        self.set_hover(self.hovered);
        let chain = self.focus.map(|id| self.ancestors(id)).unwrap_or_default();
        let tracked = self.node(id).map_or(0, |n| n.tracked);
        if tracked != 0 {
            let states =
                Self::interaction_states(id, self.focus, &chain, self.pressed, &self.hovered_path)
                    & tracked;
            self.events.push(SurfaceEvent::States(id, states));
        }
    }

    fn raw_touch(&mut self, phase: TouchPhase, x: f32, y: f32, activated: Option<NodeId>) {
        let Some(pointer) = self.pointer.as_ref() else {
            return;
        };
        if !pointer.reporting {
            return;
        }
        let path = pointer.touch_path.clone();
        if path.is_empty() {
            if phase == TouchPhase::Start {
                self.pointer.as_mut().unwrap().reporting = false;
            }
            return;
        }
        if phase == TouchPhase::Start
            && !path.iter().any(|id| {
                self.node(*id)
                    .is_some_and(|node| node.events.contains_listener(EventKind::Touch))
            })
        {
            let watches = path
                .into_iter()
                .filter_map(|id| self.node(id).and_then(|node| node.events.hint_watch()))
                .collect();
            self.events
                .push(SurfaceEvent::HintObservation(HintObservation::Press(
                    watches,
                )));
            let pointer = self.pointer.as_mut().unwrap();
            pointer.reporting = false;
            pointer.touch_path.clear();
            return;
        }
        let location = self
            .surface_to_local(pointer.target, x, y)
            .unwrap_or_default();
        let point = TouchPoint {
            id: 0,
            target: pointer.target,
            path,
            page: point(px(x), px(y)),
            location: point(px(location.0), px(location.1)),
            changed: true,
        };
        let event = TouchEvent {
            phase,
            timestamp: pointer.started.elapsed().as_secs_f64() * 1000.0,
            points: vec![point],
            activated,
        };
        self.emit(
            ROOT_ID,
            EventKind::Touch,
            EventPayload::Touch(Box::new(event)),
        );
    }

    pub(crate) fn drag_pointer(&mut self, x: f32, y: f32, report_touch: bool) {
        let Some(mut pointer) = self.pointer.take() else {
            return;
        };
        let (dx, dy) = (x - pointer.origin.0, y - pointer.origin.1);
        if dx.hypot(dy) > self.metrics.width().0.min(self.metrics.height().0) {
            pointer.moved = true;
            self.set_pressed(None);
        }
        let mut activated = None;
        if pointer.pan.is_none()
            && self.drag_input.is_none()
            && !self.selection_area_dragging()
            && let Some(id) = pointer.pan_candidate
        {
            let (dx, dy) = self.pan_delta(id, &pointer, x, y);
            let decision = self.node(id).map_or(Some(false), |n| {
                n.props.pan_activation.map_or_else(
                    || {
                        if dx.hypot(dy) > nsh_core::PanActivation::MIN_DISTANCE.0 {
                            Some(true)
                        } else {
                            None
                        }
                    },
                    |gate| gate.decide(px(dx), px(dy)),
                )
            });
            match decision {
                Some(true) => {
                    pointer.pan = Some(id);
                    activated = Some(id);
                    self.pan_event(id, EventKind::PanStart, &pointer, x, y);
                }
                Some(false) => pointer.pan_candidate = None,
                None => {}
            }
        }
        if let Some(id) = pointer.pan {
            let (dx, dy) = self.pan_delta(id, &pointer, x, y);
            let gestures = self.node(id).map(|n| n.gestures);
            if let Some(gestures) = gestures {
                let mut finished = Vec::new();
                if let Some(value) = gestures.pan_x {
                    self.animation
                        .set(value, pointer.pan_base.0 + dx, &mut finished);
                }
                if let Some(value) = gestures.pan_y {
                    self.animation
                        .set(value, pointer.pan_base.1 + dy, &mut finished);
                }
                if !finished.is_empty() {
                    self.events.push(SurfaceEvent::AnimationsFinished(finished));
                }
            }
        }
        pointer.last = (x, y);
        self.pointer = Some(pointer);
        if report_touch {
            self.raw_touch(TouchPhase::Move, x, y, activated);
        }
    }

    fn pan_event(&mut self, id: NodeId, kind: EventKind, pointer: &Pointer, x: f32, y: f32) {
        let elapsed = pointer.started.elapsed().as_secs_f32().max(0.001);
        let (dx, dy) = self.pan_delta(id, pointer, x, y);
        let gestures = self.node(id).map(|n| n.gestures).unwrap_or_default();
        self.emit_if(
            id,
            kind,
            EventPayload::Pan {
                translation: point(px(dx), px(dy)),
                velocity_x: dx / elapsed,
                velocity_y: dy / elapsed,
                value_x: gestures.pan_x.map(|_| px(pointer.pan_base.0 + dx)),
                value_y: gestures.pan_y.map(|_| px(pointer.pan_base.1 + dy)),
            },
        );
    }

    fn pan_delta(&self, id: NodeId, pointer: &Pointer, x: f32, y: f32) -> (f32, f32) {
        match (
            self.surface_to_local(id, pointer.origin.0, pointer.origin.1),
            self.surface_to_local(id, x, y),
        ) {
            (Some(from), Some(to)) => (to.0 - from.0, to.1 - from.1),
            _ => (0.0, 0.0),
        }
    }

    /// Clears hover and native capture when the pointer leaves the input region.
    /// Keyboard focus and the editor's selection remain active.
    pub fn pointer_left(&mut self) {
        self.set_hover(None);
        self.cancel_pointer();
    }

    /// Cancels native pointer capture while retaining keyboard focus.
    /// Hosts call this when their input region changes, then forward the
    /// resulting events before delivering more pointer input.
    pub fn cancel_pointer(&mut self) {
        if let Some(pointer) = self.pointer.as_ref().filter(|pointer| {
            pointer.scroll.is_none() && pointer.native.is_none() && !pointer.navigation_claimed
        }) {
            let (x, y) = pointer.last;
            self.raw_touch(TouchPhase::Cancel, x, y, None);
        }
        if let Some(pointer) = self.pointer.take() {
            if pointer.navigation {
                self.navigation_pointer_cancel();
            }
            if let Some(id) = pointer.scroll {
                self.end_scroll_drag(id, true);
            }
            if let Some(id) = pointer.pressable {
                self.emit_if(id, EventKind::PressUp, EventPayload::None);
            }
            if let Some(id) = pointer.pan {
                self.pan_event(
                    id,
                    EventKind::PanEnd,
                    &pointer,
                    pointer.last.0,
                    pointer.last.1,
                );
            }
        }
        self.set_pressed(None);
        self.drag_input = None;
        self.selection_area_release();
    }

    pub(crate) fn input_pending(&self) -> bool {
        self.selection_area_pending()
            || self.pointer.as_ref().is_some_and(|pointer| {
                !pointer.moved
                    && !pointer.long_fired
                    && pointer.pressable.is_some_and(|id| {
                        self.node(id)
                            .is_some_and(|n| n.events.contains(EventKind::LongPress))
                    })
            })
    }

    pub(crate) fn input_tick(&mut self) -> bool {
        let selecting = self.selection_area_tick();
        let Some(pointer) = self.pointer.as_ref() else {
            return selecting;
        };
        let Some(id) = pointer.pressable else {
            return selecting;
        };
        if pointer.moved || pointer.long_fired {
            return selecting;
        }
        let Some(node) = self.node(id) else {
            return selecting;
        };
        if !node.events.contains(EventKind::LongPress)
            || pointer.started.elapsed().as_secs_f32() * 1000.0
                < node.props.long_press_delay.unwrap_or(500.0)
        {
            return selecting;
        }
        if let Some(pointer) = self.pointer.as_mut() {
            pointer.long_fired = true;
        }
        self.emit_if(id, EventKind::LongPress, EventPayload::None);
        true
    }
}

fn keystroke(event: KeyEvent) -> Option<Keystroke> {
    let mut modifiers = Modifiers {
        ctrl: event.modifiers.contains(KeyModifiers::CONTROL),
        alt: event.modifiers.contains(KeyModifiers::ALT),
        shift: event.modifiers.contains(KeyModifiers::SHIFT) || event.code == KeyCode::BackTab,
        cmd: event.modifiers.contains(KeyModifiers::SUPER),
    };
    let key = match event.code {
        KeyCode::Char(c) => {
            let shifted = "~!@#$%^&*()_+{}|:\"<>?";
            let bases = "`1234567890-=[]\\;',./";
            let base = shifted
                .chars()
                .position(|s| s == c)
                .and_then(|i| bases.chars().nth(i));
            if base.is_some() || c.is_ascii_uppercase() {
                modifiers.shift = true;
            }
            Key::Char(base.unwrap_or(c.to_ascii_lowercase()))
        }
        KeyCode::Enter => Key::Enter,
        KeyCode::Esc => Key::Escape,
        KeyCode::Tab | KeyCode::BackTab => Key::Tab,
        KeyCode::Backspace => Key::Backspace,
        KeyCode::Delete => Key::Delete,
        KeyCode::Insert => Key::Insert,
        KeyCode::Up => Key::Up,
        KeyCode::Down => Key::Down,
        KeyCode::Left => Key::Left,
        KeyCode::Right => Key::Right,
        KeyCode::Home => Key::Home,
        KeyCode::End => Key::End,
        KeyCode::PageUp => Key::PageUp,
        KeyCode::PageDown => Key::PageDown,
        KeyCode::F(n) => Key::F(n),
        _ => return None,
    };
    Some(Keystroke { modifiers, key })
}

#[cfg(test)]
mod tests {
    use nsh_core::{Bounds, Command, Point, Size};

    use super::*;

    #[test]
    fn terminal_shortcuts_normalize_shifted_printable_keys() {
        let stroke = keystroke(KeyEvent::new(KeyCode::Char('?'), KeyModifiers::NONE)).unwrap();
        assert_eq!(stroke.key, Key::Char('/'));
        assert!(stroke.modifiers.shift);
        let stroke = keystroke(KeyEvent::new(KeyCode::Char('K'), KeyModifiers::CONTROL)).unwrap();
        assert_eq!(stroke.key, Key::Char('k'));
        assert!(stroke.modifiers.ctrl && stroke.modifiers.shift);
        let stroke = keystroke(KeyEvent::new(KeyCode::BackTab, KeyModifiers::NONE)).unwrap();
        assert_eq!(stroke.key, Key::Tab);
        assert!(stroke.modifiers.shift);
    }

    fn mask(events: &[EventKind]) -> nsh_core::EventMask {
        let mut mask = nsh_core::EventMask::default();
        for kind in events {
            mask.set(*kind, true);
        }
        mask
    }

    fn create(id: NodeId, kind: ViewKind, parent: NodeId, y: f32) -> Vec<nsh_core::MountItem> {
        use nsh_core::MountItem;
        vec![
            MountItem::Create { id, kind },
            MountItem::Frame {
                id,
                frame: Bounds::new(
                    Point::new(px(0.0), (y).into()),
                    Size::new(px(160.0), px(32.0)),
                ),
            },
            MountItem::Insert {
                parent,
                child: id,
                before: None,
            },
        ]
    }

    #[test]
    fn retiring_a_dragged_row_keeps_its_surviving_ancestor_pan() {
        use nsh_core::{GestureValues, MountBatch, MountItem};

        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::View, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::View, 2, 0.0));
        items.extend([
            MountItem::Events {
                id: 2,
                events: mask(&[EventKind::PanStart, EventKind::PanEnd]),
            },
            MountItem::Events {
                id: 4,
                events: mask(&[EventKind::Touch]),
            },
            MountItem::Animation(nsh_core::animation::AnimationOp::CreateValue {
                node: 17,
                value: 0.0,
            }),
            MountItem::Gestures {
                id: 2,
                values: GestureValues {
                    pan_x: Some(17),
                    ..Default::default()
                },
            },
        ]);
        surface.apply(MountBatch { items });
        let mouse = |kind, column| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row: 0,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5));
        let before = surface.animation.value(17).unwrap();
        assert!(before > 0.0);
        surface.apply(MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 4,
                request: 1,
                roots: vec![4],
            }],
        });
        assert_eq!(surface.node(4).unwrap().parent, None);
        surface.drain_events().for_each(drop);
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 8));
        assert!(surface.animation.value(17).unwrap() > before);
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 8));
        assert!(surface.pointer.is_none());
        let events: Vec<_> = surface.drain_events().collect();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, SurfaceEvent::Event(2, EventKind::PanEnd, _)))
                .count(),
            1
        );
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(_, EventKind::Touch, _)))
        );
    }

    fn form() -> Surface {
        use nsh_core::{MountBatch, MountItem};
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Input, ROOT_ID, 0.0);
        items.push(MountItem::InputContent {
            id: 2,
            content: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(160.0), px(32.0))),
        });
        items.extend(create(4, ViewKind::View, ROOT_ID, 48.0));
        items.push(MountItem::Events {
            id: 4,
            events: mask(&[EventKind::Press, EventKind::PressDown, EventKind::PressUp]),
        });
        surface.apply(MountBatch { items });
        surface.events.clear();
        surface
    }

    fn key(surface: &mut Surface, code: KeyCode, modifiers: KeyModifiers) {
        surface.handle_event(Event::Key(KeyEvent::new(code, modifiers)));
    }

    #[test]
    fn source_removal_cancels_an_unmounted_inputs_old_autofocus_request() {
        use nsh_core::{InputConfig, MountBatch, MountItem};

        for remove in [false, true] {
            let mut surface = form();
            assert_eq!(surface.focused(), Some(2));
            surface.apply(MountBatch {
                items: vec![
                    MountItem::Create {
                        id: 8,
                        kind: ViewKind::Input,
                    },
                    MountItem::Input {
                        id: 8,
                        config: Box::new(InputConfig {
                            auto_focus: true,
                            ..Default::default()
                        }),
                    },
                    MountItem::Frame {
                        id: 8,
                        frame: Bounds::new(
                            Point::new(px(0.0), px(96.0)),
                            Size::new(px(160.0), px(32.0)),
                        ),
                    },
                ],
            });
            assert_eq!(surface.focused(), Some(2));
            let mut items = Vec::new();
            if remove {
                items.push(MountItem::Remove { id: 8 });
            }
            items.push(MountItem::Insert {
                parent: ROOT_ID,
                child: 8,
                before: None,
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(if remove { 2 } else { 8 }));
            if remove {
                surface.apply(MountBatch {
                    items: vec![MountItem::Command {
                        id: 8,
                        command: Command::Focus,
                    }],
                });
                assert_eq!(surface.focused(), Some(8));
            }
        }
    }

    #[test]
    fn paste_behavior_reports_before_inserting_or_preserves_text() {
        use nsh_core::{InputConfig, MountBatch, MountItem, PasteBehavior};

        use crate::services::ClipboardContent;

        for asynchronous in [false, true] {
            for behavior in [PasteBehavior::Report, PasteBehavior::Insert] {
                let mut surface = form();
                let config = InputConfig {
                    multiline: true,
                    paste_behavior: behavior,
                    ..Default::default()
                };
                surface.apply(MountBatch {
                    items: vec![
                        MountItem::Input {
                            id: 2,
                            config: Box::new(config),
                        },
                        MountItem::InputValue {
                            id: 2,
                            text: "abc".into(),
                            count: 0,
                        },
                        MountItem::Events {
                            id: 2,
                            events: mask(&[EventKind::Paste, EventKind::ChangeText]),
                        },
                    ],
                });
                surface.set_focus(Some(2));
                surface.selection(2, 1, 2);
                let before = surface.input_context().unwrap();
                surface.events.clear();
                let text = "X\r\nY\t";
                if asynchronous {
                    let edit = InputEdit {
                        node: 2,
                        expected_event_count: before.event_count,
                        selection: before.selection.clone(),
                        replacement: String::new(),
                    };
                    surface.complete_paste(edit, Ok(ClipboardContent::Text(text.into())));
                } else {
                    assert!(surface.handle_event(Event::Paste(text.into())));
                }
                let after = surface.input_context().unwrap();
                if behavior == PasteBehavior::Report {
                    assert_eq!(after.text.as_deref(), Some("abc"));
                    assert_eq!(after.selection, before.selection);
                    assert_eq!(after.event_count, before.event_count);
                } else {
                    assert_eq!(after.text, Some(format!("a{text}c")));
                    assert_eq!(after.event_count, before.event_count + 1);
                }
                let events: Vec<_> = surface
                    .events
                    .iter()
                    .filter_map(|event| {
                        if let SurfaceEvent::Event(2, kind, payload) = event {
                            Some((*kind, payload))
                        } else {
                            None
                        }
                    })
                    .collect();
                assert!(
                    matches!(events.first(), Some((EventKind::Paste, EventPayload::Paste(paste))) if paste.text == text && paste.files.is_empty() && paste.uris.is_empty())
                );
                let kinds: Vec<_> = events.iter().map(|(kind, _)| *kind).collect();
                assert_eq!(
                    kinds,
                    if behavior == PasteBehavior::Report {
                        vec![EventKind::Paste]
                    } else {
                        vec![EventKind::Paste, EventKind::ChangeText]
                    }
                );
            }
        }
    }

    #[test]
    fn paste_reporting_keeps_async_admission_and_readonly_boundaries() {
        use nsh_core::{
            MountBatch, MountItem,
            access::{Access, Capabilities},
        };

        use crate::services::ClipboardContent;

        for boundary in 0..5 {
            let mut surface = form();
            surface.apply(MountBatch {
                items: vec![
                    MountItem::InputValue {
                        id: 2,
                        text: "abc".into(),
                        count: 0,
                    },
                    MountItem::Events {
                        id: 2,
                        events: mask(&[EventKind::Paste]),
                    },
                ],
            });
            surface.set_focus(Some(2));
            surface.selection(2, 1, 2);
            let context = surface.input_context().unwrap();
            let edit = InputEdit {
                node: 2,
                expected_event_count: context.event_count,
                selection: context.selection,
                replacement: String::new(),
            };
            match boundary {
                0 => surface.node_mut(2).unwrap().input.editable = false,
                1 => surface.selection(2, 0, 1),
                2 => surface.set_focus(None),
                3 => surface.set_access(Access {
                    declared: Capabilities::from_json(&serde_json::json!({})).unwrap(),
                    granted: None,
                }),
                _ => {
                    surface.edit_input(2, |editor, config| editor.replace("updated", config));
                }
            }
            surface.events.clear();
            let before = surface.node(2).unwrap().editor.text().to_owned();
            surface.complete_paste(edit, Ok(ClipboardContent::Text("late".into())));
            assert_eq!(surface.node(2).unwrap().editor.text(), before);
            assert!(surface.events.is_empty());
            if boundary == 0 {
                assert!(surface.handle_event(Event::Paste("readonly".into())));
                assert_eq!(surface.node(2).unwrap().editor.text(), before);
                assert!(surface.events.is_empty());
            }
        }
    }

    #[test]
    fn pointer_leave_clears_hover_and_capture_without_losing_the_editor() {
        use nsh_core::{MountBatch, MountItem};

        let mut surface = form();
        surface.handle_event(Event::Paste("abcdef".into()));
        key(&mut surface, KeyCode::Home, KeyModifiers::NONE);
        key(&mut surface, KeyCode::Right, KeyModifiers::NONE);
        key(&mut surface, KeyCode::Right, KeyModifiers::NONE);
        surface.apply(MountBatch {
            items: vec![
                MountItem::Events {
                    id: 2,
                    events: mask(&[
                        EventKind::HoverIn,
                        EventKind::HoverOut,
                        EventKind::PressDown,
                        EventKind::PressUp,
                        EventKind::Press,
                        EventKind::Focus,
                        EventKind::Blur,
                        EventKind::SelectionChange,
                    ]),
                },
                MountItem::TrackStates {
                    id: 2,
                    states: state::HOVERED | state::PRESSED | state::FOCUSED,
                },
            ],
        });
        surface.events.clear();
        let mouse = |kind| {
            Event::Mouse(MouseEvent {
                kind,
                column: 2,
                row: 0,
                modifiers: KeyModifiers::NONE,
            })
        };
        assert!(surface.handle_event(mouse(MouseEventKind::Moved)));
        assert!(surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left))));
        let entered: Vec<_> = surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, kind, payload) => Some((id, kind, payload)),
                _ => None,
            })
            .collect();
        assert_eq!(
            entered,
            [
                (2, EventKind::HoverIn, EventPayload::None),
                (2, EventKind::PressDown, EventPayload::None),
            ]
        );
        assert_eq!(surface.focused(), Some(2));
        assert_eq!(surface.input_context().unwrap().selection, 2..2);

        surface.pointer_left();
        assert_eq!(surface.focused(), Some(2));
        assert_eq!(surface.input_context().unwrap().selection, 2..2);
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some("abcdef")
        );
        let states: Vec<_> = surface
            .events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::States(2, states) => Some(*states),
                _ => None,
            })
            .collect();
        assert_eq!(states, [state::FOCUSED | state::PRESSED, state::FOCUSED]);
        let left: Vec<_> = surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, kind, payload) => Some((id, kind, payload)),
                _ => None,
            })
            .collect();
        assert_eq!(
            left,
            [
                (2, EventKind::HoverOut, EventPayload::None),
                (2, EventKind::PressUp, EventPayload::None),
            ]
        );

        // A real Up can restore hover, but cannot complete the cancelled press.
        assert!(!surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left))));
        let released: Vec<_> = surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, kind, payload) => Some((id, kind, payload)),
                _ => None,
            })
            .collect();
        assert_eq!(released, [(2, EventKind::HoverIn, EventPayload::None)]);
        for kind in [
            MouseEventKind::Moved,
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            assert!(surface.handle_event(mouse(kind)));
        }
        let resumed: Vec<_> = surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, kind, payload) => Some((id, kind, payload)),
                _ => None,
            })
            .collect();
        assert_eq!(
            resumed,
            [
                (2, EventKind::PressDown, EventPayload::None),
                (2, EventKind::PressUp, EventPayload::None),
                (2, EventKind::Press, EventPayload::None),
            ]
        );
        assert_eq!(surface.focused(), Some(2));
        assert_eq!(surface.input_context().unwrap().selection, 2..2);
    }

    #[test]
    fn first_pointer_focus_places_the_caret_in_visible_input_text() {
        use nsh_core::{InputConfig, MountBatch, MountItem, TextAlign};

        for (text, multiline, align, click, visible, caret, edited) in [
            (
                "abcdefghijklmno",
                false,
                TextAlign::Left,
                (1, 4),
                &["abcd"][..],
                1,
                "aXbcdefghijklmno",
            ),
            (
                "ab",
                false,
                TextAlign::Right,
                (2, 4),
                &["  ab"][..],
                0,
                "Xab",
            ),
            (
                "abcd\nefgh\nijkl",
                true,
                TextAlign::Left,
                (1, 5),
                &["abcd", "efgh"][..],
                6,
                "abcd\neXfgh\nijkl",
            ),
        ] {
            let mut surface = form();
            let mut items = create(10, ViewKind::Input, ROOT_ID, 64.0);
            items.extend([
                MountItem::Frame {
                    id: 10,
                    frame: Bounds::new(
                        point(px(0.0), px(64.0)),
                        Size::new(px(32.0), px(if multiline { 32.0 } else { 16.0 })),
                    ),
                },
                MountItem::Input {
                    id: 10,
                    config: Box::new(InputConfig {
                        multiline,
                        align,
                        ..Default::default()
                    }),
                },
                MountItem::InputValue {
                    id: 10,
                    text: text.into(),
                    count: 0,
                },
                MountItem::Events {
                    id: 10,
                    events: mask(&[EventKind::Focus, EventKind::SelectionChange]),
                },
            ]);
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(2));
            assert_eq!(
                surface
                    .snapshot()
                    .lines()
                    .skip(4)
                    .take(visible.len())
                    .collect::<Vec<_>>(),
                visible
            );
            surface.events.clear();
            assert!(surface.handle_event(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: click.0,
                row: click.1,
                modifiers: KeyModifiers::NONE,
            })));
            assert_eq!(surface.focused(), Some(10));
            assert_eq!(surface.input_context().unwrap().selection, caret..caret);
            assert_eq!(
                surface
                    .snapshot()
                    .lines()
                    .skip(4)
                    .take(visible.len())
                    .collect::<Vec<_>>(),
                visible
            );
            let callbacks: Vec<_> = surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, kind, payload) => Some((id, kind, payload)),
                    _ => None,
                })
                .collect();
            assert_eq!(
                callbacks,
                [
                    (10, EventKind::Focus, EventPayload::None),
                    (
                        10,
                        EventKind::SelectionChange,
                        EventPayload::Map(vec![
                            ("start", PayloadValue::Number(f64::from(caret))),
                            ("end", PayloadValue::Number(f64::from(caret))),
                        ])
                    ),
                ]
            );
            assert!(surface.handle_event(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Up(MouseButton::Left),
                column: click.0,
                row: click.1,
                modifiers: KeyModifiers::NONE,
            })));
            surface.handle_event(Event::Paste("X".into()));
            assert_eq!(
                surface.input_context().unwrap().text.as_deref(),
                Some(edited)
            );
        }
    }

    #[test]
    fn pointer_caret_resolves_the_current_focused_scroll_offset() {
        use nsh_core::{MountBatch, MountItem};

        let mut surface = form();
        let mut items = create(10, ViewKind::Input, ROOT_ID, 64.0);
        items.extend([
            MountItem::Frame {
                id: 10,
                frame: Bounds::new(point(px(0.0), px(64.0)), Size::new(px(32.0), px(16.0))),
            },
            MountItem::InputValue {
                id: 10,
                text: "abcdefghijklmno".into(),
                count: 0,
            },
            MountItem::Command {
                id: 10,
                command: Command::Focus,
            },
        ]);
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(10));
        assert_eq!(surface.input_context().unwrap().selection, 15..15);
        assert_eq!(surface.snapshot().lines().nth(4), Some("mno"));
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            assert!(surface.handle_event(Event::Mouse(MouseEvent {
                kind,
                column: 1,
                row: 4,
                modifiers: KeyModifiers::NONE,
            })));
            assert_eq!(surface.input_context().unwrap().selection, 13..13);
        }
        // Clicking visible text keeps its viewport stable; only a caret
        // outside the viewport asks the editor to reveal another range.
        assert_eq!(surface.snapshot().lines().nth(4), Some("mno"));
        surface.handle_event(Event::Paste("X".into()));
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some("abcdefghijklmXno")
        );
    }

    #[test]
    fn captured_editor_drags_continue_with_native_horizontal_scroll() {
        use nsh_core::{MountBatch, MountItem};

        let mut surface = form();
        let mut items = create(10, ViewKind::Input, ROOT_ID, 64.0);
        items.extend([
            MountItem::Frame {
                id: 10,
                frame: Bounds::new(point(px(0.0), px(64.0)), Size::new(px(32.0), px(16.0))),
            },
            MountItem::InputValue {
                id: 10,
                text: "abcdefghijklmno".into(),
                count: 0,
            },
            MountItem::Command {
                id: 10,
                command: Command::Focus,
            },
        ]);
        surface.apply(MountBatch { items });
        key(&mut surface, KeyCode::Home, KeyModifiers::NONE);
        let mouse = |kind, column| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row: 4,
                modifiers: KeyModifiers::NONE,
            })
        };
        assert!(surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1)));
        assert_eq!(surface.input_context().unwrap().selection, 1..1);
        let drag = mouse(MouseEventKind::Drag(MouseButton::Left), 6);
        assert!(surface.handle_event(drag.clone()));
        assert_eq!(surface.input_context().unwrap().selection, 1..6);
        assert_eq!(surface.snapshot().lines().nth(4), Some("defg"));
        assert!(surface.handle_event(drag));
        assert_eq!(surface.input_context().unwrap().selection, 1..9);
        assert_eq!(surface.snapshot().lines().nth(4), Some("ghij"));
        assert!(surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 6)));
        surface.handle_event(Event::Paste("X".into()));
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some("aXjklmno")
        );
    }

    #[test]
    fn pointer_focus_preserves_a_clipped_press_and_keyboard_focus_reveals_it() {
        use nsh_core::{MountBatch, MountItem};

        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::View, 2, 32.0));
        items.extend([
            MountItem::Frame {
                id: 2,
                frame: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(160.0), px(96.0))),
            },
            MountItem::Frame {
                id: 4,
                frame: Bounds::new(point(px(8.0), px(32.0)), Size::new(px(128.0), px(232.0))),
            },
            MountItem::ScrollContent {
                id: 2,
                size: Size::new(px(160.0), px(320.0)),
            },
            MountItem::Events {
                id: 4,
                events: mask(&[EventKind::Press, EventKind::PressDown, EventKind::PressUp]),
            },
        ]);
        surface.apply(MountBatch { items });
        surface.events.clear();
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            assert!(surface.handle_event(Event::Mouse(MouseEvent {
                kind,
                column: 2,
                row: 2,
                modifiers: KeyModifiers::NONE,
            })));
            assert_eq!(surface.focused(), Some(4));
            assert_eq!(surface.node(2).unwrap().scroll.y, px(0.0));
        }
        let presses: Vec<_> = surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, EventKind::Press, EventPayload::None) => Some(id),
                _ => None,
            })
            .collect();
        assert_eq!(presses, [4]);
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(2));
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(4));
        assert_eq!(surface.node(2).unwrap().scroll.y, px(32.0));
    }

    #[test]
    fn native_tooltip_observations_preserve_button_callbacks() {
        use nsh_core::{
            ApproxTextEngine, Core, MountBatch, MountItem, Op, Prop, Tag,
            overlay::TooltipContent,
            platform::{Idiom, Os},
            ui::Environment,
        };

        let mut core = Core::new(ApproxTextEngine, Size::new(px(320.0), px(192.0)));
        core.set_environment(Environment {
            os: Os::Linux,
            idiom: Idiom::Desktop,
            ..Environment::default()
        });
        for op in [
            Op::Create {
                id: 2,
                tag: Tag::View,
            },
            Op::Insert {
                parent: ROOT_ID,
                child: 2,
                before: None,
            },
            Op::SetProp {
                id: 2,
                prop: Prop::Tooltip(TooltipContent::Text("Close conversation".into())),
            },
        ] {
            core.apply(op).unwrap();
        }
        for event in [EventKind::Press, EventKind::PressDown, EventKind::PressUp] {
            core.apply(Op::Listen {
                id: 2,
                event,
                enabled: true,
            })
            .unwrap();
        }
        let events = core
            .commit()
            .unwrap()
            .items
            .into_iter()
            .find_map(|item| match item {
                MountItem::Events { id: 2, events } => Some(events),
                _ => None,
            })
            .expect("the core mounts the tooltip anchor's event mask");
        let watch = events
            .hint_watch()
            .expect("the core issues the native tooltip's watch token");
        let mut surface = form();
        surface.apply(MountBatch {
            items: vec![MountItem::Events { id: 4, events }],
        });
        for (kind, column, row) in [
            (MouseEventKind::Moved, 1, 3),
            (MouseEventKind::Down(MouseButton::Left), 1, 3),
            (MouseEventKind::Up(MouseButton::Left), 1, 3),
            (MouseEventKind::Moved, 20, 10),
        ] {
            surface.handle_event(Event::Mouse(MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            }));
        }
        let mut observations = Vec::new();
        let mut callbacks = Vec::new();
        for event in surface.drain_events() {
            match event {
                SurfaceEvent::HintObservation(HintObservation::Enter(token)) => {
                    observations.push(("enter", vec![token]));
                }
                SurfaceEvent::HintObservation(HintObservation::Leave(token)) => {
                    observations.push(("leave", vec![token]));
                }
                SurfaceEvent::HintObservation(HintObservation::Press(path)) => {
                    observations.push(("press", path));
                }
                SurfaceEvent::Event(id, kind, payload) => callbacks.push((id, kind, payload)),
                _ => {}
            }
        }
        assert_eq!(
            observations,
            [
                ("enter", vec![watch]),
                ("press", vec![watch]),
                ("leave", vec![watch]),
            ]
        );
        assert_eq!(
            callbacks,
            [
                (4, EventKind::PressDown, EventPayload::None),
                (4, EventKind::PressUp, EventPayload::None),
                (4, EventKind::Press, EventPayload::None),
            ]
        );
    }

    #[test]
    fn a_fractional_button_activates_at_its_visible_text_cell() {
        use std::sync::Arc;

        use nsh_core::{AttributedText, MountBatch, MountItem, ResolvedTextStyle, TextEngine};

        let mut surface = Surface::new(8, 4, crate::CellMetrics::default());
        let mut text = AttributedText {
            selectable: Some(false),
            ..Default::default()
        };
        text.push("x", ResolvedTextStyle::default());
        let engine = crate::TerminalTextEngine::default();
        let size = Size::new(px(8.0), px(16.0));
        let layout = engine.layout(&engine.prepare(&text), size);
        let mut items = create(2, ViewKind::View, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::Text, 2, 0.0));
        items.extend([
            MountItem::Frame {
                id: 2,
                frame: Bounds::new(point(px(14.0), px(12.0)), size),
            },
            MountItem::Frame {
                id: 4,
                frame: Bounds::new(point(px(0.0), px(0.0)), size),
            },
            MountItem::Events {
                id: 2,
                events: mask(&[EventKind::Press]),
            },
            MountItem::Text {
                id: 4,
                text: Arc::new(text),
                layout,
                content: Bounds::new(point(px(0.0), px(0.0)), size),
            },
        ]);
        surface.apply(MountBatch { items });
        assert_eq!(surface.snapshot().lines().nth(1), Some("  x"));
        for (column, row, expected) in [(1, 0, vec![]), (2, 1, vec![2])] {
            for kind in [
                MouseEventKind::Down(MouseButton::Left),
                MouseEventKind::Up(MouseButton::Left),
            ] {
                surface.handle_event(Event::Mouse(MouseEvent {
                    kind,
                    column,
                    row,
                    modifiers: KeyModifiers::NONE,
                }));
            }
            let presses: Vec<_> = surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, EventKind::Press, EventPayload::None) => Some(id),
                    _ => None,
                })
                .collect();
            assert_eq!(presses, expected);
        }
    }

    #[test]
    fn newly_tracked_hover_starts_at_the_current_hit_and_clears_on_leave() {
        use nsh_core::{MountBatch, MountItem};
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::View, 2, 0.0));
        items.extend(create(6, ViewKind::Input, ROOT_ID, 48.0));
        surface.apply(MountBatch { items });
        // Keep keyboard focus outside the rail: an enabled scroll is the
        // first native focus stop and would otherwise report FOCUS_WITHIN.
        surface.set_focus(Some(6));
        assert_eq!(surface.focus, Some(6));
        assert_eq!(surface.hit_test(4.0, 8.0), Some(4));
        surface.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Moved,
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(surface.hovered, Some(4));
        surface.events.clear();
        surface.apply(MountBatch {
            items: vec![MountItem::TrackStates {
                id: 2,
                states: state::HOVERED | state::FOCUS_WITHIN,
            }],
        });
        assert!(surface.events.iter().any(|event| matches!(event,
            SurfaceEvent::States(2, value) if *value == state::HOVERED)));
        surface.events.clear();
        surface.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Moved,
            column: 30,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(surface.focus, Some(6));
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::States(2, 0)))
        );
    }

    fn parked_focus_scene() -> Surface {
        use nsh_core::{MountBatch, MountItem};
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::View, 2, -1_000_000.0));
        items.extend(create(6, ViewKind::Input, 4, 0.0));
        items.extend(create(8, ViewKind::Input, 2, 0.0));
        items.push(MountItem::Events {
            id: 6,
            events: mask(&[EventKind::Focus, EventKind::Blur]),
        });
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(160.0), px(1000.0)),
        });
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(2));
        surface.events.clear();
        surface
    }

    #[test]
    fn mount_focus_reveals_final_frames_and_respects_later_explicit_scrolls() {
        use nsh_core::{Command, MountBatch, MountItem};

        for (later, expected_offset) in [
            (None, 640.0),
            (
                Some(MountItem::Command {
                    id: 2,
                    command: Command::ScrollTo {
                        x: px(0.0),
                        y: px(80.0),
                        animated: false,
                    },
                }),
                80.0,
            ),
            (
                Some(MountItem::ScrollBy {
                    id: 2,
                    dx: px(0.0),
                    dy: px(16.0),
                }),
                640.0,
            ),
            (
                Some(MountItem::Command {
                    id: 2,
                    command: Command::ScrollTo {
                        x: px(0.0),
                        y: px(f32::NAN),
                        animated: false,
                    },
                }),
                640.0,
            ),
        ] {
            let mut surface = parked_focus_scene();
            let mut items = vec![MountItem::Command {
                id: 6,
                command: Command::Focus,
            }];
            items.extend(later);
            // A duplicate focus is a no-op, including after an explicit scroll.
            items.push(MountItem::Command {
                id: 6,
                command: Command::Focus,
            });
            items.push(MountItem::Frame {
                id: 4,
                frame: Bounds::new(point(px(0.0), px(640.0)), Size::new(px(160.0), px(32.0))),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(6));
            assert_eq!(surface.node(2).unwrap().scroll.y, px(expected_offset));
            let focus_events: Vec<_> = surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, EventKind::Focus, _) => Some(id),
                    _ => None,
                })
                .collect();
            assert_eq!(focus_events, [6]);
        }
    }

    #[test]
    fn superseded_mount_focus_does_not_reveal_a_retired_target() {
        use nsh_core::{Command, MountBatch, MountItem};

        for (later, expected_focus) in [
            (
                vec![MountItem::Command {
                    id: 6,
                    command: Command::Blur,
                }],
                None,
            ),
            (vec![MountItem::Remove { id: 6 }], Some(2)),
            (
                vec![
                    MountItem::Remove { id: 6 },
                    MountItem::Insert {
                        parent: 4,
                        child: 6,
                        before: None,
                    },
                ],
                Some(2),
            ),
            (
                vec![MountItem::Command {
                    id: 8,
                    command: Command::Focus,
                }],
                Some(8),
            ),
            (
                {
                    let mut items = vec![MountItem::Delete { id: 6 }];
                    items.extend(create(6, ViewKind::Input, 4, 0.0));
                    items
                },
                Some(6),
            ),
        ] {
            let mut surface = parked_focus_scene();
            let mut items = vec![MountItem::Command {
                id: 6,
                command: Command::Focus,
            }];
            items.extend(later);
            items.push(MountItem::Frame {
                id: 4,
                frame: Bounds::new(point(px(0.0), px(640.0)), Size::new(px(160.0), px(32.0))),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), expected_focus);
            assert_eq!(surface.node(2).unwrap().scroll.y, px(0.0));
        }
    }

    #[test]
    fn terminal_form_edits_and_activates_buttons_with_keyboard() {
        let mut surface = form();
        assert_eq!(surface.focused(), Some(2));
        surface.handle_event(Event::Paste("中文😀".into()));
        assert_eq!(surface.node(2).unwrap().editor.text(), "中文😀");
        assert!(surface.events.iter().any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::ChangeText, EventPayload::Text { text, count: 1 }) if text == "中文😀")));
        surface.input_value(2, "stale".into(), 0);
        assert_eq!(surface.node(2).unwrap().editor.text(), "中文😀");
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(4));
        surface.events.clear();
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(
            surface
                .events
                .iter()
                .filter(|event| matches!(event, SurfaceEvent::Event(4, EventKind::Press, _)))
                .count(),
            1
        );
        let repeat =
            KeyEvent::new_with_kind(KeyCode::Enter, KeyModifiers::NONE, KeyEventKind::Repeat);
        surface.handle_event(Event::Key(repeat));
        assert_eq!(
            surface
                .events
                .iter()
                .filter(|event| matches!(event, SurfaceEvent::Event(4, EventKind::Press, _)))
                .count(),
            1
        );
        key(&mut surface, KeyCode::BackTab, KeyModifiers::SHIFT);
        assert_eq!(surface.node(2).unwrap().editor.selected(), "中文😀");
        let generation = surface.node(2).unwrap().generation;
        for multiline in [false, true] {
            surface.node_mut(2).unwrap().input.multiline = multiline;
            for selection in [(2, 2), (1, 4)] {
                for (code, modifiers) in [
                    (KeyCode::Tab, KeyModifiers::NONE),
                    (KeyCode::BackTab, KeyModifiers::SHIFT),
                ] {
                    surface.selection(2, selection.0, selection.1);
                    key(&mut surface, code, modifiers);
                    assert_eq!(surface.focused(), Some(4));
                    key(&mut surface, code, modifiers);
                    assert_eq!(surface.focused(), Some(2));
                    let node = surface.node(2).unwrap();
                    assert_eq!(node.generation, generation);
                    assert_eq!(node.editor.text(), "中文😀");
                    assert_eq!(
                        node.editor.selection(),
                        if multiline { selection } else { (0, 4) }
                    );
                }
            }
        }
    }

    #[test]
    fn inert_pointer_drags_preserve_input_focus_and_caret_but_scroll_background_focuses() {
        use nsh_core::{MountBatch, MountItem};

        for touch_listener in [false, true] {
            let mut surface = form();
            surface.node_mut(2).unwrap().events = mask(&[EventKind::Blur]);
            surface.node_mut(4).unwrap().events = if touch_listener {
                mask(&[EventKind::Touch])
            } else {
                Default::default()
            };
            let mut items = Vec::new();
            for (scroll, background, y) in [(6, 8, 96.0), (10, 12, 144.0)] {
                items.extend(create(scroll, ViewKind::Scroll, ROOT_ID, y));
                items.extend(create(background, ViewKind::View, scroll, 0.0));
                items.push(MountItem::ScrollContent {
                    id: scroll,
                    size: Size::new(px(160.0), px(1000.0)),
                });
            }
            surface.apply(MountBatch { items });
            surface.handle_event(Event::Paste("abcdef".into()));
            key(&mut surface, KeyCode::Left, KeyModifiers::NONE);
            key(&mut surface, KeyCode::Left, KeyModifiers::NONE);
            surface.events.clear();
            let mouse = |kind, column, row| {
                Event::Mouse(MouseEvent {
                    kind,
                    column,
                    row,
                    modifiers: KeyModifiers::NONE,
                })
            };
            for (kind, column) in [
                (MouseEventKind::Down(MouseButton::Left), 1),
                (MouseEventKind::Drag(MouseButton::Left), 5),
                (MouseEventKind::Up(MouseButton::Left), 5),
            ] {
                surface.handle_event(mouse(kind, column, 3));
                assert_eq!(surface.focused(), Some(2));
                assert_eq!(surface.node(2).unwrap().editor.selection(), (4, 4));
                assert_eq!(surface.node(2).unwrap().editor.text(), "abcdef");
            }
            assert!(
                !surface
                    .events
                    .iter()
                    .any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::Blur, _)))
            );

            key(&mut surface, KeyCode::Char('x'), KeyModifiers::NONE);
            assert_eq!(surface.node(2).unwrap().editor.text(), "abcdxef");

            surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1, 9));
            surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 1, 9));
            assert_eq!(surface.focused(), Some(10));
            assert_eq!(surface.node(2).unwrap().editor.selection(), (5, 5));
            assert!(
                surface
                    .events
                    .iter()
                    .any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::Blur, _)))
            );
        }
    }

    #[test]
    fn modal_focus_scope_traps_tab_and_restores_background_focus() {
        use nsh_core::{InputConfig, MountBatch, MountItem, ViewProps};
        let mut surface = form();
        surface.set_focus(Some(4));
        let mut items = create(6, ViewKind::Modal, ROOT_ID, 0.0);
        items.extend(create(8, ViewKind::Input, 6, 0.0));
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(8));
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(8));
        surface.set_focus(Some(4));
        assert_eq!(surface.focused(), None);
        surface.set_focus(Some(8));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 6 }],
        });
        assert_eq!(surface.focused(), None);
        surface.tick(1.0);
        assert_eq!(surface.focused(), Some(4));
        // A popup that opens with its modal must not bypass the modal's
        // capture of the actual background owner (4, rather than first stop 2).
        let mut items = create(10, ViewKind::Modal, ROOT_ID, 0.0);
        items.extend(create(12, ViewKind::View, 10, 0.0));
        items.push(MountItem::ViewProps {
            id: 12,
            props: Box::new(ViewProps {
                focus_return_parent: Some(10),
                ..Default::default()
            }),
        });
        items.extend(create(14, ViewKind::Input, 12, 0.0));
        items.push(MountItem::Input {
            id: 14,
            config: Box::new(InputConfig {
                auto_focus: true,
                ..Default::default()
            }),
        });
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(14));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        surface.tick(2.0);
        assert_eq!(surface.focused(), Some(4));
    }

    fn popup(
        id: NodeId,
        field: NodeId,
        parent: NodeId,
        auto_focus: bool,
    ) -> Vec<nsh_core::MountItem> {
        use nsh_core::{InputConfig, MountItem, ViewProps};
        let mut items = create(id, ViewKind::View, ROOT_ID, 96.0);
        items.push(MountItem::ViewProps {
            id,
            props: Box::new(ViewProps {
                focus_return_parent: Some(parent),
                ..Default::default()
            }),
        });
        items.extend(create(field, ViewKind::Input, id, 0.0));
        items.push(MountItem::Input {
            id: field,
            config: Box::new(InputConfig {
                auto_focus,
                ..Default::default()
            }),
        });
        items
    }

    fn modal_focus_return(id: NodeId, field: NodeId) -> Vec<nsh_core::MountItem> {
        use nsh_core::{Command, InputConfig, ModalAnimation, ModalConfig, MountItem};
        let mut items = create(id, ViewKind::Modal, ROOT_ID, 0.0);
        items.push(MountItem::ModalConfig {
            id,
            config: ModalConfig {
                animation: ModalAnimation::None,
                ..Default::default()
            },
        });
        items.extend(create(field, ViewKind::Input, id, 0.0));
        items.push(MountItem::Input {
            id: field,
            config: Box::new(InputConfig {
                auto_focus: true,
                ..Default::default()
            }),
        });
        items.push(MountItem::Command {
            id: field,
            command: Command::Focus,
        });
        items
    }

    #[test]
    fn replacing_popups_and_modals_keeps_the_original_opener_and_caret() {
        use nsh_core::{MountBatch, MountItem};
        for back in [false, true] {
            for insert_first in [false, true] {
                let mut surface = form();
                let original = surface.node(2).unwrap().generation;
                surface.input_value(2, "abcdef".into(), 0);
                surface.selection(2, 3, 3);
                let mut items = vec![MountItem::Insert {
                    parent: ROOT_ID,
                    child: 4,
                    before: Some(2),
                }];
                items.extend(popup(6, 8, ROOT_ID, false));
                surface.apply(MountBatch { items });
                assert_eq!(surface.focused(), Some(8));

                let remove = vec![MountItem::Delete { id: 8 }, MountItem::Delete { id: 6 }];
                let modal = modal_focus_return(10, 12);
                let items = if insert_first {
                    modal.into_iter().chain(remove).collect()
                } else {
                    remove.into_iter().chain(modal).collect()
                };
                surface.apply(MountBatch { items });
                assert_eq!(surface.focused(), Some(12));
                surface.focus_history.clear();

                let remove = vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }];
                if back {
                    let popup = popup(14, 16, ROOT_ID, false);
                    let items = if insert_first {
                        popup.into_iter().chain(remove).collect()
                    } else {
                        remove.into_iter().chain(popup).collect()
                    };
                    surface.apply(MountBatch { items });
                    assert_eq!(surface.focused(), Some(16));
                    surface.focus_history.clear();
                    surface.apply(MountBatch {
                        items: vec![MountItem::Delete { id: 16 }, MountItem::Delete { id: 14 }],
                    });
                } else {
                    surface.apply(MountBatch { items: remove });
                }
                assert_eq!(surface.focused(), Some(2));
                assert_eq!(surface.node(2).unwrap().generation, original);
                assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
                key(&mut surface, KeyCode::Char('x'), KeyModifiers::NONE);
                assert_eq!(surface.node(2).unwrap().editor.text(), "abcxdef");
            }
        }
    }

    #[test]
    fn a_modal_inherits_a_removed_popup_owner_until_its_native_exit_finishes() {
        use nsh_core::{ModalAnimation, ModalConfig, MountBatch, MountItem};
        for animation in [ModalAnimation::None, ModalAnimation::Fade] {
            let mut surface = form();
            surface.input_value(2, "abcdef".into(), 0);
            surface.selection(2, 3, 3);
            surface.apply(MountBatch {
                items: popup(6, 8, ROOT_ID, false),
            });
            let mut items = modal_focus_return(10, 12);
            items.push(MountItem::ModalConfig {
                id: 10,
                config: ModalConfig {
                    animation,
                    ..Default::default()
                },
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(12));
            surface.tick(1.0);
            surface.apply(MountBatch {
                items: vec![MountItem::Delete { id: 8 }, MountItem::Delete { id: 6 }],
            });
            assert_eq!(surface.focused(), Some(12));
            surface.focus_history.clear();
            // Native Back consumes the same scope as an app's removal.
            surface.apply(MountBatch {
                items: vec![MountItem::Command {
                    id: ROOT_ID,
                    command: nsh_core::Command::Back,
                }],
            });
            surface.focus_history.clear();
            surface.tick(2.0);
            assert_eq!(surface.focused(), Some(2));
            assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
            key(&mut surface, KeyCode::Char('x'), KeyModifiers::NONE);
            assert_eq!(surface.node(2).unwrap().editor.text(), "abcxdef");
        }
    }

    #[test]
    fn closing_a_replacement_modal_keeps_an_explicit_blur() {
        use nsh_core::{Command, ModalAnimation, ModalConfig, MountBatch, MountItem};
        for animation in [ModalAnimation::None, ModalAnimation::Fade] {
            for blur_first in [false, true] {
                let mut surface = form();
                surface.apply(MountBatch {
                    items: popup(6, 8, ROOT_ID, false),
                });
                let mut items = vec![MountItem::Delete { id: 8 }, MountItem::Delete { id: 6 }];
                items.extend(modal_focus_return(10, 12));
                items.push(MountItem::ModalConfig {
                    id: 10,
                    config: ModalConfig {
                        animation,
                        ..Default::default()
                    },
                });
                surface.apply(MountBatch { items });
                assert_eq!(surface.focused(), Some(12));
                surface.tick(1.0);
                let blur = MountItem::Command {
                    id: 12,
                    command: Command::Blur,
                };
                let mut items = vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }];
                if blur_first {
                    items.insert(0, blur);
                } else {
                    items.push(blur);
                }
                surface.apply(MountBatch { items });
                assert_eq!(surface.focused(), None);
                surface.tick(2.0);
                assert_eq!(surface.focused(), None);
            }
        }
    }

    #[test]
    fn popup_pane_replacement_keeps_tab_autofocus_and_the_original_editor_caret() {
        use nsh_core::{InputConfig, MountBatch, MountItem, ViewProps};

        for delete in [false, true] {
            let mut surface = form();
            surface.apply(MountBatch {
                items: vec![MountItem::Insert {
                    parent: ROOT_ID,
                    child: 4,
                    before: Some(2),
                }],
            });
            surface.input_value(2, "abcdef".into(), 0);
            surface.selection(2, 3, 3);
            let mut items = create(6, ViewKind::View, ROOT_ID, 96.0);
            items.push(MountItem::ViewProps {
                id: 6,
                props: Box::new(ViewProps {
                    focus_return_parent: Some(ROOT_ID),
                    ..Default::default()
                }),
            });
            items.extend(create(8, ViewKind::View, 6, 0.0));
            items.push(MountItem::Events {
                id: 8,
                events: mask(&[EventKind::Press]),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(8));
            let mut items = vec![if delete {
                MountItem::Delete { id: 8 }
            } else {
                MountItem::Remove { id: 8 }
            }];
            items.extend(create(10, ViewKind::View, 6, 0.0));
            items.push(MountItem::Events {
                id: 10,
                events: mask(&[EventKind::Press]),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(10));
            for _ in 0..2 {
                key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
                assert_eq!(surface.focused(), Some(10));
            }
            assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
            surface.drain_events().for_each(drop);
            let mut items = vec![MountItem::Delete { id: 10 }];
            items.extend(create(12, ViewKind::View, 6, 0.0));
            items.push(MountItem::Events {
                id: 12,
                events: mask(&[EventKind::Press, EventKind::Focus]),
            });
            items.extend(create(14, ViewKind::Input, 6, 0.0));
            items.push(MountItem::Input {
                id: 14,
                config: Box::new(InputConfig {
                    auto_focus: true,
                    ..Default::default()
                }),
            });
            items.push(MountItem::Events {
                id: 14,
                events: mask(&[EventKind::Focus]),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(14));
            let focused: Vec<_> = surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, EventKind::Focus, _) => Some(id),
                    _ => None,
                })
                .collect();
            assert_eq!(focused, [14]);
            surface.apply(MountBatch {
                items: vec![MountItem::Remove { id: 6 }],
            });
            assert_eq!(surface.focused(), Some(2));
            assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
            key(&mut surface, KeyCode::Char('Z'), KeyModifiers::NONE);
            assert_eq!(surface.node(2).unwrap().editor.text(), "abcZdef");
        }
    }

    fn disable(id: NodeId) -> nsh_core::MountItem {
        let mut props = nsh_core::ViewProps::default();
        props.accessibility.state.disabled = true;
        nsh_core::MountItem::ViewProps {
            id,
            props: Box::new(props),
        }
    }

    #[test]
    fn busy_popup_keeps_native_focus_and_returns_its_actual_opener() {
        use nsh_core::{MountBatch, MountItem, ViewProps};

        for opener in [2, 4] {
            let mut surface = form();
            surface.input_value(2, "abcdef".into(), 0);
            surface.selection(2, 3, 3);
            if opener == 4 {
                for kind in [
                    MouseEventKind::Down(MouseButton::Left),
                    MouseEventKind::Up(MouseButton::Left),
                ] {
                    surface.handle_event(Event::Mouse(MouseEvent {
                        kind,
                        column: 1,
                        row: 3,
                        modifiers: KeyModifiers::NONE,
                    }));
                }
            }
            let mut items = popup(6, 8, ROOT_ID, true);
            items.extend(create(10, ViewKind::View, 6, 32.0));
            items.push(MountItem::Events {
                id: 10,
                events: mask(&[EventKind::Press]),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(8));
            key(&mut surface, KeyCode::Char('x'), KeyModifiers::NONE);
            assert_eq!(surface.node(8).unwrap().editor.text(), "x");
            surface.apply(MountBatch {
                items: vec![disable(8)],
            });
            assert_eq!(surface.focused(), Some(10));
            surface.apply(MountBatch {
                items: vec![disable(10)],
            });
            assert_eq!(surface.focused(), Some(6));
            surface.apply(MountBatch::default());
            for code in [KeyCode::Tab, KeyCode::BackTab] {
                key(&mut surface, code, KeyModifiers::NONE);
                assert_eq!(surface.focused(), Some(6));
            }
            surface.apply(MountBatch {
                items: vec![MountItem::ViewProps {
                    id: 10,
                    props: Box::new(ViewProps::default()),
                }],
            });
            for _ in 0..2 {
                key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
                assert_eq!(surface.focused(), Some(10));
            }
            surface.apply(MountBatch {
                items: vec![disable(10)],
            });
            assert_eq!(surface.focused(), Some(6));
            surface.apply(MountBatch {
                items: [8, 10, 6]
                    .into_iter()
                    .map(|id| MountItem::Delete { id })
                    .collect(),
            });
            assert_eq!(surface.focused(), Some(opener));
            assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
            key(&mut surface, KeyCode::Char('Z'), KeyModifiers::NONE);
            assert_eq!(
                surface.node(2).unwrap().editor.text(),
                if opener == 2 { "abcZdef" } else { "abcdef" }
            );
        }
    }

    #[test]
    fn a_new_popup_prioritizes_its_autofocus_and_restores_the_new_background_editor() {
        use nsh_core::{Command, InputConfig, MountBatch, MountItem, ViewProps};

        for existing_opener in [false, true] {
            let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
            let mut items = create(4, ViewKind::View, ROOT_ID, 32.0);
            items.push(MountItem::Events {
                id: 4,
                events: mask(&[EventKind::Press]),
            });
            if existing_opener {
                surface.apply(MountBatch {
                    items: std::mem::take(&mut items),
                });
                assert_eq!(surface.focused(), Some(4));
            }
            items.extend(create(2, ViewKind::Input, ROOT_ID, 0.0));
            items.push(MountItem::Input {
                id: 2,
                config: Box::new(InputConfig {
                    auto_focus: true,
                    ..Default::default()
                }),
            });
            items.push(MountItem::InputValue {
                id: 2,
                text: "abcdef".into(),
                count: 0,
            });
            items.push(MountItem::Command {
                id: 2,
                command: Command::SetSelection { start: 3, end: 3 },
            });
            items.extend(create(6, ViewKind::View, ROOT_ID, 96.0));
            items.push(MountItem::ViewProps {
                id: 6,
                props: Box::new(ViewProps {
                    focus_return_parent: Some(ROOT_ID),
                    ..Default::default()
                }),
            });
            items.extend(create(10, ViewKind::View, 6, 0.0));
            items.push(MountItem::Events {
                id: 10,
                events: mask(&[EventKind::Press]),
            });
            items.extend(create(8, ViewKind::Input, 6, 32.0));
            items.push(MountItem::Input {
                id: 8,
                config: Box::new(InputConfig {
                    auto_focus: true,
                    ..Default::default()
                }),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(8));
            surface.handle_event(Event::Paste("search".into()));
            assert_eq!(surface.node(8).unwrap().editor.text(), "search");
            surface.apply(MountBatch::default());
            assert_eq!(surface.focused(), Some(8));
            surface.apply(MountBatch {
                items: [8, 10, 6]
                    .into_iter()
                    .map(|id| MountItem::Delete { id })
                    .collect(),
            });
            assert_eq!(surface.focused(), Some(if existing_opener { 4 } else { 2 }));
            assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
            if !existing_opener {
                surface.handle_event(Event::Paste("Z".into()));
                assert_eq!(surface.node(2).unwrap().editor.text(), "abcZdef");
            }
        }
    }

    #[test]
    fn popup_autofocus_can_mount_after_the_popup_itself() {
        use nsh_core::{InputConfig, MountBatch, MountItem, ViewProps};

        for parent in [ROOT_ID, 6] {
            let mut surface = form();
            surface.apply(MountBatch {
                items: popup(6, 8, ROOT_ID, false),
            });
            assert_eq!(surface.focused(), Some(8));
            let mut items = create(10, ViewKind::View, ROOT_ID, 96.0);
            items.push(MountItem::ViewProps {
                id: 10,
                props: Box::new(ViewProps {
                    focus_return_parent: Some(parent),
                    ..Default::default()
                }),
            });
            surface.apply(MountBatch { items });
            // Even before its search mounts, the newly opened popup owns
            // native focus instead of leaving keyboard input in its opener.
            assert_eq!(surface.focused(), Some(10));
            let mut items = create(12, ViewKind::View, 10, 0.0);
            items.push(MountItem::Events {
                id: 12,
                events: mask(&[EventKind::Press]),
            });
            items.extend(create(14, ViewKind::Input, 10, 32.0));
            items.push(MountItem::Input {
                id: 14,
                config: Box::new(InputConfig {
                    auto_focus: true,
                    ..Default::default()
                }),
            });
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(14));
            surface.handle_event(Event::Paste("late".into()));
            assert_eq!(surface.node(14).unwrap().editor.text(), "late");
            surface.apply(MountBatch {
                items: [14, 12, 10]
                    .into_iter()
                    .map(|id| MountItem::Delete { id })
                    .collect(),
            });
            assert_eq!(surface.focused(), Some(8));
        }
    }

    #[test]
    fn popup_buttons_take_keyboard_focus_but_outside_pointer_keeps_its_new_owner() {
        use nsh_core::{MountBatch, MountItem, ViewProps};
        let mut surface = form();
        let pointer = |column, row| {
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column,
                row,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(pointer(1, 3));
        assert_eq!(surface.focused(), Some(4));
        let mut items = create(6, ViewKind::View, ROOT_ID, 96.0);
        items.push(MountItem::ViewProps {
            id: 6,
            props: Box::new(ViewProps {
                focus_return_parent: Some(ROOT_ID),
                ..Default::default()
            }),
        });
        for (id, y) in [(8, 0.0), (10, 32.0), (12, 64.0)] {
            items.extend(create(id, ViewKind::View, 6, y));
            items.push(MountItem::Events {
                id,
                events: mask(&[EventKind::Press]),
            });
        }
        items.push(MountItem::ViewProps {
            id: 8,
            props: Box::new(ViewProps {
                focusable: Some(false),
                ..Default::default()
            }),
        });
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(10));
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(12));
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(10));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 6 }],
        });
        assert_eq!(surface.focused(), Some(4));
        surface.apply(MountBatch {
            items: vec![MountItem::Insert {
                parent: ROOT_ID,
                child: 6,
                before: None,
            }],
        });
        assert_eq!(surface.focused(), Some(10));
        surface.apply(MountBatch {
            items: vec![disable(8), disable(10), disable(12)],
        });
        assert_eq!(surface.focused(), Some(6));
        surface.handle_event(pointer(1, 0));
        assert_eq!(surface.focused(), Some(2));
        // A controlled popup may remain open after the outside press.
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(4));
        surface.handle_event(pointer(1, 0));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 6 }],
        });
        assert_eq!(surface.focused(), Some(2));
        key(&mut surface, KeyCode::Char('q'), KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().editor.text(), "q");
    }

    #[test]
    fn logically_nested_sibling_popups_restore_each_other_and_unwind_deleted_parents() {
        use nsh_core::{MountBatch, MountItem};
        let mut surface = form();
        let mut items = popup(6, 8, ROOT_ID, false);
        items.extend(popup(10, 12, 6, true));
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(12));
        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }],
        });
        assert_eq!(surface.focused(), Some(8));
        key(&mut surface, KeyCode::Char('p'), KeyModifiers::NONE);
        assert_eq!(surface.node(8).unwrap().editor.text(), "p");
        surface.apply(MountBatch {
            items: popup(14, 16, 6, true),
        });
        assert_eq!(surface.focused(), Some(16));
        let mut items = vec![MountItem::Delete { id: 8 }];
        items.extend(create(18, ViewKind::Input, 6, 0.0));
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(16));
        surface.apply(MountBatch {
            items: [16, 14]
                .into_iter()
                .map(|id| MountItem::Delete { id })
                .collect(),
        });
        assert_eq!(surface.focused(), Some(18));
        surface.apply(MountBatch {
            items: popup(20, 22, 6, true),
        });
        assert_eq!(surface.focused(), Some(22));
        surface.apply(MountBatch {
            items: vec![disable(18), disable(22)],
        });
        assert_eq!(surface.focused(), Some(20));
        surface.apply(MountBatch {
            items: [22, 20]
                .into_iter()
                .map(|id| MountItem::Delete { id })
                .collect(),
        });
        assert_eq!(surface.focused(), Some(6));
        surface.apply(MountBatch {
            items: vec![MountItem::ViewProps {
                id: 18,
                props: Box::new(nsh_core::ViewProps::default()),
            }],
        });
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(18));
        surface.apply(MountBatch {
            items: popup(20, 22, 6, true),
        });
        assert_eq!(surface.focused(), Some(22));
        surface.apply(MountBatch {
            items: [22, 20, 18, 6]
                .into_iter()
                .map(|id| MountItem::Delete { id })
                .collect(),
        });
        assert_eq!(surface.focused(), Some(2));
        key(&mut surface, KeyCode::Char('b'), KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().editor.text(), "b");
    }

    #[test]
    fn popup_reparenting_and_reopening_follow_final_batch_topology() {
        use nsh_core::{MountBatch, MountItem};
        let mut surface = form();
        surface.apply(MountBatch {
            items: popup(6, 8, ROOT_ID, false),
        });
        assert_eq!(surface.focused(), Some(8));
        surface.apply(MountBatch {
            items: vec![
                MountItem::Remove { id: 6 },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 6,
                    before: None,
                },
            ],
        });
        assert_eq!(surface.focused(), Some(8));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 6 }],
        });
        assert_eq!(surface.focused(), Some(2));
        surface.set_focus(Some(4));
        surface.apply(MountBatch {
            items: vec![MountItem::Insert {
                parent: ROOT_ID,
                child: 6,
                before: None,
            }],
        });
        assert_eq!(surface.focused(), Some(8));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 6 }],
        });
        assert_eq!(surface.focused(), Some(4));
    }

    #[test]
    fn popup_close_does_not_restore_a_reused_opener_or_override_an_explicit_focus() {
        use nsh_core::{Command, MountBatch, MountItem};
        for (ancestor, already_open, removed) in [
            (false, true, true),
            (true, true, true),
            (true, false, true),
            (true, true, false),
        ] {
            let mut surface = form();
            surface.input_value(2, "abcdef".into(), 0);
            surface.selection(2, 3, 3);
            if ancestor {
                let mut items = create(18, ViewKind::View, ROOT_ID, 0.0);
                items.push(MountItem::Insert {
                    parent: 18,
                    child: 2,
                    before: None,
                });
                surface.apply(MountBatch { items });
            }
            if already_open {
                surface.apply(MountBatch {
                    items: popup(6, 8, ROOT_ID, true),
                });
            }
            let root = if ancestor { 18 } else { 2 };
            let mut items = Vec::new();
            if removed {
                items.push(MountItem::Remove { id: root });
            }
            items.push(MountItem::Insert {
                parent: ROOT_ID,
                child: root,
                before: None,
            });
            if !already_open {
                items.extend(popup(6, 8, ROOT_ID, true));
            }
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(8));
            surface.apply(MountBatch {
                items: vec![MountItem::Remove { id: 6 }],
            });
            assert_eq!(surface.focused(), if removed { None } else { Some(2) });
            assert_eq!(surface.node(2).unwrap().editor.selection(), (3, 3));
            key(&mut surface, KeyCode::Char('Z'), KeyModifiers::NONE);
            assert_eq!(
                surface.node(2).unwrap().editor.text(),
                if removed { "abcdef" } else { "abcZdef" }
            );
        }

        let mut surface = form();
        surface.apply(MountBatch {
            items: popup(6, 8, ROOT_ID, true),
        });
        let mut items = vec![
            MountItem::Delete { id: 8 },
            MountItem::Delete { id: 6 },
            MountItem::Delete { id: 2 },
        ];
        items.extend(create(2, ViewKind::Input, ROOT_ID, 0.0));
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(4));
        let mut items = popup(10, 12, ROOT_ID, true);
        items.push(MountItem::Command {
            id: 2,
            command: Command::Focus,
        });
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(2));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        assert_eq!(surface.focused(), Some(2));
        surface.apply(MountBatch {
            items: popup(14, 16, ROOT_ID, true),
        });
        surface.apply(MountBatch {
            items: vec![disable(16)],
        });
        assert_eq!(surface.focused(), Some(14));
        surface.apply(MountBatch {
            items: vec![
                MountItem::Remove { id: 14 },
                MountItem::Command {
                    id: 4,
                    command: Command::Focus,
                },
            ],
        });
        assert_eq!(surface.focused(), Some(4));
    }

    #[test]
    fn replacing_a_popup_in_one_batch_keeps_the_surviving_original_opener() {
        use nsh_core::{MountBatch, MountItem};
        let mut surface = form();
        surface.apply(MountBatch {
            items: popup(6, 8, ROOT_ID, true),
        });
        let mut items = vec![MountItem::Delete { id: 8 }, MountItem::Delete { id: 6 }];
        items.extend(popup(10, 12, ROOT_ID, true));
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(12));
        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 12 }, MountItem::Delete { id: 10 }],
        });
        assert_eq!(surface.focused(), Some(2));
    }

    #[test]
    fn reusing_a_logical_parent_does_not_adopt_its_previous_sibling_popup() {
        use nsh_core::{Command, MountBatch, MountItem};
        let mut surface = form();
        surface.apply(MountBatch {
            items: popup(6, 8, ROOT_ID, true),
        });
        surface.set_focus(Some(4));
        surface.apply(MountBatch {
            items: popup(10, 12, 6, true),
        });
        assert_eq!(surface.focused(), Some(12));
        let mut items = vec![MountItem::Delete { id: 8 }, MountItem::Delete { id: 6 }];
        items.extend(popup(6, 14, ROOT_ID, false));
        items.push(MountItem::Command {
            id: 2,
            command: Command::Focus,
        });
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(2));
        surface.set_focus(Some(12));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        assert_eq!(surface.focused(), Some(2));
        key(&mut surface, KeyCode::Char('n'), KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().editor.text(), "n");
    }

    #[test]
    fn a_modal_covers_a_popup_without_retiring_its_focus_return_scope() {
        use nsh_core::{InputConfig, MountBatch, MountItem, ViewProps};
        let mut surface = form();
        surface.apply(MountBatch {
            items: popup(6, 8, ROOT_ID, false),
        });
        let mut items = create(10, ViewKind::Modal, ROOT_ID, 0.0);
        items.push(MountItem::Frame {
            id: 10,
            frame: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(160.0), px(96.0))),
        });
        items.extend(create(14, ViewKind::View, 10, 0.0));
        items.push(MountItem::Events {
            id: 14,
            events: mask(&[EventKind::Press]),
        });
        items.extend(create(12, ViewKind::Input, 10, 32.0));
        items.push(MountItem::Input {
            id: 12,
            config: Box::new(InputConfig {
                auto_focus: true,
                ..Default::default()
            }),
        });
        surface.apply(MountBatch { items });
        assert_eq!(surface.focused(), Some(12));
        // A popup prop update while covered does not close or reopen it.
        surface.apply(MountBatch {
            items: vec![MountItem::ViewProps {
                id: 6,
                props: Box::new(ViewProps {
                    focus_return_parent: Some(ROOT_ID),
                    test_id: Some("covered".into()),
                    ..Default::default()
                }),
            }],
        });
        assert_eq!(surface.focused(), Some(12));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        surface.tick(1.0);
        assert_eq!(surface.focused(), Some(8));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 6 }],
        });
        assert_eq!(surface.focused(), Some(2));
    }

    #[test]
    fn keymap_respects_editing_and_always_bindings() {
        use std::sync::Arc;

        use nsh_core::keymap::{KeyBinding, Keymap, When};
        let mut surface = form();
        let stroke = Keystroke::parse_with("ctrl+k", false).unwrap();
        surface.keymap = Arc::new(Keymap::new(vec![KeyBinding::new(
            99,
            stroke,
            When::Always,
            false,
        )]));
        key(&mut surface, KeyCode::Char('k'), KeyModifiers::CONTROL);
        assert!(surface.events.iter().any(|event| matches!(
            event,
            SurfaceEvent::Event(
                ROOT_ID,
                EventKind::KeyCommand,
                EventPayload::Value(PayloadValue::Number(99.0))
            )
        )));
        assert_eq!(surface.node(2).unwrap().editor.count(), 0);
        surface.keymap = Arc::new(Keymap::new(vec![KeyBinding::new(
            88,
            Keystroke::parse_with("a", false).unwrap(),
            When::Auto,
            false,
        )]));
        key(&mut surface, KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().editor.text(), "a");
        surface.keymap = Arc::new(Keymap::new(vec![KeyBinding::new(
            100,
            Keystroke::parse_with("ctrl+shift+q", false).unwrap(),
            When::Always,
            false,
        )]));
        key(
            &mut surface,
            KeyCode::Char('Q'),
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        );
        assert!(!surface.should_quit());
        assert!(surface.events.iter().any(|event| matches!(
            event,
            SurfaceEvent::Event(
                ROOT_ID,
                EventKind::KeyCommand,
                EventPayload::Value(PayloadValue::Number(100.0))
            )
        )));
    }

    #[test]
    fn scoped_keymaps_use_native_descendant_focus_and_leave_other_inputs_alone() {
        use std::sync::Arc;

        use nsh_core::{
            MountBatch, MountItem,
            keymap::{KeyBinding, Keymap, When},
        };

        let mut surface = form();
        let mut items = create(6, ViewKind::View, ROOT_ID, 80.0);
        items.extend(create(8, ViewKind::Input, 6, 0.0));
        surface.apply(MountBatch { items });
        let stroke = Keystroke::parse_with("ctrl+k", false).unwrap();
        let mut scoped = KeyBinding::new(2, stroke, When::Always, false);
        scoped.within = Some(6);
        let mut typing = KeyBinding::new(
            3,
            Keystroke::parse_with("a", false).unwrap(),
            When::Always,
            false,
        );
        typing.within = Some(6);
        surface.keymap = Arc::new(Keymap::new(vec![
            KeyBinding::new(1, stroke, When::Always, false),
            scoped,
            typing,
        ]));
        let command = |surface: &mut Surface| {
            surface.drain_events().find_map(|event| match event {
                SurfaceEvent::Event(
                    ROOT_ID,
                    EventKind::KeyCommand,
                    EventPayload::Value(PayloadValue::Number(id)),
                ) => Some(id),
                _ => None,
            })
        };
        surface.set_focus(Some(8));
        assert_eq!(surface.focus_path(), [8, 6, ROOT_ID]);
        key(&mut surface, KeyCode::Char('k'), KeyModifiers::CONTROL);
        assert_eq!(command(&mut surface), Some(2.0));
        surface.set_focus(Some(2));
        key(&mut surface, KeyCode::Char('k'), KeyModifiers::CONTROL);
        assert_eq!(command(&mut surface), Some(1.0));
        key(&mut surface, KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().editor.text(), "a");
        assert_eq!(command(&mut surface), None);
        surface.set_focus(None);
        assert!(surface.focus_path().is_empty());
        key(&mut surface, KeyCode::Char('k'), KeyModifiers::CONTROL);
        assert_eq!(command(&mut surface), Some(1.0));
        surface.set_focus(Some(8));
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 6 }],
        });
        assert!(!surface.focus_path().contains(&6));
        key(&mut surface, KeyCode::Char('k'), KeyModifiers::CONTROL);
        assert_eq!(command(&mut surface), Some(1.0));
    }

    #[test]
    fn modal_escape_ignores_late_parent_bindings_and_restores_them_after_closing() {
        use std::sync::Arc;

        use nsh_core::{
            MountBatch, MountItem,
            keymap::{KeyBinding, Keymap, When},
        };

        let mut surface = form();
        let mut items = create(6, ViewKind::View, ROOT_ID, 80.0);
        items.extend(create(8, ViewKind::Input, 6, 0.0));
        surface.apply(MountBatch { items });
        let escape = Keystroke::parse_with("escape", false).unwrap();
        let mut parent = KeyBinding::new(1, escape, When::Always, false);
        parent.within = Some(6);
        surface.keymap = Arc::new(Keymap::new(vec![parent]));
        let command = |surface: &mut Surface| {
            surface.drain_events().find_map(|event| match event {
                SurfaceEvent::Event(
                    ROOT_ID,
                    EventKind::KeyCommand,
                    EventPayload::Value(PayloadValue::Number(id)),
                ) => Some(id),
                _ => None,
            })
        };
        surface.set_focus(Some(8));
        key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(command(&mut surface), Some(1.0));

        let mut items = create(10, ViewKind::Modal, 6, 0.0);
        items.extend(create(12, ViewKind::Input, 10, 0.0));
        surface.apply(MountBatch { items });
        assert_eq!(surface.focus_path(), [12, 10, 6, ROOT_ID]);
        let mut latest_parent = parent;
        latest_parent.id = 3;
        surface.apply(MountBatch {
            items: vec![MountItem::Keymap(Arc::new(Keymap::new(vec![
                parent,
                KeyBinding::new(
                    2,
                    Keystroke::parse_with("ctrl+k", false).unwrap(),
                    When::Always,
                    false,
                ),
                latest_parent,
            ])))],
        });
        key(&mut surface, KeyCode::Char('k'), KeyModifiers::CONTROL);
        assert_eq!(command(&mut surface), Some(2.0));

        key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
        let dispatched = surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, kind, payload)
                    if matches!(kind, EventKind::KeyCommand | EventKind::RequestClose) =>
                {
                    Some((id, kind, payload))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            dispatched,
            vec![(
                10,
                EventKind::RequestClose,
                EventPayload::Map(vec![("reason", PayloadValue::Str("cancel".into()))]),
            )]
        );
        assert!(surface.node(10).unwrap().popped);
        surface.tick(1.0);
        assert_eq!(surface.focus_path(), [8, 6, ROOT_ID]);
        key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
        assert_eq!(command(&mut surface), Some(3.0));
    }

    #[test]
    fn multiline_input_wheel_keeps_selection_and_shares_the_viewport_with_hit_and_reveal() {
        use nsh_core::{InputConfig, MountBatch, MountItem};
        use ratatui::layout::{Position, Rect};
        const SOURCE: &str = "ROW00\nROW01\nROW02\nROW03\nROW04\nROW05\nROW06\nROW07\nROW08\nROW09";
        let mut surface = form();
        let area = Rect::new(0, 0, 40, 12);
        let input_rows = |surface: &Surface, columns: u16, rows: u16| {
            let mut buffer = ratatui::buffer::Buffer::empty(area);
            surface.render(area, &mut buffer);
            (0..rows)
                .map(|row| {
                    (0..columns)
                        .map(|column| buffer[(column, row)].symbol())
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
        };
        surface.apply(MountBatch {
            items: vec![
                MountItem::Input {
                    id: 2,
                    config: Box::new(InputConfig {
                        multiline: true,
                        ..Default::default()
                    }),
                },
                MountItem::InputValue {
                    id: 2,
                    text: SOURCE.into(),
                    count: 0,
                },
            ],
        });
        key(&mut surface, KeyCode::Home, KeyModifiers::CONTROL);
        assert_eq!(input_rows(&surface, 5, 2), ["ROW00", "ROW01"]);
        assert_eq!(
            surface.input_cursor_position(area),
            Some(Position::new(0, 0))
        );
        let wheel = |direction, row| MouseEvent {
            kind: direction,
            column: 1,
            row,
            modifiers: KeyModifiers::NONE,
        };
        surface.handle_wheel(wheel(MouseEventKind::ScrollDown, 3), 1);
        assert_eq!(
            input_rows(&surface, 5, 1),
            ["ROW00"],
            "an outside wheel must not scroll the focused input"
        );
        surface.handle_wheel(wheel(MouseEventKind::ScrollDown, 0), 1);
        assert_eq!(input_rows(&surface, 5, 2), ["ROW03", "ROW04"]);
        assert_eq!(surface.input_context().unwrap().selection, 0..0);
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some(SOURCE)
        );
        assert_eq!(surface.input_cursor_position(area), None);
        let mut buffer = ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, 40, 12));
        surface.render(buffer.area, &mut buffer);
        assert!(
            !buffer[(0, 0)]
                .modifier
                .contains(ratatui::style::Modifier::REVERSED),
            "an offscreen caret must not be painted on the first visible row"
        );
        surface.handle_wheel(wheel(MouseEventKind::ScrollUp, 0), 1);
        assert_eq!(input_rows(&surface, 5, 1), ["ROW00"]);
        assert_eq!(
            surface.input_cursor_position(area),
            Some(Position::new(0, 0))
        );
        surface.handle_wheel(wheel(MouseEventKind::ScrollDown, 0), 1);
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            surface.handle_event(Event::Mouse(MouseEvent {
                kind,
                column: 2,
                row: 0,
                modifiers: KeyModifiers::NONE,
            }));
        }
        assert_eq!(
            surface.input_context().unwrap().selection,
            20..20,
            "the pointer must use the scrolled visual row"
        );
        assert_eq!(input_rows(&surface, 5, 1), ["ROW03"]);
        assert_eq!(
            surface.input_cursor_position(area),
            Some(Position::new(2, 0))
        );
        key(&mut surface, KeyCode::End, KeyModifiers::CONTROL);
        assert_eq!(input_rows(&surface, 5, 2), ["ROW08", "ROW09"]);
        assert_eq!(
            surface.input_cursor_position(area),
            Some(Position::new(5, 1))
        );
        let input_size = |height| MountBatch {
            items: vec![
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(160.0), px(height))),
                },
                MountItem::InputContent {
                    id: 2,
                    content: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(160.0), px(height))),
                },
            ],
        };
        surface.apply(input_size(16.0));
        assert_eq!(
            input_rows(&surface, 5, 1),
            ["ROW09"],
            "resize must reveal a caret that was visible before"
        );
        assert_eq!(
            surface.input_cursor_position(area),
            Some(Position::new(5, 0))
        );
        surface.handle_wheel(wheel(MouseEventKind::ScrollUp, 0), 1);
        assert_eq!(input_rows(&surface, 5, 1), ["ROW06"]);
        assert_eq!(surface.input_cursor_position(area), None);
        surface.apply(input_size(32.0));
        assert_eq!(
            input_rows(&surface, 5, 2),
            ["ROW06", "ROW07"],
            "resize must not pull back a caret deliberately wheeled out of view"
        );
        assert_eq!(surface.input_cursor_position(area), None);
        surface.set_focus(Some(4));
        assert_eq!(surface.input_cursor_position(area), None);
        assert_eq!(
            input_rows(&surface, 5, 1),
            ["ROW06"],
            "blur must preserve the input viewport"
        );
        surface.input_value(2, "new0\nnew1".into(), 0);
        assert_eq!(
            input_rows(&surface, 4, 2),
            ["new0", "new1"],
            "shorter controlled text clamps the retained viewport"
        );
        surface.apply(MountBatch {
            items: vec![
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(40.0), px(48.0))),
                },
                MountItem::InputContent {
                    id: 2,
                    content: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(40.0), px(48.0))),
                },
            ],
        });
        surface.input_value(2, "abcde\nf".into(), 0);
        surface.set_focus(Some(2));
        surface.selection(2, 5, 5);
        let mut buffer = ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, 5, 3));
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(4, 0)].symbol(), "e");
        assert!(
            buffer[(4, 0)]
                .modifier
                .contains(ratatui::style::Modifier::REVERSED),
            "a full-width line's insertion boundary before LF keeps a visible caret"
        );
        assert_eq!(
            surface.input_cursor_position(buffer.area),
            Some(Position::new(4, 0))
        );
        surface.apply(MountBatch {
            items: vec![
                MountItem::Frame {
                    id: 2,
                    frame: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(16.0), px(48.0))),
                },
                MountItem::InputContent {
                    id: 2,
                    content: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(16.0), px(48.0))),
                },
            ],
        });
        surface.input_value(2, "\t\nx".into(), 0);
        surface.selection(2, 1, 1);
        let mut buffer = ratatui::buffer::Buffer::empty(Rect::new(0, 0, 2, 3));
        surface.render(buffer.area, &mut buffer);
        assert!(
            buffer[(1, 0)]
                .modifier
                .contains(ratatui::style::Modifier::REVERSED),
            "a tab's insertion boundary before LF keeps the caret on the last visible cell"
        );
        assert_eq!(
            surface.input_cursor_position(buffer.area),
            Some(Position::new(1, 0))
        );
    }

    #[test]
    fn multiline_files_keep_raw_values_paste_and_return_line_endings() {
        let mut surface = form();
        surface.node_mut(2).unwrap().input = nsh_core::InputConfig {
            multiline: true,
            submit_behavior: Some(SubmitBehavior::Newline),
            ..Default::default()
        };
        let original = "  A\t中\x1b\0\r\nB \r\n\r\n";
        surface.input_value(2, original.into(), 0);
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some(original)
        );
        assert_eq!(surface.input_context().unwrap().event_count, 0);
        assert!(
            !surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::ChangeText, _)))
        );
        // Raw editing data is never emitted as terminal control sequences.
        surface.focus = None;
        let mut buffer = ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, 40, 12));
        surface.render(buffer.area, &mut buffer);
        assert_eq!(buffer[(2, 0)].symbol(), "A");
        assert_eq!(buffer[(4, 0)].symbol(), "中");
        assert_eq!(buffer[(0, 1)].symbol(), "B");
        assert!(
            buffer
                .content
                .iter()
                .all(|cell| !cell.symbol().contains(char::is_control))
        );
        surface.focus = Some(2);
        key(&mut surface, KeyCode::Char('x'), KeyModifiers::NONE);
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some(format!("{original}x\r\n").as_str())
        );
        let pasted = "\tP\rQ\nR\r\n \n";
        surface.handle_event(Event::Paste(pasted.into()));
        let edited = format!("{original}x\r\n{pasted}");
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some(edited.as_str())
        );
        for _ in 0..3 {
            key(&mut surface, KeyCode::Char('z'), KeyModifiers::CONTROL);
        }
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some(original)
        );
        for _ in 0..3 {
            key(&mut surface, KeyCode::Char('y'), KeyModifiers::CONTROL);
        }
        assert_eq!(
            surface.input_context().unwrap().text.as_deref(),
            Some(edited.as_str())
        );
    }

    #[test]
    fn input_return_obeys_submit_and_multiline_rules() {
        let mut surface = form();
        let mut config = nsh_core::InputConfig {
            multiline: true,
            submit_behavior: Some(SubmitBehavior::Submit),
            ..Default::default()
        };
        surface.node_mut(2).unwrap().input = config.clone();
        surface.node_mut(2).unwrap().events = mask(&[EventKind::SubmitEditing]);
        surface.handle_event(Event::Paste("first".into()));
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().editor.text(), "first");
        assert_eq!(surface.focused(), Some(2));
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(2, EventKind::SubmitEditing, _)))
        );
        key(&mut surface, KeyCode::Enter, KeyModifiers::SHIFT);
        assert_eq!(surface.node(2).unwrap().editor.text(), "first\n");
        config.submit_behavior = Some(SubmitBehavior::BlurAndSubmit);
        surface.node_mut(2).unwrap().input = config;
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert_eq!(surface.focused(), None);
        surface.reconcile_focus(false);
        assert_eq!(surface.focused(), None);
    }

    #[test]
    fn disabled_controls_and_pointer_none_subtrees_are_skipped() {
        let mut surface = form();
        surface
            .node_mut(4)
            .unwrap()
            .props
            .accessibility
            .state
            .disabled = true;
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(2));
        surface.node_mut(ROOT_ID).unwrap().props.pointer_events = PointerEvents::None;
        surface.reconcile_focus(false);
        assert_eq!(surface.focused(), None);
    }

    #[test]
    fn dialog_blocks_form_and_honors_cancelable() {
        use nsh_core::{Dialog, DialogButton};
        let mut surface = form();
        surface.dialog = Some(Dialog {
            id: 12,
            title: Some("Choose".into()),
            message: None,
            buttons: vec![
                DialogButton {
                    text: "First".into(),
                    style: Default::default(),
                },
                DialogButton {
                    text: "Second".into(),
                    style: Default::default(),
                },
            ],
            cancelable: false,
            sheet: false,
        });
        assert!(surface.focus_path().is_empty());
        key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
        assert!(surface.dialog.is_some());
        surface.handle_event(Event::Paste("blocked".into()));
        assert_eq!(surface.node(2).unwrap().editor.text(), "");
        key(&mut surface, KeyCode::BackTab, KeyModifiers::NONE);
        assert_eq!(surface.dialog_selection, 1);
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert!(surface.dialog.is_none());
        assert_eq!(surface.focus_path(), [2, ROOT_ID]);
        assert!(surface.events.iter().any(|event| matches!(event, SurfaceEvent::Event(ROOT_ID, EventKind::Dialog, EventPayload::Map(fields)) if fields.contains(&("index", PayloadValue::Number(1.0))))));
    }

    #[test]
    fn wheel_scrolls_native_state_and_preserves_core_adjustment_count() {
        use nsh_core::{MountBatch, MountItem, Size};
        let intents = |surface: &Surface| {
            surface
                .events
                .iter()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, EventKind::ScrollIntent, EventPayload::Map(fields)) => {
                        fields.iter().find_map(|(key, value)| match (*key, value) {
                            ("intent", PayloadValue::Str(intent)) => Some((*id, intent.clone())),
                            _ => None,
                        })
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.push(MountItem::Events {
            id: 2,
            events: mask(&[EventKind::ScrollIntent]),
        });
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(160.0), px(1000.0)),
        });
        surface.apply(MountBatch { items });
        surface.node_mut(2).unwrap().scroll.count = 3;
        surface.events.clear();
        surface.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 2,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(surface.node(2).unwrap().scroll.y.0, 48.0);
        assert!(
            matches!(surface.events.first(), Some(SurfaceEvent::Event(2, EventKind::ScrollIntent, EventPayload::Map(fields))) if fields.contains(&("intent", PayloadValue::Str("scroll".into()))))
        );
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Scroll(2, offset, 3) if *offset == point(px(0.0),px(48.0))))
        );
        let scroll = &mut surface.node_mut(2).unwrap().scroll;
        scroll.content.width.0 = 1000.0;
        scroll.horizontal = true;
        scroll.mirrored = true;
        scroll.x.0 = 100.0;
        let wheel = |kind| {
            Event::Mouse(MouseEvent {
                kind,
                column: 2,
                row: 0,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(wheel(MouseEventKind::ScrollRight));
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 76.0);
        surface.handle_event(wheel(MouseEventKind::ScrollDown));
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 100.0);
        key(&mut surface, KeyCode::Left, KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 124.0);
        key(&mut surface, KeyCode::Home, KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 0.0);
        key(&mut surface, KeyCode::End, KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 840.0);
        key(&mut surface, KeyCode::End, KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 840.0);
        assert_eq!(
            intents(&surface),
            vec![
                (2, "scroll".into()),
                (2, "scroll".into()),
                (2, "scroll".into()),
                (2, "scroll".into()),
                (2, "start".into()),
                (2, "end".into()),
                (2, "end".into())
            ]
        );
        surface.events.clear();
        surface.apply(MountBatch {
            items: vec![
                MountItem::Command {
                    id: 2,
                    command: nsh_core::Command::ScrollTo {
                        x: px(0.0),
                        y: px(0.0),
                        animated: false,
                    },
                },
                MountItem::ScrollBy {
                    id: 2,
                    dx: px(16.0),
                    dy: px(0.0),
                },
            ],
        });
        assert_eq!(intents(&surface), Vec::<(NodeId, String)>::new());
        surface.node_mut(2).unwrap().scroll.enabled = false;
        key(&mut surface, KeyCode::Home, KeyModifiers::NONE);
        assert_eq!(intents(&surface), Vec::<(NodeId, String)>::new());
    }

    #[test]
    fn wheel_burst_keeps_the_initial_scroll_target_when_a_nested_view_moves_under_pointer() {
        use nsh_core::{MountBatch, MountItem, Size};
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::Scroll, 2, 48.0));
        for id in [2, 4] {
            items.push(MountItem::Events {
                id,
                events: mask(&[EventKind::ScrollIntent]),
            });
            items.push(MountItem::ScrollContent {
                id,
                size: Size::new(px(160.0), px(1000.0)),
            });
        }
        surface.apply(MountBatch { items });
        surface.events.clear();
        let mouse = MouseEvent {
            kind: MouseEventKind::ScrollDown,
            column: 2,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };
        assert_eq!(surface.handle_wheel(mouse, 0), 0);
        assert_eq!(
            surface.handle_wheel(
                MouseEvent {
                    kind: MouseEventKind::Moved,
                    ..mouse
                },
                3
            ),
            0
        );
        assert_eq!(surface.hovered, None);
        assert_eq!(surface.events.len(), 0);
        assert_eq!(surface.handle_wheel(mouse, 3), 3);
        assert_eq!(surface.node(2).unwrap().scroll.y.0, 144.0);
        assert_eq!(surface.node(4).unwrap().scroll.y.0, 0.0);
        let offsets: Vec<_> = surface
            .events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::Scroll(id, offset, count) => {
                    Some((*id, offset.x.0, offset.y.0, *count))
                }
                _ => None,
            })
            .collect();
        assert_eq!(offsets, [(2, 0.0, 144.0, 0)]);
        let owners: Vec<_> = surface
            .events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, EventKind::ScrollIntent, _) => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(owners, [2]);

        surface.node_mut(2).unwrap().scroll.y.0 = 0.0;
        surface.events.clear();
        assert_eq!(surface.handle_wheel(mouse, 1), 1);
        assert!(surface.handle_event(Event::Mouse(mouse)));
        assert_eq!(surface.node(2).unwrap().scroll.y.0, 48.0);
        assert_eq!(surface.node(4).unwrap().scroll.y.0, 48.0);
    }

    #[test]
    fn nested_wheels_keep_vertical_motion_outside_horizontal_readers() {
        use nsh_core::{MountBatch, MountItem};

        for (width, kind, modifiers, expected_x, expected_y) in [
            (
                160.0,
                MouseEventKind::ScrollDown,
                KeyModifiers::NONE,
                0.0,
                48.0,
            ),
            (
                1000.0,
                MouseEventKind::ScrollDown,
                KeyModifiers::NONE,
                0.0,
                48.0,
            ),
            (
                1000.0,
                MouseEventKind::ScrollRight,
                KeyModifiers::NONE,
                24.0,
                0.0,
            ),
            (
                1000.0,
                MouseEventKind::ScrollDown,
                KeyModifiers::SHIFT,
                24.0,
                0.0,
            ),
        ] {
            let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
            let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
            items.extend(create(4, ViewKind::Scroll, 2, 0.0));
            items.extend([
                MountItem::ScrollConfig {
                    id: 4,
                    horizontal: true,
                    scrollbar_visible: false,
                    scroll_value: None,
                    keyboard_dismiss: Default::default(),
                    mirrored: false,
                },
                MountItem::ScrollContent {
                    id: 2,
                    size: Size::new(px(160.0), px(1000.0)),
                },
                MountItem::ScrollContent {
                    id: 4,
                    size: Size::new(px(width), px(32.0)),
                },
            ]);
            surface.apply(MountBatch { items });
            surface.events.clear();
            let mouse = MouseEvent {
                kind,
                column: 2,
                row: 0,
                modifiers,
            };
            assert_eq!(surface.handle_wheel(mouse, 1), 1);
            assert_eq!(
                (
                    surface.node(4).unwrap().scroll.x.0,
                    surface.node(4).unwrap().scroll.y.0,
                    surface.node(2).unwrap().scroll.x.0,
                    surface.node(2).unwrap().scroll.y.0,
                ),
                (expected_x, 0.0, 0.0, expected_y),
                "width={width} kind={kind:?}"
            );
        }
    }

    #[test]
    fn wheel_burst_counts_horizontal_rtl_shift_and_zoom_with_mounted_limits() {
        use nsh_core::{GestureValues, MountBatch, MountItem, Size, animation::AnimationOp};
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(1000.0), px(1000.0)),
        });
        items.extend([
            MountItem::Animation(AnimationOp::CreateValue {
                node: 11,
                value: 3.0,
            }),
            MountItem::Gestures {
                id: ROOT_ID,
                values: GestureValues {
                    pinch: Some(11),
                    ..Default::default()
                },
            },
        ]);
        surface.apply(MountBatch { items });
        let mouse = MouseEvent {
            kind: MouseEventKind::ScrollRight,
            column: 2,
            row: 0,
            modifiers: KeyModifiers::NONE,
        };
        let scroll = &mut surface.node_mut(2).unwrap().scroll;
        scroll.x.0 = 100.0;
        scroll.horizontal = true;
        scroll.mirrored = true;
        assert_eq!(surface.handle_wheel(mouse, 3), 3);
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 28.0);
        assert_eq!(
            surface.handle_wheel(
                MouseEvent {
                    kind: MouseEventKind::ScrollDown,
                    modifiers: KeyModifiers::SHIFT,
                    ..mouse
                },
                2
            ),
            2
        );
        assert_eq!(surface.node(2).unwrap().scroll.x.0, 76.0);
        let behavior = &mut surface.node_mut(2).unwrap().scroll.behavior;
        behavior.min_zoom = 0.5;
        behavior.max_zoom = 2.0;
        behavior.pinch = true;
        assert_eq!(
            surface.handle_wheel(
                MouseEvent {
                    kind: MouseEventKind::ScrollUp,
                    modifiers: KeyModifiers::CONTROL,
                    ..mouse
                },
                10
            ),
            10
        );
        assert_eq!(surface.node(2).unwrap().scroll.physics.zoom, 2.0);
        assert_eq!(
            surface.handle_wheel(
                MouseEvent {
                    kind: MouseEventKind::ScrollDown,
                    modifiers: KeyModifiers::CONTROL,
                    ..mouse
                },
                u16::MAX
            ),
            u16::MAX
        );
        assert_eq!(surface.node(2).unwrap().scroll.physics.zoom, 0.5);
        assert_eq!(
            surface.animation.value(11),
            Some(3.0),
            "the mounted Scroll must keep its zoom instead of pinching its ancestor"
        );
    }

    #[test]
    fn control_wheel_pinches_the_same_image_natively_and_pairs_subscribed_gestures() {
        use std::{
            sync::Arc,
            time::{Duration, Instant},
        };

        use nsh_core::{
            GestureValues, MountBatch, MountItem, ResizeMode,
            animation::{AnimationOp, AnimationProp},
        };
        use ratatui::{buffer::Buffer, layout::Rect, style::Color};

        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::View, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::Image, 2, 0.0));
        items.extend(create(6, ViewKind::Scroll, ROOT_ID, 64.0));
        items.extend([
            MountItem::Frame {
                id: 4,
                frame: Bounds::new(point(px(0.0), px(0.0)), Size::new(px(80.0), px(32.0))),
            },
            MountItem::Animation(AnimationOp::CreateValue {
                node: 11,
                value: 1.0,
            }),
            MountItem::Gestures {
                id: 2,
                values: GestureValues {
                    pinch: Some(11),
                    ..Default::default()
                },
            },
            MountItem::AnimationBindings {
                id: 4,
                bindings: vec![(AnimationProp::Transform(0), 11)],
            },
            MountItem::ScrollContent {
                id: 6,
                size: Size::new(px(1000.0), px(1000.0)),
            },
        ]);
        surface.apply(MountBatch { items });
        let behavior = &mut surface.node_mut(6).unwrap().scroll.behavior;
        behavior.min_zoom = 0.5;
        behavior.max_zoom = 2.0;
        let node = surface.node_mut(4).unwrap();
        node.style.transform_origin = nsh_core::TransformOrigin {
            x: px(0.0).into(),
            y: px(0.0).into(),
            z: px(0.0),
        };
        node.style
            .transform
            .push(nsh_core::TransformKind::Scale, 1.0);
        let request = node
            .image
            .update(
                Some(nsh_core::ImageSource {
                    uri: Arc::from("asset:/pinch.png"),
                    scales: nsh_core::ImageScales::NONE,
                    data: None,
                    size: None,
                }),
                ResizeMode::Stretch,
                nsh_core::ImageOptions::default(),
                0.0,
            )
            .remove(0);
        node.image.install_cached(
            &request,
            Arc::new(crate::image::AnimatedRaster {
                frames: vec![Arc::new(crate::image::Raster {
                    width: 1,
                    height: 1,
                    rgba: vec![255, 0, 0, 255],
                })],
                delays: vec![100],
                plays: 1,
            }),
            0.0,
        );
        let image_generation = node.generation;
        let render = |surface: &mut Surface| {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                surface.tick(0.0);
                let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 12));
                surface.render(buffer.area, &mut buffer);
                if !surface.composites.borrow().pending() {
                    return buffer;
                }
                assert!(
                    Instant::now() < deadline,
                    "the native image transform did not finish painting"
                );
                std::thread::sleep(Duration::from_millis(1));
            }
        };
        let before = render(&mut surface);
        assert_eq!(before[(9, 0)].bg, Color::Rgb(255, 0, 0));
        assert_eq!(before[(10, 0)].bg, Color::Rgb(255, 255, 255));
        surface.events.clear();
        let mouse = MouseEvent {
            kind: MouseEventKind::ScrollUp,
            column: 2,
            row: 0,
            modifiers: KeyModifiers::CONTROL,
        };
        assert!(surface.handle_event(Event::Mouse(mouse)));
        assert_eq!(surface.animation.value(11), Some(1.1));
        assert_eq!(surface.node(4).unwrap().generation, image_generation);
        assert_eq!(surface.global_frame(4).unwrap().size.width.0, 88.0);
        assert_eq!(render(&mut surface)[(10, 0)].bg, Color::Rgb(255, 0, 0));
        assert!(surface.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::ScrollDown,
            ..mouse
        })));
        assert!((surface.animation.value(11).unwrap() - 1.0).abs() < 0.000_001);
        assert_eq!(render(&mut surface)[(10, 0)].bg, Color::Rgb(255, 255, 255));
        assert_eq!(surface.handle_wheel(mouse, 2), 2);
        assert!((surface.animation.value(11).unwrap() - 1.21).abs() < 0.000_001);
        assert_eq!(render(&mut surface)[(11, 0)].bg, Color::Rgb(255, 0, 0));
        assert_eq!(
            surface.handle_wheel(
                MouseEvent {
                    kind: MouseEventKind::ScrollDown,
                    ..mouse
                },
                2
            ),
            2
        );
        assert!((surface.animation.value(11).unwrap() - 1.0).abs() < 0.000_001);
        assert_eq!(
            surface.node(6).unwrap().scroll.physics.zoom,
            1.0,
            "a sibling Scroll cannot take the image's physical pinch"
        );
        assert!(
            !surface.events.iter().any(|event| matches!(
                event,
                SurfaceEvent::Event(_, EventKind::PinchStart | EventKind::PinchEnd, _)
            )),
            "native values must not require JS gesture listeners"
        );

        surface.apply(MountBatch {
            items: vec![MountItem::Events {
                id: 2,
                events: mask(&[EventKind::PinchStart, EventKind::PinchEnd]),
            }],
        });
        surface.events.clear();
        assert_eq!(
            surface.handle_wheel(mouse, 4),
            1,
            "callbacks must run before another detent is admitted"
        );
        assert!((surface.animation.value(11).unwrap() - 1.1).abs() < 0.000_001);
        let gestures = surface
            .drain_events()
            .filter_map(|event| match event {
                SurfaceEvent::Event(
                    2,
                    kind @ (EventKind::PinchStart | EventKind::PinchEnd),
                    EventPayload::Map(fields),
                ) => Some((kind, fields)),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            gestures,
            vec![
                (
                    EventKind::PinchStart,
                    vec![
                        ("scale", PayloadValue::Number(1.0)),
                        ("velocity", PayloadValue::Number(0.0))
                    ]
                ),
                (
                    EventKind::PinchEnd,
                    vec![
                        ("scale", PayloadValue::Number(f64::from(1.1_f32))),
                        ("velocity", PayloadValue::Number(0.0))
                    ]
                ),
            ]
        );
    }

    #[test]
    fn wheel_burst_yields_after_one_host_component_detent() {
        use nsh_core::{MountBatch, MountItem, Size};

        use crate::native::{ComponentContext, ComponentResponse, NativeComponent};
        struct Wheel;
        impl NativeComponent for Wheel {
            fn render(&self, _: &ComponentContext, _: &mut ratatui::buffer::Buffer) {}
            fn handle_event(&mut self, _: &Event, _: &ComponentContext) -> ComponentResponse {
                ComponentResponse::event("wheel", serde_json::json!({"detent": 1}))
            }
        }
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::View, 2, 0.0));
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(160.0), px(1000.0)),
        });
        surface.apply(MountBatch { items });
        surface.node_mut(4).unwrap().native = Some(Box::new(Wheel));
        surface.events.clear();
        assert_eq!(
            surface.handle_wheel(
                MouseEvent {
                    kind: MouseEventKind::ScrollDown,
                    column: 2,
                    row: 0,
                    modifiers: KeyModifiers::NONE,
                },
                3
            ),
            1
        );
        assert_eq!(surface.node(2).unwrap().scroll.y.0, 0.0);
        let native: Vec<_> = surface
            .events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::Event(
                    id,
                    EventKind::NativeEvent,
                    EventPayload::Native { name, data },
                ) => Some((*id, name.as_ref(), data)),
                _ => None,
            })
            .collect();
        assert_eq!(native, [(4, "wheel", &serde_json::json!({"detent": 1}))]);
    }

    #[test]
    fn password_copy_and_paste_do_not_expose_secret_to_clipboard() {
        let mut surface = form();
        surface.node_mut(2).unwrap().input.secure = true;
        surface.handle_event(Event::Paste("secret".into()));
        surface.node_mut(2).unwrap().editor.select_all();
        surface.clipboard = "public".into();
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(surface.clipboard, "public");
        assert!(!surface.should_quit());
    }

    #[test]
    fn removing_a_selection_area_cancels_its_drag_after_its_text_moves_elsewhere() {
        use std::sync::Arc;

        use nsh_core::{
            AttributedText, MountBatch, MountItem, ResolvedTextStyle, TextEngine, ViewProps,
        };

        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::View, ROOT_ID, 0.0);
        items.push(MountItem::ViewProps {
            id: 2,
            props: Box::new(ViewProps {
                selection_area: true,
                ..Default::default()
            }),
        });
        let mut text = AttributedText {
            selectable: Some(true),
            ..Default::default()
        };
        text.push(
            "First line\nSecond line\nThird line\nFourth line\nLast line",
            ResolvedTextStyle::default(),
        );
        let engine = crate::TerminalTextEngine::default();
        let size = Size::new(px(160.0), px(144.0));
        let layout = engine.layout(&engine.prepare(&text), size);
        items.extend(create(4, ViewKind::Text, 2, 0.0));
        items.extend([
            MountItem::Frame {
                id: 4,
                frame: Bounds::new(Point::default(), size),
            },
            MountItem::Text {
                id: 4,
                text: Arc::new(text),
                layout,
                content: Bounds::new(Point::default(), size),
            },
        ]);
        items.extend(create(6, ViewKind::Scroll, ROOT_ID, 64.0));
        items.push(MountItem::ScrollContent { id: 6, size });
        surface.apply(MountBatch { items });
        let mouse = |kind, column, row| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1, 0));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5, 0));
        assert!(surface.selection_area_dragging());
        assert_eq!(surface.selection_area_owner(), Some(2));
        let selected = surface.selection_area_range(4).unwrap();
        assert!(selected.0 < selected.1);
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert!(!surface.clipboard.is_empty());

        surface.apply(MountBatch {
            items: vec![
                MountItem::Insert {
                    parent: 6,
                    child: 4,
                    before: None,
                },
                MountItem::Remove { id: 2 },
                MountItem::Insert {
                    parent: ROOT_ID,
                    child: 2,
                    before: None,
                },
            ],
        });
        assert!(!surface.selection_area_dragging());
        assert!(surface.pointer.is_none());
        assert_eq!(surface.node(2).unwrap().parent, Some(ROOT_ID));
        let selection = surface.selection_area_range(4);
        let scroll = surface.node(6).unwrap().scroll.y;
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 10, 10));
        surface.tick(1.0);
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 10, 10));
        surface.tick(2.0);
        assert!(!surface.selection_area_pending());
        assert!(!surface.selection_area_tick());
        assert_eq!(surface.node(6).unwrap().scroll.y, scroll);
        assert_eq!(surface.selection_area_range(4), selection);
    }

    #[test]
    fn selection_area_copies_across_lines_and_scrolling_without_activating_links() {
        use std::sync::Arc;

        use nsh_core::{
            AttributedText, ModalAnimation, ModalConfig, MountBatch, MountItem, ResolvedTextStyle,
            TextEngine, TextLink, ViewProps,
            keymap::{KeyBinding, Keymap, When},
        };

        let mut surface = Surface::new(30, 6, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.push(MountItem::Frame {
            id: 2,
            frame: Bounds::new(Point::default(), Size::new(px(160.0), px(64.0))),
        });
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(160.0), px(144.0)),
        });
        items.extend(create(3, ViewKind::View, 2, 0.0));
        items.push(MountItem::Frame {
            id: 3,
            frame: Bounds::new(Point::default(), Size::new(px(160.0), px(144.0))),
        });
        items.push(MountItem::ViewProps {
            id: 3,
            props: Box::new(ViewProps {
                selection_area: true,
                ..Default::default()
            }),
        });
        let engine = crate::TerminalTextEngine::default();
        for (id, y, height, value, selectable) in [
            (4, 0.0, 16.0, "First line", true),
            (5, 32.0, 32.0, "Second line\nThird line", true),
            (6, 96.0, 16.0, "Tail line", true),
            (7, 128.0, 16.0, "Excluded chrome", false),
        ] {
            let mut text = AttributedText {
                selectable: Some(selectable),
                ..Default::default()
            };
            text.push(value, ResolvedTextStyle::default());
            if id == 4 {
                text.links.push(TextLink {
                    start: 0,
                    end: 5,
                    node: 99,
                    events: mask(&[EventKind::Press]),
                    props: Arc::default(),
                });
            }
            let prepared = engine.prepare(&text);
            let size = Size::new(px(160.0), px(height));
            let layout = engine.layout(&prepared, size);
            items.extend(create(id, ViewKind::Text, 3, y));
            items.push(MountItem::Frame {
                id,
                frame: Bounds::new(Point::new(px(0.0), px(y)), size),
            });
            items.push(MountItem::Text {
                id,
                text: Arc::new(text),
                layout,
                content: Bounds::new(Point::default(), size),
            });
        }
        surface.apply(MountBatch { items });
        let mouse = |kind, column, row| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1, 0));
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 1, 0));
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(99, EventKind::Press, _)))
        );
        let original_transform = surface.node(3).unwrap().style.transform;
        let original_origin = surface.node(3).unwrap().style.transform_origin;
        let original_frame = surface.node(3).unwrap().frame;
        let original_scroll_width = surface.node(2).unwrap().frame.size.width;
        surface.node_mut(2).unwrap().frame.size.width = px(240.0);
        for (origin, scale, leading_column, trailing_column) in [
            (0.0, 1.0, 0_u16, 19_u16),
            (0.0, 2.0, 0, 19),
            (17.0, 1.0, 2, 19),
            (17.0, 2.0, 2, 21),
        ] {
            let node = surface.node_mut(3).unwrap();
            node.frame.origin.x = px(origin);
            node.style.transform = original_transform;
            node.style.transform_origin = nsh_core::TransformOrigin {
                x: px(0.0).into(),
                y: px(0.0).into(),
                z: px(0.0),
            };
            if scale != 1.0 {
                node.style
                    .transform
                    .push(nsh_core::TransformKind::ScaleX, scale);
            }
            for (start, end) in [
                ((leading_column, 0), (trailing_column, 3)),
                ((trailing_column, 3), (leading_column.saturating_sub(1), 0)),
            ] {
                surface.events.clear();
                surface.handle_event(mouse(
                    MouseEventKind::Down(MouseButton::Left),
                    start.0,
                    start.1,
                ));
                surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), end.0, end.1));
                surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), end.0, end.1));
                key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
                assert_eq!(
                    surface.clipboard, "First line\nSecond line\nThird line",
                    "a leading caret must include the first character in either drag direction at origin {origin}, scale {scale}"
                );
                assert!(
                    !surface
                        .events
                        .iter()
                        .any(|event| matches!(event, SurfaceEvent::Event(99, EventKind::Press, _))),
                    "selecting from a first-column link must not activate it"
                );
            }
        }
        let node = surface.node_mut(3).unwrap();
        node.frame = original_frame;
        node.style.transform = original_transform;
        node.style.transform_origin = original_origin;
        surface.node_mut(2).unwrap().frame.size.width = original_scroll_width;
        surface.events.clear();
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1, 0));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5, 3));
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 5, 3));
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(surface.clipboard, "rst line\nSecond line\nThird ");
        assert!(
            !surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(99, EventKind::Press, _)))
        );
        for kind in [ViewKind::Modal, ViewKind::View] {
            let mut items = create(10, kind, ROOT_ID, 0.0);
            if kind == ViewKind::Modal {
                items.push(MountItem::ModalConfig {
                    id: 10,
                    config: ModalConfig {
                        animation: ModalAnimation::None,
                        close_on_escape: false,
                        ..Default::default()
                    },
                });
            } else {
                items.push(MountItem::ViewProps {
                    id: 10,
                    props: Box::new(ViewProps {
                        focus_return_parent: Some(ROOT_ID),
                        ..Default::default()
                    }),
                });
            }
            items.extend(create(12, ViewKind::View, 10, 0.0));
            items.push(MountItem::Events {
                id: 12,
                events: mask(&[EventKind::Press]),
            });
            items.push(MountItem::Command {
                id: 12,
                command: Command::Focus,
            });
            let mut bindings: Vec<_> = [(201, "ctrl+a"), (202, "ctrl+c")]
                .into_iter()
                .map(|(id, key)| {
                    let mut binding = KeyBinding::new(
                        id,
                        Keystroke::parse_with(key, false).unwrap(),
                        When::NotEditing,
                        false,
                    );
                    binding.within = Some(10);
                    binding
                })
                .collect();
            if kind == ViewKind::View {
                let mut close = KeyBinding::new(
                    203,
                    Keystroke::parse_with("escape", false).unwrap(),
                    When::Always,
                    false,
                );
                close.within = Some(10);
                bindings.push(close);
            }
            items.push(MountItem::Keymap(Arc::new(Keymap::new(bindings))));
            surface.apply(MountBatch { items });
            assert_eq!(surface.focused(), Some(12));
            surface.events.clear();
            key(&mut surface, KeyCode::Char('a'), KeyModifiers::CONTROL);
            key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
            let commands: Vec<_> = surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(
                        ROOT_ID,
                        EventKind::KeyCommand,
                        EventPayload::Value(PayloadValue::Number(id)),
                    ) => Some(id),
                    _ => None,
                })
                .collect();
            assert_eq!(
                commands,
                [201.0, 202.0],
                "background selection must not mark a non-input overlay as editing"
            );
            assert_eq!(surface.clipboard, "rst line\nSecond line\nThird ");
            key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
            let close: Vec<_> = surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(
                        id,
                        kind @ (EventKind::RequestClose | EventKind::KeyCommand),
                        payload,
                    ) => Some((id, kind, payload)),
                    _ => None,
                })
                .collect();
            if kind == ViewKind::Modal {
                assert_eq!(
                    close,
                    [(
                        10,
                        EventKind::RequestClose,
                        EventPayload::Map(vec![("reason", PayloadValue::Str("cancel".into()))])
                    )]
                );
            } else {
                assert_eq!(
                    close,
                    [(
                        ROOT_ID,
                        EventKind::KeyCommand,
                        EventPayload::Value(PayloadValue::Number(203.0))
                    )]
                );
            }
            surface.apply(MountBatch {
                items: vec![
                    MountItem::Remove { id: 10 },
                    MountItem::Keymap(Arc::new(Keymap::new(vec![]))),
                ],
            });
            key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
            assert_eq!(
                surface.clipboard, "rst line\nSecond line\nThird ",
                "closing an overlay restores the original selected range"
            );
        }
        let mut items = modal_focus_return(10, 12);
        items.push(MountItem::InputValue {
            id: 12,
            text: "Overlay draft".into(),
            count: 0,
        });
        surface.apply(MountBatch { items });
        key(&mut surface, KeyCode::Char('a'), KeyModifiers::CONTROL);
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(surface.clipboard, "Overlay draft");
        surface.handle_event(Event::Paste("Edited overlay".into()));
        assert_eq!(surface.node(12).unwrap().editor.text(), "Edited overlay");
        surface.events.clear();
        key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(10, EventKind::RequestClose, _)))
        );
        assert_eq!(surface.clipboard, "Overlay draft");
        surface.apply(MountBatch {
            items: vec![MountItem::Remove { id: 10 }],
        });
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(surface.clipboard, "rst line\nSecond line\nThird ");
        surface.handle_event(mouse(MouseEventKind::ScrollDown, 5, 3));
        assert_eq!(surface.node(2).unwrap().scroll.y, px(48.0));
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(surface.clipboard, "rst line\nSecond line\nThird ");
        key(&mut surface, KeyCode::Char('a'), KeyModifiers::CONTROL);
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(
            surface.clipboard,
            "First line\nSecond line\nThird line\nTail line"
        );
        key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(
            surface.clipboard,
            "First line\nSecond line\nThird line\nTail line"
        );
        assert!(!surface.should_quit());
        assert!(surface.selection_area_range(4).is_none());
        assert!(surface.selection_area_range(5).is_none());
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1, 3));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5, 5));
        assert!(
            surface.animating(),
            "dragging past the Scroll edge schedules native work"
        );
        surface.tick(0.016);
        assert!((surface.node(2).unwrap().scroll.y.0 - 60.0).abs() < 0.01);
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 5, 5));
        key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(surface.clipboard, "il line");
        assert!(
            !surface.animating(),
            "a completed selection does not keep polling"
        );
        surface.scroll_to(2, px(0.0), px(0.0));
        let mut items = Vec::new();
        for (id, value) in [(4, "中😀"), (5, "下一行")] {
            let mut text = AttributedText {
                selectable: Some(true),
                ..Default::default()
            };
            text.push(value, ResolvedTextStyle::default());
            let prepared = engine.prepare(&text);
            let size = Size::new(px(160.0), px(16.0));
            items.push(MountItem::Text {
                id,
                text: Arc::new(text),
                layout: engine.layout(&prepared, size),
                content: Bounds::new(Point::default(), size),
            });
        }
        surface.apply(MountBatch { items });
        for (start, end) in [((1, 0), (5, 2)), ((5, 2), (1, 0))] {
            surface.handle_event(mouse(
                MouseEventKind::Down(MouseButton::Left),
                start.0,
                start.1,
            ));
            surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), end.0, end.1));
            surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), end.0, end.1));
            key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
            assert_eq!(
                surface.clipboard, "😀\n下一行",
                "the trailing cell of a wide character must retain its caret boundary without splitting the following surrogate pair"
            );
        }
        // Keep the right-aligned text clear of the Scroll's last-column
        // scrollbar, which handles its own Down before text selection.
        surface.node_mut(2).unwrap().frame.size.width = px(240.0);
        for (first, second, painted, leading_column, trailing_column) in [
            ("abc", "def", ["abc", "def"], 17, 19),
            ("אבג", "דהו", ["גבא", "והד"], 19, 17),
        ] {
            let mut items = Vec::new();
            for (id, value) in [(4, first), (5, second)] {
                let mut text = AttributedText {
                    selectable: Some(true),
                    writing_direction: Some(true),
                    ..Default::default()
                };
                text.push(value, ResolvedTextStyle::default());
                let prepared = engine.prepare(&text);
                let size = Size::new(px(160.0), px(16.0));
                items.push(MountItem::Text {
                    id,
                    text: Arc::new(text),
                    layout: engine.layout(&prepared, size),
                    content: Bounds::new(Point::default(), size),
                });
            }
            surface.apply(MountBatch { items });
            let area = ratatui::layout::Rect::new(0, 0, 30, 6);
            let mut buffer = ratatui::buffer::Buffer::empty(area);
            surface.render_plain(area, &mut buffer);
            for (row, expected) in [0, 2].into_iter().zip(painted) {
                let visible: String = (17..20)
                    .map(|column| buffer[(column, row)].symbol())
                    .collect();
                assert_eq!(visible, expected, "drag endpoints must hit painted glyphs");
            }
            for (start, end) in [
                ((leading_column, 0), (trailing_column, 2)),
                ((trailing_column, 2), (leading_column, 0)),
            ] {
                surface.clipboard.clear();
                surface.handle_event(mouse(
                    MouseEventKind::Down(MouseButton::Left),
                    start.0,
                    start.1,
                ));
                surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), end.0, end.1));
                surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), end.0, end.1));
                key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
                assert_eq!(
                    surface.clipboard,
                    format!("{first}\n{second}"),
                    "selection must follow each glyph's bidi direction inside an explicitly RTL paragraph"
                );
            }
        }
        surface.node_mut(2).unwrap().frame.size.width = original_scroll_width;
    }

    #[test]
    fn selectable_text_uses_shaped_runs_for_drag_copy_and_inline_links() {
        use std::sync::Arc;

        use nsh_core::{
            AttributedText, MountBatch, MountItem, ResolvedTextStyle, Size, TextEngine, TextLink,
        };
        for (x, y, column_origin, row) in [(0.0, 0.0, 0_u16, 0), (14.0, 12.0, 2, 1)] {
            let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
            let mut text = AttributedText {
                selectable: Some(true),
                ..Default::default()
            };
            text.push("Hello中", ResolvedTextStyle::default());
            text.links.push(TextLink {
                start: 2,
                end: 5,
                node: 10,
                events: mask(&[EventKind::Press]),
                props: Arc::default(),
            });
            let engine = crate::TerminalTextEngine::default();
            let prepared = engine.prepare(&text);
            let layout = engine.layout(&prepared, Size::new(px(160.0), px(32.0)));
            let mut items = create(2, ViewKind::Text, ROOT_ID, 0.0);
            items.push(MountItem::Frame {
                id: 2,
                frame: Bounds::new(Point::new(px(x), px(y)), Size::new(px(160.0), px(32.0))),
            });
            items.push(MountItem::Text {
                id: 2,
                text: Arc::new(text),
                layout,
                content: Bounds::new(Point::new(px(0.0), px(0.0)), Size::new(px(160.0), px(32.0))),
            });
            surface.apply(MountBatch { items });
            let mouse = |kind, column| {
                Event::Mouse(MouseEvent {
                    kind,
                    column: column_origin + column,
                    row,
                    modifiers: KeyModifiers::NONE,
                })
            };
            surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1));
            surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 4));
            surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 4));
            assert_eq!(surface.node(2).unwrap().editor.selected(), "llo");
            key(&mut surface, KeyCode::Char('c'), KeyModifiers::CONTROL);
            assert_eq!(surface.clipboard, "llo");
            assert!(
                !surface
                    .events
                    .iter()
                    .any(|event| matches!(event, SurfaceEvent::Event(10, EventKind::Press, _)))
            );
            surface.events.clear();
            surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 3));
            surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 3));
            assert!(
                surface
                    .events
                    .iter()
                    .any(|event| matches!(event, SurfaceEvent::Event(10, EventKind::Press, _)))
            );
        }

        let mut surface = Surface::new(8, 8, crate::CellMetrics::default());
        let mut text = AttributedText {
            selectable: Some(true),
            ..Default::default()
        };
        text.push("a中中中中z\n一二", ResolvedTextStyle::default());
        text.links = vec![
            TextLink {
                start: 1,
                end: 5,
                node: 10,
                events: mask(&[EventKind::Press]),
                props: Arc::default(),
            },
            TextLink {
                start: 7,
                end: 9,
                node: 12,
                events: mask(&[EventKind::Press]),
                props: Arc::default(),
            },
        ];
        let engine = crate::TerminalTextEngine::default();
        let layout = engine.layout(&engine.prepare(&text), Size::new(px(32.0), px(64.0)));
        let content = Bounds::new(Point::default(), Size::new(px(32.0), px(64.0)));
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.push(MountItem::Frame {
            id: 2,
            frame: Bounds::new(Point::default(), Size::new(px(32.0), px(32.0))),
        });
        items.push(MountItem::ScrollConfig {
            id: 2,
            horizontal: false,
            scrollbar_visible: false,
            scroll_value: None,
            keyboard_dismiss: Default::default(),
            mirrored: false,
        });
        items.push(MountItem::ScrollContent {
            id: 2,
            size: Size::new(px(32.0), px(64.0)),
        });
        items.extend(create(4, ViewKind::Text, 2, 0.0));
        items.push(MountItem::Frame {
            id: 4,
            frame: content,
        });
        items.push(MountItem::Text {
            id: 4,
            text: Arc::new(text.clone()),
            layout: layout.clone(),
            content,
        });
        surface.apply(MountBatch { items });
        surface.set_focus(Some(4));
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(10));
        assert_eq!(surface.focus_path(), vec![10, 4, 2, ROOT_ID]);
        assert_eq!(
            surface.snapshot().lines().take(2).collect::<Vec<_>>(),
            vec!["a中", "中中"]
        );
        let area = ratatui::layout::Rect::new(0, 0, 8, 8);
        let mut buffer = ratatui::buffer::Buffer::empty(area);
        surface.render_plain(area, &mut buffer);
        assert!(
            !buffer[(0, 0)]
                .modifier
                .contains(ratatui::style::Modifier::UNDERLINED)
        );
        for cell in [(1, 0), (0, 1), (2, 1)] {
            assert!(
                buffer[cell]
                    .modifier
                    .contains(ratatui::style::Modifier::UNDERLINED)
            );
        }
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(12));
        assert_eq!(surface.node(2).unwrap().scroll.y, px(32.0));
        assert_eq!(
            surface.snapshot().lines().take(2).collect::<Vec<_>>(),
            vec!["中z", "一二"]
        );
        let semantics = surface.accessibility_snapshot();
        let second = semantics.iter().find(|node| node.id == 12).unwrap();
        assert_eq!(second.role, nsh_core::AccessibilityRole::Link);
        assert_eq!(second.label, "一二");
        assert!(second.focused);
        assert_eq!(
            second.frame,
            Bounds::new(Point::new(px(0.0), px(16.0)), Size::new(px(32.0), px(16.0)))
        );
        surface.events.clear();
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        surface.handle_event(Event::Key(KeyEvent::new_with_kind(
            KeyCode::Enter,
            KeyModifiers::NONE,
            KeyEventKind::Repeat,
        )));
        key(&mut surface, KeyCode::BackTab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(10));
        key(&mut surface, KeyCode::Char(' '), KeyModifiers::NONE);
        let presses: Vec<_> = surface
            .events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, EventKind::Press, _) => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(presses, vec![12, 10]);
        surface.events.clear();
        let mouse = |kind| {
            Event::Mouse(MouseEvent {
                kind,
                column: 1,
                row: 0,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left)));
        surface.set_focus(Some(10));
        surface.apply(MountBatch {
            items: vec![
                MountItem::Delete { id: 10 },
                MountItem::Text {
                    id: 4,
                    text: Arc::new(text.clone()),
                    layout: layout.clone(),
                    content,
                },
            ],
        });
        assert_eq!(surface.focused(), Some(2));
        assert!(surface.pointer.is_none());
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left)));
        assert!(
            !surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(10, EventKind::Press, _)))
        );
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left)));
        surface.set_focus(Some(10));
        assert_eq!(surface.focused(), Some(10));
        text.links.retain(|link| link.node != 10);
        surface.apply(MountBatch {
            items: vec![MountItem::Text {
                id: 4,
                text: Arc::new(text),
                layout,
                content,
            }],
        });
        assert_eq!(surface.focused(), Some(2));
        assert!(surface.pointer.is_none());
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left)));
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert!(
            !surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(10, EventKind::Press, _)))
        );
        key(&mut surface, KeyCode::Tab, KeyModifiers::SHIFT);
        assert_eq!(surface.focused(), Some(12));
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(12, EventKind::Press, _)))
        );

        // A pure image link has no TerminalRun. It wraps after CJK and a
        // surrogate pair, then occupies two rows at its real attachment size.
        // The transparent attachment root lets the paragraph own the contact.
        let mut surface = Surface::new(12, 8, crate::CellMetrics::default());
        let style = ResolvedTextStyle::default();
        let mut text = AttributedText {
            selectable: Some(true),
            ..Default::default()
        };
        text.push("中😀", style);
        text.push_attachment(Size::new(px(16.0), px(32.0)), style);
        text.push("!", style);
        let mut props = nsh_core::ViewProps {
            focusable: Some(true),
            ..Default::default()
        };
        props.accessibility.role = nsh_core::AccessibilityRole::Link;
        props.accessibility.label = Some("Photo".into());
        text.links.push(TextLink {
            start: 3,
            end: 4,
            node: 10,
            events: mask(&[EventKind::Press]),
            props: Arc::new(props),
        });
        let content = Bounds::new(Point::new(px(8.0), px(16.0)), Size::new(px(32.0), px(64.0)));
        let layout = engine.layout(&engine.prepare(&text), content.size);
        let mut items = create(2, ViewKind::Text, ROOT_ID, 0.0);
        items.push(MountItem::Frame {
            id: 2,
            frame: Bounds::new(Point::new(px(8.0), px(16.0)), Size::new(px(48.0), px(80.0))),
        });
        items.push(MountItem::Text {
            id: 2,
            text: Arc::new(text.clone()),
            layout: layout.clone(),
            content,
        });
        items.extend(create(4, ViewKind::View, 2, 0.0));
        items.push(MountItem::Frame {
            id: 4,
            frame: Bounds::new(Point::new(px(8.0), px(32.0)), Size::new(px(16.0), px(32.0))),
        });
        items.push(MountItem::ViewProps {
            id: 4,
            props: Box::new(nsh_core::ViewProps {
                pointer_events: PointerEvents::None,
                ..Default::default()
            }),
        });
        items.extend(create(6, ViewKind::Image, 4, 0.0));
        items.push(MountItem::Frame {
            id: 6,
            frame: Bounds::new(Point::default(), Size::new(px(16.0), px(32.0))),
        });
        surface.apply(MountBatch { items });
        let mouse = |kind, column, row| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row,
                modifiers: KeyModifiers::NONE,
            })
        };
        let presses = |surface: &Surface| {
            surface
                .events
                .iter()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, EventKind::Press, _) => Some(*id),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        surface.events.clear();
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 2, 3));
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 2, 3));
        assert_eq!(presses(&surface), [10]);
        surface.set_focus(Some(2));
        key(&mut surface, KeyCode::Tab, KeyModifiers::NONE);
        assert_eq!(surface.focused(), Some(10));
        let semantics = surface.accessibility_snapshot();
        let image_link = semantics.iter().find(|node| node.id == 10).unwrap();
        assert_eq!(image_link.role, nsh_core::AccessibilityRole::Link);
        assert_eq!(image_link.label, "Photo");
        assert!(image_link.focused);
        assert_eq!(
            image_link.frame,
            Bounds::new(
                Point::new(px(16.0), px(48.0)),
                Size::new(px(16.0), px(32.0))
            )
        );
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        key(&mut surface, KeyCode::Char(' '), KeyModifiers::NONE);
        assert_eq!(presses(&surface), [10, 10, 10]);

        // An interactive attachment keeps its own contact instead of
        // activating the enclosing text span's link or selecting its paragraph.
        surface.node_mut(2).unwrap().props.selection_area = true;
        surface.node_mut(4).unwrap().props.pointer_events = PointerEvents::Auto;
        surface.node_mut(4).unwrap().events = mask(&[EventKind::Press]);
        surface.events.clear();
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 2, 3));
        assert_eq!(surface.focused(), Some(4));
        assert!(!surface.selection_area_dragging());
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 2, 3));
        assert_eq!(presses(&surface), [4]);
        surface.node_mut(4).unwrap().props.pointer_events = PointerEvents::None;
        surface.node_mut(4).unwrap().events = Default::default();

        surface.events.clear();
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 2, 3));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5, 4));
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 5, 4));
        assert!(presses(&surface).is_empty());

        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 2, 3));
        surface.apply(MountBatch {
            items: vec![MountItem::Command {
                id: 10,
                command: nsh_core::Command::Focus,
            }],
        });
        assert_eq!(surface.focused(), Some(10));
        text.links.clear();
        surface.apply(MountBatch {
            items: vec![MountItem::Text {
                id: 2,
                text: Arc::new(text),
                layout,
                content,
            }],
        });
        assert_eq!(surface.focused(), Some(2));
        assert!(surface.pointer.is_none());
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 2, 3));
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        assert!(presses(&surface).is_empty());
    }

    #[test]
    fn inline_link_owners_follow_text_replacement_and_native_lifetimes() {
        use nsh_core::{
            AccessibilityRole, AttributedText, Command, LayoutAnimation, LayoutCurve,
            LayoutProperty, LayoutTransition, MountBatch, MountItem, ResolvedTextStyle, TextEngine,
            TextLink, ViewProps,
        };
        use std::sync::Arc;

        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let engine = crate::TerminalTextEngine::default();
        let content = Bounds::new(Point::default(), Size::new(px(160.0), px(32.0)));
        let link = |id, start, end, disabled| {
            let mut props = ViewProps::default();
            props.accessibility.state.disabled = disabled;
            TextLink {
                start,
                end,
                node: id,
                events: mask(&[EventKind::Press]),
                props: Arc::new(props),
            }
        };
        let text = |id, links| {
            let mut text = AttributedText::default();
            text.push("first second", ResolvedTextStyle::default());
            text.links = links;
            MountItem::Text {
                id,
                layout: engine.layout(&engine.prepare(&text), content.size),
                text: Arc::new(text),
                content,
            }
        };
        let focus = |surface: &mut Surface, id| {
            surface.apply(MountBatch {
                items: vec![MountItem::Command {
                    id,
                    command: Command::Focus,
                }],
            });
        };
        let activate = |surface: &mut Surface, id, owner| {
            surface.set_focus(Some(2));
            focus(surface, id);
            assert_eq!(surface.focused(), Some(id));
            assert_eq!(surface.focus_path(), vec![id, owner, 2, ROOT_ID]);
            assert!(surface.accessibility_snapshot().iter().any(|node| {
                node.id == id && node.role == AccessibilityRole::Link && node.focused
            }));
            surface.events.clear();
            key(surface, KeyCode::Enter, KeyModifiers::NONE);
            let presses = surface
                .events
                .iter()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, EventKind::Press, _) => Some(*id),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(presses, [id]);
        };
        let inactive = |surface: &mut Surface, id| {
            surface.set_focus(Some(2));
            surface.events.clear();
            focus(surface, id);
            assert_ne!(surface.focused(), Some(id));
            key(surface, KeyCode::Enter, KeyModifiers::NONE);
            assert!(!surface.events.iter().any(|event| {
                matches!(event, SurfaceEvent::Event(target, EventKind::Press, _) if *target == id)
            }));
            assert!(
                !surface
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.id == id)
            );
        };
        let mut items = create(2, ViewKind::Scroll, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::Text, 2, 0.0));
        items.push(text(4, vec![link(10, 0, 5, true), link(12, 6, 12, false)]));
        surface.apply(MountBatch { items });
        assert!(surface.accessibility_snapshot().iter().any(|node| {
            node.id == 10 && node.role == AccessibilityRole::Link && node.state.disabled
        }));
        // Delete only the first span: the remaining link moves in the Text's
        // link array, with no replacement Text to repair a stale locator.
        surface.apply(MountBatch {
            items: vec![MountItem::Delete { id: 10 }],
        });
        inactive(&mut surface, 10);
        activate(&mut surface, 12, 4);

        // A new snapshot terminates the old link; no per-span Delete is needed.
        surface.apply(MountBatch {
            items: vec![text(4, vec![link(14, 0, 5, false)])],
        });
        inactive(&mut surface, 12);
        activate(&mut surface, 14, 4);
        surface.set_focus(Some(2));
        surface.apply(MountBatch {
            items: vec![MountItem::RetireListCell {
                id: 4,
                request: 1,
                roots: vec![4],
            }],
        });
        assert!(
            surface
                .events
                .iter()
                .any(|event| { matches!(event, SurfaceEvent::ListCellRetired(4, 1, true)) })
        );
        assert!(
            !surface
                .accessibility_snapshot()
                .iter()
                .any(|node| node.id == 14)
        );
        // Parked content is still resident: restoration need not resend Text.
        surface.apply(MountBatch {
            items: vec![MountItem::ProjectRoot {
                parent: 2,
                id: 4,
                following: vec![],
            }],
        });
        activate(&mut surface, 14, 4);

        for (old, next, boundary) in [(14, 16, 0), (16, 18, 1), (18, 20, 2)] {
            surface.set_focus(Some(2));
            match boundary {
                0 => surface.apply(MountBatch {
                    items: vec![MountItem::Delete { id: 4 }],
                }),
                1 => {
                    surface.apply(MountBatch {
                        items: vec![
                            MountItem::LayoutAnimation(LayoutAnimation {
                                delete: Some(LayoutTransition {
                                    curve: LayoutCurve::Linear,
                                    property: LayoutProperty::Opacity,
                                    duration_ms: 1000.0,
                                    delay_ms: 0.0,
                                }),
                                ..LayoutAnimation::default()
                            }),
                            MountItem::Delete { id: 4 },
                        ],
                    });
                    surface.tick(surface.now + 1.1);
                }
                // Remove retains its Node; the subsequent Create overwrites it.
                _ => surface.apply(MountBatch {
                    items: vec![MountItem::Remove { id: 4 }],
                }),
            }
            let mut items = create(4, ViewKind::Text, 2, 0.0);
            items.push(text(4, vec![link(next, 0, 5, false)]));
            surface.apply(MountBatch { items });
            inactive(&mut surface, old);
            activate(&mut surface, next, 4);
        }
        // A moved span can be published at its new Text before the previous
        // owner's other span or the owner itself is deleted. Deleting that
        // sibling must not reclaim the moved span while compacting the array.
        let mut items = vec![text(4, vec![link(20, 0, 5, false), link(22, 6, 12, false)])];
        items.extend(create(6, ViewKind::Text, 2, 0.0));
        items.push(text(6, vec![link(20, 0, 5, false)]));
        items.push(MountItem::Delete { id: 22 });
        items.push(MountItem::Delete { id: 4 });
        surface.apply(MountBatch { items });
        activate(&mut surface, 20, 6);

        // Separately, a stale old-owner Text update must not retire a link
        // already published by the new owner, even while it keeps focus.
        let mut items = create(4, ViewKind::Text, 2, 0.0);
        items.push(text(4, vec![link(20, 0, 5, false), link(22, 6, 12, false)]));
        items.push(text(6, vec![link(20, 0, 5, false)]));
        surface.apply(MountBatch { items });
        focus(&mut surface, 20);
        assert_eq!(surface.focus_path(), vec![20, 6, 2, ROOT_ID]);
        surface.events.clear();
        surface.apply(MountBatch {
            items: vec![text(4, vec![link(22, 6, 12, false)])],
        });
        assert_eq!(surface.focused(), Some(20));
        assert_eq!(surface.focus_path(), vec![20, 6, 2, ROOT_ID]);
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        let presses = surface
            .events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, EventKind::Press, _) => Some(*id),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(presses, [20]);

        // A real view takes precedence over a virtual span with that ID.
        let mut items = create(20, ViewKind::View, 2, 0.0);
        items.push(MountItem::Events {
            id: 20,
            events: mask(&[EventKind::Press]),
        });
        surface.apply(MountBatch { items });
        focus(&mut surface, 20);
        assert_eq!(surface.focus_path(), vec![20, 2, ROOT_ID]);
        surface.events.clear();
        surface.apply(MountBatch {
            items: vec![text(6, vec![])],
        });
        assert_eq!(surface.focused(), Some(20));
        assert_eq!(surface.focus_path(), vec![20, 2, ROOT_ID]);
        key(&mut surface, KeyCode::Enter, KeyModifiers::NONE);
        let presses = surface
            .events
            .iter()
            .filter_map(|event| match event {
                SurfaceEvent::Event(id, EventKind::Press, _) => Some(*id),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(presses, [20]);
    }

    #[test]
    fn native_long_press_suppresses_click_and_drag_reports_raw_touches_and_pan() {
        use nsh_core::{GestureValues, MountBatch, MountItem};
        let mut surface = form();
        surface.node_mut(4).unwrap().events = mask(&[
            EventKind::Press,
            EventKind::LongPress,
            EventKind::Touch,
            EventKind::PanStart,
            EventKind::PanEnd,
        ]);
        surface.node_mut(4).unwrap().props.long_press_delay = Some(0.0);
        let mouse = |kind, column| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row: 3,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1));
        assert!(surface.input_tick());
        assert!(!surface.input_pending());
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 1));
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(4, EventKind::LongPress, _)))
        );
        assert!(
            !surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(4, EventKind::Press, _)))
        );
        surface.apply(MountBatch {
            items: vec![
                MountItem::Animation(nsh_core::animation::AnimationOp::CreateValue {
                    node: 11,
                    value: 5.0,
                }),
                MountItem::Gestures {
                    id: 4,
                    values: GestureValues {
                        pan_x: Some(11),
                        ..Default::default()
                    },
                },
            ],
        });
        surface.events.clear();
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5));
        assert_eq!(surface.animation.value(11), Some(37.0));
        surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 5));
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(4, EventKind::PanStart, _)))
        );
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(4, EventKind::PanEnd, _)))
        );
        assert!(surface.events.iter().any(|event| matches!(event,SurfaceEvent::Event(ROOT_ID,EventKind::Touch,EventPayload::Touch(touch)) if touch.phase == TouchPhase::Move && touch.activated == Some(4))));

        for retirement in [
            None,
            Some(MountItem::Remove { id: 4 }),
            Some(MountItem::Delete { id: 4 }),
        ] {
            let remove_owner = retirement.is_some();
            let mut surface = form();
            let mut items = create(6, ViewKind::View, 4, 0.0);
            items.extend(create(8, ViewKind::View, ROOT_ID, 96.0));
            surface.apply(MountBatch { items });
            surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1));
            let mut items = vec![MountItem::Insert {
                parent: 8,
                child: 6,
                before: None,
            }];
            if let Some(item) = retirement {
                items.push(item);
            }
            surface.apply(MountBatch { items });
            assert_eq!(surface.node(6).unwrap().parent, Some(8));
            surface.events.clear();
            assert_eq!(
                surface.handle_event(mouse(MouseEventKind::Up(MouseButton::Left), 1)),
                !remove_owner
            );
            let released = surface
                .drain_events()
                .filter_map(|event| match event {
                    SurfaceEvent::Event(id, kind @ (EventKind::Press | EventKind::PressUp), _) => {
                        Some((id, kind))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                released,
                if remove_owner {
                    vec![]
                } else {
                    vec![(4, EventKind::PressUp), (4, EventKind::Press)]
                }
            );
        }
    }

    #[test]
    fn host_edits_guard_generation_graphemes_focus_and_secure_context() {
        let mut surface = form();
        surface.handle_event(Event::Paste("a😀b".into()));
        let context = surface.input_context().unwrap();
        assert_eq!(context.text.as_deref(), Some("a😀b"));
        assert!(!surface.apply_input_edit(InputEdit {
            node: 2,
            expected_event_count: context.event_count,
            selection: 1..2,
            replacement: "split".into()
        }));
        assert!(surface.apply_input_edit(InputEdit {
            node: 2,
            expected_event_count: context.event_count,
            selection: 1..3,
            replacement: "中".into()
        }));
        assert_eq!(surface.node(2).unwrap().editor.text(), "a中b");
        assert!(!surface.apply_input_edit(InputEdit {
            node: 2,
            expected_event_count: context.event_count,
            selection: 0..1,
            replacement: "stale".into()
        }));
        surface.node_mut(2).unwrap().input.max_length = Some(3);
        let current = surface.input_context().unwrap();
        assert!(!surface.apply_input_edit(InputEdit {
            node: 2,
            expected_event_count: current.event_count,
            selection: 0..1,
            replacement: "😀".into()
        }));
        assert_eq!(
            surface.input_context().unwrap().selection,
            current.selection
        );
        surface.node_mut(2).unwrap().input.secure = true;
        assert_eq!(surface.input_context().unwrap().text, None);
        let count = surface.node(2).unwrap().editor.count();
        surface.set_focus(Some(4));
        assert!(!surface.apply_input_edit(InputEdit {
            node: 2,
            expected_event_count: count,
            selection: 0..3,
            replacement: "background".into()
        }));
        surface.set_focus(Some(2));
        surface.selection(2, 3, 3);
        let input = &mut surface.node_mut(2).unwrap().input;
        input.secure = false;
        input.auto_capitalize = nsh_core::AutoCapitalize::Characters;
        input.max_length = Some(5);
        assert!(surface.type_text("xy"));
        assert_eq!(surface.node(2).unwrap().editor.text(), "a中bXY");
        key(&mut surface, KeyCode::Char('a'), KeyModifiers::NONE);
        assert_eq!(surface.node(2).unwrap().editor.text(), "a中bXY");
    }

    #[test]
    fn transformed_inputs_report_local_caret_touch_and_pan_coordinates() {
        let mut surface = form();
        let origin = nsh_core::TransformOrigin {
            x: px(0.0).into(),
            y: px(0.0).into(),
            z: px(0.0),
        };
        let node = surface.node_mut(2).unwrap();
        node.style.transform_origin = origin;
        node.style
            .transform
            .push(nsh_core::TransformKind::Scale, 2.0);
        node.editor.controlled("abcd".into(), 0);
        node.events = mask(&[EventKind::Touch]);
        surface.handle_event(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 4,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(surface.node(2).unwrap().editor.selection(), (2, 2));
        assert!(surface.events.iter().any(|event|matches!(event,SurfaceEvent::Event(ROOT_ID,EventKind::Touch,EventPayload::Touch(touch)) if touch.phase==TouchPhase::Start && (touch.points[0].location.x.0-18.0).abs()<0.001 && (touch.points[0].location.y.0-4.0).abs()<0.001)));
        surface.cancel_pointer();
        let node = surface.node_mut(4).unwrap();
        node.style.transform_origin = origin;
        node.style
            .transform
            .push(nsh_core::TransformKind::Scale, 2.0);
        node.events = mask(&[EventKind::PanStart, EventKind::PanEnd]);
        node.gestures.pan_x = Some(11);
        surface.animation.apply(
            nsh_core::animation::AnimationOp::CreateValue {
                node: 11,
                value: 5.0,
            },
            &mut Vec::new(),
        );
        let mouse = |kind, column| {
            Event::Mouse(MouseEvent {
                kind,
                column,
                row: 3,
                modifiers: KeyModifiers::NONE,
            })
        };
        surface.handle_event(mouse(MouseEventKind::Down(MouseButton::Left), 1));
        surface.handle_event(mouse(MouseEventKind::Drag(MouseButton::Left), 5));
        assert!((surface.animation.value(11).unwrap() - 21.0).abs() < 0.001);
    }

    #[test]
    fn keyboard_back_honors_prevent_back_before_javascript() {
        use nsh_core::{MountBatch, MountItem};
        let mut surface = Surface::new(40, 12, crate::CellMetrics::default());
        let mut items = create(2, ViewKind::Stack, ROOT_ID, 0.0);
        items.extend(create(4, ViewKind::Screen, 2, 0.0));
        items.extend(create(6, ViewKind::Screen, 2, 0.0));
        items.push(MountItem::ScreenConfig {
            id: 6,
            config: Box::new(nsh_core::ScreenConfig {
                prevent_back: true,
                ..Default::default()
            }),
        });
        surface.apply(MountBatch { items });
        surface.tick(1.0);
        surface.events.clear();
        key(&mut surface, KeyCode::Esc, KeyModifiers::NONE);
        assert!(
            surface
                .events
                .iter()
                .any(|event| matches!(event, SurfaceEvent::Event(6, EventKind::BackRequest, _)))
        );
        assert!(!surface.node(6).unwrap().popped);
    }
}
