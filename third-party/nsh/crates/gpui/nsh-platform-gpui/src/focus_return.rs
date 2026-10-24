//! Popovers' native focus lifetime. Core supplies their logical parent,
//! because the native overlay views are siblings in the surface or modal.
//! Capture before a batch can run child autoFocus; reconcile its final
//! tree, so moving an overlay is not a close followed by another opening.
//! Modal return targets join that same chain when a batch replaces a scope.

use std::rc::Rc;

use nsh_core::{Command, MountBatch, MountItem, NodeId, ViewKind};

use crate::{surface::Surface, text_input::FocusTarget, view::NshView};

#[derive(Default)]
pub(crate) struct FocusReturns {
    popups: Vec<FocusScope>,
}

#[derive(Clone)]
struct FocusScope {
    view: NshView,
    parent: NshView,
    restore: Option<FocusTarget>,
}

pub(crate) struct BeforeBatch {
    focused: Option<FocusTarget>,
    owner: Option<NshView>,
    modals: Vec<FocusScope>,
}

fn focused(surface: &Surface) -> Option<FocusTarget> {
    crate::native::requested_focus(surface)
        .and_then(|id| surface.view(id))
        .map(FocusTarget::View)
        .or_else(|| crate::text_input::focused_target(surface))
        .or_else(|| {
            crate::native::focused_component(surface)
                .and_then(|id| surface.view(id))
                .map(FocusTarget::View)
        })
}

fn contains(parent: &NshView, child: &NshView) -> bool {
    let mut next = Some(child.clone());
    while let Some(view) = next {
        if view == *parent {
            return true;
        }
        next = view.parent_view();
    }
    false
}

fn current(surface: &Surface, view: &NshView) -> bool {
    surface.view(view.id()).as_ref() == Some(view)
}

fn candidate(item: &MountItem) -> Option<NodeId> {
    match item {
        MountItem::ViewProps { id, .. } | MountItem::ViewStyle { id, .. } => Some(*id),
        MountItem::Insert { child, .. } => Some(*child),
        MountItem::ProjectRoot { id, .. } => Some(*id),
        _ => None,
    }
}

fn eligible(surface: &Surface, target: &FocusTarget) -> bool {
    returnable(surface, target) && contains(&crate::navigation::focus_scope(surface), target.view())
}

fn returnable(surface: &Surface, target: &FocusTarget) -> bool {
    current(surface, target.view()) && target.valid(surface) && !leaving(target.view())
}

fn leaving(view: &NshView) -> bool {
    let mut next = Some(view.clone());
    while let Some(view) = next {
        if view.state().live.as_ref().is_some_and(|live| live.dying()) {
            return true;
        }
        next = view.parent_view();
    }
    false
}

fn popup_parent(surface: &Surface, view: &NshView) -> Option<NshView> {
    if !current(surface, view) || !crate::navigation::is_shown(view) || leaving(view) {
        return None;
    }
    let parent = surface.view(view.state().props.focus_return_parent?)?;
    // A logical parent can be a native sibling, but it must still be the
    // shown popup the core identified, or the real surface/modal root.
    if parent != surface.root
        && !(parent.kind() == ViewKind::Modal
            && current(surface, &parent)
            && crate::navigation::is_shown(&parent))
        && popup_parent(surface, &parent).is_none()
    {
        return None;
    }
    Some(parent)
}

fn owner<'a>(popups: &'a [FocusScope], view: &NshView) -> Option<&'a FocusScope> {
    let mut next = Some(view.clone());
    while let Some(view) = next {
        if let Some(popup) = popups.iter().find(|popup| popup.view == view) {
            return Some(popup);
        }
        next = view.parent_view();
    }
    None
}

fn within(popups: &[FocusScope], parent: &NshView, view: &NshView) -> bool {
    if contains(parent, view) {
        return true;
    }
    let mut next = owner(popups, view);
    while let Some(popup) = next {
        if popup.parent == *parent {
            return true;
        }
        next = popups.iter().find(|parent| parent.view == popup.parent);
    }
    false
}

fn restore_target<'a>(
    surface: &Surface,
    active: &[FocusScope],
    closing: &'a [FocusScope],
    mut returning: Option<&'a FocusScope>,
    can_return: impl Fn(&Surface, &FocusTarget) -> bool,
) -> Option<FocusTarget> {
    while let Some(popup) = returning {
        if let Some(target) = &popup.restore {
            if let Some(parent) = owner(closing, target.view()) {
                returning = Some(parent);
                continue;
            }
            if can_return(surface, target) {
                return Some(target.clone());
            }
        }
        // Deleted children no longer have native ancestry. The captured
        // logical parent still identifies the next owner to unwind.
        returning = closing.iter().find(|parent| parent.view == popup.parent);
        if returning.is_none()
            && active.iter().any(|parent| parent.view == popup.parent)
            && let Some(target) = crate::input::first_focus_stop(surface, &popup.parent)
            && can_return(surface, &target)
        {
            return Some(target);
        }
    }
    None
}

impl FocusReturns {
    pub(crate) fn clear(&mut self) {
        self.popups.clear();
    }

    fn reconcile(
        &mut self,
        surface: &Surface,
        batch: &MountBatch,
        before: BeforeBatch,
    ) -> Option<FocusTarget> {
        let now = focused(surface);
        let mut closing = Vec::new();
        let mut retained = Vec::with_capacity(self.popups.len());
        for popup in self.popups.drain(..) {
            if (current(surface, &popup.view) && crate::navigation::is_parked(surface, &popup.view))
                || popup_parent(surface, &popup.view).as_ref() == Some(&popup.parent)
            {
                retained.push(popup);
            } else {
                closing.push(popup);
            }
        }
        self.popups = retained;

        let modals = crate::navigation::focus_returns(surface);
        let mut active = self.popups.clone();
        for modal in &before.modals {
            if modals.iter().any(|(view, _)| *view == modal.view) {
                active.push(modal.clone());
            } else {
                closing.push(modal.clone());
            }
        }

        let previous_owner = before
            .owner
            .as_ref()
            .and_then(|view| closing.iter().find(|popup| popup.view == *view));
        let restore = match previous_owner {
            // A new modal may cover this target. Inherit the live owner
            // now; its modal scope only decides when focus can return.
            Some(owner) => restore_target(surface, &active, &closing, Some(owner), returnable),
            None => before.focused.clone(),
        };

        let blurred = batch.items.iter().rev().find_map(|item| match item {
            MountItem::Command {
                command: Command::Blur,
                ..
            } => Some(true),
            MountItem::Command {
                command: Command::Focus,
                ..
            } => Some(false),
            _ => None,
        }) == Some(true);
        for (view, target) in modals {
            if crate::navigation::is_parked(surface, &view) {
                continue;
            }
            let target = match before.modals.iter().find(|modal| modal.view == view) {
                Some(modal) => restore_target(surface, &active, &closing, Some(modal), returnable),
                None if target
                    .as_ref()
                    .is_some_and(|target| returnable(surface, target)) =>
                {
                    target
                }
                None if !blurred => restore
                    .clone()
                    .filter(|target| !contains(&view, target.view())),
                None => None,
            };
            crate::navigation::set_focus_return(surface, &view, target);
        }

        let mut opened = Vec::new();
        for item in &batch.items {
            let Some(view) = candidate(item).and_then(|id| surface.view(id)) else {
                continue;
            };
            if self.popups.iter().any(|popup| popup.view == view) {
                continue;
            }
            let Some(parent) = popup_parent(surface, &view) else {
                continue;
            };
            self.popups.push(FocusScope {
                view: view.clone(),
                parent,
                restore: restore
                    .clone()
                    .filter(|target| !contains(&view, target.view())),
            });
            opened.push(view);
        }

        // New nested popups may have been configured before their parent.
        // Open the innermost last, independently of native sibling ancestry.
        opened.sort_by_key(|view| {
            let mut depth = 0;
            let mut next = self.popups.iter().find(|popup| popup.view == *view);
            while let Some(popup) = next {
                depth += 1;
                next = self
                    .popups
                    .iter()
                    .find(|parent| parent.view == popup.parent);
            }
            depth
        });
        for view in &opened {
            let index = self
                .popups
                .iter()
                .position(|popup| popup.view == *view)
                .unwrap();
            if opened.contains(&self.popups[index].parent) {
                self.popups[index].restore =
                    crate::input::first_focus_stop(surface, &self.popups[index].parent);
            }
        }
        let explicit = blurred
            || batch.items.iter().any(|item| {
                matches!(
                    item,
                    MountItem::Command {
                        command: Command::Focus,
                        ..
                    }
                )
            });
        if !explicit {
            for view in opened.iter().rev() {
                if !contains(&crate::navigation::focus_scope(surface), view) {
                    continue;
                }
                // A child autoFocus already established the correct owner.
                // Keep its caret, including in a logical nested popup.
                if now
                    .as_ref()
                    .is_some_and(|field| within(&self.popups, view, field.view()))
                {
                    return None;
                }
                if let Some(target) = crate::input::first_focus_stop(surface, view) {
                    return Some(target);
                }
            }
        }

        // A retained popup can be removed and reinserted in one batch.
        // Its old focused control was retired, but its original opener and
        // logical scope survived. Resume inside that final active popup.
        if !explicit
            && now.is_none()
            && before.focused.is_none()
            && let Some(popup) = self
                .popups
                .iter()
                .find(|popup| Some(&popup.view) == before.owner.as_ref())
            && contains(&crate::navigation::focus_scope(surface), &popup.view)
            && let Some(target) = crate::input::first_focus_stop(surface, &popup.view)
        {
            return Some(target);
        }

        // A pointer press outside may have moved focus before the app's
        // close batch. Only the departing owner can give focus back.
        if blurred && now.is_none() {
            return None;
        }
        let returning = match &now {
            Some(view) => owner(&closing, view.view()),
            None => previous_owner,
        };
        restore_target(surface, &self.popups, &closing, returning, eligible)
    }
}

fn retire_target(root: &NshView, target: &mut Option<FocusTarget>) {
    if target
        .as_ref()
        .is_some_and(|view| contains(root, view.view()))
    {
        target.take();
    }
}

/// Revoke saved targets while the removed root still has its old ancestry.
/// Logical scope parents remain available to unwind a popup/modal chain.
pub(crate) fn retiring(surface: &Surface, root: &NshView) {
    for popup in &mut surface.focus_returns.borrow_mut().popups {
        retire_target(root, &mut popup.restore);
    }
    for (view, target) in crate::navigation::focus_returns(surface) {
        if target
            .as_ref()
            .is_some_and(|target| contains(root, target.view()))
        {
            crate::navigation::set_focus_return(surface, &view, None);
        }
    }
}

/// A virtual target's release also revokes saved popup/modal return owners.
pub(crate) fn retiring_link(surface: &Surface, node: NodeId) {
    for popup in &mut surface.focus_returns.borrow_mut().popups {
        if popup
            .restore
            .as_ref()
            .is_some_and(|target| target.id() == node)
        {
            popup.restore = None;
        }
    }
    for (view, target) in crate::navigation::focus_returns(surface) {
        if target.as_ref().is_some_and(|target| target.id() == node) {
            crate::navigation::set_focus_return(surface, &view, None);
        }
    }
}

pub(crate) fn retire_link_before(before: Option<&mut BeforeBatch>, node: NodeId) {
    if let Some(before) = before {
        if before
            .focused
            .as_ref()
            .is_some_and(|target| target.id() == node)
        {
            before.focused = None;
        }
        for modal in &mut before.modals {
            if modal
                .restore
                .as_ref()
                .is_some_and(|target| target.id() == node)
            {
                modal.restore = None;
            }
        }
    }
}

/// A batch's captured targets follow the same real-removal boundary.
pub(crate) fn retire_before(before: Option<&mut BeforeBatch>, root: &NshView) {
    if let Some(before) = before {
        retire_target(root, &mut before.focused);
        for modal in &mut before.modals {
            retire_target(root, &mut modal.restore);
        }
    }
}

/// Captures the real native owner before a child autoFocus or Delete.
/// Streamed children do not change a popup's lifetime. Only changed popup
/// roots and their mounted ancestors need a focus-return reconciliation.
pub(crate) fn before_batch(surface: &Surface, batch: &MountBatch) -> Option<BeforeBatch> {
    let state = surface.focus_returns.borrow();
    if !batch.items.iter().any(|item| {
        matches!(item, MountItem::ViewProps { props, .. } if props.focus_return_parent.is_some())
            || matches!(
                item,
                MountItem::Create {
                    kind: ViewKind::Modal,
                    ..
                }
            )
            || candidate(item)
                .and_then(|id| surface.view(id))
                .is_some_and(|view| {
                    view.kind() == ViewKind::Modal
                        || view.state().props.focus_return_parent.is_some()
                        || state
                            .popups
                            .iter()
                            .any(|popup| contains(&view, &popup.view))
                })
            || match item {
                MountItem::Remove { id } | MountItem::Delete { id } => {
                    surface.view(*id).is_some_and(|view| {
                        view.kind() == ViewKind::Modal
                            || state
                                .popups
                                .iter()
                                .any(|popup| contains(&view, &popup.view))
                    })
                }
                _ => false,
            }
    }) {
        return None;
    }
    let mut modals = Vec::new();
    for (view, restore) in crate::navigation::focus_returns(surface) {
        let parent = restore
            .as_ref()
            .and_then(|target| {
                owner(&state.popups, target.view()).or_else(|| owner(&modals, target.view()))
            })
            .map(|scope| scope.view.clone())
            .unwrap_or_else(|| surface.root.clone());
        modals.push(FocusScope {
            view,
            parent,
            restore,
        });
    }
    let focused = focused(surface);
    let owner = focused
        .as_ref()
        .and_then(|view| owner(&state.popups, view.view()).or_else(|| owner(&modals, view.view())))
        .map(|popup| popup.view.clone());
    Some(BeforeBatch {
        focused,
        owner,
        modals,
    })
}

pub(crate) fn after_batch(surface: &Rc<Surface>, batch: &MountBatch, before: Option<BeforeBatch>) {
    let Some(before) = before else { return };
    let target = surface
        .focus_returns
        .borrow_mut()
        .reconcile(surface, batch, before);
    if let Some(target) = target {
        crate::input::restore_focus(surface, &target);
    }
}

/// A successful explicit blur also cancels the immediate return of a
/// modal removed later in this batch. Capture still keeps its old chain
/// for a later explicit focus command or replacement scope.
pub(crate) fn after_blur(surface: &Surface, batch: &MountBatch) {
    if focused(surface).is_some() {
        return;
    }
    for (view, _) in crate::navigation::focus_returns(surface) {
        if batch.items.iter().any(|item| match item {
            MountItem::Remove { id } | MountItem::Delete { id } => surface
                .view(*id)
                .is_some_and(|removed| contains(&removed, &view)),
            _ => false,
        }) {
            crate::navigation::set_focus_return(surface, &view, None);
        }
    }
}

/// Tab follows the popup that currently owns native focus. Pointer hit
/// testing and explicit focus outside it remain unrestricted.
pub(crate) fn scope(surface: &Surface) -> Option<NshView> {
    let state = surface.focus_returns.borrow();
    let active = |popup: &&FocusScope| {
        popup_parent(surface, &popup.view).as_ref() == Some(&popup.parent)
            && contains(&crate::navigation::focus_scope(surface), &popup.view)
    };
    let popup = match focused(surface) {
        Some(view) => owner(&state.popups, view.view()).filter(active),
        None => state.popups.iter().rev().find(active),
    };
    popup.map(|popup| popup.view.clone())
}
