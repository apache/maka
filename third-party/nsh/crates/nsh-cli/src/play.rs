//! `nsh publish android`: uploads an Android App Bundle (`.aab`) to a Google
//! Play track (internal testing unless `--track` names another), or promotes
//! a release between tracks, with the Google Play Developer API; plus
//! `nsh publish status android` and `nsh publish doctor android`.
//!
//! A release is one edit: `edits.insert` → `edits.bundles.upload` (or
//! `edits.tracks.get` of the track promoted from) → `edits.tracks.update`
//! → listings and images with `--listing` → `edits.commit`; an edit that
//! fails on the way is deleted, so nothing half-done is left on Play.
//! Auth is a service account: its JSON key signs a JWT (RS256) that
//! `token_uri` exchanges for an access token (OAuth 2.0 JWT bearer grant).
//! The key's path comes from `--credentials` or `NSH_PLAY_CREDENTIALS` and
//! is never copied anywhere.
//!
//! HTTP goes through [`Transport`], so the request flow is tested without
//! the network.

use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context as _, bail};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{store, ui};

const SCOPE: &str = "https://www.googleapis.com/auth/androidpublisher";
const API: &str = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_API: &str =
    "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
/// The track a release goes to unless `--track` names another: testers get
/// it at once, and nothing reaches the public without an explicit flag.
pub(crate) const DEFAULT_TRACK: &str = "internal";

/// A service account's JSON key, the fields used.
#[derive(Deserialize)]
pub(crate) struct ServiceAccount {
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_owned()
}

impl ServiceAccount {
    pub(crate) fn read(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("the service account key {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| {
            format!(
                "{} is not a service account's JSON key (it needs client_email and private_key)",
                path.display()
            )
        })
    }

    /// A signed JWT asking `token_uri` for an access token to the Play
    /// Developer API, valid an hour from `now` (seconds since the epoch).
    pub(crate) fn assertion(&self, now: u64) -> anyhow::Result<String> {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = json!({
            "iss": self.client_email,
            "scope": SCOPE,
            "aud": self.token_uri,
            "iat": now,
            "exp": now + 3600,
        });
        let claims = URL_SAFE_NO_PAD.encode(claims.to_string());
        let message = format!("{header}.{claims}");
        let key = ring::signature::RsaKeyPair::from_pkcs8(&pem_der(&self.private_key)?)
            .map_err(|e| anyhow::anyhow!("the service account's private_key: {e}"))?;
        let mut signature = vec![0; key.public().modulus_len()];
        key.sign(
            &ring::signature::RSA_PKCS1_SHA256,
            &ring::rand::SystemRandom::new(),
            message.as_bytes(),
            &mut signature,
        )
        .map_err(|_| anyhow::anyhow!("could not sign with the service account's private_key"))?;
        Ok(format!("{message}.{}", URL_SAFE_NO_PAD.encode(signature)))
    }
}

/// The DER bytes of a PEM `PRIVATE KEY` (PKCS #8, as Google writes them).
fn pem_der(pem: &str) -> anyhow::Result<Vec<u8>> {
    let body: String = pem
        .lines()
        .map(str::trim)
        .filter(|l| !l.starts_with("-----"))
        .collect();
    STANDARD
        .decode(body)
        .context("the service account's private_key is not PEM")
}

/// An HTTP request, as [`Transport`] sends it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Request {
    pub method: &'static str,
    pub url: String,
    pub content_type: Option<&'static str>,
    pub token: Option<String>,
    pub body: Vec<u8>,
}

pub(crate) struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

pub(crate) trait Transport {
    fn send(&mut self, request: Request) -> anyhow::Result<Response>;
}

/// [`Transport`] over the network.
pub(crate) struct Http(ureq::Agent);

impl Http {
    pub(crate) fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .build();
        Self(config.into())
    }
}

impl Transport for Http {
    fn send(&mut self, request: Request) -> anyhow::Result<Response> {
        let mut builder = ureq::http::Request::builder()
            .method(request.method)
            .uri(&request.url);
        if let Some(token) = &request.token {
            builder = builder.header("Authorization", format!("Bearer {token}"));
        }
        if let Some(content_type) = request.content_type {
            builder = builder.header("Content-Type", content_type);
        }
        let mut response = self
            .0
            .run(builder.body(request.body)?)
            .with_context(|| format!("{} {}", request.method, request.url))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_vec()?;
        Ok(Response { status, body })
    }
}

/// How a release goes out on its track.
#[derive(Debug, Clone, Copy, PartialEq, clap::ValueEnum)]
pub(crate) enum ReleaseStatus {
    /// Not visible to anyone; Play takes only drafts until the app's first
    /// release is made in Play Console.
    Draft,
    /// Out to a fraction of the track's users (`--rollout`).
    InProgress,
    /// A staged rollout stopped.
    Halted,
    /// Out to every user of the track.
    Completed,
}

impl ReleaseStatus {
    fn api(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::InProgress => "inProgress",
            Self::Halted => "halted",
            Self::Completed => "completed",
        }
    }
}

/// What to release, and where.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Source<'a> {
    /// Upload this bundle.
    Bundle(&'a Path),
    /// Take the version codes of the newest release on this track
    /// (promotion, e.g. from `beta` to `production`).
    Track(&'a str),
}

pub(crate) struct Options<'a> {
    pub source: Source<'a>,
    pub package: &'a str,
    pub account: &'a ServiceAccount,
    /// `internal`, `alpha`, `beta`, `production` or a custom track's name.
    pub track: &'a str,
    pub status: ReleaseStatus,
    /// The fraction of users a staged rollout reaches (`inProgress`/`halted`).
    pub rollout: Option<f64>,
    /// The store directory's locales: their release notes go with the
    /// release.
    pub locales: &'a [store::Locale],
    /// Also update the store listing (texts and images) of every locale.
    pub listing: bool,
}

/// What Play reported for the release.
#[derive(Debug, PartialEq)]
pub(crate) struct Uploaded {
    pub version_codes: Vec<String>,
}

/// The status and rollout a release gets from the flags: a rollout makes a
/// staged (`inProgress`) release; `completed` and `draft` take none.
pub(crate) fn release_status(
    status: Option<ReleaseStatus>,
    rollout: Option<f64>,
) -> anyhow::Result<ReleaseStatus> {
    if let Some(fraction) = rollout
        && !(fraction > 0.0 && fraction < 1.0)
    {
        bail!(
            "--rollout is the fraction of users, above 0 and below 1 (e.g. 0.1); a full release takes no --rollout"
        );
    }
    let status = status.unwrap_or(if rollout.is_some() {
        ReleaseStatus::InProgress
    } else {
        ReleaseStatus::Completed
    });
    match (status, rollout) {
        (ReleaseStatus::InProgress | ReleaseStatus::Halted, None) => {
            bail!("a staged release needs --rollout <fraction>, e.g. --rollout 0.1")
        }
        (ReleaseStatus::Draft | ReleaseStatus::Completed, Some(_)) => {
            bail!("--rollout makes a staged release: drop it, or use --status in-progress")
        }
        _ => Ok(status),
    }
}

/// Releases to the track in one edit: the bundle is uploaded (or the
/// version codes are taken from another track), the release with its notes
/// is set, the listing is updated if asked, and the edit is committed.
pub(crate) fn upload(
    transport: &mut dyn Transport,
    options: &Options<'_>,
    now: u64,
) -> anyhow::Result<Uploaded> {
    let bundle = match options.source {
        Source::Bundle(path) => {
            Some(std::fs::read(path).with_context(|| format!("the bundle {}", path.display()))?)
        }
        Source::Track(_) => None,
    };
    let token = access_token(transport, options.account, now)?;
    in_edit(transport, &token, options.package, |transport, edit| {
        let version_codes = match (&options.source, bundle) {
            (Source::Bundle(_), Some(bundle)) => {
                let uploaded = send(
                    transport,
                    Request {
                        method: "POST",
                        url: format!(
                            "{UPLOAD_API}/{}/edits/{}/bundles?uploadType=media",
                            options.package, edit.id
                        ),
                        content_type: Some("application/octet-stream"),
                        token: Some(token.to_owned()),
                        body: bundle,
                    },
                )
                .context("Google Play refused the bundle")?;
                let Some(code) = uploaded["versionCode"].as_i64() else {
                    bail!("Google Play took the bundle without a versionCode: {uploaded}");
                };
                vec![code.to_string()]
            }
            (Source::Track(from), _) => {
                let track = edit
                    .call(transport, "GET", format!("tracks/{from}"), None)
                    .with_context(|| format!("could not read the {from} track"))?;
                let codes = newest_release(&track)
                    .and_then(|r| r["versionCodes"].as_array())
                    .map(|codes| codes.iter().filter_map(version_code).collect::<Vec<_>>())
                    .unwrap_or_default();
                if codes.is_empty() {
                    bail!("the {from} track has no release to promote");
                }
                codes
            }
            _ => unreachable!(),
        };
        let mut release = json!({
            "versionCodes": version_codes,
            "status": options.status.api(),
        });
        if let Some(fraction) = options.rollout {
            release["userFraction"] = json!(fraction);
        }
        let notes: Vec<Value> = options
            .locales
            .iter()
            .filter_map(|l| {
                let text = l.release_notes.as_ref()?;
                Some(json!({"language": l.tag, "text": text}))
            })
            .collect();
        if !notes.is_empty() {
            release["releaseNotes"] = Value::Array(notes);
        }
        let track = options.track;
        edit.call(
            transport,
            "PUT",
            format!("tracks/{track}"),
            Some(json!({"track": track, "releases": [release]})),
        )
        .with_context(|| format!("Google Play refused the release on the {track} track"))?;
        if options.listing {
            update_listing(transport, edit, options.package, options.locales)?;
        }
        Ok(Uploaded { version_codes })
    })
}

fn version_code(code: &Value) -> Option<String> {
    code.as_str()
        .map(str::to_owned)
        .or_else(|| code.as_i64().map(|c| c.to_string()))
}

/// The release of a track with the highest version code.
fn newest_release(track: &Value) -> Option<&Value> {
    track["releases"].as_array()?.iter().max_by_key(|r| {
        r["versionCodes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| version_code(c)?.parse::<i64>().ok())
            .max()
            .unwrap_or(i64::MIN)
    })
}

/// Sets each locale's texts and replaces its images of every type it has.
fn update_listing(
    transport: &mut dyn Transport,
    edit: &Edit<'_>,
    package: &str,
    locales: &[store::Locale],
) -> anyhow::Result<()> {
    for locale in locales {
        let tag = &locale.tag;
        let texts = [
            ("title", &locale.name),
            ("shortDescription", &locale.short_description),
            ("fullDescription", &locale.description),
        ];
        if texts.iter().any(|(_, t)| t.is_some()) {
            let mut listing = json!({"language": tag});
            for (field, text) in texts {
                if let Some(text) = text {
                    listing[field] = json!(text);
                }
            }
            edit.call(transport, "PATCH", format!("listings/{tag}"), Some(listing))
                .with_context(|| format!("Google Play refused the {tag} listing"))?;
        }
        for (kind, files) in &locale.images {
            if !IMAGE_TYPES.contains(&kind.as_str()) {
                bail!(
                    "store/{tag}/android/{kind} is not a Google Play image type (one of {})",
                    IMAGE_TYPES.join(", ")
                );
            }
            edit.call(transport, "DELETE", format!("listings/{tag}/{kind}"), None)
                .with_context(|| format!("could not clear the {tag} {kind}"))?;
            for file in files {
                let body =
                    std::fs::read(file).with_context(|| format!("reading {}", file.display()))?;
                let png = file.extension().and_then(|e| e.to_str()) == Some("png");
                send(
                    transport,
                    Request {
                        method: "POST",
                        url: format!(
                            "{UPLOAD_API}/{package}/edits/{}/listings/{tag}/{kind}?uploadType=media",
                            edit.id
                        ),
                        content_type: Some(if png { "image/png" } else { "image/jpeg" }),
                        token: Some(edit.token.to_owned()),
                        body,
                    },
                )
                .with_context(|| format!("Google Play refused {}", file.display()))?;
            }
        }
    }
    Ok(())
}

/// Google Play's listing image types (`edits.images`).
pub(crate) const IMAGE_TYPES: &[&str] = &[
    "phoneScreenshots",
    "sevenInchScreenshots",
    "tenInchScreenshots",
    "tvScreenshots",
    "wearScreenshots",
    "icon",
    "featureGraphic",
    "tvBanner",
];

/// An open edit.
pub(crate) struct Edit<'a> {
    id: String,
    url: String,
    token: &'a str,
}

impl Edit<'_> {
    /// Calls `path` under the edit.
    fn call(
        &self,
        transport: &mut dyn Transport,
        method: &'static str,
        path: String,
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        call(
            transport,
            self.token,
            method,
            format!("{}/{path}", self.url),
            body,
        )
    }
}

/// Runs `work` in a new edit and commits it; an edit that fails on the way
/// is deleted, so nothing half-done is left on Play.
fn in_edit<T>(
    transport: &mut dyn Transport,
    token: &str,
    package: &str,
    work: impl FnOnce(&mut dyn Transport, &Edit<'_>) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let edit = open_edit(transport, token, package)?;
    let result = work(transport, &edit).and_then(|value| {
        call(
            transport,
            token,
            "POST",
            format!("{}:commit", edit.url),
            None,
        )
        .context("Google Play refused to commit the edit")?;
        Ok(value)
    });
    if result.is_err() {
        // Leave no open edit behind; a failure here changes nothing.
        let _ = call(transport, token, "DELETE", edit.url, None);
    }
    result
}

fn open_edit<'a>(
    transport: &mut dyn Transport,
    token: &'a str,
    package: &str,
) -> anyhow::Result<Edit<'a>> {
    let app = format!("{API}/{package}");
    let edit = call(
        transport,
        token,
        "POST",
        format!("{app}/edits"),
        Some(json!({})),
    )
    .context("could not open an edit on Google Play")?;
    let Some(id) = edit["id"].as_str().map(str::to_owned) else {
        bail!("Google Play opened an edit without an id: {edit}");
    };
    Ok(Edit {
        url: format!("{app}/edits/{id}"),
        id,
        token,
    })
}

/// One release on a track, as `nsh publish status android` shows it.
#[derive(Debug, PartialEq, serde::Serialize)]
pub(crate) struct TrackRelease {
    pub track: String,
    pub name: Option<String>,
    pub status: String,
    pub version_codes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_fraction: Option<f64>,
}

/// Reads every track's releases in a throwaway edit (deleted, never
/// committed).
pub(crate) fn status(
    transport: &mut dyn Transport,
    package: &str,
    account: &ServiceAccount,
    now: u64,
) -> anyhow::Result<Vec<TrackRelease>> {
    let token = access_token(transport, account, now)?;
    let edit = open_edit(transport, &token, package)?;
    let tracks = edit.call(transport, "GET", "tracks".to_owned(), None);
    let _ = call(transport, &token, "DELETE", edit.url.clone(), None);
    let tracks = tracks.context("could not read the tracks")?;
    let mut releases = vec![];
    for track in tracks["tracks"].as_array().into_iter().flatten() {
        let name = track["track"].as_str().unwrap_or_default();
        for release in track["releases"].as_array().into_iter().flatten() {
            releases.push(TrackRelease {
                track: name.to_owned(),
                name: release["name"].as_str().map(str::to_owned),
                status: release["status"].as_str().unwrap_or_default().to_owned(),
                version_codes: release["versionCodes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(version_code)
                    .collect(),
                user_fraction: release["userFraction"].as_f64(),
            });
        }
    }
    Ok(releases)
}

fn access_token(
    transport: &mut dyn Transport,
    account: &ServiceAccount,
    now: u64,
) -> anyhow::Result<String> {
    let assertion = account.assertion(now)?;
    let response = send(
        transport,
        Request {
            method: "POST",
            url: account.token_uri.clone(),
            content_type: Some("application/x-www-form-urlencoded"),
            token: None,
            // The JWT is base64url and dots: nothing to escape.
            body: format!(
                "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={assertion}"
            )
            .into_bytes(),
        },
    )
    .with_context(|| {
        format!(
            "could not sign in to Google as the service account {}",
            account.client_email
        )
    })?;
    match response["access_token"].as_str() {
        Some(token) => Ok(token.to_owned()),
        None => bail!("Google's token response has no access_token"),
    }
}

fn call(
    transport: &mut dyn Transport,
    token: &str,
    method: &'static str,
    url: String,
    body: Option<Value>,
) -> anyhow::Result<Value> {
    send(
        transport,
        Request {
            method,
            url,
            content_type: body.as_ref().map(|_| "application/json"),
            token: Some(token.to_owned()),
            body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
        },
    )
}

/// Sends a request and reads its JSON answer; an error status becomes an
/// error with Google's message.
fn send(transport: &mut dyn Transport, request: Request) -> anyhow::Result<Value> {
    let response = transport.send(request)?;
    let value: Value = if response.body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&response.body)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&response.body).into_owned()))
    };
    if !(200..300).contains(&response.status) {
        let message = value["error"]["message"]
            .as_str()
            .or_else(|| value["error_description"].as_str())
            .or_else(|| value["error"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        bail!("HTTP {}: {message}", response.status);
    }
    Ok(value)
}

/// Which app on Google Play, as which service account.
#[derive(clap::Args, Clone, Debug)]
pub(crate) struct AppArgs {
    /// The app's directory or entry, whose `nsh.json` `id` is the
    /// package name.
    #[arg(long, default_value = ".")]
    pub entry: PathBuf,
    /// The package name on Google Play (default: `nsh.json` `id`).
    #[arg(long)]
    pub package: Option<String>,
    /// The service account's JSON key; keep it out of the repository.
    #[arg(long, env = "NSH_PLAY_CREDENTIALS", hide_env_values = true)]
    pub credentials: Option<PathBuf>,
}

/// `nsh publish android`.
#[derive(clap::Args, Clone, Debug)]
pub(crate) struct PublishArgs {
    /// The bundle (`.aab`) to upload; leave it out to promote with `--from`.
    #[arg(required_unless_present = "from", conflicts_with = "from")]
    pub bundle: Option<PathBuf>,
    #[command(flatten)]
    pub app: AppArgs,
    /// The track to release to: `internal` (default), `alpha`, `beta`,
    /// `production` or a custom track's name.
    #[arg(long, default_value = DEFAULT_TRACK)]
    pub track: String,
    /// Promote: release the newest version codes of this track to
    /// `--track` instead of uploading a bundle.
    #[arg(long, value_name = "TRACK")]
    pub from: Option<String>,
    /// The release's status (default: `completed`, or `in-progress` with
    /// `--rollout`); `halted` stops a staged rollout.
    #[arg(long, value_enum, conflicts_with = "draft")]
    pub status: Option<ReleaseStatus>,
    /// A staged rollout to this fraction of the track's users, e.g. `0.1`.
    #[arg(long, value_name = "FRACTION")]
    pub rollout: Option<f64>,
    /// Release as a draft, which Play requires until the app's first
    /// release is made in Play Console.
    #[arg(long)]
    pub draft: bool,
    /// The store directory: `<locale>/release_notes.txt` goes with the
    /// release, the rest with `--listing` (default: `store` in the app's
    /// directory).
    #[arg(long)]
    pub store: Option<PathBuf>,
    /// Also update the store listing (name, descriptions, images) from the
    /// store directory, replacing what Play has for those locales.
    #[arg(long)]
    pub listing: bool,
}

/// The package name: `--package`, else `nsh.json` `id`.
fn package_name(app: &AppArgs) -> anyhow::Result<String> {
    if let Some(package) = &app.package {
        return Ok(package.clone());
    }
    match crate::package::read_config(&app.entry)?.id {
        Some(id) => Ok(id),
        None => bail!("nsh.json has no `id`: give the app's package name with --package"),
    }
}

fn credentials(app: &AppArgs) -> anyhow::Result<&Path> {
    app.credentials.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "give the Google Play service account's JSON key with --credentials or NSH_PLAY_CREDENTIALS"
        )
    })
}

/// The app's directory: `entry` itself, or the directory of an entry file.
fn app_dir(entry: &Path) -> PathBuf {
    if entry.is_dir() {
        entry.to_owned()
    } else {
        entry.parent().map(Path::to_owned).unwrap_or_default()
    }
}

fn now() -> anyhow::Result<u64> {
    Ok(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())
}

/// `nsh publish android`.
pub(crate) fn publish(args: &PublishArgs) -> anyhow::Result<()> {
    if let Some(bundle) = &args.bundle
        && bundle.extension().and_then(|e| e.to_str()) != Some("aab")
    {
        bail!(
            "{} is not an Android App Bundle (.aab): Google Play takes bundles, not APKs",
            bundle.display()
        );
    }
    let credentials = credentials(&args.app)?;
    let status = release_status(
        args.draft.then_some(ReleaseStatus::Draft).or(args.status),
        args.rollout,
    )?;
    if args.from.as_deref() == Some(args.track.as_str()) {
        bail!("--from and --track name the same track");
    }
    let package = package_name(&args.app)?;
    let locales = store::read_with(&args.app.entry, args.store.as_deref())?.locales("android");
    let account = ServiceAccount::read(credentials)?;
    let source = match (&args.bundle, &args.from) {
        (Some(bundle), _) => Source::Bundle(bundle),
        (None, Some(from)) => Source::Track(from),
        (None, None) => bail!("give a bundle (.aab), or --from <track> to promote"),
    };
    let uploaded = upload(
        &mut Http::new(),
        &Options {
            source,
            package: &package,
            account: &account,
            track: &args.track,
            status,
            rollout: args.rollout,
            locales: &locales,
            listing: args.listing,
        },
        now()?,
    )?;
    let reach = match (status, args.rollout) {
        (ReleaseStatus::Draft, _) => " as a draft".to_owned(),
        (_, Some(fraction)) => format!(" for {}% of its users", fraction * 100.0),
        _ => String::new(),
    };
    ui::done(format!(
        "{package} version code {} is on Google Play's {} track{reach}{}",
        uploaded.version_codes.join(", "),
        args.track,
        if args.listing {
            ", with its store listing"
        } else {
            ""
        },
    ));
    Ok(())
}

/// `nsh publish status android`.
pub(crate) fn print_status(app: &AppArgs, as_json: bool) -> anyhow::Result<()> {
    let account = ServiceAccount::read(credentials(app)?)?;
    let package = package_name(app)?;
    let releases = status(&mut Http::new(), &package, &account, now()?)?;
    if as_json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({"package": package, "releases": releases}))?
        );
        return Ok(());
    }
    if releases.is_empty() {
        println!("{package} has no releases on Google Play");
    }
    for r in &releases {
        let fraction = r
            .user_fraction
            .map(|f| format!(" ({}% of users)", f * 100.0))
            .unwrap_or_default();
        println!(
            "{:<12} {:<11} {}{fraction}{}",
            r.track,
            r.status,
            r.version_codes.join(", "),
            r.name
                .as_deref()
                .map(|n| format!("  {n}"))
                .unwrap_or_default(),
        );
    }
    Ok(())
}

/// One check of `nsh publish doctor android`.
#[derive(Debug, PartialEq)]
pub(crate) struct Check {
    pub name: &'static str,
    pub result: Result<String, String>,
}

/// Checks, without changing anything on Play, that `nsh publish android`
/// has what it needs: the key, the package name, the store directory, a
/// sign-in and access to the app (an edit opened and deleted).
pub(crate) fn doctor_checks(
    transport: &mut dyn Transport,
    app: &AppArgs,
    store: &Path,
    now: u64,
) -> Vec<Check> {
    let mut checks = vec![];
    let account = credentials(app)
        .and_then(ServiceAccount::read)
        .map_err(|e| format!("{e:#}"));
    checks.push(Check {
        name: "service account key",
        result: account
            .as_ref()
            .map(|a| a.client_email.clone())
            .map_err(Clone::clone),
    });
    let package = package_name(app).map_err(|e| format!("{e:#}"));
    checks.push(Check {
        name: "package name",
        result: package.clone(),
    });
    checks.push(Check {
        name: "store listing",
        result: store_summary(&app.entry, store),
    });
    let (Ok(account), Ok(package)) = (account, package) else {
        return checks;
    };
    let token = access_token(transport, &account, now).map_err(|e| format!("{e:#}"));
    checks.push(Check {
        name: "sign in",
        result: token
            .as_ref()
            .map(|_| "signed in".to_owned())
            .map_err(Clone::clone),
    });
    let Ok(token) = token else {
        return checks;
    };
    let access = open_edit(transport, &token, &package).map(|edit| {
        let _ = call(transport, &token, "DELETE", edit.url, None);
    });
    checks.push(Check {
        name: "app access",
        result: access
            .map(|()| format!("{package} is editable"))
            .map_err(|e| {
                format!(
                    "{e:#} (create the app and its first release in Play Console, and grant the service account access to it)"
                )
            }),
    });
    checks
}

fn store_summary(entry: &Path, store: &Path) -> Result<String, String> {
    let locales = store::read_with(entry, Some(store))
        .map_err(|e| format!("{e:#}"))?
        .locales("android");
    if locales.is_empty() {
        return Ok(format!(
            "none at {} (no release notes or listing)",
            store.display()
        ));
    }
    for locale in &locales {
        for (kind, _) in &locale.images {
            if !IMAGE_TYPES.contains(&kind.as_str()) {
                return Err(format!(
                    "{}/{}/android/{kind} is not a Google Play image type (one of {})",
                    store.display(),
                    locale.tag,
                    IMAGE_TYPES.join(", ")
                ));
            }
        }
    }
    let tags: Vec<&str> = locales.iter().map(|l| l.tag.as_str()).collect();
    Ok(tags.join(", "))
}

/// `nsh publish doctor android`: prints each check; fails if one fails.
pub(crate) fn doctor(app: &AppArgs, store: Option<&Path>) -> anyhow::Result<()> {
    let store = store
        .map(Path::to_owned)
        .unwrap_or_else(|| app_dir(&app.entry).join("store"));
    let checks = doctor_checks(&mut Http::new(), app, &store, now()?);
    let mut failed = 0;
    for check in &checks {
        match &check.result {
            Ok(detail) => println!("ok    {}: {detail}", check.name),
            Err(error) => {
                failed += 1;
                println!("error {}: {error}", check.name);
            }
        }
    }
    if failed > 0 {
        bail!("{failed} check(s) failed");
    }
    ui::done("ready to publish to Google Play");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 2048-bit RSA key made for these tests only (`openssl genpkey`).
    const KEY: &str = include_str!("../tests/fixtures/play-test-key.pem");

    fn account() -> ServiceAccount {
        ServiceAccount {
            client_email: "ci@example.iam.gserviceaccount.com".to_owned(),
            private_key: KEY.to_owned(),
            token_uri: "https://oauth2.example/token".to_owned(),
        }
    }

    /// Answers each request with the next canned response and records it.
    struct Fake {
        responses: Vec<(u16, &'static str)>,
        requests: Vec<Request>,
    }

    impl Transport for Fake {
        fn send(&mut self, request: Request) -> anyhow::Result<Response> {
            self.requests.push(request);
            let (status, body) = self.responses.remove(0);
            Ok(Response {
                status,
                body: body.as_bytes().to_vec(),
            })
        }
    }

    fn bundle() -> (tempdir::Dir, PathBuf) {
        let dir = tempdir::Dir::new();
        let path = dir.0.join("app.aab");
        std::fs::write(&path, b"AAB").unwrap();
        (dir, path)
    }

    mod tempdir {
        pub(super) struct Dir(pub(super) std::path::PathBuf);
        impl Dir {
            pub(super) fn new() -> Self {
                let path = std::env::temp_dir().join(format!(
                    "nsh-play-{}-{:?}",
                    std::process::id(),
                    std::thread::current().id()
                ));
                std::fs::create_dir_all(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn the_assertion_is_an_rs256_jwt_the_key_verifies() {
        let jwt = account().assertion(1_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
        assert_eq!(header, json!({"alg": "RS256", "typ": "JWT"}));
        let claims: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            claims,
            json!({
                "iss": "ci@example.iam.gserviceaccount.com",
                "scope": SCOPE,
                "aud": "https://oauth2.example/token",
                "iat": 1000,
                "exp": 4600,
            })
        );
        let key = ring::signature::RsaKeyPair::from_pkcs8(&pem_der(KEY).unwrap()).unwrap();
        let public = ring::signature::UnparsedPublicKey::new(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            key.public().as_ref(),
        );
        public
            .verify(
                format!("{}.{}", parts[0], parts[1]).as_bytes(),
                &URL_SAFE_NO_PAD.decode(parts[2]).unwrap(),
            )
            .expect("the signature verifies");
    }

    #[test]
    fn a_key_that_is_not_pkcs8_is_refused() {
        let mut account = account();
        account.private_key = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----".into();
        let error = account.assertion(0).unwrap_err().to_string();
        assert!(error.contains("private_key"), "{error}");
    }

    #[test]
    fn uploads_and_releases_to_internal_in_one_edit() {
        let (_dir, path) = bundle();
        let account = account();
        let mut fake = Fake {
            responses: vec![
                (200, r#"{"access_token":"tok","expires_in":3599}"#),
                (200, r#"{"id":"e1"}"#),
                (200, r#"{"versionCode":42,"sha256":"x"}"#),
                (200, r#"{"track":"internal"}"#),
                (200, r#"{"id":"e1"}"#),
            ],
            requests: vec![],
        };
        let uploaded = upload(
            &mut fake,
            &Options {
                status: ReleaseStatus::Completed,
                ..options(&path, "com.acme.app", &account)
            },
            1_000,
        )
        .unwrap();
        assert_eq!(
            uploaded,
            Uploaded {
                version_codes: vec!["42".to_owned()]
            }
        );
        let r = &fake.requests;
        let summary: Vec<(&str, &str)> = r.iter().map(|r| (r.method, r.url.as_str())).collect();
        assert_eq!(
            summary,
            [
                ("POST", "https://oauth2.example/token"),
                (
                    "POST",
                    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.acme.app/edits"
                ),
                (
                    "POST",
                    "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/com.acme.app/edits/e1/bundles?uploadType=media"
                ),
                (
                    "PUT",
                    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.acme.app/edits/e1/tracks/internal"
                ),
                (
                    "POST",
                    "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.acme.app/edits/e1:commit"
                ),
            ]
        );
        let form = String::from_utf8(r[0].body.clone()).unwrap();
        assert!(form.starts_with(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=ey"
        ));
        assert_eq!(r[0].token, None);
        assert!(r[1..].iter().all(|r| r.token.as_deref() == Some("tok")));
        assert_eq!(r[2].body, b"AAB");
        assert_eq!(r[2].content_type, Some("application/octet-stream"));
        let track: Value = serde_json::from_slice(&r[3].body).unwrap();
        assert_eq!(
            track,
            json!({"track": "internal", "releases": [{"versionCodes": ["42"], "status": "completed"}]})
        );
    }

    #[test]
    fn a_draft_release_has_status_draft() {
        let (_dir, path) = bundle();
        let account = account();
        let mut fake = Fake {
            responses: vec![
                (200, r#"{"access_token":"tok"}"#),
                (200, r#"{"id":"e1"}"#),
                (200, r#"{"versionCode":7}"#),
                (200, "{}"),
                (200, "{}"),
            ],
            requests: vec![],
        };
        let options = Options {
            status: ReleaseStatus::Draft,
            ..options(&path, "a.b", &account)
        };
        upload(&mut fake, &options, 0).unwrap();
        let track: Value = serde_json::from_slice(&fake.requests[3].body).unwrap();
        assert_eq!(track["releases"][0]["status"], "draft");
    }

    #[test]
    fn a_refused_upload_deletes_the_edit_and_reports_googles_message() {
        let (_dir, path) = bundle();
        let account = account();
        let mut fake = Fake {
            responses: vec![
                (200, r#"{"access_token":"tok"}"#),
                (200, r#"{"id":"e1"}"#),
                (
                    403,
                    r#"{"error":{"code":403,"message":"APK specifies a version code that has already been used."}}"#,
                ),
                (204, ""),
            ],
            requests: vec![],
        };
        let options = Options {
            status: ReleaseStatus::Completed,
            ..options(&path, "a.b", &account)
        };
        let error = format!("{:#}", upload(&mut fake, &options, 0).unwrap_err());
        assert!(error.contains("refused the bundle"), "{error}");
        assert!(
            error.contains("HTTP 403: APK specifies a version code"),
            "{error}"
        );
        let last = fake.requests.last().unwrap();
        assert_eq!(last.method, "DELETE");
        assert!(last.url.ends_with("/applications/a.b/edits/e1"));
        assert_eq!(fake.requests.len(), 4);
    }

    #[test]
    fn a_refused_sign_in_stops_before_any_edit() {
        let (_dir, path) = bundle();
        let account = account();
        let mut fake = Fake {
            responses: vec![(
                400,
                r#"{"error":"invalid_grant","error_description":"Invalid JWT Signature."}"#,
            )],
            requests: vec![],
        };
        let options = Options {
            status: ReleaseStatus::Completed,
            ..options(&path, "a.b", &account)
        };
        let error = format!("{:#}", upload(&mut fake, &options, 0).unwrap_err());
        assert!(
            error.contains("ci@example.iam.gserviceaccount.com"),
            "{error}"
        );
        assert!(error.contains("Invalid JWT Signature."), "{error}");
        assert_eq!(fake.requests.len(), 1);
    }

    fn options<'a>(path: &'a Path, package: &'a str, account: &'a ServiceAccount) -> Options<'a> {
        Options {
            source: Source::Bundle(path),
            package,
            account,
            track: DEFAULT_TRACK,
            status: ReleaseStatus::Completed,
            rollout: None,
            locales: &[],
            listing: false,
        }
    }

    fn fake(responses: Vec<(u16, &'static str)>) -> Fake {
        Fake {
            responses,
            requests: vec![],
        }
    }

    fn json_body(request: &Request) -> Value {
        serde_json::from_slice(&request.body).unwrap()
    }

    #[test]
    fn a_staged_rollout_to_production_with_release_notes() {
        let (_dir, path) = bundle();
        let account = account();
        let locales = [
            store::Locale {
                tag: "en-US".into(),
                release_notes: Some("Faster start".into()),
                ..Default::default()
            },
            store::Locale {
                tag: "zh-CN".into(),
                ..Default::default()
            },
        ];
        let mut fake = fake(vec![
            (200, r#"{"access_token":"tok"}"#),
            (200, r#"{"id":"e1"}"#),
            (200, r#"{"versionCode":9}"#),
            (200, "{}"),
            (200, "{}"),
        ]);
        let options = Options {
            track: "production",
            status: ReleaseStatus::InProgress,
            rollout: Some(0.1),
            locales: &locales,
            ..options(&path, "a.b", &account)
        };
        upload(&mut fake, &options, 0).unwrap();
        let r = &fake.requests[3];
        assert!(r.url.ends_with("/edits/e1/tracks/production"), "{}", r.url);
        assert_eq!(
            json_body(r),
            json!({"track": "production", "releases": [{
                "versionCodes": ["9"],
                "status": "inProgress",
                "userFraction": 0.1,
                "releaseNotes": [{"language": "en-US", "text": "Faster start"}],
            }]})
        );
    }

    #[test]
    fn promotes_the_newest_release_of_another_track() {
        let account = account();
        let mut fake = fake(vec![
            (200, r#"{"access_token":"tok"}"#),
            (200, r#"{"id":"e1"}"#),
            (
                200,
                r#"{"track":"beta","releases":[{"versionCodes":["7"],"status":"completed"},{"versionCodes":["12","11"],"status":"completed"}]}"#,
            ),
            (200, "{}"),
            (200, "{}"),
        ]);
        let path = PathBuf::new();
        let options = Options {
            source: Source::Track("beta"),
            track: "production",
            ..options(&path, "a.b", &account)
        };
        let uploaded = upload(&mut fake, &options, 0).unwrap();
        assert_eq!(uploaded.version_codes, ["12", "11"]);
        let r = &fake.requests;
        assert_eq!(r[2].method, "GET");
        assert!(r[2].url.ends_with("/edits/e1/tracks/beta"));
        assert!(r[3].url.ends_with("/edits/e1/tracks/production"));
        assert_eq!(
            json_body(&r[3])["releases"][0]["versionCodes"],
            json!(["12", "11"])
        );
        assert!(r[4].url.ends_with("/edits/e1:commit"));
    }

    #[test]
    fn promoting_an_empty_track_deletes_the_edit() {
        let account = account();
        let mut fake = fake(vec![
            (200, r#"{"access_token":"tok"}"#),
            (200, r#"{"id":"e1"}"#),
            (200, r#"{"track":"beta"}"#),
            (204, ""),
        ]);
        let path = PathBuf::new();
        let options = Options {
            source: Source::Track("beta"),
            ..options(&path, "a.b", &account)
        };
        let error = format!("{:#}", upload(&mut fake, &options, 0).unwrap_err());
        assert!(error.contains("no release to promote"), "{error}");
        assert_eq!(fake.requests.last().unwrap().method, "DELETE");
    }

    #[test]
    fn the_listing_sets_texts_and_replaces_images() {
        let (dir, path) = bundle();
        let shot = dir.0.join("1.png");
        std::fs::write(&shot, b"PNG").unwrap();
        let account = account();
        let locales = [store::Locale {
            tag: "en-US".into(),
            name: Some("Acme".into()),
            description: Some("Does things".into()),
            images: vec![("phoneScreenshots".into(), vec![shot])],
            ..Default::default()
        }];
        let mut fake = fake(vec![
            (200, r#"{"access_token":"tok"}"#),
            (200, r#"{"id":"e1"}"#),
            (200, r#"{"versionCode":3}"#),
            (200, "{}"),
            (200, "{}"),
            (200, "{}"),
            (200, "{}"),
            (200, "{}"),
        ]);
        let options = Options {
            locales: &locales,
            listing: true,
            ..options(&path, "a.b", &account)
        };
        upload(&mut fake, &options, 0).unwrap();
        let summary: Vec<(&str, &str)> = fake.requests[4..]
            .iter()
            .map(|r| (r.method, r.url.rsplit("applications/").next().unwrap()))
            .collect();
        assert_eq!(
            summary,
            [
                ("PATCH", "a.b/edits/e1/listings/en-US"),
                ("DELETE", "a.b/edits/e1/listings/en-US/phoneScreenshots"),
                (
                    "POST",
                    "a.b/edits/e1/listings/en-US/phoneScreenshots?uploadType=media"
                ),
                ("POST", "a.b/edits/e1:commit"),
            ]
        );
        assert_eq!(
            json_body(&fake.requests[4]),
            json!({"language": "en-US", "title": "Acme", "fullDescription": "Does things"})
        );
        assert_eq!(fake.requests[6].body, b"PNG");
        assert_eq!(fake.requests[6].content_type, Some("image/png"));
    }

    #[test]
    fn an_unknown_image_type_is_refused_before_commit() {
        let (_dir, path) = bundle();
        let account = account();
        let locales = [store::Locale {
            tag: "en-US".into(),
            images: vec![("screens".into(), vec![path.clone()])],
            ..Default::default()
        }];
        let mut fake = fake(vec![
            (200, r#"{"access_token":"tok"}"#),
            (200, r#"{"id":"e1"}"#),
            (200, r#"{"versionCode":3}"#),
            (200, "{}"),
            (204, ""),
        ]);
        let options = Options {
            locales: &locales,
            listing: true,
            ..options(&path, "a.b", &account)
        };
        let error = format!("{:#}", upload(&mut fake, &options, 0).unwrap_err());
        assert!(error.contains("not a Google Play image type"), "{error}");
        assert_eq!(fake.requests.last().unwrap().method, "DELETE");
    }

    #[test]
    fn release_status_follows_the_flags() {
        assert_eq!(
            release_status(None, None).unwrap(),
            ReleaseStatus::Completed
        );
        assert_eq!(
            release_status(None, Some(0.2)).unwrap(),
            ReleaseStatus::InProgress
        );
        assert_eq!(
            release_status(Some(ReleaseStatus::Halted), Some(0.2)).unwrap(),
            ReleaseStatus::Halted
        );
        assert_eq!(
            release_status(Some(ReleaseStatus::Draft), None).unwrap(),
            ReleaseStatus::Draft
        );
        for (status, rollout) in [
            (None, Some(0.0)),
            (None, Some(1.0)),
            (Some(ReleaseStatus::InProgress), None),
            (Some(ReleaseStatus::Completed), Some(0.5)),
            (Some(ReleaseStatus::Draft), Some(0.5)),
        ] {
            assert!(
                release_status(status, rollout).is_err(),
                "{status:?} {rollout:?}"
            );
        }
    }

    #[test]
    fn status_reads_the_tracks_and_commits_nothing() {
        let account = account();
        let mut fake = fake(vec![
            (200, r#"{"access_token":"tok"}"#),
            (200, r#"{"id":"e1"}"#),
            (
                200,
                r#"{"tracks":[{"track":"internal","releases":[{"name":"1.2","versionCodes":["5"],"status":"completed"}]},{"track":"production","releases":[{"versionCodes":["4"],"status":"inProgress","userFraction":0.25}]}]}"#,
            ),
            (204, ""),
        ]);
        let releases = status(&mut fake, "a.b", &account, 0).unwrap();
        assert_eq!(
            releases,
            [
                TrackRelease {
                    track: "internal".into(),
                    name: Some("1.2".into()),
                    status: "completed".into(),
                    version_codes: vec!["5".into()],
                    user_fraction: None,
                },
                TrackRelease {
                    track: "production".into(),
                    name: None,
                    status: "inProgress".into(),
                    version_codes: vec!["4".into()],
                    user_fraction: Some(0.25),
                },
            ]
        );
        assert!(fake.requests[2].url.ends_with("/edits/e1/tracks"));
        assert_eq!(fake.requests[3].method, "DELETE");
        assert!(fake.requests.iter().all(|r| !r.url.ends_with(":commit")));
    }

    #[test]
    fn doctor_checks_everything_without_committing() {
        let dir = tempdir::Dir::new();
        let key = dir.0.join("key.json");
        std::fs::write(
            &key,
            json!({"client_email": "ci@x", "private_key": KEY, "token_uri": "https://t"})
                .to_string(),
        )
        .unwrap();
        let app = AppArgs {
            entry: dir.0.clone(),
            package: Some("a.b".into()),
            credentials: Some(key),
        };
        let mut fake = fake(vec![
            (200, r#"{"access_token":"tok"}"#),
            (200, r#"{"id":"e1"}"#),
            (204, ""),
        ]);
        let checks = doctor_checks(&mut fake, &app, &dir.0.join("store"), 0);
        assert!(checks.iter().all(|c| c.result.is_ok()), "{checks:?}");
        assert_eq!(checks.len(), 5);
        assert_eq!(fake.requests[2].method, "DELETE");

        let app = AppArgs {
            credentials: None,
            ..app
        };
        let checks = doctor_checks(&mut fake, &app, &dir.0.join("store"), 0);
        assert!(
            checks[0]
                .result
                .as_ref()
                .unwrap_err()
                .contains("NSH_PLAY_CREDENTIALS")
        );
        assert_eq!(checks.len(), 3);
    }

    #[test]
    fn only_bundles_are_taken() {
        let args = |bundle: &str, credentials: Option<PathBuf>| PublishArgs {
            bundle: Some(bundle.into()),
            app: AppArgs {
                entry: ".".into(),
                package: Some("a.b".into()),
                credentials,
            },
            track: DEFAULT_TRACK.into(),
            from: None,
            status: None,
            rollout: None,
            draft: false,
            store: None,
            listing: false,
        };
        let error = publish(&args("app.apk", None)).unwrap_err().to_string();
        assert!(error.contains("not an Android App Bundle"), "{error}");
        let error = publish(&args("app.aab", None)).unwrap_err().to_string();
        assert!(error.contains("NSH_PLAY_CREDENTIALS"), "{error}");
        let error = publish(&PublishArgs {
            rollout: Some(1.5),
            ..args("app.aab", Some("k.json".into()))
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("--rollout"), "{error}");
    }
}
