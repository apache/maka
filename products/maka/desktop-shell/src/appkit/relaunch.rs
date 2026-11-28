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

//! Local macOS grants belong to this desktop process.
use dispatch2::DispatchQueue;
use std::{
    os::unix::fs::{MetadataExt, PermissionsExt},
    sync::{Arc, OnceLock},
};
use tokio::sync::oneshot::Sender;

static STARTED_EXECUTABLE: OnceLock<(u64, u64)> = OnceLock::new();
fn executable_identity() -> Option<(u64, u64)> {
    let file = std::fs::metadata(std::env::current_exe().ok()?).ok()?;
    (file.is_file() && file.permissions().mode() & 0o111 != 0).then(|| (file.dev(), file.ino()))
}
pub(crate) fn remember_executable() {
    if let Some(id) = executable_identity() {
        let _ = STARTED_EXECUTABLE.set(id);
    }
}

// Set only after the ordinary Quit path accepted the request.
pub(crate) static RESTARTING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub(crate) fn restart(call: Sender<Result<(), String>>, updater: Arc<crate::updater::Controller>) {
    use nsh_platform_macos::objc2::MainThreadMarker;
    use std::sync::atomic::Ordering;
    if !supported() {
        let _ = call.send(Err("The current launcher cannot reopen this desktop".into()));
        return;
    }
    DispatchQueue::main().exec_async(move || {
        let mtm = MainThreadMarker::new().expect("restart runs on AppKit's main thread");
        if !updater.reserve_desktop_restart() {
            let _ = call.send(Err("An update or restart is in progress".into()));
            return;
        }
        if nsh_platform_macos::try_quit_for_relaunch(mtm) {
            RESTARTING.store(true, Ordering::Release);
            let _ = call.send(Ok(()));
        } else {
            updater.cancel_desktop_restart();
            let _ = call.send(Err("The desktop could not complete its normal quit".into()));
        }
    });
}

pub(crate) fn supported() -> bool {
    std::env::var(maka_updater::RELAUNCH_SUPPORTED_ENV).as_deref() == Ok("1")
        && executable_identity().is_some_and(|id| STARTED_EXECUTABLE.get() == Some(&id))
}
