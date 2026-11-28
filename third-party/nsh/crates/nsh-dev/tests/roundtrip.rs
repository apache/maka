//! Server and client talking over a real socket.

use std::{sync::mpsc, time::Duration};

use nsh_dev::{
    AppInfo, ClientEvent, DevClient, DevEvent, DevServer, HostInfo,
    protocol::{BundleFormat, HostPlatform, LogLevel, WS_PATH},
};

const TIMEOUT: Duration = Duration::from_secs(5);

/// A host named `device` with bytecode `bytecode` serving `nsh/base`.
fn host(device: &str, bytecode: &str) -> HostInfo {
    let mut host = HostInfo::new(HostPlatform::Android);
    host.device = device.into();
    host.bytecode_version = bytecode.into();
    host.ui_sets = vec!["app/native".into(), "app/charts".into()];
    host
}

/// A host that takes test steps, and steps from `nsh test --attach` when
/// `attach`.
fn stepping_host(device: &str, bytecode: &str, attach: bool) -> HostInfo {
    let mut host = host(device, bytecode);
    host.tests = true;
    host.attach = attach;
    host
}

fn next_non_status(rx: &mpsc::Receiver<DevEvent>) -> DevEvent {
    loop {
        match rx.recv_timeout(TIMEOUT).expect("event") {
            DevEvent::Connected
            | DevEvent::Disconnected
            | DevEvent::Building
            | DevEvent::Testing
            | DevEvent::Attachable
            | DevEvent::Step { .. } => continue,
            event => return event,
        }
    }
}

#[test]
fn bundles_errors_and_logs_round_trip() {
    let (client_tx, client_rx) = mpsc::channel();
    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, move |event| {
        let _ = client_tx.send(event);
    })
    .unwrap();
    server.set_limits(Some("memory=64MB,call=500ms".into()));
    server.publish(
        vec![1, 2, 3],
        "source v1".into(),
        Some("{\"version\":3}".into()),
        AppInfo {
            capabilities: Some("{\"statusBar\":true}".into()),
            id: Some("com.example.roundtrip".into()),
            url_schemes: vec!["claim-test".into()],
            window: Some("{\"title\":\"Roundtrip\"}".into()),
            application: Some("{\"quitMode\":\"explicit\"}".into()),
        },
        None,
        vec!["app/native".into()],
    );
    let url = format!("ws://{}{WS_PATH}", server.local_addr());

    // A client with the same bytecode version gets bytecode, starting with
    // the latest bundle published before it connected.
    let (tx, rx) = mpsc::channel();
    let client = DevClient::start(url.clone(), host("test-device", "bc-1"), move |e| {
        let _ = tx.send(e);
    })
    .unwrap();
    match next_non_status(&rx) {
        DevEvent::Bundle {
            session,
            version: 1,
            format: BundleFormat::Bytecode,
            bytes,
            source_map,
            capabilities,
            app_id,
            url_schemes,
            window,
            application,
            limits,
        } => {
            assert_ne!(session, 0, "the server names its run");
            assert_eq!(url_schemes, ["claim-test"]);
            assert_eq!(window.as_deref(), Some("{\"title\":\"Roundtrip\"}"));
            assert_eq!(application.as_deref(), Some("{\"quitMode\":\"explicit\"}"));
            assert_eq!(limits.as_deref(), Some("memory=64MB,call=500ms"));
            assert_eq!(app_id.as_deref(), Some("com.example.roundtrip"));
            assert_eq!(bytes, [1, 2, 3]);
            assert_eq!(source_map.as_deref(), Some("{\"version\":3}"));
            assert_eq!(capabilities.as_deref(), Some("{\"statusBar\":true}"));
        }
        other => panic!("{other:?}"),
    }
    // The server reports the host with the build it sent first.
    match client_rx.recv_timeout(TIMEOUT).unwrap() {
        ClientEvent::Connected { device, build } => {
            assert_eq!((device.as_str(), build), ("test-device", Some(1)))
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(server.clients(), 1);

    server.publish_error("syntax error at App.tsx:3");
    assert!(matches!(next_non_status(&rx), DevEvent::BuildFailed(m) if m.contains("App.tsx:3")));

    // A hot update reaches connected clients before its bundle.
    server.building();
    server.publish(
        vec![4],
        "source v2".into(),
        None,
        AppInfo::default(),
        Some(("patch v2".into(), Some("{}".into()))),
        Vec::new(),
    );
    match next_non_status(&rx) {
        DevEvent::Patch {
            version: 2,
            base: 1,
            code,
            source_map,
            ..
        } => {
            assert_eq!(code, "patch v2");
            assert_eq!(source_map.as_deref(), Some("{}"));
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        next_non_status(&rx),
        DevEvent::Bundle { version: 2, .. }
    ));

    client.log(LogLevel::Warn, "js", "hello from device");
    match client_rx.recv_timeout(TIMEOUT).unwrap() {
        ClientEvent::Log(log) => assert_eq!(
            (log.device.as_str(), log.message.as_str()),
            ("test-device", "hello from device")
        ),
        other => panic!("{other:?}"),
    }

    // A client with another engine build gets JS source instead.
    let (tx2, rx2) = mpsc::channel();
    let _other = DevClient::start(url, host("old-host", "bc-0"), move |e| {
        let _ = tx2.send(e);
    })
    .unwrap();
    match next_non_status(&rx2) {
        DevEvent::Bundle {
            format: BundleFormat::Source,
            bytes,
            ..
        } => assert_eq!(bytes, b"source v2"),
        other => panic!("{other:?}"),
    }

    // A host that goes away is reported once its session ends.
    drop(client);
    let gone = std::iter::from_fn(|| client_rx.recv_timeout(TIMEOUT).ok()).find_map(|e| match e {
        ClientEvent::Disconnected { device } => Some(device),
        _ => None,
    });
    assert_eq!(gone.as_deref(), Some("test-device"));
}

/// Build numbers start at 1 in each run of the server: a host still running
/// build 1 of an earlier run tells the new run's build 1 apart by its
/// session.
#[test]
fn each_run_of_the_server_has_its_own_session() {
    let session_of = || {
        let server =
            DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
        server.publish(
            vec![1],
            "v1".into(),
            None,
            AppInfo::default(),
            None,
            Vec::new(),
        );
        let url = format!("ws://{}{WS_PATH}", server.local_addr());
        let (tx, rx) = mpsc::channel();
        let _client = DevClient::start(url, host("test-device", "bc-1"), move |e| {
            let _ = tx.send(e);
        })
        .unwrap();
        match next_non_status(&rx) {
            DevEvent::Bundle {
                session,
                version: 1,
                ..
            } => session,
            other => panic!("{other:?}"),
        }
    };
    assert_ne!(session_of(), session_of());
}

/// A host built for another app (without the app's own UI set) gets no
/// bundle but a message saying why, and the server reports it; once a
/// bundle needs only what it has, it gets bundles again.
#[test]
fn a_host_without_the_apps_ui_set_is_told_it_cannot_run_it() {
    let (client_tx, client_rx) = mpsc::channel();
    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, move |event| {
        let _ = client_tx.send(event);
    })
    .unwrap();
    server.install_commands([(
        HostPlatform::Android,
        "nsh run examples/gallery-rs --target android".to_owned(),
    )]);
    let needs = || vec!["gallery/native".to_owned(), "app/native".to_owned()];
    server.publish(
        vec![1],
        "v1".into(),
        None,
        AppInfo::default(),
        None,
        needs(),
    );
    let url = format!("ws://{}{WS_PATH}", server.local_addr());

    let (tx, rx) = mpsc::channel();
    let _client = DevClient::start(url.clone(), host("Android Emulator", "bc-1"), move |e| {
        let _ = tx.send(e);
    })
    .unwrap();
    match next_non_status(&rx) {
        DevEvent::CannotRun { missing, message } => {
            assert_eq!(missing, ["gallery/native"]);
            assert!(message.contains("gallery/native"), "{message}");
            assert!(
                message.contains("nsh run examples/gallery-rs --target android"),
                "{message}"
            );
        }
        other => panic!("{other:?}"),
    }
    // Connected without a build, then why.
    match client_rx.recv_timeout(TIMEOUT).unwrap() {
        ClientEvent::Connected { device, build } => {
            assert_eq!((device.as_str(), build), ("Android Emulator", None))
        }
        other => panic!("{other:?}"),
    }
    match client_rx.recv_timeout(TIMEOUT).unwrap() {
        ClientEvent::CannotRun {
            device,
            missing,
            install,
        } => {
            assert_eq!(device, "Android Emulator");
            assert_eq!(missing, ["gallery/native"]);
            assert_eq!(
                install.as_deref(),
                Some("nsh run examples/gallery-rs --target android")
            );
        }
        other => panic!("{other:?}"),
    }

    // A rebuild that still needs it: neither its patch nor its bundle, and
    // no news (the host shows the message already); nor a build error.
    server.publish(
        vec![2],
        "v2".into(),
        None,
        AppInfo::default(),
        Some(("patch v2".into(), None)),
        needs(),
    );
    server.publish_error("syntax error");
    // A bundle that needs only `nsh/base` reaches it again.
    server.publish(
        vec![3],
        "v3".into(),
        None,
        AppInfo::default(),
        None,
        vec!["app/native".into()],
    );
    match next_non_status(&rx) {
        DevEvent::Bundle {
            version: 3, bytes, ..
        } => assert_eq!(bytes, [3]),
        other => panic!("{other:?}"),
    }
    assert!(
        client_rx.try_recv().is_err(),
        "the rebuild that still needed it was not reported again"
    );

    // Needed again: reported again.
    server.publish(
        vec![4],
        "v4".into(),
        None,
        AppInfo::default(),
        None,
        needs(),
    );
    assert!(matches!(next_non_status(&rx), DevEvent::CannotRun { .. }));
    assert!(matches!(
        client_rx.recv_timeout(TIMEOUT).unwrap(),
        ClientEvent::CannotRun { .. }
    ));

    // A host that has the set runs the app.
    let (tx2, rx2) = mpsc::channel();
    let mut app_host = host("iOS Simulator", "bc-1");
    app_host.platform = HostPlatform::IosSimulator;
    app_host.ui_sets.push("gallery/native".into());
    let _app_host = DevClient::start(url, app_host, move |e| {
        let _ = tx2.send(e);
    })
    .unwrap();
    assert!(matches!(
        next_non_status(&rx2),
        DevEvent::Bundle { version: 4, .. }
    ));
    match client_rx.recv_timeout(TIMEOUT).unwrap() {
        ClientEvent::Connected { device, build } => {
            assert_eq!((device.as_str(), build), ("iOS Simulator", Some(4)))
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_test_session_asks_its_host_for_steps_and_hears_their_outcomes() {
    use nsh_dev::protocol::{StepOutcome, TestStep};

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.test_session();
    assert_eq!(
        server.step(TestStep::Texts, TIMEOUT),
        Err("no host that takes test steps is connected".into())
    );
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let (tx, rx) = mpsc::channel();
    let client = std::sync::Arc::new(std::sync::OnceLock::<DevClient>::new());
    let answering = client.clone();
    let started =
        DevClient::start(
            url,
            stepping_host("tester", "bc-1", false),
            move |event| match event {
                DevEvent::Step { id, step } => {
                    let outcome = match step {
                        TestStep::Texts => StepOutcome::Done {
                            value: serde_json::json!(["Hello"]),
                        },
                        other => StepOutcome::Failed {
                            message: format!("cannot {other:?}"),
                        },
                    };
                    answering.get().expect("client").step_done(id, outcome);
                }
                event => {
                    let _ = tx.send(event);
                }
            },
        )
        .unwrap();
    let _ = client.set(started);
    // Told of the test session before anything else of the server's.
    loop {
        match rx.recv_timeout(TIMEOUT).expect("event") {
            DevEvent::Testing => break,
            DevEvent::Connected => continue,
            other => panic!("{other:?} before the test session"),
        }
    }
    let deadline = std::time::Instant::now() + TIMEOUT;
    while !server.has_tester() {
        assert!(std::time::Instant::now() < deadline, "the host never came");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        server.step(TestStep::Texts, TIMEOUT),
        Ok(serde_json::json!(["Hello"]))
    );
    assert_eq!(
        server.step(TestStep::Back, TIMEOUT),
        Err("cannot Back".into())
    );
}

/// A host on `server` that takes steps `nsh test --attach` sends, answering
/// `texts` with its name, once it heard it may ([`DevEvent::Attachable`]).
fn attached_host(
    server: &DevServer,
    device: &str,
) -> std::sync::Arc<std::sync::OnceLock<DevClient>> {
    use nsh_dev::protocol::{StepOutcome, TestStep};
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let client = std::sync::Arc::new(std::sync::OnceLock::<DevClient>::new());
    let answering = client.clone();
    let (tx, rx) = mpsc::channel();
    let name = device.to_owned();
    let started =
        DevClient::start(
            url,
            stepping_host(device, "bc-1", true),
            move |event| match event {
                DevEvent::Step { id, step } => {
                    let outcome = match step {
                        TestStep::Texts => StepOutcome::Done {
                            value: serde_json::json!([name.clone()]),
                        },
                        other => StepOutcome::Failed {
                            message: format!("cannot {other:?}"),
                        },
                    };
                    answering.get().expect("client").step_done(id, outcome);
                }
                event => {
                    let _ = tx.send(event);
                }
            },
        )
        .unwrap();
    loop {
        match rx.recv_timeout(TIMEOUT).expect("event") {
            DevEvent::Attachable => break,
            DevEvent::Connected => continue,
            other => panic!("{other:?} before the server said it takes attached steps"),
        }
    }
    let _ = client.set(started);
    client
}

#[test]
fn an_attached_session_drives_the_hosts_that_take_its_steps() {
    use nsh_dev::{Attachment, protocol::TestStep};

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    let addr = server.local_addr();
    server.set_attach_token(Some("secret".into()));
    let _window = attached_host(&server, "window");
    // A host that takes test steps but not attached ones (an older one).
    let (tx, rx) = mpsc::channel();
    let _page = DevClient::start(
        format!("ws://{addr}{WS_PATH}"),
        stepping_host("page", "bc-1", false),
        move |event| {
            let _ = tx.send(event);
        },
    )
    .unwrap();
    let deadline = std::time::Instant::now() + TIMEOUT;
    while server.clients() < 2 {
        assert!(std::time::Instant::now() < deadline, "the hosts never came");
        std::thread::sleep(Duration::from_millis(10));
    }
    let (attached, hosts) = Attachment::connect(addr, "secret").unwrap();
    let listed: Vec<(&str, bool)> = hosts.iter().map(|h| (h.device.as_str(), h.steps)).collect();
    assert_eq!(listed, [("window", true), ("page", false)]);
    assert_eq!(
        attached.step(hosts[0].id, TestStep::Texts, TIMEOUT),
        Ok(serde_json::json!(["window"]))
    );
    assert_eq!(
        attached.step(hosts[0].id, TestStep::Back, TIMEOUT),
        Err("cannot Back".into())
    );
    assert_eq!(
        attached.step(hosts[1].id, TestStep::Texts, TIMEOUT),
        Err("the host left, or takes no steps".into())
    );
    // The app keeps running after the attached session.
    assert_eq!(
        attached.step(hosts[0].id, TestStep::Quit, TIMEOUT),
        Err("an attached session leaves the app running: it does not quit it".into())
    );
    // The host that takes no attached steps was never told it may.
    assert!(
        rx.try_iter()
            .all(|e| !matches!(e, DevEvent::Attachable | DevEvent::Testing))
    );
}

#[test]
fn a_test_session_takes_no_attached_steps() {
    use nsh_dev::Attachment;

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.test_session();
    server.set_attach_token(Some("secret".into()));
    let (tx, rx) = mpsc::channel();
    let _client = DevClient::start(
        format!("ws://{}{WS_PATH}", server.local_addr()),
        stepping_host("tester", "bc-1", true),
        move |event| {
            let _ = tx.send(event);
        },
    )
    .unwrap();
    loop {
        match rx.recv_timeout(TIMEOUT).expect("event") {
            DevEvent::Testing => break,
            DevEvent::Connected => continue,
            other => panic!("{other:?} before the test session"),
        }
    }
    // Its steps are the test's: an attached session sees it but cannot
    // tell it it may take steps of its own.
    let (_, hosts) = Attachment::connect(server.local_addr(), "secret").unwrap();
    assert_eq!(hosts.len(), 1);
}

#[test]
fn an_attached_session_comes_from_this_machine_and_no_web_page() {
    use nsh_dev::protocol::ATTACH_PATH;
    use tungstenite::client::IntoClientRequest;

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.set_attach_token(Some("secret".into()));
    let addr = server.local_addr();
    let mut request = format!("ws://{addr}{ATTACH_PATH}")
        .into_client_request()
        .unwrap();
    // Even the dev server's own page, which `/ws` takes.
    request
        .headers_mut()
        .insert("Origin", format!("http://{addr}").parse().unwrap());
    match tungstenite::connect(request) {
        Err(tungstenite::Error::Http(response)) => assert_eq!(response.status(), 403),
        other => panic!("{:?}", other.map(|_| ())),
    }
    // A name rebound to this machine, as for the server's other paths.
    let mut request = format!("ws://{addr}{ATTACH_PATH}")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("Host", "rebound.example".parse().unwrap());
    match tungstenite::connect(request) {
        Err(tungstenite::Error::Http(response)) => assert_eq!(response.status(), 403),
        other => panic!("{:?}", other.map(|_| ())),
    }
}

#[test]
fn an_attached_session_needs_the_sessions_token() {
    use nsh_dev::Attachment;

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    let addr = server.local_addr();
    // A development session that takes no attached steps.
    assert_eq!(
        Attachment::connect(addr, "secret").err().as_deref(),
        Some("this session takes no attached steps")
    );
    server.set_attach_token(Some("secret".into()));
    // A wrong token, one of the same length, and none.
    for token in ["guess", "secreT", ""] {
        assert_eq!(
            Attachment::connect(addr, token).err().as_deref(),
            Some("the session's token differs: it was replaced or restarted"),
            "{token:?}"
        );
    }
    // The session's own.
    assert!(Attachment::connect(addr, "secret").is_ok());
}

#[test]
fn an_app_of_rust_only_runs_as_its_hosts_root() {
    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.publish_root();
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let (tx, rx) = mpsc::channel();
    let _client = DevClient::start(url, host("test-device", "bc-1"), move |e| {
        let _ = tx.send(e);
    })
    .unwrap();
    // A host connecting later hears it too: it is the latest state.
    assert!(matches!(next_non_status(&rx), DevEvent::Root));
}

#[test]
fn a_traced_test_session_hears_the_batches_before_the_step_ends() {
    use nsh_dev::protocol::{StepOutcome, TestStep};

    let (traces_tx, traces) = mpsc::channel();
    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, move |event| {
        if let ClientEvent::Trace { items } = event {
            let _ = traces_tx.send(items);
        }
    })
    .unwrap();
    server.test_session();
    server.set_test_trace(true);
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let (setup_tx, setup) = mpsc::channel();
    let client = std::sync::Arc::new(std::sync::OnceLock::<DevClient>::new());
    let answering = client.clone();
    let started =
        DevClient::start(
            url,
            stepping_host("tester", "bc-1", false),
            move |event| match event {
                DevEvent::TestSetup { trace, .. } => {
                    let _ = setup_tx.send(trace);
                }
                // A step's batch goes before its outcome.
                DevEvent::Step { id, .. } => {
                    let client = answering.get().expect("client");
                    client.trace(vec!["Create { id: 2, kind: View }".into()]);
                    client.step_done(
                        id,
                        StepOutcome::Done {
                            value: serde_json::Value::Null,
                        },
                    );
                }
                _ => {}
            },
        )
        .unwrap();
    let _ = client.set(started);
    assert!(
        setup.recv_timeout(TIMEOUT).expect("the setup"),
        "told to trace"
    );
    let deadline = std::time::Instant::now() + TIMEOUT;
    while !server.has_tester() {
        assert!(std::time::Instant::now() < deadline, "the host never came");
        std::thread::sleep(Duration::from_millis(10));
    }
    server
        .step(
            TestStep::Press {
                selector: "Add".into(),
            },
            TIMEOUT,
        )
        .unwrap();
    assert_eq!(
        traces.try_recv().expect("the batch, before the step's end"),
        ["Create { id: 2, kind: View }"]
    );
}

/// The status code of `GET <path>` with `headers` (raw HTTP/1.1).
fn status(addr: std::net::SocketAddr, path: &str, headers: &str) -> u16 {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).unwrap();
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n{headers}\r\n"
    )
    .unwrap();
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    let line = String::from_utf8_lossy(&response);
    line.split(' ')
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0)
}

#[test]
fn assets_are_the_apps_media_and_named_files_only() {
    let dir = std::env::temp_dir().join(format!("nsh-dev-served-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".git")).unwrap();
    for file in [
        "logo.png",
        ".env",
        "App.tsx",
        "nsh.json",
        "data.json",
        ".git/config",
    ] {
        std::fs::write(dir.join(file), b"x").unwrap();
    }
    let server = DevServer::start(
        "127.0.0.1:0".parse().unwrap(),
        "bc-1",
        Some(dir.clone()),
        |_| {},
    )
    .unwrap();
    server.serve_files([("data.json".to_owned(), dir.join("data.json"))]);
    let addr = server.local_addr();
    assert_eq!(status(addr, "/assets/logo.png", ""), 200);
    // Named by a build (an import, a crate's files): any type.
    assert_eq!(status(addr, "/assets/data.json", ""), 200);
    for path in [
        "/assets/.env",
        "/assets/App.tsx",
        "/assets/nsh.json",
        "/assets/.git/config",
        "/assets/..%2f..%2fetc%2fpasswd",
    ] {
        assert_eq!(status(addr, path, ""), 404, "{path}");
    }
    drop(server);
    let _ = std::fs::remove_dir_all(&dir);
}

/// An entry below its app (`tests/SubApp.tsx`) names its assets from the
/// app's directory: the server, started at the entry's, serves the media
/// files from there once a build says so, as a package of the app has them.
#[test]
fn the_assets_root_follows_the_build() {
    let dir = std::env::temp_dir().join(format!("nsh-dev-asset-root-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::create_dir_all(dir.join("tests")).unwrap();
    std::fs::write(dir.join("assets/dot.png"), b"dot").unwrap();
    std::fs::write(dir.join("tests/beside.png"), b"beside").unwrap();
    let server = DevServer::start(
        "127.0.0.1:0".parse().unwrap(),
        "bc-1",
        Some(dir.join("tests")),
        |_| {},
    )
    .unwrap();
    let addr = server.local_addr();
    assert_eq!(status(addr, "/assets/beside.png", ""), 200);
    assert_eq!(status(addr, "/assets/assets/dot.png", ""), 404);
    server.set_assets_root(Some(dir.clone()));
    let (line, body) = get(addr, "/assets/assets/dot.png", "*/*");
    assert!(line.contains("200"), "{line}");
    assert_eq!(body, "dot");
    assert_eq!(status(addr, "/assets/tests/beside.png", ""), 200);
    assert_eq!(status(addr, "/assets/beside.png", ""), 404);
    drop(server);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_websocket_refuses_other_web_pages() {
    use tungstenite::client::IntoClientRequest;
    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    let addr = server.local_addr();
    let url = format!("ws://{addr}{WS_PATH}");
    let connect = |origin: Option<String>| {
        let mut request = url.as_str().into_client_request().unwrap();
        if let Some(origin) = origin {
            request
                .headers_mut()
                .insert("Origin", origin.parse().unwrap());
        }
        tungstenite::connect(request)
    };
    // A native host, and the dev server's own page.
    assert!(connect(None).is_ok());
    assert!(connect(Some(format!("http://{addr}"))).is_ok());
    for origin in ["https://evil.example", "http://127.0.0.1:1", "null"] {
        match connect(Some(origin.to_owned())) {
            Err(tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), 403, "{origin}")
            }
            other => panic!("{origin}: {:?}", other.map(|_| ())),
        }
    }
}

/// A page whose own name DNS rebinds to this machine sends its requests
/// same-origin, without an `Origin`, under that name as its `Host`: it reads
/// none of the server's files, while the hosts on devices and the web host's
/// pages, which name the server by its address or `localhost`, read them as
/// before.
#[test]
fn a_name_rebound_to_this_machine_reads_nothing() {
    let dir = std::env::temp_dir().join(format!("nsh-dev-rebound-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("logo.png"), b"png").unwrap();
    let server = DevServer::start(
        "127.0.0.1:0".parse().unwrap(),
        "bc-1",
        Some(dir.clone()),
        |_| {},
    )
    .unwrap();
    server.publish(
        vec![1, 2, 3],
        "the app's source".into(),
        None,
        AppInfo::default(),
        None,
        Vec::new(),
    );
    server.serve_web("<p>page</p>".into(), [("nsh.js".into(), b"js".to_vec())]);
    let addr = server.local_addr();
    let port = addr.port();
    let paths = ["/bundle.js", "/assets/logo.png", "/", "/nsh.js"];
    for host in [
        format!("evil.example:{port}"),
        format!("rebind.127.0.0.1.nip.io:{port}"),
        format!("my-mac.local:{port}"),
    ] {
        for path in paths {
            let (line, body) = request(addr, path, &host, "");
            assert!(line.contains("403"), "{path} at {host}: {line}");
            assert!(!body.contains("source"), "{path} at {host}");
        }
    }
    for host in [addr.to_string(), format!("localhost:{port}")] {
        for path in paths {
            let (line, _) = request(addr, path, &host, "");
            assert!(line.contains("200"), "{path} at {host}: {line}");
        }
    }
    // `/ws` is left to its `Origin` check: a native host's handshake under
    // any name still opens.
    let handshake = "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: \
                     13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
    let (line, _) = request(addr, WS_PATH, &format!("dev.example:{port}"), handshake);
    assert!(line.contains("101"), "{line}");
    drop(server);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The status line and body of `GET path` with `Host: host` and the
/// `headers` (lines ending with `\r\n`), over a plain HTTP/1.1 connection.
fn request(addr: std::net::SocketAddr, path: &str, host: &str, headers: &str) -> (String, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).unwrap();
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    let close = if headers.is_empty() {
        "Connection: close\r\n"
    } else {
        ""
    };
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {host}\r\n{close}{headers}\r\n"
    )
    .unwrap();
    let mut response = Vec::new();
    // A WebSocket stays open: what arrived before the timeout is enough.
    let _ = stream.read_to_end(&mut response);
    let response = String::from_utf8_lossy(&response);
    let line = response.lines().next().unwrap_or_default().to_owned();
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    (line, body)
}

/// The status line and body of `GET path` with `accept`, over a plain
/// HTTP/1.1 connection.
fn get(addr: std::net::SocketAddr, path: &str, accept: &str) -> (String, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).unwrap();
    stream.set_read_timeout(Some(TIMEOUT)).unwrap();
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: {addr}\r\nAccept: {accept}\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    let status = response.lines().next().unwrap_or_default().to_owned();
    let body = response
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_owned())
        .unwrap_or_default();
    (status, body)
}

const BROWSER: &str = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

#[test]
fn the_web_host_serves_its_page_at_the_apps_paths() {
    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.serve_web("<p>page</p>".into(), [("nsh.js".into(), b"js".to_vec())]);
    let addr = server.local_addr();
    assert_eq!(get(addr, "/", BROWSER).1, "<p>page</p>");
    assert_eq!(get(addr, "/sports/football", BROWSER).1, "<p>page</p>");
    assert_eq!(
        get(addr, "/sports/football?tab=live", BROWSER).1,
        "<p>page</p>"
    );
    assert_eq!(get(addr, "/nsh.js", "*/*").1, "js");
    // A file that is not there, and the app's own requests, stay missing.
    assert!(get(addr, "/sports/nsh.js", BROWSER).0.contains("404"));
    assert!(get(addr, "/api/teams", "*/*").0.contains("404"));
}

#[test]
fn a_packaged_site_serves_its_page_at_the_apps_paths() {
    let dir = std::env::temp_dir().join(format!("nsh-site-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("assets")).unwrap();
    std::fs::write(dir.join("index.html"), "<p>site</p>").unwrap();
    std::fs::write(dir.join("assets/logo.png"), "png").unwrap();
    let server = nsh_dev::SiteServer::start("127.0.0.1:0".parse().unwrap(), dir.clone()).unwrap();
    let addr = server.local_addr();
    assert_eq!(get(addr, "/", BROWSER).1, "<p>site</p>");
    assert_eq!(get(addr, "/sports/football", BROWSER).1, "<p>site</p>");
    assert_eq!(get(addr, "/assets/logo.png", "*/*").1, "png");
    assert!(get(addr, "/assets/missing.png", BROWSER).0.contains("404"));
    assert!(
        get(addr, "/api/teams", "application/json")
            .0
            .contains("404")
    );
    drop(server);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_site_deployed_under_a_path_is_served_there() {
    let dir = std::env::temp_dir().join(format!("nsh-site-base-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("index.html"), "<p>site</p>").unwrap();
    std::fs::write(dir.join("nsh.0123456789.js"), "js").unwrap();
    let server = nsh_dev::SiteServer::start_at(
        "127.0.0.1:0".parse().unwrap(),
        dir.clone(),
        "/apps/counter/",
    )
    .unwrap();
    let addr = server.local_addr();
    assert_eq!(get(addr, "/apps/counter/", BROWSER).1, "<p>site</p>");
    assert_eq!(get(addr, "/apps/counter/nsh.0123456789.js", "*/*").1, "js");
    assert_eq!(
        get(addr, "/apps/counter/sports/football", BROWSER).1,
        "<p>site</p>"
    );
    for path in ["/", "/apps/counter"] {
        let (status, _) = get(addr, path, BROWSER);
        assert!(status.contains("307"), "{path}: {status}");
    }
    assert!(get(addr, "/nsh.0123456789.js", "*/*").0.contains("404"));
    drop(server);
    let _ = std::fs::remove_dir_all(dir);
}

/// A TCP relay in front of the server whose connection can be cut, as a
/// phone's when it goes to the background or changes networks.
struct Relay {
    addr: std::net::SocketAddr,
    up: std::sync::Arc<std::sync::atomic::AtomicBool>,
    open: std::sync::Arc<std::sync::Mutex<Vec<std::net::TcpStream>>>,
}

impl Relay {
    fn start(server: std::net::SocketAddr) -> Relay {
        use std::sync::{Arc, Mutex, atomic::AtomicBool};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let up = Arc::new(AtomicBool::new(true));
        let open: Arc<Mutex<Vec<std::net::TcpStream>>> = Arc::default();
        let (relay_up, relay_open) = (up.clone(), open.clone());
        std::thread::spawn(move || {
            for device in listener.incoming().flatten() {
                if !relay_up.load(std::sync::atomic::Ordering::SeqCst) {
                    continue;
                }
                let Ok(upstream) = std::net::TcpStream::connect(server) else {
                    continue;
                };
                let mut open = relay_open.lock().unwrap();
                open.push(device.try_clone().unwrap());
                open.push(upstream.try_clone().unwrap());
                for (mut from, mut to) in [
                    (device.try_clone().unwrap(), upstream.try_clone().unwrap()),
                    (upstream, device),
                ] {
                    std::thread::spawn(move || {
                        let _ = std::io::copy(&mut from, &mut to);
                        let _ = to.shutdown(std::net::Shutdown::Both);
                    });
                }
            }
        });
        Relay { addr, up, open }
    }

    fn cut(&self) {
        self.up.store(false, std::sync::atomic::Ordering::SeqCst);
        for stream in self.open.lock().unwrap().drain(..) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }

    fn restore(&self) {
        self.up.store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

fn publish(server: &DevServer, build: u8, patch: Option<&str>) {
    server.publish(
        vec![build],
        format!("source v{build}"),
        None,
        AppInfo::default(),
        patch.map(|code| (code.to_owned(), None)),
        Vec::new(),
    );
}

/// Waits for the client to lose its connection, then for the server to
/// count it gone.
fn wait_disconnected(rx: &mpsc::Receiver<DevEvent>, server: &DevServer) {
    loop {
        if let DevEvent::Disconnected = rx.recv_timeout(TIMEOUT).expect("disconnect") {
            break;
        }
    }
    let deadline = std::time::Instant::now() + TIMEOUT;
    while server.clients() > 0 {
        assert!(
            std::time::Instant::now() < deadline,
            "server still counts it"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// A host that reconnects after missing builds catches up through their
/// hot updates, in order, then gets the bundle it already runs: the app
/// keeps its state. When a missed build had no hot update, it gets only
/// the bundle and reloads, as before.
#[test]
fn a_host_that_reconnects_after_missed_builds_gets_their_hot_updates() {
    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    publish(&server, 1, None);
    let relay = Relay::start(server.local_addr());
    let url = format!("ws://{}{WS_PATH}", relay.addr);
    let (tx, rx) = mpsc::channel();
    let _client = DevClient::start(url, host("phone", "bc-1"), move |e| {
        let _ = tx.send(e);
    })
    .unwrap();
    assert!(matches!(
        next_non_status(&rx),
        DevEvent::Bundle { version: 1, .. }
    ));

    // Away while two builds land.
    relay.cut();
    wait_disconnected(&rx, &server);
    publish(&server, 2, Some("patch v2"));
    publish(&server, 3, Some("patch v3"));
    relay.restore();
    for (version, base, code) in [(2, 1, "patch v2"), (3, 2, "patch v3")] {
        match next_non_status(&rx) {
            DevEvent::Patch {
                version: v,
                base: b,
                code: c,
                ..
            } => assert_eq!((v, b, c.as_str()), (version, base, code)),
            other => panic!("{other:?}"),
        }
    }
    assert!(matches!(
        next_non_status(&rx),
        DevEvent::Bundle { version: 3, .. }
    ));

    // A reconnect on the same build: the bundle only, which it runs.
    relay.cut();
    wait_disconnected(&rx, &server);
    relay.restore();
    assert!(matches!(
        next_non_status(&rx),
        DevEvent::Bundle { version: 3, .. }
    ));

    // A missed build that reloads (no hot update) breaks the chain.
    relay.cut();
    wait_disconnected(&rx, &server);
    publish(&server, 4, None);
    publish(&server, 5, Some("patch v5"));
    relay.restore();
    assert!(matches!(
        next_non_status(&rx),
        DevEvent::Bundle { version: 5, .. }
    ));
}

/// A test host on `server` that answers each step with `answer`'s outcome,
/// once the server counts it as the test's host.
fn tester(
    server: &DevServer,
    answer: impl Fn(nsh_dev::protocol::TestStep) -> nsh_dev::protocol::StepOutcome + Send + 'static,
) -> std::sync::Arc<std::sync::OnceLock<DevClient>> {
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let client = std::sync::Arc::new(std::sync::OnceLock::<DevClient>::new());
    let answering = client.clone();
    let started = DevClient::start(url, stepping_host("tester", "bc-1", false), move |event| {
        if let DevEvent::Step { id, step } = event {
            answering.get().expect("client").step_done(id, answer(step));
        }
    })
    .unwrap();
    let _ = client.set(started);
    let deadline = std::time::Instant::now() + TIMEOUT;
    while !server.has_tester() {
        assert!(std::time::Instant::now() < deadline, "the host never came");
        std::thread::sleep(Duration::from_millis(10));
    }
    client
}

/// A paste of `files` into `#field`.
fn paste(files: Vec<nsh_dev::protocol::TestFile>) -> nsh_dev::protocol::TestStep {
    nsh_dev::protocol::TestStep::Paste {
        selector: "#field".into(),
        text: String::new(),
        html: String::new(),
        files,
        uris: Vec::new(),
    }
}

#[test]
fn a_test_pastes_a_large_file_into_its_host() {
    use nsh_dev::protocol::{StepOutcome, TestFile, TestStep};

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.test_session();
    // The host answers with what arrived: each file's size and whether
    // every byte is the one sent.
    let _client = tester(&server, |step| match step {
        TestStep::Paste { files, .. } => StepOutcome::Done {
            value: files
                .iter()
                .map(|f| {
                    serde_json::json!([f.name, f.data.len(), f.data.iter().all(|&b| b == b'a')])
                })
                .collect(),
        },
        other => StepOutcome::Failed {
            message: format!("cannot {other:?}"),
        },
    });
    // 20 MB of text: more than a WebSocket frame takes by default.
    let size = 20 << 20;
    assert_eq!(
        server.step(
            paste(vec![TestFile::new(
                "big.txt",
                "text/plain",
                vec![b'a'; size]
            )]),
            Duration::from_secs(30),
        ),
        Ok(serde_json::json!([["big.txt", size, true]]))
    );
    // The connection stays up for the next step.
    assert_eq!(
        server.step(TestStep::Back, TIMEOUT),
        Err("cannot Back".into())
    );
}

#[test]
fn a_paste_beyond_the_message_limit_fails_with_its_size() {
    use nsh_dev::protocol::{StepOutcome, TestFile, TestStep};

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.test_session();
    let _client = tester(&server, |step| match step {
        TestStep::Back => StepOutcome::Done {
            value: serde_json::Value::Null,
        },
        other => StepOutcome::Failed {
            message: format!("cannot {other:?}"),
        },
    });
    let err = server
        .step(
            paste(vec![TestFile::new(
                "huge.bin",
                "application/octet-stream",
                vec![0; 60 << 20],
            )]),
            Duration::from_secs(30),
        )
        .unwrap_err();
    assert!(err.contains("64 MiB"), "{err}");
    // The host never saw it and is still there.
    assert_eq!(
        server.step(TestStep::Back, TIMEOUT),
        Ok(serde_json::Value::Null)
    );
}

#[test]
fn a_host_that_takes_smaller_frames_leaving_on_a_paste_is_told_apart() {
    use nsh_dev::protocol::{PROTOCOL_VERSION, TestFile};

    let server = DevServer::start("127.0.0.1:0".parse().unwrap(), "bc-1", None, |_| {}).unwrap();
    server.test_session();
    // A host on tungstenite's defaults (16 MiB frames), as hosts were
    // before they took the protocol's whole message size.
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let (mut socket, _) = tungstenite::connect(url).unwrap();
    socket
        .send(tungstenite::Message::Text(
            serde_json::json!({
                "type": "hello",
                "protocol": PROTOCOL_VERSION,
                "bytecode_version": "bc-1",
                "device": "older",
                "tests": true,
            })
            .to_string()
            .into(),
        ))
        .unwrap();
    let host = std::thread::spawn(move || while socket.read().is_ok() {});
    let deadline = std::time::Instant::now() + TIMEOUT;
    while !server.has_tester() {
        assert!(std::time::Instant::now() < deadline, "the host never came");
        std::thread::sleep(Duration::from_millis(10));
    }
    let err = server
        .step(
            paste(vec![TestFile::new(
                "big.txt",
                "text/plain",
                vec![b'a'; 20 << 20],
            )]),
            Duration::from_secs(30),
        )
        .unwrap_err();
    assert!(err.contains("older nsh"), "{err}");
    host.join().unwrap();
}

#[test]
fn a_server_that_drops_each_session_at_once_is_retried_with_backoff() {
    // A server that ends every session right after the handshake, as one
    // sending a frame over the host's limit does.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let accepted = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = accepted.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            count.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if let Ok(mut socket) = tungstenite::accept(stream) {
                let _ = socket.close(None);
                let _ = socket.flush();
            }
        }
    });
    let url = format!("ws://{addr}{WS_PATH}");
    let client = DevClient::start(url, host("phone", "bc-1"), |_| {}).unwrap();
    std::thread::sleep(Duration::from_secs(3));
    drop(client);
    let sessions = accepted.load(std::sync::atomic::Ordering::Relaxed);
    // 100 ms apart that would be ~30; backing off it is a handful.
    assert!((1..=8).contains(&sessions), "{sessions} sessions in 3 s");
}

#[test]
fn scheme_claims_survive_source_bytecode_and_rebuilds_including_removal() {
    let server =
        DevServer::start("127.0.0.1:0".parse().unwrap(), "claims-bc", None, |_| {}).unwrap();
    let publish = |schemes: Vec<String>| {
        server.publish(
            vec![1],
            "export {};".into(),
            None,
            AppInfo {
                url_schemes: schemes,
                ..AppInfo::default()
            },
            None,
            Vec::new(),
        )
    };
    publish(vec!["claim-test".into()]);
    let url = format!("ws://{}{WS_PATH}", server.local_addr());
    let mut clients = Vec::new();
    let mut receivers = Vec::new();
    for (device, bytecode, format) in [
        ("same", "claims-bc", BundleFormat::Bytecode),
        ("source", "older", BundleFormat::Source),
    ] {
        let (tx, rx) = mpsc::channel();
        clients.push(
            DevClient::start(url.clone(), host(device, bytecode), move |event| {
                let _ = tx.send(event);
            })
            .unwrap(),
        );
        assert!(
            matches!(next_non_status(&rx), DevEvent::Bundle { version: 1, format: actual, url_schemes, .. } if actual == format && url_schemes == ["claim-test"])
        );
        receivers.push(rx);
    }
    publish(vec!["changed".into()]);
    for rx in &receivers {
        assert!(
            matches!(next_non_status(rx), DevEvent::Bundle { version: 2, url_schemes, .. } if url_schemes == ["changed"])
        );
    }
    publish(Vec::new());
    for rx in &receivers {
        assert!(
            matches!(next_non_status(rx), DevEvent::Bundle { version: 3, url_schemes, .. } if url_schemes.is_empty())
        );
    }
}
