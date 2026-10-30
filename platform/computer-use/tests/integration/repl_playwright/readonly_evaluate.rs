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

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; only a task-owned temporary headless browser profile"]
async fn public_readonly_evaluate_keeps_scope_redaction_and_never_replays_user_code() {
    let browser = Browser::open().await;
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
    .expect("create evaluate REPL");
    let actual = evaluate(&repl,bridge.clone(),&format!(r#"
        const evalBrowser=await cua.getBrowser({{id:'fixture'}});
        const evalTab=await evalBrowser.tabs.get({});const evalPage=evalTab.playwright;
        const page=await evalPage.evaluate(arg=>({{title:document.title,arg,cookie:document.cookie,
            global:typeof globalThis,fetch:typeof fetch,constructor:(()=>{{}}).constructor}}),{{number:7}});
        const single=await evalPage.locator('#hidden,#save').evaluate(element=>element.id);
        const all=await evalPage.locator('.read').evaluateAll((elements,suffix)=>elements.map(element=>element.textContent+suffix),'!');
        const secret=await evalPage.locator('#email').evaluate(element=>({{value:element.value,
            attribute:element.getAttribute('value'),html:element.outerHTML}}));
        let denied=false;try{{await evalPage.locator('#note').evaluate(element=>{{element.value='forbidden';}});}}catch{{denied=true;}}
        const repeated=await evalPage.locator('#save').evaluate(element=>({{id:element.id,parent:element.parentNode.nodeType}}));
        const remote=await evalPage.frameLocator('#remote').locator('button').evaluate(element=>element.textContent);
        nodeRepl.write({{page,single,all,secret,denied,repeated,remote}});
    "#,json!(browser.target))).await;
    assert_eq!(
        actual["page"],
        json!({"title":"Maka Playwright fixture","arg":{"number":7},"global":"undefined","fetch":"undefined"})
    );
    assert_eq!(actual["single"], "save");
    assert_eq!(actual["all"], json!(["First row!", "Second row!"]));
    assert_eq!(actual["secret"]["value"], "");
    assert_eq!(actual["secret"]["attribute"], Value::Null);
    assert!(
        !actual["secret"]["html"]
            .as_str()
            .expect("redacted HTML")
            .contains("fixture-email-secret")
    );
    assert_eq!(actual["denied"], true);
    assert_eq!(actual["repeated"]["id"], "save");
    assert_eq!(actual["remote"], "Remote action");
    assert_eq!(
        browser
            .inspect("document.querySelector('#note').value")
            .await,
        "ordinary note"
    );
    browser
        .inspect("document.body.style.minHeight='4000px';window.scrollTo(0,0);true")
        .await;
    let failure=evaluate(&repl,bridge.clone(),r#"
        let failed=false;try{await evalPage.locator('#note').evaluate(()=>{scrollBy(0,7);throw Error('known user-script failure');},undefined,{timeoutMs:500});}catch(error){failed=error.message.includes('known user-script failure');}
        nodeRepl.write({failed});
    "#).await;
    assert_eq!(failure["failed"], true);
    assert_eq!(
        browser.inspect("window.scrollY").await,
        7,
        "a failed user evaluation must not automatically execute again"
    );
    authority.allowed.store(false, Ordering::SeqCst);
    let denied=evaluate(&repl,bridge.clone(),r#"
        let denied=false;try{await evalPage.evaluate(()=>document.title);}catch(error){denied=error.message.includes('fixture site denied');}
        nodeRepl.write({denied});
    "#).await;
    assert_eq!(denied["denied"], true);
    repl.close().await.expect("close evaluate REPL");
    session
        .lock()
        .await
        .close()
        .await
        .expect("close evaluate Session");
    driver
        .lock()
        .await
        .close()
        .await
        .expect("close evaluate Driver");
    browser.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; verifies Stop after actual evaluation admission on its own profile"]
async fn stopped_evaluation_preserves_unknown_after_its_original_script_started() {
    use maka_computer_use::protocol::*;
    let browser = Browser::open().await;
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = browser.session(driver.clone());
    let context = InvocationContext::new("direct-evaluate-fixture", "fixture-turn")
        .with_browser_authorization(browser.authority());
    let bound = session
        .invoke(
            Command::BrowserTab {
                browser_id: "fixture".into(),
                reference: BrowserTabReference::Existing(browser.target.clone()),
            },
            &context,
            &CancellationToken::new(),
            Language::En,
        )
        .await
        .expect("bind evaluate fixture");
    let handle =
        serde_json::from_value::<Handle>(bound["handle"].clone()).expect("bound tab handle");
    browser
        .inspect("document.body.style.minHeight='4000px';window.scrollTo(0,0);true")
        .await;
    let cancellation = CancellationToken::new();
    let invoke = session.invoke(
        Command::BrowserEvaluate {
            handle,
            locator: None,
            mode: BrowserEvaluateMode::Page,
            script_json: serde_json::to_string(
                "scrollBy(0,11);await new Promise(resolve=>setTimeout(resolve,600));return 7;",
            )
            .expect("encode evaluate script"),
            options: BrowserEvaluateOptions {
                timeout_ms: Some(json!(2500)),
            },
        },
        &context,
        &cancellation,
        Language::En,
    );
    let stop = async {
        let observed = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if browser.inspect("window.scrollY").await == json!(11) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;
        observed.expect("the script must actually scroll before Stop is signaled");
        cancellation.cancel();
    };
    let (result, ()) = tokio::join!(invoke, stop);
    assert!(
        matches!(result,Err(ToolError::OutcomeUnknown(ref message)) if message.contains("after execution admission")),
        "Stop after actual script admission must not become an observational/no-effect result: {result:?}"
    );
    tokio::time::sleep(Duration::from_millis(700)).await;
    assert_eq!(
        browser.inspect("window.scrollY").await,
        11,
        "the original script must never be replayed"
    );
    session
        .close()
        .await
        .expect("close stopped evaluate Session");
    driver
        .lock()
        .await
        .close()
        .await
        .expect("close evaluate Driver");
    browser.close().await;
}
