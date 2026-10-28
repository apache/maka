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

//! Independent Computer Use REPL and Session-owned Cua targets.
//!
//! Host supplies authorization and journal ownership; this crate supplies the
//! pinned native implementation. Perception and driver administration are absent.

mod activity;
#[cfg(feature = "native-desktop")]
mod browser;
#[path = "browser/clipboard.rs"]
mod browser_clipboard;
pub mod cursor;
pub mod desktop;
#[cfg(feature = "native-desktop")]
mod driver;
#[cfg(not(feature = "native-desktop"))]
#[path = "bridge_driver.rs"]
mod driver;
pub mod extension_browser_host;
#[cfg(feature = "native-desktop")]
mod identity;
mod invocation;
pub mod language;
#[cfg(all(
    feature = "native-desktop",
    target_os = "linux",
    not(target_env = "musl")
))]
mod linux_ax;
#[cfg(all(feature = "native-desktop", target_os = "linux"))]
mod linux_image;
#[cfg(all(feature = "native-desktop", target_os = "linux"))]
mod linux_input;
#[cfg(all(feature = "native-desktop", target_os = "macos"))]
mod macos;
#[cfg(feature = "native-desktop")]
mod observation;
mod permission_subject;
pub mod protocol;
#[cfg(feature = "native-desktop")]
mod session;

pub use desktop::{NativeEpochId, Session, SessionOwner};
pub use driver::Driver;
pub use invocation::{
    AuthorizationFuture, BrowserAccess, BrowserAttachmentAuthorization, BrowserAttachmentOrigin,
    BrowserAuthorization, BrowserDocument, BrowserEffectScope, BrowserHostEffects,
    BrowserLeaseChildRequest, BrowserPreparationBinding, BrowserPreparationHeader,
    BrowserPreparationPolicy, BrowserPreparationTarget, BrowserSessionPreparation,
    CheckedSettlementFuture, HostEffectFactory, HostEffectFuture, HostUncertaintyFuture,
    InvocationCompletion, InvocationContext, OperationSettlement, SettlementFuture,
};
pub use maka_capabilities::computer::BrowserLeaseSubject;
pub use permission_subject::{ComputerAppBinding, ComputerAppTarget};
pub fn facade() -> String {
    facade_for(desktop::local_platform(), false)
}

pub fn facade_for(platform: &str, audio_enabled: bool) -> String {
    format!(
        "const nativePlatform = {platform:?};\nconst audioEnabled = {audio_enabled};\n{}",
        include_str!("facade.js")
    )
}

pub const ID: &str = "maka.computer-use";
pub const REVISION: &str = "cua-repl-v1";
