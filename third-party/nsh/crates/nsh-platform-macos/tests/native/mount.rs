//! Mounting children into real `AppView`s: the order of the app's views
//! among themselves and below AppKit views a parent holds that are not
//! NSH's own (hosted natives, or views a host app adds itself), read from
//! the native `NSView` hierarchy, in parents of each kind (a plain view, a
//! container of a view that clips its children and casts a shadow, a view
//! over a backdrop blur, a scroll view's container).
//!
//! Appends skip scanning a parent's subviews for such views while none can
//! have come in (`view.rs`, `first_foreign`), so the checks change the
//! parents' subviews in every way a host can after an append left them
//! known to hold only NSH's views: `addSubview:`, a positioned
//! `addSubview:positioned:relativeTo:`, `setSubviews:`,
//! `replaceSubview:with:`, moving a view from one parent to another, and a
//! view of the host's tagged as NSH's backdrop whose tag it then changes.
//! Each time an appended row must go where scanning would put it: right
//! below the lowest view that is not NSH's. NSH's own reorders, removals
//! and registered native components (made, removed, made again) are
//! checked too.
//!
//! A subtree deleted in one batch leaves the window with its root alone:
//! its views stay in the root, out of the window (`deleted_subtree`).
//!
//! The benchmark (`bench`) mounts 100, 1 000 and 8 600 rows that are not
//! virtualized (wall time, process and main thread CPU). It is the
//! workload of the former `tests/mount.rs`, unchanged, so that runs before
//! and after a change compare: `NSH_MOUNT_BENCH_ONLY=1` runs it alone
//! (`main.rs`); `NSH_MOUNT_REPEATS`, `NSH_MOUNT_DUMP` and `NSH_MOUNT_HOLD`
//! tune it as before.

use std::{
    cell::RefCell,
    rc::Rc,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use nsh_core::{element::Root, prelude::*};
use nsh_platform_macos::{
    AppOptions, AppView, ComponentContext, NativeComponent,
    objc2::{MainThreadMarker, MainThreadOnly, Message, rc::Retained},
    objc2_app_kit::{
        NSAccessibility, NSApplication, NSBackingStoreType, NSUserInterfaceItemIdentification,
        NSView, NSWindow, NSWindowOrderingMode, NSWindowStyleMask,
    },
    objc2_foundation::{NSArray, NSDate, NSPoint, NSRect, NSRunLoop, NSSize, NSString},
};

/// The rows the measured roots mount.
static ROWS: AtomicUsize = AtomicUsize::new(0);

/// The keys of the rows [`Steps`] shows in each parent (`n…`: a registered
/// native component), and how often the test changed them.
static LIST: Mutex<Vec<String>> = Mutex::new(Vec::new());
static GENERATION: AtomicUsize = AtomicUsize::new(0);

/// Whether [`Subtree`] shows its group, and how often the test changed it.
static GROUP: AtomicUsize = AtomicUsize::new(1);

/// The registered native components alive.
static LIVE: AtomicUsize = AtomicUsize::new(0);

/// The native component the rows `n…` are.
const COMPONENT: &str = "mount-test.box";

/// The parents [`Steps`] lays out, by test id.
const PARENTS: [&str; 4] = ["plain", "clipped", "blurred", "scrolled"];

/// NSH's own backdrops (first in a parent, under the rows), by class.
const BACKDROPS: [&str; 4] = [
    "<NshPlainBlur>",
    "<NshMaterialBackdrop>",
    "<NshGlassBackdrop>",
    "<NSVisualEffectView>",
];

thread_local! {
    /// What the test calls the AppKit views it adds as a host would.
    static NAMES: RefCell<Vec<(Retained<NSView>, &'static str)>> = const { RefCell::new(Vec::new()) };
}

/// `ROWS` rows in a plain view (its children are in the view itself).
#[component]
fn PlainRows() -> impl IntoElement {
    let n = ROWS.load(Ordering::Relaxed);
    view()
        .test_id("rows")
        .children((0..n).map(|_| view().h(px(2.0))))
}

/// Shows `keys` from now on.
fn set_list(keys: &[&str]) {
    *LIST.lock().unwrap() = keys.iter().map(|s| s.to_string()).collect();
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn list_now() -> Vec<String> {
    LIST.lock().unwrap().clone()
}

/// The row of `key` in the parent whose rows' test ids start with `prefix`.
fn row(prefix: &str, key: &str) -> AnyElement {
    let id = format!("{prefix}{key}");
    if key.starts_with('n') {
        nsh_core::element::native(COMPONENT)
            .test_id(&id)
            .h(px(4.0))
            .into_element()
    } else {
        view().test_id(&id).h(px(4.0)).into_element()
    }
}

/// Keyed rows ([`LIST`]) in a parent of each kind.
#[component]
fn Steps() -> impl IntoElement {
    let generation = signal(GENERATION.load(Ordering::SeqCst));
    set_interval(Duration::from_millis(5), move || {
        let now = GENERATION.load(Ordering::SeqCst);
        if generation.get_untracked() != now {
            generation.set(now);
        }
    });
    let rows = move |prefix: &'static str| {
        each(
            move || {
                generation.get();
                list_now()
            },
            |key: &String| key.clone(),
            move |key, _| row(prefix, &key.get_untracked()),
        )
    };
    view()
        .size_full()
        // In the view itself.
        .child(view().test_id("plain").child(rows("plain-")))
        // In a container: a view clipping its children that casts a
        // shadow.
        .child(
            view()
                .test_id("clipped")
                .overflow_hidden()
                .shadow_md()
                .child(rows("clipped-")),
        )
        // Over a backdrop blur (an AppKit view of NSH's own).
        .child(
            view()
                .test_id("blurred")
                .backdrop_blur(px(8.0))
                .child(rows("blurred-")),
        )
        // In a scroll view's container.
        .child(
            scroll()
                .test_id("scrolled")
                .h(px(80.0))
                .child(rows("scrolled-")),
        )
}

/// A group of rows, each with a child, beside a view that stays: shown
/// while [`GROUP`] is odd.
#[component]
fn Subtree() -> impl IntoElement {
    let generation = signal(GROUP.load(Ordering::SeqCst));
    set_interval(Duration::from_millis(5), move || {
        let now = GROUP.load(Ordering::SeqCst);
        if generation.get_untracked() != now {
            generation.set(now);
        }
    });
    view()
        .size_full()
        .child(view().test_id("kept").h(px(4.0)))
        .child(each(
            move || {
                if generation.get() % 2 == 1 {
                    vec![generation.get_untracked()]
                } else {
                    vec![]
                }
            },
            |key: &usize| *key,
            |_, _| {
                view()
                    .test_id("group")
                    .children((0..20).map(|i| {
                        view()
                            .test_id(&format!("group-{i}"))
                            .h(px(2.0))
                            .child(view().h(px(1.0)))
                    }))
                    .into_element()
            },
        ))
}

/// A registered native component: an AppKit view, counted while alive.
struct TestBox(Retained<NSView>);

impl TestBox {
    fn new() -> TestBox {
        let mtm = MainThreadMarker::new().expect("components are made on the main thread");
        let view = NSView::initWithFrame(NSView::alloc(mtm), NSRect::ZERO);
        view.setAccessibilityIdentifier(Some(&NSString::from_str("box")));
        LIVE.fetch_add(1, Ordering::SeqCst);
        TestBox(view)
    }
}

impl Drop for TestBox {
    fn drop(&mut self) {
        LIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

impl NativeComponent for TestBox {
    fn view(&self) -> Retained<NSView> {
        self.0.clone()
    }

    fn set_prop(&mut self, _name: &str, _value: Option<&serde_json::Value>) {}
}

/// Runs the main run loop until `done` holds, for at most `limit`.
fn until(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + limit;
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        let soon = NSDate::dateWithTimeIntervalSinceNow(0.001);
        NSRunLoop::currentRunLoop().runUntilDate(&soon);
    }
}

/// Runs the main run loop for `seconds`.
fn settle(seconds: f64) {
    let soon = NSDate::dateWithTimeIntervalSinceNow(seconds);
    NSRunLoop::currentRunLoop().runUntilDate(&soon);
}

fn class_name(view: &NSView) -> String {
    view.class().name().to_string_lossy().into_owned()
}

fn test_id(view: &NSView) -> Option<String> {
    view.accessibilityIdentifier().map(|i| i.to_string())
}

/// The view with test id `id`, at or under `view`.
fn find(view: &NSView, id: &str) -> Option<Retained<NSView>> {
    if test_id(view).as_deref() == Some(id) {
        return Some(view.retain());
    }
    view.subviews().iter().find_map(|v| find(&v, id))
}

/// The view holding `view`'s children: its container, or itself.
fn holder(view: &NSView) -> Retained<NSView> {
    view.subviews()
        .iter()
        .find(|v| class_name(v) == "NshContainer" && test_id(v).is_none())
        // A navigation backdrop is a container too, but empty and
        // first; a view's container holds its children.
        .filter(|c| !c.subviews().is_empty())
        .unwrap_or_else(|| view.retain())
}

/// What the test calls `view`: its name if the test added it, else its
/// test id, else its class.
fn label(view: &NSView) -> String {
    let named = NAMES.with_borrow(|names| {
        names
            .iter()
            .find(|(v, _)| std::ptr::eq::<NSView>(&**v, view))
            .map(|(_, name)| *name)
    });
    match named {
        Some(name) => name.to_string(),
        None => test_id(view).unwrap_or_else(|| format!("<{}>", class_name(view))),
    }
}

/// What `view` holds, bottom to top ([`label`]).
fn order(view: &NSView) -> Vec<String> {
    view.subviews().iter().map(|v| label(&v)).collect()
}

/// `view`'s hierarchy, `depth` levels deep, `limit` subviews a level.
fn dump(view: &NSView, depth: usize, limit: usize, indent: usize, out: &mut String) {
    let subviews = view.subviews();
    out.push_str(&format!(
        "{:indent$}{}{} subviews={}\n",
        "",
        class_name(view),
        test_id(view).map_or_else(String::new, |id| format!(" id={id}")),
        subviews.len(),
    ));
    if depth == 0 {
        return;
    }
    for (i, v) in subviews.iter().enumerate() {
        if i == limit && subviews.len() > limit + 1 {
            out.push_str(&format!(
                "{:w$}… {} more\n",
                "",
                subviews.len() - limit - 1,
                w = indent + 2
            ));
            if let Some(last) = subviews.lastObject() {
                dump(&last, depth - 1, limit, indent + 2, out);
            }
            break;
        }
        dump(&v, depth - 1, limit, indent + 2, out);
    }
}

struct Shown {
    window: Retained<NSWindow>,
    app: Rc<AppView>,
}

impl Shown {
    fn new(mtm: MainThreadMarker, fps: bool) -> Shown {
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 600.0));
        // SAFETY: a plain titled window, created on the main thread.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                frame,
                NSWindowStyleMask::Titled,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // SAFETY: `Shown` retains the window until after it closes.
        unsafe { window.setReleasedWhenClosed(false) };
        let app = AppView::new(
            mtm,
            AppOptions {
                size: (400, 600),
                ..AppOptions::default()
            },
        );
        window.setContentView(Some(&app.view()));
        window.orderFrontRegardless();
        if fps {
            app.set_fps_monitor(true);
        }
        Shown { window, app }
    }

    fn view(&self) -> Retained<NSView> {
        self.app.view()
    }
}

impl Drop for Shown {
    fn drop(&mut self) {
        self.app.set_fps_monitor(false);
        self.app.stop();
        self.window.close();
    }
}

/// The view holding the rows of `parent`.
fn holder_of(root: &NSView, parent: &str) -> Retained<NSView> {
    holder(&find(root, parent).unwrap_or_else(|| panic!("no parent {parent}")))
}

/// The row of `key` in `holder`, the holder of `parent`'s rows.
fn row_view(holder: &NSView, parent: &str, key: &str) -> Retained<NSView> {
    let id = format!("{parent}-{key}");
    holder
        .subviews()
        .iter()
        .find(|v| test_id(v).as_deref() == Some(id.as_str()))
        .unwrap_or_else(|| panic!("no row {id}"))
}

/// What `parent` holds, bottom to top: its rows by key, the views the test
/// added by name, other views by class; NSH's own backdrop left out.
fn shown_rows(root: &NSView, parent: &str) -> Vec<String> {
    let prefix = format!("{parent}-");
    order(&holder_of(root, parent))
        .into_iter()
        .filter(|s| !BACKDROPS.contains(&s.as_str()))
        .map(|s| {
            s.strip_prefix(&prefix)
                .map_or_else(|| s.clone(), str::to_string)
        })
        .collect()
}

/// Waits until every parent holds what `expected` says for it, bottom to
/// top; fails with what they hold after 5 s.
fn expect_rows(root: &NSView, what: &str, expected: impl Fn(&str) -> Vec<&'static str>) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let wrong: Vec<(&str, Vec<&str>, Vec<String>)> = PARENTS
            .iter()
            .filter_map(|&parent| {
                let want = expected(parent);
                let have = shown_rows(root, parent);
                (have != want).then_some((parent, want, have))
            })
            .collect();
        if wrong.is_empty() {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "{what}: (parent, expected, shown) {wrong:#?}"
        );
        settle(0.001);
    }
}

/// [`expect_rows`] with the same rows in every parent.
fn expect_all(root: &NSView, what: &str, expected: &[&'static str]) {
    expect_rows(root, what, |_| expected.to_vec());
}

/// A plain AppKit view the test calls `name`.
fn new_view(mtm: MainThreadMarker, name: &'static str) -> Retained<NSView> {
    let view = NSView::initWithFrame(
        NSView::alloc(mtm),
        NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(10.0, 4.0)),
    );
    NAMES.with_borrow_mut(|names| names.push((view.clone(), name)));
    view
}

/// A view called `name` in each parent, put there by `put(parent, its
/// holder, the view)`, as a host app would.
fn add_each(
    mtm: MainThreadMarker,
    root: &NSView,
    name: &'static str,
    mut put: impl FnMut(&str, &NSView, &NSView),
) -> Vec<Retained<NSView>> {
    PARENTS
        .iter()
        .map(|&parent| {
            let view = new_view(mtm, name);
            put(parent, &holder_of(root, parent), &view);
            view
        })
        .collect()
}

fn remove_all(views: &[Retained<NSView>]) {
    for view in views {
        view.removeFromSuperview();
    }
}

/// Waits until `n` registered components are alive.
fn expect_live(n: usize) {
    until(
        &format!("{n} live components"),
        Duration::from_secs(5),
        || LIVE.load(Ordering::SeqCst) == n,
    );
}

/// Each parent's native row `key` hosts exactly one component view.
fn expect_box(root: &NSView, key: &str) {
    for parent in PARENTS {
        let id = format!("{parent}-{key}");
        let native = find(root, &id).unwrap_or_else(|| panic!("no native row {id}"));
        let boxes = native
            .subviews()
            .iter()
            .filter(|v| test_id(v).as_deref() == Some("box"))
            .count();
        assert_eq!(boxes, 1, "{id} hosts {boxes} component views");
    }
}

/// The order of rows in parents of each kind through appends, inserts,
/// removals and reorders, with AppKit views a host puts in the parents in
/// every way it can (the app's appended views go right below the lowest
/// of them), and the FPS panel above the root.
fn ordering(mtm: MainThreadMarker) {
    set_list(&["a0", "a1", "a2"]);
    let shown = Shown::new(mtm, true);
    shown.app.register_component(
        COMPONENT,
        Rc::new(|_context: ComponentContext| -> Box<dyn NativeComponent> {
            Box::new(TestBox::new())
        }),
    );
    shown.app.load(Root::of::<Steps>().into());
    let root = shown.view();
    until("the first mount", Duration::from_secs(5), || {
        find(&root, "scrolled-a2").is_some()
    });
    settle(0.05);
    expect_all(&root, "the first mount", &["a0", "a1", "a2"]);

    // `addSubview:` on top, as a host app (or AppKit) adds a view: not one
    // of NSH's natives. Appends go below it, inserts before a sibling and
    // removals keep it on top, appends after it went go on top.
    let foreign = add_each(mtm, &root, "foreign", |_, holder, v| holder.addSubview(v));
    set_list(&["a0", "a1", "a2", "a3", "a4", "a5"]);
    expect_all(
        &root,
        "appended under a host's view",
        &["a0", "a1", "a2", "a3", "a4", "a5", "foreign"],
    );
    set_list(&["a0", "b", "a1", "a2", "a3", "a4", "a5"]);
    expect_all(
        &root,
        "inserted before a sibling",
        &["a0", "b", "a1", "a2", "a3", "a4", "a5", "foreign"],
    );
    set_list(&["a0", "b", "a1", "a3", "a4", "a5"]);
    expect_all(
        &root,
        "removed",
        &["a0", "b", "a1", "a3", "a4", "a5", "foreign"],
    );
    remove_all(&foreign);
    set_list(&["a0", "b", "a1", "a3", "a4", "a5", "a6"]);
    expect_all(
        &root,
        "appended after the host's view went",
        &["a0", "b", "a1", "a3", "a4", "a5", "a6"],
    );

    // `addSubview:positioned:relativeTo:` between rows, after an append
    // found only NSH's views: the next append goes right below it.
    let positioned = add_each(mtm, &root, "positioned", |parent, holder, v| {
        let a1 = row_view(holder, parent, "a1");
        holder.addSubview_positioned_relativeTo(v, NSWindowOrderingMode::Below, Some(&a1));
    });
    expect_all(
        &root,
        "a host's view inserted between rows",
        &["a0", "b", "positioned", "a1", "a3", "a4", "a5", "a6"],
    );
    set_list(&["a0", "b", "a1", "a3", "a4", "a5", "a6", "a7"]);
    expect_all(
        &root,
        "appended under a host's positioned view",
        &["a0", "b", "a7", "positioned", "a1", "a3", "a4", "a5", "a6"],
    );
    remove_all(&positioned);
    set_list(&["c0", "c1", "c2"]);
    expect_all(&root, "new rows", &["c0", "c1", "c2"]);

    // `setSubviews:` with the parent's subviews and one of the host's.
    let set = add_each(mtm, &root, "set", |_, holder, v| {
        let mut all = holder.subviews().to_vec();
        all.push(v.retain());
        holder.setSubviews(&NSArray::from_retained_slice(&all));
    });
    expect_all(
        &root,
        "a host's view set among the subviews",
        &["c0", "c1", "c2", "set"],
    );
    set_list(&["c0", "c1", "c2", "c3"]);
    expect_all(
        &root,
        "appended under a host's view set",
        &["c0", "c1", "c2", "c3", "set"],
    );
    remove_all(&set);
    set_list(&["d0", "d1", "d2"]);
    expect_all(&root, "new rows", &["d0", "d1", "d2"]);

    // `replaceSubview:with:` taking a row's place (NSH's row is put back
    // before NSH removes it).
    let mut taken = Vec::new();
    let replaced = add_each(mtm, &root, "replaced", |parent, holder, v| {
        let d2 = row_view(holder, parent, "d2");
        holder.replaceSubview_with(&d2, v);
        taken.push(d2);
    });
    expect_all(
        &root,
        "a host's view in a row's place",
        &["d0", "d1", "replaced"],
    );
    set_list(&["d0", "d1", "d2", "d3"]);
    expect_all(
        &root,
        "appended under a host's replacing view",
        &["d0", "d1", "d3", "replaced"],
    );
    for (host_view, row) in replaced.iter().zip(&taken) {
        let holder = superview_of(host_view);
        holder.replaceSubview_with(host_view, row);
    }
    expect_all(
        &root,
        "the row back in its place",
        &["d0", "d1", "d3", "d2"],
    );
    drop(taken);
    set_list(&["e0", "e1", "e2"]);
    expect_all(&root, "new rows", &["e0", "e1", "e2"]);

    // One of the host's views moved from parent to parent: where it comes
    // in appends go below it, where it left they go on top again.
    let moved = new_view(mtm, "moved");
    holder_of(&root, "plain").addSubview(&moved);
    set_list(&["e0", "e1", "e2", "e3"]);
    expect_rows(
        &root,
        "appended with a host's view in the plain parent",
        |parent| match parent {
            "plain" => vec!["e0", "e1", "e2", "e3", "moved"],
            _ => vec!["e0", "e1", "e2", "e3"],
        },
    );
    holder_of(&root, "clipped").addSubview(&moved);
    set_list(&["e0", "e1", "e2", "e3", "e4"]);
    expect_rows(
        &root,
        "appended after the host's view moved to the container",
        |parent| match parent {
            "clipped" => vec!["e0", "e1", "e2", "e3", "e4", "moved"],
            _ => vec!["e0", "e1", "e2", "e3", "e4"],
        },
    );
    holder_of(&root, "scrolled").addSubview(&moved);
    set_list(&["e0", "e1", "e2", "e3", "e4", "e5"]);
    expect_rows(
        &root,
        "appended after the host's view moved to the scroll view",
        |parent| match parent {
            "scrolled" => vec!["e0", "e1", "e2", "e3", "e4", "e5", "moved"],
            _ => vec!["e0", "e1", "e2", "e3", "e4", "e5"],
        },
    );
    moved.removeFromSuperview();
    set_list(&["f0", "f1", "f2"]);
    expect_all(&root, "new rows", &["f0", "f1", "f2"]);

    // NSH reordering its own views, without and with a host's view on top.
    set_list(&["f1", "f2", "f0"]);
    expect_all(&root, "reordered", &["f1", "f2", "f0"]);
    let top = add_each(mtm, &root, "top", |_, holder, v| holder.addSubview(v));
    set_list(&["f2", "f0", "f1"]);
    expect_all(
        &root,
        "reordered under a host's view",
        &["f2", "f0", "f1", "top"],
    );
    remove_all(&top);
    set_list(&["g0", "g1"]);
    expect_all(&root, "new rows", &["g0", "g1"]);

    // A view of the host's tagged as NSH's backdrop: NSH's while tagged
    // (appends go above it), the host's once the host changes the tag,
    // which no one hears of (appends go below it, so it must never have
    // let appends skip the scan).
    let impostor = add_each(mtm, &root, "impostor", |_, holder, v| {
        v.setIdentifier(Some(&NSString::from_str("nsh.backdrop")));
        holder.addSubview(v);
    });
    set_list(&["g0", "g1", "g2"]);
    expect_all(
        &root,
        "appended over a view tagged as a backdrop",
        &["g0", "g1", "impostor", "g2"],
    );
    for v in &impostor {
        v.setIdentifier(Some(&NSString::from_str("host.renamed")));
    }
    set_list(&["g0", "g1", "g2", "g3"]);
    expect_all(
        &root,
        "appended after the tag changed",
        &["g0", "g1", "g3", "impostor", "g2"],
    );
    remove_all(&impostor);
    set_list(&["h0", "h1"]);
    expect_all(&root, "new rows", &["h0", "h1"]);

    // Registered native components among the rows: made, removed, made
    // again, with a host's view on top of the parents.
    set_list(&["h0", "n1", "h1"]);
    expect_all(
        &root,
        "a native component among the rows",
        &["h0", "n1", "h1"],
    );
    expect_live(PARENTS.len());
    expect_box(&root, "n1");
    let over = add_each(mtm, &root, "over", |_, holder, v| holder.addSubview(v));
    set_list(&["h0", "n1", "h1", "h2", "n2"]);
    expect_all(
        &root,
        "native components appended",
        &["h0", "n1", "h1", "h2", "n2", "over"],
    );
    expect_live(2 * PARENTS.len());
    set_list(&["h0", "h1", "h2", "n2"]);
    expect_all(
        &root,
        "a native component removed",
        &["h0", "h1", "h2", "n2", "over"],
    );
    expect_live(PARENTS.len());
    set_list(&["h0", "h1", "h2", "n2", "n1"]);
    expect_all(
        &root,
        "a native component made again",
        &["h0", "h1", "h2", "n2", "n1", "over"],
    );
    expect_live(2 * PARENTS.len());
    expect_box(&root, "n1");
    expect_box(&root, "n2");
    remove_all(&over);
    set_list(&["h0"]);
    expect_all(&root, "the native components gone", &["h0"]);
    expect_live(0);

    // The FPS panel stays above the root in the view AppView puts in
    // the window.
    let top = order(&root);
    assert!(
        top.last().is_some_and(|s| !s.starts_with("<NshView")),
        "the FPS panel is not on top: {top:?}"
    );

    // Informational: whether a container goes with its app (its new
    // tracking mark holds no reference).
    let container =
        nsh_platform_macos::objc2::rc::Weak::from_retained(&holder_of(&root, "scrolled"));
    drop(root);
    drop(shown);
    nsh_platform_macos::objc2::rc::autoreleasepool(|_| settle(0.2));
    println!(
        "mount: a scroll view's container released with its app: {} (informational)",
        container.load().is_none()
    );
    NAMES.with_borrow_mut(Vec::clear);
    println!("mount ordering: ok");
}

/// A subtree deleted in one batch: its root leaves the window, and its
/// views stay in it rather than each leaving the window on its own. Shown
/// again, it mounts anew.
fn deleted_subtree(mtm: MainThreadMarker) {
    GROUP.store(1, Ordering::SeqCst);
    let shown = Shown::new(mtm, false);
    shown.app.load(Root::of::<Subtree>().into());
    let root = shown.view();
    until("the group", Duration::from_secs(5), || {
        find(&root, "group-19").is_some()
    });
    let group = find(&root, "group").expect("the group");
    let rows: Vec<_> = (0..20)
        .map(|i| find(&group, &format!("group-{i}")).expect("a row"))
        .collect();
    let row_holder = superview_of(&rows[0]);

    GROUP.store(2, Ordering::SeqCst);
    until("the group's deletion", Duration::from_secs(5), || {
        group.window().is_none()
    });
    settle(0.05);
    // SAFETY: plain getters on the main thread.
    assert!(
        unsafe { group.superview() }.is_none(),
        "the group left its parent"
    );
    for row in &rows {
        // SAFETY: as above.
        let parent = unsafe { row.superview() };
        assert!(
            parent.as_deref() == Some(&*row_holder),
            "a row of the deleted group stays in it, not detached on its own"
        );
        assert!(
            row.window().is_none(),
            "a row left the window with the group"
        );
    }
    assert!(find(&root, "kept").is_some(), "the sibling stays");
    assert!(
        find(&root, "group").is_none(),
        "nothing of the group is left"
    );

    GROUP.store(3, Ordering::SeqCst);
    until("the group shown again", Duration::from_secs(5), || {
        find(&root, "group-19").is_some()
    });
    let again = find(&root, "group").expect("the group again");
    assert!(again != group, "the group mounted anew");
    println!("mount subtree: ok");
}

/// The superview of `view` (one the test put in a parent).
fn superview_of(view: &NSView) -> Retained<NSView> {
    // SAFETY: a plain getter on the main thread; AppKit keeps the
    // superview alive while `view` is in it.
    unsafe { view.superview() }.expect("in a parent")
}

/// Process CPU (user + system) so far.
fn process_cpu() -> Duration {
    // SAFETY: getrusage fills the struct it is given.
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: as above, for this process.
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) };
    let tv = |t: libc::timeval| Duration::new(t.tv_sec as u64, t.tv_usec as u32 * 1000);
    tv(usage.ru_utime) + tv(usage.ru_stime)
}

/// This thread's CPU so far.
fn thread_cpu() -> Duration {
    // SAFETY: clock_gettime fills the struct it is given.
    let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: as above, for this thread's clock.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    Duration::new(ts.tv_sec as u64, ts.tv_nsec as u32)
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

/// Mounts `n` rows of `root`, returning wall time, process CPU and main
/// thread CPU from the load to the last row in place.
fn mount_rows(
    mtm: MainThreadMarker,
    n: usize,
    root: fn() -> Root,
    dump_to: Option<&str>,
) -> [Duration; 3] {
    ROWS.store(n, Ordering::Relaxed);
    let shown = Shown::new(mtm, false);
    settle(0.05);
    let view = shown.view();
    let (wall, cpu, main) = (Instant::now(), process_cpu(), thread_cpu());
    shown.app.load(root().into());
    until("the rows", Duration::from_secs(600), || {
        find(&view, "rows").is_some_and(|rows| {
            holder(&rows)
                .subviews()
                .iter()
                .filter(|v| class_name(v) == "NshView")
                .count()
                == n
        })
    });
    let measured = [wall.elapsed(), process_cpu() - cpu, thread_cpu() - main];
    if let Some(path) = dump_to {
        let mut out = String::new();
        dump(&view, 6, 4, 0, &mut out);
        std::fs::write(path, out).expect("the hierarchy dump");
    }
    measured
}

fn bench(mtm: MainThreadMarker) {
    let repeats: usize = std::env::var("NSH_MOUNT_REPEATS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let dumps = std::env::var("NSH_MOUNT_DUMP").ok();
    let roots = [("plain", (|| Root::of::<PlainRows>()) as fn() -> Root)];
    // Warm up (fonts, classes, the engine's first start).
    mount_rows(mtm, 100, roots[0].1, None);
    for (name, root) in roots {
        for n in [100, 1000, 8600] {
            let mut runs = Vec::new();
            for r in 0..repeats {
                let dump = dumps
                    .as_ref()
                    .filter(|_| r == 0 && n == 100)
                    .map(|dir| format!("{dir}/hierarchy-{name}-{n}.txt"));
                runs.push(mount_rows(mtm, n, root, dump.as_deref()));
            }
            let col = |i: usize| {
                let mut v: Vec<f64> = runs.iter().map(|r| ms(r[i])).collect();
                v.sort_by(f64::total_cmp);
                let median = v[v.len() / 2];
                let list = v
                    .iter()
                    .map(|x| format!("{x:.1}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                format!("median {median:.1} [{list}]")
            };
            println!(
                "bench {name} n={n}: wall ms {} | process cpu ms {} | main thread cpu ms {}",
                col(0),
                col(1),
                col(2)
            );
        }
    }
    // Sampling: mount 8 600 plain rows again and again for `sample`.
    if let Ok(secs) = std::env::var("NSH_MOUNT_HOLD").map(|s| s.parse::<f64>().unwrap_or(10.0)) {
        println!("holding: pid {}", std::process::id());
        let end = Instant::now() + Duration::from_secs_f64(secs);
        while Instant::now() < end {
            mount_rows(mtm, 8600, roots[0].1, None);
        }
    }
}

/// Whether only the benchmark runs (`NSH_MOUNT_BENCH_ONLY`).
pub(super) fn bench_only() -> bool {
    std::env::var_os("NSH_MOUNT_BENCH_ONLY").is_some()
}

/// The benchmark alone, in a process nothing else ran in: as the former
/// `tests/mount.rs` ran it with `NSH_MOUNT_BENCH_ONLY`.
pub(super) fn bench_alone() {
    let mtm = MainThreadMarker::new().expect("the main thread");
    let _app = NSApplication::sharedApplication(mtm);
    bench(mtm);
}

/// The ordering checks, then the benchmark with `NSH_MOUNT_BENCH`.
pub(super) fn run() {
    let mtm = MainThreadMarker::new().expect("the main thread");
    let _app = NSApplication::sharedApplication(mtm);
    ordering(mtm);
    deleted_subtree(mtm);
    if std::env::var_os("NSH_MOUNT_BENCH").is_some() {
        bench(mtm);
    }
}
