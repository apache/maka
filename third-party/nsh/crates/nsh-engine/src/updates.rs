//! Over-the-air updates of a packaged app's code (`docs/dev/updater.md`,
//! "Packages"): signed packages (`.nshpkg`) the app downloaded with
//! `nsh/updater`'s `downloadPackage` run instead of the bundle it shipped
//! with, when they are newer, verify against the roots its `nsh.json`
//! trusts and proved they run.
//!
//! Everything lives in [`updates_dir`], `<data dir>/<app id>/updates/`:
//!
//! - `next.nshpkg`: downloaded and verified, never run;
//! - `trying.nshpkg`: `next.nshpkg` once a launch starts it, until it
//!   proves healthy (it then becomes `current.nshpkg`) or fails (it is
//!   deleted). Still there at a launch, the run before never proved
//!   healthy (the process crashed): it is deleted and the app goes back.
//!   A download during the trial writes `next.nshpkg` without touching it;
//! - `current.nshpkg`: the package that last proved healthy;
//! - `trust/`: the trust store's state (accepted builds, revocations);
//! - `packages/`: the running package's extracted assets.
//!
//! [`launch`] picks what a packaged app's launcher runs; any failure there
//! runs the shipped bundle. A package runs with the shipped app's id, URL
//! schemes and trusted paths, its own declared capabilities granted at most
//! what the shipped app declares, and `nsh/updater` reads the shipped
//! app's update configuration ([`Bundle::updater_config`]).
//!
//! Failures and fallbacks are warnings or errors, which packaged apps log
//! on every platform: the app's developer needs to see why a package does
//! not run. What runs and what is installed are info, which they log on
//! Android.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use nsh_package::{PackageReceipt, PublicKey, TrustStore};

use crate::{AppError, Bundle, LoadedPackage, Trial};

/// The directory of the state, in an app's own data directory.
pub const DIR: &str = "updates";
/// A downloaded package, run at the next launch.
pub const NEXT: &str = "next.nshpkg";
/// The package that proved healthy.
pub const CURRENT: &str = "current.nshpkg";
/// A package started and not yet healthy.
pub const TRYING: &str = "trying.nshpkg";
const TRUST: &str = "trust";
const PACKAGES: &str = "packages";

/// The update state of app `app_id` keeping its data in `data_dir` (the
/// directory each app has a directory of its own in, as
/// [`crate::EngineConfig::data_dir`]): `<data_dir>/<app id>/updates`.
pub fn updates_dir(data_dir: &Path, app_id: &str) -> PathBuf {
    data_dir.join(crate::app_dir_name(Some(app_id))).join(DIR)
}

/// What a packaged app's launcher runs ([`launch`]).
#[derive(Debug, Default)]
#[non_exhaustive]
pub struct Launch {
    /// The bundle to run.
    pub bundle: Bundle,
    /// Where its assets are: the package's when it runs one, else the
    /// shipped `assets` directory.
    pub assets: PathBuf,
    /// The package it runs (`None`: the shipped bundle).
    pub package: Option<nsh_package::App>,
}

/// Picks what a packaged app runs: `shipped`, the bundle in its resources
/// directory `resources` (`nsh`, holding `assets/nsh-updater.json`), or a
/// newer signed package from its updates when its `nsh.json` trusts
/// package roots (`"updater": { "packages": { "roots": [...] } }`) and
/// `data_dir` is where its engine keeps the apps' data. Never fails: any
/// problem with a package is logged and the shipped bundle runs.
pub fn launch(shipped: Bundle, resources: &Path, data_dir: Option<&Path>) -> Launch {
    let assets = resources.join("assets");
    let config = std::fs::read(assets.join(nsh_updater::CONFIG_ASSET)).ok();
    let mut shipped = shipped;
    match package_to_run(&mut shipped, config, data_dir) {
        Some(run) => Launch {
            bundle: run.bundle,
            assets: run.assets,
            package: Some(run.app),
        },
        None => Launch {
            bundle: shipped,
            assets,
            package: None,
        },
    }
}

/// A package to run instead of the shipped bundle ([`package_to_run`]).
#[derive(Debug)]
#[non_exhaustive]
pub struct PackageRun {
    /// Its bundle, as the shipped app's ([`launch`]).
    pub bundle: Bundle,
    /// Where its assets are.
    pub assets: PathBuf,
    /// Its app.
    pub app: nsh_package::App,
}

/// [`launch`] for a launcher that reads its resources itself (Android's,
/// from the APK): `config` is the shipped `nsh-updater.json`, which
/// `shipped` gets as its [`Bundle::updater_config`]. `None`: the shipped
/// bundle runs.
pub fn package_to_run(
    shipped: &mut Bundle,
    config: Option<Vec<u8>>,
    data_dir: Option<&Path>,
) -> Option<PackageRun> {
    // `nsh/updater` reads the shipped configuration, whatever runs.
    shipped.updater_config = config.map(Arc::from);
    let update = Shipped::read(
        shipped.updater_config.as_deref()?,
        shipped.app_id.as_deref(),
    )?;
    let dir = updates_dir(data_dir?, &update.app_id);
    let chosen = choose(&dir, &update)?;
    let app = chosen.loaded.app.clone();
    log::info!(
        "running package {} {} (build {}), shipped build {}",
        app.id,
        app.version,
        app.build,
        update.build
    );
    Some(PackageRun {
        assets: chosen.loaded.assets.clone(),
        bundle: as_shipped(chosen.loaded.bundle, shipped, chosen.trial),
        app,
    })
}

/// A package's bundle with what belongs to the installed app: its id
/// (checked equal), URL schemes, trusted paths and update configuration,
/// and at most the capabilities it declares.
fn as_shipped(mut bundle: Bundle, shipped: &Bundle, trial: Option<Arc<dyn Trial>>) -> Bundle {
    bundle.url_schemes = shipped.url_schemes.clone();
    bundle.system_paths = shipped.system_paths.clone();
    bundle.main_window = shipped.main_window.clone();
    bundle.updater_config = shipped.updater_config.clone();
    // The package's declaration, granted at most what the shipped app
    // declares: an update reaches nothing the installed app could not.
    bundle.policy.granted = match (&shipped.policy.granted, &shipped.policy.declared) {
        (Some(granted), _) => Some(granted.clone()),
        (None, declared) => declared.clone(),
    };
    bundle.trial = trial;
    bundle
}

/// The shipped app, as its update configuration says.
#[derive(Debug, Clone)]
struct Shipped {
    app_id: String,
    build: u64,
    roots: Vec<PublicKey>,
}

impl Shipped {
    /// `None` when the app takes no packages, or its configuration is not
    /// for the shipped bundle's app.
    fn read(config: &[u8], app_id: Option<&str>) -> Option<Shipped> {
        let config = match nsh_updater::Config::parse(config) {
            Ok(config) => config,
            Err(err) => {
                log::warn!("{}: {err}", nsh_updater::CONFIG_ASSET);
                return None;
            }
        };
        if config.package_roots().is_empty() {
            return None;
        }
        if app_id.is_some_and(|id| id != config.id) {
            log::warn!(
                "{} is for {}, the app is {app_id:?}: no packages",
                nsh_updater::CONFIG_ASSET,
                config.id
            );
            return None;
        }
        let roots = config
            .package_roots()
            .iter()
            .filter_map(|root| PublicKey::from_base64(root).ok())
            .collect();
        Some(Shipped {
            app_id: config.id,
            build: config.build.unwrap_or(1),
            roots,
        })
    }

    fn trust(&self, dir: &Path) -> Result<TrustStore, String> {
        let mut trust = TrustStore::open(dir.join(TRUST)).map_err(|e| e.to_string())?;
        for root in &self.roots {
            trust.add_root(*root);
        }
        Ok(trust)
    }
}

/// A package to run, and its trial when it has not proved healthy yet.
struct Chosen {
    loaded: LoadedPackage,
    trial: Option<Arc<dyn Trial>>,
}

/// The launch decision (module docs).
fn choose(dir: &Path, shipped: &Shipped) -> Option<Chosen> {
    let (next, trying, current) = (dir.join(NEXT), dir.join(TRYING), dir.join(CURRENT));
    if !next.exists() && !trying.exists() && !current.exists() {
        return None;
    }
    let trust = match shipped.trust(dir) {
        Ok(trust) => trust,
        Err(err) => {
            log::error!("updates: cannot open the trust store: {err}");
            return None;
        }
    };
    let packages = dir.join(PACKAGES);
    if trying.exists() {
        log::warn!(
            "updates: the package started last never ran {}s without a fatal error; it is \
             deleted and the app goes back",
            crate::TRIAL_PERIOD.as_secs()
        );
        remove(&trying);
    }
    let mut chosen = None;
    if next.exists() {
        match open(&trust, &next, &packages, shipped) {
            Ok(loaded) => match std::fs::rename(&next, &trying) {
                Ok(()) => {
                    let trial = PackageTrial {
                        dir: dir.to_owned(),
                        shipped: shipped.clone(),
                        receipt: loaded.receipt.clone(),
                        done: AtomicBool::new(false),
                        lock: Mutex::new(()),
                    };
                    chosen = Some(Chosen {
                        loaded,
                        trial: Some(Arc::new(trial)),
                    });
                }
                Err(err) => log::error!("updates: cannot start the package's trial: {err}"),
            },
            Err(err) => {
                log::warn!("updates: downloaded package refused: {err}");
                remove(&next);
            }
        }
    }
    if chosen.is_none() && current.exists() {
        match open(&trust, &current, &packages, shipped) {
            Ok(loaded) => {
                chosen = Some(Chosen {
                    loaded,
                    trial: None,
                })
            }
            Err(err) => {
                log::warn!("updates: the installed package does not run: {err}");
                remove(&current);
            }
        }
    }
    // Only the running package's assets stay.
    let keep = chosen.as_ref().map(|c| c.loaded.receipt.sha256.clone());
    if let Ok(entries) = std::fs::read_dir(packages.join(&shipped.app_id)) {
        for entry in entries.flatten() {
            if keep.as_deref() != entry.file_name().to_str() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    chosen
}

/// Verifies the package at `path` for the shipped app and extracts its
/// assets: refused unless it is the app's, newer than the shipped build
/// and runs here (`TrustStore::verify`).
fn open(
    trust: &TrustStore,
    path: &Path,
    packages: &Path,
    shipped: &Shipped,
) -> Result<LoadedPackage, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    // The header's claims are checked before anything is extracted.
    let package = trust
        .verify(&bytes, crate::BYTECODE_VERSION)
        .map_err(|e| e.to_string())?;
    check_app(&package.app, shipped)?;
    drop(package);
    crate::verify_package(trust, &bytes, packages)
}

fn check_app(app: &nsh_package::App, shipped: &Shipped) -> Result<(), String> {
    if app.id != shipped.app_id {
        return Err(format!("it is {}, the app is {}", app.id, shipped.app_id));
    }
    if app.build <= shipped.build {
        return Err(format!(
            "its build {} is not newer than the app's {}",
            app.build, shipped.build
        ));
    }
    Ok(())
}

fn remove(path: &Path) {
    if let Err(err) = std::fs::remove_file(path)
        && err.kind() != std::io::ErrorKind::NotFound
    {
        log::error!("updates: cannot remove {}: {err}", path.display());
    }
}

/// Verifies a downloaded package as [`launch`] will (`nsh/updater`'s
/// `downloadPackage`): signed by a release key one of `roots` certifies,
/// for app `app_id`, newer than `newer_than` (the running build) and the
/// builds accepted before, for this runtime. Accepts nothing and extracts
/// nothing; `dir` is the app's [`updates_dir`]. Returns its app.
pub fn verify_download(
    file: &Path,
    dir: &Path,
    app_id: &str,
    roots: &[String],
    newer_than: u64,
) -> Result<nsh_package::App, String> {
    let roots = roots
        .iter()
        .map(|root| PublicKey::from_base64(root).map_err(|e| format!("package root: {e}")))
        .collect::<Result<Vec<_>, _>>()?;
    if roots.is_empty() {
        return Err("the app trusts no package roots".into());
    }
    let shipped = Shipped {
        app_id: app_id.to_owned(),
        build: newer_than,
        roots,
    };
    let trust = shipped.trust(dir)?;
    let bytes = std::fs::read(file).map_err(|e| format!("{}: {e}", file.display()))?;
    let package = trust
        .verify(&bytes, crate::BYTECODE_VERSION)
        .map_err(|e| e.to_string())?;
    check_app(&package.app, &shipped)?;
    Ok(package.app)
}

/// The trial of `trying.nshpkg`: healthy, it becomes `current.nshpkg` and
/// its build is accepted; failed, it is deleted.
#[derive(Debug)]
struct PackageTrial {
    dir: PathBuf,
    shipped: Shipped,
    receipt: PackageReceipt,
    /// Decided: later calls change nothing.
    done: AtomicBool,
    lock: Mutex<()>,
}

impl PackageTrial {
    fn decide(&self) -> Option<std::sync::MutexGuard<'_, ()>> {
        let guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        (!self.done.swap(true, Ordering::SeqCst)).then_some(guard)
    }

    fn accept(&self) -> Result<(), String> {
        let mut trust = self.shipped.trust(&self.dir)?;
        trust
            .accept_receipt(&self.receipt)
            .map_err(|e| e.to_string())?;
        std::fs::rename(self.dir.join(TRYING), self.dir.join(CURRENT)).map_err(|e| e.to_string())
    }
}

impl Trial for PackageTrial {
    fn healthy(&self) {
        let Some(_guard) = self.decide() else { return };
        match self.accept() {
            Ok(()) => log::info!(
                "updates: package {} build {} is healthy: installed",
                self.receipt.app.id,
                self.receipt.app.build
            ),
            Err(err) => log::error!("updates: cannot install the healthy package: {err}"),
        }
    }

    fn failed(&self, error: &AppError) {
        let Some(_guard) = self.decide() else { return };
        log::error!(
            "updates: package {} build {} failed ({}): the next launch goes back",
            self.receipt.app.id,
            self.receipt.app.build,
            error.message
        );
        remove(&self.dir.join(TRYING));
    }
}

#[cfg(test)]
mod tests {
    use nsh_package::{Certificate, Contents, SecretKey, build, certify};

    use super::*;
    use crate::AppErrorKind;

    const ID: &str = "com.example.app";

    struct Keys {
        root: SecretKey,
        release: SecretKey,
        cert: Certificate,
    }

    impl Keys {
        fn new() -> Keys {
            let root = SecretKey::generate().unwrap();
            let release = SecretKey::generate().unwrap();
            let cert = certify(&root, &release.public(), &[ID.into()], 0, u64::MAX);
            Keys {
                root,
                release,
                cert,
            }
        }

        fn package(&self, id: &str, build_number: u64) -> Vec<u8> {
            let contents = Contents {
                app: nsh_package::App {
                    id: id.into(),
                    name: "App".into(),
                    version: format!("1.0.{build_number}"),
                    build: build_number,
                },
                capabilities: Some(serde_json::json!({ "clipboard": true })),
                source: format!("globalThis.build = {build_number};"),
                bytecode: None,
                source_map: None,
                assets: vec![("a.txt".into(), build_number.to_string().into_bytes())],
                min_runtime: None,
            };
            let cert = if id == ID {
                self.cert.clone()
            } else {
                certify(
                    &self.root,
                    &self.release.public(),
                    &["*".into()],
                    0,
                    u64::MAX,
                )
            };
            build(&contents, &self.release, &cert).unwrap()
        }

        fn shipped(&self, build: u64) -> Shipped {
            Shipped {
                app_id: ID.into(),
                build,
                roots: vec![self.root.public()],
            }
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nsh-updates-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(dir: &Path, name: &str, bytes: &[u8]) {
        std::fs::write(dir.join(name), bytes).unwrap();
    }

    fn chosen_build(chosen: &Option<Chosen>) -> Option<u64> {
        chosen.as_ref().map(|c| c.loaded.app.build)
    }

    fn fatal() -> AppError {
        AppError::new(AppErrorKind::Load, "Error: boom")
    }

    #[test]
    fn nothing_downloaded_runs_the_shipped_bundle() {
        let (keys, dir) = (Keys::new(), temp("none"));
        assert!(choose(&dir, &keys.shipped(1)).is_none());
    }

    #[test]
    fn a_new_package_runs_on_trial_and_is_installed_once_healthy() {
        let (keys, dir) = (Keys::new(), temp("healthy"));
        put(&dir, NEXT, &keys.package(ID, 2));
        let chosen = choose(&dir, &keys.shipped(1));
        assert_eq!(chosen_build(&chosen), Some(2));
        let chosen = chosen.unwrap();
        assert!(dir.join(TRYING).exists() && !dir.join(NEXT).exists());
        assert_eq!(
            std::fs::read(chosen.loaded.assets.join("a.txt")).unwrap(),
            b"2"
        );
        let trial = chosen.trial.expect("on trial");
        trial.healthy();
        // A later failure changes nothing.
        trial.failed(&fatal());
        assert!(!dir.join(NEXT).exists() && !dir.join(TRYING).exists());
        assert!(dir.join(CURRENT).exists());
        // Installed: the next launch runs it, off trial.
        let again = choose(&dir, &keys.shipped(1)).unwrap();
        assert_eq!(again.loaded.app.build, 2);
        assert!(again.trial.is_none());
        // Accepted: build 1 would now be refused.
        let trust = keys.shipped(1).trust(&dir).unwrap();
        assert_eq!(trust.accepted_build(ID), Some(2));
    }

    #[test]
    fn a_package_that_crashed_is_rolled_back_to_the_installed_one() {
        let (keys, dir) = (Keys::new(), temp("crash"));
        put(&dir, CURRENT, &keys.package(ID, 2));
        put(&dir, NEXT, &keys.package(ID, 3));
        assert_eq!(chosen_build(&choose(&dir, &keys.shipped(1))), Some(3));
        // The process died before the trial ended: it is still on trial.
        let rolled_back = choose(&dir, &keys.shipped(1));
        assert_eq!(chosen_build(&rolled_back), Some(2));
        assert!(!dir.join(NEXT).exists() && !dir.join(TRYING).exists());
        // Only the running package's assets are kept.
        let kept: Vec<_> = std::fs::read_dir(dir.join(PACKAGES).join(ID))
            .unwrap()
            .collect();
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn a_fatal_error_deletes_the_package() {
        let (keys, dir) = (Keys::new(), temp("fatal"));
        put(&dir, NEXT, &keys.package(ID, 2));
        let chosen = choose(&dir, &keys.shipped(1)).unwrap();
        let trial = chosen.trial.unwrap();
        trial.failed(&fatal());
        trial.healthy();
        assert!(!dir.join(NEXT).exists() && !dir.join(TRYING).exists());
        assert!(!dir.join(CURRENT).exists());
        assert!(choose(&dir, &keys.shipped(1)).is_none());
    }

    #[test]
    fn tampered_foreign_and_old_packages_are_deleted() {
        let keys = Keys::new();
        let mut tampered = keys.package(ID, 2);
        let at = tampered.len() / 2;
        tampered[at] ^= 1;
        let untrusted = Keys::new().package(ID, 2);
        for (name, bytes) in [
            ("tampered", tampered),
            ("untrusted", untrusted),
            ("foreign", keys.package("com.example.other", 2)),
            ("old", keys.package(ID, 1)),
        ] {
            let dir = temp(name);
            put(&dir, NEXT, &bytes);
            assert!(choose(&dir, &keys.shipped(1)).is_none(), "{name}");
            assert!(!dir.join(NEXT).exists(), "{name}");
        }
    }

    #[test]
    fn a_newer_app_replaces_the_installed_package() {
        let (keys, dir) = (Keys::new(), temp("newer-app"));
        put(&dir, CURRENT, &keys.package(ID, 2));
        assert_eq!(chosen_build(&choose(&dir, &keys.shipped(1))), Some(2));
        // The app was updated to build 2 (or later): it runs its own.
        assert!(choose(&dir, &keys.shipped(2)).is_none());
        assert!(!dir.join(CURRENT).exists());
    }

    #[test]
    fn an_older_download_than_the_installed_package_is_refused() {
        let (keys, dir) = (Keys::new(), temp("older"));
        put(&dir, NEXT, &keys.package(ID, 3));
        choose(&dir, &keys.shipped(1))
            .unwrap()
            .trial
            .unwrap()
            .healthy();
        put(&dir, NEXT, &keys.package(ID, 2));
        assert_eq!(chosen_build(&choose(&dir, &keys.shipped(1))), Some(3));
        assert!(!dir.join(NEXT).exists());
    }

    #[test]
    fn a_download_during_a_trial_waits_for_the_next_launch() {
        let (keys, dir) = (Keys::new(), temp("during"));
        put(&dir, NEXT, &keys.package(ID, 2));
        let trial = choose(&dir, &keys.shipped(1)).unwrap().trial.unwrap();
        put(&dir, NEXT, &keys.package(ID, 3));
        trial.healthy();
        let trust = keys.shipped(1).trust(&dir).unwrap();
        assert_eq!(trust.accepted_build(ID), Some(2));
        let next = choose(&dir, &keys.shipped(1)).unwrap();
        assert_eq!(next.loaded.app.build, 3);
        assert!(next.trial.is_some());
    }

    #[test]
    fn downloads_are_verified_without_being_accepted() {
        let (keys, dir) = (Keys::new(), temp("download"));
        let roots = [keys.root.public().to_base64()];
        let file = dir.join("next.nshpkg.part");
        put(&dir, "next.nshpkg.part", &keys.package(ID, 3));
        let app = verify_download(&file, &dir, ID, &roots, 2).unwrap();
        assert_eq!(app.build, 3);
        assert!(verify_download(&file, &dir, ID, &roots, 3).is_err());
        assert!(verify_download(&file, &dir, "com.example.other", &roots, 2).is_err());
        let other = [Keys::new().root.public().to_base64()];
        assert!(verify_download(&file, &dir, ID, &other, 2).is_err());
        assert!(verify_download(&file, &dir, ID, &[], 2).is_err());
        let trust = keys.shipped(1).trust(&dir).unwrap();
        assert_eq!(trust.accepted_build(ID), None);
    }

    #[test]
    fn packages_run_as_the_shipped_app() {
        let (keys, dir) = (Keys::new(), temp("launch"));
        let resources = dir.join("nsh");
        std::fs::create_dir_all(resources.join("assets")).unwrap();
        let config = serde_json::json!({
            "id": ID, "version": "1.0.0", "github": "o/r", "build": 1,
            "packages": { "roots": [keys.root.public().to_base64()] },
        });
        std::fs::write(
            resources.join("assets/nsh-updater.json"),
            config.to_string(),
        )
        .unwrap();
        let data = dir.join("data");
        let updates = updates_dir(&data, ID);
        std::fs::create_dir_all(&updates).unwrap();
        put(&updates, NEXT, &keys.package(ID, 2));
        let declared =
            crate::parse_capabilities(r#"{"network":{"hosts":["api.example.com"]}}"#).unwrap();
        let shipped = Bundle::source("1".into())
            .with_app_id(Some(ID))
            .with_url_schemes(["example"])
            .with_main_window(Some(r#"{"defaultSize":{"width":900,"height":640}}"#))
            .with_policy(crate::Policy {
                declared: Some(declared),
                ..Default::default()
            });

        assert!(shipped.main_window.is_some());
        let launched = launch(shipped.clone(), &resources, Some(&data));
        assert_eq!(launched.package.as_ref().map(|a| a.build), Some(2));
        let bundle = &launched.bundle;
        assert_eq!(bundle.url_schemes, ["example"]);
        assert_eq!(bundle.main_window, shipped.main_window);
        assert!(bundle.updater_config.is_some() && bundle.trial.is_some());
        // The package declares the clipboard; the app did not.
        assert!(!bundle.policy.access().allows_clipboard());
        assert!(launched.assets.join("a.txt").exists());

        // Without a data directory, or roots, the shipped bundle runs.
        let plain = launch(shipped.clone(), &resources, None);
        assert!(plain.package.is_none() && plain.bundle.updater_config.is_some());
        assert_eq!(plain.assets, resources.join("assets"));
        let elsewhere = dir.join("other");
        let shipped_only = launch(shipped, &elsewhere, Some(&data));
        assert!(shipped_only.package.is_none() && shipped_only.bundle.updater_config.is_none());
    }
}
