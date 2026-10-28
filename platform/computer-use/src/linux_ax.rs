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

//! Epoch-owned display aliases and the Linux accessibility text view.

use platform_linux::atspi::native_ax::{NativeAxRow, NativeAxSnapshot, NativeAxSource};
use std::collections::HashMap;
use std::fmt::{self, Display, Write};

#[derive(Clone, Copy)]
pub(crate) enum ReadCoverage {
    Full,
    Filtered,
}

impl ReadCoverage {
    pub(crate) fn for_query(query: Option<&str>) -> Self {
        match query {
            Some(query) if !query.trim_matches(js_whitespace).is_empty() => Self::Filtered,
            _ => Self::Full,
        }
    }
}

#[derive(Clone, Default)]
struct WindowIds {
    native_to_public: HashMap<String, String>,
    insertion_order: Vec<String>,
}

/// One owner per interpreter epoch; aliases never authorize native actions.
#[derive(Default)]
pub(crate) struct ElementIds {
    next_id: f64,
    windows: HashMap<u64, WindowIds>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct UnknownElementId(String);

impl Display for UnknownElementId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Unknown element ID {} for this window; refresh get_window_state()",
            self.0
        )
    }
}

impl std::error::Error for UnknownElementId {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum InvalidSnapshot {
    ParentNotBeforeChild {
        row: usize,
        parent: usize,
    },
    ParentDepthNotLess {
        row: usize,
        parent: usize,
        parent_depth: usize,
        depth: usize,
    },
}

impl Display for InvalidSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ParentNotBeforeChild { row, parent } => write!(
                formatter,
                "invalid native AX snapshot: row {row} parent {parent} must precede the child"
            ),
            Self::ParentDepthNotLess {
                row,
                parent,
                parent_depth,
                depth,
            } => write!(
                formatter,
                "invalid native AX snapshot: row {row} depth {depth} must exceed parent {parent} depth {parent_depth}"
            ),
        }
    }
}

impl std::error::Error for InvalidSnapshot {}

pub(crate) fn validate_snapshot(snapshot: &NativeAxSnapshot) -> Result<(), InvalidSnapshot> {
    for (index, row) in snapshot.rows.iter().enumerate() {
        if let Some(parent) = row.parent {
            if parent >= index {
                return Err(InvalidSnapshot::ParentNotBeforeChild { row: index, parent });
            }
            let parent_depth = snapshot.rows[parent].depth;
            if parent_depth >= row.depth {
                return Err(InvalidSnapshot::ParentDepthNotLess {
                    row: index,
                    parent,
                    parent_depth,
                    depth: row.depth,
                });
            }
        }
    }
    Ok(())
}

impl ElementIds {
    pub(crate) fn assign<'a>(
        &mut self,
        window_id: u64,
        snapshot: &'a NativeAxSnapshot,
        coverage: ReadCoverage,
    ) -> PublicSnapshot<'a> {
        let previous = self.windows.remove(&window_id).unwrap_or_default();
        let mut current = match coverage {
            ReadCoverage::Full => WindowIds::default(),
            ReadCoverage::Filtered => previous.clone(),
        };
        let ids = snapshot
            .rows
            .iter()
            .map(|row| {
                if let Some(id) = current.native_to_public.get(&row.native_id) {
                    return id.clone();
                }
                let id = previous
                    .native_to_public
                    .get(&row.native_id)
                    .cloned()
                    .unwrap_or_else(|| {
                        let id = self.next_id.to_string();
                        self.next_id += 1.0;
                        id
                    });
                current.insertion_order.push(row.native_id.clone());
                current
                    .native_to_public
                    .insert(row.native_id.clone(), id.clone());
                id
            })
            .collect();
        self.windows.insert(window_id, current);
        PublicSnapshot { snapshot, ids }
    }

    pub(crate) fn resolve<'a>(
        &'a self,
        window_id: u64,
        selector: Option<&'a str>,
    ) -> Result<Option<&'a str>, UnknownElementId> {
        let Some(id) = selector else {
            return Ok(None);
        };
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Ok(Some(id));
        }
        if let Some(window) = self.windows.get(&window_id) {
            for native in &window.insertion_order {
                if window.native_to_public.get(native).is_some_and(|v| v == id) {
                    return Ok(Some(native));
                }
            }
        }
        Err(UnknownElementId(id.into()))
    }
}

pub(crate) struct PublicSnapshot<'a> {
    snapshot: &'a NativeAxSnapshot,
    ids: Vec<String>,
}

impl PublicSnapshot<'_> {
    #[cfg(test)]
    pub(crate) fn public_id(&self, raw_row: usize) -> Option<&str> {
        self.ids.get(raw_row).map(String::as_str)
    }

    pub(crate) fn metadata(&self) -> Result<serde_json::Value, serde_json::Error> {
        let mut metadata = serde_json::to_value(self.snapshot)?;
        for (row, id) in self.ids.iter().enumerate() {
            metadata["rows"][row]["id"] = serde_json::Value::String(id.clone());
        }
        Ok(metadata)
    }

    pub(crate) fn render(&self) -> String {
        let mut children = vec![Vec::new(); self.snapshot.rows.len()];
        let mut roots = Vec::new();
        for (index, row) in self.snapshot.rows.iter().enumerate() {
            match row.parent {
                Some(parent) => children[parent].push(index),
                None => roots.push(index),
            }
        }
        let source = match self.snapshot.source {
            NativeAxSource::AtSpi => "at_spi",
            NativeAxSource::X11 => "x11",
        };
        let mut lines = Vec::new();
        for root in roots {
            if let Some(node) = self.simplify(root, &children) {
                node.render(0, &mut lines);
            }
        }
        format!("Accessibility source: {source}\n{}", lines.join("\n"))
    }

    fn simplify<'a>(&'a self, index: usize, children: &[Vec<usize>]) -> Option<ViewNode<'a>> {
        let mut node = ViewNode {
            row: &self.snapshot.rows[index],
            id: &self.ids[index],
            merged_text: None,
            children: children[index]
                .iter()
                .filter_map(|&child| self.simplify(child, children))
                .collect(),
        };
        let content = node.has_content();
        let interactive = node.interactive();
        let keep = content
            || !node.children.is_empty()
            || node.row.native_id.starts_with("x11:")
            || interactive
                && (node.row.states.is_none() || node.state("enabled") || node.state("focused"));
        if !keep {
            return None;
        }
        if !interactive && !content && node.container() {
            if node.children.len() == 1 {
                return node.children.pop();
            }
            node.children = node
                .children
                .into_iter()
                .flat_map(|child| {
                    if child.role() == node.row.role && !child.interactive() && !child.has_content()
                    {
                        child.children
                    } else {
                        vec![child]
                    }
                })
                .collect();
        }
        if !node
            .children
            .iter()
            .any(ViewNode::has_interactive_descendant)
        {
            let labels: Vec<_> = node
                .text_parts()
                .iter()
                .map(|part| part.text.to_owned())
                .collect();
            loop {
                let mut removed = false;
                node.children = node
                    .children
                    .into_iter()
                    .flat_map(|child| {
                        let parts = child.text_parts();
                        if child.text()
                            && !parts.is_empty()
                            && parts
                                .iter()
                                .all(|part| labels.iter().any(|label| label.contains(part.text)))
                        {
                            removed = true;
                            child.children
                        } else {
                            vec![child]
                        }
                    })
                    .collect();
                if !removed {
                    break;
                }
            }
        }
        if !interactive {
            let mut merged = Vec::new();
            let mut adjacent = Vec::new();
            for child in std::mem::take(&mut node.children) {
                if child.text() && !child.interactive() && child.children.is_empty() {
                    adjacent.push(child);
                } else {
                    merge_text(&mut adjacent, &mut merged);
                    merged.push(child);
                }
            }
            merge_text(&mut adjacent, &mut merged);
            node.children = merged;
        }
        Some(node)
    }
}

struct ViewNode<'a> {
    row: &'a NativeAxRow,
    id: &'a str,
    merged_text: Option<String>,
    children: Vec<Self>,
}

struct TextPart<'a> {
    title: Option<&'static str>,
    text: &'a str,
}

impl ViewNode<'_> {
    fn role(&self) -> &str {
        if self.merged_text.is_some() {
            "text"
        } else {
            &self.row.role
        }
    }

    fn container(&self) -> bool {
        matches!(
            self.role(),
            "group" | "panel" | "filler" | "section" | "generic"
        )
    }

    fn text(&self) -> bool {
        matches!(self.role(), "text" | "static" | "label")
    }

    fn state(&self, state: &str) -> bool {
        self.row
            .states
            .as_ref()
            .is_some_and(|states| states.iter().any(|value| value == state))
    }

    fn interactive(&self) -> bool {
        self.row.actions.as_ref().is_some_and(|actions| {
            actions.iter().any(|action| {
                !matches!(
                    action.to_lowercase().as_str(),
                    "dodefault" | "clickancestor" | "showcontextmenu" | "scrolltovisible"
                )
            })
        }) || [
            "focusable",
            "focused",
            "editable",
            "selected",
            "checkable",
            "checked",
            "indeterminate",
            "expanded",
        ]
        .iter()
        .any(|state| self.state(state))
            || matches!(
                self.role(),
                "push button"
                    | "button"
                    | "toggle button"
                    | "check box"
                    | "radio button"
                    | "entry"
                    | "password text"
                    | "link"
                    | "menu item"
                    | "check menu item"
                    | "radio menu item"
                    | "combo box"
                    | "slider"
                    | "spin button"
                    | "scroll bar"
                    | "scroll pane"
                    | "viewport"
            )
    }

    fn has_interactive_descendant(&self) -> bool {
        self.interactive() || self.children.iter().any(Self::has_interactive_descendant)
    }

    fn text_parts(&self) -> Vec<TextPart<'_>> {
        let fields = if let Some(text) = &self.merged_text {
            [
                (None, None),
                (Some("Description"), None),
                (Some("Value"), Some(text.as_str())),
            ]
        } else {
            [
                (None, self.row.name.as_deref()),
                (Some("Description"), self.row.description.as_deref()),
                (Some("Value"), self.row.value.as_deref()),
            ]
        };
        let mut parts: Vec<TextPart<'_>> = Vec::new();
        for (title, value) in fields {
            if let Some(text) = value
                && !text.trim_matches(js_whitespace).is_empty()
                && !parts.iter().any(|part| part.text == text)
            {
                parts.push(TextPart { title, text });
            }
        }
        parts
    }

    fn has_content(&self) -> bool {
        !self.text_parts().is_empty() || matches!(self.role(), "image" | "icon")
    }

    fn line(&self) -> String {
        let role = if self.container() {
            "container"
        } else if self.text() {
            "text"
        } else if self.role() == "menu item" {
            ""
        } else {
            self.role()
        };
        let mut flags = Vec::new();
        for state in ["focused", "selected", "expanded", "indeterminate"] {
            if self.state(state) {
                flags.push(state);
            }
        }
        if self.state("checked") {
            flags.push("checked");
        } else if self.state("checkable") && !self.state("indeterminate") {
            flags.push("unchecked");
        }
        if self.state("editable") {
            flags.push("settable");
        }
        if self.row.states.is_some() && !self.state("enabled") && !self.container() && !self.text()
        {
            flags.push("disabled");
        }
        let secondary: Vec<_> = if let Some(actions) = &self.row.actions {
            let one_context = actions
                .iter()
                .filter(|action| action.to_lowercase() == "showcontextmenu")
                .count()
                == 1;
            actions
                .iter()
                .enumerate()
                .filter(|(index, action)| {
                    !(*index == 0
                        && matches!(
                            action.to_lowercase().as_str(),
                            "press" | "click" | "dodefault" | "clickancestor"
                        )
                        || one_context && action.to_lowercase() == "showcontextmenu")
                })
                .map(|(_, action)| action.as_str())
                .collect()
        } else {
            Vec::new()
        };
        let has_secondary = !secondary.is_empty();
        let secondary = secondary.join(", ");
        let mut parts = self.text_parts();
        if has_secondary {
            parts.push(TextPart {
                title: Some("Secondary Actions"),
                text: &secondary,
            });
        }
        parts
            .sort_by_key(|part| part.text.encode_utf16().count() > 100 || part.text.contains('\n'));
        let descriptions: Vec<_> = parts
            .iter()
            .map(|part| {
                if let Some(title) = part.title
                    && (parts.len() > 1 || title == "Secondary Actions")
                {
                    return format!("{title}: {}", part.text);
                }
                part.text.to_owned()
            })
            .collect();
        let mut segments = Vec::new();
        if !role.is_empty() {
            segments.push(role.to_owned());
        }
        if !flags.is_empty() {
            segments.push(format!("({})", flags.join(", ")));
        }
        if !descriptions.is_empty() {
            segments.push(descriptions.join(", "));
        }
        segments
            .join(" ")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
            .replace('\t', "\\t")
    }

    fn render(&self, depth: usize, lines: &mut Vec<String>) {
        let mut line = "\t".repeat(depth);
        write!(line, "{} {}", self.id, self.line()).unwrap();
        lines.push(line);
        for child in &self.children {
            child.render(depth + 1, lines);
        }
    }
}

fn merge_text<'a>(adjacent: &mut Vec<ViewNode<'a>>, output: &mut Vec<ViewNode<'a>>) {
    if adjacent.len() > 1 {
        let text = adjacent
            .iter()
            .flat_map(|node| node.text_parts().into_iter().map(|part| part.text))
            .collect::<Vec<_>>()
            .join(" ");
        let mut first = adjacent.remove(0);
        first.merged_text = Some(text);
        adjacent.clear();
        output.push(first);
    } else {
        output.append(adjacent);
    }
}

fn js_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(native: &str, parent: Option<usize>, role: &str, name: Option<&str>) -> NativeAxRow {
        NativeAxRow {
            native_id: native.into(),
            parent,
            depth: usize::from(parent.is_some()),
            role: role.into(),
            name: name.map(str::to_owned),
            description: None,
            value: None,
            states: None,
            actions: None,
            element_index: None,
        }
    }

    fn fixture(prefix: &str) -> NativeAxSnapshot {
        let mut entry = row(
            &format!("{prefix}/entry"),
            Some(1),
            "text",
            Some("Maka AT-SPI Target Entry"),
        );
        entry.depth = 2;
        entry.states = Some(vec!["enabled".into(), "editable".into()]);
        entry.actions = Some(vec!["activate".into()]);
        entry.value = Some("seed-target".into());
        entry.element_index = Some(0);
        let mut save = row(
            &format!("{prefix}/save"),
            Some(1),
            "push button",
            Some("Maka AT-SPI Target Save"),
        );
        save.depth = 2;
        save.states = Some(vec!["enabled".into()]);
        save.actions = Some(vec!["click".into()]);
        save.element_index = Some(1);
        let mut status = row(
            &format!("{prefix}/status"),
            Some(1),
            "label",
            Some("Maka AT-SPI Target Status"),
        );
        status.depth = 2;
        NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![
                row(
                    &format!("{prefix}/frame"),
                    None,
                    "frame",
                    Some("Maka AT-SPI Target"),
                ),
                row(&format!("{prefix}/panel"), Some(0), "panel", None),
                entry,
                save,
                status,
            ],
        }
    }

    #[test]
    fn metadata_keeps_observed_rows_and_adds_their_assigned_public_ids() {
        let mut snapshot = fixture("target");
        snapshot
            .rows
            .push(row("target/empty", Some(0), "filler", None));
        validate_snapshot(&snapshot).expect("the owned flat fixture is valid");
        let mut ids = ElementIds::default();
        let view = ids.assign(1, &snapshot, ReadCoverage::Full);
        let metadata = view
            .metadata()
            .expect("the borrowed raw snapshot serializes");
        assert_eq!(metadata["source"], "at_spi");
        assert_eq!(
            metadata["rows"][5]["id"], "5",
            "unrendered aliases remain in metadata"
        );
        assert!(
            !view
                .render()
                .lines()
                .any(|line| line.trim_start().starts_with("5 "))
        );
        assert_eq!(metadata["rows"][3]["id"], "3");
        assert_eq!(metadata["rows"][3]["native_id"], "target/save");
        assert_eq!(metadata["rows"][3]["element_index"], 1);
        let observed: NativeAxSnapshot = serde_json::from_value(metadata)
            .expect("public IDs add metadata without changing observed DTO fields");
        assert_eq!(observed, snapshot);
    }

    #[test]
    fn flat_parent_validation_rejects_nonpreceding_and_nondecreasing_depth_links() {
        for parent in [0, 1, usize::MAX] {
            let snapshot = NativeAxSnapshot {
                source: NativeAxSource::AtSpi,
                rows: vec![row("root", Some(parent), "frame", None)],
            };
            assert_eq!(
                validate_snapshot(&snapshot),
                Err(InvalidSnapshot::ParentNotBeforeChild { row: 0, parent })
            );
        }
        for parent_depth in [1, 2] {
            let mut root = row("root", None, "frame", None);
            root.depth = parent_depth;
            let snapshot = NativeAxSnapshot {
                source: NativeAxSource::AtSpi,
                rows: vec![root, row("child", Some(0), "text", None)],
            };
            assert_eq!(
                validate_snapshot(&snapshot),
                Err(InvalidSnapshot::ParentDepthNotLess {
                    row: 1,
                    parent: 0,
                    parent_depth,
                    depth: 1,
                })
            );
        }
    }

    #[test]
    fn flat_parent_validation_accepts_partial_roots_and_depth_gaps() {
        let mut root = row("root", None, "group", None);
        root.depth = 3;
        let mut child = row("child", Some(0), "label", Some("Visible"));
        child.depth = 7;
        let mut partial_root = row("partial", None, "text", Some("Partial"));
        partial_root.depth = usize::MAX;
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![root, child, partial_root],
        };
        assert_eq!(validate_snapshot(&snapshot), Ok(()));
    }

    #[test]
    fn own_gtk_fixture_assigns_raw_parents_before_rendering_save_three() {
        let snapshot = fixture("target");
        let mut ids = ElementIds::default();
        let view = ids.assign(1, &snapshot, ReadCoverage::Full);
        assert_eq!(view.public_id(3), Some("3"));
        assert_eq!(snapshot.rows[3].element_index, Some(1));
        assert_eq!(
            view.render(),
            "Accessibility source: at_spi\n0 frame Maka AT-SPI Target\n\t1 container\n\t\t2 text (settable) Maka AT-SPI Target Entry, Value: seed-target, Secondary Actions: activate\n\t\t3 push button Maka AT-SPI Target Save\n\t\t4 text Maka AT-SPI Target Status"
        );
    }

    #[test]
    fn aliases_span_windows_and_rebind_reuses_each_windows_native_ids() {
        let target = fixture("target");
        let other = fixture("other");
        let mut ids = ElementIds::default();
        assert_eq!(
            ids.assign(1, &target, ReadCoverage::Full).public_id(3),
            Some("3")
        );
        assert_eq!(
            ids.assign(2, &other, ReadCoverage::Full).public_id(3),
            Some("8")
        );
        assert_eq!(
            ids.assign(1, &target, ReadCoverage::Full).public_id(3),
            Some("3")
        );
        assert_eq!(ids.resolve(1, Some("3")).unwrap(), Some("target/save"));
        assert_eq!(ids.resolve(2, Some("8")).unwrap(), Some("other/save"));
        assert!(ids.resolve(1, Some("8")).is_err());
        let mut reset = ElementIds::default();
        assert_eq!(
            reset.assign(2, &other, ReadCoverage::Full).public_id(3),
            Some("3")
        );
        assert_eq!(
            reset.assign(1, &target, ReadCoverage::Full).public_id(3),
            Some("8")
        );
    }

    #[test]
    fn full_reads_prune_missing_aliases_and_insertions_do_not_renumber_survivors() {
        let initial = fixture("target");
        let mut ids = ElementIds::default();
        ids.assign(1, &initial, ReadCoverage::Full);
        let missing = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: initial.rows[..3].to_vec(),
        };
        ids.assign(1, &missing, ReadCoverage::Full);
        assert!(ids.resolve(1, Some("3")).is_err());
        let mut returned = fixture("target");
        returned
            .rows
            .insert(3, row("target/new", Some(1), "push button", Some("New")));
        let view = ids.assign(1, &returned, ReadCoverage::Full);
        assert_eq!(view.public_id(0), Some("0"));
        assert_eq!(view.public_id(2), Some("2"));
        assert_eq!(view.public_id(3), Some("5"));
        assert_eq!(view.public_id(4), Some("6"));
        assert_eq!(view.public_id(5), Some("7"));
    }

    #[test]
    fn filtered_reads_preserve_unreturned_aliases() {
        let snapshot = fixture("target");
        let mut ids = ElementIds::default();
        ids.assign(1, &snapshot, ReadCoverage::Full);
        let filtered = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![row("new", None, "button", Some("New"))],
        };
        assert_eq!(
            ids.assign(1, &filtered, ReadCoverage::Filtered)
                .public_id(0),
            Some("5")
        );
        assert_eq!(ids.resolve(1, Some("3")).unwrap(), Some("target/save"));
        assert_eq!(ids.resolve(1, Some("5")).unwrap(), Some("new"));
    }

    #[test]
    fn selectors_match_exact_ascii_decimal_strings_and_pass_native_values_through() {
        let snapshot = fixture("target");
        let mut ids = ElementIds::default();
        ids.assign(1, &snapshot, ReadCoverage::Full);
        assert_eq!(
            ids.resolve(1, Some("03")).unwrap_err().to_string(),
            "Unknown element ID 03 for this window; refresh get_window_state()"
        );
        for native in [
            "",
            ":1.0:/org/a11y/atspi/accessible/5",
            "x11:123",
            "٣",
            "+3",
        ] {
            assert_eq!(ids.resolve(1, Some(native)).unwrap(), Some(native));
        }
        assert_eq!(ids.resolve(1, None).unwrap(), None);
    }

    #[test]
    fn floating_counter_plateau_keeps_first_insertion_resolution() {
        let mut ids = ElementIds {
            next_id: 9_007_199_254_740_992.0,
            ..ElementIds::default()
        };
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![
                row("first", None, "button", None),
                row("second", None, "button", None),
            ],
        };
        let view = ids.assign(1, &snapshot, ReadCoverage::Full);
        assert_eq!(view.public_id(0), Some("9007199254740992"));
        assert_eq!(view.public_id(1), Some("9007199254740992"));
        assert_eq!(
            ids.resolve(1, Some("9007199254740992")).unwrap(),
            Some("first")
        );
    }

    #[test]
    fn view_flattens_passive_ancestors_and_merges_adjacent_text_leaves() {
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![
                row("root", None, "group", None),
                row("panel", Some(0), "panel", None),
                row("a", Some(1), "label", Some("Alpha")),
                row("b", Some(1), "static", Some("Beta")),
            ],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: at_spi\n1 container\n\t2 text Alpha Beta"
        );
    }

    #[test]
    fn view_removes_duplicate_text_descendants_without_losing_their_children() {
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![
                row("root", None, "group", Some("Alpha Beta")),
                row("a", Some(0), "label", Some("Alpha")),
                row("b", Some(1), "text", Some("Beta")),
            ],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: at_spi\n0 container Alpha Beta"
        );
    }

    #[test]
    fn view_keeps_flag_order_secondary_actions_and_control_character_escaping() {
        let mut control = row("control", None, "button", Some("Line\r\nTab\t"));
        control.states = Some(
            [
                "selected",
                "focused",
                "expanded",
                "indeterminate",
                "checkable",
                "editable",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        );
        control.actions = Some(
            ["CLICK", "activate", "showcontextmenu"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
        );
        control.description = control.name.clone();
        control.value = Some("short".into());
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![control],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: at_spi\n0 button (focused, selected, expanded, indeterminate, settable, disabled) Value: short, Secondary Actions: activate, Line\\r\\nTab\\t"
        );
    }

    #[test]
    fn view_distinguishes_unknown_states_and_retains_x11_metadata() {
        let mut root = row("x11:123", None, "window", None);
        root.description = Some("fixture / Fixture".into());
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::X11,
            rows: vec![root],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: x11\n0 window fixture / Fixture"
        );
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::X11,
            rows: vec![row("x11:123", None, "window", None)],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: x11\n0 window"
        );
        let mut button = row("button", None, "button", None);
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![button.clone()],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: at_spi\n0 button"
        );
        button.states = Some(Vec::new());
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![button],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: at_spi\n"
        );
    }

    #[test]
    fn secondary_action_filtering_keeps_duplicate_context_actions_and_empty_names() {
        let mut control = row("control", None, "button", Some("Menu"));
        control.actions = Some(
            ["press", "showcontextmenu", "ShowContextMenu", "click"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
        );
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![control],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: at_spi\n0 button Menu, Secondary Actions: showcontextmenu, ShowContextMenu, click"
        );
        let mut control = row("empty", None, "button", None);
        control.actions = Some(vec![String::new()]);
        let snapshot = NativeAxSnapshot {
            source: NativeAxSource::AtSpi,
            rows: vec![control],
        };
        assert_eq!(
            ElementIds::default()
                .assign(1, &snapshot, ReadCoverage::Full)
                .render(),
            "Accessibility source: at_spi\n0 button Secondary Actions: "
        );
    }
}
