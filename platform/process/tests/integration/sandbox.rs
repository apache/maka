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

use maka_agent_facts::tools::ToolExecutor;
use maka_process::{SHELL_NAME, ShellExecutor};
use maka_sandbox::{
    Network, Sandbox,
    filesystem::{Access, Policy, Rule},
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "macos")]
#[tokio::test]
async fn destination_grants_route_native_pipes_and_ptys_without_allowing_direct_connections() {
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let root = tempfile::tempdir().unwrap();
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let denied = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = origin.local_addr().unwrap();
        let denied_address = denied.local_addr().unwrap();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (mut socket, _) = origin.accept().await.unwrap();
                let mut headers = Vec::new();
                while !headers.ends_with(b"\r\n\r\n") {
                    headers.push(socket.read_u8().await.unwrap());
                }
                socket
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK",
                    )
                    .await
                    .unwrap();
            }
        });
        let sandbox = Sandbox::Managed {
            filesystem: Policy {
                default: Access::Read,
                rules: vec![],
                deny_globs: vec![],
            },
            network: Network::destination(
                maka_sandbox::Destination::new("127.0.0.1", address.port()).unwrap(),
            ),
        };
        let executor = ShellExecutor::new(root.path(), sandbox).unwrap();
        let command = format!(
            r#"
            /usr/bin/curl -fsS --max-time 2 http://{address} || exit 10
            if /usr/bin/curl -fsS --max-time 2 http://{denied_address}; then exit 11; fi
            if /usr/bin/curl --noproxy '*' -fsS --max-time 2 http://{address}; then exit 12; fi
        "#
        );
        let output = executor
            .invoke(
                SHELL_NAME.into(),
                json!({"command":command}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(output["status"], "completed", "{output}");
        assert_eq!(output["exitCode"], 0, "{output}");
        assert_eq!(output["output"]["stdout"], "OK", "{output}");
        let (mut child, terminal) = maka_process::pty::spawn(
            executor.command_pty(&command).unwrap(),
            maka_agent_facts::terminal::TerminalSize::new(80, 24).unwrap(),
        )
        .await
        .unwrap();
        let mut output = Vec::new();
        let (status, ()) = tokio::join!(child.wait(), async {
            let mut buffer = [0; 4096];
            loop {
                let count = terminal.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                output.extend_from_slice(&buffer[..count]);
            }
        });
        assert!(
            status.unwrap().success(),
            "{}",
            String::from_utf8_lossy(&output)
        );
        child.close().await.unwrap();
        server.await.unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), denied.accept())
                .await
                .is_err()
        );
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn loader_configuration_cannot_execute_before_the_sandbox_boundary() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let work = root.join("work");
    let outside = root.join("outside");
    std::fs::create_dir(&work).unwrap();
    std::fs::create_dir(&outside).unwrap();
    let sandbox = Sandbox::Managed {
        filesystem: Policy {
            default: Access::Read,
            rules: vec![
                Rule::subtree(&work, Access::Write),
                Rule::subtree(work.join(".git"), Access::Read),
            ],
            deny_globs: Vec::new(),
        },
        network: Network::Denied,
    };
    let command = || {
        let mut command = maka_process::Command::new("/bin/sh", &work)
            .sandbox(&sandbox)
            .unwrap();
        // Overrides after capture must be checked too, before allocating guards.
        command
            .args(["-c", "touch unexpected"])
            .env("LD_DEBUG", "libs")
            .env("LD_DEBUG_OUTPUT", outside.join("loader"));
        command
    };
    let failure = match maka_process::pipe::spawn(command()).await {
        Ok(_) => panic!("pipe accepted loader control before isolation"),
        Err(error) => error,
    };
    assert!(
        failure.to_string().contains("inside the sandboxed command"),
        "{failure}"
    );
    let failure = match maka_process::pty::spawn(
        command(),
        maka_agent_facts::terminal::TerminalSize::new(80, 24).unwrap(),
    )
    .await
    {
        Ok(_) => panic!("PTY accepted loader control before isolation"),
        Err(error) => error,
    };
    assert!(
        failure.to_string().contains("inside the sandboxed command"),
        "{failure}"
    );
    assert_eq!(std::fs::read_dir(&work).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);

    #[cfg(target_os = "linux")]
    for target in [&outside, &work] {
        // Loader diagnostics are a real pre-main filesystem effect: permitted
        // inside work, denied outside it. Normal target env remains available.
        let mut command = maka_process::Command::new("/usr/bin/env", &work);
        command.env("MAKA_ALLOWED", "yes").args([
            "LD_DEBUG=libs".into(),
            format!("LD_DEBUG_OUTPUT={}", target.join("loader").display()),
            "/bin/sh".into(),
            "-c".into(),
            "test \"$MAKA_ALLOWED\" = yes".into(),
        ]);
        let maka_process::pipe::Spawned {
            mut child,
            stdin,
            mut stdout,
            mut stderr,
        } = maka_process::pipe::spawn(command.sandbox(&sandbox).unwrap())
            .await
            .unwrap();
        drop(stdin);
        use tokio::io::AsyncReadExt;
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let (status, _, _) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                child.wait(),
                stdout.read_to_end(&mut output),
                stderr.read_to_end(&mut errors)
            )
        })
        .await
        .unwrap();
        assert!(
            status.unwrap().success(),
            "{}",
            String::from_utf8_lossy(&errors)
        );
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }
    #[cfg(target_os = "linux")]
    assert!(std::fs::read_dir(&work).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .as_encoded_bytes()
            .starts_with(b"loader.")
    }));
}

#[tokio::test]
async fn foreground_and_observed_shells_share_nested_filesystem_boundaries() {
    for default in [
        Access::Read,
        #[cfg(target_os = "linux")]
        Access::Deny,
    ] {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join("work/protected")).unwrap();
        std::fs::create_dir_all(root.join("work/protected/reopened")).unwrap();
        std::fs::write(root.join("outside"), "unchanged").unwrap();
        std::fs::write(root.join("work/protected/secret"), "secret").unwrap();
        let mut rules = vec![
            Rule::subtree(root.join("work"), Access::Write),
            Rule::subtree(root.join("work/protected"), Access::Deny),
            Rule::subtree(root.join("work/protected/reopened"), Access::Write),
            Rule::subtree(root.join("work/.git"), Access::Read),
        ];
        if default == Access::Deny {
            rules.extend(["/usr", "/etc"].map(|path| Rule::subtree(path, Access::Read)));
        }
        let executor = ShellExecutor::new(
            root.join("work"),
            Sandbox::Managed {
                filesystem: Policy {
                    default,
                    rules,
                    deny_globs: Vec::new(),
                },
                network: Network::Denied,
            },
        )
        .unwrap();
        let command = r#"
        printf permitted > allowed || exit 10
        printf reopened > protected/reopened/allowed || exit 11
        if printf escaped > ../outside; then exit 12; fi
        if cat protected/secret; then exit 13; fi
        if mv protected moved; then exit 14; fi
        if ln -s ../outside alias && printf escaped > alias; then exit 15; fi
        if mkdir -p .git && printf escaped > .git/config; then exit 16; fi
        rm -f alias
        printf completed
    "#;
        let foreground = executor
            .invoke(
                SHELL_NAME.into(),
                json!({"command":command}),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(foreground["status"], "completed", "{foreground}");
        assert_eq!(foreground["output"]["stdout"], "completed");
        assert!(!root.join("work/.git").exists());
        let rejected = executor
            .command_pipes("printf unexpected > rejected-effect")
            .unwrap();
        assert!(!root.join("work/.git").exists());
        drop(rejected);
        assert!(!root.join("work/.git").exists());
        assert!(!root.join("work/rejected-effect").exists());
        let prepared = executor
            .command_pipes("printf unexpected > cancelled-effect")
            .unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(
            prepared
                .observe(Some(5000), cancelled)
                .unwrap()
                .completion
                .await
                .is_err()
        );
        assert!(!root.join("work/.git").exists());
        assert!(!root.join("work/cancelled-effect").exists());
        let mut observed = executor
            .observe(command.into(), Some(5000), CancellationToken::new())
            .unwrap();
        let (result, started) = tokio::join!(observed.completion, async {
            let mut started = false;
            while let Some(event) = observed.events.recv().await {
                if matches!(event, maka_process::PipeEvent::Started) {
                    started = true;
                }
            }
            started
        });
        assert!(started);
        assert!(!root.join("work/.git").exists());
        let result = result.unwrap();
        assert!(
            matches!(result.outcome, maka_process::ProcessOutcome::Exited(status) if status.success()),
            "{result:?}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("outside")).unwrap(),
            "unchanged"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("work/protected/secret")).unwrap(),
            "secret"
        );
    }
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn network_policy_blocks_host_sockets_without_breaking_anonymous_ipc() {
    use std::os::unix::net::UnixDatagram;
    let temp = tempfile::tempdir().unwrap();
    let listener = UnixDatagram::bind(temp.path().join("host.sock")).unwrap();
    listener.set_nonblocking(true).unwrap();
    let tcp = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    for network in [Network::Denied, Network::Allowed] {
        let source = r#"
import socket, sys, ctypes, errno, platform
if platform.machine() == 'x86_64':
    libc = ctypes.CDLL(None, use_errno=True)
    for number in [512, 547, 0x40000029]:
        assert libc.syscall(number, socket.AF_INET, socket.SOCK_STREAM, 0) == -1
        assert ctypes.get_errno() == errno.ENOSYS
for factory in [
    lambda: socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM),
    lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)[0],
    lambda: socket.socketpair(socket.AF_UNIX, socket.SOCK_RAW)[0],
]:
    try:
        sender = factory()
        sender.sendmsg([b'escaped'], [], 0, 'host.sock')
    except PermissionError:
        pass
    else:
        raise AssertionError('Host datagram socket was reachable')
a, b = socket.socketpair()
a.sendmsg([b'ipc'])
assert b.recv(3) == b'ipc'
a.send(b'normal')
assert b.recv(6) == b'normal'
try:
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client.settimeout(1)
    client.connect(('127.0.0.1', int(sys.argv[1])))
except PermissionError:
    assert sys.argv[2] == 'denied'
else:
    assert sys.argv[2] == 'allowed'
"#;
        let mut command = maka_process::Command::new("/usr/bin/python3", temp.path());
        command.env_clear().env("PATH", "/usr/bin:/bin").args([
            "-c",
            source,
            &tcp.local_addr().unwrap().port().to_string(),
            if network == Network::Allowed {
                "allowed"
            } else {
                "denied"
            },
        ]);
        let command = command
            .sandbox(&Sandbox::Managed {
                filesystem: Policy::uniform(Access::Read),
                network,
            })
            .unwrap();
        let spawned = maka_process::pipe::spawn(command).await.unwrap();
        let maka_process::pipe::Spawned {
            mut child,
            mut stdout,
            mut stderr,
            stdin,
        } = spawned;
        drop(stdin);
        use tokio::io::AsyncReadExt;
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let (status, _, _) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::join!(
                child.wait(),
                stdout.read_to_end(&mut output),
                stderr.read_to_end(&mut errors)
            )
        })
        .await
        .unwrap();
        assert!(
            status.unwrap().success(),
            "{}",
            String::from_utf8_lossy(&errors)
        );
        assert_eq!(
            listener.recv(&mut [0; 32]).unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }
}
