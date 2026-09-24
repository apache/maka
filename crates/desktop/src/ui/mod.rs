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

//! The few controls the client draws itself. Every control answers the
//! mouse and, once focused with Tab, bare Enter and Space; hover is an
//! instant wash and the cursor stays an arrow, as in native apps.

pub mod motion;
pub mod scrollbar;
pub mod select;

use crate::theme::theme;
use gpui_kit::{
    AnyView, App, AppContext, ClickEvent, ClipboardItem, Context, Div, ElementId, FontWeight, Hsla,
    InteractiveElement, IntoElement, KeyDownEvent, ListState, ParentElement, Render, Role,
    SharedString, Stateful, StatefulInteractiveElement, Styled, Svg, Window, div,
    prelude::FluentBuilder, px, svg,
};
use std::{rc::Rc, time::Duration};

gpui_kit::assets::icon_assets!(pub Icons, [
    Pencil,
    Wrench,
    Sparkles,
    Hourglass,
    Square,
    List,
    MessageCircleQuestionMark,
    SquarePen,
]);

/// Our icons first, then gpui-kit's default set.
pub struct Assets;

impl gpui_kit::AssetSource for Assets {
    fn load(&self, path: &str) -> gpui_kit::Result<Option<std::borrow::Cow<'static, [u8]>>> {
        match Icons.load(path)? {
            Some(bytes) => Ok(Some(bytes)),
            None => gpui_kit::assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> gpui_kit::Result<Vec<SharedString>> {
        let mut paths = Icons.list(path)?;
        paths.extend(gpui_kit::assets::Assets.list(path)?);
        Ok(paths)
    }
}

/// A Lucide icon. An svg does not inherit its parent's text color, so the
/// color is required; follow a parent's hover with `group_hover`.
pub fn icon(path: &'static str, color: Hsla) -> Svg {
    svg()
        .path(SharedString::new_static(path))
        .size(px(14.))
        .flex_none()
        .text_color(color)
}

/// Tells `list` which rows changed between two orders of stable keys, so
/// unchanged rows keep their measured heights and the scroll position holds.
pub fn splice(list: &ListState, old: &[String], new: &[String]) {
    let prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    if prefix + suffix < old.len().max(new.len()) {
        list.splice(prefix..old.len() - suffix, new.len() - prefix - suffix);
    }
}

type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

/// Makes `element` a control: clicked, or activated with bare Enter or Space
/// once focused. Chords are left alone so their commands still run.
pub fn pressable(
    element: Stateful<Div>,
    on_press: impl Fn(&mut Window, &mut App) + 'static,
) -> Stateful<Div> {
    let on_press: Handler = Rc::new(on_press);
    let on_key = on_press.clone();
    element
        .role(Role::Button)
        .tab_index(0)
        .on_click(move |_: &ClickEvent, window, cx| {
            cx.stop_propagation();
            on_press(window, cx)
        })
        .on_key_down(move |event: &KeyDownEvent, window, cx| {
            let key = &event.keystroke;
            if matches!(key.key.as_str(), "enter" | "space") && !key.modifiers.modified() {
                cx.stop_propagation();
                on_key(window, cx);
            }
        })
}

#[derive(Clone, Copy, PartialEq)]
pub enum Tone {
    /// The one action the card is for.
    Primary,
    Outline,
}

/// A labeled button, 28 tall.
pub fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    tone: Tone,
    disabled: bool,
    on_press: impl Fn(&mut Window, &mut App) + 'static,
    cx: &App,
) -> Stateful<Div> {
    let theme = theme(cx);
    let base = div()
        .id(id)
        .h(px(28.))
        .px(px(13.))
        .flex()
        .items_center()
        .justify_center()
        .rounded(px(7.))
        .border_1()
        .text_size(px(12.5))
        .font_weight(FontWeight::SEMIBOLD)
        .focus_visible(|style| style.border_color(theme.accent))
        .map(|this| match tone {
            Tone::Primary => this
                .bg(theme.accent_solid)
                .border_color(theme.accent_solid)
                .text_color(theme.on_accent)
                .when(!disabled, |this| this.hover(|style| style.opacity(0.9))),
            Tone::Outline => this
                .border_color(theme.border)
                .text_color(theme.muted)
                .when(!disabled, |this| {
                    this.hover(|style| style.bg(theme.hover).text_color(theme.text))
                }),
        })
        .child(label.into());
    if disabled {
        base.opacity(0.5)
    } else {
        pressable(base, on_press).active(|style| style.opacity(0.8))
    }
}

/// A square icon button: 26 with a 14 icon, or 22 with a 13 icon when small.
pub fn icon_button(
    id: impl Into<ElementId>,
    path: &'static str,
    small: bool,
    on_press: impl Fn(&mut Window, &mut App) + 'static,
    cx: &App,
) -> Stateful<Div> {
    let theme = theme(cx);
    let (box_size, icon_size) = if small { (22., 13.) } else { (26., 14.) };
    let id = id.into();
    let group = SharedString::from(format!("{id}"));
    pressable(
        div()
            .id(id)
            .group(group.clone())
            .size(px(box_size))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(6.))
            .border_1()
            .border_color(gpui_kit::transparent_black())
            .hover(|style| style.bg(theme.hover))
            .focus_visible(|style| style.border_color(theme.accent))
            .child(
                icon(path, theme.muted)
                    .size(px(icon_size))
                    .group_hover(group, |style| style.text_color(theme.text)),
            ),
        on_press,
    )
}

/// A one-line tooltip for `.tooltip(tooltip("…"))`.
pub fn tooltip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView {
    let text = text.into();
    move |_, cx| {
        let text = text.clone();
        cx.new(|_| Tooltip(text)).into()
    }
}

struct Tooltip(SharedString);

impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = theme(cx);
        div().pl(px(2.)).pt(px(4.)).child(
            div()
                .px(px(7.))
                .py(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(theme.border)
                .bg(theme.overlay)
                .shadow_md()
                .text_size(px(12.5))
                .line_height(px(15.))
                .text_color(theme.muted)
                .child(self.0.clone()),
        )
    }
}

/// Which copy button shows its check mark. One per window: copying anything
/// else takes the check away, and an older timer cannot clear a newer copy.
#[derive(Default)]
pub struct Copied {
    key: Option<SharedString>,
    generation: u64,
}

impl Copied {
    pub fn is(&self, key: &str) -> bool {
        self.key.as_deref() == Some(key)
    }

    pub fn copy(&mut self, key: SharedString, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.key = Some(key);
        self.generation += 1;
        let generation = self.generation;
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(2)).await;
            let _ = this.update(cx, |this, cx| {
                if this.generation == generation {
                    this.key = None;
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::AssetSource;

    #[test]
    fn every_icon_the_client_draws_is_embedded() {
        let mut missing = Vec::new();
        for file in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/src"))
            .into_iter()
            .flatten()
            .flatten()
            .flat_map(|entry| walk(entry.path()))
        {
            let source = std::fs::read_to_string(&file).unwrap_or_default();
            for path in source.split('"').filter(|part| {
                part.starts_with("icons/") && part.ends_with(".svg") && !part.contains(' ')
            }) {
                if !matches!(super::Assets.load(path), Ok(Some(_))) {
                    missing.push(path.to_owned());
                }
            }
        }
        assert!(missing.is_empty(), "not embedded: {missing:?}");
    }

    fn walk(path: std::path::PathBuf) -> Vec<std::path::PathBuf> {
        if path.is_dir() {
            std::fs::read_dir(&path)
                .into_iter()
                .flatten()
                .flatten()
                .flat_map(|entry| walk(entry.path()))
                .collect()
        } else {
            vec![path]
        }
    }
}
