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

use std::{
    ffi::{CStr, OsStr, OsString},
    io::{self, Read},
    os::unix::{
        ffi::{OsStrExt, OsStringExt},
        fs::PermissionsExt,
        process::CommandExt,
    },
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc::{self, RecvTimeoutError},
    time::{Duration, Instant},
};

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CAPTURE_BYTES: usize = 64 * 1024;

pub fn resolve() -> Option<OsString> {
    if std::env::var_os("MAKA_SKIP_SHELL_ENV").as_deref() == Some(OsStr::new("1"))
        || non_empty("TERM")
        || non_empty("COLORTERM")
    {
        return None;
    }
    let shell = select_shell(
        std::env::var_os("SHELL").as_deref(),
        account_shell().as_deref(),
    );
    match capture(&shell, DEFAULT_TIMEOUT) {
        Ok(path) => Some(path),
        Err(error) => {
            eprintln!("maka-desktop-shell: login shell PATH: {error}");
            None
        }
    }
}

fn non_empty(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|value| !value.is_empty())
}

fn executable(path: &Path) -> bool {
    path.is_absolute()
        && std::fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

fn select_shell(inherited: Option<&OsStr>, account: Option<&Path>) -> PathBuf {
    if let Some(raw) = inherited {
        let trimmed = Path::new(OsStr::from_bytes(raw.as_bytes().trim_ascii()));
        if executable(trimmed) {
            return trimmed.to_owned();
        }
    }
    if let Some(account) = account.filter(|path| executable(path)) {
        return account.to_owned();
    }
    PathBuf::from(if cfg!(target_os = "macos") {
        "/bin/zsh"
    } else {
        "/bin/sh"
    })
}

fn account_shell() -> Option<PathBuf> {
    let mut buffer = vec![0u8; 65_536];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    // SAFETY: out pointers and scratch buffer outlive the call; pw_shell is copied before return.
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
        let bytes = CStr::from_ptr(entry.pw_shell).to_bytes().trim_ascii();
        (!bytes.is_empty()).then(|| PathBuf::from(OsStr::from_bytes(bytes)))
    }
}

enum Chunk {
    Bytes(Vec<u8>),
    Overflow,
}

struct Probe {
    child: Child,
    pgid: Option<libc::pid_t>,
}

impl Probe {
    fn spawn(shell: &Path, mark: &str) -> Result<(Self, std::process::ChildStdout), String> {
        let name = shell
            .file_name()
            .and_then(OsStr::to_str)
            .unwrap_or_default();
        let prefix = if name == "nu" { "^" } else { "" };
        // Spawn /bin/sh so shells where $PATH is a list (fish, nu, csh) export a colon-delimited PATH.
        let script =
            format!("{prefix}/bin/sh -c 'printf \"%s%s%s\" \"$1\" \"$PATH\" \"$1\"' sh {mark}");
        let mut command = Command::new(shell);
        if matches!(name, "csh" | "tcsh") {
            command.arg0(format!("-{name}")).arg("-ic");
        } else {
            command.args(["-i", "-l", "-c"]);
        }
        command
            .arg(script)
            .env("DISABLE_AUTO_UPDATE", "true")
            .env("DISABLE_UPDATE_PROMPT", "true")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // SAFETY: setsid is async-signal-safe and isolates the interactive shell in its own session/pgrp.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("{}: {error}", shell.display()))?;
        let stdout = child.stdout.take().expect("piped stdout");
        let pgid = libc::pid_t::try_from(child.id()).ok().filter(|&id| id > 0);
        Ok((Self { child, pgid }, stdout))
    }

    fn kill_group(&mut self) {
        if let Some(pgid) = self.pgid.take() {
            // SAFETY: setsid made child the group leader; -pgid signals only that dedicated group.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.kill_group();
        let _ = self.child.wait();
    }
}

fn capture(shell: &Path, timeout: Duration) -> Result<OsString, String> {
    let mark = format!("__MAKA_PATH_{}__", uuid::Uuid::new_v4().simple());
    let (mut probe, mut stdout) = Probe::spawn(shell, &mark)?;
    let (tx, rx) = mpsc::sync_channel(16);
    std::thread::spawn(move || {
        let mut total = 0usize;
        let mut chunk = [0u8; 4096];
        while let Ok(count) = stdout.read(&mut chunk) {
            if count == 0 {
                break;
            }
            total += count;
            if total > MAX_CAPTURE_BYTES {
                let _ = tx.send(Chunk::Overflow);
                break;
            }
            if tx.send(Chunk::Bytes(chunk[..count].to_vec())).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut eof = false;
    loop {
        if let Some(parsed) = extract(&output, mark.as_bytes()) {
            return parsed.map_err(str::to_owned);
        }
        if eof
            && let Some(status) = probe
                .child
                .try_wait()
                .map_err(|error| format!("{}: {error}", shell.display()))?
        {
            return if status.success() {
                Err(format!("missing PATH markers from {}", shell.display()))
            } else {
                Err(format!("{} exited with {status}", shell.display()))
            };
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for {}", shell.display()));
        }
        if eof {
            std::thread::sleep(Duration::from_millis(5).min(deadline - now));
            continue;
        }
        match rx.recv_timeout((deadline - now).min(Duration::from_millis(50))) {
            Ok(Chunk::Bytes(bytes)) => output.extend_from_slice(&bytes),
            Ok(Chunk::Overflow) => {
                return Err(format!(
                    "{} output exceeded {MAX_CAPTURE_BYTES} bytes",
                    shell.display()
                ));
            }
            Err(RecvTimeoutError::Disconnected) => eof = true,
            Err(RecvTimeoutError::Timeout) => {}
        }
    }
}

fn extract(output: &[u8], mark: &[u8]) -> Option<Result<OsString, &'static str>> {
    let start = output
        .windows(mark.len())
        .position(|window| window == mark)?
        + mark.len();
    let rest = &output[start..];
    let end = rest.windows(mark.len()).position(|window| window == mark)?;
    let bytes = &rest[..end];
    if bytes.is_empty() || bytes.contains(&0) {
        return Some(Err("login shell returned an empty or invalid PATH"));
    }
    Some(Ok(OsString::from_vec(bytes.to_vec())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_selection_falls_back_through_executable_candidates() {
        let dir = std::env::temp_dir().join(format!("maka-login-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let inherited = dir.join("inherited-sh");
        let account = dir.join("account-sh");
        std::fs::write(&inherited, "#!/bin/sh\n").unwrap();
        std::fs::write(&account, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&inherited, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::set_permissions(&account, std::fs::Permissions::from_mode(0o700)).unwrap();

        let padded = OsString::from(format!("  {} \n", inherited.display()));
        assert_eq!(select_shell(Some(&padded), Some(&account)), inherited);

        std::fs::set_permissions(&inherited, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(select_shell(Some(&padded), Some(&account)), account);
        assert_eq!(
            select_shell(Some(OsStr::new("relative/sh")), Some(&account)),
            account
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn timeout_kills_hung_shell_and_its_process_group() {
        let dir = std::env::temp_dir().join(format!("maka-login-timeout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let shell = dir.join("hung-shell");
        let pid_file = dir.join("child.pid");
        std::fs::write(
            &shell,
            format!(
                "#!/bin/sh\n[ \"$1\" = warmup ] && exit 0\n( trap '' HUP TERM; sleep 60 ) </dev/null >/dev/null 2>&1 &\nprintf '%s' \"$!\" > '{}'\nwait\n",
                pid_file.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            Command::new(&shell)
                .arg("warmup")
                .status()
                .unwrap()
                .success()
        );

        let error = capture(&shell, Duration::from_millis(500)).unwrap_err();
        assert!(error.contains("timed out"), "{error}");

        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(5) {
            // SAFETY: signal 0 only probes process existence.
            if unsafe { libc::kill(pid, 0) } != 0
                && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        // SAFETY: clean up leaked test child before failing.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
        let _ = std::fs::remove_dir_all(&dir);
        panic!("descendant {pid} survived timeout cleanup");
    }
}
