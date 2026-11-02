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
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

type Reply = dyn Fn(&Value) -> Result<Value, ToolError> + Send + Sync;

#[derive(Clone)]
struct Host {
    calls: Arc<Mutex<Vec<Value>>>,
    reply: Arc<Reply>,
}
impl Host {
    fn new(reply: impl Fn(&Value) -> Result<Value, ToolError> + Send + Sync + 'static) -> Self {
        Self {
            calls: Arc::default(),
            reply: Arc::new(reply),
        }
    }
    fn actions(&self) -> Vec<Value> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|call| call["method"] == "action")
            .map(|call| call["action"].clone())
            .collect()
    }
}
impl ToolExecutor for Host {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }
    fn invoke(&self, _: String, input: Value, _: CancellationToken) -> ToolFuture {
        let host = self.clone();
        Box::pin(async move {
            serde_json::from_value::<maka_computer_use::protocol::Command>(input.clone())
                .expect("the facade must produce the real Host command schema");
            host.calls.lock().unwrap().push(input.clone());
            (host.reply)(&input)
        })
    }
}

fn binding(input: &Value) -> Result<Value, ToolError> {
    Ok(match input["method"].as_str().unwrap() {
        "documentation" => json!("CUA reference"),
        "getApp" => json!({"kind":"app","handle":{"kind":"app","id":"fixture"}}),
        "getBrowser" => {
            json!({"id":"fixture","type":"extension","apiProfile":{"mode":"ax","user":true}})
        }
        "browserTab" | "createBrowserTab" => {
            json!({"kind":"tab","id":"fixture:tab","handle":{"kind":"tab","id":"tab"},"apiProfile":{"mode":"ax","user":true}})
        }
        other => panic!("unexpected Host command {other}: {input}"),
    })
}

async fn evaluate(repl: &Repl, host: &Host, source: impl Into<String>) -> Vec<CellOutput> {
    let context = CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(), vec![])
        .unwrap()
        .with_image_deduplication();
    let result = repl
        .evaluate(
            source.into(),
            Arc::new(host.clone()),
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
    assert!(matches!(result, CellResult::Success { .. }), "{result:?}");
    context.take_output()
}

fn text(output: &[CellOutput]) -> Vec<&str> {
    output
        .iter()
        .filter_map(|part| match part {
            CellOutput::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn native_pointer_and_secondary_actions_reach_the_host_protocol() {
    for platform in ["linux", "windows", "mac"] {
        let repl = Repl::new(
            maka_computer_use::facade_for(platform, false),
            CellLimits::default(),
        )
        .unwrap();
        let host = Host::new(|input| {
            if input["method"] == "action" {
                Ok(Value::Null)
            } else {
                binding(input)
            }
        });
        let distance = if platform == "mac" {
            "2.5"
        } else {
            "{pixels:100}"
        };
        evaluate(
            &repl,
            &host,
            format!(
                r#"
            const app = await cua.getApp('fixture');
            await app.click([37.5,41.25],{{mouseButton:'r',clickCount:2}});
            await app.scroll([37.5,41.25],'u',{distance});
            await app.performSecondaryAction(7,'Show Menu');
        "#
            ),
        )
        .await;
        let actions = host.actions();
        if platform == "linux" {
            assert_eq!(
                actions,
                vec![
                    json!({"kind":"linuxClick","input":{"x":37.5,"y":41.25,"mouse_button":"right","click_count":2}}),
                    json!({"kind":"linuxScroll","input":{"x":37.5,"y":41.25,"direction":"up","pixels":100}}),
                    json!({"kind":"secondary","index":7,"action":"Show Menu"}),
                ]
            );
        } else {
            assert_eq!(
                actions,
                vec![
                    json!({"kind":"click","target":[37.5,41.25],"options":{"mouseButton":"right","clickCount":2}}),
                    json!({"kind":"scroll","target":[37.5,41.25],"direction":"up","distance": if platform == "mac" {json!(2.5)} else {json!({"pixels":100})}}),
                    json!({"kind":"secondary","index":7,"action":"Show Menu"}),
                ]
            );
        }
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
    let action_errors = Arc::new(Mutex::new(Vec::new()));
    let recorded = action_errors.clone();
    let error = ToolError::Native(Box::new(maka_agent_facts::tools::NativeToolError {
        name: "SkyComputerUseError".into(),
        code: -10005,
        error_name: "unknownError".into(),
        message: message.into(),
    }));
    let host = Host::new(move |input| {
        if input["method"] == "nativeComputer" {
            recorded.lock().unwrap().push(error.clone());
            Err(error.clone())
        } else {
            binding(input)
        }
    });
    let output = evaluate(
        &repl,
        &host,
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
"#,
    )
    .await;
    let caught = text(&output).into_iter().find_map(|part| {
        serde_json::from_str::<Value>(part)
            .ok()
            .filter(|value| value.get("code").is_some())
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

#[tokio::test]
async fn user_claim_is_explicit_while_tab_objects_and_metadata_are_lazy() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let host = Host::new(|input| match input["method"].as_str().unwrap() {
        "browserUserOpenTabs" | "browserManagedTabs" => {
            Ok(json!([{"id":"17","title":"Selected","url":"about:blank"}]))
        }
        "browserUserClaimTab" | "browserTab" => Ok(
            json!({"kind":"tab","id":"17","handle":{"kind":"tab","id":"tab"},"apiProfile":{"mode":"ax","user":true}}),
        ),
        "tabMetadata" => Ok(json!({"title":"Selected","url":"about:blank"})),
        _ => binding(input),
    });
    let output = evaluate(
        &repl,
        &host,
        r#"
        const browser = await cua.getBrowser({id:'fixture'});
        const listed = await browser.user.openTabs();
        await browser.user.claimTab(listed[0]);
        const tab = await browser.tabs.get('17');
        nodeRepl.write({id:tab.id,title:await tab.title()});
    "#,
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(text(&output).last().unwrap()).unwrap(),
        json!({"id":"17","title":"Selected"})
    );
    {
        let calls = host.calls.lock().unwrap();
        assert_eq!(
            calls
                .iter()
                .filter(|call| call["method"] == "browserUserClaimTab")
                .map(|call| call["tabId"].clone())
                .collect::<Vec<_>>(),
            vec![json!("17")]
        );
        assert!(calls.iter().all(|call| call["method"] != "observe"));
    }
    repl.close().await.unwrap();
}

#[tokio::test]
async fn observations_omit_missing_images_and_deduplicate_present_images_per_evaluation() {
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let host = Host::new(|input| match input["method"].as_str().unwrap() {
        "observe" if input["kind"] == "screenshot" => {
            Ok(json!({"image":{"type":"image","mimeType":"image/png","data":PNG}}))
        }
        "observe" => Ok(json!({"state":"Screenshot unavailable"})),
        _ => binding(input),
    });
    let output = evaluate(
        &repl,
        &host,
        r#"
        const app=await cua.getApp('fixture');
        const combined=await app.getAXStateAndScreenshot({emit:false});
        nodeRepl.write({state:combined.state,hasScreenshot:Object.hasOwn(combined,'screenshot')});
        globalThis.shot=await app.getScreenshot();
        await nodeRepl.emitImage(shot);
    "#,
    )
    .await;
    assert!(
        text(&output).contains(&"{\"state\":\"Screenshot unavailable\",\"hasScreenshot\":false}")
    );
    assert_eq!(
        output
            .iter()
            .filter(|part| matches!(part, CellOutput::Media { .. }))
            .count(),
        1
    );
    let output = evaluate(&repl, &host, "await nodeRepl.emitImage(shot);").await;
    assert_eq!(
        output
            .iter()
            .filter(|part| matches!(part, CellOutput::Media { .. }))
            .count(),
        1
    );
    repl.close().await.unwrap();
}

#[tokio::test]
async fn partial_effects_and_inventory_errors_remain_visible_without_replaying_actions() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let host = Host::new(|input| match input["method"].as_str().unwrap() {
        "getState" => Ok(json!({"apps":[],"browsers":[],"errors":["desktop unavailable"]})),
        "action" => Ok(
            json!({"effect":"partial","requested_chars":5,"delivered_chars":2,"guidance":"read getAXState(); do not replay"}),
        ),
        _ => binding(input),
    });
    let output = evaluate(
        &repl,
        &host,
        "await cua.getState({emit:false});const app=await cua.getApp('fixture');await app.typeText('value');",
    ).await;
    let values: Vec<Value> = text(&output)
        .iter()
        .filter_map(|s| serde_json::from_str(s).ok())
        .collect();
    assert_eq!(
        values,
        vec![
            json!({"errors":["desktop unavailable"]}),
            json!({"effect":"partial","requestedChars":5,"deliveredChars":2,"warning":"read getAXState(); do not replay"})
        ]
    );
    assert_eq!(host.actions().len(), 1);
    repl.close().await.unwrap();
}

#[tokio::test]
async fn encoded_dom_and_titles_survive_model_parser_replacement() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let host = Host::new(|input| match input["method"].as_str().unwrap() {
        "browserCua" => Ok(json!({"json":r#""<button>\ud83d\udc00\\ud800</button>""#})),
        "tabMetadata" => Ok(json!({"titleJson":r#""\ud800 title \udc00 \\ud800 😀""#})),
        "observe" => {
            Ok(json!({"state":"Tab 17\n0 RootWebArea \"\\ud800 title\"\n  1 button \"OK\""}))
        }
        _ => binding(input),
    });
    let output = evaluate(&repl, &host, r#"
        const tab=await (await cua.getBrowser({id:'fixture'})).tabs.get('17');
        const saved=JSON.parse;
        JSON.parse=()=>{throw Error('model parser must not run');};
        try {
            const dom=await tab.dom_cua.get_visible_dom();
            const title=await tab.title();
            const ax=await tab.getAXState({emit:false});
            nodeRepl.write({dom:dom==='<button>\ud83d\udc00\\ud800</button>',title:title==='\ud800 title \udc00 \\ud800 😀',ax:ax==='Tab 17\n0 RootWebArea "\\ud800 title"\n  1 button "OK"'});
        } finally {JSON.parse=saved;}
    "#,
    ).await;
    assert_eq!(
        serde_json::from_str::<Value>(text(&output).last().unwrap()).unwrap(),
        json!({"dom":true,"title":true,"ax":true})
    );
    repl.close().await.unwrap();
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
                .any(|part| matches!(part, CellOutput::Text { text } if serde_json::from_str::<Value>(text).is_ok_and(|value| value.is_array())))
        );
    }
    repl.close().await.unwrap();
    native.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
}
