//! Launch at login: whether the system opens the app when the user logs in
//! (`nsh/desktop`'s `Application.launchAtLogin()` and
//! `setLaunchAtLogin(enabled)`; Rust's
//! [`crate::element::desktop::launch_at_login`] and
//! [`crate::element::desktop::set_launch_at_login`]).
//!
//! A standalone app's runner gives the core the platform's
//! [`LoginItemBackend`] (`run_app` with the backends' `login_item` option,
//! which the release runners set): macOS's `SMAppService.mainApp`, a value
//! of the `Run` key on Windows, an XDG autostart entry on Linux. Without one
//! (a view embedded in another app, a development host, tests, the mobile
//! platforms, the web) the app has no login item: its status is
//! [`LoginItemStatus::Unavailable`] and changing it fails. The core calls
//! the backend on a thread of its own, one call at a time in the order the
//! app made them (the last change wins), never on the main or the engine
//! thread. It needs no capability: like `quit` and `restart`, it is the
//! app's own lifecycle.

/// What the app's login item is, as a platform's backend reads it. Apps
/// only see whether it is on ([`crate::element::desktop::launch_at_login`]):
/// every status but [`Enabled`](Self::Enabled) reads as `false`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum LoginItemStatus {
    /// The system opens the app when the user logs in.
    Enabled,
    /// It does not: nothing is registered for the app, or (Linux) its entry
    /// is turned off.
    Disabled,
    /// Registered, and waiting for the user in the system's settings
    /// (macOS's Login Items; Windows' startup apps, where they turned the
    /// app off): only they turn it on, there.
    RequiresApproval,
    /// This run of the app has no login item: a view embedded in another
    /// app, a development run, a platform without login items.
    #[default]
    Unavailable,
}

/// Why `set_launch_at_login` failed.
#[derive(Debug)]
#[non_exhaustive]
pub enum LaunchAtLoginError {
    /// This run of the app has no login item: a view embedded in another
    /// app, `nsh run`, a platform without one (TS:
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`).
    Unavailable,
    /// The system refused or failed (TS: Node's code of the error, `EIO`
    /// when it has none).
    System(std::io::Error),
    /// The app declares capabilities without `application` (TS:
    /// `ERR_ACCESS_DENIED`, `permission` `"application"`).
    Denied,
}

impl std::fmt::Display for LaunchAtLoginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str(
                "this run of the app cannot launch at login: only standalone desktop apps \
                 can, and not under `nsh run`",
            ),
            Self::System(error) => write!(f, "launch at login could not be changed: {error}"),
            Self::Denied => f.write_str(
                "launching at login is not granted: add `\"application\": true` to \
                 capabilities in nsh.json",
            ),
        }
    }
}

impl std::error::Error for LaunchAtLoginError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::System(error) => Some(error),
            Self::Unavailable | Self::Denied => None,
        }
    }
}

impl From<std::io::Error> for LaunchAtLoginError {
    fn from(error: std::io::Error) -> Self {
        Self::System(error)
    }
}

/// The login item of the app a standalone runner runs, as its platform
/// keeps it. The core calls it on a thread of its own, one call at a time:
/// its methods may block.
pub trait LoginItemBackend: Send + Sync {
    /// The login item's status now.
    fn status(&self) -> std::io::Result<LoginItemStatus>;

    /// Registers the app to open when the user logs in (`enabled`) or
    /// removes its registration, and gives the status after it. Registering
    /// what is registered and removing what is not there succeed.
    /// [`LoginItemStatus::Unavailable`]: there is nothing to change here.
    fn set(&self, enabled: bool) -> std::io::Result<LoginItemStatus>;
}

/// What the core holds of the app's login item: its backend, and the
/// thread that calls it.
pub(crate) struct LoginItems {
    backend: std::sync::Arc<dyn LoginItemBackend>,
    #[cfg(not(target_arch = "wasm32"))]
    worker: Option<std::sync::mpsc::Sender<Call>>,
}

/// A call for the worker: a change (`Some`) or a read, and where its result
/// goes.
#[cfg(not(target_arch = "wasm32"))]
type Call = (
    Option<bool>,
    tokio::sync::oneshot::Sender<std::io::Result<LoginItemStatus>>,
);

impl LoginItems {
    pub(crate) fn new(backend: std::sync::Arc<dyn LoginItemBackend>) -> Self {
        Self {
            backend,
            #[cfg(not(target_arch = "wasm32"))]
            worker: None,
        }
    }

    /// Reads the status (`None`) or changes it, after the calls made
    /// before: the result comes to the future.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn call(
        &mut self,
        enabled: Option<bool>,
    ) -> impl Future<Output = std::io::Result<LoginItemStatus>> + 'static {
        let (tx, rx) = tokio::sync::oneshot::channel();
        // One thread, one queue: the calls run in the order they came, so
        // the app's last change is the one that stays.
        let sent = self
            .worker()
            .is_some_and(|worker| worker.send((enabled, tx)).is_ok());
        async move {
            if !sent {
                return Err(std::io::Error::other(
                    "cannot start the login item's thread",
                ));
            }
            rx.await.unwrap_or_else(|_| {
                Err(std::io::Error::other(
                    "the login item's thread stopped before it answered",
                ))
            })
        }
    }

    /// Without threads (WebAssembly), the call runs at once.
    #[cfg(target_arch = "wasm32")]
    pub(crate) fn call(
        &mut self,
        enabled: Option<bool>,
    ) -> impl Future<Output = std::io::Result<LoginItemStatus>> + 'static {
        let result = match enabled {
            None => self.backend.status(),
            Some(enabled) => self.backend.set(enabled),
        };
        std::future::ready(result)
    }

    /// The worker's queue, its thread started on the first call; it ends
    /// once the core drops the queue and the calls in it are done.
    #[cfg(not(target_arch = "wasm32"))]
    fn worker(&mut self) -> Option<&std::sync::mpsc::Sender<Call>> {
        if self.worker.is_none() {
            let (tx, rx) = std::sync::mpsc::channel::<Call>();
            let backend = self.backend.clone();
            std::thread::Builder::new()
                .name("nsh-login-item".into())
                .spawn(move || {
                    for (enabled, reply) in rx {
                        // A backend that panics fails this call and leaves
                        // the thread to the calls after it.
                        let result =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                                || match enabled {
                                    None => backend.status(),
                                    Some(enabled) => backend.set(enabled),
                                },
                            ))
                            .unwrap_or_else(|_| {
                                Err(std::io::Error::other("the login item's backend panicked"))
                            });
                        let _ = reply.send(result);
                    }
                })
                .map_err(|e| log::error!("cannot start the login item's thread: {e}"))
                .ok()?;
            self.worker = Some(tx);
        }
        self.worker.as_ref()
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;

    /// Records the calls and keeps the last change.
    #[derive(Default)]
    struct Fake {
        calls: Mutex<Vec<Option<bool>>>,
        enabled: Mutex<bool>,
    }

    impl LoginItemBackend for Fake {
        fn status(&self) -> std::io::Result<LoginItemStatus> {
            self.calls.lock().unwrap().push(None);
            Ok(if *self.enabled.lock().unwrap() {
                LoginItemStatus::Enabled
            } else {
                LoginItemStatus::Disabled
            })
        }

        fn set(&self, enabled: bool) -> std::io::Result<LoginItemStatus> {
            // A slow system: a later call must still wait for this one.
            std::thread::sleep(std::time::Duration::from_millis(if enabled {
                30
            } else {
                0
            }));
            self.calls.lock().unwrap().push(Some(enabled));
            *self.enabled.lock().unwrap() = enabled;
            self.status()
        }
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn calls_run_in_the_order_they_came_on_one_thread() {
        let fake = Arc::new(Fake::default());
        let mut items = LoginItems::new(fake.clone());
        let on = items.call(Some(true));
        let off = items.call(Some(false));
        let read = items.call(None);
        assert_eq!(block_on(read).unwrap(), LoginItemStatus::Disabled);
        assert_eq!(block_on(on).unwrap(), LoginItemStatus::Enabled);
        assert_eq!(block_on(off).unwrap(), LoginItemStatus::Disabled);
        assert_eq!(
            *fake.calls.lock().unwrap(),
            [Some(true), None, Some(false), None, None]
        );
    }

    /// Panics at its first change.
    struct Panicking(Mutex<bool>);

    impl LoginItemBackend for Panicking {
        fn status(&self) -> std::io::Result<LoginItemStatus> {
            Ok(LoginItemStatus::Disabled)
        }

        fn set(&self, _: bool) -> std::io::Result<LoginItemStatus> {
            if !std::mem::replace(&mut *self.0.lock().unwrap(), true) {
                panic!("a backend's bug");
            }
            Ok(LoginItemStatus::Enabled)
        }
    }

    #[test]
    fn a_backend_that_panics_fails_that_call_only() {
        let mut items = LoginItems::new(Arc::new(Panicking(Mutex::new(false))));
        let first = items.call(Some(true));
        let second = items.call(Some(true));
        let error = block_on(first).unwrap_err();
        assert!(error.to_string().contains("panicked"), "{error}");
        assert_eq!(block_on(second).unwrap(), LoginItemStatus::Enabled);
        assert_eq!(
            block_on(items.call(None)).unwrap(),
            LoginItemStatus::Disabled
        );
    }
}
