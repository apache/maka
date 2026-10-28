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

use maka_computer_use::{
    Session,
    protocol::{Command, InventoryOptions},
};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires WSL, a matching Windows helper, and a disposable Windows form with MAKA_CUA_TEST_WINDOW"]
async fn wsl_uses_windows_targets_input_cursors_and_session_cleanup() {
    use maka_capabilities::computer::Desktop;
    use serde_json::{Value, json};
    async fn call(session: &mut Session, id: &str, command: Value) -> Value {
        session
            .invoke(
                serde_json::from_value(command).unwrap(),
                &maka_computer_use::InvocationContext::new(id, "fixture-turn"),
                &CancellationToken::new(),
                maka_agent_facts::language::Language::En,
            )
            .await
            .unwrap()
    }
    assert!(
        std::fs::read_to_string("/proc/sys/kernel/osrelease")
            .unwrap()
            .to_ascii_lowercase()
            .contains("microsoft")
    );
    let window: u64 = std::env::var("MAKA_CUA_TEST_WINDOW")
        .expect("disposable form window ID")
        .parse()
        .unwrap();
    let driver = std::sync::Arc::new(tokio::sync::Mutex::new(maka_computer_use::Driver::default()));
    let mut a = Session::new(driver.clone());
    let mut b = Session::new(driver.clone());
    a.configure(
        Desktop::Auto,
        vec![],
        maka_agent_facts::language::Language::En,
    )
    .unwrap();
    b.configure(
        Desktop::Windows,
        vec![],
        maka_agent_facts::language::Language::En,
    )
    .unwrap();
    assert_eq!(a.platform(), "windows");
    assert!(
        matches!(a.configure(Desktop::Local, vec![], maka_agent_facts::language::Language::En), Err(maka_agent_facts::tools::ToolError::Failed(message)) if message.contains("reset Cua"))
    );
    #[cfg(feature = "native-desktop")]
    {
        let mut local = Session::new(driver.clone());
        local
            .configure(
                Desktop::Local,
                vec![],
                maka_agent_facts::language::Language::En,
            )
            .unwrap();
        assert_eq!(local.platform(), "linux");
        local.close().await.unwrap();
    }

    let app = call(
        &mut a,
        "wsl-a",
        json!({"method":"getApp","target":{"windowId":window}}),
    )
    .await;
    let state = app["state"].as_str().unwrap();
    let line = state
        .lines()
        .find(|line| line.contains("WSL input"))
        .unwrap_or_else(|| panic!("fixture field missing: {state}"));
    let index: u64 = line
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .split(|c: char| !c.is_ascii_digit())
        .next()
        .unwrap()
        .parse()
        .unwrap();
    call(&mut a, "wsl-a", json!({"method":"action","handle":app["handle"],"action":{"kind":"setValue","index":index,"value":"Maka WSL verified"}})).await;
    let observed = call(
        &mut a,
        "wsl-a",
        json!({"method":"observe","handle":app["handle"],"kind":"both","options":{}}),
    )
    .await;
    assert!(
        observed["state"]
            .as_str()
            .unwrap()
            .contains("Maka WSL verified")
    );
    assert!(observed["image"]["data"].as_str().unwrap().len() > 100);
    let foreign = b
        .invoke(
            serde_json::from_value(
                json!({"method":"observe","handle":app["handle"],"kind":"ax","options":{}}),
            )
            .unwrap(),
            &maka_computer_use::InvocationContext::new("wsl-b", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await;
    assert!(
        matches!(foreign, Err(maka_agent_facts::tools::ToolError::Failed(message)) if message.contains("stale_target"))
    );
    let other = call(
        &mut b,
        "wsl-b",
        json!({"method":"getApp","target":{"windowId":window}}),
    )
    .await;
    for (session, id, handle, label, color, point) in [
        (&mut a, "wsl-a", &app["handle"], "WSL A", "blue", [20, 20]),
        (
            &mut b,
            "wsl-b",
            &other["handle"],
            "WSL B",
            "mint",
            [120, 20],
        ),
    ] {
        call(session, id, json!({"method":"configureCursor","options":{"label":label,"color":color,"reducedMotion":true}})).await;
        call(
            session,
            id,
            json!({"method":"observe","handle":handle,"kind":"screenshot","options":{}}),
        )
        .await;
        call(session, id, json!({"method":"action","handle":handle,"action":{"kind":"moveCursor","target":point}})).await;
    }
    let cursor_a = call(
        &mut a,
        "wsl-a",
        json!({"method":"cursorState","options":{}}),
    )
    .await;
    let cursor_b = call(
        &mut b,
        "wsl-b",
        json!({"method":"cursorState","options":{}}),
    )
    .await;
    assert_eq!(cursor_a["native"]["status"], "ready");
    assert_eq!(cursor_b["native"]["status"], "ready");
    assert_eq!(
        cursor_a["native"]["rendererPid"],
        cursor_b["native"]["rendererPid"]
    );
    assert_ne!(cursor_a["settings"]["id"], cursor_b["settings"]["id"]);
    a.close().await.unwrap();
    assert_eq!(
        call(
            &mut b,
            "wsl-b",
            json!({"method":"cursorState","options":{}})
        )
        .await["native"]["visible"],
        true
    );
    let result = call(
        &mut b,
        "wsl-b",
        json!({"method":"observe","handle":other["handle"],"kind":"ax","options":{}}),
    )
    .await;
    assert!(
        result["state"]
            .as_str()
            .unwrap()
            .contains("Maka WSL verified")
    );
    b.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    println!(
        "WSL_WINDOWS_VERIFIED renderer_pid={}",
        cursor_b["native"]["rendererPid"]
    );
}

#[tokio::test]
async fn closed_or_cancelled_session_cannot_start_native_work() {
    let driver = std::sync::Arc::new(tokio::sync::Mutex::new(maka_computer_use::Driver::default()));
    let mut run = Session::new(driver.clone());
    let stop = CancellationToken::new();
    stop.cancel();
    assert!(
        matches!(run.prepare(&stop, maka_agent_facts::language::Language::En).await, Err(maka_agent_facts::tools::ToolError::Failed(message)) if message == "Computer Use preparation cancelled")
    );
    assert!(
        run.invoke(
            Command::ListApps {
                options: InventoryOptions::default()
            },
            &maka_computer_use::InvocationContext::new("cancelled", "fixture-turn"),
            &stop,
            maka_agent_facts::language::Language::En
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("cancelled before dispatch")
    );
    run.close().await.unwrap();
    assert!(
        matches!(run.prepare(&CancellationToken::new(), maka_agent_facts::language::Language::En).await, Err(maka_agent_facts::tools::ToolError::Failed(message)) if message == "Computer Use Session is closed")
    );
    assert!(
        run.invoke(
            Command::ListApps {
                options: InventoryOptions::default()
            },
            &maka_computer_use::InvocationContext::new("closed", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("Session is closed")
    );
    run.close().await.unwrap();
}

#[cfg(feature = "native-desktop")]
#[tokio::test]
#[ignore = "requires an interactive desktop; lists applications without sending input"]
async fn native_application_observation_and_shutdown() {
    let driver = std::sync::Arc::new(tokio::sync::Mutex::new(maka_computer_use::Driver::default()));
    let mut run = Session::new(driver.clone());
    let result = run
        .invoke(
            Command::ListApps {
                options: InventoryOptions::default(),
            },
            &maka_computer_use::InvocationContext::new("maka-native-smoke", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await;
    let mut other = Session::new(driver.clone());
    let second = other
        .invoke(
            Command::ListApps {
                options: InventoryOptions::default(),
            },
            &maka_computer_use::InvocationContext::new("maka-native-second", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await
        .unwrap();
    assert!(second.is_array());
    run.close().await.unwrap();
    let still_live = other
        .invoke(
            Command::ListWindows {
                options: InventoryOptions::default(),
            },
            &maka_computer_use::InvocationContext::new("maka-native-second", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await
        .unwrap();
    assert!(still_live.is_array());
    other.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    let result = result.unwrap();
    assert!(result.is_array());
}

#[cfg(all(feature = "native-desktop", target_os = "macos"))]
#[tokio::test]
#[ignore = "requires a locked macOS desktop; verifies refusal without launching or controlling an app"]
async fn locked_desktop_refuses_target_binding_before_app_resolution() {
    let driver = std::sync::Arc::new(tokio::sync::Mutex::new(maka_computer_use::Driver::default()));
    let mut session = Session::new(driver.clone());
    let error = session
        .invoke(
            Command::GetApp {
                target: maka_computer_use::protocol::AppReference::Window {
                    window_id: u64::MAX,
                },
            },
            &maka_computer_use::InvocationContext::new("locked-fixture", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("desktop_locked"), "{error}");
    session.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
}
