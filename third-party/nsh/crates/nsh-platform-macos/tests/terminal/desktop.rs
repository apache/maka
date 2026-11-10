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

//! Pixel terminal window requests must not surface the hidden native renderer.
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_engine::{App, Bundle, EngineConfig};
use nsh_platform_macos::{
    TerminalSurface,
    objc2::MainThreadMarker,
    objc2_app_kit::NSApplication,
    objc2_foundation::{NSDate, NSRunLoop},
};
use nsh_terminal::{DevicePixels, NativeSurface, size};

const APP: &str = r#"
import { View, mount } from "nsh";
import { Input } from "nsh/base";
import { Tray, Window } from "nsh/desktop";
function App() {
  const main = Window.get("main");
  main.focus();
  Tray.set({ tooltip: "NSH terminal isolation" });
  const extra = Window.open(() => <Input
    autoFocus ref={input => input?.focus()}
    defaultValue="secondary" style={{height: 40}}
  />, {
    id: "terminal-secondary", title: "NSH terminal secondary",
    defaultSize: { width: 160, height: 100 }
  });
  extra.focus();
  return <View style={{flex: 1}}><Input autoFocus defaultValue="terminal" style={{height: 40}} /></View>;
}
mount(App);
"#;

fn config(source: &str) -> EngineConfig {
    let code = nsh_bundler::compile_module("TerminalDesktop.tsx", source, &[]).unwrap();
    let mut config = EngineConfig::new(App::Js(Bundle::source(code)));
    config.ui_sets = vec![nsh_base::registry()];
    config
}

fn until(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(
            Instant::now() < deadline,
            "native terminal isolation did not settle"
        );
        NSRunLoop::currentRunLoop().runUntilDate(&NSDate::dateWithTimeIntervalSinceNow(0.001));
    }
}

pub(super) fn isolation() {
    let mtm = MainThreadMarker::new().expect("main thread");
    let app = NSApplication::sharedApplication(mtm);
    let initial_windows = app.windows().count();
    let surface = TerminalSurface::new(
        config(APP),
        size(DevicePixels(320), DevicePixels(240)),
        1.0,
        Box::new(|frame| {
            frame.submit().unwrap().complete().unwrap();
        }),
        Arc::new(|| {}),
    )
    .unwrap();
    until(|| {
        surface.pump_with_draw(true);
        assert_eq!(surface.take_error(), None);
        surface.editor_text().as_deref() == Some("terminal")
    });
    assert_eq!(
        app.windows().count(),
        initial_windows + 1,
        "terminal opened a secondary native window"
    );
    for window in app.windows() {
        assert!(!window.isVisible(), "terminal exposed an offscreen window");
    }
    surface.set_selected_text_range(8..8).unwrap();
    assert!(surface.paste(nsh_core::PasteEvent::new("!")));
    until(|| {
        surface.pump_with_draw(true);
        surface.editor_text().as_deref() == Some("terminal!")
    });
    surface.shutdown();
}
