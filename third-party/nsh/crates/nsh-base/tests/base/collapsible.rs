//! `Collapsible`: with `reveal`, opening and closing animate the frames the
//! region moves natively (a clipped region springing between zero and the
//! content's height, what follows it moving along; the commit's other
//! frames change at once), and the content stays in the tree until the
//! region has closed; without it, or with reduced motion, the content comes
//! and goes at once. On a manual clock, so time moves only when the test
//! says.

use std::sync::{Arc, Mutex};

use nsh_base::collapsible;
use nsh_core::{LayoutCurve, MountItem, NodeId, Size, element::Root, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    reveal: bool,
    /// A board of fixed height after it, whose row the trigger's press
    /// grows too (live data landing in the same commit).
    board: bool,
}

/// A 20-point trigger over a 30-point content, in a region; a view after
/// it moves as the region opens and closes.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let open = signal(false);
    let tick = signal(false);
    let board = props.board;
    view()
        .child(
            view().test_id("region").child(
                collapsible()
                    .open(open)
                    .reveal(props.reveal)
                    .content(view().test_id("details").h(px(30.0)).child(text("Details")))
                    .child(
                        view()
                            .test_id("trigger")
                            .h(px(20.0))
                            .on_press(move || {
                                open.update(|o| *o = !*o);
                                tick.update(|t| *t = !*t);
                            })
                            .child(text("Summary")),
                    ),
            ),
        )
        .child(view().test_id("after").h(px(20.0)).child(text("After")))
        .child(when(
            move || board,
            move || {
                view().test_id("board").h(px(40.0)).child(
                    view()
                        .test_id("row")
                        .style_with(move |s| s.h(px(if tick.get() { 20.0 } else { 10.0 }))),
                )
            },
        ))
}

/// The items of each step's batches, by step.
type Seen = Arc<Mutex<Vec<(String, Vec<MountItem>)>>>;

struct App {
    app: Headless,
    seen: Seen,
}

fn start(reveal: bool, reduce_motion: bool) -> App {
    start_with(reveal, reduce_motion, false)
}

fn start_with(reveal: bool, reduce_motion: bool, board: bool) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps { reveal, board }))
    };
    config.environment.reduce_motion = reduce_motion;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen: Seen = Arc::default();
    let into = seen.clone();
    app.observe(move |step, batch| {
        into.lock()
            .unwrap()
            .push((step.to_owned(), batch.items.clone()));
    });
    app.first_render().unwrap();
    app.wait_for("Summary").unwrap();
    App { app, seen }
}

impl App {
    /// Presses the trigger and returns the items of the batches that came.
    fn toggle(&mut self) -> Vec<MountItem> {
        self.seen.lock().unwrap().clear();
        self.app.press("id:trigger").unwrap();
        self.items()
    }

    /// Presses the trigger and returns the batches that came.
    fn toggle_batches(&mut self) -> Vec<Vec<MountItem>> {
        self.seen.lock().unwrap().clear();
        self.app.press("id:trigger").unwrap();
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|(_, items)| items.clone())
            .collect()
    }

    /// The items that came since the last toggle.
    fn items(&self) -> Vec<MountItem> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .flat_map(|(_, items)| items.iter().cloned())
            .collect()
    }

    /// The view with test id `test_id`, from every batch so far.
    fn id(&self, all: &[MountItem], test_id: &str) -> NodeId {
        all.iter()
            .find_map(|i| match i {
                MountItem::ViewProps { id, props } if props.test_id.as_deref() == Some(test_id) => {
                    Some(*id)
                }
                _ => None,
            })
            .unwrap_or_else(|| panic!("no view {test_id}"))
    }
}

/// The last frame `items` give `id`: its y and height.
fn frame(items: &[MountItem], id: NodeId) -> Option<(f32, f32)> {
    items.iter().rev().find_map(|i| match i {
        MountItem::Frame { id: at, frame } if *at == id => {
            Some((frame.origin.y.0, frame.size.height.0))
        }
        _ => None,
    })
}

/// Whether `items` animate the commit's frames with the reveal's spring.
fn reveals(items: &[MountItem]) -> bool {
    items.iter().any(|i| {
        matches!(i, MountItem::LayoutAnimation(a)
            if a.create.is_none()
                && a.delete.is_none()
                && a.update.is_some_and(|u| u.curve == LayoutCurve::Spring { damping: 1.0 }))
    })
}

/// Whether `items` take the view `id`, or a view around it (as `inserts`
/// placed them), out of the tree. While the region is closed its content is
/// clipped away, so the screen does not show it whether it is there or not:
/// the batches say.
fn detaches(items: &[MountItem], inserts: &[MountItem], id: NodeId) -> bool {
    let mut chain = vec![id];
    while chain.len() < 64 {
        let at = *chain.last().unwrap();
        let parent = inserts.iter().rev().find_map(|i| match i {
            MountItem::Insert { parent, child, .. } if *child == at => Some(*parent),
            _ => None,
        });
        match parent {
            Some(parent) => chain.push(parent),
            None => break,
        }
    }
    items.iter().any(
        |i| matches!(i, MountItem::Remove { id } | MountItem::Delete { id } if chain.contains(id)),
    )
}

/// Whether the last frame `batches` give `id` animates (`None`: they give
/// it none): the platforms animate a frame with the last layout animation
/// before it in its batch.
fn frame_motion(batches: &[Vec<MountItem>], id: NodeId) -> Option<bool> {
    let mut found = None;
    for items in batches {
        let mut animated = false;
        for item in items {
            match item {
                MountItem::LayoutAnimation(a) => animated = a.update.is_some(),
                MountItem::Frame { id: at, .. } if *at == id => found = Some(animated),
                _ => {}
            }
        }
    }
    found
}

fn any_layout_animation(items: &[MountItem]) -> bool {
    items
        .iter()
        .any(|i| matches!(i, MountItem::LayoutAnimation(_)))
}

#[test]
fn a_reveal_keeps_the_content_until_the_region_has_closed() {
    let mut app = start(true, false);
    let first: Vec<MountItem> = app.items();
    let after = app.id(&first, "after");
    let region = app.id(&first, "region");
    assert_eq!(
        frame(&first, region).map(|f| f.1),
        Some(20.0),
        "the trigger"
    );
    assert!(!app.app.shows("Details"), "collapsed: no content");
    assert_eq!(
        frame(&first, after).map(|f| f.0),
        Some(20.0),
        "after the trigger"
    );

    // Open: the commit's frames spring, the content in at once (clipped).
    let opened = app.toggle();
    assert!(reveals(&opened), "the opening commit animates its frames");
    assert!(app.app.shows("Details"));
    assert_eq!(
        frame(&opened, after).map(|f| f.0),
        Some(50.0),
        "below the content"
    );
    assert_eq!(
        frame(&opened, region).map(|f| f.1),
        Some(50.0),
        "and the content"
    );
    // Small: the animation, the content's views and texts, the frames that
    // move (the clip, the region, the view after it).
    assert!(opened.len() <= 24, "{} items: {opened:#?}", opened.len());

    // Close: the frames spring back and the content stays meanwhile.
    let closed = app.toggle();
    assert!(reveals(&closed), "the closing commit animates its frames");
    assert_eq!(
        frame(&closed, after).map(|f| f.0),
        Some(20.0),
        "back under the trigger"
    );
    assert_eq!(
        frame(&closed, region).map(|f| f.1),
        Some(20.0),
        "the trigger"
    );
    // Made in the first render or on opening (a fill of the harness's).
    let inserts: Vec<MountItem> = first.iter().chain(&opened).cloned().collect();
    let details = app.id(&inserts, "details");
    assert!(
        !detaches(&closed, &inserts, details),
        "kept while the region closes"
    );
    assert!(!app.app.shows("Details"), "clipped by the closed region");
    assert!(closed.len() <= 10, "{} items: {closed:#?}", closed.len());
    app.seen.lock().unwrap().clear();
    app.app
        .run_for(std::time::Duration::from_millis(200))
        .unwrap();
    assert!(!detaches(&app.items(), &inserts, details), "still closing");
    app.seen.lock().unwrap().clear();
    app.app
        .run_for(std::time::Duration::from_millis(100))
        .unwrap();
    let removed = app.items();
    assert!(
        detaches(&removed, &inserts, details),
        "out once closed: {removed:#?}"
    );
    assert!(
        !any_layout_animation(&removed),
        "taking it out animates nothing"
    );
}

#[test]
fn a_reveal_animates_only_the_frames_it_moves() {
    let mut app = start_with(true, false, true);
    let first = app.items();
    let (after, board, row) = (
        app.id(&first, "after"),
        app.id(&first, "board"),
        app.id(&first, "row"),
    );
    for step in ["open", "close"] {
        let batches = app.toggle_batches();
        assert_eq!(
            frame_motion(&batches, after),
            Some(true),
            "{step}: moved along"
        );
        assert_eq!(
            frame_motion(&batches, board),
            Some(true),
            "{step}: moved along"
        );
        assert_eq!(
            frame_motion(&batches, row),
            Some(false),
            "{step}: a row of the board changed in the same commit, at once: {batches:#?}"
        );
    }
}

#[test]
fn opening_again_while_it_closes_keeps_the_content() {
    let mut app = start(true, false);
    app.toggle();
    app.toggle();
    app.app
        .run_for(std::time::Duration::from_millis(100))
        .unwrap();
    let reopened = app.toggle();
    assert!(reveals(&reopened));
    app.app
        .run_for(std::time::Duration::from_millis(400))
        .unwrap();
    assert!(app.app.shows("Details"), "open: the closing's end is void");
}

#[test]
fn with_reduced_motion_a_reveal_closes_at_once() {
    let mut app = start(true, true);
    let opened = app.toggle();
    assert!(app.app.shows("Details"));
    assert!(!any_layout_animation(&opened), "no motion");
    let closed = app.toggle();
    assert!(!app.app.shows("Details"), "out at once");
    assert!(!any_layout_animation(&closed), "no motion");
}

#[test]
fn without_reveal_the_content_comes_and_goes_at_once() {
    let mut app = start(false, false);
    let opened = app.toggle();
    assert!(app.app.shows("Details"));
    assert!(!any_layout_animation(&opened));
    let closed = app.toggle();
    assert!(!app.app.shows("Details"), "out at once");
    assert!(!any_layout_animation(&closed));
}
