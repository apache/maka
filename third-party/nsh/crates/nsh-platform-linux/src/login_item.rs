//! The app's login item on Linux (`Application.loginItem()`,
//! [`nsh_core::desktop::LoginItemBackend`]): an XDG autostart entry,
//! `$XDG_CONFIG_HOME/autostart/<app id>.desktop` (`~/.config/autostart`),
//! which the desktop (GNOME, KDE Plasma, ...) starts when the user logs in
//! and lists in its autostart settings. Only [`crate::run_app`] with
//! [`crate::AppOptions::login_item`] gives the core this backend.
//!
//! The entry is NSH's and this copy's: `Exec` and `TryExec` name this
//! executable (with `TryExec` the desktop skips an entry whose executable is
//! gone), and one where either names another executable, or is missing,
//! reads as disabled. This executable is the one the app started from,
//! [`nsh_core::restart::program_path`] as the backend is made, while the app
//! starts: once an update or a package manager replaced the app on disk, the
//! process' own is the one moved aside or deleted (`<path> (deleted)`), while
//! the app starts from the path it was started from. Enabling writes the entry whole, to
//! a temporary file renamed into place, unless it is there already; disabling
//! removes it only when it is this copy's. The entry is the setting itself:
//! one the desktop's settings turned off (`Hidden=true`,
//! `X-GNOME-Autostart-enabled=false`) reads as disabled, and enabling writes
//! it on again. Entries elsewhere (the system's, in `$XDG_CONFIG_DIRS`) are
//! not read; a key given twice reads as its last, as GLib's key files do. In
//! a Flatpak or Snap sandbox the app has no login item (`unavailable`): its
//! paths are the sandbox's. A snap's app runs from below `$SNAP`; a program a
//! snap starts inherits the variable, so only an executable below it counts.

use std::{
    io,
    path::{Path, PathBuf},
};

use gtk4::glib;
use nsh_core::desktop::{LoginItemBackend, LoginItemStatus};

use crate::desktop_file::{escape, exec_arg, program, read, value, write_atomically};

/// The login item of the app `app_id`, named `name` in the desktop's
/// settings.
pub(crate) struct LoginItem {
    app_id: String,
    name: String,
    /// The program the app started from, taken as the app starts.
    program: Option<PathBuf>,
}

impl LoginItem {
    pub(crate) fn new(app_id: &str, name: &str) -> Self {
        Self {
            app_id: app_id.to_owned(),
            name: name.to_owned(),
            program: nsh_core::restart::program_path().ok(),
        }
    }

    /// The program the entry starts: the one the app started from.
    fn program(&self) -> io::Result<PathBuf> {
        match &self.program {
            Some(program) => Ok(program.clone()),
            None => nsh_core::restart::program_path(),
        }
    }

    /// The entry's path, in `dir` (the user's autostart directory).
    fn path(&self, dir: &Path) -> io::Result<PathBuf> {
        let id = &self.app_id;
        if id.is_empty() || id.starts_with('.') || id.contains(|c: char| c == '/' || c.is_control())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("the app id {id:?} cannot name an autostart entry"),
            ));
        }
        Ok(dir.join(format!("{id}.desktop")))
    }

    fn status_in(&self, dir: &Path, exe: &Path) -> io::Result<LoginItemStatus> {
        Ok(match read(&self.path(dir)?)? {
            Some(text) => status_of(&text, exe),
            None => LoginItemStatus::Disabled,
        })
    }

    fn set_in(&self, dir: &Path, exe: &Path, enabled: bool) -> io::Result<LoginItemStatus> {
        let path = self.path(dir)?;
        let current = read(&path)?;
        if enabled {
            let entry = entry(&self.app_id, &self.name, exe)?;
            if current.as_deref() != Some(entry.as_str()) {
                write_atomically(dir, &path, &entry)?;
            }
        } else if current.is_some_and(|text| this_copys(&text, exe)) {
            match std::fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
                _ => {}
            }
        }
        self.status_in(dir, exe)
    }
}

impl LoginItemBackend for LoginItem {
    fn status(&self) -> io::Result<LoginItemStatus> {
        let exe = self.program()?;
        if sandboxed(&exe) {
            return Ok(LoginItemStatus::Unavailable);
        }
        self.status_in(&autostart_dir(), &exe)
    }

    fn set(&self, enabled: bool) -> io::Result<LoginItemStatus> {
        let exe = self.program()?;
        if sandboxed(&exe) {
            return Ok(LoginItemStatus::Unavailable);
        }
        self.set_in(&autostart_dir(), &exe, enabled)
    }
}

/// The user's autostart directory (`$XDG_CONFIG_HOME/autostart`).
fn autostart_dir() -> PathBuf {
    glib::user_config_dir().join("autostart")
}

/// Whether the app, run from `exe`, runs in a Flatpak or Snap sandbox.
fn sandboxed(exe: &Path) -> bool {
    Path::new("/.flatpak-info").exists() || in_snap(std::env::var_os("SNAP").as_deref(), exe)
}

/// Whether `exe` is a snap's, whose files are below `snap` (`$SNAP`).
fn in_snap(snap: Option<&std::ffi::OsStr>, exe: &Path) -> bool {
    snap.is_some_and(|snap| !snap.is_empty() && exe.starts_with(snap))
}

/// The status of entry `text` for this executable `exe`.
fn status_of(text: &str, exe: &Path) -> LoginItemStatus {
    let off = value(text, "Hidden").is_some_and(|v| v == "true")
        || value(text, "X-GNOME-Autostart-enabled").is_some_and(|v| v == "false");
    if this_copys(text, exe) && !off {
        LoginItemStatus::Enabled
    } else {
        LoginItemStatus::Disabled
    }
}

/// Whether entry `text` is NSH's for this executable: the program of its
/// `Exec`, what the desktop runs, and its `TryExec`, which NSH writes, both
/// name it.
fn this_copys(text: &str, exe: &Path) -> bool {
    let names = |program: Option<String>| program.is_some_and(|p| Path::new(&p) == exe);
    names(value(text, "Exec").and_then(|exec| program(&exec))) && names(value(text, "TryExec"))
}

/// The entry that starts `exe` at login, for the app `app_id` named `name`.
fn entry(app_id: &str, name: &str, exe: &Path) -> io::Result<String> {
    let exe = exe
        .to_str()
        .filter(|e| !e.contains(char::is_control))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "an autostart entry cannot start {}: not UTF-8, or control characters",
                    exe.display()
                ),
            )
        })?;
    let name: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    Ok(format!(
        "[Desktop Entry]\nType=Application\nName={}\nExec={}\nTryExec={}\nIcon={}\n\
         Terminal=false\nX-GNOME-Autostart-enabled=true\n",
        escape(&name),
        exec_arg(exe),
        escape(exe),
        escape(app_id),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh autostart directory of the test's own.
    fn dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nsh-login-item-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn entries_quote_and_escape_as_the_specification_asks() {
        let exe = Path::new("/opt/my \"b\" $x 100%/a\\b/app");
        let text = entry("com.example.a", "A\nB\\C", exe).unwrap();
        assert!(text.starts_with("[Desktop Entry]\nType=Application\nName=A B\\\\C\n"));
        assert!(
            text.contains("Exec=\"/opt/my \\\\\"b\\\\\" \\\\$x 100%%/a\\\\\\\\b/app\"\n"),
            "{text}"
        );
        assert!(text.contains("TryExec=/opt/my \"b\" $x 100%/a\\\\b/app\n"));
        assert!(text.contains("Icon=com.example.a\n"));
        // What is written is read back as the same executable.
        assert_eq!(value(&text, "TryExec").as_deref(), exe.to_str());
        assert_eq!(
            value(&text, "Exec")
                .and_then(|exec| program(&exec))
                .as_deref(),
            exe.to_str()
        );
        assert!(this_copys(&text, exe));
        assert!(entry("a", "A", Path::new("/opt/a\nb")).is_err());
        // Spaces at a path's end, which readers trim from a line, are kept.
        for exe in ["/opt/app/app ", "/opt/app/app\u{3000}", " /opt/app/app  "] {
            let exe = Path::new(exe);
            let text = entry("com.example.a", " A ", exe).unwrap();
            assert_eq!(value(&text, "TryExec").as_deref(), exe.to_str(), "{text}");
            assert_eq!(value(&text, "Name").as_deref(), Some(" A "));
            assert_eq!(status_of(&text, exe), LoginItemStatus::Enabled, "{text}");
        }
    }

    #[test]
    fn statuses_follow_the_entry_and_the_desktops_settings() {
        let exe = Path::new("/opt/app/app");
        let ours = entry("com.example.a", "A", exe).unwrap();
        assert_eq!(status_of(&ours, exe), LoginItemStatus::Enabled);
        assert_eq!(
            status_of(&ours, Path::new("/elsewhere/app")),
            LoginItemStatus::Disabled
        );
        for off in ["Hidden=true", "X-GNOME-Autostart-enabled=false"] {
            let text = format!(
                "{}{off}\n",
                ours.replace("X-GNOME-Autostart-enabled=true\n", "")
            );
            assert_eq!(status_of(&text, exe), LoginItemStatus::Disabled, "{off}");
        }
        // A key given twice reads as its last, as GLib reads it: turned off
        // by a line added below NSH's.
        let appended = format!("{ours}X-GNOME-Autostart-enabled=false\n");
        assert_eq!(status_of(&appended, exe), LoginItemStatus::Disabled);
        // Keys of other groups, and entries without `TryExec`, are not ours.
        let other =
            "[Desktop Entry]\nExec=/opt/app/app\n[Desktop Action x]\nTryExec=/opt/app/app\n";
        assert_eq!(status_of(other, exe), LoginItemStatus::Disabled);
        // Nor one whose `Exec`, what the desktop runs, starts another
        // program or nothing, whatever its `TryExec` names.
        let elsewhere = ours.replace("Exec=\"/opt/app/app\"", "Exec=\"/opt/other/app\" --x");
        assert_ne!(elsewhere, ours);
        assert_eq!(status_of(&elsewhere, exe), LoginItemStatus::Disabled);
        let without = ours.replace("Exec=\"/opt/app/app\"\n", "");
        assert_ne!(without, ours);
        assert_eq!(status_of(&without, exe), LoginItemStatus::Disabled);
        // Nor one whose quotes end inside a longer argument, which starts
        // `/opt/app/app-other`.
        for longer in ["Exec=\"/opt/app/app\"-other", "Exec=/opt/app/app\"-other\""] {
            let text = ours.replace("Exec=\"/opt/app/app\"", longer);
            assert_eq!(status_of(&text, exe), LoginItemStatus::Disabled, "{longer}");
        }
        // Its arguments after the program, and a program written unquoted,
        // are still this executable's.
        let unquoted = ours.replace("Exec=\"/opt/app/app\"", "Exec=/opt/app/app --hidden");
        assert_eq!(status_of(&unquoted, exe), LoginItemStatus::Enabled);
    }

    #[test]
    fn enabling_writes_the_entry_and_disabling_removes_only_this_copys() {
        let dir = dir("set");
        let (exe, other) = (Path::new("/opt/a/app"), Path::new("/opt/b/app"));
        let item = LoginItem::new("com.example.a", "A");
        let path = dir.join("com.example.a.desktop");
        assert_eq!(
            item.status_in(&dir, exe).unwrap(),
            LoginItemStatus::Disabled
        );
        // Removing what is not there succeeds.
        assert_eq!(
            item.set_in(&dir, exe, false).unwrap(),
            LoginItemStatus::Disabled
        );
        assert_eq!(
            item.set_in(&dir, exe, true).unwrap(),
            LoginItemStatus::Enabled
        );
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            entry("com.example.a", "A", exe).unwrap()
        );
        // No temporary file is left behind.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert_eq!(
            item.set_in(&dir, exe, true).unwrap(),
            LoginItemStatus::Enabled
        );
        // Another copy reads it as not its own and leaves it when disabling.
        assert_eq!(
            item.status_in(&dir, other).unwrap(),
            LoginItemStatus::Disabled
        );
        assert_eq!(
            item.set_in(&dir, other, false).unwrap(),
            LoginItemStatus::Disabled
        );
        assert!(path.exists());
        // Turned off in the desktop's settings, enabling turns it on again.
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{text}Hidden=true\n")).unwrap();
        assert_eq!(
            item.status_in(&dir, exe).unwrap(),
            LoginItemStatus::Disabled
        );
        assert_eq!(
            item.set_in(&dir, exe, true).unwrap(),
            LoginItemStatus::Enabled
        );
        assert_eq!(
            item.set_in(&dir, exe, false).unwrap(),
            LoginItemStatus::Disabled
        );
        assert!(!path.exists());
        // Another program's entry that is not UTF-8 reads, and enabling
        // writes NSH's over it.
        std::fs::write(&path, b"[Desktop Entry]\nName=\xff\nTryExec=/opt/b/app\n").unwrap();
        assert_eq!(
            item.status_in(&dir, exe).unwrap(),
            LoginItemStatus::Disabled
        );
        assert_eq!(
            item.set_in(&dir, exe, true).unwrap(),
            LoginItemStatus::Enabled
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_snap_is_one_the_app_runs_from() {
        use std::ffi::OsStr;
        let snap = Some(OsStr::new("/snap/app/3"));
        assert!(in_snap(snap, Path::new("/snap/app/3/bin/app")));
        // A program a snap started (a terminal's) inherits `SNAP`.
        assert!(!in_snap(snap, Path::new("/opt/app/app")));
        assert!(!in_snap(Some(OsStr::new("")), Path::new("/opt/app/app")));
        assert!(!in_snap(None, Path::new("/snap/app/3/bin/app")));
    }

    #[test]
    fn app_ids_that_cannot_name_a_file_are_refused() {
        let dir = dir("ids");
        for id in ["", ".hidden", "a/b", "a\0b", "a\nb"] {
            let error = LoginItem::new(id, "A")
                .set_in(&dir, Path::new("/opt/a"), true)
                .unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput, "{id:?}");
        }
        assert!(!dir.exists());
    }
}
