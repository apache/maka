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

use super::*;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
};

struct Case {
    id: &'static str,
    family: &'static str,
    selector: &'static str,
    value: &'static str,
    background: bool,
}

const CASES: [Case; 8] = [
    Case {
        id: "fill-empty",
        family: "input",
        selector: "#entry",
        value: "",
        background: true,
    },
    Case {
        id: "fill-text",
        family: "input",
        selector: "#entry",
        value: "alpha Å🙂",
        background: true,
    },
    Case {
        id: "ce-plain",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
    Case {
        id: "ce-focus-replace-cancel",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
    Case {
        id: "ce-focus-detach",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
    Case {
        id: "input-plain",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
    Case {
        id: "textarea-plain",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
    Case {
        id: "input-label",
        family: "ce",
        selector: "#entry-label",
        value: "own CE payload Ω🙂",
        background: false,
    },
];

const REDIRECT_CASES: [Case; 3] = [
    Case {
        id: "ce-redirect-input",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
    Case {
        id: "ce-redirect-shadow-input",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
    Case {
        id: "ce-redirect-frame-input",
        family: "ce",
        selector: "#entry",
        value: "own CE payload Ω🙂",
        background: false,
    },
];

pub(super) fn fixture_html(path: &str) -> Option<&'static str> {
    Some(match path {
        "/input/fill-empty?case=fill-empty" => {
            include_str!("neutral_focus/fixtures/fill-empty.html")
        }
        "/input/fill-text?case=fill-text" => include_str!("neutral_focus/fixtures/fill-text.html"),
        "/ce/ce-plain?case=ce-plain" => include_str!("neutral_focus/fixtures/ce-plain.html"),
        "/ce/ce-focus-replace-cancel?case=ce-focus-replace-cancel" => {
            include_str!("neutral_focus/fixtures/ce-focus-replace-cancel.html")
        }
        "/ce/ce-focus-detach?case=ce-focus-detach" => {
            include_str!("neutral_focus/fixtures/ce-focus-detach.html")
        }
        "/ce/input-plain?case=input-plain" => {
            include_str!("neutral_focus/fixtures/input-plain.html")
        }
        "/ce/textarea-plain?case=textarea-plain" => {
            include_str!("neutral_focus/fixtures/textarea-plain.html")
        }
        "/ce/input-label?case=input-label" => {
            include_str!("neutral_focus/fixtures/input-label.html")
        }
        "/ce/ce-redirect-input?case=ce-redirect-input" => {
            include_str!("neutral_focus/fixtures/ce-redirect-input.html")
        }
        "/ce/ce-redirect-shadow-input?case=ce-redirect-shadow-input" => {
            include_str!("neutral_focus/fixtures/ce-redirect-shadow-input.html")
        }
        "/ce/ce-redirect-frame-input?case=ce-redirect-frame-input" => {
            include_str!("neutral_focus/fixtures/ce-redirect-frame-input.html")
        }
        "/sentinel" => include_str!("neutral_focus/fixtures/sentinel.html"),
        _ => return None,
    })
}

const SENTINEL_SNAPSHOT: &str = r#"(()=>({url:location.href,timeOrigin:performance.timeOrigin,observedAt:performance.now(),hasFocus:document.hasFocus(),visibilityState:document.visibilityState,readyState:document.readyState,activeElementId:document.activeElement?.id??null,innerWidth,innerHeight,devicePixelRatio}))()"#;
const INPUT_SNAPSHOT: &str = include_str!("neutral_focus/input_snapshot.js");

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn save(file: &mut File, capture: &Value) {
    let bytes = serde_json::to_vec_pretty(capture).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    file.set_len(0).unwrap();
    file.write_all(&bytes).unwrap();
    file.write_all(b"\n").unwrap();
    file.sync_all().unwrap();
}

fn save_pending(file: &mut File, capture: &mut Value, row: &Value) {
    capture["pending_case"] = row.clone();
    save(file, capture);
}

async fn command(
    browser: &Browser,
    session: Option<&str>,
    method: &str,
    input: Value,
) -> Result<Value, String> {
    browser
        .observer
        .call(session, method, input)
        .await
        .map_err(|error| error.to_string())
}

async fn read(browser: &Browser, session: Option<&str>, method: &str, input: Value) -> Value {
    match command(browser, session, method, input).await {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error}),
    }
}

async fn document(browser: &Browser, session: Option<&str>, expression: &str) -> Value {
    let raw = read(
        browser,
        session,
        "Runtime.evaluate",
        json!({"expression":expression,"returnByValue":true,"awaitPromise":true}),
    )
    .await;
    if raw["ok"] == true && raw["value"].get("exceptionDetails").is_none() {
        json!({"ok":true,"value":raw["value"]["result"]["value"]})
    } else {
        json!({"ok":false,"raw":raw})
    }
}

// This owned file is an expression; Biome may add one statement terminator.
// Keep that terminator outside the surrounding `fixture: (...)` expression.
fn input_snapshot_expression() -> &'static str {
    let expression = INPUT_SNAPSHOT.trim_end();
    expression
        .strip_suffix(';')
        .unwrap_or(expression)
        .trim_end()
}

fn snapshot_expression(case: &Case) -> String {
    let fixture = if case.family == "input" {
        input_snapshot_expression()
    } else {
        "window.__ceProbe.snapshot()"
    };
    format!(
        r#"(()=>({{url:location.href,timeOrigin:performance.timeOrigin,observedAt:performance.now(),hasFocus:document.hasFocus(),visibilityState:document.visibilityState,readyState:document.readyState,activeElementId:document.activeElement?.id??null,fixture:({fixture}),documentHtml:document.documentElement.outerHTML}}))()"#
    )
}

async fn pair(browser: &Browser, b_session: &str, case: &Case) -> Value {
    // A is always the first independent read after an awaited public call.
    let a = document(browser, None, &snapshot_expression(case)).await;
    let b = document(browser, Some(b_session), SENTINEL_SNAPSHOT).await;
    let a_metrics = read(browser, None, "Page.getLayoutMetrics", json!({})).await;
    let b_metrics = read(browser, Some(b_session), "Page.getLayoutMetrics", json!({})).await;
    let a_frame = read(browser, None, "Page.getFrameTree", json!({})).await;
    let b_frame = read(browser, Some(b_session), "Page.getFrameTree", json!({})).await;
    json!({"a":a,"b":b,"a_layout_metrics":a_metrics,"b_layout_metrics":b_metrics,
        "a_frame_tree":a_frame,"b_frame_tree":b_frame,
        "order":["A DOM","B DOM","A layout metrics","B layout metrics","A frame tree","B frame tree"],
        "timing":"Sequential neutral observations, not atomic. A is read before B or filesystem writes. Per-document clocks retain their own timeOrigin; raw event arrays are not sorted or normalized."})
}

async fn wait_ready(
    browser: &Browser,
    session: Option<&str>,
    url: &str,
    fixture: &str,
) -> Result<(), String> {
    let expression = format!(
        "location.href==={} && document.readyState==='complete' && ({fixture})",
        json!(url)
    );
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let observed = document(browser, session, &expression).await;
            if observed["ok"] == true && observed["value"] == true {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .map_err(|error| format!("owned document readiness: {error}"))
}

async fn wait_scene(
    browser: &Browser,
    b_session: &str,
    background: bool,
    receipt: &mut Value,
) -> Result<(), String> {
    const STATE: &str = "({url:location.href,timeOrigin:performance.timeOrigin,observedAt:performance.now(),hasFocus:document.hasFocus(),visibilityState:document.visibilityState})";
    let budget = Duration::from_secs(10);
    let started = tokio::time::Instant::now();
    *receipt = json!({"deadline_ms":10000,"samples":[],"ok":false,
        "predicate":"A.hasFocus === !background && B.hasFocus === background; visibility is retained without changing the existing focus guard",
        "scope":"Sequential independent A/B reads; no activation retry, focus reset or emulation setter"});
    let result = tokio::time::timeout(budget, async {
        loop {
            let a = document(browser, None, STATE).await;
            let a_focused = a["ok"] == true && a["value"]["hasFocus"] == !background;
            let index = receipt["samples"].as_array().unwrap().len();
            receipt["samples"].as_array_mut().unwrap().push(json!({
                "index":index,"a_elapsed_seconds":started.elapsed().as_secs_f64(),
                "a":a,"b_pending":true,"completed_pair":false}));
            let b = document(browser, Some(b_session), STATE).await;
            let elapsed = started.elapsed();
            let satisfied = a_focused && b["ok"] == true && b["value"]["hasFocus"] == background;
            let accepted = satisfied && elapsed <= budget;
            let sample = &mut receipt["samples"][index];
            sample["b"] = b;
            sample["b_pending"] = json!(false);
            sample["completed_pair"] = json!(true);
            sample["elapsed_seconds"] = json!(elapsed.as_secs_f64());
            sample["focus_predicate_satisfied"] = json!(satisfied);
            sample["accepted_within_deadline"] = json!(accepted);
            if accepted {
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await;
    receipt["elapsed_seconds"] = json!(started.elapsed().as_secs_f64());
    match result {
        Ok(()) => {
            receipt["ok"] = json!(true);
            Ok(())
        }
        Err(error) => {
            let message = format!("initial owned A/B focus precondition: {error}");
            receipt["error"] = json!(message);
            Err(message)
        }
    }
}

async fn create_b(
    browser: &Browser,
    url: &str,
    background: bool,
    target: &mut Option<String>,
    session: &mut Option<String>,
) -> Result<(), String> {
    let reply = command(
        browser,
        None,
        "Target.createTarget",
        json!({"url":url,"background":background}),
    )
    .await?;
    let id = reply["targetId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("createTarget did not return owned B id")?
        .to_owned();
    *target = Some(id.clone());
    let reply = command(
        browser,
        None,
        "Target.attachToTarget",
        json!({"targetId":id,"flatten":true}),
    )
    .await?;
    *session = Some(
        reply["sessionId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("attachToTarget did not return owned B session")?
            .to_owned(),
    );
    Ok(())
}

async fn cell(repl: &Repl, bridge: Arc<dyn ToolExecutor>, source: &str) -> Value {
    let store = match CellStore::temporary() {
        Ok(store) => store,
        Err(error) => {
            return json!({"cell_result":{"ok":false,"context_error":format!("{error:?}")}});
        }
    };
    let context = match CellContext::new(store, vec![]) {
        Ok(context) => context,
        Err(error) => {
            return json!({"cell_result":{"ok":false,"context_error":format!("{error:?}")}});
        }
    };
    let result = repl
        .evaluate(
            source.to_owned(),
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(20),
        )
        .await;
    let output = context.take_output();
    let public = output
        .iter()
        .rev()
        .find_map(|output| match output {
            CellOutput::Text { text } => serde_json::from_str::<Value>(text).ok(),
            _ => None,
        })
        .unwrap_or(Value::Null);
    json!({"cell_result":match result {
        Ok(result)=>serde_json::to_value(result).unwrap(),
        Err(error)=>json!({"ok":false,"abort":format!("{error:?}")}),
    },"public_output":public,"output":serde_json::to_value(output).unwrap(),"source":source,"source_sha256":digest(source.as_bytes())})
}

fn process_metadata(browser: &Browser) -> Value {
    let Some(pid) = browser.chrome.id() else {
        return json!({"ok":false,"error":"owned child has no process id"});
    };
    let base = PathBuf::from(format!("/proc/{pid}"));
    let raw = |name| match std::fs::read(base.join(name)) {
        Ok(bytes) => json!({"ok":true,"bytes":bytes,"sha256":digest(&bytes)}),
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    };
    json!({"owned_child_pid":pid,"cmdline":raw("cmdline"),"status":raw("status"),"stat":raw("stat"),
        "exe":match std::fs::read_link(base.join("exe")) {
            Ok(path)=>json!({"ok":true,"value":path}),Err(error)=>json!({"ok":false,"error":error.to_string()})},
        "provenance":"Only this fresh fixture's retained tokio Child; no PID attribution by process-name or global scan"})
}

fn observed_controls(row: &Value, case: &Case) -> Value {
    let result = &row["operation"]["public_output"]["__neutral_result__"];
    let after = &row["after"]["a"]["value"]["fixture"];
    let positive = match case.id {
        "ce-plain" => Some(
            result["ok"] == true
                && result["isUndefined"] == true
                && after["state"]["text"] == case.value,
        ),
        "input-plain" | "textarea-plain" | "input-label" => Some(
            result["ok"] == true
                && result["isUndefined"] == true
                && after["state"]["value"] == case.value,
        ),
        _ => None,
    };
    let negative = (case.id == "ce-focus-detach").then(|| {
        result["ok"] == false
            && after["state"]["held"]["connected"] == false
            && after["state"]["currentEntryIsHeld"] == false
            && after["state"]["replacement"]["text"] == "untouched replacement"
            && after["documentPastes"]
                .as_array()
                .is_some_and(Vec::is_empty)
            && after["pastes"].as_array().is_some_and(Vec::is_empty)
    });
    json!({"positive_control_satisfied":positive,"held_detach_negative_satisfied":negative,
        "scope":"Observed controls are reported separately from capture completeness and do not establish Original parity. Both document and retained disconnected-node paste arrays are required for the negative."})
}

fn observations_complete(row: &Value) -> bool {
    if row["initial_scene_verified"] != true
        || row["binding"]["cell_result"]["ok"] != true
        || row["binding"]["public_output"]["__neutral_binding__"]["ok"] != true
        || row["operation"]["cell_result"]["ok"] != true
        || !row["operation"]["public_output"]["__neutral_result__"]["ok"].is_boolean()
        || row["public_locator_fill_attempts"] != 1
        || row["all_authorizations_bound_to_fixture"] != true
    {
        return false;
    }
    for phase in [
        "before_binding",
        "before",
        "after",
        "after_product_teardown",
    ] {
        for target in ["a", "b"] {
            if row[phase][target]["ok"] != true {
                return false;
            }
        }
        for target in [
            "a_frame_tree",
            "b_frame_tree",
            "a_layout_metrics",
            "b_layout_metrics",
        ] {
            if row[phase][target]["ok"] != true {
                return false;
            }
        }
    }
    for target in ["a_frame_tree", "b_frame_tree"] {
        for field in ["id", "loaderId", "url"] {
            let before = &row["before_binding"][target]["value"]["frameTree"]["frame"][field];
            if !before.as_str().is_some_and(|value| !value.is_empty()) {
                return false;
            }
            for phase in ["before", "after", "after_product_teardown"] {
                if row[phase][target]["value"]["frameTree"]["frame"][field] != *before {
                    return false;
                }
            }
        }
    }
    [
        "repl",
        "session",
        "driver",
        "neutral_b_detach",
        "neutral_b_close",
    ]
    .iter()
    .all(|key| row["cleanup"][*key]["ok"] == true)
        && row["cleanup"]["neutral_b_close"]["value"]["success"] == true
}

async fn record_case(file: &mut File, capture: &mut Value, case: &Case) {
    let route = format!("/{}/{}?case={}", case.family, case.id, case.id);
    let mut row = json!({"id":case.id,"family":case.family,"selector":case.selector,"method":"fill","value":case.value,
        "scene":if case.background {"background"} else {"foreground"},"completed":false,
        "public_locator_fill_attempts":0,"phase":"before fresh headed owned Chrome",
        "fixture_html_sha256":digest(fixture_html(&route).unwrap().as_bytes()),
        "sentinel_html_sha256":digest(fixture_html("/sentinel").unwrap().as_bytes()),
        "creation_history":["Fresh inherited Browser::open_with_headless(false) launches generic owned root page A; its initial foreground history is retained, not represented as Original about:blank."]});
    save_pending(file, capture, &row);
    let browser = Browser::open_with_headless(false).await;
    row["a_target"] = json!(browser.target);
    row["initial_url"] = json!(browser.url);
    row["own_process"] = process_metadata(&browser);
    row["browser_version"] = read(&browser, None, "Browser.getVersion", json!({})).await;
    row["browser_command_line"] =
        read(&browser, None, "Browser.getBrowserCommandLine", json!({})).await;
    let a_url = format!("{}{}", browser.url.trim_end_matches('/'), route);
    let b_url = format!("{}sentinel", browser.url);
    row["url"] = json!(a_url);
    row["sentinel_url"] = json!(b_url);
    let driver = Arc::new(Mutex::new(Driver::default()));
    let session = Arc::new(Mutex::new(browser.session(driver.clone())));
    let authority = browser.authority();
    let bridge = Arc::new(Bridge {
        session: session.clone(),
        authority: authority.clone(),
    });
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    );
    let mut b_target = None;
    let mut b_session = None;
    let measured: Result<(), String> = async {
        if case.background {
            create_b(&browser, &b_url, false, &mut b_target, &mut b_session).await?;
            command(&browser, None, "Target.activateTarget", json!({"targetId":b_target})).await?;
            row["creation_history"].as_array_mut().unwrap().push(json!("Initial setup only: create B background=false and activate its exact returned target id before navigating A."));
        }
        command(&browser, None, "Page.navigate", json!({"url":a_url})).await?;
        wait_ready(&browser, None, &a_url, if case.family=="input" {"window.__fixture?.caseId && !!window.__inputOrderDiagnostics"} else if case.id.starts_with("ce-redirect-") {"!!window.__ceProbe && window.__ceProbe.snapshot().redirect.ready"} else {"!!window.__ceProbe"}).await?;
        if !case.background {
            create_b(&browser, &b_url, true, &mut b_target, &mut b_session).await?;
            row["creation_history"].as_array_mut().unwrap().push(json!("Initial setup only: navigate A and create B background=true; final desired-target activation follows both owned readiness barriers."));
        }
        let b = b_session.as_deref().ok_or("owned B observer session missing")?;
        wait_ready(&browser, Some(b), &b_url, "!!document.querySelector('#sentinel')").await?;
        row["b_target"] = json!(b_target);
        row["b_observer_session"] = json!(b);
        let desired = if case.background {
            b_target.as_deref().ok_or("owned B activation target missing")?
        } else {
            browser.target.as_str()
        };
        row["pretrial_setup"] = json!({"both_owned_documents_ready":true,
            "desired_target":if case.background {"B"} else {"A"},"desired_target_id":desired,
            "a_target_id":browser.target,"b_target_id":b_target,"a_url":a_url,"b_url":b_url,
            "final_activation_attempts":1,"method":"Page.bringToFront","scope":"One final initial setup Page.bringToFront on the exact desired page session after both exact-document readiness barriers, before initial snapshot and all public binding/inventory/claim. INPUT keeps its separately recorded pre-navigation B activation so A is born in the background. No later activation repair."});
        row["phase"] = json!("both owned documents ready; final declared pretrial activation pending");
        save_pending(file, capture, &row);
        let activation_started = tokio::time::Instant::now();
        let activation_session = if case.background { Some(b) } else { None };
        let activation = read(&browser, activation_session, "Page.bringToFront", json!({})).await;
        let acknowledged = activation["ok"] == true;
        row["pretrial_setup"]["activation"] = activation;
        row["pretrial_setup"]["activation_elapsed_seconds"] = json!(activation_started.elapsed().as_secs_f64());
        if !acknowledged { return Err("final declared pretrial activation failed; no retry performed".into()); }
        row["creation_history"].as_array_mut().unwrap().push(json!("Final initial setup only: bring the declared exact-owned page to front once after both documents are ready, then observe without repair."));
        wait_scene(&browser, b, case.background, &mut row["pretrial_setup"]["gate"]).await?;
        row["before_binding"] = pair(&browser, b, case).await;
        row["initial_scene_verified"] = json!(row["before_binding"]["a"]["ok"]==true && row["before_binding"]["b"]["ok"]==true
            && row["before_binding"]["a"]["value"]["hasFocus"]==!case.background
            && row["before_binding"]["b"]["value"]["hasFocus"]==case.background);
        if row["initial_scene_verified"]!=true { return Err("A/B focus changed before first public binding; no repair performed".into()); }
        row["phase"] = json!("initial neutral A/B focus precondition retained before public binding");
        save_pending(file, capture, &row);
        let repl = repl.as_ref().map_err(|error| format!("REPL creation: {error:?}"))?;
        let binding = format!("var __neutralTab;{{try{{const ownedBrowser=await cua.getBrowser({{id:'fixture'}});__neutralTab=await ownedBrowser.tabs.get({});nodeRepl.write(JSON.stringify({{__neutral_binding__:{{ok:true}}}}));}}catch(error){{nodeRepl.write(JSON.stringify({{__neutral_binding__:{{ok:false,name:error.name,error:String(error)}}}}));}}}}",json!(browser.target));
        row["binding"] = cell(repl, bridge.clone(), &binding).await;
        row["before"] = pair(&browser, b, case).await;
        row["phase"] = json!("public binding retained; no focus reset or emulation setter");
        save_pending(file, capture, &row);
        if row["binding"]["public_output"]["__neutral_binding__"]["ok"]!=true { return Err("public binding failed; retained neutral before-fill observation".into()); }
        if case.id.starts_with("ce-redirect-") {
            let fixture = &row["before"]["a"]["value"]["fixture"];
            let valid = fixture["caseId"] == case.id
                && fixture["redirect"]["ready"] == true
                && fixture["state"]["held"]["connected"] == true
                && fixture["state"]["currentEntryIsHeld"] == true
                && fixture["state"]["activeIsHeld"] == false
                && fixture["focusHandlers"] == 0
                && fixture["focusMutation"].is_null()
                && fixture["state"]["text"] == "seed";
            row["redirect_causal_control_valid"] = json!(valid);
            if !valid { return Err("fresh directed redirect pretrial causal controls failed; no fill attempted".into()); }
        }
        let source = format!("{{try{{const result=await __neutralTab.playwright.locator({}).fill({});nodeRepl.write(JSON.stringify({{__neutral_result__:{{ok:true,type:typeof result,isUndefined:result===undefined}}}}));}}catch(error){{nodeRepl.write(JSON.stringify({{__neutral_result__:{{ok:false,name:error.name,error:String(error)}}}}));}}}}",json!(case.selector),json!(case.value));
        row["public_locator_fill_attempts"] = json!(1);
        row["operation"] = cell(repl, bridge.clone(), &source).await;
        // No filesystem, version request, wait, RAF or other product call precedes A.
        row["after"] = pair(&browser, b, case).await;
        row["controls"] = observed_controls(&row, case);
        row["phase"] = json!("public fill result and immediate independent A/B observations retained");
        save_pending(file, capture, &row);
        Ok(())
    }.await;
    row["measurement"] = match measured {
        Ok(()) => json!({"ok":true}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    if let Ok(repl) = repl {
        let result = repl.close().await;
        row["cleanup"]["repl"] = json!({"ok":result.is_ok(),"raw":format!("{result:?}")});
    } else {
        row["cleanup"]["repl"] = json!({"ok":false,"error":"REPL was not created"});
    }
    let result = session.lock().await.close().await;
    row["cleanup"]["session"] = json!({"ok":result.is_ok(),"raw":format!("{result:?}")});
    let result = driver.lock().await.close().await;
    row["cleanup"]["driver"] = json!({"ok":result.is_ok(),"raw":format!("{result:?}")});
    // The independent observer remains alive through all product teardown.
    if let Some(b) = b_session.as_deref() {
        row["after_product_teardown"] = pair(&browser, b, case).await;
    } else {
        row["after_product_teardown"] = json!({"a":document(&browser,None,&snapshot_expression(case)).await,
            "b":{"ok":false,"error":"owned B observer was not attached"}});
    }
    row["authorization_calls"] = json!(authority.calls.lock().unwrap().len());
    row["all_authorizations_bound_to_fixture"] = json!(
        authority
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|access| access.document().tab_id == browser.target)
    );
    if let Some(b) = b_session {
        row["cleanup"]["neutral_b_detach"] = read(
            &browser,
            None,
            "Target.detachFromTarget",
            json!({"sessionId":b}),
        )
        .await;
    }
    if let Some(b) = b_target {
        row["cleanup"]["neutral_b_close"] =
            read(&browser, None, "Target.closeTarget", json!({"targetId":b})).await;
    }
    let complete = row["measurement"]["ok"] == true && observations_complete(&row);
    row["phase"] = json!("post-product neutral snapshots retained; closing own Chrome last");
    save_pending(file, capture, &row);
    browser.close().await;
    row["owned_browser_closed"] = json!(true);
    row["completed"] = json!(complete);
    row["phase"] = json!("closed");
    capture["cases"].as_array_mut().unwrap().push(row);
    capture.as_object_mut().unwrap().remove("pending_case");
    save(file, capture);
}

async fn record_neutral_cases(cases: &[Case], kind: &str) {
    let path = PathBuf::from(
        std::env::var_os("MAKA_CUA_NEUTRAL_FOCUS_CAPTURE")
            .expect("fresh absolute owned capture required"),
    );
    assert!(path.is_absolute(), "capture path must be absolute");
    assert!(
        std::env::var("DISPLAY").is_ok_and(|value| !value.is_empty()),
        "private owned DISPLAY required"
    );
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("capture output must be fresh");
    let mut capture = json!({"kind":kind,"role":"candidate","completed":false,"cases":[],"declared_case_count":cases.len(),
        "product":"Current compiled Main candidate; Root retains exact source and ELF identities",
        "scope":"Declared independent fresh headed owned Chrome/profile scenes; one public locator.fill per scene; initial setup only activates exact owned A/B targets. No focus reset, emulation setter, sleep, RAF, injected backend or event normalization.",
        "teardown":"Keep neutral observer through Repl, Session and Driver close; observe surviving A+B before detaching B and closing the owned browser.",
        "completeness":"Transport, initial scene, exact owned document continuity, neutral observations and cleanup. Public errors and semantic controls remain raw observations, not whole-parity PASS.",
        "requested_chrome":std::env::var("MAKA_CUA_TEST_CHROME").unwrap(),"test_binary":std::env::current_exe().unwrap()});
    save(&mut file, &capture);
    for case in cases {
        record_case(&mut file, &mut capture, case).await;
    }
    let complete = capture["cases"].as_array().is_some_and(|rows| {
        rows.len() == cases.len()
            && rows
                .iter()
                .all(|row| row["completed"] == true && row["owned_browser_closed"] == true)
    });
    capture["completed"] = json!(complete);
    capture["observations_complete"] = json!(complete);
    capture["parity_claimed"] = json!(false);
    save(&mut file, &capture);
    assert!(
        complete,
        "neutral recorder incomplete; retained {}",
        path.display()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires fresh owned headed Chrome scene and MAKA_CUA_NEUTRAL_FOCUS_CAPTURE; records eight public locator fills"]
async fn public_locator_fill_records_background_focus_and_contenteditable_ranges() {
    record_neutral_cases(&CASES, "browser-neutral-focus-eight-case-capture").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires fresh owned headed Chrome scene and MAKA_CUA_NEUTRAL_FOCUS_CAPTURE; records three current active-recipient redirects"]
async fn public_locator_fill_records_redirected_active_recipients() {
    record_neutral_cases(
        &REDIRECT_CASES,
        "browser-neutral-focus-redirect-three-case-capture",
    )
    .await;
}
