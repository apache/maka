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
use maka_computer_use::{
    BrowserAttachmentAuthorization, BrowserAttachmentOrigin, BrowserHostEffects, HostEffectFuture,
};

#[derive(Clone)]
struct ClipboardAuthority(Arc<SiteAuthority>);

impl BrowserAuthorization for ClipboardAuthority {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        self.0.authorize(access, cancellation)
    }

    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture {
        BrowserAuthorization::check(self.0.as_ref(), access, cancellation)
    }

    fn attachment(&self) -> Option<Arc<dyn BrowserAttachmentAuthorization>> {
        Some(Arc::new(self.clone()))
    }
}

impl BrowserAttachmentAuthorization for ClipboardAuthority {
    fn check(
        &self,
        origin: BrowserAttachmentOrigin,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let authority = self.0.clone();
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(ToolError::Failed(
                    "clipboard fixture attachment ended".into(),
                ));
            }
            match origin {
                BrowserAttachmentOrigin::Site(origin)
                    if authority.allowed.load(Ordering::SeqCst) && origin == authority.origin =>
                {
                    Ok(())
                }
                _ => Err(ToolError::Failed(
                    "clipboard fixture current origin denied".into(),
                )),
            }
        })
    }
}

#[derive(Default)]
struct ClipboardEffects {
    tasks: StdMutex<Vec<tokio::task::JoinHandle<Result<(), ToolError>>>>,
}

impl BrowserHostEffects for ClipboardEffects {
    fn spawn(&self, unpolled: HostEffectFuture) -> Result<(), ToolError> {
        self.tasks.lock().unwrap().push(tokio::spawn(unpolled));
        Ok(())
    }
}

impl ClipboardEffects {
    async fn join(&self) {
        loop {
            let tasks = std::mem::take(&mut *self.tasks.lock().unwrap());
            if tasks.is_empty() {
                break;
            }
            for task in tasks {
                task.await.unwrap().unwrap();
            }
        }
    }
}

struct ClipboardBridge {
    session: Arc<Mutex<Session>>,
    authority: Arc<ClipboardAuthority>,
    effects: Arc<ClipboardEffects>,
}

impl ToolExecutor for ClipboardBridge {
    fn names(&self) -> Vec<String> {
        vec!["cua".into()]
    }

    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let session = self.session.clone();
        let authority = self.authority.clone();
        let effects = self.effects.clone();
        Box::pin(async move {
            let command = serde_json::from_value(input)
                .map_err(|error| ToolError::Failed(error.to_string()))?;
            session
                .lock()
                .await
                .invoke(
                    command,
                    &InvocationContext::new("playwright-fixture", "fixture-turn")
                        .with_browser_authorization(authority)
                        .with_browser_host_effects(effects),
                    &cancellation,
                    Language::En,
                )
                .await
        })
    }
}
pub(super) async fn observe(browser: &Browser, session: Option<&str>, expression: &str) -> Value {
    let reply = browser
        .observer
        .call(
            session,
            "Runtime.evaluate",
            json!({
                "expression":expression,"returnByValue":true,"awaitPromise":true
            }),
        )
        .await
        .unwrap();
    assert!(reply.get("exceptionDetails").is_none(), "{reply}");
    reply["result"]["value"].clone()
}

pub(super) async fn attach_fixture_frame(browser: &Browser, suffix: &str) -> String {
    let targets = browser
        .observer
        .call(None, "Target.getTargets", json!({}))
        .await
        .unwrap();
    let matches: Vec<_> = targets["targetInfos"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|target| {
            target["type"] == "iframe"
                && target["url"]
                    .as_str()
                    .is_some_and(|url| url.ends_with(suffix))
        })
        .collect();
    assert_eq!(
        matches.len(),
        1,
        "one owned OOPIF must match {suffix}: {targets}"
    );
    let reply = browser
        .observer
        .call(
            None,
            "Target.attachToTarget",
            json!({
                "targetId":matches[0]["targetId"],"flatten":true
            }),
        )
        .await
        .unwrap();
    reply["sessionId"].as_str().unwrap().to_owned()
}

pub(super) const FIXTURE: &str = r#"(() => {
    const section=document.createElement('section');section.id='mutation-fixture';
    section.innerHTML=`<button id="m-click">Activate</button>
      <button id="m-hidden" style="display:none">Unique mutate</button><button id="m-visible">Unique mutate</button>
      <button class="m-ambiguous">Ambiguous mutation</button><button class="m-ambiguous">Ambiguous mutation</button>
      <label>Mutation notes<input id="m-text" value="seed"></label>
      <input id="m-check" type="checkbox"><input id="m-radio" type="radio" checked>
      <input id="m-blocked" type="checkbox"><input id="m-sequential"><input id="m-other">
      <select id="m-select"><option value="a">Label A</option><option value="b">Label B</option><option value="c">Label C</option></select>
      <select id="m-multiple" multiple><option value="a">Label A</option><option value="b">Label B</option><option value="c">Label C</option></select>
      <div class="m-row"><span class="m-value">Before</span><button>Change row</button></div>
      <div class="m-row"><span class="m-value">Second</span><button>Change row</button></div>
      <div id="m-shadow"></div>`;
    document.body.prepend(section);
    globalThis.mutationOracle={events:[],clicks:0,doubles:0,checkboxClicks:0,blockedClicks:0,visibleClicks:0,sequentialInputs:0,lateInputs:0,sealed:false,mode:''};
    const oracle=globalThis.mutationOracle;
    for(const kind of ['click','dblclick','input','change','keydown','keyup']) section.addEventListener(kind,event=>{
      oracle.events.push({kind,id:event.target.id,key:event.key??null,data:event.data??null,trusted:event.isTrusted,
        value:event.target.value??null,checked:event.target.checked??null});
      if(kind==='input'&&event.target.id==='m-sequential') {
        oracle.sequentialInputs++;
        if(oracle.sealed)oracle.lateInputs++;
        if(oracle.mode==='lose-focus')document.querySelector('#m-other').focus();
      }
    });
    document.querySelector('#m-click').addEventListener('click',()=>oracle.clicks++);
    document.querySelector('#m-click').addEventListener('dblclick',()=>oracle.doubles++);
    document.querySelector('#m-visible').addEventListener('click',()=>oracle.visibleClicks++);
    document.querySelector('#m-check').addEventListener('click',()=>oracle.checkboxClicks++);
    document.querySelector('#m-blocked').addEventListener('click',event=>{oracle.blockedClicks++;event.preventDefault()});
    section.querySelector('.m-row button').addEventListener('click',()=>section.querySelector('.m-value').textContent='By own mutation');
    const shadow=document.querySelector('#m-shadow').attachShadow({mode:'open'});
    shadow.innerHTML='<button id="m-shadow-button">Mutation shadow</button>';
    shadow.querySelector('button').onclick=()=>oracle.shadowClicks=(oracle.shadowClicks??0)+1;
    return true;
})()"#;

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; verifies public locator mutations in its own temporary Chrome profile"]
async fn public_locator_mutations_have_independent_events_frames_and_cache_oracles() {
    let browser = Browser::open().await;
    assert_eq!(browser.inspect(FIXTURE).await, true);
    let remote = attach_fixture_frame(&browser, "/frame/remote").await;
    let nested = attach_fixture_frame(&browser, "/frame/nested").await;
    let frame_setup = "globalThis.ownMutationClicks=0;document.querySelector('button').addEventListener('click',()=>globalThis.ownMutationClicks++);true";
    assert_eq!(observe(&browser, Some(&remote), frame_setup).await, true);
    assert_eq!(observe(&browser, Some(&nested), frame_setup).await, true);
    assert_eq!(browser.inspect("const d=document.querySelector('#local').contentDocument;d.defaultView.ownMutationClicks=0;d.querySelector('button').addEventListener('click',()=>d.defaultView.ownMutationClicks++);true").await, true);
    let driver = Arc::new(Mutex::new(Driver::default()));
    let session = Arc::new(Mutex::new(browser.session(driver.clone())));
    let bridge = Arc::new(Bridge {
        session: session.clone(),
        authority: browser.authority(),
    });
    let repl = Repl::new(
        facade(),
        CellLimits {
            heap_bytes: 128 * 1024 * 1024,
            ..Default::default()
        },
    )
    .unwrap();
    let result = evaluate(&repl, bridge.clone(), &format!(r#"
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

      await mp.frameLocator('#remote').frameLocator('#nested').getByRole('button').click();
      const mutationErrors={{}};
      for(const [name,action] of [
        ['strict',()=>mp.locator('.m-ambiguous').click()],
        ['radio',()=>mp.locator('#m-radio').uncheck()],
        ['blocked',()=>mp.locator('#m-blocked').check()]
      ]){{try{{await action();mutationErrors[name]=null;}}catch(error){{mutationErrors[name]=error.message;}}}}
      const mutationRows=await mp.locator('.m-row').all();
      const unrelatedMutationRows=await mp.locator('.m-row').all();
      nodeRepl.write({{returns:mutationReturns,errors:mutationErrors,
        cached:await mutationRows[0].locator('.m-value').innerText(),
        unrelated:await unrelatedMutationRows[0].locator('.m-value').innerText()}});
    "#,json!(browser.target))).await;
    for name in [
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
    ] {
        assert_eq!(
            result["returns"][name], "undefined",
            "public return for {name}: {result}"
        );
    }
    assert_eq!(result["cached"], "Before");
    assert_eq!(result["unrelated"], "Before");
    assert!(
        result["errors"]["strict"]
            .as_str()
            .unwrap()
            .contains("strict mode violation"),
        "{result}"
    );
    assert!(
        result["errors"]["radio"]
            .as_str()
            .unwrap()
            .ends_with("Cannot uncheck a radio button"),
        "{result}"
    );
    assert!(
        result["errors"]["blocked"]
            .as_str()
            .unwrap()
            .contains("checked state"),
        "{result}"
    );
    let oracle=browser.inspect("({oracle:mutationOracle,text:document.querySelector('#m-text').value,checked:document.querySelector('#m-check').checked,radio:document.querySelector('#m-radio').checked,blocked:document.querySelector('#m-blocked').checked,selected:document.querySelector('#m-select').value,multiple:Array.from(document.querySelector('#m-multiple').selectedOptions,x=>x.value),local:document.querySelector('#local').contentWindow.ownMutationClicks})").await;
    assert_eq!(oracle["text"], "replaced appended你🙂é");
    for (field, value) in [
        ("clicks", 3),
        ("doubles", 1),
        ("checkboxClicks", 3),
        ("blockedClicks", 1),
        ("visibleClicks", 1),
        ("shadowClicks", 1),
    ] {
        assert_eq!(
            oracle["oracle"][field], value,
            "independent {field}: {oracle}"
        );
    }
    assert_eq!(oracle["checked"], true);
    assert_eq!(oracle["radio"], true);
    assert_eq!(oracle["blocked"], false);
    assert_eq!(oracle["selected"], "a");
    assert_eq!(oracle["multiple"], json!(["a", "c"]));
    let events = oracle["oracle"]["events"].as_array().unwrap();
    assert!(
        events.iter().any(|event| event["kind"] == "keydown"
            && event["key"] == "End"
            && event["trusted"] == true),
        "{oracle}"
    );
    assert!(
        events
            .iter()
            .any(|event| event["kind"] == "input" && event["id"] == "m-text"),
        "{oracle}"
    );
    let selections: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "change" && event["id"] == "m-select")
        .map(|event| event["value"].clone())
        .collect();
    assert_eq!(
        selections,
        json!(["b", "c", "a"]).as_array().unwrap().clone(),
        "{oracle}"
    );
    assert_eq!(oracle["local"], 1);
    assert_eq!(
        observe(&browser, Some(&remote), "ownMutationClicks").await,
        1
    );
    assert_eq!(
        observe(&browser, Some(&nested), "ownMutationClicks").await,
        1
    );
    assert_eq!(
        browser
            .inspect("document.querySelector('.m-value').textContent='External change';true")
            .await,
        true
    );
    let cache=evaluate(&repl,bridge.clone(),r#"
      const externalMutationCache={own:await mutationRows[0].locator('.m-value').innerText(),other:await unrelatedMutationRows[0].locator('.m-value').innerText(),live:await mp.locator('.m-value').first().innerText()};
      await mutationRows[0].locator('button').click();
      nodeRepl.write({before:externalMutationCache,own:await mutationRows[0].locator('.m-value').innerText(),other:await unrelatedMutationRows[0].locator('.m-value').innerText()});
    "#).await;
    assert_eq!(
        cache,
        json!({"before":{"own":"Before","other":"Before","live":"External change"},"own":"By own mutation","other":"Before"})
    );
    assert_eq!(browser.inspect("const overlay=document.createElement('div');overlay.id='mutation-frame-overlay';overlay.style.cssText='position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.01)';mutationOracle.overlayClicks=0;overlay.onclick=()=>mutationOracle.overlayClicks++;document.body.append(overlay);true").await,true);
    let forced=evaluate(&repl,bridge.clone(),r#"
      let frameRefusal=null;
      try {await mp.frameLocator('#remote').getByRole('button',{name:'Remote action',exact:true}).click();}
      catch(error){frameRefusal=error.message;}
      nodeRepl.write({refusal:frameRefusal,forced:typeof(await mp.frameLocator('#remote').getByRole('button',{name:'Remote action',exact:true}).click({force:true}))});
    "#).await;
    let refusal = forced["refusal"]
        .as_str()
        .expect("frame overlay must refuse an unforced pointer action");
    assert!(
        refusal.ends_with("Frame is obscured at the interaction point"),
        "{forced}"
    );
    assert_eq!(forced["forced"], "undefined");
    assert_eq!(
        browser.inspect("mutationOracle.overlayClicks").await,
        1,
        "force must dispatch an actual covered point to the overlay"
    );
    assert_eq!(
        observe(&browser, Some(&remote), "ownMutationClicks").await,
        1,
        "force must not pretend the covered OOPIF received the click"
    );
    browser
        .inspect("document.querySelector('#mutation-frame-overlay').remove();true")
        .await;
    browser.inspect("document.querySelector('#m-sequential').value='virtual-copy';document.querySelector('#m-other').value='';true").await;
    // Persistent clipboard shortcuts require the current attachment authority
    // and effect custody; earlier locator/text calls keep their original bridge.
    let effects = Arc::new(ClipboardEffects::default());
    let clipboard_bridge = Arc::new(ClipboardBridge {
        session: session.clone(),
        authority: Arc::new(ClipboardAuthority(bridge.authority.clone())),
        effects: effects.clone(),
    });
    let clipboard=evaluate(&repl,clipboard_bridge.clone(),r#"
      await mp.locator('#m-sequential').press('ControlOrMeta+A');
      await mp.locator('#m-sequential').press('ControlOrMeta+C');
      await mp.locator('#m-other').press('ControlOrMeta+V');
      await mp.locator('#m-sequential').press('ControlOrMeta+X');
      let refused;try{await mp.locator('#m-other').press('Control+Alt+V');}catch(error){refused=String(error);}
      nodeRepl.write({refused});
    "#).await;
    assert!(
        clipboard["refused"]
            .as_str()
            .unwrap()
            .contains("Native clipboard shortcuts are disabled"),
        "{clipboard}"
    );
    assert_eq!(browser.inspect("[document.querySelector('#m-sequential').value,document.querySelector('#m-other').value]").await,json!(["","virtual-copy"]));
    browser.inspect("document.querySelector('#m-sequential').value='custom';document.querySelector('#m-sequential').addEventListener('cut',event=>{event.preventDefault();event.clipboardData.setData('text/plain','app-cut');event.target.value='handled-by-app';},{once:true});true").await;
    evaluate(
        &repl,
        clipboard_bridge,
        r#"
      await mp.locator('#m-sequential').press('ControlOrMeta+A');
      await mp.locator('#m-sequential').press('ControlOrMeta+X');
      await mp.locator('#m-other').press('ControlOrMeta+A');
      await mp.locator('#m-other').press('ControlOrMeta+V');
      await mp.locator('#email').press('ControlOrMeta+A');
      await mp.locator('#email').press('ControlOrMeta+C');
      await mp.locator('#m-other').press('ControlOrMeta+A');
      await mp.locator('#m-other').press('ControlOrMeta+V');
      nodeRepl.write({done:true});
    "#,
    )
    .await;
    assert_eq!(browser.inspect("[document.querySelector('#m-sequential').value,document.querySelector('#m-other').value,document.querySelector('#email').value]").await,json!(["handled-by-app","app-cut","fixture-email-secret"]),"app-handled cut succeeds without a default commit, and protected copy retains the virtual clipboard");
    repl.close().await.unwrap();
    session.lock().await.close().await.unwrap();
    effects.join().await;
    driver.lock().await.close().await.unwrap();
    for id in [&remote, &nested] {
        browser
            .observer
            .call(None, "Target.detachFromTarget", json!({"sessionId":id}))
            .await
            .unwrap();
    }
    browser.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 3)]
#[ignore = "requires MAKA_CUA_TEST_CHROME; verifies real mutation denial, cancellation, and independently acknowledged partial input"]
async fn locator_mutations_preserve_denial_and_stop_after_observed_partial_input() {
    use maka_computer_use::protocol::*;
    let browser = Browser::open().await;
    assert_eq!(browser.inspect(FIXTURE).await, true);
    let driver = Arc::new(Mutex::new(Driver::default()));
    let mut session = browser.session(driver.clone());
    let base = InvocationContext::new("mutation-stop-fixture", "fixture-turn");
    let bound = session
        .invoke(
            Command::BrowserTab {
                browser_id: "fixture".into(),
                reference: BrowserTabReference::Existing(browser.target.clone()),
            },
            &base,
            &CancellationToken::new(),
            Language::En,
        )
        .await
        .unwrap();
    let mutation = |selector: &str, operation: Value| {
        serde_json::from_value::<Command>(json!({"method":"browserMutation","handle":bound["handle"],"locator":{"selector":selector},"operation":operation})).unwrap()
    };
    let click = || mutation("#m-click", json!({"kind":"click"}));
    let error = session
        .invoke(click(), &base, &CancellationToken::new(), Language::En)
        .await
        .unwrap_err();
    assert!(
        error.to_string().contains("requires Host authorization"),
        "{error}"
    );
    let authority = browser.authority();
    let context = base.with_browser_authorization(authority.clone());
    authority.allowed.store(false, Ordering::SeqCst);
    let error = session
        .invoke(click(), &context, &CancellationToken::new(), Language::En)
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "tool failed: fixture site denied");
    authority.allowed.store(true, Ordering::SeqCst);
    let stopped = CancellationToken::new();
    stopped.cancel();
    let error = session
        .invoke(click(), &context, &stopped, Language::En)
        .await
        .unwrap_err();
    assert_eq!(
        error.to_string(),
        "tool failed: Computer Use cancelled before dispatch"
    );
    assert_eq!(
        browser.inspect("mutationOracle.clicks").await,
        0,
        "denied and pre-cancelled calls must produce no clicks"
    );
    let stop = CancellationToken::new();
    let text = "ABCDEFGHIJKLMNO";
    let command = mutation(
        "#m-sequential",
        json!({"kind":"pressSequentially","value":text}),
    );
    let operation = session.invoke(command, &context, &stop, Language::En);
    let oracle = async {
        tokio::time::timeout(Duration::from_secs(3),async {
            loop {
                let observed=browser.inspect("({value:document.querySelector('#m-sequential').value,inputs:mutationOracle.sequentialInputs})").await;
                if observed["inputs"].as_u64().unwrap()>0 {stop.cancel();break observed;}
                tokio::task::yield_now().await;
            }
        }).await.expect("first actual input event must precede cancellation")
    };
    let (result, acknowledged) = tokio::join!(operation, oracle);
    let error = result.unwrap_err();
    assert!(matches!(error, ToolError::OutcomeUnknown(_)), "{error}");
    let prefix=browser.inspect("mutationOracle.sealed=true;({value:document.querySelector('#m-sequential').value,inputs:mutationOracle.sequentialInputs})").await;
    let value = prefix["value"].as_str().unwrap();
    assert!(
        !value.is_empty() && text.starts_with(value) && value.len() < text.len(),
        "observed prefix {prefix}; initial ack {acknowledged}"
    );
    // Count input events over acknowledged browser frame progress after settlement.
    // The value and event oracle establish effects; elapsed time alone does not.
    let settled=observe(&browser,None,"new Promise(resolve=>{let remaining=16;function frame(){if(--remaining)requestAnimationFrame(frame);else resolve({value:document.querySelector('#m-sequential').value,inputs:mutationOracle.sequentialInputs,late:mutationOracle.lateInputs})}requestAnimationFrame(frame)})").await;
    assert_eq!(settled["value"], prefix["value"]);
    assert_eq!(settled["inputs"], prefix["inputs"]);
    assert_eq!(settled["late"], 0);
    assert_eq!(browser.inspect("document.querySelector('#m-sequential').value='';mutationOracle.sealed=false;mutationOracle.mode='lose-focus';mutationOracle.sequentialInputs=0;true").await,true);
    let error = session
        .invoke(
            mutation(
                "#m-sequential",
                json!({"kind":"pressSequentially","value":"XYZ"}),
            ),
            &context,
            &CancellationToken::new(),
            Language::En,
        )
        .await
        .unwrap_err();
    assert!(matches!(error, ToolError::OutcomeUnknown(_)), "{error}");
    let focus=observe(&browser,None,"new Promise(resolve=>{requestAnimationFrame(()=>requestAnimationFrame(()=>resolve({value:document.querySelector('#m-sequential').value,other:document.querySelector('#m-other').value,inputs:mutationOracle.sequentialInputs,active:document.activeElement.id})))})").await;
    assert_eq!(
        focus,
        json!({"value":"X","other":"","inputs":1,"active":"m-other"})
    );
    session.close().await.unwrap();
    driver.lock().await.close().await.unwrap();
    browser.close().await;
}
