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

mod inspection;

use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_plugin_core::composition::{Environment, ExecutionLocation, Input};
use serde_json::Value;
use std::{collections::BTreeMap, process::Command};

#[test]
fn durable_application_commands_commit_read_cas_and_never_claim_readiness() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let owner = RootOwner::create(&root, &namespaces).unwrap();
    drop(owner);
    let input = Input {
        environment: Environment {
            location: ExecutionLocation::Host,
            presentation: None,
        },
        instances: BTreeMap::new(),
        recovery: None,
        launch: None,
    };
    let path = dir.path().join("input.json");
    std::fs::write(&path, serde_json::to_vec(&input).unwrap()).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let commit = || {
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args([
                "application",
                "commit",
                "--root",
                root.to_str().unwrap(),
                "--deployment",
                &id,
                "--expected-revision",
                "0",
                "--input",
                path.to_str().unwrap(),
            ])
            .output()
            .unwrap()
    };
    let output = commit();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let source: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(source["deployment"], id);
    assert_eq!(source["revision"], 1);
    assert!(source.get("ready").is_none());
    let read = Command::new(env!("CARGO_BIN_EXE_maka"))
        .args([
            "application",
            "read",
            "--root",
            root.to_str().unwrap(),
            "--deployment",
            &id,
        ])
        .output()
        .unwrap();
    assert!(
        read.status.success(),
        "{}",
        String::from_utf8_lossy(&read.stderr)
    );
    let loaded: Value = serde_json::from_slice(&read.stdout).unwrap();
    assert_eq!(loaded["reference"], source);
    assert_eq!(loaded["input"], serde_json::to_value(input).unwrap());
    assert!(!commit().status.success());
    assert!(RootOwner::open(&root, &namespaces).is_ok());
}

#[test]
fn source_rejection_diagnostics_cannot_execute_terminal_control_sequences() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("input.json");
    let root = dir.path().join("absent-root");
    std::fs::write(
        &path,
        serde_json::to_vec(&serde_json::json!({"\u{1b}]52;c;hostile\u{7}": 1})).unwrap(),
    )
    .unwrap();
    for command in ["check", "commit"] {
        let mut process = Command::new(env!("CARGO_BIN_EXE_maka"));
        process.args(["application", command, "--input"]).arg(&path);
        if command == "commit" {
            process.arg("--root").arg(&root).args([
                "--deployment",
                "00000000-0000-0000-0000-000000000001",
                "--expected-revision",
                "0",
            ]);
        }
        let output = process.output().unwrap();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert!(String::from_utf8_lossy(&output.stderr).contains("unknown field"));
        assert!(!output.stderr.contains(&0x1b));
        assert!(!output.stderr.contains(&0x07));
        assert!(!root.exists());
    }
}

#[test]
fn url_install_commits_validated_bytes_without_changing_the_composition() {
    use sha2::{Digest, Sha256};
    use std::{
        io::{Read, Write},
        sync::Arc,
    };
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let owner = RootOwner::create(&root, &RootNamespaces::for_current_account().unwrap()).unwrap();
    let deployment = uuid::Uuid::new_v4();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let input = Input {
        environment: Environment {
            location: ExecutionLocation::Host,
            presentation: None,
        },
        instances: BTreeMap::new(),
        recovery: None,
        launch: None,
    };
    runtime.block_on(async {
        let store = maka_event_log::root_store::RootStore::open(Arc::new(owner))
            .await
            .unwrap();
        store
            .commit_application(deployment, 0, input.clone(), vec![], vec![])
            .await
            .unwrap();
        store.shutdown().await.unwrap();
    });
    let package = maka_packages::Package::new(BTreeMap::from([
        ("maka.extension.json".into(), br#"{"schemaVersion":1,"id":"example.url-cli","application":{"entries":{"host":{"implementation":{"kind":"javascript","module":"host.mjs","realm":"shared"},"configuration":{"type":"object"},"imports":{},"exports":{}}}}}"#.to_vec()),
        ("host.mjs".into(), b"export function activate() { return {}; }".to_vec()),
    ])).unwrap();
    let bytes = package.to_bundle();
    let digest = hex::encode(Sha256::digest(&bytes));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/plugin.maka-plugin",
        listener.local_addr().unwrap()
    );
    let worker = std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut request = [0; 8192];
                    let mut received = 0;
                    while !request[..received]
                        .windows(4)
                        .any(|bytes| bytes == b"\r\n\r\n")
                    {
                        assert!(
                            received < request.len(),
                            "package request headers exceed the fixture limit"
                        );
                        let read = stream.read(&mut request[received..]).unwrap();
                        assert!(read > 0, "package request ended before its headers");
                        received += read;
                    }
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .unwrap();
                    stream.write_all(&bytes).unwrap();
                    return;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(error) => panic!("package fixture: {error}"),
            }
        }
    });
    let output = Command::new(env!("CARGO_BIN_EXE_maka"))
        .args([
            "application",
            "install-url",
            "--root",
            root.to_str().unwrap(),
            "--deployment",
            &deployment.to_string(),
            "--url",
            &url,
            "--sha256",
            &digest,
            "--expected-revision",
            "1",
        ])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    worker.join().unwrap();
    let installed: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(installed["source"]["revision"], 2);
    assert_eq!(
        installed["package"],
        serde_json::to_value(package.application_ref()).unwrap()
    );
    runtime.block_on(async {
        let owner =
            RootOwner::open(&root, &RootNamespaces::for_current_account().unwrap()).unwrap();
        let store = maka_event_log::root_store::RootStore::open(Arc::new(owner))
            .await
            .unwrap();
        let loaded = store.load_application(deployment).await.unwrap().unwrap();
        let (loaded_source, loaded_packages, _, _) = loaded.into_parts();
        assert_eq!(
            serde_json::to_value(loaded_source.input).unwrap(),
            serde_json::to_value(input).unwrap()
        );
        assert_eq!(
            loaded_packages[0].application_ref(),
            package.application_ref()
        );
        store.shutdown().await.unwrap();
    });
}

#[test]
#[ignore = "requires the built bundled product"]
fn standalone_host_package_update_preserves_saved_configuration_and_data() {
    use maka_event_log::root_store::RootStore;
    use maka_host_runtime::application::host::Configuration;
    use maka_packages::Package;
    use serde_json::json;
    use std::{path::PathBuf, sync::Arc};

    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("standalone-host");
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let mut host = crate::candidate::CandidateFixture::new(root.clone());
    let owner = RootOwner::open(&root, &namespaces).unwrap();
    let root_id = owner.root_id().to_owned();
    let deployment = uuid::Uuid::new_v4();
    let files_key = uuid::Uuid::new_v4();
    let consumer_key = uuid::Uuid::new_v4();
    let bundle = PathBuf::from(env!("OUT_DIR")).join("product");
    let current = Package::read_from(&bundle.join("packages/workspace-files")).unwrap();
    // A same-ID fork is explicit configuration, not evidence of an old default.
    // The update policy replaces this declared bundled ID without guessing origin.
    let mut files = current.files().clone();
    files.insert(
        "previous-release.txt".into(),
        b"locally retained package bytes\n".to_vec(),
    );
    let previous = Package::new(files).unwrap();
    assert_ne!(previous.application_ref(), current.application_ref());
    let manifest: Value = serde_json::from_slice(&current.files()["maka.extension.json"]).unwrap();
    let contract = &manifest["application"]["entries"]["host"]["exports"]["files"]["contract"];
    let consumer = Package::new(BTreeMap::from([
        (
            "maka.extension.json".into(),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"id":"example.standalone-custom",
                "application":{"entries":{"host":{
                    "implementation":{"kind":"javascript","module":"host.mjs","realm":"shared"},
                    "configuration":{"type":"object","properties":{"label":{"type":"string"}},
                        "required":["label"],"additionalProperties":false},
                    "imports":{"files":{"contract":contract,"cardinality":{"kind":"one"}}},
                    "exports":{}
                }}}
            }))
            .unwrap(),
        ),
        (
            "host.mjs".into(),
            b"export function activate() { return {}; }".to_vec(),
        ),
    ]))
    .unwrap();
    // URL installation retains packages as inventory even before a source
    // selects them. Updating a selected package must not discard that inventory.
    let mut inventory_files = consumer.files().clone();
    let mut inventory_manifest: Value =
        serde_json::from_slice(&inventory_files["maka.extension.json"]).unwrap();
    inventory_manifest["id"] = json!("example.standalone-inventory");
    inventory_files.insert(
        "maka.extension.json".into(),
        serde_json::to_vec(&inventory_manifest).unwrap(),
    );
    let inventory = Package::new(inventory_files).unwrap();
    let input: Input = serde_json::from_value(json!({
        "environment":{"location":"host"},
        "instances":{
            "files":{"key":files_key,"package":{"source":"pinned","package":previous.application_ref()},
                "usePackage":"entry"},
            "custom":{"key":consumer_key,"package":{"source":"pinned","package":consumer.application_ref()},
                "usePackage":"entry","configuration":{"values":{"label":"Keep my configuration"}},
                "bindings":{"files":[{"kind":"instance","path":["files"],"export":"files"}]}}
        }
    })).unwrap();
    let selection = json!({"kind":"public_host",
        "endpoints":{"files":{"consumer":[consumer_key],"import":"files",
            "grant":{"methods":["readText"],"recovery":false}}},
        "native":[{"origin":[consumer_key],"consumer":[consumer_key],"provider":[files_key],
            "export":"files","methods":["readText"],"recovery":false}]
    });
    serde_json::from_value::<Configuration>(selection.clone())
        .unwrap()
        .validate()
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let store = RootStore::open(Arc::new(owner)).await.unwrap();
        let source = store
            .commit_application(
                deployment,
                0,
                input.clone(),
                vec![],
                vec![previous.clone(), consumer.clone(), inventory.clone()],
            )
            .await
            .unwrap();
        store
            .select_committed_application_launch(source, selection.clone())
            .await
            .unwrap();
        store
            .create_session(
                "retained-session",
                "standalone-history",
                &json!({
                    "title":"Keep this session", "locale":"zh-CN", "customSetting":"retained"
                }),
                1,
            )
            .await
            .unwrap();
        let invocation = maka_agent_facts::event::Invocation {
            session_id: "retained-session".into(),
            turn_id: "retained-turn".into(),
            run_id: "retained-run".into(),
            invocation_id: "retained-invocation".into(),
        };
        for fact in [
            maka_agent_facts::event::Fact::InvocationOpened {
                configuration: None,
                input: maka_agent_facts::input::InvocationInput::Message {
                    source_messages: vec![],
                    content: "Preserve my conversation history".into(),
                    request_fingerprint: None,
                },
            },
            maka_agent_facts::event::Fact::InvocationEnded {
                outcome: maka_agent_facts::event::InvocationOutcome::Completed,
            },
        ] {
            store
                .session("retained-session")
                .await
                .unwrap()
                .append(
                    &maka_agent_facts::event::EventWrite::plain(
                        maka_agent_facts::event::RuntimeEvent::new(invocation.clone(), fact),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
        }
        store.shutdown().await.unwrap();
    });
    let snapshot = || {
        runtime.block_on(async {
        let owner = RootOwner::open(&root, &namespaces).unwrap();
        assert_eq!(owner.root_id(), root_id);
        let store = RootStore::open(Arc::new(owner)).await.unwrap();
        let loaded = store.load_application(deployment).await.unwrap().unwrap();
        let launch = store.application_launch().await.unwrap().unwrap();
        let snapshot = json!({
            "rootId":root_id,
            "source":loaded.source(),
            "packages":loaded.packages().iter().map(Package::application_ref).collect::<Vec<_>>(),
            "selection":{"deployment":launch.deployment,"configuration":launch.configuration,
                "pending":launch.pending},
            "session":store.get_session::<Value>("retained-session").await.unwrap().unwrap(),
            "history":store.session("retained-session").await.unwrap().scoped_prefix(maka_agent_facts::event::LogScope::Session { id: "retained-session".into() }, 100, 128 * 1024).await.unwrap(),
        });
        store.shutdown().await.unwrap();
        snapshot
    })
    };
    let update = |apply: bool| {
        let mut process = Command::new(env!("CARGO_BIN_EXE_maka"));
        process
            .args(["application", "update-defaults", "--root"])
            .arg(&root);
        if apply {
            process.arg("--apply");
        }
        process.output().unwrap()
    };
    let initial = snapshot();
    assert!(
        initial["packages"]
            .as_array()
            .unwrap()
            .contains(&serde_json::to_value(inventory.application_ref()).unwrap())
    );
    assert!(
        !input
            .instances
            .values()
            .any(|node| node.package == inventory.application_ref().into())
    );
    let preview = update(false);
    assert!(
        preview.status.success(),
        "standalone Host preview failed: {}",
        String::from_utf8_lossy(&preview.stderr)
    );
    let preview: Value = serde_json::from_slice(&preview.stdout).unwrap();
    assert_eq!(preview["scope"], "selected_packages");
    assert_eq!(preview["changed"], true);
    assert_eq!(preview["applied"], false);
    let old_ref = previous.application_ref();
    let new_ref = current.application_ref();
    assert_eq!(
        preview["changes"],
        json!([format!(
            "/instances/files/package: {}@{} -> {}@{}",
            old_ref.id, old_ref.revision, new_ref.id, new_ref.revision
        )])
    );
    assert_eq!(
        snapshot(),
        initial,
        "preview must preserve the complete saved state"
    );

    let applied = update(true);
    assert!(
        applied.status.success(),
        "standalone Host apply failed: {}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let applied: Value = serde_json::from_slice(&applied.stdout).unwrap();
    assert_eq!(applied["scope"], "selected_packages");
    assert_eq!(applied["changed"], true);
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["changes"], preview["changes"]);
    let after = snapshot();
    let mut expected = input.clone();
    expected.instances.get_mut("files").unwrap().package = current.application_ref().into();
    assert_eq!(
        after["source"]["input"],
        serde_json::to_value(expected).unwrap(),
        "only the recognized bundled package pin changes; custom configuration, bindings and keys survive"
    );
    assert_eq!(
        after["source"]["reference"]["deployment"],
        deployment.to_string()
    );
    assert_eq!(after["source"]["reference"]["revision"], 2);
    assert_eq!(
        after["source"]["reference"]["stateDomain"],
        initial["source"]["reference"]["stateDomain"]
    );
    for field in ["rootId", "selection", "session", "history"] {
        assert_eq!(
            after[field], initial[field],
            "package update changed {field}"
        );
    }
    assert!(
        after["packages"]
            .as_array()
            .unwrap()
            .contains(&serde_json::to_value(current.application_ref()).unwrap())
    );
    assert!(
        after["packages"]
            .as_array()
            .unwrap()
            .contains(&serde_json::to_value(consumer.application_ref()).unwrap())
    );
    assert!(
        after["packages"]
            .as_array()
            .unwrap()
            .contains(&serde_json::to_value(inventory.application_ref()).unwrap()),
        "updating selected package pins must preserve installed, unselected packages"
    );
    assert!(!directory.path().join("ui").exists());

    for apply in [false, true] {
        let repeat = update(apply);
        assert!(
            repeat.status.success(),
            "{}",
            String::from_utf8_lossy(&repeat.stderr)
        );
        let repeat: Value = serde_json::from_slice(&repeat.stdout).unwrap();
        assert_eq!(repeat["scope"], "selected_packages");
        assert_eq!(repeat["changed"], false);
        assert_eq!(repeat["applied"], false);
        assert_eq!(repeat["changes"], json!([]));
        assert_eq!(
            snapshot(),
            after,
            "repeated preview/apply must not create a source revision"
        );
    }
    host.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "serve", "--root"])
            .arg(&root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let registration = host.wait_for_registration();
    assert_eq!(registration["rootId"], root_id);
    assert_eq!(registration["pid"], host.child.as_ref().unwrap().id());
    runtime.block_on(async {
        use maka_host_runtime::application::host::{Client, discovery};
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let discovered = discovery::read(&root).unwrap();
            let status = Client::status(&discovered.endpoint, Some(discovered.host_epoch))
                .await
                .unwrap();
            discovered.verify(&status).unwrap();
            assert_eq!(status.root_id, root_id);
            assert_eq!(status.epoch.to_string(), registration["hostEpoch"]);
            assert_eq!(status.source.deployment, deployment);
            assert_eq!(status.source.revision, 2);
            assert!(!status.closing);
            let mut client = Client::connect(&discovered.endpoint, Some(status.epoch))
                .await
                .unwrap();
            assert_eq!(client.epoch(), status.epoch);
            client.close().await.unwrap();
        })
        .await
        .expect("updated standalone Host must activate and answer status");
    });
    for apply in [false, true] {
        let busy = update(apply);
        assert!(
            !busy.status.success(),
            "an active Host Root must reject concurrent updates"
        );
        assert!(busy.stdout.is_empty());
        assert!(
            host.child.as_mut().unwrap().try_wait().unwrap().is_none(),
            "an update attempt must not stop the active Host"
        );
    }
    let retired = Command::new(env!("CARGO_BIN_EXE_maka"))
        .args(["host", "retire", "--root"])
        .arg(&root)
        .args([
            "--expected-host-epoch",
            registration["hostEpoch"].as_str().unwrap(),
        ])
        .output()
        .unwrap();
    assert!(
        retired.status.success(),
        "{}",
        String::from_utf8_lossy(&retired.stderr)
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&retired.stdout).unwrap()["kind"],
        "prepared"
    );
    assert!(host.wait_for_exit().success());
    assert!(!host.registration.exists());
    assert_eq!(
        snapshot(),
        after,
        "activation, busy update attempts and retirement must preserve the saved state"
    );
}
