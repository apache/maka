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

mod build_ui;
mod install;
mod product;
mod serve;

pub(crate) use product::{
    LivePublication, ProductHost, Roots, configure_workspace_locations, directories,
    live_update_available, open_host, prepare_live_publication, root_path, select_committed_host,
};

use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use maka_host_runtime::HostError;
use maka_packages::Package;
use maka_plugin_core::{
    composition::Input,
    deployment::RemoteObservation,
    package::Packages,
    plan::{Plan, RemoteExports},
};
use serde::Serialize;

#[derive(Subcommand)]
pub(super) enum Command {
    /// Compile a plugin's NSH UI module and assets for packaging.
    BuildUi(build_ui::BuildUi),
    /// Author a checked business Host without Node or a source checkout.
    Compose(product::Compose),
    /// Preview selected bundled Host package updates; use --apply to synchronize.
    UpdateDefaults(product::Update),
    /// Download, validate and install a plugin bundle into an inactive deployment.
    InstallUrl(install::InstallUrl),
    /// Check exact package revisions, template overrides, variants and capability bindings.
    Check(Check),
    /// Emit authoring schemas from the actual runtime wire types.
    Schema,
    /// Validate immutable package bytes and print their exact pinned reference.
    InspectPackage(InspectPackage),
    /// Export validated immutable package bytes to a new installable bundle.
    ExportPackage(ExportPackage),
    /// Atomically commit desired deployment input and exact immutable bytes.
    Commit(Commit),
    /// Read and validate the persisted source and every selected package.
    Read(ReadSource),
    /// Serve an existing deployment as an independent public Host.
    Serve(serve::Serve),
}

#[derive(Args)]
pub(super) struct InspectPackage {
    #[arg(long, value_name = "PATH")]
    package: PathBuf,
}

#[derive(Args)]
pub(super) struct ExportPackage {
    #[arg(long, value_name = "PATH")]
    package: PathBuf,
    /// A new destination; an existing file is never replaced.
    #[arg(long, value_name = "FILE")]
    output: PathBuf,
}

#[derive(Args)]
pub(super) struct Check {
    /// Deployment composition input in JSON.
    #[arg(long, value_name = "FILE")]
    input: PathBuf,
    /// Immutable application package directory or bundle; repeat for each revision.
    #[arg(long = "package", value_name = "PATH")]
    packages: Vec<PathBuf>,
    /// Observed remote declarations in JSON; compatibility evidence, never authorization.
    #[arg(long, value_name = "FILE")]
    remote_exports: Option<PathBuf>,
}

#[derive(Args)]
pub(super) struct Commit {
    /// Existing owned State Root.
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    deployment: uuid::Uuid,
    /// Zero creates; replacement requires the currently observed revision.
    #[arg(long)]
    expected_revision: u64,
    #[command(flatten)]
    source: Check,
}

#[derive(Args)]
pub(super) struct ReadSource {
    #[arg(long)]
    root: PathBuf,
    #[arg(long)]
    deployment: uuid::Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    instances: Vec<&'a maka_plugin_core::plan::Instance>,
}

impl Command {
    pub(super) async fn run(self) -> Result<(), HostError> {
        self.run_inner()
            .await
            .map_err(|error| -> HostError { sanitize_diagnostic(&error.to_string()).into() })
    }

    async fn run_inner(self) -> Result<(), HostError> {
        match self {
            Self::BuildUi(args) => args.run().await?,
            Self::Compose(args) => args.run().await?,
            Self::UpdateDefaults(args) => args.run().await?,
            Self::InstallUrl(args) => args.run().await?,
            Self::Serve(args) => serve::run(args).await?,
            Self::Schema => println!("{}", serde_json::to_string(&maka_schema::catalog())?),
            Self::InspectPackage(args) => {
                let reference = tokio::task::spawn_blocking(move || {
                    Package::read_from(&std::path::absolute(args.package)?)
                        .map(|package| package.application_ref())
                })
                .await??;
                println!("{}", serde_json::to_string_pretty(&reference)?);
            }
            Self::ExportPackage(args) => {
                let reference = tokio::task::spawn_blocking(move || {
                    let package = Package::read_from(&std::path::absolute(args.package)?)?;
                    package.export_to(&std::path::absolute(args.output)?)?;
                    Ok::<_, maka_packages::PackageIoError>(package.application_ref())
                })
                .await??;
                println!("{}", serde_json::to_string_pretty(&reference)?);
            }
            Self::Check(args) => {
                let report = tokio::task::spawn_blocking(move || args.check()).await??;
                println!("{report}");
            }
            Self::Commit(args) => {
                let (input, observations, packages) =
                    tokio::task::spawn_blocking(move || args.source.read()).await??;
                let store = open_store(args.root).await?;
                let result = store
                    .commit_application(
                        args.deployment,
                        args.expected_revision,
                        input,
                        observations,
                        packages,
                    )
                    .await;
                let closed = store.close().await;
                let source = result?;
                closed?;
                println!("{}", serde_json::to_string_pretty(&source)?);
            }
            Self::Read(args) => {
                let store = open_application_inspection(args.root).await?;
                let result = store.load_application(args.deployment).await;
                store.drain().await;
                let loaded = result?.ok_or("deployment not found")?;
                println!("{}", serde_json::to_string_pretty(&loaded.source())?);
            }
        }
        Ok(())
    }
}

impl Check {
    fn read(self) -> Result<(Input, Vec<RemoteObservation>, Vec<Package>), HostError> {
        let input = read_json(&self.input)?;
        let mut packages = Vec::new();
        for source in self.packages {
            let package = Package::read_from(&std::path::absolute(source)?)?;
            packages.push(package);
        }
        let observations = self
            .remote_exports
            .map(|source| read_json(&source))
            .transpose()?
            .unwrap_or_default();
        Ok((input, observations, packages))
    }
    fn check(self) -> Result<String, HostError> {
        let (input, observations, bytes) = self.read()?;
        let mut packages = Packages::default();
        for package in bytes {
            let declaration = package
                .manifest()
                .application
                .as_ref()
                .ok_or("package has no application declaration")?;
            packages.insert_checked(package.application_ref(), declaration.clone())?;
        }
        let mut remote = RemoteExports::new();
        for observation in observations {
            if remote
                .insert(observation.capability, observation.declaration)
                .is_some()
            {
                return Err("duplicate remote capability observation".into());
            }
        }
        let plan = Plan::prepare(&input, &packages, &remote)?;
        Ok(serde_json::to_string_pretty(&Report {
            instances: plan.instances().values().collect(),
        })?)
    }
}

fn read_json<T: serde::de::DeserializeOwned>(source: &Path) -> Result<T, HostError> {
    Ok(serde_json::from_reader(std::io::BufReader::new(
        std::fs::File::open(source)?,
    ))?)
}

pub(super) async fn open_store(
    root: PathBuf,
) -> Result<maka_event_log::root_store::RootStore, HostError> {
    let owner = tokio::task::spawn_blocking(move || {
        maka_event_log::root::RootOwner::open(
            &root,
            &maka_event_log::root::RootNamespaces::for_current_account()?,
        )
    })
    .await??;
    Ok(maka_transport::open_store(std::sync::Arc::new(owner)).await?)
}

async fn open_application_inspection(root: PathBuf) -> Result<maka_event_log::EventLog, HostError> {
    let owner = tokio::task::spawn_blocking(move || {
        maka_event_log::root::RootOwner::open_existing(
            &root,
            &maka_event_log::root::RootNamespaces::for_current_account()?,
        )
    })
    .await??;
    Ok(maka_transport::open_application_inspection(std::sync::Arc::new(owner)).await?)
}

// Authored identifiers and source errors can contain terminal control characters.
// Keep headless CLI diagnostics safe independently of a presentation backend.
fn sanitize_diagnostic(text: &str) -> String {
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

#[cfg(test)]
mod source_input_tests {
    use super::*;

    #[test]
    fn authoring_reads_complete_contract_documents_and_rejects_malformed_json() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("remote-exports.json");
        let value =
            serde_json::json!({"contract": format!("甲{}🙂 END", "x".repeat(3 * 1024 * 1024))});
        std::fs::write(&file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(
            read_json::<serde_json::Value>(&file).unwrap() == value,
            "authoring must read the complete original contract JSON"
        );
        std::fs::write(&file, b"{\"contract\":").unwrap();
        assert!(
            read_json::<serde_json::Value>(&file)
                .unwrap_err()
                .to_string()
                .contains("EOF while parsing")
        );
    }
}
