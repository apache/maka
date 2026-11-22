//! `zlib`: LLRT's compression API with an output ceiling NSH enforces.
//!
//! Decompressed output lives in Rust memory the heap limit does not cover
//! until it becomes a JS buffer, so a small payload (a 1 MiB gzip of zeros
//! inflates to 1 GiB) could take far more memory than the VM is given. Every
//! decompression entry point, sync and callback, therefore runs with
//! `maxOutputLength` at most [`ceiling`]; a caller's own `maxOutputLength`
//! may only lower it. LLRT's module is wrapped rather than patched: it is
//! evaluated as an inner module and its functions are exported again, the
//! decompressors behind the clamp.
use rquickjs::{
    Class, Ctx, Exception, Function, JsLifetime, Module, Object, Result, Value,
    class::{ClassKind, JsCell, JsClass, Readable, Trace, Tracer},
    function::{Constructor, Params},
    module::{Declarations, Exports, ModuleDef},
};

/// The largest output one decompression may produce, unless the VM's heap
/// limit is smaller.
const MAX_OUTPUT: usize = 64 * 1024 * 1024;

/// Exported unchanged: their output is bounded by their input.
const COMPRESSORS: &[&str] = &[
    "deflate",
    "deflateSync",
    "deflateRaw",
    "deflateRawSync",
    "gzip",
    "gzipSync",
    "brotliCompress",
    "brotliCompressSync",
    "zstdCompress",
    "zstdCompressSync",
];

/// Exported behind the ceiling; `(name, takes a callback)`.
const DECOMPRESSORS: &[(&str, bool)] = &[
    ("inflate", true),
    ("inflateSync", false),
    ("inflateRaw", true),
    ("inflateRawSync", false),
    ("gunzip", true),
    ("gunzipSync", false),
    ("brotliDecompress", true),
    ("brotliDecompressSync", false),
    ("zstdDecompress", true),
    ("zstdDecompressSync", false),
];

pub(crate) struct ZlibModule;

/// One of LLRT's decompressors behind the ceiling. A callable class rather
/// than a closure, so the garbage collector sees the function it holds.
struct Bounded<'js> {
    inner: Function<'js>,
    callback: bool,
}
// SAFETY: the only lifetime-bearing field is the traced function handle.
unsafe impl<'js> JsLifetime<'js> for Bounded<'js> {
    type Changed<'to> = Bounded<'to>;
}
impl<'js> Trace<'js> for Bounded<'js> {
    fn trace<'a>(&self, tracer: Tracer<'a, 'js>) {
        self.inner.trace(tracer);
    }
}
impl<'js> JsClass<'js> for Bounded<'js> {
    const NAME: &'static str = "NshBoundedDecompressor";
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
        let undefined = || Value::new_undefined(cx.clone());
        let data = params.arg(0).unwrap_or_else(undefined);
        // `(data, options?)`, or `(data, options?, callback)`.
        let count = params.len();
        let (options, callback) = if this.callback {
            let callback = (count > 1).then(|| params.arg(count - 1)).flatten();
            ((count > 2).then(|| params.arg(1)).flatten(), callback)
        } else {
            (params.arg(1), None)
        };
        let options = bounded_options(&cx, options)?;
        match callback {
            Some(callback) => this.inner.call((data, options, callback)),
            None => this.inner.call((data, options)),
        }
    }
}

fn names() -> impl Iterator<Item = &'static str> {
    COMPRESSORS
        .iter()
        .copied()
        .chain(DECOMPRESSORS.iter().map(|(name, _)| *name))
}

impl ModuleDef for ZlibModule {
    fn declare(declare: &Declarations) -> Result<()> {
        for name in names() {
            declare.declare(name)?;
        }
        declare.declare("default")?;
        Ok(())
    }

    fn evaluate<'js>(cx: &Ctx<'js>, exports: &Exports<'js>) -> Result<()> {
        let (inner, done) = Module::declare_def::<quickjs_jit_stdlib::zlib::ZlibModule, _>(
            cx.clone(),
            "nsh:zlib-llrt",
        )?
        .eval()?;
        done.finish::<()>()?;
        let inner: Object = inner.namespace()?.get("default")?;
        let default = Object::new(cx.clone())?;
        for name in COMPRESSORS {
            default.set(*name, inner.get::<_, Value>(*name)?)?;
        }
        for &(name, callback) in DECOMPRESSORS {
            let function: Function = inner.get(name)?;
            let bounded = Class::instance(
                cx.clone(),
                Bounded {
                    inner: function,
                    callback,
                },
            )?;
            default.set(name, bounded)?;
        }
        for name in names() {
            exports.export(name, default.get::<_, Value>(name)?)?;
        }
        exports.export("default", default)?;
        Ok(())
    }
}

/// The VM's ceiling on one decompression's output: [`MAX_OUTPUT`], or the
/// heap limit when that is smaller.
fn ceiling(cx: &Ctx<'_>) -> usize {
    match crate::dom::shared(cx.as_raw().as_ptr()).limits.memory_bytes {
        0 => MAX_OUTPUT,
        heap => heap.min(MAX_OUTPUT),
    }
}

/// A copy of the caller's options whose `maxOutputLength` is at most the
/// ceiling.
fn bounded_options<'js>(cx: &Ctx<'js>, options: Option<Value<'js>>) -> Result<Object<'js>> {
    let bounded = Object::new(cx.clone())?;
    let mut limit = ceiling(cx);
    if let Some(options) = options.and_then(Value::into_object) {
        for entry in options.props::<String, Value>() {
            let (key, value) = entry?;
            bounded.set(key, value)?;
        }
        let requested: Value = options.get("maxOutputLength")?;
        if !requested.is_undefined() {
            let requested = requested.as_number().ok_or_else(|| {
                Exception::throw_type(cx, "options.maxOutputLength must be a number")
            })?;
            if requested.is_nan() || requested < 0.0 {
                return Err(Exception::throw_range(
                    cx,
                    "options.maxOutputLength must be a non-negative number",
                ));
            }
            if requested < limit as f64 {
                limit = requested as usize;
            }
        }
    }
    bounded.set("maxOutputLength", limit)?;
    Ok(bounded)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use nsh_core::js::Limits;

    use crate::{Host, HostOptions};

    /// A JS expression making a `Uint8Array` of `bytes` (from a hex string:
    /// an array literal would take much of the small heap).
    fn literal(bytes: &[u8]) -> String {
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        format!("bytes('{hex}')")
    }

    /// Small payloads of one byte more zeros than a 16 MiB heap's ceiling,
    /// which every decompressor, sync and callback, must refuse whatever
    /// `maxOutputLength` the caller asks for.
    #[test]
    fn decompression_output_is_capped() {
        const HEAP: usize = 16 * 1024 * 1024;
        let zeros = vec![0u8; HEAP + 1];
        let best = flate2::Compression::best();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), best);
        let mut deflate = flate2::write::ZlibEncoder::new(Vec::new(), best);
        let mut raw = flate2::write::DeflateEncoder::new(Vec::new(), best);
        gzip.write_all(&zeros).unwrap();
        deflate.write_all(&zeros).unwrap();
        raw.write_all(&zeros).unwrap();
        let (gzip, deflate, raw) = (
            gzip.finish().unwrap(),
            deflate.finish().unwrap(),
            raw.finish().unwrap(),
        );
        let mut brotli = Vec::new();
        {
            let mut e = brotli::CompressorWriter::new(&mut brotli, 4096, 1, 22);
            e.write_all(&zeros).unwrap();
        }
        let zstd = zstd::stream::encode_all(&zeros[..], 1).unwrap();
        for bomb in [&gzip, &deflate, &raw, &brotli, &zstd] {
            assert!(bomb.len() * 100 < HEAP, "{}", bomb.len());
        }
        let host = Host::with_options(HostOptions {
            limits: Limits {
                memory_bytes: HEAP,
                ..Limits::default()
            },
            ..HostOptions::default()
        })
        .unwrap();
        host.eval_source(&format!(
            r#"
            import zlib, {{ gunzipSync, inflateSync }} from 'zlib';
            function bytes(hex) {{
              const out = new Uint8Array(hex.length / 2);
              for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
              return out;
            }}
            const bombs = {{
              gunzip: {}, inflate: {}, inflateRaw: {}, brotliDecompress: {}, zstdDecompress: {},
            }};
            const refused = (e) => e instanceof RangeError && /{HEAP}/.test(String(e));
            const checks = {{}};
            for (const [name, bomb] of Object.entries(bombs)) {{
              for (const options of [undefined, {{ maxOutputLength: 1e12 }}, {{ maxOutputLength: Infinity }}]) {{
                try {{ zlib[name + 'Sync'](bomb, options); checks[name + 'Sync'] = false; }}
                catch (e) {{ checks[name + 'Sync'] = checks[name + 'Sync'] !== false && refused(e); }}
              }}
            }}
            checks.named = gunzipSync === zlib.gunzipSync && inflateSync === zlib.inflateSync;
            // Under the ceiling, with a caller's lower limit and other options kept.
            const small = zlib.gzipSync(new Uint8Array(1000));
            checks.fits = gunzipSync(small).length === 1000;
            try {{ gunzipSync(small, {{ maxOutputLength: 999 }}); checks.lowered = false; }}
            catch (e) {{ checks.lowered = /999/.test(String(e)); }}
            try {{ gunzipSync(small, {{ maxOutputLength: -1 }}); checks.negative = false; }}
            catch (e) {{ checks.negative = e instanceof RangeError; }}
            globalThis.checks = checks;
            globalThis.calls = {{}};
            for (const [name, bomb] of Object.entries(bombs)) {{
              zlib[name](bomb, (e) => {{ calls[name] = refused(e); }});
              zlib[name](bomb, {{ maxOutputLength: 1e12 }}, (e) => {{ calls[name + 'Raised'] = refused(e); }});
            }}
            zlib.gunzip(small, (e, out) => {{ calls.fits = e === null && out.length === 1000; }});
            "#,
            literal(&gzip),
            literal(&deflate),
            literal(&raw),
            literal(&brotli),
            literal(&zstd),
        ))
        .unwrap();
        assert!(
            host.eval_script(
                "checks",
                "Object.keys(checks).length === 9 && Object.values(checks).every(v => v === true)"
            )
            .unwrap(),
            "a decompressor went past the ceiling"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !host
            .eval_script("calls", "Object.keys(calls).length === 11")
            .unwrap()
        {
            assert!(std::time::Instant::now() < deadline, "callbacks never ran");
            host.run_jobs();
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(
            host.eval_script("calls", "Object.values(calls).every(v => v === true)")
                .unwrap()
        );
    }
}
