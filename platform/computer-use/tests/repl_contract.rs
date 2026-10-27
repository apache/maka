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

use maka_agent_facts::tools::ToolExecutor;
use maka_agent_facts::tools::ToolFuture;
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult};
use maka_computer_use::facade;
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

struct Fixture;
impl ToolExecutor for Fixture {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        Box::pin(async move {
            Ok(match input["method"].as_str().unwrap() {
                "documentation" => json!("Fixture CUA reference"),
                "getState" => {
                    json!({"apps":[],"browsers":[],"errors":["desktop_fixture_unavailable"]})
                }
                "getApp" => {
                    json!({"kind":"app","handle":{"kind":"app","id":"fixture"},"state":"Fixture window"})
                }
                "observe" => {
                    json!({"image":{"type":"image","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="}})
                }
                "action" => match input["action"]["kind"].as_str().unwrap() {
                    "click" => {
                        json!({"effect":"unverifiable","route":"synthetic_events","delivery":{"mode":"foreground"},"guidance":"Fixture effect is uncertain; read getAXState(); do not replay input."})
                    }
                    "setValue" => {
                        json!({"effect":"suspected_noop","guidance":"Fixture effect is uncertain; read getAXState(); do not replay input."})
                    }
                    "typeText" => {
                        json!({"effect":"partial","requested_chars":5,"delivered_chars":2,"guidance":"Fixture effect is uncertain; read getAXState(); do not replay input."})
                    }
                    other => panic!("unexpected fixture action {other}"),
                },
                other => panic!("unexpected fixture command {other}"),
            })
        })
    }
}

async fn evaluate(repl: &Repl, code: &str) -> Vec<CellOutput> {
    let context = CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![])
        .unwrap()
        .with_image_deduplication();
    let result = repl
        .evaluate(
            code.into(),
            Arc::new(Fixture),
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    context.take_output()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inventory_failures_remain_visible_and_auto_explicit_screenshot_output_is_once_per_call() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let output = evaluate(
        &repl,
        "const state=await cua.getState({emit:false}); nodeRepl.write(state.apps);",
    )
    .await;
    assert!(output.iter().any(|part| matches!(part, CellOutput::Text { text } if text.contains("desktop_fixture_unavailable"))));
    let output = evaluate(&repl, "const app=await cua.getApp('fixture'); const shot=await app.getScreenshot(); await nodeRepl.emitImage(shot);").await;
    assert_eq!(
        output
            .iter()
            .filter(|part| matches!(part, CellOutput::Media { .. }))
            .count(),
        1
    );
    let output = evaluate(&repl, "await nodeRepl.emitImage(shot);").await;
    assert_eq!(
        output
            .iter()
            .filter(|part| matches!(part, CellOutput::Media { .. }))
            .count(),
        1,
        "a later call can intentionally show the same image"
    );
    for (code, effect) in [
        ("nodeRepl.write(await app.click([0,0]));", "unverifiable"),
        (
            "nodeRepl.write(await app.setValue(1, 'value'));",
            "suspected_noop",
        ),
        ("nodeRepl.write(await app.typeText('value'));", "partial"),
    ] {
        let output = evaluate(&repl, code).await;
        assert!(output.iter().any(|part| matches!(part, CellOutput::Text {text} if text.contains(effect) && text.contains("getAXState()") && text.contains("do not replay"))));
        assert!(
            output
                .iter()
                .any(|part| matches!(part, CellOutput::Text {text} if text == "undefined")),
            "actions retain the public Promise<void> contract"
        );
        if effect == "partial" {
            assert!(output.iter().any(|part| matches!(part, CellOutput::Text {text} if text.contains("\"requestedChars\":5") && text.contains("\"deliveredChars\":2"))));
        }
    }
    repl.close().await.unwrap();
}

#[cfg(feature = "native-desktop")]
#[tokio::test]
async fn browser_discovery_distinguishes_no_configuration_from_an_unavailable_selection() {
    let driver = Arc::new(tokio::sync::Mutex::new(maka_computer_use::Driver::default()));
    let mut session = maka_computer_use::Session::new(driver.clone());
    session
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![],
            maka_agent_facts::language::Language::En,
        )
        .unwrap();
    for method in ["listBrowsers", "listTabs"] {
        let output = session
            .invoke(
                serde_json::from_value(json!({"method":method,"options":{}})).unwrap(),
                "fixture",
                &CancellationToken::new(),
                maka_agent_facts::language::Language::En,
            )
            .await
            .unwrap();
        assert_eq!(output, json!([]));
    }
    let missing = session
        .invoke(
            serde_json::from_value(json!({"method":"getBrowser","options":{"id":"chrome"}}))
                .unwrap(),
            "fixture",
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await;
    assert!(
        missing
            .unwrap_err()
            .to_string()
            .contains("no matching configured CDP provider")
    );
    session.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
}

// Each evaluation owns its language; the same REPL and native target owner can
// serve differently captured invocations without changing persistent JS state.
#[cfg(feature = "native-desktop")]
struct LocalBridge {
    native: Arc<tokio::sync::Mutex<maka_computer_use::Session>>,
    language: maka_agent_facts::language::Language,
}
#[cfg(feature = "native-desktop")]
impl ToolExecutor for LocalBridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let native = self.native.clone();
        let language = self.language;
        Box::pin(async move {
            native
                .lock()
                .await
                .invoke(
                    serde_json::from_value(input).unwrap(),
                    "language-fixture",
                    &cancellation,
                    language,
                )
                .await
        })
    }
}

#[cfg(feature = "native-desktop")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn persistent_repl_uses_each_evaluations_language_without_rewriting_user_output() {
    use maka_agent_facts::language::Language;
    let driver = Arc::new(tokio::sync::Mutex::new(maka_computer_use::Driver::default()));
    let native = Arc::new(tokio::sync::Mutex::new(maka_computer_use::Session::new(
        driver.clone(),
    )));
    native
        .lock()
        .await
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![],
            Language::En,
        )
        .unwrap();
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    for (language, recovery) in [
        (Language::ZhCn, "重新绑定目标"),
        (Language::ZhTw, "重新綁定目標"),
        (Language::En, "target rebinding"),
        (Language::ZhCn, "重新绑定目标"),
    ] {
        let context =
            CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = repl
            .evaluate(
                "await cua.listBrowsers(); nodeRepl.write('原始 user_DATA: zh-TW / en');".into(),
                Arc::new(LocalBridge {
                    native: native.clone(),
                    language,
                }),
                CancellationToken::new(),
                context.clone(),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
        let outputs = context.take_output();
        assert!(outputs.iter().any(|part| matches!(part, CellOutput::Text { text }
            if text.contains(recovery) && text.contains("cua_reset") && text.contains("getAXState"))));
        assert!(
            outputs
                .iter()
                .any(|part| matches!(part, CellOutput::Text { text }
            if text == "原始 user_DATA: zh-TW / en"))
        );
        assert!(
            outputs
                .iter()
                .any(|part| matches!(part, CellOutput::Text { text } if text == "[]"))
        );
    }
    repl.close().await.unwrap();
    native.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
}
