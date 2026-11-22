//! Build-time checks of Tailwind classes: the static parts of `class` and
//! `classList` attributes are parsed with the core's own parser and theme,
//! and unknown classes are reported with their source position.

use nsh_core::tailwind::{Theme, parse};
use oxc::{
    allocator::Allocator,
    ast::ast::{
        Expression, JSXAttribute, JSXAttributeName, JSXAttributeValue, ObjectPropertyKind,
        PropertyKey,
    },
    ast_visit::{Visit, walk},
    parser::Parser,
    span::SourceType,
};

/// One unknown class.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UnknownClass {
    /// 1-based line and column.
    pub(crate) line: usize,
    pub(crate) column: usize,
    pub(crate) class: String,
}

/// The unknown classes in `source`'s JSX.
pub(crate) fn check(source: &str, source_type: SourceType, theme: &Theme) -> Vec<UnknownClass> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type).parse();
    let mut v = Checker {
        source,
        theme,
        found: Vec::new(),
    };
    v.visit_program(&parsed.program);
    v.found
}

struct Checker<'s> {
    source: &'s str,
    theme: &'s Theme,
    found: Vec<UnknownClass>,
}

impl Checker<'_> {
    /// Checks the classes of the string at byte `offset` of the source.
    fn classes(&mut self, classes: &str, offset: u32) {
        let list = parse(self.theme, classes);
        for unknown in list.unknown() {
            // The class's own position within the string, if found.
            let at = classes.find(&**unknown).unwrap_or(0) as u32;
            let (line, column) = crate::compile::position(self.source, offset + at);
            self.found.push(UnknownClass {
                line,
                column,
                class: unknown.to_string(),
            });
        }
    }

    /// Strings an expression can evaluate to statically: literals, both
    /// sides of conditionals and `&&` / `||`, the parts of templates.
    fn expression(&mut self, e: &Expression<'_>) {
        match e {
            Expression::StringLiteral(s) => self.classes(&s.value, s.span.start + 1),
            Expression::TemplateLiteral(t) => {
                let last = t.quasis.len().saturating_sub(1);
                for (i, q) in t.quasis.iter().enumerate() {
                    // A class touching an interpolation is only part of a
                    // name (`bg-${color}-500`): skip it.
                    let raw: &str = &q.value.raw;
                    let mut start = 0;
                    let mut end = raw.len();
                    if i > 0 && !raw.starts_with(char::is_whitespace) {
                        start = raw.find(char::is_whitespace).unwrap_or(raw.len());
                    }
                    if i < last && !raw.ends_with(char::is_whitespace) {
                        end = raw.rfind(char::is_whitespace).map_or(0, |e| e + 1);
                    }
                    if start < end {
                        self.classes(&raw[start..end], q.span.start + start as u32);
                    }
                }
                for e in &t.expressions {
                    self.expression(e);
                }
            }
            Expression::ConditionalExpression(c) => {
                self.expression(&c.consequent);
                self.expression(&c.alternate);
            }
            Expression::LogicalExpression(l) => self.expression(&l.right),
            Expression::ParenthesizedExpression(p) => self.expression(&p.expression),
            _ => {}
        }
    }
}

impl<'a> Visit<'a> for Checker<'_> {
    fn visit_jsx_attribute(&mut self, attr: &JSXAttribute<'a>) {
        let JSXAttributeName::Identifier(name) = &attr.name else {
            return walk::walk_jsx_attribute(self, attr);
        };
        match (name.name.as_str(), &attr.value) {
            ("class" | "contentContainerClass", Some(JSXAttributeValue::StringLiteral(s))) => {
                self.classes(&s.value, s.span.start + 1);
            }
            (
                "class" | "contentContainerClass",
                Some(JSXAttributeValue::ExpressionContainer(c)),
            ) => {
                if let Some(e) = c.expression.as_expression() {
                    self.expression(e);
                }
            }
            ("classList", Some(JSXAttributeValue::ExpressionContainer(c))) => {
                if let Some(Expression::ObjectExpression(o)) = c.expression.as_expression() {
                    for p in &o.properties {
                        if let ObjectPropertyKind::ObjectProperty(p) = p {
                            match &p.key {
                                PropertyKey::StringLiteral(s) => {
                                    self.classes(&s.value, s.span.start + 1)
                                }
                                PropertyKey::StaticIdentifier(i) => {
                                    self.classes(&i.name, i.span.start)
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        walk::walk_jsx_attribute(self, attr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_unknown_static_classes() {
        let source = r#"
import { Text, View } from "nsh";
export function A(p: { on: boolean }) {
  return (
    <View class="p-4 bg-blu-500">
      <Text class={p.on ? "text-white" : "txt-black"} classList={{ "opacity-50": p.on, nope: p.on }} />
      <View class={`flex ${p.on ? "gap-2" : ""} wat bg-${p.on}-500 x${p.on}`} />
    </View>
  );
}
"#;
        let found = check(source, SourceType::tsx(), &Theme::default());
        let names: Vec<&str> = found.iter().map(|u| u.class.as_str()).collect();
        assert_eq!(names, ["bg-blu-500", "txt-black", "nope", "wat"]);
        assert_eq!((found[0].line, found[0].column), (5, 22));
    }

    #[test]
    fn theme_tokens_are_classes() {
        let source = r#"<View class="bg-primary text-muted-foreground bg-chart-up rounded-(--radius-card)" />"#;
        let themed = |theme: nsh_base::Theme| {
            let mut tailwind = Theme::default();
            tailwind.set_tokens(theme.tokens());
            tailwind
        };
        let found = check(
            source,
            SourceType::tsx(),
            &themed(nsh_base::Theme::default()),
        );
        let names: Vec<&str> = found.iter().map(|u| u.class.as_str()).collect();
        assert_eq!(names, ["bg-chart-up", "rounded-(--radius-card)"]);
        // The app's own theme (`nsh.json` `"theme"`) adds its keys.
        let theme = nsh_base::Theme::from_json(
            r##"{ "cssVars": { "theme": { "radius-card": "10px" }, "light": { "chart-up": "#00ff00" } } }"##,
        )
        .unwrap();
        assert!(check(source, SourceType::tsx(), &themed(theme)).is_empty());
    }
}
