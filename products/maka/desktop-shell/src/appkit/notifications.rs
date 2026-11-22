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

use block2::{DynBlock, RcBlock};
use nsh_engine::{HostChannel, JsonValue};
use nsh_platform_macos::{
    objc2::{
        MainThreadOnly,
        rc::{Retained, autoreleasepool},
    },
    with_running_view,
};
use objc2_app_kit::NSApplication;
use objc2_foundation::{NSObject, NSString};
use std::{
    ptr::NonNull,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;

unsafe extern "C" {
    fn maka_install_notification_delegate(
        opened: &DynBlock<dyn Fn(NonNull<NSString>)>,
    ) -> *mut NSObject;
    fn maka_show_notification(
        tag: &NSString,
        title: &NSString,
        body: &NSString,
        done: &DynBlock<dyn Fn(*mut NSString)>,
    );
}

pub(super) fn install(events: Arc<Mutex<Option<HostChannel>>>) -> Option<Retained<NSObject>> {
    let opened = RcBlock::new(move |tag: NonNull<NSString>| {
        with_running_view(|view| {
            if let Some(window) = view.view().window() {
                if window.isMiniaturized() {
                    window.deminiaturize(None);
                }
                // A notification click explicitly requests keyboard focus.
                #[allow(deprecated)]
                NSApplication::sharedApplication(window.mtm()).activateIgnoringOtherApps(true);
                window.makeKeyAndOrderFront(None);
            }
        });
        // SAFETY: The delegate lends the request's non-null identifier for this callback.
        forward_click(&events, unsafe { tag.as_ref() });
    });
    // SAFETY: The delegate copies the thread-safe block and returns nil or a +1 NSObject.
    unsafe { Retained::from_raw(maka_install_notification_delegate(&opened)) }
}

fn forward_click(events: &Mutex<Option<HostChannel>>, tag: &NSString) {
    let host = events.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(host) = host
        && let Err(error) = host.send(
            "notification.open",
            serde_json::json!({ "tag": tag.to_string() }),
        )
    {
        eprintln!("maka-desktop-shell: opening notification: {error}");
    }
}

#[derive(Debug, PartialEq)]
struct Notification<'a> {
    tag: &'a str,
    title: &'a str,
    body: &'a str,
}

impl<'a> Notification<'a> {
    fn parse(data: &'a JsonValue) -> Result<Self, &'static str> {
        let text = |key: &str| {
            data[key]
                .as_str()
                .ok_or("expected a tag, a title and a body in an open window")
        };
        Ok(Self {
            tag: text("tag")?,
            title: text("title")?,
            body: text("body")?,
        })
    }
}

pub(super) async fn show(data: &JsonValue) -> Result<JsonValue, String> {
    let notice = Notification::parse(data)?;
    let (reply, mut result) = mpsc::channel(1);
    autoreleasepool(|_| {
        let done = RcBlock::new(move |error: *mut NSString| {
            // SAFETY: The native completion lends its error string, or passes nil on success.
            let result =
                unsafe { error.as_ref() }.map_or(Ok(JsonValue::Null), |e| Err(e.to_string()));
            let _ = reply.try_send(result);
        });
        let tag = NSString::from_str(notice.tag);
        let title = NSString::from_str(notice.title);
        let body = NSString::from_str(notice.body);
        // SAFETY: ARC retains the strings and copies the block for asynchronous delivery.
        unsafe { maka_show_notification(&tag, &title, &body, &done) };
    });
    result
        .recv()
        .await
        .ok_or("macOS did not complete the notification request")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::Shell;
    use nsh_engine::{Bundle, EngineConfig};
    use objc2_foundation::NSBundle;
    use serde_json::json;

    #[test]
    fn parses_the_notification_content_and_requires_each_string_field() {
        let mut data = json!({"tag": "会话-1", "title": "Maka", "body": "Ready"});
        assert_eq!(
            Notification::parse(&data).unwrap(),
            Notification {
                tag: "会话-1",
                title: "Maka",
                body: "Ready"
            }
        );
        for key in ["tag", "title", "body"] {
            let original = data.as_object_mut().unwrap().remove(key).unwrap();
            assert!(Notification::parse(&data).is_err(), "missing {key}");
            data[key] = json!(42);
            assert!(Notification::parse(&data).is_err(), "non-string {key}");
            data[key] = original;
        }
    }

    #[tokio::test]
    async fn unbundled_shell_rejects_notifications_without_opening_the_center() {
        assert!(NSBundle::mainBundle().bundleIdentifier().is_none());
        assert!(install(Arc::default()).is_none());
        let result = show(&json!({"tag": "conversation", "title": "Maka", "body": "Ready"})).await;
        assert!(result.unwrap_err().contains("bundle identifier"));
    }

    #[test]
    fn click_forwards_the_tag_to_the_attached_workbench() {
        let (shell, _requests) = Shell::new(tokio::sync::watch::channel(false).1);
        let bundle = Bundle::source(
            "import { host } from 'nsh'; host.on('notification.open', data => host.post('opened', data));".into(),
        )
        .with_capabilities_json(Some(r#"{"host":["notification.open","opened"]}"#)).unwrap();
        let config = shell.attach(EngineConfig::new(bundle));
        let (opened, received) = std::sync::mpsc::channel();
        config.host.handle("opened", move |mut call| {
            opened.send(call.take_data()).unwrap()
        });
        let _workbench = nsh_testing::start(config).unwrap();
        forward_click(&shell.events, &NSString::from_str("会话-1"));
        assert_eq!(
            received
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap(),
            json!({"tag": "会话-1"})
        );
    }
}
