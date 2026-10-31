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

//! Complete canonical reads join one immutable body into the same selected row.
use super::recipe::{Recipe, Slot};
use crate::StoreError;
use sqlx::{Row, sqlite::SqliteRow};
use std::{borrow::Cow, io};

// Full-event queries bind their selected event as e. Metadata-only queries do
// not join these tables or fetch body payloads.
pub(crate) const COLUMNS: &str = "e.canonical_bytes AS canonical_length,
 e.body_id AS canonical_body_reference,
 e.header_offset AS canonical_offset,
 canonical_body.id AS canonical_body_id,
 canonical_body.raw_bytes AS canonical_raw_bytes,
 canonical_body.payload AS canonical_payload";
pub(crate) const JOINS: &str =
    "LEFT JOIN event_bodies canonical_body ON canonical_body.id=e.body_id";
fn invalid(reason: &'static str) -> StoreError {
    io::Error::new(io::ErrorKind::InvalidData, reason).into()
}
fn nonnegative(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value).map_err(|_| invalid("negative canonical storage metadata"))
}
struct Fields<'a> {
    header: Option<&'a str>,
    length: Option<i64>,
    reference: Option<i64>,
    offset: Option<i64>,
    body: Option<i64>,
    raw_bytes: Option<i64>,
    payload: Option<&'a [u8]>,
}
fn reconstruct(fields: Fields<'_>) -> Result<Cow<'_, str>, StoreError> {
    let Fields {
        header,
        length,
        reference,
        offset,
        body,
        raw_bytes,
        payload,
    } = fields;
    let Some(header) = header else {
        if length.is_some()
            || reference.is_some()
            || offset.is_some()
            || body.is_some()
            || raw_bytes.is_some()
            || payload.is_some()
        {
            return Err(invalid("collected event retains live body metadata"));
        }
        return Err(StoreError::MaterialCollected);
    };
    let length =
        nonnegative(length.ok_or_else(|| invalid("live event lacks its canonical byte length"))?)?;
    match (reference, offset, body, raw_bytes, payload) {
        (None, None, None, None, None) => Recipe::new(header, length, None)?.reconstruct(None),
        (Some(reference), Some(offset), Some(id), Some(raw_bytes), Some(payload)) => {
            if reference <= 0 || reference != id || id <= 0 || raw_bytes <= 0 {
                return Err(invalid("invalid canonical body identity or length"));
            }
            let raw_bytes = nonnegative(raw_bytes)?;
            let recipe = Recipe::new(
                header,
                length,
                Some(Slot {
                    offset: nonnegative(offset)?,
                    bytes: raw_bytes,
                }),
            )?;
            recipe.reconstruct(Some(payload))
        }
        _ => Err(invalid("canonical slot or body is missing joined metadata")),
    }
}
pub(crate) fn json(row: &SqliteRow) -> Result<Cow<'_, str>, StoreError> {
    let header = row.try_get("event_header")?;
    let length = row.try_get("canonical_length")?;
    let reference: Option<i64> = row.try_get("canonical_body_reference")?;
    // Presence comes from the event reference, not its joined body. A dangling
    // body reference must take the complete validation path and fail.
    if reference.is_none() {
        return reconstruct(Fields {
            header,
            length,
            reference,
            offset: None,
            body: None,
            raw_bytes: None,
            payload: None,
        });
    }
    reconstruct(Fields {
        header,
        length,
        reference,
        offset: row.try_get("canonical_offset")?,
        body: row.try_get("canonical_body_id")?,
        raw_bytes: row.try_get("canonical_raw_bytes")?,
        payload: row.try_get("canonical_payload")?,
    })
}
pub(crate) fn json_on_handle<'a>(row: &'a rusqlite::Row<'_>) -> Result<Cow<'a, str>, StoreError> {
    let header = row
        .get_ref("event_header")?
        .as_str_or_null()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                row.as_ref()
                    .column_index("event_header")
                    .expect("selected canonical header"),
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    let length = row.get("canonical_length")?;
    let reference: Option<i64> = row.get("canonical_body_reference")?;
    if reference.is_none() {
        return reconstruct(Fields {
            header,
            length,
            reference,
            offset: None,
            body: None,
            raw_bytes: None,
            payload: None,
        });
    }
    let payload = row
        .get_ref("canonical_payload")?
        .as_blob_or_null()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                row.as_ref()
                    .column_index("canonical_payload")
                    .expect("selected canonical body"),
                rusqlite::types::Type::Blob,
                Box::new(error),
            )
        })?;
    reconstruct(Fields {
        header,
        length,
        reference,
        offset: row.get("canonical_offset")?,
        body: row.get("canonical_body_id")?,
        raw_bytes: row.get("canonical_raw_bytes")?,
        payload,
    })
}
pub(crate) async fn one(
    connection: &mut sqlx::SqliteConnection,
    sequence: u64,
) -> Result<String, StoreError> {
    let row = sqlx::query(sqlx::AssertSqlSafe(format!(
        "SELECT e.event_header,{COLUMNS} FROM event_log e {JOINS} WHERE e.sequence=?"
    )))
    .bind(sequence as i64)
    .fetch_one(connection)
    .await?;
    Ok(json(&row)?.into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn corrupt_large_length_is_rejected_before_reserving_the_event() {
        let result = reconstruct(Fields {
            header: Some("null"),
            length: Some(i64::MAX),
            reference: Some(1),
            offset: Some(0),
            body: Some(1),
            raw_bytes: Some(i64::MAX),
            payload: Some(&[0; 8]),
        });
        let error = result.unwrap_err();
        assert!(
            error.to_string().contains("canonical body length changed"),
            "{error}"
        );
    }
    #[test]
    fn incomplete_joins_never_turn_into_inline_events() {
        let result = reconstruct(Fields {
            header: Some("null"),
            length: Some(4),
            reference: Some(1),
            offset: Some(0),
            body: None,
            raw_bytes: None,
            payload: None,
        });
        assert!(result.is_err());
        let result = reconstruct(Fields {
            header: None,
            length: None,
            reference: None,
            offset: None,
            body: None,
            raw_bytes: None,
            payload: None,
        });
        assert!(matches!(result, Err(StoreError::MaterialCollected)));
    }
}
