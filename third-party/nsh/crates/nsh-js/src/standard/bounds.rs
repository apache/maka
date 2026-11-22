//! Sizes LLRT allocates in Rust memory from a number JS passes:
//! `Buffer.alloc`, `Buffer.allocUnsafe`, `Buffer.allocUnsafeSlow` and
//! `crypto.randomBytes`. Rust's allocator aborts the process when an
//! allocation fails, so `Buffer.alloc(2 ** 45)` would end the host app and
//! every VM in it; behind [`Guarded`], a size past the VM's heap limit (or
//! 1 GiB without one) is a `RangeError` (`code` `ERR_OUT_OF_RANGE`)
//! instead. `allocUnsafe` and `allocUnsafeSlow` zero their memory as
//! `alloc` does: uninitialized Rust memory may hold the host's data.
use rquickjs::{
    Class, Ctx, Exception, Function, JsLifetime, Object, Result, Value,
    class::{ClassKind, JsCell, JsClass, Readable, Trace, Tracer},
    function::{Constructor, Params},
};
#[cfg(feature = "crypto")]
use rquickjs::{
    Module,
    module::{Declarations, Exports, ModuleDef},
};

/// The largest allocation without a heap limit.
const MAX_ALLOCATION: usize = 1 << 30;

/// The VM's largest allocation: its heap limit, or [`MAX_ALLOCATION`].
fn ceiling(cx: &Ctx<'_>) -> usize {
    match crate::dom::shared(cx.as_raw().as_ptr()).limits.memory_bytes {
        0 => MAX_ALLOCATION,
        heap => heap.min(MAX_ALLOCATION),
    }
}

/// One of LLRT's functions whose first argument is a size, behind the
/// VM's ceiling. A callable class rather than a closure, so the garbage
/// collector sees the function it holds.
struct Guarded<'js> {
    inner: Function<'js>,
    /// Its JS name, for the error.
    name: &'static str,
    /// Only the size goes on (`allocUnsafe` as `alloc`, zeroed).
    size_only: bool,
}
// SAFETY: the only lifetime-bearing field is the traced function handle.
unsafe impl<'js> JsLifetime<'js> for Guarded<'js> {
    type Changed<'to> = Guarded<'to>;
}
impl<'js> Trace<'js> for Guarded<'js> {
    fn trace<'a>(&self, tracer: Tracer<'a, 'js>) {
        self.inner.trace(tracer);
    }
}
impl<'js> JsClass<'js> for Guarded<'js> {
    const NAME: &'static str = "NshSizedAllocation";
    const KIND: ClassKind = ClassKind::Callable;
    type Mutable = Readable;
    fn prototype(cx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        Ok(Some(Function::prototype(cx.clone())))
    }
    fn constructor(_: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        Ok(None)
    }
    fn call<'a>(this: &JsCell<'js, Self>, params: Params<'a, 'js>) -> Result<Value<'js>> {
        let cx = params.ctx().clone();
        let this = this.borrow();
        let size = params
            .arg(0)
            .unwrap_or_else(|| Value::new_undefined(cx.clone()));
        let limit = ceiling(&cx);
        // Other values are LLRT's to refuse.
        if let Some(n) = size.as_number()
            && n > limit as f64
        {
            let message = format!(
                "{}: the size {n} is over the VM's {limit}-byte limit",
                this.name
            );
            // A RangeError with Node's code.
            let _ = Exception::throw_range(&cx, &message);
            let error = cx.catch();
            if let Some(error) = error.as_object() {
                error.set("code", "ERR_OUT_OF_RANGE")?;
            }
            return Err(cx.throw(error));
        }
        if this.size_only {
            return this.inner.call((size,));
        }
        let rest: Vec<Value<'js>> = (1..params.len()).filter_map(|i| params.arg(i)).collect();
        match rest.as_slice() {
            [] => this.inner.call((size,)),
            [a] => this.inner.call((size, a.clone())),
            [a, b, ..] => this.inner.call((size, a.clone(), b.clone())),
        }
    }
}

/// `inner` behind the ceiling, as a function value.
fn guarded<'js>(
    cx: &Ctx<'js>,
    inner: Function<'js>,
    name: &'static str,
    size_only: bool,
) -> Result<Value<'js>> {
    Ok(Class::instance(
        cx.clone(),
        Guarded {
            inner,
            name,
            size_only,
        },
    )?
    .into_value())
}

/// Puts the global `Buffer`'s allocations behind the ceiling (the `buffer`
/// module exports the same constructor).
pub(crate) fn guard_buffer(cx: &Ctx<'_>) -> Result<()> {
    let buffer: Object = cx.globals().get("Buffer")?;
    let alloc: Function = buffer.get("alloc")?;
    buffer.set("alloc", guarded(cx, alloc.clone(), "Buffer.alloc", false)?)?;
    for name in ["allocUnsafe", "allocUnsafeSlow"] {
        let what = if name == "allocUnsafe" {
            "Buffer.allocUnsafe"
        } else {
            "Buffer.allocUnsafeSlow"
        };
        buffer.set(name, guarded(cx, alloc.clone(), what, true)?)?;
    }
    Ok(())
}

/// Puts `randomBytes` of the global `crypto` object behind the ceiling.
#[cfg(feature = "crypto")]
pub(crate) fn guard_crypto(cx: &Ctx<'_>) -> Result<()> {
    let crypto: Object = cx.globals().get("crypto")?;
    guard_random_bytes(cx, &crypto)
}

#[cfg(feature = "crypto")]
fn guard_random_bytes<'js>(cx: &Ctx<'js>, object: &Object<'js>) -> Result<()> {
    let random: Function = object.get("randomBytes")?;
    object.set(
        "randomBytes",
        guarded(cx, random, "crypto.randomBytes", false)?,
    )
}

/// The `crypto` module: LLRT's, evaluated as an inner module, its
/// `randomBytes` behind the ceiling.
#[cfg(feature = "crypto")]
pub(crate) struct CryptoModule;

#[cfg(feature = "crypto")]
impl ModuleDef for CryptoModule {
    fn declare(declare: &Declarations) -> Result<()> {
        quickjs_jit_stdlib::crypto::CryptoModule::declare(declare)
    }

    fn evaluate<'js>(cx: &Ctx<'js>, exports: &Exports<'js>) -> Result<()> {
        let (inner, done) = Module::declare_def::<quickjs_jit_stdlib::crypto::CryptoModule, _>(
            cx.clone(),
            "nsh:crypto-llrt",
        )?
        .eval()?;
        done.finish::<()>()?;
        let default: Object = inner.namespace()?.get("default")?;
        guard_random_bytes(cx, &default)?;
        for key in default.keys::<String>() {
            let key = key?;
            exports.export(key.as_str(), default.get::<_, Value>(key.as_str())?)?;
        }
        exports.export("default", default)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::{Host, HostOptions, Limits};

    #[test]
    fn sizes_past_the_heap_limit_throw_instead_of_aborting() {
        let host = Host::with_options(HostOptions {
            limits: Limits {
                memory_bytes: 16 << 20,
                ..Limits::default()
            },
            ..HostOptions::default()
        })
        .unwrap();
        host.eval_source(
            r#"
            import { Buffer as B } from 'buffer';
            import crypto, { randomBytes } from 'crypto';
            const refused = (f) => { try { f(); return 'made'; } catch (e) { return `${e instanceof RangeError}:${e.code}`; } };
            globalThis.result = [
              refused(() => Buffer.alloc(2 ** 45)),
              refused(() => B.allocUnsafe(2 ** 45)),
              refused(() => Buffer.allocUnsafeSlow(17 << 20)),
              refused(() => randomBytes(2 ** 45)),
              refused(() => crypto.randomBytes(2 ** 45)),
              refused(() => globalThis.crypto.randomBytes(2 ** 45)),
              B === Buffer,
              Buffer.alloc(3, 1).join(),
              Buffer.alloc(2, 'ab', 'utf8').toString(),
              [...Buffer.allocUnsafe(4)].every((b) => b === 0),
              randomBytes(8).length,
            ].join('|');
            "#,
        )
        .unwrap();
        assert!(
            host.eval_script(
                "result",
                "if (result !== 'true:ERR_OUT_OF_RANGE|true:ERR_OUT_OF_RANGE|true:ERR_OUT_OF_RANGE|true:ERR_OUT_OF_RANGE|true:ERR_OUT_OF_RANGE|true:ERR_OUT_OF_RANGE|true|1,1,1|ab|true|8') throw Error(result); true"
            )
            .unwrap()
        );
    }
}
