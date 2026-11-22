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

//! Actual private capture files, owned until this native epoch retires.

use base64::{Engine, engine::general_purpose::STANDARD};
use maka_agent_facts::capability::ContentBlock;
use maka_agent_facts::tools::ToolError;
use serde_json::{Value, json};

#[derive(Default)]
pub(super) struct CaptureFiles {
    directory: Option<tempfile::TempDir>,
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}

impl CaptureFiles {
    pub(super) async fn jpeg(&mut self, image: ContentBlock) -> Result<Value, ToolError> {
        let ContentBlock::Image { data, mime_type } = image else {
            return Err(failed("native capture provider returned no image"));
        };
        let data = match mime_type.as_str() {
            "image/png" => crate::linux_image::jpeg(data).await?,
            "image/jpeg" => data,
            _ => {
                return Err(failed(
                    "native capture provider returned an unsupported image format",
                ));
            }
        };
        if self.directory.is_none() {
            self.directory = Some(
                tokio::task::spawn_blocking(|| {
                    tempfile::Builder::new()
                        .prefix("maka-native-captures-")
                        .tempdir()
                })
                .await
                .map_err(failed)?
                .map_err(failed)?,
            );
        }
        let path = self
            .directory
            .as_ref()
            .expect("owned capture directory")
            .path()
            .join(format!("{}.jpg", uuid::Uuid::new_v4()));
        let bytes = STANDARD.decode(&data).map_err(failed)?;
        let output_path = path.clone();
        tokio::task::spawn_blocking(move || std::fs::write(output_path, bytes))
            .await
            .map_err(failed)?
            .map_err(failed)?;
        Ok(
            json!({"filepath":path.to_string_lossy(),"data_url":format!("data:image/jpeg;base64,{data}")}),
        )
    }
}
