//! `EmojiPicker`: a list box of the emoji by name under the headers of the
//! groups the app names; typing filters by English names and keywords and
//! the app's annotations, `empty` shows when nothing matches; Up and Down
//! move the highlight down a column, Left and Right along the cells while
//! the query is empty; Return and a press choose the emoji with the skin
//! tone; the pointer highlights; Escape clears the query and then cancels;
//! the app's recent emoji lead; `emojiVersion` and `groups` choose what
//! shows; the ref scrolls to a group, which is reported, and looks emoji
//! up; and a key press costs the two cells it concerns.

use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{
    EmojiAnnotation, EmojiEntry, EmojiGroupId, EmojiGroupLabels, EmojiPickerApi, EmojiPickerEvent,
    EmojiSkinTone, emoji_picker,
};
use nsh_core::{MountItem, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    groups: Option<Vec<EmojiGroupId>>,
    recent: Vec<SharedString>,
    skin_tone: EmojiSkinTone,
    emoji_version: Option<SharedString>,
    annotations: Vec<EmojiAnnotation>,
}

fn props() -> HarnessProps {
    HarnessProps {
        groups: Some(vec![EmojiGroupId::SmileysEmotion, EmojiGroupId::PeopleBody]),
        recent: Vec::new(),
        skin_tone: EmojiSkinTone::None,
        emoji_version: None,
        annotations: Vec::new(),
    }
}

/// The picker (a search field `Search emoji`, headers `Smileys`, `People`
/// and `Recent`, `Nothing found` while nothing matches) in a 320 × 400
/// box, eight cells to a row of 36 points; what the app heard as `log:…`,
/// the highlighted emoji as `highlighted:…`, the group at the top as
/// `group:…`. F5 scrolls to People, F6 focuses the picker, F7 logs the
/// matched count, F8 the entry of 👍.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let log = signal(Vec::<String>::new());
    let highlighted = signal(SharedString::from("none"));
    let group = signal(String::from("none"));
    let push = move |s: String| log.update(|l| l.push(s));
    let r = component_ref::<nsh_base::EmojiPicker>();
    let api = move |f: &dyn Fn(&EmojiPickerApi)| {
        if let Some(api) = r.api::<EmojiPickerApi>() {
            f(&api);
        }
    };
    on_key("f5", move |_| {
        api(&|a| a.scroll_to_group(EmojiGroupId::PeopleBody, Some(false)))
    });
    on_key("f6", move |_| api(&|a| a.focus()));
    on_key("f7", move |_| {
        api(&|a| push(format!("count={}", a.matched_count())));
    });
    on_key("f8", move |_| {
        api(&|a| {
            let e = a.entry("👍".into()).unwrap();
            push(format!(
                "entry={}|{}|{:?}|{}",
                e.label, e.version, e.group, e.has_skin_tones
            ));
        });
    });
    let mut labels = EmojiGroupLabels::default();
    labels.smileys_emotion = Some("Smileys".into());
    labels.people_body = Some("People".into());
    labels.recent = Some("Recent".into());
    let mut el = emoji_picker()
        .recent(props.recent.clone())
        .skin_tone(props.skin_tone)
        .annotations(props.annotations.clone())
        .group_labels(labels)
        .placeholder("Search emoji")
        .accessibility_label("Emoji")
        .empty(text("Nothing found"))
        .item_class("size-9")
        .on_select(move |e: &EmojiPickerEvent| {
            if let EmojiPickerEvent::Select(emoji, base, tone, label) = e {
                push(format!("select={emoji}|{base}|{tone:?}|{label}"));
            }
        })
        .on_cancel(move || push("cancel".into()))
        .on_highlight_change(move |e: &Option<EmojiEntry>| {
            highlighted.set(
                e.as_ref()
                    .map_or_else(|| "none".into(), |e| e.emoji.clone()),
            );
        })
        .on_group_change(move |g: &EmojiGroupId| group.set(format!("{g:?}")))
        .on_query_change(move |q: &SharedString| push(format!("query={q}")))
        .component_ref(&r)
        .w(px(320.0))
        .h(px(400.0));
    if let Some(groups) = props.groups.clone() {
        el = el.groups(groups);
    }
    if let Some(max) = props.emoji_version.clone() {
        el = el.emoji_version(max);
    }
    view()
        .child(el)
        .child(text(move || format!("log:{}", log.get().join(" "))))
        .child(text(move || format!("highlighted:{}", highlighted.get())))
        .child(text(move || format!("group:{}", group.get())))
}

fn launch(root: Root) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

fn start(props: HarnessProps) -> Headless {
    let mut app = launch(Root::new::<Harness>(move || props.clone()));
    app.wait_for("role:option").unwrap();
    app
}

fn key(app: &mut Headless, keys: &str) {
    app.press_key(keys).unwrap();
}

fn see(app: &mut Headless, text: &str) {
    app.wait_for(&format!("text:{text}")).unwrap();
}

fn log(app: &Headless) -> String {
    app.screen()
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("log:").map(str::to_owned))
        .unwrap_or_default()
}

fn log_ends(app: &mut Headless, end: &str) {
    let end = end.to_owned();
    let found = app.wait_until(
        &format!("the log ending with `{end}`"),
        Duration::from_secs(5),
        |s| {
            s.texts()
                .iter()
                .any(|t| t.starts_with("log:") && t.ends_with(end.as_str()))
        },
    );
    if let Err(e) = found {
        panic!("{e}; the log: {}", log(app));
    }
}

fn type_in(app: &mut Headless, text: &str) {
    app.type_text("text:Search emoji", text).unwrap();
}

#[test]
fn screen_readers_hear_a_list_box_of_emoji_by_name_under_named_groups() {
    let app = start(props());
    let screen = app.screen();
    assert_eq!(screen.count("role:listbox[Emoji]"), Ok(1));
    assert_eq!(screen.count("role:option[grinning face]"), Ok(1));
    assert!(screen.shows("Smileys"));
    assert!(screen.count("role:header").unwrap() >= 1);
    // Only the rows near the list are made.
    let made = screen.count("role:option").unwrap();
    assert!((8..200).contains(&made), "{made} cells made");
    assert!(!screen.shows("Nothing found"));
    // Browsing highlights nothing until a key or the pointer does.
    assert!(screen.shows("highlighted:none"));
}

#[test]
fn typing_filters_by_names_and_keywords_and_highlights_the_first_match() {
    let mut app = start(props());
    type_in(&mut app, "thumbs");
    app.wait_for_gone("role:option[grinning face]", Duration::from_secs(5))
        .unwrap();
    // 👍 and 👎, without headers: the short row's other places are
    // nothing to screen readers.
    assert_eq!(app.screen().count("role:option"), Ok(2));
    assert_eq!(app.screen().count("role:option[thumbs up]"), Ok(1));
    assert_eq!(app.screen().count("role:header"), Ok(0));
    see(&mut app, "highlighted:👍");
    // A keyword, not in the name.
    key(&mut app, "escape");
    type_in(&mut app, "cheerful");
    app.wait_for("role:option[grinning face]").unwrap();
    see(&mut app, "highlighted:😀");
    key(&mut app, "f7");
    log_ends(&mut app, "count=1");
    // Nothing.
    key(&mut app, "escape");
    type_in(&mut app, "zzzz");
    see(&mut app, "Nothing found");
    see(&mut app, "highlighted:none");
}

#[test]
fn the_keys_move_along_the_cells_and_down_the_columns() {
    let mut app = start(props());
    key(&mut app, "f6");
    key(&mut app, "down");
    see(&mut app, "highlighted:😀");
    key(&mut app, "right");
    see(&mut app, "highlighted:😃");
    key(&mut app, "left");
    see(&mut app, "highlighted:😀");
    // Eight to a row.
    key(&mut app, "down");
    see(&mut app, "highlighted:🙂");
    key(&mut app, "up");
    see(&mut app, "highlighted:😀");
    assert!(!log(&app).contains("select="), "moving chooses nothing");
    // While a query shows, Left and Right are the caret's.
    type_in(&mut app, "face");
    app.wait_for_gone("role:option[waving hand]", Duration::from_secs(1))
        .ok();
    let first = app
        .screen()
        .texts()
        .into_iter()
        .find(|t| t.starts_with("highlighted:"))
        .map(|t| t.to_string())
        .unwrap();
    key(&mut app, "right");
    app.wait(Duration::from_millis(50)).unwrap();
    assert!(app.shows(&first));
}

#[test]
fn return_and_a_press_choose_with_the_skin_tone() {
    let mut app = start(HarnessProps {
        skin_tone: EmojiSkinTone::Medium,
        ..props()
    });
    type_in(&mut app, "thumbs up");
    see(&mut app, "highlighted:👍🏽");
    key(&mut app, "enter");
    log_ends(&mut app, "select=👍🏽|👍|Medium|thumbs up");
    key(&mut app, "escape");
    app.press("role:option[grinning face]").unwrap();
    log_ends(&mut app, "select=😀|😀|Medium|grinning face");
}

#[test]
fn the_pointer_highlights_the_cell_it_moves_over() {
    let mut app = start(props());
    app.hover("role:option[upside-down face]").unwrap();
    see(&mut app, "highlighted:🙃");
}

#[test]
fn escape_clears_the_query_and_then_cancels() {
    let mut app = start(props());
    type_in(&mut app, "cat");
    log_ends(&mut app, "query=cat");
    key(&mut app, "escape");
    log_ends(&mut app, "query=cat query=");
    app.wait_for("role:option[grinning face]").unwrap();
    key(&mut app, "escape");
    log_ends(&mut app, "query= cancel");
}

#[test]
fn the_apps_recent_emoji_lead_and_its_annotations_name_them() {
    let mut app = start(HarnessProps {
        groups: None,
        recent: vec!["👍🏾".into(), "not an emoji".into(), "😂".into()],
        annotations: vec![EmojiAnnotation::new("😂", "笑哭").keywords(["哈哈"])],
        ..props()
    });
    see(&mut app, "Recent");
    assert_eq!(app.screen().count("role:option[笑哭]"), Ok(2));
    key(&mut app, "f6");
    key(&mut app, "down");
    see(&mut app, "highlighted:👍");
    key(&mut app, "right");
    see(&mut app, "highlighted:😂");
    // The app's words and English both match.
    type_in(&mut app, "哈哈");
    app.wait_for_gone("role:option[thumbs up]", Duration::from_secs(5))
        .unwrap();
    see(&mut app, "highlighted:😂");
    key(&mut app, "escape");
    type_in(&mut app, "tears of joy");
    see(&mut app, "highlighted:😂");
}

#[test]
fn groups_and_the_newest_version_choose_what_shows() {
    let mut app = start(HarnessProps {
        emoji_version: Some("15".into()),
        ..props()
    });
    // Melting face is 14, cracking face 18.
    type_in(&mut app, "melting");
    see(&mut app, "highlighted:🫠");
    key(&mut app, "escape");
    type_in(&mut app, "cracking face");
    see(&mut app, "Nothing found");
    // Groups not chosen are not searched either.
    key(&mut app, "escape");
    type_in(&mut app, "pizza");
    see(&mut app, "Nothing found");
}

#[test]
fn the_ref_scrolls_to_a_group_which_is_reported_and_looks_emoji_up() {
    let mut app = start(props());
    see(&mut app, "group:SmileysEmotion");
    key(&mut app, "f5");
    see(&mut app, "group:PeopleBody");
    app.wait_for("role:option[waving hand]").unwrap();
    key(&mut app, "f8");
    log_ends(&mut app, "entry=thumbs up|0.6|PeopleBody|true");
}

/// What a step sent: mount items, views made, views deleted.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Cost {
    items: usize,
    made: usize,
    deleted: usize,
}

#[test]
fn a_key_press_changes_the_cell_left_and_the_cell_reached_only() {
    let mut app = start(props());
    let counts = Arc::new([const { AtomicUsize::new(0) }; 3]);
    let into = counts.clone();
    app.observe(move |_, batch| {
        into[0].fetch_add(batch.items.len(), Ordering::Relaxed);
        for item in &batch.items {
            match item {
                MountItem::Create { .. } => into[1].fetch_add(1, Ordering::Relaxed),
                MountItem::Delete { .. } => into[2].fetch_add(1, Ordering::Relaxed),
                _ => 0,
            };
        }
    });
    key(&mut app, "f6");
    key(&mut app, "down");
    see(&mut app, "highlighted:😀");
    app.idle(Duration::from_millis(50)).unwrap();
    for c in counts.iter() {
        c.store(0, Ordering::Relaxed);
    }
    key(&mut app, "right");
    see(&mut app, "highlighted:😃");
    app.idle(Duration::from_millis(50)).unwrap();
    let cost = Cost {
        items: counts[0].load(Ordering::Relaxed),
        made: counts[1].load(Ordering::Relaxed),
        deleted: counts[2].load(Ordering::Relaxed),
    };
    assert_eq!((cost.made, cost.deleted), (0, 0), "{cost:?}");
    // The two cells' projected focus, and the harness's text.
    assert!(cost.items <= 4, "{cost:?}");
}
