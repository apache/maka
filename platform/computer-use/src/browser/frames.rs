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
use cua_driver_core::browser::cdp_ws::CdpEvent;
use tokio::sync::mpsc;

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq, Eq)]
pub(super) struct Frame {
    pub id: String,
    pub loader: String,
    pub session: Option<String>,
    pub parent: Option<String>,
}

#[derive(Clone)]
struct Child {
    session: String,
    parent: Option<String>,
}

#[derive(Default)]
pub(super) struct Frames {
    enabled: bool,
    pending: std::collections::HashSet<String>,
    events: Option<mpsc::UnboundedReceiver<CdpEvent>>,
    children: HashMap<String, Child>,
}

pub(super) struct Catalog {
    pub tree: Value,
    children: HashMap<String, String>,
}

impl Catalog {
    pub(super) fn main(&self) -> Result<Frame, ToolError> {
        tree_frames(&self.tree, None)
            .into_iter()
            .find(|frame| frame.parent.is_none())
            .ok_or_else(|| failed("main frame identity unavailable"))
    }
}

fn tree_frames(tree: &Value, session: Option<&str>) -> Vec<Frame> {
    let mut frames = Vec::new();
    let _ = collect_frames(tree, session, &mut frames);
    frames
}
fn parent_link(tree: &Value, parent: &str, child: &str) -> bool {
    let mut pending = vec![tree];
    while let Some(node) = pending.pop() {
        if node["frame"]["id"] == child && node["frame"]["parentId"] == parent {
            return true;
        }
        if let Some(children) = node["childFrames"].as_array() {
            if node["frame"]["id"] == parent
                && children.iter().any(|node| node["frame"]["id"] == child)
            {
                return true;
            }
            pending.extend(children);
        }
    }
    false
}

fn scopes_match(used: &[Frame], current: &HashMap<Option<String>, Value>) -> bool {
    for frame in used {
        let Some(tree) = current.get(&frame.session) else {
            return false;
        };
        let Some(candidate) = tree_frames(tree, frame.session.as_deref())
            .into_iter()
            .find(|candidate| candidate.id == frame.id && candidate.loader == frame.loader)
        else {
            return false;
        };
        if let Some(parent) = frame.parent.as_deref() {
            let Some(parent_frame) = used.iter().find(|candidate| candidate.id == parent) else {
                return false;
            };
            // An OOPIF can be absent from its parent's renderer-local tree.
            // Its own current root still reports the actual parentId. Keep
            // that direct edge proof instead of discarding it; an explicit
            // different parent must fail even if another tree is older.
            if let Some(actual) = candidate.parent.as_deref() {
                if actual != parent {
                    return false;
                }
            } else if !current
                .get(&parent_frame.session)
                .is_some_and(|tree| parent_link(tree, parent, &frame.id))
            {
                return false;
            }
        }
    }
    true
}

impl Tab {
    pub(super) async fn frame_observation(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, ToolError> {
        self.socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?
            .observe_in(session, method, params)
            .await
    }
    pub(super) async fn frame_request(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, ToolError> {
        self.socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?
            .request_in(session, method, params)
            .await
    }

    pub(super) async fn attach_frames(&mut self) -> Result<(), ToolError> {
        if self.frames.events.is_none() {
            let connection = &self.socket.as_ref().unwrap().connection;
            self.frames.events = Some(connection.subscribe());
        }
        if !self.frames.enabled {
            self.frame_request(
                None,
                "Target.setAutoAttach",
                json!({
                    "autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true
                }),
            )
            .await?;
            self.frames.enabled = true;
        }
        // Only exact descendants announced on this bound page socket are
        // admitted. Popups, workers and unrelated target inventories never do.
        let mut attached = std::collections::HashSet::new();
        loop {
            while let Ok(event) = self.frames.events.as_mut().unwrap().try_recv() {
                let parent_known = event.session_id.is_none()
                    || self
                        .frames
                        .children
                        .values()
                        .any(|child| Some(&child.session) == event.session_id.as_ref());
                if !parent_known {
                    continue;
                }
                if event.method == "Target.detachedFromTarget" {
                    if let Some(session) = event.params["sessionId"].as_str() {
                        self.frames
                            .children
                            .retain(|_, child| child.session != session);
                        loop {
                            let live: std::collections::HashSet<_> = self
                                .frames
                                .children
                                .values()
                                .map(|child| child.session.clone())
                                .collect();
                            let before = self.frames.children.len();
                            self.frames.children.retain(|_, child| {
                                child
                                    .parent
                                    .as_ref()
                                    .is_none_or(|parent| live.contains(parent))
                            });
                            if before == self.frames.children.len() {
                                break;
                            }
                        }
                    }
                } else if event.method == "Target.attachedToTarget"
                    && event.params["targetInfo"]["type"] == "iframe"
                {
                    let (Some(target), Some(session)) = (
                        event.params["targetInfo"]["targetId"].as_str(),
                        event.params["sessionId"].as_str(),
                    ) else {
                        continue;
                    };
                    if self
                        .frames
                        .children
                        .get(target)
                        .is_none_or(|child| child.session != session)
                    {
                        self.frames.children.insert(
                            target.to_owned(),
                            Child {
                                session: session.to_owned(),
                                parent: event.session_id.clone(),
                            },
                        );
                        self.frames.pending.insert(session.to_owned());
                    }
                }
            }
            let live: std::collections::HashSet<_> = self
                .frames
                .children
                .values()
                .map(|child| child.session.clone())
                .collect();
            self.frames.pending.retain(|session| live.contains(session));
            let mut pending: Vec<_> = self.frames.pending.iter().cloned().collect();
            pending.sort();
            if pending.is_empty() {
                break;
            }
            for session in pending {
                if !attached.insert(session.clone()) {
                    return Err(failed("iframe attachment did not settle"));
                }
                if !self
                    .frames
                    .children
                    .values()
                    .any(|child| child.session == session)
                {
                    continue;
                }
                self.frame_request(
                    Some(&session),
                    "Target.setAutoAttach",
                    json!({
                        "autoAttach":true,"waitForDebuggerOnStart":false,"flatten":true
                    }),
                )
                .await?;
                self.frame_request(Some(&session), "Page.enable", json!({}))
                    .await?;
                self.frames.pending.remove(&session);
            }
        }
        Ok(())
    }

    pub(super) async fn frames(&mut self) -> Result<Vec<Frame>, ToolError> {
        self.attach_frames().await?;
        let main = self
            .frame_request(None, "Page.getFrameTree", json!({}))
            .await?;
        let mut frames = Vec::new();
        collect_frames(&main["frameTree"], None, &mut frames)?;
        let mut children: Vec<_> = self.frames.children.values().cloned().collect();
        children.sort_by(|a, b| a.session.cmp(&b.session));
        for child in children {
            let tree = self
                .frame_request(Some(&child.session), "Page.getFrameTree", json!({}))
                .await?;
            let id = tree["frameTree"]["frame"]["id"]
                .as_str()
                .ok_or_else(|| failed("iframe identity unavailable"))?;
            // Prove an owner in the exact parent renderer, rather than trusting
            // a claimed target id or a renderer-controlled URL.
            self.frame_request(
                child.parent.as_deref(),
                "DOM.getFrameOwner",
                json!({"frameId":id}),
            )
            .await?;
            let mut local = Vec::new();
            collect_frames(&tree["frameTree"], Some(&child.session), &mut local)?;
            for frame in local {
                frames.retain(|old| old.id != frame.id);
                frames.push(frame);
            }
        }
        Ok(frames)
    }

    pub(super) async fn frame_catalog(&mut self) -> Result<Catalog, ToolError> {
        self.attach_frames().await?;
        let tree = self
            .frame_request(None, "Page.getFrameTree", json!({}))
            .await?["frameTree"]
            .clone();
        Ok(Catalog {
            tree,
            children: self
                .frames
                .children
                .iter()
                .map(|(target, child)| (target.clone(), child.session.clone()))
                .collect(),
        })
    }

    pub(super) async fn main_frame(&self) -> Result<Frame, ToolError> {
        let tree = self
            .frame_request(None, "Page.getFrameTree", json!({}))
            .await?;
        tree_frames(&tree["frameTree"], None)
            .into_iter()
            .find(|frame| frame.parent.is_none())
            .ok_or_else(|| failed("main frame identity unavailable"))
    }

    pub(super) async fn resolve_frame(
        &self,
        parent: &Frame,
        backend: u64,
        hint: Option<&str>,
        catalog: &Catalog,
    ) -> Result<Frame, ToolError> {
        let tree = if parent.session.is_none() {
            catalog.tree.clone()
        } else {
            self.frame_request(parent.session.as_deref(), "Page.getFrameTree", json!({}))
                .await?["frameTree"]
                .clone()
        };
        let local = tree_frames(&tree, parent.session.as_deref());
        if !local
            .iter()
            .any(|frame| frame.id == parent.id && frame.loader == parent.loader)
        {
            return Err(failed(
                "parent frame changed while resolving a frame locator",
            ));
        }
        let mut candidates = Vec::new();
        if let Some(hint) = hint {
            candidates.push(hint.to_owned());
        }
        candidates.extend(
            local
                .iter()
                .filter(|frame| frame.parent.as_deref() == Some(parent.id.as_str()))
                .map(|frame| frame.id.clone()),
        );
        candidates.extend(catalog.children.keys().cloned());
        let mut seen = std::collections::HashSet::new();
        for id in candidates {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Ok(owner) = self
                .frame_request(
                    parent.session.as_deref(),
                    "DOM.getFrameOwner",
                    json!({"frameId":id}),
                )
                .await
            else {
                continue;
            };
            if owner["backendNodeId"].as_u64() != Some(backend) {
                continue;
            }
            if let Some(session) = catalog.children.get(&id) {
                let root = self
                    .frame_request(Some(session), "Page.getFrameTree", json!({}))
                    .await?;
                let mut frame = tree_frames(&root["frameTree"], Some(session))
                    .into_iter()
                    .find(|frame| frame.id == id)
                    .ok_or_else(|| failed("iframe target identity changed"))?;
                if frame
                    .parent
                    .as_deref()
                    .is_some_and(|actual| actual != parent.id)
                {
                    return Err(failed("iframe parent changed"));
                }
                frame.parent = Some(parent.id.clone());
                return Ok(frame);
            }
            if let Some(frame) = local
                .iter()
                .find(|frame| frame.id == id && frame.parent.as_deref() == Some(parent.id.as_str()))
            {
                return Ok(frame.clone());
            }
            return Err(failed("iframe renderer is not attached"));
        }
        Err(failed(
            "frame target is not available for this iframe selector",
        ))
    }

    pub(super) async fn frame_scopes_current(&self, used: &[Frame]) -> Result<bool, ToolError> {
        let mut sessions = Vec::new();
        for frame in used {
            if !sessions.contains(&frame.session) {
                sessions.push(frame.session.clone());
            }
        }
        let trees =
            futures_util::future::join_all(sessions.iter().map(|session| {
                self.frame_request(session.as_deref(), "Page.getFrameTree", json!({}))
            }))
            .await;
        let mut current = HashMap::new();
        for (session, tree) in sessions.into_iter().zip(trees) {
            current.insert(session, tree?["frameTree"].clone());
        }
        Ok(scopes_match(used, &current))
    }

    pub(super) async fn verify_element(
        &mut self,
        index: u64,
        language: Language,
    ) -> Result<DomElement, ToolError> {
        let element = self.refs.get(&index).cloned().ok_or_else(|| {
            failed(match language {
                Language::En => "stale_element: read getAXState first",
                Language::ZhCn => "stale_element: 请先读取 getAXState",
                Language::ZhTw => "stale_element: 請先讀取 getAXState",
            })
        })?;
        let element = match element {
            ElementRef::Dom(element) => element,
            ElementRef::Dialog(_) => {
                return Err(failed(
                    "JavaScript dialog is no longer active; observe again",
                ));
            }
        };
        let frame = element
            .frame
            .as_ref()
            .ok_or_else(|| failed("element frame was not proven"))?;
        if !self.frames().await?.contains(frame) {
            self.refs.clear();
            return Err(failed(match language {
                Language::En => "stale_element: frame navigated or detached; observe again",
                Language::ZhCn => "stale_element: 框架已导航或分离；请重新观察",
                Language::ZhTw => "stale_element: 框架已導覽或分離；請重新觀察",
            }));
        }
        Ok(element)
    }

    pub(super) async fn element_extent(
        &mut self,
        index: u64,
        horizontal: bool,
        language: Language,
    ) -> Result<f64, ToolError> {
        let element = self.verify_element(index, language).await?;
        let frame = element
            .frame
            .as_ref()
            .ok_or_else(|| failed("element frame was not proven"))?;
        let quads = self
            .frame_request(
                frame.session.as_deref(),
                "DOM.getContentQuads",
                json!({"backendNodeId":element.backend}),
            )
            .await?;
        let quad = quads["quads"]
            .get(0)
            .and_then(Value::as_array)
            .filter(|quad| quad.len() >= 8)
            .ok_or_else(|| failed("element has no content bounds"))?;
        let values = [0, 2, 4, 6].map(|offset| {
            quad[offset + usize::from(!horizontal)]
                .as_f64()
                .filter(|value| value.is_finite())
                .ok_or_else(|| failed("element has invalid content bounds"))
        });
        let [a, b, c, d] = values;
        let points = [a?, b?, c?, d?];
        let minimum = points.iter().copied().fold(f64::INFINITY, f64::min);
        let maximum = points.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        Ok(maximum - minimum)
    }

    pub(super) async fn element_point(
        &mut self,
        index: u64,
        scroll: bool,
        cancellation: &tokio_util::sync::CancellationToken,
        language: Language,
    ) -> Result<[f64; 2], ToolError> {
        let element = self.verify_element(index, language).await?;
        let value=self.call_element(index,"function(scroll){if(!this.isConnected||this.disabled)throw Error('element unavailable');if(scroll)this.scrollIntoView({block:'center',inline:'center'});const r=this.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;const hit=this.getRootNode().elementFromPoint(x,y);if(r.width<=0||r.height<=0||!(hit===this||this.contains(hit)))throw Error('element occluded');return {point:[x,y],width:this.ownerDocument.defaultView.innerWidth,height:this.ownerDocument.defaultView.innerHeight};}",vec![json!(scroll)],cancellation, language).await?;
        let mut point: [f64; 2] = serde_json::from_value(value["point"].clone()).map_err(failed)?;
        let mut width = value["width"]
            .as_f64()
            .ok_or_else(|| failed("frame width unavailable"))?;
        let mut height = value["height"]
            .as_f64()
            .ok_or_else(|| failed("frame height unavailable"))?;
        let frames = self.frames().await?;
        let mut frame = element
            .frame
            .clone()
            .ok_or_else(|| failed("element frame was not proven"))?;
        let mut ancestors = std::collections::HashSet::new();
        loop {
            if !ancestors.insert(frame.id.clone()) {
                return Err(failed("cyclic iframe ancestry"));
            }
            let Some(parent) = frame.parent.as_ref() else {
                return Ok(point);
            };
            let parent = frames
                .iter()
                .find(|f| &f.id == parent)
                .ok_or_else(|| failed("frame parent unavailable"))?
                .clone();
            let owner = self
                .frame_request(
                    parent.session.as_deref(),
                    "DOM.getFrameOwner",
                    json!({"frameId":frame.id}),
                )
                .await?;
            let backend = owner["backendNodeId"]
                .as_u64()
                .ok_or_else(|| failed("frame owner unavailable"))?;
            let resolved = self
                .frame_request(
                    parent.session.as_deref(),
                    "DOM.resolveNode",
                    json!({"backendNodeId":backend,"objectGroup":"maka-cua"}),
                )
                .await?;
            let object = resolved["object"]["objectId"]
                .as_str()
                .ok_or_else(|| failed("iframe owner detached"))?;
            let checked=self.frame_request(parent.session.as_deref(),"Runtime.callFunctionOn",json!({
                "objectId":object,"functionDeclaration":"function(x,y,width,height){if(!this.isConnected)throw Error('iframe owner detached');for(let node=this;node;node=node.assignedSlot??node.parentElement??node.getRootNode().host){const style=getComputedStyle(node);if(style.transform!=='none'||style.rotate!=='none'||style.scale!=='none'||style.translate!=='none')throw Error('transformed iframe input unavailable; use a tab screenshot');}const r=this.getBoundingClientRect(),sx=r.width/this.offsetWidth,sy=r.height/this.offsetHeight;const px=r.x+this.clientLeft*sx+x/width*this.clientWidth*sx,py=r.y+this.clientTop*sy+y/height*this.clientHeight*sy;const hit=this.getRootNode().elementFromPoint(px,py);if(hit!==this)throw Error('iframe owner occluded');return {point:[px,py],width:this.ownerDocument.defaultView.innerWidth,height:this.ownerDocument.defaultView.innerHeight};}",
                "arguments":[{"value":point[0]},{"value":point[1]},{"value":width},{"value":height}],"returnByValue":true
            })).await?;
            if let Some(details) = checked.get("exceptionDetails") {
                let guidance = match language {
                    Language::En => {
                        "iframe owner occluded, transformed or detached; use a fresh tab screenshot"
                    }
                    Language::ZhCn => "iframe 所属元素被遮挡、变换或分离；请重新获取标签页截图",
                    Language::ZhTw => "iframe 所屬元素被遮擋、變換或分離；請重新取得分頁擷取畫面",
                };
                return Err(failed(format!("{details}\n{guidance}")));
            }
            let checked = &checked["result"]["value"];
            point = serde_json::from_value(checked["point"].clone()).map_err(failed)?;
            width = checked["width"]
                .as_f64()
                .ok_or_else(|| failed("parent viewport unavailable"))?;
            height = checked["height"]
                .as_f64()
                .ok_or_else(|| failed("parent viewport unavailable"))?;
            if !point.iter().all(|v| v.is_finite()) || width <= 0.0 || height <= 0.0 {
                return Err(failed("iframe geometry unavailable"));
            }
            frame = parent;
        }
    }
}

fn collect_frames(
    tree: &Value,
    session: Option<&str>,
    frames: &mut Vec<Frame>,
) -> Result<(), ToolError> {
    let mut pending = vec![tree];
    while let Some(tree) = pending.pop() {
        let raw = &tree["frame"];
        if let (Some(id), Some(loader)) = (raw["id"].as_str(), raw["loaderId"].as_str()) {
            frames.push(Frame {
                id: id.into(),
                loader: loader.into(),
                session: session.map(str::to_owned),
                parent: raw["parentId"].as_str().map(str::to_owned),
            });
        }
        if let Some(children) = tree["childFrames"].as_array() {
            pending.extend(children.iter().rev());
        }
    }
    Ok(())
}

#[cfg(test)]
mod scope_tests {
    use super::*;

    #[test]
    fn oopif_root_parent_proves_an_edge_omitted_from_the_parent_tree() {
        let root = Frame {
            id: "main".into(),
            loader: "main-document".into(),
            session: None,
            parent: None,
        };
        let child = Frame {
            id: "remote".into(),
            loader: "remote-document".into(),
            session: Some("remote-session".into()),
            parent: Some("main".into()),
        };
        let used = [root.clone(), child.clone()];
        let root_tree = json!({"frame":{"id":"main","loaderId":"main-document"}});
        let child_tree =
            json!({"frame":{"id":"remote","loaderId":"remote-document","parentId":"main"}});
        let mut current = HashMap::from([
            (None, root_tree.clone()),
            (child.session.clone(), child_tree.clone()),
        ]);
        assert!(!parent_link(&root_tree, "main", "remote"));
        assert!(scopes_match(&used, &current));

        current.get_mut(&child.session).unwrap()["frame"]["loaderId"] = json!("replacement");
        assert!(
            !scopes_match(&used, &current),
            "child loader fence was lost"
        );
        current.insert(child.session.clone(), child_tree.clone());
        current.get_mut(&None).unwrap()["frame"]["loaderId"] = json!("replacement");
        assert!(
            !scopes_match(&used, &current),
            "parent loader fence was lost"
        );
        current.insert(None, root_tree.clone());
        current.get_mut(&child.session).unwrap()["frame"]["parentId"] = json!("sibling");
        assert!(!scopes_match(&used, &current), "wrong parent was admitted");
        current.insert(child.session.clone(), child_tree);
        current.get_mut(&child.session).unwrap()["frame"]
            .as_object_mut()
            .unwrap()
            .remove("parentId");
        assert!(
            !scopes_match(&used, &current),
            "missing edge proof was admitted"
        );

        current.get_mut(&None).unwrap()["childFrames"] = json!([
            {"frame":{"id":"remote","loaderId":"remote-document","parentId":"main"}}
        ]);
        assert!(
            scopes_match(&used, &current),
            "parent-tree proof must still work"
        );
        current.get_mut(&child.session).unwrap()["frame"]["parentId"] = json!("sibling");
        assert!(
            !scopes_match(&used, &current),
            "explicit wrong parent must win"
        );
        assert!(
            !scopes_match(&[child], &current),
            "untracked parent was admitted"
        );
    }
}
