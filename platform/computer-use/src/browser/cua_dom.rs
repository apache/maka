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

//! Visible DOM references share the existing Tab reference allocator and CDP.

use super::*;
use crate::browser::{DomCuaElement, DomElement, ElementRef};
use serde::Deserialize;

const SNAPSHOT: &str = include_str!("cua_dom.js");
const MAX_ELEMENTS: usize = 200;
const MAX_CHARS: usize = 20_000;
const FRAME_BUDGET: Duration = Duration::from_secs(1);
const REFERENCE_PLACEHOLDER: &str = "__maka_dom_ref__";
// Keep JSON-escaped UTF-16 text intact through CDP and Rust's UTF-8 strings.
const CAPTURE_METADATA: &str = r#"function(){return {viewport:this.viewport,clip:this.clip,items:this.items.map(({line,order})=>({lineJson:JSON.stringify(line).slice(1,-1),lineLength:line.length,order})),frames:this.frames.map(({rect,size,order})=>({rect,size,order}))};}"#;
// Temporary markup uses a placeholder; the Host applies the final UTF-16
// budget after substituting canonical IDs. Never return an unbounded row.
const REFERENCE_MARKUP_ALLOWANCE: usize = 20;

fn shared_child_deadline(
    deadline: &mut Option<tokio::time::Instant>,
    main_completed: tokio::time::Instant,
) -> tokio::time::Instant {
    *deadline.get_or_insert(main_completed + FRAME_BUDGET)
}

#[derive(Deserialize)]
struct Capture {
    viewport: [f64; 4],
    clip: [f64; 4],
    items: Vec<Row>,
    frames: Vec<Child>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Row {
    line_json: String,
    line_length: usize,
    order: usize,
}
impl Row {
    fn render(&self, id: u64) -> Result<(String, usize), ToolError> {
        let (prefix, suffix) = self
            .line_json
            .split_once(REFERENCE_PLACEHOLDER)
            .ok_or_else(|| failed("Visible DOM row lacks its reference placeholder"))?;
        let id = id.to_string();
        let length = self
            .line_length
            .checked_sub(REFERENCE_PLACEHOLDER.len())
            .and_then(|length| length.checked_add(id.len()))
            .ok_or_else(|| failed("Visible DOM row has an invalid UTF-16 length"))?;
        Ok((format!("{prefix}{id}{suffix}"), length))
    }
}
#[derive(Deserialize)]
struct Child {
    order: usize,
    rect: [f64; 4],
    size: [f64; 2],
}
struct Scope {
    frame: frames::Frame,
    used: Vec<frames::Frame>,
    clip: Option<[f64; 4]>,
}
pub(super) enum Action {
    Click {
        node: String,
        count: u32,
    },
    Scroll {
        node: Option<String>,
        delta: [f64; 2],
    },
}

fn intersection(a: [f64; 4], b: [f64; 4]) -> Option<[f64; 4]> {
    let value = [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ];
    (value.iter().all(|x| x.is_finite()) && value[2] > value[0] && value[3] > value[1])
        .then_some(value)
}
fn child_clip(rect: [f64; 4], clip: [f64; 4]) -> Option<[f64; 4]> {
    intersection(rect, clip).map(|r| {
        [
            r[0] - rect[0],
            r[1] - rect[1],
            r[2] - rect[0],
            r[3] - rect[1],
        ]
    })
}
fn reference(value: &str) -> Result<u64, ToolError> {
    let id = value
        .parse::<u64>()
        .ok()
        .filter(|id| id.to_string() == value);
    id.ok_or_else(|| failed(format!("DOM node {value} is stale or missing")))
}
fn delta(value: &Value) -> Result<f64, ToolError> {
    if value.is_null() {
        Ok(0.0)
    } else {
        value
            .as_f64()
            .ok_or_else(|| failed("dom_cua_scroll requires x and y numbers"))
    }
}
pub(super) fn action(operation: BrowserCuaOperation) -> Result<Action, ToolError> {
    let node = |value: String| {
        if value.is_empty() {
            Err(failed("DOM node id must be nonempty"))
        } else {
            Ok(value)
        }
    };
    match operation {
        BrowserCuaOperation::DomClick { node_id } => Ok(Action::Click {
            node: node(node_id)?,
            count: 1,
        }),
        BrowserCuaOperation::DomDoubleClick { node_id } => Ok(Action::Click {
            node: node(node_id)?,
            count: 2,
        }),
        BrowserCuaOperation::DomScroll {
            node_id,
            scroll_x,
            scroll_y,
        } => Ok(Action::Scroll {
            node: node_id.map(node).transpose()?,
            delta: [delta(&scroll_x)?, delta(&scroll_y)?],
        }),
        _ => unreachable!("only DOM node operations reach the DOM plan"),
    }
}
impl Tab {
    async fn cua_dom_nodes(
        &self,
        frame: &frames::Frame,
        object: &str,
        collection: &str,
        resources: &Resources,
    ) -> Result<Vec<frames::NodeIdentity>, ToolError> {
        let array=cdp_value(self.frame_observation(frame.session.as_deref(),"Runtime.callFunctionOn",json!({
            "objectId":object,"functionDeclaration":"function(collection){return this[collection].map(row=>row.element);}",
            "arguments":[{"value":collection}],"returnByValue":false,"objectGroup":resources.group,
        })).await?)?;
        let array = array["objectId"]
            .as_str()
            .ok_or_else(|| failed("DOM projection node array is unavailable"))?;
        let properties = self
            .frame_property_handles(
                frame.session.as_deref(),
                json!({"objectId":array,"ownProperties":true}),
            )
            .await?;
        let mut objects = properties
            .iter()
            .filter_map(|property| {
                Some((
                    property.name.parse::<usize>().ok()?,
                    property.value.as_ref()?.object_id.clone()?,
                ))
            })
            .collect::<Vec<_>>();
        objects.sort_by_key(|(index, _)| *index);
        if objects
            .iter()
            .enumerate()
            .any(|(expected, (index, _))| expected != *index)
        {
            return Err(failed("DOM projection node handle indices are incomplete"));
        }
        // Independent description requests share the existing connection's
        // bounded writer instead of adding a round trip per visible element.
        let nodes = futures_util::future::join_all(objects.iter().map(|(_, object)| {
            self.frame_node_identity(frame.session.as_deref(), json!({"objectId":object}))
        }))
        .await;
        nodes.into_iter().collect()
    }
    pub(super) async fn cua_dom_snapshot(
        &mut self,
        proof: &origin::DocumentOrigin,
        call: crate::browser::BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        // Retire only this projection's current handles. AX indices use this
        // same table and allocator, so neither family can reinterpret the other.
        self.refs
            .retain(|_, element| !matches!(element, ElementRef::DomCua(_)));
        self.ax.begin_dom(&proof.document_identity().frame_token());
        let resources = Resources::new();
        let document = self.document();
        let result=async {
            let catalog=self.frame_catalog().await?;
            let main=catalog.main()?;
            let mut frame_deadline=None;
            let mut pending=vec![Scope{frame:main.clone(),used:vec![main],clip:None}];
            let mut lines=Vec::new();
            let mut characters=0;
            while let Some(scope)=pending.pop() {
                if lines.len()>=MAX_ELEMENTS || characters>=MAX_CHARS {break;}
                let child=scope.used.len()>1;
                let child_deadline=if child {Some(frame_deadline.expect("main projection establishes the child window"))} else {None};
                if child_deadline.is_some_and(|deadline|tokio::time::Instant::now()>=deadline) {continue;}
                check_input(call.cancellation)?;
                let effect=self.read_effect();
                let work=async {
                    proof.check_current(self).await?;
                    let engine=self.playwright_engine(&scope.frame,&resources).await?;
                    let maximum=MAX_ELEMENTS-lines.len();
                    let raw=cdp_value(self.frame_observation(scope.frame.session.as_deref(),"Runtime.callFunctionOn",json!({
                        "objectId":engine,"functionDeclaration":SNAPSHOT,
                        "arguments":[{"value":{"clip":scope.clip,"maxElements":maximum,"maxChars":MAX_CHARS+MAX_ELEMENTS*REFERENCE_MARKUP_ALLOWANCE,"overlayRootIds":["codex-agent-overlay-root"]}}],
                        "returnByValue":false,"objectGroup":resources.group,
                    })).await?)?;
                    let object=raw["objectId"].as_str().ok_or_else(||failed("Visible DOM projection did not return an object"))?.to_owned();
                    let metadata=cdp_value(self.frame_observation(scope.frame.session.as_deref(),"Runtime.callFunctionOn",json!({
                        "objectId":object,"functionDeclaration":CAPTURE_METADATA,
                        "returnByValue":true,"objectGroup":resources.group,
                    })).await?)?;
                    let capture:Capture=serde_json::from_value(metadata["value"].clone()).map_err(failed)?;
                    if !capture.viewport.iter().chain(capture.clip.iter()).all(|v|v.is_finite()) {return Err(failed("Visible DOM viewport is not finite"));}
                    let nodes=self.cua_dom_nodes(&scope.frame,&object,"items",&resources).await?;
                    let owners=self.cua_dom_nodes(&scope.frame,&object,"frames",&resources).await?;
                    if nodes.len()!=capture.items.len() || owners.len()!=capture.frames.len() {return Err(failed("DOM projection node handles are incomplete"));}
                    if !self.frame_scopes_current(&scope.used).await? {return Err(failed("frame changed during visible DOM snapshot"));}
                    Ok((capture,nodes,owners))
                };
                let captured=if let Some(deadline)=child_deadline {
                    tokio::select! {biased;
                        ()=call.cancellation.cancelled()=>return Err(effect?.interrupted("Visible DOM read cancelled")),
                        value=tokio::time::timeout_at(deadline,work)=>match value {Ok(value)=>value,Err(_)=>continue},
                    }
                }else{super::super::super::wait::cancellable_observation(effect?,call.cancellation,work).await};
                let (capture,nodes,owners)=match captured {
                    Ok(value)=>value,
                    Err(ToolError::Failed(_)) if child=>continue,
                    Err(error)=>return Err(error),
                };
                if intersection(capture.viewport,capture.clip).is_none() {continue;}
                let limit=MAX_CHARS;
                let mut stopped=None;
                for (index,row) in capture.items.iter().enumerate() {
                    check_input(call.cancellation)?;
                    let node=&nodes[index];
                    let element=DomElement {backend:node.backend_node_id.ok_or_else(||failed("DOM node lacks its backend identity"))?,frame:Some(scope.frame.clone())};
                    let id=self.ax.dom_reference(&proof.document_identity().frame_token(),&element)?;
                    let (line,length)=row.render(id)?;
                    let length=length.checked_add(usize::from(!lines.is_empty())).ok_or_else(||failed("Visible DOM row has an invalid UTF-16 length"))?;
                    if length>limit-characters || lines.len()>=MAX_ELEMENTS {stopped=Some(row.order);break;}
                    self.refs.insert(id,ElementRef::DomCua(DomCuaElement{element,used:scope.used.clone(),clip:capture.clip}));
                    characters+=length;lines.push(line);
                }
                // Ordinary children get one shared window after the main
                // projection, including its final canonical-reference budget.
                // Descendants and siblings must not renew that window.
                let frame_deadline=shared_child_deadline(&mut frame_deadline,tokio::time::Instant::now());
                let mut children=Vec::new();
                for (index,child) in capture.frames.iter().enumerate() {
                    if stopped.is_some_and(|order|child.order>=order) {continue;}
                    if !child.size.iter().all(|n|n.is_finite()&&*n>0.0) {continue;}
                    let Some(clip)=child_clip(child.rect,capture.clip) else {continue};
                    let resolved=async {
                        let node=&owners[index];
                        let backend=node.backend_node_id.ok_or_else(||failed("iframe lacks its backend identity"))?;
                        self.resolve_frame(&scope.frame,backend,node.frame_id.as_deref(),&catalog).await
                    };
                    let frame=tokio::select! {biased;
                        ()=call.cancellation.cancelled()=>return Err(self.read_effect()?.interrupted("Visible DOM read cancelled")),
                        result=tokio::time::timeout_at(frame_deadline,resolved)=>match result {
                            Ok(Ok(frame))=>frame,Ok(Err(ToolError::Failed(_)))|Err(_)=>continue,
                            Ok(Err(error))=>return Err(error),
                        },
                    };
                    if scope.used.contains(&frame) {continue;}
                    let mut used=scope.used.clone();used.push(frame.clone());
                    children.push(Scope{frame,used,clip:Some(clip)});
                }
                pending.extend(children.into_iter().rev());
            }
            proof.check_current(self).await?;
            if self.document()!=document {return Err(failed("document changed during visible DOM snapshot"));}
            Ok(json!({"json":format!("\"{}\"",lines.join("\\n"))}))
        }.await;
        resources.cleanup(self).await;
        result
    }

    async fn cua_dom_selected(
        &self,
        node: &str,
        resources: &Resources,
    ) -> Result<(Selected, [f64; 4]), ToolError> {
        let id = reference(node)?;
        let Some(ElementRef::DomCua(reference)) = self.refs.get(&id) else {
            return Err(failed(format!("DOM node {node} is stale or missing")));
        };
        if !self.frame_scopes_current(&reference.used).await? {
            return Err(failed(format!("DOM node {node} is stale or missing")));
        }
        let frame = reference
            .element
            .frame
            .clone()
            .ok_or_else(|| failed("DOM reference lacks its proven frame"))?;
        resources.register(&frame);
        let resolved = self
            .frame_observation(
                frame.session.as_deref(),
                "DOM.resolveNode",
                json!({"backendNodeId":reference.element.backend,"objectGroup":resources.group}),
            )
            .await?;
        let object = resolved["object"]["objectId"]
            .as_str()
            .ok_or_else(|| failed(format!("DOM node {node} is stale or missing")))?
            .to_owned();
        Ok((
            Selected {
                object,
                frame,
                used: reference.used.clone(),
            },
            reference.clip,
        ))
    }
    pub(super) async fn cua_dom_action(
        &mut self,
        action: Action,
        proof: &origin::DocumentOrigin,
        call: crate::browser::BrowserCall<'_>,
        cursor: &crate::cursor::Spec,
    ) -> Result<(), ToolError> {
        let resources = Resources::new();
        let result=async {
            let node=match &action {Action::Click{node,..}=>Some(node.as_str()),Action::Scroll{node,..}=>node.as_deref()};
            let (point,target)=if let Some(node)=node {
                let (selected,clip)=self.cua_dom_selected(node,&resources).await?;
                proof.check_current(self).await?;
                self.before_input(call.cancellation,call.language).await?;
                resources.mutated.store(true,std::sync::atomic::Ordering::Relaxed);
                let value=cdp_value(self.frame_request(selected.frame.session.as_deref(),"Runtime.callFunctionOn",json!({
                    "objectId":selected.object,
                    "functionDeclaration":"function(clip){if(!this.isConnected)return null;this.scrollIntoView({block:'nearest',inline:'nearest'});for(const rect of [...this.getClientRects(),this.getBoundingClientRect()]){if(rect.width<=0||rect.height<=0)continue;const l=Math.max(rect.left,clip[0]),t=Math.max(rect.top,clip[1]),r=Math.min(rect.right,clip[2]),b=Math.min(rect.bottom,clip[3]);if(r>l&&b>t)return [(l+r)/2,(t+b)/2];}return null;}",
                    "arguments":[{"value":clip}],"returnByValue":true,"objectGroup":resources.group,
                })).await?)?;
                let local:[f64;2]=serde_json::from_value(value["value"].clone()).map_err(|_|failed(format!("DOM node {node} is stale or missing")))?;
                if !local.iter().all(|x|x.is_finite()) {return Err(failed("DOM node point is not finite"));}
                let top=self.dom_cua_project(&selected,local,&resources,call.cancellation).await?;
                let session=selected.frame.session.clone();
                let input=if session.is_some() {
                    let start=selected.used.iter().rposition(|frame|frame.session!=session).map_or(0,|index|index+1);
                    let within=Selected{object:selected.object.clone(),frame:selected.frame.clone(),used:selected.used[start..].to_vec()};
                    self.dom_cua_project(&within,local,&resources,call.cancellation).await?
                }else{top};
                (top,Some(MouseTarget{session,input,used:selected.used.clone(),main:selected.used.iter().find(|frame|frame.session==selected.frame.session).map(|frame|frame.id.clone()).unwrap_or_else(||selected.frame.id.clone())}))
            }else{
                let metrics=self.frame_observation(None,"Page.getLayoutMetrics",json!({})).await?;
                let viewport=&metrics["cssVisualViewport"];
                let width=viewport["clientWidth"].as_f64().ok_or_else(||failed("viewport width is unavailable"))?;
                let height=viewport["clientHeight"].as_f64().ok_or_else(||failed("viewport height is unavailable"))?;
                ([width/2.0,height/2.0],None)
            };
            let pointer=match action {
                Action::Click{count,..}=>Pointer::Click{point,mask:0,button:Button::Left,count},
                Action::Scroll{delta,..}=>Pointer::Scroll{point,mask:0,delta},
            };
            let mut target=target;
            if matches!(pointer,Pointer::Scroll{..}) && let Some(target)=target.as_mut() {target.session=None;target.input=point;}
            self.cua_pointer_at(pointer,proof,call,cursor,target).await
        }.await;
        resources.cleanup(self).await;
        result.map_err(|error| {
            if resources.mutated.load(std::sync::atomic::Ordering::Relaxed) {
                if let ToolError::Failed(message) = error {
                    unknown(format!(
                        "{message}; DOM input preparation already began; do not replay"
                    ))
                } else {
                    error
                }
            } else {
                error
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_main_projection_does_not_consume_or_renew_the_shared_child_window() {
        let request_started = tokio::time::Instant::now();
        // Simulate a main projection that alone took longer than a child window.
        // Deterministic instants avoid real timers and a test-only Tokio feature.
        let main_completed = request_started + Duration::from_secs(2);
        let mut window = None;
        let first_child = shared_child_deadline(&mut window, main_completed);
        assert!(first_child > main_completed);
        assert_eq!(first_child, main_completed + Duration::from_secs(1));

        let sibling_started = main_completed + Duration::from_millis(900);
        assert_eq!(
            shared_child_deadline(&mut window, sibling_started),
            first_child
        );
        assert!(sibling_started < first_child);
        let descendant_started = main_completed + Duration::from_millis(1100);
        assert_eq!(
            shared_child_deadline(&mut window, descendant_started),
            first_child
        );
        assert!(descendant_started >= first_child);
    }

    #[test]
    fn exact_public_ids_never_alias_numeric_spellings() {
        assert_eq!(reference("17").unwrap(), 17);
        for value in ["", "017", "+17", "1.7e1", "0x11", " 17 "] {
            assert!(reference(value).is_err(), "{value:?}");
        }
    }
    #[test]
    fn clipping_stays_in_the_child_viewport_and_omits_nonintersections() {
        assert_eq!(
            child_clip([100.5, 200.25, 500.5, 600.25], [0.0, 250.0, 300.0, 550.0]),
            Some([0.0, 49.75, 199.5, 349.75])
        );
        assert!(child_clip([1.0, 2.0, 3.0, 4.0], [3.0, 4.0, 9.0, 10.0]).is_none());
    }
    #[test]
    fn escaped_rows_keep_surrogates_and_the_original_utf16_budget() {
        let row: Row = serde_json::from_value(json!({
            "lineJson": r#"<button node_id=__maka_dom_ref__>\ud83d</button>"#,
            "lineLength": "<button node_id=__maka_dom_ref__>".len() + 1 + "</button>".len(),
            "order": 0,
        }))
        .unwrap();
        let (line, length) = row.render(17).unwrap();
        assert_eq!(line, r#"<button node_id=17>\ud83d</button>"#);
        assert_eq!(length, "<button node_id=17>".len() + 1 + "</button>".len());
        assert_ne!(length, line.encode_utf16().count());
        let packet = json!({"json": format!("\"{line}\"")});
        let wire = serde_json::to_string(&packet).unwrap();
        let decoded: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(decoded["json"], r#""<button node_id=17>\ud83d</button>""#);
        assert!(serde_json::from_str::<Value>(decoded["json"].as_str().unwrap()).is_err());
    }

    #[test]
    fn public_reference_replaces_only_the_markup_placeholder() {
        let row = Row {
            line_json: r#"<button node_id=__maka_dom_ref__>__maka_dom_ref__\\ud800</button>"#
                .into(),
            line_length: "<button node_id=__maka_dom_ref__>__maka_dom_ref__\\ud800</button>".len(),
            order: 0,
        };
        let (line, length) = row.render(u64::MAX).unwrap();
        assert_eq!(
            line,
            r#"<button node_id=18446744073709551615>__maka_dom_ref__\\ud800</button>"#
        );
        assert_eq!(
            length,
            "<button node_id=18446744073709551615>__maka_dom_ref__\\ud800</button>".len()
        );
        let invalid = Row {
            line_length: 0,
            ..row
        };
        assert!(invalid.render(1).is_err());
    }
}
