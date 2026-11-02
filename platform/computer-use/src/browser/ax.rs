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

use super::{DomElement, ElementRef, dialogs::ActiveDialog, failed};
use cua_driver_core::browser::JsonStringLiteral;
use maka_agent_facts::{language::Language, tools::ToolError};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

// Indices identify nodes, not their current row positions. Removed indices
// cannot acquire a new meaning, including after navigation or reconnection.
#[derive(Default)]
pub(super) struct Projection {
    document: String,
    indices: HashMap<String, u64>,
    next: u64,
}

impl Projection {
    pub(super) fn begin_dom(&mut self, document: &str) {
        if self.document != document {
            self.document = document.into();
            self.indices.clear();
        }
        if self
            .indices
            .keys()
            .filter(|key| key.starts_with("dom-cua:"))
            .count()
            > 5_000
        {
            self.indices.retain(|key, _| !key.starts_with("dom-cua:"));
        }
    }
    pub(super) fn dom_reference(
        &mut self,
        document: &str,
        element: &DomElement,
    ) -> Result<u64, ToolError> {
        if self.document != document {
            self.document = document.into();
            self.indices.clear();
        }
        let frame = element
            .frame
            .as_ref()
            .ok_or_else(|| failed("DOM node lacks its frame identity"))?;
        let key = format!("dom-cua:{}:{}:{}", frame.id, frame.loader, element.backend);
        if let Some(index) = self.indices.get(&key) {
            return Ok(*index);
        }
        // DOM CUA exposes nonempty decimal strings; retain the one existing
        // monotonic allocator so a retired AX/DOM reference cannot alias.
        self.next = self.next.max(1);
        let index = self.next;
        self.next = index
            .checked_add(1)
            .filter(|next| *next <= 9_007_199_254_740_991)
            .ok_or_else(|| failed("browser reference index limit reached; reset Cua"))?;
        self.indices.insert(key, index);
        Ok(index)
    }
    pub(super) fn render(
        &mut self,
        document: &str,
        nodes: &[Value],
        language: Language,
    ) -> Result<(String, HashMap<u64, ElementRef>), ToolError> {
        self.render_nodes(document, nodes, None, language)
    }

    // Only this trusted synthetic tree can supply an already quoted root name.
    // Ordinary CDP nodes cannot select this path using a field or a node ID.
    pub(super) fn render_dialog(
        &mut self,
        document: &str,
        dialog: &ActiveDialog,
        title: &JsonStringLiteral,
        language: Language,
    ) -> Result<(String, HashMap<u64, ElementRef>), ToolError> {
        if let Ok(title) = title.strict_scalar() {
            return self.render(document, &dialog.ax_nodes(&title), language);
        }
        // This internal empty name has no output authority. The actual title
        // remains the validated literal, inserted at the existing quoted slot.
        let nodes = dialog.ax_nodes("");
        let root = format!("javascript-dialog:{}:root", dialog.metadata.id);
        self.render_nodes(
            document,
            &nodes,
            Some(DialogRootName { id: &root, title }),
            language,
        )
    }

    fn render_nodes(
        &mut self,
        document: &str,
        nodes: &[Value],
        dialog_root_name: Option<DialogRootName<'_>>,
        language: Language,
    ) -> Result<(String, HashMap<u64, ElementRef>), ToolError> {
        if self.document != document {
            self.document = document.to_owned();
            self.indices.clear();
        }
        let nodes: HashMap<&str, &Value> = nodes
            .iter()
            .filter_map(|node| Some((node["nodeId"].as_str()?, node)))
            .collect();
        let mut walk = Walk {
            projection: self,
            nodes: &nodes,
            seen: HashSet::new(),
            retained: HashSet::new(),
            rows: Vec::new(),
            refs: HashMap::new(),
            dialog_root_name,
        };
        // CDP supplies parents before children. Sort root IDs for a stable
        // presentation rather than relying on HashMap iteration order.
        let mut roots: Vec<_> = nodes
            .iter()
            .filter(|(_, node)| {
                node["parentId"]
                    .as_str()
                    .is_none_or(|id| !nodes.contains_key(id))
            })
            .map(|(id, _)| *id)
            .collect();
        roots.sort_unstable();
        for root in roots {
            walk.visit(root, 0, "", language)?;
        }
        walk.projection
            .indices
            .retain(|key, _| key.starts_with("dom-cua:") || walk.retained.contains(key));
        Ok((walk.rows.join("\n"), walk.refs))
    }
}

struct DialogRootName<'a> {
    id: &'a str,
    title: &'a JsonStringLiteral,
}

// serde_json's byte visitor decodes JSON strings to WTF-8, preserving lone
// surrogate units. JSON parsing and escape validation stay in that library.
fn canonical_dialog_name(title: &JsonStringLiteral) -> Result<String, ToolError> {
    struct Bytes;
    impl<'de> serde::de::Visitor<'de> for Bytes {
        type Value = Vec<u8>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a JSON string")
        }

        fn visit_bytes<E: serde::de::Error>(self, bytes: &[u8]) -> Result<Self::Value, E> {
            Ok(bytes.to_vec())
        }
    }

    let mut deserializer = serde_json::Deserializer::from_str(title.json());
    let bytes = serde::Deserializer::deserialize_bytes(&mut deserializer, Bytes).map_err(failed)?;
    let mut remaining = bytes.as_slice();
    let mut quoted = String::from("\"");
    while !remaining.is_empty() {
        let (scalar, rest) = match std::str::from_utf8(remaining) {
            Ok(scalar) => (scalar, &[][..]),
            Err(error) => {
                let (scalar, rest) = remaining.split_at(error.valid_up_to());
                (std::str::from_utf8(scalar).map_err(failed)?, rest)
            }
        };
        let encoded = serde_json::to_string(scalar).map_err(failed)?;
        // A serialized str always has these two ASCII quote delimiters.
        quoted.push_str(&encoded[1..encoded.len() - 1]);
        if rest.is_empty() {
            break;
        }
        match rest {
            [0xed, second @ 0xa0..=0xbf, third @ 0x80..=0xbf, tail @ ..] => {
                let unit = 0xd000 | (u16::from(*second & 0x3f) << 6) | u16::from(*third & 0x3f);
                quoted.push_str(&format!("\\u{unit:04x}"));
                remaining = tail;
            }
            _ => return Err(failed("decoded dialog title contains invalid WTF-8")),
        }
    }
    quoted.push('"');
    Ok(quoted)
}

struct Walk<'a> {
    projection: &'a mut Projection,
    nodes: &'a HashMap<&'a str, &'a Value>,
    seen: HashSet<&'a str>,
    retained: HashSet<String>,
    rows: Vec<String>,
    refs: HashMap<u64, ElementRef>,
    dialog_root_name: Option<DialogRootName<'a>>,
}
impl<'a> Walk<'a> {
    fn visit(
        &mut self,
        id: &'a str,
        depth: usize,
        parent_name: &'a str,
        language: Language,
    ) -> Result<(), ToolError> {
        let mut pending = vec![(id, depth, parent_name)];
        while let Some((id, depth, parent_name)) = pending.pop() {
            if !self.seen.insert(id) {
                continue;
            }
            let Some(node) = self.nodes.get(id).copied() else {
                continue;
            };
            let role = node["role"]["value"].as_str().unwrap_or("unknown");
            if role == "InlineTextBox" {
                continue;
            }
            let name = node["name"]["value"].as_str().unwrap_or("");
            let content = &node["value"]["value"];
            let transparent = node["ignored"] == true
                || (matches!(role, "generic" | "none" | "LabelText")
                    && name.is_empty()
                    && node["actions"].as_array().is_none_or(Vec::is_empty))
                || (role == "StaticText" && !name.is_empty() && name == parent_name);
            let mut child_depth = depth;
            if !transparent {
                let scope = node["makaFrame"]
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let loader = node["makaFrame"]
                    .get("loader")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let identity = node["backendDOMNodeId"]
                    .as_u64()
                    .map(|id| format!("{scope}:{loader}:dom:{id}"))
                    .unwrap_or_else(|| format!("ax:{id}"));
                let index = if let Some(index) = self.projection.indices.get(&identity) {
                    *index
                } else {
                    let index = self.projection.next;
                    self.projection.next = index
                        .checked_add(1)
                        .filter(|next| *next <= 9_007_199_254_740_991)
                        .ok_or_else(|| {
                            failed(match language {
                                Language::En => "accessibility index limit reached; reset Cua",
                                Language::ZhCn => "无障碍索引数已达上限；请重置 Cua",
                                Language::ZhTw => "輔助使用索引數已達上限；請重設 Cua",
                            })
                        })?;
                    self.projection.indices.insert(identity.clone(), index);
                    index
                };
                self.retained.insert(identity);
                if let Some(dialog) = node.get("makaDialog") {
                    self.refs.insert(
                        index,
                        ElementRef::Dialog(serde_json::from_value(dialog.clone()).map_err(failed)?),
                    );
                } else if let Some(backend) = node["backendDOMNodeId"].as_u64() {
                    self.refs.insert(
                        index,
                        ElementRef::Dom(DomElement {
                            backend,
                            frame: serde_json::from_value(node["makaFrame"].clone()).ok(),
                        }),
                    );
                }
                let quoted_name = if let Some(root) = self
                    .dialog_root_name
                    .as_ref()
                    .filter(|root| root.id == id && role == "RootWebArea")
                {
                    canonical_dialog_name(root.title)?
                } else {
                    json!(name).to_string()
                };
                let mut row = format!("{}{index} {role} {quoted_name}", "  ".repeat(depth));
                if !content.is_null() && content != "" {
                    row.push_str(&format!(" value={content}"));
                }
                if let Some(actions) = node
                    .get("actions")
                    .filter(|value| value.as_array().is_some_and(|actions| !actions.is_empty()))
                {
                    row.push_str(&format!(" actions={actions}"));
                }
                if let Some(properties) = node["properties"].as_array() {
                    for property in properties {
                        let key = property["name"].as_str().unwrap_or("");
                        let value = &property["value"]["value"];
                        match key {
                            "disabled" | "focused" | "readonly" | "required" | "busy"
                                if value == true =>
                            {
                                row.push_str(&format!(" [{key}]"));
                            }
                            "checked" | "selected" | "expanded" if !value.is_null() => {
                                row.push_str(&format!(" [{key}={value}]"));
                            }
                            _ => {}
                        }
                    }
                }
                self.rows.push(row);
                child_depth += 1;
            }
            let child_name = if transparent { parent_name } else { name };
            if let Some(children) = node["childIds"].as_array() {
                for child in children.iter().rev() {
                    if let Some(child) = child.as_str() {
                        pending.push((child, child_depth, child_name));
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    fn dialog_fixture() -> (super::super::dialogs::Dialogs, ActiveDialog) {
        use super::super::dialogs::{DialogEvent, DialogTarget, DialogType, Dialogs};
        let dialogs = Dialogs::default();
        dialogs
            .observe(DialogEvent::Opening {
                target: DialogTarget { session: None },
                kind: DialogType::Prompt,
                message: "Fixture message".into(),
                default_prompt: "Default response".into(),
                url: "https://fixture.example/".into(),
            })
            .unwrap();
        let dialog = dialogs.current().unwrap();
        (dialogs, dialog)
    }

    fn dialog_refs(refs: &HashMap<u64, ElementRef>) -> std::collections::BTreeMap<u64, Value> {
        refs.iter()
            .map(|(&index, reference)| match reference {
                ElementRef::Dialog(reference) => (index, serde_json::to_value(reference).unwrap()),
                ElementRef::Dom(_) | ElementRef::DomCua(_) => {
                    panic!("synthetic dialog produced a DOM reference")
                }
            })
            .collect()
    }

    #[test]
    fn dialog_scalar_titles_keep_the_original_ax_bytes_and_control_references() {
        let (_, dialog) = dialog_fixture();
        for literal in [
            r#""ordinary""#,
            r#""\u0041""#,
            r#""\"quoted\" \\path\nnext\tline\r\u0000""#,
            r#""emoji \ud83d\ude00 é""#,
            r#""literal \\ud800""#,
        ] {
            let title = JsonStringLiteral::parse(literal.into()).unwrap();
            let scalar = title.strict_scalar().unwrap();
            let (old, old_refs) = Projection::default()
                .render("dialog", &dialog.ax_nodes(&scalar), Language::En)
                .unwrap();
            let (current, current_refs) = Projection::default()
                .render_dialog("dialog", &dialog, &title, Language::En)
                .unwrap();
            assert_eq!(current.as_bytes(), old.as_bytes(), "{literal}");
            assert_eq!(dialog_refs(&current_refs), dialog_refs(&old_refs));
            assert_eq!(
                current,
                format!(
                    "0 RootWebArea {}\n  1 alertdialog \"fixture.example says\"\n    2 StaticText \"Fixture message\"\n    3 textbox \"Response\" value=\"Default response\" [focused]\n    4 button \"Cancel\"\n    5 button \"OK\"",
                    json!(scalar)
                ),
                "{literal}"
            );
        }
    }

    #[test]
    fn dialog_utf16_quoted_root_keeps_rows_refs_modal_state_and_page_isolation() {
        let (dialogs, dialog) = dialog_fixture();
        let title = JsonStringLiteral::parse(
            "\n  \"\\ud800 title \\udc00 \\\\ud800 \\u0041 😀\" \r\n".into(),
        )
        .unwrap();
        assert!(title.strict_scalar().is_err());
        let (baseline, baseline_refs) = Projection::default()
            .render("dialog", &dialog.ax_nodes(""), Language::En)
            .unwrap();
        let mut projection = Projection::default();
        let (state, refs) = projection
            .render_dialog("dialog", &dialog, &title, Language::En)
            .unwrap();
        assert_eq!(
            state.lines().next(),
            Some(r#"0 RootWebArea "\ud800 title \udc00 \\ud800 A 😀""#)
        );
        assert_eq!(
            state.lines().skip(1).collect::<Vec<_>>(),
            baseline.lines().skip(1).collect::<Vec<_>>()
        );
        assert_eq!(dialog_refs(&refs), dialog_refs(&baseline_refs));
        assert_eq!(refs.len(), 3, "prompt, dismiss and accept controls survive");
        let (again, again_refs) = projection
            .render_dialog("dialog", &dialog, &title, Language::En)
            .unwrap();
        assert_eq!(again, state);
        assert_eq!(dialog_refs(&again_refs), dialog_refs(&refs));
        assert!(dialogs.check_method("Input.dispatchMouseEvent").is_err());
        assert!(dialogs.check_method("Page.handleJavaScriptDialog").is_ok());
        assert_eq!(dialogs.current().unwrap().metadata.id, dialog.metadata.id);

        let page = json!([{
            "nodeId":format!("javascript-dialog:{}:root", dialog.metadata.id),
            "role":{"value":"RootWebArea"},
            "name":{"value":"Actual page name"},
            "titleJson":title,
            "dialog_root_name":"untrusted page field"
        }]);
        let (page_state, _) = Projection::default()
            .render("page", page.as_array().unwrap(), Language::En)
            .unwrap();
        assert_eq!(page_state, "0 RootWebArea \"Actual page name\"");
    }

    #[test]
    fn dialog_lexical_aliases_keep_identical_final_state_and_no_accessibility_diff() {
        let (_, dialog) = dialog_fixture();
        for (first, alias, expected) in [
            (r#""A\ud800""#, r#""\u0041\uD800""#, r#""A\ud800""#),
            (r#""\/\u000A\ud800""#, r#""/\n\uD800""#, r#""/\n\ud800""#),
            (r#""😀\ud800""#, r#""\ud83d\ude00\uD800""#, r#""😀\ud800""#),
            (r#""\ud800A""#, r#""\uD800\u0041""#, r#""\ud800A""#),
            (
                r#""\ud800\ud800""#,
                r#""\uD800\uD800""#,
                r#""\ud800\ud800""#,
            ),
            (r#""\udc00""#, r#""\uDC00""#, r#""\udc00""#),
            (
                r#""\ud800\\ud800""#,
                r#""\uD800\u005cud800""#,
                r#""\ud800\\ud800""#,
            ),
            (
                r#""\ud800\b\f\r\t\u0000""#,
                r#""\uD800\u0008\u000c\u000d\u0009\u0000""#,
                r#""\ud800\b\f\r\t\u0000""#,
            ),
        ] {
            let first = JsonStringLiteral::parse(first.into()).unwrap();
            let alias = JsonStringLiteral::parse(alias.into()).unwrap();
            assert!(first.strict_scalar().is_err());
            assert!(alias.strict_scalar().is_err());
            let mut projection = Projection::default();
            let (state, refs) = projection
                .render_dialog("dialog", &dialog, &first, Language::En)
                .unwrap();
            let (alias_state, alias_refs) = projection
                .render_dialog("dialog", &dialog, &alias, Language::En)
                .unwrap();
            assert_eq!(state, alias_state);
            assert_eq!(dialog_refs(&refs), dialog_refs(&alias_refs));
            let expected_root = format!("0 RootWebArea {expected}");
            assert_eq!(state.lines().next(), Some(expected_root.as_str()));
            assert_eq!(
                crate::session::display_diff(Some(&state), &alias_state, Language::En),
                "Accessibility state unchanged."
            );
        }

        // The existing AX formatter has no 160-unit title clipping. A lone
        // unit at that boundary and every following unit must remain visible.
        let prefix = "x".repeat(159);
        let title = JsonStringLiteral::parse(format!(
            "\"{prefix}\\uD800\\u0041\\udc00\\ud83d\\ude00\\u000a\""
        ))
        .unwrap();
        let (state, refs) = Projection::default()
            .render_dialog("dialog", &dialog, &title, Language::En)
            .unwrap();
        let expected_root = format!("0 RootWebArea \"{prefix}\\ud800A\\udc00😀\\n\"");
        assert_eq!(state.lines().next(), Some(expected_root.as_str()));
        assert_eq!(state.lines().count(), 6);
        assert_eq!(refs.len(), 3);

        let controls: String = (0u8..=31).map(char::from).collect();
        let scalar_json = serde_json::to_string(&controls).unwrap();
        let escaped_controls: String = (0u16..=31).map(|unit| format!("\\u{unit:04X}")).collect();
        let title = JsonStringLiteral::parse(format!("\"{escaped_controls}\\uD800\"")).unwrap();
        assert_eq!(
            canonical_dialog_name(&title).unwrap(),
            format!("{}\\ud800\"", &scalar_json[..scalar_json.len() - 1])
        );
        let edge_scalars = serde_json::to_string("\u{10ffff}\u{2028}\u{2029}\u{ffff}").unwrap();
        let title =
            JsonStringLiteral::parse(r#""\udbff\udfff\u2028\u2029\uffff\uD800""#.into()).unwrap();
        assert_eq!(
            canonical_dialog_name(&title).unwrap(),
            format!("{}\\ud800\"", &edge_scalars[..edge_scalars.len() - 1])
        );
    }

    #[test]
    fn dom_and_ax_share_monotonic_indices_without_reinterpreting_retired_handles() {
        let mut projection = Projection::default();
        let element = DomElement {
            backend: 11,
            frame: Some(super::super::frames::Frame {
                id: "main".into(),
                loader: "one".into(),
                session: None,
                parent: None,
            }),
        };
        let dom = projection.dom_reference("main:one", &element).unwrap();
        assert_eq!(dom, 1);
        let nodes = vec![
            json!({"nodeId":"ax","backendDOMNodeId":12,"makaFrame":element.frame,"role":{"value":"button"},"name":{"value":"Next"}}),
        ];
        let (_, refs) = projection.render("main:one", &nodes, Language::En).unwrap();
        assert!(refs.keys().all(|id| *id > dom));
        assert_eq!(projection.dom_reference("main:one", &element).unwrap(), dom);
        let fresh = projection.dom_reference("main:two", &element).unwrap();
        assert!(fresh > dom);
    }
    #[test]
    fn complete_deep_accessibility_tree_keeps_original_descendant_indices() {
        let nodes=(0..70).map(|index| {
            let mut node=json!({"nodeId":index.to_string(),"backendDOMNodeId":index+1,"role":{"value":"button"},"name":{"value":format!("Node {index}")}});
            if index>0 {node["parentId"]=json!((index-1).to_string());}
            if index<69 {node["childIds"]=json!([(index+1).to_string()]);}
            node
        }).collect::<Vec<_>>();
        let mut projection = Projection::default();
        let (state, refs) = projection.render("original", &nodes, Language::En).unwrap();
        assert_eq!(refs.len(), 70);
        assert!(
            state.ends_with("button \"Node 69\""),
            "complete deepest descendant must remain visible"
        );
        let index = *refs
            .iter()
            .find(|(_, value)| matches!(value,ElementRef::Dom(element) if element.backend==70))
            .unwrap()
            .0;
        let (_, again) = projection.render("original", &nodes, Language::En).unwrap();
        assert!(matches!(&again[&index],ElementRef::Dom(element) if element.backend==70));
    }

    use super::*;

    #[test]
    fn projection_preserves_decision_state_and_never_reassigns_removed_indices() {
        let mut projection = Projection::default();
        let tree = json!([
            {"nodeId":"1","role":{"value":"RootWebArea"},"name":{"value":"Form"},"childIds":["2","3"]},
            {"nodeId":"2","parentId":"1","backendDOMNodeId":10,"role":{"value":"button"},"name":{"value":"Delete"},"childIds":["4"],"properties":[{"name":"disabled","value":{"value":true}}]},
            {"nodeId":"3","parentId":"1","backendDOMNodeId":11,"role":{"value":"textbox"},"name":{"value":"Name"},"value":{"value":"你好\nvalue"},"properties":[{"name":"focused","value":{"value":true}}]},
            {"nodeId":"4","parentId":"2","role":{"value":"StaticText"},"name":{"value":"Delete"},"childIds":["5"]},
            {"nodeId":"5","parentId":"4","role":{"value":"InlineTextBox"},"name":{"value":"Delete"}}
        ]);
        let (state, refs) = projection
            .render("document1", tree.as_array().unwrap(), Language::En)
            .unwrap();
        assert_eq!(state.lines().count(), 3, "{state}");
        assert!(
            state.contains("  1 button \"Delete\" [disabled]"),
            "{state}"
        );
        assert!(
            state.contains("value=\"你好\\nvalue\" [focused]"),
            "{state}"
        );
        let removed = *refs
            .iter()
            .find(|(_, value)| matches!(value,ElementRef::Dom(element) if element.backend==10))
            .unwrap()
            .0;
        let mut replacement = tree.as_array().unwrap().clone();
        replacement.retain(|node| !matches!(node["nodeId"].as_str(), Some("2" | "4" | "5")));
        replacement[0]["childIds"] = json!(["3", "6"]);
        replacement.push(json!({"nodeId":"6","parentId":"1","backendDOMNodeId":12,"role":{"value":"button"},"name":{"value":"Submit"}}));
        let (_, fresh) = projection
            .render("document1", &replacement, Language::En)
            .unwrap();
        assert!(!fresh.contains_key(&removed));
        assert!(matches!(fresh.get(&2),Some(ElementRef::Dom(element)) if element.backend==11));
        let (_, navigated) = projection
            .render("document2", tree.as_array().unwrap(), Language::En)
            .unwrap();
        assert!(navigated.keys().all(|key| !fresh.contains_key(key)));
    }
}
