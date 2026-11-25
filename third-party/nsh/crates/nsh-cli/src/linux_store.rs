//! Linux store delivery: the AppStream metainfo every Linux software
//! centre reads, AppImage and Flatpak packages (`nsh package --target linux
//! --format appimage|flatpak`), and the Flathub manifest `nsh publish linux`
//! keeps in step with the app's release archive.
//!
//! Flathub takes no uploads: an app is a repository (`flathub/<id>`) whose
//! manifest names the release archive by URL and SHA-256, and a new release
//! is a pull request that updates both. `nsh publish linux` writes that
//! manifest; opening the pull request stays with the maintainer.

use std::{
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context as _, bail};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::ui;

/// What Linux stores show of the app, written into the AppStream metainfo
/// ([`metainfo`]). It comes from the store listing every store shares
/// (`store.rs`): the texts of the `en-US` locale (else the first one) and
/// `store.linux`.
#[derive(Debug, Default)]
pub(crate) struct StoreConfig {
    /// One line under the app's name (Flathub: at most 35 characters):
    /// the listing's `subtitle`.
    pub(crate) summary: Option<String>,
    /// What the app does: paragraphs separated by blank lines.
    pub(crate) description: Option<String>,
    /// The app's web site: `store.linux.homepage`, else the listing's
    /// `marketingUrl`.
    pub(crate) homepage: Option<String>,
    /// The app's license as an SPDX expression (`MIT`, `Apache-2.0`).
    pub(crate) license: Option<String>,
    /// Who makes the app.
    pub(crate) developer: Option<String>,
    /// Freedesktop categories (`["Development", "Utility"]`; default
    /// `Utility`).
    pub(crate) categories: Vec<String>,
    /// Search keywords: the listing's, split at commas.
    pub(crate) keywords: Vec<String>,
    /// Screenshot image URLs, the first being the default one.
    pub(crate) screenshots: Vec<String>,
}

impl StoreConfig {
    pub(crate) fn of(store: &crate::store::StoreConfig) -> Self {
        let listing = store
            .locales
            .get("en-US")
            .or_else(|| store.locales.values().next())
            .cloned()
            .unwrap_or_default();
        let linux = &store.linux;
        Self {
            summary: listing.subtitle,
            description: listing.description,
            homepage: linux.homepage.clone().or(listing.marketing_url),
            license: linux.license.clone(),
            developer: linux.developer.clone(),
            categories: linux.categories.clone(),
            keywords: listing
                .keywords
                .iter()
                .flat_map(|k| k.split(','))
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(str::to_owned)
                .collect(),
            screenshots: linux.screenshots.clone(),
        }
    }

    /// The app's store metadata, from its `nsh.json` and `store/`.
    pub(crate) fn read(entry: &Path) -> anyhow::Result<Self> {
        Ok(Self::of(&crate::store::read(entry)?))
    }
}

/// `nsh.json` `"linux"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinuxConfig {
    /// The Flatpak manifest's options.
    #[serde(default)]
    pub(crate) flatpak: FlatpakConfig,
}

/// `nsh.json` `"linux"."flatpak"`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FlatpakConfig {
    /// The GNOME runtime's version (default [`GNOME_RUNTIME`]).
    pub(crate) runtime_version: Option<String>,
    /// The sandbox's permissions, replacing [`DEFAULT_FINISH_ARGS`].
    pub(crate) finish_args: Option<Vec<String>>,
}

/// The GNOME runtime the Linux runner (GTK 4) runs on in Flatpak.
pub(crate) const GNOME_RUNTIME: &str = "49";

/// A window on Wayland or X11, the GPU, and the network.
pub(crate) const DEFAULT_FINISH_ARGS: &[&str] = &[
    "--share=ipc",
    "--socket=wayland",
    "--socket=fallback-x11",
    "--device=dri",
    "--share=network",
];

/// The size the packaged icon is written at: what Flathub asks for.
pub(crate) const ICON_SIZE: u32 = 256;

/// Marks the release archive's source in a manifest, so `nsh publish linux`
/// finds the lines to update in one the maintainer has edited.
const ARCHIVE_MARK: &str = "# nsh: release archive";

/// What a Linux package of the app is made of, beside the packaged
/// directory: everything [`metainfo`] and the manifest read.
pub(crate) struct LinuxApp<'a> {
    pub(crate) name: &'a str,
    pub(crate) id: &'a str,
    pub(crate) executable: &'a str,
    pub(crate) version: &'a str,
    pub(crate) store: &'a StoreConfig,
}

fn xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// The developer id AppStream asks for: the app id without its last part
/// (`com.example` for `com.example.app`).
fn developer_id(id: &str) -> &str {
    id.rsplit_once('.').map_or(id, |(head, _)| head)
}

/// Today as `YYYY-MM-DD` (UTC).
fn today() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    civil_date((secs / 86_400) as i64)
}

/// The date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The app's AppStream metainfo (`<id>.metainfo.xml`): what GNOME Software,
/// KDE Discover and Flathub list.
pub(crate) fn metainfo(app: &LinuxApp<'_>) -> String {
    let LinuxApp {
        name,
        id,
        version,
        store,
        ..
    } = *app;
    let mut out = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<component type=\"desktop-application\">\n");
    out.push_str(&format!("  <id>{}</id>\n", xml(id)));
    out.push_str("  <metadata_license>CC0-1.0</metadata_license>\n");
    if let Some(license) = &store.license {
        out.push_str(&format!(
            "  <project_license>{}</project_license>\n",
            xml(license)
        ));
    }
    out.push_str(&format!("  <name>{}</name>\n", xml(name)));
    let summary = store.summary.as_deref().unwrap_or(name);
    out.push_str(&format!("  <summary>{}</summary>\n", xml(summary)));
    if let Some(developer) = &store.developer {
        out.push_str(&format!(
            "  <developer id=\"{}\">\n    <name>{}</name>\n  </developer>\n",
            xml(developer_id(id)),
            xml(developer)
        ));
    }
    let description = store.description.as_deref().unwrap_or(summary);
    out.push_str("  <description>\n");
    for paragraph in description
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        let line = paragraph.split_whitespace().collect::<Vec<_>>().join(" ");
        out.push_str(&format!("    <p>{}</p>\n", xml(&line)));
    }
    out.push_str("  </description>\n");
    out.push_str(&format!(
        "  <launchable type=\"desktop-id\">{}.desktop</launchable>\n",
        xml(id)
    ));
    if let Some(homepage) = &store.homepage {
        out.push_str(&format!(
            "  <url type=\"homepage\">{}</url>\n",
            xml(homepage)
        ));
    }
    if !store.categories.is_empty() {
        out.push_str("  <categories>\n");
        for c in &store.categories {
            out.push_str(&format!("    <category>{}</category>\n", xml(c)));
        }
        out.push_str("  </categories>\n");
    }
    if !store.keywords.is_empty() {
        out.push_str("  <keywords>\n");
        for k in &store.keywords {
            out.push_str(&format!("    <keyword>{}</keyword>\n", xml(k)));
        }
        out.push_str("  </keywords>\n");
    }
    if !store.screenshots.is_empty() {
        out.push_str("  <screenshots>\n");
        for (i, url) in store.screenshots.iter().enumerate() {
            let kind = if i == 0 { " type=\"default\"" } else { "" };
            out.push_str(&format!(
                "    <screenshot{kind}>\n      <image>{}</image>\n    </screenshot>\n",
                xml(url)
            ));
        }
        out.push_str("  </screenshots>\n");
    }
    out.push_str("  <content_rating type=\"oars-1.1\"/>\n");
    out.push_str(&format!(
        "  <releases>\n    <release version=\"{}\" date=\"{}\"/>\n  </releases>\n",
        xml(version),
        today()
    ));
    out.push_str("</component>\n");
    out
}

/// The `.desktop` entry's `Categories=` line for the app's store
/// categories (default `Utility`).
pub(crate) fn desktop_categories(store: &StoreConfig) -> String {
    if store.categories.is_empty() {
        "Categories=Utility;".to_owned()
    } else {
        let list: String = store.categories.iter().map(|c| format!("{c};")).collect();
        format!("Categories={list}")
    }
}

/// Writes the app's icon as a `ICON_SIZE`×`ICON_SIZE` PNG, what Flathub
/// and the hicolor theme directory it is installed in expect.
pub(crate) fn write_icon(icon: &Path, to: &Path) -> anyhow::Result<()> {
    let image = image::open(icon).with_context(|| format!("read {}", icon.display()))?;
    let image = if image.width() == ICON_SIZE && image.height() == ICON_SIZE {
        image
    } else {
        image.resize_exact(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
    };
    image
        .save_with_format(to, image::ImageFormat::Png)
        .with_context(|| format!("write {}", to.display()))
}

/// The machine name of this host's processor, as Flatpak and AppImage name
/// it.
pub(crate) fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x86_64"
    }
}

/// Installs the packaged directory `dir` under `prefix` the way Linux lays
/// out apps: the directory in `lib/<id>`, the executable linked from `bin`,
/// and the entry, icon and metainfo under `share`.
fn install_prefix(dir: &Path, prefix: &Path, app: &LinuxApp<'_>) -> anyhow::Result<()> {
    let id = app.id;
    let lib = prefix.join("lib").join(id);
    copy_dir(dir, &lib)?;
    for file in [
        format!("{id}.desktop"),
        format!("{id}.png"),
        format!("{id}.metainfo.xml"),
    ] {
        let _ = fs::remove_file(lib.join(file));
    }
    let bin = prefix.join("bin");
    fs::create_dir_all(&bin)?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        Path::new("../lib").join(id).join(app.executable),
        bin.join(app.executable),
    )?;
    let share = prefix.join("share");
    let apps = share.join("applications");
    fs::create_dir_all(&apps)?;
    fs::copy(
        dir.join(format!("{id}.desktop")),
        apps.join(format!("{id}.desktop")),
    )?;
    let icon = dir.join(format!("{id}.png"));
    if icon.exists() {
        let icons = share.join(format!("icons/hicolor/{ICON_SIZE}x{ICON_SIZE}/apps"));
        fs::create_dir_all(&icons)?;
        fs::copy(&icon, icons.join(format!("{id}.png")))?;
    }
    let meta = share.join("metainfo");
    fs::create_dir_all(&meta)?;
    fs::copy(
        dir.join(format!("{id}.metainfo.xml")),
        meta.join(format!("{id}.metainfo.xml")),
    )?;
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), &dest)
                .with_context(|| format!("copy {}", entry.path().display()))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                let mode = entry.metadata()?.permissions().mode();
                fs::set_permissions(&dest, fs::Permissions::from_mode(mode))?;
            }
        }
    }
    Ok(())
}

/// `appimagetool`: `NSH_APPIMAGETOOL`, else the one on `PATH`.
fn appimagetool() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("NSH_APPIMAGETOOL") {
        return Some(PathBuf::from(path));
    }
    which("appimagetool")
}

pub(crate) fn which(tool: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(tool))
        .find(|p| p.is_file())
}

/// `<out>/<name>-<arch>.AppImage` from the packaged directory `dir`, with
/// `appimagetool`; the AppDir it is made of stays in `<out>/<name>.AppDir`.
/// The AppImage runs on the system's GTK 4, like the `.tar.gz`.
pub(crate) fn appimage(dir: &Path, out: &Path, app: &LinuxApp<'_>) -> anyhow::Result<PathBuf> {
    let id = app.id;
    let appdir = out.join(format!("{}.AppDir", app.name));
    if appdir.exists() {
        fs::remove_dir_all(&appdir)?;
    }
    install_prefix(dir, &appdir.join("usr"), app)?;
    fs::copy(
        dir.join(format!("{id}.desktop")),
        appdir.join(format!("{id}.desktop")),
    )?;
    let icon = dir.join(format!("{id}.png"));
    if icon.exists() {
        fs::copy(&icon, appdir.join(format!("{id}.png")))?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(format!("{id}.png"), appdir.join(".DirIcon"))?;
    } else {
        bail!("an AppImage needs an icon: set `icon` in nsh.json");
    }
    let app_run = appdir.join("AppRun");
    fs::write(
        &app_run,
        format!(
            "#!/bin/sh\nHERE=\"$(dirname \"$(readlink -f \"$0\")\")\"\nexec \"$HERE/usr/lib/{id}/{}\" \"$@\"\n",
            app.executable
        ),
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&app_run, fs::Permissions::from_mode(0o755))?;
    }
    let Some(tool) = appimagetool() else {
        bail!(
            "making an AppImage needs appimagetool (https://github.com/AppImage/appimagetool/releases): \
             put it on PATH or set NSH_APPIMAGETOOL; the AppDir is ready in {}",
            appdir.display()
        );
    };
    let image = out.join(format!("{}-{}.AppImage", app.name, arch()));
    let _ = fs::remove_file(&image);
    let output = Command::new(&tool)
        .env("ARCH", arch())
        // Runs without FUSE, as in containers and CI.
        .env("APPIMAGE_EXTRACT_AND_RUN", "1")
        .arg("--no-appstream")
        .arg(&appdir)
        .arg(&image)
        .output()
        .with_context(|| format!("run {}", tool.display()))?;
    if !output.status.success() {
        bail!(
            "appimagetool failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(image)
}

/// Where the manifest's archive comes from: a local file (`nsh package`'s
/// test build) or a released URL with its SHA-256 (Flathub).
pub(crate) enum ArchiveSource<'a> {
    Path(&'a str),
    Url { url: &'a str, sha256: &'a str },
}

/// The Flatpak manifest (`<id>.yml`): the GNOME runtime, the sandbox's
/// permissions, and one module installing the release archive the way
/// [`install_prefix`] does.
pub(crate) fn flatpak_manifest(
    app: &LinuxApp<'_>,
    config: &FlatpakConfig,
    source: &ArchiveSource<'_>,
    arch: &str,
    icon: bool,
) -> String {
    let id = app.id;
    let exe = app.executable;
    let runtime = config.runtime_version.as_deref().unwrap_or(GNOME_RUNTIME);
    let mut out = format!(
        "id: {id}\nruntime: org.gnome.Platform\nruntime-version: '{runtime}'\nsdk: org.gnome.Sdk\ncommand: {exe}\nfinish-args:\n"
    );
    match &config.finish_args {
        Some(args) => args
            .iter()
            .for_each(|a| out.push_str(&format!("  - {a}\n"))),
        None => DEFAULT_FINISH_ARGS
            .iter()
            .for_each(|a| out.push_str(&format!("  - {a}\n"))),
    }
    out.push_str(&format!(
        "modules:\n  - name: {}\n    buildsystem: simple\n    build-commands:\n",
        exe.to_ascii_lowercase()
    ));
    let mut commands = vec![
        format!("mkdir -p /app/lib/{id} /app/bin"),
        format!("cp -a . /app/lib/{id}/"),
        format!(
            "rm -f /app/lib/{id}/{id}.desktop /app/lib/{id}/{id}.png /app/lib/{id}/{id}.metainfo.xml"
        ),
        format!("ln -s ../lib/{id}/{exe} /app/bin/{exe}"),
        format!("install -Dm644 {id}.desktop /app/share/applications/{id}.desktop"),
        format!("install -Dm644 {id}.metainfo.xml /app/share/metainfo/{id}.metainfo.xml"),
    ];
    if icon {
        commands.push(format!(
            "install -Dm644 {id}.png /app/share/icons/hicolor/{ICON_SIZE}x{ICON_SIZE}/apps/{id}.png"
        ));
    }
    for c in commands {
        out.push_str(&format!("      - {c}\n"));
    }
    out.push_str("    sources:\n");
    out.push_str(&format!("      {ARCHIVE_MARK}\n      - type: archive\n"));
    match source {
        ArchiveSource::Path(path) => out.push_str(&format!("        path: {path}\n")),
        ArchiveSource::Url { url, sha256 } => {
            out.push_str(&format!("        url: {url}\n        sha256: {sha256}\n"));
        }
    }
    out.push_str(&format!("        only-arches:\n          - {arch}\n"));
    out
}

/// The processor the release archive's executable `executable` is built for,
/// as Flatpak names it, read from the executable's ELF header.
fn archive_arch(archive: &Path, executable: &str) -> anyhow::Result<&'static str> {
    let file = fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in tar
        .entries()
        .with_context(|| format!("read {}", archive.display()))?
    {
        let mut entry = entry?;
        if !entry.header().entry_type().is_file()
            || entry.path()?.file_name().and_then(|n| n.to_str()) != Some(executable)
        {
            continue;
        }
        let mut header = [0; 20];
        entry
            .read_exact(&mut header)
            .with_context(|| format!("read {executable} in {}", archive.display()))?;
        return elf_arch(&header).with_context(|| {
            format!(
                "{executable} in {} is not an x86_64 or aarch64 ELF executable",
                archive.display()
            )
        });
    }
    bail!("{} has no executable `{executable}`", archive.display())
}

/// The Flatpak name of an ELF header's machine (`e_machine`).
fn elf_arch(header: &[u8; 20]) -> Option<&'static str> {
    if &header[..4] != b"\x7fELF" || header[5] != 1 {
        return None;
    }
    match u16::from_le_bytes([header[18], header[19]]) {
        0x3e => Some("x86_64"),
        0xb7 => Some("aarch64"),
        _ => None,
    }
}

/// Points the release archive's source in an existing manifest at `url`,
/// `sha256` and the archive's `arch`, leaving the rest as the maintainer
/// wrote it; `None` when the manifest has no marked archive source.
fn update_manifest(text: &str, url: &str, sha256: &str, arch: &str) -> Option<String> {
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let mark = lines.iter().position(|l| l.trim() == ARCHIVE_MARK)?;
    let mut url_done = false;
    let mut sha_done = false;
    let mut in_arches = false;
    for line in lines.iter_mut().skip(mark + 1) {
        let trimmed = line.trim_start();
        let indent = &line[..line.len() - trimmed.len()];
        if in_arches && trimmed.starts_with("- ") {
            *line = format!("{indent}- {arch}");
            in_arches = false;
            continue;
        }
        if trimmed.starts_with("- ") && (url_done || sha_done) {
            break;
        }
        if trimmed == "only-arches:" {
            in_arches = true;
            continue;
        }
        if let Some(rest) = trimmed
            .strip_prefix("url:")
            .or(trimmed.strip_prefix("path:"))
        {
            let _ = rest;
            *line = format!("{indent}url: {url}");
            url_done = true;
        } else if trimmed.starts_with("sha256:") {
            *line = format!("{indent}sha256: {sha256}");
            sha_done = true;
        }
    }
    if !url_done {
        return None;
    }
    if !sha_done {
        let at = lines
            .iter()
            .position(|l| l.trim_start().starts_with("url: "))
            .unwrap();
        let indent: String = lines[at].chars().take_while(|c| *c == ' ').collect();
        lines.insert(at + 1, format!("{indent}sha256: {sha256}"));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    Some(out)
}

/// The Flatpak of the packaged directory `dir`: the manifest
/// `<out>/flatpak/<id>.yml` building from the `.tar.gz` beside it and, with
/// `flatpak-builder` installed, the bundle `<out>/<name>.flatpak`.
pub(crate) fn flatpak(
    archive: &Path,
    out: &Path,
    app: &LinuxApp<'_>,
    config: &FlatpakConfig,
    icon: bool,
) -> anyhow::Result<Option<PathBuf>> {
    let dir = out.join("flatpak");
    fs::create_dir_all(&dir)?;
    let archive_path = format!(
        "../{}",
        archive.file_name().unwrap_or_default().to_string_lossy()
    );
    let manifest = dir.join(format!("{}.yml", app.id));
    fs::write(
        &manifest,
        flatpak_manifest(
            app,
            config,
            &ArchiveSource::Path(&archive_path),
            arch(),
            icon,
        ),
    )?;
    let (Some(builder), Some(flatpak)) = (which("flatpak-builder"), which("flatpak")) else {
        ui::warn(format!(
            "flatpak-builder is not installed: wrote {} only; install flatpak-builder to build {}.flatpak",
            ui::path(&manifest),
            app.name
        ));
        return Ok(None);
    };
    let repo = dir.join("repo");
    let status = Command::new(builder)
        .args(["--user", "--install-deps-from=flathub", "--force-clean"])
        .arg(format!("--repo={}", repo.display()))
        .arg(dir.join("build"))
        .arg(&manifest)
        .status()
        .context("run flatpak-builder")?;
    if !status.success() {
        bail!("flatpak-builder failed");
    }
    let bundle = out.join(format!("{}.flatpak", app.name));
    let status = Command::new(flatpak)
        .arg("build-bundle")
        .arg(&repo)
        .arg(&bundle)
        .arg(app.id)
        .status()
        .context("run flatpak build-bundle")?;
    if !status.success() {
        bail!("flatpak build-bundle failed");
    }
    Ok(Some(bundle))
}

/// `nsh publish linux`: the Flathub manifest of a release archive (`nsh
/// publish status linux`: its version on Flathub; `nsh publish doctor
/// linux`: what Flathub asks of the app).
#[derive(clap::Args, Clone, Debug)]
pub(crate) struct Args {
    /// The release archive (`nsh package --target linux`'s `.tar.gz`).
    archive: PathBuf,
    /// Where the archive is downloaded from (default: nsh.json
    /// `store.linux.archiveUrl`).
    #[arg(long)]
    url: Option<String>,
    /// The app's directory or entry.
    #[arg(long, default_value = ".")]
    entry: PathBuf,
    /// The checkout of the app's Flathub repository (`flathub/<id>`) whose
    /// `<id>.yml` to write or update (default: `.nsh/out/flathub/<id>`).
    #[arg(short, long)]
    out: Option<PathBuf>,
}

struct Resolved {
    config: crate::package::AppConfig,
    store: StoreConfig,
    /// `store.linux.archiveUrl`.
    archive_url: Option<String>,
    name: String,
    id: String,
    executable: String,
    version: String,
}

fn resolve(entry: &Path) -> anyhow::Result<Resolved> {
    let config = crate::package::read_config(entry)?;
    let Some(id) = config.id.clone() else {
        bail!("nsh.json has no `id`: Flathub names the app by it");
    };
    let name = config.name.clone().unwrap_or_else(|| id.clone());
    let executable = crate::package::executable_name(&name);
    let version = config.version.clone().unwrap_or_else(|| "1.0.0".into());
    let store = crate::store::read(entry)?;
    Ok(Resolved {
        config,
        archive_url: store.linux.archive_url.clone(),
        store: StoreConfig::of(&store),
        name,
        id,
        executable,
        version,
    })
}

pub(crate) fn publish(args: &Args) -> anyhow::Result<()> {
    let archive = &args.archive;
    let app = resolve(&args.entry)?;
    let url = match (&args.url, &app.archive_url) {
        (Some(url), _) => url.clone(),
        (None, Some(template)) => template.replace("{version}", &app.version),
        (None, None) => bail!(
            "give the URL the release archive is downloaded from with --url, or set nsh.json `store.linux.archiveUrl`"
        ),
    };
    let url = &url;
    if !url.starts_with("https://") {
        bail!("Flathub downloads the archive over HTTPS: the archive URL must start with https://");
    }
    let mut hasher = Sha256::new();
    let mut file =
        fs::File::open(archive).with_context(|| format!("open {}", archive.display()))?;
    let mut buf = vec![0; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let sha256 = format!("{:x}", hasher.finalize());
    // The archive may have been built on another machine (CI): its executable,
    // not this host, says which processor Flathub builds it for.
    let arch = archive_arch(archive, &app.executable)?;
    let out = args.out.clone().unwrap_or_else(|| {
        crate::package::config_dir(&args.entry)
            .join(".nsh/out/flathub")
            .join(&app.id)
    });
    fs::create_dir_all(&out)?;
    let manifest = out.join(format!("{}.yml", app.id));
    let existing = fs::read_to_string(&manifest).ok();
    let text = match existing
        .as_deref()
        .and_then(|t| update_manifest(t, url, &sha256, arch))
    {
        Some(text) => text,
        None => {
            if existing.is_some() {
                ui::warn(format!(
                    "{} has no `{ARCHIVE_MARK}` source: writing it anew",
                    ui::path(&manifest)
                ));
            }
            let linux = LinuxApp {
                name: &app.name,
                id: &app.id,
                executable: &app.executable,
                version: &app.version,
                store: &app.store,
            };
            let icon = app
                .config
                .icon(crate::package::PackageTarget::Linux)
                .is_some();
            flatpak_manifest(
                &linux,
                &app.config.linux.flatpak,
                &ArchiveSource::Url {
                    url,
                    sha256: &sha256,
                },
                arch,
                icon,
            )
        }
    };
    fs::write(&manifest, text)?;
    ui::done(format!(
        "{} → {} {}",
        ui::path(&manifest),
        app.version,
        ui::dim(format!("({arch}, sha256 {})", &sha256[..12]))
    ));
    ui::note(format!(
        "commit it to flathub/{} and open a pull request: Flathub builds and publishes it once merged",
        app.id
    ));
    Ok(())
}

/// The app's latest version on Flathub (`None`: not on Flathub).
fn flathub_version(id: &str) -> anyhow::Result<Option<String>> {
    let url = format!("https://flathub.org/api/v2/appstream/{id}");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .get(&url)
        .call()
        .with_context(|| format!("GET {url}"))?;
    match response.status().as_u16() {
        404 => return Ok(None),
        200 => {}
        code => bail!("GET {url}: HTTP {code}"),
    }
    let body: serde_json::Value = serde_json::from_slice(&response.body_mut().read_to_vec()?)?;
    Ok(body["releases"]
        .as_array()
        .and_then(|r| r.first())
        .and_then(|r| r["version"].as_str())
        .map(str::to_owned))
}

pub(crate) fn status(entry: &Path, json: bool) -> anyhow::Result<()> {
    let app = resolve(entry)?;
    let flathub = flathub_version(&app.id)?;
    let up_to_date = flathub.as_deref() == Some(app.version.as_str());
    if json {
        println!(
            "{}",
            serde_json::json!({
                "id": app.id,
                "version": app.version,
                "flathub": flathub,
                "upToDate": up_to_date,
            })
        );
    } else {
        match &flathub {
            None => ui::note(format!("{} is not on Flathub", app.id)),
            Some(v) if up_to_date => ui::done(format!("{} {v} is on Flathub", app.id)),
            Some(v) => ui::note(format!(
                "{}: Flathub has {v}, nsh.json has {}",
                app.id, app.version
            )),
        }
    }
    if !up_to_date {
        std::process::exit(1);
    }
    Ok(())
}

/// Flathub's app id rules: at least three parts of letters, digits, `_`
/// and `-` (only in the last), none starting with a digit.
fn id_problem(id: &str) -> Option<&'static str> {
    let parts: Vec<&str> = id.split('.').collect();
    if parts.len() < 3 {
        return Some("needs at least three parts (com.example.App)");
    }
    if id.len() > 255 {
        return Some("is longer than 255 characters");
    }
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || part.starts_with(|c: char| c.is_ascii_digit()) {
            return Some("has an empty part or one starting with a digit");
        }
        let last = i == parts.len() - 1;
        if !part
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || (last && c == '-'))
        {
            return Some("may only use letters, digits and `_` (and `-` in the last part)");
        }
    }
    None
}

#[derive(Default)]
struct Report {
    failed: usize,
}

impl Report {
    fn ok(&mut self, what: impl std::fmt::Display) {
        ui::done(what.to_string());
    }
    fn warn(&mut self, what: impl std::fmt::Display) {
        ui::warn(what.to_string());
    }
    fn fail(&mut self, what: impl std::fmt::Display) {
        self.failed += 1;
        ui::error(what.to_string());
    }
}

pub(crate) fn doctor(entry: &Path) -> anyhow::Result<()> {
    let mut r = Report::default();
    let app = resolve(entry)?;
    let store = &app.store;
    match id_problem(&app.id) {
        None => r.ok(format!("id {}", app.id)),
        Some(problem) => r.fail(format!("id {} {problem}", app.id)),
    }
    if app.config.version.is_some() {
        r.ok(format!("version {}", app.version));
    } else {
        r.warn("nsh.json has no `version`: packages say 1.0.0");
    }
    match &store.summary {
        None => r.fail("the store listing's subtitle (AppStream summary) is missing"),
        Some(s) if s.chars().count() > 35 => r.warn(format!(
            "the store listing's subtitle is {} characters: Flathub wants at most 35",
            s.chars().count()
        )),
        Some(_) => r.ok("summary (listing subtitle)"),
    }
    for (key, value) in [
        ("description", store.description.is_some()),
        ("store.linux.license", store.license.is_some()),
    ] {
        if value {
            r.ok(key)
        } else {
            r.fail(format!("{key} is missing"))
        }
    }
    for (key, value) in [
        ("store.linux.developer", store.developer.is_some()),
        ("store.linux.homepage", store.homepage.is_some()),
        ("store.linux.screenshots", !store.screenshots.is_empty()),
    ] {
        if value {
            r.ok(key)
        } else {
            r.warn(format!("{key} is missing: Flathub asks for it"))
        }
    }
    match app.config.icon(crate::package::PackageTarget::Linux) {
        None => r.fail("no icon for linux (`icon` in nsh.json)"),
        Some(icon) => match image::image_dimensions(icon) {
            Ok((w, h)) if w != h => r.fail(format!(
                "icon {} is {w}×{h}: it must be square",
                icon.display()
            )),
            Ok((w, _)) if w < ICON_SIZE => r.warn(format!(
                "icon {} is {w}×{w}: it is scaled up to {ICON_SIZE}×{ICON_SIZE}",
                icon.display()
            )),
            Ok(_) => r.ok(format!("icon {}", icon.display())),
            Err(e) => r.fail(format!("icon {}: {e}", icon.display())),
        },
    }
    let tmp = std::env::temp_dir().join(format!("nsh-doctor-{}", std::process::id()));
    fs::create_dir_all(&tmp)?;
    let linux = LinuxApp {
        name: &app.name,
        id: &app.id,
        executable: &app.executable,
        version: &app.version,
        store,
    };
    let meta = tmp.join(format!("{}.metainfo.xml", app.id));
    fs::write(&meta, metainfo(&linux))?;
    let desktop = tmp.join(format!("{}.desktop", app.id));
    fs::write(
        &desktop,
        crate::package::linux_desktop_entry(
            &app.config,
            store,
            &app.name,
            &app.id,
            &app.executable,
            true,
        ),
    )?;
    match which("appstreamcli") {
        Some(tool) => {
            let out = Command::new(tool)
                .args(["validate", "--no-net", "--explain"])
                .arg(&meta)
                .output()?;
            if out.status.success() {
                r.ok("metainfo passes appstreamcli validate");
            } else {
                r.fail(format!(
                    "metainfo fails appstreamcli validate:\n{}",
                    String::from_utf8_lossy(&out.stdout).trim()
                ));
            }
        }
        None => r.warn("appstreamcli is not installed: metainfo not validated"),
    }
    match which("desktop-file-validate") {
        Some(tool) => {
            let out = Command::new(tool).arg(&desktop).output()?;
            let text = String::from_utf8_lossy(&out.stdout);
            if out.status.success() && !text.contains("error:") {
                r.ok("desktop entry passes desktop-file-validate");
            } else {
                r.fail(format!(
                    "desktop entry fails desktop-file-validate:\n{}",
                    text.trim()
                ));
            }
        }
        None => r.warn("desktop-file-validate is not installed: desktop entry not validated"),
    }
    let _ = fs::remove_dir_all(&tmp);
    if r.failed > 0 {
        bail!(
            "{} problem(s) to fix before publishing to Flathub",
            r.failed
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> StoreConfig {
        StoreConfig {
            summary: Some("Counts <things>".into()),
            description: Some("First & one.\n\nSecond\nline.".into()),
            license: Some("MIT".into()),
            developer: Some("Example".into()),
            categories: vec!["Development".into()],
            screenshots: vec!["https://example.com/a.png".into()],
            ..StoreConfig::default()
        }
    }

    #[test]
    fn metadata_comes_from_the_shared_store_listing() {
        let store: crate::store::StoreConfig = serde_json::from_value(serde_json::json!({
            "locales": {
                "en-US": {
                    "subtitle": "Counts things",
                    "description": "Counts.",
                    "keywords": "count, tally,",
                    "marketingUrl": "https://example.com"
                },
                "de-DE": { "subtitle": "Zählt" }
            },
            "linux": { "license": "MIT", "categories": ["Utility"], "screenshots": ["https://example.com/a.png"] }
        }))
        .unwrap();
        let meta = StoreConfig::of(&store);
        assert_eq!(meta.summary.as_deref(), Some("Counts things"));
        assert_eq!(meta.description.as_deref(), Some("Counts."));
        assert_eq!(meta.keywords, ["count", "tally"]);
        assert_eq!(meta.homepage.as_deref(), Some("https://example.com"));
        assert_eq!(meta.license.as_deref(), Some("MIT"));
        assert_eq!(meta.categories, ["Utility"]);
        assert_eq!(meta.screenshots, ["https://example.com/a.png"]);
    }

    fn app(store: &StoreConfig) -> LinuxApp<'_> {
        LinuxApp {
            name: "Counter",
            id: "com.example.Counter",
            executable: "Counter",
            version: "1.2.0",
            store,
        }
    }

    #[test]
    fn metainfo_has_what_flathub_lists() {
        let s = store();
        let xml = metainfo(&app(&s));
        assert!(xml.contains("<id>com.example.Counter</id>"));
        assert!(xml.contains("<summary>Counts &lt;things&gt;</summary>"));
        assert!(xml.contains("<p>First &amp; one.</p>\n    <p>Second line.</p>"));
        assert!(xml.contains("<developer id=\"com.example\">"));
        assert!(
            xml.contains(
                "<launchable type=\"desktop-id\">com.example.Counter.desktop</launchable>"
            )
        );
        assert!(xml.contains("<release version=\"1.2.0\" date=\""));
        assert!(xml.contains("<screenshot type=\"default\">"));
    }

    #[test]
    fn civil_dates() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_416), "2025-11-24");
        assert_eq!(civil_date(11_016), "2000-02-29");
    }

    #[test]
    fn manifest_is_written_then_updated_in_place() {
        let s = store();
        let text = flatpak_manifest(
            &app(&s),
            &FlatpakConfig::default(),
            &ArchiveSource::Url {
                url: "https://e.com/a-1.tar.gz",
                sha256: "aaa",
            },
            "aarch64",
            true,
        );
        assert!(text.contains("runtime-version: '49'"));
        assert!(text.contains("command: Counter"));
        assert!(text.contains("hicolor/256x256/apps/com.example.Counter.png"));
        let edited = text.replace("  - --share=network\n", "");
        let updated =
            update_manifest(&edited, "https://e.com/a-2.tar.gz", "bbb", "x86_64").unwrap();
        assert!(updated.contains("url: https://e.com/a-2.tar.gz"));
        assert!(updated.contains("only-arches:\n          - x86_64\n"));
        assert!(!updated.contains("aarch64"));
        assert!(updated.contains("sha256: bbb"));
        assert!(!updated.contains("aaa"));
        assert!(!updated.contains("--share=network"));
        // A local build's manifest gains the hash.
        let local = flatpak_manifest(
            &app(&s),
            &FlatpakConfig::default(),
            &ArchiveSource::Path("../a.tar.gz"),
            "x86_64",
            false,
        );
        let updated = update_manifest(&local, "https://e.com/a.tar.gz", "ccc", "x86_64").unwrap();
        assert!(updated.contains("url: https://e.com/a.tar.gz\n        sha256: ccc\n"));
        assert!(update_manifest("id: x\n", "u", "s", "x86_64").is_none());
    }

    #[test]
    fn archive_arch_comes_from_the_executable() {
        let elf = |machine: u16| {
            let mut header = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0];
            header.resize(18, 0);
            header.extend(machine.to_le_bytes());
            header.extend([0; 44]);
            header
        };
        let dir = std::env::temp_dir().join(format!("nsh-flathub-arch-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let archive = |name: &str, files: &[(&str, Vec<u8>)]| {
            let path = dir.join(name);
            let gz = flate2::write::GzEncoder::new(
                fs::File::create(&path).unwrap(),
                flate2::Compression::fast(),
            );
            let mut tar = tar::Builder::new(gz);
            for (name, data) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o755);
                header.set_cksum();
                tar.append_data(&mut header, name, data.as_slice()).unwrap();
            }
            tar.into_inner().unwrap().finish().unwrap();
            path
        };
        let x86 = archive(
            "x86.tar.gz",
            &[
                ("Counter/lib.so", elf(0xb7)),
                ("Counter/Counter", elf(0x3e)),
            ],
        );
        assert_eq!(archive_arch(&x86, "Counter").unwrap(), "x86_64");
        let arm = archive("arm.tar.gz", &[("Counter/Counter", elf(0xb7))]);
        assert_eq!(archive_arch(&arm, "Counter").unwrap(), "aarch64");
        let none = archive("none.tar.gz", &[("Counter/Other", elf(0x3e))]);
        assert!(archive_arch(&none, "Counter").is_err());
        let text = archive(
            "text.tar.gz",
            &[("Counter/Counter", b"#!/bin/sh\n".to_vec())],
        );
        assert!(archive_arch(&text, "Counter").is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn flathub_ids() {
        assert_eq!(id_problem("com.example.Counter"), None);
        assert_eq!(id_problem("io.github.me.my-app"), None);
        assert!(id_problem("com.example").is_some());
        assert!(id_problem("com.my-co.app").is_some());
        assert!(id_problem("com.1example.app").is_some());
    }

    #[test]
    fn desktop_categories_default_to_utility() {
        assert_eq!(
            desktop_categories(&StoreConfig::default()),
            "Categories=Utility;"
        );
        assert_eq!(desktop_categories(&store()), "Categories=Development;");
    }
}
