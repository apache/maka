//! A build-time check of components that take their props apart in their
//! parameter (`function Title({ text })`): a component runs once, and a
//! prop that changes is a getter, so a destructured one is read that once
//! and never follows a change. Reported as a warning, with the props to
//! read where they are used instead.

use oxc::{
    ast::ast::{
        BindingPattern, Declaration, ExportDefaultDeclarationKind, Expression, FormalParameters,
        Function, ObjectPattern, Program, PropertyKey, Statement, VariableDeclaration,
    },
    span::GetSpan,
};

use crate::hot::{expression_has_jsx, function_has_jsx, is_component_name};

/// A component destructuring its props.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DestructuredProps {
    /// 1-based line and column of the pattern.
    pub(crate) line: usize,
    pub(crate) column: usize,
    /// The component's name.
    pub(crate) component: String,
    /// The props it takes out, as written (`...rest` for a rest).
    pub(crate) names: Vec<String>,
}

impl DestructuredProps {
    /// What the warning says.
    pub(crate) fn message(&self) -> String {
        let pattern = format!("{{ {} }}", self.names.join(", "));
        let example = self
            .names
            .iter()
            .find(|n| !n.starts_with("..."))
            .map_or("props.name".to_owned(), |n| format!("props.{n}"));
        format!(
            "{} takes its props apart (`{pattern}`): each is read once, when {} runs, and does not \
             follow changes; take `props` and read `{example}` where it is used (`split(props, [...])` \
             to pass the rest on)",
            self.component, self.component
        )
    }
}

/// The top-level components of `program` (`source` its text) whose first
/// parameter takes the props apart. A component taking them apart in its
/// body (`const { id } = props;`) says so on purpose and is left alone.
pub(crate) fn check(program: &Program<'_>, source: &str) -> Vec<DestructuredProps> {
    let mut finder = Finder {
        source,
        found: Vec::new(),
    };
    for statement in &program.body {
        match statement {
            Statement::FunctionDeclaration(f) => finder.function_declaration(f),
            Statement::VariableDeclaration(v) => finder.variables(v),
            Statement::ExportDeclaration(e) => match &e.declaration {
                Declaration::FunctionDeclaration(f) => finder.function_declaration(f),
                Declaration::VariableDeclaration(v) => finder.variables(v),
                _ => {}
            },
            Statement::ExportDefaultDeclaration(e) => {
                if let ExportDefaultDeclarationKind::FunctionDeclaration(f) = &e.declaration {
                    finder.function_declaration(f);
                }
            }
            _ => {}
        }
    }
    finder.found
}

struct Finder<'s> {
    source: &'s str,
    found: Vec<DestructuredProps>,
}

impl Finder<'_> {
    fn function_declaration(&mut self, f: &Function<'_>) {
        if let Some(id) = &f.id {
            self.component(&id.name, &f.params, || function_has_jsx(f));
        }
    }

    /// `const Name = (…) => …` / `function (…) {…}`.
    fn variables(&mut self, v: &VariableDeclaration<'_>) {
        for decl in &v.declarations {
            let (BindingPattern::BindingIdentifier(id), Some(init)) = (&decl.id, &decl.init) else {
                continue;
            };
            match init {
                Expression::ArrowFunctionExpression(f) => {
                    self.component(&id.name, &f.params, || expression_has_jsx(init));
                }
                Expression::FunctionExpression(f) => {
                    self.component(&id.name, &f.params, || function_has_jsx(f));
                }
                _ => {}
            }
        }
    }

    /// A function named `name` taking `params`, a component when its name
    /// is and it has JSX.
    fn component(
        &mut self,
        name: &str,
        params: &FormalParameters<'_>,
        has_jsx: impl FnOnce() -> bool,
    ) {
        let Some(pattern) = params
            .items
            .first()
            .and_then(|p| object_pattern(&p.pattern))
        else {
            return;
        };
        if !is_component_name(name) || !has_jsx() {
            return;
        }
        let (line, column) = crate::compile::position(self.source, pattern.span.start);
        self.found.push(DestructuredProps {
            line,
            column,
            component: name.to_owned(),
            names: names(pattern, self.source),
        });
    }
}

/// The object pattern a parameter is (with a default too: `({ a } = {})`).
fn object_pattern<'p, 'a>(pattern: &'p BindingPattern<'a>) -> Option<&'p ObjectPattern<'a>> {
    match pattern {
        BindingPattern::ObjectPattern(o) => Some(o),
        BindingPattern::AssignmentPattern(a) => object_pattern(&a.left),
        _ => None,
    }
}

/// The props `pattern` takes out, as written.
fn names(pattern: &ObjectPattern<'_>, source: &str) -> Vec<String> {
    let mut names: Vec<String> = pattern
        .properties
        .iter()
        .map(|p| match &p.key {
            PropertyKey::StaticIdentifier(id) => id.name.to_string(),
            key => {
                let span = key.span();
                source[span.start as usize..span.end as usize].to_owned()
            }
        })
        .collect();
    if let Some(rest) = &pattern.rest {
        let span = rest.argument.span();
        names.push(format!(
            "...{}",
            &source[span.start as usize..span.end as usize]
        ));
    }
    names
}

#[cfg(test)]
mod tests {
    use oxc::{allocator::Allocator, parser::Parser, span::SourceType};

    use super::*;

    fn found(source: &str) -> Vec<DestructuredProps> {
        let allocator = Allocator::default();
        let parsed = Parser::new(&allocator, source, SourceType::tsx()).parse();
        check(&parsed.program, source)
    }

    #[test]
    fn components_destructuring_their_props_are_found() {
        let source = r#"import { Text } from "nsh";
function Title({ text, size = 2 }: { text: string; size?: number }) { return <Text>{text}</Text>; }
export const Badge = ({ label, ...rest }: any) => <Text {...rest}>{label}</Text>;
export default function Page({ id } = { id: 1 }) { return <Text>{id}</Text>; }
export function Row(props: { a: string }) { return <Text>{props.a}</Text>; }
function Kept(props: { id: string }) { const { id } = props; return <Text>{id}</Text>; }
function helper({ a }: { a: number }) { return a; }
const Plain = ({ a }: { a: number }) => a + 1;
"#;
        let found = found(source);
        let summary: Vec<(usize, &str, Vec<&str>)> = found
            .iter()
            .map(|d| {
                (
                    d.line,
                    d.component.as_str(),
                    d.names.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                (2, "Title", vec!["text", "size"]),
                (3, "Badge", vec!["label", "...rest"]),
                (4, "Page", vec!["id"]),
            ]
        );
        assert_eq!(found[0].column, 16);
        assert_eq!(
            found[0].message(),
            "Title takes its props apart (`{ text, size }`): each is read once, when Title runs, \
             and does not follow changes; take `props` and read `props.text` where it is used \
             (`split(props, [...])` to pass the rest on)"
        );
    }
}
