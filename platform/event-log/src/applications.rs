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

//! Atomic durable application sources; no legacy composition translation.
mod changes;
mod source;
pub use source::SourceSnapshot;
pub mod intents;
pub mod launch;
pub mod operations;
use crate::{EventLog, StoreError};
pub use changes::DeploymentChanges;
use maka_packages::Package;
use maka_plugin_core::{
    composition::Input,
    deployment::{Deployment, DeploymentRef, RemoteObservation, management::ManagedDeployment},
    package::{PackageRef, Packages},
    plan::{Plan, RemoteExports},
};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::collections::{BTreeMap, BTreeSet};

use uuid::Uuid;

/// Immutable source, bytes and plan checked together before persistence.
/// This value carries no Root authority and is not evidence of a committed revision.
pub struct PreparedApplication {
    input: Input,
    observations: Vec<RemoteObservation>,
    packages: Vec<Package>,
    plan: Plan,
}
impl PreparedApplication {
    pub fn new(
        input: Input,
        observations: Vec<RemoteObservation>,
        packages: Vec<Package>,
    ) -> Result<Self, StoreError> {
        let plan = validate(&input, &observations, &packages)?;
        Ok(Self {
            input,
            observations,
            packages,
            plan,
        })
    }
    pub fn input(&self) -> &Input {
        &self.input
    }
    pub fn remote_exports(&self) -> &[RemoteObservation] {
        &self.observations
    }
    pub fn packages(&self) -> &[Package] {
        &self.packages
    }
    pub fn plan(&self) -> &Plan {
        &self.plan
    }
}

/// Exact committed source and immutable bytes, checked together with its plan.
pub struct LoadedDeployment {
    source: Deployment,
    packages: Vec<Package>,
    plan: Plan,
    snapshot: SourceSnapshot,
}
impl LoadedDeployment {
    pub fn source(&self) -> &Deployment {
        &self.source
    }
    pub fn packages(&self) -> &[Package] {
        &self.packages
    }
    pub fn plan(&self) -> &Plan {
        &self.plan
    }
    /// Consume the immutable checked snapshot. Edited parts require a new plan.
    pub fn into_parts(self) -> (Deployment, Vec<Package>, Plan, SourceSnapshot) {
        (self.source, self.packages, self.plan, self.snapshot)
    }
    pub fn check_store(&self, store: &EventLog) -> Result<(), StoreError> {
        self.snapshot.check_root(store)
    }
    pub fn snapshot(&self) -> SourceSnapshot {
        self.snapshot.clone()
    }
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
fn validate(
    input: &Input,
    observations: &[RemoteObservation],
    bytes: &[Package],
) -> Result<Plan, StoreError> {
    let packages = validate_packages(bytes)?;
    validate_plan(input, observations, &packages)
}
fn validate_packages(bytes: &[Package]) -> Result<Packages, StoreError> {
    let mut packages = Packages::default();
    let mut references = BTreeSet::new();
    for package in bytes {
        if !references.insert(package.application_ref()) {
            return Err(invalid("duplicate application package revision"));
        }
        let declaration = package
            .manifest()
            .application
            .as_ref()
            .ok_or_else(|| invalid("application declaration required"))?;
        packages
            .insert_checked(package.application_ref(), declaration.clone())
            .map_err(|e| invalid(e.to_string()))?;
    }
    Ok(packages)
}
fn validate_plan(
    input: &Input,
    observations: &[RemoteObservation],
    packages: &Packages,
) -> Result<Plan, StoreError> {
    let mut remote = RemoteExports::new();
    for observation in observations {
        if remote
            .insert(
                observation.capability.clone(),
                observation.declaration.clone(),
            )
            .is_some()
        {
            return Err(invalid("duplicate remote capability observation"));
        }
    }
    Plan::prepare(input, packages, &remote).map_err(|e| invalid(e.to_string()))
}
/// Shared deterministic source checks, before any SQL effect. This validates
/// metadata and immutable bytes; it grants no deployment management authority.
pub fn validate_application(
    input: &Input,
    observations: &[RemoteObservation],
    bytes: &[Package],
) -> Result<(), StoreError> {
    validate(input, observations, bytes).map(|_| ())
}

/// Check several sources against the same immutable package set. Each source
/// keeps its selected packages, observations and plan.
pub fn prepare_applications(
    sources: &[(&Input, &[RemoteObservation])],
    bytes: &[Package],
) -> Result<Vec<PreparedApplication>, StoreError> {
    let packages = validate_packages(bytes)?;
    sources
        .iter()
        .map(|(input, observations)| {
            let plan = validate_plan(input, observations, &packages)?;
            let required: BTreeSet<_> = plan
                .instances()
                .values()
                .map(|instance| &instance.package)
                .collect();
            let selected: Vec<_> = bytes
                .iter()
                .filter(|package| required.contains(&package.application_ref()))
                .cloned()
                .collect();
            Ok(PreparedApplication {
                input: (*input).clone(),
                observations: observations.to_vec(),
                packages: selected,
                plan,
            })
        })
        .collect()
}
impl EventLog {
    fn application_domain(&self) -> Result<String, StoreError> {
        self.root_owner
            .as_ref()
            .map(|owner| owner.root_id().to_owned())
            .ok_or_else(|| invalid("application sources require an owned State Root"))
    }
    /// Commits desired input and exact bytes, not live readiness or convergence.
    /// Revision zero creates a deployment; every replacement is an explicit CAS.
    pub async fn commit_application(
        &self,
        deployment: Uuid,
        expected_revision: u64,
        input: Input,
        observations: Vec<RemoteObservation>,
        bytes: Vec<Package>,
    ) -> Result<DeploymentRef, StoreError> {
        let prepared = PreparedApplication::new(input, observations, bytes)?;
        Ok(self
            .commit_prepared_application(deployment, expected_revision, prepared)
            .await?
            .source
            .reference)
    }

    /// A successful COMMIT binds the checked source to this exact live Root owner.
    /// An unknown COMMIT outcome returns no executable snapshot; callers recover
    /// using the original durable pending operation and normal storage validation.
    pub async fn commit_prepared_application(
        &self,
        deployment: Uuid,
        expected_revision: u64,
        prepared: PreparedApplication,
    ) -> Result<LoadedDeployment, StoreError> {
        let domain = self.application_domain()?;
        if deployment.is_nil() || expected_revision >= 9_007_199_254_740_991 {
            return Err(invalid("invalid deployment or exhausted revision"));
        }
        let PreparedApplication {
            input,
            observations,
            packages: bytes,
            plan,
        } = prepared;
        let encoded = serde_json::to_string(&input)?;
        let remote = serde_json::to_string(&observations)?;
        let owner = std::sync::Arc::downgrade(self.root_owner.as_ref().expect("owned source Root"));
        let commits = self.commits.notice();
        self.connection.run(move |connection| {
            let tx = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)?;
            let id = deployment.to_string();
            let current: Option<i64> = tx.query_row("SELECT revision FROM application_deployments WHERE id = ?", params![&id], |row| row.get(0)).optional()?;
            let current = current.unwrap_or(0) as u64;
            if current != expected_revision { return Err(StoreError::RevisionConflict {
                expected: expected_revision.to_string(), actual: current.to_string(),
            }); }
            let revision = expected_revision + 1;
            tx.execute("INSERT INTO application_sources VALUES (?, ?, ?, ?)", params![&id, revision as i64, encoded, remote])?;
            tx.execute("INSERT INTO application_deployments VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision", params![&id, revision as i64])?;
            for package in &bytes {
                let reference = package.application_ref();
                // Existing immutable content must match as well; never repair corruption by an overwrite.
                let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM application_packages WHERE id = ? AND revision = ?)", params![&reference.id, &reference.revision], |row| row.get(0))?;
                if exists {
                    if read_package(&tx, &reference)?.files() != package.files() {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    tx.execute("INSERT INTO application_packages VALUES (?, ?)", params![&reference.id, &reference.revision])?;
                    for (path, payload) in package.files() {
                        let digest={ use sha2::Digest; format!("sha256:{}",hex::encode(sha2::Sha256::digest(payload))) };
                        let content=crate::content::put(&tx,&digest,payload)?;
                        tx.execute("INSERT INTO application_package_files VALUES (?, ?, ?, ?)", params![&reference.id, &reference.revision, path, content])?;
                    }
                }
                tx.execute("INSERT INTO application_source_packages VALUES (?, ?, ?, ?)", params![&id, revision as i64, &reference.id, &reference.revision])?;
            }
            tx.commit().map_err(StoreError::CommitUnknown)?;
            commits.metadata();
            let reference = DeploymentRef { state_domain: domain, deployment, revision };
            let snapshot = SourceSnapshot::new(owner, reference.clone(), &plan);
            Ok(LoadedDeployment {
                source: Deployment { reference, input, remote_exports: observations },
                packages: bytes, plan, snapshot,
            })
        }).await
    }

    pub async fn load_application(
        &self,
        deployment: Uuid,
    ) -> Result<Option<LoadedDeployment>, StoreError> {
        self.read_application(deployment, None).await
    }

    /// Reads a committed original revision, independent of the current head.
    pub async fn load_application_at(
        &self,
        reference: &DeploymentRef,
    ) -> Result<Option<LoadedDeployment>, StoreError> {
        reference.validate().map_err(invalid)?;
        if reference.state_domain != self.application_domain()? {
            return Err(invalid("foreign application state domain"));
        }
        self.read_application(reference.deployment, Some(reference.revision))
            .await
    }

    /// Bounded source and references from one original SQL snapshot. No package
    /// payload is read or claimed validated; executors still load exact bytes.
    pub async fn read_application_metadata(
        &self,
        deployment: Uuid,
    ) -> Result<Option<ManagedDeployment>, StoreError> {
        self.read_metadata(deployment, None).await
    }

    /// Metadata of the exact committed revision, independent of head.
    pub async fn read_application_metadata_at(
        &self,
        reference: &DeploymentRef,
    ) -> Result<Option<ManagedDeployment>, StoreError> {
        reference.validate().map_err(invalid)?;
        if reference.state_domain != self.application_domain()? {
            return Err(invalid("foreign application state domain"));
        }
        self.read_metadata(reference.deployment, Some(reference.revision))
            .await
    }

    /// Exact bytes of one package in a committed revision, without reading or
    /// validating the revision's other packages. `None` when the revision does
    /// not contain that package.
    pub async fn load_application_package_at(
        &self,
        source: &DeploymentRef,
        package: &PackageRef,
    ) -> Result<Option<Package>, StoreError> {
        source.validate().map_err(invalid)?;
        if source.state_domain != self.application_domain()? {
            return Err(invalid("foreign application state domain"));
        }
        package
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        let deployment = source.deployment.to_string();
        let revision = source.revision as i64;
        let requested = package.clone();
        let files = self
            .connection
            .read(move |connection| {

                    let tx = Transaction::new_unchecked(connection, TransactionBehavior::Deferred)?;
                    let installed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM application_source_packages
                            WHERE deployment = ? AND source_revision = ? AND id = ? AND revision = ?)", params![&deployment, revision, &requested.id, &requested.revision], |row| row.get(0))?;
                    let files = if installed {
                        Some(read_package_files(&tx, &requested)?)
                    } else {
                        None
                    };
                    tx.commit()?;
                    Ok(files)

            })
            .await?;
        let Some(files) = files else {
            return Ok(None);
        };
        let package = package.clone();
        tokio::task::spawn_blocking(move || build_checked_package(files, &package).map(Some))
            .await
            .map_err(|error| {
                invalid(format!(
                    "application package validation worker failed: {error}"
                ))
            })?
    }

    async fn read_metadata(
        &self,
        deployment: Uuid,
        revision: Option<u64>,
    ) -> Result<Option<ManagedDeployment>, StoreError> {
        let domain = self.application_domain()?;
        if deployment.is_nil() {
            return Err(invalid("invalid deployment"));
        }
        self.connection
            .read(move |connection| {
                let tx = Transaction::new_unchecked(connection, TransactionBehavior::Deferred)?;
                let metadata = read_metadata(&tx, domain, deployment, revision)?;
                tx.commit()?;
                Ok(metadata)
            })
            .await
    }

    async fn read_application(
        &self,
        deployment: Uuid,
        revision: Option<u64>,
    ) -> Result<Option<LoadedDeployment>, StoreError> {
        let domain = self.application_domain()?;
        if deployment.is_nil() {
            return Err(invalid("invalid deployment"));
        }
        let owner = std::sync::Arc::downgrade(self.root_owner.as_ref().expect("owned source Root"));
        let raw = self
            .connection
            .read(move |connection| {
                let tx = Transaction::new_unchecked(connection, TransactionBehavior::Deferred)?;
                let Some(metadata) = read_metadata(&tx, domain, deployment, revision)? else {
                    return Ok(None);
                };
                let mut raw_packages = Vec::with_capacity(metadata.packages.len());
                for reference in &metadata.packages {
                    let files = read_package_files(&tx, reference)?;
                    raw_packages.push((reference.clone(), files));
                }
                tx.commit()?;
                Ok(Some((metadata, raw_packages)))
            })
            .await?;
        let Some((metadata, raw_packages)) = raw else {
            return Ok(None);
        };
        tokio::task::spawn_blocking(move || {
            let mut packages = Vec::with_capacity(raw_packages.len());
            for (reference, files) in raw_packages {
                packages.push(build_checked_package(files, &reference)?);
            }
            let plan = validate(
                &metadata.source.input,
                &metadata.source.remote_exports,
                &packages,
            )?;
            let snapshot = SourceSnapshot::new(owner, metadata.source.reference.clone(), &plan);
            Ok(Some(LoadedDeployment {
                snapshot,
                source: metadata.source,
                packages,
                plan,
            }))
        })
        .await
        .map_err(|error| {
            invalid(format!(
                "application source validation worker failed: {error}"
            ))
        })?
    }
}

fn read_metadata(
    connection: &Connection,
    domain: String,
    deployment: Uuid,
    revision: Option<u64>,
) -> Result<Option<ManagedDeployment>, StoreError> {
    let id = deployment.to_string();
    let revision = match revision {
        Some(revision) => revision,
        None => match connection
            .query_row(
                "SELECT revision FROM application_deployments WHERE id = ?",
                params![&id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
        {
            Some(revision) => revision as u64,
            None => return Ok(None),
        },
    };
    let Some((stored_revision, input_json, remote_json)) = connection.query_row(
        "SELECT revision, input_json, remote_exports_json FROM application_sources WHERE deployment = ?1 AND revision = ?2",
        params![&id, revision as i64],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
    ).optional()? else { return Ok(None); };
    let input: Input = serde_json::from_str(&input_json)?;
    let observations: Vec<RemoteObservation> = serde_json::from_str(&remote_json)?;
    let reference = DeploymentRef {
        state_domain: domain,
        deployment,
        revision: stored_revision as u64,
    };
    reference.validate().map_err(invalid)?;
    let mut statement = connection.prepare_cached("SELECT id,
        CASE WHEN length(CAST(revision AS BLOB)) = 71 THEN revision END AS revision
        FROM application_source_packages WHERE deployment = ? AND source_revision = ? ORDER BY id, revision")?;
    let refs = statement.query_map(params![&id, revision as i64], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
        ))
    })?;
    let mut packages = Vec::new();
    for row in refs {
        let (id, revision) = row?;
        let reference = PackageRef {
            id: id.ok_or_else(|| invalid("invalid stored package id"))?,
            revision: revision.ok_or_else(|| invalid("invalid stored package revision"))?,
        };
        reference
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        packages.push(reference);
    }
    Ok(Some(ManagedDeployment {
        source: Deployment {
            reference,
            input,
            remote_exports: observations,
        },
        packages,
    }))
}

fn read_package_files(
    connection: &Connection,
    reference: &PackageRef,
) -> Result<BTreeMap<String, Vec<u8>>, StoreError> {
    let mut statement = connection.prepare_cached(
        "SELECT path, CASE WHEN typeof(c.payload) = 'blob' THEN c.payload END AS payload
        FROM application_package_files f JOIN contents c ON c.id=f.content_id
        WHERE f.id = ? AND f.revision = ? ORDER BY f.path",
    )?;
    let rows = statement.query_map(params![&reference.id, &reference.revision], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?))
    })?;
    let mut files = BTreeMap::new();
    for row in rows {
        let (path, bytes) = row?;
        maka_packages::validate_path(&path).map_err(|e| invalid(e.to_string()))?;
        let bytes = bytes.ok_or_else(|| invalid("stored package payload must be a BLOB"))?;
        files.insert(path, bytes);
    }
    if files.is_empty() {
        return Err(invalid("invalid stored application package file count"));
    }
    Ok(files)
}

fn build_checked_package(
    files: BTreeMap<String, Vec<u8>>,
    reference: &PackageRef,
) -> Result<Package, StoreError> {
    let package = Package::new(files).map_err(|e| invalid(e.to_string()))?;
    if &package.application_ref() != reference {
        return Err(invalid("application package digest mismatch"));
    }
    Ok(package)
}

fn read_package(connection: &Connection, reference: &PackageRef) -> Result<Package, StoreError> {
    let files = read_package_files(connection, reference)?;
    build_checked_package(files, reference)
}
