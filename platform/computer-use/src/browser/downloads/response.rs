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

//! Browser-owned Document response classification and exact Fetch identity.

use super::*;

#[derive(Clone, Debug)]
pub(super) struct Paused {
    pub id: String,
    pub url: String,
    pub overrides: Option<Value>,
}

pub(super) enum Disposition {
    ContinueRequest(String),
    ContinueResponse(String),
    Download(Paused),
}

fn header<'a>(headers: &'a [Value], name: &str) -> Option<&'a str> {
    headers.iter().find(|entry| {
        entry["name"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(name))
    })?["value"]
        .as_str()
}

fn whitespace(value: char) -> bool {
    matches!(value, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn attachment(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Some(prefix) = value.get(..10) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("attachment") {
        return false;
    }
    let suffix = value[10..].trim_start_matches(whitespace);
    suffix.is_empty() || suffix.starts_with(';')
}

fn media(mime: Option<&str>) -> bool {
    mime.is_some_and(|mime| {
        mime == "application/pdf" || mime.starts_with("image/") || mime.starts_with("video/")
    })
}

pub(super) fn classify(
    event: &cua_driver_core::browser::cdp_ws::CdpEvent,
    enabled: bool,
) -> Result<Option<Disposition>, ToolError> {
    if event.method != "Fetch.requestPaused"
        || event.session_id.is_some()
        || event.params["resourceType"] != "Document"
    {
        return Ok(None);
    }
    let response = &event.params;
    if response["responseStatusCode"].is_null() && response["responseErrorReason"].is_null() {
        return Ok(None);
    }
    let id = response["requestId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| unknown("Document response lost its Fetch request identity"))?
        .to_owned();
    if !response["responseErrorReason"].is_null() {
        return Ok(Some(Disposition::ContinueRequest(id)));
    }
    let headers = match response.get("responseHeaders") {
        Some(Value::Array(headers)) => headers.as_slice(),
        None | Some(Value::Null) => &[],
        Some(_) => return Err(unknown("Document response headers are malformed")),
    };
    let mime = header(headers, "content-type").map(|value| {
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim_matches(whitespace)
            .to_ascii_lowercase()
    });
    let disposition = header(headers, "content-disposition");
    let redirect = matches!(
        response["responseStatusCode"].as_u64(),
        Some(301 | 302 | 303 | 307 | 308)
    ) && header(headers, "location").is_some();
    let ordinary = mime.as_deref() == Some("text/html") || media(mime.as_deref());
    if redirect || !(attachment(disposition) || (enabled && media(mime.as_deref())) || !ordinary) {
        return Ok(Some(Disposition::ContinueResponse(id)));
    }
    let url = response["request"]["url"]
        .as_str()
        .ok_or_else(|| unknown("Download response lost its URL"))?
        .to_owned();
    let overrides = if response["responseStatusCode"].is_number()
        && !headers.is_empty()
        && !attachment(disposition)
        && media(mime.as_deref())
    {
        let mut rewritten = headers.to_vec();
        let mut replaced = false;
        for entry in &mut rewritten {
            if entry["name"]
                .as_str()
                .is_some_and(|name| name.eq_ignore_ascii_case("content-disposition"))
            {
                let value = entry["value"]
                    .as_str()
                    .ok_or_else(|| unknown("Download disposition header is malformed"))?;
                entry["value"] = Value::String(format!(
                    "attachment{}",
                    value
                        .find(';')
                        .map(|index| &value[index..])
                        .unwrap_or_default()
                ));
                replaced = true;
            }
        }
        if !replaced {
            rewritten.push(json!({"name":"Content-Disposition","value":"attachment"}));
        }
        let mut overrides =
            json!({"responseCode":response["responseStatusCode"],"responseHeaders":rewritten});
        if let Some(phrase) = response["responseStatusText"]
            .as_str()
            .filter(|phrase| !phrase.is_empty())
        {
            overrides["responsePhrase"] = Value::String(phrase.to_owned());
        }
        Some(overrides)
    } else {
        None
    };
    Ok(Some(Disposition::Download(Paused { id, url, overrides })))
}
