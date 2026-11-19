//! URL schemes that open the app (nsh.json `schemes`, `UrlScheme` of `nsh`).
//!
//! The desktop finds the app that opens `myapp://` through a `.desktop`
//! file with `MimeType=x-scheme-handler/myapp`, named after the app's id in
//! `$XDG_DATA_HOME/applications`. The runner makes sure that entry opens the
//! app's links and files, without taking over an entry someone else wrote:
//!
//! - none there: it writes its own, which it marks as NSH's, and rewrites
//!   whenever it differs (the executable may move, and a package unpacked
//!   anywhere still opens its links);
//! - one an installer or the user wrote whose `Exec` starts this executable
//!   (by path, or by name on the `PATH`): the types it lacks are added to
//!   its `MimeType`, and a URL field code to its `Exec` when it has none,
//!   every other line kept as it is;
//! - one that starts another executable (another copy of the app): it is
//!   left alone. The copies share the application id, so whichever runs
//!   gets the other's links through GApplication.
//!
//! An entry changes as a whole (a temporary file renamed into place). A
//! scheme becomes the app's by default (`xdg-mime default`) only when no
//! application handles it yet. The app runs once ([`crate::run_app`]): the
//! desktop starts the executable with the URL, which GApplication hands to
//! the running instance's `open`.

use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use gtk4::{gio, glib, prelude::*};

use crate::desktop_file::{escape, exec_arg, program, read, unescape, value, write_atomically};

/// Arguments the desktop starts the executable with before the URL.
static EXEC_ARGS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The key that marks an entry NSH wrote, which it may rewrite.
const GENERATED: &str = "X-NSH-Generated";

/// Sets the arguments the desktop entry starts the executable with before
/// the URL: a development host names the app it runs (`--app-id …`),
/// which a release runner reads from its package.
pub fn set_exec_args(args: Vec<String>) {
    *EXEC_ARGS.lock().unwrap_or_else(|e| e.into_inner()) = args;
}

/// Makes the app's desktop entry open `schemes` and the files of
/// `mime_types` (nsh.json `fileTypes`), as the module says, and makes the
/// app the default for the schemes no application handles yet (for files
/// it is one of the apps in Open With: the user picks the default).
pub(crate) fn register(app_id: &str, name: &str, schemes: &[String], mime_types: &[String]) {
    let Ok(exe) = nsh_core::restart::program_path() else {
        return;
    };
    let dir = glib::user_data_dir().join("applications");
    let file = format!("{app_id}.desktop");
    let path = dir.join(&file);
    let current = match read(&path) {
        Ok(current) => current,
        Err(e) => {
            log::warn!("nsh: cannot read {}: {e}", path.display());
            return;
        }
    };
    let args = EXEC_ARGS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let types = Types::new(schemes, mime_types);
    let icon = exe
        .parent()
        .map(|dir| dir.join(format!("{app_id}.png")))
        .filter(|icon| icon.is_file());
    let ours = entry(app_id, name, &exe, &args, &types, icon.as_deref());
    let this = exe.canonicalize().unwrap_or_else(|_| exe.clone());
    let starts_this =
        |program: &str| resolve(program).is_some_and(|p| p.canonicalize().is_ok_and(|p| p == this));
    let plan = plan(current.as_deref(), &ours, app_id, &types, starts_this);
    if plan == Plan::Foreign {
        log::info!(
            "nsh: {} starts another copy of the app; leaving it as it is",
            path.display()
        );
        return;
    }
    // Asked before the entry changes: once it lists a scheme, GIO answers
    // with this app for it.
    let unhandled: Vec<&str> = types
        .schemes
        .iter()
        .map(String::as_str)
        .filter(|kind| !handled(kind))
        .collect();
    if let Plan::Write(text) = plan {
        if let Err(e) = write_atomically(&dir, &path, &text) {
            log::warn!("nsh: cannot register the app's URL schemes: {e}");
            return;
        }
        // Where the directory has a MIME cache (`update-desktop-database`,
        // which `xdg-mime` reads on desktops without GIO), it would miss
        // the new types.
        if dir.join("mimeinfo.cache").exists() {
            let updated = std::process::Command::new("update-desktop-database")
                .arg(&dir)
                .status();
            if !updated.is_ok_and(|s| s.success()) {
                log::warn!("nsh: cannot update {}'s MIME cache", dir.display());
            }
        }
    }
    for kind in unhandled {
        // xdg-utils' `xdg-mime` writes the default where this desktop reads
        // it (`mimeapps.list`).
        let made = std::process::Command::new("xdg-mime")
            .args(["default", &file, kind])
            .status();
        if !made.is_ok_and(|s| s.success()) {
            log::warn!("nsh: cannot make the app open {kind} (xdg-mime)");
        }
    }
}

/// Whether an application handles `kind` already: GIO's default, which
/// falls back to any application listing it, else `xdg-mime`'s, which
/// asks the desktop's own (KDE's, say).
fn handled(kind: &str) -> bool {
    if gio::AppInfo::default_for_type(kind, false).is_some() {
        return true;
    }
    std::process::Command::new("xdg-mime")
        .args(["query", "default", kind])
        .stderr(std::process::Stdio::null())
        .output()
        .is_ok_and(|out| out.status.success() && !out.stdout.trim_ascii().is_empty())
}

/// The file `program`, the first argument of an `Exec`, starts: a path, or
/// a name looked up on the `PATH` as the desktop does.
fn resolve(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.is_absolute() {
        return Some(path.to_owned());
    }
    if program.contains('/') {
        return None;
    }
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(program))
        .find(|path| path.is_file())
}

/// The MIME types of the app's entry: its schemes' (`x-scheme-handler/…`)
/// and its files'.
struct Types {
    schemes: Vec<String>,
    all: Vec<String>,
    /// The field code `Exec` hands URLs with: `%U` (several) when it opens
    /// files, else `%u`.
    url_code: &'static str,
}

impl Types {
    fn new(schemes: &[String], mime_types: &[String]) -> Self {
        let schemes: Vec<String> = schemes
            .iter()
            .map(|s| format!("x-scheme-handler/{s}"))
            .collect();
        let mut all: Vec<String> = Vec::new();
        for kind in schemes.iter().chain(mime_types) {
            if !all.iter().any(|k| k.eq_ignore_ascii_case(kind)) {
                all.push(kind.clone());
            }
        }
        Self {
            schemes,
            all,
            url_code: if mime_types.is_empty() { "%u" } else { "%U" },
        }
    }
}

/// What the app's desktop entry needs.
#[derive(Debug, PartialEq)]
enum Plan {
    /// It opens the app's links and files as it is.
    Current,
    /// This text opens them.
    Write(String),
    /// It starts another executable: left alone.
    Foreign,
}

/// What the entry `current` (`None`: there is none) needs: NSH's own, `ours`,
/// where there is none or NSH wrote it; else, when its `Exec` starts this
/// executable (`starts_this` of its program), the missing `types` and a URL
/// field code.
fn plan(
    current: Option<&str>,
    ours: &str,
    app_id: &str,
    types: &Types,
    starts_this: impl Fn(&str) -> bool,
) -> Plan {
    let Some(current) = current else {
        return Plan::Write(ours.to_owned());
    };
    if written_by_nsh(current, app_id) {
        return if current == ours {
            Plan::Current
        } else {
            Plan::Write(ours.to_owned())
        };
    }
    if !value(current, "Exec")
        .and_then(|exec| program(&exec))
        .is_some_and(|program| starts_this(&program))
    {
        return Plan::Foreign;
    }
    match merge(current, types) {
        Some(text) => Plan::Write(text),
        None => Plan::Current,
    }
}

/// Whether NSH wrote the entry `text`: it has NSH's mark, or it is what NSH
/// wrote before it marked them (hidden, `StartupWMClass` the app's id, and
/// only the keys it wrote).
fn written_by_nsh(text: &str, app_id: &str) -> bool {
    if value(text, GENERATED).is_some_and(|v| v == "true") {
        return true;
    }
    const KEYS: &[&str] = &[
        "Type",
        "Name",
        "Exec",
        "StartupWMClass",
        "Terminal",
        "NoDisplay",
        "MimeType",
    ];
    let mut groups = 0;
    for line in text.lines() {
        let line = line.trim_ascii();
        if line.is_empty() {
            continue;
        }
        if line == "[Desktop Entry]" {
            groups += 1;
        } else if !line
            .split_once('=')
            .is_some_and(|(key, _)| KEYS.contains(&key.trim_ascii_end()))
        {
            return false;
        }
    }
    groups == 1
        && value(text, "NoDisplay").is_some_and(|v| v == "true")
        && value(text, "StartupWMClass").is_some_and(|v| v == app_id)
}

/// The entry `text` with the `types` its `MimeType` lacks added, and a URL
/// field code in its `Exec` when it has none; `None` when it has both. Only
/// those lines of the `[Desktop Entry]` group change (the last of a key
/// given twice, which is the one readers take): comments, other keys
/// (localized ones too) and groups stay as they are.
fn merge(text: &str, types: &Types) -> Option<String> {
    let mut lines: Vec<String> = text.split_inclusive('\n').map(str::to_owned).collect();
    let (mut last_key, mut mime, mut exec) = (None, None, None);
    let mut in_entry = false;
    for (i, line) in lines.iter().enumerate() {
        let line = line.trim_ascii();
        if let Some(group) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            in_entry = group == "Desktop Entry";
            if in_entry {
                last_key = Some(i);
            }
        } else if in_entry
            && !line.starts_with('#')
            && let Some((key, _)) = line.split_once('=')
        {
            last_key = Some(i);
            match key.trim_ascii_end() {
                "MimeType" => mime = Some(i),
                "Exec" => exec = Some(i),
                _ => {}
            }
        }
    }
    let mut changed = false;
    if let Some(i) = exec
        && let Some(with_code) = with_url_code(&unescape(raw_value(&lines[i])), types.url_code)
    {
        lines[i] = with_value(&lines[i], &escape(&with_code));
        changed = true;
    }
    let listed = mime
        .map(|i| raw_value(&lines[i]).to_owned())
        .unwrap_or_default();
    let missing: String = types
        .all
        .iter()
        .filter(|kind| {
            !listed
                .split(';')
                .any(|listed| listed.trim_ascii().eq_ignore_ascii_case(kind))
        })
        .map(|kind| format!("{kind};"))
        .collect();
    if !missing.is_empty() {
        let separator = if listed.is_empty() || listed.ends_with(';') {
            ""
        } else {
            ";"
        };
        let value = format!("{listed}{separator}{missing}");
        match mime {
            Some(i) => lines[i] = with_value(&lines[i], &value),
            None => {
                let i = last_key?;
                if !lines[i].ends_with('\n') {
                    lines[i].push('\n');
                }
                lines.insert(i + 1, format!("MimeType={value}\n"));
            }
        }
        changed = true;
    }
    changed.then(|| lines.concat())
}

/// The value of a `key=value` line as written (its escapes kept), without
/// the white space readers trim.
fn raw_value(line: &str) -> &str {
    line.split_once('=')
        .map_or("", |(_, value)| value.trim_ascii())
}

/// The `key=value` line `line` with the value `value` (as written), its
/// key and line break kept.
fn with_value(line: &str, value: &str) -> String {
    let key = line.split_once('=').map_or(line, |(key, _)| key);
    let end = &line[line.trim_end_matches(['\r', '\n']).len()..];
    format!("{key}={value}{end}")
}

/// `exec` (an `Exec` value, its string escapes undone) handing URLs with
/// `url_code`, or `None` when it hands them already (`%u`, `%U`): its file
/// field code (`%f`, `%F`) turned into the URL one of the same count (GIO
/// hands a file as a `file:` URL), or `url_code` added after it.
fn with_url_code(exec: &str, url_code: &str) -> Option<String> {
    let mut file_code = None;
    // Field codes are arguments of their own, outside quotes.
    let (mut quoted, mut escaped) = (false, false);
    let mut token: Option<(usize, bool)> = None;
    for (i, c) in exec.char_indices().chain([(exec.len(), ' ')]) {
        if quoted {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                quoted = false;
            }
            continue;
        }
        match c {
            ' ' | '\t' => {
                if let Some((start, true)) = token.take() {
                    match &exec[start..i] {
                        "%u" | "%U" => return None,
                        "%f" | "%F" if file_code.is_none() => file_code = Some(start),
                        _ => {}
                    }
                }
            }
            '"' => {
                quoted = true;
                token = Some((token.map_or(i, |(start, _)| start), false));
            }
            _ => {
                token.get_or_insert((i, true));
            }
        }
    }
    let mut exec = exec.to_owned();
    match file_code {
        Some(at) => {
            let code = if &exec[at + 1..at + 2] == "F" {
                "U"
            } else {
                "u"
            };
            exec.replace_range(at + 1..at + 2, code);
        }
        None => {
            exec.push(' ');
            exec.push_str(url_code);
        }
    }
    Some(exec)
}

/// NSH's own desktop entry: `Exec` quoted as the specification asks
/// (`args` after the executable, then the URL field code), `TryExec` the
/// executable (the desktop hides the entry once it is gone), the package's
/// icon when it has one, and NSH's mark. A development host's (`args`
/// naming the app it runs) is hidden: it opens a project's links, it is not
/// an app to launch.
fn entry(
    app_id: &str,
    name: &str,
    exe: &Path,
    args: &[String],
    types: &Types,
    icon: Option<&Path>,
) -> String {
    let exe = exe.to_string_lossy();
    let name: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let exec: Vec<String> = std::iter::once(exe.as_ref())
        .chain(args.iter().map(String::as_str))
        .map(exec_arg)
        .collect();
    let mut text = format!(
        "[Desktop Entry]\nType=Application\nName={}\nExec={} {}\nTryExec={}\n",
        escape(&name),
        exec.join(" "),
        types.url_code,
        escape(&exe),
    );
    if let Some(icon) = icon {
        text.push_str(&format!("Icon={}\n", escape(&icon.to_string_lossy())));
    }
    text.push_str(&format!(
        "StartupWMClass={}\nTerminal=false\n",
        escape(app_id)
    ));
    if !args.is_empty() {
        text.push_str("NoDisplay=true\n");
    }
    let types: String = types.all.iter().map(|kind| format!("{kind};")).collect();
    text.push_str(&format!("MimeType={types}\n{GENERATED}=true\n"));
    text
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

    fn types(schemes: &[&str], mime_types: &[&str]) -> Types {
        let own = |list: &[&str]| list.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        Types::new(&own(schemes), &own(mime_types))
    }

    /// `plan` for the app `com.a.b`, whose executable is `/opt/b/b` (also
    /// found as `b` on the `PATH`).
    fn plan_for(current: Option<&str>, types: &Types) -> Plan {
        let ours = entry("com.a.b", "B", Path::new("/opt/b/b"), &[], types, None);
        plan(current, &ours, "com.a.b", types, |program| {
            program == "/opt/b/b" || program == "b"
        })
    }

    #[test]
    fn entries_quote_the_executable_and_list_the_types() {
        let exe = Path::new("/opt/my \"b\"/b");
        let args = ["--app-id".to_owned(), "a%b".to_owned()];
        let e = entry("com.a.b", "B", exe, &args, &types(&["b", "bb"], &[]), None);
        assert!(
            e.contains("Exec=\"/opt/my \\\\\"b\\\\\"/b\" \"--app-id\" \"a%%b\" %u\n"),
            "{e}"
        );
        assert_eq!(
            value(&e, "Exec").and_then(|exec| program(&exec)).as_deref(),
            exe.to_str()
        );
        assert!(e.contains("TryExec=/opt/my \"b\"/b\n"));
        assert!(e.contains("MimeType=x-scheme-handler/b;x-scheme-handler/bb;\n"));
        // A development host's entry is hidden, and has no icon.
        assert!(e.contains("NoDisplay=true\n"));
        assert!(!e.contains("Icon="));
        assert!(e.ends_with("X-NSH-Generated=true\n"));
        // A package's shows, with its icon.
        let icon = Path::new("/opt/b/com.a.b.png");
        let types = types(&["b"], &["video/mp4", "Video/MP4"]);
        let e = entry(
            "com.a.b",
            "B\nC",
            Path::new("/opt/b/b"),
            &[],
            &types,
            Some(icon),
        );
        assert_eq!(
            e,
            "[Desktop Entry]\nType=Application\nName=B C\nExec=\"/opt/b/b\" %U\n\
             TryExec=/opt/b/b\nIcon=/opt/b/com.a.b.png\nStartupWMClass=com.a.b\n\
             Terminal=false\nMimeType=x-scheme-handler/b;video/mp4;\nX-NSH-Generated=true\n"
        );
    }

    #[test]
    fn a_missing_entry_is_written() {
        let types = types(&["b"], &[]);
        let Plan::Write(text) = plan_for(None, &types) else {
            panic!("no entry written");
        };
        assert!(written_by_nsh(&text, "com.a.b"));
        assert!(text.contains("MimeType=x-scheme-handler/b;\n"));
        // Written, it is current.
        assert_eq!(plan_for(Some(&text), &types), Plan::Current);
    }

    #[test]
    fn nsh_rewrites_its_own_entries() {
        let types = types(&["b"], &[]);
        let ours = entry("com.a.b", "B", Path::new("/opt/b/b"), &[], &types, None);
        // Its own, for an executable that moved since.
        let moved = entry("com.a.b", "B", Path::new("/old/b"), &[], &types, None);
        assert_eq!(plan_for(Some(&moved), &types), Plan::Write(ours.clone()));
        // What NSH wrote before it marked its entries.
        let unmarked = "[Desktop Entry]\nType=Application\nName=B\nExec=\"/old/b\" %u\n\
                        StartupWMClass=com.a.b\nTerminal=false\nNoDisplay=true\n\
                        MimeType=x-scheme-handler/b;\n";
        assert!(written_by_nsh(unmarked, "com.a.b"));
        assert_eq!(plan_for(Some(unmarked), &types), Plan::Write(ours));
        // Hidden, but with a key of its own, or another app's class: not NSH's.
        let icon = unmarked.replace("Terminal", "Icon=b\nTerminal");
        assert!(!written_by_nsh(&icon, "com.a.b"));
        assert!(!written_by_nsh(unmarked, "com.a.c"));
        assert!(!written_by_nsh(
            &unmarked.replace("NoDisplay=true\n", ""),
            "com.a.b"
        ));
    }

    /// An entry an installer wrote: visible, with an icon, categories,
    /// localized keys, comments and an action.
    const INSTALLED: &str = "# Installed by the app's installer\n\
        [Desktop Entry]\n\
        Type=Application\n\
        Name=B\n\
        Name[zh_CN]=乙\n\
        Comment[de]=Ein B\n\
        Exec=b %u\n\
        Icon=com.a.b\n\
        Categories=Utility;\n\
        MimeType=x-scheme-handler/b;\n\
        StartupWMClass=com.a.b\n\
        # Keep in sync with the action below\n\
        Actions=new;\n\
        \n\
        [Desktop Action new]\n\
        Name=New\n\
        Exec=b --new\n";

    #[test]
    fn an_installed_entry_that_opens_the_types_is_left_as_it_is() {
        assert_eq!(
            plan_for(Some(INSTALLED), &types(&["b"], &[])),
            Plan::Current
        );
        // Schemes and types compare without case.
        assert_eq!(
            plan_for(Some(INSTALLED), &types(&["B"], &[])),
            Plan::Current
        );
        let absolute = INSTALLED.replace("Exec=b %u", "Exec=\"/opt/b/b\" %u");
        assert_eq!(
            plan_for(Some(&absolute), &types(&["b"], &[])),
            Plan::Current
        );
    }

    #[test]
    fn missing_types_are_added_to_an_installed_entry() {
        let plan = plan_for(Some(INSTALLED), &types(&["b", "bb"], &["video/mp4"]));
        let expected = INSTALLED.replace(
            "MimeType=x-scheme-handler/b;\n",
            "MimeType=x-scheme-handler/b;x-scheme-handler/bb;video/mp4;\n",
        );
        assert_eq!(plan, Plan::Write(expected));
        // Without a `MimeType`, one is added after the group's last key,
        // and a URL field code to an `Exec` without one: only the last
        // `Exec`, which readers take, and not the action's.
        let bare = INSTALLED
            .replace("MimeType=x-scheme-handler/b;\n", "")
            .replace("Exec=b %u\n", "Exec=old\nExec=b --x\n");
        let expected = INSTALLED
            .replace("MimeType=x-scheme-handler/b;\n", "")
            .replace("Exec=b %u\n", "Exec=old\nExec=b --x %u\n")
            .replace(
                "Actions=new;\n",
                "Actions=new;\nMimeType=x-scheme-handler/b;\n",
            );
        assert_eq!(
            plan_for(Some(&bare), &types(&["b"], &[])),
            Plan::Write(expected)
        );
        // A list without its last `;`, and Windows line breaks, are kept.
        let crlf = "[Desktop Entry]\r\nExec=b\r\nMimeType=text/plain\r\nName=B";
        assert_eq!(
            plan_for(Some(crlf), &types(&["b"], &[])),
            Plan::Write(
                "[Desktop Entry]\r\nExec=b %u\r\nMimeType=text/plain;x-scheme-handler/b;\r\nName=B"
                    .to_owned()
            )
        );
        let unterminated = "[Desktop Entry]\nExec=b %u";
        assert_eq!(
            plan_for(Some(unterminated), &types(&["b"], &[])),
            Plan::Write("[Desktop Entry]\nExec=b %u\nMimeType=x-scheme-handler/b;\n".to_owned())
        );
    }

    #[test]
    fn an_entry_of_another_executable_is_left_alone() {
        let types = types(&["b", "bb"], &[]);
        for exec in [
            "Exec=/elsewhere/b %u",
            "Exec=c",
            "Exec=./b",
            "Exec=\"/opt/b/b\"-x",
        ] {
            let text = INSTALLED.replace("Exec=b %u", exec);
            assert_eq!(plan_for(Some(&text), &types), Plan::Foreign, "{exec}");
        }
        // Without an `Exec` it starts nothing of this executable's.
        let text = INSTALLED.replace("Exec=b %u\n", "");
        assert_eq!(plan_for(Some(&text), &types), Plan::Foreign);
    }

    #[test]
    fn exec_hands_urls_with_a_url_field_code() {
        assert_eq!(with_url_code("b %u", "%u"), None);
        assert_eq!(with_url_code("b --x %U", "%u"), None);
        assert_eq!(with_url_code("b", "%u").as_deref(), Some("b %u"));
        assert_eq!(with_url_code("b --x", "%U").as_deref(), Some("b --x %U"));
        // A file field code becomes the URL one of the same count.
        assert_eq!(with_url_code("b %f", "%U").as_deref(), Some("b %u"));
        assert_eq!(with_url_code("b %F --x", "%u").as_deref(), Some("b %U --x"));
        // Only arguments of their own, outside quotes, are field codes.
        assert_eq!(
            with_url_code("\"/a %u\" \"%U\" x%u %%u", "%u").as_deref(),
            Some("\"/a %u\" \"%U\" x%u %%u %u")
        );
        assert_eq!(
            with_url_code("\"/a \\\" %u\" %F", "%u").as_deref(),
            Some("\"/a \\\" %u\" %U")
        );
    }

    #[test]
    fn programs_resolve_as_the_desktop_starts_them() {
        assert_eq!(resolve("/opt/b/b"), Some(PathBuf::from("/opt/b/b")));
        assert_eq!(resolve("./b"), None);
        assert_eq!(resolve("nsh-no-such-program-on-the-path"), None);
    }
}
