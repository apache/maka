//! App Store Connect delivery: upload, processing, TestFlight, the App Store
//! version and listing, and App Review. Credentials stay in memory; the IPA
//! is streamed to Apple's delivery URLs separately from authenticated API
//! calls. Control calls go through [`Transport`] so the flow is tested
//! without the network.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, bail, ensure};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use md5::Md5;
use ring::{
    rand::SystemRandom,
    signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::Digest;

use crate::{
    play::{Http, Request, Transport},
    store::{ReleaseMode, StoreConfig, StoreState, query_value},
    ui,
};

pub(crate) struct Credentials {
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

pub(crate) struct Ipa {
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
        "uploaded":true, "sourceFileChecksums":{"file":{"algorithm":"MD5", "hash":checksum}}
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

const API: &str = "https://api.appstoreconnect.apple.com/v1";

/// App Store Connect over a [`Transport`], signing a fresh token per call: a
/// large IPA or a long processing wait outlives any one token.
pub(crate) struct Asc<'a> {
    transport: &'a mut dyn Transport,
    credentials: &'a Credentials,
    clock: fn() -> u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl<'a> Asc<'a> {
    fn new(transport: &'a mut dyn Transport, credentials: &'a Credentials) -> Self {
        Self {
            transport,
            credentials,
            clock: now,
        }
    }

    fn call(
        &mut self,
        method: &'static str,
        path: &str,
        body: Option<Value>,
    ) -> anyhow::Result<Value> {
        let token = self.credentials.token((self.clock)())?;
        let response = self.transport.send(Request {
            method,
            url: format!("{API}/{path}"),
            content_type: body.as_ref().map(|_| "application/json"),
            token: Some(token),
            body: body.map(|b| b.to_string().into_bytes()).unwrap_or_default(),
        })?;
        let value: Value = if response.body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&response.body).with_context(|| {
                format!(
                    "App Store Connect returned HTTP {} with an invalid JSON response",
                    response.status
                )
            })?
        };
        if !(200..300).contains(&response.status) {
            let errors = value["errors"]
                .as_array()
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
            bail!(
                "App Store Connect {method} {} HTTP {}: {errors}",
                path.split('?').next().unwrap_or(path),
                response.status
            );
        }
        Ok(value)
    }

    fn get(&mut self, path: &str) -> anyhow::Result<Value> {
        self.call("GET", path, None)
    }

    fn list(&mut self, path: &str) -> anyhow::Result<Vec<Value>> {
        Ok(self.get(path)?["data"]
            .as_array()
            .cloned()
            .unwrap_or_default())
    }
}

fn resource_id(response: &Value) -> anyhow::Result<&str> {
    id_of(&response["data"])
}

/// A resource's ID, checked so that it cannot change an API path.
fn id_of(resource: &Value) -> anyhow::Result<&str> {
    let id = resource["id"]
        .as_str()
        .context("App Store Connect response has no resource ID")?;
    ensure!(
        !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
        "invalid App Store Connect resource ID"
    );
    Ok(id)
}

fn link(kind: &str, id: &str) -> Value {
    json!({"data":{"type":kind, "id":id}})
}

/// The App Store Connect credentials and app, from flags or the environment.
/// Each is optional here so that `doctor` can report what is missing.
#[derive(clap::Args, Clone)]
pub(crate) struct Account {
    /// Numeric Apple ID of the app in App Store Connect (default: nsh.json
    /// `store.ios.appId`).
    #[arg(long, env = "NSH_APP_STORE_APP_ID")]
    app_id: Option<String>,
    /// App Store Connect team API key issuer ID.
    #[arg(long, env = "NSH_APP_STORE_ISSUER_ID")]
    issuer_id: Option<String>,
    /// App Store Connect API key ID.
    #[arg(long, env = "NSH_APP_STORE_KEY_ID")]
    key_id: Option<String>,
    /// Private API key (.p8); keep it outside the project (default:
    /// `~/.appstoreconnect/private_keys/AuthKey_<key id>.p8`).
    #[arg(long, env = "NSH_APP_STORE_PRIVATE_KEY", hide_env_values = true)]
    private_key: Option<PathBuf>,
    /// The app's directory or entry, whose `nsh.json` holds `version` and
    /// the store listing (`"store"`, `store/`).
    #[arg(long, default_value = ".")]
    entry: PathBuf,
}

impl Account {
    /// `--app-id` / `NSH_APP_STORE_APP_ID`, else `nsh.json`
    /// `store.ios.appId`.
    fn app_id(&self) -> anyhow::Result<String> {
        let id = match &self.app_id {
            Some(id) => id.clone(),
            None => crate::store::read(&self.entry)
                .context("read nsh.json for `store.ios.appId`")?
                .ios
                .app_id
                .context(
                    "set the app's Apple ID (App Store Connect → App Information → Apple ID) \
                     in nsh.json `store.ios.appId`, or give --app-id",
                )?,
        };
        ensure!(
            !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()),
            "the app ID `{id}` must be the numeric Apple ID from App Store Connect"
        );
        Ok(id)
    }

    fn credentials(&self) -> anyhow::Result<Credentials> {
        let issuer = self
            .issuer_id
            .clone()
            .context("give the API key issuer with --issuer-id or NSH_APP_STORE_ISSUER_ID")?;
        let key_id = self
            .key_id
            .clone()
            .context("give the API key ID with --key-id or NSH_APP_STORE_KEY_ID")?;
        let path = match &self.private_key {
            Some(path) => path.clone(),
            None => default_key(&key_id).with_context(|| {
                format!(
                    "put the .p8 key at ~/.appstoreconnect/private_keys/AuthKey_{key_id}.p8, \
                     or give --private-key or NSH_APP_STORE_PRIVATE_KEY"
                )
            })?,
        };
        let pem = std::fs::read_to_string(&path)
            .with_context(|| format!("read App Store Connect key {}", path.display()))?;
        Credentials::from_pem(issuer, key_id, &pem)
    }
}

/// Where Apple's tools (`altool`, `xcrun notarytool`) look for
/// `AuthKey_<key id>.p8`: the first that exists.
fn default_key(key_id: &str) -> Option<PathBuf> {
    let name = format!("AuthKey_{key_id}.p8");
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs = vec![PathBuf::from("private_keys")];
    if let Some(home) = home {
        for dir in [
            ".appstoreconnect/private_keys",
            ".private_keys",
            "private_keys",
        ] {
            dirs.push(home.join(dir));
        }
    }
    dirs.into_iter()
        .map(|dir| dir.join(&name))
        .find(|p| p.is_file())
}

/// What to do once the upload is processed.
pub(crate) struct Plan<'a> {
    pub app_id: &'a str,
    pub store: &'a StoreConfig,
    pub beta_groups: Vec<String>,
    /// Stop after TestFlight: no App Store version, listing or submission.
    pub testflight_only: bool,
    pub release: ReleaseMode,
    pub submit: bool,
    /// Longest wait for Apple to process the build.
    pub timeout: Duration,
    pub poll: Duration,
    pub sleep: fn(Duration),
}

/// Waits for the uploaded build to be processed and returns it.
pub(crate) fn wait_for_build(asc: &mut Asc, plan: &Plan, ipa: &Ipa) -> anyhow::Result<Value> {
    let path = format!(
        "builds?filter[app]={}&filter[version]={}&filter[preReleaseVersion.version]={}&filter[preReleaseVersion.platform]=IOS&limit=1",
        plan.app_id,
        query_value(&ipa.build),
        query_value(&ipa.version)
    );
    let mut waited = Duration::ZERO;
    loop {
        if let Some(build) = asc.list(&path)?.into_iter().next() {
            match build["attributes"]["processingState"].as_str() {
                Some("VALID") => return Ok(build),
                Some(state @ ("INVALID" | "FAILED")) => bail!(
                    "Apple could not process build {} ({}): {state}; App Store Connect emails the reason",
                    ipa.version,
                    ipa.build
                ),
                _ => {}
            }
        }
        ensure!(
            waited < plan.timeout,
            "build {} ({}) is still processing after {} minutes; run `nsh publish status ios` later",
            ipa.version,
            ipa.build,
            plan.timeout.as_secs() / 60
        );
        (plan.sleep)(plan.poll);
        waited += plan.poll;
    }
}

/// Everything after the upload: compliance, TestFlight groups, then the App
/// Store version with its listing, and the submission when asked for.
pub(crate) fn deliver(asc: &mut Asc, plan: &Plan, ipa: &Ipa) -> anyhow::Result<()> {
    ui::note(format!(
        "waiting for Apple to process build {} ({})",
        ipa.version, ipa.build
    ));
    let build = wait_for_build(asc, plan, ipa)?;
    let build_id = id_of(&build)?.to_owned();
    if build["attributes"]["usesNonExemptEncryption"].is_null() {
        match plan.store.ios.uses_non_exempt_encryption {
            Some(uses) => {
                asc.call(
                    "PATCH",
                    &format!("builds/{build_id}"),
                    Some(json!({"data":{"type":"builds", "id":build_id,
                        "attributes":{"usesNonExemptEncryption":uses}}})),
                )?;
            }
            None => ui::warn(
                "set nsh.json store.ios.usesNonExemptEncryption: Apple holds the build until export compliance is answered",
            ),
        }
    }
    for name in &plan.beta_groups {
        let groups = asc.list(&format!(
            "betaGroups?filter[app]={}&filter[name]={}",
            plan.app_id,
            query_value(name)
        ))?;
        let Some(group) = groups
            .iter()
            .find(|g| g["attributes"]["name"].as_str() == Some(name))
        else {
            bail!("App Store Connect has no TestFlight group `{name}` for this app");
        };
        let group_id = id_of(group)?;
        asc.call(
            "POST",
            &format!("builds/{build_id}/relationships/betaGroups"),
            Some(json!({"data":[{"type":"betaGroups", "id":group_id}]})),
        )?;
        ui::note(format!(
            "build {} is available to TestFlight group {name}",
            ipa.build
        ));
    }
    if plan.testflight_only {
        return Ok(());
    }
    let version_id = prepare_version(asc, plan, &ipa.version, &build_id)?;
    write_listing(asc, plan, &version_id)?;
    if plan.submit {
        submit(asc, plan.app_id, &version_id)?;
        ui::note(format!(
            "version {} is submitted for App Review",
            ipa.version
        ));
    }
    Ok(())
}

/// App Store states in which a version can still be edited.
const EDITABLE: [&str; 6] = [
    "PREPARE_FOR_SUBMISSION",
    "DEVELOPER_REJECTED",
    "REJECTED",
    "METADATA_REJECTED",
    "INVALID_BINARY",
    "READY_FOR_REVIEW",
];

fn version_state(version: &Value) -> &str {
    version["attributes"]["appVersionState"]
        .as_str()
        .or(version["attributes"]["appStoreState"].as_str())
        .unwrap_or("UNKNOWN")
}

/// Creates the App Store version, or reuses the editable one with the same
/// version string; attaches the build and sets the release mode.
fn prepare_version(
    asc: &mut Asc,
    plan: &Plan,
    version: &str,
    build_id: &str,
) -> anyhow::Result<String> {
    let release_type = match plan.release {
        ReleaseMode::Manual => "MANUAL",
        ReleaseMode::Auto | ReleaseMode::Phased => "AFTER_APPROVAL",
    };
    let existing = asc.list(&format!(
        "apps/{}/appStoreVersions?filter[versionString]={}&filter[platform]=IOS",
        plan.app_id,
        query_value(version)
    ))?;
    let id = match existing.first() {
        Some(found) => {
            let state = version_state(found);
            ensure!(
                EDITABLE.contains(&state),
                "App Store version {version} is {state} and can no longer change; raise `version` in nsh.json"
            );
            let id = id_of(found)?.to_owned();
            asc.call(
                "PATCH",
                &format!("appStoreVersions/{id}"),
                Some(json!({"data":{"type":"appStoreVersions", "id":id,
                    "attributes":{"releaseType":release_type}}})),
            )?;
            asc.call(
                "PATCH",
                &format!("appStoreVersions/{id}/relationships/build"),
                Some(link("builds", build_id)),
            )?;
            id
        }
        None => {
            let created = asc.call(
                "POST",
                "appStoreVersions",
                Some(json!({"data":{"type":"appStoreVersions",
                    "attributes":{"platform":"IOS", "versionString":version, "releaseType":release_type},
                    "relationships":{"app":link("apps", plan.app_id), "build":link("builds", build_id)}}})),
            )?;
            resource_id(&created)?.to_owned()
        }
    };
    let phased = asc.get(&format!(
        "appStoreVersions/{id}/appStoreVersionPhasedRelease"
    ));
    let phased_id = phased
        .ok()
        .and_then(|p| id_of(&p["data"]).ok().map(str::to_owned));
    match (plan.release, phased_id) {
        (ReleaseMode::Phased, None) => {
            asc.call(
                "POST",
                "appStoreVersionPhasedReleases",
                Some(json!({"data":{"type":"appStoreVersionPhasedReleases",
                    "attributes":{"phasedReleaseState":"INACTIVE"},
                    "relationships":{"appStoreVersion":link("appStoreVersions", &id)}}})),
            )?;
        }
        (ReleaseMode::Manual | ReleaseMode::Auto, Some(phased)) => {
            asc.call(
                "DELETE",
                &format!("appStoreVersionPhasedReleases/{phased}"),
                None,
            )?;
        }
        _ => {}
    }
    ui::note(format!(
        "App Store version {version} has the build ({release_type})"
    ));
    Ok(id)
}

/// Sets the listing of every locale in the store config.
fn write_listing(asc: &mut Asc, plan: &Plan, version_id: &str) -> anyhow::Result<()> {
    let locales = &plan.store.locales;
    if locales.is_empty() {
        return Ok(());
    }
    let existing = asc.list(&format!(
        "appStoreVersions/{version_id}/appStoreVersionLocalizations"
    ))?;
    let app_info = editable_app_info(asc, plan.app_id)?;
    let info_existing = match &app_info {
        Some(info) => asc.list(&format!("appInfos/{info}/appInfoLocalizations"))?,
        None => Vec::new(),
    };
    for (locale, listing) in locales {
        let mut attributes = serde_json::Map::new();
        for (key, value) in [
            ("description", &listing.description),
            ("keywords", &listing.keywords),
            ("promotionalText", &listing.promotional_text),
            ("whatsNew", &listing.release_notes),
            ("supportUrl", &listing.support_url),
            ("marketingUrl", &listing.marketing_url),
        ] {
            if let Some(value) = value {
                attributes.insert(key.into(), json!(value));
            }
        }
        let localization_id = upsert(
            asc,
            "appStoreVersionLocalizations",
            &existing,
            locale,
            attributes,
            ("appStoreVersion", "appStoreVersions", version_id),
        )?;
        let mut info = serde_json::Map::new();
        for (key, value) in [
            ("name", &listing.name),
            ("subtitle", &listing.subtitle),
            ("privacyPolicyUrl", &listing.privacy_policy_url),
        ] {
            if let Some(value) = value {
                info.insert(key.into(), json!(value));
            }
        }
        if !info.is_empty() {
            let Some(info_id) = &app_info else {
                bail!(
                    "the app has no editable App Store info for name, subtitle or privacy policy URL"
                );
            };
            upsert(
                asc,
                "appInfoLocalizations",
                &info_existing,
                locale,
                info,
                ("appInfo", "appInfos", info_id),
            )?;
        }
        if let Some(localization_id) = localization_id {
            for (class, paths) in &listing.screenshots {
                if let Some(display) = display_type(class) {
                    write_screenshots(asc, &localization_id, display, paths)?;
                }
            }
        }
        ui::note(format!("App Store listing for {locale} is up to date"));
    }
    Ok(())
}

/// The App Store screenshot size a device class maps to; Apple's own names
/// (`APP_IPHONE_67`) are taken as they are.
fn display_type(class: &str) -> Option<&str> {
    match class {
        "phone" => Some("APP_IPHONE_67"),
        "tablet" => Some("APP_IPAD_PRO_3GEN_129"),
        other if other.starts_with("APP_") => Some(other),
        _ => None,
    }
}

/// Updates the localization of `locale` among `existing`, or creates it.
/// Returns its ID, `None` when there was nothing to write and none exists.
fn upsert(
    asc: &mut Asc,
    kind: &str,
    existing: &[Value],
    locale: &str,
    attributes: serde_json::Map<String, Value>,
    (relation, parent_kind, parent): (&str, &str, &str),
) -> anyhow::Result<Option<String>> {
    if let Some(found) = existing
        .iter()
        .find(|l| l["attributes"]["locale"].as_str() == Some(locale))
    {
        let id = id_of(found)?.to_owned();
        if !attributes.is_empty() {
            asc.call(
                "PATCH",
                &format!("{kind}/{id}"),
                Some(json!({"data":{"type":kind, "id":id, "attributes":attributes}})),
            )?;
        }
        return Ok(Some(id));
    }
    let mut attributes = attributes;
    attributes.insert("locale".into(), json!(locale));
    let created = asc.call(
        "POST",
        kind,
        Some(json!({"data":{"type":kind, "attributes":attributes,
            "relationships":{relation:link(parent_kind, parent)}}})),
    )?;
    Ok(Some(resource_id(&created)?.to_owned()))
}

fn editable_app_info(asc: &mut Asc, app_id: &str) -> anyhow::Result<Option<String>> {
    let infos = asc.list(&format!("apps/{app_id}/appInfos"))?;
    let editable = infos.iter().find(|info| {
        let state = info["attributes"]["state"]
            .as_str()
            .or(info["attributes"]["appStoreState"].as_str());
        state.is_some_and(|s| EDITABLE.contains(&s) || s == "PREPARE_FOR_SUBMISSION")
    });
    editable
        .map(|info| id_of(info).map(str::to_owned))
        .transpose()
}

/// Replaces a screenshot set with `paths`, unless it already holds the same
/// images in the same order.
fn write_screenshots(
    asc: &mut Asc,
    localization_id: &str,
    display: &str,
    paths: &[PathBuf],
) -> anyhow::Result<()> {
    let images = paths
        .iter()
        .map(|path| {
            let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .context("screenshot file name must be UTF-8")?
                .to_owned();
            let md5 = format!("{:x}", Md5::digest(&bytes));
            Ok((name, bytes, md5))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let sets = asc.list(&format!(
        "appStoreVersionLocalizations/{localization_id}/appScreenshotSets?filter[screenshotDisplayType]={display}"
    ))?;
    let set_id = match sets.first() {
        Some(set) => id_of(set)?.to_owned(),
        None => {
            let created = asc.call(
                "POST",
                "appScreenshotSets",
                Some(json!({"data":{"type":"appScreenshotSets",
                    "attributes":{"screenshotDisplayType":display},
                    "relationships":{"appStoreVersionLocalization":link("appStoreVersionLocalizations", localization_id)}}})),
            )?;
            resource_id(&created)?.to_owned()
        }
    };
    let current = asc.list(&format!("appScreenshotSets/{set_id}/appScreenshots"))?;
    let same = current.len() == images.len()
        && current.iter().zip(&images).all(|(shot, (_, _, md5))| {
            shot["attributes"]["sourceFileChecksum"].as_str() == Some(md5)
        });
    if same {
        return Ok(());
    }
    for shot in &current {
        asc.call("DELETE", &format!("appScreenshots/{}", id_of(shot)?), None)?;
    }
    for (name, bytes, md5) in images {
        let reserved = asc.call(
            "POST",
            "appScreenshots",
            Some(json!({"data":{"type":"appScreenshots",
                "attributes":{"fileName":name, "fileSize":bytes.len()},
                "relationships":{"appScreenshotSet":link("appScreenshotSets", &set_id)}}})),
        )?;
        let shot_id = resource_id(&reserved)?.to_owned();
        let operations: Vec<UploadOperation> =
            serde_json::from_value(reserved["data"]["attributes"]["uploadOperations"].clone())
                .context("read screenshot upload operations")?;
        validate_operations(&operations, bytes.len() as u64)?;
        let content_type = crate::store::image_kind(Path::new(&name));
        for op in &operations {
            let start = op.offset as usize;
            // Delivery requests never carry the API token.
            let response = asc.transport.send(Request {
                method: "PUT",
                url: op.url.clone(),
                content_type,
                token: None,
                body: bytes[start..start + op.length as usize].to_vec(),
            });
            ensure!(
                response.is_ok_and(|r| (200..300).contains(&r.status)),
                "screenshot {name} transfer failed"
            );
        }
        asc.call(
            "PATCH",
            &format!("appScreenshots/{shot_id}"),
            Some(json!({"data":{"type":"appScreenshots", "id":shot_id,
                "attributes":{"uploaded":true, "sourceFileChecksum":md5}}})),
        )?;
    }
    ui::note(format!("uploaded {} {display} screenshots", paths.len()));
    Ok(())
}

/// Submits the version for App Review, reusing a submission not yet sent.
fn submit(asc: &mut Asc, app_id: &str, version_id: &str) -> anyhow::Result<()> {
    let open = asc.list(&format!(
        "reviewSubmissions?filter[app]={app_id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW"
    ))?;
    let submission = match open.first() {
        Some(found) => id_of(found)?.to_owned(),
        None => {
            let created = asc.call(
                "POST",
                "reviewSubmissions",
                Some(
                    json!({"data":{"type":"reviewSubmissions", "attributes":{"platform":"IOS"},
                    "relationships":{"app":link("apps", app_id)}}}),
                ),
            )?;
            resource_id(&created)?.to_owned()
        }
    };
    asc.call(
        "POST",
        "reviewSubmissionItems",
        Some(json!({"data":{"type":"reviewSubmissionItems",
            "relationships":{"reviewSubmission":link("reviewSubmissions", &submission),
                "appStoreVersion":link("appStoreVersions", version_id)}}})),
    )?;
    asc.call(
        "PATCH",
        &format!("reviewSubmissions/{submission}"),
        Some(json!({"data":{"type":"reviewSubmissions", "id":submission,
            "attributes":{"submitted":true}}})),
    )?;
    Ok(())
}

/// What `nsh publish status ios` reports.
#[derive(Debug, Serialize)]
pub(crate) struct Status {
    pub state: StoreState,
    pub version: Option<String>,
    pub app_store_state: Option<String>,
    pub release_type: Option<String>,
    pub build: Option<String>,
    pub build_state: Option<String>,
}

fn classify(app_store_state: &str) -> StoreState {
    match app_store_state {
        "READY_FOR_SALE"
        | "READY_FOR_DISTRIBUTION"
        | "PENDING_DEVELOPER_RELEASE"
        | "PROCESSING_FOR_DISTRIBUTION"
        | "PROCESSING_FOR_APP_STORE"
        | "ACCEPTED"
        | "REPLACED_WITH_NEW_VERSION" => StoreState::Live,
        "WAITING_FOR_REVIEW"
        | "IN_REVIEW"
        | "WAITING_FOR_EXPORT_COMPLIANCE"
        | "PENDING_APPLE_RELEASE" => StoreState::Pending,
        "PREPARE_FOR_SUBMISSION"
        | "READY_FOR_REVIEW"
        | "DEVELOPER_REMOVED_FROM_SALE"
        | "REMOVED_FROM_SALE" => StoreState::Draft,
        _ => StoreState::ActionNeeded,
    }
}

/// The newest App Store version and build.
pub(crate) fn status(asc: &mut Asc, app_id: &str) -> anyhow::Result<Status> {
    let version = asc
        .list(&format!(
            "apps/{app_id}/appStoreVersions?filter[platform]=IOS&limit=1"
        ))?
        .into_iter()
        .next();
    let build = asc
        .list(&format!(
            "builds?filter[app]={app_id}&sort=-uploadedDate&limit=1"
        ))?
        .into_iter()
        .next();
    let build_state = build.as_ref().and_then(|b| {
        b["attributes"]["processingState"]
            .as_str()
            .map(str::to_owned)
    });
    let app_store_state = version.as_ref().map(|v| version_state(v).to_owned());
    let state = match (&app_store_state, build_state.as_deref()) {
        (_, Some("PROCESSING")) => StoreState::Pending,
        (_, Some("INVALID" | "FAILED")) => StoreState::ActionNeeded,
        (Some(s), _) => classify(s),
        (None, Some(_)) => StoreState::Draft,
        (None, None) => StoreState::ActionNeeded,
    };
    let text = |v: &Option<Value>, key: &str| {
        v.as_ref()
            .and_then(|v| v["attributes"][key].as_str().map(str::to_owned))
    };
    Ok(Status {
        state,
        version: text(&version, "versionString"),
        release_type: text(&version, "releaseType"),
        app_store_state,
        build: text(&build, "version"),
        build_state,
    })
}

/// Upload a packaged iOS app, then take it as far as asked: TestFlight, the
/// App Store version and listing, and App Review with `--submit`.
#[derive(clap::Args, Clone)]
pub(crate) struct Args {
    /// App Store-signed IPA produced by `nsh package --target ios`.
    ipa: PathBuf,
    #[command(flatten)]
    account: Account,
    /// Stop once the upload is accepted, without waiting for processing.
    #[arg(long)]
    no_wait: bool,
    /// Stop after TestFlight: no App Store version, listing or submission.
    #[arg(long, conflicts_with = "submit")]
    testflight_only: bool,
    /// TestFlight group to give the build to (repeatable; default:
    /// `store.ios.betaGroups`).
    #[arg(long = "beta-group")]
    beta_groups: Vec<String>,
    /// How the version goes live once approved (default:
    /// `store.ios.release`, else manual).
    #[arg(long, value_enum)]
    release: Option<ReleaseMode>,
    /// Submit the version for App Review.
    #[arg(long, conflicts_with = "no_wait")]
    submit: bool,
    /// Minutes to wait for Apple to process the build.
    #[arg(long, default_value_t = 60)]
    timeout: u64,
}

/// `nsh publish status ios`.
#[derive(clap::Args, Clone)]
pub(crate) struct StatusArgs {
    #[command(flatten)]
    account: Account,
    /// Print JSON for scripts.
    #[arg(long)]
    json: bool,
}

/// `nsh publish doctor ios`.
#[derive(clap::Args, Clone)]
pub(crate) struct DoctorArgs {
    #[command(flatten)]
    account: Account,
    /// Only check local files; make no request.
    #[arg(long)]
    offline: bool,
}

fn client_agent() -> Http {
    Http::new()
}

/// `nsh publish ios`.
pub(crate) fn publish(args: &Args) -> anyhow::Result<()> {
    ensure!(cfg!(target_os = "macos"), "nsh publish ios runs on macOS");
    let app_id = args.account.app_id()?;
    let credentials = args.account.credentials()?;
    let store = if args.testflight_only && args.beta_groups.is_empty() {
        crate::store::read(&args.account.entry).unwrap_or_default()
    } else {
        crate::store::read(&args.account.entry)?
    };
    let mut file = File::open(&args.ipa).context("open IPA")?;
    let size = file.metadata()?.len();
    let ipa = Ipa::read(&mut file)?;
    if let Ok(config) = crate::package::read_config(&crate::store::app_entry(&args.account.entry))
        && let Some(version) = &config.version
        && version != &ipa.version
    {
        ui::warn(format!(
            "the IPA is version {} but nsh.json says {version}; publishing {}",
            ipa.version, ipa.version
        ));
    }
    let name = args
        .ipa
        .file_name()
        .and_then(|s| s.to_str())
        .context("IPA filename must be UTF-8")?;
    let mut transport = client_agent();
    let mut asc = Asc::new(&mut transport, &credentials);
    let app = asc.get(&format!("apps/{app_id}"))?;
    ensure!(
        app["data"]["attributes"]["bundleId"].as_str() == Some(&ipa.bundle_id),
        "IPA bundle identifier does not match --app-id"
    );
    file.rewind()?;
    // App Store Connect rejects SHA_256 here with HTTP 409 (`sourceFileChecksums` is not valid) and accepts MD5.
    let mut digest = Md5::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    let checksum = format!("{:x}", digest.finalize());
    let upload = asc.call("POST", "buildUploads", Some(ipa.upload_request(&app_id)))?;
    let upload_id = resource_id(&upload)?.to_owned();
    ui::note(format!(
        "App Store Connect upload {upload_id}: {} {} ({})",
        ipa.bundle_id, ipa.version, ipa.build
    ));
    upload_file(&mut asc, &upload_id, name, size, &checksum, &mut file).with_context(|| {
        format!("upload {upload_id} did not finish; check App Store Connect before retrying")
    })?;
    if args.no_wait {
        ui::done(format!(
            "uploaded {} (upload {upload_id}); Apple is processing it: https://appstoreconnect.apple.com/apps/{app_id}/testflight",
            ui::path(&args.ipa),
        ));
        return Ok(());
    }
    let plan = Plan {
        app_id: &app_id,
        store: &store,
        beta_groups: if args.beta_groups.is_empty() {
            store.ios.beta_groups.clone()
        } else {
            args.beta_groups.clone()
        },
        testflight_only: args.testflight_only,
        release: args
            .release
            .or(store.ios.release)
            .unwrap_or(ReleaseMode::Manual),
        submit: args.submit,
        timeout: Duration::from_secs(args.timeout * 60),
        poll: Duration::from_secs(30),
        sleep: std::thread::sleep,
    };
    deliver(&mut asc, &plan, &ipa)?;
    ui::done(format!(
        "{} {} ({}) is {}: https://appstoreconnect.apple.com/apps/{app_id}",
        ipa.bundle_id,
        ipa.version,
        ipa.build,
        if args.submit {
            "in App Review"
        } else if args.testflight_only {
            "on TestFlight"
        } else {
            "ready to submit"
        }
    ));
    Ok(())
}

/// `nsh publish status ios`: exits 0 live, 10 pending, 11 draft, 12 action needed.
pub(crate) fn print_status(args: &StatusArgs) -> anyhow::Result<i32> {
    let app_id = args.account.app_id()?;
    let credentials = args.account.credentials()?;
    let mut transport = client_agent();
    let status = status(&mut Asc::new(&mut transport, &credentials), &app_id)?;
    if args.json {
        println!("{}", serde_json::to_string_pretty(&status)?);
    } else {
        let or = |v: &Option<String>| v.clone().unwrap_or_else(|| "-".into());
        println!("state:   {:?}", status.state);
        println!(
            "version: {} {} ({})",
            or(&status.version),
            or(&status.app_store_state),
            or(&status.release_type)
        );
        println!("build:   {} {}", or(&status.build), or(&status.build_state));
    }
    Ok(status.state.exit_code())
}

/// `nsh publish doctor ios`: read-only checks of credentials and config.
pub(crate) fn doctor(args: &DoctorArgs) -> anyhow::Result<()> {
    let mut check = crate::store::Check::new();
    let account = &args.account;
    check.report("app ID", account.app_id());
    let credentials = account.credentials();
    check.report(
        "API key",
        credentials
            .as_ref()
            .map(|_| "ES256 key reads".into())
            .map_err(|e| anyhow::anyhow!("{e:#}")),
    );
    let config = crate::package::read_config(&crate::store::app_entry(&account.entry));
    check.report(
        "nsh.json",
        config
            .as_ref()
            .map_err(|e| anyhow::anyhow!("{e:#}"))
            .and_then(|c| {
                let id = c.id.clone().context("no `id` (the bundle identifier)")?;
                let version = c.version.clone().context("no `version`")?;
                Ok(format!("{id} {version}"))
            }),
    );
    let store = crate::store::read(&account.entry);
    check.report(
        "store listing",
        store
            .as_ref()
            .map_err(|e| anyhow::anyhow!("{e:#}"))
            .map(|s| {
                let shots: usize = s
                    .locales
                    .values()
                    .flat_map(|l| l.screenshots.iter())
                    .filter(|(class, _)| display_type(class).is_some())
                    .map(|(_, p)| p.len())
                    .sum();
                format!("{} locales, {shots} App Store screenshots", s.locales.len())
            }),
    );
    if let Ok(store) = &store
        && store.ios.uses_non_exempt_encryption.is_none()
    {
        check.report(
            "export compliance",
            Err(anyhow::anyhow!(
                "set store.ios.usesNonExemptEncryption in nsh.json"
            )),
        );
    }
    if !args.offline
        && let (Ok(credentials), Ok(app_id)) = (&credentials, account.app_id())
    {
        let mut transport = client_agent();
        let mut asc = Asc::new(&mut transport, credentials);
        let app = asc.get(&format!("apps/{app_id}"));
        let bundle = app.as_ref().ok().and_then(|a| {
            a["data"]["attributes"]["bundleId"]
                .as_str()
                .map(str::to_owned)
        });
        check.report(
            "App Store Connect access",
            app.map(|_| format!("app {app_id} is {}", bundle.clone().unwrap_or_default())),
        );
        if let (Some(bundle), Ok(Some(id))) = (bundle, config.as_ref().map(|c| c.id.clone())) {
            check.report(
                "bundle identifier",
                if bundle == id {
                    Ok(id)
                } else {
                    Err(anyhow::anyhow!(
                        "nsh.json id {id} is not the app's {bundle}"
                    ))
                },
            );
        }
    }
    check.finish()
}

fn upload_file(
    asc: &mut Asc,
    upload_id: &str,
    name: &str,
    size: u64,
    checksum: &str,
    file: &mut File,
) -> anyhow::Result<()> {
    let reservation = asc.call(
        "POST",
        "buildUploadFiles",
        Some(file_request(upload_id, name, size)),
    )?;
    let file_id = resource_id(&reservation)?.to_owned();
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
    let completed = asc.call(
        "PATCH",
        &format!("buildUploadFiles/{file_id}"),
        Some(complete_request(&file_id, checksum)),
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
    fn app_id_comes_from_the_flag_else_nsh_json() {
        let dir = std::env::temp_dir().join(format!("nsh-asc-app-id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let account = |app_id: Option<&str>| Account {
            app_id: app_id.map(str::to_owned),
            issuer_id: None,
            key_id: None,
            private_key: None,
            entry: dir.clone(),
        };
        std::fs::write(dir.join("nsh.json"), r#"{"id":"com.example.app"}"#).unwrap();
        assert!(account(None).app_id().is_err());
        std::fs::write(
            dir.join("nsh.json"),
            r#"{"id":"com.example.app","store":{"ios":{"appId":"6835723652"}}}"#,
        )
        .unwrap();
        assert_eq!(account(None).app_id().unwrap(), "6835723652");
        assert_eq!(account(Some("42")).app_id().unwrap(), "42");
        assert!(account(Some("com.example.app")).app_id().is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    use crate::play::Response;

    /// Answers each request with the next canned response and records it.
    struct Fake {
        responses: Vec<(u16, Value)>,
        requests: Vec<Request>,
    }

    impl Transport for Fake {
        fn send(&mut self, request: Request) -> anyhow::Result<Response> {
            let (status, body) = if self.responses.is_empty() {
                (599, json!({}))
            } else {
                self.responses.remove(0)
            };
            self.requests.push(request);
            Ok(Response {
                status,
                body: body.to_string().into_bytes(),
            })
        }
    }

    impl Fake {
        fn new(responses: Vec<(u16, Value)>) -> Self {
            Self {
                responses,
                requests: Vec::new(),
            }
        }

        /// `METHOD path` of each request, without the API prefix.
        fn calls(&self) -> Vec<String> {
            self.requests
                .iter()
                .map(|r| {
                    format!(
                        "{} {}",
                        r.method,
                        r.url.trim_start_matches(&format!("{API}/"))
                    )
                })
                .collect()
        }

        fn body(&self, index: usize) -> Value {
            serde_json::from_slice(&self.requests[index].body).unwrap()
        }
    }

    fn credentials() -> Credentials {
        let der =
            EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new())
                .unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(der.as_ref())
        );
        Credentials::from_pem("issuer".into(), "KEY123".into(), &pem).unwrap()
    }

    fn ipa() -> Ipa {
        Ipa {
            bundle_id: "com.example.app".into(),
            version: "1.2.0".into(),
            build: "42".into(),
        }
    }

    fn plan<'a>(store: &'a StoreConfig) -> Plan<'a> {
        Plan {
            app_id: "123",
            store,
            beta_groups: vec!["QA".into()],
            testflight_only: false,
            release: ReleaseMode::Phased,
            submit: true,
            timeout: Duration::from_secs(120),
            poll: Duration::from_secs(30),
            sleep: |_| {},
        }
    }

    fn data(value: Value) -> (u16, Value) {
        (200, json!({ "data": value }))
    }

    #[test]
    fn delivers_a_processed_build_to_testflight_the_app_store_and_review() {
        let dir = std::env::temp_dir().join(format!("nsh-asc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shot = dir.join("01.png");
        std::fs::write(&shot, b"PNGDATA").unwrap();
        let mut store = StoreConfig::default();
        store.ios.uses_non_exempt_encryption = Some(false);
        let listing = store.locales.entry("en-US".into()).or_default();
        listing.release_notes = Some("Faster".into());
        listing.name = Some("Example".into());
        listing
            .screenshots
            .insert("phone".into(), vec![shot.clone()]);
        listing.screenshots.insert("desktop".into(), vec![shot]);
        let md5 = format!("{:x}", Md5::digest(b"PNGDATA"));
        let mut fake = Fake::new(vec![
            data(json!([])), // not yet listed
            data(json!([{"id":"b1", "attributes":{"processingState":"PROCESSING"}}])),
            data(
                json!([{"id":"b1", "attributes":{"processingState":"VALID", "usesNonExemptEncryption":null}}]),
            ),
            data(json!({"id":"b1"})), // encryption
            data(json!([{"id":"g1", "attributes":{"name":"QA"}}])),
            (204, Value::Null),                              // beta group
            data(json!([])),                                 // no version yet
            data(json!({"id":"v1"})),                        // created
            (404, json!({"errors":[{"code":"NOT_FOUND"}]})), // no phased release
            data(json!({"id":"p1"})),                        // phased created
            data(json!([])),                                 // version localizations
            data(json!([{"id":"i1", "attributes":{"state":"PREPARE_FOR_SUBMISSION"}}])),
            data(json!([{"id":"il1", "attributes":{"locale":"en-US"}}])),
            data(json!({"id":"l1"})),  // localization created
            data(json!({"id":"il1"})), // app info localization
            data(json!([])),           // screenshot sets
            data(json!({"id":"s1"})),  // set created
            data(json!([{"id":"old", "attributes":{"sourceFileChecksum":"stale"}}])),
            (204, Value::Null), // old deleted
            data(json!({"id":"sh1", "attributes":{"uploadOperations":[
                {"method":"PUT", "url":"https://delivery.apple.com/s?sig=1", "offset":0, "length":7}
            ]}})),
            (200, Value::Null),        // delivery
            data(json!({"id":"sh1"})), // committed
            data(json!([])),           // no open submission
            data(json!({"id":"r1"})),
            data(json!({"id":"ri1"})),
            data(json!({"id":"r1"})),
        ]);
        let credentials = credentials();
        let mut asc = Asc {
            transport: &mut fake,
            credentials: &credentials,
            clock: || 1_700_000_000,
        };
        deliver(&mut asc, &plan(&store), &ipa()).unwrap();
        assert!(fake.responses.is_empty());
        let calls = fake.calls();
        assert_eq!(
            calls,
            [
                "GET builds?filter[app]=123&filter[version]=42&filter[preReleaseVersion.version]=1.2.0&filter[preReleaseVersion.platform]=IOS&limit=1",
                "GET builds?filter[app]=123&filter[version]=42&filter[preReleaseVersion.version]=1.2.0&filter[preReleaseVersion.platform]=IOS&limit=1",
                "GET builds?filter[app]=123&filter[version]=42&filter[preReleaseVersion.version]=1.2.0&filter[preReleaseVersion.platform]=IOS&limit=1",
                "PATCH builds/b1",
                "GET betaGroups?filter[app]=123&filter[name]=QA",
                "POST builds/b1/relationships/betaGroups",
                "GET apps/123/appStoreVersions?filter[versionString]=1.2.0&filter[platform]=IOS",
                "POST appStoreVersions",
                "GET appStoreVersions/v1/appStoreVersionPhasedRelease",
                "POST appStoreVersionPhasedReleases",
                "GET appStoreVersions/v1/appStoreVersionLocalizations",
                "GET apps/123/appInfos",
                "GET appInfos/i1/appInfoLocalizations",
                "POST appStoreVersionLocalizations",
                "PATCH appInfoLocalizations/il1",
                "GET appStoreVersionLocalizations/l1/appScreenshotSets?filter[screenshotDisplayType]=APP_IPHONE_67",
                "POST appScreenshotSets",
                "GET appScreenshotSets/s1/appScreenshots",
                "DELETE appScreenshots/old",
                "POST appScreenshots",
                "PUT https://delivery.apple.com/s?sig=1",
                "PATCH appScreenshots/sh1",
                "GET reviewSubmissions?filter[app]=123&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW",
                "POST reviewSubmissions",
                "POST reviewSubmissionItems",
                "PATCH reviewSubmissions/r1",
            ]
        );
        assert_eq!(
            fake.body(3)["data"]["attributes"],
            json!({"usesNonExemptEncryption":false})
        );
        assert_eq!(
            fake.body(5),
            json!({"data":[{"type":"betaGroups", "id":"g1"}]})
        );
        assert_eq!(
            fake.body(7)["data"],
            json!({"type":"appStoreVersions",
                "attributes":{"platform":"IOS", "versionString":"1.2.0", "releaseType":"AFTER_APPROVAL"},
                "relationships":{"app":{"data":{"type":"apps", "id":"123"}}, "build":{"data":{"type":"builds", "id":"b1"}}}})
        );
        assert_eq!(
            fake.body(13)["data"]["attributes"],
            json!({"whatsNew":"Faster", "locale":"en-US"})
        );
        assert_eq!(
            fake.body(14)["data"]["attributes"],
            json!({"name":"Example"})
        );
        assert_eq!(
            fake.body(16)["data"]["attributes"],
            json!({"screenshotDisplayType":"APP_IPHONE_67"})
        );
        let delivery = &fake.requests[20];
        assert_eq!(
            delivery.token, None,
            "delivery URLs never get the API token"
        );
        assert_eq!(delivery.content_type, Some("image/png"));
        assert_eq!(delivery.body, b"PNGDATA");
        assert_eq!(
            fake.body(21)["data"]["attributes"],
            json!({"uploaded":true, "sourceFileChecksum":md5})
        );
        assert_eq!(
            fake.body(25)["data"]["attributes"],
            json!({"submitted":true})
        );
        assert!(
            fake.requests
                .iter()
                .filter(|r| r.url.starts_with(API))
                .all(|r| r.token.is_some())
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn without_submit_nothing_goes_to_review_and_same_screenshots_are_kept() {
        let dir = std::env::temp_dir().join(format!("nsh-asc-keep-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let shot = dir.join("01.png");
        std::fs::write(&shot, b"SAME").unwrap();
        let mut store = StoreConfig::default();
        store
            .locales
            .entry("en-US".into())
            .or_default()
            .screenshots
            .insert("phone".into(), vec![shot]);
        let md5 = format!("{:x}", Md5::digest(b"SAME"));
        let mut fake = Fake::new(vec![
            data(
                json!([{"id":"b1", "attributes":{"processingState":"VALID", "usesNonExemptEncryption":true}}]),
            ),
            data(json!([{"id":"v1", "attributes":{"appVersionState":"PREPARE_FOR_SUBMISSION"}}])),
            data(json!({"id":"v1"})),
            (204, Value::Null),
            data(json!({"id":"p1"})), // a phased release left from before
            (204, Value::Null),       // deleted: release is manual
            data(json!([{"id":"l1", "attributes":{"locale":"en-US"}}])),
            data(json!([])), // no editable app info
            data(json!([{"id":"s1"}])),
            data(json!([{"id":"sh1", "attributes":{"sourceFileChecksum":md5}}])),
        ]);
        let credentials = credentials();
        let mut asc = Asc {
            transport: &mut fake,
            credentials: &credentials,
            clock: || 1_700_000_000,
        };
        let mut plan = plan(&store);
        plan.beta_groups.clear();
        plan.submit = false;
        plan.release = ReleaseMode::Manual;
        deliver(&mut asc, &plan, &ipa()).unwrap();
        let calls = fake.calls();
        assert_eq!(calls[2], "PATCH appStoreVersions/v1");
        assert_eq!(
            fake.body(2)["data"]["attributes"],
            json!({"releaseType":"MANUAL"})
        );
        assert_eq!(calls[3], "PATCH appStoreVersions/v1/relationships/build");
        assert_eq!(calls[5], "DELETE appStoreVersionPhasedReleases/p1");
        assert_eq!(calls.len(), 10, "{calls:#?}");
        assert!(
            !calls
                .iter()
                .any(|c| c.contains("review") || c.starts_with("POST appScreenshots"))
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_version_past_review_is_not_changed_and_invalid_builds_stop() {
        let store = StoreConfig::default();
        let mut plan = plan(&store);
        plan.beta_groups.clear();
        let credentials = credentials();
        let mut fake = Fake::new(vec![
            data(
                json!([{"id":"b1", "attributes":{"processingState":"VALID", "usesNonExemptEncryption":false}}]),
            ),
            data(json!([{"id":"v1", "attributes":{"appVersionState":"READY_FOR_SALE"}}])),
        ]);
        let mut asc = Asc {
            transport: &mut fake,
            credentials: &credentials,
            clock: || 0,
        };
        let error = deliver(&mut asc, &plan, &ipa()).unwrap_err().to_string();
        assert!(error.contains("READY_FOR_SALE"), "{error}");
        assert_eq!(fake.requests.len(), 2);

        let mut fake = Fake::new(vec![data(
            json!([{"id":"b1", "attributes":{"processingState":"INVALID"}}]),
        )]);
        let mut asc = Asc {
            transport: &mut fake,
            credentials: &credentials,
            clock: || 0,
        };
        assert!(
            deliver(&mut asc, &plan, &ipa())
                .unwrap_err()
                .to_string()
                .contains("INVALID")
        );

        plan.timeout = Duration::from_secs(60);
        let mut fake = Fake::new(vec![data(json!([])), data(json!([])), data(json!([]))]);
        let mut asc = Asc {
            transport: &mut fake,
            credentials: &credentials,
            clock: || 0,
        };
        assert!(
            deliver(&mut asc, &plan, &ipa())
                .unwrap_err()
                .to_string()
                .contains("still processing")
        );
        assert_eq!(fake.requests.len(), 3);
    }

    #[test]
    fn status_maps_store_states_to_exit_codes() {
        let credentials = credentials();
        for (version_state, build_state, expected) in [
            ("READY_FOR_SALE", "VALID", StoreState::Live),
            ("PENDING_DEVELOPER_RELEASE", "VALID", StoreState::Live),
            ("WAITING_FOR_REVIEW", "VALID", StoreState::Pending),
            ("READY_FOR_SALE", "PROCESSING", StoreState::Pending),
            ("PREPARE_FOR_SUBMISSION", "VALID", StoreState::Draft),
            ("REJECTED", "VALID", StoreState::ActionNeeded),
            (
                "PREPARE_FOR_SUBMISSION",
                "INVALID",
                StoreState::ActionNeeded,
            ),
        ] {
            let mut fake = Fake::new(vec![
                data(
                    json!([{"id":"v1", "attributes":{"versionString":"1.2.0", "appVersionState":version_state, "releaseType":"MANUAL"}}]),
                ),
                data(
                    json!([{"id":"b1", "attributes":{"version":"42", "processingState":build_state}}]),
                ),
            ]);
            let mut asc = Asc {
                transport: &mut fake,
                credentials: &credentials,
                clock: || 0,
            };
            let status = status(&mut asc, "123").unwrap();
            assert_eq!(status.state, expected, "{version_state} {build_state}");
            assert_eq!(status.version.as_deref(), Some("1.2.0"));
            assert_eq!(status.build.as_deref(), Some("42"));
        }
        assert_eq!(
            [
                StoreState::Live,
                StoreState::Pending,
                StoreState::Draft,
                StoreState::ActionNeeded
            ]
            .map(StoreState::exit_code),
            [0, 10, 11, 12]
        );
    }

    #[test]
    fn errors_name_the_call_and_apples_reason_without_the_query() {
        let credentials = credentials();
        let mut fake = Fake::new(vec![(
            409,
            json!({"errors":[{"code":"ENTITY_ERROR", "detail":"whatsNew is not allowed"}]}),
        )]);
        let mut asc = Asc {
            transport: &mut fake,
            credentials: &credentials,
            clock: || 0,
        };
        let error = asc.get("apps/1?filter[x]=secret").unwrap_err().to_string();
        assert!(
            error.contains("GET apps/1 HTTP 409: ENTITY_ERROR: whatsNew is not allowed"),
            "{error}"
        );
        assert!(!error.contains("secret"));
    }

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
    fn requests_link_the_app_upload_and_ipa_and_commit_md5() {
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
                "type":"buildUploadFiles", "id":"file-1", "attributes":{"uploaded":true,"sourceFileChecksums":{"file":{"algorithm":"MD5","hash":"abcd"}}}
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
