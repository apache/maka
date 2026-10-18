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

//! The window Maka opens in. The native title bar is hidden: the sidebar's
//! top strip and the plate's header draw the chrome and move the window
//! (`window_control_area('drag')`), and the traffic lights sit in that strip
//! where the native client puts them. The title names the application, which
//! a run from an app directory would otherwise title after the directory.

use gpui_shell::ShellRoot;
use gpui_shell::gpui::{
    AnyView, AnyWindowHandle, App, AppContext as _, TitlebarOptions, Window, WindowOptions, point,
    px, size,
};

/// Maka's components (`maka-desktop`'s `Terminal`), the bindings they need,
/// and the window opener.
pub fn components() -> Result<gpui_shell::FrozenComponentRegistry, gpui_shell::RegistryError> {
    let mut registry = gpui_shell::ComponentRegistry::new(
        gpui_shell::COMPONENT_REGISTRY_API_VERSION,
        "maka-desktop",
    )?;
    crate::terminal::register(&mut registry)?;
    registry
        .with_initializer(crate::terminal::init)
        .with_window_opener(open)
        .freeze()
}

/// The traffic lights' top left corner, as the native client places them
/// (maka-gpui `TRAFFIC_LIGHTS`): on the centre line of the 56px strip.
const TRAFFIC_LIGHTS: (f32, f32) = (16., 25.);

/// The smallest window the sidebar and the reading column fit in.
const MIN_SIZE: (f32, f32) = (960., 600.);

fn open(
    cx: &mut App,
    options: WindowOptions,
    build: &mut dyn FnMut(&mut Window, &mut App) -> AnyView,
) -> gpui_shell::anyhow::Result<AnyWindowHandle> {
    // `check` renders in a hidden window and takes it as it is.
    let options = if options.show {
        WindowOptions {
            titlebar: Some(TitlebarOptions {
                title: Some("Maka".into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(TRAFFIC_LIGHTS.0), px(TRAFFIC_LIGHTS.1))),
            }),
            window_min_size: Some(size(px(MIN_SIZE.0), px(MIN_SIZE.1))),
            ..options
        }
    } else {
        options
    };
    // The application window's root is the runtime's `ShellRoot`, which its
    // dialogs and toasts look up; it goes in unchanged. Anything else the
    // runtime opens a window for (the check's empty view) is put in one.
    let window = cx.open_window(options, |window, cx| {
        match build(window, cx).downcast::<ShellRoot>() {
            Ok(root) => root,
            Err(view) => cx.new(|cx| ShellRoot::new(view, window, cx)),
        }
    })?;
    Ok(window.into())
}
