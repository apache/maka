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

use super::*;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
    mpsc,
};
use std::time::Duration;

struct UiLifetime(Arc<AtomicUsize>);
impl Drop for UiLifetime {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

thread_local! {
    static VIEWS: RefCell<Vec<(Weak<AppView>, Weak<Surface>)>> = const { RefCell::new(Vec::new()) };
}

/// Runs actual engines and Win32 destruction/reopen messages. The availability
/// seam avoids requiring Explorer (CI may have no notification area host).
#[test]
fn resident_close_releases_ui_reopens_without_duplicates_and_quits_while_hidden() {
    for available in [true, false] {
        let created = Arc::new(AtomicUsize::new(0));
        let released = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicUsize::new(0));
        let observations = Arc::new(Mutex::new(Vec::new()));
        let (done, finished) = mpsc::channel();
        let timeout = std::thread::spawn(move || {
            if finished.recv_timeout(Duration::from_secs(30)).is_err() {
                super::super::quit_app();
                true
            } else {
                false
            }
        });
        let factory_created = created.clone();
        let factory_released = released.clone();
        let closed_count = closed.clone();
        let observed = observations.clone();
        let mut tray = TrayOptions::default();
        tray.title = "Resident lifecycle test".into();
        tray.open_label = "Open".into();
        tray.quit_label = "Quit".into();
        let code = run_resident_app(
            move || {
                factory_created.fetch_add(1, Ordering::SeqCst);
                let mut policy = nsh_engine::Policy::default();
                policy
                    .declared
                    .get_or_insert_default()
                    .host
                    .push("test.ready".into());
                let bundle =
                    Bundle::source("import { host } from 'nsh'; host.post('test.ready');".into())
                        .with_policy(policy);
                let mut config = EngineConfig::new(bundle);
                config.context = config.context.with(UiLifetime(factory_released.clone()));
                config.host.handle("test.ready", move |_| {
                    crate::window::invoke(move || {
                        let hwnd = STATE.with(|slot| {
                            let state = slot.borrow();
                            let state = state.as_ref()?;
                            state.tray.available.set(available);
                            let view = state.view.as_ref()?;
                            VIEWS.with(|views| {
                                views
                                    .borrow_mut()
                                    .push((Rc::downgrade(view), Rc::downgrade(view.surface())))
                            });
                            Some(view.hwnd())
                        });
                        if let Some(hwnd) = hwnd {
                            // SAFETY: exercises the native window close path, not application Quit.
                            unsafe {
                                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
                            }
                        }
                    });
                });
                config
            },
            AppOptions {
                title: "Resident lifecycle test".into(),
                size: (320, 240),
                ..Default::default()
            },
            tray,
            |_| {},
            move || {
                let count = closed_count.fetch_add(1, Ordering::SeqCst) + 1;
                let all_released = VIEWS.with(|views| {
                    views.borrow().iter().all(|(view, surface)| {
                        view.upgrade().is_none() && surface.upgrade().is_none()
                    })
                });
                observed.lock().unwrap().push(all_released);
                if available {
                    let hwnd =
                        STATE.with(|slot| slot.borrow().as_ref().map(|state| state.tray.hwnd));
                    if let Some(hwnd) = hwnd {
                        let command = if count < 3 {
                            OPEN_COMMAND
                        } else {
                            QUIT_COMMAND
                        };
                        // SAFETY: route actions through the tray owner's real message procedure.
                        unsafe {
                            let _ =
                                PostMessageW(Some(hwnd), WM_COMMAND, WPARAM(command), LPARAM(0));
                            if count < 3 {
                                let _ = PostMessageW(
                                    Some(hwnd),
                                    WM_COMMAND,
                                    WPARAM(OPEN_COMMAND),
                                    LPARAM(0),
                                );
                            }
                        }
                    }
                }
            },
            || true,
        );
        done.send(()).unwrap();
        assert!(
            !timeout.join().unwrap(),
            "resident lifecycle did not complete"
        );
        assert_eq!(code, std::process::ExitCode::SUCCESS);
        let expected = if available { 3 } else { 1 };
        assert_eq!(
            created.load(Ordering::SeqCst),
            expected,
            "Open duplicated a window"
        );
        assert_eq!(closed.load(Ordering::SeqCst), expected);
        assert_eq!(
            released.load(Ordering::SeqCst),
            expected,
            "engine contexts survived window close"
        );
        assert!(
            observations
                .lock()
                .unwrap()
                .iter()
                .all(|released| *released),
            "a closed native view or surface remained owned"
        );
    }
}
