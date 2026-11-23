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

use std::path::PathBuf;

#[derive(clap::Parser)]
pub(crate) struct BuildUi {
    /// The plugin's NSH TSX or TypeScript entry module.
    #[arg(long, value_name = "FILE")]
    pub(crate) entry: PathBuf,
    /// Directory for the compiled module, assets and manifest.json.
    #[arg(long, value_name = "DIRECTORY")]
    pub(crate) output: PathBuf,
    /// Root containing every imported asset; defaults to the NSH app directory.
    #[arg(long, value_name = "DIRECTORY")]
    pub(crate) asset_root: Option<PathBuf>,
}

// Authored identifiers and source errors can contain terminal control characters.
// Keep headless CLI diagnostics safe independently of a presentation backend.
pub(crate) fn sanitize_diagnostic(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '\t' => output.push_str("    "),
            '\n' => output.push(character),
            character if !character.is_control() => output.push(character),
            _ => {}
        }
    }
    output
}
