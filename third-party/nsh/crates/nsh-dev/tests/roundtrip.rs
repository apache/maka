//! Server and client talking over a real socket.

use std::{sync::mpsc, time::Duration};

use nsh_dev::{
    AppInfo, ClientEvent, DevClient, DevEvent, DevServer, HostInfo,
    protocol::{BundleFormat, HostPlatform, LogLevel, WS_PATH},
};

const TIMEOUT: Duration = Duration::from_secs(5);

/// A host named `device` with bytecode `bytecode` serving `nsh/base`.
fn host(device: &str, bytecode: &str) -> HostInfo {
    HostInfo {
        device: device.into(),
        platform: HostPlatform::Android,
        bytecode_version: bytecode.into(),
        ui_sets: vec!["app/native".into(), "app/charts".into()],
        tests: false,
    }
}

fn next_non_status(rx: &mpsc::Receiver<DevEvent>) -> DevEvent {
    loop {
        match rx.recv_timeout(TIMEOUT).expect("event") {
            DevEvent::Connected
            | DevEvent::Disconnected
            | DevEvent::Building
            | DevEvent::Testing
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
            window: Some("{\"title\":\"Roundtrip\"}".into()),
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
            window,
            limits,
        } => {
            assert_ne!(session, 0, "the server names its run");
            assert_eq!(window.as_deref(), Some("{\"title\":\"Roundtrip\"}"));
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
    let started = DevClient::start(
        url,
        HostInfo {
            tests: true,
            ..host("tester", "bc-1")
        },
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
    let started = DevClient::start(
        url,
        HostInfo {
            tests: true,
            ..host("tester", "bc-1")
        },
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
