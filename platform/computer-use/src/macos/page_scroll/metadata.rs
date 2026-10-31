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

//! Read-only requests serviced by the existing display host's AppKit queue.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "query", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Query {
    WindowOrder,
    KeyboardLayout,
    Process {
        pid: i32,
    },
    GlobalWindow {
        #[serde(deserialize_with = "crate::protocol::deserialize_numbers")]
        point: [f64; 2],
    },
    FirstBundleProcess {
        bundle: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "observation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Observation {
    WindowOrder {
        ids: Vec<u32>,
    },
    KeyboardLayout {
        layout: Option<platform_macos::input::native_keyboard::NativeKeyboardLayout>,
    },
    Process {
        application: Option<platform_macos::geometry::event_target::RunningProcess>,
    },
    GlobalWindow {
        id: Option<u32>,
    },
    FirstBundleProcess {
        pid: Option<i32>,
    },
}

pub(crate) fn read(
    main: platform_macos::geometry::MainThreadMarker,
    query: Query,
) -> Result<Observation, String> {
    use platform_macos::geometry::event_target as native;
    match query {
        Query::WindowOrder => native::ordered_window_ids_on_main_thread(main)
            .map(|ids| Observation::WindowOrder { ids })
            .map_err(|error| error.to_string()),
        Query::KeyboardLayout => Ok(Observation::KeyboardLayout {
            layout: platform_macos::input::native_keyboard::capture_layout(main).ok(),
        }),
        Query::Process { pid } => Ok(Observation::Process {
            application: native::running_process_on_main_thread(main, pid),
        }),
        Query::GlobalWindow { point } => native::global_window_at_point_on_main_thread(main, point)
            .map(|id| Observation::GlobalWindow { id })
            .map_err(|error| error.to_string()),
        Query::FirstBundleProcess { bundle } => Ok(Observation::FirstBundleProcess {
            pid: native::first_bundle_process_on_main_thread(main, &bundle),
        }),
    }
}
