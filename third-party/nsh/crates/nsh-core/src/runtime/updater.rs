//! `nsh/updater`: the app updates itself (`docs/dev/updater.md`). The rules
//! are `nsh-updater`'s; this module is its JS face over the platform's HTTP
//! stack ([`UpdaterHost`]). The source comes from the package, never from
//! the caller, so what the app's code can do is ask, not point it elsewhere.
//!
//! Needs no capability: the developer named the source in `nsh.json`, and a
//! module running inside another app has no installation to replace.
//!
//! Packages (`checkForPackage`, `downloadPackage`, `restartToPackage`,
//! `runningPackage`): a newer build of the app's code, signed and verified
//! against the roots in `nsh.json`, which the app's launcher runs at its
//! next start (`nsh_engine::updates`). They update the code on every
//! platform with a launcher that runs them, iOS and Android included.

#[cfg(not(target_arch = "wasm32"))]
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
};

use crate::element::{Callback, JsError, JsObject, Later, System, codes, module};

/// Takes a piece of a body and the total size if known; an error stops it.
pub type UpdaterSink<'a> = &'a mut dyn FnMut(&[u8], Option<u64>) -> Result<(), String>;

/// What the platform gives the module: the package's update configuration
/// and HTTP. Both block, and are called off the engine thread.
pub trait UpdaterHost: Send + Sync + 'static {
    /// The package's configuration file; `None` when it has none (a
    /// development run, an app without `"updater"` in `nsh.json`).
    fn config(&self) -> Option<Vec<u8>>;

    /// Gets `url`, following redirects, handing each piece of the body and
    /// the total size if known to `sink`, until it fails or the body ends.
    fn get(&self, url: &str, sink: UpdaterSink<'_>) -> Result<(), String>;

    /// The signed package this run's code came from; `None` (the default):
    /// the bundle the app shipped with.
    fn running_package(&self) -> Option<PackageVersion> {
        None
    }

    /// Whether the app's launcher runs signed packages, so that a package
    /// [`verify_package`](Self::verify_package) accepts runs at the next
    /// start. `false` (the default): the host runs none.
    fn runs_packages(&self) -> bool {
        false
    }

    /// Verifies the package downloaded to `file` as the app's launcher
    /// will before running it: signed by a release key one of `roots`
    /// certifies, for app `app_id`, its build newer than `newer_than` and
    /// than the builds accepted in the trust state under `updates` (the
    /// app's updates directory), for this runtime. Records nothing. The
    /// default refuses: the host runs no packages.
    fn verify_package(
        &self,
        file: &std::path::Path,
        updates: &std::path::Path,
        app_id: &str,
        roots: &[String],
        newer_than: u64,
    ) -> Result<PackageVersion, String> {
        let _ = (file, updates, app_id, roots, newer_than);
        Err("this host runs no packages".into())
    }
}

/// A signed package of the app's code: its version and build
/// ([`UpdaterHost::running_package`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PackageVersion {
    /// Its version string (`nsh.json` `"version"`).
    pub version: String,
    /// Its build number.
    pub build: u64,
}

/// Bytes downloaded, as `downloadUpdate`'s callback gets them.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct UpdateProgress {
    /// Bytes received so far.
    pub(crate) received: f64,
    /// All of them, when known.
    pub(crate) total: Option<f64>,
}

/// A newer version of the app.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct AppUpdate {
    /// Its version.
    pub(crate) version: String,
    /// What changed, as the manifest says it.
    pub(crate) notes: Option<String>,
    /// Where the user can get it by hand: the archive, or a store's page on
    /// iOS and Android. For `openUrl` when `canInstall` is false.
    pub(crate) url: String,
    /// Whether `downloadUpdate` and `installAndRestart` work here: a package
    /// on the desktop, installed where the user can write. False on iOS and
    /// Android, and under a directory only the system writes.
    pub(crate) can_install: bool,
}

/// A newer build of the app's code, as a signed package.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct PackageUpdate {
    /// Its version (`nsh.json` `"version"`).
    pub(crate) version: String,
    /// Its build number, newer than the running one.
    pub(crate) build: f64,
    /// What changed, as the manifest says it.
    pub(crate) notes: Option<String>,
    /// Its size in bytes, when the manifest says it.
    pub(crate) size: Option<f64>,
}

/// The signed package this run's code came from.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct RunningPackage {
    /// Its version (`nsh.json` `"version"`).
    pub(crate) version: String,
    /// Its build number.
    pub(crate) build: f64,
}

/// The installed app the code runs in, and the runtime built into it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct ShellInfo {
    /// The installed app's version as it was packaged (`nsh.json`
    /// `"version"`; on iOS its `CFBundleShortVersionString`).
    pub(crate) version: Option<String>,
    /// The installed app's build number as it was packaged (`nsh.json`
    /// `"build"`; on iOS its `CFBundleVersion`).
    pub(crate) build: Option<f64>,
    /// The version of the NSH runtime built into the installed app.
    pub(crate) nsh_version: String,
    /// Whether the installed app runs signed packages of its code
    /// (`checkForPackage`): its launcher runs them and its `nsh.json` trusts
    /// package roots.
    pub(crate) packages: bool,
}

impl ShellInfo {
    /// From the shipped update configuration (`nsh-updater.json`), if any,
    /// and whether the launcher runs packages.
    fn new(config: Option<&[u8]>, runs_packages: bool) -> ShellInfo {
        // (version, build, trusts package roots); nothing updates on the web
        #[cfg(not(target_arch = "wasm32"))]
        let shipped = config
            .and_then(|bytes| nsh_updater::Config::parse(bytes).ok())
            .map(|config| {
                let roots = !config.package_roots().is_empty();
                (config.version, config.build.unwrap_or(1), roots)
            });
        #[cfg(target_arch = "wasm32")]
        let shipped: Option<(String, u64, bool)> = config.and(None);
        ShellInfo {
            version: shipped.as_ref().map(|(version, _, _)| version.clone()),
            build: shipped.as_ref().map(|(_, build, _)| *build as f64),
            nsh_version: env!("CARGO_PKG_VERSION").to_owned(),
            packages: runs_packages && shipped.is_some_and(|(_, _, roots)| roots),
        }
    }
}

/// Checking for a newer version of the app and installing it.
#[module]
pub(crate) struct Updater;

#[module(flat)]
impl Updater {
    /// Asks the source in `nsh.json`'s `"updater"` for a newer version.
    /// Resolves with the update, or `null` when the app is up to date, has
    /// no `"updater"`, or runs where apps do not update (the web, a
    /// development run). Rejects when the source cannot be reached or its
    /// manifest is not acceptable: a bad signature, another app's id, a
    /// URL that is not HTTPS.
    pub(crate) fn check_for_update(sys: System) -> Later<Option<AppUpdate>> {
        Later::new(native::check(sys))
    }

    /// Downloads the update the last `checkForUpdate` found and checks it
    /// against the manifest, calling `onProgress` as bytes arrive. Rejects
    /// with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when it found none or
    /// `canInstall` is false, and when the download fails or does not match.
    pub(crate) fn download_update(
        #[args(progress)] on_progress: Option<Callback<UpdateProgress>>,
        sys: System,
    ) -> Later<()> {
        Later::new(native::download(sys, on_progress))
    }

    /// Replaces the installed app with the downloaded update and restarts
    /// it as `Application.restart()` does: this run quits, and the new
    /// version starts once it has exited, so the promise settles only on
    /// failure. Rejects when nothing was downloaded, or when the app cannot
    /// be replaced, which leaves it as it was.
    pub(crate) fn install_and_restart(sys: System) -> Later<()> {
        Later::new(native::install(sys))
    }

    /// Asks the source in `nsh.json`'s `"updater"` for a newer build of the
    /// app's code: a signed package newer than the running build (the
    /// running package's, else the one the app shipped with) that this
    /// runtime runs. Resolves with it, or `null` when there is none, the
    /// app trusts no package roots (`"updater": { "packages": { "roots" } }`)
    /// or runs where apps do not update (the web, a development run).
    /// Rejects as `checkForUpdate` does.
    pub(crate) fn check_for_package(sys: System) -> Later<Option<PackageUpdate>> {
        Later::new(native::check_package(sys))
    }

    /// Downloads the package the last `checkForPackage` found, checks it
    /// against the manifest and verifies it as the app's next start will:
    /// signed by a release key a trusted root certifies, for this app, newer
    /// than the running build, for this runtime. It then runs from the
    /// app's next start (`restartToPackage`). Calls `onProgress` as bytes
    /// arrive. Rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when the
    /// check found none, and with an error saying why when the download
    /// fails or the package is refused, which leaves nothing behind.
    pub(crate) fn download_package(
        #[args(progress)] on_progress: Option<Callback<UpdateProgress>>,
        sys: System,
    ) -> Later<()> {
        Later::new(native::download_package(sys, on_progress))
    }

    /// Restarts the app into the downloaded package as
    /// `Application.restart()` does: this run quits and the app starts
    /// again, so the promise settles only on failure. Rejects when nothing
    /// was downloaded, and with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where
    /// an app cannot restart itself (iOS, Android): the package runs from
    /// the app's next start there.
    pub(crate) fn restart_to_package(sys: System) -> Later<()> {
        Later::new(native::restart_to_package(sys))
    }

    /// The signed package this run's code came from: its version and build;
    /// `null` for the code the app shipped with.
    pub(crate) fn running_package(sys: System) -> Option<RunningPackage> {
        let running = sys.updater.as_ref()?.running_package()?;
        Some(RunningPackage {
            version: running.version,
            build: running.build as f64,
        })
    }

    /// The installed app this code runs in, its shell: the version and build
    /// it was packaged with (on iOS its `CFBundleShortVersionString` and
    /// `CFBundleVersion`), the NSH runtime built into it (`nshVersion`) and
    /// whether it runs signed packages. A package replaces the app's code,
    /// not its shell: `runningPackage()` says which code runs, this what runs
    /// it. `version` and `build` are `null` for an app without `"updater"`
    /// in `nsh.json`, and where apps do not update (the web, a development
    /// run); `packages` is false there.
    pub(crate) fn shell_info(sys: System) -> ShellInfo {
        let host = sys.updater.as_ref();
        ShellInfo::new(
            host.and_then(|host| host.config()).as_deref(),
            host.is_some_and(|host| host.runs_packages()),
        )
    }
}

/// Why no package can be downloaded.
fn no_package() -> JsError {
    JsError::Error("no package to download: checkForPackage found none".into())
        .with_code(codes::UNAVAILABLE)
}

/// Why nothing can be downloaded or installed.
fn unavailable() -> JsError {
    JsError::Error(
        "no update this run can install: check `canInstall` of `checkForUpdate`'s update, or \
         send the user to its `url`"
            .into(),
    )
    .with_code(codes::UNAVAILABLE)
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use nsh_updater::{Available, Config, Download};

    use super::*;

    /// What the VM's last check found and its download left, whether an
    /// operation is in progress, and the package the last package check
    /// found.
    #[derive(Default)]
    struct Found(
        RefCell<Option<Rc<Pending>>>,
        Cell<bool>,
        RefCell<Option<Arc<PendingPackage>>>,
    );

    /// A package the last `checkForPackage` found.
    struct PendingPackage {
        host: Arc<dyn UpdaterHost>,
        available: nsh_updater::AvailablePackage,
        /// The app's updates directory.
        dir: PathBuf,
        app_id: String,
        roots: Vec<String>,
        running_build: u64,
    }

    struct Operation<'a>(&'a Cell<bool>);

    impl Drop for Operation<'_> {
        fn drop(&mut self) {
            self.0.set(false);
        }
    }

    fn begin(found: &Found) -> Result<Operation<'_>, JsError> {
        if found.1.replace(true) {
            return Err(JsError::Error(
                "an update operation is already in progress".into(),
            ));
        }
        Ok(Operation(&found.1))
    }

    impl crate::element::Local for Found {}

    struct Pending {
        host: Arc<dyn UpdaterHost>,
        available: Available,
        dir: PathBuf,
        archive: RefCell<Option<PathBuf>>,
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        installation: nsh_updater::install::Installation,
    }

    /// Runs `work` off the engine thread.
    async fn blocking<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, JsError> {
        super::super::fs::blocking(move || work().map_err(JsError::Error)).await
    }

    pub(super) async fn check(sys: System) -> Result<Option<AppUpdate>, JsError> {
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        // A failed check keeps what the last one found, and its download: a
        // network blip must not lose a verified archive waiting for a restart.
        let Some(host) = sys.updater.clone() else {
            *found.0.borrow_mut() = None;
            return Ok(None);
        };
        let worker = host.clone();
        let checked = blocking(move || {
            let Some(bytes) = worker.config() else {
                return Ok(None);
            };
            let config = Config::parse(&bytes).map_err(|e| e.to_string())?;
            #[cfg(any(target_os = "linux", target_os = "macos", windows))]
            if let Some(installation) =
                nsh_updater::install::Installation::current(&config.id, &bytes)
            {
                // Windows leftovers also need removal when no newer update exists.
                installation.remove_leftovers();
            }
            let manifest = get_all(&*worker, &config.manifest_url())?;
            let signature = match config.signature_url() {
                Some(url) => Some(get_all(&*worker, &url)?),
                None => None,
            };
            let available = config
                .check(&manifest, signature.as_deref(), &nsh_updater::platform())
                .map_err(|e| e.to_string())?
                .filter(|available| {
                    !package_covers(worker.running_package().as_ref(), &available.version)
                });
            Ok(available.map(|available| (bytes, config, available)))
        })
        .await?;
        let Some((bytes, config, available)) = checked else {
            *found.0.borrow_mut() = None;
            return Ok(None);
        };
        // Only the desktops install an update (`can_install` below).
        #[cfg_attr(
            not(any(target_os = "linux", target_os = "macos", windows)),
            allow(unused_mut)
        )]
        let mut update = AppUpdate {
            version: available.version.clone(),
            notes: available.notes.clone(),
            url: available.url.clone(),
            can_install: false,
        };
        #[cfg(any(target_os = "linux", target_os = "macos", windows))]
        {
            let id = config.id.clone();
            let installation = blocking(move || {
                Ok(nsh_updater::install::Installation::current(&id, &bytes)
                    .filter(|installation| installation.can_install()))
            })
            .await?;
            let mut found = found.0.borrow_mut();
            if let (Some(installation), Some(dir), true) = (
                installation,
                sys.data_dir.clone(),
                available.sha256.is_some(),
            ) {
                update.can_install = true;
                // The same version again keeps its download; a newer one
                // replaces it, so a restart always installs the latest.
                let same = found.as_ref().is_some_and(|pending| {
                    pending.available.version == available.version
                        && pending.available.sha256 == available.sha256
                });
                if !same {
                    *found = Some(Rc::new(Pending {
                        host,
                        available,
                        dir: dir.join("updates"),
                        archive: RefCell::new(None),
                        installation,
                    }));
                }
            } else {
                *found = None;
            }
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
        let _ = (bytes, config, host, &found);
        Ok(Some(update))
    }

    /// A small file, whole. A manifest is a few kilobytes.
    fn get_all(host: &dyn UpdaterHost, url: &str) -> Result<Vec<u8>, String> {
        const MAX: usize = 1 << 20;
        let mut bytes = Vec::new();
        host.get(url, &mut |chunk, _| {
            if bytes.len() + chunk.len() > MAX {
                return Err("over 1 MiB".to_owned());
            }
            bytes.extend_from_slice(chunk);
            Ok(())
        })
        .map_err(|e| format!("{url}: {e}"))?;
        Ok(bytes)
    }

    fn pending(sys: &System) -> Result<Rc<Pending>, JsError> {
        sys.locals
            .get::<Found>()
            .0
            .borrow()
            .clone()
            .ok_or_else(unavailable)
    }

    pub(super) async fn download(
        sys: System,
        on_progress: Option<Callback<UpdateProgress>>,
    ) -> Result<(), JsError> {
        use std::io::Write as _;

        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let pending = pending(&sys)?;
        let host = pending.host.clone();
        let dir = pending.dir.clone();
        let url = pending.available.url.clone();
        let sha256 = pending.available.sha256.clone().unwrap_or_default();
        let size = pending.available.size;
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let name = format!(
            "download-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut work = std::pin::pin!(blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join(name);
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            let mut check = Download::new(&sha256, size);
            let result = host
                .get(&url, &mut |chunk, total| {
                    let received = check.update(chunk).map_err(|e| e.to_string())?;
                    file.write_all(chunk).map_err(|e| e.to_string())?;
                    let _ = tx.send((received, size.or(total)));
                    Ok(())
                })
                .and_then(|()| file.flush().map_err(|e| e.to_string()))
                .and_then(|()| check.finish().map_err(|e| e.to_string()));
            if let Err(e) = result {
                let _ = std::fs::remove_file(&path);
                return Err(e);
            }
            Ok(path)
        }));
        let path = loop {
            tokio::select! {
                result = &mut work => break result?,
                Some((received, total)) = rx.recv() => {
                    if let Some(callback) = &on_progress {
                        callback.post(UpdateProgress {
                            received: received as f64,
                            total: total.map(|t: u64| t as f64),
                        });
                    }
                }
            }
        };
        if let Some(previous) = pending.archive.borrow_mut().replace(path) {
            let _ = std::fs::remove_file(previous);
        }
        Ok(())
    }

    /// The app's updates directory, as `nsh_engine::updates` has it.
    const UPDATES: &str = "updates";
    /// The downloaded package the app's next start runs.
    const NEXT: &str = "next.nshpkg";

    pub(super) async fn check_package(sys: System) -> Result<Option<PackageUpdate>, JsError> {
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let (Some(host), Some(data_dir)) = (sys.updater.clone(), sys.data_dir.clone()) else {
            *found.2.borrow_mut() = None;
            return Ok(None);
        };
        let worker = host.clone();
        let checked = blocking(move || {
            let Some(bytes) = worker.config() else {
                return Ok(None);
            };
            let config = Config::parse(&bytes).map_err(|e| e.to_string())?;
            if config.package_roots().is_empty() {
                return Ok(None);
            }
            let running_build = worker
                .running_package()
                .map(|running| running.build)
                .unwrap_or(config.build.unwrap_or(1));
            let manifest = get_all(&*worker, &config.manifest_url())?;
            let signature = match config.signature_url() {
                Some(url) => Some(get_all(&*worker, &url)?),
                None => None,
            };
            let available = config
                .check_package(
                    &manifest,
                    signature.as_deref(),
                    running_build,
                    env!("CARGO_PKG_VERSION"),
                )
                .map_err(|e| e.to_string())?;
            Ok(available.map(|available| (config, available, running_build)))
        })
        .await?;
        let Some((config, available, running_build)) = checked else {
            *found.2.borrow_mut() = None;
            return Ok(None);
        };
        let update = PackageUpdate {
            version: available.version.clone(),
            build: available.build as f64,
            notes: available.notes.clone(),
            size: available.size.map(|size| size as f64),
        };
        *found.2.borrow_mut() = Some(Arc::new(PendingPackage {
            host,
            available,
            dir: data_dir.join(UPDATES),
            roots: config.package_roots().to_vec(),
            app_id: config.id,
            running_build,
        }));
        Ok(Some(update))
    }

    pub(super) async fn download_package(
        sys: System,
        on_progress: Option<Callback<UpdateProgress>>,
    ) -> Result<(), JsError> {
        use std::io::Write as _;

        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let pending = found.2.borrow().clone().ok_or_else(no_package)?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut work = std::pin::pin!(blocking(move || {
            let pending = &*pending;
            let dir = &pending.dir;
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let part = dir.join(format!("{NEXT}.part"));
            // A download that stopped half way (the app quit) starts again.
            let _ = std::fs::remove_file(&part);
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&part)
                .map_err(|e| e.to_string())?;
            let available = &pending.available;
            let mut check = Download::new(&available.sha256, available.size);
            let result = pending
                .host
                .get(&available.url, &mut |chunk, total| {
                    let received = check.update(chunk).map_err(|e| e.to_string())?;
                    file.write_all(chunk).map_err(|e| e.to_string())?;
                    let _ = tx.send((received, available.size.or(total)));
                    Ok(())
                })
                .and_then(|()| file.sync_all().map_err(|e| e.to_string()))
                .and_then(|()| check.finish().map_err(|e| e.to_string()))
                .and_then(|()| {
                    pending.host.verify_package(
                        &part,
                        dir,
                        &pending.app_id,
                        &pending.roots,
                        pending.running_build,
                    )
                })
                .and_then(|_| std::fs::rename(&part, dir.join(NEXT)).map_err(|e| e.to_string()));
            if let Err(e) = result {
                let _ = std::fs::remove_file(&part);
                return Err(format!("package refused: {e}"));
            }
            Ok(())
        }));
        loop {
            tokio::select! {
                result = &mut work => break result,
                Some((received, total)) = rx.recv() => {
                    if let Some(callback) = &on_progress {
                        callback.post(UpdateProgress {
                            received: received as f64,
                            total: total.map(|t: u64| t as f64),
                        });
                    }
                }
            }
        }
    }

    pub(super) async fn restart_to_package(sys: System) -> Result<(), JsError> {
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let downloaded = sys
            .data_dir
            .as_ref()
            .is_some_and(|dir| dir.join(UPDATES).join(NEXT).exists());
        if !downloaded {
            return Err(JsError::Error(
                "nothing is downloaded: call downloadPackage first".into(),
            ));
        }
        restart_into_package().await
    }

    /// As `Application.restart()`: the app's launcher runs the package
    /// when it starts again.
    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    async fn restart_into_package() -> Result<(), JsError> {
        crate::element::desktop::restart();
        std::future::pending().await
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    async fn restart_into_package() -> Result<(), JsError> {
        Err(JsError::Error(
            "an app cannot restart itself here: the package runs from the app's next start".into(),
        )
        .with_code(codes::UNAVAILABLE))
    }

    #[cfg(any(target_os = "linux", target_os = "macos", windows))]
    pub(super) async fn install(sys: System) -> Result<(), JsError> {
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let pending = pending(&sys)?;
        let archive = pending.archive.borrow().clone().ok_or_else(|| {
            JsError::Error("nothing is downloaded: call downloadUpdate first".into())
        })?;
        let installation = pending.installation.clone();
        // The restart starts the app at the path the user knows: once the
        // directory or `.app` is swapped, this process' executable is the
        // old one, moved aside and deleted.
        crate::restart::remember_program();
        blocking(move || {
            installation.install(&archive).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&archive);
            Ok(())
        })
        .await?;
        // As `Application.restart()`: the app quits as the user's quit does
        // (storage written, windows closed), and the new version starts
        // once this process has exited (`crate::restart`).
        crate::element::desktop::restart();
        std::future::pending().await
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    pub(super) async fn install(_: System) -> Result<(), JsError> {
        Err(unavailable())
    }
    /// Whether the package this run's code came from is already the
    /// release `offered` or a later one. The app's own version is the one it
    /// shipped as, so after restarting into a package of the latest release
    /// the manifest would still look newer, and the whole app would be
    /// downloaded and offered again for what already runs.
    fn package_covers(running: Option<&PackageVersion>, offered: &str) -> bool {
        running.is_some_and(|running| nsh_updater::version_at_least(&running.version, offered))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn a_running_package_of_the_release_or_later_covers_it() {
            let running = |version: &str| PackageVersion {
                version: version.into(),
                build: 35,
            };
            assert!(!package_covers(None, "0.2.1"));
            assert!(package_covers(Some(&running("0.2.1")), "0.2.1"));
            assert!(package_covers(Some(&running("0.2.10")), "0.2.9"));
            // A release the package is older than comes as the whole app (a newer runtime).
            assert!(!package_covers(Some(&running("0.2.1")), "0.3.0"));
        }

        #[test]
        fn shell_info_reads_the_shipped_configuration() {
            let config = br#"{"id":"dev.noop.app","version":"0.2.1","github":"o/r","build":35,
                "packages":{"roots":["SJl1kuuXiy0WqZM03S0Q16OIGNX7e+RTI8H5Flk8JLo="]}}"#;
            let info = ShellInfo::new(Some(config), true);
            assert_eq!(info.version.as_deref(), Some("0.2.1"));
            assert_eq!(info.build, Some(35.0));
            assert_eq!(info.nsh_version, env!("CARGO_PKG_VERSION"));
            assert!(info.packages);
            // A launcher that runs no packages, or a configuration that trusts no roots.
            assert!(!ShellInfo::new(Some(config), false).packages);
            let plain = br#"{"id":"dev.noop.app","version":"0.2.1","github":"o/r"}"#;
            let info = ShellInfo::new(Some(plain), true);
            assert_eq!(info.build, Some(1.0));
            assert!(!info.packages);
            // No configuration: a development run, an app without `"updater"`.
            let info = ShellInfo::new(None, true);
            assert_eq!(
                (info.version, info.build, info.packages),
                (None, None, false)
            );
        }

        #[test]
        fn operations_are_serial_and_release_on_error_or_cancellation() {
            let found = Found::default();
            let operation = begin(&found).unwrap();
            assert!(begin(&found).is_err());
            drop(operation);
            let operation = begin(&found).unwrap();
            assert!(begin(&found).is_err());
            drop(operation);
            assert!(begin(&found).is_ok());
        }
    }
}

/// Nothing updates on the web: a deploy updates its apps.
#[cfg(target_arch = "wasm32")]
mod native {
    use super::*;

    pub(super) async fn check(_: System) -> Result<Option<AppUpdate>, JsError> {
        Ok(None)
    }

    pub(super) async fn download(
        _: System,
        _: Option<Callback<UpdateProgress>>,
    ) -> Result<(), JsError> {
        Err(unavailable())
    }

    pub(super) async fn install(_: System) -> Result<(), JsError> {
        Err(unavailable())
    }

    pub(super) async fn check_package(_: System) -> Result<Option<PackageUpdate>, JsError> {
        Ok(None)
    }

    pub(super) async fn download_package(
        _: System,
        _: Option<Callback<UpdateProgress>>,
    ) -> Result<(), JsError> {
        Err(no_package())
    }

    pub(super) async fn restart_to_package(_: System) -> Result<(), JsError> {
        Err(no_package())
    }
}
