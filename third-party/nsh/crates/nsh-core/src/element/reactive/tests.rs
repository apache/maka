//! Signals, memos, effects and owners on a Rust runtime.

use std::{cell::RefCell, rc::Rc};

use super::*;

/// Makes what `setup` makes in a root of a fresh runtime (its effects run
/// once the root is made, as in Solid), then runs `check` on it.
fn run<T>(setup: impl FnOnce() -> T, check: impl FnOnce(T)) {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let (owner, made) = create_root(setup);
    check(made);
    owner.dispose();
}

#[test]
fn signals_drive_memos_and_effects() {
    let seen = Rc::new(RefCell::new(Vec::new()));
    let log = seen.clone();
    run(
        move || {
            let count = signal(1);
            let doubled = computed(move || count.get() * 2);
            effect(move || log.borrow_mut().push(doubled.get()));
            (count, doubled)
        },
        |(count, doubled)| {
            count.set(2);
            count.set(2);
            count.update(|n| *n += 1);
            assert_eq!(*seen.borrow(), [2, 4, 6]);
            assert_eq!(doubled.get_untracked(), 6);
        },
    );
}

#[test]
fn signals_without_equality_notify_every_write() {
    let runs = Rc::new(RefCell::new(0));
    let r = runs.clone();
    run(
        move || {
            let ticks = signal_with(Vec::<u8>::new(), SignalEquals::Never);
            effect(move || {
                ticks.with(|_| ());
                *r.borrow_mut() += 1;
            });
            ticks
        },
        |ticks| {
            ticks.set(Vec::new());
            assert_eq!(*runs.borrow(), 2);
        },
    );
}

#[test]
fn what_an_owner_made_goes_with_it() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let cleaned = Rc::new(RefCell::new(false));
    let c = cleaned.clone();
    let (owner, count) = create_root(move || {
        let count = signal(0);
        cleanup(move || *c.borrow_mut() = true);
        count
    });
    assert_eq!(count.try_get(), Some(0));
    owner.dispose();
    assert!(*cleaned.borrow());
    assert_eq!(count.try_get(), None, "the signal went with its owner");
    assert!(!count.try_set(1));
}

#[test]
fn a_stored_value_of_a_disposed_owner_is_skipped_by_try_with() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let (owner, list) = create_root(|| stored(vec![1, 2]));
    assert_eq!(list.try_with(|l| l.len()), Some(2));
    owner.dispose();
    assert_eq!(list.try_with(|l| l.len()), None, "it went with its owner");
}

#[test]
#[should_panic(expected = "after its owner was disposed")]
fn reading_a_disposed_signal_panics() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let (owner, count) = create_root(|| signal(0));
    owner.dispose();
    count.get();
}

#[test]
fn context_reaches_what_is_made_below() {
    #[derive(Clone, PartialEq, Debug)]
    struct Accent(&'static str);
    run(
        || {
            provide_context(Accent("blue"));
            let (_, found) = create_root(use_context::<Accent>);
            (found, use_context::<u32>())
        },
        |(found, missing)| {
            assert_eq!(found, Some(Accent("blue")));
            assert_eq!(missing, None);
        },
    );
}

#[test]
fn a_panicking_effect_is_reported_with_its_owner() {
    let runtime = Runtime::default();
    let (owner, ()) = {
        let _entered = runtime.enter();
        create_root(|| effect(|| panic!("boom")))
    };
    let failures = runtime.take_failures();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0].1, "boom");
    assert_ne!(failures[0].0, owner, "the effect's own node ran it");
}

#[test]
fn batches_and_untracked_reads() {
    let runs = Rc::new(RefCell::new(0));
    let r = runs.clone();
    run(
        move || {
            let a = signal(0);
            let b = signal(0);
            effect(move || {
                a.get();
                untracked(|| b.get());
                *r.borrow_mut() += 1;
            });
            (a, b)
        },
        |(a, b)| {
            batch(|| {
                a.set(1);
                a.set(2);
            });
            b.set(5);
            assert_eq!(*runs.borrow(), 2);
        },
    );
}

#[test]
fn what_is_made_under_an_owner_disposed_while_it_runs_goes_at_once() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let before = runtime.slots_in_use();
    let (owner, ()) = create_root(|| {
        let _ = signal(0);
    });
    let cleaned = Rc::new(RefCell::new(false));
    let runs = Rc::new(RefCell::new(0));
    let (c, r) = (cleaned.clone(), runs.clone());
    let (made, root) = owner.scope(move || {
        // A listener closing the view it belongs to, then going on.
        owner.dispose();
        let made = signal(1);
        effect(move || *r.borrow_mut() += 1);
        cleanup(move || *c.borrow_mut() = true);
        let (root, inner) = create_root(|| signal(2));
        (made, (root, inner))
    });
    assert_eq!(made.try_get(), None, "disposed at once");
    assert_eq!(root.1.try_get(), None, "a root made there too");
    assert!(!root.0.is_live());
    assert_eq!(*runs.borrow(), 0, "the effect never runs");
    assert!(*cleaned.borrow(), "a cleanup runs at once");
    assert_eq!(runtime.slots_in_use(), before, "nothing stays");
}

#[test]
fn an_owner_disposed_in_a_nested_run_is_not_current_again() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let before = runtime.slots_in_use();
    let (outer, ()) = create_root(|| ());
    let (inner, ()) = outer.run(|| create_root(|| ()));
    let made = outer.scope(|| {
        inner.scope(|| outer.dispose());
        // Back under `outer`, gone meanwhile.
        signal(1)
    });
    assert_eq!(made.try_get(), None);
    inner.dispose();
    assert_eq!(runtime.slots_in_use(), before);
}

#[test]
fn a_listener_of_a_disposed_owner_does_not_run() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let runs = Rc::new(RefCell::new(0));
    let r = runs.clone();
    let (owner, listener) = create_root(move || {
        crate::element::Listener::<()>::from(move |_: &()| *r.borrow_mut() += 1)
    });
    listener.call(&());
    assert_eq!(*runs.borrow(), 1);
    owner.dispose();
    listener.call(&());
    assert_eq!(*runs.borrow(), 1, "its view is gone");
}

#[test]
fn a_stored_value_reads_without_subscribing() {
    let runs = Rc::new(RefCell::new(0));
    let r = runs.clone();
    run(
        move || {
            let cache = stored(1);
            effect(move || {
                let _ = cache.get();
                *r.borrow_mut() += 1;
            });
            cache
        },
        |cache| {
            assert_eq!(cache.get(), 1);
            cache.replace(2);
            assert_eq!(cache.get(), 2);
            assert_eq!(*runs.borrow(), 1, "nothing subscribed to it");
        },
    );
}

/// A computation reads a memo that is to run again, and the memo's run
/// lets the owner both are in go (as a list's rows memo lets a cell's
/// content go), then nodes are made elsewhere and take the freed slots:
/// the read gives the memo's last value, never a new node's, and neither
/// run writes its result into a node made in its slot.
#[test]
fn a_memo_disposed_while_a_read_brings_it_up_to_date_gives_its_last_value() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let (outer, (a, b)) = create_root(|| (signal(0), signal(0)));
    let cell: Rc<std::cell::Cell<Option<Owner>>> = Rc::default();
    let made: Rc<RefCell<Vec<Signal<i32>>>> = Rc::default();
    let read = Rc::new(RefCell::new(Vec::new()));
    let (c, m, r) = (cell.clone(), made.clone(), read.clone());
    let (owner, ()) = create_root(move || {
        let memo: Rc<std::cell::Cell<Option<Memo<i32>>>> = Rc::default();
        let slot = memo.clone();
        // Runs first when `a` and `b` change together, and reads the memo
        // before it ran.
        let _reader = computed(move || {
            a.get();
            if let Some(memo) = slot.get() {
                r.borrow_mut().push(memo.get());
            }
        });
        memo.set(Some(computed(move || {
            let n = b.get();
            if n == 1 {
                c.get().expect("the cell").dispose();
                m.borrow_mut()
                    .extend(outer.run(|| (0..8).map(|_| signal(-1)).collect::<Vec<_>>()));
            }
            n * 10
        })));
    });
    cell.set(Some(owner));
    batch(|| {
        a.set(1);
        b.set(1);
    });
    assert_eq!(*read.borrow(), [0]);
    let values: Vec<i32> = made.borrow().iter().map(|s| s.get()).collect();
    assert_eq!(values, [-1; 8]);
    outer.dispose();
}

/// As above, with computations taking the freed slots: once the read
/// returns, what the reader reads goes to no one, never to a computation
/// made in its slot, which would then run again for a source it never
/// read.
#[test]
fn a_reader_let_go_by_the_memo_it_reads_tracks_into_no_new_computation() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let (outer, (a, b, x)) = create_root(|| (signal(0), signal(0), signal(0)));
    let cell: Rc<std::cell::Cell<Option<Owner>>> = Rc::default();
    let runs: Rc<RefCell<Vec<u32>>> = Rc::default();
    let made: Rc<RefCell<Vec<Memo<()>>>> = Rc::default();
    let (c, r, m) = (cell.clone(), runs.clone(), made.clone());
    let (owner, ()) = create_root(move || {
        let memo: Rc<std::cell::Cell<Option<Memo<i32>>>> = Rc::default();
        let slot = memo.clone();
        // Runs first when `a` and `b` change together, reads the memo
        // before it ran, then `x`.
        let _reader = computed(move || {
            a.get();
            if let Some(memo) = slot.get() {
                memo.get();
                x.get();
            }
        });
        memo.set(Some(computed(move || {
            let n = b.get();
            if n == 1 {
                c.get().expect("the cell").dispose();
                let (r, m) = (r.clone(), m.clone());
                outer.run(move || {
                    for i in 0..8 {
                        r.borrow_mut().push(0);
                        let r = r.clone();
                        m.borrow_mut()
                            .push(computed(move || r.borrow_mut()[i] += 1));
                    }
                });
            }
            n * 10
        })));
    });
    cell.set(Some(owner));
    batch(|| {
        a.set(1);
        b.set(1);
    });
    assert_eq!(*runs.borrow(), [1; 8]);
    x.set(1);
    for memo in made.borrow().iter() {
        memo.get();
    }
    assert_eq!(*runs.borrow(), [1; 8]);
    outer.dispose();
}

/// A computation's cleanup lets the computation go, and nodes made after
/// take its slot: cleaning it stops there, and runs no cleanup of theirs.
#[test]
fn a_computation_let_go_by_its_cleanup_leaves_the_nodes_in_its_slot_alone() {
    let runtime = Runtime::default();
    let _entered = runtime.enter();
    let (outer, a) = create_root(|| signal(0));
    let cell: Rc<std::cell::Cell<Option<Owner>>> = Rc::default();
    let cleaned: Rc<RefCell<Vec<u32>>> = Rc::default();
    let (c, k) = (cell.clone(), cleaned.clone());
    let (owner, ()) = create_root(move || {
        let _cleaning = computed(move || {
            a.get();
            let (c, k) = (c.clone(), k.clone());
            cleanup(move || {
                c.get().expect("the cell").dispose();
                outer.run(move || {
                    for i in 0..8 {
                        k.borrow_mut().push(0);
                        let k = k.clone();
                        computed(move || {
                            let k = k.clone();
                            cleanup(move || k.borrow_mut()[i] += 1);
                        });
                    }
                });
            });
        });
    });
    cell.set(Some(owner));
    a.set(1);
    assert_eq!(*cleaned.borrow(), [0; 8]);
    outer.dispose();
    assert_eq!(*cleaned.borrow(), [1; 8]);
}
