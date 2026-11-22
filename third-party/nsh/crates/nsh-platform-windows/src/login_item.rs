//! The app's login item on Windows (`Application.loginItem()`,
//! [`nsh_core::desktop::LoginItemBackend`]): a value of
//! `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run` named
//! by the app's id and holding this executable's quoted path, which the
//! system starts when the user logs in (Settings' Startup apps and Task
//! Manager's Startup tab list it). Only [`crate::run_app`] with
//! [`crate::AppOptions::login_item`] gives the core this backend.
//!
//! The value is this copy's: one naming another executable reads as
//! disabled, enabling replaces it and disabling leaves it. This executable
//! is the one the app started from, [`nsh_core::restart::program_path`] as
//! the backend is made, while the app starts: however the app is replaced on
//! disk later, the path it starts from. A command is at
//! most 260 characters (Microsoft's "Run and RunOnce Registry Keys"), and a
//! program the key started should not write to the key while it runs, so
//! nothing is written unless the app asks for a change and the value
//! differs. Turning the app off in Settings or Task Manager keeps the value
//! and marks it in `...\Explorer\StartupApproved\Run` (a binary value of the
//! same name whose first byte is odd), which reads as `requiresApproval`:
//! only the user turns it back on there, and NSH never writes that key. Its
//! format is not documented: a mark that is missing or of a form not known
//! reads as approved. The installer `nsh package` makes removes the value on
//! uninstall when it names that installation's executable
//! (`nsh-cli`'s `windows.rs`).

use std::{
    io,
    path::{Path, PathBuf},
};

use nsh_core::desktop::{LoginItemBackend, LoginItemStatus};
use windows::{
    Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_UNSUPPORTED_TYPE, WIN32_ERROR},
        System::Registry::{
            HKEY_CURRENT_USER, REG_ROUTINE_FLAGS, REG_SZ, RRF_RT_REG_BINARY, RRF_RT_REG_SZ,
            RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW,
        },
    },
    core::HSTRING,
};

/// The key of the programs the system starts at the user's logon.
const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Where Settings and Task Manager mark the `Run` values the user turned
/// off.
const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// The longest command a `Run` value holds, in characters.
const MAX_COMMAND: usize = 260;

/// The login item of the app whose id names its value.
pub(crate) struct LoginItem {
    name: String,
    /// The keys it reads and writes under `HKEY_CURRENT_USER`: [`RUN`] and
    /// [`APPROVED`] (a test's own in tests).
    run: String,
    approved: String,
    /// The program the app started from, taken as the app starts.
    program: Option<PathBuf>,
}

impl LoginItem {
    pub(crate) fn new(app_id: &str) -> Self {
        Self {
            name: app_id.to_owned(),
            run: RUN.to_owned(),
            approved: APPROVED.to_owned(),
            program: nsh_core::restart::program_path().ok(),
        }
    }

    /// The program the value starts: the one the app started from.
    fn program(&self) -> io::Result<PathBuf> {
        match &self.program {
            Some(program) => Ok(program.clone()),
            None => nsh_core::restart::program_path(),
        }
    }

    /// The value's name: the app's id, which an empty one cannot be (it
    /// would name the key's default value).
    fn name(&self) -> io::Result<&str> {
        if self.name.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "an empty app id cannot name a login item",
            ));
        }
        Ok(&self.name)
    }

    fn status_for(&self, exe: &Path) -> io::Result<LoginItemStatus> {
        let name = self.name()?;
        let command = read_string(&self.run, name)?;
        let mark = read_binary(&self.approved, name)?;
        Ok(status_of(command.as_deref(), mark.as_deref(), exe))
    }

    fn set_for(&self, exe: &Path, enabled: bool) -> io::Result<LoginItemStatus> {
        let name = self.name()?;
        let current = read_string(&self.run, name)?;
        if enabled {
            let command = command(exe)?;
            if current.as_deref() != Some(command.as_str()) {
                write_string(&self.run, name, &command)?;
            }
        } else if current.is_some_and(|command| names(&command, exe)) {
            delete_value(&self.run, name)?;
        }
        self.status_for(exe)
    }
}

impl LoginItemBackend for LoginItem {
    fn status(&self) -> io::Result<LoginItemStatus> {
        self.status_for(&self.program()?)
    }

    fn set(&self, enabled: bool) -> io::Result<LoginItemStatus> {
        self.set_for(&self.program()?, enabled)
    }
}

/// The status for the `Run` value `command` and its `StartupApproved`
/// `mark`, for this executable `exe`.
fn status_of(command: Option<&str>, mark: Option<&[u8]>, exe: &Path) -> LoginItemStatus {
    if !command.is_some_and(|command| names(command, exe)) {
        return LoginItemStatus::Disabled;
    }
    match mark {
        // Odd first bytes (`03`, `07`) are what Settings and Task Manager
        // write for an app turned off; even ones (`02`, `06`) turned on.
        Some([first, ..]) if first & 1 == 1 => LoginItemStatus::RequiresApproval,
        _ => LoginItemStatus::Enabled,
    }
}

/// The `Run` command that starts `exe`: its path, quoted. A path that is not
/// Unicode (an unpaired UTF-16 surrogate, which Windows allows) is refused:
/// written as text, it would name another file.
fn command(exe: &Path) -> io::Result<String> {
    let path = exe.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "the app's path is not Unicode, so no login item can name it: {}",
                exe.display()
            ),
        )
    })?;
    let command = format!("\"{path}\"");
    if command.encode_utf16().count() > MAX_COMMAND {
        return Err(io::Error::new(
            io::ErrorKind::InvalidFilename,
            format!(
                "the app's path is too long for a login item ({MAX_COMMAND} characters at \
                 most): {}",
                exe.display()
            ),
        ));
    }
    Ok(command)
}

/// Whether `command` starts `exe`: its program, quoted or up to the first
/// space, is the same path, compared as Windows compares paths (case and
/// separators aside).
fn names(command: &str, exe: &Path) -> bool {
    let command = command.trim_start();
    let program = match command.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(rest),
        None => command.split([' ', '\t']).next().unwrap_or(command),
    };
    same_path(Path::new(program), exe)
}

/// Whether `a` and `b` are the same path to Windows (case, separators and a
/// verbatim `\\?\` or `\\?\UNC\` prefix aside); one that is not Unicode is
/// no path a command names (see [`command`]).
fn same_path(a: &Path, b: &Path) -> bool {
    let plain = |p: &Path| -> Option<String> {
        let s = p.to_str()?.replace('/', "\\").to_lowercase();
        Some(match s.strip_prefix(r"\\?\unc\") {
            Some(share) => format!(r"\\{share}"),
            None => s.strip_prefix(r"\\?\").map_or(s.clone(), str::to_owned),
        })
    };
    plain(a).is_some_and(|a| plain(b) == Some(a))
}

/// The error `code` as an I/O error (its errno-like kind: `EACCES`, ...).
fn error(code: WIN32_ERROR) -> io::Error {
    io::Error::from_raw_os_error(code.0 as i32)
}

/// The data of value `name` of `key` under `HKEY_CURRENT_USER` read with
/// `flags`, `None` when it or its key is missing or of a type `flags` does
/// not take.
fn read(key: &str, name: &str, flags: REG_ROUTINE_FLAGS) -> io::Result<Option<Vec<u8>>> {
    let (key, name) = (HSTRING::from(key), HSTRING::from(name));
    let get = |data: Option<&mut Vec<u8>>, size: &mut u32| {
        // SAFETY: valid strings; `data`, when given, holds `size` bytes.
        unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                &key,
                &name,
                flags,
                None,
                data.map(|d| d.as_mut_ptr().cast()),
                Some(size),
            )
        }
    };
    let missing =
        |code: WIN32_ERROR| code == ERROR_FILE_NOT_FOUND || code == ERROR_UNSUPPORTED_TYPE;
    let mut size = 0u32;
    let code = get(None, &mut size);
    if missing(code) {
        return Ok(None);
    }
    if code.is_err() {
        return Err(error(code));
    }
    // The value may grow before it is read; a call that finds the buffer
    // short reports the size it needs, which the next one takes.
    for _ in 0..3 {
        let mut data = vec![0u8; size as usize];
        let code = get(Some(&mut data), &mut size);
        if missing(code) {
            return Ok(None);
        }
        if code.is_ok() {
            data.truncate(size as usize);
            return Ok(Some(data));
        }
        if code != ERROR_MORE_DATA {
            return Err(error(code));
        }
    }
    Err(io::Error::other(format!(
        "the registry value {name} keeps changing"
    )))
}

/// String value `name` of `key`: a `REG_SZ`, or a `REG_EXPAND_SZ` with its
/// environment variables expanded (`RegGetValueW` expands it unless told
/// not to).
fn read_string(key: &str, name: &str) -> io::Result<Option<String>> {
    Ok(read(key, name, RRF_RT_REG_SZ)?.map(|bytes| {
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&pair| u16::from_le_bytes(pair))
            .collect();
        let len = units.iter().position(|&u| u == 0).unwrap_or(units.len());
        // A value that is not Unicode names no path `command` writes: it
        // reads as an empty command, which starts no executable.
        String::from_utf16(&units[..len]).unwrap_or_default()
    }))
}

/// Binary value `name` of `key` (`REG_BINARY`).
fn read_binary(key: &str, name: &str) -> io::Result<Option<Vec<u8>>> {
    read(key, name, RRF_RT_REG_BINARY)
}

/// Sets string value `name` of `key`, making the key when missing.
fn write_string(key: &str, name: &str, value: &str) -> io::Result<()> {
    let data: Vec<u16> = value.encode_utf16().chain(Some(0)).collect();
    // SAFETY: valid strings, and `data` with its length in bytes.
    let code = unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            &HSTRING::from(key),
            &HSTRING::from(name),
            REG_SZ.0,
            Some(data.as_ptr().cast()),
            (data.len() * 2) as u32,
        )
    };
    if code.is_err() {
        return Err(error(code));
    }
    Ok(())
}

/// Deletes value `name` of `key`; one already gone is no error.
fn delete_value(key: &str, name: &str) -> io::Result<()> {
    // SAFETY: valid strings.
    let code =
        unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(key), &HSTRING::from(name)) };
    if code.is_err() && code != ERROR_FILE_NOT_FOUND {
        return Err(error(code));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use windows::Win32::System::Registry::{
        REG_BINARY, REG_DWORD, REG_EXPAND_SZ, REG_VALUE_TYPE, RegDeleteKeyW, RegDeleteTreeW,
    };

    use super::*;

    const EXE: &str = r"C:\Users\Ana\AppData\Local\Programs\Tray App\Tray App.exe";

    #[test]
    fn commands_are_quoted_and_held_to_the_run_keys_limit() {
        let exe = Path::new(EXE);
        let command = command(exe).unwrap();
        assert_eq!(command, format!("\"{EXE}\""));
        assert!(names(&command, exe));
        let long = PathBuf::from(format!(r"C:\{}\app.exe", "a".repeat(260)));
        let error = super::command(&long).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidFilename);
    }

    #[test]
    fn paths_that_are_not_unicode_are_never_written_or_matched() {
        use std::os::windows::ffi::OsStringExt;
        // `C:\<unpaired surrogate>.exe`: a name Windows allows.
        let units: Vec<u16> = r"C:\"
            .encode_utf16()
            .chain([0xD800])
            .chain(".exe".encode_utf16())
            .collect();
        let exe = PathBuf::from(std::ffi::OsString::from_wide(&units));
        let error = command(&exe).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        // Its lossy form (U+FFFD in place of the surrogate) is another path.
        let lossy = format!("\"{}\"", exe.display());
        assert!(lossy.contains('\u{FFFD}'));
        assert!(!names(&lossy, &exe));
        assert!(!same_path(&exe, &exe));
    }

    #[test]
    fn a_value_is_this_copys_when_it_starts_this_executable() {
        let exe = Path::new(EXE);
        // Case and separators aside, with arguments after it.
        let shouted = format!(r#""{}" --hidden"#, EXE.to_uppercase().replace('\\', "/"));
        assert!(names(&shouted, exe));
        assert!(names(r"C:\tray.exe --x", Path::new(r"c:\TRAY.exe")));
        assert!(names(&format!(r#""\\?\{EXE}""#), exe));
        // A share's path, written verbatim or not.
        let share = Path::new(r"\\?\UNC\fileserver\apps\Tray.exe");
        assert!(names(r#""\\fileserver\apps\Tray.exe""#, share));
        assert!(names(
            r#""\\?\unc\FileServer\apps\tray.exe""#,
            Path::new(r"\\fileserver\apps\Tray.exe")
        ));
        assert!(!names(
            r#""\\?\UNC\fileserver\apps\Tray.exe""#,
            Path::new(r"C:\fileserver\apps\Tray.exe")
        ));
        // Another copy, or a program of the same name elsewhere.
        assert!(!names(r#""D:\Apps\Tray App\Tray App.exe""#, exe));
        assert!(!names(
            r#""C:\Users\Ana\AppData\Local\Programs\Tray App""#,
            exe
        ));
        assert!(!names("", exe));
    }

    #[test]
    fn statuses_follow_the_value_and_the_users_mark() {
        let exe = Path::new(EXE);
        let ours = format!("\"{EXE}\"");
        let status = |command: Option<&str>, mark: Option<&[u8]>| status_of(command, mark, exe);
        assert_eq!(status(None, None), LoginItemStatus::Disabled);
        // Another copy's value is not this one's, whatever its mark.
        assert_eq!(
            status(Some(r#""D:\Tray.exe""#), Some(&[2; 12])),
            LoginItemStatus::Disabled
        );
        assert_eq!(status(Some(&ours), None), LoginItemStatus::Enabled);
        let mut on = [0u8; 12];
        on[0] = 2;
        assert_eq!(status(Some(&ours), Some(&on)), LoginItemStatus::Enabled);
        on[0] = 6;
        assert_eq!(status(Some(&ours), Some(&on)), LoginItemStatus::Enabled);
        let mut off = [0u8; 12];
        off[0] = 3;
        assert_eq!(
            status(Some(&ours), Some(&off)),
            LoginItemStatus::RequiresApproval
        );
        off[0] = 7;
        assert_eq!(
            status(Some(&ours), Some(&off)),
            LoginItemStatus::RequiresApproval
        );
        // A mark of a form not known reads as approved.
        assert_eq!(status(Some(&ours), Some(&[])), LoginItemStatus::Enabled);
    }

    /// A key of the test's own below `HKEY_CURRENT_USER\Software`, holding
    /// the two keys a login item uses; removed with what it holds when
    /// dropped.
    struct Scratch(String);

    impl Scratch {
        fn new(name: &str) -> Self {
            let scratch = Self(format!(
                r"Software\nsh-test-login-item-{name}-{}",
                std::process::id()
            ));
            scratch.remove();
            scratch
        }

        fn item(&self, app_id: &str) -> LoginItem {
            LoginItem {
                name: app_id.to_owned(),
                run: format!(r"{}\Run", self.0),
                approved: format!(r"{}\Approved", self.0),
                program: None,
            }
        }

        fn remove(&self) {
            let key = HSTRING::from(self.0.as_str());
            // SAFETY: a valid string, naming the test's own key.
            unsafe {
                let _ = RegDeleteTreeW(HKEY_CURRENT_USER, &key);
                let _ = RegDeleteKeyW(HKEY_CURRENT_USER, &key);
            }
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            self.remove();
        }
    }

    /// Sets value `name` of `key` to `data`, typed `kind`.
    fn set_raw(key: &str, name: &str, kind: REG_VALUE_TYPE, data: &[u8]) {
        // SAFETY: valid strings, and `data` with its length in bytes.
        let code = unsafe {
            RegSetKeyValueW(
                HKEY_CURRENT_USER,
                &HSTRING::from(key),
                &HSTRING::from(name),
                kind.0,
                Some(data.as_ptr().cast()),
                data.len() as u32,
            )
        };
        assert!(code.is_ok(), "{code:?}");
    }

    /// `text` as the registry holds a string: UTF-16 with its final NUL.
    fn wide(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain(Some(0))
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    #[test]
    fn the_value_is_written_marked_and_removed_in_the_registry() {
        let scratch = Scratch::new("value");
        let item = scratch.item("com.example.a");
        let (exe, other) = (Path::new(EXE), Path::new(r"D:\Apps\Tray App\Tray App.exe"));
        // Neither key is there yet.
        assert_eq!(item.status_for(exe).unwrap(), LoginItemStatus::Disabled);
        assert_eq!(item.set_for(exe, false).unwrap(), LoginItemStatus::Disabled);
        assert_eq!(item.set_for(exe, true).unwrap(), LoginItemStatus::Enabled);
        assert_eq!(
            read_string(&item.run, "com.example.a").unwrap(),
            Some(format!("\"{EXE}\""))
        );
        assert_eq!(item.set_for(exe, true).unwrap(), LoginItemStatus::Enabled);
        // The user's marks, of each length, and one that is not binary.
        for (mark, status) in [
            (&[3u8; 12][..], LoginItemStatus::RequiresApproval),
            (&[3][..], LoginItemStatus::RequiresApproval),
            (&[2u8; 12][..], LoginItemStatus::Enabled),
            (&[][..], LoginItemStatus::Enabled),
        ] {
            set_raw(&item.approved, "com.example.a", REG_BINARY, mark);
            assert_eq!(item.status_for(exe).unwrap(), status, "{mark:?}");
        }
        set_raw(
            &item.approved,
            "com.example.a",
            REG_DWORD,
            &3u32.to_le_bytes(),
        );
        assert_eq!(item.status_for(exe).unwrap(), LoginItemStatus::Enabled);
        // Another copy: not its own, and left when that copy disables.
        assert_eq!(item.status_for(other).unwrap(), LoginItemStatus::Disabled);
        assert_eq!(
            item.set_for(other, false).unwrap(),
            LoginItemStatus::Disabled
        );
        assert!(read_string(&item.run, "com.example.a").unwrap().is_some());
        assert_eq!(item.set_for(exe, false).unwrap(), LoginItemStatus::Disabled);
        assert_eq!(read_string(&item.run, "com.example.a").unwrap(), None);
    }

    #[test]
    fn values_of_other_types_read_expanded_or_not_at_all() {
        let scratch = Scratch::new("types");
        let item = scratch.item("com.example.a");
        // An expandable string reads expanded.
        let temp = std::env::var("TEMP").unwrap();
        let exe = PathBuf::from(format!(r"{temp}\Tray App\Tray App.exe"));
        set_raw(
            &item.run,
            "com.example.a",
            REG_EXPAND_SZ,
            &wide(r#""%TEMP%\Tray App\Tray App.exe""#),
        );
        assert_eq!(item.status_for(&exe).unwrap(), LoginItemStatus::Enabled);
        assert_eq!(
            item.set_for(&exe, false).unwrap(),
            LoginItemStatus::Disabled
        );
        assert_eq!(read_string(&item.run, "com.example.a").unwrap(), None);
        // A value of another type is no command: not this copy's, left when
        // disabling, replaced when enabling.
        set_raw(&item.run, "com.example.a", REG_DWORD, &1u32.to_le_bytes());
        assert_eq!(item.status_for(&exe).unwrap(), LoginItemStatus::Disabled);
        assert_eq!(
            item.set_for(&exe, false).unwrap(),
            LoginItemStatus::Disabled
        );
        assert_eq!(item.set_for(&exe, true).unwrap(), LoginItemStatus::Enabled);
    }

    #[test]
    fn an_empty_app_id_names_no_value() {
        let scratch = Scratch::new("empty");
        let item = scratch.item("");
        let exe = Path::new(EXE);
        assert_eq!(
            item.status_for(exe).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        assert_eq!(
            item.set_for(exe, true).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
    }
}
