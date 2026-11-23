//! The Android resources (`res/`) of the AARs a package carries: where they
//! go in `aapt2 link` and the `R` classes their code reads them through.
//!
//! A library's resources are overlays under NSH's own: the package's own
//! resources win over the app's libraries, which win over its crates'.
//! A library's code is compiled against `R` fields its build had no final
//! values for; its `R.txt` lists them, with those of the libraries it was
//! built with, and the package gives each one a library listed defines the
//! id `aapt2 link` settled on. One no library listed defines is left out,
//! unless code reads it (its class file refers to the field).

use std::{
    collections::BTreeMap,
    ffi::OsString,
    fmt::Write as _,
    path::{Path, PathBuf},
};

/// A symbol of an `R.txt`, by (type, name): `string hello`,
/// `styleable My_View`.
pub(super) type Symbols = BTreeMap<(String, String), Symbol>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Symbol {
    /// `int[]` (a styleable's attributes) rather than `int`.
    pub(super) array: bool,
    /// As `R.txt` has it: `0x7f010000`, `0`, `{ 0x0101014f, 0x7f010000 }`.
    pub(super) value: String,
}

/// Reads a library's `R.txt`: one `<int|int[]> <type> <name> <value>` a
/// line, each name a Java name, as its `R` class has them.
pub(super) fn parse_symbols(text: &str) -> Result<Symbols, String> {
    parse(text, true)
}

/// Reads what `aapt2 link --output-text-symbols` wrote: every resource of
/// the package, the app's own among them, whose names are no Java names
/// unless a library's code reads them ([`r_java`] checks those).
pub(super) fn parse_linked(text: &str) -> Result<Symbols, String> {
    parse(text, false)
}

fn parse(text: &str, java_names: bool) -> Result<Symbols, String> {
    let mut out = Symbols::new();
    for (number, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(4, ' ');
        let (Some(kind), Some(kind_of), Some(name), Some(value)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return Err(format!("line {}: `{line}` is no symbol", number + 1));
        };
        let array = match kind {
            "int" => false,
            "int[]" => true,
            _ => return Err(format!("line {}: `{kind}` is no symbol kind", number + 1)),
        };
        if java_names && (!identifier(kind_of) || !identifier(name)) {
            return Err(format!(
                "line {}: `{kind_of} {name}` is no Java name",
                number + 1
            ));
        }
        out.insert(
            (kind_of.to_owned(), name.to_owned()),
            Symbol {
                array,
                value: value.trim().to_owned(),
            },
        );
    }
    Ok(out)
}

/// The fields of a library's `R` that code reads, by (type, name): the
/// class that reads it, by Java name.
pub(super) type Reads = BTreeMap<(String, String), String>;

/// The library package and the resource type of the class `class` (by
/// internal name) when it is one of an `R` class: `com/example/R$string`.
pub(super) fn r_type(class: &str) -> Option<(String, &str)> {
    let (package, simple) = class.rsplit_once('/').unwrap_or(("", class));
    let kind_of = simple.strip_prefix("R$")?;
    (!kind_of.is_empty() && !kind_of.contains('$')).then(|| (package.replace('/', "."), kind_of))
}

/// `R.java` of the library `package`, with each field of `wanted` (its
/// `R.txt`) and `read` (what code reads of it) that `linked` (what `aapt2
/// link` wrote) has, the value `linked` gives it; and how many of `wanted`
/// it leaves out, which no library listed defines. A field `read` has that
/// `linked` has not is an error naming the class that reads it.
pub(super) fn r_java(
    package: &str,
    wanted: &Symbols,
    read: &Reads,
    linked: &Symbols,
) -> Result<(String, usize), Vec<String>> {
    if !package.split('.').all(identifier) {
        return Err(vec![format!("`{package}` is no Java package")]);
    }
    if let Some(word) = package.split('.').find(|part| keyword(part)) {
        return Err(vec![format!(
            "its package `{package}` has the Java keyword `{word}`, which no `R` class can be in"
        )]);
    }
    let fields: std::collections::BTreeSet<&(String, String)> =
        wanted.keys().chain(read.keys()).collect();
    let mut out = format!("package {package};\n\npublic final class R {{\n");
    let mut open: Option<&str> = None;
    let mut left_out = 0;
    let mut errors = Vec::new();
    for key @ (kind_of, name) in fields {
        let reader = read.get(key);
        let Some(have) = linked.get(key) else {
            match reader {
                Some(class) => errors.push(format!(
                    "`{class}` reads `R.{kind_of}.{name}`, which no Android library listed defines"
                )),
                None => left_out += 1,
            }
            continue;
        };
        if let Some(word) = [kind_of, name].into_iter().find(|part| keyword(part)) {
            errors.push(format!(
                "`R.{kind_of}.{name}`: the Java keyword `{word}` names no `R` field"
            ));
            continue;
        }
        if !identifier(kind_of) || !identifier(name) {
            errors.push(format!("`R.{kind_of}.{name}` is no Java name"));
            continue;
        }
        if let Some(symbol) = wanted.get(key)
            && have.array != symbol.array
        {
            errors.push(format!(
                "its code takes `R.{kind_of}.{name}` as {}, the package has {}",
                java_type(symbol.array),
                java_type(have.array)
            ));
            continue;
        }
        if open != Some(kind_of) {
            if open.is_some() {
                out.push_str("    }\n");
            }
            let _ = writeln!(out, "    public static final class {kind_of} {{");
            open = Some(kind_of);
        }
        let _ = writeln!(
            out,
            "        public static final {} {name} = {};",
            java_type(have.array),
            have.value
        );
    }
    if open.is_some() {
        out.push_str("    }\n");
    }
    out.push_str("}\n");
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok((out, left_out))
}

fn java_type(array: bool) -> &'static str {
    if array { "int[]" } else { "int" }
}

/// A Java identifier as `R.txt` names types and fields.
fn identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// A word Java reserves, which no identifier is.
fn keyword(text: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "abstract",
        "assert",
        "boolean",
        "break",
        "byte",
        "case",
        "catch",
        "char",
        "class",
        "const",
        "continue",
        "default",
        "do",
        "double",
        "else",
        "enum",
        "extends",
        "false",
        "final",
        "finally",
        "float",
        "for",
        "goto",
        "if",
        "implements",
        "import",
        "instanceof",
        "int",
        "interface",
        "long",
        "native",
        "new",
        "null",
        "package",
        "private",
        "protected",
        "public",
        "return",
        "short",
        "static",
        "strictfp",
        "super",
        "switch",
        "synchronized",
        "this",
        "throw",
        "throws",
        "transient",
        "true",
        "try",
        "void",
        "volatile",
        "while",
        "_",
    ];
    KEYWORDS.contains(&text)
}

/// The resources `aapt2 link` takes: `own` (the package's) as they are
/// when no library has any. Else the libraries are overlays (`-R`, of which
/// a later one wins), lowest first, and `own` one more over them all,
/// besides as it is, where two of its files that define one resource are
/// still an error. A style an overlay defines again is replaced whole, not
/// joined item by item, as Android's Gradle plugin merges them.
pub(super) fn link_inputs(own: &[PathBuf], libraries: &[PathBuf]) -> Vec<OsString> {
    let mut out: Vec<OsString> = own.iter().map(|p| p.clone().into_os_string()).collect();
    if libraries.is_empty() {
        return out;
    }
    for path in libraries.iter().chain(own) {
        out.push("-R".into());
        out.push(path.clone().into_os_string());
    }
    out.push("--auto-add-overlay".into());
    out.push("--override-styles-instead-of-overlaying".into());
    out
}

/// A resource a file under `res/` defines.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Defined {
    /// `mipmap`, `color`, `style`...
    pub(super) kind: String,
    pub(super) name: String,
    /// The directory's qualifiers: `anydpi-v26`, `night`, empty for none.
    pub(super) config: String,
}

/// What the file `path` under `res/` (`<type>[-<qualifiers>]/<file>`)
/// defines: a values file (`values[-<qualifiers>]/*.xml`) the resources of
/// its elements, `true`; another one the resource it is, `false`.
pub(super) fn defined(path: &str, bytes: &[u8]) -> Result<(bool, Vec<Defined>), String> {
    let Some((dir, file)) = path.split_once('/') else {
        return Err(format!("`{path}` is in no resource directory"));
    };
    let (kind, config) = dir.split_once('-').unwrap_or((dir, ""));
    if kind != "values" {
        let name = file.split('.').next().unwrap_or(file);
        let one = Defined {
            kind: kind.to_owned(),
            name: name.to_owned(),
            config: config.to_owned(),
        };
        return Ok((false, vec![one]));
    }
    let mut reader = quick_xml::Reader::from_reader(bytes);
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut buf = Vec::new();
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|e| format!("`{path}` is no XML: {e}"))?;
        let (element, opens) = match &event {
            quick_xml::events::Event::Start(e) => (Some(e.clone()), true),
            quick_xml::events::Event::Empty(e) => (Some(e.clone()), false),
            quick_xml::events::Event::End(_) => {
                depth = depth.saturating_sub(1);
                (None, false)
            }
            quick_xml::events::Event::Eof => break,
            _ => (None, false),
        };
        if let Some(element) = element {
            // `<resources>`'s own children.
            if depth == 1 {
                let attribute = |key: &str| {
                    element
                        .attributes()
                        .flatten()
                        .find(|a| a.key.as_ref() == key)
                        .and_then(|a| {
                            a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                                .map(|v| v.into_owned())
                        })
                };
                let tag = element.local_name().as_ref().to_owned();
                let kind = match tag.as_str() {
                    "item" => attribute("type"),
                    "string-array" | "integer-array" | "array" => Some("array".to_owned()),
                    "declare-styleable" => Some("styleable".to_owned()),
                    "public" | "eat-comment" | "skip" => None,
                    _ => Some(tag),
                };
                if let (Some(kind), Some(name)) = (kind, attribute("name")) {
                    out.push(Defined {
                        kind,
                        name,
                        config: config.to_owned(),
                    });
                }
            }
            if opens {
                depth += 1;
            }
        }
        buf.clear();
    }
    Ok((true, out))
}

/// The files of `res` (a library's: path under `res/`, contents) that the
/// package leaves out: those of resources `own` (what NSH generates for the
/// package: its icon, launch screen, notification sounds) has, in whichever
/// configuration, as the device would take the library's for a
/// configuration NSH has none for. A values file defining one for such a
/// configuration is an error, which leaving it out would not do alone.
pub(super) fn left_out(
    own: &std::collections::BTreeSet<Defined>,
    res: &[(String, Vec<u8>)],
) -> Result<Vec<String>, String> {
    let owns = |d: &Defined| own.iter().any(|o| o.kind == d.kind && o.name == d.name);
    let mut out = Vec::new();
    for (path, bytes) in res {
        let (values, defines) = defined(path, bytes)?;
        if !values {
            if defines.iter().any(owns) {
                out.push(path.clone());
            }
            continue;
        }
        if let Some(d) = defines.iter().find(|d| owns(d) && !own.contains(d)) {
            return Err(format!(
                "its `res/{path}` defines `@{}/{}`, which NSH makes for the package \
                 (its icon, launch screen or notification sounds)",
                d.kind, d.name
            ));
        }
    }
    Ok(out)
}

/// What the resource files NSH wrote under `dir` define.
pub(super) fn generated(dir: &Path) -> anyhow::Result<std::collections::BTreeSet<Defined>> {
    let mut out = std::collections::BTreeSet::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let sub = entry?.path();
        let Some(dir_name) = sub.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        for file in std::fs::read_dir(&sub)? {
            let file = file?.path();
            let Some(name) = file.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let (_, defines) = defined(&format!("{dir_name}/{name}"), &std::fs::read(&file)?)
                .map_err(anyhow::Error::msg)?;
            out.extend(defines);
        }
    }
    Ok(out)
}

/// `libraries` (who lists each: `None` for the app, else its crate),
/// lowest priority first, as [`link_inputs`] takes them: the crates' by
/// crate name, then the app's; of one, a later listed below an earlier.
pub(super) fn lowest_first<T>(mut libraries: Vec<(Option<String>, T)>) -> Vec<T> {
    // Stable: the listed order stays within one crate.
    libraries.sort_by(|(a, _), (b, _)| (a.is_some(), a).cmp(&(b.is_some(), b)));
    libraries.into_iter().rev().map(|(_, t)| t).collect()
}

/// The file of `package`'s `R.java` under `dir`.
pub(super) fn r_java_path(dir: &Path, package: &str) -> PathBuf {
    let mut path = dir.to_owned();
    path.extend(package.split('.'));
    path.join("R.java")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbols_are_read_by_type_and_name() {
        let symbols = parse_symbols(
            "int attr tint 0x7f010000\n\
             int[] styleable My_View { 0x0101014f, 0x7f010000 }\n\
             \n\
             int styleable My_View_tint 1\n",
        )
        .unwrap();
        let get =
            |kind_of: &str, name: &str| symbols[&(kind_of.to_owned(), name.to_owned())].clone();
        assert_eq!(
            get("attr", "tint"),
            Symbol {
                array: false,
                value: "0x7f010000".into()
            }
        );
        assert_eq!(
            get("styleable", "My_View"),
            Symbol {
                array: true,
                value: "{ 0x0101014f, 0x7f010000 }".into()
            }
        );
        assert_eq!(get("styleable", "My_View_tint").value, "1");
        for (text, error) in [
            ("int attr tint", "line 1: `int attr tint` is no symbol"),
            ("long attr tint 1", "line 1: `long` is no symbol kind"),
            (
                "int string a;static{} 1",
                "line 1: `string a;static{}` is no Java name",
            ),
        ] {
            assert_eq!(parse_symbols(text).unwrap_err(), error);
        }
    }

    #[test]
    fn a_librarys_r_class_has_the_fields_it_lists_with_the_ids_the_package_gave() {
        // `aapt2 link --output-text-symbols`: every resource of the package,
        // styleable indices in the order of the attributes' ids.
        let linked = parse_symbols(
            "int attr tint 0x7f010000\n\
             int id root 0x7f020000\n\
             int layout main 0x7f040000\n\
             int string hello 0x7f050000\n\
             int string other 0x7f050001\n\
             int[] styleable My_View { 0x0101014f, 0x7f010000 }\n\
             int styleable My_View_android_text 0\n\
             int styleable My_View_tint 1\n",
        )
        .unwrap();
        // The library's own `R.txt`: its build's values, which do not count.
        let wanted = parse_symbols(
            "int string hello 0x7f0b0001\n\
             int layout main 0x7f080000\n\
             int[] styleable My_View { 0x7f030001, 0x0101014f }\n\
             int styleable My_View_tint 0\n\
             int styleable My_View_android_text 1\n",
        )
        .unwrap();
        assert_eq!(
            r_java("com.example.lib", &wanted, &Reads::new(), &linked)
                .unwrap()
                .0,
            "package com.example.lib;

public final class R {
    public static final class layout {
        public static final int main = 0x7f040000;
    }
    public static final class string {
        public static final int hello = 0x7f050000;
    }
    public static final class styleable {
        public static final int[] My_View = { 0x0101014f, 0x7f010000 };
        public static final int My_View_android_text = 0;
        public static final int My_View_tint = 1;
    }
}
"
        );
        assert_eq!(
            r_java("com.example.lib", &Symbols::new(), &Reads::new(), &linked).unwrap(),
            (
                "package com.example.lib;\n\npublic final class R {\n}\n".to_owned(),
                0
            )
        );
        let kind = parse_symbols("int styleable My_View 0").unwrap();
        assert_eq!(
            r_java("com.example.lib", &kind, &Reads::new(), &linked).unwrap_err(),
            ["its code takes `R.styleable.My_View` as int, the package has int[]"]
        );
        assert_eq!(
            r_java("com.example-lib", &wanted, &Reads::new(), &linked).unwrap_err(),
            ["`com.example-lib` is no Java package"]
        );
        assert_eq!(
            r_java_path(Path::new("src"), "com.example.lib"),
            Path::new("src/com/example/lib/R.java")
        );
    }

    #[test]
    fn libraries_are_overlays_under_the_packages_own_resources() {
        let paths = |names: &[&str]| -> Vec<PathBuf> { names.iter().map(PathBuf::from).collect() };
        let own = paths(&["icon.flat", "compiled-app.zip"]);
        // Without libraries' resources, `aapt2 link` takes the same
        // arguments as before.
        assert_eq!(
            link_inputs(&own, &[]),
            [OsString::from("icon.flat"), "compiled-app.zip".into()]
        );
        // `aapt2 link`: of two overlays with one resource, the later wins.
        let libraries = lowest_first(vec![
            (None, "app-first.zip"),
            (Some("zeta".to_owned()), "zeta.zip"),
            (None, "app-second.zip"),
            (Some("alpha".to_owned()), "alpha-first.zip"),
            (Some("alpha".to_owned()), "alpha-second.zip"),
        ]);
        assert_eq!(
            libraries,
            [
                "zeta.zip",
                "alpha-second.zip",
                "alpha-first.zip",
                "app-second.zip",
                "app-first.zip",
            ]
        );
        let args: Vec<String> = link_inputs(&own, &paths(&libraries))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        // `own` as it is, which finds two of its files defining one
        // resource, and once more over the libraries; styles replaced whole.
        assert_eq!(
            args.join(" "),
            "icon.flat compiled-app.zip -R zeta.zip -R alpha-second.zip -R alpha-first.zip \
             -R app-second.zip -R app-first.zip -R icon.flat -R compiled-app.zip \
             --auto-add-overlay --override-styles-instead-of-overlaying"
        );
    }

    #[test]
    fn the_link_symbols_need_no_java_names_and_keywords_name_no_field() {
        // The app's own `drawable/café.png`: no library reads it.
        let linked =
            parse_linked("int drawable café 0x7f010000\nint string hi 0x7f020000\n").unwrap();
        assert_eq!(linked.len(), 2);
        let wanted = parse_symbols("int string hi 0x7f0b0000").unwrap();
        let none = Reads::new();
        assert!(r_java("com.example.lib", &wanted, &none, &linked).is_ok());
        assert_eq!(
            r_java("com.example.native", &wanted, &none, &linked).unwrap_err(),
            [
                "its package `com.example.native` has the Java keyword `native`, which no `R` class can be in"
            ]
        );
        let linked = parse_linked("int string class 0x7f020000\n").unwrap();
        let wanted = parse_symbols("int string class 0x7f0b0000").unwrap();
        assert_eq!(
            r_java("com.example.lib", &wanted, &none, &linked).unwrap_err(),
            ["`R.string.class`: the Java keyword `class` names no `R` field"]
        );
    }

    #[test]
    fn what_no_library_defines_is_left_out_unless_code_reads_it() {
        let linked = parse_linked(
            "int string title 0x7f050000\n\
             int attr tint 0x7f010000\n\
             int[] styleable Banner { 0x7f010000 }\n\
             int styleable Banner_tint 0\n",
        )
        .unwrap();
        // Built with another library: its R.txt lists that one's
        // resources too, which no library listed defines.
        let wanted = parse_symbols(
            "int anim abc_fade_in 0x7f010000\n\
             int attr colorPrimary 0x7f020000\n\
             int string title 0x7f0b0000\n\
             int[] styleable ActionBar { 0x7f020000 }\n\
             int styleable ActionBar_colorPrimary 0\n\
             int[] styleable Banner { 0x7f030000 }\n\
             int styleable Banner_tint 0\n",
        )
        .unwrap();
        let reads = |fields: &[(&str, &str)]| -> Reads {
            fields
                .iter()
                .map(|(k, n)| {
                    (
                        ((*k).to_owned(), (*n).to_owned()),
                        "com.example.lib.Banner".to_owned(),
                    )
                })
                .collect()
        };
        let read = reads(&[
            ("string", "title"),
            ("styleable", "Banner"),
            ("styleable", "Banner_tint"),
        ]);
        assert_eq!(
            r_java("com.example.lib", &wanted, &read, &linked).unwrap(),
            (
                "package com.example.lib;

public final class R {
    public static final class string {
        public static final int title = 0x7f050000;
    }
    public static final class styleable {
        public static final int[] Banner = { 0x7f010000 };
        public static final int Banner_tint = 0;
    }
}
"
                .to_owned(),
                4
            )
        );
        // A field the code reads that the R.txt has not: the package
        // defines it, so it is there.
        let java = r_java("com.example.lib", &Symbols::new(), &read, &linked)
            .unwrap()
            .0;
        assert!(java.contains("int title = 0x7f050000;"), "{java}");
        // The code reads what no library defines.
        let read = reads(&[
            ("anim", "abc_fade_in"),
            ("styleable", "ActionBar"),
            ("styleable", "ActionBar_colorPrimary"),
        ]);
        assert_eq!(
            r_java("com.example.lib", &wanted, &read, &linked).unwrap_err(),
            [
                "`com.example.lib.Banner` reads `R.anim.abc_fade_in`, which no Android library listed defines",
                "`com.example.lib.Banner` reads `R.styleable.ActionBar`, which no Android library listed defines",
                "`com.example.lib.Banner` reads `R.styleable.ActionBar_colorPrimary`, which no Android library listed defines",
            ]
        );
        assert_eq!(
            r_type("com/example/lib/R$string"),
            Some(("com.example.lib".to_owned(), "string"))
        );
        assert_eq!(r_type("R$id"), Some((String::new(), "id")));
        for class in [
            "com/example/lib/R",
            "com/example/lib/R$",
            "com/example/lib/Banner$string",
            "com/example/lib/R$string$1",
            "com/example/lib/MyR$string",
        ] {
            assert_eq!(r_type(class), None, "{class}");
        }
    }

    #[test]
    fn a_library_leaves_out_the_resources_nsh_makes_in_any_configuration() {
        let own: std::collections::BTreeSet<Defined> = [
            ("mipmap-xxxhdpi/ic_launcher.png", &b"png"[..]),
            (
                "values/ic_launcher_background.xml",
                b"<resources>\n<color name=\"ic_launcher_background\">#FFFFFFFF</color>\n</resources>",
            ),
        ]
        .into_iter()
        .flat_map(|(path, bytes)| defined(path, bytes).unwrap().1)
        .collect();
        let res = |entries: &[(&str, &str)]| -> Vec<(String, Vec<u8>)> {
            entries
                .iter()
                .map(|(p, b)| ((*p).to_owned(), b.as_bytes().to_vec()))
                .collect()
        };
        // The library's icon in other densities and as an adaptive icon.
        let library = res(&[
            ("mipmap-hdpi/ic_launcher.png", "png"),
            ("mipmap-anydpi-v26/ic_launcher.xml", "<adaptive-icon/>"),
            ("drawable/lib_logo.png", "png"),
            // The same configuration: NSH's wins anyway.
            (
                "values/values.xml",
                "<resources><color name=\"ic_launcher_background\">#000</color>\
                 <string name=\"lib\">x</string><item type=\"id\" name=\"lib_id\"/></resources>",
            ),
        ]);
        assert_eq!(
            left_out(&own, &library).unwrap(),
            [
                "mipmap-hdpi/ic_launcher.png",
                "mipmap-anydpi-v26/ic_launcher.xml"
            ]
        );
        // A values file of another configuration: an error.
        let night = res(&[(
            "values-night/values.xml",
            "<resources><color name=\"ic_launcher_background\">#000</color></resources>",
        )]);
        assert_eq!(
            left_out(&own, &night).unwrap_err(),
            "its `res/values-night/values.xml` defines `@color/ic_launcher_background`, which NSH \
             makes for the package (its icon, launch screen or notification sounds)"
        );
        let (values, defines) = defined(
            "values-v31/v.xml",
            b"<resources><style name=\"A\"><item name=\"x\">1</item></style>\
              <declare-styleable name=\"S\"><attr name=\"a\"/></declare-styleable>\
              <string-array name=\"L\"/></resources>",
        )
        .unwrap();
        assert!(values);
        let defines: Vec<String> = defines
            .iter()
            .map(|d| format!("{}/{} {}", d.kind, d.name, d.config))
            .collect();
        assert_eq!(defines, ["style/A v31", "styleable/S v31", "array/L v31"]);
    }
}
