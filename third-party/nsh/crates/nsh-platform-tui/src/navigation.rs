//! Native stack decisions applied at complete mount-batch boundaries.

use nsh_core::{
    EventKind, EventPayload, NodeId, PayloadValue, ROOT_ID, ScreenConfig, ViewKind,
    navigation::{Reported, insets_payload},
};
use nsh_engine::EngineControl;

use crate::mount::Mounter;

#[derive(Default)]
pub(crate) struct Screen {
    pub(crate) config: ScreenConfig,
    reported: Reported,
}

#[derive(Default)]
pub(crate) struct Modal {
    pub(crate) config: nsh_core::ModalConfig,
    pub(crate) reported: Reported,
    pub(crate) closed: bool,
    pub(crate) shown: bool,
}

pub(crate) fn focus_scope(tree: &Mounter) -> NodeId {
    tree.modals
        .iter()
        .rev()
        .copied()
        .find(|&id| modal_visible(tree, id))
        .unwrap_or(ROOT_ID)
}

pub(crate) fn modal_visible(tree: &Mounter, id: NodeId) -> bool {
    tree.get(id).is_some_and(|v| {
        v.modal.as_ref().is_some_and(|m| !m.closed)
            && !v.style.hidden
            && v.style.opacity > 0.0
            && crate::keyboard::contains(tree, ROOT_ID, id)
    })
}

fn visible(tree: &Mounter, mut id: NodeId) -> bool {
    loop {
        let Some(view) = tree.get(id) else {
            return false;
        };
        if view.concealed || view.style.hidden || view.style.opacity <= 0.0 {
            return false;
        }
        if id == ROOT_ID {
            return true;
        }
        if view.kind == ViewKind::Modal {
            return modal_visible(tree, id);
        }
        let Some(parent) = view.parent else {
            return false;
        };
        id = parent;
    }
}

pub(crate) enum CloseReason {
    Cancel,
    Backdrop,
}

pub(crate) fn request_close(
    tree: &mut Mounter,
    control: &EngineControl,
    id: NodeId,
    reason: CloseReason,
) {
    let Some(view) = tree.get_mut(id) else {
        return;
    };
    let Some(modal) = &mut view.modal else {
        return;
    };
    if modal.closed {
        return;
    }
    let (reason, close) = match reason {
        CloseReason::Cancel => ("cancel", modal.config.close_on_escape),
        CloseReason::Backdrop => ("backdrop", modal.config.close_on_backdrop_press),
    };
    control.dispatch_event(
        id,
        EventKind::RequestClose,
        EventPayload::Map(vec![("reason", PayloadValue::Str(reason.into()))]),
    );
    if close {
        modal.closed = true;
        view.concealed = true;
        control.dispatch_event(id, EventKind::Dismiss, EventPayload::None);
    }
}

pub(crate) fn back(tree: &mut Mounter, control: &EngineControl, app_first: bool) -> bool {
    use nsh_core::navigation::{Back, back_target, innermost};
    let scope = focus_scope(tree);
    let newest = (scope != ROOT_ID).then_some(scope);
    let app_listens = app_first
        && tree
            .get(ROOT_ID)
            .is_some_and(|v| v.events.contains(EventKind::BackPress));
    let target = back_target(newest, app_listens, |modal| {
        let stacks: Vec<_> = tree
            .views
            .iter()
            .enumerate()
            .filter_map(|(index, view)| {
                let id = index as NodeId;
                let view = view.as_ref()?;
                let stack = view.stack.as_ref()?;
                (visible(tree, id)
                    && nsh_core::navigation::shown_in_layout(
                        std::iter::successors(Some(id), |&id| tree.get(id)?.parent)
                            .filter(|&id| id != ROOT_ID)
                            .filter_map(|id| Some(tree.get(id)?.frame)),
                    )
                    && modal.is_none_or(|modal| crate::keyboard::contains(tree, modal, id))
                    && stack.takes_back(|screen| {
                        tree.get(screen)
                            .and_then(|v| v.screen.as_ref())
                            .is_some_and(|s| s.config.prevent_back)
                    }))
                .then_some(id)
            })
            .collect();
        innermost(&stacks, |&outer, &inner| {
            crate::keyboard::contains(tree, outer, inner)
        })
        .copied()
    });
    match target {
        Some(Back::App) => {
            control.dispatch_event(ROOT_ID, EventKind::BackPress, EventPayload::None)
        }
        Some(Back::Stack(id)) => {
            let top = tree
                .get(id)
                .and_then(|v| v.stack.as_ref())
                .and_then(|s| s.top())
                .unwrap();
            let view = tree.get(top).unwrap();
            if view.events.contains(EventKind::BackRequest) {
                control.dispatch_event(top, EventKind::BackRequest, EventPayload::None);
            }
            if view.screen.as_ref().is_some_and(|s| s.config.prevent_back) {
                return true;
            }
            let stack = tree.get_mut(id).unwrap().stack.as_mut().unwrap();
            if stack.pop().is_none() {
                return true;
            }
            let shown = stack.top();
            let children = tree.get(id).unwrap().children.clone();
            for child in children {
                if let Some(view) = tree.get_mut(child)
                    && view.kind == ViewKind::Screen
                {
                    view.concealed = Some(child) != shown;
                }
            }
            control.dispatch_event(top, EventKind::Dismiss, EventPayload::None);
        }
        Some(Back::Modal(id)) => request_close(tree, control, id, CloseReason::Cancel),
        None => return false,
    }
    true
}

pub(crate) fn end_batch(tree: &mut Mounter) {
    // Core inserts siblings from the end using `before` anchors. New modals in
    // one commit follow the completed tree's paint order, not message order.
    if !tree.pending_modals.is_empty() {
        let mut pending = std::mem::take(&mut tree.pending_modals);
        let mut presented = Vec::new();
        collect_presented(tree, ROOT_ID, &pending, &mut presented);
        pending.retain(|id| !presented.contains(id));
        tree.modals.extend(presented);
        tree.pending_modals = pending;
    }
    let mut dirty = std::mem::take(&mut tree.dirty_stacks);
    for &id in &dirty {
        let Some(stack) = tree.get(id) else {
            continue;
        };
        let screens: Vec<_> = stack
            .children
            .iter()
            .copied()
            .filter(|&child| {
                tree.get(child)
                    .is_some_and(|view| view.kind == ViewKind::Screen)
            })
            .collect();
        let Some(state) = tree.get_mut(id).and_then(|view| view.stack.as_mut()) else {
            continue;
        };
        state.reconcile(&screens);
        let top = state.top();
        for screen in screens {
            if let Some(view) = tree.get_mut(screen) {
                view.concealed = Some(screen) != top;
            }
        }
    }
    dirty.clear();
    tree.dirty_stacks = dirty;
    let mut dirty = std::mem::take(&mut tree.dirty_screens);
    for &id in &dirty {
        let Some(view) = tree.get(id) else {
            continue;
        };
        let Some(screen) = &view.screen else {
            continue;
        };
        let selected = screen.config.header_view;
        let headers: Vec<_> = view
            .children
            .iter()
            .copied()
            .filter(|&child| {
                tree.get(child)
                    .is_some_and(|view| view.kind == ViewKind::HeaderItem)
            })
            .collect();
        for &header in &headers {
            if let Some(view) = tree.get_mut(header) {
                view.concealed = Some(header) != selected;
            }
        }
        if let Some(header) = selected.filter(|id| headers.contains(id)) {
            let children = &mut tree.get_mut(id).unwrap().children;
            if children.last() != Some(&header) {
                children.retain(|&id| id != header);
                children.push(header);
            }
        }
    }
    dirty.clear();
    tree.dirty_screens = dirty;
}

fn collect_presented(tree: &Mounter, id: NodeId, pending: &[NodeId], presented: &mut Vec<NodeId>) {
    let Some(view) = tree.get(id) else {
        return;
    };
    if pending.contains(&id) {
        presented.push(id);
    }
    for &child in &view.children {
        collect_presented(tree, child, pending, presented);
    }
}

pub(crate) fn report_shown(tree: &mut Mounter, control: &EngineControl) {
    let size = tree.get(ROOT_ID).map(|v| v.frame.size).unwrap_or_default();
    let modals = tree.modals.clone();
    for &id in &modals {
        if !modal_visible(tree, id) {
            continue;
        }
        let view = tree.get_mut(id).unwrap();
        view.frame = nsh_core::Bounds::new(Default::default(), size);
        let modal = view.modal.as_mut().unwrap();
        let insets = Default::default();
        if let Some(changed) = modal.reported.update(size, insets) {
            control.set_root_size(id, size, insets);
            if changed {
                control.dispatch_event(id, EventKind::Insets, insets_payload(insets));
            }
        }
        if size.width > nsh_core::Points::ZERO && !modal.shown {
            modal.shown = true;
            control.dispatch_event(id, EventKind::Show, EventPayload::None);
        }
    }
    report_in(tree, ROOT_ID, control);
    for id in modals {
        if modal_visible(tree, id) {
            report_in(tree, id, control);
        }
    }
}

fn report_in(tree: &mut Mounter, id: NodeId, control: &EngineControl) {
    let Some(view) = tree.get(id) else {
        return;
    };
    if view.concealed || view.style.hidden || view.style.opacity <= 0.0 {
        return;
    }
    let children = view.children.len();
    if view.kind == ViewKind::Screen {
        let size = view
            .parent
            .and_then(|parent| tree.get(parent))
            .filter(|parent| parent.kind == ViewKind::Stack)
            .map(|stack| stack.frame.size);
        if let Some(size) = size {
            let screen = tree.get_mut(id).unwrap().screen.as_mut().unwrap();
            let insets = Default::default();
            if let Some(insets_changed) = screen.reported.update(size, insets) {
                control.set_root_size(id, size, insets);
                if insets_changed {
                    control.dispatch_event(id, EventKind::Insets, insets_payload(insets));
                }
            }
        }
    }
    for index in 0..children {
        let child = tree.get(id).unwrap().children[index];
        if tree.get(child).is_some_and(|v| v.kind != ViewKind::Modal) {
            report_in(tree, child, control);
        }
    }
}
