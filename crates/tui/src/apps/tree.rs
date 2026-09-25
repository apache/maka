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

//! A plugin's view tree as kernel nodes. The plugin says what things are;
//! this decides how they look and behave: widths, the shared label column
//! of a form, where a split stacks, which region scrolls. Plugin text keeps
//! its meaning (tone) but never its own layout.

use crate::ui::{self, Node, On, Role, Size, Tone};
use maka_plugins::terminal_ui::view::{self as wire, Control, Target, View};
use serde_json::Value;
use std::collections::BTreeMap;
use unicode_width::UnicodeWidthStr;

/// What a control in a plugin view asks the shell to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    /// Read another route of the same view.
    Navigate(Value),
    /// Submit a declared action with its fields.
    Submit(String),
    Toggle(String),
    Pick(String, String),
    /// Return in a one-line text field: the field's default action.
    Commit(String),
    /// Open a Maka session the view names.
    Open(String),
}

/// A text field's well in the laid-out tree; its owner paints the editor.
pub(crate) struct Well {
    /// The instance whose field this is.
    pub key: super::Key,
    pub field: String,
    pub path: String,
    pub label: String,
    pub label_width: u16,
    pub multiline: bool,
    pub placeholder: String,
    pub secret: bool,
}

pub(crate) struct Env<'a, M> {
    pub readers: &'a super::transcript::Readers,
    pub resources_live: bool,
    pub i18n: &'a crate::i18n::I18n,
    pub key: &'a super::Key,
    pub drafts: &'a BTreeMap<String, Value>,
    pub ascii: bool,
    /// Whether a control is offered at all. Transient states (a request in
    /// flight) are gated when the command runs, so focus never falls off.
    pub offered: &'a dyn Fn(&Intent) -> bool,
    /// The action whose last submission was applied, for a check mark.
    pub applied: Option<&'a str>,
    /// What fills a slot: the views placed in it, given the slot's name,
    /// its path in this view, its kernel path and width.
    pub slots: &'a Slots<'a, M>,
}

pub(crate) type Slots<'a, M> = dyn Fn(&str, &str, &str, u16) -> (Vec<Node<M>>, Vec<Well>) + 'a;

/// Fills no slot, for places a view shows only in part.
pub(crate) fn unfilled<M>(_: &str, _: &str, _: &str, _: u16) -> (Vec<Node<M>>, Vec<Well>) {
    (vec![], vec![])
}

/// Below this width a split stacks its panes.
const SPLIT: u16 = 72;
/// Multi-line fields show this many rows.
pub(crate) const AREA_ROWS: u16 = 3;

/// The view's root under `parent` (the kernel path of its container).
pub(crate) fn build<M>(
    view: &View,
    env: &Env<'_, M>,
    parent: &str,
    width: u16,
    wrap: &dyn Fn(Intent) -> M,
) -> (Node<M>, Vec<Well>) {
    let widest = inputs(&view.root)
        .into_iter()
        .map(|label| label.width())
        .max();
    let mut builder = Builder {
        view,
        env,
        wrap,
        wire: vec![],
        label_width: widest.map_or(0, |widest| (widest as u16 + 2).min(width * 2 / 5)),
        wells: vec![],
    };
    let path = format!("{parent}/{}", view.root.key());
    let node = builder.node(&view.root, path, width, Axis::Column);
    (node, builder.wells)
}

/// The label an Input gives a field, for review screens.
pub(crate) fn label(view: &View, field: &str) -> Option<String> {
    fn find<'a>(node: &'a wire::Node, field: &str) -> Option<&'a str> {
        match node {
            wire::Node::Input {
                field: bound,
                label,
                ..
            } if bound == field && !label.is_empty() => Some(label),
            _ => node
                .children()
                .into_iter()
                .find_map(|child| find(child, field)),
        }
    }
    find(&view.root, field).map(str::to_owned)
}

/// The readable text of a view, top to bottom, without its controls.
pub(crate) fn prose(view: &View) -> String {
    fn walk(node: &wire::Node, out: &mut Vec<String>) {
        match node {
            wire::Node::Text { spans, .. } => {
                out.push(spans.iter().map(|span| span.text.as_str()).collect())
            }
            wire::Node::Markdown { text, .. } | wire::Node::Code { text, .. } => {
                out.push(text.clone())
            }
            wire::Node::Item { title, detail, .. } => {
                out.push(title.clone());
                if !detail.is_empty() {
                    out.push(detail.clone());
                }
            }
            _ => node
                .children()
                .into_iter()
                .for_each(|child| walk(child, out)),
        }
    }
    let mut out = vec![view.title.clone()];
    walk(&view.root, &mut out);
    out.join("\n")
}

/// Whether a view shows nothing at all, so its place can stay empty.
pub(crate) fn blank(view: &View) -> bool {
    fn empty(node: &wire::Node) -> bool {
        match node {
            wire::Node::Text { spans, .. } => spans.iter().all(|span| span.text.trim().is_empty()),
            wire::Node::Markdown { text, .. } | wire::Node::Code { text, .. } => {
                text.trim().is_empty()
            }
            wire::Node::Rule { .. } | wire::Node::Slot { .. } => true,
            wire::Node::Column { .. }
            | wire::Node::Row { .. }
            | wire::Node::Scroll { .. }
            | wire::Node::Split { .. }
            | wire::Node::Boundary { .. } => node.children().into_iter().all(empty),
            _ => false,
        }
    }
    empty(&view.root)
}

/// Every slot a view declares: its path in the view, name and context.
pub(crate) fn slots(view: &View) -> Vec<(String, String, Value)> {
    fn walk(node: &wire::Node, path: String, out: &mut Vec<(String, String, Value)>) {
        let path = if path.is_empty() {
            node.key().to_owned()
        } else {
            format!("{path}/{}", node.key())
        };
        if let wire::Node::Slot { name, context, .. } = node {
            out.push((path.clone(), name.clone(), context.clone()));
        }
        for child in node.children() {
            walk(child, path.clone(), out);
        }
    }
    let mut out = vec![];
    walk(&view.root, String::new(), &mut out);
    out
}

/// Actions bound to primary buttons, in reading order.
pub(crate) fn primary_actions(view: &View) -> Vec<&str> {
    fn walk<'a>(node: &'a wire::Node, out: &mut Vec<&'a str>) {
        if let wire::Node::Button {
            action,
            role: wire::Role::Primary,
            ..
        } = node
        {
            out.push(action);
        }
        node.children()
            .into_iter()
            .for_each(|child| walk(child, out));
    }
    let mut out = vec![];
    walk(&view.root, &mut out);
    out
}

fn inputs(node: &wire::Node) -> Vec<&str> {
    match node {
        wire::Node::Input { label, .. } => vec![label.as_str()],
        _ => node.children().into_iter().flat_map(inputs).collect(),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Axis {
    Row,
    Column,
}

struct Builder<'a, M> {
    view: &'a View,
    env: &'a Env<'a, M>,
    wrap: &'a dyn Fn(Intent) -> M,
    /// Keys from the root to the node being built: its path in the view.
    wire: Vec<String>,
    label_width: u16,
    wells: Vec<Well>,
}

impl<M> Builder<'_, M> {
    fn offer(&self, intent: Intent) -> (M, bool) {
        let enabled = (self.env.offered)(&intent);
        ((self.wrap)(intent), enabled)
    }

    fn node(&mut self, node: &wire::Node, path: String, width: u16, parent: Axis) -> Node<M> {
        self.wire.push(node.key().to_owned());
        let built = self.place(node, path, width, parent);
        self.wire.pop();
        built
    }

    fn place(&mut self, node: &wire::Node, path: String, width: u16, parent: Axis) -> Node<M> {
        let key = node.key().to_owned();
        match node {
            wire::Node::Column { gap, children, .. } => {
                let expands = has_transcript(node);
                // Item-only collections are lists. Decorative headings may
                // sit among them; inputs and actions keep separate Tab stops.
                let list = children
                    .iter()
                    .any(|child| matches!(child, wire::Node::Item { .. }))
                    && children.iter().all(|child| {
                        matches!(
                            child,
                            wire::Node::Item { .. }
                                | wire::Node::Text { .. }
                                | wire::Node::Rule { .. }
                                | wire::Node::Markdown { .. }
                                | wire::Node::Code { .. }
                                | wire::Node::Progress { .. }
                        )
                    });
                let children = children
                    .iter()
                    .map(|child| {
                        let path = format!("{path}/{}", child.key());
                        self.node(child, path, width, Axis::Column)
                    })
                    .collect();
                let node = Node::column(key, children).gap(u16::from(*gap));
                let node = if expands { node.size(Size::Fill) } else { node };
                if list { node.focus_group() } else { node }
            }
            wire::Node::Boundary {
                body,
                bottom,
                padding,
                emphasis,
                activity,
                ..
            } => {
                let expands = has_transcript(node);
                let child = self.node(
                    body,
                    format!("{path}/{}", body.key()),
                    width.saturating_sub(2 + 2 * u16::from(padding.horizontal)),
                    Axis::Column,
                );
                let mut boundary = Node::boundary(key, child)
                    .padding(padding.horizontal.into(), padding.vertical.into())
                    .emphasis(match emphasis {
                        wire::Emphasis::Normal => ui::Emphasis::Normal,
                        wire::Emphasis::Accent => ui::Emphasis::Accent,
                    })
                    .activity(match activity {
                        wire::Activity::Idle => ui::Activity::Idle,
                        wire::Activity::Busy => ui::Activity::Busy,
                    });
                if let Some(bottom) = bottom {
                    boundary = boundary.bottom(self.node(
                        bottom,
                        format!("{path}/{}", bottom.key()),
                        width.saturating_sub(4),
                        Axis::Row,
                    ));
                }
                if expands {
                    boundary.size(Size::Fill)
                } else {
                    boundary
                }
            }
            wire::Node::Row { gap, children, .. } => self.row(key, path, *gap, children, width),
            wire::Node::Text { spans, clip, .. } => text(key, spans, *clip),
            wire::Node::Rule { .. } => Node::rule(key),
            wire::Node::Scroll { rows, child, .. } => {
                let inner = format!("{path}/{}", child.key());
                let focusable = !interactive(child);
                let child = self.node(child, inner, width.saturating_sub(1), Axis::Column);
                let node = Node::scroll(key, child).size(Size::Upto(*rows));
                // A region of reading takes focus itself so the keyboard
                // can scroll it; one with controls scrolls to its focus.
                if focusable { node.on(On::Scroll) } else { node }
            }
            wire::Node::Split {
                ratio, left, right, ..
            } => self.split(key, path, *ratio, left, right, width),
            wire::Node::Tabs { current, tabs, .. } => {
                let tabs = tabs
                    .iter()
                    .map(|tab| {
                        let chosen = tab.id == *current;
                        let (message, enabled) = self.offer(Intent::Navigate(tab.route.clone()));
                        Node::text(
                            tab.id.clone(),
                            vec![(
                                tab.label.clone(),
                                if chosen { Tone::Strong } else { Tone::Muted },
                            )],
                        )
                        .on(On::Activate(message))
                        .current(chosen)
                        .enabled(enabled)
                    })
                    .collect();
                Node::column(
                    key,
                    vec![
                        Node::row("tabs", tabs).gap(3).focus_group(),
                        Node::rule("rule"),
                    ],
                )
            }
            wire::Node::Item {
                title,
                detail,
                meta,
                tone: item_tone,
                current,
                target,
                ..
            } => {
                let (intent, chevron) = match target {
                    Target::Route { route } => (Intent::Navigate(route.clone()), true),
                    Target::Action { action } => (Intent::Submit(action.clone()), false),
                    Target::Session { session } => (Intent::Open(session.clone()), true),
                };
                let mut head = vec![
                    Node::text("title", vec![(title.clone(), tone(*item_tone))])
                        .clip()
                        .size(Size::Fill),
                ];
                if !meta.is_empty() {
                    head.push(
                        Node::text("meta", vec![(meta.clone(), Tone::Subtle)])
                            .clip()
                            .size(Size::Upto(width / 3)),
                    );
                }
                if chevron {
                    let glyph = if self.env.ascii { ">" } else { "›" };
                    head.push(Node::text("chevron", vec![(glyph.into(), Tone::Subtle)]));
                }
                let mut rows = vec![Node::row("head", head).gap(2)];
                if !detail.is_empty() {
                    rows.push(Node::text("detail", vec![(detail.clone(), Tone::Muted)]).clip());
                }
                let (message, enabled) = self.offer(intent);
                Node::column(key, rows)
                    .on(On::Activate(message))
                    .current(*current)
                    .enabled(enabled)
            }
            wire::Node::Button {
                action,
                role,
                label,
                ..
            } => {
                let mut button = self.button(action, *role, label.as_deref());
                // A button stays its own width even in a column.
                match parent {
                    Axis::Row => {
                        button.key = key.into();
                        button
                    }
                    Axis::Column => Node::row(key, vec![button]),
                }
            }
            wire::Node::Input { field, label, .. } => self.input(key, path, field, label, width),
            wire::Node::Progress {
                value, max, label, ..
            } => self.progress(key, *value, *max, label, width),
            wire::Node::Markdown { text, .. } => Node::column(key, markdown(text, self.env.ascii)),
            wire::Node::Code { text, .. } => Node::column(key, code(text, self.env.ascii)),
            wire::Node::Transcript { .. } => {
                if let Some(token) = self.env.readers.token(self.env.key, &self.wire.join("/")) {
                    Node::transcript(key, token)
                } else if !self.env.resources_live {
                    Node::column(key, vec![])
                } else {
                    Node::text(
                        key,
                        vec![(self.env.i18n.text("transcript-failed"), Tone::Subtle)],
                    )
                }
            }
            // An unfilled slot takes no room.
            wire::Node::Slot { name, .. } => {
                let (fillers, wells) = (self.env.slots)(name, &self.wire.join("/"), &path, width);
                self.wells.extend(wells);
                Node::column(key, fillers).gap(1)
            }
        }
    }

    /// Children keep their natural widths when the row holds them all;
    /// otherwise buttons keep theirs and everything else shares the rest
    /// equally. Fields, bars, splits and columns (lanes) always stretch.
    fn row(
        &mut self,
        key: String,
        path: String,
        gap: u8,
        children: &[wire::Node],
        width: u16,
    ) -> Node<M> {
        let gap = u16::from(gap);
        let fixed: u16 = children
            .iter()
            .filter_map(|child| self.button_width(child))
            .sum();
        let fills = children
            .iter()
            .filter(|child| self.button_width(child).is_none())
            .count() as u16;
        let gaps = gap.saturating_mul(children.len().saturating_sub(1) as u16);
        let share = width.saturating_sub(fixed.saturating_add(gaps)) / fills.max(1);
        let stretch = children.iter().any(stretchy);
        let nodes: Vec<_> = children
            .iter()
            .map(|child| {
                let path = format!("{path}/{}", child.key());
                self.node(child, path, share, Axis::Row)
            })
            .collect();
        let natural = nodes
            .iter()
            .map(ui::natural_width)
            .fold(gaps, u16::saturating_add);
        let fill = stretch || natural > width;
        let nodes = nodes
            .into_iter()
            .zip(children)
            .map(|(node, child)| {
                if fill && self.button_width(child).is_none() {
                    node.size(Size::Fill)
                } else {
                    node
                }
            })
            .collect();
        let node = Node::row(key, nodes).gap(gap);
        if children.iter().any(has_transcript) {
            node.size(Size::Fill)
        } else {
            node
        }
    }

    fn split(
        &mut self,
        key: String,
        path: String,
        ratio: u8,
        left: &wire::Node,
        right: &wire::Node,
        width: u16,
    ) -> Node<M> {
        let expands = has_transcript(left) || has_transcript(right);
        // Both layouts keep the same paths, so focus survives a resize
        // across the breakpoint.
        let (left_path, right_path) = (
            format!("{path}/leading/{}", left.key()),
            format!("{path}/trailing/{}", right.key()),
        );
        if width < SPLIT {
            let left = self.node(left, left_path, width, Axis::Column);
            let right = self.node(right, right_path, width, Axis::Column);
            let node = Node::column(
                key,
                vec![
                    Node::column("leading", vec![left]).size(if expands {
                        Size::Fill
                    } else {
                        Size::Content
                    }),
                    Node::rule("divider"),
                    Node::column("trailing", vec![right]).size(if expands {
                        Size::Fill
                    } else {
                        Size::Content
                    }),
                ],
            )
            .gap(1);
            return if expands { node.size(Size::Fill) } else { node };
        }
        let leading = width.saturating_sub(3) * u16::from(ratio) / 100;
        let trailing = width.saturating_sub(3 + leading);
        let left = self.node(left, left_path, leading, Axis::Column);
        let right = self.node(right, right_path, trailing, Axis::Column);
        let node = Node::row(
            key,
            vec![
                Node::column("leading", vec![left]).size(Size::Fixed(leading)),
                Node::rule("divider"),
                Node::column("trailing", vec![right]).size(Size::Fill),
            ],
        )
        .gap(1);
        if expands { node.size(Size::Fill) } else { node }
    }

    fn button_label(&self, action: &str, label: Option<&str>) -> String {
        let label = label
            .map(str::to_owned)
            .or_else(|| self.view.action(action).map(|action| action.label.clone()))
            .unwrap_or_default();
        if self.env.applied == Some(action) {
            format!("{} {label}", if self.env.ascii { "+" } else { "✓" })
        } else {
            label
        }
    }

    fn button_width(&self, node: &wire::Node) -> Option<u16> {
        match node {
            wire::Node::Button { action, label, .. } => {
                Some(self.button_label(action, label.as_deref()).width() as u16 + 4)
            }
            _ => None,
        }
    }

    fn button(&self, action: &str, role: wire::Role, label: Option<&str>) -> Node<M> {
        let role = match role {
            wire::Role::Normal => Role::Normal,
            wire::Role::Primary => Role::Primary,
            wire::Role::Destructive => Role::Destructive,
        };
        let (message, enabled) = self.offer(Intent::Submit(action.to_owned()));
        Node::button("button", self.button_label(action, label), role)
            .on(On::Activate(message))
            .enabled(enabled)
    }

    fn input(
        &mut self,
        key: String,
        path: String,
        field: &str,
        label: &str,
        width: u16,
    ) -> Node<M> {
        let Some(spec) = self.view.field(field) else {
            return Node::column(key, vec![]);
        };
        let caption = Node::text("label", vec![(label.to_owned(), Tone::Normal)])
            .clip()
            .size(Size::Fixed(self.label_width));
        match &spec.control {
            Control::Toggle { .. } => {
                let on = self
                    .env
                    .drafts
                    .get(field)
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let switch = match (on, self.env.ascii) {
                    (true, false) => "━●",
                    (false, false) => "○─",
                    (true, true) => "[x]",
                    (false, true) => "[ ]",
                };
                let (message, enabled) = self.offer(Intent::Toggle(field.to_owned()));
                Node::row(
                    key,
                    vec![
                        caption,
                        Node::text(
                            "value",
                            vec![(switch.into(), if on { Tone::Accent } else { Tone::Subtle })],
                        ),
                    ],
                )
                .on(On::Activate(message))
                .enabled(enabled)
            }
            Control::Choice { options, .. } => {
                let value = self.env.drafts.get(field).and_then(Value::as_str);
                let current = options
                    .iter()
                    .position(|option| Some(option.value.as_str()) == value);
                let shown = current.map_or_else(String::new, |index| options[index].label.clone());
                let enabled = (self.env.offered)(&Intent::Pick(field.to_owned(), String::new()));
                let choices = options
                    .iter()
                    .map(|option| ui::Choice {
                        label: option.label.clone(),
                        action: (self.wrap)(Intent::Pick(field.to_owned(), option.value.clone())),
                    })
                    .collect();
                let affordance = if self.env.ascii { " v" } else { " ▾" };
                Node::row(
                    key,
                    vec![
                        caption,
                        Node::text(
                            "value",
                            vec![(shown, Tone::Normal), (affordance.into(), Tone::Subtle)],
                        )
                        .clip()
                        .size(Size::Upto(width.saturating_sub(self.label_width))),
                    ],
                )
                .on(On::Choose { choices, current })
                .enabled(enabled)
            }
            Control::Text {
                multiline,
                placeholder,
                secret,
                ..
            } => {
                self.wells.push(Well {
                    key: self.env.key.clone(),
                    field: field.to_owned(),
                    path,
                    label: label.to_owned(),
                    label_width: self.label_width,
                    multiline: *multiline,
                    placeholder: placeholder.clone(),
                    secret: *secret,
                });
                let (message, enabled) = self.offer(Intent::Commit(field.to_owned()));
                Node::slot(key, if *multiline { AREA_ROWS } else { 1 })
                    .on(On::Activate(message))
                    .enabled(enabled)
            }
        }
    }

    fn progress(&self, key: String, value: u64, max: u64, label: &str, width: u16) -> Node<M> {
        let percent = format!("{:>3}%", value.saturating_mul(100) / max.max(1));
        let caption = (!label.is_empty()).then(|| label.width() as u16 + 2);
        let caption_width = caption.unwrap_or(0).min(width / 3);
        // The label, the bar and the percentage, a column apart.
        let gaps = if caption.is_some() { 2 } else { 1 };
        let bar = width.saturating_sub(caption_width + percent.len() as u16 + gaps);
        let filled = (u64::from(bar) * value / max.max(1)) as usize;
        let (full, empty) = if self.env.ascii {
            ("#", "-")
        } else {
            ("━", "─")
        };
        let mut children = vec![];
        if caption.is_some() {
            children.push(
                Node::text("label", vec![(label.to_owned(), Tone::Normal)])
                    .clip()
                    .size(Size::Fixed(caption_width)),
            );
        }
        children.push(
            Node::text(
                "bar",
                vec![
                    (full.repeat(filled), Tone::Accent),
                    (
                        empty.repeat(usize::from(bar).saturating_sub(filled)),
                        Tone::Subtle,
                    ),
                ],
            )
            .clip()
            .size(Size::Fill),
        );
        children.push(Node::text("percent", vec![(percent, Tone::Muted)]));
        Node::row(key, children).gap(1)
    }
}

/// Whether a node takes whatever width it is given rather than its content's.
pub(super) fn has_transcript(node: &wire::Node) -> bool {
    matches!(node, wire::Node::Transcript { .. }) || node.children().into_iter().any(has_transcript)
}

fn stretchy(node: &wire::Node) -> bool {
    matches!(
        node,
        wire::Node::Column { .. }
            | wire::Node::Input { .. }
            | wire::Node::Transcript { .. }
            | wire::Node::Progress { .. }
            | wire::Node::Split { .. }
            | wire::Node::Scroll { .. }
            | wire::Node::Markdown { .. }
            | wire::Node::Code { .. }
            | wire::Node::Item { .. }
    ) || node.children().into_iter().any(stretchy)
}

fn interactive(node: &wire::Node) -> bool {
    matches!(
        node,
        wire::Node::Item { .. }
            | wire::Node::Button { .. }
            | wire::Node::Input { .. }
            | wire::Node::Transcript { .. }
            | wire::Node::Tabs { .. }
    ) || node.children().into_iter().any(interactive)
}

fn tone(tone: wire::Tone) -> Tone {
    match tone {
        wire::Tone::Normal => Tone::Normal,
        wire::Tone::Strong => Tone::Strong,
        wire::Tone::Muted => Tone::Muted,
        wire::Tone::Subtle => Tone::Subtle,
        wire::Tone::Accent => Tone::Accent,
        wire::Tone::Success => Tone::Success,
        wire::Tone::Warning => Tone::Warning,
        wire::Tone::Error => Tone::Error,
    }
}

/// Wrapped prose; a line break in the source starts a new paragraph line.
fn text<M>(key: String, spans: &[wire::Span], clip: bool) -> Node<M> {
    let mut lines: Vec<Vec<(String, Tone)>> = vec![vec![]];
    for span in spans {
        for (index, part) in span.text.split('\n').enumerate() {
            if index > 0 {
                lines.push(vec![]);
            }
            if !part.is_empty() {
                let part = part.replace('\t', "    ");
                lines.last_mut().unwrap().push((part, tone(span.tone)));
            }
        }
    }
    if lines.len() == 1 || clip {
        let node = Node::text(key, lines.swap_remove(0));
        return if clip { node.clip() } else { node };
    }
    Node::column(
        key,
        lines
            .into_iter()
            .enumerate()
            .map(|(index, spans)| Node::text(index.to_string(), spans))
            .collect(),
    )
}

fn code<M>(text: &str, ascii: bool) -> Vec<Node<M>> {
    let gutter = if ascii { "| " } else { "│ " };
    text.lines()
        .enumerate()
        .map(|(index, line)| {
            Node::text(
                index.to_string(),
                vec![
                    (gutter.into(), Tone::Subtle),
                    (line.replace('\t', "    "), Tone::Normal),
                ],
            )
            .clip()
        })
        .collect()
}

/// CommonMark as kernel text: headings strong, inline code and links
/// accented, lists bulleted, quotes and code behind a gutter.
fn markdown<M>(source: &str, ascii: bool) -> Vec<Node<M>> {
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
    enum Block {
        Prose(Vec<(String, Tone)>),
        Code(String),
        Rule,
        Gap,
    }
    let mut blocks = vec![];
    let mut line: Vec<(String, Tone)> = vec![];
    let (mut strong, mut link, mut quote, mut heading, mut fenced) = (0, 0, 0usize, false, false);
    let mut lists: Vec<Option<u64>> = vec![];
    let quote_mark = if ascii { "| " } else { "│ " };
    let flush = |blocks: &mut Vec<Block>, line: &mut Vec<(String, Tone)>, quote: usize| {
        if line.iter().any(|(text, _)| !text.trim().is_empty()) {
            if quote > 0 {
                line.insert(0, (quote_mark.repeat(quote), Tone::Subtle));
            }
            blocks.push(Block::Prose(std::mem::take(line)));
        }
        line.clear();
    };
    let options =
        Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES | Options::ENABLE_TASKLISTS;
    for event in Parser::new_ext(source, options) {
        let top = quote == 0 && lists.is_empty();
        match event {
            Event::Start(Tag::Heading { .. }) => heading = true,
            Event::End(TagEnd::Heading(_)) => {
                heading = false;
                flush(&mut blocks, &mut line, quote);
                blocks.push(Block::Gap);
            }
            Event::End(TagEnd::Paragraph) => {
                flush(&mut blocks, &mut line, quote);
                if top {
                    blocks.push(Block::Gap);
                }
            }
            Event::Start(Tag::List(start)) => {
                flush(&mut blocks, &mut line, quote);
                lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                flush(&mut blocks, &mut line, quote);
                lists.pop();
                if quote == 0 && lists.is_empty() {
                    blocks.push(Block::Gap);
                }
            }
            Event::Start(Tag::Item) => {
                flush(&mut blocks, &mut line, quote);
                let indent = "  ".repeat(lists.len().saturating_sub(1));
                let marker = match lists.last_mut() {
                    Some(Some(number)) => {
                        let marker = format!("{number}. ");
                        *number += 1;
                        marker
                    }
                    _ => (if ascii { "- " } else { "• " }).to_owned(),
                };
                line.push((format!("{indent}{marker}"), Tone::Subtle));
            }
            Event::End(TagEnd::Item) => flush(&mut blocks, &mut line, quote),
            Event::Start(Tag::BlockQuote(_)) => {
                flush(&mut blocks, &mut line, quote);
                quote += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) => {
                flush(&mut blocks, &mut line, quote);
                quote = quote.saturating_sub(1);
                if quote == 0 && lists.is_empty() {
                    blocks.push(Block::Gap);
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                flush(&mut blocks, &mut line, quote);
                fenced = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                fenced = false;
                if top {
                    blocks.push(Block::Gap);
                }
            }
            Event::Text(text) if fenced => {
                blocks.extend(text.lines().map(|line| Block::Code(line.to_owned())));
            }
            Event::Text(text) => {
                let tone = if heading || strong > 0 {
                    Tone::Strong
                } else if link > 0 {
                    Tone::Accent
                } else {
                    Tone::Normal
                };
                line.push((text.into_string(), tone));
            }
            Event::Code(text) => line.push((text.into_string(), Tone::Accent)),
            Event::Start(Tag::Strong) => strong += 1,
            Event::End(TagEnd::Strong) => strong -= 1,
            Event::Start(Tag::Link { .. }) => link += 1,
            Event::End(TagEnd::Link) => link -= 1,
            Event::SoftBreak => line.push((" ".into(), Tone::Normal)),
            Event::HardBreak | Event::End(TagEnd::TableHead | TagEnd::TableRow) => {
                flush(&mut blocks, &mut line, quote)
            }
            Event::End(TagEnd::TableCell) => line.push(("   ".into(), Tone::Normal)),
            Event::TaskListMarker(done) => {
                let mark = match (done, ascii) {
                    (true, false) => "☑ ",
                    (false, false) => "☐ ",
                    (true, true) => "[x] ",
                    (false, true) => "[ ] ",
                };
                line.push((mark.into(), Tone::Subtle));
            }
            Event::Rule => {
                flush(&mut blocks, &mut line, quote);
                blocks.push(Block::Rule);
            }
            _ => {}
        }
    }
    flush(&mut blocks, &mut line, quote);
    while matches!(blocks.last(), Some(Block::Gap)) {
        blocks.pop();
    }
    let gutter = if ascii { "| " } else { "│ " };
    blocks
        .into_iter()
        .enumerate()
        .map(|(index, block)| {
            let key = index.to_string();
            match block {
                Block::Prose(spans) => Node::text(key, spans),
                Block::Code(line) => Node::text(
                    key,
                    vec![
                        (gutter.into(), Tone::Subtle),
                        (line.replace('\t', "    "), Tone::Normal),
                    ],
                )
                .clip(),
                Block::Rule => Node::rule(key),
                Block::Gap => Node::text(key, vec![]).size(Size::Fixed(1)),
            }
        })
        .collect()
}
