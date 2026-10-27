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

//! Locator download triggering uses the existing selector and tab command path.

use super::*;

const DOWNLOAD_MEDIA: &str = include_str!("download_media.js");

impl Tab {
    pub(in crate::browser) async fn playwright_download_media(
        &mut self,
        locator: &LocatorPlan,
        options: &BrowserDownloadOptions,
        document: crate::BrowserDocument,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let resources = Resources::new();
        let budget = super::super::downloads::locator_timeout(options);
        let deadline = (!budget.is_zero()).then(|| tokio::time::Instant::now() + budget);
        let operation = async {
            loop {
                check_input(cancellation)?;
                if deadline.is_some_and(|deadline| tokio::time::Instant::now() >= deadline) {
                    return Err(failed("Playwright selector deadline exceeded"));
                }
                let selected = self.playwright_scope(&locator.selector, &resources).await;
                let SelectorScope {
                    frame,
                    used,
                    segment,
                } = match selected {
                    Ok(scope) => scope,
                    Err(AttemptError::Fatal(error)) => return Err(error),
                    Err(AttemptError::Retry(error)) => {
                        if budget.is_zero()
                            || deadline
                                .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
                        {
                            return Err(error);
                        }
                        tokio::select! {
                            biased;
                            ()=cancellation.cancelled()=>return Err(failed("Locator download cancelled before dispatch")),
                            ()=tokio::time::sleep_until((tokio::time::Instant::now()+Duration::from_millis(100)).min(deadline.expect("positive retry budget")))=>{},
                        }
                        continue;
                    }
                };
                self.refresh_info(language).await?;
                if self.document() != document || !self.frame_scopes_current(&used).await? {
                    return Err(failed("document or frame changed before locator download"));
                }
                let engine = self.playwright_engine(&frame, &resources).await?;
                check_input(cancellation)?;
                resources
                    .mutated
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                let reply = self
                    .frame_request(
                        frame.session.as_deref(),
                        "Runtime.callFunctionOn",
                        json!({
                            "objectId":engine,"functionDeclaration":DOWNLOAD_MEDIA,
                            "arguments":[{"value":{"parsedSelector":segment.parsed}}],
                            "returnByValue":true,"awaitPromise":true,"objectGroup":resources.group,
                        }),
                    )
                    .await?;
                let value = cdp_value(reply)?["value"].clone();
                match value["status"].as_str() {
                    Some("value") => return Ok(Value::Null),
                    Some("strict") => {
                        let error = match read_reply(value) {
                            Err(AttemptError::Fatal(error)) => error,
                            _ => {
                                return Err(unknown(
                                    "Locator download returned invalid dispatch metadata",
                                ));
                            }
                        };
                        resources
                            .mutated
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                        return Err(error);
                    }
                    Some("missing") | Some("notReady") => {
                        // Missing selection performed no page operation. A later selector
                        // attempt is safe; a dispatched click is never retried.
                        resources
                            .mutated
                            .store(false, std::sync::atomic::Ordering::Relaxed);
                        if budget.is_zero()
                            || deadline
                                .is_some_and(|deadline| tokio::time::Instant::now() >= deadline)
                        {
                            return Err(failed(
                                value["message"]
                                    .as_str()
                                    .unwrap_or("no element matches the locator"),
                            ));
                        }
                        tokio::select! {
                            biased;
                            ()=cancellation.cancelled()=>return Err(failed("Locator download cancelled before dispatch")),
                            ()=tokio::time::sleep_until((tokio::time::Instant::now()+Duration::from_millis(100)).min(deadline.expect("positive retry budget")))=>{},
                        }
                    }
                    _ => {
                        return Err(unknown(
                            "Locator download returned invalid dispatch metadata",
                        ));
                    }
                }
            }
        };
        let result = operation.await;
        resources.cleanup(self).await;
        result
    }
}
