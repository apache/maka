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

#[path = "counter/support.rs"]
mod support;
use std::path::PathBuf;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = std::path::absolute(PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("output directory required")?,
    ))?;
    std::fs::create_dir(&output)?;
    let (input, packages) = match std::env::args().nth(2).as_deref() {
        None => support::fixture("return frame({count:state.count+1,revision:state.revision+1});"),
        Some("workspace") => support::workspace_fixture(),
        Some("resource") => support::resource_fixture(),
        Some("events") => support::editor_events_fixture(),
        Some("editor") => support::editor_fixture(),
        Some("native") => support::native_fixture(),
        Some("composed") => support::composed_fixture(support::CHILD_UPDATE, support::PARENT_EVENT),
        Some(_) => return Err("unknown counter fixture".into()),
    };
    for package in &packages {
        package.export_to(&output.join(format!("{}.maka-plugin", package.manifest().id)))?;
    }
    std::fs::write(
        output.join("input.json"),
        serde_json::to_vec_pretty(&input)?,
    )?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_time()
        .build()?;
    let root = output.join("root");
    let owner = std::sync::Arc::new(maka_event_log::root::RootOwner::create(
        &root,
        &maka_event_log::root::RootNamespaces::for_current_account()?,
    )?);
    let store = runtime.block_on(maka_event_log::RootStore::open(owner))?;
    runtime.block_on(store.commit_application(
        uuid::Uuid::from_u128(1),
        0,
        input.clone(),
        vec![],
        packages.clone(),
    ))?;
    runtime.block_on(store.close())?;
    println!("{}", output.display());
    Ok(())
}
