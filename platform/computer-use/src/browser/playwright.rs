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

mod download_media;
mod mutation;
pub(super) use mutation::validate_mutation;
use std::{collections::HashSet, future::Future, pin::Pin, sync::Mutex};
use tokio_util::sync::CancellationToken;

const INJECTED: &str = include_str!("../../../../third-party/playwright/injected.js");
const READ: &str = include_str!("playwright-read.js");
const SETUP: &str = include_str!("playwright-setup.js");
const WORLD: &str = "maka-playwright-1.58.2";

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Reply {
    Value { value: Value },
    Missing,
    Strict { count: usize },
}

enum AttemptError {
    Retry(ToolError),
    Fatal(ToolError),
}
impl From<ToolError> for AttemptError {
    fn from(error: ToolError) -> Self {
        Self::Retry(error)
    }
}
type Attempt<T> = Result<T, AttemptError>;
struct SelectorScope {
    frame: frames::Frame,
    used: Vec<frames::Frame>,
    segment: Segment,
}
struct ReadValue {
    value: Value,
    used: Vec<frames::Frame>,
}
struct Snapshot {
    frame: frames::Frame,
    ancestors: Vec<frames::Frame>,
    full: String,
    iframes: Vec<Value>,
}
#[derive(Deserialize)]
struct Segment {
    text: String,
    parsed: Value,
}
struct Resources {
    group: String,
    sessions: Mutex<HashSet<Option<String>>>,
    mutated: std::sync::atomic::AtomicBool,
}
impl Resources {
    fn new() -> Self {
        Self {
            group: format!("maka-playwright-{}", uuid::Uuid::new_v4()),
            sessions: Mutex::new(HashSet::new()),
            mutated: std::sync::atomic::AtomicBool::new(false),
        }
    }
    fn register(&self, frame: &frames::Frame) {
        self.sessions.lock().unwrap().insert(frame.session.clone());
    }
    async fn cleanup(&self, tab: &Tab) {
        let sessions: Vec<_> = self.sessions.lock().unwrap().iter().cloned().collect();
        let release = futures_util::future::join_all(sessions.iter().map(|session| {
            tab.frame_request(
                session.as_deref(),
                "Runtime.releaseObjectGroup",
                json!({"objectGroup":self.group}),
            )
        }));
        // These are this read's debugger handles. Releasing them cannot replay
        // application input. Disconnect also releases any remaining handles.
        let _ = tokio::time::timeout(Duration::from_millis(500), release).await;
    }
}

pub(super) fn validate(
    operation: &BrowserReadOperation,
    options: &BrowserReadOptions,
) -> Result<(), ToolError> {
    if options.timeout_ms == Some(0) {
        return Err(failed("timeoutMs must be positive"));
    }
    if matches!(operation,BrowserReadOperation::GetAttribute {name} if name.is_empty()) {
        return Err(failed("locator.getAttribute requires a name"));
    }
    Ok(())
}

fn cdp_value(reply: Value) -> Result<Value, ToolError> {
    if let Some(exception) = reply.get("exceptionDetails") {
        return Err(failed(
            exception["exception"]["description"]
                .as_str()
                .or_else(|| exception["text"].as_str())
                .unwrap_or("Playwright page read failed"),
        ));
    }
    Ok(reply["result"].clone())
}
fn read_reply(value: Value) -> Attempt<Value> {
    match serde_json::from_value(value).map_err(failed)? {
        Reply::Value { value } => Ok(value),
        Reply::Missing => Err(AttemptError::Retry(failed(
            "no element matches the locator",
        ))),
        Reply::Strict { count } => Err(AttemptError::Fatal(failed(format!(
            "strict mode violation: locator resolved to {count} elements"
        )))),
    }
}

impl Tab {
    async fn playwright_engine(
        &self,
        frame: &frames::Frame,
        resources: &Resources,
    ) -> Result<String, ToolError> {
        resources.register(frame);
        let world = self
            .frame_request(
                frame.session.as_deref(),
                "Page.createIsolatedWorld",
                json!({"frameId":frame.id,"worldName":WORLD,"grantUniveralAccess":false}),
            )
            .await?;
        let context = world["executionContextId"]
            .as_u64()
            .ok_or_else(|| failed("Playwright isolated world unavailable"))?;
        let existing=cdp_value(self.frame_observation(frame.session.as_deref(),"Runtime.evaluate",json!({"contextId":context,"expression":"globalThis.__makaPlaywright","objectGroup":resources.group,"returnByValue":false})).await?)?;
        if let Some(object) = existing["objectId"].as_str() {
            return Ok(object.into());
        }
        let expression =
            format!("(() => {{const module={{}};{INJECTED}\n{SETUP}\nreturn engine;}})()");
        let engine=cdp_value(self.frame_observation(frame.session.as_deref(),"Runtime.evaluate",json!({"contextId":context,"expression":expression,"objectGroup":resources.group,"returnByValue":false})).await?)?;
        engine["objectId"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| failed("Playwright injected utility unavailable"))
    }

    async fn playwright_script(
        &self,
        frame: &frames::Frame,
        request: Value,
        by_value: bool,
        resources: &Resources,
    ) -> Result<Value, ToolError> {
        let engine = self.playwright_engine(frame, resources).await?;
        cdp_value(self.frame_observation(frame.session.as_deref(),"Runtime.callFunctionOn",json!({"objectId":engine,"functionDeclaration":READ,"arguments":[{"value":request}],"returnByValue":by_value,"awaitPromise":true,"objectGroup":resources.group})).await?)
    }

    async fn playwright_element(
        &self,
        frame: &frames::Frame,
        segment: &Segment,
        resources: &Resources,
    ) -> Attempt<String> {
        let envelope=self.playwright_script(frame,json!({"selector":segment.text,"parsedSelector":segment.parsed,"operation":{"kind":"frame"}}),false,resources).await?;
        let envelope_id = envelope["objectId"]
            .as_str()
            .ok_or_else(|| failed("frame locator did not return an object"))?;
        let properties = self
            .frame_request(
                frame.session.as_deref(),
                "Runtime.getProperties",
                json!({"objectId":envelope_id,"ownProperties":true}),
            )
            .await?;
        let properties = properties["result"]
            .as_array()
            .ok_or_else(|| failed("frame locator metadata unavailable"))?;
        let property = |name: &str| {
            properties
                .iter()
                .find(|entry| entry["name"] == name)
                .map(|entry| &entry["value"])
        };
        match property("status").and_then(|value| value["value"].as_str()) {
            Some("missing") => {
                return Err(AttemptError::Retry(failed(
                    "frame locator has no matching element",
                )));
            }
            Some("strict") => {
                return Err(AttemptError::Fatal(failed(
                    "strict mode violation: frame locator resolved to multiple elements",
                )));
            }
            Some("value") => {}
            _ => {
                return Err(AttemptError::Retry(failed(
                    "frame locator returned invalid metadata",
                )));
            }
        }
        let node = property("value")
            .and_then(|value| value["objectId"].as_str())
            .ok_or_else(|| failed("frame locator did not resolve an element"))?;
        Ok(node.to_owned())
    }

    async fn playwright_frame(
        &self,
        parent: &frames::Frame,
        segment: &Segment,
        catalog: &frames::Catalog,
        resources: &Resources,
    ) -> Attempt<frames::Frame> {
        let node = self.playwright_element(parent, segment, resources).await?;
        let described = self
            .frame_request(
                parent.session.as_deref(),
                "DOM.describeNode",
                json!({"objectId":node}),
            )
            .await?;
        let backend = described["node"]["backendNodeId"]
            .as_u64()
            .ok_or_else(|| failed("frame owner identity unavailable"))?;
        if !matches!(
            described["node"]["nodeName"].as_str(),
            Some("IFRAME" | "FRAME")
        ) {
            return Err(AttemptError::Retry(failed(
                "frame locator must select an iframe or frame element",
            )));
        }
        Ok(self
            .resolve_frame(
                parent,
                backend,
                described["node"]["frameId"].as_str(),
                catalog,
            )
            .await?)
    }

    async fn playwright_scope(
        &mut self,
        query: &str,
        resources: &Resources,
    ) -> Attempt<SelectorScope> {
        let main = self.main_frame().await?;
        let split = self
            .playwright_script(
                &main,
                json!({"selector":query,"operation":{"kind":"selectorSegments"}}),
                true,
                resources,
            )
            .await?;
        let segments: Vec<Segment> =
            serde_json::from_value(read_reply(split["value"].clone())?).map_err(failed)?;
        if segments.is_empty() {
            return Err(AttemptError::Fatal(failed("locator requires a selector")));
        }
        let mut frame = main.clone();
        let mut used = vec![main.clone()];
        if segments.len() > 1 {
            let catalog = self.frame_catalog().await?;
            if catalog.main()? != main {
                return Err(AttemptError::Fatal(failed(
                    "main frame changed during browser read; retry the operation",
                )));
            }
            for segment in &segments[..segments.len() - 1] {
                frame = self
                    .playwright_frame(&frame, segment, &catalog, resources)
                    .await?;
                used.push(frame.clone());
            }
        }
        let segment = segments
            .into_iter()
            .last()
            .expect("nonempty selector segments");
        Ok(SelectorScope {
            frame,
            used,
            segment,
        })
    }

    async fn playwright_attempt(
        &mut self,
        query: &str,
        operation: &BrowserReadOperation,
        resources: &Resources,
    ) -> Attempt<ReadValue> {
        let SelectorScope {
            frame,
            used,
            segment,
        } = self.playwright_scope(query, resources).await?;
        let relative = match operation {
            BrowserReadOperation::Rows {
                relative: Some(relative),
            } => Some(&relative.selector),
            _ => None,
        };
        let result=self.playwright_script(&frame,json!({"selector":segment.text,"parsedSelector":segment.parsed,"operation":operation,"relative":relative}),true,resources).await?;
        Ok(ReadValue {
            value: read_reply(result["value"].clone())?,
            used,
        })
    }

    pub(super) async fn playwright_read(
        &mut self,
        plan: &LocatorPlan,
        operation: BrowserReadOperation,
        budget: super::ReadBudget,
        document: crate::BrowserDocument,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let effect = self.read_effect()?;
        let resources = Resources::new();
        let timeout = budget.remaining;
        check_input(cancellation)?;
        if timeout.is_zero() {
            return Err(failed("Playwright selector deadline exceeded"));
        }
        let deadline = tokio::time::Instant::now() + timeout;
        // Lazy tab bindings do not have a debugger socket yet. The connection
        // and document proof belong to this read's deadline too; Host consent
        // has already completed; authorization spent the same remaining budget.
        let ready = async {
            self.verify(language).await?;
            if self.document() != document {
                return Err(failed(
                    "document changed during browser authorization; retry the operation",
                ));
            }
            check_input(cancellation)
        };
        tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(effect.interrupted("Browser read cancelled")),
            result=tokio::time::timeout_at(deadline,ready)=>result.map_err(|_|effect.interrupted("Playwright selector deadline exceeded"))??,
        }
        if matches!(operation, BrowserReadOperation::DomSnapshot) {
            let result = self
                .playwright_snapshot_read(document, cancellation, language, &resources, deadline)
                .await;
            resources.cleanup(self).await;
            return result.map_err(|error| effect.read_failure(error));
        }
        let result=async {
            loop {
                check_input(cancellation)?;
                if tokio::time::Instant::now() >= deadline {
                    return Err(failed("Playwright selector deadline exceeded"));
                }
                let attempt=async {
                    let result=self.playwright_attempt(&plan.selector,&operation,&resources).await?;
                    if !self.frame_scopes_current(&result.used).await? {return Err(AttemptError::Fatal(failed("frame changed during browser read; retry the operation")));}
                    self.refresh_info(language).await?;
                    if self.document()!=document {return Err(AttemptError::Fatal(failed("document changed during browser read; retry the operation")));}
                    check_input(cancellation)?;
                    Ok(result.value)
                };
                let result=tokio::select! {
                    biased;
                    _=cancellation.cancelled()=>return Err(effect.interrupted("Browser read cancelled")),
                    result=tokio::time::timeout_at(deadline,attempt)=>result.map_err(|_|effect.interrupted("Playwright selector deadline exceeded"))?,
                };
                match result {
                    Ok(value)=>return Ok(value),
                    Err(AttemptError::Fatal(error))=>return Err(error),
                    Err(AttemptError::Retry(error))=>{
                        if effect.uncertain(&error) { return Err(error); }
                        if tokio::time::Instant::now()>=deadline {return Err(error);}
                        tokio::select! {
                            biased;
                            _=cancellation.cancelled()=>return Err(failed("Browser read cancelled")),
                            _=tokio::time::sleep_until((tokio::time::Instant::now()+Duration::from_millis(100)).min(deadline))=>{},
                        }
                    },
                }
            }
        }.await;
        resources.cleanup(self).await;
        result.map_err(|error| effect.read_failure(error))
    }

    async fn capture_snapshot(
        &self,
        frame: frames::Frame,
        mut ancestors: Vec<frames::Frame>,
        resources: &Resources,
        cancellation: &CancellationToken,
    ) -> Attempt<Snapshot> {
        check_input(cancellation)?;
        if ancestors.iter().any(|ancestor| ancestor.id == frame.id) {
            return Err(AttemptError::Fatal(failed("cyclic iframe ancestry")));
        }
        ancestors.push(frame.clone());
        let raw = self
            .playwright_script(
                &frame,
                json!({"selector":"","operation":{"kind":"domSnapshot"}}),
                true,
                resources,
            )
            .await?;
        let value = read_reply(raw["value"].clone())?;
        if !self.frame_scopes_current(&ancestors).await? {
            return Err(AttemptError::Retry(failed(
                "frame changed during DOM snapshot",
            )));
        }
        check_input(cancellation)?;
        Ok(Snapshot {
            frame,
            ancestors,
            full: value["full"]
                .as_str()
                .ok_or_else(|| failed("DOM snapshot unavailable"))?
                .into(),
            iframes: value["iframes"]
                .as_array()
                .ok_or_else(|| failed("iframe snapshot metadata unavailable"))?
                .clone(),
        })
    }

    async fn playwright_snapshot_read(
        &mut self,
        document: crate::BrowserDocument,
        cancellation: &CancellationToken,
        language: Language,
        resources: &Resources,
        deadline: tokio::time::Instant,
    ) -> Result<Value, ToolError> {
        let effect = self.read_effect()?;
        check_input(cancellation)?;
        if tokio::time::Instant::now() >= deadline {
            return Err(failed("Playwright snapshot deadline exceeded"));
        }
        let mandatory = async {
            let main = self.main_frame().await?;
            let snapshot = self
                .capture_snapshot(main, Vec::new(), resources, cancellation)
                .await
                .map_err(|error| match error {
                    AttemptError::Retry(error) | AttemptError::Fatal(error) => error,
                })?;
            self.refresh_info(language).await?;
            if self.document() != document {
                return Err(failed(
                    "document changed during browser read; retry the operation",
                ));
            }
            check_input(cancellation)?;
            Ok::<_, ToolError>(snapshot)
        };
        let root = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(effect.interrupted("Browser read cancelled")),
            result=tokio::time::timeout_at(deadline,mandatory)=>result.map_err(|_|effect.interrupted("Playwright snapshot deadline exceeded"))??,
        };
        if !root.iframes.iter().any(|owner| owner["visible"] == true) {
            return Ok(json!(clean_snapshot(&root.full)));
        }
        // The main snapshot is already validated. Optional renderer or child
        // failures retain it, while caller cancellation still interrupts.
        check_input(cancellation)?;
        if tokio::time::Instant::now() >= deadline {
            return Ok(json!(clean_snapshot(&root.full)));
        }
        let catalog = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(effect.interrupted("Browser read cancelled")),
            result=tokio::time::timeout_at(deadline,self.frame_catalog())=>match result {
                Ok(Ok(catalog))=>catalog,
                Ok(Err(error)) if effect.uncertain(&error)=>return Err(error),
                Err(_) if matches!(effect, ReadEffect::NativePreparation)=>return Err(effect.interrupted("Playwright snapshot deadline exceeded")),
                _=>return Ok(json!(clean_snapshot(&root.full))),
            },
        };
        if catalog.main().ok().as_ref() != Some(&root.frame) {
            return Ok(json!(clean_snapshot(&root.full)));
        }
        let result = tokio::select! {
            biased;
            _=cancellation.cancelled()=>return Err(effect.interrupted("Browser read cancelled")),
            result=self.expand_snapshot(root,&catalog,cancellation,resources,deadline,effect)=>result?,
        };
        check_input(cancellation)?;
        Ok(json!(clean_snapshot(&result)))
    }

    fn expand_snapshot<'a>(
        &'a self,
        snapshot: Snapshot,
        catalog: &'a frames::Catalog,
        cancellation: &'a CancellationToken,
        resources: &'a Resources,
        deadline: tokio::time::Instant,
        effect: ReadEffect,
    ) -> Pin<Box<dyn Future<Output = Result<String, ToolError>> + Send + 'a>> {
        Box::pin(async move {
            let children=snapshot.iframes.iter().filter(|owner|owner["visible"]==true).map(|owner|{
                let ancestors=snapshot.ancestors.clone();let frame=snapshot.frame.clone();
                async move {
                    let Some(reference)=owner["reference"].as_str() else {return Ok(None)};
                    if tokio::time::Instant::now() >= deadline {return Ok(None)};
                    let capture=async {
                        let split=self.playwright_script(&frame,json!({"selector":format!("aria-ref={reference}"),"operation":{"kind":"selectorSegments"}}),true,resources).await?;
                        let segments:Vec<Segment>=serde_json::from_value(read_reply(split["value"].clone())?).map_err(failed)?;
                        let segment=segments.first().ok_or_else(||failed("iframe reference unavailable"))?;
                        let child=self.playwright_frame(&frame,segment,catalog,resources).await?;
                        self.capture_snapshot(child,ancestors,resources,cancellation).await
                    };
                    let child=match tokio::time::timeout_at(deadline,capture).await {
                        Ok(Ok(child))=>child,
                        Ok(Err(AttemptError::Retry(error)|AttemptError::Fatal(error))) if effect.uncertain(&error)=>return Err(error),
                        Err(_) if matches!(effect,ReadEffect::NativePreparation)=>return Err(effect.interrupted("Playwright snapshot deadline exceeded")),
                        _=>return Ok(None),
                    };
                    let nested=self.expand_snapshot(child,catalog,cancellation,resources,deadline,effect).await?;
                    Ok(Some((reference.to_owned(),nested)))
                }
            });
            let children = futures_util::future::join_all(children)
                .await
                .into_iter()
                .collect::<Result<Vec<_>, ToolError>>()?;
            Ok(merge_snapshot(snapshot.full, &snapshot.iframes, children))
        })
    }
}

fn merge_snapshot(
    mut full: String,
    iframes: &[Value],
    children: Vec<Option<(String, String)>>,
) -> String {
    for owner in iframes {
        let Some(reference) = owner["reference"].as_str() else {
            continue;
        };
        let mut attributes = String::new();
        for name in ["id", "name"] {
            if let Some(value) = owner[name].as_str().filter(|value| !value.is_empty()) {
                attributes += &format!(
                    " [{name}={}]",
                    serde_json::to_string(value).expect("string serialization")
                );
            }
        }
        let marker = format!(" [ref={reference}]");
        if !attributes.is_empty() {
            full = full
                .lines()
                .map(|line| {
                    if line.trim_start().starts_with("- iframe") {
                        line.replace(&marker, &(attributes.clone() + &marker))
                    } else {
                        line.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    let mut lines = Vec::new();
    for line in full.lines() {
        lines.push(line.to_owned());
        if !line.trim_start().starts_with("- iframe") {
            continue;
        }
        let Some((_, snapshot)) = children
            .iter()
            .flatten()
            .find(|(reference, _)| line.contains(&format!("[ref={reference}]")))
        else {
            continue;
        };
        if !line.ends_with(':') {
            lines.last_mut().unwrap().push(':');
        }
        let indentation = line.bytes().take_while(|byte| *byte == b' ').count() + 2;
        lines.extend(snapshot.lines().map(|line| " ".repeat(indentation) + line));
    }
    lines.join("\n")
}

fn without_references(line: &str) -> String {
    let mut result = line.to_owned();
    for prefix in [" [ref=", " [cursor="] {
        while let Some(start) = result.find(prefix) {
            let Some(end) = result[start..].find(']') else {
                break;
            };
            result.replace_range(start..=start + end, "");
        }
    }
    result
}
fn unnamed(line: &str, role: &str) -> bool {
    let Some(mut remaining) = line
        .strip_prefix("- ")
        .and_then(|line| line.strip_prefix(role))
    else {
        return false;
    };
    if !remaining.is_empty() && !remaining.starts_with([' ', ':']) {
        return false;
    }
    remaining = remaining.trim().trim_end_matches(':').trim();
    while let Some(attribute) = remaining.strip_prefix('[') {
        let Some(end) = attribute.find(']') else {
            return false;
        };
        remaining = attribute[end + 1..].trim();
    }
    remaining.is_empty()
}
fn clean_snapshot(snapshot: &str) -> String {
    if !snapshot
        .lines()
        .any(|line| line.trim_start().starts_with("- "))
    {
        return snapshot.into();
    }
    struct Node {
        line: String,
        indent: usize,
        children: Vec<usize>,
    }
    let mut nodes = vec![Node {
        line: String::new(),
        indent: 0,
        children: Vec::new(),
    }];
    let mut stack = vec![0];
    for line in snapshot.lines().filter(|line| !line.trim().is_empty()) {
        let indent = line.bytes().take_while(|byte| *byte == b' ').count();
        while stack.len() > 1 && nodes[*stack.last().unwrap()].indent >= indent {
            stack.pop();
        }
        let parent = *stack.last().unwrap();
        let index = nodes.len();
        nodes.push(Node {
            line: without_references(line.trim_start()),
            indent,
            children: Vec::new(),
        });
        nodes[parent].children.push(index);
        stack.push(index);
    }
    fn render(nodes: &[Node], index: usize, depth: usize, output: &mut Vec<String>) {
        let node = &nodes[index];
        if unnamed(&node.line, "img") {
            return;
        }
        let kept = index != 0
            && !["generic", "group", "listitem"]
                .iter()
                .any(|role| unnamed(&node.line, role));
        if kept {
            output.push("  ".repeat(depth) + &node.line);
        }
        for child in &node.children {
            render(nodes, *child, depth + usize::from(kept), output);
        }
    }
    let mut output = Vec::new();
    render(&nodes, 0, 0, &mut output);
    output.join("\n")
}
