//! `nsh/base`'s `SplitView` through the JS glue: on iOS the columns' stacks
//! and a native `UISplitViewController` component (`nsh/split-view`) with
//! the app's visibility as data, what the user changes coming back as
//! `onColumnVisibilityChange` (shown again when the app keeps its value),
//! each column laid out at the size the split reports; elsewhere the
//! columns of a dock area, every stack kept as the presentation changes.

use crossbeam_channel::Receiver;
use nsh_core::{
    EventKind, EventPayload, MountBatch, MountItem, ViewKind,
    platform::{Os, SPLIT_VIEW_COMPONENT},
};
use nsh_engine::{Engine, Environment};

use crate::components::{shows, start_with, until};

const MAIL: &str = r#"import { mount, signal, Text } from "nsh";
import { type ColumnVisibility, createNavStack, NavPage, NavStack, SplitView } from "nsh/base";
const visibility = signal<ColumnVisibility>("all");
const reported = signal("none");
const mailboxes = createNavStack(["mailboxes"]);
const inbox = createNavStack(["inbox"]);
const message = createNavStack(["message"]);
// What the app takes: `detailOnly` and `all`, never `doubleColumn`.
const take = (next: ColumnVisibility) => {
  reported.set(next);
  if (next !== "doubleColumn") visibility.set(next);
};
mount(() => (
  <SplitView
    style={{ flex: 1 }}
    columnVisibility={visibility()}
    onColumnVisibilityChange={({ columnVisibility }) => take(columnVisibility)}
    sidebar={<NavStack state={mailboxes}>{() => <NavPage title="Mailboxes"><Text>Mailboxes</Text></NavPage>}</NavStack>}
    content={<NavStack state={inbox}>{() => <NavPage title="Inbox"><Text>Inbox</Text></NavPage>}</NavStack>}
    detail={<NavStack state={message}>{() => <NavPage title="Message"><Text>{`Reported: ${reported()} Shown: ${visibility()}`}</Text></NavPage>}</NavStack>}
  />
));
"#;

fn start(os: Os, app: &str) -> (Engine, Receiver<MountBatch>) {
    start_with(
        app,
        Environment {
            os,
            ..Environment::default()
        },
        None,
        None,
    )
}

/// The split's component node.
fn split_id(batches: &[MountBatch]) -> Option<u32> {
    batches
        .iter()
        .flat_map(|b| &b.items)
        .find_map(|item| match item {
            MountItem::Component { id, name } if &**name == SPLIT_VIEW_COMPONENT => Some(*id),
            _ => None,
        })
}

/// The split's prop `key`, as last sent in `batches`.
fn prop<'a>(
    batches: impl IntoIterator<Item = &'a MountBatch>,
    id: u32,
    key: &str,
) -> Option<serde_json::Value> {
    batches
        .into_iter()
        .flat_map(|b| &b.items)
        .filter_map(|item| match item {
            MountItem::ComponentProps { id: c, props } if *c == id => Some(props),
            _ => None,
        })
        .flatten()
        .filter(|(name, _)| &**name == key)
        .last()
        .and_then(|(_, value)| value.clone())
}

/// The stacks made, in the order they were.
fn stacks(batches: &[MountBatch]) -> Vec<u32> {
    batches
        .iter()
        .flat_map(|b| &b.items)
        .filter_map(|item| match item {
            MountItem::Create {
                id,
                kind: ViewKind::Stack,
            } => Some(*id),
            _ => None,
        })
        .collect()
}

/// The last frame sent for `id` in `batches`.
fn frame<'a>(batches: impl IntoIterator<Item = &'a MountBatch>, id: u32) -> Option<(f32, f32)> {
    batches
        .into_iter()
        .flat_map(|b| &b.items)
        .filter_map(|item| match item {
            MountItem::Frame { id: f, frame } if *f == id => {
                Some((frame.size.width.0, frame.size.height.0))
            }
            _ => None,
        })
        .last()
}

fn native(engine: &Engine, split: u32, name: &str, data: serde_json::Value) {
    engine.control().dispatch_event(
        split,
        EventKind::NativeEvent,
        EventPayload::Native {
            name: name.into(),
            data,
        },
    );
}

/// On iOS the split is the system's: the columns' stacks are made, the
/// component gets the number of columns and the app's visibility; a column
/// is laid out at the size the split reports for it; what the user shows
/// is reported, and shown again (a new `revision`) when the app keeps its
/// own value; the collapsed split's way back is a column's visibility.
#[test]
fn ios_gets_a_split_view_controller_of_the_columns_stacks() {
    let (engine, rx) = start(Os::Ios, MAIL);
    let initial = until(&rx, |batch| shows(batch, "Reported: none Shown: all"));
    let split = split_id(&initial).expect("the native split");
    assert_eq!(prop(&initial, split, "columns"), Some("triple".into()));
    assert_eq!(
        prop(&initial, split, "columnVisibility"),
        Some("all".into())
    );
    assert_eq!(prop(&initial, split, "revision"), Some(0.into()));
    let made = stacks(&initial);
    assert_eq!(made.len(), 3, "a stack per column");
    // The split laid its columns out: the sidebar's stack takes its size.
    native(
        &engine,
        split,
        "layout",
        serde_json::json!({
            "sidebar": { "width": 320, "height": 700 },
            "content": { "width": 320, "height": 700 },
            "detail": { "width": 384, "height": 700 },
        }),
    );
    // (Frames of the first layout may still come first.)
    let laid_out = until(&rx, |batch| frame([batch], made[0]) == Some((320.0, 700.0)));
    assert_eq!(frame(&laid_out, made[0]), Some((320.0, 700.0)));
    // The user shows the content and the detail: reported; the app keeps
    // its value, which the split is told to show again.
    native(
        &engine,
        split,
        "columnVisibilityChange",
        "doubleColumn".into(),
    );
    let kept = until(&rx, |batch| {
        prop([batch], split, "revision") == Some(1.into())
    });
    assert!(
        kept.iter()
            .any(|b| shows(b, "Reported: doubleColumn Shown: all")),
        "reported, and the app kept all"
    );
    // The user hides the sidebar and the content: the app takes it.
    native(
        &engine,
        split,
        "columnVisibilityChange",
        "detailOnly".into(),
    );
    let taken = until(&rx, |batch| {
        shows(batch, "Reported: detailOnly Shown: detailOnly")
    });
    assert_eq!(
        prop(&taken, split, "columnVisibility"),
        Some("detailOnly".into())
    );
    assert_eq!(prop(&taken, split, "revision"), None, "nothing shown again");
    // Collapsed, the user went back from the detail's first page to the
    // content: `doubleColumn`, which this app does not take.
    native(&engine, split, "compactColumnChange", 1.into());
    let back = until(&rx, |batch| {
        prop([batch], split, "revision") == Some(2.into())
    });
    assert!(
        back.iter()
            .any(|b| shows(b, "Reported: doubleColumn Shown: detailOnly")),
        "the column the user went back to is reported"
    );
    // No stack went: each column keeps its pages.
    for batch in initial.iter().chain(&laid_out).chain(&kept).chain(&taken) {
        for item in &batch.items {
            if let MountItem::Delete { id } = item {
                assert!(!made.contains(id), "stack {id} deleted");
            }
        }
    }
}

/// Elsewhere the columns are a dock area's: no native split, every
/// column's stack made once and kept as the visibility changes.
#[test]
fn elsewhere_the_columns_are_a_dock_areas() {
    // The app changes what shows by itself.
    let app = format!("{MAIL}\nsetTimeout(() => visibility.set(\"detailOnly\"), 100);\n");
    for os in [Os::Android, Os::MacOs, Os::Web] {
        let (_engine, rx) = start(os, &app);
        let batches = until(&rx, |batch| {
            shows(batch, "Reported: none Shown: detailOnly")
        });
        assert_eq!(split_id(&batches), None, "{os:?}");
        let made = stacks(&batches);
        assert_eq!(made.len(), 3, "{os:?}: a stack per column");
        for batch in &batches {
            for item in &batch.items {
                if let MountItem::Delete { id } = item {
                    assert!(!made.contains(id), "{os:?}: stack {id} deleted");
                }
            }
        }
    }
}
