//! `nsh component`: the parts of an installed distribution that are added
//! when they are needed, as `rustup component add` does.
//!
//! A release archive (`nsh-<host>.tar.gz`) holds the CLI and this machine's
//! own runtime (`runtime/macos`, `runtime/linux`, `runtime/windows`), what
//! `nsh run` and `nsh package` need for this machine. Each other runtime is
//! a component, an archive of the same release (`nsh-<component>.tar.gz`,
//! or `nsh-<component>-<host>.tar.gz` for one built for this machine) with
//! its `.sha256`: `nsh component add <name>` installs it, and a command that
//! needs a runtime not installed adds its component first. An archive holds
//! one directory, `nsh/`, laid out as the distribution, with its record
//! `components/<name>.json`: the version and revision it was built at,
//! which must be this CLI's (a nightly's components are replaced every
//! night; a CLI of another night is told to `nsh update`).
//!
//! `nsh component pack` (hidden, the release workflow's) moves each
//! component out of a distribution into its archive, leaving the core.

use std::{
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};

use crate::{runtime, self_update, ui};

/// A component of the distribution.
#[derive(Debug)]
pub(crate) struct Component {
    /// Its name (`nsh component add <name>`).
    pub(crate) name: &'static str,
    /// What it is, as `nsh component list` shows it.
    what: &'static str,
    /// What it holds, relative to the distribution's root.
    paths: &'static [&'static str],
    /// Built for this machine: its archive names the host.
    per_host: bool,
    /// The hosts it is published for (`None`: every one).
    hosts: Option<&'static [&'static str]>,
}

/// Every component, in the order `nsh component list` shows them.
pub(crate) const COMPONENTS: &[Component] = &[
    Component {
        name: "android",
        what: "Android runtime (`--target android`, `nsh package --target android`)",
        paths: &[
            "runtime/android/release/classes.dex",
            "runtime/android/release/lib",
            "runtime/android/dev/classes.dex",
            "runtime/android/dev/lib",
        ],
        per_host: false,
        hosts: None,
    },
    Component {
        name: "android-symbols",
        what: "Android runtime's symbols (crash reports, `ndk-stack`)",
        paths: &[
            "runtime/android/release/symbols",
            "runtime/android/dev/symbols",
        ],
        per_host: false,
        hosts: None,
    },
    Component {
        name: "ios",
        what: "iOS runtimes (`--target ios`, `catalyst`, `nsh package --target ios`)",
        paths: &["runtime/ios"],
        per_host: true,
        hosts: Some(&["macos-arm64"]),
    },
    Component {
        name: "web",
        what: "web runtime (`--target web`, `nsh package --target web`)",
        paths: &["runtime/web"],
        per_host: false,
        hosts: None,
    },
    Component {
        name: "gpui",
        what: "GPUI development host (`--target gpui`)",
        paths: &["runtime/gpui"],
        per_host: true,
        hosts: None,
    },
    Component {
        name: "tui",
        what: "terminal development host (`--target tui`)",
        paths: &["runtime/tui"],
        per_host: true,
        hosts: None,
    },
];

/// What `components/<name>.json` records.
#[derive(Debug, Serialize, Deserialize)]
struct Record {
    version: String,
    commit: String,
}

impl Record {
    fn this_build() -> Record {
        Record {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            commit: env!("NSH_GIT_SHA").to_owned(),
        }
    }

    /// Whether it was built from the same revision as this CLI.
    fn matches_this_build(&self) -> bool {
        let this = Record::this_build();
        self.version == this.version
            && (this.commit == "unknown" || self.commit == "unknown" || self.commit == this.commit)
    }
}

impl Component {
    /// The component called `name`.
    pub(crate) fn named(name: &str) -> anyhow::Result<&'static Component> {
        COMPONENTS.iter().find(|c| c.name == name).with_context(|| {
            let names: Vec<_> = COMPONENTS.iter().map(|c| c.name).collect();
            format!("no component {name} (components: {})", names.join(", "))
        })
    }

    /// Whether it is published for `host`.
    fn for_host(&self, host: &str) -> bool {
        self.hosts.is_none_or(|hosts| hosts.contains(&host))
    }

    /// Its release asset, for `host`.
    fn asset(&self, host: &str) -> String {
        if self.per_host {
            format!("nsh-{}-{host}.tar.gz", self.name)
        } else {
            format!("nsh-{}.tar.gz", self.name)
        }
    }

    fn record(&self, root: &Path) -> PathBuf {
        root.join("components").join(format!("{}.json", self.name))
    }

    /// Whether it is installed in the distribution at `root`.
    fn installed(&self, root: &Path) -> bool {
        self.record(root).exists() && self.paths.iter().all(|p| root.join(p).exists())
    }
}

/// The root of the distribution this CLI is part of (`<root>/bin/nsh`, its
/// runtimes in `<root>/runtime`), `None` for a checkout's build.
pub(crate) fn distribution() -> Option<PathBuf> {
    let exe = runtime::cli_exe().ok()?;
    let bin = exe.parent()?;
    if bin.file_name()? != "bin" {
        return None;
    }
    let root = bin.parent()?;
    root.join("runtime").is_dir().then(|| root.to_owned())
}

/// Makes sure the component holding what `missing` names is installed in
/// the distribution at `root`, adding it if not: called when a command
/// needs a runtime the distribution does not have.
pub(crate) fn ensure(root: &Path, name: &str, missing: &Path) -> anyhow::Result<()> {
    let component = Component::named(name)?;
    if component.installed(root) && missing.exists() {
        return Ok(());
    }
    ui::note(format!(
        "{} is not installed yet: adding it (`nsh component add {name}`)",
        component.what
    ));
    add(root, component)?;
    if !missing.exists() {
        let file = missing.file_name().unwrap_or(missing.as_os_str());
        bail!("the component `{name}` holds no {}", file.to_string_lossy());
    }
    Ok(())
}

/// The components installed in the distribution at `root`.
pub(crate) fn installed(root: &Path) -> Vec<&'static str> {
    COMPONENTS
        .iter()
        .filter(|c| c.installed(root))
        .map(|c| c.name)
        .collect()
}

/// `nsh component list`.
pub(crate) fn list() -> anyhow::Result<()> {
    let root = required_distribution()?;
    let host = self_update::host()?;
    for component in COMPONENTS.iter().filter(|c| c.for_host(host)) {
        let state = if component.installed(&root) {
            ui::green("installed")
        } else {
            ui::dim("not installed")
        };
        ui::plain(format!(
            "{:<16} {:<14} {}",
            component.name,
            state,
            ui::dim(component.what)
        ));
    }
    Ok(())
}

/// `nsh component add <names>`.
pub(crate) fn add_named(names: &[String]) -> anyhow::Result<()> {
    let root = required_distribution()?;
    for name in names {
        let component = Component::named(name)?;
        if component.installed(&root) {
            ui::done(format!("`{name}` is already installed"));
            continue;
        }
        add(&root, component)?;
    }
    Ok(())
}

/// `nsh component remove <names>`.
pub(crate) fn remove_named(names: &[String]) -> anyhow::Result<()> {
    let root = required_distribution()?;
    for name in names {
        let component = Component::named(name)?;
        for path in component.paths {
            remove_path(&root.join(path))?;
            remove_empty_parents(&root, path);
        }
        remove_path(&component.record(&root))?;
        remove_empty_parents(&root, Path::new("components").join(name).as_path());
        ui::done(format!("removed `{name}`"));
    }
    Ok(())
}

fn required_distribution() -> anyhow::Result<PathBuf> {
    distribution().context(
        "this nsh is not an installed distribution (built from source?): \
         a checkout builds its runtimes with cargo when they are needed",
    )
}

/// Downloads `component` of this build's release and installs it into the
/// distribution at `root`.
fn add(root: &Path, component: &Component) -> anyhow::Result<()> {
    let host = self_update::host()?;
    if !component.for_host(host) {
        bail!(
            "the component `{}` is not published for {host}",
            component.name
        );
    }
    let tag = self_update::own_tag();
    let url = self_update::asset_url(&tag, &component.asset(host));
    add_from(root, component, &url, &tag)
}

/// Downloads `component`'s archive from `url` (`label` names where from)
/// and installs it into the distribution at `root`.
fn add_from(root: &Path, component: &Component, url: &str, label: &str) -> anyhow::Result<()> {
    // Unpacked next to where it goes: the moves into place stay on one
    // file system.
    let work = root.join(format!(
        ".component-{}-{}",
        component.name,
        std::process::id()
    ));
    remove_path(&work)?;
    fs::create_dir_all(&work).with_context(|| {
        format!(
            "create {} (cannot write into the distribution; add the component as the user who installed nsh)",
            work.display()
        )
    })?;
    let result = (|| {
        let archive = work.join("component.tar.gz");
        let step = ui::Step::start(format!("downloading `{}` ({label})", component.name));
        self_update::download(&self_update::agent(), url, &archive, &step)
            .with_context(|| format!("download the component `{}`", component.name))?;
        step.finish();
        let step = ui::Step::start(format!("installing `{}`", component.name));
        let unpacked = work.join("unpacked");
        unpack(&archive, &unpacked)?;
        install(root, component, &unpacked.join("nsh"))?;
        step.done(format!("installed `{}`", component.name));
        anyhow::Ok(())
    })();
    let _ = fs::remove_dir_all(&work);
    result
}

/// Moves `component`'s paths from the unpacked archive `from` into the
/// distribution at `root`, once its record says it was built with this CLI.
fn install(root: &Path, component: &Component, from: &Path) -> anyhow::Result<()> {
    let record_path = component.record(from);
    let record: Record = serde_json::from_slice(
        &fs::read(&record_path)
            .with_context(|| format!("the archive of `{}` has no record", component.name))?,
    )
    .with_context(|| format!("read {}", record_path.display()))?;
    if !record.matches_this_build() {
        let this = Record::this_build();
        bail!(
            "the release's `{}` was built from {} ({}), this nsh from {} ({}): \
             run `nsh update` and try again",
            component.name,
            record.version,
            record.commit,
            this.version,
            this.commit
        );
    }
    for path in component.paths {
        let source = from.join(path);
        if !source.exists() {
            bail!("the archive of `{}` holds no {path}", component.name);
        }
        let dest = root.join(path);
        remove_path(&dest)?;
        if let Some(dir) = dest.parent() {
            fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        fs::rename(&source, &dest).with_context(|| format!("install {}", dest.display()))?;
    }
    let dest = component.record(root);
    fs::create_dir_all(dest.parent().context("components directory")?)?;
    fs::rename(&record_path, &dest).with_context(|| format!("install {}", dest.display()))?;
    Ok(())
}

fn unpack(archive: &Path, into: &Path) -> anyhow::Result<()> {
    let file = fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    tar.set_preserve_permissions(true);
    tar.unpack(into)
        .with_context(|| format!("unpack {}", archive.display()))
}

/// Removes the directories `path` (relative to `root`) leaves empty, up to
/// `root`: what a component brought (`runtime/android/`) goes with it.
fn remove_empty_parents(root: &Path, path: impl AsRef<Path>) {
    let mut dir = path.as_ref().parent();
    while let Some(relative) = dir.filter(|d| !d.as_os_str().is_empty()) {
        // Fails, and stops, at the first directory that is not empty.
        if fs::remove_dir(root.join(relative)).is_err() {
            break;
        }
        dir = relative.parent();
    }
}

fn remove_path(path: &Path) -> anyhow::Result<()> {
    let result = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(_) => return Ok(()),
    };
    result.with_context(|| format!("remove {}", path.display()))
}

/// `nsh component pack --out <dir>`: moves each component this
/// distribution holds into its archive in `out`, with its record, and out of
/// the distribution, which is left with the core. The release workflow runs
/// it on a copy of `dist/nsh`.
pub(crate) fn pack(out: &Path) -> anyhow::Result<()> {
    let root = distribution().context("pack runs the CLI of the distribution it packs")?;
    let host = self_update::host()?;
    fs::create_dir_all(out).with_context(|| format!("create {}", out.display()))?;
    let record = serde_json::to_vec_pretty(&Record::this_build())?;
    for component in COMPONENTS {
        let present: Vec<_> = component
            .paths
            .iter()
            .filter(|p| root.join(p).exists())
            .collect();
        if present.is_empty() {
            continue;
        }
        if present.len() != component.paths.len() {
            bail!(
                "the distribution holds only part of `{}`: {}",
                component.name,
                present
                    .iter()
                    .map(|p| p.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        let asset = out.join(component.asset(host));
        write_archive(&root, component, &record, &asset)?;
        for path in component.paths {
            remove_path(&root.join(path))?;
            remove_empty_parents(&root, path);
        }
        ui::done(format!("packed {}", ui::path(&asset)));
    }
    Ok(())
}

fn write_archive(
    root: &Path,
    component: &Component,
    record: &[u8],
    to: &Path,
) -> anyhow::Result<()> {
    let file = fs::File::create(to).with_context(|| format!("create {}", to.display()))?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);
    tar.follow_symlinks(false);
    for path in component.paths {
        let source = root.join(path);
        let name = Path::new("nsh").join(path);
        let packed = if source.is_dir() {
            tar.append_dir_all(&name, &source)
        } else {
            tar.append_path_with_name(&source, &name)
        };
        packed.with_context(|| format!("pack {}", source.display()))?;
    }
    let mut header = tar::Header::new_gnu();
    header.set_size(record.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(
        &mut header,
        Path::new("nsh/components").join(format!("{}.json", component.name)),
        record,
    )?;
    tar.into_inner()?
        .finish()
        .with_context(|| format!("write {}", to.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::env;

    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("nsh-component-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn components_are_distinct_and_cover_disjoint_paths() {
        for (i, a) in COMPONENTS.iter().enumerate() {
            for b in &COMPONENTS[i + 1..] {
                assert_ne!(a.name, b.name);
                for p in a.paths {
                    for q in b.paths {
                        assert!(
                            !Path::new(p).starts_with(q) && !Path::new(q).starts_with(p),
                            "{p} and {q} overlap"
                        );
                    }
                }
            }
        }
        assert_eq!(
            Component::named("gpui").unwrap().asset("linux-x86_64"),
            "nsh-gpui-linux-x86_64.tar.gz"
        );
        assert_eq!(
            Component::named("web").unwrap().asset("linux-x86_64"),
            "nsh-web.tar.gz"
        );
        assert!(!Component::named("ios").unwrap().for_host("linux-x86_64"));
        assert!(Component::named("nope").is_err());
    }

    #[test]
    fn a_packed_component_installs_into_another_distribution() {
        let dir = temp("pack");
        let from = dir.join("from");
        let web = Component::named("web").unwrap();
        fs::create_dir_all(from.join("runtime/web/browser")).unwrap();
        fs::write(from.join("runtime/web/nsh.js"), b"js").unwrap();
        fs::write(from.join("runtime/web/browser/dom.js"), b"dom").unwrap();
        let record = serde_json::to_vec(&Record::this_build()).unwrap();
        let archive = dir.join("nsh-web.tar.gz");
        write_archive(&from, web, &record, &archive).unwrap();

        let unpacked = dir.join("unpacked");
        unpack(&archive, &unpacked).unwrap();
        let root = dir.join("root");
        fs::create_dir_all(root.join("runtime/web")).unwrap();
        fs::write(root.join("runtime/web/stale.js"), b"old").unwrap();
        install(&root, web, &unpacked.join("nsh")).unwrap();
        assert_eq!(fs::read(root.join("runtime/web/nsh.js")).unwrap(), b"js");
        assert_eq!(
            fs::read(root.join("runtime/web/browser/dom.js")).unwrap(),
            b"dom"
        );
        assert!(!root.join("runtime/web/stale.js").exists());
        assert!(web.installed(&root));
        assert_eq!(installed(&root), vec!["web"]);
        let _ = fs::remove_dir_all(&dir);
    }

    /// Serves `files` (path → body) over HTTP on this machine, one
    /// connection after another, as a release's downloads.
    fn serve(files: Vec<(String, Vec<u8>)>) -> String {
        use std::io::{BufRead as _, BufReader, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut request = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                reader.read_line(&mut request).unwrap();
                // The rest of the request's head.
                let mut line = String::new();
                while reader.read_line(&mut line).unwrap_or(0) > 2 {
                    line.clear();
                }
                let path = request.split_whitespace().nth(1).unwrap_or("").to_owned();
                let response = match files.iter().find(|(p, _)| *p == path) {
                    Some((_, body)) => {
                        let mut head = format!(
                            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        )
                        .into_bytes();
                        head.extend_from_slice(body);
                        head
                    }
                    None => {
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_vec()
                    }
                };
                let _ = stream.write_all(&response);
            }
        });
        format!("http://{address}")
    }

    fn sha256(bytes: &[u8]) -> String {
        use sha2::{Digest as _, Sha256};
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn a_component_is_downloaded_checked_and_installed() {
        let dir = temp("download");
        let from = dir.join("from");
        let android = Component::named("android").unwrap();
        for variant in ["release", "dev"] {
            fs::create_dir_all(from.join(format!("runtime/android/{variant}/lib/arm64-v8a")))
                .unwrap();
            fs::write(
                from.join(format!("runtime/android/{variant}/classes.dex")),
                variant,
            )
            .unwrap();
            fs::write(
                from.join(format!("runtime/android/{variant}/lib/arm64-v8a/libnsh.so")),
                b"elf",
            )
            .unwrap();
        }
        let record = serde_json::to_vec(&Record::this_build()).unwrap();
        let archive = dir.join("nsh-android.tar.gz");
        write_archive(&from, android, &record, &archive).unwrap();
        let bytes = fs::read(&archive).unwrap();
        let sum = format!("{}  nsh-android.tar.gz\n", sha256(&bytes)).into_bytes();
        let base = serve(vec![
            ("/good/nsh-android.tar.gz".into(), bytes.clone()),
            ("/good/nsh-android.tar.gz.sha256".into(), sum),
            ("/bad/nsh-android.tar.gz".into(), bytes),
            (
                "/bad/nsh-android.tar.gz.sha256".into(),
                format!("{}  x\n", sha256(b"something else")).into_bytes(),
            ),
        ]);

        let root = dir.join("root");
        fs::create_dir_all(root.join("runtime/macos")).unwrap();
        // A download that does not match its SHA-256 installs nothing.
        let error = add_from(
            &root,
            android,
            &format!("{base}/bad/nsh-android.tar.gz"),
            "test",
        )
        .unwrap_err();
        assert!(format!("{error:#}").contains("SHA-256"), "{error:#}");
        assert!(!android.installed(&root));
        // Nor does a release without it.
        assert!(
            add_from(
                &root,
                android,
                &format!("{base}/none/nsh-android.tar.gz"),
                "test"
            )
            .is_err()
        );

        let dex = root.join("runtime/android/dev/classes.dex");
        add_from(
            &root,
            android,
            &format!("{base}/good/nsh-android.tar.gz"),
            "test",
        )
        .unwrap();
        assert!(android.installed(&root));
        assert_eq!(fs::read(&dex).unwrap(), b"dev");
        assert!(
            root.join("runtime/android/release/lib/arm64-v8a/libnsh.so")
                .exists()
        );
        // Nothing of the download stays behind.
        let leftovers: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".component-"))
            .collect();
        assert!(leftovers.is_empty());
        // Already there: `ensure` downloads nothing (the URL is not asked).
        ensure(&root, "android", &dex).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_a_component_leaves_empty_goes_with_it() {
        let root = temp("empty");
        fs::create_dir_all(root.join("runtime/android/release/lib")).unwrap();
        fs::create_dir_all(root.join("runtime/android/dev")).unwrap();
        fs::write(root.join("runtime/android/dev/classes.dex"), b"dex").unwrap();
        fs::create_dir_all(root.join("runtime/macos")).unwrap();
        remove_path(&root.join("runtime/android/release/lib")).unwrap();
        remove_empty_parents(&root, "runtime/android/release/lib");
        assert!(!root.join("runtime/android/release").exists());
        assert!(root.join("runtime/android/dev").exists());
        remove_path(&root.join("runtime/android/dev/classes.dex")).unwrap();
        remove_empty_parents(&root, "runtime/android/dev/classes.dex");
        assert!(!root.join("runtime/android").exists());
        assert!(root.join("runtime/macos").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_component_of_another_build_is_refused() {
        let dir = temp("other");
        let from = dir.join("nsh");
        let tui = Component::named("tui").unwrap();
        fs::create_dir_all(from.join("runtime/tui")).unwrap();
        fs::create_dir_all(from.join("components")).unwrap();
        let other = Record {
            version: "0.0.1".into(),
            commit: "abcdef0".into(),
        };
        fs::write(tui.record(&from), serde_json::to_vec(&other).unwrap()).unwrap();
        let root = dir.join("root");
        let error = install(&root, tui, &from).unwrap_err().to_string();
        assert!(error.contains("nsh update"), "{error}");
        assert!(!tui.installed(&root));
        let _ = fs::remove_dir_all(&dir);
    }
}
