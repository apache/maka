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

// This independently authored page observes input rather than implementing it.
const PAGE: &str = r##"<!doctype html><meta charset="utf-8"><title>Original browser write fixture CASE_TITLE</title>
<label for="entry">Message</label><input id="entry" value="seed"><output id="case">CASE_TITLE</output>
<script>
  window.__fixture = {caseId: CASE_JSON, events: []};
  const entry = document.querySelector('#entry');
  for (const name of ['focus','blur','paste','beforeinput','input','change','keydown','keyup','select','selectionchange']) {
    document.addEventListener(name, event => {
      if (event.target !== entry && name !== 'selectionchange') return;
      const row = {type:event.type, trusted:event.isTrusted, value:entry.value,
        selectionStart:entry.selectionStart, selectionEnd:entry.selectionEnd,
        key:event.key ?? null, code:event.code ?? null, inputType:event.inputType ?? null,
        data:event.data ?? null, defaultPrevented:event.defaultPrevented,
        ctrl:event.ctrlKey ?? false, meta:event.metaKey ?? false,
        clipboardTypes:event.clipboardData ? Array.from(event.clipboardData.types) : null,
        clipboardText:event.clipboardData ? event.clipboardData.getData('text/plain') : null};
      window.__fixture.events.push(row);
      queueMicrotask(() => { row.defaultPreventedAfterDispatch=event.defaultPrevented; row.valueAfterDispatch=entry.value; });
    }, true);
  }
  if (CASE_JSON === 'prevent-paste') entry.addEventListener('paste', event => event.preventDefault());
</script>"##;

const CASES: [(&str, &str, &str); 5] = [
    ("fill-empty", "fill", ""),
    ("fill-text", "fill", "alpha Å🙂"),
    ("type-text", "type", "β🙂"),
    ("type-empty", "type", ""),
    ("prevent-paste", "fill", "blocked"),
];

pub(super) fn fixture_html(case: &str) -> String {
    // Only fixture-owned case names are interpolated into HTML text.
    assert!(CASES.iter().any(|(id, _, _)| *id == case));
    PAGE.replace("CASE_TITLE", case)
        .replace("CASE_JSON", &json!(case).to_string())
}

fn save_capture(file: &mut File, capture: &Value) {
    let bytes = serde_json::to_vec_pretty(capture).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    file.set_len(0).unwrap();
    file.write_all(&bytes).unwrap();
    file.write_all(b"\n").unwrap();
    file.sync_all().unwrap();
}

const SNAPSHOT: &str = r##"(() => ({caseId:window.__fixture.caseId,
  value:document.querySelector('#entry').value,activeElementId:document.activeElement?.id??null,
  selectionStart:document.querySelector('#entry').selectionStart,
  selectionEnd:document.querySelector('#entry').selectionEnd,
  events:structuredClone(window.__fixture.events)}))()"##;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires owned MAKA_CUA_TEST_CHROME, private DISPLAY and fresh absolute MAKA_CUA_TEXT_EVENT_CAPTURE; records actual public fill/type DOM events"]
async fn public_locator_text_mutations_record_values_selection_and_dom_events() {
    let path = PathBuf::from(
        std::env::var_os("MAKA_CUA_TEXT_EVENT_CAPTURE")
            .expect("MAKA_CUA_TEXT_EVENT_CAPTURE must name a fresh task-owned JSON output file"),
    );
    assert!(path.is_absolute(), "capture path must be absolute");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("capture output must be fresh and its parent must exist");
    let mut capture = json!({
        "kind":"browser-locator-text-event-capture","role":"candidate","completed":false,
        "cases":[],"fixture_html_sha256":{},
        "observation_timing":"Fresh document per case; no input preparation; independent snapshot immediately after awaited public operation; no extra sleep or RAF",
        "environment":{"headless":false,"desktop":"caller-provided task-owned DISPLAY","chrome":std::env::var("MAKA_CUA_TEST_CHROME").unwrap()},
        "comparison_scope":"Records values, UTF-16 selection offsets, full event order and every raw event field; does not impose expected locator text/event semantics"
    });
    save_capture(&mut file, &capture);
    assert!(
        std::env::var("DISPLAY").is_ok_and(|display| !display.is_empty()),
        "recorder requires the task's private display"
    );
    let browser = Browser::open_with_headless(false).await;
    capture["browser_version"] = browser
        .observer
        .call(None, "Browser.getVersion", json!({}))
        .await
        .unwrap();
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
    )
    .unwrap();
    capture["binding"] = evaluate(
        &repl,
        bridge.clone(),
        &format!(
            "const textEventBrowser=await cua.getBrowser({{id:'fixture'}});const textEventTab=await textEventBrowser.tabs.get({});nodeRepl.write({{bound:true}});",
            json!(browser.target)
        ),
    )
    .await;
    save_capture(&mut file, &capture);
    for (id, method, value) in CASES {
        let url = format!("{}case?case={id}", browser.url);
        capture["fixture_html_sha256"][id] =
            json!(hex::encode(Sha256::digest(fixture_html(id).as_bytes())));
        evaluate(
            &repl,
            bridge.clone(),
            &format!(
                "await textEventTab.goto({});nodeRepl.write({{navigated:true}});",
                json!(url)
            ),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if browser
                    .inspect(&format!("window.__fixture?.caseId==={}", json!(id)))
                    .await
                    == true
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let before = browser.inspect(SNAPSHOT).await;
        let mut row = json!({"id":id,"method":method,"value":value,"url":url,"before":before});
        capture["pending_case"] = row.clone();
        save_capture(&mut file, &capture);
        assert_eq!(
            before,
            json!({"caseId":id,"value":"seed","activeElementId":"","selectionStart":0,"selectionEnd":0,"events":[]}),
            "fresh fixture must have the same unprepared input state"
        );
        let source = format!(
            "{{try{{const result=await textEventTab.playwright.locator('#entry').{method}({});nodeRepl.write({{ok:true,type:typeof result,isUndefined:result===undefined}});}}catch(error){{nodeRepl.write({{ok:false,name:error.name,error:String(error)}});}}}}",
            json!(value)
        );
        let result = evaluate(&repl, bridge.clone(), &source).await;
        // Read immediately; do not drain or normalize queued select events.
        let after = browser.inspect(SNAPSHOT).await;
        row["result"] = result;
        row["after"] = after;
        row["code"] = json!(source);
        capture["cases"].as_array_mut().unwrap().push(row);
        capture.as_object_mut().unwrap().remove("pending_case");
        save_capture(&mut file, &capture);
    }
    repl.close().await.unwrap();
    session.lock().await.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    let rows = capture["cases"].as_array().unwrap();
    let calls_succeeded = rows.len() == CASES.len()
        && rows
            .iter()
            .all(|row| row["result"]["ok"] == true && row["result"]["isUndefined"] == true);
    capture["all_calls_succeeded"] = json!(calls_succeeded);
    capture["authorization_calls"] = json!(authority.calls.lock().unwrap().len());
    capture["all_authorizations_bound_to_fixture"] = json!(
        authority
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|access| access.document().tab_id == browser.target)
    );
    browser.close().await;
    capture["owned_browser_closed"] = json!(true);
    capture["completed"] = json!(calls_succeeded);
    save_capture(&mut file, &capture);
    assert!(
        calls_succeeded,
        "public operation failed; retained {}",
        path.display()
    );
}
