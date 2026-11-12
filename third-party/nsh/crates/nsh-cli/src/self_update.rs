//! `nsh update`: replaces the installed distribution (`~/.nsh`,
//! `%LOCALAPPDATA%\nsh`, wherever the install script put it) with the latest
//! release or nightly build on GitHub Releases, the same archives the install
//! scripts download, checked against their `.sha256`.
//!
//! The channel a build is on is stamped at build time (`NSH_CHANNEL`, set by
//! the release workflow's nightly run), so `nsh update` stays on it;
//! naming a channel switches (`nsh update nightly`, as `rustup update
//! nightly`). The latest release is read from the redirect of
//! `releases/latest` and the nightly's revision from its `nsh-release.json`,
//! neither of them an API call, so no rate limit applies. The directory is
//! swapped by `nsh_updater`'s installation, which also handles Windows'
//! running executable; the components installed beside it
//! (`crate::component`) are added again by the new nsh.

use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
};

use anyhow::{Context as _, bail};
use nsh_updater::install::Installation;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::{runtime, ui};

/// Where the releases are published.
const REPOSITORY: &str = "longbridge/nsh";
/// The nightly release's tag, moved to each build.
const NIGHTLY: &str = "nightly";
/// The nightly's description of itself, an asset of the release.
const RELEASE_INFO: &str = "nsh-release.json";

/// A release channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub(crate) enum Channel {
    /// The releases (`vX.Y.Z`).
    Stable,
    /// The latest `main`, built every night it changes.
    Nightly,
}

impl Channel {
    /// The channel this build was published on.
    fn current() -> Channel {
        if env!("NSH_CHANNEL") == "nightly" {
            Channel::Nightly
        } else {
            Channel::Stable
        }
    }

    fn name(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Nightly => "nightly",
        }
    }
}

/// `nsh-release.json`.
#[derive(Debug, Deserialize)]
struct ReleaseInfo {
    /// The workspace version it was built at.
    version: String,
    /// The full revision of `main` it was built from.
    commit: String,
    /// The UTC day it was built, `YYYY-MM-DD`; older descriptions lack it.
    #[serde(default)]
    date: Option<String>,
}

/// What the channel offers.
struct Offer {
    /// The release's tag, for its download URLs.
    tag: String,
    /// How it is shown: `0.5.0`, `0.4.0 (abcdef0 nightly 2026-11-10)`.
    label: String,
    /// Whether it differs from this build in the way that matters: a newer
    /// version on the stable channel, another revision on the nightly one,
    /// anything after a switch.
    newer: bool,
}

/// `nsh update [stable|nightly]`.
pub(crate) fn update(channel: Option<Channel>) -> anyhow::Result<()> {
    let current = Channel::current();
    let channel = channel.unwrap_or(current);
    let exe = runtime::cli_exe()?;
    let root = distribution(&exe)?;
    let installation = Installation::directory(&root, &exe)
        .context("the nsh executable is not inside its distribution")?;
    installation.remove_leftovers();
    if !installation.can_install() {
        bail!(
            "cannot write next to {}; update it as the user who installed it",
            ui::path(&root)
        );
    }
    let asset = asset()?;
    let agent = agent();
    // Replacing the directory drops the components: the new nsh adds them
    // again, from its own release.
    let components = crate::component::installed(&root);

    let step = ui::Step::start(format!("checking the {} channel", channel.name()));
    let offer = match channel {
        Channel::Stable => stable(&agent, current)?,
        Channel::Nightly => nightly(&agent, current)?,
    };
    step.finish();
    if !offer.newer {
        ui::done(format!(
            "nsh {} is the latest on the {} channel",
            env!("NSH_VERSION_TEXT"),
            channel.name()
        ));
        return Ok(());
    }

    let url = asset_url(&offer.tag, &asset);
    let dir = crate::check::cache()?.join("updates");
    fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    let archive = dir.join(format!("{}-{asset}", std::process::id()));
    let result = (|| {
        let step = ui::Step::start(format!("downloading nsh {}", offer.label));
        download(&agent, &url, &archive, &step)?;
        step.finish();
        let step = ui::Step::start(format!("installing into {}", ui::path(&root)));
        installation
            .install(&archive)
            .with_context(|| format!("replace {}", root.display()))?;
        step.finish();
        anyhow::Ok(())
    })();
    let _ = fs::remove_file(&archive);
    result?;

    let installed = std::process::Command::new(&exe)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned())
        .unwrap_or_else(|| format!("nsh {}", offer.label));
    ui::done(format!("updated to {installed}"));
    if !components.is_empty() {
        let status = std::process::Command::new(&exe)
            .args(["component", "add"])
            .args(&components)
            .status()
            .context("add the components again")?;
        if !status.success() {
            bail!(
                "could not add the components again: run `nsh component add {}`",
                components.join(" ")
            );
        }
    }
    Ok(())
}

/// The distribution's directory holding `exe` (`<root>/bin/nsh`), or why
/// `nsh update` leaves this nsh to whatever installed it.
fn distribution(exe: &Path) -> anyhow::Result<PathBuf> {
    let text = exe.to_string_lossy().replace('\\', "/");
    let managers = [
        (
            "/Cellar/",
            "Homebrew installed this nsh: run `brew upgrade nsh`",
        ),
        (
            "/scoop/apps/",
            "Scoop installed this nsh: run `scoop update nsh`",
        ),
        (
            "/mise/installs/",
            "mise installed this nsh: run `mise upgrade`",
        ),
    ];
    if let Some((_, hint)) = managers.iter().find(|(part, _)| text.contains(part)) {
        bail!("{hint}");
    }
    let root = exe
        .parent()
        .filter(|bin| bin.file_name().is_some_and(|name| name == "bin"))
        .and_then(Path::parent)
        .filter(|root| root.join("runtime").is_dir());
    match root {
        Some(root) => Ok(root.to_owned()),
        None => bail!(
            "{} is not an installed distribution (built from source?); update the checkout \
             with Git, or install a release: https://nsh.dev/docs/installation",
            ui::path(exe)
        ),
    }
}

/// The archive of this machine's platform.
fn asset() -> anyhow::Result<String> {
    let host = host()?;
    Ok(if cfg!(windows) {
        format!("nsh-{host}.zip")
    } else {
        format!("nsh-{host}.tar.gz")
    })
}

/// This machine's platform as release assets name it (`macos-arm64`).
pub(crate) fn host() -> anyhow::Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x86_64",
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-arm64",
        ("windows", "x86_64") => "windows-x86_64",
        ("windows", "aarch64") => "windows-arm64",
        (os, arch) => bail!("no prebuilt nsh for {os} {arch}; build it from source"),
    })
}

/// The release this build was published as: its tag (`v0.4.0`, `nightly`),
/// where its components are.
pub(crate) fn own_tag() -> String {
    match Channel::current() {
        Channel::Nightly => NIGHTLY.to_owned(),
        Channel::Stable => format!("v{}", env!("CARGO_PKG_VERSION")),
    }
}

/// The URL of `asset` of the release `tag`.
pub(crate) fn asset_url(tag: &str, asset: &str) -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{asset}")
}

/// Errors as statuses, redirects not followed: `releases/latest` names the
/// latest release in its `Location`.
pub(crate) fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .build()
        .into()
}

/// Follows redirects (the assets are served from another host).
fn get(agent: &ureq::Agent, url: &str) -> anyhow::Result<ureq::http::Response<ureq::Body>> {
    let mut url = url.to_owned();
    for _ in 0..10 {
        let response = agent
            .get(&url)
            .call()
            .with_context(|| format!("GET {url}"))?;
        let status = response.status();
        if !status.is_redirection() {
            if !status.is_success() {
                bail!("GET {url}: {status}");
            }
            return Ok(response);
        }
        url = location(&response).with_context(|| format!("GET {url}: {status}"))?;
    }
    bail!("GET {url}: too many redirects")
}

fn location(response: &ureq::http::Response<ureq::Body>) -> Option<String> {
    response
        .headers()
        .get("location")?
        .to_str()
        .ok()
        .map(str::to_owned)
}

fn stable(agent: &ureq::Agent, current: Channel) -> anyhow::Result<Offer> {
    let url = format!("https://github.com/{REPOSITORY}/releases/latest");
    let response = agent
        .get(&url)
        .call()
        .with_context(|| format!("GET {url}"))?;
    let tag = location(&response)
        .as_deref()
        .and_then(tag_of)
        .with_context(|| format!("GET {url}: {} names no release", response.status()))?;
    let version = semver::Version::parse(tag.trim_start_matches('v'))
        .with_context(|| format!("the latest release, {tag}, has no version"))?;
    let this = semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("the package version");
    Ok(Offer {
        label: version.to_string(),
        newer: current != Channel::Stable || version > this,
        tag,
    })
}

/// The tag in a release's URL (`…/releases/tag/<tag>`).
fn tag_of(location: &str) -> Option<String> {
    let (_, tag) = location.rsplit_once("/releases/tag/")?;
    let tag = tag.split(['?', '#']).next()?;
    (!tag.is_empty() && !tag.contains('/')).then(|| tag.to_owned())
}

fn nightly(agent: &ureq::Agent, current: Channel) -> anyhow::Result<Offer> {
    let url = format!("https://github.com/{REPOSITORY}/releases/download/{NIGHTLY}/{RELEASE_INFO}");
    let mut body = get(agent, &url)?.into_body();
    let info: ReleaseInfo = serde_json::from_slice(
        &body
            .with_config()
            .limit(64 * 1024)
            .read_to_vec()
            .with_context(|| format!("GET {url}"))?,
    )
    .with_context(|| format!("{url} is not a release description"))?;
    let short = info.commit.get(..7).unwrap_or(&info.commit);
    Ok(Offer {
        tag: NIGHTLY.to_owned(),
        label: match &info.date {
            Some(date) => format!("{} ({short} nightly {date})", info.version),
            None => format!("{} ({short} nightly)", info.version),
        },
        newer: current != Channel::Nightly || !info.commit.starts_with(env!("NSH_GIT_SHA")),
    })
}

/// Downloads `url` to `to`, checked against `url.sha256`.
pub(crate) fn download(
    agent: &ureq::Agent,
    url: &str,
    to: &Path,
    step: &ui::Step,
) -> anyhow::Result<()> {
    let sum_url = format!("{url}.sha256");
    let sum = get(agent, &sum_url)?
        .into_body()
        .read_to_string()
        .with_context(|| format!("GET {sum_url}"))?;
    let expected = sum
        .split_whitespace()
        .next()
        .filter(|hash| hash.len() == 64)
        .with_context(|| format!("{sum_url} holds no SHA-256"))?
        .to_ascii_lowercase();

    let response = get(agent, url)?;
    let total = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    let mut reader = response.into_body().into_reader();
    let mut file = fs::File::create(to).with_context(|| format!("create {}", to.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 256 * 1024];
    let mut done = 0;
    loop {
        let n = reader
            .read(&mut buffer)
            .with_context(|| format!("GET {url}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        file.write_all(&buffer[..n])
            .with_context(|| format!("write {}", to.display()))?;
        done += n;
        step.status(&match total {
            Some(total) => format!("{} of {}", ui::bytes(done), ui::bytes(total)),
            None => ui::bytes(done),
        });
    }
    file.sync_all()?;
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        bail!("the download of {url} does not match its SHA-256");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_latest_release_is_read_from_its_url() {
        assert_eq!(
            tag_of("https://github.com/longbridge/nsh/releases/tag/v0.4.0").as_deref(),
            Some("v0.4.0")
        );
        assert_eq!(tag_of("https://github.com/longbridge/nsh/releases"), None);
        assert_eq!(
            tag_of("https://github.com/longbridge/nsh/releases/tag/"),
            None
        );
    }

    #[test]
    fn only_a_distribution_updates_itself() {
        let dir = std::env::temp_dir().join(format!("nsh-self-update-{}", std::process::id()));
        let exe = dir.join("nsh/bin/nsh");
        fs::create_dir_all(dir.join("nsh/runtime")).unwrap();
        fs::create_dir_all(exe.parent().unwrap()).unwrap();
        assert_eq!(distribution(&exe).unwrap(), dir.join("nsh"));
        // A checkout's build.
        assert!(distribution(&dir.join("target/release/nsh")).is_err());
        // Package managers update their own.
        let brew = Path::new("/opt/homebrew/Cellar/nsh/0.4.0/bin/nsh");
        assert!(
            distribution(brew)
                .unwrap_err()
                .to_string()
                .contains("brew upgrade")
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
