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

#[derive(Default)]
struct Fixture {
    row_reads: Arc<std::sync::atomic::AtomicUsize>,
}
struct NativeCommands(Arc<std::sync::Mutex<Vec<Value>>>);
impl ToolExecutor for NativeCommands {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let recorded = self.0.clone();
        Box::pin(async move {
            if input["method"] == "action" {
                serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                    .map_err(|error| {
                        maka_agent_facts::tools::ToolError::Failed(error.to_string())
                    })?;
                recorded.lock().unwrap().push(input.clone());
            }
            Fixture::default().invoke(name, input, cancellation).await
        })
    }
}
impl ToolExecutor for Fixture {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        let row_reads = self.row_reads.clone();
        Box::pin(async move {
            Ok(match input["method"].as_str().unwrap() {
                "documentation" => json!("Fixture CUA reference"),
                "getState" => {
                    json!({"apps":[],"browsers":[],"errors":["desktop_fixture_unavailable"]})
                }
                "getApp" => {
                    let id = if input["target"] == "without-screenshot" {
                        "without-screenshot"
                    } else {
                        "fixture"
                    };
                    json!({"kind":"app","handle":{"kind":"app","id":id},"state":"Fixture window"})
                }
                "getBrowser" => json!({"id":"fixture"}),
                "createBrowserTab" => {
                    assert_eq!(input["browserId"], "fixture");
                    let id = match input.get("url") {
                        None => "omitted",
                        Some(Value::String(url)) if url == "about:blank" => "blank",
                        Some(Value::String(url)) if url.is_empty() => "empty",
                        Some(Value::String(url)) if url == "ftp://example.com" => "ftp",
                        other => panic!("unexpected convenience URL {other:?}"),
                    };
                    json!({"kind":"tab","handle":{"kind":"tab","id":id},"id":format!("fixture:{id}")})
                }
                "listTabs" => {
                    assert_eq!(input["options"]["browser"], "fixture");
                    json!([{"id":"fixture:existing","title":"Selected fixture","url":"about:blank"}])
                }
                "browserTab" => {
                    assert_eq!(input["browserId"], "fixture");
                    let id = match input["reference"]["kind"].as_str().unwrap() {
                        "existing" => {
                            assert_eq!(input["reference"]["id"], "fixture:existing");
                            "existing"
                        }
                        "new" => "new",
                        other => panic!("unexpected browser tab reference {other}"),
                    };
                    json!({"kind":"tab","handle":{"kind":"tab","id":id},"id":format!("fixture:{id}")})
                }
                "tabMetadata" => {
                    assert_eq!(input["handle"]["kind"], "tab");
                    match input["handle"]["id"].as_str().unwrap() {
                        "existing" => json!({"title":"Selected fixture","url":"about:blank"}),
                        "new" => json!({"title":"New fixture","url":"about:blank"}),
                        other => panic!("unexpected tab metadata handle {other}"),
                    }
                }
                "browserRead" => {
                    assert_eq!(input["handle"]["kind"], "tab");
                    match input["operation"]["kind"].as_str().unwrap() {
                        "count" => {
                            assert_eq!(input["locator"]["selector"], ".rows");
                            json!(2)
                        }
                        "rows" => {
                            assert_eq!(input["locator"]["selector"], ".rows");
                            assert_eq!(
                                input["operation"]["relative"]["selector"],
                                "internal:role=button[name=\"Use\"s]"
                            );
                            let revision =
                                row_reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                            json!([
                                {"attributes":{"data-revision":revision.to_string()},"innerText":format!("Cached {revision}"),"textContent":format!("Raw {revision}")},
                                {"attributes":{},"innerText":"Second","textContent":"Second"}
                            ])
                        }
                        "innerText" => {
                            assert_eq!(
                                input["locator"]["selector"],
                                ".rows >> nth=0 >> internal:has-text=\"x\"i"
                            );
                            json!("Live")
                        }
                        other => panic!("unexpected browser read {other}"),
                    }
                }
                "observe" => {
                    if input["handle"]["id"] == "without-screenshot"
                        || input["handle"]["id"] == "omitted"
                    {
                        json!({"state":"Screenshot unavailable"})
                    } else {
                        json!({"image":{"type":"image","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="}})
                    }
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
                    "scroll" => Value::Null,
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
            Arc::new(Fixture::default()),
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
async fn native_aliases_normalize_at_the_app_boundary_for_each_platform() {
    for platform in ["linux", "windows", "mac"] {
        let repl = Repl::new(
            maka_computer_use::facade_for(platform, false),
            CellLimits::default(),
        );
        let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
        let tools = Arc::new(NativeCommands(recorded.clone()));
        let distance = if platform == "mac" {
            "1"
        } else {
            "{pixels:100}"
        };
        let extra = if platform == "mac" {
            "await app.click([1,2],{mouseButton:0}); await app.click([1,2],{mouseButton:1}); await app.click([1,2],{mouseButton:2}); await app.click([1,2],{mouseButton:' LEFT '}); await app.scroll([1,2],' U ',1);"
        } else {
            ""
        };
        let code = format!(
            "const app=await cua.getApp('fixture'); const tab=await cua.createBrowserTab('fixture'); for (const target of [app,tab]) if ('moveCursor' in target) throw Error('unexpected public moveCursor'); for(const button of ['l','r','m']) await app.click([1,2],{{mouseButton:button}}); for(const direction of ['u','d','l','r']) await app.scroll([1,2],direction,{distance}); {extra}"
        );
        let context =
            CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = repl
            .evaluate(
                code,
                tools,
                CancellationToken::new(),
                context,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(
            matches!(result, CellResult::Success { .. }),
            "{platform}: {result:?}"
        );
        let commands = recorded.lock().unwrap();
        for (actual, expected) in commands[..3].iter().zip(["left", "right", "middle"]) {
            assert_eq!(actual["action"]["options"]["mouseButton"], expected);
        }
        for (actual, expected) in commands[3..7].iter().zip(["up", "down", "left", "right"]) {
            assert_eq!(actual["action"]["direction"], expected);
        }
        if platform == "mac" {
            for (actual, expected) in commands[7..11]
                .iter()
                .zip(["left", "right", "middle", "left"])
            {
                assert_eq!(actual["action"]["options"]["mouseButton"], expected);
            }
            assert_eq!(commands[11]["action"]["direction"], "up");
        }
        drop(commands);
        repl.close().await.unwrap();
    }
}

#[test]
fn scroll_distance_distinguishes_missing_from_null_and_round_trips_missing() {
    use maka_computer_use::protocol::{Action, Command, Distance};
    let command = json!({"method":"action","handle":{"kind":"app","id":"fixture"},"action":{"kind":"scroll","target":[10,20],"direction":"down"}});
    let parsed: Command = serde_json::from_value(command.clone()).unwrap();
    let serialized = serde_json::to_value(parsed).unwrap();
    assert!(serialized["action"].get("distance").is_none());
    assert!(serde_json::from_value::<Command>(serialized).is_ok());
    let mut explicit = command;
    explicit["action"]["distance"] = Value::Null;
    assert!(serde_json::from_value::<Command>(explicit).is_err());
    for pages in [-1.0, 0.0, 0.5, 51.0] {
        let action: Action = serde_json::from_value(
            json!({"kind":"scroll","target":1,"direction":"down","distance":pages}),
        )
        .unwrap();
        assert!(
            matches!(action, Action::Scroll { distance: Some(Distance::Pages(actual)), .. } if actual == pages)
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn combined_observation_omits_unavailable_screenshot_for_apps_and_tabs() {
    let repl = Repl::new(facade(), CellLimits::default());
    let output = evaluate(&repl, "const app=await cua.getApp('without-screenshot'); const combined=await app.getAXStateAndScreenshot({emit:false}); nodeRepl.write({state:combined.state,hasScreenshot:Object.prototype.hasOwnProperty.call(combined,'screenshot')}); const tab=await cua.createBrowserTab('fixture'); const tabCombined=await tab.getAXStateAndScreenshot({emit:false}); nodeRepl.write({hasScreenshot:Object.prototype.hasOwnProperty.call(tabCombined,'screenshot')});").await;
    assert!(output.iter().any(|part| matches!(part, CellOutput::Text { text } if text == "{\"state\":\"Screenshot unavailable\",\"hasScreenshot\":false}")));
    assert!(output.iter().any(
        |part| matches!(part, CellOutput::Text { text } if text == "{\"hasScreenshot\":false}")
    ));
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inventory_failures_remain_visible_and_auto_explicit_screenshot_output_is_once_per_call() {
    let repl = Repl::new(facade(), CellLimits::default());
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rich_browser_tab_methods_return_lazy_objects_and_current_metadata_without_auto_output() {
    let repl = Repl::new(facade(), CellLimits::default());
    let output = evaluate(
        &repl,
        "const browser=await cua.getBrowser({id:'fixture'}); const listed=await browser.tabs.list(); const selected=await browser.tabs.get(listed[0].id); const opened=await browser.tabs.new(); nodeRepl.write({title:await selected.title(),url:await opened.url(),id:opened.id});",
    ).await;
    assert_eq!(output.len(), 2, "{output:?}");
    let texts: Vec<_> = output
        .iter()
        .filter_map(|part| match part {
            CellOutput::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(texts.len(), 2, "{texts:?}");
    assert_eq!(texts[0], "Fixture CUA reference");
    assert_eq!(
        serde_json::from_str::<Value>(texts[1]).unwrap(),
        json!({"title":"Selected fixture","url":"about:blank","id":"fixture:new"})
    );
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn convenience_creation_preserves_omitted_and_explicit_urls_for_owned_navigation() {
    let repl = Repl::new(facade(), CellLimits::default());
    let output = evaluate(&repl,"const omitted=await cua.createBrowserTab('fixture'); const blank=await cua.createBrowserTab('fixture','about:blank'); const empty=await cua.createBrowserTab('fixture',''); const ftp=await cua.createBrowserTab('fixture','ftp://example.com'); nodeRepl.write([omitted.id,blank.id,empty.id,ftp.id]);").await;
    assert_eq!(output.len(), 2, "{output:?}");
    assert!(
        matches!(&output[1],CellOutput::Text{text} if serde_json::from_str::<Value>(text).unwrap() == json!(["fixture:omitted","fixture:blank","fixture:empty","fixture:ftp"]))
    );
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn playwright_collection_reads_share_exact_selector_caches_and_keep_tab_identity() {
    let repl = Repl::new(facade(), CellLimits::default());
    let output = evaluate(&repl, r#"
        const browser=await cua.getBrowser({id:'fixture'});
        const tab=await browser.tabs.get('fixture:existing');
        const rows=await tab.playwright.locator('.rows').all();
        const role=rows[0].getByRole('button',{name:'Use',exact:true});
        const literal=rows[0].locator('internal:role=button[name="Use"s]');
        const result={inner:await role.innerText(),text:await literal.textContent(),revision:await literal.getAttribute('data-revision')};
        result.filtered=await rows[0].filter({}).filter({hasText:'x'}).innerText();
        const other=await browser.tabs.new();
        try { role.and(other.playwright.locator('button')); throw Error('cross-tab locator accepted'); }
        catch(error) { if(!String(error).includes('same tab')) throw error; result.crossTabRefused=true; }
        nodeRepl.write(result);
    "#).await;
    assert_eq!(output.len(), 2, "{output:?}");
    assert!(
        matches!(&output[1],CellOutput::Text{text} if serde_json::from_str::<Value>(text).unwrap() == json!({"inner":"Cached 1","text":"Raw 1","revision":"1","filtered":"Live","crossTabRefused":true}))
    );
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
                &maka_computer_use::InvocationContext::new("fixture", "fixture-turn"),
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
            &maka_computer_use::InvocationContext::new("fixture", "fixture-turn"),
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
                    &maka_computer_use::InvocationContext::new("language-fixture", "fixture-turn"),
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
    let repl = Repl::new(facade(), CellLimits::default());
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
