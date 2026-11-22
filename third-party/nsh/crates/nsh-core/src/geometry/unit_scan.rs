//! The scan behind the typed API checks (docs/dev/geometry.md, "Typed
//! API"): parses a crate's sources and finds every bare `f32` / `f64` in
//! a public signature (a `pub fn`'s parameters and return type, a `pub`
//! field, a public enum's fields, a `pub const` / `static`, a `pub type`).
//! A found item passes when the crate's `unitless.txt` lists it (a
//! quantity without a unit, with the reason) or its `untyped.txt` does (a
//! length, an angle or a fraction not migrated yet: that list only
//! shrinks). `pub` is public API here: the workspace's `unreachable_pub`
//! lint keeps every `pub` item reachable.
//!
//! Not scanned: test modules and items macros generate. nsh-core's test
//! is `geometry::unit_types`; nsh-js and nsh-engine include this file in
//! their own tests (`#[path]`), each with its two lists.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use syn::{Fields, FnArg, ImplItem, Item, ReturnType, TraitItem, Type, Visibility, visit::Visit};

/// Whether `ty` holds a bare `f32` / `f64` anywhere (`Option<f32>`,
/// `[f32; 4]`, `(f32, f32)`, `impl Fn(f32)`, ...).
fn has_float(ty: &Type) -> bool {
    struct Floats(bool);
    impl<'ast> Visit<'ast> for Floats {
        fn visit_path(&mut self, p: &'ast syn::Path) {
            if p.leading_colon.is_none()
                && p.segments.len() == 1
                && matches!(p.segments[0].ident.to_string().as_str(), "f32" | "f64")
            {
                self.0 = true;
            }
            syn::visit::visit_path(self, p);
        }
    }
    let mut f = Floats(false);
    f.visit_type(ty);
    f.0
}

fn is_pub(vis: &Visibility) -> bool {
    matches!(vis, Visibility::Public(_))
}

fn is_test(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|a| {
        a.path().is_ident("cfg")
            && a.parse_args::<syn::Meta>()
                .is_ok_and(|m| m.path().is_ident("test"))
    })
}

fn type_name(ty: &Type) -> String {
    match ty {
        Type::Path(p) => p
            .path
            .segments
            .last()
            .map_or_else(String::new, |s| s.ident.to_string()),
        _ => "_".into(),
    }
}

struct Scan {
    found: BTreeSet<String>,
}

impl Scan {
    fn sig(&mut self, path: &str, sig: &syn::Signature) {
        for arg in &sig.inputs {
            if let FnArg::Typed(t) = arg
                && has_float(&t.ty)
            {
                let name = match &*t.pat {
                    syn::Pat::Ident(i) => i.ident.to_string(),
                    _ => "_".into(),
                };
                self.found.insert(format!("{path}({name})"));
            }
        }
        if let ReturnType::Type(_, ty) = &sig.output
            && has_float(ty)
        {
            self.found.insert(format!("{path} ->"));
        }
    }

    fn fields(&mut self, path: &str, fields: &Fields, all: bool) {
        for (i, f) in fields.iter().enumerate() {
            if (all || is_pub(&f.vis)) && has_float(&f.ty) {
                let name = f
                    .ident
                    .as_ref()
                    .map_or_else(|| i.to_string(), |n| n.to_string());
                self.found.insert(format!("{path}.{name}"));
            }
        }
    }

    fn items(&mut self, module: &str, items: &[Item]) {
        let at = |name: &str| {
            if module.is_empty() {
                name.to_owned()
            } else {
                format!("{module}::{name}")
            }
        };
        for item in items {
            match item {
                Item::Fn(f) if is_pub(&f.vis) && !is_test(&f.attrs) => {
                    self.sig(&at(&f.sig.ident.to_string()), &f.sig)
                }
                Item::Struct(s) if is_pub(&s.vis) => {
                    self.fields(&at(&s.ident.to_string()), &s.fields, false)
                }
                Item::Enum(e) if is_pub(&e.vis) => {
                    for v in &e.variants {
                        self.fields(&at(&format!("{}::{}", e.ident, v.ident)), &v.fields, true);
                    }
                }
                Item::Const(c) if is_pub(&c.vis) && has_float(&c.ty) => {
                    self.found.insert(at(&c.ident.to_string()));
                }
                Item::Static(s) if is_pub(&s.vis) && has_float(&s.ty) => {
                    self.found.insert(at(&s.ident.to_string()));
                }
                Item::Type(t) if is_pub(&t.vis) && has_float(&t.ty) => {
                    self.found.insert(at(&t.ident.to_string()));
                }
                Item::Trait(t) if is_pub(&t.vis) => {
                    for ti in &t.items {
                        if let TraitItem::Fn(f) = ti {
                            self.sig(&at(&format!("{}::{}", t.ident, f.sig.ident)), &f.sig);
                        }
                    }
                }
                // Inherent impls only: a trait impl's signature is the trait's.
                Item::Impl(i) if i.trait_.is_none() && !is_test(&i.attrs) => {
                    let ty = type_name(&i.self_ty);
                    for ii in &i.items {
                        match ii {
                            ImplItem::Fn(f) if is_pub(&f.vis) => {
                                self.sig(&at(&format!("{ty}::{}", f.sig.ident)), &f.sig)
                            }
                            ImplItem::Const(c) if is_pub(&c.vis) && has_float(&c.ty) => {
                                self.found.insert(at(&format!("{ty}::{}", c.ident)));
                            }
                            _ => {}
                        }
                    }
                }
                Item::Mod(m) if !is_test(&m.attrs) => {
                    if let Some((_, items)) = &m.content {
                        self.items(&at(&m.ident.to_string()), items);
                    }
                }
                _ => {}
            }
        }
    }
}

/// The module path of a source file (`src/ui/style.rs` is `ui::style`).
fn module_of(src: &Path, file: &Path) -> String {
    let rel = file.strip_prefix(src).expect("under src");
    let mut parts: Vec<String> = rel
        .iter()
        .map(|p| p.to_string_lossy().trim_end_matches(".rs").to_owned())
        .collect();
    if matches!(parts.last().map(String::as_str), Some("mod" | "lib")) {
        parts.pop();
    }
    parts.join("::")
}

fn sources(src: &Path, dir: &Path, skipped: &[&str], out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).expect("read src") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
            sources(src, &path, skipped, out);
        } else if path.extension().is_some_and(|e| e == "rs")
            // Test modules (`tests.rs`, `tests/…`) are not API.
            && !path.iter().any(|p| p == "tests" || p == "tests.rs")
        {
            let module = module_of(src, &path);
            if skipped
                .iter()
                .any(|m| module == *m || module.starts_with(&format!("{m}::")))
            {
                continue;
            }
            out.push(path);
        }
    }
}

/// The bare floats in public API under `src`, leaving out the modules
/// `skipped` names (and their submodules).
pub(crate) fn scan(src: &Path, skipped: &[&str]) -> BTreeSet<String> {
    let mut files = Vec::new();
    sources(src, src, skipped, &mut files);
    let mut scan = Scan {
        found: BTreeSet::new(),
    };
    for file in files {
        let text = fs::read_to_string(&file).expect("read source");
        let ast = syn::parse_file(&text).unwrap_or_else(|e| panic!("{}: {e}", file.display()));
        scan.items(&module_of(src, &file), &ast.items);
    }
    scan.found
}

/// The entries of a list: one item path per line, `#` starts a comment
/// (a reason, a group).
fn list(path: &Path) -> BTreeMap<String, usize> {
    fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("{}: {e}", path.display()))
        .lines()
        .enumerate()
        .filter_map(|(i, l)| {
            let entry = l.split('#').next().unwrap_or("").trim();
            (!entry.is_empty()).then(|| (entry.to_owned(), i + 1))
        })
        .collect()
}

/// Fails unless every bare float in the public API of the crate at `root`
/// (its `src`, the modules `skipped` names left out) is listed in its
/// `unitless.txt` or `untyped.txt`, and every entry of those lists is
/// still found.
pub(crate) fn check(root: &Path, skipped: &[&str]) {
    let found = scan(&root.join("src"), skipped);
    let unitless = list(&root.join("unitless.txt"));
    let untyped = list(&root.join("untyped.txt"));
    let mut errors = Vec::new();
    for item in &found {
        if !unitless.contains_key(item) && !untyped.contains_key(item) {
            errors.push(format!(
                "  {item}: a bare float in public API; use nsh_core::geometry's types (Points, \
                 Percentage, Radians, Length, Size, …), or list it in unitless.txt with the reason \
                 it has no unit"
            ));
        }
    }
    for (name, entries) in [("untyped.txt", &untyped), ("unitless.txt", &unitless)] {
        for (item, line) in entries {
            if !found.contains(item) {
                errors.push(format!(
                    "  {name}:{line}: {item} is typed now (or gone): remove the entry"
                ));
            }
        }
    }
    for item in unitless.keys() {
        if untyped.contains_key(item) {
            errors.push(format!("  {item} is in both lists"));
        }
    }
    assert!(
        errors.is_empty(),
        "public API of {} with bare floats (docs/dev/geometry.md, \"Typed API\"):\n{}",
        root.display(),
        errors.join("\n")
    );
}
