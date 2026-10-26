//! `nsh/canvas` end to end: what a `draw` records (the generated methods and
//! properties, and the hand-written ones) as the core decodes it.

use std::time::Duration;

use nsh_core::{
    ApproxTextEngine, MountBatch, MountItem, Size,
    canvas::{CanvasOp, Drawing, LineCap, Num, PathOp},
    geometry::px,
};
use nsh_engine::{Bundle, Engine, EngineConfig};

use crate::ChannelSink;

const APP: &str = r##"import { mount } from "nsh";
import { Canvas, Path2D } from "nsh";

mount(
  () => (
    <Canvas
      style={{ width: 100, height: 50 }}
      draw={(cx, size) => {
        cx.save();
        cx.lineWidth = 3;
        cx.lineCap = "round";
        cx.translate(size.width / 2, 0);
        cx.beginPath();
        cx.moveTo(1, 2);
        cx.lineTo(3, 4);
        cx.arc(5, 6, 7, 0, 1);
        cx.roundRect(0, 0, 10, 10, [2, 4]);
        cx.closePath();
        cx.stroke();
        cx.restore();
        // Restored: the state's value again.
        if (cx.lineWidth !== 1) throw new Error(`lineWidth ${cx.lineWidth}`);
        cx.fillStyle = "#ff0000";
        cx.fillRect(0, 0, size.width, size.height);
        cx.fill(new Path2D("M0 0 L10 10"));
      }}
    />
  ),
);
"##;

/// The app, compiled by nsh and loaded as bytecode.
fn start(app: &str) -> (Engine, crossbeam_channel::Receiver<MountBatch>) {
    static APPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nsh-canvas-{}-{}",
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
        ui_sets: vec![nsh_base::registry().into()],
    })
    .unwrap();
    let bytecode =
        nsh_js::compile_bytecode_with(&bundle.code, false, &[nsh_base::registry().into()]).unwrap();
    // SAFETY: compiled just now by this runtime.
    let app = unsafe { Bundle::bytecode(bytecode) };
    let (tx, rx) = crossbeam_channel::unbounded();
    let config = EngineConfig {
        app: nsh_engine::App::Js(app),
        viewport: Size::new(px(390.0), px(844.0)),
        trace: false,
        network: None,
        websocket: None,
        filesystem: None,
        assets: None,
        environment: Default::default(),
        header_heights: (nsh_core::Points(44.0), nsh_core::Points(96.0)),
        limits: nsh_engine::Limits::default(),
        ui_sets: vec![nsh_base::registry()],
        runtime: None,
        data_dir: None,
        cache: nsh_engine::CacheOptions::off(),
        storage: None,
        clock: Default::default(),
        context: Default::default(),
        pinned: Default::default(),
        clipboard: None,
        host: Default::default(),
        picker: None,
    };
    (
        Engine::start(config, || ApproxTextEngine, ChannelSink(tx)).unwrap(),
        rx,
    )
}

/// The first `count` drawings the app sends.
fn drawings(rx: &crossbeam_channel::Receiver<MountBatch>, count: usize) -> Vec<Drawing> {
    let mut out = Vec::new();
    while out.len() < count
        && let Ok(batch) = rx.recv_timeout(Duration::from_secs(2))
    {
        for item in batch.items {
            if let MountItem::Canvas { drawing, .. } = item {
                out.push((*drawing).clone());
            }
        }
    }
    out
}

#[test]
fn a_drawing_records_what_the_context_was_told() {
    let (_engine, rx) = start(APP);
    let drawing = drawings(&rx, 1).pop().expect("a drawing");
    let ops = &drawing.ops;
    let c = Num::Const;
    assert!(matches!(ops[0], CanvasOp::Save));
    assert!(matches!(ops[1], CanvasOp::LineWidth(Num::Const(3.0))));
    assert!(matches!(ops[2], CanvasOp::LineCap(LineCap::Round)));
    assert!(matches!(
        ops[3],
        CanvasOp::Translate(Num::Const(50.0), Num::Const(0.0))
    ));
    assert!(matches!(ops[4], CanvasOp::BeginPath));
    assert!(matches!(ops[5], CanvasOp::Path(PathOp::MoveTo(a, b)) if a == c(1.0) && b == c(2.0)));
    assert!(matches!(ops[6], CanvasOp::Path(PathOp::LineTo(a, b)) if a == c(3.0) && b == c(4.0)));
    // The default `counterclockwise`.
    assert!(matches!(
        ops[7],
        CanvasOp::Path(PathOp::Arc { ccw: false, .. })
    ));
    assert!(matches!(ops[8], CanvasOp::Path(PathOp::RoundRect { .. })));
    assert!(matches!(ops[9], CanvasOp::Path(PathOp::Close)));
    assert!(matches!(ops[10], CanvasOp::Stroke(None)));
    assert!(matches!(ops[11], CanvasOp::Restore));
    assert!(matches!(ops[12], CanvasOp::FillStyle(_)));
    assert!(matches!(ops[13], CanvasOp::FillRect([_, _, w, h]) if w == c(100.0) && h == c(50.0)));
    assert!(matches!(ops[14], CanvasOp::Fill(Some(_), _)));
    assert_eq!(ops.len(), 15, "{ops:?}");
}

/// A drawing using every hand-written part of the context: the paints, the
/// state stack, line dashes, text, images, paths and animated values.
const DRAW: &str = r##"(cx, size) => {
  const log = [];
  const g = cx.createLinearGradient(0, 0, size.width, 0);
  g.addColorStop(1, "#0000ff");
  g.addColorStop(0, "red");
  cx.fillStyle = g;
  cx.fillRect(0, 0, 10, 10);
  const r = cx.createRadialGradient(1, 2, 3, 4, 5, 6);
  r.addColorStop(0.5, "#00ff00");
  cx.strokeStyle = r;
  cx.strokeRect(0, 0, 5, 5);
  cx.strokeStyle = cx.createConicGradient(0.5, 10, 10);
  cx.shadowColor = "rgba(0,0,0,0.5)";
  cx.shadowBlur = 4;
  cx.shadowOffsetX = 2;
  cx.shadowOffsetY = 3;
  log.push(cx.shadowOffsetX, cx.shadowOffsetY, cx.lineCap, cx.globalAlpha);
  cx.setLineDash([4, 2, 1]);
  log.push(cx.getLineDash().join(","));
  cx.lineDashOffset = 1.5;
  cx.save();
  cx.font = "bold 14px system-ui";
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  cx.globalAlpha = 0.25;
  cx.globalCompositeOperation = "multiply";
  cx.fillText(42, 5, 6);
  cx.strokeText("hi", 7, 8, 100);
  log.push(cx.font, cx.measureText("abc").width);
  cx.restore();
  log.push(cx.font, cx.globalAlpha);
  cx.resetTransform();
  cx.setTransform(1, 0, 0, 1, 2, 3);
  cx.transform(1, 0, 0, 1, 4, 5);
  cx.scale(2, 3);
  cx.rotate(0.1);
  cx.drawImage("https://example.com/a.png", 1, 2);
  cx.drawImage({ url: "asset:/b.png", size: { width: 20, height: 10 } }, 1, 2);
  cx.drawImage("https://example.com/a.png", 1, 2, 3, 4);
  cx.drawImage("https://example.com/a.png", 1, 2, 3, 4, 5, 6, 7, 8);
  const p = new Path2D();
  p.moveTo(0, 0);
  p.lineTo(v, 10);
  p.rect(1, 2, 3, 4);
  p.roundRect(0, 0, 10, 10, [1, 2, 3]);
  p.roundRect(0, 0, 10, 10, 5);
  p.ellipse(5, 5, 2, 3, 0, 0, 6.28);
  p.quadraticCurveTo(1, 2, 3, 4);
  p.bezierCurveTo(1, 2, 3, 4, 5, 6);
  p.arcTo(1, 2, 3, 4, 5);
  const q = new Path2D(p);
  q.addPath(new Path2D("M0 0 L10 10 Z"));
  cx.fill(p, "evenodd");
  cx.fill("evenodd");
  cx.stroke(q);
  cx.clip(q);
  cx.clip();
  cx.lineWidth = v;
  cx.fillStyle = color;
  cx.beginPath();
  cx.arc(1, 2, 3, 0, 1, true);
  cx.fill();
  cx.clearRect(0, 0, size.width, size.height);
  log.push(cx.canvas.width, cx.canvas.height, cx instanceof CanvasRenderingContext2D, g instanceof CanvasGradient, p instanceof Path2D);
  cx.fillText(log.join("|"), 0, 0);
}"##;

const DRAW_IMPORTS: &str = r##"import { Canvas, CanvasGradient, CanvasRenderingContext2D, Path2D } from "nsh";
import { createAnimatedValue } from "nsh";

const v = createAnimatedValue(3);
const color = v.interpolate({ inputRange: [0, 1], outputRange: ["#000000", "#ffffff"] });
"##;

#[test]
fn the_hand_written_parts_record_as_in_canvas() {
    let app = format!(
        r#"import {{ mount }} from "nsh";
{DRAW_IMPORTS}
mount(() => <Canvas style={{{{ width: 100, height: 50 }}}} draw={{{DRAW}}} />);
"#
    );
    let (_engine, rx) = start(&app);
    let drawing = drawings(&rx, 1).pop().expect("a drawing");
    let text = format!("{drawing:#?}");
    // What the getters read, drawn as the last text.
    assert!(
        text.contains("2|3|butt|1|4,2,1,4,2,1|bold 14px system-ui|23.100000381469727|10px sans-serif|1|100|50|true|true|true"),
        "{text}"
    );
    // The animated value reads are slots of the drawing.
    assert_eq!(drawing.slots.len(), 2, "{:?}", drawing.slots);
    let gradients = drawing
        .ops
        .iter()
        .filter(|op| {
            matches!(
                op,
                CanvasOp::FillStyle(nsh_core::canvas::Paint::Gradient(_))
                    | CanvasOp::StrokeStyle(nsh_core::canvas::Paint::Gradient(_))
            )
        })
        .count();
    assert_eq!(gradients, 3, "{text}");
    let images = drawing
        .ops
        .iter()
        .filter(|op| matches!(op, CanvasOp::DrawImage { .. }))
        .count();
    assert_eq!(images, 4, "{text}");
}

/// Redrawn when a signal `draw` reads changes; a throwing `draw` still
/// sends what it recorded, and the error reaches the app.
const REDRAW: &str = r#"import { signal, mount } from "nsh";
import { Canvas } from "nsh";

const n = signal(1);
setTimeout(() => n.set(2), 30);

mount(() => (
  <Canvas
    style={{ width: 10, height: 10 }}
    draw={(cx) => {
      cx.lineWidth = n();
      cx.stroke();
      if (n() === 2) throw new Error("drawn");
    }}
  />
));
"#;

#[test]
fn canvases_redraw_when_what_they_read_changes() {
    let (_engine, rx) = start(REDRAW);
    let d = drawings(&rx, 2);
    assert_eq!(d.len(), 2);
    assert!(matches!(d[0].ops[0], CanvasOp::LineWidth(Num::Const(1.0))));
    assert!(matches!(d[1].ops[0], CanvasOp::LineWidth(Num::Const(2.0))));
    assert_eq!(d[1].ops.len(), 2);
}

/// A `draw` that derives a node from an animated value, run again: the same
/// node (no new one in the graph each time), the same slot.
const DERIVED: &str = r#"import { signal, mount } from "nsh";
import { createAnimatedValue } from "nsh";
import { Canvas } from "nsh";

const n = signal(1);
const v = createAnimatedValue(0);
// Chained, not two timers 30 ms apart: a late wake-up (coarse timers on
// Windows, a loaded machine) would run both in one turn, one commit.
setTimeout(() => {
  n.set(2);
  setTimeout(() => n.set(3), 30);
}, 30);

mount(() => (
  <Canvas
    style={{ width: 10, height: 10 }}
    draw={(cx) => {
      cx.lineWidth = n();
      cx.globalAlpha = v.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] });
      cx.translate(v.mul(10), 0);
      cx.stroke();
    }}
  />
));
"#;

#[test]
fn redrawing_derives_the_same_nodes() {
    let (_engine, rx) = start(DERIVED);
    let mut drawings = Vec::new();
    let mut derived = 0;
    while drawings.len() < 3
        && let Ok(batch) = rx.recv_timeout(Duration::from_secs(2))
    {
        for item in batch.items {
            match item {
                MountItem::Canvas { drawing, .. } => drawings.push(drawing.slots.clone()),
                MountItem::Animation(
                    nsh_core::animation::AnimationOp::CreateInterpolate { .. }
                    | nsh_core::animation::AnimationOp::CreateMath { .. },
                ) => derived += 1,
                _ => {}
            }
        }
    }
    assert_eq!(drawings.len(), 3);
    assert_eq!(
        derived, 2,
        "one interpolation and one product, for all three drawings"
    );
    assert_eq!(drawings[0].len(), 2);
    assert!(drawings.iter().all(|s| *s == drawings[0]), "{drawings:?}");
}

/// Hit tests answered natively while drawing and, on a kept context,
/// afterwards; `fontVariantNumeric` records with the font kept apart.
/// (Imported from `nsh/canvas`, where they were first: they still are.)
const HIT: &str = r#"import { signal, mount } from "nsh";
import { Canvas, Path2D, CanvasRenderingContext2D } from "nsh";

const later = signal("");
const p = new Path2D();
p.rect(0, 0, 10, 10);
let kept: CanvasRenderingContext2D | undefined;
setTimeout(() => later.set(`later ${kept!.isPointInPath(p, 25, 5)} ${kept!.isPointInPath(p, 5, 5)}`), 30);

mount(() => (
  <Canvas
    style={{ width: 100, height: 100 }}
    draw={(cx) => {
      kept ??= cx;
      const log: unknown[] = [];
      cx.translate(20, 0);
      log.push(cx.isPointInPath(p, 25, 5), cx.isPointInPath(p, 5, 5));
      cx.beginPath();
      cx.arc(0, 20, 5, 0, 7);
      log.push(cx.isPointInPath(20, 20), cx.isPointInPath(30, 20), cx.isPointInStroke(20, 25.2), cx.isPointInStroke(20, 20));
      cx.fontVariantNumeric = "tabular-nums";
      cx.font = "12px system-ui";
      log.push(cx.fontVariantNumeric);
      cx.fillText(log.join("|") + later(), 0, 0);
    }}
  />
));
"#;

#[test]
fn hit_tests_and_number_forms_are_native() {
    let (_engine, rx) = start(HIT);
    let drawings = drawings(&rx, 2);
    let text = format!("{drawings:#?}");
    assert!(
        text.contains("true|false|true|false|true|false|tabular-numslater true false"),
        "{text}"
    );
    assert!(drawings[0].ops.iter().any(|op| matches!(
        op,
        CanvasOp::FontVariantNumeric(v) if v.0 == nsh_core::FontVariant::TABULAR_NUMS
    )));
}
