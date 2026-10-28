//! Pan coordinates and velocity use the shared Rust gesture accumulator.
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
};

use nsh_core::{
    Points, TouchEvent, TouchPhase, TouchPoint,
    element::{JsHost, PanGesture, PropError},
    js::host::HostInput,
};

use super::{bindings::Bindings, values::Value};
#[derive(Default)]
pub(super) struct Gestures {
    next: Cell<u32>,
    states: RefCell<HashMap<u32, PanGesture>>,
}
impl Gestures {
    pub(super) fn call(&self, host: &Bindings, op: u32, args: &Value) -> Result<Value, PropError> {
        if op == 700 {
            let id = self
                .next
                .get()
                .checked_add(1)
                .ok_or_else(|| PropError("gesture IDs exhausted".into()))?;
            self.next.set(id);
            self.states.borrow_mut().insert(id, PanGesture::default());
            return Ok(Value::number(id.into()));
        }
        let id = args
            .index(0)?
            .as_number()
            .ok_or_else(|| PropError("invalid gesture".into()))? as u32;
        if op == 702 {
            self.states.borrow_mut().remove(&id);
            return Ok(Value(0));
        }
        let event = args.index(1)?;
        let points = event.get("touches")?;
        let mut list = Vec::new();
        for index in 0..points.length()?.unwrap_or(0) {
            let p = points.index(index)?;
            let n = |name| p.get(name).ok().and_then(|v| v.as_number()).unwrap_or(0.0);
            list.push(TouchPoint {
                id: n("identifier") as u32,
                target: n("target") as u32,
                path: Vec::new(),
                page: nsh_core::geometry::point(
                    Points(n("pageX") as f32),
                    Points(n("pageY") as f32),
                ),
                location: nsh_core::geometry::point(
                    Points(n("locationX") as f32),
                    Points(n("locationY") as f32),
                ),
                changed: false,
            });
        }
        let touch = TouchEvent {
            phase: TouchPhase::Move,
            timestamp: event.get("timestamp")?.as_number().unwrap_or(0.0),
            points: list,
            activated: None,
        };
        let reset = args.index(2)?.truthy();
        let gesture = {
            let mut states = self.states.borrow_mut();
            let state = states
                .get_mut(&id)
                .ok_or_else(|| PropError("gesture was disposed".into()))?;
            if reset {
                *state = PanGesture::begin(&touch);
            } else {
                state.update(&touch);
            }
            *state
        };
        let data = serde_json::json!({"moveX":gesture.position.x.0,"moveY":gesture.position.y.0,"x0":gesture.origin.x.0,"y0":gesture.origin.y.0,"dx":gesture.delta.x.0,"dy":gesture.delta.y.0,"vx":gesture.vx,"vy":gesture.vy,"numberActiveTouches":gesture.active_touches});
        host.json(&data).map(|v| Value(v.0[0] as u32))
    }
}
