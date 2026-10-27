//! Browser animation facades describe the existing Rust animation graph.
use nsh_core::{
    Op, ROOT_ID,
    element::{JsHost, PropError},
    js::host::HostInput,
};

use super::{bindings::Bindings, compat, protocol, values::Value};
fn numbers(values: impl IntoIterator<Item = f32>) -> Result<Value, PropError> {
    Value::array(values.into_iter().map(|v| Value::number(v.into())))
}
#[derive(Default)]
pub(super) struct Animations {
    derived: std::cell::RefCell<Vec<(nsh_core::animation::AnimationOp, u32)>>,
}
impl Animations {
    pub(super) fn call(&self, host: &Bindings, op: u32, args: &Value) -> Result<Value, PropError> {
        let input = compat::Value::new(args.index(0)?);
        match op {
            507 => {
                use nsh_core::animation::AnimationOp;
                let array = input
                    .as_array()
                    .ok_or_else(|| PropError("expected animation operation".into()))?;
                let mut op = protocol::decode_animation_op(input.ctx(), &array)?;
                let node = match &mut op {
                    AnimationOp::CreateInterpolate { node, .. }
                    | AnimationOp::CreateDiffClamp { node, .. }
                    | AnimationOp::CreateMath { node, .. } => std::mem::replace(node, 0),
                    _ => return Err(PropError("expected a derived animation operation".into())),
                };
                let live = args.index(1)?;
                let live = (0..live.length()?.unwrap_or(0))
                    .filter_map(|i| live.index(i).ok()?.as_number().map(|v| v as u32))
                    .collect::<std::collections::HashSet<_>>();
                let mut cache = self.derived.borrow_mut();
                cache.retain(|(_, id)| live.contains(id));
                if let Some((_, id)) = cache.iter().find(|(key, _)| *key == op) {
                    return Ok(Value::number((*id).into()));
                }
                cache.push((op.clone(), node));
                match &mut op {
                    AnimationOp::CreateInterpolate { node: id, .. }
                    | AnimationOp::CreateDiffClamp { node: id, .. }
                    | AnimationOp::CreateMath { node: id, .. } => *id = node,
                    _ => unreachable!(),
                }
                host.ops.borrow_mut().push(Op::Animation(op));
                Ok(Value::number(node.into()))
            }
            500 => {
                let array = input
                    .as_array()
                    .ok_or_else(|| PropError("expected animation operation".into()))?;
                let op = protocol::decode_animation_op(input.ctx(), &array)?;
                host.ops.borrow_mut().push(Op::Animation(op));
                Ok(Value(0))
            }
            501 => host
                .json(&nsh_core::js::animation::tables())
                .map(|value| Value(value.0[0] as u32)),
            502 => {
                let driver = protocol::driver(input.ctx(), &input)?;
                let from = args.index(1)?.as_number().unwrap_or(0.0) as f32;
                let fps = args
                    .index(2)?
                    .as_number()
                    .unwrap_or(60.0)
                    .clamp(1.0, 1000.0);
                numbers(nsh_core::animation::sample_driver(
                    driver,
                    from,
                    1.0 / fps,
                    nsh_core::animation::MAX_SAMPLES,
                ))
            }
            503 => {
                let count = args.index(1)?.as_number().unwrap_or(0.0);
                let count = if count.is_finite() {
                    (count.max(0.0) as usize).min(nsh_core::animation::MAX_SAMPLES)
                } else {
                    0
                };
                numbers(nsh_core::animation::sample_easing(
                    protocol::easing(input),
                    count,
                ))
            }
            504 => Value::array(
                protocol::motion_start(input)
                    .into_iter()
                    .map(|v| v.map_or(Value(0), |v| Value::number(v.into()))),
            ),
            505 => {
                if let Some(command) = protocol::decode_command("layoutAnimation", input)? {
                    host.ops.borrow_mut().push(Op::Command {
                        id: ROOT_ID,
                        command,
                    });
                }
                Ok(Value(0))
            }
            506 => {
                let from = nsh_core::js::animation::stagger_from(&args.index(0)?);
                let index = args.index(1)?.as_number().unwrap_or(0.0).max(0.0) as usize;
                let count = args.index(2)?.as_number().unwrap_or(0.0).max(0.0) as usize;
                Ok(Value::number(
                    nsh_core::animation::stagger_delay(index, count, from).into(),
                ))
            }
            _ => Err(PropError("unknown animation operation".into())),
        }
    }
}
