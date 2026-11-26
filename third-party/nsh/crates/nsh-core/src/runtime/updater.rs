//! `nsh/updater`: the app updates itself (`docs/dev/updater.md`). The rules
//! are `nsh-updater`'s; this module is its JS face over the platform's HTTP
//! stack ([`UpdaterHost`]). The source comes from the package, never from
//! the caller, so what the app's code can do is ask, not point it elsewhere;
//! the one exception is opted into in `nsh.json`: packages from a feed the
//! code names (`"packages": { "source": "runtime" }`), still signed with the
//! package's keys.
//!
//! Needs no capability: the developer named the source in `nsh.json`, and a
//! module running inside another app has no installation to replace.
//!
//! Packages (`checkForPackage`, `downloadPackage`, `restartToPackage`,
//! `runningPackage`): a newer build of the app's code, signed and verified
//! against the roots in `nsh.json`, which the app's launcher runs at its
//! next start (`nsh_engine::updates`). They update the code on every
//! platform with a launcher that runs them, iOS and Android included.

#[cfg(all(not(target_arch = "wasm32"), feature = "updater"))]
use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
};

use crate::element::{Callback, JsError, JsObject, Later, System, codes, module};

/// Takes a piece of a body: its byte offset in the resource, the bytes, and
/// the resource's total size if known; an error stops it.
pub type UpdaterSink<'a> = &'a mut dyn FnMut(u64, &[u8], Option<u64>) -> Result<(), String>;

/// What the platform gives the module: the package's update configuration
/// and HTTP. Both block, and are called off the engine thread.
pub trait UpdaterHost: Send + Sync + 'static {
    /// The package's configuration file; `None` when it has none (a
    /// development run, an app without `"updater"` in `nsh.json`).
    fn config(&self) -> Option<Vec<u8>>;

    /// Gets `url` from byte `from` on, following redirects, handing each
    /// piece of the body to `sink` with its offset in the resource, until it
    /// fails or the body ends. With `from > 0` the host asks for the rest
    /// (`Range: bytes=<from>-`); a server that ignores the range sends the
    /// whole resource from offset `0`, and one that cannot satisfy it
    /// (`416`) sends no pieces. Offsets count the raw resource's bytes, so
    /// the host asks for no transparent compression.
    fn get(&self, url: &str, from: u64, sink: UpdaterSink<'_>) -> Result<(), String>;

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

/// Options of `checkForUpdate`.
#[derive(Debug, Clone, Default, JsObject)]
#[non_exhaustive]
pub(crate) struct UpdateCheckOptions {
    /// The name of a channel in `nsh.json`'s `"updater": { "channels" }`
    /// to check instead of the default source. Only names the package
    /// declares are accepted: the app's code chooses, the package says
    /// where.
    pub(crate) channel: Option<String>,
    /// The language the app shows (a BCP 47 tag such as `zh-TW`): `notes`
    /// is then the manifest's notes in it, or in its language (`zh`),
    /// downloading only that file, else the default notes.
    pub(crate) locale: Option<String>,
}

/// Options of `checkForPackage`.
#[derive(Debug, Clone, Default, JsObject)]
#[non_exhaustive]
pub(crate) struct PackageCheckOptions {
    /// As `checkForUpdate`'s: the language `notes` is in, when the
    /// manifest has it.
    pub(crate) locale: Option<String>,
    /// The manifest to check, for an app whose `nsh.json` lets its code
    /// name it (`"updater": { "packages": { "source": "runtime" } }`): one
    /// build of the app for several servers. HTTPS, or plain HTTP with
    /// `"allowHttp": true`, which keeps the feed's files and redirects on
    /// its origin. The manifest's signature and the package's are checked
    /// against the keys in `nsh.json` as for any source, and a package not
    /// newer than the running build is never offered. `downloadPackage`
    /// downloads what this check found.
    pub(crate) url: Option<String>,
}

/// A newer version of the app.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct AppUpdate {
    /// Its version.
    pub(crate) version: String,
    /// What changed, as the manifest says it: in the check's `locale` when
    /// the manifest has it.
    pub(crate) notes: Option<String>,
    /// Where the user can get it by hand: the archive, or a store's page on
    /// iOS and Android. For `openUrl` when `canInstall` is false.
    pub(crate) url: String,
    /// Whether `downloadUpdate`, `installAndRestart` and `installOnQuit` work
    /// here: a package on the desktop, installed where the user can write.
    /// False on iOS and Android, and under a directory only the system
    /// writes.
    pub(crate) can_install: bool,
    /// Whether only the installed app is behind: the package this run's code
    /// came from is already this version or a later one, so the update
    /// brings a newer runtime and native shell, not newer app code. Apps that
    /// update by package can offer it as the quieter "update the app" step.
    pub(crate) shell: bool,
}

/// A newer build of the app's code, as a signed package.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub(crate) struct PackageUpdate {
    /// Its version (`nsh.json` `"version"`).
    pub(crate) version: String,
    /// Its build number, newer than the running one.
    pub(crate) build: f64,
    /// What changed, as the manifest says it: in the check's `locale` when
    /// the manifest has it.
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
        #[cfg(all(not(target_arch = "wasm32"), feature = "updater"))]
        let shipped = config
            .and_then(|bytes| nsh_updater::Config::parse(bytes).ok())
            .map(|config| {
                let roots = !config.package_roots().is_empty();
                (config.version, config.build.unwrap_or(1), roots)
            });
        #[cfg(any(target_arch = "wasm32", not(feature = "updater")))]
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
    /// Asks the source in `nsh.json`'s `"updater"` for a newer version:
    /// its `url` or `github`, or with `channel`, the manifest of that name
    /// in its `"channels"`. Resolves with the update, or `null` when the
    /// app is up to date, has no `"updater"`, or runs where apps do not
    /// update (the web, a development run). Rejects when the package
    /// declares no channel of that name, and when the source cannot be
    /// reached or its manifest is not acceptable: a bad signature, another
    /// app's id, a URL that is not HTTPS. `downloadUpdate`,
    /// `installAndRestart` and `installOnQuit` use what the last check
    /// found, whichever source.
    pub(crate) fn check_for_update(
        options: Option<UpdateCheckOptions>,
        sys: System,
    ) -> Later<Option<AppUpdate>> {
        let options = options.unwrap_or_default();
        Later::new(native::check(sys, options.channel, options.locale))
    }

    /// Downloads the update the last `checkForUpdate` found and checks it
    /// against the manifest, calling `onProgress` as bytes arrive. An
    /// interrupted transfer keeps its partial file keyed to the asset and
    /// resumes on the next call when the host supports HTTP `Range` requests,
    /// starting over when the server ignores the range or the file does not
    /// match. Transient network failures are retried within the call.
    /// Rejects with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when it found
    /// none or `canInstall` is false, and when the download fails or does not
    /// match.
    pub(crate) fn download_update(
        #[args(progress)] on_progress: Option<Callback<UpdateProgress>>,
        sys: System,
    ) -> Later<()> {
        let on_progress = on_progress.map(|callback| {
            Box::new(move |progress| callback.post(progress)) as Box<dyn Fn(UpdateProgress)>
        });
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

    /// Replaces the installed app with the downloaded update when the app
    /// quits, without starting it again: the user's next start opens the
    /// new version. The update is unpacked and checked now, as
    /// `installAndRestart` checks it, and the promise resolves once it
    /// waits; quitting then only moves it into place. Rejects when nothing
    /// was downloaded or the update is refused, which leaves the app as it
    /// was. Calling it again replaces what waits, and `installAndRestart`
    /// installs at once instead. Only a quit of the app installs it: if the
    /// app ends otherwise (a crash, being killed), it is gone, and the next
    /// `checkForUpdate` offers the update again. When moving it into place
    /// fails as the app quits (the app was moved meanwhile, say), the app
    /// stays as it was and quits all the same, the failure logged.
    pub(crate) fn install_on_quit(sys: System) -> Later<()> {
        Later::new(native::install_on_quit(sys))
    }

    /// Checks for a newer version as `checkForUpdate` does and asks the
    /// user about it in NSH's built-in prompt, as macOS apps' Sparkle does:
    /// the version, its notes and Skip This Version, Remind Me Later and
    /// Install Update, then the download's progress and Install and
    /// Relaunch or Install on Quit. Where the app cannot install itself
    /// (`canInstall` false: iOS, Android) Install Update opens the update's
    /// `url`. The user's Skip This Version and "Automatically download and
    /// install updates" are kept in the app's data directory: a `quiet`
    /// check (at startup, in the background) shows nothing for a skipped
    /// version, and installs an update as the app quits without asking
    /// once the user chose to; it shows nothing either when the app is up
    /// to date or the check fails. Without `quiet` (a "Check for Updates…"
    /// menu item) the user hears that too. Resolves once the prompt shows,
    /// or there is nothing to show; never rejects.
    pub(crate) fn prompt_for_update(
        options: Option<UpdatePromptOptions>,
        sys: System,
    ) -> Later<()> {
        let options = options.unwrap_or_default();
        Later::new(async move {
            prompt::run(sys, options).await;
            Ok::<_, JsError>(())
        })
    }

    /// Asks the source in `nsh.json`'s `"updater"` for a newer build of the
    /// app's code: a signed package newer than the running build (the
    /// running package's, else the one the app shipped with) that this
    /// runtime runs. With `url`, asks that manifest instead, when the
    /// package lets the app's code choose (`"packages": { "source":
    /// "runtime" }`). Resolves with it, or `null` when there is none, the
    /// app trusts no package roots (`"updater": { "packages": { "roots" } }`)
    /// or runs where apps do not update (the web, a development run).
    /// Rejects as `checkForUpdate` does, and for a `url` the package does
    /// not let the app choose, or without one when the package names no
    /// source of its own.
    pub(crate) fn check_for_package(
        options: Option<PackageCheckOptions>,
        sys: System,
    ) -> Later<Option<PackageUpdate>> {
        let options = options.unwrap_or_default();
        Later::new(native::check_package(sys, options.locale, options.url))
    }

    /// Downloads the package the last `checkForPackage` found, checks it
    /// against the manifest and verifies it as the app's next start will:
    /// signed by a release key a trusted root certifies, for this app, newer
    /// than the running build, for this runtime. It then runs from the
    /// app's next start (`restartToPackage`). Calls `onProgress` as bytes
    /// arrive. An interrupted transfer keeps its partial file keyed to the
    /// package and resumes on the next call when the host supports HTTP
    /// `Range` requests, starting over when the server ignores the range or
    /// the file does not match. Transient network failures are retried
    /// within the call. Rejects with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` when the check found none, and
    /// with an error saying why when the download fails or the package is
    /// refused (a refused package leaves nothing behind).
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

mod prompt;

pub use prompt::{UpdatePrompt, UpdatePromptOptions, prompt_for_update, set_update_presenter};

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

#[cfg(all(not(target_arch = "wasm32"), feature = "updater"))]
mod native {
    use std::collections::BTreeMap;

    use nsh_updater::{Available, Config};

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
        #[cfg(any(
            all(target_os = "linux", not(target_env = "ohos")),
            target_os = "macos",
            windows
        ))]
        installation: nsh_updater::install::Installation,
    }

    /// Runs `work` off the engine thread.
    async fn blocking<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<T, JsError> {
        super::super::fs::blocking(move || work().map_err(JsError::Error)).await
    }

    pub(super) async fn check(
        sys: System,
        channel: Option<String>,
        locale: Option<String>,
    ) -> Result<Option<AppUpdate>, JsError> {
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
            if !config.has_source() && channel.is_none() {
                return Err(
                    "no update source: the app's nsh.json names no github or url, only \
                            package feeds its code chooses (checkForPackage({ url }))"
                        .to_owned(),
                );
            }
            // Only the source changes: the id, version and key are the
            // package's, and the installation is found by its own file.
            let config = match &channel {
                Some(name) => config.channel(name).map_err(|e| e.to_string())?,
                None => config,
            };
            #[cfg(any(
                all(target_os = "linux", not(target_env = "ohos")),
                target_os = "macos",
                windows
            ))]
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
                .map_err(|e| e.to_string())?;
            let running = worker.running_package();
            Ok(available.map(|mut available| {
                let shell = package_covers(running.as_ref(), &available.version);
                if let Some(notes) = localized(&*worker, &available.localized_notes, locale) {
                    available.notes = Some(notes);
                }
                (bytes, config, available, shell)
            }))
        })
        .await?;
        let Some((bytes, config, available, shell)) = checked else {
            *found.0.borrow_mut() = None;
            return Ok(None);
        };
        // Only the desktops install an update (`can_install` below).
        #[cfg_attr(
            not(any(
                all(target_os = "linux", not(target_env = "ohos")),
                target_os = "macos",
                windows
            )),
            allow(unused_mut)
        )]
        let mut update = AppUpdate {
            version: available.version.clone(),
            notes: available.notes.clone(),
            url: available.url.clone(),
            can_install: false,
            shell,
        };
        #[cfg(any(
            all(target_os = "linux", not(target_env = "ohos")),
            target_os = "macos",
            windows
        ))]
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
        #[cfg(not(any(
            all(target_os = "linux", not(target_env = "ohos")),
            target_os = "macos",
            windows
        )))]
        let _ = (bytes, config, host, &found);
        Ok(Some(update))
    }

    /// The app's display name and version as it was packaged
    /// (`nsh-updater.json`), when it has them.
    pub(super) async fn shipped(sys: &System) -> (Option<String>, Option<String>) {
        let Some(host) = sys.updater.clone() else {
            return (None, None);
        };
        let shipped = blocking(move || {
            Ok(host
                .config()
                .and_then(|bytes| Config::parse(&bytes).ok())
                .map(|config| (config.name, config.version)))
        })
        .await;
        match shipped {
            Ok(Some((name, version))) => (name, Some(version)),
            _ => (None, None),
        }
    }

    /// The notes in `locale` among `files`, downloaded and checked; `None`
    /// keeps the default notes, also when the file cannot be had: notes in
    /// another language must not fail a check.
    fn localized(
        host: &dyn UpdaterHost,
        files: &BTreeMap<String, nsh_updater::NotesFile>,
        locale: Option<String>,
    ) -> Option<String> {
        let file = nsh_updater::notes_for(files, &locale?)?;
        let opened = get_all(host, &file.url)
            .and_then(|bytes| nsh_updater::open_notes(file, bytes).map_err(|e| e.to_string()));
        match opened {
            Ok(notes) => Some(notes),
            Err(e) => {
                log::warn!("updater: notes: {e}");
                None
            }
        }
    }

    /// A small file, whole. A manifest is a few kilobytes.
    fn get_all(host: &dyn UpdaterHost, url: &str) -> Result<Vec<u8>, String> {
        const MAX: usize = 1 << 20;
        let mut bytes = Vec::new();
        host.get(url, 0, &mut |_, chunk, _| {
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

    /// Safe filename fragment keying a partial or verified download to the
    /// asset's manifest SHA-256: lowercase hex as-is for normal hashes, or
    /// hashed otherwise so an unusual manifest field can never escape `dir`.
    fn part_key(sha256: &str) -> String {
        if !sha256.is_empty() && sha256.len() <= 64 && sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            sha256.to_ascii_lowercase()
        } else {
            nsh_updater::sha256(sha256.as_bytes())
        }
    }

    /// Removes stale `download-*` files in `dir` that do not belong to the
    /// asset currently being downloaded (leaving OTA package files untouched).
    fn cleanup_stale_downloads(dir: &std::path::Path, keep_part: &str, keep_dest: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with("download-")
                && name != keep_part
                && name != keep_dest
                && name.strip_suffix(".lock") != Some(keep_part)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// Removes stale OTA `.part` files in `dir` that do not match `keep_part`
    /// (including legacy `next.nshpkg.part`), leaving `next.nshpkg`,
    /// `trying.nshpkg`, `current.nshpkg`, `trust/` and `packages/` untouched.
    fn cleanup_stale_package_parts(dir: &std::path::Path, keep_part: &str) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let legacy = name == format!("{NEXT}.part");
            let other = name.starts_with("next-")
                && (name.ends_with(".nshpkg.part") || name.ends_with(".nshpkg.part.lock"));
            if (legacy || other)
                && name != keep_part
                && name.strip_suffix(".lock") != Some(keep_part)
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    /// An [`nsh_updater::Download`] that counts what it took, so a kept
    /// `.part` file can be hashed again and resumed from its end.
    #[derive(Debug)]
    struct Download {
        check: nsh_updater::Download,
        received: u64,
    }

    impl Download {
        fn new(sha256: &str, size: Option<u64>) -> Download {
            Download {
                check: nsh_updater::Download::new(sha256, size),
                received: 0,
            }
        }

        /// Seeded with the bytes already in `partial`; fails if they exceed
        /// the manifest's size or cannot be read.
        fn resume(
            sha256: &str,
            size: Option<u64>,
            partial: &mut impl std::io::Read,
        ) -> Result<Download, String> {
            let mut download = Download::new(sha256, size);
            let mut buf = [0u8; 16 * 1024];
            loop {
                match partial.read(&mut buf) {
                    Ok(0) => return Ok(download),
                    Ok(n) => {
                        download.update(&buf[..n]).map_err(|e| e.to_string())?;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e.to_string()),
                }
            }
        }

        fn received(&self) -> u64 {
            self.received
        }

        fn update(&mut self, chunk: &[u8]) -> Result<u64, nsh_updater::Error> {
            self.received = self.check.update(chunk)?;
            Ok(self.received)
        }

        fn finish(self) -> Result<(), nsh_updater::Error> {
            self.check.finish()
        }
    }

    /// Opens an existing `.part` file and seeds a [`Download`] from it, or
    /// creates a fresh empty `.part` file when none exists or the existing one
    /// is unusable (for instance, larger than `size`). Returns the open file
    /// positioned at its end, the seeded [`Download`], and whether non-empty
    /// bytes were loaded from disk.
    fn open_or_create_part(
        part: &std::path::Path,
        sha256: &str,
        size: Option<u64>,
    ) -> Result<(std::fs::File, Download, bool), String> {
        use std::io::Seek as _;

        if let Ok(mut file) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(part)
        {
            match Download::resume(sha256, size, &mut file) {
                Ok(check) => {
                    let received = check.received();
                    file.seek(std::io::SeekFrom::Start(received))
                        .map_err(|e| e.to_string())?;
                    file.set_len(received).map_err(|e| e.to_string())?;
                    return Ok((file, check, received > 0));
                }
                Err(_) => {
                    drop(file);
                    let _ = std::fs::remove_file(part);
                }
            }
        }
        let (file, check) = reset_part(part, sha256, size)?;
        Ok((file, check, false))
    }

    /// Removes any existing `part` and creates a fresh empty file beside a
    /// fresh [`Download`].
    fn reset_part(
        part: &std::path::Path,
        sha256: &str,
        size: Option<u64>,
    ) -> Result<(std::fs::File, Download), String> {
        let _ = std::fs::remove_file(part);
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(part)
            .map_err(|e| e.to_string())?;
        Ok((file, Download::new(sha256, size)))
    }

    struct DownloadTarget<'a> {
        host: &'a dyn UpdaterHost,
        url: &'a str,
        part: &'a std::path::Path,
        dest: &'a std::path::Path,
        remove_invalid_dest: bool,
        sha256: &'a str,
        size: Option<u64>,
    }

    enum TransferStep {
        /// Body reached EOF (`Full` or `Partial`); caller syncs, finishes and verifies.
        Finished {
            file: std::fs::File,
            check: Download,
            resumed: bool,
        },
        /// The existing partial file verified against the manifest and was
        /// moved into `dest` (`416` when the manifest omitted `size`).
        Completed,
        /// The existing partial file was discarded; caller restarts once from `0`.
        RestartFresh,
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum ResponseKind {
        None,
        Full,
        Partial,
        Unsatisfiable,
    }

    /// Streams one transfer pass (possibly multiple ranged slices if the host
    /// caps individual `206` responses) into `file`.
    fn transfer_into_part(
        target: &DownloadTarget<'_>,
        mut file: std::fs::File,
        mut check: Download,
        mut resumed: bool,
        progress: &mut impl FnMut(u64, Option<u64>) -> bool,
        verify: &impl Fn(&std::path::Path) -> Result<(), String>,
    ) -> Result<TransferStep, DownloadError> {
        use std::io::{Seek as _, Write as _};

        // Upper bound on server-capped `206` slices in one call.
        const MAX_RANGE_SLICES: usize = 1024;
        let mut slices = 0usize;

        loop {
            let offset = check.received();
            let mut kind = ResponseKind::None;
            let mut server_total: Option<u64> = None;
            let mut exceeded_size = false;
            // Set when the failure is ours (cancel, disk), not the network's.
            let mut local_failure = false;

            let transfer = target
                .host
                .get(target.url, offset, &mut |at, chunk, total| {
                    if chunk.is_empty() {
                        return Ok(());
                    }
                    if kind == ResponseKind::None {
                        if at == 0 {
                            kind = ResponseKind::Full;
                            if check.received() > 0 {
                                let reset = file
                                    .set_len(0)
                                    .and_then(|()| file.seek(std::io::SeekFrom::Start(0)));
                                if let Err(e) = reset {
                                    local_failure = true;
                                    return Err(e.to_string());
                                }
                                check = Download::new(target.sha256, target.size);
                                resumed = false;
                            }
                        } else if at == offset {
                            kind = ResponseKind::Partial;
                            // Show the kept bytes before the new ones arrive.
                            if !progress(offset, target.size.or(total)) {
                                local_failure = true;
                                return Err("download cancelled".to_owned());
                            }
                        } else {
                            return Err(format!("body starts at byte {at}, not {offset}"));
                        }
                        server_total = total;
                    } else if at != check.received() {
                        return Err(format!(
                            "body piece at byte {at}, expected {}",
                            check.received()
                        ));
                    }
                    let received = match check.update(chunk) {
                        Ok(received) => received,
                        Err(e) => {
                            exceeded_size = true;
                            return Err(e.to_string());
                        }
                    };
                    if let Err(e) = file.write_all(chunk) {
                        local_failure = true;
                        return Err(e.to_string());
                    }
                    if !progress(received, target.size.or(server_total)) {
                        local_failure = true;
                        return Err("download cancelled".to_owned());
                    }
                    Ok(())
                });
            // No body for a resumed request: the server could not satisfy
            // the range (`416`).
            if transfer.is_ok() && kind == ResponseKind::None && offset > 0 {
                kind = ResponseKind::Unsatisfiable;
            }

            if let Err(err) = transfer {
                let _ = file.flush();
                let received = check.received();
                drop(file);
                if exceeded_size {
                    let _ = std::fs::remove_file(target.part);
                    if resumed {
                        return Ok(TransferStep::RestartFresh);
                    }
                    return Err(err.into());
                }
                // Keep partial progress on transport / HTTP errors or cancellation
                // so the next call resumes; drop empty 0-byte placeholders.
                if received == 0 {
                    let _ = std::fs::remove_file(target.part);
                }
                let retryable = !local_failure && is_transient(&err);
                return Err(DownloadError {
                    message: err,
                    retryable,
                });
            }

            match kind {
                ResponseKind::Unsatisfiable => {
                    let received = check.received();
                    let _ = file.sync_all();
                    drop(file);
                    if offset > 0 && target.size.is_none_or(|s| s == received) {
                        // A `416` when the manifest omitted `size` can mean
                        // the partial file already holds the entire asset.
                        if check.finish().is_ok() {
                            if let Err(err) = verify(target.part) {
                                let _ = std::fs::remove_file(target.part);
                                return Err(err.into());
                            }
                            let _ = progress(received, target.size.or(Some(received)));
                            std::fs::rename(target.part, target.dest).map_err(|e| e.to_string())?;
                            return Ok(TransferStep::Completed);
                        }
                    }
                    let _ = std::fs::remove_file(target.part);
                    if resumed {
                        return Ok(TransferStep::RestartFresh);
                    }
                    return Err("HTTP 416".to_owned().into());
                }
                ResponseKind::Partial => {
                    let expected = target.size.or(server_total);
                    if check.received() > offset
                        && expected.is_some_and(|total| check.received() < total)
                        && slices < MAX_RANGE_SLICES
                    {
                        slices += 1;
                        continue;
                    }
                    return Ok(TransferStep::Finished {
                        file,
                        check,
                        resumed,
                    });
                }
                ResponseKind::Full => {
                    return Ok(TransferStep::Finished {
                        file,
                        check,
                        resumed,
                    });
                }
                ResponseKind::None => {
                    let received = check.received();
                    drop(file);
                    if received == 0 {
                        let _ = std::fs::remove_file(target.part);
                    }
                    return Err(DownloadError {
                        message: "empty response".to_owned(),
                        retryable: true,
                    });
                }
            }
        }
    }

    /// Locks `<part>.lock`, held until the returned file drops; fails at
    /// once when another download of the same asset holds it.
    fn lock_part(part: &std::path::Path) -> Result<std::fs::File, String> {
        let mut path = part.as_os_str().to_owned();
        path.push(".lock");
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| e.to_string())?;
        match file.try_lock() {
            Ok(()) => Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                Err("another download of this update is in progress".to_owned())
            }
            Err(std::fs::TryLockError::Error(e)) => Err(e.to_string()),
        }
    }

    /// Downloads `target.url` into `target.part` (resuming an existing partial
    /// file when present), verifies its size, SHA-256 and `verify`, and moves
    /// it atomically to `target.dest`.
    #[cfg(test)]
    fn download_resumable(
        target: &DownloadTarget<'_>,
        progress: impl FnMut(u64, Option<u64>) -> bool,
        verify: impl Fn(&std::path::Path) -> Result<(), String>,
    ) -> Result<(), String> {
        download_once(target, progress, verify).map_err(|e| e.message)
    }

    /// How [`download_with_retry`] backs off between attempts.
    #[derive(Clone, Copy)]
    struct RetryPolicy {
        /// Retries in a row without any new byte before giving up.
        attempts: u32,
        /// First wait; doubles per retry without progress, capped at 16x.
        backoff: std::time::Duration,
    }

    impl RetryPolicy {
        const DEFAULT: Self = Self {
            attempts: 5,
            backoff: std::time::Duration::from_secs(1),
        };
    }

    /// [`download_resumable`] that retries transient network failures
    /// (resets, stalls, truncated bodies, `5xx`, `408`, `429`) from the
    /// bytes already on disk, so a flaky link does not need the app to call
    /// `download` again. The attempt budget resets whenever a pass made
    /// progress; cancellation, verification and `4xx` errors fail at once.
    fn download_with_retry(
        target: &DownloadTarget<'_>,
        policy: RetryPolicy,
        mut progress: impl FnMut(u64, Option<u64>) -> bool,
        verify: impl Fn(&std::path::Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut failures = 0u32;
        let mut furthest = 0u64;
        loop {
            let mut reached = 0u64;
            let result = download_once(
                target,
                |received, total| {
                    reached = reached.max(received);
                    progress(received, total)
                },
                &verify,
            );
            let err = match result {
                Ok(()) => return Ok(()),
                Err(err) if !err.retryable => return Err(err.message),
                Err(err) => err,
            };
            if reached > furthest {
                furthest = reached;
                failures = 0;
            }
            failures += 1;
            if failures > policy.attempts {
                return Err(err.message);
            }
            let wait = policy.backoff * (1u32 << (failures - 1).min(4));
            std::thread::sleep(wait);
            // Let a cancellation made during the wait stop the retry.
            if !progress(furthest, target.size) {
                return Err("download cancelled".to_owned());
            }
        }
    }

    /// Whether a transfer error from the host is worth retrying.
    fn is_transient(err: &str) -> bool {
        match err
            .strip_prefix("HTTP ")
            .and_then(|code| code.trim().parse::<u16>().ok())
        {
            Some(status) => status >= 500 || status == 408 || status == 429,
            None => !err.starts_with("redirect to non-HTTPS") && err != "too many redirects",
        }
    }

    struct DownloadError {
        message: String,
        retryable: bool,
    }

    impl From<String> for DownloadError {
        fn from(message: String) -> Self {
            Self {
                message,
                retryable: false,
            }
        }
    }

    fn download_once(
        target: &DownloadTarget<'_>,
        mut progress: impl FnMut(u64, Option<u64>) -> bool,
        verify: impl Fn(&std::path::Path) -> Result<(), String>,
    ) -> Result<(), DownloadError> {
        // One download of an asset at a time, also across processes: the
        // `.part` is shared, so a second one would interleave its bytes.
        let _lock = lock_part(target.part)?;
        // Fast path: the final file is already on disk and matches this asset.
        if let Ok(mut existing) = std::fs::File::open(target.dest) {
            let matched = Download::resume(target.sha256, target.size, &mut existing)
                .ok()
                .and_then(|check| {
                    let received = check.received();
                    check.finish().ok().map(|()| received)
                });
            drop(existing);
            if let Some(received) = matched {
                let _ = std::fs::remove_file(target.part);
                if let Err(err) = verify(target.dest) {
                    let _ = std::fs::remove_file(target.dest);
                    return Err(err.into());
                }
                let _ = progress(received, target.size.or(Some(received)));
                return Ok(());
            } else if target.remove_invalid_dest {
                let _ = std::fs::remove_file(target.dest);
            }
        }

        let (mut file, mut check, mut resumed) =
            open_or_create_part(target.part, target.sha256, target.size)?;

        // Fast path: a previous run wrote all expected bytes before crashing
        // or failing before the final rename.
        if resumed && target.size == Some(check.received()) {
            let received = check.received();
            drop(file);
            if check.finish().is_ok() {
                if let Err(err) = verify(target.part) {
                    let _ = std::fs::remove_file(target.part);
                    return Err(err.into());
                }
                let _ = progress(received, Some(received));
                std::fs::rename(target.part, target.dest).map_err(|e| e.to_string())?;
                return Ok(());
            }
            (file, check) = reset_part(target.part, target.sha256, target.size)?;
            resumed = false;
        }

        loop {
            match transfer_into_part(target, file, check, resumed, &mut progress, &verify)? {
                TransferStep::Completed => return Ok(()),
                TransferStep::RestartFresh => {
                    (file, check) = reset_part(target.part, target.sha256, target.size)?;
                    resumed = false;
                }
                TransferStep::Finished {
                    file: done_file,
                    check: done_check,
                    resumed: used_partial,
                } => {
                    let sync = done_file.sync_all().map_err(|e| e.to_string());
                    drop(done_file);
                    sync?;
                    if let Err(err) = done_check.finish() {
                        let _ = std::fs::remove_file(target.part);
                        if used_partial {
                            // The kept partial bytes or the remote file may have
                            // changed; fall back once to a clean full download.
                            (file, check) = reset_part(target.part, target.sha256, target.size)?;
                            resumed = false;
                            continue;
                        }
                        return Err(err.to_string().into());
                    }
                    if let Err(err) = verify(target.part) {
                        let _ = std::fs::remove_file(target.part);
                        return Err(err.into());
                    }
                    std::fs::rename(target.part, target.dest).map_err(|e| e.to_string())?;
                    return Ok(());
                }
            }
        }
    }

    pub(super) async fn download(
        sys: System,
        on_progress: Option<Box<dyn Fn(UpdateProgress)>>,
    ) -> Result<(), JsError> {
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let pending = pending(&sys)?;
        let host = pending.host.clone();
        let dir = pending.dir.clone();
        let url = pending.available.url.clone();
        let sha256 = pending.available.sha256.clone().unwrap_or_default();
        let size = pending.available.size;
        #[cfg(any(
            all(target_os = "linux", not(target_env = "ohos")),
            target_os = "macos",
            windows
        ))]
        let delta = pending
            .available
            .delta
            .clone()
            .map(|delta| (delta, pending.installation.clone()));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut work = std::pin::pin!(blocking(move || {
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let key = part_key(&sha256);
            let part_name = format!("download-{key}.part");
            let dest_name = format!("download-{key}");
            cleanup_stale_downloads(&dir, &part_name, &dest_name);
            // The patch from the running version first, the archive when
            // it cannot make the new app.
            #[cfg(any(
                all(target_os = "linux", not(target_env = "ohos")),
                target_os = "macos",
                windows
            ))]
            if let Some((delta, installation)) = &delta {
                let progress = |received, total| tx.send((received, total)).is_ok();
                match patched(&*host, installation, &dir, delta, progress) {
                    Ok(path) => return Ok(path),
                    Err(e) => {
                        log::warn!("updater: downloading the whole app, the patch failed: {e}")
                    }
                }
            }
            let part = dir.join(&part_name);
            let dest = dir.join(&dest_name);
            let target = DownloadTarget {
                host: &*host,
                url: &url,
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size,
            };
            download_with_retry(
                &target,
                RetryPolicy::DEFAULT,
                |received, total| tx.send((received, total)).is_ok(),
                |_| Ok(()),
            )?;
            Ok(dest)
        }));
        let post = |received: u64, total: Option<u64>| {
            if let Some(on_progress) = &on_progress {
                on_progress(UpdateProgress {
                    received: received as f64,
                    total: total.map(|t| t as f64),
                });
            }
        };
        let result = loop {
            tokio::select! {
                result = &mut work => break result,
                Some((received, total)) = rx.recv() => post(received, total),
            }
        };
        while let Ok((received, total)) = rx.try_recv() {
            post(received, total);
        }
        let path = result?;
        if let Some(previous) = pending.archive.borrow_mut().replace(path.clone())
            && previous != path
        {
            let _ = std::fs::remove_file(previous);
        }
        Ok(())
    }

    /// Makes the new app from the patch of the running version
    /// ([`nsh_updater::delta`]): the installed app as the patch's reference,
    /// checked against the manifest, the patch downloaded (resumable) and
    /// applied; the `.tar` it made, checked too.
    #[cfg(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    ))]
    fn patched(
        host: &dyn UpdaterHost,
        installation: &nsh_updater::install::Installation,
        dir: &std::path::Path,
        delta: &nsh_updater::Delta,
        progress: impl FnMut(u64, Option<u64>) -> bool,
    ) -> Result<PathBuf, String> {
        use std::{fs, io::BufWriter};
        let key = part_key(&delta.result);
        // What patches to other versions left.
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if let Some(name) = name.to_str()
                    && name.starts_with("delta-")
                    && !name.starts_with(&format!("delta-{key}"))
                {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        let base_path = dir.join(format!("delta-{key}.base"));
        let result = (|| {
            let file = fs::File::create(&base_path).map_err(|e| e.to_string())?;
            let base = installation
                .delta_base(BufWriter::new(file))
                .map_err(|e| e.to_string())?;
            if base != delta.base.to_ascii_lowercase() {
                return Err(format!(
                    "the installed app is not version {} as released",
                    delta.from
                ));
            }
            let part = dir.join(format!("delta-{key}.patch.part"));
            let patch = dir.join(format!("delta-{key}.patch"));
            let target = DownloadTarget {
                host,
                url: &delta.url,
                part: &part,
                dest: &patch,
                remove_invalid_dest: true,
                sha256: &delta.sha256,
                size: Some(delta.size),
            };
            download_with_retry(&target, RetryPolicy::DEFAULT, progress, |_| Ok(()))?;
            let base = fs::read(&base_path).map_err(|e| e.to_string())?;
            let out_path = dir.join(format!("delta-{key}.tar"));
            let applied = (|| {
                let out = BufWriter::new(fs::File::create(&out_path)?);
                nsh_updater::delta::apply(&base, fs::File::open(&patch)?, out, &delta.result)
            })();
            let _ = fs::remove_file(&patch);
            if let Err(e) = applied {
                let _ = fs::remove_file(&out_path);
                return Err(e.to_string());
            }
            Ok(out_path)
        })();
        let _ = fs::remove_file(&base_path);
        result
    }

    /// The app's updates directory, as `nsh_engine::updates` has it.
    const UPDATES: &str = "updates";
    /// The downloaded package the app's next start runs.
    const NEXT: &str = "next.nshpkg";

    pub(super) async fn check_package(
        sys: System,
        locale: Option<String>,
        url: Option<String>,
    ) -> Result<Option<PackageUpdate>, JsError> {
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
            // Only the source changes, as for a channel: the id, keys and
            // roots stay the package's.
            let config = match &url {
                Some(url) => config.package_feed(url).map_err(|e| e.to_string())?,
                None if !config.has_source() => {
                    return Err("checkForPackage: pass `url`: the app's nsh.json names no \
                                source of its own (\"packages\": { \"source\": \"runtime\" })"
                        .to_owned());
                }
                None => config,
            };
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
            Ok(available.map(|mut available| {
                if let Some(notes) = localized(&*worker, &available.localized_notes, locale) {
                    available.notes = Some(notes);
                }
                (config, available, running_build)
            }))
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
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let pending = found.2.borrow().clone().ok_or_else(no_package)?;
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut work = std::pin::pin!(blocking(move || {
            let pending = &*pending;
            let dir = &pending.dir;
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            let available = &pending.available;
            let part_name = format!("next-{}.nshpkg.part", part_key(&available.sha256));
            cleanup_stale_package_parts(dir, &part_name);
            let part = dir.join(&part_name);
            let dest = dir.join(NEXT);
            let target = DownloadTarget {
                host: &*pending.host,
                url: &available.url,
                part: &part,
                dest: &dest,
                remove_invalid_dest: false,
                sha256: &available.sha256,
                size: available.size,
            };
            download_with_retry(
                &target,
                RetryPolicy::DEFAULT,
                |received, total| tx.send((received, total)).is_ok(),
                |file| {
                    pending
                        .host
                        .verify_package(
                            file,
                            dir,
                            &pending.app_id,
                            &pending.roots,
                            pending.running_build,
                        )
                        .map(|_| ())
                },
            )
            .map_err(|e| format!("package refused: {e}"))
        }));
        let post = |received: u64, total: Option<u64>| {
            if let Some(callback) = &on_progress {
                callback.post(UpdateProgress {
                    received: received as f64,
                    total: total.map(|t| t as f64),
                });
            }
        };
        let result = loop {
            tokio::select! {
                result = &mut work => break result,
                Some((received, total)) = rx.recv() => post(received, total),
            }
        };
        while let Ok((received, total)) = rx.try_recv() {
            post(received, total);
        }
        result
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
    #[cfg(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    ))]
    async fn restart_into_package() -> Result<(), JsError> {
        crate::element::desktop::restart();
        std::future::pending().await
    }

    #[cfg(not(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    )))]
    async fn restart_into_package() -> Result<(), JsError> {
        Err(JsError::Error(
            "an app cannot restart itself here: the package runs from the app's next start".into(),
        )
        .with_code(codes::UNAVAILABLE))
    }

    #[cfg(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    ))]
    pub(super) async fn install(sys: System) -> Result<(), JsError> {
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let pending = pending(&sys)?;
        let archive = pending.archive.borrow().clone().ok_or_else(|| {
            JsError::Error("nothing is downloaded: call downloadUpdate first".into())
        })?;
        let installation = pending.installation.clone();
        // Installed now instead of as the app quits (`installOnQuit`).
        crate::restart::set_at_exit(None);
        // The restart starts the app at the path the user knows: once the
        // directory or `.app` is swapped, this process' executable is the
        // old one, moved aside and deleted.
        crate::restart::remember_program();
        let program = blocking(move || {
            let program = installation.install(&archive).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&archive);
            Ok(program)
        })
        .await?;
        // The update may have renamed the executable or its `.app`.
        crate::restart::set_program(program);
        // As `Application.restart()`: the app quits as the user's quit does
        // (storage written, windows closed), and the new version starts
        // once this process has exited (`crate::restart`).
        crate::element::desktop::restart();
        std::future::pending().await
    }

    #[cfg(not(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    )))]
    pub(super) async fn install(_: System) -> Result<(), JsError> {
        Err(unavailable())
    }

    #[cfg(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    ))]
    pub(super) async fn install_on_quit(sys: System) -> Result<(), JsError> {
        let found = sys.locals.get::<Found>();
        let _operation = begin(&found)?;
        let pending = pending(&sys)?;
        let archive = pending.archive.borrow().clone().ok_or_else(|| {
            JsError::Error("nothing is downloaded: call downloadUpdate first".into())
        })?;
        let installation = pending.installation.clone();
        // What waited before goes first: it is staged in the same place.
        crate::restart::set_at_exit(None);
        let staged = blocking({
            let archive = archive.clone();
            move || installation.stage(&archive).map_err(|e| e.to_string())
        })
        .await?;
        let version = pending.available.version.clone();
        crate::restart::set_at_exit(Some(Box::new(move || {
            // A restart after the swap starts the app at the path the
            // user knows, as `install` has it.
            crate::restart::remember_program();
            match staged.finish() {
                Ok(program) => {
                    // The update may have renamed the executable or its `.app`.
                    crate::restart::set_program(program);
                    log::info!("installed version {version} as the app quit")
                }
                Err(e) => log::error!("cannot install version {version} as the app quits: {e}"),
            }
            let _ = std::fs::remove_file(&archive);
        })));
        Ok(())
    }

    #[cfg(not(any(
        all(target_os = "linux", not(target_env = "ohos")),
        target_os = "macos",
        windows
    )))]
    pub(super) async fn install_on_quit(_: System) -> Result<(), JsError> {
        Err(unavailable())
    }
    /// Whether the package this run's code came from is already the
    /// release `offered` or a later one. The app's own version is the one it
    /// shipped as, so a run on a package of the latest release still sees the
    /// release as newer: its code is current and only the shell is behind
    /// (`AppUpdate::shell`).
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

        /// A package of version 1.0.0 whose `"updater"` has a default
        /// source and a `beta` channel, each serving a signed manifest; it
        /// records the URLs asked for.
        struct Channels(std::sync::Mutex<Vec<String>>);

        const SECRET: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";
        const PUBLIC: &str = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w=";
        const STABLE: &str = "https://x.dev/latest.json";
        const BETA: &str = "https://x.dev/beta/latest.json";

        fn served(version: &str) -> Vec<u8> {
            format!(
                r#"{{"id":"dev.noop.app","version":"{version}","platforms":{{"{}":{{"url":"a.tar.gz","sha256":"ab","size":2}}}}}}"#,
                nsh_updater::platform()
            )
            .into_bytes()
        }

        const ZH_TW: &str = "https://x.dev/beta/notes.zh-TW.md";
        const JA: &str = "https://x.dev/beta/notes.ja.md";

        /// The beta manifest: notes, and in zh-TW and ja beside it (ja's
        /// file does not match its hash).
        fn beta() -> Vec<u8> {
            let mut manifest: serde_json::Value =
                serde_json::from_slice(&served("1.1.0-beta.1")).unwrap();
            manifest["notes"] = "Fixes".into();
            manifest["localizedNotes"] = serde_json::json!({
                "zh-TW": { "url": "notes.zh-TW.md", "sha256": nsh_updater::sha256("修復".as_bytes()) },
                "ja": { "url": "notes.ja.md", "sha256": nsh_updater::sha256("修正".as_bytes()) },
            });
            serde_json::to_vec(&manifest).unwrap()
        }

        impl UpdaterHost for Channels {
            fn config(&self) -> Option<Vec<u8>> {
                Some(
                    format!(
                        r#"{{"id":"dev.noop.app","version":"1.0.0","url":"{STABLE}","channels":{{"beta":"{BETA}"}},"publicKey":"{PUBLIC}"}}"#
                    )
                    .into_bytes(),
                )
            }

            fn get(&self, url: &str, _: u64, sink: UpdaterSink<'_>) -> Result<(), String> {
                self.0.lock().unwrap().push(url.to_owned());
                let manifest = match url.strip_suffix(".sig").unwrap_or(url) {
                    STABLE => served("1.0.0"),
                    BETA => beta(),
                    ZH_TW => return sink(0, "修復".as_bytes(), None),
                    JA => return sink(0, b"tampered", None),
                    _ => return Err("not found".into()),
                };
                let body = if url.ends_with(".sig") {
                    nsh_updater::sign(SECRET, &manifest).unwrap().into_bytes()
                } else {
                    manifest
                };
                sink(0, &body, Some(body.len() as u64))
            }
        }

        #[test]
        fn a_check_reads_the_channel_the_package_declares() {
            let host = Arc::new(Channels(Default::default()));
            let sys = System::default().with_updater(Some(host.clone()));
            let checked = |channel: Option<&str>| {
                tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(check(sys.clone(), channel.map(str::to_owned), None))
            };
            // The default source has nothing newer; the beta channel has.
            assert!(checked(None).unwrap().is_none());
            let update = checked(Some("beta")).unwrap().unwrap();
            assert_eq!(update.version, "1.1.0-beta.1");
            assert_eq!(update.url, "https://x.dev/beta/a.tar.gz");
            assert_eq!(
                *host.0.lock().unwrap(),
                [
                    STABLE.to_owned(),
                    format!("{STABLE}.sig"),
                    BETA.to_owned(),
                    format!("{BETA}.sig"),
                ]
            );
            // A name the package does not declare reaches no host.
            host.0.lock().unwrap().clear();
            assert!(checked(Some("nightly")).is_err());
            assert!(checked(Some("https://evil.dev/latest.json")).is_err());
            assert!(host.0.lock().unwrap().is_empty());
        }

        #[test]
        fn a_check_downloads_only_the_notes_of_its_locale() {
            let host = Arc::new(Channels(Default::default()));
            let sys = System::default().with_updater(Some(host.clone()));
            let notes = |locale: Option<&str>| {
                host.0.lock().unwrap().clear();
                let update = tokio::runtime::Builder::new_current_thread()
                    .build()
                    .unwrap()
                    .block_on(check(
                        sys.clone(),
                        Some("beta".into()),
                        locale.map(str::to_owned),
                    ))
                    .unwrap()
                    .unwrap();
                let fetched = host.0.lock().unwrap().len();
                (update.notes.unwrap(), fetched)
            };
            assert_eq!(notes(None), ("Fixes".to_owned(), 2));
            assert_eq!(notes(Some("zh-TW")), ("修復".to_owned(), 3));
            // No file for it, or one that fails its hash: the default notes.
            assert_eq!(notes(Some("de")), ("Fixes".to_owned(), 2));
            assert_eq!(notes(Some("ja")), ("Fixes".to_owned(), 3));
        }

        /// Nothing waits to install when no check found an update the app
        /// can install, and the rejection says so.
        #[test]
        fn install_on_quit_needs_a_downloaded_update() {
            let sys = System::default().with_updater(Some(Arc::new(Channels(Default::default()))));
            let error = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(install_on_quit(sys))
                .unwrap_err();
            assert_eq!(error.code(), Some(codes::UNAVAILABLE));
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

        struct TempDir(PathBuf);

        impl TempDir {
            fn new(name: &str) -> Self {
                static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
                let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let dir = std::env::temp_dir().join(format!(
                    "nsh-core-updater-{name}-{}-{n}",
                    std::process::id()
                ));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).unwrap();
                Self(dir)
            }

            fn path(&self) -> &std::path::Path {
                &self.0
            }
        }

        impl Drop for TempDir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        /// Scripted `UpdaterHost` for testing range resume, fallback, 416,
        /// server-capped slices and OTA package verification.
        struct ScriptedHost {
            payload: Vec<u8>,
            /// Each payload `get` pops one scripted action from the front.
            script: std::sync::Mutex<std::collections::VecDeque<ScriptedResponse>>,
            /// Byte offsets requested in order.
            offsets: std::sync::Mutex<Vec<u64>>,
            /// Optional package manifest + verify result for `download_package`.
            package_config: Option<Vec<u8>>,
            package_manifest: Option<Vec<u8>>,
            verify_error: Option<String>,
            verify_calls: std::sync::atomic::AtomicUsize,
            /// Every URL asked for, in order.
            urls: std::sync::Mutex<Vec<String>>,
        }

        enum ScriptedResponse {
            /// Send `bytes` from `from` (or `0` when `from == 0`), then fail with `err`.
            DropAfter { bytes: usize, err: &'static str },
            /// Honor `Range` (`206` when `from > 0`, `200` when `from == 0`) for the rest of `payload`.
            Complete,
            /// Honor `Range` (`206`) for at most `max_bytes` from `from` (server-capped slice).
            CappedSlice(usize),
            /// Ignore `Range` and send full `payload` as `200 OK`.
            IgnoreRangeFull,
            /// Reply `416 Range Not Satisfiable`.
            Unsatisfiable,
            /// Fail immediately before sending headers.
            ImmediateErr(&'static str),
        }

        impl ScriptedHost {
            fn new(payload: &[u8], script: impl IntoIterator<Item = ScriptedResponse>) -> Self {
                Self {
                    payload: payload.to_vec(),
                    script: std::sync::Mutex::new(script.into_iter().collect()),
                    offsets: std::sync::Mutex::new(Vec::new()),
                    package_config: None,
                    package_manifest: None,
                    verify_error: None,
                    verify_calls: std::sync::atomic::AtomicUsize::new(0),
                    urls: std::sync::Mutex::new(Vec::new()),
                }
            }

            fn offsets(&self) -> Vec<u64> {
                self.offsets.lock().unwrap().clone()
            }
        }

        impl UpdaterHost for ScriptedHost {
            fn config(&self) -> Option<Vec<u8>> {
                self.package_config.clone()
            }

            fn get(&self, url: &str, from: u64, sink: UpdaterSink<'_>) -> Result<(), String> {
                self.urls.lock().unwrap().push(url.to_owned());
                if let Some(manifest) = &self.package_manifest
                    && !url.ends_with(".nshpkg")
                {
                    if url.ends_with(".sig") {
                        let sig = nsh_updater::sign(SECRET, manifest).unwrap();
                        return sink(0, sig.as_bytes(), Some(sig.len() as u64));
                    }
                    return sink(0, manifest, Some(manifest.len() as u64));
                }
                self.offsets.lock().unwrap().push(from);
                let action = self
                    .script
                    .lock()
                    .unwrap()
                    .pop_front()
                    .expect("scripted response");
                let total = Some(self.payload.len() as u64);
                let start = from as usize;
                match action {
                    ScriptedResponse::DropAfter { bytes, err } => {
                        let end = (start + bytes).min(self.payload.len());
                        if start < end {
                            sink(from, &self.payload[start..end], total)?;
                        }
                        Err(err.to_owned())
                    }
                    ScriptedResponse::Complete => sink(from, &self.payload[start..], total),
                    ScriptedResponse::CappedSlice(max_bytes) => {
                        let end = (start + max_bytes).min(self.payload.len());
                        sink(from, &self.payload[start..end], total)
                    }
                    ScriptedResponse::IgnoreRangeFull => sink(0, &self.payload, total),
                    ScriptedResponse::Unsatisfiable => Ok(()),
                    ScriptedResponse::ImmediateErr(err) => Err(err.to_owned()),
                }
            }

            fn verify_package(
                &self,
                _file: &std::path::Path,
                _updates: &std::path::Path,
                _app_id: &str,
                _roots: &[String],
                _newer_than: u64,
            ) -> Result<PackageVersion, String> {
                self.verify_calls
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                if let Some(err) = &self.verify_error {
                    return Err(err.clone());
                }
                Ok(PackageVersion {
                    version: "1.0.1".into(),
                    build: 2,
                })
            }
        }

        const NO_WAIT: RetryPolicy = RetryPolicy {
            attempts: 2,
            backoff: std::time::Duration::ZERO,
        };

        #[test]
        fn transient_failures_retry_from_the_partial_file() {
            let dir = TempDir::new("retry");
            let payload = b"0123456789abcdef";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join("retry.part");
            let dest = dir.path().join("retry");
            // Each pass makes progress, so the budget of 2 resets each time.
            let host = ScriptedHost::new(
                payload,
                [
                    ScriptedResponse::DropAfter {
                        bytes: 4,
                        err: "connection reset",
                    },
                    ScriptedResponse::DropAfter {
                        bytes: 4,
                        err: "download stalled",
                    },
                    ScriptedResponse::ImmediateErr("HTTP 503"),
                    ScriptedResponse::DropAfter {
                        bytes: 4,
                        err: "truncated response",
                    },
                    ScriptedResponse::Complete,
                ],
            );
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };
            download_with_retry(&target, NO_WAIT, |_, _| true, |_| Ok(())).unwrap();
            assert_eq!(std::fs::read(&dest).unwrap(), payload);
            assert_eq!(host.offsets(), [0, 4, 8, 8, 12]);
        }

        #[test]
        fn retry_gives_up_without_progress_and_keeps_the_part() {
            let dir = TempDir::new("retry-give-up");
            let payload = b"0123456789abcdef";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join("retry.part");
            let dest = dir.path().join("retry");
            let host = ScriptedHost::new(
                payload,
                [
                    ScriptedResponse::DropAfter {
                        bytes: 5,
                        err: "connection reset",
                    },
                    ScriptedResponse::ImmediateErr("connection refused"),
                    ScriptedResponse::ImmediateErr("connection refused"),
                ],
            );
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };
            let err = download_with_retry(&target, NO_WAIT, |_, _| true, |_| Ok(())).unwrap_err();
            assert_eq!(err, "connection refused");
            // One pass with progress, then two retries without any.
            assert_eq!(host.offsets(), [0, 5, 5]);
            assert_eq!(std::fs::read(&part).unwrap(), &payload[..5]);
        }

        #[test]
        fn retry_skips_client_errors_and_cancellation() {
            let dir = TempDir::new("retry-fatal");
            let payload = b"0123456789abcdef";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join("retry.part");
            let dest = dir.path().join("retry");
            let host = ScriptedHost::new(
                payload,
                [
                    ScriptedResponse::ImmediateErr("HTTP 404"),
                    ScriptedResponse::Complete,
                ],
            );
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };
            let err = download_with_retry(&target, NO_WAIT, |_, _| true, |_| Ok(())).unwrap_err();
            assert_eq!(err, "HTTP 404");
            let err = download_with_retry(&target, NO_WAIT, |_, _| false, |_| Ok(())).unwrap_err();
            assert_eq!(err, "download cancelled");
            assert_eq!(host.offsets(), [0, 0]);
        }

        #[test]
        fn interrupted_download_resumes_from_partial_file() {
            let dir = TempDir::new("resume");
            let payload = b"0123456789abcdef";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join(format!("download-{sha256}.part"));
            let dest = dir.path().join(format!("download-{sha256}"));
            let host = ScriptedHost::new(
                payload,
                [
                    ScriptedResponse::DropAfter {
                        bytes: 6,
                        err: "connection reset",
                    },
                    ScriptedResponse::DropAfter {
                        bytes: 5,
                        err: "timed out",
                    },
                    ScriptedResponse::Complete,
                ],
            );
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };

            // First interruption keeps the 6 bytes received.
            let err = download_resumable(&target, |_, _| true, |_| Ok(())).unwrap_err();
            assert!(err.contains("connection reset"), "{err}");
            assert_eq!(std::fs::read(&part).unwrap(), &payload[..6]);
            assert!(!dest.exists());

            // Second interruption appends 5 more bytes and keeps 11 bytes.
            let mut progress = Vec::new();
            let err = download_resumable(
                &target,
                |r, t| {
                    progress.push((r, t));
                    true
                },
                |_| Ok(()),
            )
            .unwrap_err();
            assert!(err.contains("timed out"), "{err}");
            assert_eq!(std::fs::read(&part).unwrap(), &payload[..11]);
            assert_eq!(progress, [(6, Some(16)), (11, Some(16))]);

            // Third attempt finishes from byte 11 and atomically moves into `dest`.
            progress.clear();
            download_resumable(
                &target,
                |r, t| {
                    progress.push((r, t));
                    true
                },
                |_| Ok(()),
            )
            .unwrap();
            assert_eq!(host.offsets(), [0, 6, 11]);
            assert_eq!(progress, [(11, Some(16)), (16, Some(16))]);
            assert!(!part.exists());
            assert_eq!(std::fs::read(&dest).unwrap(), payload);
        }

        #[test]
        fn downloads_resume_from_existing_bytes() {
            let full = b"hello resumable world";
            let hash = nsh_updater::sha256(full);
            let size = Some(full.len() as u64);

            // Partial prefix + appended tail verifies identically to a single pass.
            let mut cursor = std::io::Cursor::new(&full[..6]);
            let mut resumed = Download::resume(&hash, size, &mut cursor).unwrap();
            assert_eq!(resumed.received(), 6);
            assert_eq!(resumed.update(&full[6..]).unwrap(), full.len() as u64);
            assert_eq!(resumed.received(), full.len() as u64);
            assert!(resumed.finish().is_ok());

            // An empty partial starts at 0.
            let mut empty = std::io::Cursor::new(&b""[..]);
            let mut fresh = Download::resume(&hash, size, &mut empty).unwrap();
            assert_eq!(fresh.received(), 0);
            fresh.update(full).unwrap();
            assert!(fresh.finish().is_ok());

            // A partial already holding all bytes finishes immediately.
            let mut complete = std::io::Cursor::new(&full[..]);
            let done = Download::resume(&hash, size, &mut complete).unwrap();
            assert_eq!(done.received(), full.len() as u64);
            assert!(done.finish().is_ok());

            // A partial larger than the manifest size is refused before any range request.
            let mut oversized = std::io::Cursor::new(b"hello resumable world!");
            assert!(Download::resume(&hash, size, &mut oversized).is_err());

            // A corrupted partial prefix fails verification once the tail arrives.
            let mut corrupt = std::io::Cursor::new(b"Hxllo ");
            let mut bad = Download::resume(&hash, size, &mut corrupt).unwrap();
            bad.update(&full[6..]).unwrap();
            assert!(bad.finish().is_err());
        }

        #[test]
        fn a_second_download_of_the_same_asset_is_refused() {
            let dir = TempDir::new("part-lock");
            let part = dir.path().join("download-abc.part");
            let held = lock_part(&part).unwrap();
            let err = lock_part(&part).unwrap_err();
            assert!(err.contains("in progress"), "{err}");
            drop(held);
            lock_part(&part).unwrap();
        }

        #[test]
        fn resume_falls_back_when_server_ignores_range() {
            let dir = TempDir::new("ignore-range");
            let payload = b"abcdefghijkl";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join(format!("download-{sha256}.part"));
            let dest = dir.path().join(format!("download-{sha256}"));
            std::fs::write(&part, &payload[..5]).unwrap();

            let host = ScriptedHost::new(payload, [ScriptedResponse::IgnoreRangeFull]);
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };
            let mut progress = Vec::new();
            download_resumable(
                &target,
                |r, t| {
                    progress.push((r, t));
                    true
                },
                |_| Ok(()),
            )
            .unwrap();

            assert_eq!(host.offsets(), [5]);
            // Progress never jumped to 5 before resetting to 0.
            assert_eq!(progress, [(12, Some(12))]);
            assert!(!part.exists());
            assert_eq!(std::fs::read(&dest).unwrap(), payload);
        }

        #[test]
        fn resume_recovers_from_corrupt_partial_file() {
            let dir = TempDir::new("corrupt-part");
            let payload = b"0123456789";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join(format!("download-{sha256}.part"));
            let dest = dir.path().join(format!("download-{sha256}"));
            std::fs::write(&part, b"XXXXX").unwrap();

            let host = ScriptedHost::new(
                payload,
                [ScriptedResponse::Complete, ScriptedResponse::Complete],
            );
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };
            download_resumable(&target, |_, _| true, |_| Ok(())).unwrap();
            // First tried resuming from 5, saw SHA-256 mismatch, deleted part, restarted from 0.
            assert_eq!(host.offsets(), [5, 0]);
            assert!(!part.exists());
            assert_eq!(std::fs::read(&dest).unwrap(), payload);
        }

        #[test]
        fn resume_handles_416_for_complete_and_stale_partials() {
            let dir = TempDir::new("416");
            let payload = b"already-complete";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join(format!("download-{sha256}.part"));
            let dest = dir.path().join(format!("download-{sha256}"));

            // Manifest omits `size`, partial is already complete: 416 verifies and finishes.
            std::fs::write(&part, payload).unwrap();
            let host = ScriptedHost::new(payload, [ScriptedResponse::Unsatisfiable]);
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: None,
            };
            download_resumable(&target, |_, _| true, |_| Ok(())).unwrap();
            assert_eq!(host.offsets(), [payload.len() as u64]);
            assert!(!part.exists());
            assert_eq!(std::fs::read(&dest).unwrap(), payload);

            // Corrupt/oversized partial + 416: deletes part and retries once from 0.
            std::fs::remove_file(&dest).unwrap();
            std::fs::write(&part, b"stale-oversized-bytes-on-disk").unwrap();
            let host = ScriptedHost::new(
                payload,
                [ScriptedResponse::Unsatisfiable, ScriptedResponse::Complete],
            );
            let target = DownloadTarget {
                host: &host,
                ..target
            };
            download_resumable(&target, |_, _| true, |_| Ok(())).unwrap();
            assert_eq!(host.offsets(), [29, 0]);
            assert!(!part.exists());
            assert_eq!(std::fs::read(&dest).unwrap(), payload);
        }

        #[test]
        fn resume_reuses_already_complete_part_or_dest_without_network() {
            let dir = TempDir::new("reuse-complete");
            let payload = b"cached-archive";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join(format!("download-{sha256}.part"));
            let dest = dir.path().join(format!("download-{sha256}"));

            // Complete `.part` with known `size` needs zero HTTP requests.
            std::fs::write(&part, payload).unwrap();
            let host = ScriptedHost::new(payload, []);
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };
            download_resumable(&target, |_, _| true, |_| Ok(())).unwrap();
            assert!(host.offsets().is_empty());
            assert!(!part.exists());
            assert_eq!(std::fs::read(&dest).unwrap(), payload);

            // Calling again with `dest` already verified also needs zero HTTP requests.
            download_resumable(&target, |_, _| true, |_| Ok(())).unwrap();
            assert!(host.offsets().is_empty());
        }

        #[test]
        fn resume_continues_across_server_capped_206_slices() {
            let dir = TempDir::new("capped-206");
            let payload = b"0123456789abcdef";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join(format!("download-{sha256}.part"));
            let dest = dir.path().join(format!("download-{sha256}"));
            std::fs::write(&part, &payload[..4]).unwrap();

            let host = ScriptedHost::new(
                payload,
                [
                    ScriptedResponse::CappedSlice(4),
                    ScriptedResponse::CappedSlice(4),
                    ScriptedResponse::CappedSlice(4),
                ],
            );
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };
            download_resumable(&target, |_, _| true, |_| Ok(())).unwrap();
            assert_eq!(host.offsets(), [4, 8, 12]);
            assert_eq!(std::fs::read(&dest).unwrap(), payload);
        }

        #[test]
        fn stale_partials_are_cleaned_without_touching_other_update_files() {
            let dir = TempDir::new("cleanup");
            std::fs::write(dir.path().join("download-old.part"), b"old").unwrap();
            std::fs::write(dir.path().join("download-old.part.lock"), b"").unwrap();
            std::fs::write(dir.path().join("download-old"), b"old-done").unwrap();
            std::fs::write(dir.path().join("download-keep.part"), b"keep").unwrap();
            std::fs::write(dir.path().join("download-keep.part.lock"), b"").unwrap();
            std::fs::write(dir.path().join("next.nshpkg"), b"pkg").unwrap();
            std::fs::write(dir.path().join("next.nshpkg.part"), b"legacy").unwrap();
            std::fs::write(dir.path().join("next-old.nshpkg.part"), b"old-pkg").unwrap();
            std::fs::write(dir.path().join("next-old.nshpkg.part.lock"), b"").unwrap();
            std::fs::write(dir.path().join("next-keep.nshpkg.part"), b"keep-pkg").unwrap();
            std::fs::write(dir.path().join("next-keep.nshpkg.part.lock"), b"").unwrap();

            cleanup_stale_downloads(dir.path(), "download-keep.part", "download-keep");
            assert!(!dir.path().join("download-old.part").exists());
            assert!(!dir.path().join("download-old.part.lock").exists());
            assert!(!dir.path().join("download-old").exists());
            assert!(dir.path().join("download-keep.part").exists());
            assert!(dir.path().join("download-keep.part.lock").exists());
            assert!(dir.path().join("next.nshpkg").exists());
            assert!(dir.path().join("next-keep.nshpkg.part").exists());

            cleanup_stale_package_parts(dir.path(), "next-keep.nshpkg.part");
            assert!(!dir.path().join("next.nshpkg.part").exists());
            assert!(!dir.path().join("next-old.nshpkg.part").exists());
            assert!(!dir.path().join("next-old.nshpkg.part.lock").exists());
            assert!(dir.path().join("next-keep.nshpkg.part").exists());
            assert!(dir.path().join("next-keep.nshpkg.part.lock").exists());
            assert!(dir.path().join("next.nshpkg").exists());

            // Unusual hashes never produce path separators or escape `dir`.
            let key = part_key("../../etc/passwd");
            assert!(!key.contains('/') && !key.contains('.'));
            assert_eq!(key.len(), 64);
        }

        #[test]
        fn resume_ignores_empty_chunks_and_rejects_misaligned_offsets() {
            enum Mode {
                EmptyFullThenFail,
                MisalignedSecondChunk,
                EmptyPartialThenFinish,
            }

            struct ChunkHost {
                payload: Vec<u8>,
                modes: std::sync::Mutex<std::collections::VecDeque<Mode>>,
            }

            impl UpdaterHost for ChunkHost {
                fn config(&self) -> Option<Vec<u8>> {
                    None
                }

                fn get(&self, _url: &str, from: u64, sink: UpdaterSink<'_>) -> Result<(), String> {
                    let total = Some(self.payload.len() as u64);
                    let start = from as usize;
                    match self.modes.lock().unwrap().pop_front().unwrap() {
                        Mode::EmptyFullThenFail => {
                            sink(0, b"", total)?;
                            Err("connection reset".into())
                        }
                        Mode::MisalignedSecondChunk => {
                            sink(from, &self.payload[start..start + 2], total)?;
                            sink(from, &self.payload[start + 2..], total)
                        }
                        Mode::EmptyPartialThenFinish => {
                            sink(from, b"", total)?;
                            sink(from, &self.payload[start..], total)
                        }
                    }
                }
            }

            let dir = TempDir::new("chunk-offsets");
            let payload = b"0123456789";
            let sha256 = nsh_updater::sha256(payload);
            let part = dir.path().join(format!("download-{sha256}.part"));
            let dest = dir.path().join(format!("download-{sha256}"));
            std::fs::write(&part, &payload[..4]).unwrap();

            let host = ChunkHost {
                payload: payload.to_vec(),
                modes: std::sync::Mutex::new(
                    [
                        Mode::EmptyFullThenFail,
                        Mode::MisalignedSecondChunk,
                        Mode::EmptyPartialThenFinish,
                    ]
                    .into_iter()
                    .collect(),
                ),
            };
            let target = DownloadTarget {
                host: &host,
                url: "https://x.dev/app.tar.gz",
                part: &part,
                dest: &dest,
                remove_invalid_dest: true,
                sha256: &sha256,
                size: Some(payload.len() as u64),
            };

            let err = download_resumable(&target, |_, _| true, |_| Ok(())).unwrap_err();
            assert!(err.contains("connection reset"), "{err}");
            assert_eq!(std::fs::read(&part).unwrap(), &payload[..4]);

            let err = download_resumable(&target, |_, _| true, |_| Ok(())).unwrap_err();
            assert!(err.contains("expected 6"), "{err}");
            assert_eq!(std::fs::read(&part).unwrap(), &payload[..6]);

            let mut progress = Vec::new();
            download_resumable(
                &target,
                |r, t| {
                    progress.push((r, t));
                    true
                },
                |_| Ok(()),
            )
            .unwrap();
            assert_eq!(progress, [(6, Some(10)), (10, Some(10))]);
            assert_eq!(std::fs::read(&dest).unwrap(), payload);
        }

        #[test]
        fn a_package_check_reads_the_feed_the_app_names_when_it_opts_in() {
            let payload = b"signed-nshpkg-bytes";
            let manifest = serde_json::to_vec(&serde_json::json!({
                "id": "dev.noop.app",
                "version": "1.0.1",
                "package": {
                    "version": "1.0.1", "build": 2, "url": "app-2.nshpkg",
                    "sha256": nsh_updater::sha256(payload), "size": payload.len(),
                    "minRuntime": "0.1.0",
                },
            }))
            .unwrap();
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            let dir = TempDir::new("package-feed");
            let host = |config: String| {
                let mut host = ScriptedHost::new(payload, [ScriptedResponse::Complete]);
                host.package_config = Some(config.into_bytes());
                host.package_manifest = Some(manifest.clone());
                let host = Arc::new(host);
                let mut sys = System::default().with_updater(Some(host.clone()));
                sys.data_dir = Some(dir.path().to_path_buf());
                (host, sys)
            };
            let feed = "http://10.0.0.2:8080/updates/latest.json";
            let check_feed = |sys: &System, url: Option<&str>| {
                rt.block_on(check_package(sys.clone(), None, url.map(str::to_owned)))
            };

            // A runtime feed: no source of its own, plain HTTP opted into.
            let (runtime, sys) = host(format!(
                r#"{{"id":"dev.noop.app","version":"1.0.0","build":1,"publicKey":"{PUBLIC}","packages":{{"roots":["{PUBLIC}"],"source":"runtime","allowHttp":true}}}}"#
            ));
            let err = check_feed(&sys, None).unwrap_err();
            assert!(format!("{err:?}").contains("pass `url`"), "{err:?}");
            let err = rt.block_on(check(sys.clone(), None, None)).unwrap_err();
            assert!(format!("{err:?}").contains("no update source"), "{err:?}");
            assert!(runtime.urls.lock().unwrap().is_empty());
            assert_eq!(check_feed(&sys, Some(feed)).unwrap().unwrap().build, 2.0);
            rt.block_on(download_package(sys.clone(), None)).unwrap();
            assert_eq!(
                *runtime.urls.lock().unwrap(),
                [
                    feed.to_owned(),
                    format!("{feed}.sig"),
                    "http://10.0.0.2:8080/updates/app-2.nshpkg".to_owned(),
                ]
            );
            // Another feed's plain-HTTP origin is refused before any request.
            runtime.urls.lock().unwrap().clear();
            assert!(check_feed(&sys, Some("ftp://10.0.0.2/latest.json")).is_err());
            assert!(runtime.urls.lock().unwrap().is_empty());

            // An app whose nsh.json names the source: its code cannot.
            let (fixed, sys) = host(format!(
                r#"{{"id":"dev.noop.app","version":"1.0.0","build":1,"url":"{STABLE}","publicKey":"{PUBLIC}","packages":{{"roots":["{PUBLIC}"]}}}}"#
            ));
            let err = check_feed(&sys, Some("https://evil.dev/latest.json")).unwrap_err();
            assert!(format!("{err:?}").contains("source"), "{err:?}");
            assert!(fixed.urls.lock().unwrap().is_empty());
        }

        #[test]
        fn download_package_resumes_and_cleans_up_refused_packages() {
            let dir = TempDir::new("package-resume");
            let payload = b"signed-nshpkg-bytes";
            let sha256 = nsh_updater::sha256(payload);
            let config = format!(
                r#"{{"id":"dev.noop.app","version":"1.0.0","build":1,"url":"{STABLE}","publicKey":"{PUBLIC}","packages":{{"roots":["{PUBLIC}"]}}}}"#
            )
            .into_bytes();
            let manifest = serde_json::to_vec(&serde_json::json!({
                "id": "dev.noop.app",
                "version": "1.0.1",
                "platforms": {},
                "package": {
                    "version": "1.0.1",
                    "build": 2,
                    "url": "app-2.nshpkg",
                    "sha256": sha256,
                    "size": payload.len(),
                    "minRuntime": "0.1.0",
                },
            }))
            .unwrap();

            // Pre-existing older `next.nshpkg` must survive an interrupted newer download.
            let updates = dir.path().join(UPDATES);
            std::fs::create_dir_all(&updates).unwrap();
            std::fs::write(updates.join(NEXT), b"older-build").unwrap();

            let mut host = ScriptedHost::new(
                payload,
                [
                    ScriptedResponse::DropAfter {
                        bytes: 7,
                        err: "network lost",
                    },
                    ScriptedResponse::ImmediateErr("HTTP 404"),
                    ScriptedResponse::Complete,
                ],
            );
            host.package_config = Some(config.clone());
            host.package_manifest = Some(manifest.clone());
            let host = Arc::new(host);

            let mut sys = System::default().with_updater(Some(host.clone()));
            sys.data_dir = Some(dir.path().to_path_buf());
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();

            let offered = rt
                .block_on(check_package(sys.clone(), None, None))
                .unwrap()
                .unwrap();
            assert_eq!(offered.build, 2.0);

            // Attempt 1 drops after 7 bytes, retries on its own and stops
            // at a `404`: part stays at 7 bytes, older `next.nshpkg` stays.
            let err = rt
                .block_on(download_package(sys.clone(), None))
                .unwrap_err();
            assert!(format!("{err:?}").contains("HTTP 404"), "{err:?}");
            let part = updates.join(format!("next-{sha256}.nshpkg.part"));
            assert_eq!(std::fs::read(&part).unwrap(), &payload[..7]);
            assert_eq!(std::fs::read(updates.join(NEXT)).unwrap(), b"older-build");

            // Attempt 2 resumes from byte 7, verifies, and atomically replaces `next.nshpkg`.
            rt.block_on(download_package(sys.clone(), None)).unwrap();
            assert_eq!(host.offsets(), [0, 7, 7]);
            assert!(!part.exists());
            assert_eq!(std::fs::read(updates.join(NEXT)).unwrap(), payload);

            // A package refused by `verify_package` removes the part and does not re-download.
            let dir2 = TempDir::new("package-refused");
            let mut bad_host = ScriptedHost::new(payload, [ScriptedResponse::Complete]);
            bad_host.package_config = Some(config);
            bad_host.package_manifest = Some(manifest);
            bad_host.verify_error = Some("not trusted".into());
            let bad_host = Arc::new(bad_host);
            let mut sys2 = System::default().with_updater(Some(bad_host.clone()));
            sys2.data_dir = Some(dir2.path().to_path_buf());
            rt.block_on(check_package(sys2.clone(), None, None))
                .unwrap()
                .unwrap();
            let err = rt.block_on(download_package(sys2, None)).unwrap_err();
            assert!(format!("{err:?}").contains("not trusted"), "{err:?}");
            assert_eq!(bad_host.offsets(), [0]);
            assert_eq!(
                bad_host
                    .verify_calls
                    .load(std::sync::atomic::Ordering::Relaxed),
                1
            );
            assert!(
                !dir2
                    .path()
                    .join(UPDATES)
                    .join(format!("next-{sha256}.nshpkg.part"))
                    .exists()
            );
            assert!(!dir2.path().join(UPDATES).join(NEXT).exists());
        }
    }
}

/// Nothing updates on the web (a deploy updates its apps), nor in a build
/// without the `updater` feature.
#[cfg(any(target_arch = "wasm32", not(feature = "updater")))]
mod native {
    use super::*;

    /// Fails when the app ships an update configuration a native runtime
    /// without the feature cannot act on: saying so beats reporting "no
    /// update" forever. Without one (a development run, an app without
    /// `"updater"`) there is nothing to check, as with the feature.
    #[cfg(not(target_arch = "wasm32"))]
    async fn configured(sys: &System) -> Result<(), JsError> {
        let Some(host) = sys.updater.clone() else {
            return Ok(());
        };
        if super::super::fs::blocking(move || Ok(host.config().is_some())).await? {
            return Err(JsError::Error(
                "this runtime was built without the NSH platform crate's feature `updater`".into(),
            )
            .with_code(codes::UNAVAILABLE));
        }
        Ok(())
    }

    #[cfg(target_arch = "wasm32")]
    async fn configured(_: &System) -> Result<(), JsError> {
        Ok(())
    }

    pub(super) async fn check(
        sys: System,
        _: Option<String>,
        _: Option<String>,
    ) -> Result<Option<AppUpdate>, JsError> {
        configured(&sys).await?;
        Ok(None)
    }

    pub(super) async fn shipped(_: &System) -> (Option<String>, Option<String>) {
        (None, None)
    }

    pub(super) async fn download(
        _: System,
        _: Option<Box<dyn Fn(UpdateProgress)>>,
    ) -> Result<(), JsError> {
        Err(unavailable())
    }

    pub(super) async fn install(_: System) -> Result<(), JsError> {
        Err(unavailable())
    }

    pub(super) async fn install_on_quit(_: System) -> Result<(), JsError> {
        Err(unavailable())
    }

    pub(super) async fn check_package(
        sys: System,
        _: Option<String>,
        _: Option<String>,
    ) -> Result<Option<PackageUpdate>, JsError> {
        configured(&sys).await?;
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

    #[cfg(all(test, not(target_arch = "wasm32")))]
    mod tests {
        use std::sync::Arc;

        use super::*;

        struct Host(Option<&'static str>);

        impl UpdaterHost for Host {
            fn config(&self) -> Option<Vec<u8>> {
                self.0.map(|config| config.as_bytes().to_vec())
            }

            fn get(&self, _: &str, _: u64, _: UpdaterSink<'_>) -> Result<(), String> {
                Err("offline".into())
            }
        }

        #[test]
        fn only_a_configured_app_learns_the_feature_is_off() {
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            let with = |host: Option<Host>| {
                System::default()
                    .with_updater(host.map(|host| Arc::new(host) as Arc<dyn UpdaterHost>))
            };
            // A development run or an app without `"updater"`: no update.
            for sys in [with(None), with(Some(Host(None)))] {
                assert!(
                    rt.block_on(check(sys.clone(), None, None))
                        .unwrap()
                        .is_none()
                );
                assert!(
                    rt.block_on(check_package(sys, None, None))
                        .unwrap()
                        .is_none()
                );
            }
            // An app that ships a configuration hears why it cannot update.
            let sys = with(Some(Host(Some("{}"))));
            let err = rt.block_on(check(sys.clone(), None, None)).unwrap_err();
            assert_eq!(err.code(), Some(codes::UNAVAILABLE));
            let err = rt.block_on(check_package(sys, None, None)).unwrap_err();
            assert_eq!(err.code(), Some(codes::UNAVAILABLE));
        }
    }
}
