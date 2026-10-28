//! Shortcut parsing and matching retain the shared native keymap rules.
use std::sync::Arc;

use nsh_core::{
    Op, Prop, ROOT_ID,
    element::PropError,
    js::host::HostInput,
    keymap::{KeyBinding, Keymap, Keystroke, When},
    platform::Os,
};

use super::{bindings::Bindings, values::Value};

pub(super) fn call(host: &Bindings, op: u32, args: &Value) -> Result<Value, PropError> {
    let apple = args.index(1)?.truthy();
    if op == 450 {
        let text = args
            .index(0)?
            .as_string()
            .ok_or_else(|| PropError("expected shortcut text".into()))?;
        let key = Keystroke::parse_with(&text, apple)
            .map_err(|e| PropError(format!("keymap.label: {e}")))?;
        return Value::string(&key.label(Os::Web, apple));
    }
    let entries = args.index(0)?;
    let mut bindings = Vec::new();
    for index in 0..entries.length()?.unwrap_or(0) {
        let entry = entries.index(index)?;
        let text = entry
            .index(0)?
            .as_string()
            .ok_or_else(|| PropError("expected shortcut text".into()))?;
        let id = entry
            .index(1)?
            .as_number()
            .ok_or_else(|| PropError("invalid shortcut ID".into()))? as u32;
        let key = Keystroke::parse_with(&text, apple)
            .map_err(|e| PropError(format!("keymap.bind: {e}")))?;
        if let Some(why) = key.reserved(Os::Web) {
            return Err(PropError(format!(
                "keymap.bind: {text:?} cannot be bound: {why}"
            )));
        }
        let when = match entry.index(2)?.as_string().as_deref() {
            None => When::Auto,
            Some("always") => When::Always,
            Some("notEditing") => When::NotEditing,
            _ => {
                return Err(PropError(
                    "keymap.bind: when must be always or notEditing".into(),
                ));
            }
        };
        bindings.push(KeyBinding::new(id, key, when, entry.index(3)?.truthy()));
    }
    host.ops.borrow_mut().push(Op::SetProp {
        id: ROOT_ID,
        prop: Prop::Keymap(Arc::new(Keymap::new(bindings))),
    });
    Ok(Value(0))
}
