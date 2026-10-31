//! `Avatar` and `AvatarGroup`: the fallback shows while the image loads
//! (after its delay), the image once it has loaded and the fallback again
//! when it fails, all from the image's own events; screen readers hear the
//! person's name; a group makes only the avatars it shows and its overflow
//! while more are in it. Headless runs load no images: the tests play the
//! platform's part with the image's load events.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{AvatarStatus, avatar, avatar_group};
use nsh_core::{
    EventKind, EventPayload, MountBatch, MountItem, NodeId, Size, ViewKind, element::Root,
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// The images the app mounted, by URL, and every batch's items.
#[derive(Default)]
struct Seen {
    images: Vec<(NodeId, String)>,
    /// The items of each batch, with the step it came in.
    batches: Vec<(String, Vec<MountItem>)>,
}

fn start<C: Component<Props = ()>>() -> (Headless, Arc<Mutex<Seen>>) {
    let config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        ..EngineConfig::new(Root::of::<C>())
    };
    let mut app = Headless::start(config).unwrap();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let log = seen.clone();
    app.observe(move |step: &str, batch: &MountBatch| {
        let mut seen = log.lock().unwrap();
        for item in &batch.items {
            if let MountItem::Image {
                id,
                source: Some(source),
                ..
            } = item
            {
                seen.images.push((*id, source.uri.to_string()));
            }
        }
        seen.batches.push((step.to_owned(), batch.items.clone()));
    });
    app.first_render().unwrap();
    (app, seen)
}

/// The image node showing `url`.
fn image_of(seen: &Mutex<Seen>, url: &str) -> NodeId {
    seen.lock()
        .unwrap()
        .images
        .iter()
        .rev()
        .find(|(_, u)| u == url)
        .unwrap_or_else(|| panic!("no image of {url}"))
        .0
}

/// The platform reports `kind` for the image of `url`.
fn report(app: &mut Headless, seen: &Mutex<Seen>, url: &str, kind: EventKind) {
    let id = image_of(seen, url);
    let payload = match kind {
        EventKind::Load => EventPayload::Image(Size::new(DevicePixels(96), DevicePixels(96))),
        EventKind::Error => EventPayload::Error {
            message: "not found".into(),
        },
        _ => EventPayload::None,
    };
    app.engine().control().dispatch_event(id, kind, payload);
}

const ADA: &str = "https://example.com/ada.png";
const GRACE: &str = "https://example.com/grace.png";
const ALAN: &str = "https://example.com/alan.png";

/// Avatars have their size, as an app gives them (`size-10`). Ada's
/// avatar, an image with a name; Grace's, whose fallback waits
/// 300 ms; Alan's, with a label over his name; Edsger's, with no image and
/// an icon of the app's in place of the initials; and a decorative one.
/// A text says what Ada's reported last.
#[component]
fn People() -> impl IntoElement {
    let status = signal(AvatarStatus::Idle);
    view()
        .child(
            avatar()
                .size(px(40.0))
                .src(ADA)
                .name("Ada Lovelace")
                .on_status_change(move |s: &AvatarStatus| status.set(*s)),
        )
        .child(
            avatar()
                .size(px(40.0))
                .src(GRACE)
                .name("Grace Hopper")
                .fallback_delay(300.0),
        )
        .child(
            avatar()
                .size(px(40.0))
                .src(ALAN)
                .name("Alan Turing")
                .accessibility_label("Alan Turing, online"),
        )
        .child(avatar().name("Edsger Dijkstra").fallback(text("☺")))
        .child(avatar().name("Barbara Liskov").accessibility_label(""))
        .child(text(move || format!("ada {:?}", status.get())))
}

#[test]
fn the_fallback_shows_while_the_image_loads_and_goes_once_it_has_loaded() {
    let (mut app, seen) = start::<People>();
    app.wait_for("ada Loading").unwrap();
    assert!(app.shows("AL"));
    report(&mut app, &seen, ADA, EventKind::LoadStart);
    report(&mut app, &seen, ADA, EventKind::Load);
    app.wait_for("ada Loaded").unwrap();
    app.wait_for_gone("text:AL", Duration::from_secs(1))
        .unwrap();
}

#[test]
fn a_failed_image_falls_back_to_the_initials() {
    let (mut app, seen) = start::<People>();
    report(&mut app, &seen, ADA, EventKind::Load);
    app.wait_for("ada Loaded").unwrap();
    assert!(!app.shows("AL"));
    report(&mut app, &seen, ADA, EventKind::Error);
    app.wait_for("ada Error").unwrap();
    app.wait_for("text:AL").unwrap();
}

#[test]
fn without_an_image_the_fallback_shows_at_once_with_the_apps_content() {
    let (app, _) = start::<People>();
    assert!(app.shows("☺"));
    // The app's content takes the place of the initials.
    assert!(!app.shows("ED"));
}

#[test]
fn the_fallback_waits_its_delay_while_the_image_loads() {
    let (mut app, seen) = start::<People>();
    assert!(!app.shows("GH"));
    app.wait(Duration::from_millis(400)).unwrap();
    assert!(app.shows("GH"));
    // Loaded within the delay: the fallback never shows.
    report(&mut app, &seen, GRACE, EventKind::LoadStart);
    app.wait(Duration::from_millis(50)).unwrap();
    report(&mut app, &seen, GRACE, EventKind::Load);
    app.wait_for_gone("text:GH", Duration::from_secs(1))
        .unwrap();
}

#[test]
fn an_image_that_loads_within_the_delay_never_shows_the_fallback() {
    let (mut app, seen) = start::<People>();
    report(&mut app, &seen, GRACE, EventKind::Load);
    app.wait(Duration::from_millis(400)).unwrap();
    assert!(!app.shows("GH"));
}

#[test]
fn screen_readers_hear_the_name_or_the_label() {
    let (app, _) = start::<People>();
    let screen = app.screen();
    assert_eq!(screen.count("role:image[Ada Lovelace]"), Ok(1));
    assert_eq!(screen.count("role:image[Alan Turing, online]"), Ok(1));
    assert_eq!(screen.count("role:image[Edsger Dijkstra]"), Ok(1));
    // An empty label is a decorative avatar.
    assert_eq!(screen.count("role:image[Barbara Liskov]"), Ok(0));
}

/// Whether the view `id` was mounted hidden from screen readers.
fn hidden_from_screen_readers(seen: &Mutex<Seen>, id: NodeId) -> bool {
    let seen = seen.lock().unwrap();
    seen.batches
        .iter()
        .flat_map(|(_, items)| items)
        .filter_map(|item| match item {
            MountItem::ViewProps { id: of, props } if *of == id => Some(props.accessibility.hidden),
            _ => None,
        })
        .next_back()
        .unwrap_or(false)
}

/// The view holding the text `text`.
fn parent_of_text(seen: &Mutex<Seen>, text: &str) -> NodeId {
    let seen = seen.lock().unwrap();
    let items: Vec<_> = seen.batches.iter().flat_map(|(_, items)| items).collect();
    let id = items
        .iter()
        .find_map(|item| match item {
            MountItem::Text { id, text: t, .. } if t.text == text => Some(*id),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no text {text}"));
    items
        .iter()
        .find_map(|item| match item {
            MountItem::Insert { parent, child, .. } if *child == id => Some(*parent),
            _ => None,
        })
        .unwrap_or_else(|| panic!("{text} is not inserted"))
}

#[test]
fn the_avatar_says_the_name_once_its_parts_are_hidden() {
    let (_, seen) = start::<People>();
    // The initials' fallback and the image: the avatar's label says the
    // name, so neither is read apart.
    assert!(hidden_from_screen_readers(
        &seen,
        parent_of_text(&seen, "AL")
    ));
    assert!(hidden_from_screen_readers(&seen, image_of(&seen, ADA)));
}

/// A group of a hundred people of which three show, then a group of the
/// first three of eight (`total`), then one of two under its limit.
#[component]
fn Team() -> impl IntoElement {
    let person = |i: usize| avatar().name(format!("Person {i}"));
    view()
        .child(
            avatar_group()
                .accessibility_label("Everyone")
                .limit(3)
                .children((0..100).map(person))
                .overflow_accessibility_label("97 more people")
                .overflow(text("+97")),
        )
        .child(
            avatar_group()
                .accessibility_label("Reviewers")
                .total(8)
                .children((100..103).map(person))
                .overflow(text("+5")),
        )
        .child(
            avatar_group()
                .accessibility_label("Pair")
                .children((200..202).map(person))
                .overflow(text("+0")),
        )
}

#[test]
fn a_group_shows_its_first_avatars_and_the_overflow_while_more_are_in_it() {
    let (app, _) = start::<Team>();
    let screen = app.screen();
    assert_eq!(screen.count("role:group[Everyone] >> role:image"), Ok(3));
    assert_eq!(screen.count("role:image[Person 2]"), Ok(1));
    assert_eq!(screen.count("role:image[Person 3]"), Ok(0));
    assert!(app.shows("+97"));
    // Screen readers hear the app's words for the overflow, not "+97".
    assert_eq!(screen.count("label:97 more people"), Ok(1));
    assert_eq!(screen.count("role:group[Reviewers] >> role:image"), Ok(3));
    assert!(app.shows("+5"));
    assert_eq!(screen.count("role:group[Pair] >> role:image"), Ok(2));
    assert!(!app.shows("+0"));
}

#[test]
fn a_group_makes_views_for_the_avatars_it_shows_only() {
    let (_, seen) = start::<Team>();
    let seen = seen.lock().unwrap();
    let created = seen
        .batches
        .iter()
        .flat_map(|(_, items)| items)
        .filter(|item| matches!(item, MountItem::Create { .. }))
        .count();
    // Eight avatars shown (a view, its fallback and the initials each),
    // three overflows, three groups and the root's: far from a hundred.
    assert!(created < 50, "{created} views for 8 avatars");
}

/// The views an item addresses (an insert, its parent and the child).
fn ids_of(item: &MountItem) -> Vec<NodeId> {
    match item {
        MountItem::Create { id, .. }
        | MountItem::Delete { id }
        | MountItem::Remove { id }
        | MountItem::Frame { id, .. }
        | MountItem::ViewStyle { id, .. }
        | MountItem::ViewProps { id, .. }
        | MountItem::AccessibilityLabel { id, .. }
        | MountItem::Text { id, .. }
        | MountItem::Image { id, .. } => vec![*id],
        MountItem::Insert { parent, child, .. } => vec![*parent, *child],
        _ => Vec::new(),
    }
}

/// What changed from batch `before` on: the items, and how many of them
/// create, delete or show an image again.
fn changes(seen: &Mutex<Seen>, before: usize) -> (Vec<MountItem>, usize, usize, usize) {
    let seen = seen.lock().unwrap();
    let items: Vec<MountItem> = seen.batches[before..]
        .iter()
        .flat_map(|(_, items)| items.iter().cloned())
        .collect();
    let count = |f: fn(&MountItem) -> bool| items.iter().filter(|i| f(i)).count();
    let created = count(|i| matches!(i, MountItem::Create { .. }));
    let deleted = count(|i| matches!(i, MountItem::Delete { .. }));
    let images = count(|i| matches!(i, MountItem::Image { .. }));
    (items, created, deleted, images)
}

/// The other avatars' images: nothing they show may change.
fn assert_untouched(seen: &Mutex<Seen>, items: &[MountItem]) {
    let others = [image_of(seen, GRACE), image_of(seen, ALAN)];
    for item in items {
        assert!(
            ids_of(item).iter().all(|id| !others.contains(id)),
            "a sibling changed: {item:?}"
        );
    }
}

#[test]
fn a_load_changes_only_the_image_and_the_fallback() {
    let (mut app, seen) = start::<People>();
    app.wait_for("ada Loading").unwrap();
    let before = seen.lock().unwrap().batches.len();
    report(&mut app, &seen, ADA, EventKind::Load);
    app.wait_for("ada Loaded").unwrap();
    let (items, created, deleted, images) = changes(&seen, before);
    // The fallback and its initials go, the image turns opaque (one
    // style), the status text changes; the image is not loaded again.
    assert_eq!((created, images), (0, 0), "{items:?}");
    assert!(deleted <= 2, "{items:?}");
    // The avatar has its size: nothing is laid out again, its rows or the
    // ones after them.
    assert!(
        !items.iter().any(|i| matches!(i, MountItem::Frame { .. })),
        "{items:?}"
    );
    assert!(items.len() <= 8, "{} items: {items:?}", items.len());
    assert_untouched(&seen, &items);
}

#[test]
fn a_failure_brings_back_only_the_fallback() {
    let (mut app, seen) = start::<People>();
    report(&mut app, &seen, ADA, EventKind::Load);
    app.wait_for("ada Loaded").unwrap();
    let before = seen.lock().unwrap().batches.len();
    report(&mut app, &seen, ADA, EventKind::Error);
    app.wait_for("ada Error").unwrap();
    let (items, created, deleted, images) = changes(&seen, before);
    // The fallback and its initials are made again, the image turns
    // transparent; nothing goes, and the image stays as it is.
    assert!(created <= 2, "{items:?}");
    assert_eq!((deleted, images), (0, 0), "{items:?}");
    assert!(
        !items.iter().any(|i| matches!(
            i,
            MountItem::Create {
                kind: ViewKind::Image,
                ..
            }
        )),
        "{items:?}"
    );
    assert!(items.len() <= 16, "{} items: {items:?}", items.len());
    assert_untouched(&seen, &items);
}

#[test]
fn a_fallback_after_its_delay_changes_only_its_avatar() {
    let (mut app, seen) = start::<People>();
    let before = seen.lock().unwrap().batches.len();
    app.wait(Duration::from_millis(400)).unwrap();
    assert!(app.shows("GH"));
    let (items, created, deleted, images) = changes(&seen, before);
    assert!(created <= 2, "{items:?}");
    assert_eq!((deleted, images), (0, 0), "{items:?}");
    let ada = image_of(&seen, ADA);
    assert!(items.iter().all(|i| !ids_of(i).contains(&ada)), "{items:?}");
}
