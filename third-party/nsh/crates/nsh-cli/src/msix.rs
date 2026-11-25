//! `nsh package --target windows --format msix`: the packaged app directory
//! ([`crate::windows::package`]) as an MSIX package, for the Microsoft
//! Store (`nsh publish windows`) or for installing outside it when signed.
//!
//! Written without the Windows SDK, so Linux and macOS CI can make it: an
//! MSIX is a ZIP of the app's files plus `AppxManifest.xml` (the app's
//! identity, entry and logos, from `nsh.json` and its `"windows"` section),
//! `AppxBlockMap.xml` (a SHA-256 of every 64 KiB block of every file) and
//! `[Content_Types].xml`. Files are stored uncompressed, which keeps the
//! block map simple (a stored block has no compressed size) and is what
//! `makeappx pack /nc` writes.
//!
//! The Store signs what it publishes, so a Store upload is unsigned. Outside
//! the Store, Windows installs only signed packages: `--sign <cert.pfx>`
//! signs it with `signtool` on Windows or `osslsigncode` elsewhere (its
//! password from `NSH_WINDOWS_CERT_PASSWORD`), and the certificate's
//! subject must be the package's publisher (`windows.publisher`).

use std::{
    fs,
    io::Write as _,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest as _, Sha256};

use crate::{package::AppConfig, ui};

/// The size of the blocks the block map hashes.
const BLOCK: usize = 64 * 1024;

/// Every entry's modification time: midnight, 1980-01-01 (the first DOS
/// date; a zero date is not a valid one).
const DOS_DATE: u32 = 0x0021_0000;

/// The logos the manifest names, `(file, size)`: the Start menu's tile and
/// list icon, and the Store's logo.
const LOGOS: [(&str, u32); 3] = [
    ("Square150x150Logo.png", 150),
    ("Square44x44Logo.png", 44),
    ("StoreLogo.png", 50),
];

/// The oldest Windows the package installs on (Windows 10 1809, the first
/// with MSIX), and the newest it was tested on.
const MIN_VERSION: &str = "10.0.17763.0";
const MAX_VERSION_TESTED: &str = "10.0.26100.0";

/// `nsh.json` `"windows"`: the package's identity, which the Store hands
/// out when the app's name is reserved in Partner Center (Product identity).
/// The Store's id of the app is `store.windows.productId` (`store.rs`).
#[derive(Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowsConfig {
    /// Package/Identity/Name (default: the app's id).
    pub(crate) identity_name: Option<String>,
    /// Package/Identity/Publisher, a distinguished name such as
    /// `CN=0A1B2C3D-...` (default: `CN=<the app's name>`).
    pub(crate) publisher: Option<String>,
    /// The publisher's name shown to users (default: the app's name).
    pub(crate) publisher_display_name: Option<String>,
}

/// The package's identity and what the manifest shows.
pub(crate) struct Identity {
    pub(crate) name: String,
    pub(crate) publisher: String,
    pub(crate) publisher_display_name: String,
    pub(crate) display_name: String,
    /// Four parts, the last 0 (the Store's own).
    pub(crate) version: String,
    /// `x64` or `arm64`.
    pub(crate) arch: &'static str,
    pub(crate) executable: String,
}

impl Identity {
    pub(crate) fn new(
        config: &AppConfig,
        name: &str,
        id: &str,
        executable: String,
        arch: &'static str,
    ) -> anyhow::Result<Self> {
        let windows = &config.windows;
        let identity_name = windows
            .identity_name
            .clone()
            .unwrap_or_else(|| identity_name(id));
        check_identity_name(&identity_name)?;
        let publisher = windows
            .publisher
            .clone()
            .unwrap_or_else(|| format!("CN={}", dn_value(name)));
        anyhow::ensure!(
            publisher.contains('='),
            "windows.publisher `{publisher}` is not a distinguished name, such as `CN=Example`"
        );
        Ok(Self {
            name: identity_name,
            publisher,
            publisher_display_name: windows
                .publisher_display_name
                .clone()
                .unwrap_or_else(|| name.to_owned()),
            display_name: name.to_owned(),
            version: package_version(config.version.as_deref().unwrap_or("1.0.0"))?,
            arch,
            executable,
        })
    }
}

/// An app id as an identity name: letters, digits, `.` and `-`.
fn identity_name(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn check_identity_name(name: &str) -> anyhow::Result<()> {
    let ok = (3..=50).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && !name.ends_with('.');
    anyhow::ensure!(
        ok,
        "the package name `{name}` must be 3 to 50 letters, digits, `.` or `-` (set windows.identityName)"
    );
    Ok(())
}

/// A name as a distinguished name's value, quoted when it has a character
/// that would end it.
fn dn_value(name: &str) -> String {
    if name.contains([',', '+', '=', '"', '<', '>', ';', '#']) {
        format!("\"{}\"", name.replace('"', "'"))
    } else {
        name.to_owned()
    }
}

/// `1.2.3` as `1.2.3.0`: four numbers up to 65535, the fourth 0 (which the
/// Store reserves). A pre-release or build suffix is dropped.
fn package_version(version: &str) -> anyhow::Result<String> {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let mut parts = Vec::new();
    for part in core.split('.') {
        let n: u16 = part.parse().with_context(|| {
            format!("the version `{version}` must be numbers up to 65535, such as 1.2.0")
        })?;
        parts.push(n);
    }
    anyhow::ensure!(
        (1..=3).contains(&parts.len()),
        "the version `{version}` must have one to three numbers (the Store sets the fourth)"
    );
    parts.resize(3, 0);
    Ok(format!("{}.{}.{}.0", parts[0], parts[1], parts[2]))
}

/// The processor a Windows executable is for (`x64`, `arm64`), from its PE
/// header.
pub(crate) fn arch(exe: &Path) -> anyhow::Result<&'static str> {
    let bytes = fs::read(exe).with_context(|| format!("read {}", exe.display()))?;
    let pe = bytes
        .get(0x3c..0x40)
        .map(|b| u32::from_le_bytes(b.try_into().unwrap()) as usize)
        .context("not a Windows executable")?;
    let machine = bytes
        .get(pe + 4..pe + 6)
        .map(|b| u16::from_le_bytes(b.try_into().unwrap()))
        .context("not a Windows executable")?;
    Ok(match machine {
        0x8664 => "x64",
        0xaa64 => "arm64",
        0x14c => "x86",
        other => bail!("{} is for an unknown processor ({other:#x})", exe.display()),
    })
}

fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// `AppxManifest.xml`: a full-trust desktop app (`runFullTrust`), as the
/// runner is a plain Win32 executable.
pub(crate) fn manifest(identity: &Identity) -> String {
    let Identity {
        name,
        publisher,
        publisher_display_name,
        display_name,
        version,
        arch,
        executable,
    } = identity;
    let (name, publisher, publisher_display_name, display_name, executable) = (
        xml(name),
        xml(publisher),
        xml(publisher_display_name),
        xml(display_name),
        xml(executable),
    );
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10" xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities" IgnorableNamespaces="uap rescap">
  <Identity Name="{name}" Publisher="{publisher}" Version="{version}" ProcessorArchitecture="{arch}"/>
  <Properties>
    <DisplayName>{display_name}</DisplayName>
    <PublisherDisplayName>{publisher_display_name}</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="{MIN_VERSION}" MaxVersionTested="{MAX_VERSION_TESTED}"/>
  </Dependencies>
  <Resources>
    <Resource Language="en-us"/>
  </Resources>
  <Applications>
    <Application Id="App" Executable="{executable}" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="{display_name}" Description="{display_name}" BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png"/>
    </Application>
  </Applications>
  <Capabilities>
    <rescap:Capability Name="runFullTrust"/>
  </Capabilities>
</Package>
"#
    )
}

/// The logos, made from the app's icon.
fn logos(icon: &Path) -> anyhow::Result<Vec<(String, Vec<u8>)>> {
    use image::imageops::FilterType;

    let source = image::open(icon).with_context(|| format!("read {}", icon.display()))?;
    let mut logos = Vec::new();
    for (file, size) in LOGOS {
        let mut png = Vec::new();
        source
            .resize_exact(size, size, FilterType::Lanczos3)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .context("encode a logo")?;
        logos.push((format!("Assets/{file}"), png));
    }
    Ok(logos)
}

/// Writes `msix` from the packaged app directory `dir`, then signs it with
/// `cert` (a `.pfx`) when given.
pub(crate) fn write(
    dir: &Path,
    identity: &Identity,
    icon: Option<&Path>,
    msix: &Path,
    cert: Option<&Path>,
) -> anyhow::Result<()> {
    let icon = icon.context(
        "an MSIX package needs the app's logos: set \"icon\" (or \"icon.windows\") in nsh.json",
    )?;
    let mut files = Vec::new();
    collect(dir, "", &mut files)?;
    files.sort();
    let mut parts: Vec<(String, Vec<u8>)> = Vec::new();
    for path in files {
        let data = fs::read(dir.join(&path)).with_context(|| format!("read {path}"))?;
        parts.push((path, data));
    }
    parts.extend(logos(icon)?);
    parts.push((
        "AppxManifest.xml".to_owned(),
        manifest(identity).into_bytes(),
    ));
    let bytes = archive(parts)?;
    if let Some(parent) = msix.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(msix, bytes).with_context(|| format!("write {}", msix.display()))?;
    if let Some(cert) = cert {
        sign(msix, cert)?;
    }
    Ok(())
}

/// The files under `dir`, as `/`-separated paths relative to it.
fn collect(dir: &Path, prefix: &str, out: &mut Vec<String>) -> anyhow::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|n| anyhow::anyhow!("{} is not UTF-8", n.to_string_lossy()))?;
        let path = format!("{prefix}{name}");
        if entry.file_type()?.is_dir() {
            collect(&entry.path(), &format!("{path}/"), out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// A ZIP entry name as OPC wants it: each byte outside the unreserved set
/// percent-encoded.
fn part_name(path: &str) -> String {
    let mut out = String::new();
    for &b in path.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The content type of a file, by extension; `[Content_Types].xml` names
/// one for each extension (or the file, when it has none).
fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("exe" | "dll") => "application/x-msdownload",
        Some("png") => "image/png",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("ico") => "image/vnd.microsoft.icon",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

/// One stored ZIP entry as written.
struct Entry {
    name: String,
    crc: u32,
    size: u32,
    offset: u32,
}

/// The package: `parts` (the manifest last of them), then the block map
/// and the content types, as a ZIP of stored entries.
fn archive(parts: Vec<(String, Vec<u8>)>) -> anyhow::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut entries = Vec::new();
    let mut block_map = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">
"#,
    );
    let mut defaults = std::collections::BTreeMap::new();
    let mut overrides = Vec::new();
    for (path, data) in &parts {
        let name = part_name(path);
        let header = 30 + name.len();
        entries.push(add(&mut out, &name, data)?);
        block_map.push_str(&format!(
            "  <File Name=\"{}\" Size=\"{}\" LfhSize=\"{header}\">\n",
            xml(&path.replace('/', "\\")),
            data.len()
        ));
        for block in data.chunks(BLOCK) {
            block_map.push_str(&format!(
                "    <Block Hash=\"{}\"/>\n",
                STANDARD.encode(Sha256::digest(block))
            ));
        }
        block_map.push_str("  </File>\n");
        if path == "AppxManifest.xml" {
            continue;
        }
        match path
            .rsplit_once('/')
            .map_or(path.as_str(), |(_, f)| f)
            .rsplit_once('.')
        {
            Some((_, ext)) if !ext.is_empty() => {
                defaults
                    .entry(ext.to_ascii_lowercase())
                    .or_insert_with(|| content_type(path));
            }
            _ => overrides.push((format!("/{name}"), content_type(path))),
        }
    }
    block_map.push_str("</BlockMap>\n");
    entries.push(add(&mut out, "AppxBlockMap.xml", block_map.as_bytes())?);
    let mut types = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">"#,
    );
    for (ext, ty) in defaults {
        types.push_str(&format!(
            r#"<Default Extension="{}" ContentType="{ty}"/>"#,
            xml(&ext)
        ));
    }
    for (part, ty) in overrides {
        types.push_str(&format!(
            r#"<Override PartName="{}" ContentType="{ty}"/>"#,
            xml(&part)
        ));
    }
    types.push_str(
        r#"<Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml"/><Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml"/></Types>"#,
    );
    entries.push(add(&mut out, "[Content_Types].xml", types.as_bytes())?);
    // The central directory.
    let start = offset(&out)?;
    for e in &entries {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // made by
        out.extend_from_slice(&20u16.to_le_bytes()); // needed
        out.extend_from_slice(&0u16.to_le_bytes()); // flags
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&DOS_DATE.to_le_bytes()); // time, date
        out.extend_from_slice(&e.crc.to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&e.size.to_le_bytes());
        out.extend_from_slice(&(e.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0; 8]); // extra, comment, disk, internal
        out.extend_from_slice(&0u32.to_le_bytes()); // external
        out.extend_from_slice(&e.offset.to_le_bytes());
        out.extend_from_slice(e.name.as_bytes());
    }
    let size = offset(&out)? - start;
    let count = u16::try_from(entries.len()).context("too many files for an MSIX package")?;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

fn offset(out: &[u8]) -> anyhow::Result<u32> {
    u32::try_from(out.len()).context("the app is over 4 GiB, too large for an MSIX package here")
}

/// Appends a stored local file entry.
fn add(out: &mut Vec<u8>, name: &str, data: &[u8]) -> anyhow::Result<Entry> {
    let offset = offset(out)?;
    let size = u32::try_from(data.len()).with_context(|| format!("{name} is over 4 GiB"))?;
    let mut crc = flate2::Crc::new();
    crc.update(data);
    let crc = crc.sum();
    out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&DOS_DATE.to_le_bytes());
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&size.to_le_bytes());
    out.extend_from_slice(&(name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(name.as_bytes());
    out.extend_from_slice(data);
    Ok(Entry {
        name: name.to_owned(),
        crc,
        size,
        offset,
    })
}

/// Signs `msix` in place with the certificate `cert` (`.pfx`): `signtool`
/// on Windows, `osslsigncode` elsewhere.
fn sign(msix: &Path, cert: &Path) -> anyhow::Result<()> {
    let password = std::env::var("NSH_WINDOWS_CERT_PASSWORD").ok();
    let step = ui::Step::start(format!("signing {}", ui::path(msix)));
    let status = if cfg!(windows) {
        let mut cmd = Command::new("signtool");
        cmd.args(["sign", "/fd", "SHA256", "/f"]).arg(cert);
        if let Some(password) = &password {
            cmd.arg("/p").arg(password);
        }
        cmd.arg(msix);
        cmd.status().context(
            "run signtool (install the Windows SDK, or sign elsewhere with osslsigncode)",
        )?
    } else {
        let signed: PathBuf = msix.with_extension("signed.msix");
        let mut cmd = Command::new("osslsigncode");
        cmd.args(["sign", "-h", "sha256", "-pkcs12"]).arg(cert);
        if let Some(password) = &password {
            cmd.arg("-pass").arg(password);
        }
        cmd.arg("-in").arg(msix).arg("-out").arg(&signed);
        let status = cmd.status().context(
            "run osslsigncode (2.6 or newer signs MSIX; install it to sign off Windows)",
        )?;
        if status.success() {
            fs::rename(&signed, msix)?;
        } else {
            let _ = fs::remove_file(&signed);
        }
        status
    };
    if !status.success() {
        bail!(
            "signing {} failed; the certificate's subject must equal windows.publisher",
            msix.display()
        );
    }
    step.done(format!("signed {}", ui::path(msix)));
    std::io::stdout().flush().ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_have_four_parts_the_last_zero() {
        assert_eq!(package_version("1.2.3").unwrap(), "1.2.3.0");
        assert_eq!(package_version("1.2").unwrap(), "1.2.0.0");
        assert_eq!(package_version("0.6.1-beta.1").unwrap(), "0.6.1.0");
        assert!(package_version("1.2.3.4").is_err());
        assert!(package_version("70000.0.0").is_err());
    }

    #[test]
    fn identity_names_come_from_the_app_id() {
        assert_eq!(identity_name("com.example.my_app"), "com.example.my-app");
        assert!(check_identity_name("ab").is_err());
        assert!(check_identity_name("com.example.app").is_ok());
    }

    #[test]
    fn the_archive_is_a_zip_with_a_block_map_of_every_file() {
        let big = vec![7u8; BLOCK + 10];
        let bytes = archive(vec![
            ("My App.exe".to_owned(), b"MZ".to_vec()),
            ("nsh/bundle.nshc".to_owned(), big.clone()),
            ("nsh/LICENSE".to_owned(), b"x".to_vec()),
            ("AppxManifest.xml".to_owned(), b"<Package/>".to_vec()),
        ])
        .unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let names: Vec<_> = zip.file_names().map(|n| n.unwrap().into_owned()).collect();
        assert!(names.contains(&"My%20App.exe".to_owned()));
        let last = zip.len() - 1;
        assert_eq!(
            zip.by_index(last).unwrap().name().unwrap(),
            "[Content_Types].xml"
        );
        let mut map = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("AppxBlockMap.xml").unwrap(), &mut map)
            .unwrap();
        assert!(map.contains(r#"<File Name="My App.exe" Size="2" LfhSize="42">"#));
        assert!(map.contains(r#"<File Name="nsh\bundle.nshc""#));
        assert_eq!(map.matches("<Block ").count(), 1 + 2 + 1 + 1);
        let mut types = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("[Content_Types].xml").unwrap(), &mut types)
            .unwrap();
        assert!(
            types.contains(r#"<Default Extension="exe" ContentType="application/x-msdownload"/>"#)
        );
        assert!(types.contains(r#"<Override PartName="/nsh/LICENSE""#));
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut zip.by_name("nsh/bundle.nshc").unwrap(), &mut data)
            .unwrap();
        assert_eq!(data, big);
    }

    #[test]
    fn the_manifest_escapes_and_names_the_executable() {
        let manifest = manifest(&Identity {
            name: "com.example.app".into(),
            publisher: "CN=A & B".into(),
            publisher_display_name: "A & B".into(),
            display_name: "App".into(),
            version: "1.0.0.0".into(),
            arch: "x64",
            executable: "App.exe".into(),
        });
        assert!(manifest.contains(r#"Publisher="CN=A &amp; B""#));
        assert!(
            manifest.contains(r#"Executable="App.exe" EntryPoint="Windows.FullTrustApplication""#)
        );
    }
}
