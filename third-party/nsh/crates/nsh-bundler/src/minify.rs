//! Minifying a JS module that is not an app: the web runtime's DOM side
//! (`nsh.js`), which `nsh package --target web` ships next to the app.
//! Apps are minified by rolldown as they are bundled.

use oxc::{
    allocator::Allocator,
    codegen::{Codegen, CodegenOptions},
    minifier::{CompressOptions, MangleOptions, Minifier, MinifierOptions},
    parser::Parser,
    span::SourceType,
};

/// Minifies the ES module `source` (`name` in errors): compressed, local
/// names mangled, exports and property names kept (code that looks
/// methods up by name, as `nsh.js`'s `op_<name>`, still finds them).
pub fn minify_module(name: &str, source: &str) -> Result<String, String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, SourceType::mjs()).parse();
    if let Some(error) = parsed.diagnostics.first() {
        return Err(format!("{name}: {error}"));
    }
    let mut program = parsed.program;
    let minified = Minifier::new(MinifierOptions {
        mangle: Some(MangleOptions::default()),
        mangle_properties: None,
        compress: Some(CompressOptions::default()),
    })
    .minify(&allocator, &mut program);
    Ok(Codegen::new()
        .with_options(CodegenOptions::minify())
        .with_scoping(minified.scoping)
        .build(&program)
        .code)
}

#[cfg(test)]
mod tests {
    #[test]
    fn exports_and_methods_keep_their_names() {
        let source = "const unused = 1;\n\
                      export function createPlayer(container) {\n\
                        const player = new Player(container);\n\
                        return player;\n\
                      }\n\
                      class Player {\n\
                        constructor(container) { this.container = container; }\n\
                        op_c(item) { return item; }\n\
                      }\n";
        let out = super::minify_module("nsh.js", source).unwrap();
        assert!(out.len() < source.len(), "{out}");
        assert!(out.contains("createPlayer"), "{out}");
        assert!(out.contains("op_c"), "{out}");
        assert!(!out.contains("unused"), "{out}");
        assert!(super::minify_module("bad.js", "export function (").is_err());
    }
}
