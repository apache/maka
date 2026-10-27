//! What an app's code uses of the native modules, by name: the exports of
//! each native module it imports, and whether it may use the globals of the
//! standard module `crypto` ([`nsh_core::js::CRYPTO_GLOBALS`]). A runtime
//! that serves only those can leave the rest out of its binary (`nsh package
//! --target web`, `docs/dev/web.md`).
//!
//! It reads the bundle's output: native modules stay imports there
//! (`plugin.rs`), so every use is an import declaration, a re-export or an
//! `import()` of one. What it cannot tell apart counts as everything: a
//! namespace import uses every export; a global of `crypto` is used wherever
//! its name is spelled (a variable, a member, a key being destructured, a
//! string), and wherever the global object is read by a name it cannot see
//! (a computed member, or a destructuring with a computed key or a rest
//! element). The global object under another name, read by a name made at
//! run time (`const g = globalThis; g[name]`), is beyond it.

use std::collections::{BTreeMap, BTreeSet};

use oxc::{
    allocator::Allocator,
    ast::ast::{
        AssignmentExpression, AssignmentTarget, AssignmentTargetProperty, BindingPattern,
        ComputedMemberExpression, ExportAllDeclaration, ExportFromDeclaration, Expression,
        IdentifierName, IdentifierReference, ImportDeclaration, ImportDeclarationSpecifier,
        ImportExpression, PropertyKey, StringLiteral, TemplateElement, VariableDeclarator,
    },
    ast_visit::{Visit, walk},
    parser::Parser,
    span::SourceType,
};

/// What an app's code imports of one native module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Imported {
    /// Every export: the module is imported as a namespace
    /// (`import * as`), re-exported whole or loaded with `import()`.
    All,
    /// These exports, by the names the module exports them as (`default`
    /// for a default import); none for an import for its effects only.
    Names(BTreeSet<String>),
}

impl Imported {
    /// Whether export `name` is among them.
    pub fn has(&self, name: &str) -> bool {
        match self {
            Imported::All => true,
            Imported::Names(names) => names.contains(name),
        }
    }

    fn add(&mut self, name: &str) {
        if let Imported::Names(names) = self {
            names.insert(name.to_owned());
        }
    }
}

/// What an app's code uses of the native modules ([`crate::Bundle::native_use`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct NativeUse {
    /// What it imports of each native module, by specifier.
    pub imports: BTreeMap<String, Imported>,
    /// It may use the globals of `crypto` ([`nsh_core::js::CRYPTO_GLOBALS`]):
    /// it spells one of their names (as a variable, a member or a key it
    /// destructures, in a string or a template), reads a computed member of
    /// `globalThis`, `self`, `window` or `global`, or destructures one of
    /// them with a computed key or a rest element.
    pub global_crypto: bool,
    /// It loads a module whose specifier is computed (`import(name)`),
    /// which may be any native module, whole.
    pub computed_import: bool,
}

impl NativeUse {
    /// Adds what `code`, an ES module of the bundle, uses of the native
    /// modules that `is_native` tells apart by specifier.
    pub fn add(&mut self, code: &str, is_native: impl Fn(&str) -> bool) {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, code, SourceType::mjs()).parse();
        let mut finder = Finder {
            uses: self,
            is_native: &is_native,
        };
        finder.visit_program(&parsed.program);
    }

    fn import(&mut self, specifier: &str) -> &mut Imported {
        self.imports
            .entry(specifier.to_owned())
            .or_insert_with(|| Imported::Names(BTreeSet::new()))
    }
}

/// The global object's names: what is read from it by a name the code does
/// not spell may be a global of `crypto`.
const GLOBAL_OBJECTS: &[&str] = &["globalThis", "self", "window", "global"];

struct Finder<'u, F> {
    uses: &'u mut NativeUse,
    is_native: &'u F,
}

impl<F> Finder<'_, F> {
    /// A name spelled in the code: one of `crypto`'s globals may be reached
    /// through it.
    fn spelled(&mut self, name: &str) {
        if nsh_core::js::CRYPTO_GLOBALS.contains(&name) {
            self.uses.global_crypto = true;
        }
    }
}

/// Whether `expression` is the global object, by one of its names.
fn is_global_object(expression: &Expression<'_>) -> bool {
    matches!(expression, Expression::Identifier(object) if GLOBAL_OBJECTS.contains(&object.name.as_str()))
}

/// Whether a computed key is a name the code spells (a string or a number),
/// which the visitor judges where it is written.
fn is_literal_key(key: &PropertyKey<'_>) -> bool {
    matches!(
        key,
        PropertyKey::StringLiteral(_) | PropertyKey::NumericLiteral(_)
    )
}

impl<'a, F: Fn(&str) -> bool> Visit<'a> for Finder<'_, F> {
    fn visit_import_declaration(&mut self, it: &ImportDeclaration<'a>) {
        let source = it.source.value.as_str();
        if (self.is_native)(source) {
            let imported = self.uses.import(source);
            for specifier in it.specifiers.iter().flatten() {
                match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(s) => {
                        imported.add(s.imported.name().as_str())
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(_) => {
                        imported.add("default")
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {
                        *imported = Imported::All
                    }
                }
            }
        }
        walk::walk_import_declaration(self, it);
    }

    fn visit_export_from_declaration(&mut self, it: &ExportFromDeclaration<'a>) {
        if (self.is_native)(it.source.value.as_str()) {
            let imported = self.uses.import(it.source.value.as_str());
            for specifier in &it.specifiers {
                imported.add(specifier.local.name().as_str());
            }
        }
        walk::walk_export_from_declaration(self, it);
    }

    fn visit_export_all_declaration(&mut self, it: &ExportAllDeclaration<'a>) {
        if (self.is_native)(it.source.value.as_str()) {
            *self.uses.import(it.source.value.as_str()) = Imported::All;
        }
        walk::walk_export_all_declaration(self, it);
    }

    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        match &it.source {
            Expression::StringLiteral(source) => {
                if (self.is_native)(source.value.as_str()) {
                    *self.uses.import(source.value.as_str()) = Imported::All;
                }
            }
            _ => self.uses.computed_import = true,
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        self.spelled(it.name.as_str());
    }

    // Members (`globalThis.crypto`) and keys (`({ crypto: c } = globalThis)`,
    // `const { CryptoKey } = self`).
    fn visit_identifier_name(&mut self, it: &IdentifierName<'a>) {
        self.spelled(it.name.as_str());
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        self.spelled(it.value.as_str());
    }

    fn visit_template_element(&mut self, it: &TemplateElement<'a>) {
        if let Some(cooked) = &it.value.cooked {
            self.spelled(cooked.as_str());
        }
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        // A string's name is judged where it is spelled.
        if is_global_object(&it.object) && !matches!(it.expression, Expression::StringLiteral(_)) {
            self.uses.global_crypto = true;
        }
        walk::walk_computed_member_expression(self, it);
    }

    fn visit_variable_declarator(&mut self, it: &VariableDeclarator<'a>) {
        if let (BindingPattern::ObjectPattern(pattern), Some(init)) = (&it.id, &it.init)
            && is_global_object(init)
            && (pattern.rest.is_some()
                || pattern
                    .properties
                    .iter()
                    .any(|property| property.computed && !is_literal_key(&property.key)))
        {
            self.uses.global_crypto = true;
        }
        walk::walk_variable_declarator(self, it);
    }

    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        if let AssignmentTarget::ObjectAssignmentTarget(target) = &it.left
            && is_global_object(&it.right)
            && (target.rest.is_some()
                || target.properties.iter().any(|property| {
                    matches!(
                        property,
                        AssignmentTargetProperty::AssignmentTargetPropertyProperty(property)
                            if property.computed && !is_literal_key(&property.name)
                    )
                }))
        {
            self.uses.global_crypto = true;
        }
        walk::walk_assignment_expression(self, it);
    }
}

#[cfg(test)]
mod tests {
    use super::{Imported, NativeUse};

    fn uses(code: &str) -> NativeUse {
        let mut uses = NativeUse::default();
        uses.add(code, |s| s == "nsh" || s.starts_with("nsh/") || s == "zlib");
        uses
    }

    fn names(list: &[&str]) -> Imported {
        Imported::Names(list.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn named_imports_count_by_the_names_the_module_exports() {
        let uses = uses(
            r#"import { Button, Tabs as T } from "nsh/base"; import { View } from "nsh";
            import d from "zlib"; import { x } from "./shared.js";"#,
        );
        assert_eq!(
            uses.imports.get("nsh/base"),
            Some(&names(&["Button", "Tabs"]))
        );
        assert_eq!(uses.imports.get("nsh"), Some(&names(&["View"])));
        assert_eq!(uses.imports.get("zlib"), Some(&names(&["default"])));
        assert_eq!(uses.imports.len(), 3);
        assert!(!uses.global_crypto && !uses.computed_import);
    }

    #[test]
    fn namespaces_whole_re_exports_and_import_calls_use_every_export() {
        for code in [
            r#"import * as base from "nsh/base";"#,
            r#"export * from "nsh/base";"#,
            r#"const base = await import("nsh/base");"#,
            r#"import { Button } from "nsh/base"; import * as all from "nsh/base";"#,
        ] {
            assert_eq!(
                uses(code).imports.get("nsh/base"),
                Some(&Imported::All),
                "{code}"
            );
        }
    }

    #[test]
    fn re_exports_count_the_name_in_the_module_and_effects_none() {
        assert_eq!(
            uses(r#"export { Editor as E } from "nsh/base";"#)
                .imports
                .get("nsh/base"),
            Some(&names(&["Editor"]))
        );
        assert_eq!(
            uses(r#"import "nsh/base";"#).imports.get("nsh/base"),
            Some(&names(&[]))
        );
    }

    #[test]
    fn what_may_be_the_global_crypto_counts() {
        for code in [
            "crypto.randomUUID();",
            "globalThis.crypto.getRandomValues(a);",
            "self[key];",
            "window['crypto'];",
            "const name = 'crypto';",
        ] {
            assert!(uses(code).global_crypto, "{code}");
        }
        for code in [
            "const c = 1;",
            "globalThis.fetch(u);",
            "globalThis['fetch'];",
        ] {
            assert!(!uses(code).global_crypto, "{code}");
        }
    }

    /// A runtime without `crypto` lacks all of its globals, not only
    /// `crypto` (`nsh_core::js::CRYPTO_GLOBALS`).
    #[test]
    fn every_global_of_crypto_counts() {
        for code in [
            "if (key instanceof CryptoKey) {}",
            "const proto = SubtleCrypto.prototype;",
            "globalThis.Crypto;",
            "'CryptoKey' in self;",
        ] {
            assert!(uses(code).global_crypto, "{code}");
        }
    }

    #[test]
    fn destructuring_the_global_object_counts_the_names_it_may_take() {
        for code in [
            "const { crypto: c } = globalThis; c.randomUUID();",
            "let c; ({ crypto: c } = self);",
            "const { 'crypto': c } = window;",
            "const { [name]: c } = globalThis;",
            "let c; ({ [name]: c } = globalThis);",
            "const { fetch, ...rest } = globalThis;",
            "Reflect.get(globalThis, `crypto`);",
        ] {
            assert!(uses(code).global_crypto, "{code}");
        }
        for code in [
            "const { fetch } = globalThis;",
            "const { [key]: _, ...rest } = props;",
            "let v; ({ [key]: v } = props);",
        ] {
            assert!(!uses(code).global_crypto, "{code}");
        }
    }

    #[test]
    fn an_import_of_a_computed_specifier_may_be_any_module() {
        assert!(uses("import(name);").computed_import);
        assert!(!uses(r#"import("./Screen.js");"#).computed_import);
    }
}
