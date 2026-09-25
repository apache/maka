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

use super::boundary::{Activity, Emphasis, Padding};
use std::borrow::Cow;

/// Main-axis size of a child inside its parent Row or Column.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Size {
    Content,
    Fixed(u16),
    /// The content's size, but no more than this: a list that grows to a
    /// cap and scrolls beyond it.
    Upto(u16),
    Fill,
}

/// Semantic text roles; the kernel maps them to the active palette.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Normal,
    Strong,
    Muted,
    Subtle,
    Accent,
    /// The default action: accent, bold.
    Primary,
    Success,
    Warning,
    Error,
    /// One of the palette's stable identity hues (session titles).
    Hue(u8),
}

/// What a button does, which decides its color at rest and under focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Normal,
    Primary,
    /// Weakens a protection (turning a sandbox off); amber even while focused.
    Caution,
    /// Loses or discards something; red even while focused.
    Destructive,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Align {
    #[default]
    Start,
    Center,
    End,
}

#[derive(Clone)]
pub struct Choice<M> {
    pub label: String,
    pub action: M,
}

#[derive(Clone)]
pub enum On<M> {
    /// Click, Enter or Space emits the action.
    Activate(M),
    /// Opens a kernel-owned popover; picking a choice emits its action.
    /// `current` is None when the active value is not one of the choices.
    Choose {
        choices: Vec<Choice<M>>,
        current: Option<usize>,
    },
    /// Set on a Scroll node: a read-only viewport that takes keyboard focus
    /// and scrolls with the arrows, Home and End.
    Scroll,
    /// Focus belongs to the mounted transcript's local reader.
    Transcript,
}

#[derive(Clone)]
pub enum Kind<M> {
    Column {
        children: Vec<Node<M>>,
        gap: u16,
    },
    Row {
        children: Vec<Node<M>>,
        gap: u16,
    },
    /// A framed body with an optional one-line inset in the bottom border.
    Boundary {
        body: Box<Node<M>>,
        bottom: Option<Box<Node<M>>>,
        padding: Padding,
        emphasis: Emphasis,
        activity: Activity,
    },
    /// `clip` keeps one row and ends an overflow with an ellipsis.
    Text {
        spans: Vec<(String, Tone)>,
        align: Align,
        clip: bool,
    },
    /// A one-cell divider across the parent's cross axis.
    Rule,
    /// A region its owner paints and drives, such as a text editor. The
    /// kernel places it and makes it a focus stop: a click only focuses it,
    /// Enter activates it, and the owner takes every other key.
    Slot,
    /// A shared reader placed and driven by the kernel. The local token
    /// identifies a source mount; it is never a plugin-provided authority.
    Transcript {
        token: uuid::Uuid,
    },
    /// Vertical scrolling for content taller than its rectangle.
    Scroll(Box<Node<M>>),
}

/// A keyed node. Keys identify interaction state (focus, hover, scroll) across
/// frames, so they must be stable and unique among siblings; positions,
/// translated labels and coordinates are never identities.
#[derive(Clone)]
pub struct Node<M> {
    pub key: Cow<'static, str>,
    pub size: Size,
    pub kind: Kind<M>,
    pub on: Option<On<M>>,
    pub enabled: bool,
    /// The chosen item of a selection group; independent of keyboard focus.
    pub current: bool,
    /// Keyboard focus arriving here also activates it, for lists whose
    /// selection follows the focus.
    pub follow_focus: bool,
    /// Descendants share one Tab stop, with arrows moving inside the group.
    /// Use for lists and tabs; form fields remain separate stops.
    pub focus_group: bool,
    /// What Enter sends instead of the activation: a list row selects on
    /// click or arrow, and Enter commits the sheet's choice.
    pub submit: Option<M>,
    pub hint: Option<String>,
    /// Set on buttons: a filled hit area whose label keeps its role color.
    pub role: Option<Role>,
}

impl<M> Node<M> {
    fn new(key: impl Into<Cow<'static, str>>, kind: Kind<M>) -> Self {
        Self {
            key: key.into(),
            size: Size::Content,
            kind,
            on: None,
            enabled: true,
            current: false,
            follow_focus: false,
            focus_group: false,
            submit: None,
            hint: None,
            role: None,
        }
    }
    pub fn column(key: impl Into<Cow<'static, str>>, children: Vec<Node<M>>) -> Self {
        Self::new(key, Kind::Column { children, gap: 0 })
    }
    pub fn row(key: impl Into<Cow<'static, str>>, children: Vec<Node<M>>) -> Self {
        Self::new(key, Kind::Row { children, gap: 0 })
    }
    pub fn boundary(key: impl Into<Cow<'static, str>>, body: Node<M>) -> Self {
        Self::new(
            key,
            Kind::Boundary {
                body: Box::new(body),
                bottom: None,
                padding: Padding::default(),
                emphasis: Emphasis::Normal,
                activity: Activity::Idle,
            },
        )
    }
    /// The lower border hosts one clipped row, with a cell on either side.
    pub fn bottom(mut self, node: Node<M>) -> Self {
        if let Kind::Boundary { bottom, .. } = &mut self.kind {
            *bottom = Some(Box::new(node));
        }
        self
    }
    /// Space inside the border; each axis is capped at four cells.
    pub fn padding(mut self, horizontal: u16, vertical: u16) -> Self {
        if let Kind::Boundary { padding, .. } = &mut self.kind {
            *padding = Padding::new(horizontal, vertical);
        }
        self
    }
    pub fn emphasis(mut self, value: Emphasis) -> Self {
        if let Kind::Boundary { emphasis, .. } = &mut self.kind {
            *emphasis = value;
        }
        self
    }
    pub fn activity(mut self, value: Activity) -> Self {
        if let Kind::Boundary { activity, .. } = &mut self.kind {
            *activity = value;
        }
        self
    }
    pub fn text(key: impl Into<Cow<'static, str>>, spans: Vec<(String, Tone)>) -> Self {
        Self::new(
            key,
            Kind::Text {
                spans,
                align: Align::Start,
                clip: false,
            },
        )
    }
    /// A command whose label is centered in its whole hit area; pair it
    /// with `on` to make it do something.
    pub fn button(key: impl Into<Cow<'static, str>>, label: String, role: Role) -> Self {
        let tone = match role {
            Role::Normal => Tone::Normal,
            Role::Primary => Tone::Primary,
            Role::Caution => Tone::Warning,
            Role::Destructive => Tone::Error,
        };
        let width = unicode_width::UnicodeWidthStr::width(label.as_str()) as u16 + 4;
        let mut node = Self::text(key, vec![(label, tone)])
            .align(Align::Center)
            .clip()
            .size(Size::Fixed(width));
        node.role = Some(role);
        node
    }
    /// A region its owner draws: a field once it has an activation, else a
    /// canvas (a preview) that takes no focus. Either is found by its path.
    pub fn slot(key: impl Into<Cow<'static, str>>, rows: u16) -> Self {
        Self::new(key, Kind::Slot).size(Size::Fixed(rows))
    }
    pub fn transcript(key: impl Into<Cow<'static, str>>, token: uuid::Uuid) -> Self {
        Self::new(key, Kind::Transcript { token })
            .size(Size::Fill)
            .on(On::Transcript)
    }
    pub fn rule(key: impl Into<Cow<'static, str>>) -> Self {
        Self::new(key, Kind::Rule).size(Size::Fixed(1))
    }
    pub fn scroll(key: impl Into<Cow<'static, str>>, child: Node<M>) -> Self {
        Self::new(key, Kind::Scroll(Box::new(child))).size(Size::Fill)
    }
    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }
    pub fn gap(mut self, rows: u16) -> Self {
        if let Kind::Column { gap, .. } | Kind::Row { gap, .. } = &mut self.kind {
            *gap = rows;
        }
        self
    }
    pub fn align(mut self, to: Align) -> Self {
        if let Kind::Text { align, .. } = &mut self.kind {
            *align = to;
        }
        self
    }
    /// One row, truncated with an ellipsis instead of wrapping.
    pub fn clip(mut self) -> Self {
        if let Kind::Text { clip, .. } = &mut self.kind {
            *clip = true;
        }
        self
    }
    pub fn on(mut self, on: On<M>) -> Self {
        self.on = Some(on);
        self
    }
    pub fn enabled(mut self, enabled: bool) -> Self {
        self.enabled = enabled;
        self
    }
    pub fn current(mut self, current: bool) -> Self {
        self.current = current;
        self
    }
    pub fn follow_focus(mut self) -> Self {
        self.follow_focus = true;
        self
    }
    pub fn focus_group(mut self) -> Self {
        self.focus_group = true;
        self
    }
    pub fn submit(mut self, message: M) -> Self {
        self.submit = Some(message);
        self
    }
    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
    /// The same tree speaking another page's messages, so one page can
    /// embed what another builds.
    pub fn map<N>(self, f: &dyn Fn(M) -> N) -> Node<N> {
        let kind = match self.kind {
            Kind::Column { children, gap } => Kind::Column {
                children: children.into_iter().map(|child| child.map(f)).collect(),
                gap,
            },
            Kind::Row { children, gap } => Kind::Row {
                children: children.into_iter().map(|child| child.map(f)).collect(),
                gap,
            },
            Kind::Boundary {
                body,
                bottom,
                padding,
                emphasis,
                activity,
            } => Kind::Boundary {
                body: Box::new(body.map(f)),
                bottom: bottom.map(|node| Box::new(node.map(f))),
                padding,
                emphasis,
                activity,
            },
            Kind::Text { spans, align, clip } => Kind::Text { spans, align, clip },
            Kind::Rule => Kind::Rule,
            Kind::Slot => Kind::Slot,
            Kind::Transcript { token } => Kind::Transcript { token },
            Kind::Scroll(child) => Kind::Scroll(Box::new(child.map(f))),
        };
        let on = self.on.map(|on| match on {
            On::Activate(message) => On::Activate(f(message)),
            On::Choose { choices, current } => On::Choose {
                choices: choices
                    .into_iter()
                    .map(|choice| Choice {
                        label: choice.label,
                        action: f(choice.action),
                    })
                    .collect(),
                current,
            },
            On::Scroll => On::Scroll,
            On::Transcript => On::Transcript,
        });
        Node {
            key: self.key,
            size: self.size,
            kind,
            on,
            enabled: self.enabled,
            current: self.current,
            follow_focus: self.follow_focus,
            focus_group: self.focus_group,
            submit: self.submit.map(f),
            hint: self.hint,
            role: self.role,
        }
    }
}
