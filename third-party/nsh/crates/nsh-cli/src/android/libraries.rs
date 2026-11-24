//! The Java libraries an Android package carries (`android.libraries` of the
//! app's `nsh.json` and of its crates' `[package.metadata.nsh]`): jar files,
//! which the SDK's `d8` turns into dex; prebuilt dex files; and Android
//! libraries (AARs), whose classes go the jars' way and whose native
//! libraries, assets, resources ([`library_resources`]) and manifest the
//! package takes as well. A package without libraries runs none of this.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use super::{
    Apk, MIN_SDK, Sdk, class_file,
    library_manifest::{self, Additions, Element, Placeholders},
    library_resources::{self, Symbols},
};

/// Where `nsh.json` lists its libraries, as errors name it.
const NSH_JSON: &str = "nsh.json `android.libraries`";

/// A Java library a package carries.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(from = "PathBuf")]
pub(crate) struct Library {
    /// The file. One `nsh.json` lists is relative to `nsh.json` until
    /// `read_config` resolves it; a crate's is resolved against the
    /// directory of the crate's `Cargo.toml`.
    pub(crate) path: PathBuf,
    /// Who lists it, for errors: `nsh.json `android.libraries`` or
    /// `<crate>: [package.metadata.nsh] `android.libraries``.
    pub(crate) listed: String,
    /// The crate that lists it; `None`: the app's `nsh.json`.
    pub(crate) owner: Option<String>,
}

impl From<PathBuf> for Library {
    fn from(path: PathBuf) -> Self {
        Library {
            path,
            listed: NSH_JSON.to_owned(),
            owner: None,
        }
    }
}

/// What a library file is, by its extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Jar,
    Dex,
    Aar,
}

impl Library {
    fn kind(&self) -> anyhow::Result<Kind> {
        let extension = self
            .path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase);
        match extension.as_deref() {
            Some("jar") => Ok(Kind::Jar),
            Some("dex") => Ok(Kind::Dex),
            Some("aar") => Ok(Kind::Aar),
            _ => bail!(
                "{}: {} is neither a jar (`.jar`), an Android library (`.aar`) nor a dex file (`.dex`)",
                self.listed,
                self.path.display()
            ),
        }
    }

    /// `path`, and who lists it.
    fn describe(&self) -> String {
        format!("{} ({})", self.path.display(), self.listed)
    }
}

/// What the libraries add to the package, after the runtime's.
#[derive(Debug, Default)]
pub(super) struct Contents {
    /// Dex files, numbered in this order after the runtime's
    /// `classes.dex`: `classes2.dex`, `classes3.dex`, ...
    pub(super) dex: Vec<PathBuf>,
    /// The jars' Java resources (`META-INF/services/...` and the like):
    /// (path at the package's root, contents).
    pub(super) resources: Vec<(String, Vec<u8>)>,
    /// The native libraries of the AARs that have any ([`native_for`]).
    pub(super) native: Vec<Native>,
    /// The AARs' assets, and the jars' Java resources under `assets/`:
    /// (path under `assets/`, contents).
    pub(super) assets: Vec<(String, Vec<u8>)>,
    /// Each asset's index in `assets` and the library it came from.
    asset_from: BTreeMap<String, (usize, String)>,
    /// What the manifest gets: the crates' entries and the AARs' manifests.
    pub(super) manifest: Additions,
    /// The AARs' resources, compiled ([`compile_res`]): overlays of `aapt2
    /// link`, lowest priority first ([`library_resources::link_inputs`]).
    pub(super) res: Vec<PathBuf>,
    /// The AARs' resources [`compile_res`] compiles.
    res_files: Vec<LibraryRes>,
    /// The AARs whose code was compiled against `R` fields: (package, its
    /// `R.txt`, the AAR and who lists it).
    r_classes: Vec<(String, Symbols, String)>,
    /// The jars [`dex`] turns into dex.
    jars: Vec<Checked>,
}

/// The resources of an AAR, to compile.
#[derive(Debug)]
struct LibraryRes {
    /// The crate that lists the AAR; `None`: the app's own `nsh.json`.
    owner: Option<String>,
    /// The AAR and who lists it, for errors.
    from: String,
    /// The AAR's contents, which the compiled resources are cached by.
    sha256: String,
    /// `res/`: (path under it, contents).
    files: Vec<(String, Vec<u8>)>,
    /// Where they are written out to compile.
    dir: PathBuf,
}

impl Contents {
    /// Whether [`dex`] needs the ids `aapt2 link` gave the resources
    /// (`--output-text-symbols`).
    pub(super) fn needs_symbols(&self) -> bool {
        !self.r_classes.is_empty()
    }

    /// Adds the asset `path` (under `assets/`) of the library `from`, once:
    /// another library with the same path and different contents is an
    /// error naming both.
    fn add_asset(&mut self, path: String, bytes: Vec<u8>, from: &str) -> anyhow::Result<()> {
        match self.asset_from.get(&path) {
            None => {
                self.asset_from
                    .insert(path.clone(), (self.assets.len(), from.to_owned()));
                self.assets.push((path, bytes));
            }
            Some((at, _)) if self.assets[*at].1 == bytes => {}
            Some((_, first)) => bail!(
                "{first} and {from} both have the asset `{path}`, with different contents: list one of them"
            ),
        }
        Ok(())
    }
}

/// The path under `assets/` of the entry `name` (`assets/<path>`) of the
/// library `shown`, which the package can take: one with an empty, `.` or
/// `..` part would land elsewhere, and `assets/nsh/` is NSH's own.
fn asset_path(shown: &str, name: &str) -> anyhow::Result<Option<String>> {
    let Some(path) = name.strip_prefix("assets/") else {
        return Ok(None);
    };
    // `assets/../classes.dex` would be a file of the package's own.
    if path.split('/').any(|part| matches!(part, "" | "." | "..")) {
        bail!("{shown} has `{name}`, an asset path with an empty, `.` or `..` part");
    }
    if path.starts_with("nsh/") {
        bail!("{shown} has `{name}`: `assets/nsh/` is NSH's own");
    }
    Ok(Some(path.to_owned()))
}

/// The native libraries of an AAR.
#[derive(Debug)]
pub(super) struct Native {
    /// The AAR and who lists it, for errors.
    pub(super) from: String,
    /// Its `jni/<abi>/*.so`: (file name, contents) by ABI.
    pub(super) abis: BTreeMap<String, Vec<(String, Vec<u8>)>>,
}

/// A library file to package, checked: one listed, or a jar of an AAR.
#[derive(Debug)]
struct Checked {
    path: PathBuf,
    /// Who lists it, which errors start with.
    listed: String,
    /// The file and who lists it, which errors name it by.
    shown: String,
    /// The crate that lists it; `None`: the app's own `nsh.json`.
    owner: Option<String>,
    kind: Kind,
    sha256: String,
}

impl Checked {
    /// The app's own `nsh.json` lists it.
    fn apps(&self) -> bool {
        self.owner.is_none()
    }
}

/// The libraries of `apk`, checked and each file once: a missing file or
/// one of another kind is an error naming who lists it; files with the same
/// contents (two crates that carry one jar) are packaged once, as the first
/// that lists them (the app before its crates).
fn checked(libraries: &[Library]) -> anyhow::Result<Vec<Checked>> {
    let mut out: Vec<Checked> = Vec::new();
    for library in libraries {
        let kind = library.kind()?;
        let bytes = fs::read(&library.path)
            .with_context(|| format!("{}: read {}", library.listed, library.path.display()))?;
        if kind == Kind::Dex && !bytes.starts_with(b"dex\n") {
            bail!(
                "{}: {} is not a dex file",
                library.listed,
                library.path.display()
            );
        }
        let sha256 = hex(&Sha256::digest(&bytes));
        if out.iter().any(|c| c.sha256 == sha256) {
            continue;
        }
        out.push(Checked {
            path: library.path.clone(),
            listed: library.listed.clone(),
            shown: library.describe(),
            owner: library.owner.clone(),
            kind,
            sha256,
        });
    }
    Ok(out)
}

/// What the libraries of `apk` add to the package: the dex files as they
/// are, in the order listed; the jars, and those of the AARs, each through
/// `d8 --intermediate` (kept in `apk.library_cache` by contents, `d8`
/// version, API level and mode), then merged by one `d8` run into `work`,
/// which fails on a class two libraries define; and the AARs' native
/// libraries, assets and manifests. Without libraries, only the crates'
/// manifest entries.
pub(super) fn prepare(apk: &Apk<'_>, work: &Path) -> anyhow::Result<Contents> {
    let mut contents = Contents::default();
    let mut files = Vec::new();
    let mut aars = Vec::new();
    for checked in checked(apk.libraries)? {
        if checked.kind == Kind::Aar {
            aars.push(read_aar(checked)?);
        } else {
            files.push(checked);
        }
    }
    let placeholders = Placeholders::new(apk.package, apk.manifest_placeholders);
    let mut manifests = Vec::new();
    let mut warnings = Vec::new();
    for (i, aar) in choose(aars)?.into_iter().enumerate() {
        if !aar.res.is_empty() {
            contents.res_files.push(LibraryRes {
                owner: aar.checked.owner.clone(),
                from: aar.checked.shown.clone(),
                sha256: aar.checked.sha256.clone(),
                files: aar.res,
                dir: work.join("aar").join(i.to_string()),
            });
        }
        if let Some(symbols) = aar.r_txt {
            contents
                .r_classes
                .push((aar.package, symbols, aar.checked.shown.clone()));
        }
        let from = aar.checked.shown;
        if let Some(level) = aar.min_compile_sdk
            && level > apk.target_sdk
        {
            bail!(
                "{from} compiles against Android API level {level} and later (its minCompileSdk), \
                 the app against {}: set nsh.json `android.targetSdk` to {level} or more",
                apk.target_sdk
            );
        }
        let parts = library_manifest::resolve(&aar.manifest, &from, &placeholders, &mut warnings)?;
        manifests.push((parts, from.clone()));
        // Its classes go the jars' way, from the work directory.
        let dir = work.join("aar").join(i.to_string());
        for (name, bytes) in aar.jars {
            let sha256 = hex(&Sha256::digest(&bytes));
            if files.iter().any(|c| c.sha256 == sha256) {
                continue;
            }
            let path = dir.join(&name);
            fs::create_dir_all(path.parent().unwrap_or(&dir))?;
            fs::write(&path, &bytes)?;
            files.push(Checked {
                path,
                listed: aar.checked.listed.clone(),
                shown: format!("`{name}` of {from}"),
                owner: aar.checked.owner.clone(),
                kind: Kind::Jar,
                sha256,
            });
        }
        for (path, bytes) in aar.assets {
            contents.add_asset(path, bytes, &from)?;
        }
        if !aar.native.is_empty() {
            contents.native.push(Native {
                from,
                abis: aar.native,
            });
        }
    }
    contents.manifest = library_manifest::additions(apk, &placeholders, manifests)?;
    for name in placeholders.missing.borrow().iter() {
        warnings.push(format!(
            "the placeholder `${{{name}}}` is empty in the shared test host, which reads no app's nsh.json"
        ));
    }
    for warning in warnings {
        crate::ui::warn(warning);
    }

    contents.dex.extend(
        files
            .iter()
            .filter(|c| c.kind == Kind::Dex)
            .map(|c| c.path.clone()),
    );
    contents.jars = files.into_iter().filter(|c| c.kind == Kind::Jar).collect();
    Ok(contents)
}

/// Adds the dex of the jars [`prepare`] found to `contents.dex`, with the
/// `R` classes of the AARs whose code reads any, their fields the ids of
/// `symbols` (what `aapt2 link --output-text-symbols` wrote): each jar
/// through `d8 --intermediate` (kept in `apk.library_cache` by contents,
/// `d8` version, API level and mode), then merged by one `d8` run into
/// `work`, which fails on a class two libraries define.
pub(super) fn dex(
    sdk: &Sdk,
    apk: &Apk<'_>,
    work: &Path,
    contents: &mut Contents,
    symbols: Option<&Path>,
) -> anyhow::Result<()> {
    let r_classes = match symbols {
        Some(symbols) if contents.needs_symbols() => Some(r_classes(
            sdk,
            apk,
            work,
            &contents.r_classes,
            &contents.jars,
            symbols,
        )?),
        _ => None,
    };
    let jars: Vec<&Checked> = contents.jars.iter().chain(&r_classes).collect();
    if jars.is_empty() {
        return Ok(());
    }
    let android_jar = sdk.android_jar(apk.target_sdk)?;
    // Each intermediate dex, with the library it is made of.
    let mut intermediate: Vec<(PathBuf, &Checked)> = Vec::new();
    for jar in &jars {
        let dir = intermediate_dex(sdk, jar, &android_jar, apk)?;
        for dex in dex_files(&dir)? {
            intermediate.push((dex, jar));
        }
    }
    let merged = work.join("libraries-dex");
    if merged.exists() {
        fs::remove_dir_all(&merged)?;
    }
    fs::create_dir_all(&merged)?;
    let inputs: Vec<PathBuf> = intermediate.iter().map(|(dex, _)| dex.clone()).collect();
    let output = merge_command(sdk, &inputs, apk.dev, &merged)
        .output()
        .context("run the SDK's d8 (is a JDK installed?)")?;
    if !output.status.success() {
        bail!(
            "{}",
            merge_error(
                &format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ),
                &intermediate,
            )
        );
    }
    contents.dex.extend(dex_files(&merged)?);
    let found = java_resources(&jars)?;
    contents.resources = found.root;
    for (path, bytes, from) in found.assets {
        contents.add_asset(path, bytes, &from)?;
    }
    Ok(())
}

/// Where an AAR keeps what its build was made for.
const AAR_METADATA: &str = "META-INF/com/android/build/gradle/aar-metadata.properties";

/// An AAR, read.
struct Aar {
    checked: Checked,
    /// Its manifest's package: what tells the library apart from others,
    /// whichever version of it this is.
    package: String,
    manifest: Element,
    /// `classes.jar` and `libs/*.jar`: (path in the AAR, contents).
    jars: Vec<(String, Vec<u8>)>,
    /// `jni/<abi>/*.so`: (file name, contents) by ABI.
    native: BTreeMap<String, Vec<(String, Vec<u8>)>>,
    /// `assets/`: (path under it, contents).
    assets: Vec<(String, Vec<u8>)>,
    /// `res/`: (path under it, contents).
    res: Vec<(String, Vec<u8>)>,
    /// The `R` fields its code was compiled against (`R.txt`), when there
    /// are any.
    r_txt: Option<Symbols>,
    /// The API level an app must compile against (`minCompileSdk`).
    min_compile_sdk: Option<u32>,
}

/// Reads what the package takes of an AAR: its classes, native
/// libraries, assets, resources, the `R` fields its code reads and its
/// manifest; what only a build reads (`public.txt`, `proguard.txt`,
/// `lint.jar`, ...) is left out.
fn read_aar(checked: Checked) -> anyhow::Result<Aar> {
    let file = fs::File::open(&checked.path)
        .with_context(|| format!("{}: read {}", checked.listed, checked.path.display()))?;
    let mut archive = zip::ZipArchive::new(file).with_context(|| {
        format!(
            "{}: {} is not an Android library (AAR)",
            checked.listed,
            checked.path.display()
        )
    })?;
    let mut manifest = None;
    let mut jars = Vec::new();
    let mut native: BTreeMap<String, Vec<(String, Vec<u8>)>> = BTreeMap::new();
    let mut assets = Vec::new();
    let mut res = Vec::new();
    // Each resource path in lower case: the path.
    let mut res_paths: BTreeMap<String, String> = BTreeMap::new();
    let mut r_txt = None;
    let mut min_compile_sdk = None;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        let name = entry.name()?.into_owned();
        if entry.enclosed_name().is_none() {
            bail!("{} has `{name}`, a path outside it", checked.shown);
        }
        let mut read = || -> anyhow::Result<Vec<u8>> {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        let libs_jar = name
            .strip_prefix("libs/")
            .is_some_and(|jar| !jar.contains('/') && jar.ends_with(".jar"));
        if name == "AndroidManifest.xml" {
            manifest = Some(String::from_utf8(read()?).with_context(|| {
                format!("{}: its AndroidManifest.xml is not UTF-8", checked.shown)
            })?);
        } else if name == "classes.jar" || libs_jar {
            jars.push((name, read()?));
        } else if let Some(rest) = name.strip_prefix("jni/") {
            if let Some((abi, so)) = rest.split_once('/')
                && !so.contains('/')
                && so.ends_with(".so")
            {
                let (abi, so) = (abi.to_owned(), so.to_owned());
                native.entry(abi).or_default().push((so, read()?));
            }
        } else if let Some(path) = asset_path(&checked.shown, &name)? {
            assets.push((path, read()?));
        } else if let Some(path) = name.strip_prefix("res/") {
            // Written out for `aapt2 compile --dir`, under the AAR's own
            // directory.
            if path.split('/').any(|part| matches!(part, "" | "." | "..")) {
                bail!(
                    "{} has `{name}`, a resource path with an empty, `.` or `..` part",
                    checked.shown
                );
            }
            // On a file system that ignores case, one would overwrite the
            // other.
            if let Some(other) = res_paths.insert(path.to_lowercase(), path.to_owned()) {
                bail!(
                    "{} has `res/{other}` and `{name}`, whose paths differ only in case",
                    checked.shown
                );
            }
            res.push((path.to_owned(), read()?));
        } else if name == "R.txt" {
            let text = String::from_utf8(read()?)
                .with_context(|| format!("{}: its R.txt is not UTF-8", checked.shown))?;
            let symbols = library_resources::parse_symbols(&text)
                .map_err(|e| anyhow::anyhow!("{}: its R.txt, {e}", checked.shown))?;
            r_txt = Some(symbols);
        } else if name == AAR_METADATA {
            let text = String::from_utf8_lossy(&read()?).into_owned();
            if let Some(value) = text
                .lines()
                .filter_map(|line| line.split_once('='))
                .find(|(key, _)| key.trim() == "minCompileSdk")
                .map(|(_, value)| value.trim().to_owned())
            {
                min_compile_sdk = Some(value.parse().map_err(|_| {
                    anyhow::anyhow!(
                        "{}: its minCompileSdk `{value}` is no API level",
                        checked.shown
                    )
                })?);
            }
        }
    }
    let manifest =
        manifest.with_context(|| format!("{} has no AndroidManifest.xml", checked.shown))?;
    let manifest = library_manifest::parse(&manifest)
        .with_context(|| format!("{}: read its AndroidManifest.xml", checked.shown))?;
    let package = manifest
        .attribute("package")
        .filter(|package| !package.is_empty())
        .with_context(|| format!("{}: its manifest names no package", checked.shown))?
        .to_owned();
    // Android's build writes one with the resources; without it, which of
    // the package's fields the code reads is unknown, and an `R` of all of
    // them would be every library's resources over again.
    if !res.is_empty() && r_txt.is_none() {
        bail!(
            "{} has resources (`res/`) but no R.txt, which lists those its code uses: \
             list an AAR as Android's build makes it",
            checked.shown
        );
    }
    Ok(Aar {
        checked,
        package,
        manifest,
        jars,
        native,
        assets,
        res,
        r_txt: r_txt.filter(|symbols| !symbols.is_empty()),
        min_compile_sdk,
    })
}

/// One AAR per library (manifest package): the app's own when it lists
/// one, which settles which version of it the package takes; two others
/// are an error naming both. (The same file twice was left out already.)
fn choose(aars: Vec<Aar>) -> anyhow::Result<Vec<Aar>> {
    let mut out: Vec<Aar> = Vec::new();
    for aar in aars {
        let Some(have) = out.iter().find(|have| have.package == aar.package) else {
            out.push(aar);
            continue;
        };
        // The app lists its own first.
        if have.checked.apps() && !aar.checked.apps() {
            continue;
        }
        let settle = if have.checked.apps() {
            "list one of them"
        } else {
            "list the one to package in nsh.json `android.libraries`"
        };
        bail!(
            "{} and {} are two versions of the library `{}`: {settle}",
            have.checked.shown,
            aar.checked.shown,
            aar.package
        );
    }
    Ok(out)
}

/// The native libraries of `native` for `abi`, which the package has:
/// (file name, contents), each name once. An AAR with native libraries but
/// none for `abi` is an error (its code would not load on such a device),
/// as is a library named as NSH's own.
pub(super) fn native_for<'a>(
    native: &'a [Native],
    abi: &str,
) -> anyhow::Result<Vec<(&'a str, &'a [u8])>> {
    let mut out: Vec<(&str, &[u8], &str)> = Vec::new();
    for library in native {
        let Some(files) = library.abis.get(abi) else {
            bail!(
                "{} has native libraries for {}, not for {abi}, which the package has: \
                 package the ABIs it has (`--abi`) or list a build of it for {abi}",
                library.from,
                library
                    .abis
                    .keys()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        };
        for (name, bytes) in files {
            if name == "libnsh.so" {
                bail!(
                    "{} has `jni/{abi}/libnsh.so`, the name of NSH's own library",
                    library.from
                );
            }
            match out.iter().find(|(have, ..)| *have == name) {
                None => out.push((name, bytes, &library.from)),
                Some((_, have, _)) if *have == bytes.as_slice() => {}
                Some((.., first)) => bail!(
                    "{first} and {} both have `{name}` for {abi}, with different contents: list one of them",
                    library.from
                ),
            }
        }
    }
    Ok(out
        .into_iter()
        .map(|(name, bytes, _)| (name, bytes))
        .collect())
}

/// Whether an asset goes into the package uncompressed: the kinds `aapt2`
/// leaves so, which are compressed already, and which an app opens as a
/// file descriptor (`AssetManager.openFd`) only when stored.
pub(super) fn stored_asset(path: &str) -> bool {
    const STORED: &[&str] = &[
        "jpg", "jpeg", "png", "gif", "webp", "wav", "mp2", "mp3", "ogg", "aac", "mpg", "mpeg",
        "mid", "midi", "smf", "jet", "rtttl", "imy", "xmf", "mp4", "m4a", "m4v", "3gp", "3gpp",
        "3g2", "3gpp2", "amr", "awb", "wma", "wmv", "webm", "mkv",
    ];
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| STORED.contains(&e.to_ascii_lowercase().as_str()))
}

/// The version of the SDK's build tools (`d8`, `aapt2`), which the cache
/// keys take.
fn build_tools_version(sdk: &Sdk) -> String {
    sdk.build_tools
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The directory `key` names in `apk.library_cache`, which `make` fills
/// when it is missing.
fn cached(
    apk: &Apk<'_>,
    key: &str,
    what: &str,
    make: impl FnOnce(&Path) -> anyhow::Result<()>,
) -> anyhow::Result<PathBuf> {
    let key = hex(&Sha256::digest(key));
    let dir = apk.library_cache.join(&key[..32]);
    if dir.join("done").exists() {
        return Ok(dir);
    }
    // Written aside and moved in whole: a run stopped half way, or another
    // one at the same time, leaves no partial entry.
    let partial = apk
        .library_cache
        .join(format!("{}.partial-{}", &key[..32], std::process::id()));
    if partial.exists() {
        fs::remove_dir_all(&partial)?;
    }
    fs::create_dir_all(&partial)?;
    if let Err(e) = make(&partial) {
        let _ = fs::remove_dir_all(&partial);
        return Err(e);
    }
    fs::write(partial.join("done"), b"")?;
    // Another run may have moved its own copy in meanwhile, the same
    // files, which it or a third run may be reading: keep it, never
    // remove it.
    if !dir.join("done").exists() && fs::rename(&partial, &dir).is_ok() {
        return Ok(dir);
    }
    let _ = fs::remove_dir_all(&partial);
    if !dir.join("done").exists() {
        bail!("could not keep {what} in {}", dir.display());
    }
    Ok(dir)
}

/// The directory of `jar`'s intermediate dex in the cache, made when
/// missing.
fn intermediate_dex(
    sdk: &Sdk,
    jar: &Checked,
    android_jar: &Path,
    apk: &Apk<'_>,
) -> anyhow::Result<PathBuf> {
    // `dex-v1`: what this makes; a change to the `d8` command takes a new
    // version, which leaves the entries of the old one unused.
    let key = format!(
        "dex-v1\0{}\0{}\0{MIN_SDK}\0{}\0{}",
        jar.sha256,
        build_tools_version(sdk),
        mode(apk.dev),
        apk.target_sdk
    );
    cached(apk, &key, &format!("the dex of {}", jar.shown), |out| {
        let output = intermediate_command(sdk, &jar.path, android_jar, apk.dev, out)
            .output()
            .context("run the SDK's d8 (is a JDK installed?)")?;
        if !output.status.success() {
            bail!(
                "{}: d8 could not read {}:\n{}",
                jar.listed,
                jar.shown,
                d8_message(&format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ))
            );
        }
        Ok(())
    })
}

/// Compiles the AARs' resources into `contents.res`, lowest priority first,
/// once NSH wrote its own under `own` ([`library_resources::left_out`]
/// leaves out a library's of the same names, with a warning).
pub(super) fn compile_res(
    sdk: &Sdk,
    apk: &Apk<'_>,
    contents: &mut Contents,
    own: &Path,
) -> anyhow::Result<()> {
    if contents.res_files.is_empty() {
        return Ok(());
    }
    let own = library_resources::generated(own)?;
    let mut compiled = Vec::new();
    for library in &contents.res_files {
        let left_out = library_resources::left_out(&own, &library.files)
            .map_err(|e| anyhow::anyhow!("{}: {e}", library.from))?;
        if !left_out.is_empty() {
            crate::ui::warn(format!(
                "{}: {} left out: NSH makes these resources for the package",
                library.from,
                left_out
                    .iter()
                    .map(|path| format!("`res/{path}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if left_out.len() == library.files.len() {
            continue;
        }
        let path = compiled_res(sdk, apk, library, &left_out)?;
        compiled.push((library.owner.clone(), path));
    }
    contents.res = library_resources::lowest_first(compiled);
    Ok(())
}

/// `library`'s resources but `left_out`, compiled by `aapt2 compile --dir`
/// (kept in `apk.library_cache` by the AAR's contents, what is left out and
/// the build tools' version), written out first when they are not.
fn compiled_res(
    sdk: &Sdk,
    apk: &Apk<'_>,
    library: &LibraryRes,
    left_out: &[String],
) -> anyhow::Result<PathBuf> {
    // `res-v1`: what this makes; a change to the `aapt2 compile` command
    // takes a new version.
    let key = format!(
        "res-v1\0{}\0{}\0{}",
        library.sha256,
        build_tools_version(sdk),
        left_out.join("\0")
    );
    let from = &library.from;
    let cache = cached(apk, &key, &format!("the resources of {from}"), |out| {
        let res = library.dir.join("res");
        for (path, bytes) in &library.files {
            if left_out.contains(path) {
                continue;
            }
            let file = res.join(path);
            fs::create_dir_all(file.parent().unwrap_or(&res))?;
            fs::write(&file, bytes)?;
        }
        let output = Command::new(sdk.tool("aapt2"))
            .arg("compile")
            .arg("--dir")
            .arg(&res)
            .arg("-o")
            .arg(out.join("res.zip"))
            .output()
            .context("run the SDK's aapt2")?;
        if !output.status.success() {
            bail!(
                "aapt2 could not compile the resources of {from}:\n{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        Ok(())
    })?;
    Ok(cache.join("res.zip"))
}

/// The `R` classes of `libraries` (package, `R.txt`, the AAR), their
/// fields the ids of `symbols`, compiled by the JDK's `javac` into a jar
/// in `work`. An `R.txt` lists the resources of the libraries an AAR was
/// built with as well: those no library listed defines are left out, with
/// one note, unless the code of `jars` reads them, which is an error.
fn r_classes(
    sdk: &Sdk,
    apk: &Apk<'_>,
    work: &Path,
    libraries: &[(String, Symbols, String)],
    jars: &[Checked],
    symbols: &Path,
) -> anyhow::Result<Checked> {
    let text = fs::read_to_string(symbols)
        .with_context(|| format!("read what aapt2 wrote to {}", symbols.display()))?;
    let linked = library_resources::parse_linked(&text)
        .map_err(|e| anyhow::anyhow!("read what aapt2 wrote to {}: {e}", symbols.display()))?;
    let packages = libraries.iter().map(|(p, _, _)| p.as_str()).collect();
    let mut reads = r_reads(jars, &packages)?;
    let dir = work.join("r");
    let sources = dir.join("src");
    let classes = dir.join("classes");
    fs::create_dir_all(&classes)?;
    let mut files = Vec::new();
    let mut errors = Vec::new();
    let (mut left_out, mut leaving_out) = (0, 0);
    for (package, wanted, from) in libraries {
        let read = reads.remove(package).unwrap_or_default();
        let (java, left) = match library_resources::r_java(package, wanted, &read, &linked) {
            Ok(r) => r,
            Err(found) => {
                errors.extend(found.into_iter().map(|e| format!("{from}: {e}")));
                continue;
            }
        };
        if left > 0 {
            left_out += left;
            leaving_out += 1;
        }
        let path = library_resources::r_java_path(&sources, package);
        fs::create_dir_all(path.parent().unwrap_or(&sources))?;
        fs::write(&path, java)?;
        files.push(path);
    }
    if !errors.is_empty() {
        bail!(
            "{}\nlist the Android libraries that define them",
            errors.join("\n")
        );
    }
    if left_out > 0 {
        crate::ui::note(format!(
            "left out of the `R` classes of {leaving_out} Android {}: {left_out} resources their R.txt \
             lists, which no library listed defines and no code reads",
            if leaving_out == 1 {
                "library"
            } else {
                "libraries"
            }
        ));
    }
    let output = Command::new(super::java_tool("javac"))
        .args(["--release", "11", "-encoding", "UTF-8", "-nowarn", "-d"])
        .arg(&classes)
        .arg("-classpath")
        .arg(sdk.android_jar(apk.target_sdk)?)
        .args(&files)
        .output()
        .context("run javac to compile the AARs' `R` classes (is a JDK installed?)")?;
    if !output.status.success() {
        bail!(
            "javac could not compile the AARs' `R` classes:\n{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let jar = dir.join("R.jar");
    write_jar(&classes, &jar)?;
    Ok(Checked {
        sha256: file_sha256(&jar)?,
        path: jar,
        listed: "the AARs' R.txt".to_owned(),
        shown: "the `R` classes of the AARs".to_owned(),
        owner: None,
        kind: Kind::Jar,
    })
}

/// What the classes of `jars` read of the `R` classes of `packages`: by
/// package, each field and the first class that reads it. A class file
/// that cannot be read is left out, with one warning a jar.
fn r_reads(
    jars: &[Checked],
    packages: &BTreeSet<&str>,
) -> anyhow::Result<BTreeMap<String, library_resources::Reads>> {
    let mut out: BTreeMap<String, library_resources::Reads> = BTreeMap::new();
    for jar in jars {
        let file = fs::File::open(&jar.path)
            .with_context(|| format!("{}: read {}", jar.listed, jar.shown))?;
        let mut archive = zip::ZipArchive::new(file)
            .with_context(|| format!("{}: {} is not a jar", jar.listed, jar.shown))?;
        let mut unread: Vec<(String, String)> = Vec::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let name = entry.name()?.into_owned();
            if entry.is_dir() || !name.ends_with(".class") {
                continue;
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            let (this, fields) = match class_file::field_refs(&bytes) {
                Ok(found) => found,
                Err(e) => {
                    unread.push((name, e));
                    continue;
                }
            };
            // An `R` class's own initializer sets every field it has.
            if library_resources::r_type(&this).is_some() {
                continue;
            }
            for field in fields {
                let Some((package, kind_of)) = library_resources::r_type(&field.class) else {
                    continue;
                };
                if packages.contains(package.as_str()) {
                    out.entry(package)
                        .or_default()
                        .entry((kind_of.to_owned(), field.name))
                        .or_insert_with(|| this.replace('/', "."));
                }
            }
        }
        if let Some((name, e)) = unread.first() {
            crate::ui::warn(format!(
                "{}: {} of its class files cannot be read, such as `{name}` ({e}): \
                 the `R` fields they read are not checked",
                jar.shown,
                unread.len()
            ));
        }
    }
    Ok(out)
}

/// A jar of the class files under `dir`, the same bytes for the same
/// classes, which keeps its dex in the cache.
fn write_jar(dir: &Path, jar: &Path) -> anyhow::Result<()> {
    fn add(dir: &Path, files: &mut Vec<PathBuf>) -> anyhow::Result<()> {
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            if path.is_dir() {
                add(&path, files)?;
            } else {
                files.push(path);
            }
        }
        Ok(())
    }
    let mut files = Vec::new();
    add(dir, &mut files)?;
    files.sort();
    let mut zip = zip::ZipWriter::new(fs::File::create(jar)?);
    let options = zip::write::SimpleFileOptions::default()
        .last_modified_time(zip::DateTime::default())
        .compression_method(zip::CompressionMethod::Deflated);
    for file in files {
        let name = file
            .strip_prefix(dir)?
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        zip.start_file(name, options)?;
        std::io::Write::write_all(&mut zip, &fs::read(&file)?)?;
    }
    zip.finish()?;
    Ok(())
}

fn mode(dev: bool) -> &'static str {
    if dev { "--debug" } else { "--release" }
}

/// `d8` on one jar: dex that a later run merges, desugared for the
/// runtime's minimum API level against the platform's `android.jar`.
fn intermediate_command(
    sdk: &Sdk,
    jar: &Path,
    android_jar: &Path,
    dev: bool,
    out: &Path,
) -> Command {
    let mut cmd = Command::new(sdk.tool("d8"));
    cmd.arg("--intermediate")
        .arg(mode(dev))
        .args(["--min-api", &MIN_SDK.to_string()])
        .arg("--lib")
        .arg(android_jar)
        .arg("--output")
        .arg(out)
        .arg(jar);
    cmd
}

/// `d8` merging the intermediate dex of every jar into `out`
/// (`classes.dex`, and more files when the methods do not fit one).
fn merge_command(sdk: &Sdk, inputs: &[PathBuf], dev: bool, out: &Path) -> Command {
    let mut cmd = Command::new(sdk.tool("d8"));
    cmd.arg(mode(dev))
        .args(["--min-api", &MIN_SDK.to_string()])
        .arg("--output")
        .arg(out)
        .args(inputs);
    cmd
}

/// The dex files `d8` wrote to `dir`, in their order: `classes.dex`,
/// `classes2.dex`, ...
fn dex_files(dir: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut files: Vec<(u32, PathBuf)> = Vec::new();
    for entry in fs::read_dir(dir).with_context(|| format!("read {}", dir.display()))? {
        let path = entry?.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(number) = name
            .strip_prefix("classes")
            .and_then(|n| n.strip_suffix(".dex"))
        else {
            continue;
        };
        let number = if number.is_empty() {
            1
        } else {
            match number.parse() {
                Ok(n) => n,
                Err(_) => continue,
            }
        };
        files.push((number, path));
    }
    files.sort();
    Ok(files.into_iter().map(|(_, path)| path).collect())
}

/// What `d8` printed, without the Java stack trace that follows its error.
fn d8_message(output: &str) -> String {
    output
        .lines()
        .take_while(|line| !line.starts_with("Exception in thread"))
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The error of the merging `d8` run, about the libraries: a class two of
/// them define names both files and who lists them, not the intermediate
/// dex `d8` saw.
fn merge_error(output: &str, intermediate: &[(PathBuf, &Checked)]) -> String {
    let library = |path: &str| {
        intermediate
            .iter()
            .find(|(dex, _)| dex.to_string_lossy() == path.trim())
            .map(|(_, library)| library.shown.clone())
    };
    let mut twice = Vec::new();
    for line in output.lines() {
        let Some((class, files)) = line
            .trim()
            .strip_prefix("Type ")
            .and_then(|rest| rest.split_once(" is defined multiple times: "))
        else {
            continue;
        };
        let files: Vec<String> = files
            .split(", ")
            .map(|path| library(path).unwrap_or_else(|| path.trim().to_owned()))
            .collect();
        let line = format!("`{class}` is in {}", files.join(" and "));
        if !twice.contains(&line) {
            twice.push(line);
        }
    }
    if !twice.is_empty() {
        return format!(
            "the Java libraries define a class more than once:\n{}\nlist one of the files that define it",
            twice.join("\n")
        );
    }
    let mut message = d8_message(output);
    for (dex, library) in intermediate {
        message = message.replace(&*dex.to_string_lossy(), &library.shown);
    }
    format!("d8 could not merge the Java libraries:\n{message}")
}

/// Entries of a jar that are no Java resource of the app: its manifest
/// and signature, and the license and build files Android's Gradle plugin
/// leaves out as well, of which every library has its own.
fn left_out(name: &str) -> bool {
    let Some(meta) = name.strip_prefix("META-INF/") else {
        return false;
    };
    if meta.contains('/') {
        return ["maven/", "proguard/", "com.android.tools/"]
            .iter()
            .any(|dir| meta.starts_with(dir));
    }
    let upper = meta.to_ascii_uppercase();
    upper == "MANIFEST.MF"
        || upper == "INDEX.LIST"
        || upper.starts_with("SIG-")
        || [".SF", ".RSA", ".DSA", ".EC"]
            .iter()
            .any(|e| upper.ends_with(e))
        || ["LICENSE", "NOTICE", "DEPENDENCIES", "AL2.0", "LGPL2.1"]
            .iter()
            .any(|n| upper == *n || upper.starts_with(&format!("{n}.")))
}

/// The Java resources of jars ([`java_resources`]).
#[derive(Debug, Default)]
struct JavaResources {
    /// At the package's root: (path, contents).
    root: Vec<(String, Vec<u8>)>,
    /// Under `assets/`: (path under it, contents, the jar).
    assets: Vec<(String, Vec<u8>, String)>,
}

/// Paths at a package's root that are the package's own.
fn reserved(name: &str) -> bool {
    ["lib/", "res/", "dex/", "manifest/", "root/"]
        .iter()
        .any(|dir| name.starts_with(dir))
        || matches!(name, "AndroidManifest.xml" | "resources.arsc")
        || (!name.contains('/') && name.starts_with("classes") && name.ends_with(".dex"))
}

/// The Java resources of `jars`: every file but classes and what
/// [`left_out`] names, each path once. Service files
/// (`META-INF/services/<interface>`) of several jars are joined, as
/// `ServiceLoader` reads every provider they list; another path two jars
/// have with different contents is an error naming both. Those under
/// `assets/` are the package's assets, as at the root of an APK, where
/// Android's Gradle plugin puts Java resources.
fn java_resources(jars: &[&Checked]) -> anyhow::Result<JavaResources> {
    let mut out: Vec<(String, Vec<u8>)> = Vec::new();
    let mut assets = Vec::new();
    // Each path's index in `out`, and the jar it came from.
    let mut seen: BTreeMap<String, (usize, &Checked)> = BTreeMap::new();
    for jar in jars {
        let file = fs::File::open(&jar.path)
            .with_context(|| format!("{}: read {}", jar.listed, jar.shown))?;
        let mut archive = zip::ZipArchive::new(file)
            .with_context(|| format!("{}: {} is not a jar", jar.listed, jar.shown))?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            if entry.is_dir() {
                continue;
            }
            let name = entry.name()?.into_owned();
            if name.ends_with(".class") || left_out(&name) {
                continue;
            }
            if let Some(path) = asset_path(&jar.shown, &name)? {
                let mut bytes = Vec::new();
                entry.read_to_end(&mut bytes)?;
                assets.push((path, bytes, jar.shown.clone()));
                continue;
            }
            if entry.enclosed_name().is_none() || reserved(&name) {
                bail!(
                    "{}: {} has `{name}`, a path the package keeps for its own files",
                    jar.listed,
                    jar.shown
                );
            }
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes)?;
            match seen.get(&name) {
                None => {
                    seen.insert(name.clone(), (out.len(), jar));
                    out.push((name, bytes));
                }
                Some((at, _)) if out[*at].1 == bytes => {}
                Some((at, _)) if name.starts_with("META-INF/services/") => {
                    let have = &mut out[*at].1;
                    if !have.ends_with(b"\n") {
                        have.push(b'\n');
                    }
                    have.extend_from_slice(&bytes);
                }
                Some((_, first)) => bail!(
                    "{} and {} both have `{name}`, with different contents: list one of them",
                    first.shown,
                    jar.shown
                ),
            }
        }
    }
    Ok(JavaResources { root: out, assets })
}

/// The SHA-256 of `path`'s contents, in hex.
pub(crate) fn file_sha256(path: &Path) -> anyhow::Result<String> {
    Ok(hex(&Sha256::digest(fs::read(path)?)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::*;

    fn dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nsh-cli-android-libraries-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A jar (or an AAR) at `path` with `entries` (name, contents).
    fn jar(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, bytes) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn library(path: &Path, listed: &str) -> Library {
        Library {
            path: path.to_owned(),
            listed: listed.to_owned(),
            owner: listed
                .split_once(": ")
                .filter(|_| listed != NSH_JSON)
                .map(|(name, _)| name.to_owned()),
        }
    }

    /// `library(path, listed)`, checked.
    fn checked_file(path: &Path, listed: &str) -> Checked {
        Checked {
            path: path.to_owned(),
            listed: listed.to_owned(),
            shown: library(path, listed).describe(),
            owner: library(path, listed).owner,
            kind: Kind::Jar,
            sha256: String::new(),
        }
    }

    #[test]
    fn kinds_go_by_extension_and_name_who_lists_them() {
        let kind = |name: &str| {
            library(
                Path::new(name),
                "scanner: [package.metadata.nsh] `android.libraries`",
            )
            .kind()
        };
        assert_eq!(kind("libs/sdk.jar").unwrap(), Kind::Jar);
        assert_eq!(kind("libs/SDK.JAR").unwrap(), Kind::Jar);
        assert_eq!(kind("java/classes.dex").unwrap(), Kind::Dex);
        assert_eq!(kind("libs/sdk.aar").unwrap(), Kind::Aar);
        let other = kind("libs/sdk.zip").unwrap_err().to_string();
        assert!(
            other.starts_with("scanner: [package.metadata.nsh] `android.libraries`: libs/sdk.zip")
                && other.contains("neither a jar"),
            "{other}"
        );
        assert!(kind("libs/sdk").is_err());
    }

    #[test]
    fn missing_and_false_files_are_errors_and_copies_go_once() {
        let dir = dir("checked");
        let a = dir.join("a.jar");
        let b = dir.join("sub/b.jar");
        fs::create_dir_all(b.parent().unwrap()).unwrap();
        jar(&a, &[("x/A.class", b"a")]);
        fs::copy(&a, &b).unwrap();
        let listed = [
            library(&a, NSH_JSON),
            library(&b, "scanner: [package.metadata.nsh] `android.libraries`"),
        ];
        // The same contents, from two places: one library.
        let checked_ = checked(&listed).unwrap();
        assert_eq!(checked_.len(), 1);
        assert_eq!(checked_[0].path, a);
        assert!(checked_[0].apps());
        // A missing file names who lists it.
        let missing = [library(
            &dir.join("gone.jar"),
            "scanner: [package.metadata.nsh.features.scan] `android.libraries`",
        )];
        let error = checked(&missing).err().unwrap().to_string();
        assert!(
            error.starts_with(
                "scanner: [package.metadata.nsh.features.scan] `android.libraries`: read "
            ) && error.contains("gone.jar"),
            "{error}"
        );
        // A dex file that is no dex fails the build, not a class lookup on
        // the device.
        let fake = dir.join("fake.dex");
        fs::write(&fake, b"PK\x03\x04 a jar").unwrap();
        let error = checked(&[library(&fake, NSH_JSON)])
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("is not a dex file"), "{error}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn d8_turns_each_jar_into_intermediate_dex_then_merges() {
        let sdk = Sdk {
            root: PathBuf::from("/sdk"),
            build_tools: PathBuf::from("/sdk/build-tools/36.1.0"),
        };
        let args = |cmd: &Command| {
            cmd.get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let one = intermediate_command(
            &sdk,
            Path::new("/app/libs/sdk.jar"),
            Path::new("/sdk/platforms/android-35/android.jar"),
            false,
            Path::new("/cache/key"),
        );
        let d8 = if cfg!(windows) { "d8.bat" } else { "d8" };
        assert_eq!(one.get_program(), sdk.build_tools.join(d8));
        assert_eq!(
            args(&one),
            [
                "--intermediate",
                "--release",
                "--min-api",
                "26",
                "--lib",
                "/sdk/platforms/android-35/android.jar",
                "--output",
                "/cache/key",
                "/app/libs/sdk.jar",
            ]
        );
        let merge = merge_command(
            &sdk,
            &[
                PathBuf::from("/cache/a/classes.dex"),
                PathBuf::from("/cache/b/classes.dex"),
            ],
            true,
            Path::new("/work/libraries-dex"),
        );
        assert_eq!(
            args(&merge),
            [
                "--debug",
                "--min-api",
                "26",
                "--output",
                "/work/libraries-dex",
                "/cache/a/classes.dex",
                "/cache/b/classes.dex",
            ]
        );
    }

    #[test]
    fn a_class_defined_twice_names_the_libraries() {
        let a = checked_file(
            Path::new("/work/scanner/libs/glue.jar"),
            "scanner: [package.metadata.nsh] `android.libraries`",
        );
        let b = checked_file(Path::new("/app/libs/glue-copy.jar"), NSH_JSON);
        let intermediate = [
            (PathBuf::from("/cache/aaaa/classes.dex"), &a),
            (PathBuf::from("/cache/bbbb/classes.dex"), &b),
        ];
        // As d8 prints it.
        let output = "Error in /cache/bbbb/classes.dex:\n\
            Type com.example.glue.Hello is defined multiple times: /cache/bbbb/classes.dex, /cache/aaaa/classes.dex\n\
            Compilation failed\n\
            Exception in thread \"main\" java.lang.RuntimeException: ...\n\
            Caused by: com.android.tools.r8.internal.g: Type com.example.glue.Hello is defined multiple times: /cache/bbbb/classes.dex, /cache/aaaa/classes.dex\n";
        let error = merge_error(output, &intermediate);
        assert_eq!(
            error,
            "the Java libraries define a class more than once:\n\
             `com.example.glue.Hello` is in /app/libs/glue-copy.jar (nsh.json `android.libraries`) and \
             /work/scanner/libs/glue.jar (scanner: [package.metadata.nsh] `android.libraries`)\n\
             list one of the files that define it"
        );
        // Another error: d8's words, without the stack trace, about the
        // libraries.
        let error = merge_error(
            "Error in /cache/aaaa/classes.dex:\nSomething else\nException in thread \"main\" x\n\tat y",
            &intermediate,
        );
        assert!(error.contains("glue.jar (scanner:"), "{error}");
        assert!(
            !error.contains("Exception") && !error.contains("/cache/"),
            "{error}"
        );
    }

    #[test]
    fn dex_files_are_in_their_order() {
        let dir = dir("order");
        for name in [
            "classes10.dex",
            "classes2.dex",
            "classes.dex",
            "other.txt",
            "classesx.dex",
        ] {
            fs::write(dir.join(name), b"").unwrap();
        }
        let names: Vec<String> = dex_files(&dir)
            .unwrap()
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["classes.dex", "classes2.dex", "classes10.dex"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_r_fields_classes_read_are_found_in_their_jars() {
        use super::class_file::tests::class_file;
        let dir = dir("r-reads");
        let classes = dir.join("classes.jar");
        let vendor = dir.join("vendor.jar");
        let banner = class_file(
            "com/example/push/Banner",
            &[
                ("com/example/push/R$string", "title", "I"),
                ("com/example/push/R$styleable", "Banner", "[I"),
                ("com/example/push/R$styleable", "Banner_tint", "I"),
                // Another library's `R`, which the package has none of.
                ("com/example/other/R$string", "x", "I"),
                ("com/example/push/Config", "level", "I"),
            ],
        );
        // An `R` class in the jar: its initializer sets its own fields.
        let r = class_file(
            "com/example/push/R$anim",
            &[("com/example/push/R$anim", "abc_fade_in", "I")],
        );
        jar(
            &classes,
            &[
                ("com/example/push/Banner.class", &banner),
                ("com/example/push/R$anim.class", &r),
                ("com/example/push/broken.class", b"\xca\xfe\xba\xbe\0"),
                ("com/example/push/notes.txt", b"x"),
            ],
        );
        let menu = class_file(
            "com/vendor/Menu",
            &[("com/example/push/R$anim", "abc_fade_in", "I")],
        );
        jar(&vendor, &[("com/vendor/Menu.class", &menu)]);
        let jars = [checked_file(&classes, CRATE), checked_file(&vendor, CRATE)];
        let reads = r_reads(&jars, &BTreeSet::from(["com.example.push"])).unwrap();
        let found: Vec<String> = reads
            .iter()
            .flat_map(|(package, fields)| {
                fields
                    .iter()
                    .map(move |((k, n), by)| format!("{package} {k}.{n} {by}"))
            })
            .collect();
        assert_eq!(
            found,
            [
                "com.example.push anim.abc_fade_in com.vendor.Menu",
                "com.example.push string.title com.example.push.Banner",
                "com.example.push styleable.Banner com.example.push.Banner",
                "com.example.push styleable.Banner_tint com.example.push.Banner",
            ]
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn jars_bring_their_java_resources() {
        let dir = dir("resources");
        let a = dir.join("a.jar");
        let b = dir.join("b.jar");
        jar(
            &a,
            &[
                ("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\n"),
                ("META-INF/SIGNER.SF", b"sig"),
                ("META-INF/SIGNER.RSA", b"sig"),
                ("META-INF/LICENSE.txt", b"license a"),
                ("META-INF/maven/a/a/pom.xml", b"<project/>"),
                (
                    "META-INF/services/com.example.Greeter",
                    b"com.example.a.Hello\n",
                ),
                ("com/example/a/Hello.class", b"class"),
                ("com/example/a/messages.properties", b"hi=a"),
                ("assets/sdk/plugin.properties", b"a=1"),
                (
                    "kotlin/collections/collections.kotlin_builtins",
                    b"builtins",
                ),
            ],
        );
        jar(
            &b,
            &[
                ("META-INF/LICENSE.txt", b"license b"),
                ("assets/sdk/plugin.properties", b"a=1"),
                (
                    "META-INF/services/com.example.Greeter",
                    b"com.example.b.Hello",
                ),
                (
                    "kotlin/collections/collections.kotlin_builtins",
                    b"builtins",
                ),
            ],
        );
        let (la, lb) = (
            checked_file(&a, NSH_JSON),
            checked_file(&b, "x: [package.metadata.nsh] `android.libraries`"),
        );
        let JavaResources {
            root: resources,
            assets,
        } = java_resources(&[&la, &lb]).unwrap();
        let names: Vec<&str> = resources.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "META-INF/services/com.example.Greeter",
                "com/example/a/messages.properties",
                "kotlin/collections/collections.kotlin_builtins",
            ]
        );
        // Both jars' providers.
        assert_eq!(resources[0].1, b"com.example.a.Hello\ncom.example.b.Hello");
        // Under `assets/`: assets, as at the root of an APK Android's
        // Gradle plugin makes, the same in both jars.
        let assets: Vec<String> = assets
            .iter()
            .map(|(path, bytes, from)| format!("{path} {} {from}", String::from_utf8_lossy(bytes)))
            .collect();
        assert_eq!(
            assets,
            [
                format!("sdk/plugin.properties a=1 {}", la.shown),
                format!("sdk/plugin.properties a=1 {}", lb.shown),
            ]
        );
        // Another file the two have with different contents: an error
        // naming both.
        jar(&b, &[("com/example/a/messages.properties", b"hi=b")]);
        let error = java_resources(&[&la, &lb]).unwrap_err().to_string();
        assert!(
            error.contains("a.jar (nsh.json `android.libraries`) and")
                && error.contains("b.jar (x: [package.metadata.nsh] `android.libraries`)")
                && error.contains("`com/example/a/messages.properties`"),
            "{error}"
        );
        // A path the package keeps for its own files.
        for (name, error) in [
            ("lib/arm64-v8a/libx.so", "keeps for its own files"),
            ("classes2.dex", "keeps for its own files"),
            ("AndroidManifest.xml", "keeps for its own files"),
            ("assets/nsh/bundle.nshc", "`assets/nsh/` is NSH's own"),
            (
                "assets/../classes.dex",
                "an asset path with an empty, `.` or `..` part",
            ),
        ] {
            jar(&b, &[(name, b"x")]);
            let found = java_resources(&[&lb]).unwrap_err().to_string();
            assert!(
                found.contains(&lb.shown) && found.contains(error),
                "{name}: {found}"
            );
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_asset_goes_in_once_from_an_aar_or_a_jar() {
        let mut contents = Contents::default();
        let add = |contents: &mut Contents, bytes: &[u8], from: &str| {
            contents.add_asset("sdk/plugin.properties".into(), bytes.to_vec(), from)
        };
        add(
            &mut contents,
            b"a=1",
            "push.aar (nsh.json `android.libraries`)",
        )
        .unwrap();
        // The same contents: once.
        add(&mut contents, b"a=1", "`classes.jar` of push.aar").unwrap();
        assert_eq!(
            contents.assets,
            [("sdk/plugin.properties".into(), b"a=1".to_vec())]
        );
        let error = add(
            &mut contents,
            b"a=2",
            "vendor.jar (nsh.json `android.libraries`)",
        )
        .unwrap_err()
        .to_string();
        assert_eq!(
            error,
            "push.aar (nsh.json `android.libraries`) and vendor.jar (nsh.json `android.libraries`) \
             both have the asset `sdk/plugin.properties`, with different contents: list one of them"
        );
    }

    /// The manifest of an AAR of `package`, with `application`'s children.
    fn aar_manifest(package: &str, application: &str) -> Vec<u8> {
        format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}">
    <uses-sdk android:minSdkVersion="21" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.INTERNET" />
    <application>{application}</application>
</manifest>"#
        )
        .into_bytes()
    }

    const CRATE: &str = "push: [package.metadata.nsh] `android.libraries`";

    #[test]
    fn an_aar_brings_its_classes_native_libraries_assets_and_manifest() {
        let dir = dir("aar");
        let path = dir.join("push.aar");
        let manifest = aar_manifest(
            "com.example.push",
            r#"<provider android:name=".PushInit" android:authorities="${applicationId}.push-init" android:exported="false" />"#,
        );
        jar(
            &path,
            &[
                ("AndroidManifest.xml", &manifest),
                ("classes.jar", b"classes"),
                ("libs/vendor.jar", b"vendor"),
                ("libs/deeper/not.jar", b"x"),
                ("jni/arm64-v8a/libpush.so", b"arm64"),
                ("jni/x86_64/libpush.so", b"x86_64"),
                ("jni/arm64-v8a/notes.txt", b"x"),
                ("assets/push/config.json", b"{}"),
                ("R.txt", b""),
                ("proguard.txt", b"-keep class x"),
                ("lint.jar", b"lint"),
                (AAR_METADATA, b"aarFormatVersion=1.0\nminCompileSdk=34\n"),
            ],
        );
        let aar = read_aar(checked(&[library(&path, CRATE)]).unwrap().remove(0)).unwrap();
        assert_eq!(aar.package, "com.example.push");
        let jars: Vec<&str> = aar.jars.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(jars, ["classes.jar", "libs/vendor.jar"]);
        let abis: Vec<&str> = aar.native.keys().map(String::as_str).collect();
        assert_eq!(abis, ["arm64-v8a", "x86_64"]);
        assert_eq!(
            aar.native["arm64-v8a"],
            [("libpush.so".into(), b"arm64".to_vec())]
        );
        assert_eq!(aar.assets, [("push/config.json".into(), b"{}".to_vec())]);
        assert_eq!(aar.min_compile_sdk, Some(34));
        // An empty R.txt: its code reads no `R` field.
        assert!(aar.res.is_empty() && aar.r_txt.is_none());
        // Its resources, and the `R` fields its code reads.
        jar(
            &path,
            &[
                ("AndroidManifest.xml", &manifest),
                ("res/values/values.xml", b"<resources/>"),
                ("R.txt", b"int string push_title 0x7f0b0001\n"),
            ],
        );
        let aar = read_aar(checked(&[library(&path, CRATE)]).unwrap().remove(0)).unwrap();
        assert_eq!(
            aar.res,
            [("values/values.xml".into(), b"<resources/>".to_vec())]
        );
        let symbols: Vec<&(String, String)> = aar.r_txt.as_ref().unwrap().keys().collect();
        assert_eq!(symbols, [&("string".into(), "push_title".into())]);
        // Two that one would overwrite on a file system ignoring case.
        jar(
            &path,
            &[
                ("AndroidManifest.xml", &manifest),
                ("res/drawable/logo.png", b"a"),
                ("res/drawable/Logo.png", b"b"),
                ("R.txt", b""),
            ],
        );
        let found = read_aar(checked(&[library(&path, CRATE)]).unwrap().remove(0))
            .err()
            .unwrap()
            .to_string();
        assert!(
            found.contains(
                "has `res/drawable/logo.png` and `res/drawable/Logo.png`, whose paths differ only in case"
            ),
            "{found}"
        );
        // What the package cannot take, or that is NSH's.
        for (entry, error) in [
            (
                "res/values/values.xml",
                "has resources (`res/`) but no R.txt, which lists those its code uses",
            ),
            (
                "res/../classes.dex",
                "a resource path with an empty, `.` or `..` part",
            ),
            ("R.txt", "its R.txt, line 1: `x` is no symbol"),
            ("assets/nsh/bundle.nshc", "`assets/nsh/` is NSH's own"),
            (
                "assets/../classes.dex",
                "an asset path with an empty, `.` or `..` part",
            ),
            (
                "assets/a/./b.txt",
                "an asset path with an empty, `.` or `..` part",
            ),
            (
                "assets/a//b.txt",
                "an asset path with an empty, `.` or `..` part",
            ),
        ] {
            jar(&path, &[("AndroidManifest.xml", &manifest), (entry, b"x")]);
            let found = read_aar(checked(&[library(&path, CRATE)]).unwrap().remove(0))
                .err()
                .unwrap()
                .to_string();
            assert!(
                found.starts_with(&format!("{} ({CRATE})", path.display()))
                    && found.contains(error),
                "{found}"
            );
        }
        jar(&path, &[("classes.jar", b"x")]);
        let found = read_aar(checked(&[library(&path, CRATE)]).unwrap().remove(0))
            .err()
            .unwrap()
            .to_string();
        assert!(found.contains("has no AndroidManifest.xml"), "{found}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn one_version_of_an_aar_goes_in_and_the_app_settles_which() {
        let dir = dir("aar-versions");
        let aar = |name: &str, package: &str, asset: &[u8], listed: &str| {
            let path = dir.join(name);
            jar(
                &path,
                &[
                    ("AndroidManifest.xml", &aar_manifest(package, "")),
                    ("assets/version.txt", asset),
                ],
            );
            library(&path, listed)
        };
        let chosen = |libraries: &[Library]| -> anyhow::Result<Vec<String>> {
            let aars = checked(libraries)?
                .into_iter()
                .map(read_aar)
                .collect::<anyhow::Result<Vec<_>>>()?;
            Ok(choose(aars)?
                .into_iter()
                .map(|aar| aar.checked.shown)
                .collect())
        };
        let other = "maps: [package.metadata.nsh] `android.libraries`";
        let one = aar("core-1.aar", "androidx.core", b"1", CRATE);
        let same = aar("core-1-copy.aar", "androidx.core", b"1", other);
        let two = aar("core-2.aar", "androidx.core", b"2", other);
        let apps = aar("core-3.aar", "androidx.core", b"3", NSH_JSON);
        let maps = aar("maps.aar", "com.example.maps", b"m", other);
        // The same file twice: once.
        assert_eq!(chosen(&[one.clone(), same, maps.clone()]).unwrap().len(), 2);
        // Two versions from crates: an error naming both.
        let error = chosen(&[one.clone(), two.clone()]).unwrap_err().to_string();
        assert!(
            error.contains("core-1.aar (push:")
                && error.contains("core-2.aar (maps:")
                && error.contains("two versions of the library `androidx.core`")
                && error.contains("list the one to package in nsh.json `android.libraries`"),
            "{error}"
        );
        // The app's own wins.
        let found = chosen(&[apps.clone(), one, two, maps]).unwrap();
        assert_eq!(found.len(), 2);
        assert!(found[0].contains("core-3.aar (nsh.json"), "{found:?}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn native_libraries_go_per_abi_the_package_has() {
        let native = |from: &str, abis: &[(&str, &str, &[u8])]| {
            let mut map: BTreeMap<String, Vec<(String, Vec<u8>)>> = BTreeMap::new();
            for (abi, name, bytes) in abis {
                map.entry((*abi).into())
                    .or_default()
                    .push(((*name).into(), bytes.to_vec()));
            }
            Native {
                from: from.into(),
                abis: map,
            }
        };
        let libraries = [
            native(
                "push.aar",
                &[
                    ("arm64-v8a", "libpush.so", b"a"),
                    ("x86_64", "libpush.so", b"x"),
                    ("arm64-v8a", "libc++_shared.so", b"c"),
                ],
            ),
            native("maps.aar", &[("arm64-v8a", "libc++_shared.so", b"c")]),
        ];
        let names = |abi: &str| -> anyhow::Result<Vec<String>> {
            Ok(native_for(&libraries, abi)?
                .into_iter()
                .map(|(name, _)| name.to_owned())
                .collect())
        };
        assert_eq!(
            names("arm64-v8a").unwrap(),
            ["libpush.so", "libc++_shared.so"]
        );
        // An ABI the package has and a library has not.
        let error = names("x86_64").unwrap_err().to_string();
        assert!(
            error.starts_with("maps.aar has native libraries for arm64-v8a, not for x86_64"),
            "{error}"
        );
        // Two libraries of one name.
        let clash = [
            native("push.aar", &[("arm64-v8a", "libc++_shared.so", b"1")]),
            native("maps.aar", &[("arm64-v8a", "libc++_shared.so", b"2")]),
        ];
        let error = native_for(&clash, "arm64-v8a").unwrap_err().to_string();
        assert!(
            error.contains("push.aar and maps.aar both have `libc++_shared.so` for arm64-v8a"),
            "{error}"
        );
        let nsh = [native("push.aar", &[("arm64-v8a", "libnsh.so", b"1")])];
        let error = native_for(&nsh, "arm64-v8a").unwrap_err().to_string();
        assert!(error.contains("the name of NSH's own library"), "{error}");
        assert!(stored_asset("sounds/ding.OGG") && !stored_asset("config.json"));
    }
}
