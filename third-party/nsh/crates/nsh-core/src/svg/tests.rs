use std::{io::Write, path::PathBuf, time::Instant};

use super::*;

const ICON: &[u8] = include_bytes!("testdata/icon.svg");
const LOGO: &[u8] = include_bytes!("testdata/logo.svg");
const HALF_ALPHA: &[u8] = include_bytes!("testdata/half-alpha.svg");
const TEXT: &[u8] = include_bytes!("testdata/text.svg");

/// A red square that fills its 10 × 10 viewport.
const RED: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#f00"/></svg>"##;

fn pt(width: f32, height: f32) -> Size<Points> {
    Size::new(Points(width), Points(height))
}

fn pixel(raster: &Raster, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * raster.width + x) * 4) as usize;
    raster.pixels[i..i + 4].try_into().unwrap()
}

fn transparent(raster: &Raster) -> bool {
    raster.pixels.iter().all(|&b| b == 0)
}

fn svg(attrs: &str) -> Vec<u8> {
    format!(r#"<svg xmlns="http://www.w3.org/2000/svg" {attrs}><rect width="1" height="1"/></svg>"#)
        .into_bytes()
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

/// A directory of its own for one test's files.
fn scratch(test: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nsh-svg-{}-{test}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn svg_raster_sniffs_bytes_not_names() {
    assert!(sniff(ICON));
    assert!(
        sniff(LOGO),
        "XML declaration, comment and doctype before <svg"
    );
    assert!(sniff(b"\xEF\xBB\xBF  \n<svg/>"));
    assert!(sniff(b"<!DOCTYPE svg [ <!ENTITY a \"b>\"> ]><svg>"));
    assert!(sniff(&gzip(ICON)), ".svgz");
    assert!(!sniff(b"\x89PNG\r\n\x1a\n"));
    assert!(!sniff(b"\xFF\xD8\xFF\xE0"));
    assert!(!sniff(b"<html><svg></svg></html>"));
    assert!(!sniff(b"<svgx>"));
    assert!(!sniff(b"<?xml version=\"1.0\""));
    assert!(!sniff(b""));
    assert!(!sniff(&gzip(b"not an svg")));
}

#[test]
fn svg_raster_size_from_width_height_and_view_box() {
    assert_eq!(size(ICON).unwrap(), pt(24.0, 24.0), "viewBox only");
    assert_eq!(
        size(LOGO).unwrap(),
        pt(48.0, 24.0),
        "width/height win over the viewBox"
    );
    assert_eq!(
        size(&svg(r#"width="30" height="20""#)).unwrap(),
        pt(30.0, 20.0)
    );
    assert_eq!(
        size(&svg(r#"width="10.5" height="10""#)).unwrap(),
        pt(10.5, 10.0),
        "fractions kept"
    );
    assert_eq!(
        size(&svg(r#"width="30px" height="1in""#)).unwrap(),
        pt(30.0, 96.0),
        "CSS units"
    );
    // One side alone takes the other from the viewBox's aspect ratio.
    assert_eq!(
        size(&svg(r#"width="16" viewBox="0 0 32 64""#)).unwrap(),
        pt(16.0, 32.0)
    );
    assert_eq!(
        size(&svg(r#"height="10" viewBox="0 0 32 64""#)).unwrap(),
        pt(5.0, 10.0)
    );
    assert_eq!(
        size(&svg(r#"width="0.25in" viewBox="0,0,1,2""#)).unwrap(),
        pt(24.0, 48.0)
    );
    assert_eq!(
        size(&svg(r#"height="1e1px" viewBox="0 0 2 1""#)).unwrap(),
        pt(20.0, 10.0)
    );
    // A relative unit, which usvg resolves (12 points a font size).
    assert_eq!(
        size(&svg(r#"width="2em" viewBox="0 0 32 64""#)).unwrap(),
        pt(24.0, 48.0)
    );
    let doc = br##"<svg xmlns="http://www.w3.org/2000/svg" width="16" viewBox="0 0 32 64"><rect width="32" height="64" fill="#f00"/></svg>"##;
    let one_side = rasterize(doc, 32).unwrap();
    assert_eq!((one_side.width, one_side.height), (16, 32));
    assert_eq!(
        pixel(&one_side, 0, 0),
        [255, 0, 0, 255],
        "the drawing fills the box"
    );
    assert_eq!(pixel(&one_side, 15, 31), [255, 0, 0, 255]);
}

#[test]
fn svg_raster_one_side_in_absolute_units() {
    fn side(value: &str) -> OneSide<'_> {
        OneSide {
            width: true,
            value,
            view_box: (1.0, 1.0),
            at: 0,
        }
    }
    assert_eq!(side("16").points(), Some(16.0));
    assert_eq!(side(" 30px ").points(), Some(30.0));
    assert_eq!(side("0.5in").points(), Some(48.0));
    assert_eq!(side("12pt").points(), Some(16.0));
    assert_eq!(side("1pc").points(), Some(16.0));
    assert_eq!(side("2em").points(), None);
    assert_eq!(side("3ex").points(), None);
    assert_eq!(side("inf").points(), None);
    assert_eq!(side("px").points(), None);
    assert_eq!(side(&"9".repeat(64)).points(), None);
}

#[test]
fn svg_raster_size_percentages() {
    assert_eq!(
        size(&svg(r#"width="50%" height="100%" viewBox="0 0 24 12""#)).unwrap(),
        pt(12.0, 12.0)
    );
    assert_eq!(
        size(&svg(r#"width="100%" height="25%" viewBox="0 0 8 8""#)).unwrap(),
        pt(8.0, 2.0)
    );
    // Without a viewBox, percentages and a missing size fall back to the
    // extent of what the SVG draws, from its origin.
    let drawing = |attrs: &str| {
        format!(r#"<svg xmlns="http://www.w3.org/2000/svg" {attrs}><rect x="2" y="3" width="20" height="10"/></svg>"#)
            .into_bytes()
    };
    assert_eq!(
        size(&drawing(r#"width="100%" height="100%""#)).unwrap(),
        pt(22.0, 13.0)
    );
    assert_eq!(size(&drawing("")).unwrap(), pt(22.0, 13.0));
}

#[test]
fn svg_raster_reported_size_is_whole_points() {
    let reported = |w, h| {
        let s = reported_size(pt(w, h));
        (s.width.0, s.height.0)
    };
    assert_eq!(reported(24.0, 24.0), (24, 24));
    assert_eq!(reported(10.5, 10.4), (11, 10));
    assert_eq!(reported(0.2, 3.0), (1, 3), "at least a point");
    assert_eq!(reported(1e30, 2.0), (i32::MAX, 2), "never wraps");
}

#[test]
fn svg_raster_dimensions_fit_the_longest_side() {
    let logo = rasterize(LOGO, 96).unwrap();
    assert_eq!(
        (logo.width, logo.height, logo.size),
        (96, 48, pt(48.0, 24.0))
    );
    assert_eq!(logo.pixels.len(), 96 * 48 * 4);
    let small = rasterize(LOGO, 10).unwrap();
    assert_eq!((small.width, small.height), (10, 5));
    let icon = rasterize(ICON, 54).unwrap();
    assert_eq!((icon.width, icon.height), (54, 54));
    let tall = rasterize(&svg(r#"viewBox="0 0 1 100""#), 50).unwrap();
    assert_eq!(
        (tall.width, tall.height),
        (1, 50),
        "never narrower than a pixel"
    );
    // Colours land where the SVG puts them.
    assert_eq!(pixel(&logo, 10, 10), [255, 0, 0, 255]);
    assert_eq!(pixel(&logo, 80, 40), [0, 0, 255, 255]);
}

#[test]
fn svg_raster_pixel_budget_clamps() {
    let fit = |w: f32, h: f32, longest: f32, max_side| {
        raster_size(usvg::Size::from_wh(w, h).unwrap(), longest, max_side).unwrap()
    };
    assert_eq!(fit(24.0, 24.0, 54.0, MAX_SIDE), (54, 54));
    // Square: the pixel budget decides before the side does.
    assert_eq!(fit(24.0, 24.0, u32::MAX as f32, MAX_SIDE), (4096, 4096));
    // 4:1 at the longest side fills the budget exactly.
    assert_eq!(fit(400.0, 100.0, 1e9, MAX_SIDE), (8192, 2048));
    // Wide: the side decides.
    assert_eq!(fit(100.0, 1.0, 1e9, MAX_SIDE), (8192, 82));
    assert_eq!(fit(1e30, 1.0, 1e9, MAX_SIDE), (8192, 1));
    assert_eq!(fit(24.0, 24.0, 1e9, MAX_OVERSAMPLED_SIDE), (2048, 2048));
    for (w, h) in [(3.0, 2.0), (1000.0, 999.0), (7.0, 13.0), (1e6, 3.0)] {
        let (width, height) = fit(w, h, f32::MAX, MAX_SIDE);
        assert!(
            u64::from(width) * u64::from(height) <= u64::from(MAX_PIXELS),
            "{w}×{h}: {width}×{height}"
        );
        assert!(width <= MAX_SIDE && height <= MAX_SIDE);
    }
    assert_eq!(
        raster_size(usvg::Size::from_wh(1.0, 1.0).unwrap(), 0.0, MAX_SIDE),
        Err(Error::NoPixels)
    );
    let capped = rasterize(&svg(r#"viewBox="0 0 100 1""#), u32::MAX).unwrap();
    assert_eq!((capped.width, capped.height), (MAX_SIDE, 82));
}

#[test]
fn svg_raster_covering() {
    // A 2:1 logo for a view 96 pixels on its longer side: 96 tall, so a
    // square view's `cover` (96 × 96 of it) shows it unscaled.
    let logo = rasterize_covering(LOGO, 96).unwrap();
    assert_eq!((logo.width, logo.height), (192, 96));
    let tall = rasterize_covering(&svg(r#"viewBox="0 0 10 40""#), 30).unwrap();
    assert_eq!((tall.width, tall.height), (30, 120));
    assert_eq!(
        rasterize_covering(ICON, 54).unwrap().width,
        54,
        "square: as rasterize"
    );
    let capped = rasterize_covering(&svg(r#"viewBox="0 0 100 1""#), 1000).unwrap();
    assert_eq!(capped.width, MAX_SIDE);
    assert_eq!(rasterize_covering(ICON, 0), Err(Error::NoPixels));
}

#[test]
fn svg_raster_scaled() {
    let logo = rasterize_scaled(LOGO, 2.0).unwrap();
    assert_eq!((logo.width, logo.height), (96, 48));
    let icon = rasterize_scaled(ICON, 2.625).unwrap();
    assert_eq!((icon.width, icon.height), (63, 63));
    assert_eq!(rasterize_scaled(ICON, 0.0), Err(Error::NoPixels));
    assert_eq!(rasterize_scaled(ICON, f32::NAN), Err(Error::NoPixels));
}

#[test]
fn svg_raster_oversampled() {
    let icon = rasterize_oversampled(ICON).unwrap();
    assert_eq!((icon.width, icon.height), (96, 96));
    let big = rasterize_oversampled(&svg(r#"width="1000" height="500""#)).unwrap();
    assert_eq!(
        (big.width, big.height),
        (MAX_OVERSAMPLED_SIDE, MAX_OVERSAMPLED_SIDE / 2)
    );
}

#[test]
fn svg_raster_premultiplied_alpha() {
    let raster = rasterize(HALF_ALPHA, 10).unwrap();
    let [r, g, b, a] = pixel(&raster, 5, 5);
    assert!((127..=128).contains(&a), "alpha {a}");
    assert_eq!((r, g, b), (a, 0, 0), "red is premultiplied by alpha");
}

#[test]
fn svg_raster_svgz() {
    let raster = rasterize(&gzip(LOGO), 96).unwrap();
    assert_eq!(raster, rasterize(LOGO, 96).unwrap());
    assert_eq!(size(&gzip(LOGO)).unwrap(), pt(48.0, 24.0));
}

#[test]
fn svg_raster_invalid_data_is_an_error() {
    for bytes in [
        &b""[..],
        b"not an svg",
        b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR",
        b"\xff\xfe<\0s\0v\0g\0",
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect",
        b"<html/>",
        &[0x1f, 0x8b, 0x08, 0x00, 0x01],
    ] {
        assert!(matches!(size(bytes), Err(Error::Invalid(_))), "{bytes:?}");
        assert!(
            matches!(rasterize(bytes, 24), Err(Error::Invalid(_))),
            "{bytes:?}"
        );
    }
    let flat = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"0\" height=\"10\"/>";
    assert_eq!(size(flat), Err(Error::NoArea));
    assert_eq!(rasterize(ICON, 0), Err(Error::NoPixels));
    for error in [
        rasterize(b"x", 1).unwrap_err(),
        Error::NoArea,
        Error::NoPixels,
        Error::TooLarge,
        Error::OverBudget { pixels: 1 },
        Error::TooManyNodes,
        Error::Panicked,
    ] {
        assert!(!error.to_string().is_empty());
    }
    assert!(
        Error::NoArea.to_string().starts_with("the SVG has no area"),
        "not an invalid SVG"
    );
}

/// `cargo test --release -p nsh-core --features svg bench_svg_icon -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_svg_icon() {
    rasterize(ICON, 54).unwrap();
    let best = (0..20)
        .map(|_| {
            let start = Instant::now();
            rasterize(ICON, 54).unwrap();
            start.elapsed()
        })
        .min()
        .unwrap();
    eprintln!("24×24 icon at 54 px: {best:?}");
}

/// The SVG files the safety tests reference, holding a red square that would
/// show if the reference were followed.
fn sentinel(test: &str) -> PathBuf {
    let path = scratch(test).join("sentinel.svg");
    std::fs::write(&path, RED).unwrap();
    path
}

fn image_href(href: &str) -> Vec<u8> {
    format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="10" height="10"><image width="10" height="10" href="{href}"/><image width="10" height="10" xlink:href="{href}"/></svg>"#
    )
    .into_bytes()
}

#[test]
fn svg_safety_file_hrefs_are_not_read() {
    let path = sentinel("file");
    let absolute = image_href(path.to_str().unwrap());
    // usvg's own options would read the file: the test would see a read.
    let tree = usvg::Tree::from_data(&absolute, &usvg::Options::default()).unwrap();
    let mut pixmap = tiny_skia::Pixmap::new(10, 10).unwrap();
    resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
    assert_eq!(
        pixmap.pixel(5, 5).unwrap().alpha(),
        255,
        "the sentinel is readable"
    );

    assert!(
        transparent(&rasterize(&absolute, 10).unwrap()),
        "absolute path"
    );
    let file_url = image_href(&format!("file://{}", path.display()));
    assert!(transparent(&rasterize(&file_url, 10).unwrap()), "file URL");
    // A relative path resolves against nothing: there is no resources
    // directory, and the resolver ignores one even where it is set.
    let dir = path.parent().unwrap();
    let relative = image_href("sentinel.svg");
    let in_dir = |options: usvg::Options<'static>| {
        let options = usvg::Options {
            resources_dir: Some(dir.into()),
            ..options
        };
        parse_with(&relative, &options)
            .unwrap()
            .root()
            .has_children()
    };
    assert!(
        in_dir(usvg::Options::default()),
        "the sentinel is reachable relatively"
    );
    assert!(!in_dir(options()), "the resolver reads nothing");
    assert!(
        transparent(&rasterize(&relative, 10).unwrap()),
        "relative path"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn svg_safety_urls_resolve_nothing() {
    use std::fmt::Write as _;
    let mut encoded = String::new();
    // Percent-encoded, so the test needs no base64 encoder.
    for b in RED.bytes() {
        write!(encoded, "%{b:02X}").unwrap();
    }
    for href in [
        "http://127.0.0.1:9/a.svg".to_owned(),
        "https://127.0.0.1:9/a.svg".to_owned(),
        format!("data:image/svg+xml,{encoded}"),
        format!("data:text/plain,{encoded}"),
    ] {
        let raster = rasterize(&image_href(&href), 10).unwrap();
        assert!(transparent(&raster), "{href}");
    }
}

#[test]
fn svg_safety_external_use_resolves_nothing() {
    let path = sentinel("use");
    let doc = format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><use href="{}#r"/><use href="sentinel.svg#r"/></svg>"##,
        path.display()
    );
    assert!(transparent(&rasterize(doc.as_bytes(), 10).unwrap()));
    let _ = std::fs::remove_dir_all(path.parent().unwrap());
}

#[test]
fn svg_safety_svgz_inflation_is_bounded() {
    // Spaces compress about a thousandfold: a small file, a huge document.
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder
        .write_all(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><!--")
        .unwrap();
    let spaces = vec![b' '; 1 << 20];
    for _ in 0..(MAX_BYTES >> 20) + 1 {
        encoder.write_all(&spaces).unwrap();
    }
    encoder.write_all(b"--></svg>").unwrap();
    let bomb = encoder.finish().unwrap();
    assert!(bomb.len() < MAX_BYTES / 100, "{} bytes", bomb.len());
    assert_eq!(size(&bomb), Err(Error::TooLarge));
    assert_eq!(rasterize(&bomb, 24), Err(Error::TooLarge));
}

#[test]
fn svg_safety_documents_are_bounded() {
    let mut doc = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--"#.to_vec();
    doc.resize(MAX_BYTES - 9, b' ');
    doc.extend_from_slice(b"--></svg>");
    assert_eq!(size(&doc).unwrap(), pt(1.0, 1.0), "at the limit");
    doc.insert(doc.len() - 9, b' ');
    assert_eq!(size(&doc), Err(Error::TooLarge));
}

#[test]
fn svg_safety_nested_layers_are_refused() {
    // Each group with opacity is a layer as large as its content (at most
    // 5 × the raster each way), and nested ones coexist.
    let depth = 40;
    let bomb = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">{}<rect width="1e5" height="1e5"/>{}</svg>"#,
        r#"<g opacity=".9">"#.repeat(depth),
        "</g>".repeat(depth)
    );
    assert!(bomb.len() < 1000, "{} bytes", bomb.len());
    let start = Instant::now();
    assert!(matches!(
        rasterize(bomb.as_bytes(), 2048),
        Err(Error::OverBudget { .. })
    ));
    assert!(matches!(
        rasterize_oversampled(bomb.as_bytes()),
        Err(Error::OverBudget { .. })
    ));
    // At a small size the same document is cheap, and draws.
    rasterize(bomb.as_bytes(), 16).unwrap();
    // As deep, with content inside the canvas: each layer is the canvas.
    let canvas = bomb.replace("1e5", "512");
    let error = rasterize(canvas.as_bytes(), 2048).unwrap_err();
    assert!(matches!(error, Error::OverBudget { .. }), "{error}");
    rasterize(canvas.as_bytes(), 64).unwrap();
    log::info!("layer bombs refused in {:?}", start.elapsed());
}

#[test]
fn svg_safety_huge_filters_and_patterns_are_refused() {
    let doc = |defs: &str, body: &str| {
        format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs>{defs}</defs>{body}</svg>"#
        )
    };
    let refused = |doc: String| {
        assert!(doc.len() < 1000, "{} bytes", doc.len());
        let error = rasterize(doc.as_bytes(), 100).unwrap_err();
        assert!(matches!(error, Error::OverBudget { .. }), "{error}: {doc}");
    };
    // A filter region is not clamped to the canvas, and every primitive's
    // result stays until the filter ends.
    refused(doc(
        r#"<filter id="f" filterUnits="userSpaceOnUse" x="-1e5" y="-1e5" width="2e5" height="2e5"><feFlood/><feFlood/></filter>"#,
        r#"<rect width="10" height="10" filter="url(#f)"/>"#,
    ));
    // A pattern's tile is not clamped either.
    refused(doc(
        r#"<pattern id="p" patternUnits="userSpaceOnUse" width="1e5" height="1e5"><rect width="1" height="1"/></pattern>"#,
        r#"<rect width="10" height="10" fill="url(#p)"/>"#,
    ));
    // A filter on a normal canvas draws.
    let blur = doc(
        r#"<filter id="b"><feGaussianBlur stdDeviation="1"/></filter>"#,
        r#"<rect width="10" height="10" filter="url(#b)"/>"#,
    );
    assert!(!transparent(&rasterize(blur.as_bytes(), 100).unwrap()));
}

#[test]
fn svg_safety_drawings_visiting_too_many_nodes_are_refused() {
    // Each pattern fills two squares with the next: drawing one square
    // draws 2^24 of the last.
    let patterns: String = (0..24)
        .map(|i| {
            let next = format!(r#"<rect width="1" height="1" fill="url(#p{})"/>"#, i + 1);
            format!(
                r#"<pattern id="p{i}" patternUnits="userSpaceOnUse" width="1" height="1">{next}{next}</pattern>"#
            )
        })
        .collect();
    let doc = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><defs>{patterns}<pattern id="p24" width="1" height="1"><rect width="1" height="1"/></pattern></defs><rect width="10" height="10" fill="url(#p0)"/></svg>"#
    );
    assert_eq!(rasterize(doc.as_bytes(), 10), Err(Error::TooManyNodes));
}

#[test]
fn svg_safety_text_is_not_drawn() {
    let raster = rasterize(TEXT, 40).unwrap();
    assert!(transparent(&raster));
    assert_eq!(raster.size, pt(40.0, 20.0));
}

/// What a drawing of an SVG ([`drawing`]) fills and strokes, painted for a
/// box of `size` with text color `current`: each paint with the operations
/// before it (the state it draws with).
mod as_drawing {
    use super::*;
    use crate::{
        canvas::{
            CanvasOp, Drawing, FillRule, GradientShape, Num, Paint, PathOp, ViewPaint,
            point_in_path,
        },
        geometry::{Point, point, px},
        style::{Color, PaintStyle},
    };

    const GREEN: Color = Color(0x00ff_00ff);

    fn paint(drawing: &Drawing, size: Size<Points>) -> Drawing {
        drawing.painted(&PaintStyle::default(), GREEN, Color::TRANSPARENT, &[], size)
    }

    /// The paint of each shape, in order: `(fill or stroke style, the
    /// operations up to the shape, its path)`.
    fn shapes(drawing: &Drawing) -> Vec<(Paint, &[CanvasOp], &[PathOp])> {
        let (mut fill, mut stroke) = (None, None);
        let mut out = Vec::new();
        for (i, op) in drawing.ops.iter().enumerate() {
            match op {
                CanvasOp::FillStyle(p) => fill = Some(p.clone()),
                CanvasOp::StrokeStyle(p) => stroke = Some(p.clone()),
                CanvasOp::Fill(Some(path), _) => {
                    out.push((fill.clone().unwrap(), &drawing.ops[..i], &path[..]))
                }
                CanvasOp::Stroke(Some(path)) => {
                    out.push((stroke.clone().unwrap(), &drawing.ops[..i], &path[..]))
                }
                _ => {}
            }
        }
        out
    }

    fn inside(ops: &[CanvasOp], path: &[PathOp], x: f32, y: f32) -> bool {
        point_in_path(ops, Some(path), FillRule::NonZero, at(x, y), |_| 0.0)
    }

    fn at(x: f32, y: f32) -> Point<Points> {
        point(px(x), px(y))
    }

    /// An icon stroked with `currentColor` takes the view's text color,
    /// whatever it is when drawn; its own colors stay.
    #[test]
    fn svg_drawing_current_color_is_the_text_color() {
        let icon = r##"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="2"/><rect width="4" height="4" fill="#0000ff"/></svg>"##;
        let d = drawing(icon).unwrap();
        assert!(
            d.view_paints
                .iter()
                .any(|(_, v)| *v == ViewPaint::StrokeCurrentColor)
        );
        let painted = paint(&d, pt(24.0, 24.0));
        let paints: Vec<_> = shapes(&painted).into_iter().map(|s| s.0).collect();
        assert_eq!(
            paints,
            [Paint::Color(GREEN), Paint::Color(Color(0x0000_ffff))]
        );
        assert!(painted.ops.contains(&CanvasOp::LineWidth(Num::Const(2.0))));
        // A `color` of the document's own is what its `currentColor` is.
        let own = drawing(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" color="#ff0000"><rect width="4" height="4" fill="currentColor"/></svg>"##,
        )
        .unwrap();
        assert_eq!(
            shapes(&painted_of(&own))[0].0,
            Paint::Color(Color(0xff00_00ff))
        );
    }

    fn painted_of(d: &Drawing) -> Drawing {
        paint(d, d.fit().unwrap().size)
    }

    /// Gradients are drawn as gradients, in the shape's coordinates
    /// (`objectBoundingBox` included), with their stops' opacity.
    #[test]
    fn svg_drawing_keeps_gradients() {
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <defs>
              <linearGradient id="l"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#0000ff" stop-opacity="0.5"/></linearGradient>
              <radialGradient id="r" cx="50" cy="50" r="40" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
            </defs>
            <rect x="10" y="0" width="80" height="20" fill="url(#l)"/>
            <circle cx="50" cy="50" r="40" fill="url(#r)"/>
          </svg>"##;
        let painted = painted_of(&drawing(svg).unwrap());
        let shapes = shapes(&painted);
        let Paint::Gradient(linear) = &shapes[0].0 else {
            panic!("{:?}", shapes[0].0)
        };
        let GradientShape::Linear { start, end } = linear.shape else {
            panic!("{linear:?}")
        };
        // From the box's left edge to its right one.
        assert!((start.x.0 - 10.0).abs() < 1e-3 && (end.x.0 - 90.0).abs() < 1e-3);
        assert!((start.y.0 - end.y.0).abs() < 1e-3);
        assert_eq!(
            linear
                .stops
                .iter()
                .map(|(o, c)| (o.0, *c))
                .collect::<Vec<_>>(),
            [(0.0, Color(0xff00_00ff)), (1.0, Color(0x0000_ff80))]
        );
        let Paint::Gradient(radial) = &shapes[1].0 else {
            panic!("{:?}", shapes[1].0)
        };
        assert_eq!(
            radial.shape,
            GradientShape::Radial {
                start: at(50.0, 50.0),
                start_radius: Points::ZERO,
                end: at(50.0, 50.0),
                end_radius: px(40.0),
            }
        );
    }

    /// The view box is fitted into the canvas's box as
    /// `preserveAspectRatio` says: in the middle by default, stretched by
    /// `none`, covering it by `slice`; the canvas's natural size is the
    /// SVG's `width` and `height`.
    #[test]
    fn svg_drawing_fits_its_view_box_into_the_box() {
        let tall = |aspect: &str| {
            drawing(&format!(
                r##"<svg xmlns="http://www.w3.org/2000/svg" width="5" height="10" viewBox="0 0 10 20" {aspect}><rect width="10" height="20"/></svg>"##
            ))
            .unwrap()
        };
        let meet = tall("");
        assert_eq!(meet.fit().unwrap().size, pt(5.0, 10.0));
        let painted = paint(&meet, pt(40.0, 40.0));
        let (_, ops, path) = shapes(&painted)[0];
        // 20 × 40 in the middle of 40 × 40.
        assert!(inside(ops, path, 11.0, 1.0) && inside(ops, path, 29.0, 39.0));
        assert!(!inside(ops, path, 9.0, 20.0) && !inside(ops, path, 31.0, 20.0));
        let painted = painted_of(&tall(r#"preserveAspectRatio="none""#));
        let (_, ops, path) = shapes(&painted)[0];
        assert!(inside(ops, path, 4.9, 9.9) && !inside(ops, path, 5.1, 5.0));
        let stretched = drawing(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" preserveAspectRatio="none"><rect width="10" height="20"/></svg>"##,
        )
        .unwrap();
        let painted = paint(&stretched, pt(40.0, 40.0));
        let (_, ops, path) = shapes(&painted)[0];
        assert!(inside(ops, path, 1.0, 1.0) && inside(ops, path, 39.0, 39.0));
        // Sliced: 40 × 80 from 20 above the top; its top left quarter is
        // a red square, the rest blue.
        let sliced = drawing(
            r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 20" preserveAspectRatio="xMinYMid slice"><rect width="10" height="20" fill="#00f"/><rect width="5" height="10" fill="#f00"/></svg>"##,
        )
        .unwrap();
        let painted = paint(&sliced, pt(40.0, 40.0));
        let (_, ops, red) = shapes(&painted)[1];
        assert!(inside(ops, red, 19.0, 19.0) && !inside(ops, red, 21.0, 19.0));
        assert!(!inside(ops, red, 19.0, 21.0));
        // A `width` and `height` beside the view box scale what usvg
        // draws; the drawing stays in the view box's coordinates.
        let big = drawing(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"><rect width="12" height="12"/></svg>"##,
        )
        .unwrap();
        assert_eq!(big.fit().unwrap().size, pt(48.0, 48.0));
        let painted = paint(&big, pt(24.0, 24.0));
        let (_, ops, path) = shapes(&painted)[0];
        assert!(inside(ops, path, 11.0, 11.0) && !inside(ops, path, 13.0, 5.0));
    }

    /// A document that is no SVG fails as the rasters do.
    #[test]
    fn svg_drawing_of_no_svg_fails() {
        assert!(matches!(drawing("<html/>"), Err(Error::Invalid(_))));
        assert!(drawing("not xml").is_err());
    }
}
