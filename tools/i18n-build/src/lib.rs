/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Compile-time ICU catalog and localized Markdown document codegen for Maka Rust crates.

mod icu;

use icu::{Node, ParamType, PluralSelector, collect_params, parse_message};
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    default_locale: String,
    locales: Vec<LocaleEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleEntry {
    tag: String,
    #[serde(default)]
    overlay: Option<String>,
}

fn find_repo_manifest(start: &Path) -> PathBuf {
    for ancestor in start.ancestors() {
        let candidate = ancestor.join("locales.manifest.json");
        if candidate.is_file() {
            return candidate;
        }
    }
    panic!(
        "could not locate locales.manifest.json from {}",
        start.display()
    );
}

fn read_manifest(crate_dir: &Path) -> Manifest {
    let path = find_repo_manifest(crate_dir);
    println!("cargo:rerun-if-changed={}", path.display());
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("invalid {}: {e}", path.display()))
}

fn flatten_json(prefix: &str, value: &Value, out: &mut BTreeMap<String, String>) {
    match value {
        Value::String(text) => {
            assert!(!prefix.is_empty(), "root locale JSON must be an object");
            assert!(
                out.insert(prefix.to_owned(), text.clone()).is_none(),
                "duplicate i18n key {prefix}"
            );
        }
        Value::Object(map) => {
            for (k, v) in map {
                let next = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten_json(&next, v, out);
            }
        }
        other => panic!("unsupported JSON value at key {prefix}: {other}"),
    }
}

fn read_locale_map(path: &Path) -> BTreeMap<String, String> {
    println!("cargo:rerun-if-changed={}", path.display());
    let raw = fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("failed to read locale file {}: {e}", path.display()));
    let value: Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("invalid JSON in {}: {e}", path.display()));
    let mut map = BTreeMap::new();
    flatten_json("", &value, &mut map);
    map
}

fn rust_ident(segment: &str) -> String {
    let mut out = String::new();
    for ch in segment.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push('_');
        }
    }
    if matches!(
        out.as_str(),
        "type"
            | "match"
            | "in"
            | "ref"
            | "mod"
            | "fn"
            | "use"
            | "loop"
            | "move"
            | "self"
            | "super"
            | "crate"
            | "as"
            | "break"
            | "const"
            | "continue"
            | "else"
            | "enum"
            | "extern"
            | "false"
            | "for"
            | "if"
            | "impl"
            | "let"
            | "mut"
            | "pub"
            | "return"
            | "static"
            | "struct"
            | "trait"
            | "true"
            | "unsafe"
            | "where"
            | "while"
            | "async"
            | "await"
            | "dyn"
    ) {
        out.insert_str(0, "r#");
    }
    out
}

/// Compile <locales_dir>/<tag>.json for every locale in locales.manifest.json
/// into strongly typed Rust functions written to OUT_DIR/<out_file>.
pub fn compile_catalog(locales_dir: impl AsRef<Path>, out_file: &str) {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dir = crate_dir.join(locales_dir);
    println!("cargo:rerun-if-changed={}", dir.display());
    let manifest = read_manifest(&crate_dir);
    let code = generate_catalog_code(&dir, &manifest);
    let out = PathBuf::from(env::var("OUT_DIR").unwrap()).join(out_file);
    fs::write(out, code).unwrap();
}

fn generate_catalog_code(dir: &Path, manifest: &Manifest) -> String {
    let mut raw_maps: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for entry in &manifest.locales {
        let path = dir.join(format!("{}.json", entry.tag));
        if entry.overlay.is_some() && !path.exists() {
            raw_maps.insert(entry.tag.clone(), BTreeMap::new());
        } else {
            raw_maps.insert(entry.tag.clone(), read_locale_map(&path));
        }
    }

    let base_map = raw_maps
        .get(&manifest.default_locale)
        .unwrap_or_else(|| panic!("missing default locale {}", manifest.default_locale))
        .clone();

    let mut resolved: Vec<BTreeMap<String, String>> = Vec::with_capacity(manifest.locales.len());
    for entry in &manifest.locales {
        let mut map = if let Some(parent) = &entry.overlay {
            let mut merged = raw_maps
                .get(parent)
                .unwrap_or_else(|| panic!("missing overlay parent {parent}"))
                .clone();
            for (k, v) in raw_maps.get(&entry.tag).unwrap() {
                assert!(
                    base_map.contains_key(k),
                    "overlay locale {} defines unknown key {k}",
                    entry.tag
                );
                merged.insert(k.clone(), v.clone());
            }
            merged
        } else {
            raw_maps.get(&entry.tag).unwrap().clone()
        };
        for key in base_map.keys() {
            assert!(
                map.contains_key(key),
                "locale {} is missing key {key}",
                entry.tag
            );
        }
        for key in map.keys() {
            assert!(
                base_map.contains_key(key),
                "locale {} defines unknown key {key}",
                entry.tag
            );
        }
        let ordered: BTreeMap<String, String> = base_map
            .keys()
            .map(|k| (k.clone(), map.remove(k).unwrap()))
            .collect();
        resolved.push(ordered);
    }

    let mut schema: BTreeMap<String, BTreeMap<String, ParamType>> = BTreeMap::new();
    let mut parsed: Vec<BTreeMap<String, Vec<Node>>> =
        vec![BTreeMap::new(); manifest.locales.len()];

    for (key, en_text) in &base_map {
        let nodes = parse_message(en_text).unwrap_or_else(|e| {
            panic!("invalid ICU in {} key {key}: {e}", manifest.default_locale)
        });
        let mut params = BTreeMap::new();
        collect_params(&nodes, &mut params).unwrap_or_else(|e| {
            panic!(
                "invalid ICU params in {} key {key}: {e}",
                manifest.default_locale
            )
        });
        schema.insert(key.clone(), params);
    }

    for (idx, entry) in manifest.locales.iter().enumerate() {
        for (key, text) in &resolved[idx] {
            let nodes = parse_message(text)
                .unwrap_or_else(|e| panic!("invalid ICU in {} key {key}: {e}", entry.tag));
            let mut params = BTreeMap::new();
            collect_params(&nodes, &mut params)
                .unwrap_or_else(|e| panic!("invalid ICU params in {} key {key}: {e}", entry.tag));
            let expected = &schema[key];
            for (name, ty) in &params {
                match expected.get(name) {
                    Some(exp_ty)
                        if exp_ty == ty
                            || (*exp_ty == ParamType::Count && *ty == ParamType::Text) => {}
                    Some(exp_ty) => panic!(
                        "placeholder type mismatch in locale {} for key {key}: {name} expected {exp_ty:?}, got {ty:?}",
                        entry.tag
                    ),
                    None => panic!(
                        "unknown placeholder {name} in locale {} for key {key}",
                        entry.tag
                    ),
                }
            }
            for (name, exp_ty) in expected {
                if !params.contains_key(name) && *exp_ty != ParamType::Count {
                    panic!(
                        "missing placeholder {name} in locale {} for key {key}",
                        entry.tag
                    );
                }
            }
            parsed[idx].insert(key.clone(), nodes);
        }
    }

    let mut root_keys: Vec<(String, String)> = Vec::new();
    let mut modules: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for key in base_map.keys() {
        if let Some((ns, rest)) = key.split_once('.') {
            modules
                .entry(rust_ident(ns))
                .or_default()
                .push((rust_ident(rest), key.clone()));
        } else {
            root_keys.push((rust_ident(key), key.clone()));
        }
    }

    let mut code = String::new();
    code.push_str("#[allow(dead_code, clippy::all)]\n");
    code.push_str("pub mod i18n_catalog {\n");
    code.push_str("    use maka_i18n::{BuiltinLocale, PluralCategory, plural_category};\n\n");

    for (fn_name, full_key) in &root_keys {
        emit_function(
            &mut code,
            "    ",
            fn_name,
            full_key,
            &schema[full_key],
            &parsed,
            manifest.locales.len(),
        );
    }

    for (mod_name, entries) in &modules {
        code.push_str(&format!("    pub mod {mod_name} {{\n"));
        code.push_str("        use super::{BuiltinLocale, PluralCategory, plural_category};\n");
        for (fn_name, full_key) in entries {
            emit_function(
                &mut code,
                "        ",
                fn_name,
                full_key,
                &schema[full_key],
                &parsed,
                manifest.locales.len(),
            );
        }
        code.push_str("    }\n");
    }

    code.push_str("}\n");
    code
}

fn emit_function(
    code: &mut String,
    indent: &str,
    fn_name: &str,
    full_key: &str,
    params: &BTreeMap<String, ParamType>,
    parsed: &[BTreeMap<String, Vec<Node>>],
    locale_count: usize,
) {
    if params.is_empty() {
        code.push_str(&format!(
            "{indent}pub fn {fn_name}(locale: impl Into<BuiltinLocale>) -> &'static str {{\n"
        ));
        code.push_str(&format!(
            "{indent}    const TABLE: [&'static str; {locale_count}] = [\n"
        ));
        for locale_nodes in parsed {
            let mut literal = String::new();
            for n in &locale_nodes[full_key] {
                if let Node::Literal(part) = n {
                    literal.push_str(part);
                }
            }
            code.push_str(&format!("{indent}        {literal:?},\n"));
        }
        code.push_str(&format!("{indent}    ];\n"));
        code.push_str(&format!("{indent}    TABLE[locale.into().index()]\n"));
        code.push_str(&format!("{indent}}}\n"));
        return;
    }

    let mut sig = vec!["locale: impl Into<BuiltinLocale>".to_owned()];
    for (name, ty) in params {
        let ident = rust_ident(name);
        let rust_ty = match ty {
            ParamType::Text => "&str",
            ParamType::Count => "i64",
        };
        sig.push(format!("{ident}: {rust_ty}"));
    }
    code.push_str(&format!(
        "{indent}pub fn {fn_name}({}) -> String {{\n",
        sig.join(", ")
    ));
    code.push_str(&format!("{indent}    let locale = locale.into();\n"));
    code.push_str(&format!("{indent}    let mut out = String::new();\n"));
    code.push_str(&format!("{indent}    match locale.index() {{\n"));
    for (idx, locale_nodes) in parsed.iter().enumerate() {
        let arm = if idx + 1 == locale_count {
            "_".to_owned()
        } else {
            idx.to_string()
        };
        code.push_str(&format!("{indent}        {arm} => {{\n"));
        emit_nodes(
            code,
            &format!("{indent}            "),
            &locale_nodes[full_key],
            params,
            None,
        );
        code.push_str(&format!("{indent}        }}\n"));
    }
    code.push_str(&format!("{indent}    }}\n"));
    code.push_str(&format!("{indent}    out\n"));
    code.push_str(&format!("{indent}}}\n"));
}

fn emit_nodes(
    code: &mut String,
    indent: &str,
    nodes: &[Node],
    params: &BTreeMap<String, ParamType>,
    active_plural: Option<&str>,
) {
    for node in nodes {
        match node {
            Node::Literal(s) => {
                code.push_str(&format!("{indent}out.push_str({s:?});\n"));
            }
            Node::Var(name) => {
                let ident = rust_ident(name);
                match params[name] {
                    ParamType::Text => {
                        code.push_str(&format!("{indent}out.push_str({ident});\n"));
                    }
                    ParamType::Count => {
                        code.push_str(&format!("{indent}out.push_str(&{ident}.to_string());\n"));
                    }
                }
            }
            Node::Hash => {
                let var = active_plural.expect("# outside plural");
                let ident = rust_ident(var);
                code.push_str(&format!("{indent}out.push_str(&{ident}.to_string());\n"));
            }
            Node::Plural { var, cases } => {
                let ident = rust_ident(var);
                let mut exacts = Vec::new();
                let mut cats = Vec::new();
                let mut other_body: Option<&[Node]> = None;
                for (sel, body) in cases {
                    match sel {
                        PluralSelector::Exact(n) => exacts.push((*n, body.as_slice())),
                        PluralSelector::Other => other_body = Some(body.as_slice()),
                        cat => cats.push((cat, body.as_slice())),
                    }
                }
                let mut opened = false;
                for (exact_n, body) in exacts {
                    let kw = if opened { "} else if" } else { "if" };
                    opened = true;
                    code.push_str(&format!("{indent}{kw} {ident} == {exact_n} {{\n"));
                    emit_nodes(code, &format!("{indent}    "), body, params, Some(var));
                }
                if opened {
                    code.push_str(&format!("{indent}}} else {{\n"));
                }
                let inner_indent = if opened {
                    format!("{indent}    ")
                } else {
                    indent.to_owned()
                };
                if cats.is_empty() {
                    emit_nodes(code, &inner_indent, other_body.unwrap(), params, Some(var));
                } else {
                    code.push_str(&format!(
                        "{inner_indent}match plural_category(locale, {ident}) {{\n"
                    ));
                    for (cat, body) in cats {
                        let variant = match cat {
                            PluralSelector::Zero => "PluralCategory::Zero",
                            PluralSelector::One => "PluralCategory::One",
                            PluralSelector::Two => "PluralCategory::Two",
                            PluralSelector::Few => "PluralCategory::Few",
                            PluralSelector::Many => "PluralCategory::Many",
                            _ => unreachable!(),
                        };
                        code.push_str(&format!("{inner_indent}    {variant} => {{\n"));
                        emit_nodes(
                            code,
                            &format!("{inner_indent}        "),
                            body,
                            params,
                            Some(var),
                        );
                        code.push_str(&format!("{inner_indent}    }}\n"));
                    }
                    code.push_str(&format!("{inner_indent}    _ => {{\n"));
                    emit_nodes(
                        code,
                        &format!("{inner_indent}        "),
                        other_body.unwrap(),
                        params,
                        Some(var),
                    );
                    code.push_str(&format!("{inner_indent}    }}\n"));
                    code.push_str(&format!("{inner_indent}}}\n"));
                }
                if opened {
                    code.push_str(&format!("{indent}}}\n"));
                }
            }
            Node::Select { var, cases } => {
                let ident = rust_ident(var);
                code.push_str(&format!("{indent}match {ident} {{\n"));
                let mut other_body: Option<&[Node]> = None;
                for (key, body) in cases {
                    if key == "other" {
                        other_body = Some(body.as_slice());
                    } else {
                        code.push_str(&format!("{indent}    {key:?} => {{\n"));
                        emit_nodes(
                            code,
                            &format!("{indent}        "),
                            body,
                            params,
                            active_plural,
                        );
                        code.push_str(&format!("{indent}    }}\n"));
                    }
                }
                code.push_str(&format!("{indent}    _ => {{\n"));
                emit_nodes(
                    code,
                    &format!("{indent}        "),
                    other_body.unwrap(),
                    params,
                    active_plural,
                );
                code.push_str(&format!("{indent}    }}\n"));
                code.push_str(&format!("{indent}}}\n"));
            }
        }
    }
}

/// Compile zstd-compressed localized Markdown documents (one per manifest locale,
/// with overlay fallback and exact protocol marker validation) into OUT_DIR/<out_file>.
pub fn compile_docs(
    docs_dir: impl AsRef<Path>,
    prefix: &str,
    out_file: &str,
    required_markers: &[&str],
) {
    let crate_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let dir = crate_dir.join(docs_dir);
    println!("cargo:rerun-if-changed={}", dir.display());
    let manifest = read_manifest(&crate_dir);
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let mut contents: BTreeMap<String, String> = BTreeMap::new();
    for entry in &manifest.locales {
        let tagged = dir.join(format!("{prefix}.{}.md", entry.tag));
        let fallback_en = dir.join(format!("{prefix}.md"));
        let path = if tagged.is_file() {
            Some(tagged)
        } else if entry.tag == manifest.default_locale && fallback_en.is_file() {
            Some(fallback_en)
        } else {
            None
        };
        if let Some(p) = path {
            println!("cargo:rerun-if-changed={}", p.display());
            let text = fs::read_to_string(&p)
                .unwrap_or_else(|e| panic!("failed to read {}: {e}", p.display()));
            contents.insert(entry.tag.clone(), text);
        } else if entry.overlay.is_none() {
            panic!(
                "missing localized document {prefix}.{}.md in {}",
                entry.tag,
                dir.display()
            );
        }
    }

    let base_doc = &contents[&manifest.default_locale];
    let base_anchors = extract_html_markers(base_doc);

    let count = manifest.locales.len();
    let mut code = String::new();
    code.push_str("#[allow(dead_code)]\n");
    code.push_str("pub mod i18n_docs {\n");
    code.push_str("    use maka_i18n::BuiltinLocale;\n");
    code.push_str("    use std::sync::OnceLock;\n\n");
    code.push_str(&format!("    const FRAMES: [&'static [u8]; {count}] = [\n"));

    for entry in &manifest.locales {
        let text = contents.get(&entry.tag).unwrap_or_else(|| {
            let parent = entry.overlay.as_deref().unwrap();
            &contents[parent]
        });
        for marker in required_markers {
            assert!(
                text.contains(marker),
                "localized doc {prefix}.{}.md is missing required marker {marker:?}",
                entry.tag
            );
        }
        let anchors = extract_html_markers(text);
        assert_eq!(
            anchors, base_anchors,
            "HTML comment protocol markers mismatch in {prefix}.{}.md",
            entry.tag
        );
        let frame_name = format!("{prefix}.{}.md.zst", entry.tag);
        let compressed = zstd::bulk::compress(text.as_bytes(), 9)
            .unwrap_or_else(|e| panic!("zstd compress failed for {frame_name}: {e}"));
        fs::write(out_dir.join(&frame_name), compressed).unwrap();
        code.push_str(&format!(
            "        include_bytes!(concat!(env!(\"OUT_DIR\"), \"/{frame_name}\")),\n"
        ));
    }
    code.push_str("    ];\n\n");
    code.push_str(&format!(
        "    static CACHE: [OnceLock<String>; {count}] = [const {{ OnceLock::new() }}; {count}];\n\n"
    ));
    code.push_str("    pub fn get(locale: impl Into<BuiltinLocale>) -> &'static str {\n");
    code.push_str("        let idx = locale.into().index();\n");
    code.push_str("        CACHE[idx].get_or_init(|| {\n");
    code.push_str("            let bytes = zstd::decode_all(FRAMES[idx]).expect(\"valid zstd localized doc\");\n");
    code.push_str("            String::from_utf8(bytes).expect(\"utf-8 localized doc\")\n");
    code.push_str("        }).as_str()\n");
    code.push_str("    }\n");
    code.push_str("}\n");
    fs::write(out_dir.join(out_file), code).unwrap();
}

fn extract_html_markers(doc: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut rest = doc;
    while let Some(start) = rest.find("<!--") {
        rest = &rest[start..];
        let Some(end) = rest.find("-->") else {
            break;
        };
        let marker = rest[..end + 3].trim();
        if marker.starts_with("<!-- browser-document:")
            || marker == "<!-- /browser-document -->"
            || marker == "<!-- named-browser-documents -->"
        {
            out.insert(marker.to_owned());
        }
        rest = &rest[end + 3..];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plural_select_and_escaped_braces() {
        let ast = parse_message(
            "{count, plural, =0 {none} one {# tool for {user}} other {# tools '{raw}' it''s ok}}",
        )
        .unwrap();
        let mut params = BTreeMap::new();
        collect_params(&ast, &mut params).unwrap();
        assert_eq!(params.get("count"), Some(&ParamType::Count));
        assert_eq!(params.get("user"), Some(&ParamType::Text));
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn rejects_plural_without_other_branch() {
        assert!(parse_message("{count, plural, one {# item}}").is_err());
    }
}
