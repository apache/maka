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

//! Shared admission for actual GPU pixels and fallible image encoders.

use std::io::{self, Write};

use anyhow::{Result, ensure};
use image::{
    ExtendedColorType, ImageEncoder,
    codecs::png::{CompressionType, FilterType, PngEncoder},
};

use crate::CandidateFrame;

pub(crate) fn dimensions(frame: &CandidateFrame) -> Result<(u32, u32)> {
    let bytes = crate::rgba_len(frame.size)?;
    ensure!(
        frame.token.sequence != 0 && frame.pixels.len() == bytes,
        "inert or malformed terminal RGBA frame"
    );
    Ok((
        u32::try_from(frame.size.width.0)?,
        u32::try_from(frame.size.height.0)?,
    ))
}

pub(crate) fn png(frame: &CandidateFrame, width: u32, height: u32) -> Result<Vec<u8>> {
    let mut output = FrameBytes::new();
    PngEncoder::new_with_quality(&mut output, CompressionType::Fast, FilterType::Adaptive)
        .write_image(&frame.pixels, width, height, ExtendedColorType::Rgba8)?;
    Ok(output.into_vec())
}

/// Propagates actual allocation failures through each encoder's writer.
pub(crate) struct FrameBytes {
    bytes: Vec<u8>,
}

impl FrameBytes {
    pub(crate) fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    pub(crate) fn into_vec(self) -> Vec<u8> {
        self.bytes
    }

    pub(crate) fn len(&self) -> usize {
        self.bytes.len()
    }

    pub(crate) fn try_reserve(&mut self, additional: usize) -> io::Result<()> {
        self.bytes.try_reserve(additional).map_err(io::Error::other)
    }
}

impl Write for FrameBytes {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.try_reserve(bytes.len())?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
