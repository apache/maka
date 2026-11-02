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

//! The operating system's privacy grants native Computer Use needs.
//!
//! On macOS these are Accessibility and Screen Recording, which belong to
//! the application responsible for the Host. Other platforms need none.

use maka_agent_facts::interaction::SystemPermissionGrant;

/// The grants native desktop work needs that are not in effect now, checked
/// with real calls. It blocks for those calls.
pub fn missing() -> Vec<SystemPermissionGrant> {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    {
        [
            SystemPermissionGrant::Accessibility,
            SystemPermissionGrant::ScreenRecording,
        ]
        .into_iter()
        .filter(|grant| !crate::macos::tcc::present((*grant).into()))
        .collect()
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    Vec::new()
}

/// Asks the operating system to show its own request for each grant, at
/// most once per grant for this Host.
pub fn request(grants: &[SystemPermissionGrant]) {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    for grant in grants {
        crate::macos::tcc::ask((*grant).into());
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    let _ = grants;
}

/// The name System Settings lists for the application the grants belong to.
pub fn application() -> String {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    {
        crate::macos::tcc::responsible_application()
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    String::new()
}

/// The tool failure for grants still missing: one `permission_required:`
/// line for each, naming the switch to turn on.
pub fn failure(grants: &[SystemPermissionGrant], application: &str) -> String {
    #[cfg(all(feature = "native-desktop", target_os = "macos"))]
    {
        grants
            .iter()
            .map(|grant| crate::macos::tcc::still_missing((*grant).into(), application))
            .collect::<Vec<_>>()
            .join("\n")
    }
    #[cfg(not(all(feature = "native-desktop", target_os = "macos")))]
    {
        let _ = (grants, application);
        String::new()
    }
}
