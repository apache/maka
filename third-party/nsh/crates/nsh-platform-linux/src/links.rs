//! URL schemes that open the app (nsh.json `schemes`, `UrlScheme` of `nsh`).
//!
//! The desktop finds the app that opens `myapp://` through a `.desktop`
//! file with `MimeType=x-scheme-handler/myapp`: the runner writes its own
//! in `$XDG_DATA_HOME/applications` (the executable may move, and a
//! package unpacked anywhere still opens its links) and makes it the
//! default for its schemes. The app runs once ([`crate::run_app`]): the
//! desktop starts the executable with the URL, which GApplication hands
//! to the running instance's `open`.

use std::sync::Mutex;

use gtk4::{gio, glib, prelude::*};

/// Arguments the desktop starts the executable with before the URL.
static EXEC_ARGS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Sets the arguments the desktop entry starts the executable with before
/// the URL: a development host names the app it runs (`--app-id …`),
/// which a release runner reads from its package.
pub fn set_exec_args(args: Vec<String>) {
    *EXEC_ARGS.lock().unwrap_or_else(|e| e.into_inner()) = args;
}

/// Writes the app's desktop entry for `schemes` and the files of
/// `mime_types` (nsh.json `fileTypes`) when it is missing or differs, and
/// makes it the schemes' default handler (for files it is one of the apps
/// in Open With: the user picks the default).
pub(crate) fn register(app_id: &str, name: &str, schemes: &[String], mime_types: &[String]) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let dir = glib::user_data_dir().join("applications");
    let file = format!("{app_id}.desktop");
    let path = dir.join(&file);
    let args = EXEC_ARGS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let entry = entry(
        app_id,
        name,
        &exe.to_string_lossy(),
        &args,
        schemes,
        mime_types,
    );
    if std::fs::read_to_string(&path).ok().as_deref() != Some(entry.as_str())
        && let Err(e) = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, &entry))
    {
        log::warn!("nsh: cannot register the app's URL schemes: {e}");
        return;
    }
    for scheme in schemes {
        let kind = format!("x-scheme-handler/{scheme}");
        let current = gio::AppInfo::default_for_type(&kind, false);
        if current.and_then(|c| c.id()).as_deref() == Some(file.as_str()) {
            continue;
        }
        // xdg-utils' `xdg-mime` writes the default where this desktop reads
        // it (`mimeapps.list`).
        let made = std::process::Command::new("xdg-mime")
            .args(["default", &file, &kind])
            .status();
        if !made.is_ok_and(|s| s.success()) {
            log::warn!("nsh: cannot make the app open {scheme}: links (xdg-mime)");
        }
    }
}

/// The desktop entry: `Exec` quoted as the spec asks, the URL as `%u`, or
/// the URLs as `%U` when it opens files.
fn entry(
    app_id: &str,
    name: &str,
    exe: &str,
    args: &[String],
    schemes: &[String],
    mime_types: &[String],
) -> String {
    let quote = |arg: &str| -> String {
        let escaped: String = arg
            .chars()
            .flat_map(|c| match c {
                '"' | '`' | '$' | '\\' => vec!['\\', c],
                // `%` is a field code unless doubled.
                '%' => vec!['%', '%'],
                c => vec![c],
            })
            .collect();
        format!("\"{escaped}\"")
    };
    let exec: Vec<String> = std::iter::once(exe)
        .chain(args.iter().map(String::as_str))
        .map(quote)
        .collect();
    let exec = exec.join(" ");
    let types: String = schemes
        .iter()
        .map(|s| format!("x-scheme-handler/{s};"))
        .chain(mime_types.iter().map(|m| format!("{m};")))
        .collect();
    let field = if mime_types.is_empty() { "%u" } else { "%U" };
    format!(
        "[Desktop Entry]\nType=Application\nName={name}\nExec={exec} {field}\n\
         StartupWMClass={app_id}\nTerminal=false\nNoDisplay=true\nMimeType={types}\n"
    )
}

/// GApplication's arguments: the program, and the URLs of `schemes` and
/// the files of `file_types` among the process's arguments (what the
/// desktop started it with), which GApplication hands to `open`.
pub(crate) fn launch_args(
    schemes: &[String],
    file_types: &[nsh_core::file_type::FileType],
) -> Vec<String> {
    let mut args = std::env::args();
    let program = args.next().unwrap_or_default();
    std::iter::once(program)
        .chain(
            args.filter(|arg| is_link(arg, schemes) || file_url(arg, None, file_types).is_some()),
        )
        .collect()
}

/// The `file://` URL of `arg` (a path, relative to `cwd` or the process's
/// directory, or a `file:` URL) when it names an existing file of one of
/// `file_types`.
pub(crate) fn file_url(
    arg: &str,
    cwd: Option<&std::path::Path>,
    file_types: &[nsh_core::file_type::FileType],
) -> Option<String> {
    if file_types.is_empty() || arg.starts_with('-') {
        return None;
    }
    let file = match cwd {
        Some(cwd) => gio::File::for_commandline_arg_and_cwd(arg, cwd),
        None => gio::File::for_commandline_arg(arg),
    };
    let path = file.path()?;
    (path.is_file() && file_types.iter().any(|t| t.matches(&path))).then(|| file.uri().to_string())
}

/// Whether `arg` is a URL of one of `schemes`.
pub(crate) fn is_link(arg: &str, schemes: &[String]) -> bool {
    arg.split_once(':')
        .is_some_and(|(scheme, _)| schemes.iter().any(|s| s.eq_ignore_ascii_case(scheme)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_are_urls_of_the_schemes() {
        let schemes = vec!["myapp".to_owned()];
        assert!(is_link("myapp://open/1", &schemes));
        assert!(is_link("MyApp:x", &schemes));
        assert!(!is_link("--trace", &schemes));
        assert!(!is_link("https://x", &schemes));
    }

    #[test]
    fn entries_quote_the_executable_and_list_the_schemes() {
        let e = entry(
            "com.a.b",
            "B",
            "/opt/my \"b\"/b",
            &["--app-id".into(), "a%b".into()],
            &["b".into(), "bb".into()],
            &[],
        );
        assert!(e.contains("Exec=\"/opt/my \\\"b\\\"/b\" \"--app-id\" \"a%%b\" %u\n"));
        assert!(e.contains("MimeType=x-scheme-handler/b;x-scheme-handler/bb;\n"));
        let e = entry("com.a.b", "B", "b", &[], &[], &["video/mp4".into()]);
        assert!(e.contains("Exec=\"b\" %U\n"));
        assert!(e.contains("MimeType=video/mp4;\n"));
    }
}
