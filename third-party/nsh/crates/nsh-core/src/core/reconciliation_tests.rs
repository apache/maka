//! Regression probes for batched reconciliation cleanup.
//! Counts protect the algorithm independently of machine speed/profile.

use std::{
    cell::RefCell,
    rc::{Rc, Weak},
    time::Instant,
};

use super::*;
use crate::{
    element::{Root, Scope},
    prelude::*,
};

#[derive(Clone, Copy)]
struct Controls {
    rows: Signal<Vec<u32>>,
    detail: Signal<bool>,
}

thread_local! {
    static COUNT: Cell<u32> = const { Cell::new(0) };
    static CONTROLS: Cell<Option<Controls>> = const { Cell::new(None) };
    static DROPPED: Cell<u32> = const { Cell::new(0) };
    static HITS: Cell<u32> = const { Cell::new(0) };
    static LIFETIMES: RefCell<Vec<Weak<()>>> = const { RefCell::new(Vec::new()) };
}

#[derive(Event)]
enum PulseEvent {
    Fired,
}

#[component]
fn Pulse(cx: Scope<PulseEvent>) -> impl IntoElement {
    text("pulse").on_press(move || cx.emit(PulseEvent::Fired))
}

#[component]
fn Regions() -> impl IntoElement {
    let rows = signal((0..COUNT.with(Cell::get)).collect::<Vec<_>>());
    let detail = signal(true);
    CONTROLS.with(|saved| saved.set(Some(Controls { rows, detail })));
    view().child(each(
        rows,
        |row| *row,
        move |row, _| {
            let key = row.get_untracked();
            let draft = signal(format!("row {key}"));
            let lifetime = Rc::new(());
            LIFETIMES.with(|saved| saved.borrow_mut().push(Rc::downgrade(&lifetime)));
            cleanup(|| DROPPED.with(|count| count.set(count.get() + 1)));
            let press = lifetime.clone();
            let responder = lifetime.clone();
            view()
                .on_press(move || {
                    let _keep = &press;
                    HITS.with(|hits| hits.set(hits.get() + 1));
                })
                .on_responder_grant(move |_: &ResponderEvent| {
                    let _keep = &responder;
                })
                .child(text(move || format!("draft {key}: {}", draft.get())))
                .child(when(detail, move || {
                    let changed = lifetime.clone();
                    let event = lifetime.clone();
                    view()
                        .child(
                            input()
                                .test_id(&format!("field-{key}"))
                                .value(move || draft.get())
                                .on_change(move |value: &str| {
                                    let _keep = &changed;
                                    draft.set(value.to_owned());
                                }),
                        )
                        .child(pulse().0.on_event(move |_: &PulseEvent| {
                            let _keep = &event;
                            HITS.with(|hits| hits.set(hits.get() + 1));
                        }))
                }))
        },
    ))
}

fn mount(count: u32) -> (Core<FakeEngine>, NodeId, MountBatch) {
    COUNT.with(|saved| saved.set(count));
    DROPPED.with(|saved| saved.set(0));
    HITS.with(|saved| saved.set(0));
    LIFETIMES.with(|saved| saved.borrow_mut().clear());
    let mut c = core();
    c.mount_root(&Root::of::<Regions>());
    let batch = c.commit().unwrap();
    let host = super::views::root_host(&batch);
    (c, host, batch)
}

fn field(c: &Core<FakeEngine>, row: u32) -> NodeId {
    let test_id = format!("field-{row}");
    named(c, &test_id)
}

fn named(c: &Core<FakeEngine>, test_id: &str) -> NodeId {
    c.nodes
        .iter()
        .find(|(_, node)| {
            node.props
                .as_ref()
                .is_some_and(|props| props.test_id.as_deref() == Some(test_id))
        })
        .map(|(_, node)| node.id)
        .expect("the row's input")
}

fn change(c: &mut Core<FakeEngine>, update: impl FnOnce(Controls)) {
    let controls = CONTROLS.with(Cell::get).unwrap();
    {
        let _entered = c.components.runtime.enter();
        update(controls);
    }
}

fn resources(c: &Core<FakeEngine>) -> [usize; 6] {
    let mut counts = [
        c.components.owners.len(),
        c.components.regions.len(),
        0,
        0,
        0,
        0,
    ];
    for inst in c.components.instances.values() {
        counts[2] += inst.handlers.len();
        counts[3] += inst.event_handlers.len();
        counts[4] += inst.responders.len();
        counts[5] += inst.bound.len();
    }
    counts
}

#[test]
fn initial_regions_and_retained_keyed_rows_do_not_scan_host_bindings() {
    for count in [50, 100, 200, 400, 800] {
        let start = Instant::now();
        let (mut c, host, _) = mount(count);
        let work = c.components.cleanup_work;
        assert!(
            work.regions >= count as usize,
            "the fixture expands a region per row: {work:?}"
        );
        assert_eq!(
            (work.scans, work.entries),
            (0, 0),
            "initial population never releases a node: {work:?}"
        );
        assert!(
            resources(&c)[5] >= count as usize * 2,
            "the host has real bound inputs and texts"
        );
        eprintln!(
            "reconciliation initial rows={count} elapsed_us={} regions={} scans={} entries={} resources={:?}",
            start.elapsed().as_micros(),
            work.regions,
            work.scans,
            work.entries,
            resources(&c)
        );

        // Report a native edit and focus, then reorder retained rows. No
        // input is recreated or reset; subsequent events use its bindings.
        let input = field(&c, 0);
        c.set_states(input, crate::tailwind::state::FOCUSED);
        c.input_changed(input, "typed", 1);
        assert!(c.component_event(
            input,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "typed".into(),
                count: 1
            }
        ));
        c.commit();
        change(&mut c, |controls| {
            controls.rows.update(|rows| rows.reverse())
        });
        let batch = c.commit().unwrap();
        assert_eq!(field(&c, 0), input);
        assert_eq!(c.focus.map(|(_, id)| id), Some(input));
        assert!(!batch.items.iter().any(|item| matches!(item,
            MountItem::Create { id, .. } | MountItem::Delete { id } | MountItem::InputValue { id, .. } if *id == input)));
        assert_eq!(
            (
                c.components.cleanup_work.scans,
                c.components.cleanup_work.entries
            ),
            (0, 0)
        );
        c.input_changed(input, "latest", 2);
        assert!(c.component_event(
            input,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "latest".into(),
                count: 2
            }
        ));
        let batch = c.commit().unwrap();
        assert!(
            super::views::texts(&batch).contains(&"draft 0: latest".to_owned()),
            "a retained field still updates its own row after reordering"
        );

        // A genuine removal must still clean every kind of host record.
        let removed = field(&c, count - 1);
        let before = resources(&c);
        change(&mut c, |controls| {
            controls
                .rows
                .update(|rows| rows.retain(|row| *row < count / 2))
        });
        c.commit();
        let after = resources(&c);
        assert!(c.components.cleanup_work.scans > 0);
        assert!(
            after
                .iter()
                .zip(before)
                .all(|(after, before)| *after < before),
            "released records leave each collection: before={before:?}, after={after:?}"
        );
        assert!(c.key(removed).is_err());
        let hits = HITS.with(Cell::get);
        assert!(!c.component_event(removed, EventKind::Press, &EventPayload::None));
        assert!(!c.component_event(
            removed,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "stale".into(),
                count: 2
            }
        ));
        assert_eq!(HITS.with(Cell::get), hits);
        assert_eq!(DROPPED.with(Cell::get), count - count / 2);

        c.apply(Op::Remove {
            parent: ROOT_ID,
            child: host,
        })
        .unwrap();
        c.apply(Op::Release { id: host }).unwrap();
        c.commit();
        assert_eq!(resources(&c), [0; 6], "unmount releases host records");
        assert!(c.components.instances.is_empty());
        assert!(
            LIFETIMES.with(|saved| saved.borrow().iter().all(|life| life.upgrade().is_none())),
            "no stale handler, responder or component listener retains a row"
        );
        assert_eq!(DROPPED.with(Cell::get), count);
    }
}

#[test]
fn removing_and_replacing_nested_regions_keeps_resource_counts_at_a_plateau() {
    let (mut c, _, _) = mount(80);
    let full = resources(&c);
    let mut empty = None;
    for _ in 0..8 {
        let old_input = field(&c, 0);
        change(&mut c, |controls| controls.detail.set(false));
        c.commit();
        let counts = resources(&c);
        assert!(counts[2] < full[2] && counts[3] < full[3] && counts[5] < full[5]);
        assert_eq!(
            *empty.get_or_insert(counts),
            counts,
            "hidden-region records reach a plateau"
        );
        assert!(c.key(old_input).is_err());
        assert!(!c.component_event(
            old_input,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "stale".into(),
                count: 1
            }
        ));
        change(&mut c, |controls| controls.detail.set(true));
        c.commit();
        assert_eq!(
            resources(&c),
            full,
            "reopening retains no old bindings/listeners"
        );
        assert_ne!(field(&c, 0), old_input);
    }
}

#[test]
fn simultaneous_region_removals_scan_each_host_once_and_scale_linearly() {
    let mut measured = Vec::new();
    for count in [200, 400] {
        let (mut c, _, _) = mount(count);
        let before = c.components.cleanup_work;
        change(&mut c, |controls| controls.detail.set(false));
        c.commit();
        let after = c.components.cleanup_work;
        let scans = after.scans - before.scans;
        let entries = after.entries - before.entries;
        assert!(after.regions - before.regions >= count as usize);
        assert_eq!(scans, 1, "all removing regions belong to one host");
        assert!(
            entries >= count as usize,
            "the cleanup scanned real bindings/listeners"
        );
        eprintln!(
            "reconciliation remove rows={count} regions={} scans={scans} entries={entries}",
            after.regions - before.regions
        );
        measured.push(entries);
    }
    assert!(
        measured[1] * 2 <= measured[0] * 5,
        "doubling rows stays within 2.5x cleanup work: {measured:?}"
    );
}

#[test]
fn an_event_looks_only_at_its_nodes_handlers() {
    // Every row has handlers on its nodes, all in the one host's view: an
    // event on one row's input finds that input's handlers without going
    // through the other rows' (a layout event per block of a long rich
    // text document went through every block's).
    let mut visits = Vec::new();
    for count in [50, 200, 800] {
        let (mut c, _, _) = mount(count);
        assert!(
            resources(&c)[2] >= count as usize * 2,
            "the rows' handlers are in the view"
        );
        let input = field(&c, count / 2);
        let before = c.components.handler_visits.get();
        assert!(c.component_event(
            input,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "typed".into(),
                count: 1
            }
        ));
        visits.push(c.components.handler_visits.get() - before);
    }
    assert!(visits[0] > 0, "the input's own handlers are looked at");
    assert!(
        visits.iter().all(|v| *v == visits[0]),
        "the same work whatever the number of rows: {visits:?}"
    );
}

thread_local! {
    static SLOT_SHOWN: Cell<Option<Signal<bool>>> = const { Cell::new(None) };
    static SLOT_PLACED: Cell<Option<Signal<bool>>> = const { Cell::new(None) };
    static SLOT_SWAP: Cell<Option<Signal<bool>>> = const { Cell::new(None) };
}

#[derive(Clone, PartialEq, Props)]
struct SlottedProps {
    body: crate::element::Prop<Option<Slot>>,
}

#[component]
fn Slotted(props: SlottedProps) -> impl IntoElement {
    let shown = signal(false);
    let placed = signal(true);
    SLOT_SHOWN.with(|saved| saved.set(Some(shown)));
    SLOT_PLACED.with(|saved| saved.set(Some(placed)));
    view()
        .child(when(placed, move || {
            props.body.place(|slot| {
                slot.w(move || px(120.0))
                    .on_press(|| HITS.with(|hits| hits.set(hits.get() + 1)))
            })
        }))
        .child(when(shown, || text(move || "temporary")))
}

#[component]
fn SlotRoot() -> impl IntoElement {
    let swap = signal(false);
    let draft = signal(String::new());
    SLOT_SWAP.with(|saved| saved.set(Some(swap)));
    view().child(slotted().0.fill(
        "body",
        dynamic(move || {
            input()
                .key(if swap.get() { "new" } else { "old" })
                .test_id("slotted-input")
                .value(move || draft.get())
                .on_change(move |value: &str| draft.set(value.to_owned()))
        }),
    ))
}

#[test]
fn cleanup_keeps_slots_and_adopted_bindings_and_retires_replaced_targets() {
    HITS.with(|hits| hits.set(0));
    let mut c = core();
    c.mount_root(&Root::of::<SlotRoot>());
    c.commit().unwrap();
    let old = named(&c, "slotted-input");
    let adopted_host = c
        .adopted_host(old)
        .expect("slot's handlers target its app element");
    let shown = SLOT_SHOWN.with(Cell::get).unwrap();
    for value in [true, false, true, false] {
        {
            let _entered = c.components.runtime.enter();
            shown.set(value);
        }
        c.commit();
        assert_eq!(named(&c, "slotted-input"), old);
        assert_eq!(c.adopted_host(old), Some(adopted_host));
        assert!(c.component_event(old, EventKind::Press, &EventPayload::None));
    }
    assert_eq!(
        HITS.with(Cell::get),
        4,
        "slot handlers survive removing neighboring regions"
    );
    assert!(c.components.cleanup_work.scans > 0);
    c.input_changed(old, "kept", 1);
    assert!(c.component_event(
        old,
        EventKind::ChangeText,
        &EventPayload::Text {
            text: "kept".into(),
            count: 1
        }
    ));
    c.commit();
    let swap = SLOT_SWAP.with(Cell::get).unwrap();
    {
        let _entered = c.components.runtime.enter();
        swap.set(true);
    }
    c.commit();
    let new = named(&c, "slotted-input");
    assert_ne!(old, new);
    assert!(c.key(old).is_err());
    assert_eq!(c.adopted_host(new), Some(adopted_host));
    assert!(!c.component_event(old, EventKind::Press, &EventPayload::None));
    assert!(c.component_event(new, EventKind::Press, &EventPayload::None));
    assert_eq!(
        HITS.with(Cell::get),
        5,
        "only the current target hears the slot's handler"
    );
    // Removing Part::Slot leaves its app-owned native input alive. The
    // release generation must still trigger cleanup and restore correctly.
    let placed = SLOT_PLACED.with(Cell::get).unwrap();
    let before = c.components.cleanup_work.scans;
    for _ in 0..4 {
        {
            let _entered = c.components.runtime.enter();
            placed.set(false);
        }
        c.commit();
        assert!(
            c.key(new).is_ok(),
            "unplacing a slot does not delete the app's input"
        );
        assert_eq!(c.adopted_host(new), None);
        let hits = HITS.with(Cell::get);
        c.component_event(new, EventKind::Press, &EventPayload::None);
        assert_eq!(
            HITS.with(Cell::get),
            hits,
            "an unplaced slot's handler no longer receives input events"
        );
        {
            let _entered = c.components.runtime.enter();
            placed.set(true);
        }
        c.commit();
        assert_eq!(named(&c, "slotted-input"), new);
        assert_eq!(c.adopted_host(new), Some(adopted_host));
        assert!(c.component_event(new, EventKind::Press, &EventPayload::None));
        assert_eq!(HITS.with(Cell::get), hits + 1);
    }
    assert!(c.components.cleanup_work.scans > before);
    assert!(
        c.components.released_hosts.is_empty(),
        "no cleanup escapes the patch boundary"
    );
}

thread_local! {
    static NATIVE_COUNT: Cell<Option<Signal<usize>>> = const { Cell::new(None) };
}

#[component]
fn RecycledRegions() -> impl IntoElement {
    let count = signal(3_usize);
    NATIVE_COUNT.with(|saved| saved.set(Some(count)));
    virtual_list(
        move || count.get(),
        |at| {
            let row = at.index();
            let draft = signal(format!("native {row}"));
            view()
                .h(px(80.0))
                // Static bound children are released by expand_root when the
                // cell renders empty; they are outside the nested region.
                .child(text(move || draft.get()))
                .child(
                    input()
                        .test_id(&format!("cell-input-{row}"))
                        .value(move || draft.get())
                        .on_change(move |value: &str| draft.set(value.to_owned())),
                )
                .child(when(|| true, move || text(move || draft.get())))
        },
    )
    .estimated_item_size(px(80.0))
    .size_full()
}

#[test]
fn shrinking_and_reexpanding_native_cells_releases_static_child_bindings() {
    let mut c = core();
    c.mount_root(&Root::of::<RecycledRegions>());
    c.commit().unwrap();
    let full = resources(&c);
    let count = NATIVE_COUNT.with(Cell::get).unwrap();
    let mut empty = None;
    for _ in 0..12 {
        let old_input = named(&c, "cell-input-0");
        {
            let _entered = c.components.runtime.enter();
            count.set(0);
        }
        c.commit();
        let counts = resources(&c);
        assert_eq!(
            *empty.get_or_insert(counts),
            counts,
            "blank native cells retain a stable set of records"
        );
        for (&host, inst) in &c.components.instances {
            assert!(
                inst.bound
                    .keys()
                    .all(|id| *id == host || c.key(*id).is_ok()),
                "a cell must forget static bindings whose nodes were released"
            );
        }
        assert!(c.key(old_input).is_err());
        assert!(!c.component_event(
            old_input,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "stale".into(),
                count: 1
            }
        ));
        {
            let _entered = c.components.runtime.enter();
            count.set(3);
        }
        c.commit();
        assert_eq!(
            resources(&c),
            full,
            "rebound native cells retain no earlier row's bindings"
        );
        let input = named(&c, "cell-input-0");
        assert_ne!(input, old_input);
        c.input_changed(input, "current", 1);
        assert!(c.component_event(
            input,
            EventKind::ChangeText,
            &EventPayload::Text {
                text: "current".into(),
                count: 1
            }
        ));
        let batch = c.commit().unwrap();
        assert!(
            super::views::texts(&batch)
                .iter()
                .any(|text| text == "current")
        );
        assert!(c.components.released_hosts.is_empty());
    }
}
