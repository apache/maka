//! Standard console imports reuse NSH's per-VM logger and its formatting.
//!
//! The facade exports the existing global object without adding stream handles,
//! environment access or another logger. Its surface matches the five methods
//! installed by `crate::console`; no Node Console constructor is advertised.

use rquickjs::{
    Ctx, Object, Result,
    module::{Declarations, Exports, ModuleDef},
};

/// The standard `console` module implementation.
pub(crate) struct ConsoleModule;

impl ModuleDef for ConsoleModule {
    fn declare(declarations: &Declarations) -> Result<()> {
        declarations.declare("default")?;
        Ok(())
    }

    fn evaluate<'js>(cx: &Ctx<'js>, exports: &Exports<'js>) -> Result<()> {
        let console: Object = cx.globals().get("console")?;
        exports.export("default", console)?;
        Ok(())
    }
}

/// The module's declaration: the global `console`'s type
/// (`crate::host::GLOBALS`), its one source, so the two never differ.
pub(crate) const TYPES: &str = r#"
/** Per-VM logging through the host's logger: the global `console`. */
declare const console: typeof globalThis.console;
export default console;
"#;

#[cfg(test)]
mod tests {
    use nsh_core::Op;

    use crate::Host;

    fn run(host: &Host, source: &str) -> String {
        host.eval_source(source).unwrap();
        let mut ops = Vec::new();
        host.take_ops(&mut ops);
        ops.into_iter()
            .rev()
            .find_map(|op| match op {
                Op::CreateText { text, .. } => Some(text),
                _ => None,
            })
            .expect("console fixture output")
    }

    #[test]
    fn module_exports_the_existing_logger_object_and_only_the_supported_surface() {
        let host = Host::new().unwrap();
        let out = run(
            &host,
            r#"
            import bare from 'console';
            import node, * as namespace from 'console';
            import {text} from 'nsh:rt';
            for (const name of ['log','info','debug','warn','error']) {
                bare[name]('console module fixture', {ok:true});
            }
            text(JSON.stringify([bare === node, node === globalThis.console,
                Object.keys(namespace).sort(), Object.keys(node).sort(),
                ['log','info','debug','warn','error'].every(name =>
                    typeof node[name] === 'function' && node[name] === globalThis.console[name]),
                typeof node.Console]));
        "#,
        );
        assert_eq!(
            out,
            r#"[true,true,["default"],["debug","error","info","log","warn"],true,"undefined"]"#
        );
    }

    /// The module's type is the global's, and the global's declaration
    /// lists exactly the methods the runtime's console has.
    #[test]
    fn the_module_and_the_global_share_one_declaration() {
        assert!(super::TYPES.contains("declare const console: typeof globalThis.console;"));
        assert!(
            !super::TYPES.contains("void"),
            "no second copy of the signatures"
        );
        let global = crate::host::GLOBALS
            .split("declare var console: {")
            .nth(1)
            .and_then(|rest| rest.split("};").next())
            .expect("the global console's declaration");
        let mut declared: Vec<&str> = global
            .lines()
            .filter_map(|line| line.trim().split('(').next())
            .filter(|name| !name.is_empty())
            .collect();
        declared.sort_unstable();
        let host = Host::new().unwrap();
        let out = run(
            &host,
            "import {text} from 'nsh:rt'; text(Object.keys(console).sort().join(','));",
        );
        assert_eq!(declared.join(","), out);
    }

    #[test]
    fn console_objects_are_isolated_between_vms() {
        let first = Host::new().unwrap();
        let second = Host::new().unwrap();
        first
            .eval_source("import console from 'console'; console.localMarker = 'first';")
            .unwrap();
        let out = run(
            &second,
            r#"
            import console from 'console'; import {text} from 'nsh:rt';
            text(JSON.stringify([typeof console.localMarker, console === globalThis.console]));
        "#,
        );
        assert_eq!(out, r#"["undefined",true]"#);
    }
}
