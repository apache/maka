//! Renderer benchmarks and DPI captures for the opaque clip-layer work
//! (PR #2931): `cargo test --release -p nsh-platform-windows capture -- --ignored --nocapture`.
//!
//! - `bench_clip_frames` times `draw_into` + `Flush` frames of a scroll-heavy
//!   scene (rounded `overflow: hidden` cards with text), whole frames and
//!   multi-rect partial ones.
//! - `capture_dpi_scales` writes `scene_<pct>.png` of the same scene rendered
//!   at 100% / 125% / 150% scale into `NSH_CAPTURE_DIR` (the temp dir by
//!   default).

use std::{sync::Arc, time::Instant};

use nsh_core::{AttributedText, ResolvedTextStyle, TextEngine, TextSpan};
use windows::Win32::Graphics::Direct2D::Common::D2D1_ALPHA_MODE_IGNORE;

use super::*;

/// Window size in DIPs; the pixel size is it times the scale.
const WIN: (f32, f32) = (560.0, 700.0);
/// Rounded `overflow: hidden` cards stacked in the scene.
const CARDS: usize = 22;

/// A target bitmap with `D2D1_ALPHA_MODE_IGNORE`, like a window back buffer.
fn opaque_bitmap(gfx: &Gfx, size: (u32, u32)) -> ID2D1Bitmap1 {
    let props = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_IGNORE,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    let size = D2D_SIZE_U {
        width: size.0,
        height: size.1,
    };
    // SAFETY: a COM call on the live context.
    unsafe { gfx.dc.CreateBitmap(size, None, 0, &props) }.unwrap()
}

/// Reads a bitmap's pixels back as BGRA rows.
fn pixels(gfx: &Gfx, bitmap: &ID2D1Bitmap1, size: (u32, u32)) -> Vec<u8> {
    let props = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_IGNORE,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: D2D1_BITMAP_OPTIONS_CPU_READ | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
        colorContext: std::mem::ManuallyDrop::new(None),
    };
    // SAFETY: COM calls on live bitmaps; the mapped memory is copied
    // before `Unmap`.
    unsafe {
        let cpu = gfx
            .dc
            .CreateBitmap(
                D2D_SIZE_U {
                    width: size.0,
                    height: size.1,
                },
                None,
                0,
                &props,
            )
            .unwrap();
        cpu.CopyFromBitmap(None, bitmap, None).unwrap();
        let mapped = cpu.Map(D2D1_MAP_OPTIONS_READ).unwrap();
        let mut out = Vec::with_capacity((size.0 * size.1 * 4) as usize);
        for row in 0..size.1 {
            let start = mapped.bits.add((row * mapped.pitch) as usize);
            out.extend_from_slice(std::slice::from_raw_parts(start, (size.0 * 4) as usize));
        }
        cpu.Unmap().unwrap();
        out
    }
}

fn laid_out(
    engine: &crate::text::DWriteTextEngine,
    s: &str,
    font_size: f32,
    color: Color,
) -> (
    std::sync::Arc<AttributedText>,
    nsh_core::TextLayout,
    Size<Points>,
) {
    let text = Arc::new(AttributedText {
        text: s.into(),
        spans: vec![TextSpan {
            start: 0,
            end: s.encode_utf16().count() as u32,
            style: ResolvedTextStyle {
                font_size: Points(font_size),
                color,
                ..Default::default()
            },
        }],
        ..Default::default()
    });
    let prepared = engine.prepare(&text);
    let measured = engine.measure(&prepared, None);
    let layout = engine.layout(&prepared, measured);
    (text, layout, measured)
}

/// A scroll-heavy scene: a header and `CARDS` rounded `overflow: hidden`
/// cards, each with a small Latin label and a small CJK line.
fn scene() -> Rc<Surface> {
    let surface = Surface::new(Default::default());
    let engine = crate::text::DWriteTextEngine::new(crate::text::ui_family());
    let panel = view(
        Some(&surface.root),
        2,
        ViewKind::View,
        rect(0.0, 0.0, WIN.0, WIN.1),
    );
    panel.state_mut().style.background_color = Color::rgba(246, 246, 248, 255);

    let next_id = std::cell::Cell::new(10 as NodeId);
    let text_view = |parent: &NshView,
                     engine: &crate::text::DWriteTextEngine,
                     s: &str,
                     at: (f32, f32),
                     size: f32,
                     color: Color| {
        let (text, layout, measured) = laid_out(engine, s, size, color);
        let tv = view(
            Some(parent),
            next_id.get(),
            ViewKind::Text,
            rect(at.0, at.1, measured.width.0, measured.height.0),
        );
        next_id.set(next_id.get() + 1);
        crate::text::set(&tv, &text, &layout, Bounds::new(Point::default(), measured));
    };

    text_view(
        &panel,
        &engine,
        "文本渲染 Text Clarity — 100% / 125% / 150%",
        (16.0, 14.0),
        15.0,
        Color::rgba(20, 20, 24, 255),
    );

    let ink = Color::rgba(40, 40, 46, 255);
    let dim = Color::rgba(110, 112, 120, 255);
    for i in 0..CARDS {
        let y = 52.0 + i as f32 * 28.0;
        let card = view(
            Some(&panel),
            next_id.get(),
            ViewKind::View,
            rect(12.0, y, WIN.0 - 24.0, 24.0),
        );
        next_id.set(next_id.get() + 1);
        {
            let mut s = card.state_mut();
            s.style.background_color = Color::rgba(255, 255, 255, 255);
            s.style.border_radius = Points(8.0);
            s.style.overflow_hidden = true;
            s.style.borders.widths = Edges::all(Points(1.0));
            s.style.borders.colors = [Color::rgba(0, 0, 0, 26); 4];
        }
        text_view(
            &card,
            &engine,
            &format!("{i:02} The quick brown fox 0123456789"),
            (10.0, 4.0),
            10.0,
            ink,
        );
        text_view(
            &card,
            &engine,
            &format!("小字号中文渲染效果 sample {i}"),
            (292.0, 4.0),
            10.0,
            dim,
        );
    }
    surface
}

/// Resizes `surface` to `WIN` DIPs at `scale` pixels per point and returns
/// the pixel size.
fn sized(surface: &Rc<Surface>, scale: f32) -> (u32, u32) {
    let pixels = (
        (WIN.0 * scale).round() as u32,
        (WIN.1 * scale).round() as u32,
    );
    surface.resized(pixels, scale);
    pixels
}

fn draw_frame(
    surface: &Rc<Surface>,
    gfx: &Gfx,
    back: &ID2D1Bitmap1,
    scale: f32,
    areas: Option<&[D2D_RECT_F]>,
) {
    draw_into(surface, gfx, back, scale, false, None, areas, None).unwrap();
    // A frame's commands are queued at EndDraw; a Flush inside a fresh
    // frame pushes them through, so the timing covers the rasterization.
    // SAFETY: COM calls bracketed by BeginDraw/EndDraw.
    unsafe {
        gfx.dc.BeginDraw();
        gfx.dc.Flush(None, None).unwrap();
        gfx.dc.EndDraw(None, None).unwrap();
    }
}

fn report(name: &str, times: &mut [f64]) {
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let p50 = times[times.len() / 2];
    let p95 = times[(times.len() * 95) / 100];
    eprintln!(
        "{name}: mean {mean:.3} ms, p50 {p50:.3} ms, p95 {p95:.3} ms ({} frames, {:.1} fps)",
        times.len(),
        1000.0 / mean
    );
}

/// Frame-time of a scroll-heavy scene with one rounded clip layer per card.
#[test]
#[ignore = "benchmark"]
fn bench_clip_frames() {
    let Ok(gfx) = gfx::get() else {
        return;
    };
    let scale: f32 = std::env::var("NSH_BENCH_SCALE")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1.25);
    let frames: usize = std::env::var("NSH_BENCH_FRAMES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(240);
    let surface = scene();
    let pixels = sized(&surface, scale);
    let back = opaque_bitmap(&gfx, pixels);

    // Whole frames (a scroll that redrew everything).
    draw_frame(&surface, &gfx, &back, scale, None);
    let mut whole = Vec::with_capacity(frames);
    for _ in 0..frames {
        let t = Instant::now();
        draw_frame(&surface, &gfx, &back, scale, None);
        whole.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    report(&format!("whole frame, scale {scale}"), &mut whole);

    // Partial frames of two areas (a scroll's damage), clipped through one
    // multi-rect layer.
    let (w, h) = (pixels.0 as f32, pixels.1 as f32);
    let areas = [
        rect_f(0.0, h * 0.2, w, h * 0.35),
        rect_f(0.0, h * 0.7, w, h * 0.3),
    ];
    draw_frame(&surface, &gfx, &back, scale, Some(&areas));
    let mut partial = Vec::with_capacity(frames);
    for _ in 0..frames {
        let t = Instant::now();
        draw_frame(&surface, &gfx, &back, scale, Some(&areas));
        partial.push(t.elapsed().as_secs_f64() * 1000.0);
    }
    report(&format!("partial frame, scale {scale}"), &mut partial);
}

/// PNGs of the scene at 100% / 125% / 150% scale, into `NSH_CAPTURE_DIR`.
#[test]
#[ignore = "captures images"]
fn capture_dpi_scales() {
    let Ok(gfx) = gfx::get() else {
        return;
    };
    let dir = std::env::var("NSH_CAPTURE_DIR")
        .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().into_owned());
    std::fs::create_dir_all(&dir).unwrap();
    for pct in [100u32, 125, 150] {
        let scale = pct as f32 / 100.0;
        let surface = scene();
        let pixels = sized(&surface, scale);
        let back = opaque_bitmap(&gfx, pixels);
        draw_frame(&surface, &gfx, &back, scale, None);
        let bgra = self::pixels(&gfx, &back, pixels);
        let mut rgba = bgra.clone();
        for px in rgba.as_chunks_mut::<4>().0 {
            px.swap(0, 2);
        }
        let path = format!("{dir}/scene_{pct}.png");
        image::save_buffer(
            &path,
            &rgba,
            pixels.0,
            pixels.1,
            image::ExtendedColorType::Rgba8,
        )
        .unwrap();
        eprintln!("wrote {path}");
    }
}
