//! App Store Connect build uploads. Credentials stay in memory; the IPA is
//! streamed to Apple's delivery URLs separately from authenticated API calls.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, bail, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::ui;

/// Upload an already packaged iOS application.
#[derive(clap::Args, Clone)]
pub(crate) struct Args {
    /// App Store-signed IPA produced by `nsh package --target ios`.
    ipa: PathBuf,
    /// Numeric Apple ID of the app in App Store Connect.
    #[arg(long, env = "NSH_APP_STORE_APP_ID")]
    app_id: String,
    /// App Store Connect team API key issuer ID.
    #[arg(long, env = "NSH_APP_STORE_ISSUER_ID")]
    issuer_id: String,
    /// App Store Connect API key ID.
    #[arg(long, env = "NSH_APP_STORE_KEY_ID")]
    key_id: String,
    /// Private API key (.p8); keep it outside the project.
    #[arg(long, env = "NSH_APP_STORE_PRIVATE_KEY", hide_env_values = true)]
    private_key: PathBuf,
}

struct Credentials {
    issuer: String,
    key_id: String,
    key: EcdsaKeyPair,
}

impl Credentials {
    fn from_pem(issuer: String, key_id: String, pem: &str) -> anyhow::Result<Self> {
        ensure!(
            !issuer.trim().is_empty() && !key_id.trim().is_empty(),
            "issuer ID and key ID must be nonempty"
        );
        let encoded = pem
            .trim()
            .strip_prefix("-----BEGIN PRIVATE KEY-----")
            .and_then(|s| s.strip_suffix("-----END PRIVATE KEY-----"))
            .context("expected a PKCS#8 App Store Connect private key (.p8)")?;
        let der = STANDARD
            .decode(encoded.split_whitespace().collect::<String>())
            .context("invalid private key encoding")?;
        let key =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &SystemRandom::new())
                .map_err(|_| anyhow::anyhow!("expected an ES256 App Store Connect private key"))?;
        Ok(Self {
            issuer,
            key_id,
            key,
        })
    }

    fn token(&self, now: u64) -> anyhow::Result<String> {
        let header = URL_SAFE_NO_PAD.encode(serde_json::to_vec(
            &json!({"alg":"ES256", "kid":self.key_id, "typ":"JWT"}),
        )?);
        let claims = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({
            "iss":self.issuer, "iat":now, "exp":now + 120, "aud":"appstoreconnect-v1"
        }))?);
        let message = format!("{header}.{claims}");
        let signature = self
            .key
            .sign(&SystemRandom::new(), message.as_bytes())
            .map_err(|_| anyhow::anyhow!("could not sign App Store Connect token"))?;
        Ok(format!(
            "{message}.{}",
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        ))
    }
}

struct Ipa {
    bundle_id: String,
    version: String,
    build: String,
}

impl Ipa {
    fn read(file: &mut File) -> anyhow::Result<Self> {
        let mut zip = zip::ZipArchive::new(file).context("read IPA archive")?;
        let names = zip.file_names().collect::<Result<Vec<_>, _>>()?;
        let paths: Vec<String> = names
            .iter()
            .filter(|name| {
                let parts: Vec<_> = name.split('/').collect();
                parts.len() == 3
                    && parts[0] == "Payload"
                    && parts[1].ends_with(".app")
                    && parts[2] == "Info.plist"
            })
            .map(ToString::to_string)
            .collect();
        ensure!(
            paths.len() == 1,
            "IPA must contain exactly one Payload/*.app/Info.plist"
        );
        let mut entry = zip.by_name(&paths[0])?;
        ensure!(entry.size() <= 1024 * 1024, "IPA Info.plist exceeds 1 MiB");
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes)?;
        let plist = plist::Value::from_reader(std::io::Cursor::new(bytes))?;
        let text = |key: &str| -> anyhow::Result<String> {
            plist
                .as_dictionary()
                .and_then(|d| d.get(key))
                .and_then(plist::Value::as_string)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .with_context(|| format!("IPA is missing {key}"))
        };
        let platforms = plist
            .as_dictionary()
            .and_then(|d| d.get("CFBundleSupportedPlatforms"))
            .and_then(plist::Value::as_array)
            .context("IPA is missing CFBundleSupportedPlatforms")?;
        ensure!(
            platforms.iter().any(|p| p.as_string() == Some("iPhoneOS")),
            "IPA must target iOS devices"
        );
        Ok(Self {
            bundle_id: text("CFBundleIdentifier")?,
            version: text("CFBundleShortVersionString")?,
            build: text("CFBundleVersion")?,
        })
    }

    fn upload_request(&self, app_id: &str) -> Value {
        json!({"data":{"type":"buildUploads", "attributes":{
            "cfBundleShortVersionString":self.version, "cfBundleVersion":self.build, "platform":"IOS"
        }, "relationships":{"app":{"data":{"type":"apps", "id":app_id}}}}})
    }
}

fn file_request(upload_id: &str, name: &str, size: u64) -> Value {
    json!({"data":{"type":"buildUploadFiles", "attributes":{
        "assetType":"ASSET", "fileName":name, "fileSize":size, "uti":"com.apple.ipa"
    }, "relationships":{"buildUpload":{"data":{"type":"buildUploads", "id":upload_id}}}}})
}

fn complete_request(file_id: &str, checksum: &str) -> Value {
    json!({"data":{"type":"buildUploadFiles", "id":file_id, "attributes":{
        "uploaded":true, "sourceFileChecksums":{"file":{"algorithm":"SHA_256", "hash":checksum}}
    }}})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadOperation {
    method: String,
    url: String,
    offset: u64,
    length: u64,
    #[serde(default)]
    request_headers: Vec<UploadHeader>,
}

#[derive(Deserialize)]
struct UploadHeader {
    name: String,
    value: String,
}

fn validate_operations(operations: &[UploadOperation], size: u64) -> anyhow::Result<()> {
    let mut ranges = Vec::new();
    for op in operations {
        let uri: ureq::http::Uri = op.url.parse().context("invalid upload URL")?;
        ensure!(
            uri.scheme_str() == Some("https") && uri.host().is_some(),
            "upload URL must use HTTPS"
        );
        ensure!(op.method == "PUT", "unsupported upload method");
        let end = op
            .offset
            .checked_add(op.length)
            .context("upload range overflow")?;
        ensure!(op.length > 0 && end <= size, "upload range exceeds IPA");
        ranges.push((op.offset, end));
    }
    ranges.sort_unstable();
    let mut cursor = 0;
    for (start, end) in ranges {
        ensure!(
            start == cursor,
            "upload ranges must cover the IPA without gaps or overlaps"
        );
        cursor = end;
    }
    ensure!(
        cursor == size && size > 0,
        "upload operations do not cover the IPA"
    );
    Ok(())
}

fn delivery_request(op: &UploadOperation) -> anyhow::Result<ureq::http::request::Builder> {
    let mut request = ureq::http::Request::builder()
        .method(op.method.as_str())
        .uri(&op.url);
    for header in &op.request_headers {
        if header.name.eq_ignore_ascii_case("content-length") {
            ensure!(
                header.value.parse::<u64>().ok() == Some(op.length),
                "upload Content-Length does not match the part"
            );
        } else {
            request = request.header(&header.name, &header.value);
        }
    }
    Ok(request.header("Content-Length", op.length))
}

struct Client {
    agent: ureq::Agent,
    credentials: Credentials,
}

impl Client {
    fn request(&self, method: &str, path: &str, body: Option<Value>) -> anyhow::Result<Value> {
        // Refresh for every control request: a large IPA may take longer than a token's lifetime.
        let token = self
            .credentials
            .token(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())?;
        let request = ureq::http::Request::builder()
            .method(method)
            .uri(format!("https://api.appstoreconnect.apple.com/v1/{path}"))
            .header("Authorization", format!("Bearer {token}"))
            .header("Content-Type", "application/json")
            .body(body.map(|b| b.to_string()).unwrap_or_default())?;
        let mut response = self
            .agent
            .run(request)
            .with_context(|| format!("App Store Connect {method} {path} failed"))?;
        let status = response.status();
        let value: Value = serde_json::from_slice(&response.body_mut().read_to_vec()?)
            .with_context(|| {
                format!("App Store Connect returned HTTP {status} with an invalid JSON response")
            })?;
        if !status.is_success() {
            let errors = value
                .get("errors")
                .and_then(Value::as_array)
                .map(|errors| {
                    errors
                        .iter()
                        .map(|e| {
                            format!(
                                "{}: {}",
                                e["code"].as_str().unwrap_or("UNKNOWN"),
                                e["detail"]
                                    .as_str()
                                    .or(e["title"].as_str())
                                    .unwrap_or("request rejected")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; ")
                })
                .unwrap_or_default();
            bail!("App Store Connect HTTP {status}: {errors}");
        }
        Ok(value)
    }
}

fn resource_id(response: &Value) -> anyhow::Result<&str> {
    let id = response["data"]["id"]
        .as_str()
        .context("App Store Connect response has no resource ID")?;
    ensure!(
        !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
        "invalid App Store Connect resource ID"
    );
    Ok(id)
}

/// Upload bytes and hand processing to App Store Connect; never submit for review.
pub(crate) fn publish(args: &Args) -> anyhow::Result<()> {
    ensure!(cfg!(target_os = "macos"), "nsh publish ios runs on macOS");
    ensure!(
        !args.app_id.is_empty() && args.app_id.bytes().all(|c| c.is_ascii_digit()),
        "--app-id must be the numeric Apple ID from App Store Connect"
    );
    let mut file = File::open(&args.ipa).context("open IPA")?;
    let size = file.metadata()?.len();
    let ipa = Ipa::read(&mut file)?;
    let name = args
        .ipa
        .file_name()
        .and_then(|s| s.to_str())
        .context("IPA filename must be UTF-8")?;
    let pem =
        std::fs::read_to_string(&args.private_key).context("read App Store Connect .p8 key")?;
    let credentials = Credentials::from_pem(args.issuer_id.clone(), args.key_id.clone(), &pem)?;
    let client = Client {
        credentials,
        agent: ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(120)))
            .build()
            .into(),
    };
    let app = client.request("GET", &format!("apps/{}", args.app_id), None)?;
    ensure!(
        app["data"]["attributes"]["bundleId"].as_str() == Some(&ipa.bundle_id),
        "IPA bundle identifier does not match --app-id"
    );
    file.rewind()?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    let checksum = format!("{:x}", digest.finalize());
    let upload = client.request(
        "POST",
        "buildUploads",
        Some(ipa.upload_request(&args.app_id)),
    )?;
    let upload_id = resource_id(&upload)?;
    ui::note(format!(
        "App Store Connect upload {upload_id}: {} {} ({})",
        ipa.bundle_id, ipa.version, ipa.build
    ));
    upload_file(&client, upload_id, name, size, &checksum, &mut file).with_context(|| {
        format!("upload {upload_id} did not finish; check App Store Connect before retrying")
    })?;
    ui::done(format!(
        "uploaded {} to App Store Connect (upload {upload_id}); Apple processes the build for TestFlight. Check https://appstoreconnect.apple.com/apps/{}/testflight",
        ui::path(&args.ipa),
        args.app_id
    ));
    Ok(())
}

fn upload_file(
    client: &Client,
    upload_id: &str,
    name: &str,
    size: u64,
    checksum: &str,
    file: &mut File,
) -> anyhow::Result<()> {
    let reservation = client.request(
        "POST",
        "buildUploadFiles",
        Some(file_request(upload_id, name, size)),
    )?;
    let file_id = resource_id(&reservation)?;
    let operations: Vec<UploadOperation> =
        serde_json::from_value(reservation["data"]["attributes"]["uploadOperations"].clone())
            .context("read file upload operations")?;
    validate_operations(&operations, size)?;
    // Delivery requests carry only Apple's supplied headers, never the API JWT.
    let delivery: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(Duration::from_secs(1800)))
        .build()
        .into();
    for (index, op) in operations.iter().enumerate() {
        file.seek(SeekFrom::Start(op.offset))?;
        let mut part = (&mut *file).take(op.length);
        let request = delivery_request(op)?.body(ureq::SendBody::from_reader(&mut part))?;
        // Delivery errors may contain signed URLs; do not expose them in logs.
        let response = delivery
            .run(request)
            .map_err(|_| anyhow::anyhow!("IPA part {} transfer failed", index + 1))?;
        ensure!(
            response.status().is_success(),
            "IPA part {} returned HTTP {}",
            index + 1,
            response.status()
        );
        ensure!(
            part.limit() == 0,
            "IPA changed or was truncated during upload"
        );
        ui::note(format!(
            "uploaded IPA part {}/{}",
            index + 1,
            operations.len()
        ));
    }
    let completed = client.request(
        "PATCH",
        &format!("buildUploadFiles/{file_id}"),
        Some(complete_request(file_id, checksum)),
    )?;
    ensure!(
        completed["data"]["attributes"]["assetDeliveryState"]["state"].as_str() != Some("FAILED"),
        "Apple rejected the uploaded file; check App Store Connect"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use ring::signature::{ECDSA_P256_SHA256_FIXED, KeyPair, UnparsedPublicKey};

    use super::*;

    #[test]
    fn jwt_is_es256_with_apple_claims_and_a_verifiable_fixed_width_signature() {
        let der =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(der.as_ref())
        );
        let credentials = Credentials::from_pem("issuer".into(), "KEY123".into(), &pem).unwrap();
        let token = credentials.token(1_700_000_000).unwrap();
        let parts: Vec<_> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let decode =
            |part| serde_json::from_slice::<Value>(&URL_SAFE_NO_PAD.decode(part).unwrap()).unwrap();
        assert_eq!(
            decode(parts[0]),
            json!({"alg":"ES256", "kid":"KEY123", "typ":"JWT"})
        );
        assert_eq!(
            decode(parts[1]),
            json!({"iss":"issuer", "aud":"appstoreconnect-v1", "iat":1_700_000_000u64, "exp":1_700_000_120u64})
        );
        let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
        assert_eq!(signature.len(), 64);
        let verifier = UnparsedPublicKey::new(
            &ECDSA_P256_SHA256_FIXED,
            credentials.key.public_key().as_ref(),
        );
        verifier
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .unwrap();
        assert!(verifier.verify(b"tampered", &signature).is_err());
    }

    #[test]
    fn invalid_keys_fail_without_echoing_key_contents() {
        let secret = "invalid-sensitive-key";
        let error = Credentials::from_pem("issuer".into(), "KEY123".into(), secret)
            .err()
            .unwrap();
        assert!(!error.to_string().contains(secret));
        assert!(
            Credentials::from_pem(
                "issuer".into(),
                "KEY123".into(),
                "-----BEGIN PRIVATE KEY-----\nYWJj\n-----END PRIVATE KEY-----"
            )
            .is_err()
        );
    }

    #[test]
    fn requests_link_the_app_upload_and_ipa_and_commit_sha256() {
        let ipa = Ipa {
            bundle_id: "com.example.app".into(),
            version: "1.2.3".into(),
            build: "42".into(),
        };
        assert_eq!(
            ipa.upload_request("123"),
            json!({"data":{
                "type":"buildUploads", "attributes":{"cfBundleShortVersionString":"1.2.3", "cfBundleVersion":"42", "platform":"IOS"},
                "relationships":{"app":{"data":{"type":"apps", "id":"123"}}}
            }})
        );
        assert_eq!(
            file_request("upload-1", "My App.ipa", 128),
            json!({"data":{
                "type":"buildUploadFiles", "attributes":{"assetType":"ASSET", "fileName":"My App.ipa", "fileSize":128, "uti":"com.apple.ipa"},
                "relationships":{"buildUpload":{"data":{"type":"buildUploads", "id":"upload-1"}}}
            }})
        );
        assert_eq!(
            complete_request("file-1", "abcd"),
            json!({"data":{
                "type":"buildUploadFiles", "id":"file-1", "attributes":{"uploaded":true,"sourceFileChecksums":{"file":{"algorithm":"SHA_256","hash":"abcd"}}}
            }})
        );
    }

    fn operation(offset: u64, length: u64) -> UploadOperation {
        serde_json::from_value(json!({"url":"https://delivery.apple.com/upload?signature=test", "method":"PUT", "offset":offset, "length":length,
            "requestHeaders":[{"name":"Content-Type", "value":"application/octet-stream"}]})).unwrap()
    }

    #[test]
    fn upload_ranges_cover_the_file_exactly_even_when_unordered() {
        assert!(validate_operations(&[operation(5, 5), operation(0, 5)], 10).is_ok());
        for ops in [
            vec![],
            vec![operation(0, 9)],
            vec![operation(0, 11)],
            vec![operation(0, 0)],
            vec![operation(0, 6), operation(5, 5)],
            vec![operation(0, 4), operation(5, 5)],
            vec![operation(u64::MAX, 1)],
        ] {
            assert!(validate_operations(&ops, 10).is_err());
        }
        let mut op = operation(0, 10);
        op.url = "http://delivery.apple.com/upload".into();
        assert!(validate_operations(&[op], 10).is_err());
        let mut op = operation(0, 10);
        op.method = "GET".into();
        assert!(validate_operations(&[op], 10).is_err());
    }

    #[test]
    fn delivery_requests_use_only_supplied_headers_and_exact_part_length() {
        let mut op = operation(5, 10);
        op.request_headers.push(UploadHeader {
            name: "content-length".into(),
            value: "10".into(),
        });
        let request = delivery_request(&op).unwrap().body(()).unwrap();
        assert_eq!(request.method(), "PUT");
        assert_eq!(
            request.headers()["content-type"],
            "application/octet-stream"
        );
        assert_eq!(request.headers()["content-length"], "10");
        assert_eq!(
            request.headers().get_all("content-length").iter().count(),
            1
        );
        assert!(!request.headers().contains_key("authorization"));
        op.request_headers.last_mut().unwrap().value = "11".into();
        assert!(delivery_request(&op).is_err());
    }

    #[test]
    fn resource_ids_cannot_change_the_api_path() {
        assert_eq!(
            resource_id(&json!({"data":{"id":"abc-123"}})).unwrap(),
            "abc-123"
        );
        assert!(resource_id(&json!({"data":{"id":"../apps"}})).is_err());
        assert!(resource_id(&json!({})).is_err());
    }

    #[test]
    fn ipa_reads_binary_plist_and_rejects_simulators_and_ambiguous_apps() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("nsh-publish-ios-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.ipa");
        for (platform, count, valid) in [
            ("iPhoneOS", 1, true),
            ("iPhoneSimulator", 1, false),
            ("iPhoneOS", 2, false),
        ] {
            let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
            for i in 0..count {
                zip.start_file(
                    format!("Payload/App{i}.app/Info.plist"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
                let mut d = plist::Dictionary::new();
                for (key, value) in [
                    ("CFBundleIdentifier", "com.example.app"),
                    ("CFBundleShortVersionString", "2.1"),
                    ("CFBundleVersion", "57"),
                ] {
                    d.insert(key.into(), plist::Value::String(value.into()));
                }
                d.insert(
                    "CFBundleSupportedPlatforms".into(),
                    plist::Value::Array(vec![plist::Value::String(platform.into())]),
                );
                let mut bytes = Vec::new();
                plist::Value::Dictionary(d)
                    .to_writer_binary(&mut bytes)
                    .unwrap();
                zip.write_all(&bytes).unwrap();
            }
            zip.finish().unwrap();
            let result = Ipa::read(&mut File::open(&path).unwrap());
            assert_eq!(result.is_ok(), valid);
            if let Ok(ipa) = result {
                assert_eq!(
                    (
                        ipa.bundle_id.as_str(),
                        ipa.version.as_str(),
                        ipa.build.as_str()
                    ),
                    ("com.example.app", "2.1", "57")
                );
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
