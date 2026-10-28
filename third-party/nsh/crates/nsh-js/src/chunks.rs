//! The chunks of a split bundle (`nsh-bundler` `BundleOptions::split`):
//! `import()` of the app's own modules, loaded on demand.
//!
//! The bundler rewrites a chunk's dynamic imports into
//! `__nsh_import("Screen.js", ["shared.js"])`: the chunk and every chunk it
//! imports statically. QuickJS's module loader cannot wait (it resolves a
//! module's imports while it compiles it), so this asks the host for the
//! chunks it does not have yet ([`crate::Host::take_chunk_requests`]: on the
//! web the page fetches them) and imports the first once all are there
//! ([`crate::Host::add_chunk_source`]); the loader (`modules.rs`) compiles
//! each chunk from the code given. The import itself is QuickJS's
//! (`JS_LoadModule`), so chunks are evaluated once, in order, and share the
//! modules they import.

use std::{cell::RefCell, collections::HashSet, ffi::CString};

use rquickjs::qjs;

use crate::{
    modules::ChunkModule,
    web::js::{self, Args, Ctx, Deferred, R, Raw, UNDEFINED, V, native},
};

/// The chunks a context waits for (empty until a split bundle imports
/// one).
#[derive(Default)]
pub(crate) struct Chunks(RefCell<Inner>);

#[derive(Default)]
struct Inner {
    /// Imports waiting for chunks.
    pending: Vec<Pending>,
    /// Asked of the host, not answered yet.
    requested: HashSet<String>,
    /// Asked, not taken by the host yet.
    queue: Vec<String>,
}

/// An `import()` waiting for its chunks.
struct Pending {
    /// The chunk it imports.
    id: String,
    /// It and the chunks it imports statically.
    needs: Vec<String>,
    deferred: Deferred,
}

impl Chunks {
    /// Frees every JS value it holds (before the context goes).
    pub(crate) fn free_all(&self) {
        drop(std::mem::take(&mut *self.0.borrow_mut()));
    }

    /// Moves the chunks to load into `out`.
    pub(crate) fn take_requests(&self, out: &mut Vec<String>) {
        out.append(&mut self.0.borrow_mut().queue);
    }
}

fn chunks<'a>(cx: Ctx) -> &'a Chunks {
    // SAFETY: a projection of the state's field, reached by shared
    // reference only.
    unsafe { &(*crate::state::state(cx)).chunks }
}

fn table<'a>(cx: Ctx) -> &'a crate::modules::ModuleTable {
    // SAFETY: as `chunks`.
    unsafe { &(*crate::state::state(cx)).modules }
}

/// Installs the global [`nsh_core::js::IMPORT_CHUNK`].
pub(crate) fn install(cx: Ctx) -> R<()> {
    let name = CString::new(nsh_core::js::IMPORT_CHUNK).unwrap_or_default();
    let f = js::function(cx, &name, import_module, 2)?;
    js::define(
        cx,
        js::global(cx).raw(),
        nsh_core::js::IMPORT_CHUNK,
        f,
        false,
    )
}

native! {
    /// `__nsh_import(id, needs)`: the namespace of chunk `id` once it and
    /// the chunks `needs` are there.
    fn import_module(cx, _this, args) {
        let id = js::to_string(cx, args.get(0))?;
        let mut needs = vec![id.clone()];
        if !js::is_nullish(args.get(1)) {
            js::for_each(cx, args.get(1), |v| {
                needs.push(js::to_string(cx, v.raw())?);
                Ok(())
            })?;
        }
        // Chunks are files next to the bundle: a name the app's code made
        // up must not reach another place (the web fetches by it).
        if let Some(bad) = needs.iter().find(|n| !is_chunk_name(n)) {
            let error = js::type_error_value(cx, &format!("'{bad}' is not a chunk of this app"));
            return js::rejected(cx, error.raw());
        }
        let deferred = Deferred::new(cx)?;
        let promise = deferred.promise.clone_ref();
        {
            let available = table(cx).chunks.borrow();
            let mut inner = chunks(cx).0.borrow_mut();
            for need in &needs {
                if !available.has(need) && inner.requested.insert(need.clone()) {
                    inner.queue.push(need.clone());
                }
            }
            inner.pending.push(Pending { id, needs, deferred });
        }
        start_ready(cx);
        Ok(promise)
    }
}

/// A chunk's file name as the bundler makes them (`Screen.js`): nothing
/// that makes it another path or URL (directories, a scheme, a query,
/// escapes).
fn is_chunk_name(name: &str) -> bool {
    name.strip_suffix(".js").is_some_and(|stem| {
        !stem.is_empty()
            && !stem.starts_with('.')
            && !stem
                .chars()
                .any(|c| c.is_control() || "/\\:?#%".contains(c))
    })
}

/// Starts the imports whose chunks are all there.
fn start_ready(cx: Ctx) {
    let ready: Vec<Pending> = {
        let available = table(cx).chunks.borrow();
        let mut inner = chunks(cx).0.borrow_mut();
        let (ready, waiting) = std::mem::take(&mut inner.pending)
            .into_iter()
            .partition(|p| p.needs.iter().all(|n| available.has(n)));
        inner.pending = waiting;
        ready
    };
    for p in ready {
        let Ok(id) = js::string(cx, &p.id) else {
            p.deferred.reject(cx, js::take_exception(cx).raw());
            continue;
        };
        // A job: an import made while a module evaluates must not evaluate
        // another one inside it.
        let mut args = [p.deferred.resolve.raw(), p.deferred.reject.raw(), id.raw()];
        // SAFETY: the job keeps its own references to the arguments.
        unsafe { qjs::JS_EnqueueJob(cx, Some(load_job), 3, args.as_mut_ptr()) };
    }
}

/// Imports chunk `argv[2]` and settles the import with `argv[0]` /
/// `argv[1]`.
unsafe extern "C" fn load_job(cx: Ctx, argc: std::ffi::c_int, argv: *mut Raw) -> Raw {
    // SAFETY: the job's three arguments.
    let args = unsafe { Args::new(argc, argv) };
    let (resolve, reject) = (args.get(0), args.get(1));
    let settled = js::to_string(cx, args.get(2)).and_then(|id| {
        let id = CString::new(id).map_err(|_| js::type_error(cx, "bad chunk id"))?;
        let base = CString::new(nsh_core::js::ENTRY_CHUNK).unwrap_or_default();
        // SAFETY: a live context; names are NUL-terminated.
        V::checked(cx, unsafe {
            qjs::JS_LoadModule(cx, base.as_ptr(), id.as_ptr())
        })
    });
    let _ = match settled {
        // Resolving with the loading promise follows it.
        Ok(namespace) => js::call(cx, resolve, UNDEFINED, &[namespace.raw()]),
        Err(_) => {
            let error = js::take_exception(cx);
            js::call(cx, reject, UNDEFINED, &[error.raw()])
        }
    };
    UNDEFINED
}

/// Gives the context chunk `id`, and starts the imports it completes.
pub(crate) fn add(cx: Ctx, id: &str, code: ChunkModule) {
    {
        let mut available = table(cx).chunks.borrow_mut();
        if available.loaded.contains(id) {
            return;
        }
        available.code.insert(id.to_owned(), code);
    }
    chunks(cx).0.borrow_mut().requested.remove(id);
    start_ready(cx);
}

/// Chunk `id` could not be loaded: the imports that need it fail with
/// `message` (a later import asks for it again).
pub(crate) fn failed(cx: Ctx, id: &str, message: &str) {
    let failed: Vec<Pending> = {
        let mut inner = chunks(cx).0.borrow_mut();
        inner.requested.remove(id);
        let (failed, waiting) = std::mem::take(&mut inner.pending)
            .into_iter()
            .partition(|p| p.needs.iter().any(|n| n == id));
        inner.pending = waiting;
        failed
    };
    for p in failed {
        let message = match p.id == id {
            true => format!("could not load chunk '{id}': {message}"),
            false => format!("could not load chunk '{id}' (for '{}'): {message}", p.id),
        };
        let error = js::type_error_value(cx, &message);
        p.deferred.reject(cx, error.raw());
    }
}

#[cfg(test)]
mod tests {
    use crate::Host;

    fn requests(host: &Host) -> Vec<String> {
        let mut out = Vec::new();
        host.take_chunk_requests(&mut out);
        out
    }

    fn log_is(host: &Host, expected: &str) -> bool {
        host.eval_script("check.js", &format!("log.join('|') === {expected:?}"))
            .unwrap()
    }

    #[test]
    fn imports_wait_for_their_chunks_and_share_what_they_import() {
        let host = Host::new().unwrap();
        // Given up front, as native hosts do.
        host.add_chunk_source(
            "shared.js",
            "import { base } from \"./bundle.js\"; export let count = 0; export const next = () => base + ++count;".into(),
            None,
        );
        host.eval_source(
            r#"
            import { importModule } from "nsh";
            export const base = 40;
            globalThis.log = [];
            globalThis.load = (id, needs) => importModule(id, needs).then(
              (m) => log.push(m.value), (e) => log.push(e.message));
            load("a.js", ["shared.js"]);
            "#,
        )
        .unwrap();
        // Only what is missing is asked for, once.
        assert_eq!(requests(&host), ["a.js"]);
        host.eval_script("again.js", "load('a.js', ['shared.js'])")
            .unwrap();
        assert!(requests(&host).is_empty());
        assert!(log_is(&host, ""));
        host.add_chunk_source(
            "a.js",
            "import { next } from \"./shared.js\"; export const value = next();".into(),
            None,
        );
        // Evaluated once: both imports see the same module.
        assert!(log_is(&host, "41|41"));
        host.eval_script("b.js", "load('b.js', ['shared.js'])")
            .unwrap();
        host.add_chunk_source(
            "b.js",
            "import { next } from \"./shared.js\"; export const value = next();".into(),
            None,
        );
        assert!(log_is(&host, "41|41|42"));
    }

    #[test]
    fn a_chunk_that_fails_to_load_rejects_and_is_asked_for_again() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            import { importModule } from "nsh";
            globalThis.log = [];
            globalThis.load = () => importModule("a.js").then(
              (m) => log.push(m.value), (e) => log.push(e.message));
            load();
            "#,
        )
        .unwrap();
        assert_eq!(requests(&host), ["a.js"]);
        host.chunk_failed("a.js", "404 Not Found");
        assert!(log_is(&host, "could not load chunk 'a.js': 404 Not Found"));
        host.eval_script("retry.js", "load()").unwrap();
        assert_eq!(requests(&host), ["a.js"]);
        host.add_chunk_source("a.js", "export const value = 'ok';".into(), None);
        assert!(log_is(
            &host,
            "could not load chunk 'a.js': 404 Not Found|ok"
        ));
    }

    #[test]
    fn only_chunk_names_are_asked_for() {
        let host = Host::new().unwrap();
        host.eval_source(
            r#"
            globalThis.log = [];
            for (const id of ["https://example.com/x.js", "../x.js", "a/b.js", ".js", "x.mjs"]) {
              __nsh_import(id, []).catch((e) => log.push(e.message));
            }
            __nsh_import("ok.js", ["../up.js"]).catch((e) => log.push(e.message));
            "#,
        )
        .unwrap();
        assert!(requests(&host).is_empty());
        assert!(
            host.eval_script(
                "check.js",
                "log.length === 6 && log.every((m) => m.endsWith('is not a chunk of this app'))"
            )
            .unwrap()
        );
    }

    #[test]
    fn bytecode_chunks_load_like_source() {
        let entry = "export const base = 1; globalThis.log = []; __nsh_import('a.js', []).then((m) => log.push(m.value));";
        let chunks = [(
            "a.js",
            "import { base } from \"./bundle.js\"; export const value = base + 1;",
        )];
        let entry_bytecode = crate::compile_bytecode(entry, true).unwrap();
        let compiled = crate::compile_chunk_bytecode(entry, &chunks, true, &[]).unwrap();
        let host = Host::new().unwrap();
        // SAFETY: just compiled with this build.
        unsafe { host.add_chunk_bytecode("a.js", compiled[0].clone(), None) };
        host.eval_bytecode(&entry_bytecode).unwrap();
        assert!(log_is(&host, "2"));
    }
}
