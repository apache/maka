//! Hot module replacement: the development bundle format and the
//! component transform.
//!
//! Development bundles keep one CommonJS chunk per module (rolldown
//! `preserveModules`), each wrapped in a factory registered with the hot
//! runtime (`nsh-js` `hot.rs`). An update redefines only the modules whose
//! code changed; the runtime runs them again in the live JS context.
//!
//! The transform makes top-level components (functions with a capitalized
//! name whose body contains JSX) hot: each is registered with
//! `__nsh_hot.component(module, name, fn, signature)`, which returns a stable
//! proxy. The signature changes when the component's own code, or the
//! module's code outside components, changes. Top-level `context()`
//! calls go through `__nsh_hot.context` so contexts keep their identity;
//! top-level `const`s made by `signal()` / `createNavStack()` go through
//! `__nsh_hot.keep`, so a module that runs again keeps their state (and a
//! navigator its screens) while their initializer's code is the same. A
//! function passed to a top-level `mount()` is a component too (named
//! `mount#<n>`), so the hot runtime can keep the mounted tree.

use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
};

use oxc::{
    allocator::{Allocator, ArenaVec},
    ast::{
        ast::{
            Argument, AssignmentOperator, AssignmentTarget, BindingPattern, Declaration,
            ExportDefaultDeclarationKind, Expression, IdentifierName, Program, Statement,
            VariableDeclaration, VariableDeclarationKind,
        },
        builder::AstBuilder,
    },
    ast_visit::Visit,
    span::{GetSpan, SPAN, Span},
};

/// Name of the hot runtime global.
const HOT: &str = "__nsh_hot";

/// Calls whose top-level `const` results keep their state across runs of
/// their module (`__nsh_hot.keep`).
const KEPT: &[&str] = &["signal", "createNavStack"];

/// Whether a node contains JSX.
#[derive(Default)]
struct HasJsx(bool);

impl<'a> Visit<'a> for HasJsx {
    fn visit_jsx_element(&mut self, _: &oxc::ast::ast::JSXElement<'a>) {
        self.0 = true;
    }

    fn visit_jsx_fragment(&mut self, _: &oxc::ast::ast::JSXFragment<'a>) {
        self.0 = true;
    }
}

pub(crate) fn is_component_name(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_uppercase())
}

pub(crate) fn function_has_jsx(f: &oxc::ast::ast::Function<'_>) -> bool {
    let mut v = HasJsx::default();
    v.visit_function(f, oxc::syntax::scope::ScopeFlags::empty());
    v.0
}

pub(crate) fn expression_has_jsx(e: &Expression<'_>) -> bool {
    let mut v = HasJsx::default();
    v.visit_expression(e);
    v.0
}

fn hash(parts: &[&str]) -> String {
    let mut h = DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}

/// What to wrap, found in a first pass over the top-level statements.
enum Target {
    /// `function Name() {}` (possibly exported) at statement `index`: assign
    /// the proxy after it.
    Function {
        index: usize,
        name: String,
        span: Span,
    },
    /// `const Name = () => …` / `function () {…}` at statement `index`,
    /// declarator `declarator`.
    Arrow {
        index: usize,
        declarator: usize,
        name: String,
        span: Span,
    },
    /// `const Name = context(…)`.
    Context {
        index: usize,
        declarator: usize,
        name: String,
    },
    /// `const name = signal(…)` (a [`KEPT`] call).
    Keep {
        index: usize,
        declarator: usize,
        name: String,
        span: Span,
    },
    /// `mount(() => …)`: the function, argument 0 of the call at
    /// statement `index`, the `n`th such call of the module.
    Mount { index: usize, n: usize, span: Span },
}

fn callee<'a>(e: &'a Expression<'_>) -> Option<&'a str> {
    match e {
        Expression::CallExpression(call) => match &call.callee {
            Expression::Identifier(c) => Some(c.name.as_str()),
            _ => None,
        },
        _ => None,
    }
}

fn variable_targets(index: usize, v: &VariableDeclaration<'_>, out: &mut Vec<Target>) {
    for (d, decl) in v.declarations.iter().enumerate() {
        let BindingPattern::BindingIdentifier(id) = &decl.id else {
            continue;
        };
        let name = id.name.as_str();
        let Some(init) = &decl.init else { continue };
        match init {
            Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
                if is_component_name(name) && expression_has_jsx(init) =>
            {
                out.push(Target::Arrow {
                    index,
                    declarator: d,
                    name: name.to_owned(),
                    span: decl.span,
                });
            }
            _ if callee(init) == Some("context") => {
                out.push(Target::Context {
                    index,
                    declarator: d,
                    name: name.to_owned(),
                });
            }
            _ if v.kind == VariableDeclarationKind::Const
                && callee(init).is_some_and(|c| KEPT.contains(&c)) =>
            {
                out.push(Target::Keep {
                    index,
                    declarator: d,
                    name: name.to_owned(),
                    span: init.span(),
                });
            }
            _ => {}
        }
    }
}

fn function_target(index: usize, f: &oxc::ast::ast::Function<'_>, out: &mut Vec<Target>) {
    if let Some(id) = &f.id
        && is_component_name(&id.name)
        && function_has_jsx(f)
    {
        out.push(Target::Function {
            index,
            name: id.name.to_string(),
            span: f.span,
        });
    }
}

/// `mount(() => …)` / `mount(function () {…})` at statement `index`.
fn mount_target(index: usize, statement: &Statement<'_>, n: &mut usize, out: &mut Vec<Target>) {
    let Statement::ExpressionStatement(e) = statement else {
        return;
    };
    let Expression::CallExpression(call) = &e.expression else {
        return;
    };
    if !matches!(&call.callee, Expression::Identifier(c) if c.name == "mount") {
        return;
    }
    let Some(arg) = call.arguments.first().and_then(Argument::as_expression) else {
        return;
    };
    if matches!(
        arg,
        Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_)
    ) && expression_has_jsx(arg)
    {
        out.push(Target::Mount {
            index,
            n: *n,
            span: arg.span(),
        });
        *n += 1;
    }
}

/// Makes the components and contexts of `program` hot. `key` identifies the
/// module across builds (its path relative to the app root); `source` is
/// the text the program was parsed from.
pub(crate) fn transform<'a>(
    allocator: &'a Allocator,
    program: &mut Program<'a>,
    source: &str,
    key: &str,
) {
    let mut targets = Vec::new();
    let mut mounts = 0;
    for (index, statement) in program.body.iter().enumerate() {
        match statement {
            Statement::ExpressionStatement(_) => {
                mount_target(index, statement, &mut mounts, &mut targets);
            }
            Statement::FunctionDeclaration(f) => function_target(index, f, &mut targets),
            Statement::VariableDeclaration(v) => variable_targets(index, v, &mut targets),
            Statement::ExportDeclaration(e) => match &e.declaration {
                Declaration::FunctionDeclaration(f) => function_target(index, f, &mut targets),
                Declaration::VariableDeclaration(v) => variable_targets(index, v, &mut targets),
                _ => {}
            },
            Statement::ExportDefaultDeclaration(e) => {
                if let ExportDefaultDeclarationKind::FunctionDeclaration(f) = &e.declaration {
                    function_target(index, f, &mut targets);
                }
            }
            _ => {}
        }
    }
    if targets.is_empty() {
        return;
    }

    // Signatures: a component's own code plus the module's code outside
    // components (what its closure may capture).
    let mut spans: Vec<Span> = targets
        .iter()
        .filter_map(|t| match t {
            Target::Function { span, .. }
            | Target::Arrow { span, .. }
            | Target::Mount { span, .. } => Some(*span),
            Target::Context { .. } | Target::Keep { .. } => None,
        })
        .collect();
    spans.sort_by_key(|s| s.start);
    let mut rest = Vec::new();
    let mut at = 0;
    for s in &spans {
        rest.push(source.get(at..s.start as usize).unwrap_or_default());
        at = s.end as usize;
    }
    rest.push(source.get(at..).unwrap_or_default());
    let rest = hash(&rest);
    let signature = |span: Span| {
        hash(&[
            source
                .get(span.start as usize..span.end as usize)
                .unwrap_or_default(),
            &rest,
        ])
    };

    let b = AstBuilder::new(allocator);
    let str = |s: &str| allocator.alloc_str(s);
    let call = |method: &str, args: Vec<Expression<'a>>| -> Expression<'a> {
        let callee = Expression::new_static_member_expression(
            SPAN,
            Expression::new_identifier(SPAN, str(HOT), &b),
            IdentifierName::new(SPAN, str(method), &b),
            false,
            &b,
        );
        let args = ArenaVec::from_iter_in(args.into_iter().map(Argument::from), &b);
        Expression::new_call_expression(SPAN, callee, None, args, false, &b)
    };
    let string = |s: &str| Expression::new_string_literal(SPAN, str(s), None, &b);

    // Insertions after statements, applied back to front.
    let mut after: Vec<(usize, Statement<'a>)> = Vec::new();
    for target in targets {
        match target {
            Target::Function { index, name, span } => {
                let proxy = call(
                    "component",
                    vec![
                        string(key),
                        string(&name),
                        Expression::new_identifier(SPAN, str(&name), &b),
                        string(&signature(span)),
                    ],
                );
                let assign = Expression::new_assignment_expression(
                    SPAN,
                    AssignmentOperator::Assign,
                    AssignmentTarget::new_assignment_target_identifier(SPAN, str(&name), &b),
                    proxy,
                    &b,
                );
                after.push((index, Statement::new_expression_statement(SPAN, assign, &b)));
            }
            Target::Arrow {
                index,
                declarator,
                name,
                span,
            } => {
                let sig = signature(span);
                wrap_init(&mut program.body[index], declarator, |init| {
                    call(
                        "component",
                        vec![string(key), string(&name), init, string(&sig)],
                    )
                });
            }
            Target::Context {
                index,
                declarator,
                name,
            } => {
                wrap_init(&mut program.body[index], declarator, |init| {
                    call("context", vec![string(key), string(&name), init])
                });
            }
            Target::Keep {
                index,
                declarator,
                name,
                span,
            } => {
                // The initializer's own code: an edit to it starts afresh.
                let sig = hash(&[source
                    .get(span.start as usize..span.end as usize)
                    .unwrap_or_default()]);
                wrap_init(&mut program.body[index], declarator, |init| {
                    call("keep", vec![string(key), string(&name), string(&sig), init])
                });
            }
            Target::Mount { index, n, span } => {
                let sig = signature(span);
                let Statement::ExpressionStatement(e) = &mut program.body[index] else {
                    continue;
                };
                let Expression::CallExpression(c) = &mut e.expression else {
                    continue;
                };
                let Some(first) = c.arguments.first_mut() else {
                    continue;
                };
                let placeholder = Argument::from(Expression::new_null_literal(SPAN, &b));
                let f = std::mem::replace(first, placeholder).into_expression();
                *first = Argument::from(call(
                    "component",
                    vec![string(key), string(&format!("mount#{n}")), f, string(&sig)],
                ));
            }
        }
    }
    after.sort_by_key(|(index, _)| std::cmp::Reverse(*index));
    for (index, statement) in after {
        program.body.insert(index + 1, statement);
    }
}

/// Replaces the initializer of declarator `declarator` of the variable
/// declaration in `statement` with `wrap(initializer)`.
fn wrap_init<'a>(
    statement: &mut Statement<'a>,
    declarator: usize,
    wrap: impl FnOnce(Expression<'a>) -> Expression<'a>,
) {
    let declaration = match statement {
        Statement::VariableDeclaration(v) => v,
        Statement::ExportDeclaration(e) => match &mut e.declaration {
            Declaration::VariableDeclaration(v) => v,
            _ => return,
        },
        _ => return,
    };
    let Some(d) = declaration.declarations.get_mut(declarator) else {
        return;
    };
    if let Some(init) = d.init.take() {
        let span = init.span();
        let mut wrapped = wrap(init);
        if let Expression::CallExpression(c) = &mut wrapped {
            // Errors in the wrapper point at the component.
            c.span = span;
        }
        d.init = Some(wrapped);
    }
}
