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

//! Bounded pages of closed semantic records; every source stays under its capture.
use super::*;
use maka_agent_facts::history::semantic::directory::*;
use maka_agent_facts::model::prompt_source::source::{
    JsonSource, SourceBytes, TextEncoding, TextSource,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::io::{self, Write};

struct Packed<B> {
    buffer: B,
    written: usize,
    read: usize,
    count: usize,
}
struct Size(usize);
impl Write for Size {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .ok_or_else(|| io::Error::other("directory record size overflow"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl<B: SourceBuffer> Packed<B> {
    fn new(buffer: B) -> Self {
        Self {
            buffer,
            written: 0,
            read: 0,
            count: 0,
        }
    }
    fn push(&mut self, value: &impl Serialize) -> Result<bool, StoreError> {
        let mut size = Size(0);
        serde_json::to_writer(&mut size, value)?;
        let needed = size
            .0
            .checked_add(8)
            .ok_or_else(|| invalid("directory record size overflow"))?;
        if needed > self.buffer.as_mut().len().saturating_sub(self.written) {
            if self.count == 0 {
                return Err(invalid(
                    "directory page allocation cannot hold one descriptor",
                ));
            }
            return Ok(false);
        }
        let start = self.written;
        let end = start + needed;
        self.buffer.as_mut()[start..start + 8].copy_from_slice(&(size.0 as u64).to_le_bytes());
        serde_json::to_writer(&mut &mut self.buffer.as_mut()[start + 8..end], value)?;
        self.written = end;
        self.count += 1;
        Ok(true)
    }
    fn next<T: DeserializeOwned>(&mut self) -> Result<Option<T>, StoreError> {
        if self.read == self.written {
            return Ok(None);
        }
        let start = self.read;
        let mut len = [0; 8];
        len.copy_from_slice(&self.buffer.as_mut()[start..start + 8]);
        let end = start
            + 8
            + usize::try_from(u64::from_le_bytes(len))
                .map_err(|_| invalid("directory record size overflow"))?;
        let value = serde_json::from_slice(&self.buffer.as_mut()[start + 8..end])?;
        self.read = end;
        Ok(Some(value))
    }
}
#[derive(Serialize, Deserialize)]
enum FragmentStorage {
    Pieces,
    Canonical { offset: u64 },
}
#[derive(Serialize, Deserialize)]
struct FragmentRecord {
    key: RowPosition,
    storage: FragmentStorage,
    bytes: u64,
    directory: PayloadDirectory,
}
impl FragmentRecord {
    fn backing(&self) -> Backing {
        match self.storage {
            FragmentStorage::Pieces => Backing::Pieces {
                key: self.key,
                bytes: self.bytes,
            },
            FragmentStorage::Canonical { offset } => Backing::Canonical {
                key: self.key,
                offset,
                bytes: self.bytes,
            },
        }
    }
}
#[derive(Serialize, Deserialize)]
struct RowRecord {
    rowid: i64,
    id: RowPosition,
    order: RowPosition,
    revision: u64,
    bytes: u64,
    directory: RowDirectory,
    payload: Option<FragmentRecord>,
}
/// One finite row header and its complete payload's finite header, under the same source cut.
pub struct CapturedDirectoryRow {
    pub row: CapturedRow,
    pub directory: RowDirectory,
    pub payload: Option<PayloadDirectory>,
}
/// Metadata pages use only the supplied charged allocation.
pub struct DirectoryPage<B> {
    domain: Arc<Domain>,
    packed: Packed<B>,
    pub next: Option<SemanticCursor>,
}
impl<B: SourceBuffer> DirectoryPage<B> {
    pub fn len(&self) -> usize {
        self.packed.count
    }
    pub fn is_empty(&self) -> bool {
        self.packed.count == 0
    }
    pub fn into_buffer(self) -> B {
        self.packed.buffer
    }
    pub fn next_row(&mut self) -> Result<Option<CapturedDirectoryRow>, StoreError> {
        let Some(record) = self.packed.next::<RowRecord>()? else {
            return Ok(None);
        };
        let backing = match record.directory.payload() {
            Some(PartSource::Complete(_)) => Some(
                record
                    .payload
                    .as_ref()
                    .ok_or_else(|| invalid("complete row lacks typed payload"))?
                    .backing(),
            ),
            None => None,
        };
        let payload = record.payload.map(|p| p.directory);
        Ok(Some(CapturedDirectoryRow {
            row: CapturedRow {
                domain: self.domain.clone(),
                rowid: record.rowid,
                id: record.id,
                order: record.order,
                revision: record.revision,
                bytes: record.bytes,
                payload: backing,
            },
            directory: record.directory,
            payload,
        }))
    }
}
/// One bounded, ordered child-list page.
pub struct ChildPage<B> {
    packed: Packed<B>,
    pub next: Option<u64>,
}
impl<B: SourceBuffer> ChildPage<B> {
    pub fn next_child(&mut self) -> Result<Option<ChildDirectory>, StoreError> {
        self.packed.next()
    }
    pub fn into_buffer(self) -> B {
        self.packed.buffer
    }
    pub fn len(&self) -> usize {
        self.packed.count
    }
    pub fn is_empty(&self) -> bool {
        self.packed.count == 0
    }
}
fn column_text<'row>(row: &'row rusqlite::Row<'_>, index: usize) -> Result<&'row str, StoreError> {
    row.get_ref(index)?.as_str().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
        .into()
    })
}
fn fragment_record(raw: &RawConnection, key: RowPosition) -> Result<FragmentRecord, StoreError> {
    let mut statement=raw.prepare("SELECT storage_kind,byte_offset,byte_len,payload_bytes,directory_json FROM context_semantic_fragments WHERE source_sequence=? AND source_index=?")?;
    let mut rows = statement.query(params![key.source_sequence as i64, key.item_index as i64])?;
    let row = rows.next()?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let kind = column_text(row, 0)?;
    let offset: Option<i64> = row.get(1)?;
    let len: Option<i64> = row.get(2)?;
    let bytes: i64 = row.get(3)?;
    if bytes <= 0 {
        return Err(invalid("typed fragment has no stored bytes"));
    }
    let storage = match super::super::source::SemanticPayloadSource::from_metadata(
        key.source_sequence as i64,
        key.item_index as i64,
        kind,
        offset,
        len,
    )? {
        super::super::source::SemanticPayloadSource::Pieces => FragmentStorage::Pieces,
        super::super::source::SemanticPayloadSource::CanonicalToolProjection(span) => {
            if span.len() != bytes {
                return Err(invalid("canonical typed fragment length changed"));
            }
            FragmentStorage::Canonical {
                offset: span.offset() as u64,
            }
        }

        super::super::source::SemanticPayloadSource::CanonicalModelPart(span) => {
            if span.len() != bytes {
                return Err(invalid("canonical typed fragment length changed"));
            }
            FragmentStorage::Canonical {
                offset: span.offset() as u64,
            }
        }
    };
    Ok(FragmentRecord {
        key,
        storage,
        bytes: bytes as u64,
        directory: serde_json::from_str(column_text(row, 4)?)?,
    })
}

impl CapturedSource {
    /// Restore an original quoted token with its write-time decoded-content measure.
    pub fn text(&self, root: &PayloadSource, span: TextSpan) -> Result<TextSource, StoreError> {
        Ok(TextSource::measured(
            SourceBytes::Source(self.byte_range(root, span.range.start, span.range.len)?),
            TextEncoding::JsonString,
            span.measure,
        ))
    }
    /// Restore one opaque JSON token with its exact original-byte measure.
    pub fn json(&self, root: &PayloadSource, span: JsonSpan) -> Result<JsonSource, StoreError> {
        Ok(JsonSource::measured(
            SourceBytes::Source(self.byte_range(root, span.range.start, span.range.len)?),
            span.measure,
        ))
    }
    pub fn row_text(&self, row: &CapturedRow, span: TextSpan) -> Result<TextSource, StoreError> {
        self.text(&self.metadata_source(row)?, span)
    }
    /// Read finite headers without navigating row_json or payload bodies.
    pub async fn directory_page<B: SourceBuffer>(
        &self,
        cursor: Option<SemanticCursor>,
        buffer: B,
    ) -> Result<DirectoryPage<B>, StoreError> {
        let selection = self.0.selection.clone();
        let domain = self.0.domain.clone();
        self.0.log.connection.read(move|db|Box::pin(async move{
   available_at(db,&selection.session,selection.captured_through).await?;
   let mut tx=db.begin().await?;
   let result=crate::connection::worker_query(&mut tx,move|worker|Box::pin(async move{with_raw(worker,|raw|{
    let mut packed=Packed::new(buffer);
    let zero=RowPosition{source_sequence:0,item_index:0};let point=cursor.unwrap_or(SemanticCursor{order:zero,id:zero});
    let query=rows_query(true).replace("r.order_sequence=?11","?11 IS NULL").replace("?13 IS NULL","?15 IS NULL").replace("json_extract(?13,'$.base')","?15").replace("json_extract(?13,'$.current')","?16").replace("SELECT r.row_json FROM","SELECT r.rowid,r.source_sequence,r.source_index,r.revision,r.order_sequence,r.order_index,length(CAST(r.row_json AS BLOB)),r.directory_json FROM");
    let mut statement=raw.prepare(&query)?;
    let mut rows=statement.query(params![&selection.session,selection.after as i64,selection.through as i64,selection.captured_through as i64,selection.before.min(i64::MAX as u64) as i64,&selection.lineage,point.order.source_sequence as i64,point.order.item_index as i64,point.id.source_sequence as i64,point.id.item_index as i64,None::<i64>,i64::MAX,None::<i64>,selection.prior_unknown,selection.replay.as_ref().map(|r|r.base as i64),selection.replay.as_ref().map(|r|r.current.as_str())])?;
    let mut last=None;let mut more=false;
    while let Some(r)=rows.next()?{
     let directory:RowDirectory=serde_json::from_str(column_text(r,7)?)?;
     let payload=match directory.payload(){Some(PartSource::Complete(key))=>Some(fragment_record(raw,key)?),_=>None};
     let id=RowPosition{source_sequence:crate::sequence_number(r.get(1)?)?,item_index:crate::sequence_number(r.get(2)?)?};
     let order=RowPosition{source_sequence:crate::sequence_number(r.get(4)?)?,item_index:crate::sequence_number(r.get(5)?)?};
     let record=RowRecord{rowid:r.get(0)?,id,order,revision:crate::sequence_number(r.get(3)?)?,bytes:crate::sequence_number(r.get(6)?)?,directory,payload};
     if !packed.push(&record)?{more=true;break;}last=Some(SemanticCursor{order,id});
    }
    Ok(DirectoryPage{domain,packed,next:if more{last}else{None}})
   })})).await;
   let closed=tx.rollback().await;settle_read(result,closed)
  })).await
    }
    /// Seek a closed child list by ordinal; no per-leaf owner jobs are created.
    pub async fn child_page<B: SourceBuffer>(
        &self,
        root: &PayloadSource,
        kind: ListKind,
        after: Option<u64>,
        buffer: B,
    ) -> Result<ChildPage<B>, StoreError> {
        self.check(&root.domain)?;
        let key = match root.backing {
            Backing::Canonical { key, .. } | Backing::Pieces { key, .. } => key,
            _ => return Err(invalid("child list requires a complete payload")),
        };
        let after = after
            .map(i64::try_from)
            .transpose()
            .map_err(|_| invalid("directory ordinal exceeds SQLite range"))?;
        self.0.log.connection.read(move|db|Box::pin(async move{
   let mut tx=db.begin().await?;let result=crate::connection::worker_query(&mut tx,move|worker|Box::pin(async move{with_raw(worker,|raw|{
    let mut statement=raw.prepare("SELECT ordinal,directory_json FROM context_semantic_directory_children WHERE source_sequence=? AND source_index=? AND list_kind=? AND ordinal>? ORDER BY ordinal")?;
    let mut rows=statement.query(params![key.source_sequence as i64,key.item_index as i64,kind.as_str(),after.unwrap_or(-1)])?;
    let mut packed=Packed::new(buffer);let mut last=None;let mut more=false;
    while let Some(r)=rows.next()?{let child:ChildDirectory=serde_json::from_str(column_text(r,1)?)?;if !packed.push(&child)?{more=true;break;}last=Some(crate::sequence_number(r.get(0)?)?);}
    Ok(ChildPage{packed,next:if more{last}else{None}})
   })})).await;let closed=tx.rollback().await;settle_read(result,closed)
  })).await
    }
}
