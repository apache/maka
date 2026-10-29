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

#![cfg(target_os = "macos")]

use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy, Rule},
    launch::Launch,
};
use std::{fs, net::TcpListener, path::Path, process::Output};

fn run(policy: Policy, network: Network, program: &str, args: &[&str], cwd: &Path) -> Output {
    let launch = Sandbox::Managed {
        filesystem: policy,
        network,
    }
    .prepare(cwd)
    .unwrap();
    let mut command = match launch {
        Launch::Direct => std::process::Command::new(program),
        Launch::Wrapped {
            program: wrapper,
            args,
        } => {
            let mut command = std::process::Command::new(wrapper);
            command.args(args).arg(program);
            command
        }
    };
    command
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .output()
        .unwrap()
}

#[test]
fn seatbelt_enforces_nested_boundaries_and_prevents_rename_and_symlink_escape() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let workspace = root.join("workspace");
    let metadata = workspace.join(".git");
    let reopened = metadata.join("output");
    fs::create_dir_all(&reopened).unwrap();
    fs::write(root.join("outside"), "outside").unwrap();
    fs::write(metadata.join("secret"), "secret").unwrap();
    fs::write(reopened.join("read-only"), "unchanged").unwrap();
    std::os::unix::fs::symlink(root.join("outside"), workspace.join("alias")).unwrap();
    let policy = Policy {
        default: Access::Read,
        rules: vec![
            Rule::subtree(&workspace, Access::Write),
            Rule::subtree(&metadata, Access::Read),
            Rule::subtree(&reopened, Access::Write),
            Rule::exact(metadata.join("secret"), Access::Deny),
            Rule::exact(reopened.join("read-only"), Access::Read),
        ],
        deny_globs: vec![],
    };
    let write = |path: &Path| {
        run(
            policy.clone(),
            Network::Denied,
            "/bin/sh",
            &[
                "-c",
                "printf changed > \"$1\"",
                "--",
                path.to_str().unwrap(),
            ],
            &root,
        )
    };
    assert!(write(&workspace.join("ok")).status.success());
    assert!(write(&reopened.join("ok")).status.success());
    for path in [
        root.join("outside"),
        metadata.join("config"),
        reopened.join("read-only"),
        workspace.join("alias"),
    ] {
        assert!(!write(&path).status.success(), "{path:?}");
    }
    assert!(
        !run(
            policy.clone(),
            Network::Denied,
            "/bin/cat",
            &[metadata.join("secret").to_str().unwrap()],
            &root
        )
        .status
        .success()
    );
    assert!(
        !run(
            policy.clone(),
            Network::Denied,
            "/bin/mv",
            &[
                metadata.to_str().unwrap(),
                workspace.join("moved").to_str().unwrap()
            ],
            &root
        )
        .status
        .success()
    );
    assert_eq!(fs::read_to_string(root.join("outside")).unwrap(), "outside");
    assert_eq!(
        fs::read_to_string(reopened.join("read-only")).unwrap(),
        "unchanged"
    );
    let writable_alias = workspace.join("hardlink");
    let link = run(
        policy.clone(),
        Network::Denied,
        "/bin/ln",
        &[
            reopened.join("read-only").to_str().unwrap(),
            writable_alias.to_str().unwrap(),
        ],
        &root,
    );
    if link.status.success() {
        assert!(
            !write(&writable_alias).status.success(),
            "hardlink bypassed read-only policy"
        );
    }
    let secret_alias = workspace.join("secret-link");
    let link = run(
        policy.clone(),
        Network::Denied,
        "/bin/ln",
        &[
            metadata.join("secret").to_str().unwrap(),
            secret_alias.to_str().unwrap(),
        ],
        &root,
    );
    if link.status.success() {
        assert!(
            !run(
                policy.clone(),
                Network::Denied,
                "/bin/cat",
                &[secret_alias.to_str().unwrap()],
                &root
            )
            .status
            .success(),
            "hardlink bypassed read denial"
        );
    }
    assert_eq!(
        fs::read_to_string(reopened.join("read-only")).unwrap(),
        "unchanged"
    );
}

#[test]
fn seatbelt_network_policy_controls_real_loopback_connections() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let policy = Policy::uniform(Access::Read);
    for (network, permitted) in [(Network::Denied, false), (Network::Allowed, true)] {
        let output = run(
            policy.clone(),
            network,
            "/usr/bin/nc",
            &["-z", "-w", "1", "127.0.0.1", &port],
            Path::new("/"),
        );
        assert_eq!(
            output.status.success(),
            permitted,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let sandbox = Sandbox::Managed {
        filesystem: policy,
        network: Network::destination(maka_sandbox::Destination::new("example.org", 443).unwrap()),
    };
    // No IPv6 listener is needed to prove that its exception cannot reach an
    // existing IPv4 listener on the same port (including IPv6-disabled hosts).
    for (host, permitted) in [("127.0.0.1", true), ("[::1]", false)] {
        let Launch::Wrapped { program, args } = sandbox
            .prepare_with_proxy(Path::new("/"), format!("{host}:{port}").parse().unwrap())
            .unwrap()
        else {
            unreachable!()
        };
        let output = std::process::Command::new(program)
            .args(args)
            .args(["/usr/bin/nc", "-z", "-G", "1", "127.0.0.1", &port])
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            permitted,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn seatbelt_globs_match_host_decisions_and_protect_future_matches_from_rename() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let files = [
        "a/.env",
        "a/deep/.env",
        "a/private/key",
        "a/public",
        "b/.env",
        "b/public",
        "école/secret",
        "école/public",
        "a-star-b",
        "public",
        "a/é",
        "a/ê",
        "a/ab",
        "a/abcd",
        "a/e\u{301}",
        "a/😀",
        "a/é-dir/secret",
        "a/line\nbreak",
        "a/q\"uote",
    ];
    for file in files {
        let path = root.join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "original").unwrap();
    }
    let mut mismatches = Vec::new();
    for (pattern, protected_parent) in [
        ("**/.env", "a"),
        ("{a/private,école}/**", "a"),
        ("a/?ublic", "a"),
        ("a/?", "a"),
        ("a/??", "a"),
        ("a/???", "a"),
        ("a/????", "a"),
        ("a/??-dir/secret", "a"),
        ("a/[pd]*", "a"),
        ("a/deep/*.future", "a"),
        ("école/secret", "école"),
        ("a**b", ""),
        ("a/{é,ê}", "a"),
        ("a/[!p]*", "a"),
        ("a/line?break", "a"),
        ("a/q\"uote", "a"),
    ] {
        let policy = Policy {
            default: Access::Read,
            rules: vec![Rule::subtree(&root, Access::Write)],
            deny_globs: vec![format!("{}/{pattern}", root.display())],
        };
        let compiled = policy.compile().unwrap();
        for file in files {
            let path = root.join(file);
            let expected = compiled.access(&path);
            let read = run(
                policy.clone(),
                Network::Denied,
                "/bin/cat",
                &[path.to_str().unwrap()],
                &root,
            );
            if read.status.success() != expected.can_read() {
                mismatches.push(format!(
                    "read {pattern} / {file}: kernel={} host={}",
                    read.status.success(),
                    expected.can_read()
                ));
            }
            let write = run(
                policy.clone(),
                Network::Denied,
                "/bin/sh",
                &[
                    "-c",
                    "printf changed > \"$1\"",
                    "--",
                    path.to_str().unwrap(),
                ],
                &root,
            );
            if write.status.success() != expected.can_write() {
                mismatches.push(format!(
                    "write {pattern} / {file}: kernel={} host={}",
                    write.status.success(),
                    expected.can_write()
                ));
            }
        }
        if !protected_parent.is_empty() {
            let rename = run(
                policy.clone(),
                Network::Denied,
                "/bin/mv",
                &[
                    root.join(protected_parent).to_str().unwrap(),
                    root.join("renamed").to_str().unwrap(),
                ],
                &root,
            );
            assert!(!rename.status.success(), "rename escaped {pattern}");
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
