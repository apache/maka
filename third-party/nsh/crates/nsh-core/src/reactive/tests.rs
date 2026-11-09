//! The graph's scheduling on a plain Rust host: numbers as values,
//! closures as computations.

use std::{
    cell::{Cell, RefCell, UnsafeCell},
    rc::Rc,
};

use super::*;

#[derive(Clone, Copy)]
struct Test;

type Func = Rc<dyn Fn(i64) -> Option<i64>>;

thread_local! {
    static GRAPH: UnsafeCell<Graph<Test>> = UnsafeCell::new(Graph::new(TestData::default()));
}

#[derive(Default)]
struct TestData {
    runaway: bool,
}

// SAFETY: one graph per thread; the module's borrows are short.
unsafe impl Host for Test {
    type Value = i64;
    type Func = Func;
    type Equals = fn(i64, i64) -> bool;
    type Cleanup = Box<dyn FnOnce()>;
    type Context = (u32, i64);
    type Data = TestData;

    unsafe fn graph<'a>(self) -> &'a mut Graph<Self> {
        // SAFETY: the thread's graph lives as long as the thread.
        GRAPH.with(|g| unsafe { &mut *g.get() })
    }
    fn empty() -> i64 {
        0
    }
    fn dup(self, v: &i64) -> i64 {
        *v
    }
    fn free(self, _: i64) {}
    fn dup_func(self, f: &Func) -> Func {
        f.clone()
    }
    fn free_func(self, _: Func) {}
    fn dup_equals(self, e: &Self::Equals) -> Self::Equals {
        *e
    }
    fn free_equals(self, _: Self::Equals) {}
    fn call(self, f: &Func, prev: i64) -> Option<i64> {
        f(prev)
    }
    fn same(self, a: &i64, b: &i64) -> bool {
        a == b
    }
    fn truthy(self, v: &i64) -> bool {
        *v != 0
    }
    fn custom_changed(self, e: &Self::Equals, prev: i64, next: &i64) -> bool {
        !e(prev, *next)
    }
    fn run_cleanup(self, f: Box<dyn FnOnce()>) {
        f();
    }
    fn free_cleanup(self, _: Box<dyn FnOnce()>) {}
    fn runaway(self) {
        // SAFETY: a short borrow.
        unsafe { self.graph() }.data.runaway = true;
    }
}

fn graph() -> &'static mut Graph<Test> {
    // SAFETY: tests take short borrows.
    unsafe { Test.graph() }
}

fn signal(v: i64) -> u32 {
    graph().signal(v, Equals::Default)
}

fn get(id: u32) -> i64 {
    read(Test, id)
}

fn set(id: u32, v: i64) {
    write(Test, id, v);
}

fn func(f: impl Fn(i64) -> i64 + 'static) -> Func {
    Rc::new(move |prev| Some(f(prev)))
}

fn computed(f: impl Fn() -> i64 + 'static) -> u32 {
    memo(Test, func(move |_| f()), 0, Equals::Default, false)
}

fn render_effect(f: impl Fn() + 'static) -> u32 {
    effect(
        Test,
        Kind::Effect,
        func(move |_| {
            f();
            0
        }),
        0,
    )
}

fn user_effect(f: impl Fn() + 'static) -> u32 {
    effect(
        Test,
        Kind::UserEffect,
        func(move |_| {
            f();
            0
        }),
        0,
    )
}

#[test]
fn a_diamond_runs_each_memo_once_per_write() {
    let a = signal(1);
    let runs = Rc::new(Cell::new(0));
    let b = computed(move || get(a) + 1);
    let c = computed(move || get(a) * 2);
    let d = {
        let runs = runs.clone();
        computed(move || {
            runs.set(runs.get() + 1);
            get(b) + get(c)
        })
    };
    let seen = Rc::new(RefCell::new(Vec::new()));
    let log = seen.clone();
    render_effect(move || log.borrow_mut().push(get(d)));
    set(a, 2);
    set(a, 3);
    assert_eq!(*seen.borrow(), [4, 7, 10]);
    assert_eq!(runs.get(), 3, "once at first, once per write");
}

#[test]
fn a_batch_runs_effects_once_at_its_end() {
    let a = signal(1);
    let b = signal(1);
    let runs = Rc::new(Cell::new(0));
    let r = runs.clone();
    render_effect(move || {
        get(a);
        get(b);
        r.set(r.get() + 1);
    });
    batch(Test, || {
        set(a, 2);
        set(b, 2);
    });
    assert_eq!(runs.get(), 2);
}

#[test]
fn equal_writes_and_equal_memos_stop_there() {
    let a = signal(1);
    let parity = computed(move || get(a) % 2);
    let runs = Rc::new(Cell::new(0));
    let r = runs.clone();
    render_effect(move || {
        get(parity);
        r.set(r.get() + 1);
    });
    set(a, 1);
    assert_eq!(runs.get(), 1, "an equal write notifies no one");
    set(a, 3);
    assert_eq!(runs.get(), 1, "a memo that stays equal stops the change");
    set(a, 4);
    assert_eq!(runs.get(), 2);
}

#[test]
fn user_effects_run_after_render_effects() {
    let a = signal(0);
    let order = Rc::new(RefCell::new(Vec::new()));
    let o = order.clone();
    user_effect(move || o.borrow_mut().push(("user", get(a))));
    let o = order.clone();
    render_effect(move || o.borrow_mut().push(("render", get(a))));
    order.borrow_mut().clear();
    set(a, 1);
    assert_eq!(*order.borrow(), [("render", 1), ("user", 1)]);
}

#[test]
fn cleanups_run_before_a_rerun_and_on_dispose() {
    let a = signal(0);
    let log = Rc::new(RefCell::new(Vec::new()));
    let l = log.clone();
    let (root, ()) = with_root(Test, || {
        render_effect(move || {
            let v = get(a);
            let l = l.clone();
            let _ = graph().on_cleanup(Box::new(move || l.borrow_mut().push(v)));
        });
    });
    set(a, 1);
    assert_eq!(*log.borrow(), [0]);
    dispose_owner(Test, root);
    assert_eq!(*log.borrow(), [0, 1]);
    set(a, 2);
    assert_eq!(*log.borrow(), [0, 1], "a disposed effect runs no more");
}

#[test]
fn an_owner_disposes_what_it_made_when_it_runs_again() {
    let show = signal(1);
    let inner = signal(0);
    let inner_runs = Rc::new(Cell::new(0));
    let r = inner_runs.clone();
    render_effect(move || {
        if get(show) != 0 {
            let r = r.clone();
            render_effect(move || {
                get(inner);
                r.set(r.get() + 1);
            });
        }
    });
    set(inner, 1);
    assert_eq!(inner_runs.get(), 2);
    set(show, 0);
    set(inner, 2);
    assert_eq!(inner_runs.get(), 2, "the inner effect went with its run");
}

#[test]
fn untracked_reads_make_no_edge() {
    let a = signal(0);
    let runs = Rc::new(Cell::new(0));
    let r = runs.clone();
    render_effect(move || {
        untracked(Test, || get(a));
        r.set(r.get() + 1);
    });
    set(a, 1);
    assert_eq!(runs.get(), 1);
}

#[test]
fn context_passes_to_what_is_made_under_its_owner() {
    let found = Rc::new(Cell::new(None));
    let f = found.clone();
    with_root(Test, || {
        let _ = graph().provide((7, 42));
        let (_, ()) = with_root(Test, || {
            let mut frame = graph().context();
            while let Some(fr) = frame {
                if fr.data.0 == 7 {
                    f.set(Some(fr.data.1));
                    break;
                }
                frame = fr.parent.clone();
            }
        });
    });
    assert_eq!(found.get(), Some(42));
}

#[test]
fn an_effect_that_keeps_writing_what_it_reads_runs_away() {
    let a = signal(0);
    render_effect(move || {
        let v = get(a);
        set(a, v + 1);
    });
    assert!(graph().data.runaway);
}

#[test]
fn rounds_do_not_add_up_to_a_runaway() {
    let a = signal(0);
    render_effect(move || {
        get(a);
    });
    // Each write is a round of its own: together they run the effect more
    // than `MAX_RUNS` times, none of them runs away.
    for v in 1..=MAX_RUNS as i64 + 10 {
        set(a, v);
    }
    assert!(!graph().data.runaway);
}

#[test]
fn handles_free_signals_and_reuse_slots_with_new_generations() {
    let a = signal(5);
    let generation = graph().generation(a);
    if let Some(held) = graph().drop_handle(a) {
        held.free(Test);
    }
    assert!(!graph().live(a, generation, u32::MAX));
    let b = signal(6);
    assert_eq!(b, a, "the slot is reused");
    assert!(graph().live(b, graph().generation(b), u32::MAX));
    assert_ne!(graph().generation(b), generation);
}

/// The graph's links hold: every edge has its back edge, no edge names a
/// freed slot, only computations have sources, and no slot is free twice.
fn check_links() {
    let g = graph();
    for (id, n) in g.nodes.iter().enumerate() {
        if n.kind == Kind::Free {
            continue;
        }
        let id = id as u32;
        assert!(
            n.is_computation() || n.sources.is_empty(),
            "{:?} {id} has sources",
            n.kind
        );
        for (i, &(s, slot)) in n.sources.iter().enumerate() {
            let back = g.nodes[s as usize].observers.get(slot as usize);
            assert_eq!(back, Some(&(id, i as u32)), "{id} reads {s}");
        }
        for (i, &(o, slot)) in n.observers.iter().enumerate() {
            assert_ne!(
                g.nodes[o as usize].kind,
                Kind::Free,
                "{id} is read by freed {o}"
            );
            let back = g.nodes[o as usize].sources.get(slot as usize);
            assert_eq!(back, Some(&(id, i as u32)), "{id} is read by {o}");
        }
    }
    let mut free = g.free.clone();
    free.sort_unstable();
    free.dedup();
    assert_eq!(free.len(), g.free.len(), "a slot freed twice: {:?}", g.free);
}

#[test]
fn a_computation_disposed_while_it_runs_is_left_with_no_edges() {
    let show = signal(1);
    let (a, b, c) = (signal(0), signal(0), signal(0));
    // Another reader of `c`, before the effect below in its list.
    render_effect(move || {
        get(c);
    });
    with_root(Test, || {
        computed(move || {
            if get(show) != 0 {
                render_effect(move || {
                    let _ = graph().on_cleanup(Box::new(move || {
                        get(a);
                        get(b);
                        get(c);
                    }));
                    // Closes the branch it runs in: it is disposed, its
                    // cleanup reads while it is still the listener.
                    set(show, 0);
                });
            }
            0
        });
    });
    // Its slot is reused, and the first effect leaves `c`'s readers.
    signal(0);
    set(c, 1);
    check_links();
}

#[test]
fn a_memo_read_while_it_is_disposed_does_not_run_again() {
    let s = signal(0);
    let other = signal(0);
    let runs = Rc::new(Cell::new(0));
    let r = runs.clone();
    with_root(Test, || {
        computed(move || {
            get(s);
            let me = Rc::new(Cell::new(NONE));
            let m = me.clone();
            let r = r.clone();
            let inner = memo(
                Test,
                func(move |_| {
                    r.set(r.get() + 1);
                    get(s);
                    get(other);
                    let m = m.clone();
                    render_effect(move || {
                        let m = m.clone();
                        // Reads the memo that owns it when it goes.
                        let _ = graph().on_cleanup(Box::new(move || {
                            get(m.get());
                        }));
                    });
                    0
                }),
                0,
                Equals::Default,
                false,
            );
            me.set(inner);
            0
        });
    });
    // The outer memo runs first and disposes the stale inner one.
    set(s, 1);
    assert_eq!(runs.get(), 2, "once at first, once made again");
    check_links();
}

#[test]
fn an_owner_disposed_again_by_its_cleanups_is_freed_once() {
    let close = signal(0);
    let root = Rc::new(Cell::new(NONE));
    let r = root.clone();
    render_effect(move || {
        if get(close) != 0 {
            dispose_owner(Test, r.get());
        }
    });
    let (id, ()) = with_root(Test, || {
        render_effect(move || {
            let _ = graph().on_cleanup(Box::new(move || set(close, 1)));
        });
    });
    root.set(id);
    // Outside a round: the cleanup's write runs the effect above at once.
    dispose_owner(Test, id);
    check_links();
}

#[test]
fn a_memo_whose_handle_goes_while_it_is_disposed_is_freed_once() {
    let a = signal(0);
    let me = Rc::new(Cell::new(NONE));
    let m = me.clone();
    let (root, ()) = with_root(Test, || {
        let id = memo(
            Test,
            func(move |_| {
                get(a);
                let m = m.clone();
                // A JS memo's object is finalized when a cleanup frees the
                // last reference to it.
                let _ = graph().on_cleanup(Box::new(move || {
                    if let Some(held) = graph().drop_handle(m.get()) {
                        held.free(Test);
                    }
                }));
                0
            }),
            0,
            Equals::Default,
            true,
        );
        me.set(id);
    });
    dispose_owner(Test, root);
    check_links();
}

#[test]
fn a_computation_disposed_in_a_nested_run_tracks_nothing_after() {
    let items = signal(1);
    let other = signal(0);
    let row = Rc::new(Cell::new(NONE));
    with_root(Test, || {
        // A list's memo: a row (a root) for its item, the last row goes.
        computed(move || {
            let n = get(items);
            dispose_owner(Test, row.get());
            // The row's item and index signals.
            signal(n);
            signal(0);
            let row = row.clone();
            with_root(Test, || {
                row.set(graph().owner());
                if n == 1 {
                    render_effect(move || {
                        // The list runs again in this write and disposes
                        // the row; the effect is the listener again after,
                        // and its slot holds the new row's index signal.
                        set(items, 2);
                        get(other);
                    });
                }
            });
            0
        });
    });
    check_links();
}

#[test]
fn compacting_gives_back_the_slots_of_a_tree_that_is_gone() {
    let kept = signal(1);
    let many: Vec<u32> = (0..5000).map(signal).collect();
    let last = *many.last().unwrap();
    let last_generation = graph().generation(last);
    // One in the middle stays: the slots after it go, those before stay free.
    let middle = many[100];
    for &id in &many {
        if id != middle
            && let Some(held) = graph().drop_handle(id)
        {
            held.free(Test);
        }
    }
    graph().compact();
    assert_eq!(graph().slots(), (2, middle as usize + 1));
    assert_eq!(get(kept), 1);
    assert_eq!(get(middle), 100);
    // A handle of a dropped slot never names the node made in its place.
    assert!(!graph().live(last, last_generation, u32::MAX));
    // Freed slots are reused lowest first.
    let next = signal(7);
    assert!(next < middle);
    if let Some(held) = graph().drop_handle(middle) {
        held.free(Test);
    }
    graph().compact();
    let mut made: Vec<u32> = (0..(last as i64 + 1)).map(signal).collect();
    made.sort_unstable();
    let again = made.iter().copied().find(|&id| id == last).unwrap();
    assert_ne!(graph().generation(again), last_generation);
    assert!(!graph().live(last, last_generation, u32::MAX));
    check_links();
}
