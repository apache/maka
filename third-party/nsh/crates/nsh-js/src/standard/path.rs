//! Browser paths use POSIX syntax and the virtual working directory `/`.
//! Pure operations remain upstream's; only cwd-dependent calls are adapted.
use rquickjs::{
    Ctx, Module, Object, Result, Value,
    function::{Func, Rest},
    module::{Declarations, Exports, ModuleDef},
};

pub(crate) struct PathModule;

fn resolve(parts: Rest<String>) -> String {
    let start = parts
        .0
        .iter()
        .rposition(|part| part.starts_with('/'))
        .unwrap_or(0);
    quickjs_jit_stdlib::path::join_path(
        std::iter::once("/").chain(parts.0[start..].iter().map(String::as_str)),
    )
}

fn relative(from: String, to: String) -> Result<String> {
    quickjs_jit_stdlib::path::relative(resolve(Rest(vec![from])), resolve(Rest(vec![to])))
}

impl ModuleDef for PathModule {
    fn declare(declarations: &Declarations) -> Result<()> {
        quickjs_jit_stdlib::path::PathModule::declare(declarations)
    }

    fn evaluate<'js>(cx: &Ctx<'js>, exports: &Exports<'js>) -> Result<()> {
        let (inner, ready) = Module::declare_def::<quickjs_jit_stdlib::path::PathModule, _>(
            cx.clone(),
            "nsh:path-portable",
        )?
        .eval()?;
        ready.finish::<()>()?;
        let default: Object = inner.namespace()?.get("default")?;
        default.set("resolve", Func::from(resolve))?;
        default.set("relative", Func::from(relative))?;
        for name in default.keys::<String>() {
            let name = name?;
            exports.export(name.as_str(), default.get::<_, Value>(&name)?)?;
        }
        exports.export("default", default)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_cwd_resolves_and_relativizes_browser_paths() {
        let _module = PathModule;
        for (parts, expected) in [
            (vec![], "/"),
            (vec!["foo", "../bar"], "/bar"),
            (vec!["/foo", "/bar", "baz"], "/bar/baz"),
            (vec!["../../foo"], "/foo"),
        ] {
            assert_eq!(
                resolve(Rest(parts.into_iter().map(str::to_owned).collect())),
                expected
            );
        }
        assert_eq!(
            relative("docs/a".into(), "images/b".into()).unwrap(),
            "../../images/b"
        );
    }
}
