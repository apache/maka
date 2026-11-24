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

fn main() {
    let source = "data/catalog-facts.json";
    println!("cargo:rerun-if-changed={source}");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    let frame = zstd::stream::compress_file(source, 9).expect("compress catalog facts");
    std::fs::write(output.join("catalog.zst"), frame).expect("write catalog frame");
}
