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

//! Observe the endpoint of one public locator prefix without changing its inputs.

use super::{mutations::*, *};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::PathBuf,
    time::Instant,
};

// These listeners only observe our own documents. They never intercept or
// replace input, focus, scrolling, native browser methods, or public commands.
const INSTALL_OBSERVER: &str = r#"function installOwnObserver(view) {
  view.ownPrefixEvents = [];
  const record = event => {
    const target = event.target;
    view.ownPrefixEvents.push({type:event.type,timeStamp:event.timeStamp,
      observedAt:view.performance.now(),timeOrigin:view.performance.timeOrigin,trusted:event.isTrusted,
      target:{tag:target?.localName??null,id:target?.id??null},
      scrollX:view.scrollX,scrollY:view.scrollY,
      clientX:event.clientX??null,clientY:event.clientY??null,
      pageX:event.pageX??null,pageY:event.pageY??null,
      screenX:event.screenX??null,screenY:event.screenY??null,
      button:event.button??null,buttons:event.buttons??null,detail:event.detail??null,
      ctrl:event.ctrlKey??null,meta:event.metaKey??null,shift:event.shiftKey??null,alt:event.altKey??null,
      path:event.composedPath().map(node=>({tag:node.localName??null,id:node.id??null}))});
  };
  view.addEventListener('scroll',record,{capture:true,passive:true});
  for (const name of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','focus','blur','focusin','focusout'])
    view.document.addEventListener(name,record,{capture:true,passive:true});
  return true;
}"#;

// A window argument matters for the same-renderer local frame: all dimensions,
// styles, focus, fonts and event clocks belong to that document's own realm.
const DOCUMENT_SNAPSHOT: &str = r#"function snapshotOwnDocument(view) {
  const startedAt=view.performance.now(),doc=view.document;
  const rect = node => {
    if (!node) return null;
    const r=node.getBoundingClientRect();
    return {x:r.x,y:r.y,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};
  };
  const element = node => {
    if (!node) return null;
    const s=view.getComputedStyle(node);
    return {tag:node.localName,id:node.id,rect:rect(node),
      scrollLeft:node.scrollLeft,scrollTop:node.scrollTop,
      clientLeft:node.clientLeft,clientTop:node.clientTop,
      clientWidth:node.clientWidth,clientHeight:node.clientHeight,
      offsetLeft:node.offsetLeft??null,offsetTop:node.offsetTop??null,
      offsetWidth:node.offsetWidth??null,offsetHeight:node.offsetHeight??null,
      scrollWidth:node.scrollWidth,scrollHeight:node.scrollHeight,
      scrollRangeWidth:Math.max(0,node.scrollWidth-node.clientWidth),
      scrollRangeHeight:Math.max(0,node.scrollHeight-node.clientHeight),
      style:{overflowX:s.overflowX,overflowY:s.overflowY,scrollbarGutter:s.scrollbarGutter,
        direction:s.direction,scrollBehavior:s.scrollBehavior,overflowAnchor:s.overflowAnchor,
        zoom:s.zoom,font:s.font,fontFamily:s.fontFamily,fontSize:s.fontSize,
        paddingLeft:s.paddingLeft,paddingTop:s.paddingTop,paddingRight:s.paddingRight,paddingBottom:s.paddingBottom,
        borderLeftWidth:s.borderLeftWidth,borderTopWidth:s.borderTopWidth,
        borderRightWidth:s.borderRightWidth,borderBottomWidth:s.borderBottomWidth,transform:s.transform}};
  };
  const active=[];
  for (let node=doc.activeElement;node;node=node.shadowRoot?.activeElement??null)
    active.push({tag:node.localName,id:node.id});
  const viewport=view.visualViewport;
  const text=doc.querySelector('#m-text'),section=doc.querySelector('#mutation-fixture');
  return {startedAt,timeOrigin:view.performance.timeOrigin,url:view.location.href,
    readyState:doc.readyState,hasFocus:doc.hasFocus(),visibilityState:doc.visibilityState,activeElements:active,
    scrollX:view.scrollX,scrollY:view.scrollY,innerWidth:view.innerWidth,innerHeight:view.innerHeight,
    outerWidth:view.outerWidth,outerHeight:view.outerHeight,devicePixelRatio:view.devicePixelRatio,
    visualViewport:viewport?{offsetLeft:viewport.offsetLeft,offsetTop:viewport.offsetTop,
      pageLeft:viewport.pageLeft,pageTop:viewport.pageTop,width:viewport.width,height:viewport.height,scale:viewport.scale}:null,
    fontsStatus:doc.fonts?.status??null,
    html:element(doc.documentElement),body:element(doc.body),scrollingElement:element(doc.scrollingElement),
    frames:Array.from(doc.querySelectorAll('iframe,frame'),node=>({...element(node),src:node.src,name:node.name})),
    button:element(doc.querySelector('button')),ownMutationClicks:view.ownMutationClicks??null,
    mutationOracle:view.mutationOracle?structuredClone(view.mutationOracle):null,
    values:section?{text:text?.value??null,selectionStart:text?.selectionStart??null,selectionEnd:text?.selectionEnd??null,
      checked:doc.querySelector('#m-check').checked,radio:doc.querySelector('#m-radio').checked,
      blocked:doc.querySelector('#m-blocked').checked,selected:doc.querySelector('#m-select').value,
      multiple:Array.from(doc.querySelector('#m-multiple').selectedOptions,node=>node.value)}:null,
    events:structuredClone(view.ownPrefixEvents??null),ownedDocumentHtml:doc.documentElement.outerHTML,
    endedAt:view.performance.now()};
}"#;

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn save_capture(file: &mut File, capture: &Value) {
    let bytes = serde_json::to_vec_pretty(capture).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    file.set_len(0).unwrap();
    file.write_all(&bytes).unwrap();
    file.write_all(b"\n").unwrap();
    file.sync_all().unwrap();
}

async fn cdp_read(browser: &Browser, session: Option<&str>, method: &str, input: Value) -> Value {
    match browser.observer.call(session, method, input).await {
        Ok(value) => json!({"ok":true,"value":value}),
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    }
}

async fn document_read(browser: &Browser, session: Option<&str>, window: &str) -> Value {
    let result = cdp_read(
        browser,
        session,
        "Runtime.evaluate",
        json!({"expression":format!("({DOCUMENT_SNAPSHOT})({window})"),
            "returnByValue":true,"awaitPromise":true}),
    )
    .await;
    if result["ok"] == true && result["value"].get("exceptionDetails").is_none() {
        json!({"ok":true,"value":result["value"]["result"]["value"]})
    } else {
        json!({"ok":false,"raw":result})
    }
}

async fn snapshot(browser: &Browser, remote: &str, nested: &str) -> Value {
    // Root DOM comes first, immediately after the awaited cell. No filesystem
    // save, version query or layout stabilization is inserted before this read.
    let root = document_read(browser, None, "window").await;
    let metrics = cdp_read(browser, None, "Page.getLayoutMetrics", json!({})).await;
    let local = document_read(
        browser,
        None,
        "document.querySelector('#local').contentWindow",
    )
    .await;
    let child = document_read(browser, Some(remote), "window").await;
    let inner = document_read(browser, Some(nested), "window").await;
    let root_tree = cdp_read(browser, None, "Page.getFrameTree", json!({})).await;
    let child_tree = cdp_read(browser, Some(remote), "Page.getFrameTree", json!({})).await;
    let inner_tree = cdp_read(browser, Some(nested), "Page.getFrameTree", json!({})).await;
    let frame_id = child_tree["value"]["frameTree"]["frame"]["id"].as_str();
    let mut geometry = json!({"parent_session":null,"css_domain":"root renderer; independent after/before observation"});
    if let Some(frame_id) = frame_id {
        geometry["owner"] = cdp_read(
            browser,
            None,
            "DOM.getFrameOwner",
            json!({"frameId":frame_id}),
        )
        .await;
        if let Some(backend) = geometry["owner"]["value"]["backendNodeId"].as_u64() {
            geometry["quads"] = cdp_read(
                browser,
                None,
                "DOM.getContentQuads",
                json!({"backendNodeId":backend}),
            )
            .await;
            geometry["box_model"] = cdp_read(
                browser,
                None,
                "DOM.getBoxModel",
                json!({"backendNodeId":backend}),
            )
            .await;
        }
    }
    json!({"root":root,"root_layout_metrics":metrics,"local":local,"remote":child,"nested":inner,
        "root_frame_tree":root_tree,"remote_frame_tree":child_tree,"nested_frame_tree":inner_tree,
        "remote_owner_geometry":geometry,
        "contexts":{"root":{"observer_session":null,"window":"window"},
            "local":{"observer_session":null,"window":"document.querySelector('#local').contentWindow"},
            "remote":{"observer_session":remote,"window":"window"},
            "nested":{"observer_session":nested,"window":"window"}},
        "order":["root DOM","root Page.getLayoutMetrics","same-renderer local DOM","remote DOM","nested DOM","root frame tree","remote frame tree","nested frame tree","remote owner/quads/box model"],
        "timing":"Sequential instrumented presentation snapshots, not atomic or a historical input/guard trace. Layout reads can flush layout. Per-document clocks are not treated as one global event order. Event coordinates belong to the event document; no post-snapshot point is called the dispatch point."})
}

fn own_process_metadata(browser: &Browser) -> Value {
    let Some(pid) = browser.chrome.id() else {
        return json!({"ok":false,"error":"owned child has no live process id"});
    };
    let base = PathBuf::from(format!("/proc/{pid}"));
    let raw = |name: &str| match std::fs::read(base.join(name)) {
        Ok(bytes) => json!({"ok":true,"bytes":bytes,"sha256":digest(&bytes)}),
        Err(error) => json!({"ok":false,"error":error.to_string()}),
    };
    json!({"owned_child_pid":pid,
        "provenance":"PID comes only from this fixture's retained tokio Child; raw proc bytes are not shell-parsed or inferred from requested flags",
        "cmdline":raw("cmdline"),"status":raw("status"),"stat":raw("stat"),
        "exe":match std::fs::read_link(base.join("exe")) {
            Ok(path)=>json!({"ok":true,"value":path}),
            Err(error)=>json!({"ok":false,"error":error.to_string()})}})
}

async fn fixture_responses(browser: &Browser) -> Value {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let root = reqwest::Url::parse(&browser.url).unwrap();
    let mut responses = Vec::new();
    for (path, remote) in [
        ("/", false),
        ("/frame/local", false),
        ("/frame/remote", true),
        ("/frame/nested", false),
    ] {
        let mut url = root.join(path).unwrap();
        if remote {
            url.set_host(Some("localhost")).unwrap();
        }
        let response = match client.get(url.clone()).send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                match response.bytes().await {
                    Ok(bytes) => json!({"ok":true,"url":url.as_str(),"status":status,
                        "sha256":digest(&bytes),"body":String::from_utf8_lossy(&bytes)}),
                    Err(error) => json!({"ok":false,"url":url.as_str(),"error":error.to_string()}),
                }
            }
            Err(error) => json!({"ok":false,"url":url.as_str(),"error":error.to_string()}),
        };
        responses.push(response);
    }
    json!({"provenance":"Separate premeasurement GETs to this unchanged task-owned fixture server; exact bytes returned by these GETs, not a retroactive capture of the navigation response", "responses":responses})
}

fn prefix_source(target: &str) -> String {
    // Exactly the existing keeper's 17 operations followed by its remote click;
    // the next nested/negative/cache/clipboard operations are intentionally absent.
    format!(
        r#"
      const mutationBrowser=await cua.getBrowser({{id:'fixture'}});
      const mutationTab=await mutationBrowser.tabs.get({});const mp=mutationTab.playwright;
      const mutationReturns={{}};
      async function mutationCall(name,action){{mutationReturns[name]=typeof(await action());}}
      await mutationCall('click',()=>mp.locator('#m-click').click());
      await mutationCall('dblclick',()=>mp.locator('#m-click').dblclick());
      await mutationCall('fill',()=>mp.locator('#m-text').fill('replaced'));
      await mutationCall('type',()=>mp.locator('#m-text').type(' appended'));
      await mutationCall('press',()=>mp.locator('#m-text').press('End'));
      await mutationCall('sequential',()=>mp.locator('#m-text').pressSequentially('你🙂é'));
      await mutationCall('selectOption',()=>mp.locator('#m-select').selectOption({{label:'Label B'}}));
      await mp.locator('#m-select').selectOption({{value:'c'}});
      await mp.locator('#m-select').selectOption({{index:0}});
      await mp.locator('#m-multiple').selectOption(['a','c']);
      await mutationCall('setChecked',()=>mp.locator('#m-check').setChecked(true));
      await mp.locator('#m-check').setChecked(true);
      await mutationCall('uncheck',()=>mp.locator('#m-check').uncheck());
      await mutationCall('check',()=>mp.locator('#m-check').check());
      await mp.locator('#m-hidden,#m-visible').click();
      await mp.getByRole('button',{{name:'Mutation shadow',exact:true}}).click();
      await mp.frameLocator('#local').getByRole('button').click();
      await mp.frameLocator('#remote').getByRole('button',{{name:'Remote action',exact:true}}).click();
      nodeRepl.write({{returns:mutationReturns}});
    "#,
        json!(target)
    )
}

fn verify_positive_controls(capture: &Value) -> bool {
    let root = &capture["after"]["root"]["value"];
    let oracle = &root["mutationOracle"];
    let returns = &capture["public_output"]["returns"];
    capture["cell_result"]["ok"] == true
        && [
            "click",
            "dblclick",
            "fill",
            "type",
            "press",
            "sequential",
            "selectOption",
            "setChecked",
            "uncheck",
            "check",
        ]
        .iter()
        .all(|name| returns[*name] == "undefined")
        && root["values"]
            == json!({"text":"replaced appended你🙂é","selectionStart":21,"selectionEnd":21,
                "checked":true,"radio":true,"blocked":false,"selected":"a","multiple":["a","c"]})
        && [
            ("clicks", 3),
            ("doubles", 1),
            ("checkboxClicks", 3),
            ("blockedClicks", 0),
            ("visibleClicks", 1),
            ("shadowClicks", 1),
        ]
        .iter()
        .all(|(field, expected)| oracle[*field] == *expected)
        && capture["after"]["local"]["value"]["ownMutationClicks"] == 1
        && capture["after"]["remote"]["value"]["ownMutationClicks"] == 1
        && capture["after"]["nested"]["value"]["ownMutationClicks"] == 0
}

fn verify_measurements(capture: &Value) -> bool {
    for phase in ["before", "after"] {
        let snapshot = &capture[phase];
        for frame in ["root", "local", "remote", "nested"] {
            let row = &snapshot[frame];
            if row["ok"] != true
                || !row["value"]["scrollingElement"].is_object()
                || !row["value"]["events"].is_array()
            {
                return false;
            }
        }
        let metrics = &snapshot["root_layout_metrics"]["value"];
        let geometry = &snapshot["remote_owner_geometry"];
        if snapshot["root_layout_metrics"]["ok"] != true
            || !metrics["cssLayoutViewport"].is_object()
            || !metrics["cssVisualViewport"].is_object()
            || geometry["owner"]["ok"] != true
            || geometry["quads"]["ok"] != true
            || geometry["box_model"]["ok"] != true
        {
            return false;
        }
    }
    for key in ["root_frame_tree", "remote_frame_tree", "nested_frame_tree"] {
        let before = &capture["before"][key]["value"]["frameTree"]["frame"];
        let after = &capture["after"][key]["value"]["frameTree"]["frame"];
        for field in ["id", "loaderId", "url"] {
            if !before[field]
                .as_str()
                .is_some_and(|value| !value.is_empty())
                || before[field] != after[field]
            {
                return false;
            }
        }
    }
    true
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires owned MAKA_CUA_TEST_CHROME and fresh absolute MAKA_CUA_PREFIX_CAPTURE; records the public 18-operation prefix without changing scroll state"]
async fn public_locator_prefix_records_scroll_and_dom_events() {
    let path = PathBuf::from(
        std::env::var_os("MAKA_CUA_PREFIX_CAPTURE")
            .expect("MAKA_CUA_PREFIX_CAPTURE must name a fresh task-owned output file"),
    );
    assert!(path.is_absolute(), "capture path must be absolute");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .expect("capture output must be fresh and its parent must exist");
    let mut capture = json!({"kind":"browser-locator-prefix-scroll-capture","role":"candidate",
        "completed":false,"phase":"before owned browser launch","requested_headless":true,
        "semantic_locator_operations":18,
        "operation_order":["click","dblclick","fill","type","press End","pressSequentially",
            "selectOption label","selectOption value","selectOption index","selectOption multiple",
            "setChecked true","setChecked true again","uncheck","check","visible fallback click",
            "shadow click","local frame click","remote frame click"],
        "executables":{"requested_chrome":std::env::var("MAKA_CUA_TEST_CHROME").unwrap(),
            "test_binary":std::env::current_exe().unwrap(),
            "identity_provenance":"The private runner hashes this retained ELF and Chrome before and after the subject; this capture independently records actual version and owned process metadata."},
        "scope":"One unmodified single-cell prefix; no scroll reset, intermediate input/read/cell, sleep, RAF, font wait or extra backend. Before/after net state does not identify which action caused a scroll.",
        "fixture_setup_sha256":digest(FIXTURE.as_bytes()),
        "observer_sha256":digest(INSTALL_OBSERVER.as_bytes()),"snapshot_sha256":digest(DOCUMENT_SNAPSHOT.as_bytes())});
    save_capture(&mut file, &capture);
    let browser = Browser::open().await;
    capture["phase"] = json!("owned browser launched; fixture setup pending");
    capture["browser_version"] = cdp_read(&browser, None, "Browser.getVersion", json!({})).await;
    capture["observed_browser_command_line"] =
        cdp_read(&browser, None, "Browser.getBrowserCommandLine", json!({})).await;
    capture["own_process"] = own_process_metadata(&browser);
    capture["fixture_responses"] = fixture_responses(&browser).await;
    save_capture(&mut file, &capture);
    assert_eq!(browser.inspect(FIXTURE).await, true);
    let remote = attach_fixture_frame(&browser, "/frame/remote").await;
    let nested = attach_fixture_frame(&browser, "/frame/nested").await;
    let frame_setup = "globalThis.ownMutationClicks=0;document.querySelector('button').addEventListener('click',()=>globalThis.ownMutationClicks++);true";
    assert_eq!(observe(&browser, Some(&remote), frame_setup).await, true);
    assert_eq!(observe(&browser, Some(&nested), frame_setup).await, true);
    assert_eq!(browser.inspect("const d=document.querySelector('#local').contentDocument;d.defaultView.ownMutationClicks=0;d.querySelector('button').addEventListener('click',()=>d.defaultView.ownMutationClicks++);true").await,true);
    for (session, window) in [
        (None, "window"),
        (None, "document.querySelector('#local').contentWindow"),
        (Some(remote.as_str()), "window"),
        (Some(nested.as_str()), "window"),
    ] {
        assert_eq!(
            observe(
                &browser,
                session,
                &format!("({INSTALL_OBSERVER})({window})")
            )
            .await,
            true
        );
    }
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
    let source = prefix_source(&browser.target);
    let context = CellContext::new(CellStore::temporary().unwrap(), vec![]).unwrap();
    capture["source"] = json!(source);
    capture["source_sha256"] = json!(digest(source.as_bytes()));
    capture["before"] = snapshot(&browser, &remote, &nested).await;
    capture["phase"] = json!("before single prefix cell");
    save_capture(&mut file, &capture);
    let started = Instant::now();
    let result = repl
        .evaluate(
            source,
            bridge,
            CancellationToken::new(),
            context.clone(),
            Duration::from_secs(20),
        )
        .await;
    let elapsed = started.elapsed();
    // Even a failed public call is followed by an independent snapshot before
    // any assertion, filesystem write or diagnostic metadata request.
    let after = snapshot(&browser, &remote, &nested).await;
    capture["after"] = after;
    capture["cell_seconds"] = json!(elapsed.as_secs_f64());
    capture["cell_result"] = match result {
        Ok(result) => serde_json::to_value(result).unwrap(),
        Err(error) => json!({"ok":false,"abort":format!("{error:?}")}),
    };
    let output = context.take_output();
    capture["public_output"] = output
        .iter()
        .rev()
        .find_map(|output| match output {
            CellOutput::Text { text } => serde_json::from_str(text).ok(),
            _ => None,
        })
        .unwrap_or(Value::Null);
    capture["output"] = serde_json::to_value(output).unwrap();
    capture["phase"] = json!("prefix result and independent after snapshot retained");
    capture["positive_controls_verified"] = json!(verify_positive_controls(&capture));
    capture["measurements_verified"] = json!(verify_measurements(&capture));
    save_capture(&mut file, &capture);
    let repl_closed = repl.close().await;
    let session_closed = session.lock().await.close().await;
    let driver_closed = driver.lock().await.close().await;
    let mut detachments = Vec::new();
    for frame in [&remote, &nested] {
        let result = cdp_read(
            &browser,
            None,
            "Target.detachFromTarget",
            json!({"sessionId":frame}),
        )
        .await;
        detachments.push(json!({"observer_session":frame,"result":result}));
    }
    let detached = detachments.iter().all(|row| row["result"]["ok"] == true);
    capture["observer_detachments"] = json!(detachments);
    capture["authorization_calls"] = json!(authority.calls.lock().unwrap().len());
    capture["all_authorizations_bound_to_fixture"] = json!(
        authority
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|access| access.document().tab_id == browser.target)
    );
    capture["phase"] = json!("closing owned browser");
    capture["repl_close"] = json!(format!("{repl_closed:?}"));
    capture["session_close"] = json!(format!("{session_closed:?}"));
    capture["driver_close"] = json!(format!("{driver_closed:?}"));
    save_capture(&mut file, &capture);
    browser.close().await;
    capture["owned_browser_closed"] = json!(true);
    let complete = capture["positive_controls_verified"] == true
        && capture["measurements_verified"] == true
        && capture["authorization_calls"]
            .as_u64()
            .is_some_and(|calls| calls > 0)
        && capture["all_authorizations_bound_to_fixture"] == true
        && repl_closed.is_ok()
        && session_closed.is_ok()
        && driver_closed.is_ok()
        && detached;
    capture["completed"] = json!(complete);
    capture["phase"] = json!("closed");
    save_capture(&mut file, &capture);
    assert!(
        complete,
        "prefix recorder failed; retained {}",
        path.display()
    );
}
