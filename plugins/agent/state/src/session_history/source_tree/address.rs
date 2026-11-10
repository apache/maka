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
use super::*;
pub(in crate::session_history) fn location(
    address: &HistoryRowAddress,
) -> (&[RunId], Option<SnapshotId>, (u64, u64)) {
    match address {
        HistoryRowAddress::Live {
            sequence,
            item_index,
            ..
        } => (&[], None, (*sequence, *item_index)),
        HistoryRowAddress::Snapshot {
            path,
            snapshot,
            sequence,
            item_index,
            ..
        } => (path, Some(*snapshot), (*sequence, *item_index)),
        HistoryRowAddress::Imported {
            path,
            snapshot,
            message_ordinal,
            part_ordinal,
        } => (path, Some(*snapshot), (*message_ordinal, *part_ordinal)),
    }
}
pub(super) fn coordinate(row: &SnapshotPosition) -> (u64, u64) {
    match row {
        SnapshotPosition::Canonical {
            sequence,
            item_index,
            ..
        } => (*sequence, *item_index),
        SnapshotPosition::Imported {
            message_ordinal,
            part_ordinal,
            ..
        } => (*message_ordinal, *part_ordinal),
    }
}

pub(in crate::session_history) fn qualify(
    section: &Segment,
    row: &SnapshotPosition,
) -> Result<QualifiedRow, StoreError> {
    let mut order = section.order.clone();
    let (address, item_index) = match row {
        SnapshotPosition::Canonical {
            sequence,
            fact,
            item_index,
            ..
        } => {
            order.push(*sequence);
            (
                if let Some(snapshot) = section.source.snapshot_id() {
                    HistoryRowAddress::Snapshot {
                        path: section.path.clone(),
                        snapshot,
                        sequence: *sequence,
                        fact: *fact,
                        item_index: *item_index,
                    }
                } else {
                    HistoryRowAddress::Live {
                        sequence: *sequence,
                        fact: *fact,
                        item_index: *item_index,
                    }
                },
                *item_index,
            )
        }
        SnapshotPosition::Imported {
            message_ordinal,
            part_ordinal,
            ..
        } => {
            let snapshot = section
                .source
                .snapshot_id()
                .ok_or_else(|| invalid("imported row cannot belong to live canonical facts"))?;
            order.push(
                message_ordinal
                    .checked_add(1)
                    .ok_or_else(|| invalid("source ordinal exhausted"))?,
            );
            (
                HistoryRowAddress::Imported {
                    path: section.path.clone(),
                    snapshot,
                    message_ordinal: *message_ordinal,
                    part_ordinal: *part_ordinal,
                },
                *part_ordinal,
            )
        }
    };
    Ok(QualifiedRow {
        address,
        order: HistoryOrder {
            path: order,
            item_index,
        },
    })
}
