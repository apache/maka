//! UI sets as data: what the toolchain needs to know of a set without
//! linking it. The bundler, the bytecode compiler and `.nsh/types` see a
//! set through its [`SetDescription`]: its specifier, its exports and their
//! kinds, its TypeScript declarations, the runtime values it re-exports
//! and the files it ships. Nothing in it runs a component.
//!
//! The prebuilt `nsh` describes the sets it links itself (the mobile UI).
//! An app's own crates (`nsh.json` `"rust"`) are described by a small
//! program `nsh` generates for the app (`nsh-cli` `rust_app.rs`): it links
//! only the app's crates and nsh-core, calls each crate's
//! `#[native_module]` entry and prints a [`Description`] as JSON
//! ([`Description::to_json`]), which `nsh` reads back
//! ([`Description::from_json`]). The document carries its format
//! ([`FORMAT`]) and the version of nsh-core that wrote it ([`VERSION`]):
//! `nsh` takes only its own.

use serde_json::{Map, Value, json};

use super::Registry;

/// The version of the JSON format of a [`Description`]: bumped whenever
/// what it holds or means changes.
pub const FORMAT: u32 = 2;

/// The version of nsh-core that writes descriptions: the version of nsh
/// the app's crates were built with.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What kind of value an export of a set is: how JS reaches it, as the
/// bundler (hints about JSX tags) and the bytecode compiler (the names a
/// module exports) see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportKind {
    /// A Rust component (`registry.register::<C>()`), with the functions of
    /// a module of the same name if the set has one.
    Component,
    /// A module object (`registry.module::<M>()`).
    Module,
    /// One function of a flat module.
    Function,
    /// A Rust class (`#[class]`).
    Class,
    /// A runtime value the set exports as it is
    /// ([`Registry::reexport`], [`Registry::native_values`]).
    Value,
}

impl ExportKind {
    /// Its name in the JSON format.
    pub fn as_str(self) -> &'static str {
        match self {
            ExportKind::Component => "component",
            ExportKind::Module => "module",
            ExportKind::Function => "function",
            ExportKind::Class => "class",
            ExportKind::Value => "value",
        }
    }

    /// The kind named `name` in the JSON format.
    pub fn parse(name: &str) -> Option<ExportKind> {
        Some(match name {
            "component" => ExportKind::Component,
            "module" => ExportKind::Module,
            "function" => ExportKind::Function,
            "class" => ExportKind::Class,
            "value" => ExportKind::Value,
            _ => return None,
        })
    }
}

/// One export of a set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportDescription {
    /// The name JS imports it by.
    pub name: String,
    /// What it is.
    pub kind: ExportKind,
}

/// A file a set ships ([`Registry::assets`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetDescription {
    /// Its path among the app's assets (`@gallery-native/logo@2x.png`).
    pub path: String,
    /// The file, where the set's crate was built.
    pub source: String,
}

/// A UI set as data: everything the toolchain reads from a [`Registry`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetDescription {
    /// The specifier apps import it by (`nsh/base`, `gallery/native`).
    pub specifier: String,
    /// Its exports, each name once, in the order a module declares them.
    pub exports: Vec<ExportDescription>,
    /// The TypeScript declarations of its components, modules and classes
    /// ([`super::declarations`]); the values it re-exports are declared by
    /// the runtime that makes them.
    pub declarations: String,
    /// The runtime values it exports as they are ([`Registry::reexport`]).
    pub reexported_values: Vec<String>,
    /// The runtime types it exports as they are ([`Registry::reexport`]).
    pub reexported_types: Vec<String>,
    /// The values the runtime makes for it ([`Registry::native_values`]).
    pub native_values: Vec<String>,
    /// The files it ships.
    pub assets: Vec<AssetDescription>,
    /// The exports TS sees without a doc comment ([`Registry::undocumented`]),
    /// which the toolchain warns of.
    pub undocumented: Vec<String>,
}

impl SetDescription {
    /// The description of `registry`, if it is a set apps import (it has a
    /// specifier).
    pub fn of(registry: &Registry) -> Option<SetDescription> {
        let specifier = registry.specifier()?;
        let specs = registry.specs();
        let modules = registry.module_specs();
        let mut exports: Vec<ExportDescription> = Vec::new();
        let mut add = |name: &str, kind: ExportKind| {
            if !exports.iter().any(|e| e.name == name) {
                exports.push(ExportDescription {
                    name: name.to_owned(),
                    kind,
                });
            }
        };
        for spec in &specs {
            add(&spec.export, ExportKind::Component);
        }
        for m in &modules {
            if specs.iter().any(|s| s.export == m.name)
                || (!m.flat && registry.function_members(m.name).is_some())
            {
                continue;
            }
            if m.flat {
                for f in &m.functions {
                    add(f.name, ExportKind::Function);
                }
            } else {
                add(m.name, ExportKind::Module);
            }
        }
        for class in registry
            .class_specs()
            .into_iter()
            .filter(|c| !c.def.interface)
        {
            add(class.name, ExportKind::Class);
        }
        for value in registry.value_specs() {
            add(value.name, ExportKind::Value);
        }
        let (values, types) = registry.reexports();
        for value in values.iter().chain(registry.native_value_names()) {
            add(value, ExportKind::Value);
        }
        let strings = |names: &[&str]| names.iter().map(|n| (*n).to_owned()).collect();
        Some(SetDescription {
            specifier: specifier.to_owned(),
            exports,
            declarations: super::declarations(registry, &[]),
            reexported_values: strings(values),
            reexported_types: strings(types),
            native_values: strings(registry.native_value_names()),
            assets: registry
                .asset_files()
                .map(|file| AssetDescription {
                    path: file.path().to_owned(),
                    source: file.source.to_owned(),
                })
                .collect(),
            undocumented: registry.undocumented(),
        })
    }

    /// The names of the exports of `kind`.
    pub fn exports_of(&self, kind: ExportKind) -> impl Iterator<Item = &str> {
        self.exports
            .iter()
            .filter(move |e| e.kind == kind)
            .map(|e| e.name.as_str())
    }

    fn to_value(&self) -> Value {
        json!({
            "specifier": self.specifier,
            "exports": self.exports.iter().map(|e| json!({
                "name": e.name,
                "kind": e.kind.as_str(),
            })).collect::<Vec<_>>(),
            "declarations": self.declarations,
            "reexports": {
                "values": self.reexported_values,
                "types": self.reexported_types,
            },
            "native_values": self.native_values,
            "assets": self.assets.iter().map(|a| json!({
                "path": a.path,
                "source": a.source,
            })).collect::<Vec<_>>(),
            "undocumented": self.undocumented,
        })
    }

    fn from_value(value: &Value, at: &str) -> Result<SetDescription, String> {
        let set = object(value, at)?;
        let specifier = string(set, "specifier", at)?;
        if specifier.is_empty() {
            return Err(format!("{at}.specifier is empty"));
        }
        let at = format!("{at} ({specifier})");
        let exports = array(set, "exports", &at)?
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let at = format!("{at}.exports[{i}]");
                let e = object(e, &at)?;
                let kind = string(e, "kind", &at)?;
                Ok(ExportDescription {
                    name: string(e, "name", &at)?,
                    kind: ExportKind::parse(&kind)
                        .ok_or_else(|| format!("{at}.kind: unknown kind {kind:?}"))?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        let reexports = object(
            set.get("reexports")
                .ok_or_else(|| format!("{at}: no reexports"))?,
            &format!("{at}.reexports"),
        )?;
        let assets = array(set, "assets", &at)?
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let at = format!("{at}.assets[{i}]");
                let a = object(a, &at)?;
                Ok(AssetDescription {
                    path: string(a, "path", &at)?,
                    source: string(a, "source", &at)?,
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(SetDescription {
            specifier,
            exports,
            declarations: string(set, "declarations", &at)?,
            reexported_values: strings(reexports, "values", &format!("{at}.reexports"))?,
            reexported_types: strings(reexports, "types", &format!("{at}.reexports"))?,
            native_values: strings(set, "native_values", &at)?,
            assets,
            undocumented: strings(set, "undocumented", &at)?,
        })
    }
}

impl From<&Registry> for SetDescription {
    /// [`SetDescription::of`] a UI set.
    ///
    /// # Panics
    ///
    /// When `registry` has no specifier: it is no set apps import.
    #[track_caller]
    fn from(registry: &Registry) -> Self {
        SetDescription::of(registry).expect("a UI set: a registry with a specifier")
    }
}

impl From<Registry> for SetDescription {
    /// [`SetDescription::of`] a UI set, as [`From<&Registry>`].
    #[track_caller]
    fn from(registry: Registry) -> Self {
        SetDescription::from(&registry)
    }
}

/// The document an app's describe program prints: its crates' sets, in the
/// order `nsh.json` `"rust"` lists the crates.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Description {
    /// The version of nsh-core that wrote it ([`VERSION`]).
    pub nsh: String,
    /// The sets.
    pub sets: Vec<SetDescription>,
}

impl Description {
    /// The description of `sets`, written by this nsh-core.
    ///
    /// # Panics
    ///
    /// When one of `sets` has no specifier (it is no UI set).
    #[track_caller]
    pub fn of(sets: &[Registry]) -> Description {
        Description {
            nsh: VERSION.to_owned(),
            sets: sets
                .iter()
                .flat_map(Registry::sets)
                .map(SetDescription::from)
                .collect(),
        }
    }

    /// The document as JSON.
    pub fn to_json(&self) -> String {
        json!({
            "format": FORMAT,
            "nsh": self.nsh,
            "sets": self.sets.iter().map(SetDescription::to_value).collect::<Vec<_>>(),
        })
        .to_string()
    }

    /// Reads a document [`Description::to_json`] wrote. A document of
    /// another [`FORMAT`] is refused, saying which; whether its
    /// [`Description::nsh`] is the reader's own is the reader's call.
    pub fn from_json(text: &str) -> Result<Description, String> {
        let value: Value = serde_json::from_str(text).map_err(|e| format!("not JSON: {e}"))?;
        let doc = object(&value, "the description")?;
        let format = doc
            .get("format")
            .and_then(Value::as_u64)
            .ok_or("the description has no format")?;
        if format != u64::from(FORMAT) {
            return Err(format!(
                "the description is in format {format}, and this nsh reads format {FORMAT}"
            ));
        }
        let sets = array(doc, "sets", "the description")?
            .iter()
            .enumerate()
            .map(|(i, set)| SetDescription::from_value(set, &format!("sets[{i}]")))
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Description {
            nsh: string(doc, "nsh", "the description")?,
            sets,
        })
    }
}

fn object<'v>(value: &'v Value, at: &str) -> Result<&'v Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{at} is not an object"))
}

fn string(object: &Map<String, Value>, key: &str, at: &str) -> Result<String, String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("{at}: no string {key}"))
}

fn array<'v>(object: &'v Map<String, Value>, key: &str, at: &str) -> Result<&'v [Value], String> {
    object
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .ok_or_else(|| format!("{at}: no list {key}"))
}

fn strings(object: &Map<String, Value>, key: &str, at: &str) -> Result<Vec<String>, String> {
    array(object, key, at)?
        .iter()
        .map(|v| {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("{at}.{key}: not a list of strings"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::prelude::*;

    #[class(interface)]
    struct Capability;

    #[class]
    impl Capability {
        pub(crate) fn is_live(&self) -> bool {
            true
        }
    }

    #[class]
    struct ClassValue;

    #[class]
    impl ClassValue {
        pub(crate) fn value(&self) -> u32 {
            1
        }
    }

    #[test]
    fn interface_classes_keep_their_types_without_a_runtime_value_export() {
        let mut registry = Registry::ui_set("test/class-description");
        registry.class::<Capability>().class::<ClassValue>();
        let described = SetDescription::of(&registry).unwrap();
        assert_eq!(
            described.exports_of(ExportKind::Class).collect::<Vec<_>>(),
            ["ClassValue"]
        );
        assert!(
            described
                .declarations
                .contains("export interface Capability")
        );
        assert!(described.declarations.contains("isLive(): boolean;"));
        assert!(
            described
                .declarations
                .contains("export declare class ClassValue")
        );
        assert!(described.declarations.contains("value(): number;"));
        let round_trip = Description::from_json(&Description::of(&[registry]).to_json()).unwrap();
        assert_eq!(round_trip.sets[0], described);
    }

    /// A component of the test set.
    #[component]
    fn Badge() -> impl IntoElement {
        view()
    }

    #[component]
    fn Plain() -> impl IntoElement {
        view()
    }

    fn set() -> Registry {
        let mut r = Registry::ui_set("test/description");
        r.register::<Badge>();
        r.reexport(&["safeArea"], &["Insets"]);
        r.native_values(&["Stack"]);
        r
    }

    #[test]
    fn a_set_is_described_by_its_exports_and_declarations() {
        let set = SetDescription::of(&set()).unwrap();
        assert_eq!(set.specifier, "test/description");
        let exports: Vec<(&str, ExportKind)> = set
            .exports
            .iter()
            .map(|e| (e.name.as_str(), e.kind))
            .collect();
        assert_eq!(
            exports,
            [
                ("Badge", ExportKind::Component),
                ("safeArea", ExportKind::Value),
                ("Stack", ExportKind::Value),
            ]
        );
        assert_eq!(
            set.exports_of(ExportKind::Component).collect::<Vec<_>>(),
            ["Badge"]
        );
        assert_eq!(set.declarations, crate::ui::declarations(&self::set(), &[]));
        assert_eq!(set.reexported_values, ["safeArea"]);
        assert_eq!(set.reexported_types, ["Insets"]);
        assert_eq!(set.native_values, ["Stack"]);
        assert!(set.undocumented.is_empty());
        // What TS sees without a doc comment, which `nsh` warns of.
        let mut plain = Registry::ui_set("test/plain");
        plain.register::<Plain>();
        assert_eq!(SetDescription::of(&plain).unwrap().undocumented, ["Plain"]);
        // A registry of no set has no description.
        assert!(SetDescription::of(&Registry::new()).is_none());
    }

    #[test]
    fn a_description_survives_json() {
        let mut description = Description::of(&[set()]);
        description.sets[0].assets.push(AssetDescription {
            path: "@app/logo@2x.png".into(),
            source: "C:\\app\\assets\\logo@2x.png".into(),
        });
        let json = description.to_json();
        assert_eq!(Description::from_json(&json).unwrap(), description);
        assert_eq!(description.nsh, VERSION);
    }

    #[test]
    fn another_format_or_a_broken_document_is_refused() {
        let json = Description::of(&[set()]).to_json();
        let mut value: Value = serde_json::from_str(&json).unwrap();
        value["format"] = (FORMAT + 1).into();
        let error = Description::from_json(&value.to_string()).unwrap_err();
        assert!(error.contains(&format!("format {}", FORMAT + 1)), "{error}");
        value["format"] = FORMAT.into();
        value["sets"][0]["exports"][0]["kind"] = "widget".into();
        let error = Description::from_json(&value.to_string()).unwrap_err();
        assert!(
            error.contains("sets[0] (test/description).exports[0].kind: unknown kind \"widget\""),
            "{error}"
        );
        assert!(
            Description::from_json("{")
                .unwrap_err()
                .starts_with("not JSON")
        );
        assert!(
            Description::from_json("{}")
                .unwrap_err()
                .contains("no format")
        );
    }
}
