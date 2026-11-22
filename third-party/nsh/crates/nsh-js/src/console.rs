use rquickjs::{Ctx, Function, Object, Type, Value, function::Rest, prelude::Coerced};

/// Installs `console`, routed to the `log` facade with target `js`.
pub(crate) fn install(cx: &Ctx<'_>) -> rquickjs::Result<()> {
    let console = Object::new(cx.clone())?;
    for (name, level) in [
        ("log", log::Level::Info),
        ("info", log::Level::Info),
        ("debug", log::Level::Debug),
        ("warn", log::Level::Warn),
        ("error", log::Level::Error),
    ] {
        let f = Function::new(cx.clone(), move |args: Rest<Value<'_>>| {
            if !log::log_enabled!(target: "js", level) {
                return;
            }
            let mut line = String::new();
            for (i, arg) in args.0.iter().enumerate() {
                if i > 0 {
                    line.push(' ');
                }
                format_value(arg, &mut line);
            }
            log::log!(target: "js", level, "{line}");
        })?;
        console.set(name, f)?;
    }
    cx.globals().set("console", console)
}

/// Formats like a browser console: strings verbatim, errors with their
/// stack, functions by name, objects and arrays as JSON.
pub(crate) fn format_value(value: &Value<'_>, out: &mut String) {
    match value.type_of() {
        Type::String => {
            if let Some(Ok(s)) = value.as_string().map(|s| s.to_string()) {
                out.push_str(&s);
            }
        }
        Type::Exception => {
            if let Some(e) = value.as_exception() {
                out.push_str(&e.to_string());
            }
        }
        Type::Function | Type::Constructor => {
            let name = value
                .as_object()
                .and_then(|o| o.get::<_, String>("name").ok())
                .filter(|n| !n.is_empty());
            out.push_str(&format!(
                "[Function {}]",
                name.as_deref().unwrap_or("(anonymous)")
            ));
        }
        Type::Object | Type::Array => {
            // Cycles or exotic values make JSON fail: fall back to toString.
            match value.ctx().json_stringify(value.clone()) {
                Ok(Some(json)) => out.push_str(&json.to_string().unwrap_or_default()),
                _ => push_coerced(value, out),
            }
        }
        _ => push_coerced(value, out),
    }
}

fn push_coerced(value: &Value<'_>, out: &mut String) {
    if let Ok(Coerced(s)) = value.get::<Coerced<String>>() {
        out.push_str(&s);
    }
}

#[cfg(test)]
mod tests {
    use rquickjs::{Context, Runtime};

    use super::*;

    fn fmt(src: &str) -> String {
        let rt = Runtime::new().unwrap();
        let cx = Context::full(&rt).unwrap();
        cx.with(|cx| {
            let value: Value = cx.eval(src).unwrap();
            let mut out = String::new();
            format_value(&value, &mut out);
            out
        })
    }

    #[test]
    fn formats_like_a_console() {
        assert_eq!(fmt("'text'"), "text");
        assert_eq!(fmt("42"), "42");
        assert_eq!(
            fmt("({ a: 1, b: [true, null] })"),
            r#"{"a":1,"b":[true,null]}"#
        );
        assert_eq!(fmt("(function named() {})"), "[Function named]");
        assert!(fmt("new Error('bad')").starts_with("Error: bad"));
        // Cycles cannot be JSON: fall back to toString instead of failing.
        assert_eq!(
            fmt("(() => { const o = {}; o.o = o; return o; })()"),
            "[object Object]"
        );
    }
}
