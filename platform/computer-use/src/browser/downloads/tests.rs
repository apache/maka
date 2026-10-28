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

use super::*;
use cua_driver_core::browser::cdp_ws::CdpEvent;

fn response(mime: &str, disposition: Option<&str>) -> CdpEvent {
    let mut headers = vec![
        json!({"name":"Content-Type","value":mime}),
        json!({"name":"X-Fixture","value":"kept"}),
    ];
    if let Some(disposition) = disposition {
        headers.push(json!({"name":"Content-Disposition","value":disposition}));
    }
    CdpEvent {
        method: "Fetch.requestPaused".into(),
        session_id: None,
        source_target_id: None,
        params: json!({
            "requestId":"actual-fetch-id","resourceType":"Document","request":{"url":"https://fixture.test/file"},
            "responseStatusCode":200,"responseStatusText":"OK","responseHeaders":headers,
        }),
    }
}

#[test]
fn document_interception_ignores_child_sessions_and_request_stage_events() {
    let mut event = response(
        "application/octet-stream",
        Some("attachment; filename=fixture.bin"),
    );
    assert!(matches!(
        response::classify(&event, false).unwrap(),
        Some(response::Disposition::Download(_))
    ));
    event.session_id = Some("actual-child-session".into());
    assert!(response::classify(&event, true).unwrap().is_none());
    event.session_id = None;
    event
        .params
        .as_object_mut()
        .unwrap()
        .remove("responseStatusCode");
    assert!(response::classify(&event, true).unwrap().is_none());
    event.params["responseErrorReason"] = json!("net::ERR_ABORTED");
    assert!(
        matches!(response::classify(&event, true).unwrap(), Some(response::Disposition::ContinueRequest(id)) if id == "actual-fetch-id")
    );
}

#[test]
fn inline_pdf_is_eligible_only_when_armed_and_rewrites_only_disposition() {
    let event = response(
        "Application/PDF; charset=binary",
        Some("inline; filename=fixture.pdf"),
    );
    assert!(matches!(
        response::classify(&event, false).unwrap(),
        Some(response::Disposition::ContinueResponse(_))
    ));
    let Some(response::Disposition::Download(download)) = response::classify(&event, true).unwrap()
    else {
        panic!("armed PDF must pause for approval");
    };
    assert_eq!(download.id, "actual-fetch-id");
    let overrides = download.overrides.unwrap();
    assert_eq!(overrides["responseCode"], 200);
    assert_eq!(overrides["responsePhrase"], "OK");
    assert_eq!(
        overrides["responseHeaders"],
        json!([
            {"name":"Content-Type","value":"Application/PDF; charset=binary"},
            {"name":"X-Fixture","value":"kept"},
            {"name":"Content-Disposition","value":"attachment; filename=fixture.pdf"},
        ])
    );
}

#[test]
fn unarmed_binary_is_still_detected_for_blocking_but_html_and_redirects_pass() {
    assert!(matches!(
        response::classify(&response("application/octet-stream", None), false).unwrap(),
        Some(response::Disposition::Download(_))
    ));
    assert!(matches!(
        response::classify(&response("text/html", None), true).unwrap(),
        Some(response::Disposition::ContinueResponse(_))
    ));
    let mut redirect = response("application/octet-stream", Some("attachment"));
    redirect.params["responseStatusCode"] = json!(302);
    redirect.params["responseHeaders"]
        .as_array_mut()
        .unwrap()
        .push(json!({"name":"Location","value":"/next"}));
    assert!(matches!(
        response::classify(&redirect, true).unwrap(),
        Some(response::Disposition::ContinueResponse(_))
    ));
}

#[test]
fn attachment_header_is_anchored_and_preserves_extension_header_bytes() {
    for value in [
        "attachment",
        "ATTACHMENT ; filename=x",
        "attachment\t; filename=x",
    ] {
        let Some(response::Disposition::Download(download)) =
            response::classify(&response("text/html", Some(value)), false).unwrap()
        else {
            panic!("attachment {value:?} must pause");
        };
        assert!(
            download.overrides.is_none(),
            "existing attachment header must remain verbatim"
        );
    }
    for value in [" attachment", "attachmentish", "inline; attachment"] {
        assert!(
            matches!(
                response::classify(&response("text/html", Some(value)), false).unwrap(),
                Some(response::Disposition::ContinueResponse(_))
            ),
            "{value:?}"
        );
    }
}

#[test]
fn wait_and_locator_budgets_preserve_the_selected_service_clamps() {
    for (value, expected) in [
        (None, 3000),
        (Some(json!("ignored")), 3000),
        (Some(json!(-1)), 0),
        (Some(json!(0)), 0),
        (Some(json!(10000)), 10000),
        (Some(json!(999999)), 120000),
    ] {
        let options = BrowserDownloadOptions { timeout_ms: value };
        assert_eq!(timeout(&options), Duration::from_millis(expected));
        assert_eq!(
            locator_timeout(&options),
            Duration::from_millis(expected.min(3000))
        );
    }
}
