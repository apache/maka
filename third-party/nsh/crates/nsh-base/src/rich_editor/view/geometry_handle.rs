/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! A session's transferable geometry proxy; its payload stays with the view.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    marker::PhantomData,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread::{self, ThreadId},
};

use nsh_core::prelude::*;

use super::{
    controller::{PageOffset, Tree},
    geometry::{Geometry, Hit},
    session::{EditorSession, SubscriptionId, ViewGeometry},
};
use crate::rich_editor::state::{Affinity, EditorState};

#[derive(Clone)]
pub(super) struct LocalGeometry {
    pub(super) geo: Rc<RefCell<Geometry>>,
    pub(super) state: Rc<RefCell<EditorState>>,
    pub(super) tree: Rc<RefCell<Tree>>,
    pub(super) pointer: Rc<Cell<Option<PageOffset>>>,
    pub(super) scrolled: Rc<Cell<Points>>,
}

thread_local! {
    static GEOMETRIES: RefCell<HashMap<u64, LocalGeometry>> = RefCell::default();
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct GeometryHandle {
    thread: ThreadId,
    id: u64,
}

/// Removes the payload on the view's thread, even if its proxy outlives it.
pub(super) struct GeometryLease {
    id: u64,
    _thread: PhantomData<Rc<()>>,
}

const _: fn() = || {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<GeometryHandle>();

    trait AmbiguousIfSend<A> {
        fn check() {}
    }
    impl<T: ?Sized> AmbiguousIfSend<()> for T {}
    impl<T: ?Sized + Send> AmbiguousIfSend<u8> for T {}
    let _ = GeometryLease::check;
};

/// The lease belongs to the view's cleanup, never to the shared session.
pub(super) fn register_geometry(local: LocalGeometry) -> (Arc<dyn ViewGeometry>, GeometryLease) {
    let id = NEXT_ID
        .try_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .expect("RichEditor geometry IDs exhausted");
    // Own cleanup before publishing either the payload or the proxy.
    let lease = GeometryLease {
        id,
        _thread: PhantomData,
    };
    GEOMETRIES.with(|entries| {
        entries.borrow_mut().insert(id, local);
    });
    (
        Arc::new(GeometryHandle {
            thread: thread::current().id(),
            id,
        }),
        lease,
    )
}

/// Stops advertising this view before its payload's destructors query the session.
pub(super) fn retire_geometry(session: &EditorSession, id: SubscriptionId, lease: GeometryLease) {
    session.unsubscribe(id);
    drop(lease);
}

impl Drop for GeometryLease {
    fn drop(&mut self) {
        // A payload's destructor may reenter the registry.
        let removed = GEOMETRIES.try_with(|entries| entries.borrow_mut().remove(&self.id));
        drop(removed);
    }
}

impl GeometryHandle {
    fn with<R>(&self, read: impl FnOnce(&LocalGeometry) -> Option<R>) -> Option<R> {
        if thread::current().id() != self.thread {
            return None;
        }
        let local = GEOMETRIES
            .try_with(|entries| entries.borrow().get(&self.id).cloned())
            .ok()
            .flatten()?;
        read(&local)
    }
}

impl ViewGeometry for GeometryHandle {
    fn page_shift(&self) -> Option<Point<Points>> {
        self.with(|local| {
            let (shift, scroll) = local.pointer.get()?;
            Some(Point::new(
                shift.x,
                shift.y + (local.scrolled.get() - scroll),
            ))
        })
    }

    fn node_rect(&self, pos: usize) -> Option<Bounds<Points>> {
        self.with(|local| {
            let tree = local.tree.borrow();
            let geo = local.geo.borrow();
            let block = tree.children.values().flatten().find(|b| b.pos == pos)?;
            let origin = geo.origin(block.id)?;
            let (_, frame) = geo.frames.get(&block.id)?;
            Some(Bounds::new(origin, frame.size))
        })
    }

    fn coords_at_pos(&self, pos: usize) -> Option<Bounds<Points>> {
        self.with(|local| local.geo.borrow().caret_rect(pos, Affinity::Downstream))
    }

    fn pos_at_coords(&self, point: Point<Points>) -> Option<usize> {
        self.with(|local| match local.geo.borrow().hit(point)? {
            Hit::Text(pos, _) | Hit::Node(pos) => Some(pos),
        })
    }

    fn selection_rect(&self) -> Option<Bounds<Points>> {
        self.with(|local| {
            let (from, to) = {
                let state = local.state.borrow();
                (state.selection().from(), state.selection().to())
            };
            let geo = local.geo.borrow();
            if from == to {
                return geo.caret_rect(from, Affinity::Downstream);
            }
            geo.range_rects(from, to)
                .into_iter()
                .reduce(|a, b| a.union(&b))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::rich_editor::{
        extensions::starter,
        state::{EditorStateConfig, Plugin, PluginSpec, TextSelection},
        view::{EditorSession, NodeViews, geometry::TextGeo},
    };

    fn fixture(x: f32, plugins: Vec<Plugin>) -> LocalGeometry {
        let schema = starter::schema();
        let doc = schema
            .node_from_json(&serde_json::json!({
                "type": "doc",
                "content": [{"type": "paragraph"}, {"type": "paragraph"}]
            }))
            .unwrap();
        let state =
            EditorState::create(EditorStateConfig::new(schema).doc(doc).plugins(plugins)).unwrap();
        let mut tree = Tree::default();
        let mut geo = Geometry::default();
        for (id, pos, y) in [(1, 1, 0.0), (2, 3, 30.0)] {
            tree.children
                .entry(0)
                .or_default()
                .push(super::super::controller::BlockItem {
                    id,
                    node: state.doc().clone(),
                    pos: pos - 1,
                    parent: 0,
                });
            geo.frames.insert(
                id,
                (
                    None,
                    Bounds::new(Point::new(px(x), px(y)), Size::new(px(100.0), px(12.0))),
                ),
            );
            geo.texts.insert(
                id,
                TextGeo {
                    start: pos,
                    frame: Bounds::new(Point::default(), Size::new(px(100.0), px(12.0))),
                    ..TextGeo::default()
                },
            );
        }
        LocalGeometry {
            geo: Rc::new(RefCell::new(geo)),
            state: Rc::new(RefCell::new(state)),
            tree: Rc::new(RefCell::new(tree)),
            pointer: Rc::new(Cell::new(None)),
            scrolled: Rc::new(Cell::new(px(0.0))),
        }
    }

    fn caret(x: f32, y: f32) -> Bounds<Points> {
        Bounds::new(Point::new(px(x), px(y)), Size::new(px(0.0), px(12.0)))
    }

    #[test]
    fn geometry_queries_read_live_owner_values_only() {
        let local = fixture(10.0, vec![]);
        let (proxy, _lease) = register_geometry(local.clone());
        assert_eq!(proxy.coords_at_pos(1), Some(caret(10.0, 0.0)));
        assert_eq!(proxy.pos_at_coords(Point::new(px(10.0), px(1.0))), Some(1));
        assert_eq!(proxy.selection_rect(), Some(caret(10.0, 0.0)));
        assert_eq!(
            proxy.node_rect(0),
            Some(Bounds::new(
                Point::new(px(10.0), px(0.0)),
                Size::new(px(100.0), px(12.0))
            ))
        );
        assert_eq!(proxy.node_rect(99), None);

        local
            .pointer
            .set(Some((Point::new(px(7.0), px(11.0)), px(3.0))));
        local.scrolled.set(px(5.0));
        assert_eq!(proxy.page_shift(), Some(Point::new(px(7.0), px(13.0))));
        let foreign = proxy.clone();
        thread::spawn(move || {
            assert_eq!(foreign.coords_at_pos(1), None);
            assert_eq!(foreign.page_shift(), None);
            assert_eq!(foreign.node_rect(0), None);
            assert_eq!(foreign.pos_at_coords(Point::default()), None);
            assert_eq!(foreign.selection_rect(), None);
        })
        .join()
        .unwrap();

        local
            .geo
            .borrow_mut()
            .frames
            .get_mut(&2)
            .unwrap()
            .1
            .origin
            .x = px(50.0);
        let before = local.state.borrow().clone();
        let mut tr = before.tr();
        tr.set_selection(TextSelection::create(before.doc(), 3, None));
        *local.state.borrow_mut() = before.apply(tr).unwrap();
        assert_eq!(proxy.coords_at_pos(3), Some(caret(50.0, 30.0)));
        assert_eq!(proxy.pos_at_coords(Point::new(px(50.0), px(31.0))), Some(3));
        assert_eq!(proxy.selection_rect(), Some(caret(50.0, 30.0)));
        assert_eq!(
            proxy.node_rect(2),
            Some(Bounds::new(
                Point::new(px(50.0), px(30.0)),
                Size::new(px(100.0), px(12.0))
            ))
        );
    }

    struct DropProbe {
        observed: Arc<Mutex<Vec<(ThreadId, bool)>>>,
        other: Arc<dyn ViewGeometry>,
    }

    impl PluginSpec for DropProbe {}

    impl Drop for DropProbe {
        fn drop(&mut self) {
            // A real geometry query reenters the TLS registry during payload destruction.
            let live = self.other.selection_rect().is_some();
            self.observed
                .lock()
                .unwrap()
                .push((thread::current().id(), live));
        }
    }

    #[test]
    fn foreign_unsubscribe_and_drop_leave_payload_destruction_to_the_owner() {
        let other = fixture(90.0, vec![]);
        let (other_proxy, _other_lease) = register_geometry(other);
        let observed = Arc::new(Mutex::new(Vec::new()));
        let local = fixture(
            10.0,
            vec![Arc::new(DropProbe {
                observed: observed.clone(),
                other: other_proxy,
            })],
        );
        let weak_geo = Rc::downgrade(&local.geo);
        let weak_state = Rc::downgrade(&local.state);
        let session = EditorSession::new(local.state.borrow().clone(), NodeViews::new());
        let (proxy, lease) = register_geometry(local);
        let id = session.attach_geometry(proxy);
        thread::spawn(move || {
            assert_eq!(session.coords_at_pos(1), None);
            session.unsubscribe(id);
            assert_eq!(session.selection_rect(), None);
            drop(session);
        })
        .join()
        .unwrap();

        assert!(weak_geo.upgrade().is_some());
        assert!(weak_state.upgrade().is_some());
        assert!(observed.lock().unwrap().is_empty());
        drop(lease);
        assert!(weak_geo.upgrade().is_none());
        assert!(weak_state.upgrade().is_none());
        assert_eq!(*observed.lock().unwrap(), [(thread::current().id(), true)]);
    }

    #[test]
    fn retired_proxies_do_not_alias_replacements_or_change_view_order() {
        let first = fixture(10.0, vec![]);
        let session = EditorSession::new(first.state.borrow().clone(), NodeViews::new());
        let (first_proxy, first_lease) = register_geometry(first);
        session.attach_geometry(first_proxy.clone());

        let second = fixture(20.0, vec![]);
        let (second_proxy, second_lease) = register_geometry(second);
        let second_id = session.attach_geometry(second_proxy);
        assert_eq!(session.coords_at_pos(1), Some(caret(20.0, 0.0)));
        let foreign = session.clone();
        thread::spawn(move || foreign.unsubscribe(second_id))
            .join()
            .unwrap();
        assert_eq!(session.coords_at_pos(1), Some(caret(10.0, 0.0)));

        drop(first_lease);
        assert_eq!(first_proxy.coords_at_pos(1), None);
        assert_eq!(first_proxy.pos_at_coords(Point::default()), None);
        assert_eq!(first_proxy.selection_rect(), None);
        assert_eq!(session.coords_at_pos(1), None);

        let replacement = fixture(30.0, vec![]);
        let (replacement_proxy, replacement_lease) = register_geometry(replacement);
        session.attach_geometry(replacement_proxy);
        assert_eq!(session.coords_at_pos(1), Some(caret(30.0, 0.0)));
        assert_eq!(first_proxy.coords_at_pos(1), None);
        drop(replacement_lease);
        assert_eq!(session.coords_at_pos(1), None);
        drop(second_lease);
        thread::spawn(move || drop((first_proxy, session)))
            .join()
            .unwrap();
    }

    struct SessionDropProbe {
        session: EditorSession,
        observed: Arc<Mutex<Vec<Option<Bounds<Points>>>>>,
    }

    impl PluginSpec for SessionDropProbe {}

    impl Drop for SessionDropProbe {
        fn drop(&mut self) {
            let rect = self.session.selection_rect();
            self.observed.lock().unwrap().push(rect);
        }
    }

    #[test]
    fn retirement_reveals_the_previous_view_before_payload_destructors_run() {
        let first = fixture(10.0, vec![]);
        let session = EditorSession::new(first.state.borrow().clone(), NodeViews::new());
        let (first_proxy, _first_lease) = register_geometry(first);
        session.attach_geometry(first_proxy);

        let observed = Arc::new(Mutex::new(Vec::new()));
        let second = fixture(
            20.0,
            vec![Arc::new(SessionDropProbe {
                session: session.clone(),
                observed: observed.clone(),
            })],
        );
        let (second_proxy, second_lease) = register_geometry(second);
        let id = session.attach_geometry(second_proxy);
        assert_eq!(session.selection_rect(), Some(caret(20.0, 0.0)));

        retire_geometry(&session, id, second_lease);
        assert_eq!(*observed.lock().unwrap(), [Some(caret(10.0, 0.0))]);
        assert_eq!(session.selection_rect(), Some(caret(10.0, 0.0)));
    }

    #[test]
    fn an_unpublished_lease_cleans_up_on_unwind() {
        let local = fixture(10.0, vec![]);
        let weak_geo = Rc::downgrade(&local.geo);
        let weak_state = Rc::downgrade(&local.state);
        let mut held = None;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let (proxy, _lease) = register_geometry(local);
            held = Some(proxy);
            panic!("exit before registering component cleanup");
        }));
        assert!(result.is_err());
        assert!(weak_geo.upgrade().is_none());
        assert!(weak_state.upgrade().is_none());
        assert_eq!(held.unwrap().coords_at_pos(1), None);
    }
}
