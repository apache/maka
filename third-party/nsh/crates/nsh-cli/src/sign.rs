//! Signed packages: `nsh keygen`, `nsh certify`, `nsh publish`,
//! `nsh verify` and `nsh revoke` (see `nsh_package` for the trust model).

use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
};

use anyhow::{Context as _, bail};
use nsh_package::{
    App, Certificate, Contents, PublicKey, Revocations, SecretKey, TrustStore, build, certify,
    revoke, verify_signature,
};

fn read_secret(path: &Path) -> anyhow::Result<SecretKey> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    SecretKey::from_base64(&text).with_context(|| format!("{}", path.display()))
}

fn read_public(path: &Path) -> anyhow::Result<PublicKey> {
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    PublicKey::from_base64(&text).with_context(|| format!("{}", path.display()))
}

fn write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    fs::write(path, bytes).with_context(|| format!("write {}", path.display()))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// `nsh keygen <name>`: `<name>.secret` (readable by the owner only) and
/// `<name>.pub`. Never overwrites a key.
pub(crate) fn keygen(name: &Path) -> anyhow::Result<()> {
    let secret_path = name.with_extension("secret");
    let public_path = name.with_extension("pub");
    for path in [&secret_path, &public_path] {
        if path.exists() {
            bail!("{} exists; keys are never overwritten", path.display());
        }
    }
    if let Some(dir) = name.parent().filter(|d| !d.as_os_str().is_empty()) {
        fs::create_dir_all(dir)?;
    }
    let key = SecretKey::generate()?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options
        .open(&secret_path)
        .with_context(|| format!("create {}", secret_path.display()))?;
    writeln!(file, "{}", key.to_base64())?;
    write(
        &public_path,
        format!("{}\n", key.public().to_base64()).as_bytes(),
    )?;
    println!(
        "key {}: {} (keep it secret), {}",
        key.public().id(),
        secret_path.display(),
        public_path.display()
    );
    Ok(())
}

/// `nsh certify`: the root certifies a release key for app ids, for `days`
/// from now.
pub(crate) fn certify_key(
    root: &Path,
    key: &Path,
    apps: &[String],
    days: u64,
    out: &Path,
) -> anyhow::Result<()> {
    if apps.is_empty() {
        bail!("name the app ids the key may sign for (--apps com.example.*)");
    }
    let root = read_secret(root)?;
    let key = read_public(key)?;
    let from = now();
    let cert = certify(&root, &key, apps, from, from + days * 86_400);
    write(out, cert.to_json().as_bytes())?;
    println!(
        "{}: key {} certified by root {} for {} until {} days from now",
        out.display(),
        key.id(),
        root.public().id(),
        apps.join(", "),
        days
    );
    Ok(())
}

/// Where `nsh publish` puts the bundle's source map.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum SourceMapOut {
    /// In the package: devices map error stacks to the app's sources.
    Package,
    /// In `<package>.map`, next to the package.
    File,
    /// Nowhere.
    #[value(name = "none")]
    Omit,
}

/// Options of `nsh publish`.
pub(crate) struct PublishOptions<'a> {
    pub(crate) entry: &'a Path,
    pub(crate) key: &'a Path,
    pub(crate) cert: &'a Path,
    pub(crate) out: Option<PathBuf>,
    pub(crate) config: crate::package::AppConfig,
    pub(crate) source_map: SourceMapOut,
    /// Without line tables (`nsh_js::Strip::All`).
    pub(crate) strip_debug: bool,
}

/// `nsh publish`: a release build of the app, signed into a `.nshpkg`.
pub(crate) fn publish(options: PublishOptions<'_>) -> anyhow::Result<()> {
    let entry = dunce::canonicalize(options.entry)?;
    let config = &options.config;
    let (name, id) = crate::package::release_name_and_id(&entry, config)?;
    let Some(build_number) = config.build else {
        bail!(
            "a package needs a build number (nsh.json `build` or --build): older builds are refused once a newer one was installed"
        );
    };
    if let Some(min) = &config.min_runtime {
        nsh_package::check_min_runtime(min).map_err(anyhow::Error::msg)?;
    }
    let key = read_secret(options.key)?;
    let cert_path = options.cert;
    let cert = Certificate::from_json(
        &fs::read_to_string(cert_path).with_context(|| format!("read {}", cert_path.display()))?,
    )?;

    // The line tables stay unless asked otherwise: the package carries the
    // bundle's source anyway, and without them reported stacks have no
    // positions to map.
    let strip = if options.strip_debug {
        nsh_js::Strip::All
    } else {
        nsh_js::Strip::Source
    };
    let mut built =
        crate::build::compile_release(&entry, strip).map_err(|e| e.into_error(&entry))?;
    crate::ui::done(format!(
        "built {} {}",
        crate::ui::path(&entry),
        built.summary("")
    ));
    let mut assets = Vec::with_capacity(built.assets.len());
    for asset in &built.assets {
        let bytes = fs::read(&asset.source).with_context(|| format!("read {}", asset.path))?;
        assets.push((asset.path.clone(), bytes));
    }
    let separate_map = match options.source_map {
        SourceMapOut::Package => None,
        SourceMapOut::File => built.source_map.take(),
        SourceMapOut::Omit => {
            built.source_map = None;
            None
        }
    };
    let contents = Contents {
        app: App {
            id: id.clone(),
            name,
            version: config.version.clone().unwrap_or_else(|| "1.0.0".to_owned()),
            build: build_number.into(),
        },
        capabilities: built.capabilities.as_ref().map(|c| c.to_json()),
        source: built.code,
        bytecode: Some((built.bytecode, nsh_js::BYTECODE_VERSION.to_owned())),
        source_map: built.source_map,
        assets,
        min_runtime: config.min_runtime.clone(),
    };
    let bytes = build(&contents, &key, &cert)?;
    let out = options
        .out
        .unwrap_or_else(|| default_out(&id, build_number));
    write(&out, &bytes)?;
    if let Some(map) = &separate_map {
        let path = map_path(&out);
        write(&path, map.as_bytes())?;
        crate::ui::done(format!(
            "wrote the source map to {} ({})",
            crate::ui::path(&path),
            crate::ui::bytes(map.len())
        ));
    }
    println!(
        "{}: {} {} (build {}), {} assets, {} KB, signed by {}, for runtime {} or newer",
        out.display(),
        id,
        contents.app.version,
        build_number,
        contents.assets.len(),
        bytes.len().div_ceil(1024),
        key.public().id(),
        contents
            .min_runtime
            .as_deref()
            .unwrap_or(nsh_package::RUNTIME_VERSION)
    );
    Ok(())
}

/// Whether `nsh publish` was given a package to sign again, not an app.
pub(crate) fn is_package(entry: &Path) -> bool {
    entry.extension().is_some_and(|e| e == "nshpkg")
}

/// Where `nsh publish` writes a package unless told otherwise.
fn default_out(id: &str, build: impl std::fmt::Display) -> PathBuf {
    PathBuf::from(".nsh/out").join(format!("{id}-{build}.nshpkg"))
}

/// `nsh publish <package>`: `package` signed again with another release key,
/// its contents unchanged (`nsh_package::resign`).
pub(crate) fn resign(
    package: &Path,
    key: &Path,
    cert: &Path,
    out: Option<PathBuf>,
) -> anyhow::Result<()> {
    let bytes = fs::read(package).with_context(|| format!("read {}", package.display()))?;
    let key = read_secret(key)?;
    let cert = Certificate::from_json(
        &fs::read_to_string(cert).with_context(|| format!("read {}", cert.display()))?,
    )?;
    let signed = nsh_package::resign(&bytes, &key, &cert)
        .with_context(|| format!("{}", package.display()))?;
    let header = verify_signature(&signed)?;
    let app = header.app();
    let out = out.unwrap_or_else(|| default_out(&app.id, app.build));
    write(&out, &signed)?;
    println!(
        "{}: {} {} (build {}), signed again by {}, for runtime {} or newer",
        out.display(),
        app.id,
        app.version,
        app.build,
        key.public().id(),
        header.min_runtime()
    );
    Ok(())
}

/// `<package>.map`: where `nsh publish --source-map file` writes the map.
fn map_path(package: &Path) -> PathBuf {
    let mut name = package.as_os_str().to_owned();
    name.push(".map");
    PathBuf::from(name)
}

/// `nsh symbolicate`: rewrites the `bundle.js:LINE:COL` positions of an
/// error report (`input`, else standard input) to app source positions,
/// with a source map or the one in a package (whose own signature is
/// checked).
pub(crate) fn symbolicate(map: &Path, input: Option<&Path>) -> anyhow::Result<()> {
    let json = if map.extension().is_some_and(|e| e == "nshpkg") {
        let bytes = fs::read(map).with_context(|| format!("read {}", map.display()))?;
        nsh_package::source_map(&bytes)
            .with_context(|| format!("{}", map.display()))?
            .with_context(|| {
                format!(
                    "{} holds no source map (published with --source-map file or none)",
                    map.display()
                )
            })?
    } else {
        fs::read_to_string(map).with_context(|| format!("read {}", map.display()))?
    };
    let text = match input {
        Some(path) => {
            fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?
        }
        None => std::io::read_to_string(std::io::stdin()).context("read standard input")?,
    };
    print!("{}", nsh_engine::symbolicate(&json, &text));
    Ok(())
}

/// `nsh verify`: checks a package as an app trusting `roots` (and knowing
/// `revocations`) would; without roots, only its signature.
pub(crate) fn verify(
    package: &Path,
    roots: &[PathBuf],
    revocations: Option<&Path>,
) -> anyhow::Result<()> {
    let bytes = fs::read(package).with_context(|| format!("read {}", package.display()))?;
    if roots.is_empty() {
        let header = verify_signature(&bytes)?;
        let app = header.app();
        println!(
            "signature valid: {} {} (build {}), for runtime {} or newer; the certificate was not checked (pass --root)",
            app.id,
            app.version,
            app.build,
            header.min_runtime()
        );
        return Ok(());
    }
    let mut store = TrustStore::new();
    for root in roots {
        store.add_root(read_public(root)?);
    }
    if let Some(path) = revocations {
        let list = Revocations::from_json(
            &fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?,
        )?;
        store.update_revocations(list)?;
    }
    let verified = store.verify(&bytes, nsh_js::BYTECODE_VERSION)?;
    println!(
        "valid: {} {} (build {}), release key {}, sha256 {}, {} assets, bytecode {}",
        verified.app.id,
        verified.app.version,
        verified.app.build,
        verified.key_id,
        verified.sha256,
        verified.assets.len(),
        if verified.bytecode().is_some() {
            "for this runtime"
        } else {
            "for another runtime (the source runs)"
        }
    );
    for ignored in &verified.ignored {
        crate::ui::warn(format!("this runtime ignores {ignored} (from a newer nsh)"));
    }
    Ok(())
}

/// `nsh revoke`: a revocation list signed by the root. With `extend`, it
/// keeps that list's entries and its sequence number goes up by one unless
/// given.
pub(crate) fn revoke_list(
    root: &Path,
    extend: Option<&Path>,
    sequence: Option<u64>,
    keys: &[String],
    packages: &[String],
    out: &Path,
) -> anyhow::Result<()> {
    let root = read_secret(root)?;
    let (mut all_keys, mut all_packages, previous) = match extend {
        Some(path) => {
            let list = Revocations::from_json(
                &fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?,
            )?;
            let (sequence, keys, packages) = list.contents()?;
            (keys, packages, Some(sequence))
        }
        None => (Vec::new(), Vec::new(), None),
    };
    let sequence = match (sequence, previous) {
        (Some(s), Some(p)) if s <= p => bail!("--sequence {s} must exceed the extended list's {p}"),
        (Some(s), _) => s,
        (None, Some(p)) => p + 1,
        (None, None) => bail!(
            "give --sequence (higher than any list published before) or --extend the last list"
        ),
    };
    all_keys.extend(keys.iter().cloned());
    all_packages.extend(packages.iter().cloned());
    let list = revoke(&root, sequence, &all_keys, &all_packages);
    write(out, list.to_json().as_bytes())?;
    let (_, keys, packages) = list.contents()?;
    println!(
        "{}: list {sequence}, {} release keys and {} packages revoked",
        out.display(),
        keys.len(),
        packages.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use nsh_package::{App, Contents, SecretKey, TrustStore, build, certify};

    use super::*;

    /// `<dir>/<name>.secret` and `<dir>/<name>.cert`: a release key
    /// certified by a new root for any app. Returns the root and the key.
    fn release_key(dir: &Path, name: &str) -> (SecretKey, SecretKey) {
        let root = SecretKey::generate().unwrap();
        let key = SecretKey::generate().unwrap();
        let cert = certify(&root, &key.public(), &["*".into()], 0, u64::MAX);
        write(
            &dir.join(format!("{name}.secret")),
            key.to_base64().as_bytes(),
        )
        .unwrap();
        write(&dir.join(format!("{name}.cert")), cert.to_json().as_bytes()).unwrap();
        (root, key)
    }

    #[test]
    fn resign_writes_the_package_signed_by_the_new_key() {
        let dir = std::env::temp_dir().join(format!("nsh-resign-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (_, ci) = release_key(&dir, "ci");
        let (platform_root, platform) = release_key(&dir, "platform");
        let ci_cert =
            Certificate::from_json(&fs::read_to_string(dir.join("ci.cert")).unwrap()).unwrap();
        let contents = Contents {
            app: App {
                id: "com.example.demo".into(),
                name: "Demo".into(),
                version: "1.2.0".into(),
                build: 7,
            },
            capabilities: None,
            source: "1".into(),
            bytecode: None,
            source_map: None,
            assets: Vec::new(),
            min_runtime: None,
        };
        let input = dir.join("in.nshpkg");
        write(&input, &build(&contents, &ci, &ci_cert).unwrap()).unwrap();
        let out = dir.join("out/signed.nshpkg");

        resign(
            &input,
            &dir.join("platform.secret"),
            &dir.join("platform.cert"),
            Some(out.clone()),
        )
        .unwrap();

        let mut store = TrustStore::new();
        store.add_root(platform_root.public());
        let package = store.verify(&fs::read(&out).unwrap(), "v").unwrap();
        assert_eq!(package.key_id, platform.public().id());
        assert_eq!(package.app.build, 7);
        let _ = fs::remove_dir_all(&dir);
    }
}
