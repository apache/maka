//! wasm-bindgen in an app's web runtime: an app whose crates call JS
//! through it (`web-sys`, `js-sys`: a WebSocket, the DOM) links imports
//! that only wasm-bindgen's JS glue provides. [`install`] reads the built
//! module ([`needs`]): when it imports such a function, `nsh` runs the
//! `wasm-bindgen` CLI of the version the module names on it ([`process`])
//! and ships the glue next to `nsh.js`, which merges the glue's imports with
//! its own (`nsh`, `env`) and runs the glue's setup before the app starts. A
//! runtime that calls no JS through wasm-bindgen (one that only links it,
//! through a crate's default features) is built and served as before.
//!
//! The glue is wasm-bindgen's `--target web` output, adapted ([`adapt`]),
//! with the JS snippets it imports (`#[wasm_bindgen(inline_js = …)]`,
//! `module = …`: `snippets/<crate>-<hash>/…`, [`snippets`]), served and
//! packaged beside it ([`link_snippets`] points the glue at their published
//! directory): the imports wasm-bindgen does not provide (the `nsh` module)
//! are not ES modules but `nsh.js`' own, and its import table and setup are
//! exported for `nsh.js` to call.

use std::{
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};

/// The file the glue is served and packaged as, next to `nsh.js`.
pub(crate) const GLUE: &str = "nsh-bindgen.js";

/// The wasm-bindgen whose glue [`adapt`] was written for and tested with;
/// later versions whose glue has the same shape adapt too.
const KNOWN: &str = "0.2.129";

/// The `wasm-bindgen` CLI to run: `NSH_WASM_BINDGEN`, else the one on `PATH`.
fn cli() -> std::ffi::OsString {
    std::env::var_os("NSH_WASM_BINDGEN").unwrap_or_else(|| "wasm-bindgen".into())
}

/// Puts the web runtime cargo built (`built`) into `out` as `<name>.wasm`:
/// through wasm-bindgen when it calls JS through it ([`needs`]), with the
/// glue as `<name>-bindgen.js` (returned) and its snippets in
/// `<name>-bindgen/`; otherwise as it is, and without the glue and snippets
/// an earlier build had.
pub(crate) fn install(built: &Path, out: &Path, name: &str) -> anyhow::Result<Option<PathBuf>> {
    let module = std::fs::read(built).with_context(|| format!("read {}", built.display()))?;
    match needs(&module).with_context(|| format!("read {}", built.display()))? {
        Some(version) => process(built, &version, out, name).map(Some),
        None => {
            let wasm = out.join(format!("{name}.wasm"));
            std::fs::write(&wasm, &module).with_context(|| format!("write {}", wasm.display()))?;
            let glue = out.join(format!("{name}-bindgen.js"));
            if glue.exists() {
                std::fs::remove_file(&glue)
                    .with_context(|| format!("remove {}", glue.display()))?;
            }
            let dir = output_dir(&glue);
            for dir in [staging_dir(&dir), dir] {
                if dir.exists() {
                    std::fs::remove_dir_all(&dir)
                        .with_context(|| format!("remove {}", dir.display()))?;
                }
            }
            Ok(None)
        }
    }
}

/// The version of the wasm-bindgen crate `module` links when its imports
/// need JS glue: web-sys, js-sys, a crate's own extern blocks, or intrinsics
/// such as `JsValue::as_string` and the generic casts of `JsValue::from_str`.
/// Only the descriptor and throw helpers that linking wasm-bindgen alone
/// can retain are ignored, along with its externref transform imports.
/// The version is the one the module records (its `__wasm_bindgen_unstable`
/// section), which the CLI must equal.
pub(crate) fn needs(module: &[u8]) -> anyhow::Result<Option<String>> {
    let linked = read_module(module)
        .map_err(|why| anyhow::anyhow!("not a WebAssembly module nsh can read: {why}"))?;
    if !linked.bindings {
        return Ok(None);
    }
    match linked.version {
        Some(version) => Ok(Some(version)),
        None => bail!(
            "the web runtime imports JS functions through wasm-bindgen but names no wasm-bindgen version (its `__wasm_bindgen_unstable` section is gone)"
        ),
    }
}

/// What [`needs`] reads in a module.
#[derive(Debug, Default, PartialEq)]
struct Linked {
    /// It imports a JS function through wasm-bindgen.
    bindings: bool,
    /// The wasm-bindgen version its `__wasm_bindgen_unstable` section
    /// names first (`0.2.129`, without the revision a git build adds).
    version: Option<String>,
}

/// Reads the import section and wasm-bindgen's custom section of
/// `module`, skipping the others by their sizes.
fn read_module(module: &[u8]) -> Result<Linked, &'static str> {
    let mut reader = Reader(module);
    if reader.take(8)? != b"\0asm\x01\0\0\0" {
        return Err("no WebAssembly module header");
    }
    let mut linked = Linked::default();
    while !reader.0.is_empty() {
        let id = reader.byte()?;
        let size = usize::try_from(reader.leb()?).map_err(|_| "a section is too large")?;
        let mut section = Reader(reader.take(size)?);
        match id {
            0 if section.name()? == "__wasm_bindgen_unstable" && linked.version.is_none() => {
                linked.version = bindgen_version(section.0);
            }
            2 => {
                for _ in 0..section.leb()? {
                    let module = section.name()?;
                    let field = section.name()?;
                    linked.bindings |= module == "__wbindgen_placeholder__"
                        && (field.starts_with("__wbg_") || field.starts_with("__wbindgen_"))
                        && !matches!(field, "__wbindgen_describe" | "__wbindgen_throw")
                        && !field.starts_with("__wbg___wbindgen_throw_");
                    section.import_kind()?;
                }
            }
            _ => {}
        }
    }
    Ok(linked)
}

/// The version in the first record of a `__wasm_bindgen_unstable` section:
/// a little-endian `u32` length and `{"schema_version":"…","version":"…"}`.
fn bindgen_version(section: &[u8]) -> Option<String> {
    let len = u32::from_le_bytes(section.get(..4)?.try_into().ok()?) as usize;
    let json = std::str::from_utf8(section.get(4..4 + len)?).ok()?;
    let (_, rest) = json.split_once("\"version\":\"")?;
    let (version, _) = rest.split_once('"')?;
    let version = version.split_whitespace().next()?;
    Some(version.to_owned())
}

/// The bytes of a module not read yet.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        if n > self.0.len() {
            return Err("it ends early");
        }
        let (taken, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(taken)
    }

    fn byte(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }

    /// An unsigned LEB128 number (signed ones of the same bytes skip alike).
    fn leb(&mut self) -> Result<u64, &'static str> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("a number is too long")
    }

    fn name(&mut self) -> Result<&'a str, &'static str> {
        let len = usize::try_from(self.leb()?).map_err(|_| "a name is too long")?;
        std::str::from_utf8(self.take(len)?).map_err(|_| "a name is not UTF-8")
    }

    /// Skips an import's kind and type.
    fn import_kind(&mut self) -> Result<(), &'static str> {
        match self.byte()? {
            // A function: its type's index.
            0x00 => self.leb().map(drop),
            // A table: its element type and limits.
            0x01 => {
                self.value_type()?;
                self.limits()
            }
            0x02 => self.limits(),
            // A global: its type and mutability.
            0x03 => {
                self.value_type()?;
                self.byte().map(drop)
            }
            // A tag: its attribute and type's index.
            0x04 => {
                self.byte()?;
                self.leb().map(drop)
            }
            _ => Err("an import of an unknown kind"),
        }
    }

    fn value_type(&mut self) -> Result<(), &'static str> {
        // `(ref null? <heap type>)`, else one byte.
        if matches!(self.byte()?, 0x63 | 0x64) {
            self.leb()?;
        }
        Ok(())
    }

    fn limits(&mut self) -> Result<(), &'static str> {
        let flags = self.byte()?;
        self.leb()?;
        if flags & 0x01 != 0 {
            self.leb()?;
        }
        // A custom page size.
        if flags & 0x08 != 0 {
            self.leb()?;
        }
        Ok(())
    }
}

/// The version `wasm-bindgen --version` printed (`wasm-bindgen 0.2.129`).
fn cli_version(output: &str) -> Option<&str> {
    output.split_whitespace().nth(1)
}

/// Checks that the `wasm-bindgen` CLI that printed `output` (`None`: none
/// ran) is `version`, the crate's: the glue and the module's imports are
/// generated by the two together.
pub(crate) fn check_cli(version: &str, output: Option<&str>) -> anyhow::Result<()> {
    let install = format!("cargo install wasm-bindgen-cli --version {version} --locked");
    match output.and_then(cli_version) {
        Some(cli) if cli == version => Ok(()),
        Some(cli) => bail!(
            "the app's web runtime calls JS through wasm-bindgen {version}, and the wasm-bindgen CLI is {cli}: they must be the same version ({install})"
        ),
        None => bail!(
            "the app's web runtime calls JS through wasm-bindgen {version} (web-sys, js-sys or a crate's #[wasm_bindgen] imports), which needs the wasm-bindgen CLI of that version: {install}"
        ),
    }
}

/// Runs the `wasm-bindgen` CLI (`version`, checked first) on `module`,
/// writing into `out` the module to load as `<name>.wasm` and the glue
/// ([`adapt`]ed) as `<name>-bindgen.js`, whose path it returns.
/// wasm-bindgen's own output, with the glue's snippets ([`snippets`]),
/// replaces `<name>-bindgen/` once it is complete: a failed run leaves the
/// previous build's module, glue and snippets together.
pub(crate) fn process(
    module: &Path,
    version: &str,
    out: &Path,
    name: &str,
) -> anyhow::Result<PathBuf> {
    let printed = Command::new(cli())
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    check_cli(version, printed.as_deref())?;
    let glue = out.join(format!("{name}-bindgen.js"));
    let dir = output_dir(&glue);
    let staging = staging_dir(&dir);
    if staging.exists() {
        std::fs::remove_dir_all(&staging)
            .with_context(|| format!("remove {}", staging.display()))?;
    }
    if let Err(error) = generate(module, version, &staging, name) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display()))?;
    }
    std::fs::rename(&staging, &dir)
        .with_context(|| format!("rename {} to {}", staging.display(), dir.display()))?;
    for (from, to) in [
        (
            dir.join(format!("{name}_bg.wasm")),
            out.join(format!("{name}.wasm")),
        ),
        (dir.join(format!("{name}-bindgen.js")), glue.clone()),
    ] {
        std::fs::rename(&from, &to)
            .with_context(|| format!("rename {} to {}", from.display(), to.display()))?;
    }
    Ok(glue)
}

/// Runs wasm-bindgen on `module` into `dir`, with the adapted glue next to
/// what it writes (`<name>-bindgen.js`).
fn generate(module: &Path, version: &str, dir: &Path, name: &str) -> anyhow::Result<()> {
    let mut command = Command::new(cli());
    command
        // The page hands the module over (`nsh.js`): the glue needs no URL
        // of a `<name>_bg.wasm` the site does not have.
        .args([
            "--target",
            "web",
            "--no-typescript",
            "--omit-default-module-path",
            "--out-dir",
        ])
        .arg(dir)
        .args(["--out-name", name])
        .arg(module);
    let step = crate::ui::Step::start("running wasm-bindgen on the web runtime");
    let (status, output) = crate::ui::capture(&mut command, |_| {}).context("run wasm-bindgen")?;
    if !status.success() {
        return Err(crate::ui::failure("running wasm-bindgen failed", output));
    }
    step.done(format!("ran wasm-bindgen {version} on the web runtime"));
    let glue = std::fs::read_to_string(dir.join(format!("{name}.js")))
        .context("read wasm-bindgen's glue")?;
    let adapted = dir.join(format!("{name}-bindgen.js"));
    std::fs::write(&adapted, adapt(&glue, version)?)
        .with_context(|| format!("write {}", adapted.display()))
}

/// Where wasm-bindgen wrote the glue `glue` (`<name>-bindgen.js`) was made
/// from: `<name>-bindgen/`.
pub(crate) fn output_dir(glue: &Path) -> PathBuf {
    glue.with_extension("")
}

/// Where wasm-bindgen writes before its output replaces `dir`.
fn staging_dir(dir: &Path) -> PathBuf {
    dir.with_extension("tmp")
}

/// The JS snippets the glue `glue` imports, as `(path, file)`: their path
/// relative to the glue (`snippets/<crate>-<hash>/inline0.js`, as the glue
/// imports them, `./` aside) and where they are. Sorted by path.
pub(crate) fn snippets(glue: &Path) -> anyhow::Result<Vec<(String, PathBuf)>> {
    let root = output_dir(glue);
    let mut found = Vec::new();
    let mut dirs = vec![root.join("snippets")];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries {
            let path = entry?.path();
            if path.is_dir() {
                dirs.push(path);
            } else if let Ok(relative) = path.strip_prefix(&root) {
                let relative = relative
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                found.push((relative, path));
            }
        }
    }
    found.sort();
    Ok(found)
}

/// The glue with its snippets imported from `dir` (`snippets.<digest>`,
/// relative to the glue) instead of `snippets`: the snippets keep their
/// paths under it, so their imports of one another resolve as they did.
/// Only ES module specifiers move: import-table keys also occur as paths,
/// but name imports in the unchanged Wasm binary.
pub(crate) fn link_snippets(glue: &str, dir: &str) -> String {
    let prefix = format!("./{dir}/");
    let mut linked = String::with_capacity(glue.len());
    for line in glue.split_inclusive('\n') {
        if let Some(specifier) = import_specifier(line).filter(|s| s.starts_with("./snippets/")) {
            let start = line.find(specifier).unwrap();
            linked.push_str(&line[..start]);
            linked.push_str(&prefix);
            linked.push_str(&line[start + "./snippets/".len()..]);
        } else {
            linked.push_str(line);
        }
    }
    linked
}

/// The glue wasm-bindgen `version` wrote (`--target web`), for `nsh.js`: an
/// import of a module wasm-bindgen does not provide (`import * as import1
/// from "nsh"`, the module's own imports, which `nsh.js` gives) becomes an
/// empty object `nsh.js` fills; and the import table (`__wbg_get_imports`)
/// and setup (`__wbg_finalize_init`) are exported, as `__nsh_imports` and
/// `__nsh_finalize`. Glue of another shape is refused: one without those
/// functions, or one that still imports a module a page cannot load.
pub(crate) fn adapt(glue: &str, version: &str) -> anyhow::Result<String> {
    for function in ["__wbg_get_imports", "__wbg_finalize_init"] {
        if !glue.contains(&format!("function {function}(")) {
            bail!(
                "the glue wasm-bindgen {version} wrote has no {function}: nsh knows the glue of wasm-bindgen {KNOWN} (--target web)"
            );
        }
    }
    let mut out = String::with_capacity(glue.len() + 128);
    for line in glue.lines() {
        match foreign_import(line) {
            Some(binding) => out.push_str(&format!("const {binding} = {{}};")),
            None => out.push_str(line),
        }
        out.push('\n');
    }
    out.push_str(
        "export { __wbg_get_imports as __nsh_imports, __wbg_finalize_init as __nsh_finalize };\n",
    );
    if let Some(specifier) = out
        .lines()
        .filter_map(import_specifier)
        .find(|s| is_bare(s))
    {
        bail!(
            "the glue wasm-bindgen {version} wrote imports \"{specifier}\", which a page cannot load: nsh knows the glue of wasm-bindgen {KNOWN} (--target web), and loads a crate's JS by its path (`module = \"/js/…\"`) or a URL"
        );
    }
    Ok(out)
}

/// The binding of `line` when it imports a module that is not a file
/// (`import * as import1 from "nsh"`): one of the module's own imports.
fn foreign_import(line: &str) -> Option<&str> {
    let rest = line.trim().strip_prefix("import * as ")?;
    let (binding, specifier) = rest.split_once(" from ")?;
    let specifier = specifier
        .trim()
        .trim_end_matches(';')
        .trim_matches(['"', '\'']);
    is_bare(specifier).then_some(binding.trim())
}

/// The module `line` imports or re-exports from statically (`import … from
/// "x"`, `import "x"`, `export … from "x"`, the `} from "x"` that ends an
/// import over several lines).
fn import_specifier(line: &str) -> Option<&str> {
    let line = line.trim();
    let rest = ["import", "export", "}"]
        .into_iter()
        .find_map(|keyword| line.strip_prefix(keyword))?;
    // `import(…)` and `import.meta` load nothing before the glue runs.
    if line.starts_with("import") && rest.starts_with(['(', '.']) {
        return None;
    }
    let quoted = match rest.trim_start() {
        side_effect if line.starts_with("import") && side_effect.starts_with(['"', '\'']) => {
            side_effect
        }
        _ => {
            // Module paths can themselves contain `from`.
            let first_quote = rest.find(['"', '\''])?;
            let from = rest[..first_quote].rfind("from")?;
            rest[from + "from".len()..].trim_start()
        }
    };
    let quote = quoted.chars().next().filter(|c| matches!(c, '"' | '\''))?;
    let (specifier, _) = quoted[1..].split_once(quote)?;
    Some(specifier)
}

/// Whether a page cannot load `specifier`: neither a path relative to the
/// glue or the site (`./`, `../`, `/`) nor a URL.
fn is_bare(specifier: &str) -> bool {
    const LOADABLE: [&str; 7] = ["./", "../", "/", "http://", "https://", "data:", "blob:"];
    !LOADABLE.iter().any(|start| specifier.starts_with(start))
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{Linked, adapt, check_cli, install, link_snippets, needs, read_module, snippets};

    /// Real glue: what wasm-bindgen 0.2.129 (`--target web --no-typescript
    /// --omit-default-module-path --out-name nsh`) wrote for a crate with an
    /// `inline_js` snippet that imports a `module = "/js/shout.js"` one, a
    /// `web_sys::console::log_1` call, and raw imports of `nsh` and `env`, as
    /// the runtime has.
    const GLUE_0_2_129: &str = include_str!("bindgen/wasm-bindgen-0.2.129.js");

    /// A module with `imports` (`(module, field)`, functions of type 0) and
    /// custom sections (`(name, payload)`).
    fn module(imports: &[(&str, &str)], customs: &[(&str, &[u8])]) -> Vec<u8> {
        fn leb(out: &mut Vec<u8>, mut n: usize) {
            while n >= 0x80 {
                out.push((n & 0x7f) as u8 | 0x80);
                n >>= 7;
            }
            out.push(n as u8);
        }
        fn name(out: &mut Vec<u8>, name: &str) {
            leb(out, name.len());
            out.extend(name.as_bytes());
        }
        let mut wasm = b"\0asm\x01\0\0\0".to_vec();
        // One type, `() -> ()`.
        wasm.extend([1, 4, 1, 0x60, 0, 0]);
        let mut section = vec![imports.len() as u8];
        for (module, field) in imports {
            name(&mut section, module);
            name(&mut section, field);
            section.extend([0, 0]);
        }
        // An imported memory and table, whose limits are skipped.
        name(&mut section, "env");
        name(&mut section, "memory");
        section.extend([2, 1, 17, 0x80, 0x02]);
        name(&mut section, "env");
        name(&mut section, "table");
        section.extend([1, 0x70, 0, 3]);
        section[0] += 2;
        wasm.push(2);
        leb(&mut wasm, section.len());
        wasm.extend(section);
        for (custom, payload) in customs {
            let mut section = Vec::new();
            name(&mut section, custom);
            section.extend(*payload);
            wasm.push(0);
            leb(&mut wasm, section.len());
            wasm.extend(section);
        }
        wasm
    }

    /// A `__wasm_bindgen_unstable` section's first record.
    fn bindgen_section(version: &str) -> Vec<u8> {
        let json = format!(r#"{{"schema_version":"0.2.128","version":"{version}"}}"#);
        let mut payload = (json.len() as u32).to_le_bytes().to_vec();
        payload.extend(json.as_bytes());
        payload.extend([3, 0, 0, 0, 1, 2, 3]);
        payload
    }

    #[test]
    fn wasm_bindgen_is_needed_by_a_module_that_calls_js_through_it() {
        let section = bindgen_section("0.2.129");
        let customs: &[(&str, &[u8])] =
            &[("producers", b"x"), ("__wasm_bindgen_unstable", &section)];
        // What linking wasm-bindgen brings (chrono's default `wasmbind`
        // without a call of `now`): its intrinsics only.
        let linked = module(
            &[
                ("nsh", "now_ms"),
                ("__wbindgen_placeholder__", "__wbindgen_describe"),
                ("__wbindgen_placeholder__", "__wbindgen_throw"),
                (
                    "__wbindgen_placeholder__",
                    "__wbg___wbindgen_throw_41e9ee4f547fc59a",
                ),
                (
                    "__wbindgen_externref_xform__",
                    "__wbindgen_externref_table_grow",
                ),
            ],
            customs,
        );
        assert_eq!(
            read_module(&linked),
            Ok(Linked {
                bindings: false,
                version: Some("0.2.129".into())
            })
        );
        assert_eq!(needs(&linked).unwrap(), None);
        // A call of a JS function.
        let calls = module(
            &[
                ("nsh", "now_ms"),
                ("__wbindgen_placeholder__", "__wbindgen_describe"),
                ("__wbindgen_placeholder__", "__wbg_getTime_f5a55efff2585d5d"),
            ],
            customs,
        );
        assert_eq!(needs(&calls).unwrap().as_deref(), Some("0.2.129"));
        // A git build of wasm-bindgen adds its revision.
        let section = bindgen_section("0.2.129 (0123456789)");
        let git = module(
            &[("__wbindgen_placeholder__", "__wbg_log_17c30ef363c61cf4")],
            &[("__wasm_bindgen_unstable", &section)],
        );
        assert_eq!(needs(&git).unwrap().as_deref(), Some("0.2.129"));
        // Without the section the CLI could not run.
        let stripped = module(
            &[("__wbindgen_placeholder__", "__wbg_log_17c30ef363c61cf4")],
            &[],
        );
        let error = needs(&stripped).unwrap_err().to_string();
        assert!(error.contains("__wasm_bindgen_unstable"), "{error}");
        // No wasm-bindgen at all.
        assert_eq!(needs(&module(&[("nsh", "now_ms")], &[])).unwrap(), None);
        assert!(needs(b"\0asm\x01\0\0\0").unwrap().is_none());
        assert!(needs(b"not wasm").is_err());
        let mut cut = calls.clone();
        cut.truncate(cut.len() - 3);
        assert!(needs(&cut).is_err());
    }

    /// JsValue operations need glue even without a web-sys/js-sys extern.
    #[test]
    fn wasm_bindgen_is_needed_by_intrinsics_and_generic_casts() {
        let section = bindgen_section("0.2.129");
        for field in [
            "__wbg___wbindgen_string_get_0380ccaa2f57f0d9",
            "__wbindgen_describe_generic_import",
            "__wbindgen_object_drop_ref",
            // Older wasm-bindgen versions imported intrinsics directly.
            "__wbindgen_string_new",
            "__wbindgen_string_get",
        ] {
            let wasm = module(
                &[("__wbindgen_placeholder__", field)],
                &[("__wasm_bindgen_unstable", &section)],
            );
            assert_eq!(needs(&wasm).unwrap().as_deref(), Some("0.2.129"), "{field}");
        }
    }

    #[test]
    fn wasm_bindgen_cli_must_be_the_crate_s_version() {
        assert!(check_cli("0.2.129", Some("wasm-bindgen 0.2.129\n")).is_ok());
        let other = check_cli("0.2.129", Some("wasm-bindgen 0.2.126"))
            .unwrap_err()
            .to_string();
        assert!(other.contains("through wasm-bindgen 0.2.129"), "{other}");
        assert!(other.contains("the wasm-bindgen CLI is 0.2.126"), "{other}");
        assert!(
            other.contains("cargo install wasm-bindgen-cli --version 0.2.129 --locked"),
            "{other}"
        );
        let none = check_cli("0.2.129", None).unwrap_err().to_string();
        assert!(
            none.contains("cargo install wasm-bindgen-cli --version 0.2.129"),
            "{none}"
        );
    }

    #[test]
    fn snippet_paths_containing_from_are_relocated_without_changing_wasm_keys() {
        let glue = "import { first } from './snippets/from-app-123/inline0.js';\n\
                    import { shout } from \"./snippets/app-123/js/from.js\";\n\
                    const imports = { './snippets/from-app-123/inline0.js': { first } };\n";
        let linked = link_snippets(glue, "snippets.0123456789");
        assert_eq!(
            linked,
            "import { first } from './snippets.0123456789/from-app-123/inline0.js';\n\
             import { shout } from \"./snippets.0123456789/app-123/js/from.js\";\n\
             const imports = { './snippets/from-app-123/inline0.js': { first } };\n"
        );
    }

    #[test]
    fn wasm_bindgen_snippets_are_found_beside_the_glue() {
        let out = std::env::temp_dir().join(format!("nsh-bindgen-snippets-{}", std::process::id()));
        let glue = out.join("nsh-bindgen.js");
        let inline = super::output_dir(&glue).join("snippets/app-ab472218d0dc7732/inline0.js");
        let module = super::output_dir(&glue).join("snippets/app-ab472218d0dc7732/js/shout.js");
        std::fs::create_dir_all(module.parent().unwrap()).unwrap();
        std::fs::write(&inline, "import { shout } from './js/shout.js';").unwrap();
        std::fs::write(&module, "export function shout() {}").unwrap();
        let found = snippets(&glue).unwrap();
        assert_eq!(
            found,
            [
                (
                    "snippets/app-ab472218d0dc7732/inline0.js".to_owned(),
                    inline
                ),
                (
                    "snippets/app-ab472218d0dc7732/js/shout.js".to_owned(),
                    module
                ),
            ]
        );
        // No snippets: none.
        assert!(snippets(&out.join("other-bindgen.js")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn wasm_bindgen_glue_takes_nsh_s_imports_from_nsh_js() {
        let adapted = adapt(GLUE_0_2_129, "0.2.129").unwrap();
        assert!(adapted.contains("\nconst import1 = {};\n"), "{adapted}");
        assert!(adapted.contains("\nconst import2 = {};\n"), "{adapted}");
        assert!(!adapted.contains("from \"nsh\""), "{adapted}");
        // Files the glue ships with stay imports.
        assert!(
            adapted.starts_with(
                "import { twice } from './snippets/app-ab472218d0dc7732/inline0.js';\n"
            ),
            "{adapted}"
        );
        assert!(adapted.ends_with(
            "export { __wbg_get_imports as __nsh_imports, __wbg_finalize_init as __nsh_finalize };\n"
        ));
        // The glue fetches no module of its own (`--omit-default-module-path`).
        assert!(!adapted.contains("_bg.wasm"), "{adapted}");
        // Another shape of glue is refused, not shipped broken: one without
        // the functions nsh.js calls,
        let error = adapt("export default function init() {}", "0.3.0")
            .unwrap_err()
            .to_string();
        assert!(error.contains("wasm-bindgen 0.3.0"), "{error}");
        assert!(error.contains("__wbg_get_imports"), "{error}");
        assert!(error.contains("wasm-bindgen 0.2.129"), "{error}");
        // or one whose imports a page cannot load.
        for import in [
            "import { wasm } from \"nsh\";",
            "import 'nsh';",
            "export { a } from \"pkg\";",
            "} from 'pkg';",
        ] {
            let glue = GLUE_0_2_129.replacen("\n", &format!("\n{import}\n"), 1);
            let error = adapt(&glue, "0.2.129").unwrap_err().to_string();
            assert!(
                error.contains("which a page cannot load"),
                "{import}: {error}"
            );
            assert!(error.contains("wasm-bindgen 0.2.129"), "{error}");
        }
        // Paths and URLs load.
        for import in [
            "import { a } from \"../x.js\";",
            "import \"/y.js\";",
            "export { b } from 'https://example.com/b.js';",
            "const meta = import.meta.url;",
        ] {
            let glue = GLUE_0_2_129.replacen("\n", &format!("\n{import}\n"), 1);
            assert!(adapt(&glue, "0.2.129").is_ok(), "{import}");
        }
    }

    #[test]
    fn a_runtime_without_wasm_bindgen_drops_the_glue_of_an_earlier_build() {
        let out = std::env::temp_dir().join(format!("nsh-bindgen-install-{}", std::process::id()));
        let built = out.join("built/app_web.wasm");
        std::fs::create_dir_all(built.parent().unwrap()).unwrap();
        // It links wasm-bindgen and calls no JS through it.
        let section = bindgen_section("0.2.129");
        let wasm = module(
            &[("__wbindgen_placeholder__", "__wbindgen_describe")],
            &[("__wasm_bindgen_unstable", &section)],
        );
        std::fs::write(&built, &wasm).unwrap();
        // What a build that called JS through it left.
        let glue = out.join("nsh-dev-bindgen.js");
        let snippet = super::output_dir(&glue).join("snippets/app-1/inline0.js");
        std::fs::create_dir_all(snippet.parent().unwrap()).unwrap();
        std::fs::write(&glue, "export {};").unwrap();
        std::fs::write(&snippet, "export const a = 1;").unwrap();
        std::fs::create_dir_all(out.join("nsh-dev-bindgen.tmp")).unwrap();
        // Another kind's glue stays.
        let other = out.join("nsh-bindgen.js");
        std::fs::write(&other, "export {};").unwrap();
        assert_eq!(install(&built, &out, "nsh-dev").unwrap(), None);
        assert_eq!(std::fs::read(out.join("nsh-dev.wasm")).unwrap(), wasm);
        assert!(!glue.exists());
        assert!(!super::output_dir(&glue).exists());
        assert!(!out.join("nsh-dev-bindgen.tmp").exists());
        assert!(snippets(&glue).unwrap().is_empty());
        assert!(other.exists());
        // Again, with nothing to remove.
        assert_eq!(install(&built, &out, "nsh-dev").unwrap(), None);
        let _ = std::fs::remove_dir_all(&out);
    }

    /// End to end with the `wasm-bindgen` CLI on `PATH` (or
    /// `NSH_WASM_BINDGEN`): builds a crate that calls JS through
    /// wasm-bindgen of the CLI's version for `wasm32-unknown-unknown` and
    /// installs it as a web runtime. Needs the target and the crates
    /// (network, or Cargo's cache), plus Node.js to instantiate both the
    /// development and published modules:
    /// `cargo test -p nsh-cli bindgen -- --ignored`.
    #[test]
    #[ignore = "needs the wasm-bindgen CLI, the wasm32 target, crates.io and Node.js"]
    fn wasm_bindgen_runs_on_a_real_module() {
        let printed = std::process::Command::new(super::cli())
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .expect("the wasm-bindgen CLI is installed");
        let version = super::cli_version(&printed).unwrap().to_owned();
        let root = std::env::temp_dir().join(format!("nsh-bindgen-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let write = |path: &str, text: &str| {
            let path = root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            "Cargo.toml",
            &format!(
                "[package]\nname = \"app\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\
                 [lib]\ncrate-type = [\"cdylib\"]\n\
                 [dependencies]\nwasm-bindgen = \"={version}\"\n[workspace]\n"
            ),
        );
        write(
            "js/from.js",
            "export function shout(text) { return text.toUpperCase(); }\n",
        );
        write(
            "src/lib.rs",
            r#"use wasm_bindgen::prelude::*;

#[link(wasm_import_module = "nsh")]
extern "C" {
    fn now_ms() -> f64;
}

#[wasm_bindgen(inline_js = "import { shout } from './js/from.js'; export function twice(s) { return shout(s + s); }")]
extern "C" {
    fn twice(s: &str) -> String;
}

#[wasm_bindgen(inline_js = "export function first(x) { return x + 3; }")]
extern "C" {
    fn first(x: f64) -> f64;
}

#[wasm_bindgen(inline_js = "export function second(x) { return x * 7; }")]
extern "C" {
    fn second(x: f64) -> f64;
}

#[wasm_bindgen(module = "/js/from.js")]
extern "C" {
    fn shout(s: &str) -> String;
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[no_mangle]
pub extern "C" fn probe() -> f64 {
    // SAFETY: The test host supplies the clock import.
    log(&twice(&shout(&unsafe { now_ms() }.to_string())));
    second(first(3.0))
}
"#,
        );
        let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
        let status = std::process::Command::new(cargo)
            .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
            .arg("--manifest-path")
            .arg(root.join("Cargo.toml"))
            .env("CARGO_TARGET_DIR", root.join("target"))
            .status()
            .unwrap();
        assert!(status.success(), "the crate builds");
        let built = root.join("target/wasm32-unknown-unknown/release/app.wasm");
        assert_eq!(
            needs(&std::fs::read(&built).unwrap()).unwrap(),
            Some(version.clone())
        );
        let out = root.join("web-runtime");
        std::fs::create_dir_all(&out).unwrap();
        // Snippets are ES modules, including on Node versions without
        // automatic module-syntax detection for `.js` files.
        std::fs::write(out.join("package.json"), r#"{"type":"module"}"#).unwrap();
        let glue = install(&built, &out, "nsh").unwrap().expect("a glue");
        assert_eq!(glue, out.join("nsh-bindgen.js"));
        // The module wasm-bindgen wrote: its imports are the glue's now.
        let wasm = std::fs::read(out.join("nsh.wasm")).unwrap();
        assert_eq!(needs(&wasm).unwrap(), None);
        assert!(!out.join("nsh-bindgen/nsh_bg.wasm").exists());
        assert!(!out.join("nsh-bindgen.tmp").exists());
        let found: Vec<String> = snippets(&glue)
            .unwrap()
            .into_iter()
            .map(|(path, _)| path)
            .collect();
        assert_eq!(found.len(), 4, "{found:?}");
        assert!(
            found.iter().any(|p| p.ends_with("/inline0.js")),
            "{found:?}"
        );
        assert!(
            found.iter().any(|p| p.ends_with("/js/from.js")),
            "{found:?}"
        );
        // Run the actual glue and Wasm, including wasm-bindgen's direct
        // numeric imports: their module names must match the Wasm binary
        // even when publication relocates the JS files.
        for directory in ["snippets", "snippets.0123456789"] {
            for (name, file) in snippets(&glue).unwrap() {
                let path = out
                    .join(directory)
                    .join(name.strip_prefix("snippets/").unwrap());
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::copy(file, path).unwrap();
            }
            if directory != "snippets" {
                // Publication must work without the development paths.
                std::fs::remove_dir_all(out.join("snippets")).unwrap();
            }
            let text = std::fs::read_to_string(&glue).unwrap();
            let text = link_snippets(&text, directory);
            let text = nsh_bundler::minify_module("nsh-bindgen.js", &text).unwrap();
            let linked = out.join(format!("{directory}.mjs"));
            std::fs::write(&linked, text).unwrap();
            let result = std::process::Command::new("node")
                .args([
                    "--input-type=module",
                    "-e",
                    r#"
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const glue = await import(pathToFileURL(process.argv[1]));
const module = await WebAssembly.compile(await readFile(process.argv[2]));
const imports = glue.__nsh_imports();
imports.nsh = { now_ms: () => 12 };
const instance = await WebAssembly.instantiate(module, imports);
glue.__nsh_finalize(instance, module);
assert.equal(instance.exports.probe(), 42);
"#,
                ])
                .arg(linked)
                .arg(out.join("nsh.wasm"))
                .output()
                .expect("Node.js runs the generated module");
            assert!(
                result.status.success(),
                "{directory}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert_eq!(String::from_utf8_lossy(&result.stdout).trim(), "1212");
        }
        // Built again, it replaces the output.
        assert_eq!(install(&built, &out, "nsh").unwrap(), Some(glue.clone()));
        assert_eq!(snippets(&glue).unwrap().len(), 4);
        // A CLI of another version leaves it as it was.
        let error = super::process(&built, "0.0.1", &out, "nsh").unwrap_err();
        assert!(error.to_string().contains("0.0.1"), "{error}");
        assert!(glue.exists() && Path::new(&out.join("nsh.wasm")).exists());
        // Only JsValue intrinsics, without web-sys or an extern JS call.
        write(
            "src/lib.rs",
            r#"#[no_mangle]
pub extern "C" fn probe() {
    let value = wasm_bindgen::JsValue::from_str("hello");
    assert_eq!(value.as_string().as_deref(), Some("hello"));
}
"#,
        );
        let status =
            std::process::Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()))
                .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
                .arg("--manifest-path")
                .arg(root.join("Cargo.toml"))
                .env("CARGO_TARGET_DIR", root.join("target"))
                .status()
                .unwrap();
        assert!(status.success());
        assert_eq!(
            needs(&std::fs::read(&built).unwrap()).unwrap(),
            Some(version)
        );
        let glue = install(&built, &out, "nsh")
            .unwrap()
            .expect("intrinsics need glue");
        assert!(
            std::fs::read_to_string(glue)
                .unwrap()
                .contains("__nsh_imports")
        );
        assert!(snippets(&out.join("nsh-bindgen.js")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
