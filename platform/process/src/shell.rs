/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use std::path::PathBuf;

/// Selected once, so the advertised dialect and executed command cannot drift.
#[derive(Clone)]
pub(crate) enum ShellPlan {
    #[cfg(unix)]
    Posix { path: PathBuf, kind: PosixShell },
    #[cfg(windows)]
    Pwsh(PathBuf),
    #[cfg(windows)]
    WindowsPowerShell(PathBuf),
    #[cfg(windows)]
    Cmd(PathBuf),
    #[cfg(windows)]
    GitBash(PathBuf),
}

impl ShellPlan {
    pub(crate) fn command(
        &self,
        cwd: &std::path::Path,
        source: &str,
        terminal: bool,
        login: bool,
    ) -> crate::Command {
        use crate::Command;
        match self {
            #[cfg(unix)]
            Self::Posix { path, .. } => {
                let _ = terminal;
                let mut command = Command::new(path, cwd);
                command.args([if login { "-lc" } else { "-c" }, source]);
                command
            }
            #[cfg(windows)]
            Self::GitBash(path) => {
                let mut command = Command::new(path, cwd);
                command.args([if login { "-lc" } else { "-c" }, source]);
                command
            }
            #[cfg(windows)]
            Self::Pwsh(path) | Self::WindowsPowerShell(path) => {
                let mut plan = Command::new(path, cwd);
                plan.arg("-NoLogo");
                if !login {
                    plan.arg("-NoProfile");
                }
                if !terminal {
                    plan.arg("-NonInteractive");
                }
                plan.args(["-Command", command::WRAPPER])
                    .env(command::SLOT, format!("{source}{}", command::EXIT));
                plan
            }
            #[cfg(windows)]
            Self::Cmd(path) => {
                let mut command = Command::new(path, cwd);
                command.raw_arg(format!("/d /s /c \"{source}\""));
                command
            }
        }
    }

    pub(crate) fn interactive(&self, cwd: &std::path::Path) -> (String, crate::pty::PtyCommand) {
        use crate::pty::PtyCommand;
        let (source, mut command) = match self {
            #[cfg(unix)]
            Self::Posix { path, .. } => {
                let source = "exec \"$SHELL\" -l";
                let mut command = PtyCommand::new(path, cwd);
                command.arg("-l").env("SHELL", path);
                (source.into(), command)
            }
            #[cfg(windows)]
            Self::GitBash(path) => {
                let mut command = PtyCommand::new(path, cwd);
                command.arg("-l");
                (format!("\"{}\" -l", path.display()), command)
            }
            #[cfg(windows)]
            Self::Pwsh(path) | Self::WindowsPowerShell(path) => {
                let source = format!("& '{}' -NoLogo", path.to_string_lossy().replace('\'', "''"));
                let mut command = PtyCommand::new(path, cwd);
                command.arg("-NoLogo");
                (source, command)
            }
            #[cfg(windows)]
            Self::Cmd(path) => {
                let mut command = PtyCommand::new(path, cwd);
                command.args(["/d", "/q"]);
                ("%ComSpec% /d /q".into(), command)
            }
        };
        command
            .env("DISABLE_AUTO_UPDATE", "true")
            .env("DISABLE_UPDATE_PROMPT", "true");
        (source, command)
    }

    pub(crate) fn detect() -> Self {
        #[cfg(unix)]
        return select_posix(account_shell().map(PathBuf::from), find_posix);
        #[cfg(windows)]
        {
            fn find(name: &str, fallback: Option<PathBuf>) -> Option<PathBuf> {
                std::env::var_os("PATH")
                    .into_iter()
                    .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
                    .map(|directory| directory.join(name))
                    .chain(fallback)
                    .find_map(|path| {
                        path.is_file()
                            .then(|| dunce::canonicalize(path).ok())
                            .flatten()
                    })
            }
            if let Some(path) = find(
                "pwsh.exe",
                std::env::var_os("ProgramFiles")
                    .map(|root| PathBuf::from(root).join(r"PowerShell\7\pwsh.exe")),
            ) {
                return Self::Pwsh(path);
            }
            let system = PathBuf::from(
                std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into()),
            );
            if let Some(path) = find(
                "powershell.exe",
                Some(system.join(r"System32\WindowsPowerShell\v1.0\powershell.exe")),
            ) {
                return Self::WindowsPowerShell(path);
            }
            Self::Cmd(system.join(r"System32\cmd.exe"))
        }
    }

    pub(crate) fn guidance(&self) -> String {
        match self {
            #[cfg(unix)]
            Self::Posix { path, kind } => {
                format!(
                    "Commands use {}; write {} syntax. Login profiles load by default; set login=false to skip them.",
                    path.display(),
                    kind.syntax(),
                )
            }
            #[cfg(windows)]
            Self::Pwsh(_) => {
                "Commands use PowerShell 7 (pwsh); write PowerShell syntax. Set login=false to skip profiles.".into()
            }
            #[cfg(windows)]
            Self::WindowsPowerShell(_) => {
                "Commands use Windows PowerShell 5.1; write PowerShell 5.1-compatible syntax. Set login=false to skip profiles.".into()
            }
            #[cfg(windows)]
            Self::GitBash(path) => format!("Commands use Git Bash ({}); write Bash syntax.", path.display()),
            #[cfg(windows)]
            Self::Cmd(_) => "Commands use cmd.exe; write cmd syntax, not bash syntax.".into(),
        }
    }
}

#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PosixShell {
    Zsh,
    Bash,
    Sh,
}

#[cfg(unix)]
impl PosixShell {
    fn from_path(path: &std::path::Path) -> Option<Self> {
        match path.file_name()?.to_str()? {
            "zsh" => Some(Self::Zsh),
            "bash" => Some(Self::Bash),
            "sh" => Some(Self::Sh),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Zsh => "zsh",
            Self::Bash => "bash",
            Self::Sh => "sh",
        }
    }

    fn syntax(self) -> &'static str {
        match self {
            Self::Zsh => "zsh",
            Self::Bash => "Bash",
            Self::Sh => "POSIX shell",
        }
    }
}

#[cfg(unix)]
fn executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_absolute()
        && std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(unix)]
fn find_posix(kind: PosixShell) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(kind.name()))
        .chain(["/bin", "/usr/bin"].map(|directory| PathBuf::from(directory).join(kind.name())))
        .find(|path| executable(path))
}

#[cfg(unix)]
fn select_posix(
    account: Option<PathBuf>,
    mut find: impl FnMut(PosixShell) -> Option<PathBuf>,
) -> ShellPlan {
    if let Some(path) = account.filter(|path| executable(path))
        && let Some(kind) = PosixShell::from_path(&path)
    {
        return ShellPlan::Posix { path, kind };
    }
    let order = if cfg!(target_os = "macos") {
        [PosixShell::Zsh, PosixShell::Bash]
    } else {
        [PosixShell::Bash, PosixShell::Zsh]
    };
    for kind in order {
        if let Some(path) = find(kind) {
            return ShellPlan::Posix { path, kind };
        }
    }
    ShellPlan::Posix {
        path: "/bin/sh".into(),
        kind: PosixShell::Sh,
    }
}

#[cfg(unix)]
fn account_shell() -> Option<std::ffi::OsString> {
    use std::{ffi::CStr, os::unix::ffi::OsStrExt};
    let mut buffer = vec![0u8; 65_536];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    // SAFETY: output pointers and scratch storage remain live through copying
    // pw_shell; no borrowed libc account memory escapes this function.
    unsafe {
        if libc::getpwuid_r(
            libc::geteuid(),
            entry.as_mut_ptr(),
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        ) != 0
            || result.is_null()
        {
            return None;
        }
        let entry = entry.assume_init();
        if entry.pw_shell.is_null() {
            return None;
        }
        let bytes = CStr::from_ptr(entry.pw_shell).to_bytes();
        (!bytes.is_empty()).then(|| std::ffi::OsStr::from_bytes(bytes).to_owned())
    }
}

#[cfg(windows)]
pub(crate) mod command {
    use std::{os::windows::ffi::OsStrExt, path::Path};

    pub(super) const SLOT: &str = "__MAKA_RUNTIME_POWERSHELL_COMMAND";
    // A read-only TEMP can put Windows PowerShell in ConstrainedLanguage.
    // Invoke-Expression parses in the current language mode; unlike
    // ScriptBlock::Create it does not require FullLanguage merely to launch a
    // native command. Never override machine application-control policy.
    pub(super) const WRAPPER: &str = r#"
if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') {
    $__makaUtf8 = [System.Text.UTF8Encoding]::new($false)
    [Console]::InputEncoding = $__makaUtf8
    [Console]::OutputEncoding = $__makaUtf8
    $OutputEncoding = $__makaUtf8
} else {
    & "$env:SystemRoot\System32\chcp.com" 65001 > $null
    $OutputEncoding = [System.Text.Encoding]::UTF8
}
$__makaCommandText = $env:__MAKA_RUNTIME_POWERSHELL_COMMAND
Remove-Item Env:\__MAKA_RUNTIME_POWERSHELL_COMMAND
Invoke-Expression $__makaCommandText
"#;
    pub(super) const EXIT: &str = "\n$__makaOk = $?\nif (-not $__makaOk) { if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } else { exit 1 } }";

    pub(crate) fn wide(path: &Path) -> std::io::Result<Vec<u16>> {
        let mut value: Vec<_> = path.as_os_str().encode_wide().collect();
        if value.contains(&0) {
            return Err(std::io::Error::other("NUL in process input"));
        }
        value.push(0);
        Ok(value)
    }

    pub(crate) fn quote(value: &str) -> String {
        let mut quoted = String::from("\"");
        let mut slashes = 0;
        for ch in value.chars() {
            if ch == '\\' {
                slashes += 1;
                continue;
            }
            quoted.extend(std::iter::repeat_n(
                '\\',
                if ch == '"' { slashes * 2 + 1 } else { slashes },
            ));
            quoted.push(ch);
            slashes = 0;
        }
        quoted.extend(std::iter::repeat_n('\\', slashes * 2));
        quoted.push('"');
        quoted
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn account_selection_and_fallback_keep_guidance_pipes_and_pty_on_one_shell() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bash");
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let selected = select_posix(Some(path.clone()), |_| panic!("account shell wins"));
        assert!(selected.guidance().contains(path.to_str().unwrap()));
        assert!(selected.guidance().contains("Bash syntax"));
        for terminal in [false, true] {
            for login in [false, true] {
                let command = selected.command(directory.path(), "echo ok", terminal, login);
                assert_eq!(command.executable, path);
                assert_eq!(command.args[0].as_ref(), if login { "-lc" } else { "-c" });
                assert_eq!(command.args[1].as_ref(), "echo ok");
            }
        }
        let (_, interactive) = selected.interactive(directory.path());
        assert_eq!(interactive.executable, path);
        assert_eq!(interactive.args[0].as_ref(), "-l");

        let unsupported = directory.path().join("fish");
        std::fs::copy(&path, &unsupported).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        for account in [None, Some(path), Some(unsupported)] {
            let mut attempted = Vec::new();
            let selected = select_posix(account, |kind| {
                attempted.push(kind);
                None
            });
            let expected = if cfg!(target_os = "macos") {
                [PosixShell::Zsh, PosixShell::Bash]
            } else {
                [PosixShell::Bash, PosixShell::Zsh]
            };
            assert_eq!(attempted, expected);
            assert!(matches!(
                selected,
                ShellPlan::Posix {
                    kind: PosixShell::Sh,
                    ..
                }
            ));
        }
        for available in [PosixShell::Bash, PosixShell::Zsh] {
            let selected = select_posix(None, |kind| {
                (kind == available).then(|| PathBuf::from("/bin").join(kind.name()))
            });
            assert!(matches!(selected, ShellPlan::Posix { kind, .. } if kind == available));
        }
    }
}
