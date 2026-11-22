//! Split bundles: the dynamic imports of a chunk become calls of the
//! runtime's chunk loader ([`nsh_core::js::IMPORT_CHUNK`]), which is told
//! every chunk the imported one needs, so the web runtime can fetch them
//! all at once before QuickJS links them (its module loader cannot wait).

use std::collections::BTreeSet;

use oxc::{
    allocator::Allocator,
    ast::ast::{Expression, ImportExpression},
    ast_visit::{Visit, walk},
    parser::Parser,
    span::{GetSpan, SourceType},
};
use string_wizard::{Hires, MagicString, SourceMapOptions};

/// `code` (the chunk `filename`) with its imports of other chunks
/// (`import("./Screen.js")`) rewritten to
/// `__nsh_import("Screen.js", ["shared.js"])`, and the source map of the
/// change; `None` if it has none. `imports` gives the chunks a chunk imports
/// statically (`None`: not a chunk of this bundle).
pub(crate) fn rewrite_imports<'a>(
    code: &str,
    filename: &str,
    imports: impl Fn(&str) -> Option<&'a [String]>,
) -> Option<(String, rolldown_sourcemap::SourceMap)> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, code, SourceType::mjs()).parse();
    let mut found = Finder { found: Vec::new() };
    found.visit_program(&parsed.program);
    let mut out = MagicString::new(code);
    let mut changed = false;
    for (start, source, value) in found.found {
        let id = value.strip_prefix("./").unwrap_or(&value);
        let Some(direct) = imports(id) else {
            continue;
        };
        // Everything the chunk needs, transitively (the entry chunk is
        // always there).
        let mut needed = BTreeSet::new();
        let mut queue: Vec<&str> = direct.iter().map(String::as_str).collect();
        while let Some(next) = queue.pop() {
            if next != id && needed.insert(next.to_owned()) {
                queue.extend(imports(next).unwrap_or_default().iter().map(String::as_str));
            }
        }
        let args = format!(
            "{}, {}",
            serde_json::Value::from(id),
            serde_json::Value::from(needed.into_iter().collect::<Vec<_>>())
        );
        // `import` (the keyword) and the specifier; whatever lies between
        // (`(`, comments) stays.
        let renamed = out.update(
            start,
            start + "import".len() as u32,
            nsh_core::js::IMPORT_CHUNK,
        );
        let replaced = renamed.and_then(|out| out.update(source.0, source.1, args));
        changed |= replaced.is_ok();
    }
    changed.then(|| {
        let map = out.source_map(SourceMapOptions {
            include_content: false,
            source: filename.into(),
            hires: Hires::Boundary,
        });
        (out.to_string(), map)
    })
}

struct Finder {
    /// Each dynamic import with a string specifier: where it starts, the
    /// specifier's span and value.
    found: Vec<(u32, (u32, u32), String)>,
}

impl<'a> Visit<'a> for Finder {
    fn visit_import_expression(&mut self, it: &ImportExpression<'a>) {
        if let Expression::StringLiteral(source) = &it.source
            && it.options.is_none()
        {
            let span = source.span();
            self.found.push((
                it.span.start,
                (span.start, span.end),
                source.value.to_string(),
            ));
        }
        walk::walk_import_expression(self, it);
    }
}
