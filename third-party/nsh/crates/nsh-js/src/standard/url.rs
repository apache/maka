//! Standard URL utilities share the existing WHATWG constructors and brands.
use rquickjs::{
    Class, Ctx, FromJs, Function, JsLifetime, Object, Result, Value,
    class::{ClassKind, JsCell, JsClass, Readable, Trace, Tracer},
    function::{Constructor, Func, Params},
    module::{Declarations, Exports, ModuleDef},
};
#[cfg(not(target_arch = "wasm32"))]
use rquickjs::{Coerced, IntoJs, function::Opt};

fn domain_to_ascii(domain: &str) -> String {
    url::quirks::domain_to_ascii(domain)
}
fn domain_to_unicode(domain: &str) -> String {
    url::quirks::domain_to_unicode(domain)
}

#[cfg(any(target_arch = "wasm32", test))]
mod browser;
#[cfg(target_arch = "wasm32")]
use browser::{file_url_to_path, format, url_to_http_options};

pub(crate) struct UrlModule;

struct FileUrlConstructor<'js>(Constructor<'js>);
// SAFETY: the only lifetime-bearing field is the traced constructor handle.
unsafe impl<'js> JsLifetime<'js> for FileUrlConstructor<'js> {
    type Changed<'to> = FileUrlConstructor<'to>;
}
impl<'js> Trace<'js> for FileUrlConstructor<'js> {
    fn trace<'a>(&self, tracer: Tracer<'a, 'js>) {
        self.0.trace(tracer);
    }
}
impl<'js> JsClass<'js> for FileUrlConstructor<'js> {
    const NAME: &'static str = "NshFileUrlConstructor";
    const KIND: ClassKind = ClassKind::Callable;
    type Mutable = Readable;
    fn prototype(cx: &Ctx<'js>) -> Result<Option<Object<'js>>> {
        Ok(Some(Function::prototype(cx.clone())))
    }
    fn constructor(_: &Ctx<'js>) -> Result<Option<Constructor<'js>>> {
        Ok(None)
    }
    fn call<'a>(this: &JsCell<'js, Self>, params: Params<'a, 'js>) -> Result<Value<'js>> {
        let cx = params.ctx();
        let input = params
            .arg(0)
            .unwrap_or_else(|| Value::new_undefined(cx.clone()));
        let path = String::from_js(cx, input)?;
        path_to_file_url(cx, &this.borrow().0, path).map(Value::from_object)
    }
}
const METHODS: &[&str] = &[
    "URL",
    "URLSearchParams",
    "domainToASCII",
    "domainToUnicode",
    "fileURLToPath",
    "pathToFileURL",
    "format",
    "urlToHttpOptions",
];

fn path_to_file_url<'js>(
    cx: &Ctx<'js>,
    constructor: &Constructor<'js>,
    path: String,
) -> Result<Object<'js>> {
    #[cfg(not(target_arch = "wasm32"))]
    let href = quickjs_jit_stdlib::url::path_to_file_url(cx.clone(), path, Opt(None))?.href();
    #[cfg(target_arch = "wasm32")]
    let href = {
        let _ = cx;
        browser::file_href(&path)
    };
    constructor.construct((href,))
}

#[cfg(not(target_arch = "wasm32"))]
fn file_url_to_path<'js>(cx: Ctx<'js>, input: Coerced<String>) -> Result<String> {
    quickjs_jit_stdlib::url::file_url_to_path(cx.clone(), input.0.into_js(&cx)?)
}

#[cfg(not(target_arch = "wasm32"))]
fn native_url<'js>(
    cx: &Ctx<'js>,
    input: &str,
) -> Result<Class<'js, quickjs_jit_stdlib::url::url_class::URL<'js>>> {
    Class::instance(
        cx.clone(),
        quickjs_jit_stdlib::url::url_class::URL::from_str(cx.clone(), input)?,
    )
}

#[cfg(not(target_arch = "wasm32"))]
fn format<'js>(cx: Ctx<'js>, input: Coerced<String>, options: Opt<Value<'js>>) -> Result<String> {
    quickjs_jit_stdlib::url::url_format(native_url(&cx, &input.0)?, options)
}

#[cfg(not(target_arch = "wasm32"))]
fn url_to_http_options<'js>(cx: Ctx<'js>, input: Coerced<String>) -> Result<Object<'js>> {
    quickjs_jit_stdlib::url::url_class::url_to_http_options(cx.clone(), native_url(&cx, &input.0)?)
}

impl ModuleDef for UrlModule {
    fn declare(declarations: &Declarations) -> Result<()> {
        declarations.declare("default")?;
        for name in METHODS {
            declarations.declare(*name)?;
        }
        Ok(())
    }
    fn evaluate<'js>(cx: &Ctx<'js>, exports: &Exports<'js>) -> Result<()> {
        let module = Object::new(cx.clone())?;
        module.set("URL", cx.globals().get::<_, Value>("URL")?)?;
        module.set(
            "URLSearchParams",
            cx.globals().get::<_, Value>("URLSearchParams")?,
        )?;
        module.set(
            "domainToASCII",
            Func::from(|domain: String| domain_to_ascii(&domain)),
        )?;
        module.set(
            "domainToUnicode",
            Func::from(|domain: String| domain_to_unicode(&domain)),
        )?;
        let constructor: Constructor = cx.globals().get("URL")?;
        module.set(
            "pathToFileURL",
            Class::instance(cx.clone(), FileUrlConstructor(constructor))?.into_inner(),
        )?;
        module.set("fileURLToPath", Func::from(file_url_to_path))?;
        module.set("format", Func::from(format))?;
        module.set("urlToHttpOptions", Func::from(url_to_http_options))?;
        for name in METHODS {
            exports.export(*name, module.get::<_, Value>(*name)?)?;
        }
        exports.export("default", module)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn llrt_initialization_preserves_native_web_constructor_identity() {
        let host = crate::Host::new().unwrap();
        host.with_raw(|raw| {
            // SAFETY: with_raw holds this live runtime's context lock, and no
            // value from the temporary Ctx escapes the closure.
            let cx = unsafe { rquickjs::Ctx::from_raw(std::ptr::NonNull::new(raw).unwrap()) };
            let globals = cx.globals();
            let names = [
                "Blob",
                "File",
                "URL",
                "URLSearchParams",
                "Event",
                "ReadableStream",
                "AbortController",
            ];
            let before = names.map(|name| globals.get::<_, rquickjs::Value>(name).unwrap());
            super::super::install(&cx).unwrap();
            for (name, before) in names.into_iter().zip(before) {
                let after = globals.get::<_, rquickjs::Value>(name).unwrap();
                assert_eq!(
                    before, after,
                    "LLRT replaced the existing {name} constructor"
                );
            }
        });
    }
}
