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

use base64::{Engine, engine::general_purpose::STANDARD};
use image::{ExtendedColorType, ImageFormat, ImageReader, codecs::jpeg::JpegEncoder};
use maka_agent_facts::tools::ToolError;
use std::io::Cursor;

// Linux native screenshots use quality 80 without chroma subsampling.
const JPEG_QUALITY: u8 = 80;

pub(crate) async fn jpeg(png: String) -> Result<String, ToolError> {
    tokio::task::spawn_blocking(move || {
        let png = STANDARD.decode(png).map_err(encoding_error)?;
        let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
        reader.no_limits();
        let rgb = reader.decode().map_err(encoding_error)?.into_rgb8();
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, JPEG_QUALITY)
            .encode(
                rgb.as_raw(),
                rgb.width(),
                rgb.height(),
                ExtendedColorType::Rgb8,
            )
            .map_err(encoding_error)?;
        Ok(STANDARD.encode(jpeg))
    })
    .await
    .map_err(encoding_error)?
}

fn encoding_error(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(format!("screenshot JPEG encoding failed: {error}"))
}
