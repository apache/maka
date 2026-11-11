//! Hot module replacement (development bundles only): the module system
//! and component registry behind `__nsh_hot`.
//!
//! A development bundle (`nsh-bundler` `HotBundle`) defines every module
//! as a factory (rolldown CommonJS output, one chunk per module) and
//! starts the entry with the namespaces of the native modules it imports
//! (`import "nsh:hot"` makes `__nsh_hot`). An update script redefines the
//! modules that changed; `update` runs them again, together with the
//! importers that cannot take the change on their own, in place: the JS
//! context, the native views and every other module keep their state.
//!
//! Components (top-level functions returning JSX, wrapped by the bundler)
//! are registered by module and name and rendered through a stable proxy.
//! Running a module again swaps the implementation behind its proxies; the
//! mounted instances whose code changed render again. Contexts keep their
//! identity across updates, so providers and consumers stay connected, and
//! so do the top-level signals and navigators the bundler marks
//! (`keep`) while their initializer's code is the same. A `mount` call made
//! again with the same component (a proxy) keeps what it mounted: only the
//! components whose code changed render again, and a navigator keeps its
//! screens. Other `mount` calls of a module that runs again are undone, from
//! the first one that differs, and made anew.

use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap},
    ffi::CString,
};

use rquickjs::qjs;

use crate::web::js::{
    self, Args, Ctx, R, Raw, UNDEFINED, V, closure, function, get, native, new_object, type_error,
};

/// The module dev bundles import for `__nsh_hot`.
pub(crate) const SPECIFIER: &str = "nsh:hot";

/// Name of the global.
const GLOBAL: &std::ffi::CStr = c"__nsh_hot";

/// The exports of [`SPECIFIER`].
pub(crate) const EXPORTS: &[crate::modules::Item] = &[(
    "hot",
    crate::modules::Export::Value(install),
    crate::modules::Ts::Internal,
)];

/// A context's hot state (empty until a development bundle starts).
#[derive(Default)]
pub(crate) struct Hot(RefCell<Inner>);

#[derive(Default)]
struct Inner {
    /// Module id -> factory(module, exports, require).
    factories: HashMap<String, V>,
    /// Modules that never run again (rolldown's runtime).
    fixed: BTreeSet<String>,
    modules: HashMap<String, Module>,
    /// Module id -> the ids of the modules that required it.
    importers: BTreeMap<String, BTreeSet<String>>,
    /// "module:name" -> component.
    components: HashMap<String, Component>,
    /// "module:name" -> context.
    contexts: HashMap<String, V>,
    /// "module:name" -> the signature of a kept value's initializer, and
    /// the value.
    kept: HashMap<String, (String, V)>,
    /// Module id -> functions undoing what its top-level code did
    /// (`undo_on_rerun`), called before it runs again.
    undo: HashMap<String, Vec<V>>,
    /// Module id -> what its `mount` calls mounted.
    renders: HashMap<String, Vec<Render>>,
    /// Module id -> the renders of its previous run, while it runs again:
    /// the next `mount` call with the same component keeps the first.
    pending: HashMap<String, Vec<Render>>,
    /// Specifier -> namespace of the native modules the app imports.
    natives: V,
    entry: Option<String>,
    /// The module running now.
    current: Option<String>,
    /// Running an update: components whose code did not change still
    /// render again (their module ran because a dependency changed).
    forced: bool,
    /// Components to render again once the update ran.
    stale: Vec<String>,
}

/// A `mount` call.
struct Render {
    /// The component it mounted.
    app: V,
    /// Made outside any module's run (after an `await`): kept with the
    /// entry's renders.
    late: bool,
    /// What `mount` returned: undoes it.
    dispose: V,
}

struct Module {
    /// The first exports object: importers keep it; later runs forward
    /// it to theirs.
    exports: V,
    components: u32,
    /// Takes its own updates: everything it exports is a component.
    accepts: bool,
}

struct Component {
    /// The implementation now.
    fun: V,
    /// Changes with the component's code (or its module's other code).
    sig: String,
    /// A signal the proxy reads: bumped to render again.
    version: V,
    proxy: V,
}

impl Hot {
    /// Frees every JS value it holds (before the context goes).
    pub(crate) fn free_all(&self) {
        drop(std::mem::take(&mut *self.0.borrow_mut()));
    }
}

fn hot<'a>(cx: Ctx) -> &'a Hot {
    // SAFETY: a projection of the state's field, reached by shared
    // reference only.
    unsafe { &(*crate::state::state(cx)).hot }
}

fn with<T>(cx: Ctx, f: impl FnOnce(&mut Inner) -> T) -> T {
    f(&mut hot(cx).0.borrow_mut())
}

/// Makes `__nsh_hot` (a global, which update scripts and the bundler's
/// component wrappers call) and returns it.
fn install(cx: Ctx) -> Raw {
    let made = (|| -> R<V> {
        let obj = new_object(cx)?;
        let methods: [(&std::ffi::CStr, js::Native, i32); 6] = [
            (c"define", define, 3),
            (c"start", start, 2),
            (c"update", update, 1),
            (c"component", component, 4),
            (c"context", context, 3),
            (c"keep", keep, 4),
        ];
        for (name, f, length) in methods {
            let f = function(cx, name, f, length)?;
            let key = name.to_str().unwrap_or_default();
            js::define(cx, obj.raw(), key, f, true)?;
        }
        let global = js::global(cx);
        // SAFETY: a new reference for the global's property.
        let r = unsafe {
            qjs::JS_DefinePropertyValueStr(
                cx,
                global.raw(),
                GLOBAL.as_ptr(),
                qjs::JS_DupValue(cx, obj.raw()),
                qjs::JS_PROP_CONFIGURABLE as i32,
            )
        };
        if r < 0 {
            return Err(js::Throw);
        }
        Ok(obj)
    })();
    match made {
        Ok(v) => v.take(),
        Err(_) => qjs::JS_EXCEPTION,
    }
}

/// `mount(app)` ran: what it returned is undone when the module running
/// now runs again (unless that run mounts `app` again: [`reuse`]). A
/// `mount` outside any module's run (after an `await` in the entry) is
/// undone when the entry runs again.
pub(crate) fn rendered(cx: Ctx, app: Raw, dispose: Raw) {
    with(cx, |h| {
        let late = h.current.is_none();
        if let Some(id) = h.current.clone().or_else(|| h.entry.clone()) {
            h.renders.entry(id).or_default().push(Render {
                app: V::dup(cx, app),
                late,
                dispose: V::dup(cx, dispose),
            });
        }
    });
}

/// `f` undoes what the module running now did at its top level (a
/// keyboard shortcut it bound): it runs before the module runs again.
/// Nothing happens outside a development bundle's module.
pub(crate) fn undo_on_rerun(cx: Ctx, f: V) {
    // Freed with no borrow held when no module runs.
    let _unused = with(cx, |h| match h.current.clone() {
        Some(id) => {
            h.undo.entry(id).or_default().push(f);
            None
        }
        None => Some(f),
    });
}

/// Takes `f` back from what undoes a module's run ([`undo_on_rerun`]):
/// what it undoes ended by itself.
pub(crate) fn forget_undo(cx: Ctx, f: Raw) -> Option<V> {
    with(cx, |h| {
        h.undo.values_mut().find_map(|list| {
            let at = list.iter().position(|v| js::same(v.raw(), f))?;
            Some(list.remove(at))
        })
    })
}

/// `mount(app, props)` is called while a module runs again: when its
/// previous run's next render mounted the same `app` without props, that
/// render stays and its disposer (a new reference) is returned. Otherwise
/// the previous run's remaining renders are undone, so this one mounts
/// after what stays.
///
/// Outside any module's run, an earlier late `mount` of the same `app` is
/// undone first: a run the entry made before it ran again can still finish
/// its `await` and mount after the new run did.
pub(crate) fn reuse(cx: Ctx, app: Raw, props: Raw) -> Option<Raw> {
    // SAFETY: an inline tag check.
    let has_props = unsafe { qjs::JS_IsObject(props) };
    let (kept, undo) = with(cx, |h| {
        let Some(id) = h.current.clone() else {
            let renders = h.renders.get_mut(h.entry.as_ref()?)?;
            let (stale, live): (Vec<_>, Vec<_>) = std::mem::take(renders)
                .into_iter()
                .partition(|r| r.late && js::same(r.app.raw(), app));
            *renders = live;
            return Some((None, stale));
        };
        let pending = h.pending.get_mut(&id)?;
        if !has_props && pending.first().is_some_and(|r| js::same(r.app.raw(), app)) {
            let render = pending.remove(0);
            let dispose = render.dispose.clone_ref();
            h.renders.entry(id).or_default().push(render);
            Some((Some(dispose), Vec::new()))
        } else {
            Some((None, std::mem::take(pending)))
        }
    })?;
    undo_renders(cx, undo);
    kept.map(V::take)
}

fn undo_renders(cx: Ctx, renders: Vec<Render>) {
    for render in renders {
        if js::call(cx, render.dispose.raw(), UNDEFINED, &[]).is_err() {
            js::report_exception(cx);
        }
    }
}

native! {
    /// `define(id, factory, fixed)`: registers a module factory; fixed
    /// modules never run again.
    fn define(cx, _this, args) {
        let id = js::to_string(cx, args.get(0))?;
        let fixed = js::to_bool(cx, args.get(2));
        with(cx, |h| {
            h.factories.insert(id.clone(), V::dup(cx, args.get(1)));
            if fixed {
                h.fixed.insert(id);
            }
        });
        Ok(V::undefined())
    }
}

native! {
    /// `start(entry, natives)`: runs the entry; `natives` maps the native
    /// modules' specifiers to their namespaces.
    fn start(cx, _this, args) {
        let entry = js::to_string(cx, args.get(0))?;
        with(cx, |h| {
            h.entry = Some(entry.clone());
            h.natives = V::dup(cx, args.get(1));
        });
        load(cx, &entry).map(|_| V::undefined())
    }
}

native! {
    /// `update(defs)`: replaces the factories of `defs` (id -> factory) and
    /// runs the modules affected; `false` when the update cannot be applied
    /// in place (the host reloads).
    fn update(cx, _this, args) {
        let defs = args.get(0);
        let mut changed = Vec::new();
        let mut defined = BTreeSet::new();
        for (id, factory) in js::record(cx, defs)? {
            with(cx, |h| {
                if h.modules.contains_key(&id) {
                    changed.push(id.clone());
                }
                h.factories.insert(id.clone(), factory);
            });
            defined.insert(id);
        }
        // The changed modules, and the importers of those that do not take
        // their own updates (up to the entry).
        let Some(order) = with(cx, |h| affected(h, changed)) else {
            return Ok(V::bool(false));
        };
        let mut result = Ok(());
        for id in &order {
            with(cx, |h| h.forced = !defined.contains(id));
            result = run(cx, id);
            if result.is_err() {
                break;
            }
        }
        let stale = with(cx, |h| {
            h.forced = false;
            let stale = std::mem::take(&mut h.stale);
            stale
                .iter()
                .filter_map(|k| h.components.get(k).map(|c| c.version.clone_ref()))
                .collect::<Vec<_>>()
        });
        result?;
        crate::reactive::batch_with(cx, || {
            for version in &stale {
                let n = crate::reactive::peek_number(cx, version.raw()).unwrap_or(0.0);
                crate::reactive::set_signal(cx, version.raw(), qjs::JS_NewFloat64(n + 1.0));
            }
        });
        Ok(V::bool(true))
    }
}

/// The modules to run again for `changed`, dependencies before their
/// importers; `None` when a change reaches a module nothing imports.
fn affected(h: &Inner, changed: Vec<String>) -> Option<Vec<String>> {
    let mut rerun = BTreeSet::new();
    let mut queue = changed;
    while let Some(id) = queue.pop() {
        if !rerun.insert(id.clone()) {
            continue;
        }
        let accepts = h.modules.get(&id).is_some_and(|m| m.accepts);
        if accepts || h.entry.as_deref() == Some(id.as_str()) {
            continue;
        }
        let from = h.importers.get(&id).filter(|f| !f.is_empty())?;
        queue.extend(from.iter().cloned());
    }
    fn visit(
        h: &Inner,
        rerun: &BTreeSet<String>,
        id: &str,
        seen: &mut BTreeSet<String>,
        order: &mut Vec<String>,
    ) {
        if !seen.insert(id.to_owned()) {
            return;
        }
        for (dep, from) in &h.importers {
            if rerun.contains(dep) && from.contains(id) {
                visit(h, rerun, dep, seen, order);
            }
        }
        order.push(id.to_owned());
    }
    let (mut seen, mut order) = (BTreeSet::new(), Vec::new());
    for id in &rerun {
        visit(h, &rerun, id, &mut seen, &mut order);
    }
    Some(order)
}

/// The exports of module `id`, running it the first time.
fn load(cx: Ctx, id: &str) -> R<V> {
    if let Some(exports) = with(cx, |h| h.modules.get(id).map(|m| m.exports.clone_ref())) {
        return Ok(exports);
    }
    let exports = new_object(cx)?;
    with(cx, |h| {
        h.modules.insert(
            id.to_owned(),
            Module {
                exports: exports.clone_ref(),
                components: 0,
                accepts: false,
            },
        )
    });
    run(cx, id)?;
    Ok(exports)
}

/// Runs module `id` (again).
fn run(cx: Ctx, id: &str) -> R<()> {
    let Some((factory, kept, fixed)) = with(cx, |h| {
        let factory = h.factories.get(id)?.clone_ref();
        let module = h.modules.get_mut(id)?;
        module.components = 0;
        // Renders made by an earlier run of this module are kept or
        // replaced by this run's `mount` calls (`reuse`).
        let previous = h.renders.remove(id).unwrap_or_default();
        h.pending.insert(id.to_owned(), previous);
        Some((factory, module.exports.clone_ref(), h.fixed.contains(id)))
    }) else {
        return Err(type_error(cx, &format!("nsh hot: no module {id}")));
    };
    let undo = with(cx, |h| h.undo.remove(id).unwrap_or_default());
    for f in undo {
        if js::call(cx, f.raw(), UNDEFINED, &[]).is_err() {
            js::report_exception(cx);
        }
    }
    let exports = if fixed {
        kept.clone_ref()
    } else {
        new_object(cx)?
    };
    let module = new_object(cx)?;
    js::define(cx, module.raw(), "exports", exports.clone_ref(), true)?;
    let from = id.to_owned();
    let require = closure(cx, Vec::new(), move |cx, _, args| require(cx, &from, args))?;
    let previous = with(cx, |h| h.current.replace(id.to_owned()));
    let ran = js::call(
        cx,
        factory.raw(),
        UNDEFINED,
        &[module.raw(), exports.raw(), require.raw()],
    );
    with(cx, |h| h.current = previous);
    // What this run did not mount again.
    let left = with(cx, |h| h.pending.remove(id).unwrap_or_default());
    undo_renders(cx, left);
    ran?;
    if !js::same(exports.raw(), kept.raw()) {
        forward(cx, &kept, &exports)?;
    }
    let accepts = accepts(cx, id, &kept)?;
    with(cx, |h| {
        if let Some(m) = h.modules.get_mut(id) {
            m.accepts = accepts;
        }
    });
    Ok(())
}

/// A factory's `require(spec)`: a native module's namespace, or the
/// exports of the app's module `spec` names (relative to `from`).
fn require(cx: Ctx, from: &str, args: Args<'_>) -> R<V> {
    let spec = js::to_string(cx, args.get(0))?;
    if !spec.starts_with('.') {
        let natives = with(cx, |h| h.natives.clone_ref());
        let namespace = get(cx, natives.raw(), &spec)?;
        if namespace.is_undefined() {
            return Err(type_error(cx, &format!("nsh hot: no module {spec}")));
        }
        return Ok(namespace);
    }
    let id = resolve(from, &spec);
    with(cx, |h| {
        h.importers
            .entry(id.clone())
            .or_default()
            .insert(from.to_owned());
    });
    load(cx, &id)
}

/// `spec` relative to module `from` (`a/b.js` + `../c.js` -> `c.js`).
fn resolve(from: &str, spec: &str) -> String {
    let mut parts: Vec<&str> = from.split('/').collect();
    parts.pop();
    for part in spec.split('/') {
        match part {
            ".." => {
                parts.pop();
            }
            "." => {}
            part => parts.push(part),
        }
    }
    parts.join("/")
}

/// Makes `kept` (what importers hold) forward to `exports` (the run's):
/// its keys follow, read through getters.
fn forward(cx: Ctx, kept: &V, exports: &V) -> R<()> {
    let new_keys = own_keys(cx, exports.raw())?;
    for (key, _) in own_keys(cx, kept.raw())? {
        if !new_keys.iter().any(|(k, _)| *k == key) {
            let name = CString::new(key).unwrap_or_default();
            // SAFETY: a new atom, freed below.
            unsafe {
                let atom = qjs::JS_NewAtom(cx, name.as_ptr());
                qjs::JS_DeleteProperty(cx, kept.raw(), atom, 0);
                qjs::JS_FreeAtom(cx, atom);
            }
        }
    }
    for (key, enumerable) in new_keys {
        let getter = {
            let key = key.clone();
            closure(cx, vec![exports.clone_ref()], move |cx, captures, _| {
                get(cx, captures[0].raw(), &key)
            })?
        };
        let name = CString::new(key).unwrap_or_default();
        let mut flags =
            qjs::JS_PROP_CONFIGURABLE | qjs::JS_PROP_HAS_GET | qjs::JS_PROP_HAS_CONFIGURABLE;
        flags |= qjs::JS_PROP_HAS_ENUMERABLE;
        if enumerable {
            flags |= qjs::JS_PROP_ENUMERABLE;
        }
        // SAFETY: a new atom, freed below; the getter is borrowed.
        let r = unsafe {
            let atom = qjs::JS_NewAtom(cx, name.as_ptr());
            let r = qjs::JS_DefineProperty(
                cx,
                kept.raw(),
                atom,
                UNDEFINED,
                getter.raw(),
                UNDEFINED,
                flags as i32,
            );
            qjs::JS_FreeAtom(cx, atom);
            r
        };
        if r < 0 {
            return Err(js::Throw);
        }
    }
    Ok(())
}

/// The own string keys of `obj`, and whether each is enumerable.
fn own_keys(cx: Ctx, obj: Raw) -> R<Vec<(String, bool)>> {
    let mut tab: *mut qjs::JSPropertyEnum = std::ptr::null_mut();
    let mut len = 0u32;
    // SAFETY: an enumeration of a live object, freed below.
    unsafe {
        if qjs::JS_GetOwnPropertyNames(cx, &mut tab, &mut len, obj, qjs::JS_GPN_STRING_MASK as i32)
            < 0
        {
            return Err(js::Throw);
        }
        let mut out = Vec::with_capacity(len as usize);
        for i in 0..len as usize {
            let e = &*tab.add(i);
            let name = qjs::JS_AtomToCStringLen(cx, std::ptr::null_mut(), e.atom);
            if !name.is_null() {
                let key = std::ffi::CStr::from_ptr(name)
                    .to_string_lossy()
                    .into_owned();
                qjs::JS_FreeCString(cx, name);
                out.push((key, e.is_enumerable));
            }
        }
        qjs::JS_FreePropertyEnum(cx, tab, len);
        Ok(out)
    }
}

/// Whether module `id` takes its own updates: it made components and
/// everything it exports (enumerably) is one of their proxies.
fn accepts(cx: Ctx, id: &str, exports: &V) -> R<bool> {
    let made = with(cx, |h| h.modules.get(id).map_or(0, |m| m.components));
    if made == 0 {
        return Ok(false);
    }
    for (key, enumerable) in own_keys(cx, exports.raw())? {
        if !enumerable {
            continue;
        }
        let value = get(cx, exports.raw(), &key)?;
        let proxy = with(cx, |h| {
            h.components
                .values()
                .any(|c| js::same(c.proxy.raw(), value.raw()))
        });
        if !proxy {
            return Ok(false);
        }
    }
    Ok(true)
}

native! {
    /// `component(module, name, fn, signature)`: the stable proxy of a
    /// component; a new signature renders its instances again.
    fn component(cx, _this, args) {
        let key = format!(
            "{}:{}",
            js::to_string(cx, args.get(0))?,
            js::to_string(cx, args.get(1))?
        );
        let sig = js::to_string(cx, args.get(3))?;
        let fun = V::dup(cx, args.get(2));
        let existing = with(cx, |h| {
            if let Some(m) = h.current.clone().and_then(|id| h.modules.get_mut(&id)) {
                m.components += 1;
            }
            let forced = h.forced;
            let c = h.components.get_mut(&key)?;
            let stale = c.sig != sig || forced;
            c.fun = fun.clone_ref();
            c.sig = sig.clone();
            let proxy = c.proxy.clone_ref();
            if stale {
                h.stale.push(key.clone());
            }
            Some(proxy)
        });
        if let Some(proxy) = existing {
            return Ok(proxy);
        }
        let version = V::checked(cx, crate::reactive::new_signal(cx, qjs::JS_NewFloat64(0.0)))?;
        let proxy = {
            let key = key.clone();
            closure(cx, vec![version.clone_ref()], move |cx, captures, args| {
                render(cx, &key, captures[0].raw(), args.get(0))
            })?
        };
        let name = js::to_string(cx, args.get(1))?;
        js::define(cx, proxy.raw(), "name", js::string(cx, &name)?, false)?;
        with(cx, |h| {
            h.components.insert(
                key,
                Component {
                    fun,
                    sig,
                    version,
                    proxy: proxy.clone_ref(),
                },
            )
        });
        Ok(proxy)
    }
}

/// A proxy's render: a memo of the component's implementation now, run
/// again when its version changes.
fn render(cx: Ctx, key: &str, version: Raw, props: Raw) -> R<V> {
    let key = key.to_owned();
    let run = closure(
        cx,
        vec![V::dup(cx, version), V::dup(cx, props)],
        move |cx, captures, _| {
            js::call(cx, captures[0].raw(), UNDEFINED, &[])?;
            let Some(fun) = with(cx, |h| h.components.get(&key).map(|c| c.fun.clone_ref())) else {
                return Ok(V::undefined());
            };
            let out = crate::reactive::untracked_with(cx, || {
                js::call(cx, fun.raw(), UNDEFINED, &[captures[1].raw()])
            });
            // A component that throws reports the error and renders
            // nothing, ready for the fix.
            Ok(out.unwrap_or_else(|_| {
                js::report_exception(cx);
                V::undefined()
            }))
        },
    )?;
    let memo = crate::reactive::memo(cx, run.take(), false);
    V::checked(cx, crate::reactive::finish_value(cx, memo))
}

native! {
    /// `context(module, name, context)`: the first context made under that
    /// name keeps its identity (taking the new default).
    fn context(cx, _this, args) {
        let key = format!(
            "{}:{}",
            js::to_string(cx, args.get(0))?,
            js::to_string(cx, args.get(1))?
        );
        let made = args.get(2);
        let kept = with(cx, |h| h.contexts.get(&key).map(V::clone_ref));
        match kept {
            Some(kept) => {
                crate::dom::set_context_default(cx, kept.raw(), made);
                Ok(kept)
            }
            None => {
                with(cx, |h| h.contexts.insert(key, V::dup(cx, made)));
                Ok(V::dup(cx, made))
            }
        }
    }
}

native! {
    /// `keep(module, name, signature, value)`: the value first made under
    /// that name while its initializer's signature stays the same (a
    /// signal keeps its value, a navigator its routes); otherwise `value`.
    fn keep(cx, _this, args) {
        let key = format!(
            "{}:{}",
            js::to_string(cx, args.get(0))?,
            js::to_string(cx, args.get(1))?
        );
        let sig = js::to_string(cx, args.get(2))?;
        let made = args.get(3);
        Ok(with(cx, |h| match h.kept.get(&key) {
            Some((kept_sig, kept)) if *kept_sig == sig => kept.clone_ref(),
            _ => {
                h.kept.insert(key, (sig, V::dup(cx, made)));
                V::dup(cx, made)
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn relative_ids() {
        assert_eq!(super::resolve("App.js", "./Counter.js"), "Counter.js");
        assert_eq!(super::resolve("a/b.js", "../c.js"), "c.js");
        assert_eq!(super::resolve("a/b.js", "./d/e.js"), "a/d/e.js");
    }
}
