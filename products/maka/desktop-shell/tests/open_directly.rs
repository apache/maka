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

#![cfg(unix)]

use std::{
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::{Duration, Instant},
};

struct Staged {
    directory: PathBuf,
    shell: PathBuf,
    recorded: PathBuf,
}

impl Staged {
    fn new(case: &str) -> Self {
        let source = std::env::var_os("CARGO_BIN_EXE_maka-desktop-shell")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_maka-desktop-shell")));
        let directory = source.parent().unwrap().join(format!(
            "desktop-open-directly-{}-{case}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        let shell = directory.join(if cfg!(target_os = "macos") {
            "Maka.app/Contents/MacOS/maka-desktop-shell"
        } else {
            "maka-desktop-shell"
        });
        std::fs::create_dir_all(shell.parent().unwrap()).unwrap();
        std::fs::hard_link(&source, &shell).unwrap();
        let recorded = directory.join("recorded");
        write_script(
            &directory.join("maka"),
            &format!(
                "#!/bin/sh\nprintf '%s\\n%s\\n%s\\n' \"$*\" \"$PATH\" \"${{MAKA_TEST_LEAKED:-absent}}\" > '{}'\n",
                recorded.display()
            ),
        );
        Self {
            directory,
            shell,
            recorded,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.shell);
        command
            .env_remove("MAKA_HOST_ROOT")
            .env_remove("MAKA_HOST_ENDPOINT")
            .env_remove("MAKA_HOST_EPOCH")
            .env_remove("MAKA_LAUNCHER")
            .env_remove("TERM")
            .env_remove("COLORTERM")
            .env_remove("MAKA_SKIP_SHELL_ENV")
            .env_remove("MAKA_TEST_LEAKED")
            .env("PATH", "/usr/bin:/bin");
        command
    }

    fn run(&self, mut command: Command) -> (Output, String) {
        let output = command.output().unwrap();
        assert!(output.status.success(), "{output:?}");
        let started = Instant::now();
        let recorded = loop {
            match std::fs::read_to_string(&self.recorded) {
                Ok(text) if text.lines().count() >= 3 => break text,
                _ if started.elapsed() < Duration::from_secs(10) => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                other => panic!("the launcher beside the shell did not run: {other:?}"),
            }
        };
        (output, recorded)
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn write_script(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

fn wait_for_process_exit(pid: libc::pid_t) {
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        // SAFETY: signal 0 only probes process existence.
        if unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    // SAFETY: clean up leaked test child before failing.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
    panic!("login shell descendant {pid} survived shell PATH capture");
}

#[test]
fn gui_launch_imports_only_login_shell_path_and_cleans_up_descendants() {
    let staged = Staged::new("login-path");
    let fake_shell = staged.directory.join("zsh");
    let pid_file = staged.directory.join("descendant.pid");
    write_script(
        &fake_shell,
        &format!(
            "#!/bin/sh\n\
             [ \"$1\" = \"-i\" ] && [ \"$2\" = \"-l\" ] && [ \"$3\" = \"-c\" ] || exit 9\n\
             ( trap '' HUP TERM; sleep 60 ) </dev/null >/dev/null 2>&1 &\n\
             printf '%s' \"$!\" > '{}'\n\
             printf '● noisy startup banner\\n'\n\
             printf 'secret-from-stderr\\n' >&2\n\
             export PATH='/resolved/from/login:/usr/bin:/bin'\n\
             export MAKA_TEST_LEAKED='leaked'\n\
             exec /bin/sh -c \"$4\"\n",
            pid_file.display()
        ),
    );

    let mut command = staged.command();
    command.env("SHELL", &fake_shell);
    let (output, recorded) = staged.run(command);
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains("secret-from-stderr"),
        "stderr leaked: {:?}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        recorded,
        "desktop\n/resolved/from/login:/usr/bin:/bin\nabsent\n"
    );

    let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    wait_for_process_exit(pid);
}

#[test]
fn terminal_and_opted_out_launches_skip_login_shell_probe() {
    for (case, key, value) in [
        ("term", "TERM", "xterm-256color"),
        ("colorterm", "COLORTERM", "truecolor"),
        ("skip", "MAKA_SKIP_SHELL_ENV", "1"),
    ] {
        let staged = Staged::new(case);
        let sentinel = staged.directory.join("ran");
        let fake_shell = staged.directory.join("zsh");
        write_script(
            &fake_shell,
            &format!(
                "#!/bin/sh\nprintf 'ran' > '{}'\nexit 1\n",
                sentinel.display()
            ),
        );
        let mut command = staged.command();
        command.env("SHELL", &fake_shell).env(key, value);
        let (_, recorded) = staged.run(command);
        assert_eq!(recorded, "desktop\n/usr/bin:/bin\nabsent\n");
        assert!(!sentinel.exists(), "{case} unexpectedly ran login shell");
    }
}

#[test]
fn failed_or_flooding_login_shell_falls_back_to_inherited_path() {
    for (case, body) in [
        (
            "failed",
            "#!/bin/sh\nprintf 'secret-startup-token' >&2\nexit 23\n",
        ),
        (
            "flood",
            "#!/bin/sh\nwhile :; do printf '0123456789abcdef0123456789abcdef'; done\n",
        ),
    ] {
        let staged = Staged::new(case);
        let fake_shell = staged.directory.join("zsh");
        write_script(&fake_shell, body);
        let mut command = staged.command();
        command.env("SHELL", &fake_shell);
        let (output, recorded) = staged.run(command);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!stderr.contains("secret-startup-token"), "{stderr}");
        assert_eq!(recorded, "desktop\n/usr/bin:/bin\nabsent\n");
    }
}

#[test]
fn csh_login_shell_loads_cshrc_and_login() {
    let Some(csh) = ["/bin/tcsh", "/bin/csh", "/usr/bin/tcsh", "/usr/bin/csh"]
        .into_iter()
        .map(Path::new)
        .find(|candidate| candidate.is_file())
    else {
        return;
    };

    let staged = Staged::new("csh-login");
    std::fs::write(
        staged.directory.join(".cshrc"),
        "setenv PATH /from-cshrc:/usr/bin:/bin\n",
    )
    .unwrap();
    std::fs::write(
        staged.directory.join(".login"),
        "setenv PATH /from-login:$PATH\n",
    )
    .unwrap();

    let mut command = staged.command();
    command.env("HOME", &staged.directory).env("SHELL", csh);
    let (_, recorded) = staged.run(command);
    assert_eq!(
        recorded,
        "desktop\n/from-login:/from-cshrc:/usr/bin:/bin\nabsent\n"
    );
}
