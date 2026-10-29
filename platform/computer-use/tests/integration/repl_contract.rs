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

#[tokio::test]
async fn host_refusals_and_unknown_outcomes_keep_their_original_message() {
    for (error, expected) in [
        (
            ToolError::Failed("native scroll refused".into()),
            "native scroll refused",
        ),
        (
            ToolError::OutcomeUnknown("tool effect outcome unknown: native detail".into()),
            "tool effect outcome unknown: native detail",
        ),
    ] {
        let repl = Repl::new(
            maka_computer_use::facade_for("linux", false),
            CellLimits::default(),
        )
        .unwrap();
        let host = Host::new(move |input| {
            if input["method"] == "action" {
                Err(error.clone())
            } else {
                binding(input)
            }
        });
        let output = evaluate(
            &repl,
            &host,
            r#"
            const app = await cua.getApp('fixture');
            try { await app.click([-1,41],{clickCount:0}); }
            catch(error) { nodeRepl.write({message:error.message}); }
        "#,
        )
        .await;
        let caught: Value = serde_json::from_str(text(&output).last().unwrap()).unwrap();
        assert_eq!(caught, json!({"message": expected}));
        assert_eq!(
            host.actions(),
            vec![json!({"kind":"linuxClick","input":{"x":-1,"y":41,"click_count":0}})]
        );
        repl.close().await.unwrap();
    }
}

#[tokio::test]
async fn ax_browser_actions_keep_read_output_separate_from_mutation() {
    for native in [false, true] {
        let repl = Repl::new(facade(), CellLimits::default()).unwrap();
        let host = Host::new(move |input| match input["method"].as_str().unwrap() {
            "getBrowser" => Ok(
                json!({"id":"fixture","type":if native {"extension"} else {"cdp"},"apiProfile":{"mode":"ax","user":native}}),
            ),
            "browserTab" => Ok(
                json!({"kind":"tab","id":"17","handle":{"kind":"tab","id":"tab"},"apiProfile":{"mode":"ax","user":native}}),
            ),
            "observe" => Ok(json!({"state":"AX state"})),
            "action" => Ok(Value::Null),
            _ => binding(input),
        });
        let output = evaluate(
            &repl,
            &host,
            r#"
        const browser = await cua.getBrowser({id:'fixture'});
        nodeRepl.write({user: 'user' in browser});
        const tab = await browser.tabs.get('17');
        nodeRepl.write(await tab.ax.get());
        await tab.ax.click([8.5,9.25],{mouseButton:'r',clickCount:2,extra:true});
        await tab.ax.drag([1,2],[3,4]);
        await tab.ax.paste(null,'paste',{format:'text',extra:true});
        await tab.ax.selectText(8,'chosen',{prefix:'before',suffix:'after',selectionType:'text'});
        await tab.ax.setValue(9,'value');
        await tab.ax.typeText(null,'typed');
    "#,
        )
        .await;
        assert!(text(&output).contains(&"AX state"));
        assert!(
            text(&output).contains(
                &serde_json::to_string(&json!({"user":native}))
                    .unwrap()
                    .as_str()
            )
        );
        assert_eq!(
            host.actions(),
            vec![
                json!({"kind":"click","target":[8.5,9.25],"options":{"mouseButton":"right","clickCount":2}}),
                json!({"kind":"drag","from":[1,2],"to":[3,4]}),
                json!({"kind":"paste","index":null,"text":"paste","options":{"format":"text"}}),
                json!({"kind":"selectText","index":8,"text":"chosen","options":{"prefix":"before","suffix":"after","selectionType":"text"}}),
                json!({"kind":"setValue","index":9,"value":"value"}),
                json!({"kind":"typeText","index":null,"text":"typed"}),
            ]
        );
        repl.close().await.unwrap();
    }
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
async fn cached_locator_rows_preserve_relative_selectors_and_tab_isolation() {
    let repl = Repl::new(facade(), CellLimits::default()).unwrap();
    let reads = std::sync::atomic::AtomicUsize::new(0);
    let host = Host::new(move |input| match input["method"].as_str().unwrap() {
        "browserRead" => Ok(match input["operation"]["kind"].as_str().unwrap() {
            "count" => json!(2),
            "rows" => {
                assert_eq!(
                    input["operation"]["relative"]["selector"],
                    "internal:role=button[name=\"Use\"s]"
                );
                {
                    let revision = reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                    json!([{"attributes":{"data-revision":revision.to_string()},"innerText":format!("Cached {revision}"),"textContent":format!("Raw {revision}")},{}])
                }
            }
            "innerText" => {
                assert_eq!(
                    input["locator"]["selector"],
                    ".rows >> nth=0 >> internal:has-text=\"x\"i"
                );
                json!("Live")
            }
            other => panic!("unexpected read {other}"),
        }),
        "browserTab" => Ok(
            json!({"kind":"tab","id":input["reference"]["id"],"handle":{"kind":"tab","id":input["reference"]["id"]},"apiProfile":{"mode":"ax","user":true}}),
        ),
        _ => binding(input),
    });
    let output = evaluate(&repl, &host, r#"
        const browser=await cua.getBrowser({id:'fixture'});
        const tab=await browser.tabs.get('17');
        const rows=await tab.playwright.locator('.rows').all();
        const role=rows[0].getByRole('button',{name:'Use',exact:true});
        const literal=rows[0].locator('internal:role=button[name="Use"s]');
        const result={inner:await role.innerText(),text:await literal.textContent(),revision:await literal.getAttribute('data-revision')};
        result.filtered=await rows[0].filter({hasText:'x'}).innerText();
        const other=await browser.tabs.get('another');
        try { role.and(other.playwright.locator('button')); }
        catch(error) { result.crossTabRefused=String(error).includes('same tab'); }
        nodeRepl.write(result);
    "#,
    ).await;
    assert_eq!(
        serde_json::from_str::<Value>(text(&output).last().unwrap()).unwrap(),
        json!({"inner":"Cached 1","text":"Raw 1","revision":"1","filtered":"Live","crossTabRefused":true})
    );
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
