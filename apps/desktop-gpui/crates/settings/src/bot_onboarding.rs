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

//! The two QR dialogs of the Remote access page, after Maka Desktop's
//! `BotOnboardingModal` (bot-onboarding-modal.tsx) and `WechatQrLoginModal`
//! (bot-wechat-login.tsx), and the QR code they draw.
//!
//! - [`OnboardingDialog`] runs one QR onboarding through [`BotService`]:
//!   the code, the line that says where it stands, polling on the
//!   provider's schedule (at least 400 ms apart, as Desktop), and the
//!   actions (Done, Generate again, Refresh QR code, Cancel, Open in
//!   browser). A confirmed scan is saved by the service; the dialog only
//!   hears how it ended, and tells the page ([`OnboardingEvent`]).
//! - [`BridgeQrDialog`] shows the local wechat-bridge's sign-in code,
//!   fetched again every 3 s until it is scanned or expires.
//!
//! A QR code is drawn here from the text it encodes (or decoded from the
//! image a provider sent), black on white in every theme, with its quiet
//! zone, as Desktop keeps its QR frame white: a phone camera needs the
//! contrast.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use bots::{
    BotProvider, BotService, BotServiceEvent, OnboardingBrand, OnboardingQr, OnboardingSnapshot,
    OnboardingState, WechatBridgeQr,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::dialog::Dialog;
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, RenderImage, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, TestSupportExt as _, Window, div, img, rems,
};
use qrcode::{Color, EcLevel, QrCode};
use shared::copy::Locale;
use shared::copy::bots as copy;
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::icons::MakaIcon;
use shared::theme::{ActiveMakaPalette as _, control_button, quiet_button};

use crate::bot_chat_view::{self as view, label, onboarding_copy, reason_message, retry_reason};

/// The drawn code's edge, in rems (Desktop's 320px QR frame, less its
/// padding).
const QR_EDGE_REMS: f32 = 14.;

/// Pixels per module of a code drawn here, and its quiet zone in modules.
const QR_MODULE_PX: usize = 8;
const QR_QUIET_MODULES: usize = 2;

/// The shortest wait between two polls (Desktop's `Math.max(400, …)`).
const MIN_POLL: Duration = Duration::from_millis(400);

/// How often the bridge's code is fetched again while it waits.
const BRIDGE_REFRESH: Duration = Duration::from_secs(3);

/// Draws `qr`: the code of its text, or the image it carries.
pub(crate) fn qr_image(qr: &OnboardingQr) -> Option<Arc<RenderImage>> {
    match qr {
        OnboardingQr::Text(text) => encode_qr(text),
        OnboardingQr::Image(url) => decode_data_url(url),
    }
}

/// The QR code of `text` at error correction M, as Desktop's `qrcode`
/// renders it.
fn encode_qr(text: &str) -> Option<Arc<RenderImage>> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M).ok()?;
    let width = code.width();
    let colors = code.to_colors();
    let side = u32::try_from((width + 2 * QR_QUIET_MODULES) * QR_MODULE_PX).ok()?;
    // Image content, not interface colour: a scanner needs black on white.
    let light = image::Rgba([255, 255, 255, 255]);
    let dark = image::Rgba([0, 0, 0, 255]);
    let frame = image::RgbaImage::from_fn(side, side, |x, y| {
        let module = |pixel: u32| (pixel as usize / QR_MODULE_PX).checked_sub(QR_QUIET_MODULES);
        match (module(x), module(y)) {
            (Some(column), Some(row))
                if column < width && row < width && colors[row * width + column] == Color::Dark =>
            {
                dark
            }
            _ => light,
        }
    });
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(frame)])))
}

/// A `data:image/...;base64,` URL as an image (GPUI draws BGRA).
fn decode_data_url(url: &str) -> Option<Arc<RenderImage>> {
    let (header, payload) = url.strip_prefix("data:image/")?.split_once(',')?;
    if !header.ends_with(";base64") {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload.trim()).ok()?;
    let mut frame = image::load_from_memory(&bytes).ok()?.into_rgba8();
    for pixel in frame.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(vec![image::Frame::new(frame)])))
}

/// What the onboarding dialog tells the page.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum OnboardingEvent {
    /// The scan was confirmed and the channel saved; the snapshot says
    /// whether its listener started.
    Connected(Box<OnboardingSnapshot>),
    /// Done or Cancel closed the dialog (closing it otherwise, the dialog's
    /// own `on_close` says so).
    Dismissed,
}

/// Where the dialog stands.
#[derive(Debug, Clone, PartialEq)]
enum Phase {
    /// Waiting for the chat bots to run, then for the first snapshot.
    Starting,
    Session(Box<OnboardingSnapshot>),
    /// The service refused, in words.
    Failed(SharedString),
}

/// Behavior and presentation owner of one QR onboarding.
pub(crate) struct OnboardingDialog {
    bots: Entity<BotService>,
    provider: BotProvider,
    brand: Option<OnboardingBrand>,
    phase: Phase,
    /// The code, kept from the first snapshot (later ones do not carry it).
    qr: Option<Arc<RenderImage>>,
    /// Bumped by every start; an answer for an older session is dropped.
    generation: u64,
    notified: bool,
    /// Images to take off the GPU once the dialog is gone.
    retired: Vec<Arc<RenderImage>>,
    _task: Option<Task<()>>,
    _subscription: Subscription,
}

impl std::fmt::Debug for OnboardingDialog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OnboardingDialog")
            .field("provider", &self.provider)
            .field("phase", &self.phase)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<OnboardingEvent> for OnboardingDialog {}

impl OnboardingDialog {
    /// A dialog for `provider` that starts its session once the chat bots
    /// run.
    pub(crate) fn new(
        bots: Entity<BotService>,
        provider: BotProvider,
        brand: Option<OnboardingBrand>,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscription = cx.subscribe(&bots, |this, bots, event: &BotServiceEvent, cx| {
            if matches!(event, BotServiceEvent::StateChanged)
                && this.phase == Phase::Starting
                && this._task.is_none()
                && bots.read(cx).is_running()
            {
                this.start(cx);
            }
        });
        let mut this = Self {
            bots,
            provider,
            brand,
            phase: Phase::Starting,
            qr: None,
            generation: 0,
            notified: false,
            retired: Vec::new(),
            _task: None,
            _subscription: subscription,
        };
        if this.bots.read(cx).is_running() {
            this.start(cx);
        }
        this
    }

    /// The session's last snapshot.
    pub(crate) fn snapshot(&self) -> Option<&OnboardingSnapshot> {
        match &self.phase {
            Phase::Session(snapshot) => Some(snapshot.as_ref()),
            _ => None,
        }
    }

    /// Whether a code is drawn.
    pub(crate) fn shows_qr(&self) -> bool {
        self.qr.is_some()
            && !matches!(
                self.snapshot().map(|snapshot| snapshot.state),
                Some(OnboardingState::Expired | OnboardingState::Denied | OnboardingState::Error)
            )
    }

    /// Starts a new session, cancelling the one shown.
    pub(crate) fn start(&mut self, cx: &mut Context<Self>) {
        self.cancel(cx);
        self.generation += 1;
        let generation = self.generation;
        self.phase = Phase::Starting;
        self.notified = false;
        self.retired.extend(self.qr.take());
        let task =
            self.bots.update(cx, |bots, cx| bots.start_onboarding(self.provider, self.brand, cx));
        let locale = Locale::current(cx);
        self._task = Some(cx.spawn(async move |this, cx| {
            let started = task.await;
            let drawn = match &started {
                Ok(snapshot) => match snapshot.qr.clone() {
                    Some(qr) => cx.background_spawn(async move { qr_image(&qr) }).await,
                    None => None,
                },
                Err(_) => None,
            };
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this._task = None;
                match started {
                    Ok(snapshot) => {
                        this.qr = drawn;
                        this.show(snapshot, cx);
                    }
                    Err(error) => {
                        log::warn!("the bot onboarding did not start: {error}");
                        let message = view::onboarding_error(None).in_locale(locale);
                        this.phase = Phase::Failed(message.into());
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    /// Takes `snapshot` and polls again when it says to.
    fn show(&mut self, snapshot: OnboardingSnapshot, cx: &mut Context<Self>) {
        let pending = snapshot.state.is_pending();
        let delay = Duration::from_millis(snapshot.next_poll_after_ms).max(MIN_POLL);
        let session: SharedString = snapshot.session_id.clone().into();
        if snapshot.state == OnboardingState::Connected && !self.notified {
            self.notified = true;
            cx.emit(OnboardingEvent::Connected(Box::new(snapshot.clone())));
        }
        self.phase = Phase::Session(Box::new(snapshot));
        if !pending {
            return;
        }
        let generation = self.generation;
        let bots = self.bots.clone();
        self._task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let poll = bots.update(cx, |bots, cx| bots.poll_onboarding(session, cx));
            let polled = poll.await;
            let _ = this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                this._task = None;
                match polled {
                    Ok(snapshot) => this.show(snapshot, cx),
                    Err(error) => {
                        log::warn!("polling the bot onboarding failed: {error}");
                        let locale = Locale::current(cx);
                        let message = view::onboarding_error(None).in_locale(locale);
                        this.phase = Phase::Failed(message.into());
                    }
                }
                cx.notify();
            });
        }));
    }

    /// Cancels the session shown, if it still runs.
    pub(crate) fn cancel(&mut self, cx: &mut Context<Self>) {
        self.generation += 1;
        self._task = None;
        if let Phase::Session(snapshot) = &self.phase {
            let session: SharedString = snapshot.session_id.clone().into();
            self.bots.update(cx, |bots, cx| bots.cancel_onboarding(session, cx));
        }
    }

    /// The dialog closes: the session ends and the code leaves the GPU.
    pub(crate) fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.cancel(cx);
        self.retired.extend(self.qr.take());
        for image in self.retired.drain(..) {
            cx.drop_image(image, Some(window));
        }
    }

    /// Done or Cancel: the kit's `close_dialog` does not run `on_close`,
    /// so the page hears it from here.
    fn dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        cx.emit(OnboardingEvent::Dismissed);
        window.close_dialog(cx);
    }

    fn open_in_browser(&mut self, cx: &mut Context<Self>) {
        let Some(snapshot) = self.snapshot() else {
            return;
        };
        let session: SharedString = snapshot.session_id.clone().into();
        let task = self.bots.update(cx, |bots, cx| bots.onboarding_url(session, cx));
        cx.spawn(async move |_, cx| match task.await {
            Ok(url) => cx.update(|cx| cx.open_url(&url)),
            Err(error) => log::warn!("the onboarding page cannot open: {error}"),
        })
        .detach();
    }

    /// The line under the code (`botOnboardingStatusCopy`).
    pub(crate) fn status_line(&self, locale: Locale) -> String {
        let [_, _, waiting, scanned, _] =
            onboarding_copy(self.provider, self.brand == Some(OnboardingBrand::Lark));
        let snapshot = match &self.phase {
            Phase::Starting => return copy::GENERATING.in_locale(locale).to_owned(),
            Phase::Failed(message) => return message.to_string(),
            Phase::Session(snapshot) => snapshot,
        };
        if let Some(health) = &snapshot.retry_health {
            let seconds = snapshot.next_poll_after_ms.div_ceil(1000).max(1);
            let reason = retry_reason(&health.category).in_locale(locale);
            let retry = copy::retrying(locale, reason, health.consecutive_failures, seconds);
            return if snapshot.state == OnboardingState::Scanned {
                format!("{} {retry}", scanned.in_locale(locale))
            } else {
                retry
            };
        }
        let text = match snapshot.state {
            OnboardingState::Waiting => waiting,
            OnboardingState::Scanned => scanned,
            OnboardingState::Connecting => copy::ONBOARDING_CONNECTING,
            OnboardingState::Connected => {
                if snapshot.warning_code.is_some() {
                    let detail = snapshot
                        .warning_detail
                        .as_deref()
                        .map(|detail| reason_message(detail, locale));
                    return copy::saved_not_connected(locale, detail.as_deref());
                }
                let name = label(self.provider).in_locale(locale);
                return copy::named(copy::CONNECTED, locale, name);
            }
            OnboardingState::Expired => copy::ONBOARDING_EXPIRED,
            OnboardingState::Denied => copy::ONBOARDING_DENIED,
            OnboardingState::Cancelled => copy::ONBOARDING_CANCELLED,
            OnboardingState::Error => view::onboarding_error(snapshot.error_code.as_deref()),
            _ => copy::ONBOARDING_PREPARING,
        };
        text.in_locale(locale).to_owned()
    }

    /// The dialog around the body: the title and subtitle, and the actions.
    pub(crate) fn dialog(&mut self, dialog: Dialog, cx: &mut Context<Self>) -> Dialog {
        let [title, subtitle, ..] =
            onboarding_copy(self.provider, self.brand == Some(OnboardingBrand::Lark));
        let state = self.snapshot().map(|snapshot| snapshot.state);
        let starting = self.phase == Phase::Starting;
        let failed = matches!(self.phase, Phase::Failed(_));
        let terminal = failed
            || matches!(
                state,
                Some(OnboardingState::Expired | OnboardingState::Denied | OnboardingState::Error)
            );
        let footer = h_flex().w_full().justify_end().gap_2();
        let footer = if state == Some(OnboardingState::Connected) {
            footer.child(
                control_button(Button::new("bot-onboarding-done").primary())
                    .label(copy::DONE.get(cx))
                    .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
            )
        } else if terminal {
            footer.child(
                control_button(Button::new("bot-onboarding-regenerate").primary())
                    .label(copy::REGENERATE.get(cx))
                    .on_click(cx.listener(|this, _, _, cx| this.start(cx))),
            )
        } else {
            footer
                .child(
                    quiet_button(Button::new("bot-onboarding-refresh"), cx)
                        .label(copy::REFRESH_QR.get(cx))
                        .disabled(starting || state == Some(OnboardingState::Connecting))
                        .on_click(cx.listener(|this, _, _, cx| this.start(cx))),
                )
                .child(
                    quiet_button(Button::new("bot-onboarding-cancel"), cx)
                        .label(copy::CANCEL.get(cx))
                        .on_click(cx.listener(|this, _, window, cx| this.dismiss(window, cx))),
                )
        };
        dialog
            .with_header(DialogHeader::new(title.get(cx)).subtitle(subtitle.get(cx)))
            .child(cx.entity())
            .with_footer(footer)
    }
}

impl Render for OnboardingDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let [_, _, _, _, qr_alt] =
            onboarding_copy(self.provider, self.brand == Some(OnboardingBrand::Lark));
        let state = self.snapshot().map(|snapshot| snapshot.state);
        let frame = div()
            .id("bot-onboarding-qr")
            .test_support()
            .size(rems(QR_EDGE_REMS))
            .flex()
            .items_center()
            .justify_center();
        let frame = match (&self.qr, state) {
            (Some(qr), _) if self.shows_qr() => frame
                .aria_label(qr_alt.get(cx))
                .child(img(qr.clone()).size_full().rounded(rems(0.625))),
            (_, None | Some(OnboardingState::Connecting))
                if !matches!(self.phase, Phase::Failed(_)) =>
            {
                frame.aria_label(copy::GENERATING_LABEL.get(cx)).child(Spinner::new().large())
            }
            (_, Some(OnboardingState::Connected)) => {
                let (glyph, ink) = if self.snapshot().is_some_and(|s| s.warning_code.is_some()) {
                    (MakaIcon::StatusFailed, maka.warning)
                } else {
                    (MakaIcon::StatusDone, maka.success)
                };
                frame.child(Icon::new(glyph).size_10().text_color(ink))
            }
            _ => {
                frame.child(Icon::new(MakaIcon::StatusFailed).size_10().text_color(maka.ink_muted))
            }
        };
        let status = self.status_line(locale);
        let can_open = self
            .snapshot()
            .is_some_and(|snapshot| snapshot.can_open_in_browser && snapshot.state.is_pending());
        v_flex()
            .id("bot-onboarding")
            .test_support()
            .w_full()
            .items_center()
            .gap_3()
            .py_2()
            .child(frame)
            .child(
                div()
                    .id("bot-onboarding-status")
                    .test_support()
                    .aria_label(SharedString::from(status.clone()))
                    .text_sm()
                    .text_center()
                    .text_color(maka.ink)
                    .child(status),
            )
            .child(
                div()
                    .text_xs()
                    .text_center()
                    .text_color(maka.ink_muted)
                    .child(copy::PRIVACY.get(cx)),
            )
            .children(can_open.then(|| {
                quiet_button(Button::new("bot-onboarding-browser"), cx)
                    .label(copy::OPEN_BROWSER.get(cx))
                    .on_click(cx.listener(|this, _, _, cx| this.open_in_browser(cx)))
            }))
    }
}

/// Where the bridge's sign-in stands.
#[derive(Debug, Clone, PartialEq)]
enum BridgePhase {
    Loading,
    Loaded(WechatBridgeQr),
    Failed,
}

/// Behavior and presentation owner of the local wechat-bridge's QR sign-in.
pub(crate) struct BridgeQrDialog {
    bots: Entity<BotService>,
    phase: BridgePhase,
    qr: Option<Arc<RenderImage>>,
    retired: Vec<Arc<RenderImage>>,
    loading: bool,
    _task: Option<Task<()>>,
}

impl std::fmt::Debug for BridgeQrDialog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeQrDialog").field("phase", &self.phase).finish_non_exhaustive()
    }
}

impl BridgeQrDialog {
    pub(crate) fn new(bots: Entity<BotService>, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            bots,
            phase: BridgePhase::Loading,
            qr: None,
            retired: Vec::new(),
            loading: false,
            _task: None,
        };
        this.load(cx);
        this
    }

    /// Fetches the code; while it waits for a scan, again in 3 s.
    fn load(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        let task = self.bots.update(cx, |bots, cx| bots.wechat_bridge_qr(cx));
        self._task = Some(cx.spawn(async move |this, cx| {
            let result = task.await;
            let drawn = match &result {
                Ok(WechatBridgeQr { ok: true, qrcode: Some(url), .. }) => {
                    let qr = OnboardingQr::Image(url.clone());
                    cx.background_spawn(async move { qr_image(&qr) }).await
                }
                _ => None,
            };
            let waiting = matches!(
                &result,
                Ok(WechatBridgeQr { ok: true, logged_in: false, expired: false, .. })
            );
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                this.retired.extend(this.qr.take());
                this.qr = drawn;
                this.phase = match result {
                    Ok(result) => {
                        if !result.ok {
                            log::warn!("the wechat-bridge QR code: {:?}", result.error);
                        }
                        BridgePhase::Loaded(result)
                    }
                    Err(error) => {
                        log::warn!("the wechat-bridge QR code: {error}");
                        BridgePhase::Failed
                    }
                };
                if waiting {
                    this._task = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(BRIDGE_REFRESH).await;
                        let _ = this.update(cx, |this, cx| this.load(cx));
                    }));
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    pub(crate) fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._task = None;
        self.retired.extend(self.qr.take());
        for image in self.retired.drain(..) {
            cx.drop_image(image, Some(window));
        }
    }

    pub(crate) fn dialog(&mut self, dialog: Dialog, cx: &mut Context<Self>) -> Dialog {
        dialog
            .with_header(
                DialogHeader::new(copy::BRIDGE_TITLE.get(cx))
                    .subtitle(copy::BRIDGE_SUBTITLE.get(cx)),
            )
            .child(cx.entity())
    }

    /// A line and the button that fetches the code again.
    fn empty(
        &self,
        title: SharedString,
        line: SharedString,
        idle: shared::copy::Text,
        busy: shared::copy::Text,
        cx: &mut Context<Self>,
    ) -> gpui_kit::AnyElement {
        let maka = cx.maka();
        v_flex()
            .items_center()
            .gap_2()
            .child(
                Icon::new(gpui_kit::assets::IconName::MessageSquare)
                    .size_6()
                    .text_color(maka.ink_muted),
            )
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(maka.ink)
                    .child(title),
            )
            .child(div().text_xs().text_center().text_color(maka.ink_muted).child(line))
            .child(
                quiet_button(Button::new("bot-bridge-reload"), cx)
                    .label(if self.loading { busy } else { idle }.get(cx))
                    .disabled(self.loading)
                    .on_click(cx.listener(|this, _, _, cx| this.load(cx))),
            )
            .into_any_element()
    }
}

impl Render for BridgeQrDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let maka = cx.maka();
        let body = match &self.phase {
            BridgePhase::Loading => v_flex()
                .items_center()
                .gap_2()
                .child(Spinner::new().large())
                .child(
                    div()
                        .text_xs()
                        .text_color(maka.ink_muted)
                        .child(copy::BRIDGE_GENERATING.get(cx)),
                )
                .into_any_element(),
            BridgePhase::Loaded(result) if result.ok && result.logged_in => div()
                .text_sm()
                .text_color(maka.success)
                .child(copy::LOGGED_IN.get(cx))
                .into_any_element(),
            BridgePhase::Loaded(result) if result.ok && result.expired => self.empty(
                copy::BRIDGE_EXPIRED.get(cx).into(),
                copy::EXPIRED_HINT.get(cx).into(),
                copy::REFRESH_QR,
                copy::REFRESHING,
                cx,
            ),
            BridgePhase::Loaded(result) if result.ok && self.qr.is_some() => v_flex()
                .items_center()
                .gap_2()
                .children(self.qr.clone().map(|qr| {
                    div()
                        .id("bot-bridge-qr")
                        .test_support()
                        .aria_label(copy::BRIDGE_QR_ALT.get(cx))
                        .size(rems(QR_EDGE_REMS))
                        .child(img(qr).size_full())
                }))
                .child(
                    div().text_xs().text_color(maka.ink_muted).child(copy::BRIDGE_WAITING.get(cx)),
                )
                .into_any_element(),
            BridgePhase::Loaded(result) if !result.ok => {
                let title = match result.hint_code.as_deref() {
                    Some("wechat_bridge_remote_url") => copy::HINT_WECHAT_BRIDGE_REMOTE_URL,
                    Some("wechat_bridge_unreachable") => copy::HINT_WECHAT_BRIDGE_UNREACHABLE,
                    _ => copy::READ_QR_FAILED,
                };
                self.empty(
                    title.get(cx).into(),
                    copy::READ_QR_FAILED.get(cx).into(),
                    copy::RETRY,
                    copy::RETRYING,
                    cx,
                )
            }
            BridgePhase::Failed => self.empty(
                copy::READ_QR_FAILED.get(cx).into(),
                copy::READ_QR_FAILED.get(cx).into(),
                copy::RETRY,
                copy::RETRYING,
                cx,
            ),
            BridgePhase::Loaded(_) => self.empty(
                copy::BRIDGE_PENDING.get(cx).into(),
                copy::BRIDGE_PENDING_HINT.get(cx).into(),
                copy::FETCH_AGAIN,
                copy::FETCHING,
                cx,
            ),
        };
        v_flex().id("bot-bridge").test_support().w_full().items_center().py_4().child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_drawn_from_its_text_or_its_image() {
        let text = OnboardingQr::Text(
            "https://open-dev.dingtalk.com/openapp/registration?code=abc".into(),
        );
        let drawn = qr_image(&text).expect("drawn");
        let size = drawn.size(0);
        assert_eq!(size.width, size.height);
        let modules = size.width.0 as usize / QR_MODULE_PX - 2 * QR_QUIET_MODULES;
        assert!((21..=57).contains(&modules), "{modules} modules");

        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(image::RgbaImage::new(4, 3))
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .expect("png");
        let url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&png)
        );
        let decoded = qr_image(&OnboardingQr::Image(url)).expect("decoded");
        assert_eq!((decoded.size(0).width.0, decoded.size(0).height.0), (4, 3));
        assert!(qr_image(&OnboardingQr::Image("data:image/png,raw".into())).is_none());
        assert!(qr_image(&OnboardingQr::Image("https://example.com/qr.png".into())).is_none());
    }
}
