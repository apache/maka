//! Linking a bundle's modules to the files they are published as: a
//! packager that names the entry and its chunks by their digests rewrites
//! what they import (`from "./bundle.js"`, `from "nsh"`) to those files'
//! URLs, so the browser resolves them without an import map.

use oxc::{allocator::Allocator, ast::ast::Statement, parser::Parser, span::SourceType};

/// The sources of `code`'s static imports and re-exports (`import … from
/// "<source>"`, `export … from "<source>"`), an ES module (`name` in
/// errors), each one given to `resolve`: what it returns replaces the
/// source, `None` keeps it. Dynamic imports are left as they are (a
/// bundle's go through the runtime's chunk loader).
pub fn rewrite_imports(
    name: &str,
    code: &str,
    mut resolve: impl FnMut(&str) -> Option<String>,
) -> Result<String, String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, code, SourceType::mjs()).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("{name}: {error}"));
    }
    let mut edits = Vec::new();
    for statement in &parsed.program.body {
        let source = match statement {
            Statement::ImportDeclaration(declaration) => Some(&declaration.source),
            Statement::ExportAllDeclaration(declaration) => Some(&declaration.source),
            Statement::ExportFromDeclaration(declaration) => Some(&declaration.source),
            _ => None,
        };
        if let Some(source) = source
            && let Some(to) = resolve(source.value.as_str())
        {
            edits.push((source.span.start as usize, source.span.end as usize, to));
        }
    }
    let mut out = String::with_capacity(code.len());
    let mut at = 0;
    for (start, end, to) in edits {
        out.push_str(&code[at..start]);
        out.push('"');
        for c in to.chars() {
            match c {
                '"' | '\\' => {
                    out.push('\\');
                    out.push(c);
                }
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\u{2028}' => out.push_str("\\u2028"),
                '\u{2029}' => out.push_str("\\u2029"),
                _ => out.push(c),
            }
        }
        out.push('"');
        at = end;
    }
    out.push_str(&code[at..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::rewrite_imports;

    #[test]
    fn static_imports_and_re_exports_are_rewritten() {
        let code = "import{a as b}from\"./bundle.js\";import'./side.js';\
                    import*as n from\"nsh\";export{c}from'./c.js';export*from\"./d.js\";\
                    const x=__nsh_import(`Screen.js`,[]);const y=import(\"./e.js\");export{b};";
        let mut seen = Vec::new();
        let out = rewrite_imports("app.js", code, |source| {
            seen.push(source.to_owned());
            (source != "./side.js").then(|| format!("./{}.1.js", source.trim_start_matches("./")))
        })
        .unwrap();
        assert_eq!(
            seen,
            ["./bundle.js", "./side.js", "nsh", "./c.js", "./d.js"]
        );
        assert!(out.contains("from\"./bundle.js.1.js\""), "{out}");
        assert!(out.contains("import'./side.js'"), "{out}");
        assert!(
            out.contains("from \"./nsh.1.js\"") || out.contains("from\"./nsh.1.js\""),
            "{out}"
        );
        assert!(out.contains("from\"./c.js.1.js\""), "{out}");
        assert!(out.contains("from\"./d.js.1.js\""), "{out}");
        // Dynamic imports and the chunk loader's calls stay.
        assert!(out.contains("__nsh_import(`Screen.js`,[])"), "{out}");
        assert!(out.contains("import(\"./e.js\")"), "{out}");
        assert!(out.ends_with("export{b};"), "{out}");
        // A source that would end the string is escaped.
        let out = rewrite_imports("a.js", "import\"x\";", |_| Some("a\"b".into())).unwrap();
        assert_eq!(out, "import\"a\\\"b\";");
        assert!(rewrite_imports("bad.js", "import from", |_| None).is_err());
    }
}
