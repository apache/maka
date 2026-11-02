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

#![cfg(target_os = "linux")]

use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy, Rule},
    launch::Launch,
};
use std::{
    fs,
    net::{TcpListener, TcpStream},
    os::{fd::AsRawFd, unix::process::CommandExt},
    path::Path,
    process::{Command, Output},
};

struct Prepared {
    command: Option<Command>,
    lease: Option<maka_sandbox::launch::MountLease>,
}
impl std::ops::Deref for Prepared {
    type Target = Command;
    fn deref(&self) -> &Command {
        self.command.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for Prepared {
    fn deref_mut(&mut self) -> &mut Command {
        self.command.as_mut().unwrap()
    }
}
impl Drop for Prepared {
    fn drop(&mut self) {
        self.command.take();
        if let Some(lease) = self.lease.take() {
            lease.finish().unwrap();
        }
    }
}

fn command(policy: &Policy, network: Network, cwd: &Path, executable: &Path) -> Prepared {
    let Launch::Wrapped {
        program,
        args,
        files,
        lease,
    } = Sandbox::Managed {
        filesystem: policy.clone(),
        network,
    }
    .prepare(cwd)
    .unwrap()
    else {
        panic!("managed execution must not bypass isolation")
    };
    let mut command = Command::new(program);
    command
        .args(args)
        .arg(executable)
        .current_dir(cwd)
        .env_clear();
    // Launch descriptors must survive only the wrapper's exec, not leak from
    // the multithreaded parent. Production pipe and PTY owners do the same.
    unsafe {
        command.pre_exec(move || {
            for file in &files {
                if libc::fcntl(file.as_raw_fd(), libc::F_SETFD, 0) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    Prepared {
        command: Some(command),
        lease: Some(lease),
    }
}

#[test]
fn bubblewrap_enforces_mount_boundaries_and_network_policy() {
    const CONNECT: &str = "MAKA_SANDBOX_TEST_CONNECT";
    // Re-enter the same test binary as the sandboxed network client; no Python,
    // curl or distro-specific shell networking extensions are needed.
    if let Ok(address) = std::env::var(CONNECT) {
        let result = TcpStream::connect_timeout(
            &address.parse().unwrap(),
            std::time::Duration::from_secs(2),
        );
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    // Real workspaces commonly live on a different filesystem from /tmp.
    let directory = tempfile::tempdir_in(std::env::current_dir().unwrap()).unwrap();
    let temporary = tempfile::tempdir().unwrap();
    let other_filesystem = temporary
        .path()
        .canonicalize()
        .unwrap()
        .join("missing-secret");
    let root = directory.path().canonicalize().unwrap();
    let workspace = root.join("workspace");
    let protected = workspace.join("protected");
    fs::create_dir_all(protected.join("output")).unwrap();
    fs::write(protected.join("secret"), "private").unwrap();
    fs::write(protected.join("config"), "original").unwrap();
    fs::write(root.join("outside"), "outside").unwrap();
    std::os::unix::fs::symlink(root.join("outside"), workspace.join("alias")).unwrap();
    let policy = Policy {
        default: Access::Read,
        rules: vec![
            Rule::subtree(&workspace, Access::Write),
            Rule::subtree(&protected, Access::Read),
            Rule::exact(protected.join("secret"), Access::Deny),
            Rule::subtree(protected.join("output"), Access::Write),
            Rule::subtree(workspace.join(".git"), Access::Read),
            Rule::subtree(workspace.join(".agents"), Access::Read),
            Rule::exact(workspace.join("missing-secret"), Access::Deny),
            Rule::subtree(workspace.join("new/deep/.git"), Access::Read),
            Rule::exact(&other_filesystem, Access::Deny),
        ],
        deny_globs: vec![],
    };
    let run = |script: &str| -> Output {
        command(&policy, Network::Denied, &workspace, Path::new("/bin/sh"))
            .args(["-c", script])
            .output()
            .unwrap()
    };
    let allowed = run("printf accepted > ordinary; printf nested > protected/output/accepted");
    assert!(
        allowed.status.success(),
        "{}",
        String::from_utf8_lossy(&allowed.stderr)
    );
    for script in [
        "printf bad > ../outside",
        "printf bad > alias",
        "printf bad > protected/config",
        "cat protected/secret",
        "mv protected moved",
        "ln protected/config hardlink && printf bad > hardlink",
        "ln protected/secret leaked && cat leaked",
        "printf bad > .git/config",
        "rmdir .agents",
        "cat missing-secret",
        "printf bad > new/deep/.git/config",
        "mv new relocated",
    ] {
        let blocked = run(script);
        assert!(!blocked.status.success(), "{script}");
    }
    assert_eq!(
        fs::read_to_string(workspace.join("ordinary")).unwrap(),
        "accepted"
    );
    assert_eq!(
        fs::read_to_string(protected.join("config")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_to_string(root.join("outside")).unwrap(), "outside");
    for name in [".git", ".agents", "missing-secret", "new"] {
        assert!(!workspace.join(name).exists(), "cleanup left {name}");
    }
    assert!(!other_filesystem.exists());
    let mut unsupported = policy.clone();
    unsupported.rules.push(Rule::subtree(
        root.join("z-missing/descendant"),
        Access::Write,
    ));
    assert!(
        Sandbox::Managed {
            filesystem: unsupported,
            network: Network::Denied
        }
        .prepare(&workspace)
        .is_err()
    );
    assert!(
        !workspace.join(".git").exists(),
        "failed preparation must roll back its placeholders"
    );
    // Two prepared/running commands share an inode lease, not ownership inferred
    // from the current emptiness of a directory. Finishing either cannot remove
    // another live sandbox's mount target.
    let first = command(&policy, Network::Denied, &workspace, Path::new("/bin/sh"));
    let second = command(
        &policy,
        Network::Denied,
        &std::env::temp_dir().canonicalize().unwrap(),
        Path::new("/bin/sh"),
    );
    drop(first);
    assert!(workspace.join(".git").is_dir());
    assert!(workspace.join("new/deep/.git").is_dir());
    assert!(other_filesystem.is_file());
    drop(second);
    assert!(!workspace.join(".git").exists());
    assert!(!workspace.join("new").exists());
    assert!(!other_filesystem.exists());
    let output = run("printf preserve > new/user-file");
    assert!(output.status.success(), "{output:?}");
    assert!(!workspace.join("new/deep").exists());
    assert_eq!(
        fs::read_to_string(workspace.join("new/user-file")).unwrap(),
        "preserve"
    );
    // Even when an owner fails before native spawn, recovery only removes its
    // recorded empty inode. A real replacement directory must survive.
    let mut abandoned = command(&policy, Network::Denied, &workspace, Path::new("/bin/sh"));
    let lease = abandoned.lease.take().unwrap();
    abandoned.command.take();
    drop(abandoned);
    drop(lease);
    fs::remove_dir(workspace.join(".git")).unwrap();
    fs::create_dir(workspace.join(".git")).unwrap();
    fs::write(workspace.join(".git/user-data"), "preserve").unwrap();
    drop(command(
        &policy,
        Network::Denied,
        &workspace,
        Path::new("/bin/sh"),
    ));
    assert_eq!(
        fs::read_to_string(workspace.join(".git/user-data")).unwrap(),
        "preserve"
    );
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    for network in [Network::Denied, Network::Allowed] {
        let result = command(
            &policy,
            network.clone(),
            &workspace,
            &std::env::current_exe().unwrap(),
        )
        .args([
            "--exact",
            "bubblewrap::bubblewrap_enforces_mount_boundaries_and_network_policy",
            "--nocapture",
        ])
        .env(CONNECT, listener.local_addr().unwrap().to_string())
        .output()
        .unwrap();
        assert_eq!(
            result.status.success(),
            network == Network::Allowed,
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}

#[test]
fn glob_snapshot_masks_existing_secrets_and_refreshes_on_the_next_launch() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    fs::create_dir_all(root.join(".hidden/private/nested")).unwrap();
    fs::write(root.join(".hidden/private/nested/secret"), "untouched").unwrap();
    fs::write(root.join("target"), "untouched").unwrap();
    std::os::unix::fs::symlink(root.join("target"), root.join("key.secret")).unwrap();
    let policy = Policy {
        default: Access::Read,
        rules: vec![
            Rule::subtree(&root, Access::Write),
            Rule::subtree(root.join(".hidden/private/nested"), Access::Write),
        ],
        deny_globs: vec![
            format!("{}/**/private", root.display()),
            format!("{}/*.secret", root.display()),
        ],
    };
    let first = command(&policy, Network::Denied, &root, Path::new("/bin/sh"))
        .args(["-c", "if cat .hidden/private/nested/secret || cat key.secret || cat target; then exit 91; fi; printf fresh > new.secret"])
        .output().unwrap();
    assert!(first.status.success(), "{first:?}");
    assert_eq!(
        fs::read_to_string(root.join("new.secret")).unwrap(),
        "fresh"
    );
    let second = command(&policy, Network::Denied, &root, Path::new("/bin/sh"))
        .args(["-c", "cat new.secret"])
        .output()
        .unwrap();
    assert!(!second.status.success(), "{second:?}");
    assert_eq!(
        fs::read_to_string(root.join("target")).unwrap(),
        "untouched"
    );
}
