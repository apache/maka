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
use crate::protocol::BrowserScreenshotOptions;
use std::time::{SystemTime, UNIX_EPOCH};

impl Browsers {
    pub(super) async fn screenshot(
        &mut self,
        handle: &str,
        options: BrowserScreenshotOptions,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let identity = self
            .targets
            .get(handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?
            .identity()?;
        self.use_tab(&identity, call.invocation.turn()).await?;
        let tab = self.targets.get_mut(handle).expect("verified tab handle");
        tab.last_turn = call.invocation.turn().to_owned();
        tab.authorize(None, call.invocation, call.cancellation, call.language)
            .await?;
        tab.verify(call).await?;
        tab.wait_ready(call.language).await?;
        let frame = tab.frame().await?;
        let data = tab.screenshot_data(options, call.cancellation).await?;
        check_input(call.cancellation)?;
        tab.authorize(None, call.invocation, call.cancellation, call.language)
            .await?;
        tab.verify(call).await?;
        if tab.frame().await? != frame {
            return Err(failed("document changed during screenshot; observe again"));
        }
        Ok(json!({"data":data}))
    }
}

impl Tab {
    async fn screenshot_css_scale(&self) -> Result<f64, ToolError> {
        let socket = self
            .socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?;
        let reply = socket
            .raw_observation(
                None,
                "Runtime.evaluate",
                json!({
                    "expression":"window.devicePixelRatio", "returnByValue":true,
                }),
            )
            .await;
        match reply {
            Ok(reply) => Ok(reply["result"]["value"]
                .as_f64()
                .filter(|value| value.is_finite() && *value > 0.0)
                .map_or(1.0, |value| 1.0 / value)),
            Err(error) if Cdp::is_pre_dispatch_guard_failure(&error) => Err(Cdp::failure(error)),
            Err(error) => {
                use cua_driver_core::browser::{CdpFailureDisposition, cdp_ws::CdpReplyError};
                // A matched Chrome error makes this fixed scalar unavailable;
                // Host/connector refusal and transport uncertainty stay errors.
                if error.downcast_ref::<CdpReplyError>().is_some_and(|reply| {
                    reply.method() == "Runtime.evaluate"
                        && reply.code().is_some()
                        && reply.disposition() == CdpFailureDisposition::ReplyFailure
                }) {
                    Ok(1.0)
                } else {
                    Err(Cdp::failure(error))
                }
            }
        }
    }

    async fn screenshot_data(
        &mut self,
        options: BrowserScreenshotOptions,
        cancellation: &CancellationToken,
    ) -> Result<String, ToolError> {
        if options
            .clip
            .as_ref()
            .is_some_and(|clip| clip.width <= 0.0 || clip.height <= 0.0)
        {
            return Err(failed(
                "tab_screenshot crop width and height must be positive",
            ));
        }
        let scale = self.screenshot_css_scale().await?;
        let mut params = json!({"format":"jpeg", "quality":80});
        if let Some(clip) = options.clip {
            params["captureBeyondViewport"] = json!(true);
            params["clip"] = json!({
                "x":clip.x, "y":clip.y, "width":clip.width, "height":clip.height, "scale":scale,
            });
        } else if options.full_page == Some(true) {
            let metrics = self.request("Page.getLayoutMetrics", json!({})).await?;
            let size = &metrics["cssContentSize"];
            let width = size["width"].as_f64().filter(|value| *value > 0.0);
            let height = size["height"].as_f64().filter(|value| *value > 0.0);
            let (Some(width), Some(height)) = (width, height) else {
                return Err(failed(
                    "Page.getLayoutMetrics returned no valid cssContentSize for full-page screenshot.",
                ));
            };
            params["captureBeyondViewport"] = json!(true);
            params["clip"] = json!({
                "x":size["x"].as_f64().unwrap_or(0.0), "y":size["y"].as_f64().unwrap_or(0.0),
                "width":width, "height":height, "scale":scale,
            });
        } else {
            let metrics = self.request("Page.getLayoutMetrics", json!({})).await?;
            let viewport = &metrics["cssVisualViewport"];
            let width = viewport["clientWidth"]
                .as_f64()
                .ok_or_else(|| failed("browser screenshot viewport width unavailable"))?;
            let height = viewport["clientHeight"]
                .as_f64()
                .ok_or_else(|| failed("browser screenshot viewport height unavailable"))?;
            if scale <= 1.0
                && width.round() > 0.0
                && height.round() > 0.0
                && let Some(data) = self
                    .viewport_screencast(width.round(), height.round(), cancellation)
                    .await?
            {
                return Ok(data);
            }
            check_input(cancellation)?;
            params["clip"] = json!({
                "x":viewport["pageX"], "y":viewport["pageY"],
                "width":width, "height":height, "scale":scale,
            });
        }
        check_input(cancellation)?;
        let socket = self
            .socket
            .as_ref()
            .ok_or_else(|| failed("tab connection unavailable"))?;
        let effect = self.read_effect()?;
        let mut budget = Some(ReadBudget {
            remaining: Duration::from_secs(5),
        });
        let image = read_step_for(
            &mut budget,
            cancellation,
            effect,
            socket.observe_in(None, "Page.captureScreenshot", params),
        )
        .await?;
        image["data"]
            .as_str()
            .filter(|data| !data.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| failed("Page.captureScreenshot returned no data for tab screenshot."))
    }

    async fn viewport_screencast(
        &self,
        width: f64,
        height: f64,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, ToolError> {
        let (sender, received) = tokio::sync::oneshot::channel();
        self.owned_input(cancellation, None, move |page, sequence, stop| {
            Box::pin(async move {
                let socket = page.socket.as_ref().ok_or_else(|| failed("tab connection unavailable"))?;
                // The exact page/claim connection is subscribed before start;
                // its demultiplexer queues pre-reply events in arrival order.
                let mut events = socket.connection.subscribe();
                let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
                let started_at = SystemTime::now().duration_since(UNIX_EPOCH)
                    .map_err(failed)?.as_millis() as f64 / 1000.0;
                let Some(cast) = sequence.start_screencast(json!({
                    "everyNthFrame":1, "format":"jpeg", "quality":80,
                    "maxWidth":width as u64, "maxHeight":height as u64,
                })).await? else {
                    let _ = sender.send(None);
                    return Ok(());
                };
                loop {
                    let event = tokio::select! { biased;
                        ()=stop.cancelled()=>return Err(failed("Screenshot cancelled; original screencast cleanup remains in custody")),
                        event=tokio::time::timeout_at(deadline, events.recv())=>match event {
                            Ok(Some(event))=>event,
                            Ok(None)|Err(_)=>break,
                        },
                    };
                    // This channel belongs to the admitted page. Flattened
                    // child-session events cannot supply its viewport image.
                    if event.session_id.is_some() || event.source_target_id.is_some() { continue; }
                    if event.method == "Page.screencastVisibilityChanged" && event.params["visible"] == false {
                        break;
                    }
                    if event.method != "Page.screencastFrame" { continue; }
                    let Some(session_id) = event.params["sessionId"].as_number().cloned() else {
                        break;
                    };
                    let frame_ack = sequence.screencast_frame(session_id);
                    let fresh = event.params["metadata"]["timestamp"].as_f64()
                        .is_some_and(|timestamp| timestamp.is_finite() && timestamp >= started_at);
                    if !fresh {
                        sequence.release(frame_ack).await?;
                        continue;
                    }
                    let data = event.params["data"].as_str().filter(|data| !data.is_empty()).map(str::to_owned);
                    // A fresh frame stops the producer before its final ACK.
                    // Both Required awaits use the original admission even if
                    // Stop arrived; a failed stop never suppresses the ACK.
                    let stopped = sequence.release(cast).await;
                    let acknowledged = sequence.release(frame_ack).await;
                    stopped?;
                    acknowledged?;
                    let _ = sender.send(data);
                    return Ok(());
                }
                // The existing custodian performs the registered stop before
                // returning. Only its confirmed terminal permits fallback.
                let _ = sender.send(None);
                Ok(())
            })
        }).await?;
        received
            .await
            .map_err(|_| failed("screencast completed without its observation result"))
    }
}
