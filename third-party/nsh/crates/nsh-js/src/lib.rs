//! QuickJS host for nsh.
//!
//! [`Host`] owns one QuickJS runtime and context, installs the globals
//! apps use (`console`, timers, web APIs such as `fetch`), serves nsh's
//! native modules (`nsh`, `nsh:rt`, `nsh/*`: the reactive graph, the
//! renderer, components), queues what the app changes as
//! [`nsh_core::Op`]s and dispatches native events back into JS.
//!
//! A host is single-threaded (`!Send`): create and use it on the engine
//! thread.

mod animated;
mod bytecode;
mod canvas;
mod chunks;
mod classes;
mod clock;
mod components;
mod console;
mod declarations;
mod desktop;
mod dom;
mod env;
mod error;
mod host;
mod host_channel;
mod hot;
mod input_action;
mod keymap;
mod list;
mod modules;
mod navigation;
mod net;
mod platform_modules;
mod protocol;
mod reactive;
mod rejections;
mod resource;
mod sandbox;
mod standard;
mod state;
mod timers;
mod touch;
mod web;

// The typed API check (docs/dev/geometry.md, "Typed API"): the scan is
// nsh-core's; this crate's lists are `unitless.txt` and `untyped.txt`.
#[cfg(test)]
#[path = "../../nsh-core/src/geometry/unit_scan.rs"]
mod unit_scan;

#[cfg(test)]
#[test]
fn public_api_is_typed() {
    unit_scan::check(std::path::Path::new(env!("CARGO_MANIFEST_DIR")), &[]);
}

pub use nsh_core::{
    js::Limits,
    platform::{ColorScheme, Environment, Idiom, Os, Renderer},
};

pub use crate::{
    bytecode::{
        BUNDLE_NAME, BYTECODE_VERSION, Strip, compile_bytecode, compile_bytecode_with,
        compile_chunk_bytecode,
    },
    declarations::type_definitions,
    error::JsError,
    host::{ErrorHandler, Host, HostOptions, TextMeasurer},
    net::{FetchEvent, FetchOp, HttpBody, HttpHead, HttpRequest, NetworkQueue, RequestId},
};

/// The names native module `specifier` exports, if it is one: nsh's own
/// modules, the runtime's and those of `ui_sets` (a bundler checks named
/// imports against them).
pub fn native_module_exports(
    specifier: &str,
    ui_sets: &[nsh_core::element::description::SetDescription],
) -> Option<Vec<String>> {
    modules::ModuleTable::compiling(ui_sets).export_names(specifier)
}
