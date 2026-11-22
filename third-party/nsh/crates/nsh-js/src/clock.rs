//! `Date` and `performance.now()` on a manual clock
//! (`nsh_core::time::Clock::manual`, an engine's under test): QuickJS reads
//! the system's time for them in C, so a VM made on a thread whose clock is
//! manual gets natives in their place that read the clock. `Date` becomes a
//! constructor that hands the original the clock's time when given none
//! (`new Date()`, `Date()`), sharing its prototype, so dates, `instanceof
//! Date` and subclasses behave as before; `Date.now()` and
//! `performance.now()` read the clock. On the system's clock nothing is
//! replaced.

use std::ffi::c_int;

use rquickjs::{Ctx, qjs};

use crate::web::{
    self,
    js::{self, Args, R, Raw, V, native},
};

/// Installs them when the current thread's clock is manual.
pub(crate) fn install(cx: &Ctx<'_>) -> rquickjs::Result<()> {
    if !nsh_core::time::manual() {
        return Ok(());
    }
    let cx = cx.as_raw().as_ptr();
    replace(cx).map_err(|_| rquickjs::Error::Exception)
}

/// What a property is: QuickJS' flags, throwing when it cannot be defined.
const READ_ONLY: c_int = (qjs::JS_PROP_ENUMERABLE | qjs::JS_PROP_THROW) as c_int;
const HIDDEN: c_int =
    (qjs::JS_PROP_WRITABLE | qjs::JS_PROP_CONFIGURABLE | qjs::JS_PROP_THROW) as c_int;
const FROZEN: c_int = qjs::JS_PROP_THROW as c_int;

/// Defines `key` on `obj` as `flags` say.
fn define(cx: js::Ctx, obj: Raw, key: &std::ffi::CStr, value: V, flags: c_int) -> R<()> {
    // SAFETY: the property takes the value.
    match unsafe { qjs::JS_DefinePropertyValueStr(cx, obj, key.as_ptr(), value.take(), flags) } {
        r if r > 0 => Ok(()),
        _ => Err(js::Throw),
    }
}

fn replace(cx: js::Ctx) -> R<()> {
    let global = js::global(cx);
    // `performance`: QuickJS makes its members read-only, so it is a new
    // object of the same shape, its time origin the clock's start.
    let performance = js::new_object(cx)?;
    define(
        cx,
        performance.raw(),
        c"now",
        js::function(cx, c"now", performance_now, 0)?,
        READ_ONLY,
    )?;
    define(
        cx,
        performance.raw(),
        c"timeOrigin",
        V::num(nsh_core::time::unix_ms()),
        READ_ONLY,
    )?;
    define(
        cx,
        global.raw(),
        c"performance",
        performance,
        (qjs::JS_PROP_WRITABLE
            | qjs::JS_PROP_ENUMERABLE
            | qjs::JS_PROP_CONFIGURABLE
            | qjs::JS_PROP_THROW) as c_int,
    )?;
    web::web(cx).clock_origin = Some(nsh_core::time::now());
    // `Date`.
    let original = js::get(cx, global.raw(), "Date")?;
    // SAFETY: a constructor-or-function, as the intrinsic `Date` is: QuickJS
    // passes the new target as `this` when constructed, `undefined` when
    // called.
    let date = V::checked(cx, unsafe {
        qjs::JS_NewCFunction2(
            cx,
            Some(date),
            c"Date".as_ptr(),
            7,
            qjs::JSCFunctionEnum_JS_CFUNC_constructor_or_func,
            0,
        )
    })?;
    let prototype = js::get(cx, original.raw(), "prototype")?;
    // As the intrinsic's: neither writable, enumerable nor configurable.
    define(cx, date.raw(), c"prototype", prototype.clone_ref(), FROZEN)?;
    define(
        cx,
        prototype.raw(),
        c"constructor",
        date.clone_ref(),
        HIDDEN,
    )?;
    for name in [c"UTC", c"parse"] {
        let member = js::get(cx, original.raw(), name.to_str().unwrap_or_default())?;
        define(cx, date.raw(), name, member, HIDDEN)?;
    }
    define(
        cx,
        date.raw(),
        c"now",
        js::function(cx, c"now", date_now, 0)?,
        HIDDEN,
    )?;
    define(cx, global.raw(), c"Date", date, HIDDEN)?;
    web::web(cx).date = original;
    Ok(())
}

/// The clock's wall time in whole milliseconds, as `Date.now()` gives it.
fn now_ms() -> f64 {
    nsh_core::time::unix_ms().floor()
}

native! {
    /// `performance.now()`: milliseconds since the clock's start.
    fn performance_now(cx, this, args) {
        let origin = web::web(cx).clock_origin.unwrap_or_else(nsh_core::time::now);
        Ok(V::num(nsh_core::time::now().saturating_duration_since(origin).as_secs_f64() * 1000.0))
    }
}

native! {
    /// `Date.now()`.
    fn date_now(cx, this, args) {
        Ok(V::num(now_ms()))
    }
}

/// `Date(...)` and `new Date(...)`: the original's, at the clock's time
/// when given none.
unsafe extern "C" fn date(cx: js::Ctx, new_target: Raw, argc: c_int, argv: *mut Raw) -> Raw {
    // SAFETY: QuickJS passes `argc` live arguments.
    let args = unsafe { Args::new(argc, argv) };
    match construct(cx, new_target, args) {
        Ok(v) => v.take(),
        Err(_) => qjs::JS_EXCEPTION,
    }
}

fn construct(cx: js::Ctx, new_target: Raw, args: Args<'_>) -> R<V> {
    let original = web::web(cx).date.clone_ref();
    let now = V::num(now_ms());
    if js::is_undefined(new_target) {
        // Called: the time now as a string, whatever the arguments.
        let today = js::construct(cx, original.raw(), &[now.raw()])?;
        return js::invoke(cx, today.raw(), "toString", &[]);
    }
    let given: Vec<Raw> = (0..args.len()).map(|i| args.get(i)).collect();
    let args = if given.is_empty() {
        vec![now.raw()]
    } else {
        given
    };
    // SAFETY: live values; the new target makes subclasses' instances.
    V::checked(cx, unsafe {
        qjs::JS_CallConstructor2(
            cx,
            original.raw(),
            new_target,
            args.len() as c_int,
            args.as_ptr().cast_mut(),
        )
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nsh_core::time::Clock;

    use crate::Host;

    #[test]
    fn date_and_performance_read_a_manual_clock() {
        let clock = Clock::manual(
            std::time::SystemTime::UNIX_EPOCH + Duration::from_millis(1_767_225_600_000),
        );
        let _guard = clock.enter();
        let host = Host::new().unwrap();
        let check = |code: &str| {
            host.eval_source(&format!(
                "const got = ({code}); if (got !== true) throw new Error(`{code}: ${{got}} ${{performance.now()}} ${{Date.now()}}`);"
            ))
            .unwrap()
        };
        check(
            "performance.now() === 0 && Date.now() === 1767225600000 && performance.timeOrigin === 1767225600000",
        );
        check(
            "new Date().toISOString() === '2026-01-01T00:00:00.000Z' && typeof Date() === 'string'",
        );
        check(
            "new Date(0).getTime() === 0 && Date.UTC(1970, 0, 2) === 86400000 && new Date() instanceof Date",
        );
        check("(class D extends Date {}, new (class D extends Date {})() instanceof Date)");
        check(
            "new Date().constructor === Date && Object.getPrototypeOf(new Date()) === Date.prototype",
        );
        clock.advance_to(clock.now() + Duration::from_millis(1500));
        check("performance.now() === 1500 && Date.now() === 1767225601500");
    }
}
