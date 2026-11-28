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

//! Deterministic generator for `platform/event-log/src/content/dict_v1.bin`.
//!
//! Run:
//!   cargo run -p maka-event-log --example gen_content_dict

#[path = "../src/content/dict_corpus.rs"]
mod dict_corpus;

use sha2::{Digest, Sha256};
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dict = dict_corpus::train_dict_v1()?;
    let out_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/content/dict_v1.bin");
    std::fs::write(&out_path, &dict)?;
    let digest = hex::encode(Sha256::digest(&dict));
    println!(
        "Wrote {} ({} bytes, sha256:{})",
        out_path.display(),
        dict.len(),
        digest
    );
    Ok(())
}
