//! Finding the versions of an nshm and installing one into
//! `~/.nsh/nshms/` (`nsh_bundler::nshm::installed_dir`).
//!
//! ```text
//! ~/.nsh/nshms/
//!   nsh-omarchy/0.3.2/            crates.io: the .crate, its sha256 checked, unpacked
//!   github.com/acme/ui/1.4.0/     a Git tag that is a version
//!   github.com/acme/ui/4f2a1c0e9b3d/  a commit (a branch, a rev or another tag)
//!   github.com/longbridge/nsh/4f2a1c0e9b3d/crates/nsh-extra/
//!                                 one of nsh's own nshm in nsh's repository
//!   .git/github.com/acme/ui/      one bare clone per repository
//! ```
//!
//! Each directory is one version, written whole (unpacked beside it, then
//! renamed) and never changed: every app on the machine shares it. The
//! ordinary crates a Rust nshm depends on stay Cargo's (`~/.cargo`).

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use anyhow::{Context as _, bail};
use sha2::{Digest as _, Sha256};

use super::{
    dep::{Origin, Ref},
    status,
};
use crate::rust_app;

/// The sparse index of crates.io.
const INDEX: &str = "https://index.crates.io";
/// Where crates.io serves `.crate` files.
const DOWNLOADS: &str = "https://static.crates.io/crates";

/// A version of an nshm on offer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Candidate {
    /// Its version, when the source says it before it is installed (a
    /// crate, a Git tag that is a version); else read from the nshm.
    pub version: Option<semver::Version>,
    /// The commit (Git).
    pub commit: Option<String>,
    /// `sha256-<hex>` of the `.crate` (crates.io).
    pub checksum: Option<String>,
    /// Yanked from crates.io: taken only when the lock has it.
    pub yanked: bool,
}

/// Lists and installs nshm: the network and Git, or a stand-in in tests.
pub(crate) trait Fetch {
    /// The versions of `name` from `origin` (not a directory).
    fn candidates(&mut self, name: &str, origin: &Origin) -> anyhow::Result<Vec<Candidate>>;
    /// Installs `candidate` of `name` from `origin` (a no-op when it is
    /// installed): its directory relative to the installation root.
    fn install(
        &mut self,
        name: &str,
        origin: &Origin,
        candidate: &Candidate,
    ) -> anyhow::Result<String>;
    /// The installation root.
    fn root(&self) -> &Path;
    /// Downloads, all at once, what [`Self::install`] will take of these
    /// crates.io `packages`: only a head start, as `install` downloads
    /// what is not there (and says what failed).
    fn prefetch(&mut self, packages: &[(String, Candidate)]) {
        let _ = packages;
    }
}

/// The most `.crate` files [`Net::prefetch`] downloads at once.
const PARALLEL_DOWNLOADS: usize = 8;

/// [`Fetch`] from crates.io and Git into `root`.
pub(crate) struct Net {
    root: PathBuf,
    agent: Option<ureq::Agent>,
    index: HashMap<String, Vec<Candidate>>,
    fetched: HashSet<String>,
    /// `.crate` files downloaded ahead ([`Fetch::prefetch`]), by
    /// `<name>-<version>`: taken by `install`.
    downloaded: HashMap<String, Vec<u8>>,
}

impl Net {
    pub(crate) fn new(root: PathBuf) -> Self {
        Net {
            root,
            agent: None,
            index: HashMap::new(),
            fetched: HashSet::new(),
            downloaded: HashMap::new(),
        }
    }

    fn agent(&mut self) -> &ureq::Agent {
        self.agent.get_or_insert_with(|| {
            ureq::Agent::config_builder()
                .http_status_as_error(false)
                .user_agent(concat!("nsh/", env!("CARGO_PKG_VERSION")))
                .build()
                .into()
        })
    }

    fn get(&mut self, url: &str) -> anyhow::Result<Option<Vec<u8>>> {
        get(self.agent(), url)
    }

    /// The bare clone of `url`, fetched once in this run.
    fn repository(&mut self, url: &str) -> anyhow::Result<PathBuf> {
        let repo = self.root.join(".git").join(repo_dir(url));
        if self.fetched.contains(url) {
            return Ok(repo);
        }
        status("Updating", format!("git repository `{url}`"));
        if repo.join("HEAD").is_file() {
            git(
                Some(&repo),
                &[
                    "fetch",
                    "--quiet",
                    "--force",
                    "--tags",
                    "--prune",
                    "origin",
                    "+refs/heads/*:refs/heads/*",
                ],
            )?;
            git(Some(&repo), &["remote", "set-head", "origin", "--auto"]).ok();
        } else {
            let _ = fs::remove_dir_all(&repo);
            fs::create_dir_all(repo.parent().expect("a repository has a parent"))?;
            git(
                None,
                &["clone", "--bare", "--quiet", url, &repo.to_string_lossy()],
            )
            .with_context(|| format!("cloning {url}"))?;
        }
        self.fetched.insert(url.to_owned());
        Ok(repo)
    }

    /// The bare clone of `url` holding `commit`, fetched when it does not.
    fn repository_with(&mut self, url: &str, commit: &str) -> anyhow::Result<PathBuf> {
        let repo = self.root.join(".git").join(repo_dir(url));
        let has = |repo: &Path| {
            git(
                Some(repo),
                &["cat-file", "-e", &format!("{commit}^{{commit}}")],
            )
            .is_ok()
        };
        if repo.join("HEAD").is_file() && has(&repo) {
            return Ok(repo);
        }
        let repo = self.repository(url)?;
        if !has(&repo) {
            bail!("{url}: no commit {commit} (was it force-pushed away?)");
        }
        Ok(repo)
    }
}

impl Fetch for Net {
    fn root(&self) -> &Path {
        &self.root
    }

    fn prefetch(&mut self, packages: &[(String, Candidate)]) {
        let wanted: Vec<(String, String)> = packages
            .iter()
            .filter_map(|(name, c)| {
                let version = c.version.as_ref()?;
                let key = format!("{name}-{version}");
                let installed = installed_dir(name, &Origin::Registry, c).ok()?;
                (!self.downloaded.contains_key(&key) && !self.root.join(installed).is_dir())
                    .then(|| (key, format!("{DOWNLOADS}/{name}/{name}-{version}.crate")))
            })
            .collect();
        if wanted.len() < 2 {
            return;
        }
        let step = crate::ui::Step::start(format!("downloading {} nshm", wanted.len()));
        let done = download_all(self.agent(), &wanted);
        step.finish();
        self.downloaded.extend(done);
    }

    fn candidates(&mut self, name: &str, origin: &Origin) -> anyhow::Result<Vec<Candidate>> {
        match origin {
            Origin::Registry => {
                if let Some(c) = self.index.get(name) {
                    return Ok(c.clone());
                }
                status("Updating", "crates.io index");
                let url = format!("{INDEX}/{}", index_path(name));
                let body = self
                    .get(&url)?
                    .with_context(|| format!("{name} is not on crates.io"))?;
                let list = parse_index(&String::from_utf8_lossy(&body), name)?;
                self.index.insert(name.to_owned(), list.clone());
                Ok(list)
            }
            Origin::Git { url, reference } => {
                let repo = self.repository(url)?;
                match reference {
                    Ref::Default => {
                        let tags = git(
                            Some(&repo),
                            &[
                                "for-each-ref",
                                "--format=%(refname:strip=2) %(objectname) %(*objectname)",
                                "refs/tags",
                            ],
                        )?;
                        let versions = tag_versions(&tags);
                        if !versions.is_empty() {
                            return Ok(versions);
                        }
                        // No versions: its default branch.
                        let commit = git(Some(&repo), &["rev-parse", "HEAD^{commit}"])
                            .with_context(|| format!("{url}: no default branch"))?;
                        Ok(vec![Candidate {
                            version: None,
                            commit: Some(commit),
                            checksum: None,
                            yanked: false,
                        }])
                    }
                    Ref::Tag(tag) => {
                        let commit = git(
                            Some(&repo),
                            &[
                                "rev-parse",
                                "--verify",
                                "--quiet",
                                &format!("refs/tags/{tag}^{{commit}}"),
                            ],
                        )
                        .with_context(|| format!("{url}: no tag {tag}"))?;
                        Ok(vec![Candidate {
                            version: tag_version(tag),
                            commit: Some(commit),
                            checksum: None,
                            yanked: false,
                        }])
                    }
                    Ref::Rev(rev) => {
                        let commit = git(
                            Some(&repo),
                            &[
                                "rev-parse",
                                "--verify",
                                "--quiet",
                                &format!("{rev}^{{commit}}"),
                            ],
                        )
                        .with_context(|| format!("{url}: no commit or branch {rev}"))?;
                        Ok(vec![Candidate {
                            version: None,
                            commit: Some(commit),
                            checksum: None,
                            yanked: false,
                        }])
                    }
                }
            }
            Origin::Path(_) => bail!("a directory has no versions to fetch"),
        }
    }

    fn install(
        &mut self,
        name: &str,
        origin: &Origin,
        candidate: &Candidate,
    ) -> anyhow::Result<String> {
        let base = installed_dir(name, origin, candidate)?;
        let dir = self.root.join(&base);
        // One of nsh's own nshm from a repository is a crate of nsh's
        // workspace there when the commit has it: installed with only that
        // crate and the workspace's manifest it takes its version from.
        let mut sub = own_crate(name, origin);
        if let Some(sub) = &sub
            && dir.join(sub).is_dir()
        {
            return Ok(format!("{base}/{sub}"));
        }
        if sub.is_none() && dir.is_dir() {
            return Ok(base);
        }
        let mut paths = Vec::new();
        if let (Some(s), Origin::Git { url, .. }) = (&sub, origin) {
            let commit = candidate.commit.as_deref().context("a commit")?;
            let repo = self.repository_with(url, commit)?;
            let manifest = format!("{commit}:{s}/Cargo.toml");
            if git(Some(&repo), &["cat-file", "-e", &manifest]).is_ok() {
                paths = vec!["Cargo.toml".to_owned(), s.clone()];
            } else {
                sub = None;
                if dir.is_dir() {
                    return Ok(base);
                }
            }
        }
        let parent = dir.parent().expect("an installed nshm has a parent");
        fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(
            ".{}.tmp-{}",
            dir.file_name().unwrap_or_default().to_string_lossy(),
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp)?;
        let unpacked = match origin {
            Origin::Registry => {
                let version = candidate.version.as_ref().context("a crate's version")?;
                let body = match self.downloaded.remove(&format!("{name}-{version}")) {
                    Some(body) => body,
                    None => {
                        // A spinner while it downloads: the `Installed` line below
                        // says it once it is there.
                        let step = crate::ui::Step::start(format!("downloading {name} v{version}"));
                        let url = format!("{DOWNLOADS}/{name}/{name}-{version}.crate");
                        let body = self
                            .get(&url)?
                            .with_context(|| format!("{name} v{version} is not on crates.io"))?;
                        step.finish();
                        body
                    }
                };
                if let Some(expected) = &candidate.checksum {
                    let actual = checksum(&body);
                    if &actual != expected {
                        let _ = fs::remove_dir_all(&tmp);
                        bail!(
                            "{name} v{version}: the download's checksum is {actual}, not {expected}"
                        );
                    }
                }
                tar::Archive::new(flate2::read::GzDecoder::new(&body[..]))
                    .unpack(&tmp)
                    .with_context(|| format!("unpacking {name} v{version}"))?;
                // A .crate holds `<name>-<version>/`.
                tmp.join(format!("{name}-{version}"))
            }
            Origin::Git { url, .. } => {
                let commit = candidate.commit.as_deref().context("a commit")?;
                let repo = self.repository_with(url, commit)?;
                let mut child = Command::new("git")
                    .arg("-C")
                    .arg(&repo)
                    .args(["archive", "--format=tar", commit])
                    .args(&paths)
                    .env("GIT_TERMINAL_PROMPT", "0")
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .context("running git")?;
                let stdout = child.stdout.take().expect("piped");
                let unpacked = tar::Archive::new(stdout).unpack(&tmp);
                let output = child.wait_with_output()?;
                if !output.status.success() {
                    let _ = fs::remove_dir_all(&tmp);
                    bail!(
                        "git archive {commit}: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    );
                }
                unpacked.with_context(|| format!("unpacking {url} at {commit}"))?;
                tmp.clone()
            }
            Origin::Path(_) => bail!("a directory is not installed"),
        };
        // Another of nsh's own nshm at this commit is installed: this one
        // joins it.
        let (from, to) = match &sub {
            Some(s) if dir.is_dir() => (unpacked.join(s), dir.join(s)),
            _ => (unpacked, dir.clone()),
        };
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::rename(&from, &to) {
            Ok(()) => {}
            // Installed meanwhile by another nsh: that copy is the same.
            Err(_) if to.is_dir() => {}
            Err(e) => {
                let _ = fs::remove_dir_all(&tmp);
                return Err(e).with_context(|| format!("installing {}", to.display()));
            }
        }
        let _ = fs::remove_dir_all(&tmp);
        let rel = match &sub {
            Some(s) => format!("{base}/{s}"),
            None => base,
        };
        let shown = if name.is_empty() {
            match origin {
                Origin::Git { url, .. } => repo_dir(url)
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_owned(),
                _ => String::new(),
            }
        } else {
            name.to_owned()
        };
        let at = match (&candidate.version, &candidate.commit) {
            (Some(v), _) => format!(" v{v}"),
            (None, Some(c)) => format!(" #{}", &c[..c.len().min(12)]),
            _ => String::new(),
        };
        status("Installed", format!("{shown}{at}"));
        Ok(rel)
    }
}

/// The bodies of `urls` (`(key, url)`), up to [`PARALLEL_DOWNLOADS`] at a
/// time, the threads sharing `agent` and its connections, by key: those that
/// failed are left out.
fn download_all(agent: &ureq::Agent, urls: &[(String, String)]) -> Vec<(String, Vec<u8>)> {
    let next = AtomicUsize::new(0);
    let done = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for _ in 0..urls.len().min(PARALLEL_DOWNLOADS) {
            scope.spawn(|| {
                while let Some((key, url)) = urls.get(next.fetch_add(1, Ordering::Relaxed)) {
                    if let Ok(Some(body)) = get(agent, url) {
                        done.lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push((key.clone(), body));
                    }
                }
            });
        }
    });
    done.into_inner().unwrap_or_else(|e| e.into_inner())
}

/// GET `url` with `agent`: its body, or `None` when there is none (404, 410).
fn get(agent: &ureq::Agent, url: &str) -> anyhow::Result<Option<Vec<u8>>> {
    let mut response = agent
        .get(url)
        .call()
        .with_context(|| format!("GET {url}"))?;
    match response.status().as_u16() {
        200 => {
            let mut body = Vec::new();
            response
                .body_mut()
                .as_reader()
                .read_to_end(&mut body)
                .with_context(|| format!("reading {url}"))?;
            Ok(Some(body))
        }
        404 | 410 => Ok(None),
        code => bail!("GET {url}: HTTP {code}"),
    }
}

/// The directory of nsh's own nshm `name` ([`rust_app::OWN_NSHM`]) in a
/// repository of nsh that `origin` is: `crates/<name>`.
fn own_crate(name: &str, origin: &Origin) -> Option<String> {
    (matches!(origin, Origin::Git { .. }) && rust_app::OWN_NSHM.contains(&name))
        .then(|| format!("crates/{name}"))
}

/// The directory, relative to the installation root, of `candidate` of
/// `name` from `origin`.
pub(crate) fn installed_dir(
    name: &str,
    origin: &Origin,
    candidate: &Candidate,
) -> anyhow::Result<String> {
    Ok(match origin {
        Origin::Registry => format!(
            "{name}/{}",
            candidate.version.as_ref().context("a crate's version")?
        ),
        Origin::Git { url, .. } => {
            let at = match (&candidate.version, &candidate.commit) {
                (Some(v), _) => v.to_string(),
                (None, Some(c)) => c[..c.len().min(12)].to_owned(),
                (None, None) => bail!("{url}: nothing to install"),
            };
            format!("{}/{at}", repo_dir(url))
        }
        Origin::Path(_) => bail!("a directory is not installed"),
    })
}

/// Where the repository `url` goes below the root: `github.com/acme/ui`
/// for `https://github.com/acme/ui(.git)` and `git@github.com:acme/ui.git`.
pub(crate) fn repo_dir(url: &str) -> String {
    let rest = url
        .split_once("://")
        .map_or(url, |(_, rest)| rest)
        .trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    // `user@host:path`, scp-like.
    let rest = match rest.split_once('@') {
        Some((user, after)) if !user.contains('/') => after,
        _ => rest,
    };
    let rest = if url.contains("://") {
        rest.to_owned()
    } else {
        rest.replacen(':', "/", 1)
    };
    let parts: Vec<String> = rest
        .split(['/', '\\', ':'])
        .map(|p| {
            p.chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                .collect::<String>()
        })
        .filter(|p| !p.is_empty() && p != "." && p != "..")
        .collect();
    if parts.is_empty() {
        "repository".to_owned()
    } else {
        parts.join("/")
    }
}

/// The path of `name` in crates.io's index.
fn index_path(name: &str) -> String {
    let name = name.to_ascii_lowercase();
    match name.len() {
        1 => format!("1/{name}"),
        2 => format!("2/{name}"),
        3 => format!("3/{}/{name}", &name[..1]),
        _ => format!("{}/{}/{name}", &name[..2], &name[2..4]),
    }
}

/// The versions of `name` in its index file `text` (a JSON object a line).
fn parse_index(text: &str, name: &str) -> anyhow::Result<Vec<Candidate>> {
    let mut out = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let entry: serde_json::Value =
            serde_json::from_str(line).with_context(|| format!("crates.io index of {name}"))?;
        let Some(version) = entry["vers"]
            .as_str()
            .and_then(|v| semver::Version::parse(v).ok())
        else {
            continue;
        };
        out.push(Candidate {
            version: Some(version),
            commit: None,
            checksum: entry["cksum"].as_str().map(|c| format!("sha256-{c}")),
            yanked: entry["yanked"].as_bool().unwrap_or(false),
        });
    }
    Ok(out)
}

/// The tags of `for-each-ref` output `text` (`<tag> <object> <peeled>`)
/// that are versions (`1.4.0`, `v1.4.0`), with their commits.
fn tag_versions(text: &str) -> Vec<Candidate> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let tag = parts.next()?;
            let object = parts.next()?;
            // An annotated tag's commit is the peeled object.
            let commit = parts.next().unwrap_or(object);
            Some(Candidate {
                version: Some(tag_version(tag)?),
                commit: Some(commit.to_owned()),
                checksum: None,
                yanked: false,
            })
        })
        .collect()
}

/// The version a tag names: `1.4.0` or `v1.4.0`.
fn tag_version(tag: &str) -> Option<semver::Version> {
    semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

/// `sha256-<hex>` of `bytes`.
fn checksum(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    format!("sha256-{hex}")
}

/// `git` with `args`, in `dir`; its trimmed output.
pub(crate) fn git(dir: Option<&Path>, args: &[&str]) -> anyhow::Result<String> {
    let mut cmd = Command::new("git");
    if let Some(dir) = dir {
        cmd.arg("-C").arg(dir);
    }
    let out = cmd
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .context("running git (is Git installed?)")?;
    if !out.status.success() {
        bail!(
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repositories_have_one_place() {
        assert_eq!(repo_dir("https://github.com/acme/ui"), "github.com/acme/ui");
        assert_eq!(
            repo_dir("https://github.com/acme/ui.git/"),
            "github.com/acme/ui"
        );
        assert_eq!(repo_dir("git@github.com:acme/ui.git"), "github.com/acme/ui");
        assert_eq!(
            repo_dir("ssh://git@git.example.com:2222/a/b.git"),
            "git.example.com/2222/a/b"
        );
        assert_eq!(repo_dir("file:///tmp/x/../repo"), "tmp/x/repo");
    }

    #[test]
    fn crates_io_index_is_read() {
        assert_eq!(index_path("a"), "1/a");
        assert_eq!(index_path("ab"), "2/ab");
        assert_eq!(index_path("abc"), "3/a/abc");
        assert_eq!(index_path("NSH-Omarchy"), "ns/h-/nsh-omarchy");
        let text = concat!(
            r#"{"name":"acme","vers":"0.1.0","cksum":"aa","yanked":false}"#,
            "\n",
            r#"{"name":"acme","vers":"0.2.0","cksum":"bb","yanked":true}"#,
            "\n"
        );
        let list = parse_index(text, "acme").unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].checksum.as_deref(), Some("sha256-aa"));
        assert!(list[1].yanked);
    }

    #[test]
    fn version_tags_are_found() {
        let list = tag_versions("v1.2.0 aaa bbb\n1.3.0 ccc\nrelease-x ddd\n");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].commit.as_deref(), Some("bbb"));
        assert_eq!(list[1].version.as_ref().unwrap().to_string(), "1.3.0");
    }

    /// nsh's own nshm from a repository of nsh: its crate, with the
    /// workspace manifest it takes its version from and nothing else.
    #[test]
    fn nshs_own_nshm_installs_its_crate_from_nshs_repository() {
        if git(None, &["--version"]).is_err() {
            return;
        }
        let base = std::env::temp_dir().join(format!("nsh-fetch-own-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let repo = base.join("nsh");
        for dir in ["crates/nsh-extra/src", "crates/nsh-core/src", "website"] {
            fs::create_dir_all(repo.join(dir)).unwrap();
        }
        fs::write(
            repo.join("Cargo.toml"),
            "[workspace]\nmembers = [\"crates/*\"]\n\n[workspace.package]\nversion = \"0.6.0\"\n",
        )
        .unwrap();
        fs::write(
            repo.join("crates/nsh-extra/Cargo.toml"),
            "[package]\nname = \"nsh-extra\"\nversion.workspace = true\n",
        )
        .unwrap();
        fs::write(repo.join("crates/nsh-extra/src/lib.rs"), "").unwrap();
        fs::write(repo.join("crates/nsh-core/src/lib.rs"), "").unwrap();
        fs::write(repo.join("website/index.md"), "").unwrap();
        let run = |args: &[&str]| git(Some(&repo), args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["add", "."]);
        run(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "nsh",
        ]);
        let commit = run(&["rev-parse", "HEAD"]);
        let url = format!("file://{}", repo.display());
        let origin = Origin::Git {
            url: url.clone(),
            reference: Ref::Rev(commit.clone()),
        };
        let mut net = Net::new(base.join("nshms"));
        let candidates = net.candidates("nsh-extra", &origin).unwrap();
        assert_eq!(candidates[0].commit.as_deref(), Some(commit.as_str()));
        let rel = net.install("nsh-extra", &origin, &candidates[0]).unwrap();
        assert_eq!(
            rel,
            format!("{}/{}/crates/nsh-extra", repo_dir(&url), &commit[..12])
        );
        let installed = base.join("nshms").join(&rel);
        assert!(installed.join("src/lib.rs").is_file());
        let root = installed.parent().unwrap().parent().unwrap();
        assert!(root.join("Cargo.toml").is_file());
        assert!(!root.join("crates/nsh-core").exists());
        assert!(!root.join("website").exists());
        // Installed: the same directory, without Git.
        assert_eq!(
            net.install("nsh-extra", &origin, &candidates[0]).unwrap(),
            rel
        );
        fs::remove_dir_all(&base).unwrap();
    }

    /// `.crate` bytes holding `<name>-<version>/nsh.json`.
    fn dot_crate(name: &str, version: &str) -> Vec<u8> {
        let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
            Vec::new(),
            flate2::Compression::fast(),
        ));
        let body = format!(r#"{{"name":"{name}","version":"{version}"}}"#);
        let mut header = tar::Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(
            &mut header,
            format!("{name}-{version}/nsh.json"),
            body.as_bytes(),
        )
        .unwrap();
        tar.into_inner().unwrap().finish().unwrap()
    }

    /// A crate downloaded ahead is installed without the network, its
    /// checksum checked as one downloaded then.
    #[test]
    fn a_crate_downloaded_ahead_is_checked_and_installed() {
        let root = std::env::temp_dir().join(format!("nsh-fetch-ahead-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let mut net = Net::new(root.clone());
        let body = dot_crate("acme", "0.1.0");
        let candidate = Candidate {
            version: Some(semver::Version::new(0, 1, 0)),
            commit: None,
            checksum: Some(checksum(b"something else")),
            yanked: false,
        };
        net.downloaded.insert("acme-0.1.0".into(), body.clone());
        let err = net
            .install("acme", &Origin::Registry, &candidate)
            .unwrap_err();
        assert!(err.to_string().contains("checksum"), "{err}");
        assert!(!root.join("acme/0.1.0").exists());
        assert_eq!(fs::read_dir(root.join("acme")).unwrap().count(), 0);

        let candidate = Candidate {
            checksum: Some(checksum(&body)),
            ..candidate
        };
        net.downloaded.insert("acme-0.1.0".into(), body);
        let rel = net.install("acme", &Origin::Registry, &candidate).unwrap();
        assert_eq!(rel, "acme/0.1.0");
        assert!(root.join("acme/0.1.0/nsh.json").is_file());
        assert!(net.downloaded.is_empty());
        // Nothing left beside it.
        assert_eq!(fs::read_dir(root.join("acme")).unwrap().count(), 1);
        fs::remove_dir_all(&root).unwrap();
    }

    /// Downloads run at once; one that fails is left out (for `install`
    /// to download again and report).
    #[test]
    fn downloads_run_at_once() {
        use std::{
            io::{BufRead as _, BufReader, Write as _},
            net::TcpListener,
            sync::{Arc, atomic::AtomicUsize},
            time::{Duration, Instant},
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let in_flight = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        {
            let (in_flight, most) = (in_flight.clone(), most.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { break };
                    let (in_flight, most) = (in_flight.clone(), most.clone());
                    std::thread::spawn(move || {
                        let mut line = String::new();
                        let mut reader = BufReader::new(stream.try_clone().unwrap());
                        reader.read_line(&mut line).unwrap();
                        while {
                            let mut header = String::new();
                            reader.read_line(&mut header).unwrap() > 2
                        } {}
                        let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                        most.fetch_max(now, Ordering::SeqCst);
                        // Held until another request is in flight too.
                        let start = Instant::now();
                        while most.load(Ordering::SeqCst) < 2
                            && start.elapsed() < Duration::from_secs(10)
                        {
                            std::thread::sleep(Duration::from_millis(5));
                        }
                        let path = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                        let response = if path == "/missing" {
                            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .to_owned()
                        } else {
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{path}",
                                path.len()
                            )
                        };
                        in_flight.fetch_sub(1, Ordering::SeqCst);
                        stream.write_all(response.as_bytes()).unwrap();
                    });
                }
            });
        }
        let urls: Vec<(String, String)> = ["a", "b", "c", "missing", "d"]
            .iter()
            .map(|k| ((*k).to_owned(), format!("http://127.0.0.1:{port}/{k}")))
            .collect();
        let mut net = Net::new(std::env::temp_dir());
        let mut done = download_all(net.agent(), &urls);
        done.sort();
        let keys: Vec<&str> = done.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["a", "b", "c", "d"]);
        assert_eq!(done[0].1, b"/a");
        assert!(most.load(Ordering::SeqCst) >= 2);
    }

    #[test]
    fn versions_and_commits_have_their_own_directories() {
        let gh = Origin::Git {
            url: "https://github.com/acme/ui".into(),
            reference: Ref::Default,
        };
        let tag = Candidate {
            version: Some(semver::Version::new(1, 4, 0)),
            commit: Some("4f2a1c0e9b3d77".into()),
            checksum: None,
            yanked: false,
        };
        assert_eq!(
            installed_dir("acme-ui", &gh, &tag).unwrap(),
            "github.com/acme/ui/1.4.0"
        );
        let head = Candidate {
            version: None,
            ..tag.clone()
        };
        assert_eq!(
            installed_dir("acme-ui", &gh, &head).unwrap(),
            "github.com/acme/ui/4f2a1c0e9b3d"
        );
        assert_eq!(
            installed_dir("nsh-omarchy", &Origin::Registry, &tag).unwrap(),
            "nsh-omarchy/1.4.0"
        );
        assert_eq!(checksum(b"hello").len(), "sha256-".len() + 64);
    }
}
