/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Error;
use maka_agent_ports::provider::authentication::Authenticate;
use maka_agent_ports::provider::authentication::Credential;
use maka_capabilities::http::Method;
use maka_capabilities::http::Request;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::json;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_util::sync::CancellationToken;

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";

#[derive(Serialize, Deserialize)]
pub(super) struct Tokens {
    pub access_token: String,
    refresh_token: String,
    expires_at: u64,
    id_token: Option<String>,
}
impl Tokens {
    pub fn read(credential: &Credential) -> Result<Self, Error> {
        credential.validate().map_err(Error::Invalid)?;
        let tokens: Self =
            serde_json::from_str(&credential.secret).map_err(|_| Error::AuthenticationRequired)?;
        tokens.validate()?;
        Ok(tokens)
    }
    fn validate(&self) -> Result<(), Error> {
        let tokens = self;
        if tokens.access_token.is_empty()
            || tokens.refresh_token.is_empty()
            || tokens.access_token.chars().any(char::is_control)
            || tokens.refresh_token.chars().any(char::is_control)
            || tokens.expires_at > 9_007_199_254_740_991
        {
            return Err(Error::AuthenticationRequired);
        }
        Ok(())
    }
    fn credential(self) -> Result<Credential, Error> {
        self.validate()?;
        let refresh_at = Some(self.expires_at.saturating_sub(300_000));
        let secret = serde_json::to_string(&self)
            .map_err(|_| Error::Invalid("invalid credential".into()))?;
        let credential = Credential { secret, refresh_at };
        credential.validate().map_err(Error::Invalid)?;
        Ok(credential)
    }
}

#[derive(Deserialize)]
struct Grant {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    id_token: Option<String>,
}
impl Grant {
    fn tokens(self, previous: Option<Tokens>) -> Result<Credential, Error> {
        let expires_at = now()?
            .checked_add(self.expires_in.checked_mul(1000).ok_or_else(invalid)?)
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(invalid)?;
        if self.expires_in == 0 || self.access_token.is_empty() {
            return Err(invalid());
        }
        let refresh_token = self
            .refresh_token
            .filter(|v| !v.is_empty())
            .or_else(|| previous.as_ref().map(|v| v.refresh_token.clone()))
            .ok_or_else(invalid)?;
        Tokens {
            access_token: self.access_token,
            refresh_token,
            expires_at,
            id_token: self.id_token.or_else(|| previous.and_then(|v| v.id_token)),
        }
        .credential()
    }
}

#[derive(Deserialize)]
struct Device {
    device_auth_id: String,
    #[serde(alias = "usercode")]
    user_code: String,
    interval: Interval,
    expires_at: Option<String>,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Interval {
    Number(u64),
    Text(String),
}
impl Interval {
    fn duration(self) -> Result<Duration, Error> {
        let value = match self {
            Self::Number(v) => v,
            Self::Text(v) => v.trim().parse().map_err(|_| invalid())?,
        };
        if value == 0 || value > 9_007_199_254_740 {
            return Err(invalid());
        }
        Ok(Duration::from_secs(value))
    }
}
#[derive(Deserialize)]
struct Exchange {
    authorization_code: String,
    code_verifier: String,
}

pub(super) async fn authenticate(
    request: Authenticate,
    context: Context,
) -> Result<Credential, Error> {
    if request.method != "chatgpt" {
        return Err(Error::Invalid("unknown authentication method".into()));
    }
    super::configuration(&request.connection)?;
    let interaction = context.interaction.as_ref().ok_or(Error::Unavailable)?;
    if context.cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    // Obtaining a device code cannot spend a login grant. Cancel this wait
    // promptly; only the later poll/exchange must retain a possibly spent grant.
    let device: Device = tokio::select! {
        _ = context.cancellation.cancelled() => return Err(Error::Cancelled),
        response = post_json(
            &context,
            "https://auth.openai.com/api/accounts/deviceauth/usercode",
            json!({"client_id": CLIENT_ID}),
            context.cancellation.clone(),
        ) => response.map_err(|error| match error {
            Error::OutcomeUnknown => Error::Transport("device authorization service unavailable".into()),
            other => other,
        })?.decode()?,
    };
    if device.device_auth_id.is_empty() || device.user_code.is_empty() {
        return Err(invalid());
    }
    let expires_at = device
        .expires_at
        .as_deref()
        .and_then(|v| v.parse::<jiff::Timestamp>().ok())
        .and_then(|v| u64::try_from(v.as_millisecond()).ok())
        .filter(|v| *v > now().unwrap_or(u64::MAX))
        .unwrap_or(now()? + 15 * 60 * 1000);
    let interval = device.interval.duration()?;
    interaction
        .open_external(
            "https://auth.openai.com/codex/device".into(),
            Some(device.user_code.clone()),
        )
        .await?;
    loop {
        if context.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let remaining = expires_at
            .checked_sub(now()?)
            .filter(|v| *v > 0)
            .ok_or(Error::AuthenticationRequired)?;
        // Once this request starts, cancellation cannot throw away a consumed
        // grant. The embedding Host owns the callback until it settles. This
        // token belongs to that settlement, not the cancelled UI wait.
        let grant_settlement = CancellationToken::new();
        let response = post_json(
            &context,
            "https://auth.openai.com/api/accounts/deviceauth/token",
            json!({"device_auth_id": device.device_auth_id, "user_code": device.user_code}),
            grant_settlement.clone(),
        )
        .await?;
        if (200..300).contains(&response.status) {
            let exchange: Exchange = response.decode()?;
            if exchange.authorization_code.is_empty() || exchange.code_verifier.is_empty() {
                return Err(invalid());
            }
            return post_form(
                &context,
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", CLIENT_ID),
                    ("code", &exchange.authorization_code),
                    ("code_verifier", &exchange.code_verifier),
                    (
                        "redirect_uri",
                        "https://auth.openai.com/deviceauth/callback",
                    ),
                ],
                grant_settlement,
            )
            .await?
            .decode::<Grant>()?
            .tokens(None);
        }
        if response.unsupported_region() || !matches!(response.status, 403 | 404) {
            return Err(response.error());
        }
        tokio::select! {
            _ = context.cancellation.cancelled() => return Err(Error::Cancelled),
            _ = tokio::time::sleep(interval.min(Duration::from_millis(remaining))) => {},
        }
    }
}

pub(super) async fn refresh(credential: Credential, context: Context) -> Result<Credential, Error> {
    let previous = Tokens::read(&credential)?;
    if context.cancellation.is_cancelled() {
        return Err(Error::Cancelled);
    }
    // Refresh can consume the old grant. Its owned settlement must finish even
    // when the caller stops waiting, just like the authorization-code exchange.
    let grant_settlement = CancellationToken::new();
    post_form(
        &context,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", &previous.refresh_token),
        ],
        grant_settlement,
    )
    .await?
    .decode::<Grant>()?
    .tokens(Some(previous))
}

struct Response {
    status: u16,
    bytes: Vec<u8>,
}
impl Response {
    fn decode<T: DeserializeOwned>(self) -> Result<T, Error> {
        if !(200..300).contains(&self.status) {
            return Err(self.error());
        }
        serde_json::from_slice(&self.bytes).map_err(|_| invalid())
    }

    fn error(&self) -> Error {
        // Classify known codes, never expose an arbitrary response body: it
        // can contain credentials, authorization codes, or terminal escapes.
        let reason = if self.unsupported_region() {
            "Country, region, or territory not supported (unsupported_country_region_territory). Check your network route."
        } else {
            match self.status {
                401 => "Authorization was rejected or expired. Start a new sign-in.",
                403 => "Access was denied. Check your ChatGPT account and network route.",
                429 => "Too many requests. Wait before trying again.",
                500..=599 => "The sign-in service is unavailable. Try again later.",
                _ => "The sign-in service rejected the request.",
            }
        };
        Error::Rejected(format!(
            "ChatGPT sign-in failed (HTTP {}): {reason}",
            self.status
        ))
    }

    fn unsupported_region(&self) -> bool {
        serde_json::from_slice::<serde_json::Value>(&self.bytes)
            .ok()
            .is_some_and(|body| body["error"]["code"] == "unsupported_country_region_territory")
    }
}
async fn post_json(
    context: &Context,
    url: &str,
    value: serde_json::Value,
    cancellation: CancellationToken,
) -> Result<Response, Error> {
    send(
        context,
        Request {
            url: url.into(),
            method: Method::Post,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(&value).map_err(|_| invalid())?.into(),
        },
        cancellation,
    )
    .await
}
async fn post_form(
    context: &Context,
    form: &[(&str, &str)],
    cancellation: CancellationToken,
) -> Result<Response, Error> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(form.iter().copied())
        .finish();
    send(
        context,
        Request {
            url: TOKEN_URL.into(),
            method: Method::Post,
            headers: vec![
                (
                    "content-type".into(),
                    "application/x-www-form-urlencoded".into(),
                ),
                ("accept".into(), "application/json".into()),
                (
                    "user-agent".into(),
                    "maka-desktop/0.1.0 (oauth-subscription)".into(),
                ),
            ],
            body: body.into_bytes().into(),
        },
        cancellation,
    )
    .await
}
async fn send(
    context: &Context,
    request: Request,
    cancellation: CancellationToken,
) -> Result<Response, Error> {
    let response = context
        .transport
        .request(request, cancellation)
        .await
        .map_err(|_| Error::OutcomeUnknown)?;
    let result = async {
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .body
            .next()
            .await
            .map_err(|_| Error::OutcomeUnknown)?
        {
            bytes.extend_from_slice(&chunk);
        }
        Ok(Response {
            status: response.head.status,
            bytes,
        })
    }
    .await;
    response.body.cancel();
    response
        .body
        .close()
        .await
        .map_err(|_| Error::OutcomeUnknown)?;
    result
}
fn now() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|v| u64::try_from(v.as_millis()).ok())
        .filter(|v| *v <= 9_007_199_254_740_991)
        .ok_or_else(invalid)
}
fn invalid() -> Error {
    Error::Invalid("invalid subscription response".into())
}
