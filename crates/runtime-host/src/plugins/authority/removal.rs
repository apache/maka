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

use super::{Error, invalid};
use maka_plugins::{
    composition::{Composition, Entry, Ledger, Operation},
    package::Package,
};
use std::collections::{BTreeMap, BTreeSet};

/// Replay the same history on both bases. Only operations whose target came
/// exclusively from the removed layer may disappear; user-inserted entries and
/// references from surviving entries must remain replayable or removal fails.
pub(crate) fn without_package_layer(
    ledger: &Ledger,
    packages: &BTreeMap<String, Package>,
    builtins: &BTreeMap<String, Vec<Operation>>,
    id: &str,
) -> Result<Ledger, Error> {
    let mut layers = builtins.clone();
    for (id, package) in packages {
        layers.insert(id.clone(), package.composition()?);
    }
    let mut base = ledger.clone();
    base.overlays.clear();
    let mut original = base.project(&layers)?;
    base.package_layers.retain(|layer| layer != id);
    // Another layer may structurally depend on this one even without declaring
    // it. Never repair that package's operations on its behalf.
    let mut remaining = base.project(&layers)?;
    let mut removed = BTreeSet::new();
    for entries in original.roots.values() {
        disappearing(entries, &remaining, id, &mut removed)?;
    }
    for operation in &ledger.overlays {
        let missing_target = match operation {
            Operation::Update { entry_id, .. }
            | Operation::Move { entry_id, .. }
            | Operation::Remove { entry_id } => remaining.find(entry_id).is_none(),
            Operation::Insert { .. } => false,
        };
        if missing_target {
            let entry_id = match operation {
                Operation::Update { entry_id, patch } => {
                    if patch
                        .package_id
                        .as_deref()
                        .is_some_and(|package| package != id)
                    {
                        return Err(invalid(
                            "removed layer entry was reassigned to another package",
                        ));
                    }
                    entry_id
                }
                Operation::Move { entry_id, .. } | Operation::Remove { entry_id } => entry_id,
                Operation::Insert { .. } => unreachable!(),
            };
            let entry = original
                .find(entry_id)
                .ok_or_else(|| invalid("overlay target disappeared"))?
                .1;
            if !exclusively_removed(entry, &removed, id) {
                return Err(invalid(
                    "removing the package would discard another entry's intent",
                ));
            }
        } else {
            // This rejects surviving children/moves pointing into the removed
            // tree instead of silently deleting their structural reference.
            remaining = remaining.apply(std::slice::from_ref(operation))?;
            base.overlays.push(operation.clone());
        }
        original = original.apply(std::slice::from_ref(operation))?;
    }
    Ok(base)
}

fn disappearing(
    entries: &[Entry],
    remaining: &Composition,
    package: &str,
    removed: &mut BTreeSet<String>,
) -> Result<(), Error> {
    for entry in entries {
        if remaining.find(&entry.id).is_none() {
            if entry.package_id.as_deref().is_some_and(|id| id != package) {
                return Err(invalid("package layer contains another package's entry"));
            }
            removed.insert(entry.id.clone());
        }
        disappearing(&entry.children, remaining, package, removed)?;
    }
    Ok(())
}

fn exclusively_removed(entry: &Entry, removed: &BTreeSet<String>, package: &str) -> bool {
    removed.contains(&entry.id)
        && entry.package_id.as_deref().is_none_or(|id| id == package)
        && entry
            .children
            .iter()
            .all(|child| exclusively_removed(child, removed, package))
}
