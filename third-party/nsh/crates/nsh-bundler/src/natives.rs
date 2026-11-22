//! What an app's code uses of the native modules, by name: the exports of
//! each native module it imports, and whether it may use the globals of the
//! standard module `crypto` ([`nsh_core::js::CRYPTO_GLOBALS`]). A runtime
//! that serves only those can leave the rest out of its binary (`nsh package
//! --target web`, `docs/dev/web.md`).
//!
//! It reads the bundle's output: native modules stay imports there
//! (`plugin.rs`), so every use is an import declaration, a re-export or an
//! `import()` of one. What it cannot tell apart counts as everything: a
//! namespace import uses the exports the code reads off it by names it
//! spells (`base.Button`, `base["Button"]`), and every export once the
//! namespace is used any other way ([`Namespace`]); a global of `crypto` is used wherever
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
        CallExpression, ChainElement, ComputedMemberExpression, ExportAllDeclaration,
        ExportFromDeclaration, Expression, IdentifierName, IdentifierReference, ImportDeclaration,
        ImportDeclarationSpecifier, ImportExpression, Program, PropertyKey, SimpleAssignmentTarget,
        Statement, StaticMemberExpression, StringLiteral, TaggedTemplateExpression,
        TemplateElement, UnaryExpression, UnaryOperator, VariableDeclarator,
    },
    ast_visit::{Visit, walk},
    parser::Parser,
    semantic::{Scoping, SemanticBuilder},
    span::SourceType,
    syntax::symbol::SymbolId,
};

/// What an app's code imports of one native module.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Imported {
    /// Every export: the module is imported as a namespace (`import * as`)
    /// the code uses other than by reading its members by name, re-exported
    /// whole or loaded with `import()`.
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
    /// It may make a shader view: it spells the tag of one (`shader`,
    /// `shadereffect`, `shadertransition`, `screeneffect`,
    /// `screentransition`) in a string or a template, as the compiled
    /// `<Shader>`, `<ShaderEffect>`, ... tags do (they pass it to `nsh:rt`'s
    /// `element`, and the import is gone), or `transitionShader`, a page's
    /// or a dialog's prop, as a key or a string.
    pub shader: bool,
    /// It may give a view a scroll bar theme of its own: it spells
    /// `scrollbar` as a key, a member or a string (`<ScrollView
    /// scrollbar={theme}>`). `nsh/base`'s core part draws such bars.
    pub scrollbar_theme: bool,
}

impl NativeUse {
    /// Adds what `code`, an ES module of the bundle, uses of the native
    /// modules that `is_native` tells apart by specifier.
    pub fn add(&mut self, code: &str, is_native: impl Fn(&str) -> bool) {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, code, SourceType::mjs()).parse();
        // Fills in the ids of the bindings and references namespaces are
        // told apart by.
        let scoping = SemanticBuilder::new()
            .build(&parsed.program)
            .semantic
            .into_scoping();
        let mut finder = Finder {
            namespaces: Namespace::of(&parsed.program, &is_native),
            uses: self,
            is_native: &is_native,
            scoping: &scoping,
            eval: false,
        };
        finder.visit_program(&parsed.program);
        let Finder {
            namespaces,
            eval,
            uses,
            ..
        } = finder;
        for namespace in namespaces {
            let imported = uses.import(&namespace.specifier);
            if namespace.whole || eval {
                *imported = Imported::All;
            } else {
                for name in &namespace.names {
                    imported.add(name);
                }
            }
        }
    }

    /// Adds what `other` uses: the use of code made of both.
    pub fn merge(&mut self, other: &NativeUse) {
        for (specifier, imported) in &other.imports {
            match (self.import(specifier), imported) {
                (Imported::All, _) => {}
                (mine, Imported::All) => *mine = Imported::All,
                (Imported::Names(mine), Imported::Names(names)) => {
                    mine.extend(names.iter().cloned())
                }
            }
        }
        self.global_crypto |= other.global_crypto;
        self.computed_import |= other.computed_import;
        self.shader |= other.shader;
        self.scrollbar_theme |= other.scrollbar_theme;
    }

    fn import(&mut self, specifier: &str) -> &mut Imported {
        self.imports
            .entry(specifier.to_owned())
            .or_insert_with(|| Imported::Names(BTreeSet::new()))
    }
}

/// The host tags of the views a shader draws (`jsx::PRIMITIVES`): each
/// needs the runtime's shader compiler.
const SHADER_TAGS: &[&str] = &[
    "shader",
    "shadereffect",
    "shadertransition",
    "screeneffect",
    "screentransition",
];

/// The global object's names: what is read from it by a name the code does
/// not spell may be a global of `crypto`.
const GLOBAL_OBJECTS: &[&str] = &["globalThis", "self", "window", "global"];

/// A native module imported as a namespace (`import * as base from
/// "nsh/base"`) and what the code reads off it.
///
/// The code uses the exports it reads by a name it spells: `base.Button`,
/// `base["Button"]`, ``base[`Button`]``, `base?.Button`, `(base).Button`, also as a call's
/// callee only when the namespace is not its receiver (`(0, base.toast)(…)`
/// or `new base.Widget()`). A method call hands the namespace to the callee
/// as `this`, so it keeps every export. Any other use may also reach every export, so it
/// counts as all of them ([`Namespace::whole`]): the namespace as a value
/// (an argument, a variable's value, destructured, returned, exported,
/// `typeof`, `in`, `base.f.call(base)`), a member by a computed key
/// (`base[name]`), writing or deleting a member (`base.X = …`, `delete
/// base.X`), and a direct `eval`, which sees the module's bindings by
/// names the code does not spell.
///
/// References are told apart by the scopes Oxc resolves: a binding of the
/// same name in an inner scope (a parameter, a `let`, a `catch` parameter)
/// is another variable. A reference Oxc left unresolved, or a namespace
/// whose binding has no id, counts as the namespace.
struct Namespace {
    /// The module's specifier.
    specifier: String,
    /// The namespace's local name.
    local: String,
    /// Its binding.
    symbol: Option<SymbolId>,
    /// The exports read off it by name.
    names: BTreeSet<String>,
    /// It is used in a way that may reach any export.
    whole: bool,
}

impl Namespace {
    /// The namespaces `program` imports of the native modules (imports are
    /// at a module's top level).
    fn of(program: &Program<'_>, is_native: &impl Fn(&str) -> bool) -> Vec<Self> {
        let mut namespaces = Vec::new();
        for statement in &program.body {
            let Statement::ImportDeclaration(import) = statement else {
                continue;
            };
            if !is_native(import.source.value.as_str()) {
                continue;
            }
            for specifier in import.specifiers.iter().flatten() {
                if let ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) = specifier {
                    namespaces.push(Namespace {
                        specifier: import.source.value.to_string(),
                        local: s.local.name.to_string(),
                        symbol: s.local.symbol_id.get(),
                        names: BTreeSet::new(),
                        whole: false,
                    });
                }
            }
        }
        namespaces
    }
}

struct Finder<'u, F> {
    uses: &'u mut NativeUse,
    is_native: &'u F,
    scoping: &'u Scoping,
    /// The namespace imports of the native modules ([`Namespace`]).
    namespaces: Vec<Namespace>,
    /// The code may call `eval` directly: every namespace counts whole.
    eval: bool,
}

impl<F> Finder<'_, F> {
    /// A string in the code: the tag of a shader view, if it is one.
    fn quoted(&mut self, value: &str) {
        if SHADER_TAGS.contains(&value) || value == "transitionShader" {
            self.uses.shader = true;
        }
        if value == "scrollbar" {
            self.uses.scrollbar_theme = true;
        }
    }

    /// A name spelled in the code: one of `crypto`'s globals may be reached
    /// through it.
    fn spelled(&mut self, name: &str) {
        if nsh_core::js::CRYPTO_GLOBALS.contains(&name) {
            self.uses.global_crypto = true;
        }
    }

    /// The binding `reference` resolves to, if Oxc resolved it.
    fn resolved(&self, reference: &IdentifierReference<'_>) -> Option<SymbolId> {
        reference
            .reference_id
            .get()
            .and_then(|id| self.scoping.get_reference(id).symbol_id())
    }

    /// The namespace ([`Namespace`]) `reference` names: one of its name,
    /// unless Oxc resolved it to another binding (one shadowing it).
    fn namespace(&self, reference: &IdentifierReference<'_>) -> Option<usize> {
        let index = self
            .namespaces
            .iter()
            .position(|n| n.local == reference.name.as_str())?;
        match (self.namespaces[index].symbol, self.resolved(reference)) {
            (Some(own), Some(other)) if own != other => None,
            _ => Some(index),
        }
    }

    /// The namespace `object` is, when it is one (in parentheses too:
    /// `(base as any).X` once TypeScript's `as` is gone).
    fn namespace_object(&self, object: &Expression<'_>) -> Option<usize> {
        match object {
            Expression::Identifier(reference) => self.namespace(reference),
            Expression::ParenthesizedExpression(inner) => self.namespace_object(&inner.expression),
            _ => None,
        }
    }

    /// Export `name` read off namespace `index`.
    fn read(&mut self, index: usize, name: String) {
        let local = self.namespaces[index].local.clone();
        self.spelled(&local);
        self.namespaces[index].names.insert(name);
    }

    /// Method calls and tagged templates hand their receiver to user code.
    /// Do not assume an exported function ignores the namespace as `this`.
    fn called_member(&mut self, callee: &Expression<'_>) {
        match callee {
            Expression::StaticMemberExpression(m) => self.changed_member(Some(&m.object)),
            Expression::ComputedMemberExpression(m) => self.changed_member(Some(&m.object)),
            Expression::ParenthesizedExpression(p) => self.called_member(&p.expression),
            Expression::ChainExpression(c) => match &c.expression {
                ChainElement::StaticMemberExpression(m) => self.changed_member(Some(&m.object)),
                ChainElement::ComputedMemberExpression(m) => self.changed_member(Some(&m.object)),
                _ => {}
            },
            _ => {}
        }
    }

    /// A member of `object` written or deleted: when it is a namespace,
    /// every export.
    fn changed_member(&mut self, object: Option<&Expression<'_>>) {
        if let Some(index) = object.and_then(|o| self.namespace_object(o)) {
            self.namespaces[index].whole = true;
        }
    }
}

/// Whether `expression` is the global object, by one of its names.
fn is_global_object(expression: &Expression<'_>) -> bool {
    matches!(expression, Expression::Identifier(object) if GLOBAL_OBJECTS.contains(&object.name.as_str()))
}

/// The string an expression spells: a string, or a template with no
/// interpolation (`` import(`nsh/desktop`) ``, as the minifier writes
/// `import("nsh/desktop")`). `None` for one computed when it runs.
fn spelled_string(source: &Expression<'_>) -> Option<String> {
    match source {
        Expression::StringLiteral(s) => Some(s.value.to_string()),
        Expression::TemplateLiteral(t) if t.expressions.is_empty() => {
            t.quasis.iter().map(|q| q.value.cooked.as_deref()).collect()
        }
        _ => None,
    }
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
                    // By what the code reads off it, once it is read
                    // (`NativeUse::add`, [`Namespace`]).
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(_) => {}
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
        match spelled_string(&it.source) {
            Some(source) => {
                if (self.is_native)(&source) {
                    *self.uses.import(&source) = Imported::All;
                }
            }
            None => self.uses.computed_import = true,
        }
        walk::walk_import_expression(self, it);
    }

    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        self.spelled(it.name.as_str());
        // Not the object of a member read by name (those are
        // `visit_static_member_expression`'s and
        // `visit_computed_member_expression`'s): the namespace itself.
        if let Some(index) = self.namespace(it) {
            self.namespaces[index].whole = true;
        }
        // The global `eval` (a module cannot declare one of its own),
        // which may be called directly.
        if it.name == "eval" && self.resolved(it).is_none() {
            self.eval = true;
        }
    }

    fn visit_call_expression(&mut self, it: &CallExpression<'a>) {
        self.called_member(&it.callee);
        walk::walk_call_expression(self, it);
    }

    fn visit_tagged_template_expression(&mut self, it: &TaggedTemplateExpression<'a>) {
        self.called_member(&it.tag);
        walk::walk_tagged_template_expression(self, it);
    }

    fn visit_static_member_expression(&mut self, it: &StaticMemberExpression<'a>) {
        if let Some(index) = self.namespace_object(&it.object) {
            self.read(index, it.property.name.to_string());
            self.visit_identifier_name(&it.property);
            return;
        }
        walk::walk_static_member_expression(self, it);
    }

    fn visit_simple_assignment_target(&mut self, it: &SimpleAssignmentTarget<'a>) {
        self.changed_member(match it {
            SimpleAssignmentTarget::StaticMemberExpression(m) => Some(&m.object),
            SimpleAssignmentTarget::ComputedMemberExpression(m) => Some(&m.object),
            _ => None,
        });
        walk::walk_simple_assignment_target(self, it);
    }

    fn visit_assignment_target(&mut self, it: &AssignmentTarget<'a>) {
        self.changed_member(match it {
            AssignmentTarget::StaticMemberExpression(m) => Some(&m.object),
            AssignmentTarget::ComputedMemberExpression(m) => Some(&m.object),
            _ => None,
        });
        walk::walk_assignment_target(self, it);
    }

    fn visit_unary_expression(&mut self, it: &UnaryExpression<'a>) {
        if it.operator == UnaryOperator::Delete {
            self.changed_member(match &it.argument {
                Expression::StaticMemberExpression(m) => Some(&m.object),
                Expression::ComputedMemberExpression(m) => Some(&m.object),
                _ => None,
            });
        }
        walk::walk_unary_expression(self, it);
    }

    // Members (`globalThis.crypto`) and keys (`({ crypto: c } = globalThis)`,
    // `const { CryptoKey } = self`).
    // A key `transitionShader` is a page's or a dialog's shader.
    fn visit_identifier_name(&mut self, it: &IdentifierName<'a>) {
        self.spelled(it.name.as_str());
        if it.name == "transitionShader" {
            self.uses.shader = true;
        }
        if it.name == "scrollbar" {
            self.uses.scrollbar_theme = true;
        }
    }

    fn visit_string_literal(&mut self, it: &StringLiteral<'a>) {
        self.spelled(it.value.as_str());
        self.quoted(it.value.as_str());
    }

    fn visit_template_element(&mut self, it: &TemplateElement<'a>) {
        if let Some(cooked) = &it.value.cooked {
            self.spelled(cooked.as_str());
            self.quoted(cooked.as_str());
        }
    }

    fn visit_computed_member_expression(&mut self, it: &ComputedMemberExpression<'a>) {
        // A string's name is judged where it is spelled.
        if is_global_object(&it.object) && !matches!(it.expression, Expression::StringLiteral(_)) {
            self.uses.global_crypto = true;
        }
        // A namespace's member by a name the code spells; by a computed
        // one, the walk visits the namespace itself (whole).
        if let Some(index) = self.namespace_object(&it.object)
            && let Some(name) = spelled_string(&it.expression)
        {
            self.read(index, name);
            self.visit_expression(&it.expression);
            return;
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
    fn merged_uses_are_those_of_both() {
        let mut a = uses(r#"import { Button } from "nsh/base"; import d from "zlib";"#);
        let b = uses(
            r#"import { Tabs } from "nsh/base"; import * as n from "nsh"; use(n); import("x" + y);"#,
        );
        let mut whole = uses(
            r#"import { Button } from "nsh/base"; import d from "zlib";
            import { Tabs } from "nsh/base"; import * as n from "nsh"; use(n); import("x" + y);"#,
        );
        a.merge(&b);
        assert_eq!(a, whole);
        // Merging is idempotent and keeps `All`.
        a.merge(&b);
        assert_eq!(a, whole);
        whole.merge(&uses(r#"import { View } from "nsh";"#));
        assert_eq!(whole.imports.get("nsh"), Some(&Imported::All));
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
    fn whole_re_exports_and_import_calls_use_every_export() {
        for code in [
            r#"export * from "nsh/base";"#,
            r#"export * as base from "nsh/base";"#,
            r#"const base = await import("nsh/base");"#,
            r#"import { Button } from "nsh/base"; import * as all from "nsh/base"; use(all);"#,
        ] {
            assert_eq!(
                uses(code).imports.get("nsh/base"),
                Some(&Imported::All),
                "{code}"
            );
        }
    }

    /// The pattern of an app that runs on shells with and without an
    /// export: it reads it off the namespace, `undefined` where the shell
    /// lacks it, rather than importing it by name, which fails to link.
    #[test]
    fn a_namespace_read_by_name_uses_the_names_read() {
        let code = r#"import * as base from "nsh/base"; import { View } from "nsh";
            const EmojiPicker = base.EmojiPicker;
            export function Picker(props) {
                return EmojiPicker ? _$c(EmojiPicker, props) : _$c(View, {});
            }"#;
        let found = uses(code);
        assert_eq!(
            found.imports.get("nsh/base"),
            Some(&names(&["EmojiPicker"]))
        );
        assert_eq!(found.imports.get("nsh"), Some(&names(&["View"])));
        // As the minifier writes it.
        assert_eq!(
            uses(r#"import*as e from"nsh/base";const t=e.EmojiPicker;export{t as P};"#)
                .imports
                .get("nsh/base"),
            Some(&names(&["EmojiPicker"]))
        );
        // Spelled keys, optional reads, reads in nested functions, and
        // the names imported beside it.
        assert_eq!(
            uses(
                r#"import { Button } from "nsh/base"; import * as b from "nsh/base";
                const a = b["Tabs"], c = b[`Tab`], d = b?.Slider;
                function f() { return () => b.Editor.displayName; }
                if (typeof b.Menu === "function") {}
                const s = (b).Select, p = ((b))["Popover"];"#
            )
            .imports
            .get("nsh/base"),
            Some(&names(&[
                "Button", "Editor", "Menu", "Popover", "Select", "Slider", "Tab", "Tabs"
            ]))
        );
        // Imported and never read: for its effects only.
        assert_eq!(
            uses(r#"import * as base from "nsh/base";"#)
                .imports
                .get("nsh/base"),
            Some(&names(&[]))
        );
        // Another module's namespace is not a native one's.
        assert_eq!(
            uses(r#"import * as base from "./base.js"; use(base);"#)
                .imports
                .len(),
            0
        );
    }

    /// Calls that pass the namespace as `this` keep every export.
    /// Extracted functions and constructors do not pass that receiver.
    #[test]
    fn calls_only_prune_when_the_namespace_is_not_the_receiver() {
        for code in [
            r#"import * as base from "nsh/base"; (0, base.toast)("hi");"#,
            r#"import * as base from "nsh/base"; new base.toast();"#,
            r#"import * as base from "nsh/base"; base.toast.call(null, "hi");"#,
        ] {
            assert_eq!(
                uses(code).imports.get("nsh/base"),
                Some(&names(&["toast"])),
                "{code}"
            );
        }
        for code in [
            r#"import * as base from "nsh/base"; base.toast("hi");"#,
            r#"import * as base from "nsh/base"; base?.toast?.("hi");"#,
            r#"import * as base from "nsh/base"; base["toast"]("hi");"#,
            r#"import * as base from "nsh/base"; base.toast`hi`;"#,
            r#"import * as base from "nsh/base"; (base.toast)("hi");"#,
            r#"import * as base from "nsh/base"; (base?.toast)("hi");"#,
            r#"import * as base from "nsh/base"; base.toast.call(base, "hi");"#,
            r#"import * as base from "nsh/base"; base.toast.apply(base, []);"#,
            r#"import * as base from "nsh/base"; Reflect.apply(base.toast, base, []);"#,
            r#"import * as base from "nsh/base"; base.toast.bind(base)();"#,
        ] {
            assert_eq!(
                uses(code).imports.get("nsh/base"),
                Some(&Imported::All),
                "{code}"
            );
        }
    }

    /// Any use of the namespace but a read of a member by a name the code
    /// spells may reach any export.
    #[test]
    fn a_namespace_used_otherwise_uses_every_export() {
        for use_of_it in [
            // As a value.
            "use(base);",
            "const ns = base; ns.Tabs;",
            "export default base;",
            "export { base };",
            "export { base as kit };",
            "const { Tabs } = base;",
            "let Tabs; ({ Tabs } = base);",
            "const [x] = [base];",
            "const o = { base };",
            "const o = { ...base };",
            "for (const k in base) {}",
            "Object.keys(base);",
            "function f() { return base; }",
            "const f = () => base;",
            "typeof base;",
            "'Tabs' in base;",
            "base === other;",
            "if (base) {}",
            "(0, base).Tabs;",
            "(cond ? base : other).Tabs;",
            // Computed keys.
            "base[name];",
            "base[`${name}`];",
            "base['Ta' + 'bs'];",
            "base[0];",
            // Changes.
            "base.Tabs = 1;",
            "(base).Tabs = 1;",
            "base['Tabs'] = 1;",
            "base.Tabs += 1;",
            "base.Tabs++;",
            "delete base.Tabs;",
            "delete base['Tabs'];",
            "[base.Tabs] = list;",
            "({ a: base.Tabs } = props);",
            "for (base.Tabs of list) {}",
            "base = other;",
            // A direct `eval` sees the binding by a name in a string.
            "eval('base.Editor');",
            "function f() { return eval(code); }",
        ] {
            let code = format!(r#"import * as base from "nsh/base"; base.Button; {use_of_it}"#);
            assert_eq!(
                uses(&code).imports.get("nsh/base"),
                Some(&Imported::All),
                "{code}"
            );
        }
    }

    /// Bindings of the same name in inner scopes are other variables: what
    /// they do counts for nothing, what the namespace does still counts.
    #[test]
    fn a_shadowing_binding_is_another_variable() {
        for code in [
            "function f(base) { return base.Editor; } base.Button;",
            "function f(base) { use(base); } base.Button;",
            "const f = (base) => base[name]; base.Button;",
            "{ const base = make(); base.Editor = 1; use(base); } base.Button;",
            "try {} catch (base) { use(base); } base.Button;",
            "function f() { let base; base = 1; delete base.Editor; } base.Button;",
            "class C { m(base) { return base; } } base.Button;",
            "function f({ base }) { use(base); } base.Button;",
            "for (const base of list) use(base); base.Button;",
            "function base2() {} use(base2); base.Button;",
        ] {
            let code = format!(r#"import * as base from "nsh/base"; {code}"#);
            assert_eq!(
                uses(&code).imports.get("nsh/base"),
                Some(&names(&["Button"])),
                "{code}"
            );
        }
        // The namespace in an inner scope that does not shadow it.
        for code in [
            "function f(other) { return use(base); }",
            "{ const other = 1; use(base); }",
            "function f(base2) { return base; }",
        ] {
            let code = format!(r#"import * as base from "nsh/base"; base.Button; {code}"#);
            assert_eq!(
                uses(&code).imports.get("nsh/base"),
                Some(&Imported::All),
                "{code}"
            );
        }
    }

    /// Each namespace counts apart, and merging keeps the names of both
    /// or `All`.
    #[test]
    fn namespaces_count_apart_and_merge() {
        let found = uses(
            r#"import * as base from "nsh/base"; import * as z from "zlib";
            import * as n from "nsh";
            base.Button; (0, z.gzipSync)(data); use(n);"#,
        );
        assert_eq!(found.imports.get("nsh/base"), Some(&names(&["Button"])));
        assert_eq!(found.imports.get("zlib"), Some(&names(&["gzipSync"])));
        assert_eq!(found.imports.get("nsh"), Some(&Imported::All));
        let mut merged = uses(r#"import * as base from "nsh/base"; base.Button;"#);
        merged.merge(&uses(r#"import * as b from "nsh/base"; b.Tabs;"#));
        assert_eq!(
            merged.imports.get("nsh/base"),
            Some(&names(&["Button", "Tabs"]))
        );
        merged.merge(&uses(r#"import * as b from "nsh/base"; use(b);"#));
        assert_eq!(merged.imports.get("nsh/base"), Some(&Imported::All));
    }

    /// What the names read off a namespace spell still counts as spelled.
    #[test]
    fn names_read_off_a_namespace_are_spelled() {
        assert!(uses(r#"import * as n from "nsh"; n.crypto;"#).global_crypto);
        assert!(uses(r#"import * as crypto from "crypto"; crypto.randomUUID();"#).global_crypto);
        assert!(uses(r#"import * as n from "nsh"; n["transitionShader"];"#).shader);
        assert!(uses(r#"import * as n from "nsh"; n.scrollbar;"#).scrollbar_theme);
        assert!(!uses(r#"import * as n from "nsh"; n.View;"#).global_crypto);
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
    fn a_shader_tag_counts_as_a_shader() {
        assert!(uses("_$element(\"shader\");").shader);
        assert!(uses("u(`shader`);").shader);
        for tag in [
            "shadereffect",
            "shadertransition",
            "screeneffect",
            "screentransition",
        ] {
            assert!(uses(&format!("_$element(\"{tag}\");")).shader, "{tag}");
        }
        assert!(uses("_$c(NavPage, { transitionShader: wipe });").shader);
        assert!(uses("_$c(Dialog, { \"transitionShader\": wipe });").shader);
        assert!(!uses("const options = { shader: wipe };").shader);
        assert!(!uses("const shader = view;").shader);
    }

    #[test]
    fn a_scrollbar_key_counts_as_a_scrollbar_theme() {
        assert!(uses("_$c(ScrollView, { scrollbar: theme });").scrollbar_theme);
        assert!(uses("_$setProp(el, \"scrollbar\", theme);").scrollbar_theme);
        assert!(uses("view.scrollbar = theme;").scrollbar_theme);
        assert!(!uses("const bar = view;").scrollbar_theme);
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
        assert!(uses("import(`./${name}.js`);").computed_import);
    }

    #[test]
    fn an_import_of_a_template_with_no_interpolation_names_its_module() {
        // The minifier writes `import("nsh/desktop")` with backticks.
        let found = uses("import(`nsh/desktop`).then((m) => m.Window);");
        assert!(!found.computed_import);
        assert_eq!(found.imports.get("nsh/desktop"), Some(&Imported::All));
    }
}
