//! nsh's JSX compiler: lowers JSX to calls of the native renderer
//! (`nsh:rt`, `crates/nsh-js/src/dom.rs`).
//!
//! **Tags** are PascalCase and name bindings by the usual scoping: every
//! tag is imported or local, except `<If when else>` and `<Each of key>`,
//! globals no binding of their name shadows. A tag naming one of the
//! [`PRIMITIVES`] imported from its module (`import { View as V } from
//! "nsh"` too) compiles to what it is: a host element made in place, the
//! renderer's list, control flow; the import is then unused and goes.
//! Every other tag is a component call. Lowercase tags are errors naming
//! the import to write (TypeScript checks a lowercase tag against one
//! global type per name, so generic and local components would lose their
//! types). Props keep their camelCase names.
//!
//! **Host elements** become one function that makes the element, its props
//! and its host children, and returns it. Static values are set once
//! (`prop`, `append`); values that change are functions the renderer
//! follows natively (`bindProp`, `insert`). An expression changes when it
//! calls something or reads a member (outside nested functions), as in
//! Solid. Event handlers are set once when they are a function or a name,
//! else followed. Consecutive dynamic children share one `insert`, placed
//! before the next static child.
//!
//! **Components** are called (untracked) with a props object: static props
//! are values, the others getters (`get title() { return … }`), children
//! the `children` getter; spreads keep getters (`merge`).
//!
//! The code is generated as JS text with holes, parsed, and the app's own
//! expressions are moved into the holes: they keep their spans (the source
//! map points at them), generated nodes take their JSX element's.

use std::{cell::Cell, collections::HashMap};

use oxc::{
    allocator::{Allocator, TakeIn},
    ast::{
        ast::{
            Expression, ImportDeclarationSpecifier, JSXAttributeItem, JSXAttributeName,
            JSXAttributeValue, JSXChild, JSXElement, JSXElementName, JSXExpression, JSXFragment,
            JSXMemberExpression, JSXMemberExpressionObject, ModuleExportName, Program, Statement,
        },
        builder::AstBuilder,
    },
    ast_visit::{Visit, VisitMut, walk_mut},
    diagnostics::OxcDiagnostic,
    parser::Parser,
    semantic::Scoping,
    span::{GetSpan, SourceType, Span},
    syntax::scope::{ScopeFlags, ScopeId},
};

/// What the tag of a primitive compiles to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Compiled {
    /// The host element of this core tag, made in place.
    Host(&'static str),
    /// The renderer's list (`nsh:rt`'s `list`).
    List,
    /// A call of the export, a native component rendering the host element
    /// of this core tag with more to it (`Canvas`'s drawing, `Dialog`'s
    /// `open`, `InputAccessoryView` only on iOS).
    Component(&'static str),
}

/// nsh's primitives, by their home (module, export), and what their tags
/// compile to: `nsh`'s, `nsh/base`'s `Input` and `Dialog` and
/// `nsh/mobile`'s `InputAccessoryView`.
pub(crate) const PRIMITIVES: &[(&str, &str, Compiled)] = &[
    ("nsh", "View", Compiled::Host("view")),
    ("nsh", "Text", Compiled::Host("text")),
    ("nsh", "Scroll", Compiled::Host("scroll")),
    ("nsh", "Overlay", Compiled::Host("overlay")),
    ("nsh", "Image", Compiled::Host("image")),
    ("nsh", "WebView", Compiled::Host("webview")),
    ("nsh", "Video", Compiled::Host("video")),
    ("nsh", "List", Compiled::List),
    ("nsh", "Canvas", Compiled::Component("canvas")),
    ("nsh/base", "Input", Compiled::Host("input")),
    ("nsh/base", "Dialog", Compiled::Component("modal")),
    (
        "nsh/mobile",
        "InputAccessoryView",
        Compiled::Component("inputaccessory"),
    ),
];

/// The control flow tags, global unless a binding of the name shadows them.
const GLOBALS: &[&str] = &["If", "Each"];

/// The renderer's functions compiled code calls (imported as `_$<name>`).
const HELPERS: &[&str] = &[
    "list",
    "element",
    "text",
    "append",
    "insert",
    "prop",
    "bindProp",
    "spread",
    "component",
    "cond",
    "each",
    "merge",
    "setup",
    "metaUrl",
    "ref",
];

/// Prefix of generated names; apps do not use it.
const HOLE: &str = "__nsh_h";

fn export_name(n: &ModuleExportName<'_>) -> String {
    match n {
        ModuleExportName::IdentifierName(n) => n.name.to_string(),
        ModuleExportName::IdentifierReference(n) => n.name.to_string(),
        ModuleExportName::StringLiteral(n) => n.value.to_string(),
    }
}

/// The primitives `program` imports: local name -> what its tag compiles to.
fn imported_primitives(program: &Program<'_>) -> HashMap<String, Compiled> {
    let mut out = HashMap::new();
    for statement in &program.body {
        let Statement::ImportDeclaration(i) = statement else {
            continue;
        };
        let module = i.source.value.as_str();
        for spec in i.specifiers.iter().flatten() {
            let ImportDeclarationSpecifier::ImportSpecifier(s) = spec else {
                continue;
            };
            let imported = export_name(&s.imported);
            if let Some(&(.., compiled)) = PRIMITIVES
                .iter()
                .find(|(m, e, _)| *m == module && *e == imported)
            {
                out.insert(s.local.name.to_string(), compiled);
            }
        }
    }
    out
}

/// Compiles the JSX of `program` (TypeScript already removed; `scoping`
/// its scopes). `prologue` is JS run first (the entry's setup). Errors come
/// back rendered with a code frame of `source`.
pub(crate) fn transform<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    scoping: &Scoping,
    source: &str,
    prologue: Option<&str>,
    meta_path: Option<&str>,
    modules: &crate::compile::NativeModules,
) -> Result<(), String> {
    let mut compiler = Compiler {
        meta_path,
        allocator,
        scoping,
        scopes: Vec::new(),
        errors: Vec::new(),
        used: [false; HELPERS.len()],
        vars: Cell::new(0),
        components: &modules.components,
        primitives: imported_primitives(program),
    };
    compiler.visit_program(program);
    if let Some(err) = compiler.errors.into_iter().next() {
        return Err(err.render_with_source_code(source.to_owned()));
    }
    let mut head = String::new();
    if let Some(prologue) = prologue {
        compiler.used[helper("setup")] = true;
        head.push_str(prologue);
    }
    let imports: Vec<String> = HELPERS
        .iter()
        .zip(compiler.used)
        .filter(|(_, used)| *used)
        .map(|(name, _)| format!("{name} as _${name}"))
        .collect();
    if imports.is_empty() {
        return Ok(());
    }
    let text = format!(
        "import {{ {} }} from \"nsh:rt\";\n{head}",
        imports.join(", ")
    );
    let text = allocator.alloc_str(&text);
    let parsed = Parser::new(allocator, text, SourceType::mjs()).parse();
    if let Some(err) = parsed.diagnostics.into_iter().next() {
        return Err(format!("nsh compiler: {err}"));
    }
    let mut body = parsed.program.body;
    let mut splice = Splice {
        holes: Vec::new(),
        span: Span::default(),
    };
    for statement in body.iter_mut() {
        splice.visit_statement(statement);
    }
    let rest = program.body.take_in(&AstBuilder::new(allocator));
    body.extend(rest);
    program.body = body;
    Ok(())
}

fn helper(name: &str) -> usize {
    HELPERS.iter().position(|h| *h == name).expect("a helper")
}

/// `web-view` -> `WebView`: a lowercase tag as the PascalCase name it
/// likely meant.
fn pascal(tag: &str) -> String {
    tag.split(['-', '_'])
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map_or_else(String::new, |c| {
                c.to_ascii_uppercase().to_string() + chars.as_str()
            })
        })
        .collect()
}

/// The edit distance of `a` and `b`, ignoring case.
fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().map(|c| c.to_ascii_lowercase()).collect();
    let b: Vec<char> = b.chars().map(|c| c.to_ascii_lowercase()).collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut prev = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (prev + usize::from(ca != cb))
                .min(row[j] + 1)
                .min(row[j + 1] + 1);
            prev = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

/// A JS string literal.
fn quote(s: &str) -> String {
    serde_json::to_string(s).expect("a string")
}

/// An object key: bare when it is an identifier, quoted otherwise.
fn key(name: &str) -> String {
    let ident = !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if ident { name.to_owned() } else { quote(name) }
}

/// JSX text as React and Solid render it (Babel's algorithm): lines
/// trimmed except at the text's ends, whitespace-only lines dropped, the
/// rest joined with a space; entities decoded. One line keeps its spaces
/// (`{a} {b}`).
fn clean_text(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.split(['\n', '\r']).collect();
    let last_non_empty = lines
        .iter()
        .rposition(|l| l.contains(|c| c != ' ' && c != '\t'))
        .unwrap_or(0);
    let mut out = String::new();
    for (i, line) in lines.iter().enumerate() {
        let line = line.replace('\t', " ");
        let mut t: &str = &line;
        if i != 0 {
            t = t.trim_start();
        }
        if i != lines.len() - 1 {
            t = t.trim_end();
        }
        if t.is_empty() {
            continue;
        }
        out.push_str(t);
        if i != last_non_empty {
            out.push(' ');
        }
    }
    (!out.is_empty()).then(|| decode_entities(&out))
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_owned();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// How many values `children` give (text that is not only whitespace,
/// elements, fragments and expressions).
fn child_count(children: &[JSXChild<'_>]) -> usize {
    children
        .iter()
        .filter(|c| match c {
            JSXChild::Text(t) => clean_text(&t.value).is_some(),
            JSXChild::ExpressionContainer(c) => {
                !matches!(c.expression, JSXExpression::EmptyExpression(_))
            }
            JSXChild::Element(_) | JSXChild::Fragment(_) | JSXChild::Spread(_) => true,
        })
        .count()
}

/// `e` without parentheses and TypeScript's assertions (`el!`, `el as
/// T`), which leave what it names (a ref's target) as it is.
fn without_wrappers(e: Expression<'_>) -> Expression<'_> {
    match e {
        Expression::ParenthesizedExpression(p) => without_wrappers(p.unbox().expression),
        Expression::TSNonNullExpression(t) => without_wrappers(t.unbox().expression),
        Expression::TSAsExpression(t) => without_wrappers(t.unbox().expression),
        Expression::TSSatisfiesExpression(t) => without_wrappers(t.unbox().expression),
        Expression::TSTypeAssertion(t) => without_wrappers(t.unbox().expression),
        e => e,
    }
}

/// The part of `span` (`raw`'s, the source text) without the whitespace
/// around it: what a label points at.
fn trimmed_span(span: Span, raw: &str) -> Span {
    if span.size() as usize != raw.len() {
        return span;
    }
    let lead = (raw.len() - raw.trim_start().len()) as u32;
    let trail = (raw.len() - raw.trim_end().len()) as u32;
    Span::new(span.start + lead, span.end - trail)
}

/// Whether an expression's value may change: it calls something or reads a
/// member, outside nested functions.
fn is_dynamic(e: &Expression<'_>) -> bool {
    #[derive(Default)]
    struct Find(bool);
    impl<'a> Visit<'a> for Find {
        fn visit_call_expression(&mut self, _: &oxc::ast::ast::CallExpression<'a>) {
            self.0 = true;
        }
        fn visit_new_expression(&mut self, _: &oxc::ast::ast::NewExpression<'a>) {
            self.0 = true;
        }
        fn visit_static_member_expression(
            &mut self,
            _: &oxc::ast::ast::StaticMemberExpression<'a>,
        ) {
            self.0 = true;
        }
        fn visit_computed_member_expression(
            &mut self,
            _: &oxc::ast::ast::ComputedMemberExpression<'a>,
        ) {
            self.0 = true;
        }
        fn visit_private_field_expression(
            &mut self,
            _: &oxc::ast::ast::PrivateFieldExpression<'a>,
        ) {
            self.0 = true;
        }
        fn visit_tagged_template_expression(
            &mut self,
            _: &oxc::ast::ast::TaggedTemplateExpression<'a>,
        ) {
            self.0 = true;
        }
        fn visit_function(&mut self, _: &oxc::ast::ast::Function<'a>, _: ScopeFlags) {}
        fn visit_arrow_function_expression(
            &mut self,
            _: &oxc::ast::ast::ArrowFunctionExpression<'a>,
        ) {
        }
    }
    let mut f = Find::default();
    f.visit_expression(e);
    f.0
}

fn is_function(e: &Expression<'_>) -> bool {
    matches!(
        e.without_parentheses(),
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
    )
}

/// `onPress`, `onChange`: an event handler prop.
fn is_event(name: &str) -> bool {
    name.len() > 2 && name.starts_with("on") && name.as_bytes()[2].is_ascii_uppercase()
}

/// What a tag names.
enum Tag {
    /// A host element, made in place (the core's tag).
    Host(&'static str),
    /// A component: the JS expression naming it.
    Component(String),
    If,
    Each,
}

/// The holes of one generated snippet.
struct Gen<'a> {
    holes: Vec<Expression<'a>>,
}

impl<'a> Gen<'a> {
    fn hole(&mut self, e: Expression<'a>) -> String {
        self.holes.push(e);
        format!("{HOLE}{}", self.holes.len() - 1)
    }
}

/// How a child's value is written.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Read once (in a getter, which is read again): expressions as they
    /// are.
    Getter,
    /// Kept: expressions that change become functions.
    Value,
}

struct Compiler<'a, 's> {
    allocator: &'a Allocator,
    scoping: &'s Scoping,
    scopes: Vec<ScopeId>,
    errors: Vec<OxcDiagnostic>,
    used: [bool; HELPERS.len()],
    vars: Cell<usize>,
    /// The UI sets' components (export, module), for hints.
    components: &'s [(String, String)],
    /// The primitives the module imports, by local name.
    primitives: HashMap<String, Compiled>,
    /// The module's path in the app: `import.meta.url` becomes its URL.
    meta_path: Option<&'s str>,
}

/// Whether `e` is `import.meta.url`.
fn is_import_meta_url(e: &Expression<'_>) -> bool {
    let Expression::StaticMemberExpression(m) = e else {
        return false;
    };
    m.property.name == "url" && matches!(&m.object, Expression::ImportMeta(_))
}

impl<'a> VisitMut<'a> for Compiler<'a, '_> {
    fn enter_scope(&mut self, _flags: ScopeFlags, scope_id: &Cell<Option<ScopeId>>) {
        match scope_id.get().or_else(|| self.scopes.last().copied()) {
            Some(id) => self.scopes.push(id),
            None => self.scopes.push(self.scoping.root_scope_id()),
        }
    }

    fn leave_scope(&mut self) {
        self.scopes.pop();
    }

    fn visit_expression(&mut self, e: &mut Expression<'a>) {
        if let Some(path) = self.meta_path
            && is_import_meta_url(e)
        {
            // The module's own URL, which the runtime knows: the bundle
            // shares one `import.meta`.
            let call = format!(
                "{}({})",
                self.use_helper("metaUrl"),
                serde_json::to_string(path).expect("a path is JSON")
            );
            *e = self.parse(&call, Vec::new(), e.span());
        } else if matches!(e, Expression::JSXElement(_) | Expression::JSXFragment(_)) {
            let span = e.span();
            let jsx = e.take_in(&AstBuilder::new(self.allocator));
            let mut g = Gen { holes: Vec::new() };
            let text = match jsx {
                Expression::JSXElement(el) => self.element(el.unbox(), &mut g),
                Expression::JSXFragment(f) => self.fragment(f.unbox(), &mut g),
                _ => unreachable!(),
            };
            *e = self.parse(&text, g.holes, span);
        } else {
            walk_mut::walk_expression(self, e);
        }
    }
}

impl<'a> Compiler<'a, '_> {
    fn error(&mut self, message: impl Into<String>, span: Span) {
        self.errors
            .push(OxcDiagnostic::error(message.into()).with_label(span));
    }

    fn use_helper(&mut self, name: &str) -> String {
        self.used[helper(name)] = true;
        format!("_${name}")
    }

    fn var(&self) -> String {
        let n = self.vars.get();
        self.vars.set(n + 1);
        format!("{HOLE}v{n}")
    }

    /// Whether `name` names a binding here that code may assign: not a
    /// `const`, an import or an undeclared global.
    fn assignable(&self, name: &str) -> bool {
        let scope = self
            .scopes
            .last()
            .copied()
            .unwrap_or_else(|| self.scoping.root_scope_id());
        self.scoping
            .find_binding(scope, name.into())
            .is_some_and(|symbol| {
                let flags = self.scoping.symbol_flags(symbol);
                !flags.is_const_variable() && !flags.is_import()
            })
    }

    /// The binding `name` names here, if any: (whether it is the module's
    /// own top-level binding).
    fn binding(&self, name: &str) -> Option<bool> {
        let scope = self
            .scopes
            .last()
            .copied()
            .unwrap_or_else(|| self.scoping.root_scope_id());
        let symbol = self.scoping.find_binding(scope, name.into())?;
        Some(self.scoping.symbol_scope_id(symbol) == self.scoping.root_scope_id())
    }

    fn tag(&mut self, name: &JSXElementName<'a>) -> Option<Tag> {
        match name {
            JSXElementName::Identifier(id) => {
                let tag = id.name.as_str();
                let hint = self.hint(tag);
                self.error(
                    format!("lowercase tag <{tag}>: tags are PascalCase components{hint}"),
                    id.span,
                );
                None
            }
            JSXElementName::IdentifierReference(r) => {
                let name = r.name.as_str();
                match self.binding(name) {
                    Some(true) => Some(match self.primitives.get(name) {
                        Some(Compiled::Host(core)) => Tag::Host(core),
                        Some(Compiled::List) => Tag::Component(self.use_helper("list")),
                        Some(Compiled::Component(_)) | None => Tag::Component(name.to_owned()),
                    }),
                    Some(false) => Some(Tag::Component(name.to_owned())),
                    None => match name {
                        "If" => Some(Tag::If),
                        "Each" => Some(Tag::Each),
                        _ => {
                            let hint = match self.module_of(name) {
                                Some(module) => {
                                    format!(": add `import {{ {name} }} from \"{module}\"`")
                                }
                                None => String::new(),
                            };
                            self.error(format!("<{name}> names nothing in scope{hint}"), r.span);
                            None
                        }
                    },
                }
            }
            JSXElementName::MemberExpression(m) => Some(Tag::Component(member(m))),
            JSXElementName::NamespacedName(n) => {
                self.error("namespaced tags are not supported", n.span);
                None
            }
            JSXElementName::ThisExpression(t) => {
                self.error("`this` is not a component", t.span);
                None
            }
        }
    }

    /// What a lowercase `tag` likely meant: the closest of the globals,
    /// the bindings in scope, nsh's primitives and the UI sets' components.
    fn hint(&self, tag: &str) -> String {
        let wanted = pascal(tag);
        let mut names: Vec<&str> = GLOBALS.to_vec();
        let mut scope = self.scopes.last().copied();
        while let Some(id) = scope {
            names.extend(
                self.scoping
                    .get_bindings(id)
                    .keys()
                    .map(|n| n.as_str())
                    .filter(|n| n.starts_with(|c: char| c.is_ascii_uppercase())),
            );
            scope = self.scoping.scope_parent_id(id);
        }
        names.extend(PRIMITIVES.iter().map(|(_, export, _)| *export));
        names.extend(self.components.iter().map(|(export, _)| export.as_str()));
        let best = names
            .iter()
            .find(|n| n.eq_ignore_ascii_case(&wanted))
            .or_else(|| names.iter().find(|n| n.starts_with(wanted.as_str())))
            .or_else(|| {
                names
                    .iter()
                    .map(|n| (distance(n, &wanted), n))
                    .filter(|(d, n)| *d <= 2.max(n.len() / 4))
                    .min_by_key(|(d, _)| *d)
                    .map(|(_, n)| n)
            });
        match best {
            Some(name) => format!(": write <{name}>{}", self.import_hint(name)),
            None => ": write the component's name (`<View>`, imported from \"nsh\")".to_owned(),
        }
    }

    /// `` and `import { View } from "nsh"` `` for a name not in scope that
    /// nsh or a UI set exports; nothing for one in scope or a global.
    fn import_hint(&self, name: &str) -> String {
        if self.binding(name).is_some() {
            return String::new();
        }
        if GLOBALS.contains(&name) {
            return " (a global: no import)".to_owned();
        }
        match self.module_of(name) {
            Some(module) => format!(" and `import {{ {name} }} from \"{module}\"`"),
            None => String::new(),
        }
    }

    /// The module that exports primitive or UI set component `name`.
    fn module_of(&self, name: &str) -> Option<&str> {
        PRIMITIVES
            .iter()
            .find(|(_, export, _)| *export == name)
            .map(|(module, ..)| *module)
            .or_else(|| {
                self.components
                    .iter()
                    .find(|(export, _)| export == name)
                    .map(|(_, module)| module.as_str())
            })
    }

    /// Parses generated code and moves the holes in.
    fn parse(&mut self, text: &str, holes: Vec<Expression<'a>>, span: Span) -> Expression<'a> {
        let text = self.allocator.alloc_str(text);
        match Parser::new(self.allocator, text, SourceType::mjs()).parse_expression() {
            Ok(mut e) => {
                let mut splice = Splice {
                    holes: holes.into_iter().map(Some).collect(),
                    span,
                };
                splice.visit_expression(&mut e);
                e
            }
            Err(errors) => {
                let detail = errors
                    .into_iter()
                    .next()
                    .map(|e| e.to_string())
                    .unwrap_or_default();
                self.error(
                    format!("nsh compiler: generated invalid code ({detail}): {text}"),
                    span,
                );
                Expression::new_null_literal(span, &AstBuilder::new(self.allocator))
            }
        }
    }

    /// An element as an expression.
    fn element(&mut self, el: JSXElement<'a>, g: &mut Gen<'a>) -> String {
        match self.tag(&el.opening_element.name) {
            Some(Tag::Host(core)) => {
                let mut body = String::new();
                let v = self.host(el, core, g, &mut body);
                format!("(() => {{ {body}return {v}; }})()")
            }
            Some(Tag::Component(callee)) => self.component(el, &callee, g),
            Some(Tag::If) => self.if_(el, g),
            Some(Tag::Each) => self.each(el, g),
            None => "undefined".to_owned(),
        }
    }

    /// A fragment: the array of its children.
    fn fragment(&mut self, f: JSXFragment<'a>, g: &mut Gen<'a>) -> String {
        let values = self.children(f.children, g, Mode::Value);
        format!("[{}]", values.join(", "))
    }

    /// An attribute's or child's expression, its own JSX compiled first.
    fn expression(&mut self, e: JSXExpression<'a>) -> Option<Expression<'a>> {
        if matches!(e, JSXExpression::EmptyExpression(_)) {
            return None;
        }
        let mut e = e.into_expression();
        self.visit_expression(&mut e);
        Some(e)
    }

    /// A host element: its statements go to `body`; returns its variable.
    fn host(
        &mut self,
        el: JSXElement<'a>,
        core: &str,
        g: &mut Gen<'a>,
        body: &mut String,
    ) -> String {
        let v = self.var();
        let element = self.use_helper("element");
        body.push_str(&format!("const {v} = {element}({});", quote(core)));
        let has_children = el.children.iter().any(|c| match c {
            JSXChild::Text(t) => clean_text(&t.value).is_some(),
            JSXChild::ExpressionContainer(c) => {
                !matches!(c.expression, JSXExpression::EmptyExpression(_))
            }
            _ => true,
        });
        let opening = el.opening_element.unbox();
        for attr in opening.attributes {
            match attr {
                JSXAttributeItem::Attribute(a) => {
                    let a = a.unbox();
                    let Some(name) = self.attr_name(&a.name) else {
                        continue;
                    };
                    if name == "children" && has_children {
                        continue;
                    }
                    match a.value {
                        None => body.push_str(&self.prop(&v, &name, "true")),
                        Some(JSXAttributeValue::StringLiteral(s)) => {
                            body.push_str(&self.prop(&v, &name, &quote(&s.value)));
                        }
                        Some(JSXAttributeValue::ExpressionContainer(c)) => {
                            if let Some(e) = self.expression(c.unbox().expression) {
                                self.host_attr(&v, &name, e, g, body);
                            }
                        }
                        Some(JSXAttributeValue::Element(child)) => {
                            let value = self.element(child.unbox(), g);
                            body.push_str(&self.prop(&v, &name, &value));
                        }
                        Some(JSXAttributeValue::Fragment(f)) => {
                            let value = self.fragment(f.unbox(), g);
                            body.push_str(&self.prop(&v, &name, &value));
                        }
                    }
                }
                JSXAttributeItem::SpreadAttribute(s) => {
                    let mut e = s.unbox().argument;
                    self.visit_expression(&mut e);
                    let spread = self.use_helper("spread");
                    body.push_str(&format!("{spread}({v}, {});", g.hole(e)));
                }
            }
        }
        if core != "text" {
            self.check_unshown_text(core, &el.children);
        }
        self.host_children(&v, el.children, g, body);
        v
    }

    /// Text written in a host element other than `<Text>` (`<View>Hi</View>`,
    /// `<View>{"Hi"}</View>`) is never shown: an error saying where it goes.
    fn check_unshown_text(&mut self, core: &str, children: &[JSXChild<'a>]) {
        let element = PRIMITIVES
            .iter()
            .find(|(.., c)| matches!(c, Compiled::Host(t) if *t == core))
            .map_or(core, |(_, name, _)| name);
        for child in children {
            let (text, span) = match child {
                JSXChild::Text(t) => match clean_text(&t.value) {
                    Some(text) => (text, trimmed_span(t.span, &t.value)),
                    None => continue,
                },
                JSXChild::ExpressionContainer(c) => match &c.expression {
                    JSXExpression::StringLiteral(s) => (s.value.to_string(), s.span),
                    JSXExpression::NumericLiteral(n) => (n.raw_str().to_string(), n.span),
                    JSXExpression::TemplateLiteral(t) if t.expressions.is_empty() => (
                        t.quasis
                            .iter()
                            .filter_map(|q| q.value.cooked.as_deref())
                            .collect(),
                        t.span,
                    ),
                    _ => continue,
                },
                _ => continue,
            };
            let text = text.trim();
            let shown: String = text.chars().take(24).collect();
            let more = if shown.len() < text.len() { "…" } else { "" };
            self.error(
                format!(
                    "text in <{element}> is not shown: text shows in a <Text> (`<Text>{shown}{more}</Text>`)"
                ),
                span,
            );
        }
    }

    fn attr_name(&mut self, name: &JSXAttributeName<'a>) -> Option<String> {
        match name {
            JSXAttributeName::Identifier(id) => Some(id.name.to_string()),
            JSXAttributeName::NamespacedName(n) => {
                self.error("namespaced props are not supported", n.span);
                None
            }
        }
    }

    fn prop(&mut self, v: &str, name: &str, value: &str) -> String {
        let prop = self.use_helper("prop");
        format!("{prop}({v}, {}, {value});", quote(name))
    }

    /// The statement giving `node` (a generated name) to `ref={e}`: a
    /// signal is set to it and a function called with it (`nsh:rt`'s
    /// `ref`), else a variable or a field is assigned it. A binding that
    /// cannot be assigned (a `const`, an import) must hold a signal or a
    /// function, which `ref` checks with its name. Other expressions come
    /// back, to be a prop (a function or a signal there works as well).
    fn ref_target(
        &mut self,
        e: Expression<'a>,
        node: &str,
        g: &mut Gen<'a>,
    ) -> Result<String, Expression<'a>> {
        match without_wrappers(e) {
            Expression::Identifier(id) => {
                let ref_ = self.use_helper("ref");
                let name = id.name.to_string();
                Ok(if self.assignable(&name) {
                    format!("{ref_}({name}, {node}) || ({name} = {node});")
                } else {
                    format!("{ref_}({name}, {node}, {});", quote(&name))
                })
            }
            Expression::StaticMemberExpression(m) => {
                let m = m.unbox();
                let key = quote(&m.property.name);
                let object = g.hole(m.object);
                Ok(self.ref_field(&object, &key, node))
            }
            Expression::ComputedMemberExpression(m) => {
                let m = m.unbox();
                let object = g.hole(m.object);
                let key = g.hole(m.expression);
                Ok(self.ref_field(&object, &key, node))
            }
            e => Err(e),
        }
    }

    /// `ref={object[key]}`: each evaluated once.
    fn ref_field(&mut self, object: &str, key: &str, node: &str) -> String {
        let ref_ = self.use_helper("ref");
        format!(
            "(({HOLE}o, {HOLE}k) => {ref_}({HOLE}o[{HOLE}k], {node}) || ({HOLE}o[{HOLE}k] = {node}))({object}, {key});"
        )
    }

    fn host_attr(
        &mut self,
        v: &str,
        name: &str,
        e: Expression<'a>,
        g: &mut Gen<'a>,
        body: &mut String,
    ) {
        if name == "ref" {
            match self.ref_target(e, v, g) {
                Ok(statement) => body.push_str(&statement),
                Err(e) => {
                    let hole = g.hole(e);
                    body.push_str(&self.prop(v, name, &hole));
                }
            }
            return;
        }
        let dynamic = if is_event(name) {
            !is_function(&e) && !matches!(e.without_parentheses(), Expression::Identifier(_))
        } else {
            is_dynamic(&e)
        };
        let hole = g.hole(e);
        if dynamic {
            let bind = self.use_helper("bindProp");
            body.push_str(&format!("{bind}({v}, {}, () => {hole});", quote(name)));
        } else {
            body.push_str(&self.prop(v, name, &hole));
        }
    }

    /// A host element's children: static ones made and appended in order,
    /// runs of dynamic ones inserted before the next static one.
    fn host_children(
        &mut self,
        v: &str,
        children: oxc::allocator::Vec<'a, JSXChild<'a>>,
        g: &mut Gen<'a>,
        body: &mut String,
    ) {
        enum Item {
            Static(String),
            Dynamic(String),
        }
        let mut items = Vec::new();
        for child in children {
            match child {
                JSXChild::Text(t) => {
                    if let Some(text) = clean_text(&t.value) {
                        let tv = self.var();
                        let make = self.use_helper("text");
                        body.push_str(&format!("const {tv} = {make}({});", quote(&text)));
                        items.push(Item::Static(tv));
                    }
                }
                JSXChild::Element(el) => {
                    let el = el.unbox();
                    match self.tag(&el.opening_element.name) {
                        Some(Tag::Host(core)) => {
                            let cv = self.host(el, core, g, body);
                            items.push(Item::Static(cv));
                        }
                        Some(Tag::Component(callee)) => {
                            items.push(Item::Dynamic(self.component(el, &callee, g)));
                        }
                        Some(Tag::If) => items.push(Item::Dynamic(self.if_(el, g))),
                        Some(Tag::Each) => items.push(Item::Dynamic(self.each(el, g))),
                        None => {}
                    }
                }
                JSXChild::Fragment(f) => {
                    items.push(Item::Dynamic(self.fragment(f.unbox(), g)));
                }
                JSXChild::ExpressionContainer(c) => {
                    if let Some(e) = self.expression(c.unbox().expression) {
                        items.push(Item::Dynamic(self.value(e, g, Mode::Value)));
                    }
                }
                JSXChild::Spread(s) => {
                    self.error("spread children are not supported", s.span);
                }
            }
        }
        let append = items
            .iter()
            .any(|i| matches!(i, Item::Static(_)))
            .then(|| self.use_helper("append"));
        for item in &items {
            if let (Item::Static(cv), Some(append)) = (item, &append) {
                body.push_str(&format!("{append}({v}, {cv});"));
            }
        }
        let mut run: Vec<&str> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            match item {
                Item::Dynamic(value) => {
                    run.push(value);
                    let next_static = items[i + 1..].iter().find_map(|n| match n {
                        Item::Static(cv) => Some(cv.as_str()),
                        Item::Dynamic(_) => None,
                    });
                    let run_ends = !matches!(items.get(i + 1), Some(Item::Dynamic(_)));
                    if run_ends {
                        let value = match run.as_slice() {
                            [one] => (*one).to_owned(),
                            many => format!("[{}]", many.join(", ")),
                        };
                        let insert = self.use_helper("insert");
                        match next_static {
                            Some(marker) => {
                                body.push_str(&format!("{insert}({v}, {value}, {marker});"))
                            }
                            None => body.push_str(&format!("{insert}({v}, {value});")),
                        }
                        run.clear();
                    }
                }
                Item::Static(_) => {}
            }
        }
    }

    /// An expression as a child value: a function when it changes and the
    /// value is kept (`Mode::Value`).
    fn value(&mut self, e: Expression<'a>, g: &mut Gen<'a>, mode: Mode) -> String {
        let dynamic = mode == Mode::Value && is_dynamic(&e) && !is_function(&e);
        let hole = g.hole(e);
        if dynamic {
            format!("() => {hole}")
        } else {
            hole
        }
    }

    /// Children as values (text, elements, expressions), in order.
    fn children(
        &mut self,
        children: oxc::allocator::Vec<'a, JSXChild<'a>>,
        g: &mut Gen<'a>,
        mode: Mode,
    ) -> Vec<String> {
        let mut values = Vec::new();
        for child in children {
            match child {
                JSXChild::Text(t) => {
                    if let Some(text) = clean_text(&t.value) {
                        values.push(quote(&text));
                    }
                }
                JSXChild::Element(el) => values.push(self.element(el.unbox(), g)),
                JSXChild::Fragment(f) => values.push(self.fragment(f.unbox(), g)),
                JSXChild::ExpressionContainer(c) => {
                    if let Some(e) = self.expression(c.unbox().expression) {
                        values.push(self.value(e, g, mode));
                    }
                }
                JSXChild::Spread(s) => self.error("spread children are not supported", s.span),
            }
        }
        values
    }

    /// A component call with its props object.
    fn component(&mut self, el: JSXElement<'a>, callee: &str, g: &mut Gen<'a>) -> String {
        let mut parts: Vec<String> = Vec::new();
        let mut props: Vec<String> = Vec::new();
        let opening = el.opening_element.unbox();
        for attr in opening.attributes {
            match attr {
                JSXAttributeItem::Attribute(a) => {
                    let a = a.unbox();
                    let Some(name) = self.attr_name(&a.name) else {
                        continue;
                    };
                    let k = key(&name);
                    match a.value {
                        None => props.push(format!("{k}: true")),
                        Some(JSXAttributeValue::StringLiteral(s)) => {
                            props.push(format!("{k}: {}", quote(&s.value)));
                        }
                        Some(JSXAttributeValue::ExpressionContainer(c)) => {
                            if let Some(mut e) = self.expression(c.unbox().expression) {
                                // The ref takes what the component gives.
                                if name == "ref" {
                                    match self.ref_target(e, &format!("{HOLE}r"), g) {
                                        Ok(statement) => {
                                            props.push(format!("ref({HOLE}r) {{ {statement} }}"));
                                            continue;
                                        }
                                        Err(other) => e = other,
                                    }
                                }
                                let dynamic = is_dynamic(&e);
                                let hole = g.hole(e);
                                props.push(if dynamic {
                                    format!("get {k}() {{ return {hole}; }}")
                                } else {
                                    format!("{k}: {hole}")
                                });
                            }
                        }
                        Some(JSXAttributeValue::Element(child)) => {
                            let value = self.element(child.unbox(), g);
                            props.push(format!("get {k}() {{ return {value}; }}"));
                        }
                        Some(JSXAttributeValue::Fragment(f)) => {
                            let value = self.fragment(f.unbox(), g);
                            props.push(format!("get {k}() {{ return {value}; }}"));
                        }
                    }
                }
                JSXAttributeItem::SpreadAttribute(s) => {
                    let mut e = s.unbox().argument;
                    self.visit_expression(&mut e);
                    if !props.is_empty() {
                        parts.push(format!("{{ {} }}", props.join(", ")));
                        props.clear();
                    }
                    parts.push(g.hole(e));
                }
            }
        }
        // A lone child is read through the getter alone; among siblings an
        // expression that changes is a function of its own, which the insert
        // of the children runs alone (`nsh:rt`'s `insert`): reading it in
        // the getter would make the getter, and every sibling it makes,
        // run again.
        let mode = if child_count(&el.children) > 1 {
            Mode::Value
        } else {
            Mode::Getter
        };
        let values = self.children(el.children, g, mode);
        if !values.is_empty() {
            let value = match values.as_slice() {
                [one] => one.clone(),
                many => format!("[{}]", many.join(", ")),
            };
            props.push(format!("get children() {{ return {value}; }}"));
        }
        if !props.is_empty() || parts.is_empty() {
            parts.push(format!("{{ {} }}", props.join(", ")));
        }
        let props = if parts.len() == 1 {
            parts.pop().expect("one")
        } else {
            let merge = self.use_helper("merge");
            format!("{merge}({})", parts.join(", "))
        };
        let component = self.use_helper("component");
        format!("{component}({callee}, {props})")
    }

    /// The attributes of a control flow element, by name (each once).
    fn flow_attrs(
        &mut self,
        el_name: &str,
        attrs: oxc::allocator::Vec<'a, JSXAttributeItem<'a>>,
        allowed: &[&str],
        g: &mut Gen<'a>,
    ) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for attr in attrs {
            match attr {
                JSXAttributeItem::Attribute(a) => {
                    let a = a.unbox();
                    let Some(name) = self.attr_name(&a.name) else {
                        continue;
                    };
                    if !allowed.contains(&name.as_str()) {
                        self.error(
                            format!(
                                "<{el_name}> takes {}, not `{name}`",
                                allowed
                                    .iter()
                                    .map(|a| format!("`{a}`"))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            ),
                            a.span,
                        );
                        continue;
                    }
                    let value = match a.value {
                        None => "true".to_owned(),
                        Some(JSXAttributeValue::StringLiteral(s)) => quote(&s.value),
                        Some(JSXAttributeValue::ExpressionContainer(c)) => {
                            match self.expression(c.unbox().expression) {
                                Some(e) => g.hole(e),
                                None => continue,
                            }
                        }
                        Some(JSXAttributeValue::Element(child)) => self.element(child.unbox(), g),
                        Some(JSXAttributeValue::Fragment(f)) => self.fragment(f.unbox(), g),
                    };
                    out.push((name, value));
                }
                JSXAttributeItem::SpreadAttribute(s) => {
                    self.error(format!("<{el_name}> takes no spread props"), s.span);
                }
            }
        }
        out
    }

    /// `<If when={c} else={…}>…</If>`.
    fn if_(&mut self, el: JSXElement<'a>, g: &mut Gen<'a>) -> String {
        let span = el.span;
        let opening = el.opening_element.unbox();
        let attrs = self.flow_attrs("If", opening.attributes, &["when", "else"], g);
        let get = |name: &str| {
            attrs
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
        };
        let Some(when) = get("when") else {
            self.error("<If> needs `when`", span);
            return "undefined".to_owned();
        };
        let cond = self.use_helper("cond");
        // `{(user) => …}`: the child is called with an accessor of `when`'s
        // value, truthy while the branch shows (Solid's `<Show>`); `when`
        // is read through it, once per read.
        if lone_function_child(&el.children) {
            let mut render = String::new();
            for child in el.children {
                if let JSXChild::ExpressionContainer(c) = child
                    && let Some(e) = self.expression(c.unbox().expression)
                {
                    render = g.hole(e);
                }
            }
            let then = format!("() => ({render})({HOLE}w)");
            let branches = match get("else") {
                Some(otherwise) => format!("{then}, () => {otherwise}"),
                None => then,
            };
            return format!("(({HOLE}w) => {cond}({HOLE}w, {branches}))(() => {when})");
        }
        let values = self.children(el.children, g, Mode::Value);
        let then = match values.as_slice() {
            [] => "undefined".to_owned(),
            [one] => one.clone(),
            many => format!("[{}]", many.join(", ")),
        };
        match get("else") {
            Some(otherwise) => {
                format!("{cond}(() => {when}, () => {then}, () => {otherwise})")
            }
            None => format!("{cond}(() => {when}, () => {then})"),
        }
    }

    /// `<Each of={items} key={(item) => item.id}>{(item, index) => …}</Each>`.
    fn each(&mut self, el: JSXElement<'a>, g: &mut Gen<'a>) -> String {
        let span = el.span;
        let opening = el.opening_element.unbox();
        let attrs = self.flow_attrs("Each", opening.attributes, &["of", "key"], g);
        let get = |name: &str| {
            attrs
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
        };
        let Some(of) = get("of") else {
            self.error("<Each> needs `of`", span);
            return "undefined".to_owned();
        };
        let mut render = None;
        for child in el.children {
            match child {
                JSXChild::Text(t) if clean_text(&t.value).is_none() => {}
                JSXChild::ExpressionContainer(c) if render.is_none() => {
                    if let Some(e) = self.expression(c.unbox().expression) {
                        render = Some(g.hole(e));
                    }
                }
                other => {
                    self.error(
                        "<Each> takes one child: a function rendering an item, `{(item, index) => …}`",
                        other.span(),
                    );
                    return "undefined".to_owned();
                }
            }
        }
        let Some(render) = render else {
            self.error(
                "<Each> takes one child: a function rendering an item, `{(item, index) => …}`",
                span,
            );
            return "undefined".to_owned();
        };
        let each = self.use_helper("each");
        match get("key") {
            Some(key) => format!("{each}(() => {of}, {render}, {key})"),
            None => format!("{each}(() => {of}, {render})"),
        }
    }
}

/// Whether `children` are one function written in place, whitespace aside
/// (`<If>`'s `{(value) => …}`).
fn lone_function_child(children: &[JSXChild<'_>]) -> bool {
    let mut meaningful = children
        .iter()
        .filter(|c| !matches!(c, JSXChild::Text(t) if clean_text(&t.value).is_none()));
    match (meaningful.next(), meaningful.next()) {
        (Some(JSXChild::ExpressionContainer(c)), None) => matches!(
            c.expression,
            JSXExpression::ArrowFunctionExpression(_) | JSXExpression::FunctionExpression(_)
        ),
        _ => false,
    }
}

fn member(m: &JSXMemberExpression<'_>) -> String {
    let object = match &m.object {
        JSXMemberExpressionObject::IdentifierReference(r) => r.name.to_string(),
        JSXMemberExpressionObject::MemberExpression(inner) => member(inner),
        JSXMemberExpressionObject::ThisExpression(_) => "this".to_owned(),
    };
    format!("{object}.{}", m.property.name)
}

/// Moves the holes into generated code and gives generated nodes `span`.
struct Splice<'a> {
    holes: Vec<Option<Expression<'a>>>,
    span: Span,
}

impl<'a> VisitMut<'a> for Splice<'a> {
    fn visit_expression(&mut self, e: &mut Expression<'a>) {
        if let Expression::Identifier(id) = e
            && let Some(i) = id
                .name
                .as_str()
                .strip_prefix(HOLE)
                .and_then(|n| n.parse::<usize>().ok())
            && let Some(hole) = self.holes.get_mut(i).and_then(Option::take)
        {
            *e = hole;
            return;
        }
        walk_mut::walk_expression(self, e);
    }

    fn visit_span(&mut self, span: &mut Span) {
        *span = self.span;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile(source: &str) -> Result<String, String> {
        crate::compile::compile_native(
            std::path::Path::new("App.tsx"),
            SourceType::tsx(),
            source,
            None,
            None,
            Some("App.tsx"),
            &crate::compile::NativeModules::new(&[nsh_base::registry().into()]),
        )
        .map(|c| c.code)
    }

    /// A compile error's message on one line (the report wraps it).
    fn error(source: &str) -> String {
        let err = compile(source).unwrap_err();
        err.lines()
            .map(|l| {
                l.trim_start()
                    .trim_start_matches("| ")
                    .trim_start_matches("x ")
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// The code with whitespace collapsed, for comparisons.
    fn flat(code: &str) -> String {
        code.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn import_meta_url_is_the_module_s_own() {
        let code =
            compile("const here = new URL(\".\", import.meta.url); const meta = import.meta;")
                .unwrap();
        assert!(
            code.starts_with(r#"import { metaUrl as _$metaUrl } from "nsh:rt";"#),
            "{code}"
        );
        assert!(
            code.contains(r#"new URL(".", _$metaUrl("App.tsx"))"#),
            "{code}"
        );
        assert!(code.contains("const meta = import.meta;"), "{code}");
    }

    #[test]
    fn host_elements_static_and_dynamic_props() {
        let code = flat(&compile(
            r#"import { View } from "nsh";
            const n = 1; let f = (x: number) => x;
            export const a = <View testID="a" accessible pointerEvents={n} accessibilityLabel={f(n)} onPress={f} onLongPress={n > 0 ? f : undefined} />;"#,
        )
        .unwrap());
        assert!(
            code.contains(r#"prop(__nsh_hv0, "testID", "a");"#),
            "{code}"
        );
        assert!(
            code.contains(r#"prop(__nsh_hv0, "accessible", true);"#),
            "{code}"
        );
        assert!(
            code.contains(r#"prop(__nsh_hv0, "pointerEvents", n);"#),
            "{code}"
        );
        assert!(
            code.contains(r#"bindProp(__nsh_hv0, "accessibilityLabel", () => f(n));"#),
            "{code}"
        );
        assert!(code.contains(r#"prop(__nsh_hv0, "onPress", f);"#), "{code}");
        assert!(
            code.contains(r#"bindProp(__nsh_hv0, "onLongPress", () => n > 0 ? f : undefined);"#),
            "{code}"
        );
        // The import of a primitive compiled in place goes.
        assert!(code.starts_with(r#"import { element as _$element, prop as _$prop, bindProp as _$bindProp } from "nsh:rt";"#), "{code}");
        assert!(!code.contains(r#"from "nsh";"#), "{code}");
    }

    /// Every primitive compiles in place by its import from `nsh`.
    #[test]
    fn primitives_from_nsh_compile_in_place() {
        let code = flat(
            &compile(
                r#"import { Canvas, Image, List, Text, Video, View, WebView } from "nsh";
            export const a = <View><Text>t</Text><Image src="x" /><WebView src="about:blank" /><Video src="v" /></View>;
            export const b = <List each={[1]}>{(i) => <Text>{i()}</Text>}</List>;
            export const c = <Canvas draw={() => {}} />;
            Image.prefetch("x");"#,
            )
            .unwrap(),
        );
        for tag in ["view", "text", "image", "webview", "video"] {
            assert!(code.contains(&format!(r#"_$element("{tag}")"#)), "{code}");
        }
        assert!(code.contains("_$component(_$list, {"), "{code}");
        assert!(code.contains("_$component(Canvas, {"), "{code}");
        // What is used as a value or called stays imported.
        assert!(
            code.contains(r#"import { Canvas, Image } from "nsh";"#),
            "{code}"
        );
    }

    #[test]
    fn bindings_in_scope_win_over_primitives_and_globals() {
        let code = flat(
            &compile(
                r#"import { View, Text } from "nsh";
            export function Outer() {
                const Text = (p: { children?: unknown }) => p.children;
                const If = (p: { when: boolean }) => p.when;
                return <View><Text>mine</Text><If when /></View>;
            }
            export const primitive = <Text>core</Text>;
            export const C = Math.random() > 0.5 ? View : Text;
            export const d = <C />;"#,
            )
            .unwrap(),
        );
        assert!(
            code.contains(r#"_$component(Text, { get children() { return "mine"; } })"#),
            "{code}"
        );
        assert!(code.contains("_$component(If, { when: true })"), "{code}");
        assert!(code.contains(r#"_$element("text")"#), "{code}");
        // A primitive used as a value is a component.
        assert!(code.contains("_$component(C, {})"), "{code}");
        assert!(
            code.contains(r#"import { View, Text } from "nsh";"#),
            "{code}"
        );
    }

    #[test]
    fn lowercase_tags_say_what_to_write() {
        let err = error("export const a = <view />;");
        assert!(err.contains("lowercase tag <view>"), "{err}");
        assert!(
            err.contains(r#"write <View> and `import { View } from "nsh"`"#),
            "{err}"
        );
        let err = error("export const a = <web-view />;");
        assert!(
            err.contains(r#"write <WebView> and `import { WebView } from "nsh"`"#),
            "{err}"
        );
        let err = error("export const a = <input-accessory />;");
        assert!(err.contains("write <InputAccessoryView>"), "{err}");
        let err = error("export const a = <each of={[]}>{() => null}</each>;");
        assert!(err.contains("write <Each> (a global: no import)"), "{err}");
        let err = error("export const a = <text-view />;");
        assert!(
            err.contains(r#"write <TextView> and `import { TextView } from "nsh/base"`"#),
            "{err}"
        );
        let err = error(
            r#"function WeatherPanel() { return null; }
            export const a = <weather-panel />;"#,
        );
        assert!(err.contains("write <WeatherPanel>"), "{err}");
        assert!(!err.contains("import"), "{err}");
        let err = error("export const a = <scrol />;");
        assert!(err.contains("write <Scroll>"), "{err}");
    }

    #[test]
    fn unknown_tags_say_what_to_import() {
        let err = error("export const a = <Text>x</Text>;");
        assert!(err.contains("<Text> names nothing in scope"), "{err}");
        assert!(
            err.contains(r#"<Text> names nothing in scope: add `import { Text } from "nsh"`"#),
            "{err}"
        );
        let err = error("export const a = <Frobnicate />;");
        assert!(err.contains("<Frobnicate> names nothing in scope"), "{err}");
    }

    #[test]
    fn every_host_element_has_one_home() {
        for tag in [
            "view",
            "text",
            "image",
            "scroll",
            "input",
            "canvas",
            "webview",
            "video",
            "modal",
            "inputaccessory",
        ] {
            assert!(nsh_core::Tag::from_name(tag).is_some(), "{tag}");
            let names: std::collections::HashSet<&str> = PRIMITIVES
                .iter()
                .filter(
                    |(.., c)| matches!(c, Compiled::Host(t) | Compiled::Component(t) if *t == tag),
                )
                .map(|(_, export, _)| *export)
                .collect();
            assert_eq!(names.len(), 1, "<{tag}>");
        }
        let mut seen = std::collections::HashSet::new();
        for (module, export, compiled) in PRIMITIVES {
            assert!(seen.insert((*module, *export)), "{module} {export} twice");
            // A name is one primitive in every module that exports it.
            assert!(
                PRIMITIVES
                    .iter()
                    .filter(|(_, e, _)| e == export)
                    .all(|(.., c)| c == compiled),
                "{export}"
            );
            assert!(
                nsh_core::js::NATIVE_MODULES.contains(module) || *module == "nsh/base",
                "{module}"
            );
        }
    }

    #[test]
    fn component_props_children_and_spreads() {
        let code = flat(&compile(
            r#"import { Text } from "nsh";
            declare const Card: any, s: () => number, rest: object;
            export const a = <Card title={s()} n={1} {...rest} footer={<Text>f</Text>}>one {s()}</Card>;"#,
        )
        .unwrap());
        assert!(
            code.contains("_$merge({ get title() { return s(); }, n: 1 }, rest, {"),
            "{code}"
        );
        assert!(code.contains("get footer() { return (() => {"), "{code}");
        // Among siblings, what changes is a function of its own; a lone
        // child is the getter's.
        assert!(
            code.contains(r#"get children() { return ["one ", () => s()]; }"#),
            "{code}"
        );
        let code = flat(
            &compile(
                r#"declare const Card: any, s: () => number;
            export const a = <Card>{s()}</Card>;"#,
            )
            .unwrap(),
        );
        assert!(code.contains("get children() { return s(); }"), "{code}");
    }

    #[test]
    fn refs_assign_variables_or_call_functions() {
        let code = flat(&compile(
            r#"import { View } from "nsh";
            let el: unknown; export const a = <View ref={el} />; export const b = <View ref={(n) => (el = n)} />;"#,
        )
        .unwrap());
        // A signal or a function takes the node (`ref`), else it is assigned.
        assert!(
            code.contains("_$ref(el, __nsh_hv0) || (el = __nsh_hv0);"),
            "{code}"
        );
        assert!(
            code.contains(r#"_$prop(__nsh_hv1, "ref", (n) => el = n);"#),
            "{code}"
        );
    }

    #[test]
    fn refs_of_consts_fields_and_assertions() {
        let code = flat(
            &compile(
                r#"import { View, signal } from "nsh";
            import { shared } from "./refs";
            const s = signal<unknown>(); const refs: { a?: unknown, [k: string]: unknown } = {};
            declare const k: () => string; let el: unknown;
            export const a = <View ref={s} />;
            export const b = <View ref={shared} />;
            export const c = <View ref={refs.a} />;
            export const d = <View ref={refs[k()]} />;
            export const e = <View ref={el!} />;"#,
            )
            .unwrap(),
        );
        // A const or an import cannot be assigned: `ref` checks it is a
        // signal or a function, by name.
        assert!(code.contains(r#"_$ref(s, __nsh_hv0, "s");"#), "{code}");
        assert!(
            code.contains(r#"_$ref(shared, __nsh_hv1, "shared");"#),
            "{code}"
        );
        // A field is assigned, its object and key evaluated once.
        assert!(
            code.contains(
                r#"((__nsh_ho, __nsh_hk) => _$ref(__nsh_ho[__nsh_hk], __nsh_hv2) || (__nsh_ho[__nsh_hk] = __nsh_hv2))(refs, "a");"#
            ),
            "{code}"
        );
        assert!(
            code.contains("|| (__nsh_ho[__nsh_hk] = __nsh_hv3))(refs, k());"),
            "{code}"
        );
        assert!(
            code.contains("_$ref(el, __nsh_hv4) || (el = __nsh_hv4);"),
            "{code}"
        );
    }

    #[test]
    fn text_outside_text_is_an_error() {
        for (source, message) in [
            (
                "<View>Hello world <Text>shown</Text></View>",
                "text in <View> is not shown: text shows in a <Text> (`<Text>Hello world</Text>`)",
            ),
            (
                r#"<Scroll>{"a string"}</Scroll>"#,
                "text in <Scroll> is not shown: text shows in a <Text> (`<Text>a string</Text>`)",
            ),
            (
                "<View>{42}</View>",
                "text in <View> is not shown: text shows in a <Text> (`<Text>42</Text>`)",
            ),
            (
                "<View>a sentence far longer than what the message shows</View>",
                "(`<Text>a sentence far longer th…</Text>`)",
            ),
        ] {
            let err = compile(&format!(
                r#"import {{ Scroll, Text, View }} from "nsh"; export const a = {source};"#
            ))
            .unwrap_err();
            // The report wraps long messages: compared without whitespace.
            let bare = |s: &str| {
                s.replace("\n  | ", " ")
                    .split_whitespace()
                    .collect::<String>()
            };
            assert!(bare(&err).contains(&bare(message)), "{source}: {err}");
        }
        // Text in a <Text>, whitespace, expressions and components' children stay.
        compile(
            r#"import { Text, View } from "nsh"; declare const Card: any, name: string;
            export const a = <View>
              <Text>Hi {name}</Text>
              {name}
              <Card>words</Card>
            </View>;"#,
        )
        .unwrap();
    }

    #[test]
    fn an_if_with_a_function_child_hands_it_an_accessor_of_when() {
        let code = flat(
            &compile(
                r#"import { Text } from "nsh";
            declare const user: () => { name: string } | null;
            export const a = <If when={user()} else={<Text>out</Text>}>
              {(u) => <Text>{u().name}</Text>}
            </If>;"#,
            )
            .unwrap(),
        );
        assert!(
            code.contains("((__nsh_hw) => _$cond(__nsh_hw, () => ((u) => (() => {"),
            "{code}"
        );
        // Called with the accessor; `else` as it was; `when` read through it.
        assert!(code.contains("})())(__nsh_hw), () => (() => {"), "{code}");
        assert!(code.contains("))(() => user());"), "{code}");
    }

    #[test]
    fn control_flow() {
        let code = flat(
            &compile(
                r#"import { View, Text } from "nsh";
            declare const on: () => boolean, items: () => { id: string }[];
            export const a = <View>
                <If when={on()} else={<Text>off</Text>}>on</If>
                <Each of={items()} key={(i) => i.id}>{(item) => <Text>{item().id}</Text>}</Each>
            </View>;"#,
            )
            .unwrap(),
        );
        assert!(
            code.contains("_$cond(() => on(), () => \"on\", () => (() => {"),
            "{code}"
        );
        assert!(
            code.contains("_$each(() => items(), (item) => (() => {"),
            "{code}"
        );
        assert!(code.contains("(i) => i.id)"), "{code}");
        let err = compile(
            r#"import { Text } from "nsh"; export const a = <Each of={[]}><Text /></Each>;"#,
        )
        .unwrap_err();
        assert!(err.contains("<Each> takes one child"), "{err}");
        let err = compile("export const a = <If>x</If>;").unwrap_err();
        assert!(err.contains("<If> needs `when`"), "{err}");
    }

    #[test]
    fn imports_tags_use_stay_and_type_only_ones_go() {
        let code = flat(
            &compile(
                r#"import { Button, Edges } from "nsh/base";
            let r: Edges | undefined;
            export const a = <Button ref={r} />;"#,
            )
            .unwrap(),
        );
        assert!(
            code.contains(r#"import { Button } from "nsh/base";"#),
            "{code}"
        );
        assert!(
            code.contains("ref(__nsh_hr) { _$ref(r, __nsh_hr) || (r = __nsh_hr); }"),
            "{code}"
        );
    }

    #[test]
    fn names_of_lowercase_tags() {
        assert_eq!(pascal("weather-panel"), "WeatherPanel");
        assert_eq!(pascal("web-view"), "WebView");
        assert_eq!(pascal("view"), "View");
        assert_eq!(distance("Scrol", "Scroll"), 1);
        assert_eq!(distance("view", "View"), 0);
    }

    #[test]
    fn jsx_text_like_react() {
        assert_eq!(clean_text("  hello  ").as_deref(), Some("  hello  "));
        assert_eq!(
            clean_text("\n   hello\n   world  \n  ").as_deref(),
            Some("hello world")
        );
        assert_eq!(clean_text("\n   \n  "), None);
        assert_eq!(clean_text(" ").as_deref(), Some(" "));
        assert_eq!(clean_text(" \n ").as_deref(), None);
        assert_eq!(
            clean_text("a &amp; b &#65;&#x42;").as_deref(),
            Some("a & b AB")
        );
    }
}
