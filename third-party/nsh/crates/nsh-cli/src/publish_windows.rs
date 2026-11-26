//! `nsh publish windows`: submits an MSIX package (`nsh package --target
//! windows --format msix`) to the Microsoft Store with the Store submission
//! API, and reports its certification (`status`) or checks the setup
//! (`doctor`).
//!
//! The flow: an Azure AD token (client credentials of an Azure AD app
//! associated with Partner Center) → `GET` the app (a pending submission is
//! refused, so a person's draft in Partner Center is never overwritten) →
//! `POST` a submission, a copy of the last published one → mark its
//! packages for deletion and add the new one, with release notes in every
//! listing when given → `PUT` it → upload a ZIP holding the package to the
//! submission's blob URL → `POST commit` → with `--wait`, poll its status
//! until certification ends. A submission that fails before it is
//! committed is deleted.
//!
//! Credentials come from the environment only (`NSH_MS_TENANT_ID`,
//! `NSH_MS_CLIENT_ID`, `NSH_MS_CLIENT_SECRET`) and are never printed.
//! HTTP goes through [`Transport`], so the flow is tested without the network.

use std::{io::Write as _, path::PathBuf, time::Duration};

use anyhow::{Context as _, bail};
use serde_json::{Value, json};

use crate::ui;

const API: &str = "https://manage.devcenter.microsoft.com/v1.0/my/applications";
const RESOURCE: &str = "https://manage.devcenter.microsoft.com";
const ENV: [&str; 3] = [
    "NSH_MS_TENANT_ID",
    "NSH_MS_CLIENT_ID",
    "NSH_MS_CLIENT_SECRET",
];

/// Arguments of `nsh publish windows`.
#[derive(clap::Args, Clone)]
pub(crate) struct Args {
    /// The MSIX package (`.msix`) to submit.
    package: PathBuf,
    #[command(flatten)]
    app: AppArgs,
    /// What changed, a text file, as every listing's release notes;
    /// `<language>=<file>` for one listing (`en-us=notes.md`, repeatable).
    /// Default: each locale's `releaseNotes` of the store listing.
    #[arg(long)]
    notes: Vec<String>,
    /// Wait for certification to end, failing when the Store rejects it.
    #[arg(long)]
    wait: bool,
}

/// Which app in the Microsoft Store.
#[derive(clap::Args, Clone)]
pub(crate) struct AppArgs {
    /// The app's directory or entry, whose `nsh.json` has
    /// `store.windows.productId`.
    #[arg(long, default_value = ".")]
    entry: PathBuf,
    /// The app's Store ID, e.g. `9NBLGGH4R315` (default:
    /// `store.windows.productId`).
    #[arg(long, alias = "store-id")]
    product_id: Option<String>,
}

/// `nsh publish status windows`.
#[derive(clap::Args, Clone)]
pub(crate) struct StatusArgs {
    #[command(flatten)]
    app: AppArgs,
    /// The submission (default: the pending one, else the last published).
    #[arg(long)]
    submission: Option<String>,
    /// Print JSON.
    #[arg(long)]
    json: bool,
}

/// An HTTP request, as [`Transport`] sends it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

pub(crate) struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

pub(crate) trait Transport {
    fn send(&mut self, request: Request) -> anyhow::Result<Response>;
}

struct Http(ureq::Agent);

impl Transport for Http {
    fn send(&mut self, request: Request) -> anyhow::Result<Response> {
        let mut builder = ureq::http::Request::builder()
            .method(request.method)
            .uri(&request.url);
        for (name, value) in &request.headers {
            builder = builder.header(*name, value);
        }
        // Never the blob URL's signature in an error.
        let shown = request.url.split('?').next().unwrap_or_default().to_owned();
        let mut response = self
            .0
            .run(builder.body(request.body)?)
            .with_context(|| format!("{} {shown}", request.method))?;
        let status = response.status().as_u16();
        let body = response
            .body_mut()
            .with_config()
            .limit(16 * 1024 * 1024)
            .read_to_vec()?;
        Ok(Response { status, body })
    }
}

fn http() -> Http {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(30 * 60)))
        .build();
    Http(config.into())
}

/// The Store API, authorized.
pub(crate) struct Store<'a, T> {
    pub transport: &'a mut T,
    pub token: String,
}

impl<T: Transport> Store<'_, T> {
    fn call(
        &mut self,
        method: &'static str,
        url: String,
        body: Option<&Value>,
    ) -> anyhow::Result<Value> {
        let mut headers = vec![("Authorization", format!("Bearer {}", self.token))];
        if body.is_some() {
            headers.push(("Content-Type", "application/json".to_owned()));
        }
        let response = self.transport.send(Request {
            method,
            url: url.clone(),
            headers,
            body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
        })?;
        let text = String::from_utf8_lossy(&response.body);
        if !(200..300).contains(&response.status) {
            bail!(
                "the Store answered {method} {url} with {}: {text}",
                response.status
            );
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).with_context(|| format!("{method} {url}: not JSON"))
    }
}

/// An Azure AD access token for the Store API.
pub(crate) fn token(
    transport: &mut impl Transport,
    tenant: &str,
    client: &str,
    secret: &str,
) -> anyhow::Result<String> {
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("grant_type", "client_credentials")
        .append_pair("client_id", client)
        .append_pair("client_secret", secret)
        .append_pair("resource", RESOURCE)
        .finish();
    let response = transport.send(Request {
        method: "POST",
        url: format!("https://login.microsoftonline.com/{tenant}/oauth2/token"),
        headers: vec![(
            "Content-Type",
            "application/x-www-form-urlencoded".to_owned(),
        )],
        body: form.into_bytes(),
    })?;
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    match body["access_token"].as_str() {
        Some(token) if response.status == 200 => Ok(token.to_owned()),
        _ => bail!(
            "Azure AD refused the credentials ({}): {}",
            response.status,
            body["error_description"]
                .as_str()
                .or(body["error"].as_str())
                .unwrap_or("no reason given")
        ),
    }
}

/// What a submission carries.
pub(crate) struct Submit<'a> {
    pub app: &'a str,
    pub package_name: &'a str,
    pub package: &'a [u8],
    /// `(language or None for every listing, text)`.
    pub notes: &'a [(Option<String>, String)],
}

/// Creates, fills, uploads and commits a submission; returns its id.
pub(crate) fn submit<T: Transport>(
    store: &mut Store<'_, T>,
    s: &Submit<'_>,
) -> anyhow::Result<String> {
    let app = store.call("GET", format!("{API}/{}", s.app), None)?;
    if let Some(pending) = app["pendingApplicationSubmission"]["id"].as_str() {
        bail!(
            "the app has a pending submission ({pending}) in Partner Center: finish or delete it first"
        );
    }
    let mut submission = store.call("POST", format!("{API}/{}/submissions", s.app), None)?;
    let id = submission["id"]
        .as_str()
        .context("the Store returned a submission without an id")?
        .to_owned();
    let result = fill_and_commit(store, s, &mut submission, &id);
    if result.is_err() {
        let _ = store.call("DELETE", format!("{API}/{}/submissions/{id}", s.app), None);
    }
    result.map(|()| id)
}

fn fill_and_commit<T: Transport>(
    store: &mut Store<'_, T>,
    s: &Submit<'_>,
    submission: &mut Value,
    id: &str,
) -> anyhow::Result<()> {
    let upload_url = submission["fileUploadUrl"]
        .as_str()
        .context("the Store returned a submission without fileUploadUrl")?
        .to_owned();
    edit(submission, s.package_name, s.notes)?;
    store.call(
        "PUT",
        format!("{API}/{}/submissions/{id}", s.app),
        Some(submission),
    )?;
    let zip = upload_zip(s.package_name, s.package)?;
    let response = store.transport.send(Request {
        method: "PUT",
        url: upload_url,
        headers: vec![
            ("x-ms-blob-type", "BlockBlob".to_owned()),
            ("Content-Type", "application/zip".to_owned()),
        ],
        body: zip,
    })?;
    if !(200..300).contains(&response.status) {
        bail!("uploading the package failed ({})", response.status);
    }
    store.call(
        "POST",
        format!("{API}/{}/submissions/{id}/commit", s.app),
        None,
    )?;
    Ok(())
}

/// Replaces the submission's packages with `package_name` and sets the
/// release notes of its listings.
fn edit(
    submission: &mut Value,
    package_name: &str,
    notes: &[(Option<String>, String)],
) -> anyhow::Result<()> {
    let packages = submission["applicationPackages"]
        .as_array_mut()
        .context("the submission has no applicationPackages")?;
    for package in packages.iter_mut() {
        package["fileStatus"] = json!("PendingDelete");
    }
    packages.push(json!({
        "fileName": package_name,
        "fileStatus": "PendingUpload",
        "minimumDirectXVersion": "None",
        "minimumSystemRam": "None",
    }));
    if notes.is_empty() {
        return Ok(());
    }
    let listings = submission["listings"]
        .as_object_mut()
        .context("the submission has no listings")?;
    for (language, text) in notes {
        match language {
            None => {
                for listing in listings.values_mut() {
                    listing["baseListing"]["releaseNotes"] = json!(text);
                }
            }
            Some(language) => {
                let listing = listings
                    .iter_mut()
                    .find(|(l, _)| l.eq_ignore_ascii_case(language))
                    .map(|(_, v)| v)
                    .with_context(|| {
                        format!("the app has no `{language}` listing in Partner Center")
                    })?;
                listing["baseListing"]["releaseNotes"] = json!(text);
            }
        }
    }
    Ok(())
}

/// The ZIP the Store reads uploaded packages from.
fn upload_zip(name: &str, data: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(
        name,
        zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .large_file(data.len() >= u32::MAX as usize),
    )?;
    zip.write_all(data)?;
    Ok(zip.finish()?.into_inner())
}

/// How a submission's status reads: done, in progress or failed.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum State {
    Published,
    InProgress,
    Failed,
}

pub(crate) fn state(status: &str) -> State {
    match status {
        "Published" | "Release" => State::Published,
        s if s.ends_with("Failed") || s == "Canceled" => State::Failed,
        _ => State::InProgress,
    }
}

fn credentials() -> anyhow::Result<(String, String, String)> {
    let missing: Vec<_> = ENV
        .iter()
        .filter(|v| std::env::var(v).map_or(true, |s| s.is_empty()))
        .copied()
        .collect();
    if !missing.is_empty() {
        bail!(
            "set {} (an Azure AD app associated with Partner Center)",
            missing.join(", ")
        );
    }
    let get = |v: &str| std::env::var(v).unwrap_or_default();
    Ok((get(ENV[0]), get(ENV[1]), get(ENV[2])))
}

fn store_id(app: &AppArgs) -> anyhow::Result<String> {
    if let Some(id) = &app.product_id {
        return Ok(id.clone());
    }
    crate::store::read(&app.entry)?.windows.product_id.context(
        "set nsh.json `store.windows.productId` to the app's Store ID (Partner Center → Product identity), or give --product-id",
    )
}

/// `--notes`, else each locale's release notes of the store listing, by
/// its lowercase tag (`en-us`) as Partner Center names listings.
fn release_notes(app: &AppArgs, notes: &[String]) -> anyhow::Result<Vec<(Option<String>, String)>> {
    if !notes.is_empty() {
        return read_notes(notes);
    }
    Ok(crate::store::read(&app.entry)?
        .locales
        .into_iter()
        .filter_map(|(tag, l)| Some((Some(tag.to_ascii_lowercase()), l.release_notes?)))
        .collect())
}

fn read_notes(notes: &[String]) -> anyhow::Result<Vec<(Option<String>, String)>> {
    notes
        .iter()
        .map(|n| {
            let (language, file) = match n.split_once('=') {
                Some((l, f)) if !l.contains(['/', '\\', '.']) => (Some(l.to_owned()), f),
                _ => (None, n.as_str()),
            };
            let text = std::fs::read_to_string(file).with_context(|| format!("read {file}"))?;
            Ok((language, text.trim().to_owned()))
        })
        .collect()
}

fn status_of<T: Transport>(
    store: &mut Store<'_, T>,
    app: &str,
    id: &str,
) -> anyhow::Result<(String, Value)> {
    let status = store.call("GET", format!("{API}/{app}/submissions/{id}/status"), None)?;
    let name = status["status"].as_str().unwrap_or("Unknown").to_owned();
    Ok((name, status))
}

pub(crate) fn publish(args: &Args) -> anyhow::Result<()> {
    let package = args.package.as_path();
    if package.extension().and_then(|e| e.to_str()) != Some("msix") {
        bail!(
            "{} is not an MSIX package: make one with `nsh package --target windows --format msix`",
            package.display()
        );
    }
    let app = store_id(&args.app)?;
    let notes = release_notes(&args.app, &args.notes)?;
    let data = std::fs::read(package).with_context(|| format!("read {}", package.display()))?;
    let (tenant, client, secret) = credentials()?;
    let mut transport = http();
    let token = token(&mut transport, &tenant, &client, &secret)?;
    let mut store = Store {
        transport: &mut transport,
        token,
    };
    let step = ui::Step::start(format!(
        "submitting {} to the Microsoft Store",
        ui::path(package)
    ));
    let file_name = package
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "app.msix".to_owned());
    let id = submit(
        &mut store,
        &Submit {
            app: &app,
            package_name: &file_name,
            package: &data,
            notes: &notes,
        },
    )?;
    step.done(format!("committed submission {id} of app {app}"));
    if !args.wait {
        ui::done(format!(
            "certification runs in the Store: `nsh publish status windows --submission {id}`"
        ));
        return Ok(());
    }
    wait(&mut store, &app, &id)
}

fn wait<T: Transport>(store: &mut Store<'_, T>, app: &str, id: &str) -> anyhow::Result<()> {
    let step = ui::Step::start("waiting for certification");
    let mut last = String::new();
    loop {
        let (name, status) = status_of(store, app, id)?;
        if name != last {
            eprintln!("submission {id}: {name}");
            last = name.clone();
        }
        match state(&name) {
            State::Published => {
                step.done(format!("submission {id}: {name}"));
                return Ok(());
            }
            State::Failed => bail!(
                "submission {id}: {name}: {}",
                status["statusDetails"]["errors"]
            ),
            State::InProgress => std::thread::sleep(Duration::from_secs(60)),
        }
    }
}

pub(crate) fn status(args: &StatusArgs) -> anyhow::Result<()> {
    let (submission, as_json) = (args.submission.as_deref(), args.json);
    let app = store_id(&args.app)?;
    let (tenant, client, secret) = credentials()?;
    let mut transport = http();
    let token = token(&mut transport, &tenant, &client, &secret)?;
    let mut store = Store {
        transport: &mut transport,
        token,
    };
    let id = match submission {
        Some(id) => id.to_owned(),
        None => {
            let info = store.call("GET", format!("{API}/{app}"), None)?;
            info["pendingApplicationSubmission"]["id"]
                .as_str()
                .or(info["lastPublishedApplicationSubmission"]["id"].as_str())
                .context("the app has no submission yet")?
                .to_owned()
        }
    };
    let (name, status) = status_of(&mut store, &app, &id)?;
    if as_json {
        println!(
            "{}",
            json!({ "app": app, "submission": id, "status": name, "details": status["statusDetails"] })
        );
    } else {
        println!("submission {id}: {name}");
    }
    std::process::exit(match state(&name) {
        State::Published => 0,
        State::Failed => 1,
        State::InProgress => 2,
    })
}

pub(crate) fn doctor(app: &AppArgs) -> anyhow::Result<()> {
    let mut problems = 0;
    let config = crate::package::read_config(&app.entry).ok();
    let check = |ok: bool, what: String, problems: &mut i32| {
        if ok {
            ui::done(what);
        } else {
            ui::warn(what);
            *problems += 1;
        }
    };
    if let Some(config) = &config {
        let w = &config.windows;
        check(
            w.identity_name.is_some(),
            "nsh.json windows.identityName (Product identity → Package/Identity/Name)".into(),
            &mut problems,
        );
        check(
            w.publisher.is_some(),
            "nsh.json windows.publisher (Package/Identity/Publisher)".into(),
            &mut problems,
        );
        check(
            config
                .icon(crate::package::PackageTarget::Windows)
                .is_some(),
            "nsh.json icon (the package's logos)".into(),
            &mut problems,
        );
    }
    let id = store_id(app);
    check(
        id.is_ok(),
        "the app's Store ID (store.windows.productId or --product-id)".into(),
        &mut problems,
    );
    match credentials() {
        Err(e) => check(false, format!("{e:#}"), &mut problems),
        Ok((tenant, client, secret)) => {
            let mut transport = http();
            match token(&mut transport, &tenant, &client, &secret) {
                Err(e) => check(false, format!("{e:#}"), &mut problems),
                Ok(token) => {
                    check(true, "Azure AD credentials".into(), &mut problems);
                    if let Ok(id) = &id {
                        let mut store = Store {
                            transport: &mut transport,
                            token,
                        };
                        match store.call("GET", format!("{API}/{id}"), None) {
                            Ok(app) => check(
                                true,
                                format!(
                                    "Store app {id}: {}",
                                    app["primaryName"].as_str().unwrap_or("?")
                                ),
                                &mut problems,
                            ),
                            Err(e) => check(false, format!("{e:#}"), &mut problems),
                        }
                    }
                }
            }
        }
    }
    if problems > 0 {
        bail!("{problems} problem(s) to fix before `nsh publish windows`");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        requests: Vec<Request>,
        responses: Vec<(u16, String)>,
    }

    impl Transport for Fake {
        fn send(&mut self, request: Request) -> anyhow::Result<Response> {
            self.requests.push(request);
            let (status, body) = self.responses.remove(0);
            Ok(Response {
                status,
                body: body.into_bytes(),
            })
        }
    }

    fn submission() -> String {
        json!({
            "id": "1152921504",
            "fileUploadUrl": "https://blob.example/x?sig=secret",
            "applicationPackages": [{ "fileName": "old.msix", "fileStatus": "Uploaded" }],
            "listings": { "en-us": { "baseListing": { "releaseNotes": "" } }, "zh-cn": { "baseListing": {} } },
        })
        .to_string()
    }

    #[test]
    fn a_submission_replaces_the_package_uploads_and_commits() {
        let mut fake = Fake {
            requests: vec![],
            responses: vec![
                (200, "{}".into()),
                (201, submission()),
                (200, "{}".into()),
                (201, String::new()),
                (202, r#"{"status":"CommitStarted"}"#.into()),
            ],
        };
        let mut store = Store {
            transport: &mut fake,
            token: "t".into(),
        };
        let notes = [
            (None, "Faster".to_owned()),
            (Some("zh-CN".to_owned()), "更快".to_owned()),
        ];
        let id = submit(
            &mut store,
            &Submit {
                app: "9N1",
                package_name: "App.msix",
                package: b"PK",
                notes: &notes,
            },
        )
        .unwrap();
        assert_eq!(id, "1152921504");
        let methods: Vec<_> = fake
            .requests
            .iter()
            .map(|r| (r.method, r.url.clone()))
            .collect();
        assert_eq!(methods[0], ("GET", format!("{API}/9N1")));
        assert_eq!(methods[1], ("POST", format!("{API}/9N1/submissions")));
        assert_eq!(
            methods[2],
            ("PUT", format!("{API}/9N1/submissions/1152921504"))
        );
        assert_eq!(
            methods[3],
            ("PUT", "https://blob.example/x?sig=secret".to_owned())
        );
        assert_eq!(
            methods[4].1,
            format!("{API}/9N1/submissions/1152921504/commit")
        );
        let put: Value = serde_json::from_slice(&fake.requests[2].body).unwrap();
        assert_eq!(put["applicationPackages"][0]["fileStatus"], "PendingDelete");
        assert_eq!(put["applicationPackages"][1]["fileName"], "App.msix");
        assert_eq!(
            put["listings"]["en-us"]["baseListing"]["releaseNotes"],
            "Faster"
        );
        assert_eq!(
            put["listings"]["zh-cn"]["baseListing"]["releaseNotes"],
            "更快"
        );
        assert!(
            fake.requests[3]
                .headers
                .contains(&("x-ms-blob-type", "BlockBlob".to_owned()))
        );
        let zip =
            zip::ZipArchive::new(std::io::Cursor::new(fake.requests[3].body.clone())).unwrap();
        let names: Vec<_> = zip.file_names().map(|n| n.unwrap().into_owned()).collect();
        assert_eq!(names, ["App.msix"]);
    }

    #[test]
    fn a_failed_upload_deletes_the_submission() {
        let mut fake = Fake {
            requests: vec![],
            responses: vec![
                (200, "{}".into()),
                (201, submission()),
                (200, "{}".into()),
                (403, String::new()),
                (204, String::new()),
            ],
        };
        let mut store = Store {
            transport: &mut fake,
            token: "t".into(),
        };
        assert!(
            submit(
                &mut store,
                &Submit {
                    app: "9N1",
                    package_name: "a.msix",
                    package: b"",
                    notes: &[]
                }
            )
            .is_err()
        );
        let last = fake.requests.last().unwrap();
        assert_eq!(
            (last.method, last.url.as_str()),
            ("DELETE", &*format!("{API}/9N1/submissions/1152921504"))
        );
    }

    #[test]
    fn a_pending_submission_is_left_alone() {
        let mut fake = Fake {
            requests: vec![],
            responses: vec![(200, r#"{"pendingApplicationSubmission":{"id":"7"}}"#.into())],
        };
        let mut store = Store {
            transport: &mut fake,
            token: "t".into(),
        };
        let err = submit(
            &mut store,
            &Submit {
                app: "9N1",
                package_name: "a.msix",
                package: b"",
                notes: &[],
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("pending submission (7)"));
        assert_eq!(fake.requests.len(), 1);
    }

    #[test]
    fn states() {
        assert_eq!(state("Published"), State::Published);
        assert_eq!(state("CertificationFailed"), State::Failed);
        assert_eq!(state("Certification"), State::InProgress);
    }
}
