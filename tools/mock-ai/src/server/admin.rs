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

use super::{BoxBody, ServerState, full_json};
use crate::pacing::{RuntimeProfile, ScenarioSchedule};
use crate::ratelimit::RateLimitConfig;
#[cfg(feature = "rules")]
use crate::rules::RuleSpec;
use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use serde_json::json;
use std::sync::Arc;

pub(super) async fn handle_admin(
    method: Method,
    path: &str,
    req: Request<Incoming>,
    state: Arc<ServerState>,
) -> Response<BoxBody> {
    match (method, path) {
        (Method::GET, "/admin/health") => full_json(StatusCode::OK, &json!({ "ok": true })),
        (Method::GET, "/admin/metrics") => {
            full_json(StatusCode::OK, &json!(state.metrics.snapshot()))
        }
        (Method::GET, "/admin/requests") => {
            full_json(StatusCode::OK, &json!(state.recorder.snapshot()))
        }
        (Method::POST, "/admin/reset") => {
            state.reset();
            full_json(StatusCode::OK, &json!({ "reset": true }))
        }
        #[cfg(feature = "rules")]
        (Method::GET, "/admin/rules") => {
            let rules = state
                .rule_engine
                .as_ref()
                .map(|e| e.rule_specs())
                .unwrap_or_default();
            full_json(StatusCode::OK, &json!(rules))
        }
        #[cfg(feature = "rules")]
        (Method::PUT, "/admin/rules") => {
            let Some(engine) = &state.rule_engine else {
                return full_json(
                    StatusCode::BAD_REQUEST,
                    &json!({ "error": "server is not configured with a RuleEngine" }),
                );
            };
            let bytes = match Limited::new(req.into_body(), 8 * 1024 * 1024)
                .collect()
                .await
            {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let specs: Vec<RuleSpec> = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid rules JSON: {e}") }),
                    );
                }
            };
            match engine.replace_rules(specs) {
                Ok(()) => full_json(StatusCode::OK, &json!({ "updated": true })),
                Err(e) => full_json(StatusCode::BAD_REQUEST, &json!({ "error": e.to_string() })),
            }
        }
        (Method::GET, "/admin/profile") => {
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::PUT, "/admin/profile") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let profile: RuntimeProfile = match serde_json::from_slice(&bytes) {
                Ok(p) => p,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid profile JSON: {e}") }),
                    );
                }
            };
            state.profile.set_manual_override(Some(profile));
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::DELETE, "/admin/profile") => {
            state.profile.set_manual_override(None);
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::PUT, "/admin/schedule") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let schedule: ScenarioSchedule = match serde_json::from_slice(&bytes) {
                Ok(s) => s,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid schedule JSON: {e}") }),
                    );
                }
            };
            state.profile.set_schedule(schedule);
            full_json(StatusCode::OK, &json!(state.profile.snapshot()))
        }
        (Method::GET, "/admin/ratelimit") => {
            full_json(StatusCode::OK, &json!(state.rate_limiter.config()))
        }
        (Method::PUT, "/admin/ratelimit") => {
            let bytes = match Limited::new(req.into_body(), 1024 * 1024).collect().await {
                Ok(c) => c.to_bytes(),
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("body read failed: {e}") }),
                    );
                }
            };
            let cfg: RateLimitConfig = match serde_json::from_slice(&bytes) {
                Ok(c) => c,
                Err(e) => {
                    return full_json(
                        StatusCode::BAD_REQUEST,
                        &json!({ "error": format!("invalid ratelimit JSON: {e}") }),
                    );
                }
            };
            state.rate_limiter.update_config(cfg);
            full_json(StatusCode::OK, &json!(state.rate_limiter.config()))
        }
        (Method::GET, "/admin/violations") => {
            full_json(StatusCode::OK, &json!(state.watchdog.snapshot()))
        }
        (Method::DELETE, "/admin/violations") => {
            state.watchdog.clear();
            full_json(StatusCode::OK, &json!({ "cleared": true }))
        }
        _ => full_json(
            StatusCode::NOT_FOUND,
            &json!({ "error": format!("unknown admin route: {path}") }),
        ),
    }
}
