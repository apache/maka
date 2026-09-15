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

mod control;
mod health;
mod model;
#[cfg(windows)]
mod platform;
#[cfg(any(windows, test))]
mod recorder_lifecycle;
#[cfg(all(test, not(windows)))]
#[path = "platform/snapshot.rs"]
mod snapshot_tests;
mod store;

#[cfg(windows)]
fn main() {
    if let Err(error) = platform::run() {
        eprintln!("{error}");
        std::process::exit(if error.to_string() == "recorder_occupied" {
            75
        } else {
            1
        });
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows Computer History requires Windows.");
    std::process::exit(1);
}
