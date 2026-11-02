//! What `process` needs of the VM itself. The module is the runtime's typed
//! registry (`nsh_core::runtime::process`, its JS face and declarations
//! made from the spec); here its default object becomes the global
//! `process`, and `nextTick` queues a JS job, which only the VM can.

use std::ffi::c_int;

use rquickjs::{Ctx, Error, Result, qjs};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

/// Makes the `process` module's default object the global `process`, before
/// application code runs (the module and the global are one object).
pub(crate) fn install(cx: &Ctx<'_>) -> Result<()> {
    let raw = cx.as_raw().as_ptr();
    // SAFETY: the state is installed before the standard globals.
    let object = unsafe {
        (*crate::state::state(raw))
            .modules
            .default_object(raw, "process")
    }
    .ok_or(Error::Unknown)?;
    // SAFETY: inline tag check of the owned value.
    if unsafe { qjs::JS_IsException(object) } {
        return Err(Error::Exception);
    }
    // SAFETY: the global object takes the owned value.
    unsafe {
        let global = qjs::JS_GetGlobalObject(raw);
        qjs::JS_SetPropertyStr(raw, global, c"process".as_ptr(), object);
        qjs::JS_FreeValue(raw, global);
    }
    Ok(())
}

/// `process.nextTick(callback, ...args)`: `callback(...args)` as a JS job,
/// after the current one and before timers.
pub(crate) unsafe extern "C" fn next_tick(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let callback = crate::reactive::arg(argc, argv, 0);
    // SAFETY: a tag check of a live argument.
    if argc < 1 || !unsafe { qjs::JS_IsFunction(cx, callback) } {
        // SAFETY: a literal message on a live context.
        return unsafe {
            qjs::JS_ThrowTypeError(
                cx,
                c"process.nextTick: callback must be a function".as_ptr(),
            )
        };
    }
    // SAFETY: QuickJS copies the `argc` live arguments into the job.
    if unsafe { qjs::JS_EnqueueJob(cx, Some(tick), argc, argv) } < 0 {
        return qjs::JS_EXCEPTION;
    }
    qjs::JS_UNDEFINED
}

/// The job: the callback (argument 0) with the rest of the arguments.
unsafe extern "C" fn tick(cx: *mut JsContext, argc: c_int, argv: *mut JsValue) -> JsValue {
    // SAFETY: the job's `argc` (at least one) live arguments.
    unsafe { qjs::JS_Call(cx, *argv, qjs::JS_UNDEFINED, argc - 1, argv.add(1)) }
}

#[cfg(test)]
mod tests {
    use nsh_core::Op;

    use crate::Host;

    fn result(host: &Host) -> String {
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        ops.into_iter()
            .rev()
            .find_map(|op| match op {
                Op::CreateText { text, .. } => Some(text),
                _ => None,
            })
            .expect("fixture output")
    }

    #[test]
    fn module_shares_global_and_defers_callbacks_with_arguments() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import process, {nextTick, spawn, run, platform, arch} from 'process';
            import bare from 'process';
            import {text} from 'nsh:rt';
            const calls = [];
            nextTick((a,b) => { calls.push(a+b); text(JSON.stringify([
                process === bare, bare === globalThis.process,
                spawn === process.spawn, run === process.run,
                platform === process.platform, arch === process.arch,
                nextTick === process.nextTick, process.dataDir, calls
            ])); }, 2, 3);
            calls.push('sync');
        "#,
        )
        .unwrap();
        assert_eq!(
            result(&host),
            r#"[true,true,true,true,true,true,true,null,["sync",5]]"#
        );
    }

    #[test]
    fn data_directory_getter_tracks_host_configuration_without_host_authority() {
        let host = Host::new().unwrap();
        let path = std::path::PathBuf::from("/configured-app-root");
        host.set_system_access(nsh_core::access::Access::default(), Some(path));
        host.eval_source(
            r#"
            import process from 'process'; import {text} from 'nsh:rt';
            let denied = false;
            // Headless runs are iOS: no processes there, before any grant.
            try { process.spawn('not-granted'); } catch (e) { denied = e.code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'; }
            text(JSON.stringify([process.dataDir, denied,
                typeof process.exit, typeof process.env]));
        "#,
        )
        .unwrap();
        assert_eq!(
            result(&host),
            r#"["/configured-app-root",true,"function","object"]"#
        );
    }

    #[test]
    fn environment_is_a_fresh_granted_snapshot_and_exit_is_a_checked_host_request() {
        use std::{cell::Cell, rc::Rc};
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import process from 'process'; import {text} from 'nsh:rt';
            const a=process.env,b=process.env;
            a.NSH_ONLY_LOCAL='modified';
            let denied=false; try {process.exit();} catch(e) {denied=e.code==='ERR_ACCESS_DENIED'&&e.permission==='process'&&e.resource==='exit';}
            text(JSON.stringify([a!==b,typeof process.env.NSH_ONLY_LOCAL,denied]));
        "#,
        )
        .unwrap();
        assert_eq!(result(&host), r#"[true,"undefined",true]"#);
        let mut declared = nsh_core::access::Capabilities::default();
        declared.process.exit = true;
        host.set_system_access(
            nsh_core::access::Access {
                declared,
                granted: None,
            },
            None,
        );
        host.eval_source(
            r#"
            import process from 'process'; import {text} from 'nsh:rt';
            let missing=false;try {process.exit(3);}catch(e){missing=e.code==='ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';}
            text(JSON.stringify(missing));
        "#,
        )
        .unwrap();
        assert_eq!(result(&host), "true");
        let requested = Rc::new(Cell::new(-1));
        let sink = requested.clone();
        host.set_exit_handler(Rc::new(move |code| sink.set(code)));
        host.eval_source("import {exit} from 'process'; exit(7);")
            .unwrap();
        assert_eq!(requested.get(), 7);
    }
}
