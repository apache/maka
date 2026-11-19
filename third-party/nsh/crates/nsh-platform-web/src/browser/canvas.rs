//! Recorded browser drawings use the shared Rust canvas decoder.
use nsh_core::{
    Op, Points,
    canvas::{
        CanvasOp, FillRule, PathOp, point_in_path, point_in_stroke,
        render::{ImageFormat, RenderRequest},
    },
    element::{JsHost, PropError, TsTypes},
    js::{host::HostInput, ops::JsOps},
};

use super::{bindings::Bindings, values::Value};
fn drawing(list: &Value) -> Result<nsh_core::canvas::Drawing, PropError> {
    let len = list
        .length()?
        .ok_or_else(|| PropError("canvas: expected recorded operations".into()))?;
    if len > 1_000_000 {
        return Err(PropError("canvas operation limit exceeded".into()));
    }
    nsh_core::js::canvas::decode(list, 0, len).map_err(|e| PropError(format!("nsh canvas: {e}")))
}
pub(super) fn call(host: &Bindings, op: u32, args: &Value) -> Result<Value, PropError> {
    match op {
        600 => {
            let mut types = TsTypes::default();
            let (mut path, mut context, mut properties) = (Vec::new(), Vec::new(), Vec::new());
            PathOp::methods(&mut types, &mut path);
            CanvasOp::methods(&mut types, &mut context);
            CanvasOp::properties(&mut types, &mut properties);
            let methods = |items: Vec<nsh_core::js::ops::OpMethod>| {
                items.into_iter().map(|m| serde_json::json!({"name":m.name,"code":m.code,"defaults":m.params.iter().map(|p|p.default.and_then(|v|serde_json::from_str::<serde_json::Value>(v).ok())).collect::<Vec<_>>()})).collect::<Vec<_>>()
            };
            let data = serde_json::json!({"path":methods(path),"context":methods(context),"properties":properties.iter().map(|p|serde_json::json!({"name":p.name,"code":p.code,"initial":serde_json::from_str::<serde_json::Value>(p.initial).unwrap_or_default()})).collect::<Vec<_>>()});
            host.json(&data).map(|v| Value(v.0[0] as u32))
        }
        601 => {
            let id = args
                .index(0)?
                .node()
                .ok_or_else(|| PropError("canvas: expected a node".into()))?;
            let drawing = drawing(&args.index(1)?)?;
            host.ops.borrow_mut().push(Op::Draw {
                id,
                drawing: Box::new(drawing),
            });
            Ok(Value(0))
        }
        602 => {
            let Ok(drawing) = drawing(&args.index(0)?) else {
                return Ok(Value(2));
            };
            let path = args.index(1)?;
            let path = if path.is_nullish() {
                None
            } else {
                let recorded = Value::array([Value::number(19.0), path])?;
                match self::drawing(&recorded)
                    .ok()
                    .and_then(|mut drawing| drawing.ops.pop())
                {
                    Some(CanvasOp::Stroke(path)) => path,
                    _ => None,
                }
            };
            let point = nsh_core::geometry::point(
                Points(args.index(2)?.as_number().unwrap_or(f64::NAN) as f32),
                Points(args.index(3)?.as_number().unwrap_or(f64::NAN) as f32),
            );
            let rule = if args.index(4)?.as_string().as_deref() == Some("evenodd") {
                FillRule::EvenOdd
            } else {
                FillRule::NonZero
            };
            let hit = if args.index(5)?.truthy() {
                point_in_stroke(&drawing.ops, path.as_deref(), point, |_| 0.0)
            } else {
                point_in_path(&drawing.ops, path.as_deref(), rule, point, |_| 0.0)
            };
            Ok(Value(if hit { 3 } else { 2 }))
        }
        603 => {
            let font = args
                .index(0)?
                .as_string()
                .and_then(|v| nsh_core::canvas::CanvasFont::parse(&v))
                .unwrap_or_default();
            let numeric = args
                .index(1)?
                .as_string()
                .and_then(|v| nsh_core::FontVariant::parse(&v))
                .unwrap_or_default();
            let text = args.index(2)?.as_string().unwrap_or_default();
            Ok(Value::number(
                crate::text::canvas_width(&font.with_numeric(numeric), &text).into(),
            ))
        }
        // `OffscreenCanvas.convertToBlob`: the recorded operations, then
        // `[width, height, type, scale]` and the promise's call: rendered
        // as `nsh-js`'s (`Op::RenderCanvas`), settled by the core's reply.
        604 => {
            let drawing = drawing(&args.index(0)?)?;
            let options = args.index(1)?;
            let number = |i: usize| -> Result<f32, PropError> {
                Ok(options.index(i)?.as_number().unwrap_or(f64::NAN) as f32)
            };
            let (width, height) = (number(0)?, number(1)?);
            let format = options
                .index(2)?
                .as_string()
                .and_then(|mime| ImageFormat::from_mime(&mime))
                .unwrap_or_default();
            let scale = options.index(3)?;
            let scale = (!scale.is_nullish()).then(|| scale.as_number().unwrap_or(f64::NAN) as f32);
            let call = args.index(2)?.as_number().unwrap_or(0.0) as u32;
            host.ops.borrow_mut().push(Op::RenderCanvas {
                call,
                request: Box::new({
                    let mut request = RenderRequest::default();
                    request.drawing = drawing;
                    request.size = nsh_core::Size::new(Points(width), Points(height));
                    request.scale = scale;
                    request.format = format;
                    request
                }),
            });
            Ok(Value(0))
        }
        // An offscreen context's clear of the whole canvas
        // (`canvas.js` `track`): which of the recorded property
        // operations take effect (the decoder drops a value it cannot
        // read, and the one before stays), as booleans.
        605 => {
            let ops = args.index(0)?;
            let len = ops.length()?.unwrap_or(0);
            let mut effective = Vec::with_capacity(len);
            for i in 0..len {
                let taken = drawing(&ops.index(i)?).is_ok_and(|d| d.ops.len() == 1);
                effective.push(serde_json::Value::Bool(taken));
            }
            host.json(&serde_json::Value::Array(effective))
                .map(|v| Value(v.0[0] as u32))
        }
        _ => Err(PropError("unknown canvas operation".into())),
    }
}
