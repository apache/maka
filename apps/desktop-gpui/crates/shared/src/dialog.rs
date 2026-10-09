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

//! The header every dialog draws, after Maka Desktop's `DialogHeader`
//! (@astryxdesign/core `Dialog/DialogHeader.tsx`): the title at the heading
//! rung (16/24, 600) with an optional quiet line under it on the left; the
//! header's own actions, then the close button, on the right, in a row
//! centred on the title's first line, the close button's edge on the edge of
//! the content under it.
//!
//! gpui-kit's dialog draws its close button in the surface's corner, above
//! the title line and outside the content's edge, where it collides with a
//! header action. [`DialogHeaderExt::with_header`] turns that one off and
//! puts this header in the title's place. Its close button dispatches the
//! dialog's `Cancel` from inside the header, as Escape does, so `on_cancel`
//! and `on_close` run either way.
//!
//! gpui-kit puts a dialog a tenth of the window down, whatever its height;
//! Desktop centres it. A dialog cannot know its height before it is laid
//! out, so [`DialogHeaderExt`] centres it from the frame before: the
//! header records where its top was drawn, the footer
//! ([`DialogHeaderExt::with_footer`]) or a confirmation's description
//! ([`confirmation_text`]) where the dialog ends, and the next frame's
//! top margin puts the dialog's middle on the window's. A dialog seen
//! before opens centred at once; a new one moves there on its second frame.

use gpui_kit::base::actions::Cancel;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::{AlertDialog, Dialog, DialogAction, DialogFooter};
use gpui_kit::component::{IconName, Sizable as _, WindowExt as _, h_flex, v_flex};
use std::cell::RefCell;
use std::collections::HashMap;

use gpui_kit::{
    AnyElement, App, ElementId, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, Pixels, RenderOnce, SharedString, StatefulInteractiveElement as _,
    Styled as _, TestSupportExt as _, Window, canvas, div, prelude::FluentBuilder as _, px, rems,
};

use crate::copy;
use crate::theme::{ActiveMakaPalette as _, BODY_TEXT_REMS, HEADING_LINE_REMS, HEADING_TEXT_REMS};

/// Id of the header's title block, unless the dialog names its own.
pub const DIALOG_TITLE_ID: &str = "dialog-title";
/// Id of the header's close button.
pub const DIALOG_CLOSE_ID: &str = "dialog-close";

/// gpui-kit's dialog padding, and a confirmation's: Desktop's `toast.confirm`
/// is Astryx `AlertDialog`, 400px wide, whose `Layout` takes the dialog's
/// default padding, `--spacing-4`, on every side and between the text and
/// the buttons (Maka's theme sets no `--astryx-dialog-padding`).
const DIALOG_PADDING: Pixels = px(16.);
const CONFIRMATION_PADDING: Pixels = px(16.);
const CONFIRMATION_WIDTH: Pixels = px(400.);
/// gpui-kit's 1px ring around the dialog, inside its edge.
const DIALOG_BORDER: Pixels = px(1.);
/// The least room a centred dialog keeps above it, gpui-kit's margin below.
const MIN_MARGIN: Pixels = px(16.);
/// A confirmation's footer, which gpui-kit draws: its gap above (the
/// padding), then a row of 32px buttons.
const CONFIRMATION_FOOTER: Pixels = px(32.);

/// The header drawn last: its dialog's key, where its top was, and the
/// dialog's padding.
#[derive(Clone)]
struct HeaderProbe {
    key: SharedString,
    top: Pixels,
    padding: Pixels,
}

thread_local! {
    static LAST_HEADER: RefCell<Option<HeaderProbe>> = const { RefCell::new(None) };
    /// Each dialog's top margin that centres it, by its title, and how far
    /// that is below gpui-kit's own (a tenth of the window down).
    static CENTRED: RefCell<HashMap<SharedString, (Pixels, Pixels)>> =
        RefCell::new(HashMap::new());
}

/// Records where the dialog that drew the last header ends (`bottom`, its
/// lower edge in window coordinates) and, when the margin that centres it
/// changed, redraws.
fn dialog_ends_at(bottom: Pixels, window: &mut Window) {
    let Some(header) = LAST_HEADER.with(|last| last.borrow().clone()) else {
        return;
    };
    let height = (bottom + DIALOG_BORDER) - (header.top - header.padding - DIALOG_BORDER);
    let viewport = window.viewport_size().height;
    let margin = ((viewport - height) / 2.).max(MIN_MARGIN);
    let changed = CENTRED.with(|centred| {
        let previous = centred.borrow_mut().insert(header.key, (margin, margin - viewport / 10.));
        previous.is_none_or(|(previous, _)| (previous - margin).abs() > px(0.5))
    });
    if changed {
        window.refresh();
    }
}

/// The top margin that centred the dialog titled `key` last time, and
/// how far it is below gpui-kit's.
fn centred_margin(key: &SharedString) -> Option<(Pixels, Pixels)> {
    CENTRED.with(|centred| centred.borrow().get(key).copied())
}

/// A confirmation's text (an alert's description), with the probe that
/// tells where the dialog ends: under the text are only gpui-kit's footer
/// and the padding.
pub fn confirmation_text(text: impl Into<SharedString>) -> impl IntoElement {
    v_flex().id("confirmation-text").test_support().child(text.into()).child(
        canvas(
            |bounds, window, _| {
                dialog_ends_at(
                    bounds.bottom()
                        + CONFIRMATION_PADDING
                        + CONFIRMATION_FOOTER
                        + CONFIRMATION_PADDING,
                    window,
                )
            },
            |_, _, _, _| {},
        )
        .w_full()
        .h_0(),
    )
}

/// A confirmation's two answers at Maka's control size (32px, labels at
/// 14/500), which gpui-kit's own footer draws at 16: Cancel as the quiet
/// button, then the final action, solid primary or, for one that cannot
/// be undone, solid danger. Cancel closes the alert and gives focus back,
/// as Escape does (it runs no `on_cancel`; these alerts have none); the
/// final action confirms it as Enter does, so the alert's `on_ok` runs
/// either way. Set it with `.footer(...)` beside `.on_ok(...)`.
pub fn confirmation_answers(
    cancel: impl Into<SharedString>,
    ok: impl Into<SharedString>,
    danger: bool,
    cx: &App,
) -> DialogFooter {
    let cancel = cancel.into();
    let ok = ok.into();
    let ok_button = crate::theme::control_button(Button::new("ok"));
    let ok_button = if danger { ok_button.danger() } else { ok_button.primary() };
    // Each at its own width, at the footer's end (the kit's wrappers would
    // share the row out between them).
    DialogFooter::new()
        .child(
            crate::theme::quiet_button(Button::new("cancel"), cx)
                .label(cancel)
                .on_click(|_, window, cx| window.close_dialog(cx)),
        )
        .child(div().flex_none().child(DialogAction::new().child(ok_button.label(ok))))
}

/// The probe for a dialog with no footer, as its body's last child: under
/// the body is only the padding.
pub fn dialog_end() -> impl IntoElement {
    canvas(
        |bounds, window, _| dialog_ends_at(bounds.bottom() + DIALOG_PADDING, window),
        |_, _, _, _| {},
    )
    .w_full()
    .h_0()
}

/// A dialog's header: see the module documentation. The title block has
/// the title as its accessible label.
#[derive(IntoElement)]
pub struct DialogHeader {
    id: ElementId,
    title: SharedString,
    subtitle: Option<AnyElement>,
    actions: Vec<AnyElement>,
    closable: bool,
    padding: Pixels,
}

impl std::fmt::Debug for DialogHeader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialogHeader")
            .field("id", &self.id)
            .field("title", &self.title)
            .field("actions", &self.actions.len())
            .field("closable", &self.closable)
            .finish_non_exhaustive()
    }
}

impl DialogHeader {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            id: DIALOG_TITLE_ID.into(),
            title: title.into(),
            subtitle: None,
            actions: Vec::new(),
            closable: true,
            padding: DIALOG_PADDING,
        }
    }

    /// The title block's id, for a dialog its tests find by name (default
    /// [`DIALOG_TITLE_ID`]).
    pub fn id(mut self, id: impl Into<ElementId>) -> Self {
        self.id = id.into();
        self
    }

    /// A quiet line under the title (12px muted), wrapped, never clipped.
    pub fn subtitle(mut self, subtitle: impl IntoElement) -> Self {
        self.subtitle = Some(subtitle.into_any_element());
        self
    }

    /// An action of the header ("Use template"), placed before the close
    /// button: a labelled action at the control height (32px), centred on
    /// the title line.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }

    /// Whether the close button shows (default: it does). A dialog that
    /// cannot be dismissed now (its work is in flight, a first-launch
    /// choice) hides it.
    pub fn closable(mut self, closable: bool) -> Self {
        self.closable = closable;
        self
    }
}

impl RenderOnce for DialogHeader {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        // The close button dispatches from this node, inside the dialog,
        // whatever holds focus (the kit's own close does the same).
        let anchor = window
            .use_keyed_state("dialog-header-anchor", cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let dispatcher = anchor.clone();
        let close = self.closable.then(|| {
            Button::new(DIALOG_CLOSE_ID)
                .small()
                .ghost()
                .icon(IconName::Close)
                .accessibility_label(copy::CLOSE.get(cx))
                .tooltip(copy::CLOSE.get(cx))
                .on_click(move |_, window, cx| dispatcher.dispatch_action(&Cancel, window, cx))
        });
        let line = rems(HEADING_LINE_REMS);
        let has_actions = !self.actions.is_empty();
        let probe = HeaderProbe { key: self.title.clone(), top: px(0.), padding: self.padding };
        h_flex()
            .id("dialog-header")
            .test_support()
            .w_full()
            .items_start()
            .gap_3()
            // The kit's title slot is semibold; the subtitle is not.
            .font_weight(FontWeight::NORMAL)
            .child(div().absolute().size_0().track_focus(&anchor))
            .child(
                canvas(
                    move |bounds, _, _| {
                        let probe = HeaderProbe { top: bounds.top(), ..probe };
                        LAST_HEADER.with(|last| *last.borrow_mut() = Some(probe));
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_0(),
            )
            .child(
                v_flex()
                    .id(self.id)
                    .test_support()
                    .aria_label(self.title.clone())
                    .flex_1()
                    .min_w_0()
                    .when(has_actions, |this| this.mt_1())
                    .child(
                        div()
                            .text_size(rems(HEADING_TEXT_REMS))
                            .line_height(line)
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(cx.maka().ink)
                            .child(self.title),
                    )
                    // Supporting text, 12/20, 8 under the title.
                    .children(self.subtitle.map(|subtitle| {
                        div()
                            .mt_2()
                            .text_xs()
                            .line_height(rems(1.25))
                            .text_color(cx.maka().ink_muted)
                            .child(subtitle)
                    })),
            )
            .when(!self.actions.is_empty() || close.is_some(), |this| {
                // One title line tall, so every control centres on it; with
                // a labelled action the row is the control height (32px)
                // and the title moves down 4px to stay centred on it (the
                // dialog clips anything above its header).
                this.child(
                    h_flex()
                        .id("dialog-header-actions")
                        .test_support()
                        .flex_shrink_0()
                        .map(|this| if has_actions { this.h_8() } else { this.h(line) })
                        .items_center()
                        .gap_2()
                        // Button labels: the label rung, 14/500.
                        .text_size(rems(BODY_TEXT_REMS))
                        .font_weight(FontWeight::MEDIUM)
                        .children(self.actions)
                        .children(close),
                )
            })
    }
}

/// Puts a [`DialogHeader`] in a dialog's title place, and centres the
/// dialog once its end is known (see the module documentation).
pub trait DialogHeaderExt: Sized {
    fn with_header(self, header: DialogHeader) -> Self;

    /// The dialog's footer, with the probe that tells where the dialog
    /// ends: under the footer is only the padding.
    fn with_footer(self, footer: impl IntoElement) -> Self;
}

impl DialogHeaderExt for Dialog {
    /// Hides the kit's corner close button; the header draws its own.
    fn with_header(self, header: DialogHeader) -> Self {
        let margin = centred_margin(&header.title);
        self.close_button(false).title(header).when_some(margin, |this, (m, _)| this.margin_top(m))
    }

    fn with_footer(self, footer: impl IntoElement) -> Self {
        self.footer(
            v_flex().w_full().child(footer).child(
                canvas(
                    |bounds, window, _| dialog_ends_at(bounds.bottom() + DIALOG_PADDING, window),
                    |_, _, _, _| {},
                )
                .w_full()
                .h_0(),
            ),
        )
    }
}

impl DialogHeaderExt for AlertDialog {
    /// An alert answers with its buttons and Escape: as in Desktop's, its
    /// header has no close button. It is Desktop's confirmation: 400px
    /// wide with 16px around; give it its text with [`confirmation_text`].
    /// gpui-kit's alert takes no top margin, so the surface moves down by
    /// its own margin instead.
    fn with_header(self, header: DialogHeader) -> Self {
        let margin = centred_margin(&header.title);
        let header = DialogHeader { padding: CONFIRMATION_PADDING, ..header.closable(false) };
        self.close_button(false)
            .width(CONFIRMATION_WIDTH)
            .p(CONFIRMATION_PADDING)
            .title(header)
            .when_some(margin, |this, (_, below)| this.mt(below))
    }

    fn with_footer(self, footer: impl IntoElement) -> Self {
        self.footer(footer)
    }
}

#[cfg(test)]
mod tests {
    use gpui_kit::component::Root;
    use gpui_kit::test::TestWindowExt as _;
    use gpui_kit::{
        AppContext as _, Bounds, Context, Pixels, Render, TestAppContext, WindowHandle, px, size,
    };

    use super::*;

    struct Host;

    impl Render for Host {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            div().size_full()
        }
    }

    /// A dialog of `width` in a window `window_width` wide: the header with
    /// `title`, a "Use template" action and the close button, over a body
    /// as wide as the content.
    fn open(
        title: &'static str,
        width: Pixels,
        window_width: Pixels,
        cx: &mut TestAppContext,
    ) -> WindowHandle<Root> {
        cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_reduce_motion(true);
        });
        let window = cx.open_window(size(window_width, px(885.)), |window, cx| {
            Root::new(cx.new(|_| Host), window, cx)
        });
        cx.update_window(window.into(), |_, window, cx| {
            window.open_dialog(cx, move |dialog, _, _| {
                dialog
                    .w(width)
                    .with_header(
                        DialogHeader::new(title).id("probe-title").action(
                            Button::new("probe-action").small().ghost().label("Use template"),
                        ),
                    )
                    .child(div().id("probe-body").test_support().w_full().h_8())
            });
        })
        .expect("window");
        for _ in 0..2 {
            cx.update_window(window.into(), |_, window, cx| window.render_frame(cx))
                .expect("window");
            cx.run_until_parked();
        }
        window
    }

    fn bounds(
        window: WindowHandle<Root>,
        id: &'static str,
        cx: &mut TestAppContext,
    ) -> Bounds<Pixels> {
        cx.update_window(window.into(), |_, window, _| window.find(id).bounds()).expect("window")
    }

    fn assert_recipe(window: WindowHandle<Root>, cx: &mut TestAppContext) {
        let title = bounds(window, "probe-title", cx);
        let action = bounds(window, "probe-action", cx);
        let close = bounds(window, DIALOG_CLOSE_ID, cx);
        let body = bounds(window, "probe-body", cx);
        let line = px(24.);
        let first_line = title.top() + line / 2.;
        let centre = |b: Bounds<Pixels>| b.top() + b.size.height / 2.;
        assert!((centre(close) - first_line).abs() < px(1.), "close {close:?}, title {title:?}");
        assert!((centre(action) - first_line).abs() < px(1.), "action {action:?}");
        assert!((close.right() - body.right()).abs() < px(1.), "close {close:?}, body {body:?}");
        assert!(action.right() <= close.left(), "action {action:?}, close {close:?}");
        assert!(title.right() <= action.left(), "title {title:?}, action {action:?}");
        assert!((title.left() - body.left()).abs() < px(1.), "title {title:?}, body {body:?}");
        assert!(close.bottom() <= body.top(), "close {close:?}, body {body:?}");
        // The kit's corner button is gone: one close button.
        let kit_close = cx
            .update_window(window.into(), |_, window, _| window.try_find("close").is_some())
            .expect("window");
        assert!(!kit_close, "the kit's close button still draws");
    }

    #[gpui_kit::test]
    fn the_close_button_sits_on_the_title_line_at_the_contents_edge(cx: &mut TestAppContext) {
        let window = open("New scheduled task", px(480.), px(1512.), cx);
        assert_recipe(window, cx);
    }

    #[gpui_kit::test]
    fn a_long_title_wraps_beside_the_actions_in_a_narrow_dialog(cx: &mut TestAppContext) {
        let title = "A scheduled task whose name runs much longer than one line of the header";
        let window = open(title, px(480.), px(400.), cx);
        assert_recipe(window, cx);
        let title = bounds(window, "probe-title", cx);
        assert!(title.size.height > px(30.), "the title wraps: {title:?}");
    }

    #[gpui_kit::test]
    fn a_dialog_with_a_footer_is_centred_in_the_window(cx: &mut TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            cx.set_reduce_motion(true);
        });
        let window = cx.open_window(size(px(1512.), px(885.)), |window, cx| {
            Root::new(cx.new(|_| Host), window, cx)
        });
        cx.update_window(window.into(), |_, window, cx| {
            window.open_dialog(cx, move |dialog, _, _| {
                dialog
                    .w(px(480.))
                    .with_header(DialogHeader::new("Centred probe").id("probe-title"))
                    .child(div().w_full().h(px(200.)))
                    .with_footer(div().id("probe-footer").test_support().w_full().h_8())
            });
        })
        .expect("window");
        for _ in 0..3 {
            cx.update_window(window.into(), |_, window, cx| window.render_frame(cx))
                .expect("window");
            cx.run_until_parked();
        }
        let title = bounds(window, "probe-title", cx);
        let footer = bounds(window, "probe-footer", cx);
        let ring = DIALOG_BORDER + DIALOG_PADDING;
        let (top, bottom) = (title.top() - ring, footer.bottom() + ring);
        let middle = (top + bottom) / 2.;
        assert!((middle - px(885. / 2.)).abs() < px(1.), "top {top:?}, bottom {bottom:?}");
    }

    #[gpui_kit::test]
    fn the_close_button_cancels_the_dialog(cx: &mut TestAppContext) {
        let window = open("New scheduled task", px(480.), px(1512.), cx);
        cx.update_window(window.into(), |_, window, cx| window.click(DIALOG_CLOSE_ID, cx))
            .expect("window");
        cx.run_until_parked();
        let open = cx
            .update_window(window.into(), |_, window, cx| window.has_active_dialog(cx))
            .expect("window");
        assert!(!open);
    }
}
