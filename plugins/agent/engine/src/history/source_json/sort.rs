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

//! Bounded runs and two arena regions; keys remain decoded source comparisons.

use super::super::capture_arena::CaptureArena;
use super::{Roots, cancelled, invalid, key_text};
use super::{
    io as page,
    record::{FIELD_BYTES, Field},
};
use maka_agent_facts::model::prompt_source::source::{SourceBudget, json};
use std::{cmp::Ordering, io, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy)]
pub(super) enum Order {
    Key,
    Insertion,
}

pub(super) async fn same_key(
    roots: &Roots,
    left: &Field,
    right: &Field,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<bool> {
    if left.digest != right.digest {
        return Ok(false);
    }
    json::text_source_eq(
        &key_text(roots, left.key)?,
        &key_text(roots, right.key)?,
        budget,
    )
    .await
}
async fn compare(
    roots: &Roots,
    left: &Field,
    right: &Field,
    order: Order,
    budget: Arc<dyn SourceBudget>,
) -> io::Result<Ordering> {
    match order {
        Order::Insertion => {
            Ok((left.first_layer, left.first_member).cmp(&(right.first_layer, right.first_member)))
        }
        Order::Key => {
            let digest = left.digest.cmp(&right.digest);
            if digest != Ordering::Equal {
                return Ok(digest);
            }
            let key = json::text_source_cmp(
                &key_text(roots, left.key)?,
                &key_text(roots, right.key)?,
                budget,
            )
            .await?;
            if key != Ordering::Equal {
                return Ok(key);
            }
            Ok((left.layer, left.member).cmp(&(right.layer, right.member)))
        }
    }
}

#[expect(
    clippy::too_many_arguments,
    reason = "sort receives both existing arena regions and the caller-owned work envelope"
)]
pub(super) async fn sort(
    arena: &CaptureArena,
    roots: &Roots,
    start: u64,
    scratch: u64,
    count: u64,
    order: Order,
    budget: Arc<dyn SourceBudget>,
    cancel: &CancellationToken,
) -> io::Result<u64> {
    if count < 2 {
        return Ok(start);
    }
    let mut buffer = budget.allocate(page::PAGE_BYTES).await?;
    let run = buffer.as_ref().len().min(page::PAGE_BYTES) / FIELD_BYTES;
    if run == 0 {
        return Err(invalid());
    }
    let mut base = 0u64;
    while base < count {
        cancelled(cancel)?;
        let records = (count - base).min(run as u64) as usize;
        let used = records * FIELD_BYTES;
        let offset = start
            .checked_add(base.checked_mul(FIELD_BYTES as u64).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        buffer = arena
            .with_writer(move |writer| {
                writer.read_exact_at(offset, &mut buffer.as_mut()[..used])?;
                Ok(buffer)
            })
            .await?;
        for index in 1..records {
            let value =
                Field::decode(&buffer.as_ref()[index * FIELD_BYTES..(index + 1) * FIELD_BYTES])?;
            let mut destination = index;
            while destination > 0 {
                let previous = Field::decode(
                    &buffer.as_ref()[(destination - 1) * FIELD_BYTES..destination * FIELD_BYTES],
                )?;
                if compare(roots, &previous, &value, order, budget.clone()).await?
                    != Ordering::Greater
                {
                    break;
                }
                buffer.as_mut().copy_within(
                    (destination - 1) * FIELD_BYTES..destination * FIELD_BYTES,
                    destination * FIELD_BYTES,
                );
                destination -= 1;
            }
            buffer.as_mut()[destination * FIELD_BYTES..(destination + 1) * FIELD_BYTES]
                .copy_from_slice(&value.encode());
        }
        buffer = arena
            .with_writer(move |writer| {
                writer.write_at(offset, &buffer.as_ref()[..used])?;
                Ok(buffer)
            })
            .await?;
        base += records as u64;
    }
    drop(buffer);
    let mut width = run as u64;
    let mut input = start;
    let mut output = scratch;
    while width < count {
        cancelled(cancel)?;
        let mut writer = page::PageWriter::new(arena, output, budget.clone()).await?;
        let mut base = 0u64;
        while base < count {
            let left_count = (count - base).min(width);
            let right_base = base.checked_add(left_count).ok_or_else(invalid)?;
            let right_count = (count - right_base).min(width);
            let left_start = input
                .checked_add(base.checked_mul(FIELD_BYTES as u64).ok_or_else(invalid)?)
                .ok_or_else(invalid)?;
            let right_start = input
                .checked_add(
                    right_base
                        .checked_mul(FIELD_BYTES as u64)
                        .ok_or_else(invalid)?,
                )
                .ok_or_else(invalid)?;
            let mut left = page::PageReader::new(
                arena.inspect(page::region(left_start, left_count, FIELD_BYTES)?),
                budget.clone(),
            )
            .await?;
            let mut right = page::PageReader::new(
                arena.inspect(page::region(right_start, right_count, FIELD_BYTES)?),
                budget.clone(),
            )
            .await?;
            let mut a = left
                .read::<FIELD_BYTES>()
                .await?
                .map(|bytes| Field::decode(&bytes))
                .transpose()?;
            let mut b = right
                .read::<FIELD_BYTES>()
                .await?
                .map(|bytes| Field::decode(&bytes))
                .transpose()?;
            while a.is_some() || b.is_some() {
                cancelled(cancel)?;
                let take_left = match (&a, &b) {
                    (Some(a), Some(b)) => {
                        compare(roots, a, b, order, budget.clone()).await? != Ordering::Greater
                    }
                    (Some(_), None) => true,
                    _ => false,
                };
                if take_left {
                    writer.push(&a.take().ok_or_else(invalid)?.encode()).await?;
                    a = left
                        .read::<FIELD_BYTES>()
                        .await?
                        .map(|bytes| Field::decode(&bytes))
                        .transpose()?;
                } else {
                    writer.push(&b.take().ok_or_else(invalid)?.encode()).await?;
                    b = right
                        .read::<FIELD_BYTES>()
                        .await?
                        .map(|bytes| Field::decode(&bytes))
                        .transpose()?;
                }
            }
            base = right_base.checked_add(right_count).ok_or_else(invalid)?;
        }
        let bytes = writer.finish().await?;
        if bytes != count.checked_mul(FIELD_BYTES as u64).ok_or_else(invalid)? {
            return Err(invalid());
        }
        std::mem::swap(&mut input, &mut output);
        width = width.checked_mul(2).unwrap_or(count);
    }
    Ok(input)
}
