//! Image variants follow the pixel ratio: a surface at 3 mounts the `@3x`
//! file of an image with scales, and moving to 2 sends that image again
//! as `@2x`, alone, in one batch; images without scales are not sent.
//! `Image.getSize` and `Image.prefetch` ask for the variant the views load
//! at the surface's pixel ratio; `getSize` gives the imported file's size.

use std::time::Duration;

use crossbeam_channel::Receiver;
use nsh_core::{
    ApproxTextEngine, Command, EventKind, EventPayload, MountBatch, MountItem, NodeId,
    PayloadValue, ROOT_ID,
};
use nsh_engine::{Bundle, Engine, EngineConfig, Environment};

use crate::ChannelSink;

/// How long the engine may take to send what a test waits for: the first
/// frame starts QuickJS, which is slow in a debug build on a busy machine.
const WAIT: Duration = Duration::from_secs(5);

/// How long the engine must send nothing to be done with a change.
const QUIET: Duration = Duration::from_millis(300);

/// `app` (TSX), bundled, compiled and started on a surface at
/// `pixel_ratio`.
fn start(app: &str, pixel_ratio: f32) -> (Engine, Receiver<MountBatch>) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nsh-variants-{}-{}",
        std::process::id(),
        APPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    std::fs::write(&entry, app).unwrap();
    let bundle = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry,
        minify: false,
        split: false,
        ui_sets: Vec::new(),
    })
    .unwrap();
    let bytecode = nsh_js::compile_bytecode_with(&bundle.code, false, &[]).unwrap();
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        environment: Environment {
            pixel_ratio,
            ..Environment::default()
        },
        // SAFETY: compiled just now by this runtime.
        ..EngineConfig::new(nsh_engine::App::Js(unsafe { Bundle::bytecode(bytecode) }))
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// The first batch that comes within `wait`, and those that follow it
/// until the engine is quiet.
fn batches_within(rx: &Receiver<MountBatch>, wait: Duration) -> Vec<MountBatch> {
    let mut out = Vec::new();
    if let Ok(first) = rx.recv_timeout(wait) {
        out.push(first);
        while let Ok(batch) = rx.recv_timeout(QUIET) {
            out.push(batch);
        }
    }
    out
}

/// What the engine sends for a start or a change that sends something.
fn sent(rx: &Receiver<MountBatch>) -> Vec<MountBatch> {
    let batches = batches_within(rx, WAIT);
    assert!(!batches.is_empty(), "nothing sent within {WAIT:?}");
    batches
}

/// The image items of `batch`: node and source URI.
fn images(batch: &MountBatch) -> Vec<(NodeId, String)> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Image { id, source, .. } => Some((
                *id,
                source.as_ref().map_or(String::new(), |s| s.uri.to_string()),
            )),
            _ => None,
        })
        .collect()
}

const APP: &str = r#"import { mount, View } from "nsh";
import { Image } from "nsh";

const icon = { url: "asset:/img.png", size: { width: 40, height: 30 }, scales: [1, 2, 3] };
const single = { url: "asset:/single.png", size: { width: 10, height: 10 } };
const big = { url: "asset:/big.png", size: { width: 20, height: 20 }, scales: [1, 2, 4] };

mount(() => (
  <View>
    <Image src={icon} />
    <Image src={single} />
    <Image src={big} />
  </View>
));
"#;

#[test]
fn variant_repick_sends_only_the_images_whose_variant_changes() {
    let mut environment = Environment {
        pixel_ratio: 3.0,
        ..Environment::default()
    };
    let (engine, rx) = start(APP, environment.pixel_ratio);
    let first = sent(&rx);
    let mounted: Vec<_> = first.iter().flat_map(images).collect();
    let uris: Vec<&str> = mounted.iter().map(|(_, u)| u.as_str()).collect();
    assert_eq!(
        uris,
        [
            "asset:/img@3x.png",
            "asset:/single.png",
            "asset:/big@4x.png"
        ]
    );
    let icon = mounted[0].0;

    // 3 → 2: both scaled images go to `@2x`; `single` is not sent.
    environment.pixel_ratio = 2.0;
    engine.control().set_environment(environment);
    let after = sent(&rx);
    let changed: Vec<_> = after.iter().map(images).filter(|i| !i.is_empty()).collect();
    assert_eq!(changed.len(), 1, "one batch: {changed:?}");
    let mut sent_now = changed[0].clone();
    sent_now.sort();
    let big = sent_now[1].0;
    assert_eq!(
        sent_now,
        [
            (icon, "asset:/img@2x.png".to_owned()),
            (big, "asset:/big@2x.png".to_owned())
        ]
    );
    // No relayout: no frames moved.
    assert!(
        !after
            .iter()
            .flat_map(|b| &b.items)
            .any(|i| matches!(i, MountItem::Frame { .. })),
        "no relayout"
    );

    // 2 → 2.5: the smallest scale at least 2.5: `@3x` and `@4x`.
    environment.pixel_ratio = 2.5;
    engine.control().set_environment(environment);
    let mut sent_now: Vec<_> = sent(&rx).iter().flat_map(images).collect();
    sent_now.sort();
    assert_eq!(
        sent_now,
        [
            (icon, "asset:/img@3x.png".to_owned()),
            (big, "asset:/big@4x.png".to_owned())
        ]
    );

    // 2.5 → 3: neither pick changes, nothing is sent.
    environment.pixel_ratio = 3.0;
    engine.control().set_environment(environment);
    let sent_now: Vec<_> = batches_within(&rx, QUIET).iter().flat_map(images).collect();
    assert!(sent_now.is_empty(), "{sent_now:?}");
}

/// Many ratio changes keep the item count bounded: one image item per
/// image whose pick changed, each time.
#[test]
fn variant_repick_item_counts_stay_bounded() {
    let mut environment = Environment {
        pixel_ratio: 1.0,
        ..Environment::default()
    };
    let (engine, rx) = start(APP, environment.pixel_ratio);
    sent(&rx);
    for ratio in [2.0, 1.0, 2.0, 1.0, 3.0, 1.0] {
        environment.pixel_ratio = ratio;
        engine.control().set_environment(environment);
        let after = sent(&rx);
        let items: usize = after.iter().map(|b| b.items.len()).sum();
        let images = after.iter().flat_map(images).count();
        assert_eq!(images, 2, "at {ratio}: the icon and big");
        assert!(items <= 4, "at {ratio}: {items} items");
    }
}

const INFO_APP: &str = r#"import { mount, signal, Text } from "nsh";
import { Image } from "nsh";

const icon = { url: "asset:/img.png", size: { width: 40, height: 30 }, scales: [1, 2, 3] };
const shown = signal("waiting");
setTimeout(async () => {
  const size = await Image.getSize(icon);
  const plain = await Image.getSize({ url: "asset:/single.png", size: { width: 999, height: 999 } });
  const ready = await Image.prefetch(icon);
  shown.set(`${size.width}x${size.height} ${plain.width}x${plain.height} ${ready}`);
}, 0);

mount(() => <Text>{shown()}</Text>);
"#;

/// Answers every image request with its file's pixel size (the variant's
/// scale times 40x30 for `img`, 10x10 for `single`), until the app shows
/// its result: the URIs asked for and the text shown.
fn info(pixel_ratio: f32, variant_size: Option<(f64, f64)>) -> (Vec<String>, String) {
    let (engine, rx) = start(INFO_APP, pixel_ratio);
    let control = engine.control();
    let mut asked = Vec::new();
    let mut shown = String::new();
    while shown.is_empty() || shown == "waiting" {
        let Ok(batch) = rx.recv_timeout(WAIT) else {
            break;
        };
        for item in &batch.items {
            match item {
                MountItem::Command {
                    id: ROOT_ID,
                    command: Command::ImageInfo { id, uri },
                } => {
                    asked.push(uri.clone());
                    let scale = match uri.as_str() {
                        "asset:/img@2x.png" => 2.0,
                        "asset:/img@3x.png" => 3.0,
                        _ => 1.0,
                    };
                    let (w, h) = if uri.contains("single") {
                        (10.0, 10.0)
                    } else {
                        variant_size
                            .filter(|_| scale != 1.0)
                            .unwrap_or((40.0 * scale, 30.0 * scale))
                    };
                    control.dispatch_event(
                        ROOT_ID,
                        EventKind::ImageInfo,
                        EventPayload::Map(vec![
                            ("id", PayloadValue::Number(*id as f64)),
                            ("width", PayloadValue::Number(w)),
                            ("height", PayloadValue::Number(h)),
                        ]),
                    );
                }
                MountItem::Text { text, .. } => shown = text.text.clone(),
                _ => {}
            }
        }
    }
    (asked, shown)
}

#[test]
fn variant_info_get_size_and_prefetch_ask_for_the_picked_variant() {
    let (asked, shown) = info(3.0, None);
    assert_eq!(
        asked,
        [
            "asset:/img@3x.png",
            "asset:/single.png",
            "asset:/img@3x.png"
        ]
    );
    // The imported file's size, whatever variant was asked for.
    assert_eq!(shown, "40x30 10x10 true");

    let (asked, shown) = info(2.0, None);
    assert_eq!(asked[0], "asset:/img@2x.png");
    assert_eq!(shown, "40x30 10x10 true");

    let (asked, shown) = info(1.0, None);
    assert_eq!(asked[0], "asset:/img.png");
    assert_eq!(shown, "40x30 10x10 true");
}

/// A mismatched variant is a build warning: its decoded size must not
/// change getSize's result for the imported asset.
#[test]
fn variant_info_get_size_keeps_imported_dimensions_for_mismatched_variants() {
    for ratio in [1.0, 2.0, 3.0] {
        let (asked, shown) = info(ratio, Some((120.0, 90.0)));
        assert_eq!(shown, "40x30 10x10 true", "at pixel ratio {ratio}");
        assert_eq!(
            asked.len(),
            3,
            "getSize still loads the image before returning"
        );
    }
}

/// `src` and `placeholder` are names several elements take: each decodes
/// as its element's prop (an image's placeholder is an image, an input's a
/// text), and a web view's `src`, `html` and `baseUrl` make one source.
#[test]
fn shared_names_decode_as_their_elements_props() {
    use nsh_core::{NativeProps, WebSource, geometry::Points};
    const APP: &str = r#"import { mount, View, Video, WebView } from "nsh";
import { Input } from "nsh/base";
import { Image } from "nsh";

const logo = { url: "asset:/logo.png", size: { width: 10, height: 10 } };

mount(() => (
  <View>
    <Image src="https://example.com/a.png" placeholder={logo} />
    <Input placeholder="Name" />
    <Video src="https://example.com/a.mp4" />
    <WebView src="https://example.com/start" />
    <WebView baseUrl="https://example.com/" src="https://example.com/start" html="<p>Hi</p>" />
  </View>
));
"#;
    let (_engine, rx) = start(APP, 1.0);
    let mut placeholder = None;
    let mut input = None;
    let mut video = None;
    let mut web: Vec<(NodeId, WebSource)> = Vec::new();
    for batch in sent(&rx) {
        for item in batch.items {
            match item {
                MountItem::Image { options, .. } => {
                    placeholder = options.placeholder.map(|p| (p.uri.to_string(), p.size));
                }
                MountItem::Input { config, .. } => input = Some(config.placeholder.clone()),
                MountItem::NativeProps {
                    props: NativeProps::Video(v),
                    ..
                } => video = v.source.as_deref().map(str::to_owned),
                MountItem::NativeProps {
                    id,
                    props: NativeProps::WebView(w),
                } => {
                    web.retain(|(i, _)| *i != id);
                    web.push((id, w.source.clone()));
                }
                _ => {}
            }
        }
    }
    web.sort_by_key(|(id, _)| *id);
    assert_eq!(
        placeholder,
        Some((
            "asset:/logo.png".to_owned(),
            Some(nsh_core::geometry::size(Points(10.0), Points(10.0)))
        ))
    );
    assert_eq!(input.as_deref(), Some("Name"));
    assert_eq!(video.as_deref(), Some("https://example.com/a.mp4"));
    let sources: Vec<WebSource> = web.into_iter().map(|(_, s)| s).collect();
    assert_eq!(
        sources,
        [
            WebSource::Uri("https://example.com/start".into()),
            WebSource::Html {
                html: "<p>Hi</p>".into(),
                base_url: Some("https://example.com/".into()),
            },
        ]
    );
}

/// The image items of `batch` with their bytes: source URI and data.
fn inline_images(batch: &MountBatch) -> Vec<(String, Option<Vec<u8>>)> {
    batch
        .items
        .iter()
        .filter_map(|i| match i {
            MountItem::Image {
                source: Some(s), ..
            } => Some((s.uri.to_string(), s.data.as_ref().map(|d| d.to_vec()))),
            _ => None,
        })
        .collect()
}

/// `blob:` URLs hand the platform their blob's bytes, shared, and keep
/// them after the URL is revoked; `data:` URIs are decoded by the core and
/// go by a short key, a digest of their bytes.
#[test]
fn data_uris_and_blob_urls_carry_their_bytes() {
    const APP: &str = r#"import { mount, View, Image } from "nsh";

const blob = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: "image/png" });
const url = URL.createObjectURL(blob);
const revoked = URL.createObjectURL(new Blob([new Uint8Array([9])]));
URL.revokeObjectURL(revoked);

mount(() => (
  <View>
    <Image src={url} />
    <Image src="data:image/png;base64,iVBORw==" />
    <Image src="data:image/svg+xml,%3Csvg%3E" />
    <Image src={revoked} />
  </View>
));
URL.revokeObjectURL(url);
"#;
    let (_engine, rx) = start(APP, 1.0);
    let mounted: Vec<_> = sent(&rx).iter().flat_map(inline_images).collect();
    assert_eq!(mounted.len(), 4, "{mounted:?}");
    // A blob goes by a digest of its bytes, as a `data:` URI does.
    let (blob_uri, blob_bytes) = &mounted[0];
    assert!(
        blob_uri.starts_with("data:image/png;nsh-key="),
        "{blob_uri}"
    );
    assert_eq!(blob_bytes.as_deref(), Some(&[137, 80, 78, 71, 1, 2, 3][..]));
    let (png, png_bytes) = &mounted[1];
    assert!(png.starts_with("data:image/png;nsh-key="), "{png}");
    assert_eq!(png_bytes.as_deref(), Some(&[137, 80, 78, 71][..]));
    let (svg, svg_bytes) = &mounted[2];
    assert!(svg.starts_with("data:image/svg+xml;nsh-key="), "{svg}");
    assert_eq!(svg_bytes.as_deref(), Some(&b"<svg>"[..]));
    // A revoked URL names no bytes: the platform reports the error.
    let (revoked, revoked_bytes) = &mounted[3];
    assert!(revoked.starts_with("blob:"), "{revoked}");
    assert_eq!(revoked_bytes, &None);
}
