//! A Rust component's images, web views and video on the engine: an
//! image of a crate's asset lays out at its natural size, the platform's
//! events reach the listeners decoded, the refs' commands reach their
//! views, and an inline page's HTML follows what it reads.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, MountBatch, MountItem, NativeProps, NodeId,
    PayloadValue, ViewKind, WebSource,
    element::{ImageAsset, ImageProgress, Root, VideoInfo, VideoProgress, WebNavigation},
    geometry::{DevicePixels, size},
    platform::ColorScheme,
    prelude::*,
};
use nsh_engine::{Engine, EngineConfig, Environment};

use crate::ChannelSink;

/// A 2× logo of 64 × 64 points, as `asset!` describes one.
const LOGO: ImageAsset = ImageAsset {
    url: "asset:/@app/logo@2x.png",
    size: nsh_core::geometry::Size {
        width: Points(64.0),
        height: Points(64.0),
    },
    scales: &[],
};

/// An image, an inline page and a video logging what they report, and
/// buttons driving the page and the video.
#[component]
fn Media() -> impl IntoElement {
    let log = signal(Vec::<String>::new());
    let note = move |line: String| log.update(|l| l.push(line));
    let page = element_ref();
    let player = element_ref();
    view()
        .flex_1()
        // Not stretched across the column: at its own size.
        .child(view().items_start().child(image(LOGO)))
        .child(
            image("https://example.com/photo.jpg")
                .size(px(40.0))
                .on_load_start(move |_: &()| note("image start".into()))
                .on_progress(move |p: &ImageProgress| {
                    note(format!("image {}/{}", p.loaded, p.total))
                })
                .on_load(move |s: &Size<Points>| {
                    note(format!("image {}x{}", s.width.0, s.height.0))
                })
                .on_error(move |m: &str| note(format!("image failed: {m}")))
                .on_load_end(move |_: &()| note("image end".into())),
        )
        .child(
            web_view_html(
                || format!("<body class={}>", if dark() { "dark" } else { "light" }),
                None,
            )
            .element_ref(&page)
            .h(px(100.0))
            .on_message(move |data: &str| note(format!("page: {data}")))
            .on_navigation_state_change(move |n: &WebNavigation| {
                note(format!(
                    "at {} {:?} loading {} back {}",
                    n.url, n.title, n.loading, n.can_go_back
                ))
            }),
        )
        .child(
            video("https://example.com/clip.mp4")
                .element_ref(&player)
                .h(px(100.0))
                .on_load(move |v: &VideoInfo| {
                    note(format!(
                        "video {} s {}x{}",
                        v.duration, v.size.width.0, v.size.height.0
                    ))
                })
                .on_progress(move |p: &VideoProgress| {
                    note(format!("played {}/{}", p.current_time, p.duration))
                })
                .on_buffer(move |b: &bool| note(format!("buffering {b}"))),
        )
        .child(text("Post").on_press(move |_: &()| page.post_message("hi")))
        .child(text("Back").on_press(move |_: &()| page.go_back()))
        .child(text("Restart").on_press(move |_: &()| player.seek(0.0)))
        .child(text(move || log.with(|l| l.join(" | "))))
}

/// What the platform was sent: the views made, texts, commands, image
/// sources and inline pages, by node.
#[derive(Default)]
struct Seen {
    created: Vec<(NodeId, ViewKind)>,
    texts: Vec<(NodeId, String)>,
    commands: Vec<(NodeId, Command)>,
    images: Vec<(NodeId, String, Option<Size<Points>>)>,
    frames: Vec<(NodeId, Size<Points>)>,
    html: Vec<String>,
}

impl Seen {
    /// Applies the batches until none comes for a moment.
    fn drain(&mut self, rx: &Receiver<MountBatch>) {
        while let Ok(batch) = rx.recv_timeout(Duration::from_millis(300)) {
            for item in batch.items {
                match item {
                    MountItem::Create { id, kind } => self.created.push((id, kind)),
                    MountItem::Text { id, text, .. } => {
                        self.texts.retain(|t| t.0 != id);
                        self.texts.push((id, text.text.clone()));
                    }
                    MountItem::Command { id, command } => self.commands.push((id, command)),
                    MountItem::Image {
                        id,
                        source: Some(source),
                        ..
                    } => self.images.push((id, source.uri.to_string(), source.size)),
                    MountItem::Frame { id, frame } => self.frames.push((id, frame.size)),
                    MountItem::NativeProps {
                        props: NativeProps::WebView(web),
                        ..
                    } => {
                        if let WebSource::Html { html, .. } = &web.source {
                            self.html.push(html.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    fn of(&self, kind: ViewKind) -> NodeId {
        self.created
            .iter()
            .find(|c| c.1 == kind)
            .unwrap_or_else(|| panic!("no {kind:?}: {:?}", self.created))
            .0
    }

    fn text(&self, text: &str) -> NodeId {
        self.texts
            .iter()
            .find(|t| t.1 == text)
            .unwrap_or_else(|| panic!("no {text}: {:?}", self.texts))
            .0
    }

    /// The log's last line.
    fn last(&self) -> &str {
        let log = &self.texts.last().expect("the log").1;
        log.rsplit(" | ").next().unwrap_or(log)
    }
}

fn start() -> (Engine, Receiver<MountBatch>, Seen) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let engine = Engine::start(
        EngineConfig::new(Root::of::<Media>()),
        || ApproxTextEngine,
        ChannelSink(tx),
    )
    .unwrap();
    let mut seen = Seen::default();
    seen.drain(&rx);
    (engine, rx, seen)
}

fn map(fields: &[(&'static str, PayloadValue)]) -> EventPayload {
    EventPayload::Map(fields.to_vec())
}

#[test]
fn an_asset_image_lays_out_at_its_natural_size() {
    let (_engine, _rx, seen) = start();
    let (logo, _, natural) = seen
        .images
        .iter()
        .find(|i| i.1 == LOGO.url)
        .expect("the logo's source")
        .clone();
    assert_eq!(natural, Some(size(px(64.0), px(64.0))));
    assert!(
        seen.frames
            .iter()
            .any(|&(id, s)| id == logo && s == size(px(64.0), px(64.0))),
        "{:?}",
        seen.frames
    );
}

#[test]
fn an_images_events_reach_its_listeners() {
    let (engine, rx, mut seen) = start();
    let photo = seen
        .images
        .iter()
        .find(|i| i.1 == "https://example.com/photo.jpg")
        .expect("the photo's source")
        .0;
    let control = engine.control();
    let mut send = |kind, payload, line: &str| {
        control.dispatch_event(photo, kind, payload);
        seen.drain(&rx);
        assert_eq!(seen.last(), line);
    };
    send(EventKind::LoadStart, EventPayload::None, "image start");
    send(
        EventKind::Progress,
        map(&[
            ("loaded", PayloadValue::Number(512.0)),
            ("total", PayloadValue::Number(1024.0)),
        ]),
        "image 512/1024",
    );
    send(
        EventKind::Load,
        EventPayload::Image(size(DevicePixels(300), DevicePixels(200))),
        "image 300x200",
    );
    send(
        EventKind::Error,
        EventPayload::Error {
            message: "not found".into(),
        },
        "image failed: not found",
    );
    send(EventKind::LoadEnd, EventPayload::None, "image end");
}

#[test]
fn web_views_and_videos_report_and_take_commands() {
    let (engine, rx, mut seen) = start();
    let (page, player) = (seen.of(ViewKind::WebView), seen.of(ViewKind::Video));
    let control = engine.control();
    let mut send = |id, kind, payload, line: &str| {
        control.dispatch_event(id, kind, payload);
        seen.drain(&rx);
        assert_eq!(seen.last(), line);
    };
    send(
        page,
        EventKind::Message,
        map(&[("data", PayloadValue::Str("hello from the page".into()))]),
        "page: hello from the page",
    );
    send(
        page,
        EventKind::NavigationStateChange,
        map(&[
            ("url", PayloadValue::Str("https://nsh.dev/docs/".into())),
            ("title", PayloadValue::Str("NSH".into())),
            ("loading", PayloadValue::Bool(true)),
            ("canGoBack", PayloadValue::Bool(true)),
            ("canGoForward", PayloadValue::Bool(false)),
        ]),
        "at https://nsh.dev/docs/ \"NSH\" loading true back true",
    );
    send(
        player,
        EventKind::Load,
        map(&[
            ("duration", PayloadValue::Number(5.0)),
            ("width", PayloadValue::Number(1280.0)),
            ("height", PayloadValue::Number(720.0)),
        ]),
        "video 5 s 1280x720",
    );
    send(
        player,
        EventKind::Progress,
        map(&[
            ("currentTime", PayloadValue::Number(1.5)),
            ("duration", PayloadValue::Number(5.0)),
        ]),
        "played 1.5/5",
    );
    send(
        player,
        EventKind::Buffer,
        map(&[("isBuffering", PayloadValue::Bool(true))]),
        "buffering true",
    );

    // The refs' commands go to their views.
    for label in ["Post", "Back", "Restart"] {
        control.dispatch_event(seen.text(label), EventKind::Press, EventPayload::None);
        seen.drain(&rx);
    }
    assert_eq!(
        seen.commands,
        [
            (page, Command::PostMessage("hi".into())),
            (page, Command::GoBack),
            (player, Command::Seek(0.0)),
        ]
    );
}

#[test]
fn an_inline_page_follows_what_its_html_reads() {
    let (engine, rx, mut seen) = start();
    assert_eq!(seen.html, ["<body class=light>"]);
    engine.control().set_environment(Environment {
        color_scheme: ColorScheme::Dark,
        ..Environment::default()
    });
    seen.drain(&rx);
    assert_eq!(seen.html, ["<body class=light>", "<body class=dark>"]);
}
