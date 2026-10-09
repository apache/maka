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

//! UI integration tests of the custom pet in the main window: the demo
//! pack (crates/pet/fixtures/demo-pet) in a temporary State Root, chosen
//! in the preferences, drawn by the production window content.

use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use futures_lite::future::Boxed;
use gpui_kit::component::Root;
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, Entity, TestAppContext, WindowHandle, px, size};
use serde_json::Value;
use settings::{AppPreferences, Appearance, Language, Preferences, SettingsSection};
use workspace::{HostRequestError, HostSession, HostTransport, UnavailableProjectCatalog};

use crate::Workbench;

/// A Host that answers nothing: the pet needs none.
struct NoHost;

impl HostTransport for NoHost {
    fn request(
        &self,
        _: &'static str,
        _: Value,
        _: Duration,
    ) -> Boxed<Result<Value, HostRequestError>> {
        Box::pin(async { Err(HostRequestError::NotConnected) })
    }
}

struct TempRoot(PathBuf);

impl Drop for TempRoot {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).ok();
    }
}

fn open(cx: &mut TestAppContext) -> (TempRoot, Entity<Workbench>, WindowHandle<Root>) {
    let root = TempRoot(std::env::temp_dir().join(format!("app-pet-{}", uuid_like())));
    let fixture = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../pet/fixtures/demo-pet"));
    pet::import_from_directory(&fixture, &pet::PetPackStore::new(&root.0)).expect("demo pack");
    cx.update(|cx| {
        gpui_kit::init(cx);
        crate::init(cx);
        cx.set_reduce_motion(true);
        let chosen = Preferences::new(Language::English, Appearance::Light)
            .with_selected_pet(pet::PetPackId::parse("demo-blob"));
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.restore(chosen, None, cx));
    });
    let host = cx.new(|_| HostSession::with_transport(root.0.clone(), Arc::new(NoHost)));
    let mut workbench = None;
    let window = cx.open_window(size(px(1000.), px(700.)), |window, cx| {
        let view = cx
            .new(|cx| Workbench::new(host.clone(), Rc::new(UnavailableProjectCatalog), window, cx));
        workbench = Some(view.clone());
        Root::new(view, window, cx)
    });
    cx.run_until_parked();
    (root, workbench.expect("workbench"), window)
}

/// A name no other test run shares.
fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("{}-{nanos}", std::process::id())
}

fn drawn(
    window: WindowHandle<Root>,
    cx: &mut TestAppContext,
) -> Option<gpui_kit::Bounds<gpui_kit::Pixels>> {
    cx.update_window(window.into(), |_, window, cx| {
        window.render_frame(cx);
        window.try_find("pet-companion-frame").map(|frame| frame.bounds())
    })
    .expect("window")
}

#[gpui_kit::test]
fn the_chosen_pet_sits_bottom_right_and_hides_behind_settings(cx: &mut TestAppContext) {
    let (_root, workbench, window) = open(cx);
    let bounds = drawn(window, cx).expect("the pet shows");
    assert!(bounds.right() > px(950.) && bounds.bottom() > px(650.), "bottom right: {bounds:?}");

    cx.update_window(window.into(), |_, window, cx| {
        workbench.update(cx, |workbench, cx| {
            workbench.show_settings(SettingsSection::Appearance, |_, _, _| {}, window, cx)
        });
    })
    .expect("window");
    cx.run_until_parked();
    assert_eq!(drawn(window, cx), None, "settings cover the app");

    cx.update_window(window.into(), |_, window, cx| {
        workbench.update(cx, |workbench, cx| workbench.close_settings(window, cx));
    })
    .expect("window");
    cx.run_until_parked();
    assert!(drawn(window, cx).is_some(), "back to the app, back on the plate");

    // Turning it off in the preferences takes it away.
    cx.update(|cx| {
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_selected_pet(None, cx))
    });
    cx.run_until_parked();
    assert_eq!(drawn(window, cx), None);
}
