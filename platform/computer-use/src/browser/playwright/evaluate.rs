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

//! Executes explicit browser reads through a frozen DOM surface in an isolated world.

use super::*;
use crate::protocol::{BrowserEvaluateMode, BrowserEvaluateOptions};

const MEMBRANE: &str = include_str!("readonly-evaluate.js");
const WORLD_NAME: &str = "maka-playwright-readonly";
/// The observed runtime grants transient evaluate cleanup 100 milliseconds.
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(100);

#[derive(Clone)]
struct EvaluationBinding {
    frame: frames::Frame,
    context: u64,
    name: String,
}

struct EvaluationScope {
    frame: frames::Frame,
    mode: BrowserEvaluateMode,
    used: Vec<frames::Frame>,
    context: u64,
    binding: String,
}

impl Tab {
    async fn readonly_world(
        &self,
        frame: &frames::Frame,
        resources: &Resources,
    ) -> Result<u64, ToolError> {
        resources.register(frame);
        let world = self
            .frame_request(
                frame.session.as_deref(),
                "Page.createIsolatedWorld",
                json!({"frameId":frame.id,"worldName":WORLD_NAME,"grantUniveralAccess":false}),
            )
            .await?;
        world["executionContextId"]
            .as_u64()
            .ok_or_else(|| failed("Playwright isolated world unavailable"))
    }

    async fn readonly_engine(
        &self,
        frame: &frames::Frame,
        resources: &Resources,
    ) -> Result<(u64, String), ToolError> {
        let context = self.readonly_world(frame, resources).await?;
        let current = cdp_value(
            self.frame_observation(
                frame.session.as_deref(),
                "Runtime.evaluate",
                json!({"contextId":context,"expression":"globalThis.__makaPlaywright",
                "returnByValue":false,"objectGroup":resources.group}),
            )
            .await?,
        )?;
        if let Some(object) = current["objectId"].as_str() {
            return Ok((context, object.to_owned()));
        }
        // The same upstream selector engine and the same authored setup are
        // reused in this dedicated realm; no additional selector implementation.
        let expression =
            format!("(() => {{const module={{}};{INJECTED}\n{SETUP}\nreturn engine;}})()");
        let installed = cdp_value(
            self.frame_observation(
                frame.session.as_deref(),
                "Runtime.evaluate",
                json!({"contextId":context,"expression":expression,"returnByValue":false,
                "objectGroup":resources.group}),
            )
            .await?,
        )?;
        let object = installed["objectId"]
            .as_str()
            .ok_or_else(|| failed("Playwright injected utility unavailable"))?;
        Ok((context, object.to_owned()))
    }

    async fn readonly_scope(
        &mut self,
        locator: Option<&LocatorPlan>,
        mode: BrowserEvaluateMode,
        resources: &Resources,
        bindings: &Mutex<Vec<EvaluationBinding>>,
    ) -> Attempt<EvaluationScope> {
        let (frame, used, segment) = if let Some(locator) = locator {
            let scope = self.playwright_scope(&locator.selector, resources).await?;
            (scope.frame, scope.used, Some(scope.segment))
        } else {
            let frame = self.main_frame().await?;
            (frame.clone(), vec![frame], None)
        };
        let binding = format!("__makaReadonly_{}", uuid::Uuid::new_v4().simple());
        if segment.is_none() {
            let context = self.readonly_world(&frame, resources).await?;
            return Ok(EvaluationScope {
                frame,
                mode,
                used,
                context,
                binding,
            });
        }
        let (context, engine) = self.readonly_engine(&frame, resources).await?;
        // Retain the exact temporary binding before the fixed selector request
        // can be canceled after its remote write. Cleanup never guesses a name.
        bindings
            .lock()
            .expect("evaluate bindings mutex poisoned")
            .push(EvaluationBinding {
                frame: frame.clone(),
                context,
                name: binding.clone(),
            });
        let request = json!({"parsed":segment.as_ref().map(|value|&value.parsed),
            "mode":mode,"binding":binding});
        // Resolve before running user code. Missing single targets may retry;
        // strict failures and every error after execution admission never replay.
        let resolve = r#"function(request) {
            const matches=request.parsed ? this.querySelectorAll(request.parsed,document) : [];
            let selected;
            if(request.mode==='element') {
                if(matches.length===0) return {status:'missing'};
                if(matches.length===1) selected=matches[0];
                else {
                    const visible=matches.filter(element=>this.elementState(element,'visible').matches);
                    if(visible.length!==1) return {status:'strict',count:matches.length};
                    selected=visible[0];
                }
            } else if(request.mode==='all') selected=matches;
            globalThis[request.binding]=selected;
            return {status:'value',value:null};
        }"#;
        let result = cdp_value(self.frame_observation(frame.session.as_deref(),"Runtime.callFunctionOn",
            json!({"objectId":engine,"functionDeclaration":resolve,"arguments":[{"value":request}],
                "returnByValue":true,"objectGroup":resources.group})).await?)?;
        if result["value"]["status"] == "missing" {
            return Err(AttemptError::Retry(failed("No element matched selector")));
        }
        read_reply(result["value"].clone())?;
        Ok(EvaluationScope {
            frame,
            mode,
            used,
            context,
            binding,
        })
    }

    async fn release_readonly_bindings(
        &self,
        bindings: &Mutex<Vec<EvaluationBinding>>,
        resources: &Resources,
    ) {
        let bindings = bindings
            .lock()
            .expect("evaluate bindings mutex poisoned")
            .clone();
        let cleanup = async {
            for binding in bindings {
                let _ = self.frame_observation(binding.frame.session.as_deref(), "Runtime.evaluate", json!({
                    "contextId":binding.context,"expression":format!("delete globalThis[{}]",json!(binding.name)),
                    "returnByValue":true,
                })).await;
            }
            resources.cleanup(self).await;
        };
        let _ = tokio::time::timeout(CLEANUP_TIMEOUT, cleanup).await;
    }

    pub(in crate::browser) async fn playwright_evaluate(
        &mut self,
        locator: Option<&LocatorPlan>,
        mode: BrowserEvaluateMode,
        script_json: &str,
        options: &BrowserEvaluateOptions,
        budget: super::super::ReadBudget,
        call: super::super::BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let document = self.document();
        let resources = Resources::new();
        let bindings = Mutex::new(Vec::new());
        let last_error = Mutex::new("playwright.evaluate exceeded its deadline".to_owned());
        let timeout = || {
            let reason = last_error.lock().expect("evaluate error mutex poisoned");
            if mode == BrowserEvaluateMode::Element
                && let Some(locator) = locator
            {
                return failed(format!(
                    "Timed out after {}ms evaluating selector {}: {}",
                    options.budget().as_secs_f64() * 1000.0,
                    locator.selector,
                    reason.as_str()
                ));
            }
            failed("playwright.evaluate exceeded its deadline")
        };
        let deadline = tokio::time::Instant::now() + budget.remaining;
        let effect = self.read_effect()?;
        let cancellation = call.cancellation;
        let setup = async {
            self.verify(call).await?;
            if self.document() != document {
                return Err(failed(
                    "document changed during browser authorization; retry the operation",
                ));
            }
            loop {
                check_input(cancellation)?;
                if tokio::time::Instant::now() >= deadline {
                    return Err(timeout());
                }
                match self
                    .readonly_scope(locator, mode, &resources, &bindings)
                    .await
                {
                    Ok(scope) => return Ok(scope),
                    Err(AttemptError::Fatal(error)) => return Err(error),
                    Err(AttemptError::Retry(error)) => {
                        *last_error.lock().expect("evaluate error mutex poisoned") =
                            error.to_string();
                        if effect.uncertain(&error) {
                            return Err(error);
                        }
                        if tokio::time::Instant::now() >= deadline {
                            return Err(timeout());
                        }
                        tokio::select! {
                            biased;
                            _=cancellation.cancelled()=>return Err(failed("Browser evaluate cancelled")),
                            _=tokio::time::sleep_until((tokio::time::Instant::now()+Duration::from_millis(100)).min(deadline))=>{},
                        }
                    }
                }
            }
        };
        let selected = tokio::select! {
            biased;
            _=cancellation.cancelled()=>Err(effect.interrupted("Browser evaluate cancelled before execution")),
            result=tokio::time::timeout_at(deadline,setup)=>result
                .map_err(|_| if matches!(effect, ReadEffect::Observation) { timeout() }
                    else { effect.interrupted("playwright.evaluate exceeded its deadline before execution") })
                .and_then(|value| value),
        };
        let scope = match selected {
            Ok(scope) => scope,
            Err(error) => {
                self.release_readonly_bindings(&bindings, &resources).await;
                return Err(effect.read_failure(error));
            }
        };
        let result = self
            .execute_readonly(&scope, script_json, deadline, &document, call, &resources)
            .await;
        self.release_readonly_bindings(&bindings, &resources).await;
        result
    }

    async fn execute_readonly(
        &mut self,
        scope: &EvaluationScope,
        script_json: &str,
        deadline: tokio::time::Instant,
        document: &crate::BrowserDocument,
        call: super::super::BrowserCall<'_>,
        resources: &Resources,
    ) -> Result<Value, ToolError> {
        let effect = self.read_effect()?;
        let preflight = async {
            check_input(call.cancellation)?;
            if !self.frame_scopes_current(&scope.used).await? {
                return Err(failed(
                    "frame changed before browser evaluation; retry the operation",
                ));
            }
            self.refresh_info(call).await?;
            if &self.document() != document {
                return Err(failed(
                    "document changed before browser evaluation; retry the operation",
                ));
            }
            check_input(call.cancellation)
        };
        tokio::select! {
            biased;
            _=call.cancellation.cancelled()=>return Err(effect.interrupted("Browser evaluate cancelled before execution")),
            result=tokio::time::timeout_at(deadline,preflight)=>result
                .map_err(|_|effect.interrupted("playwright.evaluate exceeded its deadline before execution"))??,
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(failed("playwright.evaluate exceeded its deadline"));
        }
        let mode = serde_json::to_string(&scope.mode).map_err(failed)?;
        let expression = format!(
            "({MEMBRANE})(JSON.parse({}),{mode},globalThis[{}])",
            json!(script_json),
            json!(scope.binding)
        );
        // This entry can scroll or schedule permitted browser work. It is an
        // actual CDP request, never an observation/no-effect hint, and it is
        // never replayed once its original request future has been polled.
        let execution = self.frame_request(
            scope.frame.session.as_deref(),
            "Runtime.evaluate",
            json!({"contextId":scope.context,"expression":expression,"awaitPromise":true,
                "returnByValue":true,"timeout":remaining.as_secs_f64()*1000.0,
                "objectGroup":resources.group,"allowUnsafeEvalBlockedByCSP":true}),
        );
        let reply = tokio::select! {
            biased;
            _=call.cancellation.cancelled()=>return Err(unknown("Browser evaluate cancelled after execution admission; original request may still be running")),
            result=tokio::time::timeout_at(deadline,execution)=>result
                .map_err(|_|unknown("Browser evaluate deadline exceeded after execution admission; original request may still be running"))??,
        };
        let remote = cdp_value(reply)?;
        let value = remote
            .get("value")
            .cloned()
            .ok_or_else(|| failed("browser evaluation did not return its projected result"))?;
        let error = value.get("errorJson").and_then(Value::as_str).is_some();
        let data = value.get("json").and_then(Value::as_str).is_some()
            && value
                .get("negativeZerosJson")
                .and_then(Value::as_str)
                .is_some();
        if error == data {
            return Err(failed(
                "browser evaluation returned an invalid projected result",
            ));
        }
        let verify = async {
            if !self.frame_scopes_current(&scope.used).await? {
                return Err(unknown(
                    "frame changed after browser evaluation; original script was not replayed",
                ));
            }
            self.refresh_info(call).await?;
            if &self.document() != document {
                return Err(unknown(
                    "document changed after browser evaluation; original script was not replayed",
                ));
            }
            check_input(call.cancellation)
        };
        tokio::select! {
            biased;
            _=call.cancellation.cancelled()=>return Err(unknown("Browser evaluate cancelled after execution; original script was not replayed")),
            result=tokio::time::timeout_at(deadline,verify)=>result
                .map_err(|_|unknown("Browser evaluate verification exceeded its deadline after execution; original script was not replayed"))??,
        }
        Ok(value)
    }
}
