//! Resource load generations use the same state machine as native apps.
use std::{cell::RefCell, collections::HashMap};

use nsh_core::{
    element::PropError,
    js::host::HostInput,
    resource::{Run, Runs},
};

use super::values::Value;

#[derive(Default)]
pub(super) struct Resources {
    runs: RefCell<HashMap<u32, Runs>>,
    next: std::cell::Cell<u32>,
}
impl Resources {
    pub(super) fn call(&self, op: u32, args: &Value) -> Result<Value, PropError> {
        if op == 800 {
            let initial = args.index(0)?.truthy();
            let id = self
                .next
                .get()
                .checked_add(1)
                .ok_or_else(|| PropError("resource IDs exhausted".into()))?;
            self.next.set(id);
            self.runs.borrow_mut().insert(
                id,
                if initial {
                    Runs::with_value()
                } else {
                    Runs::default()
                },
            );
            return Ok(Value::number(id.into()));
        }
        let id = args.index(0)?.as_number().unwrap_or(0.0) as u32;
        let run = args.index(1)?.as_number().unwrap_or(0.0) as u64;
        // Read browser arguments before borrowing: accessors may reenter.
        let mut all = self.runs.borrow_mut();
        if op == 807 {
            all.remove(&id);
            return Ok(Value(0));
        }
        if matches!(op, 804 | 805) && !all.contains_key(&id) {
            return Ok(Value(0));
        }
        let runs = all
            .get_mut(&id)
            .ok_or_else(|| PropError("released resource".into()))?;
        let state = match op {
            801 => {
                let (run, state) = runs.start();
                let (run, state) = (run.to_bits(), state.name());
                drop(all);
                return Value::array([Value::number(run as f64), Value::string(state)?]);
            }
            802 => Some(runs.skip()),
            803 => {
                runs.cancel();
                None
            }
            804 => runs.resolve(Run::from_bits(run)),
            805 => runs.reject(Run::from_bits(run)),
            806 => Some(runs.mutate()),
            _ => return Err(PropError("unknown resource operation".into())),
        };
        drop(all);
        state.map_or(Ok(Value(0)), |state| Value::string(state.name()))
    }
}
