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

//! The system notification a task posts when its run ends while the window
//! is in the background: "Send system notifications" on the General page,
//! after Maka Desktop's (apps/desktop/src/main/runtime-host-notifications.ts,
//! notifications-policy.ts, notifications-main.ts).
//!
//! The Host marks the `session.catalog.changed` that ends a Turn or starts
//! waiting on the user with an `attention` (completed, errored, waiting).
//! [`RunNotifier`] posts one notification per attention event, through
//! GPUI's `show_system_notification` (the platform's notification center:
//! `UNUserNotificationCenter` on macOS, which asks for permission the first
//! time; a build run outside an app bundle posts none). Clicking one brings
//! its window forward. Desktop also bounces the Dock icon; GPUI has no call
//! for that.

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use gpui_kit::{
    AnyWindowHandle, App, Context, Entity, Global, SharedString, Subscription, SystemNotification,
    Window,
};
use host_protocol::{ChangeNotice, PushFrame, SessionAttention, SessionAttentionKind};
use shared::copy::settings as copy;
use shared::copy::{Locale, Text, task_title_text};
use workspace::{HostSession, HostSessionEvent};

use crate::preferences::AppPreferences;

/// Attention events remembered, so one delivered twice posts once
/// (Desktop's `deduplicateRunNotifications` keeps 512).
const SEEN_EVENTS: usize = 512;

/// Desktop's `MAX_TITLE_CHARS` and `MAX_BODY_CHARS`.
const TITLE_MAX_CHARS: usize = 80;
const BODY_MAX_CHARS: usize = 160;

/// Whether a run's end posts a notification (Desktop's
/// `shouldRaiseRunNotification`): when the switch is on and the window is
/// not the one in front.
pub fn should_notify(enabled: bool, window_active: bool) -> bool {
    enabled && !window_active
}

/// A title or body line: whitespace collapsed, cut to `max` characters with
/// an ellipsis (Desktop's `sanitizeLine`).
fn line(text: &str, max: usize) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= max {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(max - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The fallback title and body for an attention of `kind`.
fn fallback(kind: &SessionAttentionKind) -> (Text, Text) {
    match kind {
        SessionAttentionKind::Errored => (copy::RUN_ERRORED_TITLE, copy::RUN_ERRORED_BODY),
        SessionAttentionKind::Waiting => (copy::RUN_WAITING_TITLE, copy::RUN_WAITING_BODY),
        _ => (copy::RUN_COMPLETED_TITLE, copy::RUN_COMPLETED_BODY),
    }
}

/// The notification for `attention` (Desktop's
/// `resolveNotificationContent`): the task's name, else the kind's title;
/// the Host's reason, else the kind's line.
pub fn notification_content(
    attention: &SessionAttention,
    task_name: Option<&str>,
    locale: Locale,
) -> (String, String) {
    let (title, body) = fallback(&attention.kind);
    let name = task_name.and_then(task_title_text).map(|name| line(name, TITLE_MAX_CHARS));
    let reason = attention.body.as_deref().map(|body| line(body, BODY_MAX_CHARS));
    (
        name.filter(|name| !name.is_empty()).unwrap_or_else(|| title.in_locale(locale).to_owned()),
        reason
            .filter(|reason| !reason.is_empty())
            .unwrap_or_else(|| body.in_locale(locale).to_owned()),
    )
}

/// Reads a task's name by its id, for a notification's title.
pub type TaskNames = Rc<dyn Fn(&str, &App) -> Option<SharedString>>;

/// Whether a Session's runs post nothing: a side chat's fork, whose turns
/// belong to its workbar tab, not to a task of the list.
pub type HiddenSessions = Rc<dyn Fn(&str, &App) -> bool>;

/// Behavior owner of one window's run notifications: it watches the
/// window's Host session for attentions and posts each one once, while the
/// preference is on and the window is in the background. It lives as long
/// as the window's workbench.
pub struct RunNotifier {
    window: AnyWindowHandle,
    host: Entity<HostSession>,
    task_names: TaskNames,
    hidden: Option<HiddenSessions>,
    /// `(host epoch, session, event)` of the attentions posted, oldest first.
    seen: VecDeque<(String, String, String)>,
    seen_set: HashSet<(String, String, String)>,
    _subscription: Subscription,
}

impl std::fmt::Debug for RunNotifier {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunNotifier").field("seen", &self.seen.len()).finish_non_exhaustive()
    }
}

impl RunNotifier {
    pub fn new(
        host: Entity<HostSession>,
        task_names: TaskNames,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscription =
            cx.subscribe_in(&host, window, |this, _, event: &HostSessionEvent, window, cx| {
                let HostSessionEvent::Push(frame) = event else {
                    return;
                };
                if let PushFrame::Change(ChangeNotice::SessionCatalogChanged {
                    session_id,
                    attention: Some(attention),
                    ..
                }) = frame.as_ref()
                {
                    this.on_attention(session_id, attention, window.is_window_active(), cx);
                }
            });
        Self {
            window: window.window_handle(),
            host,
            task_names,
            hidden: None,
            seen: VecDeque::new(),
            seen_set: HashSet::new(),
            _subscription: subscription,
        }
    }

    /// Posts nothing for the Sessions `hidden` names (side chats' forks).
    pub fn set_hidden_sessions(&mut self, hidden: HiddenSessions) {
        self.hidden = Some(hidden);
    }

    fn on_attention(
        &mut self,
        session_id: &str,
        attention: &SessionAttention,
        window_active: bool,
        cx: &mut Context<Self>,
    ) {
        if self.hidden.as_ref().is_some_and(|hidden| hidden(session_id, cx)) {
            log::debug!("no notification for {session_id}: a side chat's fork");
            return;
        }
        let epoch = self.host.read(cx).accepted().map(|accepted| accepted.host_epoch.clone());
        let key = (epoch.unwrap_or_default(), session_id.to_owned(), attention.event_id.clone());
        if !self.seen_set.insert(key.clone()) {
            return;
        }
        self.seen.push_back(key.clone());
        if self.seen.len() > SEEN_EVENTS
            && let Some(oldest) = self.seen.pop_front()
        {
            self.seen_set.remove(&oldest);
        }
        let enabled = AppPreferences::current(cx).run_notifications;
        if !should_notify(enabled, window_active) {
            return;
        }
        let name = (self.task_names)(session_id, cx);
        let (title, body) = notification_content(attention, name.as_deref(), Locale::current(cx));
        let (epoch, session, event) = key;
        let tag: SharedString = format!("maka-run:{epoch}:{session}:{event}").into();
        log::info!("notifying: {} for {session}", attention.kind);
        cx.default_global::<NotificationWindows>().remember(tag.clone(), self.window);
        cx.show_system_notification(SystemNotification {
            tag,
            title: title.into(),
            body: body.into(),
            actions: Vec::new(),
        });
    }
}

/// The window each posted notification came from, for its click.
#[derive(Default)]
struct NotificationWindows {
    windows: HashMap<SharedString, AnyWindowHandle>,
    order: VecDeque<SharedString>,
}

impl Global for NotificationWindows {}

impl NotificationWindows {
    fn remember(&mut self, tag: SharedString, window: AnyWindowHandle) {
        if self.windows.insert(tag.clone(), window).is_none() {
            self.order.push_back(tag);
        }
        while self.order.len() > SEEN_EVENTS {
            if let Some(oldest) = self.order.pop_front() {
                self.windows.remove(&oldest);
            }
        }
    }
}

/// Brings a clicked notification's window forward, as Desktop focuses its
/// main window. Called by [`crate::init`].
pub(crate) fn init(cx: &mut App) {
    cx.on_system_notification_response(|response, cx| {
        let window = cx
            .try_global::<NotificationWindows>()
            .and_then(|windows| windows.windows.get(&response.tag).copied());
        cx.activate(true);
        if let Some(window) = window {
            window.update(cx, |_, window, _| window.activate_window()).ok();
        }
    });
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn attention(kind: &str, body: Option<&str>) -> SessionAttention {
        let mut value = json!({"kind": kind, "eventId": "e1"});
        if let Some(body) = body {
            value["body"] = json!(body);
        }
        serde_json::from_value(value).expect("attention")
    }

    #[test]
    fn only_a_background_window_with_the_switch_on_notifies() {
        assert!(should_notify(true, false));
        assert!(!should_notify(true, true), "the window in front shows it already");
        assert!(!should_notify(false, false), "the switch is off");
    }

    #[test]
    fn a_notification_names_the_task_and_says_why() {
        let en = Locale::English;
        assert_eq!(
            notification_content(&attention("completed", None), Some("Fix  the\nbuild"), en),
            ("Fix the build".to_owned(), copy::RUN_COMPLETED_BODY.en().to_owned())
        );
        assert_eq!(
            notification_content(&attention("errored", Some("auth failed")), None, en),
            (copy::RUN_ERRORED_TITLE.en().to_owned(), "auth failed".to_owned())
        );
        // A task still called what the Host names a new one reads as untitled.
        let (title, _) = notification_content(
            &attention("waiting", None),
            Some(shared::copy::HOST_DEFAULT_TASK_NAME),
            en,
        );
        assert_eq!(title, copy::RUN_WAITING_TITLE.en());
        let long = "x".repeat(200);
        let (_, body) = notification_content(&attention("errored", Some(&long)), None, en);
        assert_eq!(body.chars().count(), BODY_MAX_CHARS);
        assert!(body.ends_with('…'));
    }
}
