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
