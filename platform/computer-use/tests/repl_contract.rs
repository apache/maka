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

use maka_agent_facts::tools::{ToolError, ToolExecutor, ToolFuture};
use maka_code_runtime::{CellContext, CellLimits, CellOutput, CellResult};
use maka_computer_use::facade;
use maka_js_runtime::repl::Repl;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Fixture {
    row_reads: Arc<std::sync::atomic::AtomicUsize>,
    app_action_error: Option<ToolError>,
    action_errors: Arc<std::sync::Mutex<Vec<ToolError>>>,
    dom_snapshot_json: Option<String>,
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
        let app_action_error = self.app_action_error.clone();
        let action_errors = self.action_errors.clone();
        let dom_snapshot_json = self.dom_snapshot_json.clone();
        Box::pin(async move {
            if (input["method"] == "nativeComputer"
                || (input["method"] == "action" && input["handle"]["kind"] == "app"))
                && let Some(error) = app_action_error
            {
                action_errors.lock().unwrap().push(error.clone());
                return Err(error);
            }
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
                "getBrowser" => {
                    json!({"id":"fixture","type":"extension","apiProfile":{"mode":"ax","user":true}})
                }
                "createBrowserTab" => {
                    assert_eq!(input["browserId"], "fixture");
                    let id = match input.get("url") {
                        None => "omitted",
                        Some(Value::String(url)) if url == "about:blank" => "blank",
                        Some(Value::String(url)) if url.is_empty() => "empty",
                        Some(Value::String(url)) if url == "ftp://example.com" => "ftp",
                        other => panic!("unexpected convenience URL {other:?}"),
                    };
                    json!({"kind":"tab","apiProfile":{"mode":"ax","user":true},"handle":{"kind":"tab","id":id},"id":format!("fixture:{id}")})
                }
                "listTabs" | "browserManagedTabs" => {
                    if input["method"] == "listTabs" {
                        assert_eq!(input["options"]["browser"], "fixture");
                    } else {
                        assert_eq!(input["browserId"], "fixture");
                    }
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
                    json!({"kind":"tab","apiProfile":{"mode":"ax","user":true},"handle":{"kind":"tab","id":id},"id":format!("fixture:{id}")})
                }
                "tabMetadata" => {
                    assert_eq!(input["handle"]["kind"], "tab");
                    match input["handle"]["id"].as_str().unwrap() {
                        "existing" => json!({"title":"Selected fixture","url":"about:blank"}),
                        "new" => json!({"title":"New fixture","url":"about:blank"}),
                        other => panic!("unexpected tab metadata handle {other}"),
                    }
                }
                "browserCua" => {
                    assert_eq!(input["operation"]["kind"], "domSnapshot");
                    serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                        .expect("DOM snapshot uses the real command schema");
                    json!({"json":dom_snapshot_json.expect("DOM fixture has escaped JSON text")})
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
                    "click" | "linuxClick" => {
                        json!({"effect":"unverifiable","route":"synthetic_events","delivery":{"mode":"foreground"},"guidance":"Fixture effect is uncertain; read getAXState(); do not replay input."})
                    }
                    "setValue" => {
                        json!({"effect":"suspected_noop","guidance":"Fixture effect is uncertain; read getAXState(); do not replay input."})
                    }
                    "typeText" => {
                        json!({"effect":"partial","requested_chars":5,"delivered_chars":2,"guidance":"Fixture effect is uncertain; read getAXState(); do not replay input."})
                    }
                    "scroll" | "linuxScroll" | "drag" | "linuxDrag" | "secondary" => Value::Null,
                    other => panic!("unexpected fixture action {other}"),
                },
                other => panic!("unexpected fixture command {other}"),
            })
        })
    }
}

struct AxCommands {
    native: bool,
    calls: Arc<std::sync::Mutex<Vec<Value>>>,
}
impl ToolExecutor for AxCommands {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        let native = self.native;
        let calls = self.calls.clone();
        Box::pin(async move {
            serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            calls.lock().unwrap().push(input.clone());
            Ok(match input["method"].as_str().unwrap() {
                "documentation" => json!("AX fixture reference"),
                "getBrowser" => {
                    json!({"id":"fixture","type":if native {"extension"}else{"cdp"},"apiProfile":{"mode":"ax","user":native}})
                }
                "browserTab" | "browserUserClaimTab" => {
                    json!({"kind":"tab","id":"17","handle":{"kind":"tab","id":"ax"},"apiProfile":{"mode":"ax","user":native}})
                }
                "observe" => {
                    json!({"state":"AX fixture state","image":{"type":"image","mimeType":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="}})
                }
                "action" => Value::Null,
                other => panic!("unexpected AX fixture command {other}"),
            })
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_ax_profile_uses_real_protocol_and_keeps_get_separate_from_write() {
    for native in [true, false] {
        let repl = Repl::new(facade(), CellLimits::default()).unwrap();
        let calls = Arc::new(std::sync::Mutex::new(Vec::new()));
        let context =
            CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = repl.evaluate(
            format!(r#"
                const browser=await cua.getBrowser({{id:'fixture'}});
                if (('user' in browser)!=={native} || Object.keys(browser).includes('user')!=={native}) throw Error('provider profile mismatch');
                const tab=await browser.tabs.get('17');
                const names=['click','drag','get','paste','performSecondaryAction','pressKey','scroll','selectText','setValue','typeText','write'];
                if (JSON.stringify(Object.keys(tab.ax).sort())!==JSON.stringify(names.sort()) || !Object.isFrozen(tab.ax)) throw Error('AX shape mismatch');
                if (await tab.ax.get()!=='AX fixture state') throw Error('AX get result mismatch');
                const shot=await tab.ax.get('screenshot');
                if (!(shot instanceof Uint8Array) || shot[0]!==137) throw Error('AX screenshot bytes mismatch');
                await tab.ax.click([8.5,9.25],{{mouseButton:'r',clickCount:2,extra:true}});
                await tab.ax.drag([1,2],[3,4]);
                await tab.ax.paste(null,'paste',{{format:'text',extra:true}});
                await tab.ax.performSecondaryAction(7,'expand');
                await tab.ax.pressKey(null,'Control_L+F12');
                await tab.ax.scroll([5,6],'down',2.5);
                await tab.ax.selectText(8,'chosen',{{prefix:'before',suffix:'after',selectionType:'text',extra:true}});
                await tab.ax.setValue(9,'value');
                await tab.ax.typeText(null,'typed');
                if (await tab.ax.write('both',{{emit:false}})!==undefined) throw Error('AX write returned data');
            "#),
            Arc::new(AxCommands { native, calls: calls.clone() }), CancellationToken::new(), context.clone(), Duration::from_secs(5),
        ).await.unwrap();
        assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
        let output = context.take_output();
        let text: Vec<_> = output
            .iter()
            .filter_map(|part| match part {
                CellOutput::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(
            text.iter()
                .filter(|text| **text == "AX fixture state")
                .count(),
            1,
            "{output:?}"
        );
        assert!(
            matches!(output.last(), Some(CellOutput::Media { .. })),
            "{output:?}"
        );
        {
            let calls = calls.lock().unwrap();
            let observations: Vec<_> = calls
                .iter()
                .filter(|call| call["method"] == "observe")
                .collect();
            assert_eq!(observations.len(), 3);
            assert!(
                observations
                    .iter()
                    .all(|call| call["options"]["emit"] == false)
            );
            let actions: Vec<_> = calls
                .iter()
                .filter(|call| call["method"] == "action")
                .map(|call| call["action"].clone())
                .collect();
            assert_eq!(
                actions,
                vec![
                    json!({"kind":"click","target":[8.5,9.25],"options":{"mouseButton":"right","clickCount":2}}),
                    json!({"kind":"drag","from":[1,2],"to":[3,4]}),
                    json!({"kind":"paste","index":null,"text":"paste","options":{"format":"text"}}),
                    json!({"kind":"secondary","index":7,"action":"expand"}),
                    json!({"kind":"pressKey","index":null,"key":"Control_L+F12"}),
                    json!({"kind":"scroll","target":[5,6],"direction":"down","distance":2.5}),
                    json!({"kind":"selectText","index":8,"text":"chosen","options":{"prefix":"before","suffix":"after","selectionType":"text"}}),
                    json!({"kind":"setValue","index":9,"value":"value"}),
                    json!({"kind":"typeText","index":null,"text":"typed"}),
                ]
            );
        }
        repl.close().await.unwrap();
    }
}

struct UserBrowserCommands(Arc<std::sync::Mutex<Vec<Value>>>);
impl ToolExecutor for UserBrowserCommands {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let recorded = self.0.clone();
        Box::pin(async move {
            serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            recorded.lock().unwrap().push(input.clone());
            match input["method"].as_str().unwrap() {
                "browserUserOpenTabs" => {
                    Ok(json!([{"id":"17","title":"User fixture","url":"https://fixture.test/"}]))
                }
                "browserUserClaimTab" => Ok(
                    json!({"kind":"tab","apiProfile":{"mode":"ax","user":true},"handle":{"kind":"tab","id":"user-handle"},"id":input["tabId"]}),
                ),
                "browserTab" => Ok(
                    json!({"kind":"tab","apiProfile":{"mode":"ax","user":true},"handle":{"kind":"tab","id":"deferred"},"id":input["reference"]["id"]}),
                ),
                _ => Fixture::default().invoke(name, input, cancellation).await,
            }
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser_user_claim_preserves_public_ids_and_lazy_get_stays_separate() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl.evaluate(
        "const browser = await cua.getBrowser({id:'fixture'});
         const tabs = await browser.user.openTabs();
         const objectClaim = await browser.user.claimTab(tabs[0]);
         if (objectClaim.id !== '17' || typeof objectClaim.playwright.getByRole !== 'function') throw Error('claim did not return the ordinary Tab');
         await browser.user.claimTab(' 0x11 ');
         await browser.user.claimTab({id:''});
         for (const value of ['', null, {}, 17, {id:17}]) {
           let rejected = false;
           try { await browser.user.claimTab(value); } catch { rejected = true; }
           if (!rejected) throw Error('invalid claim argument reached the host');
         }
         const deferred = await browser.tabs.get('17');
         if (deferred.id !== '17') throw Error('lazy get changed the public id');".into(),
        Arc::new(UserBrowserCommands(recorded.clone())), CancellationToken::new(), context, Duration::from_secs(5),
    ).await.unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    {
        let calls = recorded.lock().unwrap();
        let claims: Vec<_> = calls
            .iter()
            .filter(|call| call["method"] == "browserUserClaimTab")
            .map(|call| call["tabId"].clone())
            .collect();
        assert_eq!(claims, vec![json!("17"), json!(" 0x11 "), json!("")]);
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "browserUserOpenTabs")
                .count(),
            1
        );
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "browserTab")
                .count(),
            1
        );
        assert!(!calls.iter().any(|call| call["method"] == "observe"));
    }
    repl.close().await.unwrap();
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
        )
        .unwrap();
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
        {
            let commands = recorded.lock().unwrap();
            for (actual, expected) in commands[..3].iter().zip(["left", "right", "middle"]) {
                let button = if platform == "linux" {
                    &actual["action"]["input"]["mouse_button"]
                } else {
                    &actual["action"]["options"]["mouseButton"]
                };
                assert_eq!(button, expected);
            }
            for (actual, expected) in commands[3..7].iter().zip(["up", "down", "left", "right"]) {
                let direction = if platform == "linux" {
                    &actual["action"]["input"]["direction"]
                } else {
                    &actual["action"]["direction"]
                };
                assert_eq!(direction, expected);
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
        }
        repl.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn secondary_action_name_reaches_the_existing_host_dispatch_on_each_platform() {
    for platform in ["linux", "mac", "windows"] {
        let repl = Repl::new(
            maka_computer_use::facade_for(platform, false),
            CellLimits::default(),
        )
        .unwrap();
        let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
        let context =
            CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = repl
            .evaluate(
                "var app = await cua.getApp('fixture');
                 if (await app.performSecondaryAction(7, 'Show Menu') !== undefined)
                   throw new Error('secondary action must preserve its void return');"
                    .into(),
                Arc::new(NativeCommands(recorded.clone())),
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
        {
            let commands = recorded.lock().unwrap();
            assert_eq!(commands.len(), 1, "{platform}: {commands:?}");
            assert_eq!(commands[0]["handle"], json!({"kind":"app","id":"fixture"}));
            assert_eq!(
                commands[0]["action"],
                json!({"kind":"secondary","index":7,"action":"Show Menu"})
            );
        }
        repl.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linux_app_projects_pointer_arguments_before_protocol_validation() {
    let repl = Repl::new(
        maka_computer_use::facade_for("linux", false),
        CellLimits::default(),
    )
    .unwrap();
    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            r#"
const app = await cua.getApp('fixture');
await app.click([37,41,999]);
await app.scroll([37,41,999],'down',{pixels:100});
await app.drag([37,41,999],[57,61,999]);
await app.drag({0:37,1:41},{0:57,1:61});
await app.click([37,41],null);
await app.click([37,41],{ignored:true});
for (const target of [1,'1','01',null,'not-an-element','٣']) await app.click(target);
await app.scroll('01','d');
await app.scroll(null,'down');
"#
            .into(),
            Arc::new(NativeCommands(recorded.clone())),
            CancellationToken::new(),
            context,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    let actions = recorded
        .lock()
        .unwrap()
        .iter()
        .map(|command| command["action"].clone())
        .collect();
    assert_eq!(
        Value::Array(actions),
        json!([
            {"kind":"linuxClick","input":{"x":37,"y":41}},
            {"kind":"linuxScroll","input":{"x":37,"y":41,"direction":"down","pixels":100}},
            {"kind":"linuxDrag","input":{"path":[{"x":37,"y":41},{"x":57,"y":61}]}},
            {"kind":"linuxDrag","input":{"path":[{"x":37,"y":41},{"x":57,"y":61}]}},
            {"kind":"linuxClick","input":{"x":37,"y":41}},
            {"kind":"linuxClick","input":{"x":37,"y":41}},
            {"kind":"linuxClick","input":{"element_id":"1"}},
            {"kind":"linuxClick","input":{"element_id":"1"}},
            {"kind":"linuxClick","input":{"element_id":"01"}},
            {"kind":"linuxClick","input":{"element_id":"null"}},
            {"kind":"linuxClick","input":{"element_id":"not-an-element"}},
            {"kind":"linuxClick","input":{"element_id":"٣"}},
            {"kind":"linuxScroll","input":{"element_id":"01","direction":"down"}},
            {"kind":"linuxScroll","input":{"element_id":"null","direction":"down"}}
        ])
    );
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linux_coordinate_click_passes_native_counts_and_null_fields_to_the_host() {
    let repl = Repl::new(
        maka_computer_use::facade_for("linux", false),
        CellLimits::default(),
    )
    .unwrap();
    let recorded = Arc::new(std::sync::Mutex::new(Vec::new()));
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            r#"
const app = await cua.getApp('fixture');
await app.click([37,41],{clickCount:0});
await app.click([37,41],{clickCount:4});
await app.click([null,41],{clickCount:null});
await app.click([NaN,Infinity],{clickCount:NaN});
await app.click([37],{clickCount:undefined});
"#
            .into(),
            Arc::new(NativeCommands(recorded.clone())),
            CancellationToken::new(),
            context,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    {
        let commands = recorded.lock().unwrap();
        assert!(
            commands
                .iter()
                .all(|command| command["action"]["kind"] == "linuxClick")
        );
        let inputs = commands
            .iter()
            .map(|command| command["action"]["input"].clone())
            .collect();
        // Native parsing and completeness belong to the host, after this boundary.
        assert_eq!(
            Value::Array(inputs),
            json!([
                {"x":37,"y":41,"click_count":0},
                {"x":37,"y":41,"click_count":4},
                {"x":null,"y":41,"click_count":null},
                {"x":null,"y":null,"click_count":null},
                {"x":37}
            ])
        );
    }
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linux_app_click_preserves_unknown_outcome_body_at_the_repl_boundary() {
    for body in [
        "background pointer position is outside the target window",
        "tool effect outcome unknown: nested application detail",
    ] {
        let repl = Repl::new(
            maka_computer_use::facade_for("linux", false),
            CellLimits::default(),
        )
        .unwrap();
        let action_errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        let context =
            CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = repl
            .evaluate(
                r#"
const app = await cua.getApp('fixture');
let caught;
try { await app.click([-1,41],{clickCount:0}); }
catch (error) { caught = {string:String(error),message:error.message}; }
if (caught === undefined) throw Error('expected native click failure');
nodeRepl.write(caught);
"#
                .into(),
                Arc::new(Fixture {
                    app_action_error: Some(ToolError::OutcomeUnknown(body.into())),
                    action_errors: action_errors.clone(),
                    ..Fixture::default()
                }),
                CancellationToken::new(),
                context.clone(),
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
        let output = context.take_output();
        let caught = output.iter().find_map(|part| match part {
            CellOutput::Text { text } => serde_json::from_str::<Value>(text)
                .ok()
                .filter(|value| value.get("message").is_some()),
            _ => None,
        });
        assert_eq!(
            caught,
            Some(json!({"string":format!("Error: {body}"),"message":body})),
            "{output:?}"
        );
        assert!(matches!(
            action_errors.lock().unwrap().as_slice(),
            [ToolError::OutcomeUnknown(message)] if message == body
        ));
        repl.close().await.unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_error_properties_survive_the_rust_to_js_repl_bridge() {
    let repl = Repl::new(
        maka_computer_use::facade_for("mac", false),
        CellLimits::default(),
    )
    .unwrap();
    let message = "Computer Use server error -10005: fixture native description";
    let action_errors = Arc::new(std::sync::Mutex::new(Vec::new()));
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl
        .evaluate(
            r#"
let caught;
async function native_error_properties() { await cua.computer.get_app_state(17); }
try { await native_error_properties(); }
catch (error) {
  if (!(error instanceof Error)) throw Error('native failure must remain a realm Error');
  if (error.constructor === Error || error.constructor.name !== 'SkyComputerUseError')
    throw Error('native failure lost its native Error subclass');
  if (!error.stack.includes('native_error_properties'))
    throw Error('native failure lost its original JavaScript stack');
  caught = {name:error.name,code:error.code,errorName:error.errorName,
    message:error.message,string:String(error)};
}
if (caught === undefined) throw Error('expected native failure');
nodeRepl.write(caught);
"#
            .into(),
            Arc::new(Fixture {
                app_action_error: Some(ToolError::Native(Box::new(
                    maka_agent_facts::tools::NativeToolError {
                        name: "SkyComputerUseError".into(),
                        code: -10005,
                        error_name: "unknownError".into(),
                        message: message.into(),
                    },
                ))),
                action_errors: action_errors.clone(),
                ..Fixture::default()
            }),
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    let output = context.take_output();
    let caught = output.iter().find_map(|part| match part {
        CellOutput::Text { text } => serde_json::from_str::<Value>(text)
            .ok()
            .filter(|value| value.get("code").is_some()),
        _ => None,
    });
    assert_eq!(
        caught,
        Some(json!({
            "name":"SkyComputerUseError","code":-10005,"errorName":"unknownError",
            "message":message,"string":format!("SkyComputerUseError: {message}")
        })),
        "{output:?}"
    );
    assert!(matches!(
        action_errors.lock().unwrap().as_slice(),
        [ToolError::Native(error)] if error.code == -10005 && error.message == message
    ));
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn linux_app_scroll_keeps_pixel_validation_with_the_host() {
    for body in [
        "pixels must be an integer between 1 and 65535",
        "pixels must be a positive finite number.",
    ] {
        let repl = Repl::new(
            maka_computer_use::facade_for("linux", false),
            CellLimits::default(),
        )
        .unwrap();
        let action_errors = Arc::new(std::sync::Mutex::new(Vec::new()));
        let context =
            CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
        let result = repl
            .evaluate(
                format!(
                    "const app = await cua.getApp('fixture');
                     let caught;
                     try {{ await app.scroll([37,41],'down',{{pixels:0}}); }}
                     catch (error) {{ caught = error.message; }}
                     if (caught !== {expected}) throw Error('native scroll refusal changed: ' + caught);",
                    expected = serde_json::to_string(body).unwrap(),
                ),
                Arc::new(Fixture {
                    app_action_error: Some(ToolError::Failed(body.into())),
                    action_errors: action_errors.clone(),
                    ..Fixture::default()
                }),
                CancellationToken::new(),
                context,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
        assert!(matches!(
            action_errors.lock().unwrap().as_slice(),
            [ToolError::Failed(message)] if message == body
        ));
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
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let output = evaluate(&repl, "const app=await cua.getApp('without-screenshot'); const combined=await app.getAXStateAndScreenshot({emit:false}); nodeRepl.write({state:combined.state,hasScreenshot:Object.prototype.hasOwnProperty.call(combined,'screenshot')}); const tab=await cua.createBrowserTab('fixture'); const tabCombined=await tab.getAXStateAndScreenshot({emit:false}); nodeRepl.write({hasScreenshot:Object.prototype.hasOwnProperty.call(tabCombined,'screenshot')});").await;
    assert!(output.iter().any(|part| matches!(part, CellOutput::Text { text } if text == "{\"state\":\"Screenshot unavailable\",\"hasScreenshot\":false}")));
    assert!(output.iter().any(
        |part| matches!(part, CellOutput::Text { text } if text == "{\"hasScreenshot\":false}")
    ));
    repl.close().await.unwrap();
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rich_browser_tab_methods_return_lazy_objects_and_current_metadata_without_auto_output() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
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
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let output = evaluate(&repl,"const omitted=await cua.createBrowserTab('fixture'); const blank=await cua.createBrowserTab('fixture','about:blank'); const empty=await cua.createBrowserTab('fixture',''); const ftp=await cua.createBrowserTab('fixture','ftp://example.com'); nodeRepl.write([omitted.id,blank.id,empty.id,ftp.id]);").await;
    assert_eq!(output.len(), 2, "{output:?}");
    assert!(
        matches!(&output[1],CellOutput::Text{text} if serde_json::from_str::<Value>(text).unwrap() == json!(["fixture:omitted","fixture:blank","fixture:empty","fixture:ftp"]))
    );
    repl.close().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn playwright_collection_reads_share_exact_selector_caches_and_keep_tab_identity() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
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
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

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
    let missing = match missing {
        Err(ToolError::Failed(message)) => message,
        other => panic!("expected missing provider refusal, got {other:?}"),
    };
    assert_eq!(missing, "browser_unavailable: no current matching provider");
    let unselected = session
        .invoke(
            serde_json::from_value(json!({"method":"getBrowser","options":{}})).unwrap(),
            &maka_computer_use::InvocationContext::new("fixture", "fixture-turn"),
            &CancellationToken::new(),
            maka_agent_facts::language::Language::En,
        )
        .await;
    assert!(
        matches!(&unselected, Err(ToolError::Failed(message)) if message == "browser selection is ambiguous or missing; select an ID from listBrowsers"),
        "{unselected:?}"
    );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    session
        .configure(
            maka_capabilities::computer::Desktop::Local,
            vec![maka_capabilities::computer::BrowserConnection {
                id: "unavailable-fixture".into(),
                endpoint: endpoint.clone(),
            }],
            maka_agent_facts::language::Language::En,
        )
        .unwrap();
    let invocation = maka_computer_use::InvocationContext::new("fixture", "fixture-turn");
    let cancellation = CancellationToken::new();
    let (unavailable, request) = tokio::join!(
        session.invoke(
            serde_json::from_value(json!({
                "method":"getBrowser","options":{"id":"unavailable-fixture"}
            }))
            .unwrap(),
            &invocation,
            &cancellation,
            maka_agent_facts::language::Language::En,
        ),
        tokio::time::timeout(Duration::from_secs(5), async {
            let (stream, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(stream);
            let mut request = String::new();
            stream.read_line(&mut request).await.unwrap();
            loop {
                let mut header = String::new();
                stream.read_line(&mut header).await.unwrap();
                if header == "\r\n" {
                    break;
                }
                assert!(!header.is_empty(), "incomplete owned CDP fixture request");
            }
            stream
                .get_mut()
                .write_all(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .await
                .unwrap();
            request
        })
    );
    let request = request.expect("configured provider must reach the owned CDP fixture");
    let mut request = request.split_whitespace();
    assert_eq!(request.next(), Some("GET"));
    assert_eq!(request.next(), Some("/json/version"));
    let unavailable = match unavailable {
        Err(ToolError::Failed(message)) => message,
        other => panic!("expected unavailable configured provider refusal, got {other:?}"),
    };
    assert!(
        unavailable.contains("503 Service Unavailable"),
        "{unavailable}"
    );
    assert!(
        unavailable.contains(&format!("{endpoint}/json/version")),
        "{unavailable}"
    );
    assert_ne!(unavailable, missing);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dom_snapshot_preserves_utf16_through_rust_and_the_real_repl_facade() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl.evaluate(
        r#"
            const tab = await cua.createBrowserTab('fixture');
            const saved = JSON.parse;
            JSON.parse = () => { throw Error('model-replaced parser must not run'); };
            try {
                const value = await tab.dom_cua.get_visible_dom();
                const expected = '<button node_id=17>' + '\ud83d' + '</button>\n<input node_id=18 title="' + '\udc00' + '\\ud800" />';
                if (value !== expected || typeof value !== 'string') throw Error('DOM UTF-16 text changed');
                if (value.charCodeAt(value.indexOf('>') + 1) !== 0xd83d) throw Error('high surrogate lost');
                if (!value.includes('\udc00') || !value.includes('\\ud800')) throw Error('low surrogate or literal escape lost');
                nodeRepl.write('DOM UTF-16 preserved');
            } finally { JSON.parse = saved; }
        "#.into(),
        Arc::new(Fixture {
            dom_snapshot_json: Some(r#""<button node_id=17>\ud83d</button>\n<input node_id=18 title=\"\udc00\\ud800\" />""#.into()),
            ..Fixture::default()
        }),
        CancellationToken::new(), context.clone(), Duration::from_secs(5),
    ).await.unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    assert!(
        context
            .take_output()
            .iter()
            .any(|part| matches!(part, CellOutput::Text {text} if text == "DOM UTF-16 preserved"))
    );
    repl.close().await.unwrap();
}

#[cfg(feature = "native-desktop")]
struct EncodedTitleFixture {
    title: cua_driver_core::browser::JsonStringLiteral,
    group: cua_driver_core::browser::JsonStringLiteral,
}
#[cfg(feature = "native-desktop")]
impl ToolExecutor for EncodedTitleFixture {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let title = self.title.clone();
        let group = self.group.clone();
        Box::pin(async move {
            serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                .expect("title fixture uses the actual command schema");
            let row = json!({"id":"fixture:existing","titleJson":title,"tabGroupJson":group,"url":"about:blank"});
            Ok(match input["method"].as_str().unwrap() {
                "listTabs" | "browserUserOpenTabs" => json!([row]),
                "browserManagedTabs" => {
                    let mut row = row;
                    row.as_object_mut().unwrap().remove("tabGroupJson");
                    json!([row])
                }
                "getState" => {
                    json!({"apps":[{"title":"Native title untouched"}],"browsers":[{"id":"fixture","tabs":[row]}],"errors":[]})
                }
                "tabMetadata" => row,
                _ => return Fixture::default().invoke(name, input, cancellation).await,
            })
        })
    }
}

#[cfg(feature = "native-desktop")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn encoded_titles_reach_every_repl_surface_before_observation_output() {
    use cua_driver_core::browser::JsonStringLiteral;
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl.evaluate(r#"
        const browser = await cua.getBrowser({id:'fixture'});
        const tab = await browser.tabs.get('fixture:existing');
        const expected = '\ud800 title \udc00 \\ud800 😀';
        const group = '\udc00 group';
        const originalParser = JSON.parse;
        JSON.parse = () => { throw Error('model parser must not be called'); };
        try {
            const check = (row, withGroup) => {
                if (row.title !== expected || typeof row.title !== 'string') throw Error('title changed');
                if (withGroup && row.tabGroup !== group) throw Error('group changed');
                if (!withGroup && Object.hasOwn(row,'tabGroup')) throw Error('managed inventory leaked user group');
                if (Object.hasOwn(row,'titleJson') || Object.hasOwn(row,'tabGroupJson')) throw Error('encoded fields escaped');
            };
            if (await tab.title() !== expected) throw Error('tab.title changed');
            check((await browser.tabs.list())[0], false);
            check((await browser.user.openTabs())[0], true);
            check((await cua.listTabs())[0], true);
            const state = await cua.getState();
            check(state.browsers[0].tabs[0], true);
            if (state.apps[0].title !== 'Native title untouched') throw Error('native app data changed');
            nodeRepl.write('Lossless titles preserved');
        } finally { JSON.parse = originalParser; }
    "#.into(), Arc::new(EncodedTitleFixture {
        title: JsonStringLiteral::parse(r#""\ud800 title \udc00 \\ud800 😀""#.into()).unwrap(),
        group: JsonStringLiteral::parse(r#""\udc00 group""#.into()).unwrap(),
    }), CancellationToken::new(), context.clone(), Duration::from_secs(5)).await.unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    let output = context.take_output();
    assert!(
        output.iter().any(
            |part| matches!(part, CellOutput::Text{text} if text == "Lossless titles preserved")
        )
    );
    let observations: Vec<_> = output
        .iter()
        .filter_map(|part| match part {
            CellOutput::Text { text } if text.starts_with('[') || text.starts_with("{\"apps\"") => {
                Some(text)
            }
            _ => None,
        })
        .collect();
    assert_eq!(observations.len(), 2);
    for text in observations {
        assert!(
            text.contains(r#""title":"\ud800 title \udc00 \\ud800 😀""#),
            "{text}"
        );
        assert!(text.contains(r#""tabGroup":"\udc00 group""#), "{text}");
        assert!(
            !text.contains("titleJson") && !text.contains("tabGroupJson"),
            "{text}"
        );
    }
    repl.close().await.unwrap();
}

// The matching native unit keeper renders this exact six-row AX grammar with
// the real Projection. This fixture checks its existing String/REPL boundary.
struct DialogAxTitleFixture;
impl DialogAxTitleFixture {
    fn state() -> String {
        concat!(
            "Tab 17: https://fixture.example/\n",
            r#"0 RootWebArea "\ud800 title \udc00 \\ud800 A 😀""#,
            "\n  1 alertdialog \"fixture.example says\"\n    2 StaticText \"Fixture message\"\n    3 textbox \"Response\" value=\"Default response\" [focused]\n    4 button \"Cancel\"\n    5 button \"OK\""
        )
        .into()
    }
}
impl ToolExecutor for DialogAxTitleFixture {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, name: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        Box::pin(async move {
            serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                .expect("dialog AX fixture uses the actual command schema");
            if input["method"] == "observe" {
                return Ok(json!({
                    "state":Self::state(),
                    "screenshotUnavailable":"Screenshot unavailable while a JavaScript prompt dialog is open. Use getAXState() and its dialog controls."
                }));
            }
            Fixture::default().invoke(name, input, cancellation).await
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dialog_ax_quoted_utf16_name_crosses_the_actual_repl_as_one_string() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let context =
        CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![]).unwrap();
    let result = repl.evaluate(r#"
        const tab = await (await cua.getBrowser({id:'fixture'})).tabs.get('fixture:existing');
        const expected = '\ud800 title \udc00 \\ud800 A 😀';
        const parse = JSON.parse;
        const stringify = JSON.stringify;
        const check = (state) => {
            if (typeof state !== 'string' || state.split('\n').length !== 7) throw Error('AX String/rows changed');
            const root = state.split('\n')[1];
            const prefix = '0 RootWebArea ';
            if (!root.startsWith(prefix)) throw Error('AX root grammar changed');
            const quotedName = root.slice(prefix.length);
            const actual = parse(quotedName);
            if (actual !== expected || actual.charCodeAt(0) !== 0xd800) throw Error('UTF16 code units changed');
            if (quotedName !== stringify(expected)) throw Error('AX name spelling is not canonical');
            if (!actual.includes('\\ud800') || actual.includes('\ufffd')) throw Error('literal escape or lone unit was replaced');
            if (!state.includes('    3 textbox "Response" value="Default response" [focused]') ||
                !state.endsWith('    4 button "Cancel"\n    5 button "OK"')) throw Error('dialog controls changed');
        };
        JSON.parse = () => { throw Error('facade must not reparse AX text'); };
        try {
            check(await tab.getAXState({emit:false}));
            check(await tab.getAXState());
            const both = await tab.getAXStateAndScreenshot({emit:false});
            check(both.state);
            if (Object.hasOwn(both,'screenshot')) throw Error('dialog screenshot invented');
            nodeRepl.write('Dialog AX literal preserved');
        } finally { JSON.parse = parse; }
    "#.into(), Arc::new(DialogAxTitleFixture), CancellationToken::new(), context.clone(), Duration::from_secs(5)).await.unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    let output = context.take_output();
    assert!(output.iter().any(|part| matches!(part,
        CellOutput::Text { text } if text == "Dialog AX literal preserved")));
    let observations: Vec<_> = output
        .iter()
        .filter_map(|part| match part {
            CellOutput::Text { text } if text.starts_with("Tab 17: ") => Some(text),
            _ => None,
        })
        .collect();
    let expected = DialogAxTitleFixture::state();
    assert_eq!(observations, vec![&expected]);
    repl.close().await.unwrap();
}
