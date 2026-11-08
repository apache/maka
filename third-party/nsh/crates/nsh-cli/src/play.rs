//! `nsh publish android`: uploads an Android App Bundle (`.aab`) to Google
//! Play's internal testing track with the Google Play Developer API.
//!
//! The flow is one edit: `edits.insert` → `edits.bundles.upload` →
//! `edits.tracks.update` (track `internal`) → `edits.commit`; an edit that
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

use crate::ui;

const SCOPE: &str = "https://www.googleapis.com/auth/androidpublisher";
const API: &str = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_API: &str =
    "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
/// The only track this command releases to: testers get it at once, and
/// nothing reaches the public without a person promoting it in Play Console.
pub(crate) const TRACK: &str = "internal";

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

pub(crate) struct Options<'a> {
    pub bundle: &'a Path,
    pub package: &'a str,
    pub account: &'a ServiceAccount,
    /// Release as a draft: Play takes only drafts until the app's first
    /// release is made in Play Console.
    pub draft: bool,
}

/// What Play reported for the release.
#[derive(Debug, PartialEq)]
pub(crate) struct Uploaded {
    pub version_code: i64,
}

/// Uploads the bundle and releases it to the internal track, in one edit.
pub(crate) fn upload(
    transport: &mut dyn Transport,
    options: &Options<'_>,
    now: u64,
) -> anyhow::Result<Uploaded> {
    let bundle = std::fs::read(options.bundle)
        .with_context(|| format!("the bundle {}", options.bundle.display()))?;
    let token = access_token(transport, options.account, now)?;
    let app = format!("{API}/{}", options.package);
    let call = |transport: &mut dyn Transport, method, url: String, body: Option<Value>| {
        call(transport, &token, method, url, body)
    };
    let edit = call(transport, "POST", format!("{app}/edits"), Some(json!({})))
        .context("could not open an edit on Google Play")?;
    let Some(edit) = edit["id"].as_str().map(str::to_owned) else {
        bail!("Google Play opened an edit without an id: {edit}");
    };
    let edit_url = format!("{app}/edits/{edit}");
    let result = (|| {
        let uploaded = send(
            transport,
            Request {
                method: "POST",
                url: format!(
                    "{UPLOAD_API}/{}/edits/{edit}/bundles?uploadType=media",
                    options.package
                ),
                content_type: Some("application/octet-stream"),
                token: Some(token.clone()),
                body: bundle,
            },
        )
        .context("Google Play refused the bundle")?;
        let Some(version_code) = uploaded["versionCode"].as_i64() else {
            bail!("Google Play took the bundle without a versionCode: {uploaded}");
        };
        let status = if options.draft { "draft" } else { "completed" };
        call(
            transport,
            "PUT",
            format!("{edit_url}/tracks/{TRACK}"),
            Some(json!({
                "track": TRACK,
                "releases": [{
                    "versionCodes": [version_code.to_string()],
                    "status": status,
                }],
            })),
        )
        .context("Google Play refused the internal testing release")?;
        call(transport, "POST", format!("{edit_url}:commit"), None)
            .context("Google Play refused to commit the edit")?;
        Ok(Uploaded { version_code })
    })();
    if result.is_err() {
        // Leave no open edit behind; a failure here changes nothing.
        let _ = call(transport, "DELETE", edit_url, None);
    }
    result
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

/// `nsh publish android`.
pub(crate) fn publish(
    bundle: &Path,
    entry: &Path,
    package: Option<String>,
    credentials: Option<PathBuf>,
    draft: bool,
) -> anyhow::Result<()> {
    if bundle.extension().and_then(|e| e.to_str()) != Some("aab") {
        bail!(
            "{} is not an Android App Bundle (.aab): Google Play takes bundles, not APKs",
            bundle.display()
        );
    }
    let Some(credentials) = credentials else {
        bail!(
            "give the Google Play service account's JSON key with --credentials or NSH_PLAY_CREDENTIALS"
        );
    };
    let package = match package {
        Some(package) => package,
        None => {
            let config = crate::package::read_config(entry)?;
            match config.id {
                Some(id) => id,
                None => bail!("nsh.json has no `id`: give the app's package name with --package"),
            }
        }
    };
    let account = ServiceAccount::read(&credentials)?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
    let uploaded = upload(
        &mut Http::new(),
        &Options {
            bundle,
            package: &package,
            account: &account,
            draft,
        },
        now,
    )?;
    ui::done(format!(
        "{package} version code {} is on Google Play's internal testing track{}",
        uploaded.version_code,
        if draft { " as a draft" } else { "" }
    ));
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
                bundle: &path,
                package: "com.acme.app",
                account: &account,
                draft: false,
            },
            1_000,
        )
        .unwrap();
        assert_eq!(uploaded, Uploaded { version_code: 42 });
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
            bundle: &path,
            package: "a.b",
            account: &account,
            draft: true,
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
            bundle: &path,
            package: "a.b",
            account: &account,
            draft: false,
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
            bundle: &path,
            package: "a.b",
            account: &account,
            draft: false,
        };
        let error = format!("{:#}", upload(&mut fake, &options, 0).unwrap_err());
        assert!(
            error.contains("ci@example.iam.gserviceaccount.com"),
            "{error}"
        );
        assert!(error.contains("Invalid JWT Signature."), "{error}");
        assert_eq!(fake.requests.len(), 1);
    }

    #[test]
    fn only_bundles_are_taken() {
        let error = publish(Path::new("app.apk"), Path::new("."), None, None, false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not an Android App Bundle"), "{error}");
        let error = publish(Path::new("app.aab"), Path::new("."), None, None, false)
            .unwrap_err()
            .to_string();
        assert!(error.contains("NSH_PLAY_CREDENTIALS"), "{error}");
    }
}
