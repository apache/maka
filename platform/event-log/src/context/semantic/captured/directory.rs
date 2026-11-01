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
use super::super::directory::codec;
use super::*;
use maka_agent_facts::history::semantic::directory::*;
use maka_agent_facts::model::prompt_source::source::{
    JsonSource, SourceBytes, TextEncoding, TextSource,
};

struct Packed<B> {
    buffer: B,
    written: usize,
    read: usize,
    count: usize,
}
// The record prefix carries its exact byte length. Descriptor bytes are copied
// from SQLite directly into the caller's charged page allocation.
impl<B: SourceBuffer> Packed<B> {
    fn new(buffer: B) -> Self {
        Self {
            buffer,
            written: 0,
            read: 0,
            count: 0,
        }
    }
    fn push(&mut self, parts: &[&[u8]]) -> Result<bool, StoreError> {
        let bytes = parts.iter().try_fold(0usize, |sum, part| {
            sum.checked_add(part.len())
                .ok_or_else(|| invalid("directory record size overflow"))
        })?;
        let needed = bytes
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
        let target = &mut self.buffer.as_mut()[self.written..self.written + needed];
        target[..8].copy_from_slice(&(bytes as u64).to_le_bytes());
        let mut position = 8;
        for part in parts {
            target[position..position + part.len()].copy_from_slice(part);
            position += part.len();
        }
        self.written += needed;
        self.count += 1;
        Ok(true)
    }
    fn next(&mut self) -> Result<Option<&[u8]>, StoreError> {
        if self.read == self.written {
            return Ok(None);
        }
        let prefix = self
            .buffer
            .as_mut()
            .get(self.read..self.read + 8)
            .ok_or_else(|| invalid("incomplete directory record"))?;
        let len = usize::try_from(u64::from_le_bytes(
            prefix.try_into().expect("eight-byte length prefix"),
        ))
        .map_err(|_| invalid("directory record size overflow"))?;
        let start = self.read + 8;
        let end = start
            .checked_add(len)
            .filter(|end| *end <= self.written)
            .ok_or_else(|| invalid("incomplete directory record"))?;
        self.read = end;
        Ok(Some(&self.buffer.as_mut()[start..end]))
    }
}
const ROW_WORDS: usize = 13;
const ROW_HEADER_BYTES: usize = ROW_WORDS * 8;
fn push_row<B: SourceBuffer>(
    packed: &mut Packed<B>,
    metadata: [u64; 12],
    directory: &[u8],
    payload: &[u8],
) -> Result<bool, StoreError> {
    let mut header = [0u8; ROW_HEADER_BYTES];
    for (index, value) in metadata
        .into_iter()
        .chain(std::iter::once(directory.len() as u64))
        .enumerate()
    {
        header[index * 8..index * 8 + 8].copy_from_slice(&value.to_le_bytes());
    }
    packed.push(&[&header, directory, payload])
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
        let Some(record) = self.packed.next()? else {
            return Ok(None);
        };
        let header = record
            .get(..ROW_HEADER_BYTES)
            .ok_or_else(|| invalid("incomplete directory row header"))?;
        let words: [u64; ROW_WORDS] = std::array::from_fn(|index| {
            u64::from_le_bytes(
                header[index * 8..index * 8 + 8]
                    .try_into()
                    .expect("eight-byte directory field"),
            )
        });
        let directory_len = usize::try_from(words[12])
            .map_err(|_| invalid("directory length exceeds memory range"))?;
        let directory_end = ROW_HEADER_BYTES
            .checked_add(directory_len)
            .filter(|end| *end <= record.len())
            .ok_or_else(|| invalid("incomplete row descriptor"))?;
        let directory: RowDirectory = codec::decode(&record[ROW_HEADER_BYTES..directory_end])?;
        let payload_bytes = &record[directory_end..];
        let payload = if words[7] == 0 {
            if !payload_bytes.is_empty() {
                return Err(invalid("payload descriptor without backing"));
            }
            None
        } else {
            Some(codec::decode::<PayloadDirectory>(payload_bytes)?)
        };
        let key = RowPosition {
            source_sequence: words[8],
            item_index: words[9],
        };
        let backing = match words[7] {
            0 => None,
            1 => Some(Backing::Pieces {
                key,
                bytes: words[11],
            }),
            2 => Some(Backing::Canonical {
                key,
                offset: words[10],
                bytes: words[11],
            }),
            _ => return Err(invalid("invalid directory payload backing")),
        };
        if directory.payload().is_some() != backing.is_some() {
            return Err(invalid("directory payload presence differs from backing"));
        }
        Ok(Some(CapturedDirectoryRow {
            row: CapturedRow {
                domain: self.domain.clone(),
                rowid: i64::try_from(words[0])
                    .map_err(|_| invalid("directory rowid exceeds SQLite range"))?,
                id: RowPosition {
                    source_sequence: words[1],
                    item_index: words[2],
                },
                order: RowPosition {
                    source_sequence: words[3],
                    item_index: words[4],
                },
                revision: words[5],
                bytes: words[6],
                payload: backing,
            },
            directory,
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
        self.packed.next()?.map(codec::decode).transpose()
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
fn column_bytes<'row>(
    row: &'row rusqlite::Row<'_>,
    index: usize,
) -> Result<&'row [u8], StoreError> {
    row.get_ref(index)?.as_bytes().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Blob,
            Box::new(error),
        )
        .into()
    })
}
fn with_fragment<R>(
    raw: &RawConnection,
    key: RowPosition,
    use_fragment: impl FnOnce([u64; 5], &[u8]) -> Result<R, StoreError>,
) -> Result<R, StoreError> {
    let mut statement=raw.prepare("SELECT storage_kind,byte_offset,byte_len,payload_bytes,directory_bytes FROM context_semantic_fragments WHERE source_sequence=? AND source_index=?")?;
    let mut rows = statement.query(params![key.source_sequence as i64, key.item_index as i64])?;
    let row = rows.next()?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
    let kind: &str = row
        .get_ref(0)?
        .as_str()
        .map_err(|error| invalid(error.to_string()))?;
    let offset: Option<i64> = row.get(1)?;
    let len: Option<i64> = row.get(2)?;
    let bytes: i64 = row.get(3)?;
    if bytes <= 0 {
        return Err(invalid("typed fragment has no stored bytes"));
    }
    let source = super::super::source::SemanticPayloadSource::from_metadata(
        key.source_sequence as i64,
        key.item_index as i64,
        kind,
        offset,
        len,
    )?;
    let (tag, offset) = match source {
        super::super::source::SemanticPayloadSource::Pieces => (1, 0),
        super::super::source::SemanticPayloadSource::CanonicalToolProjection(span) => {
            if span.len() != bytes {
                return Err(invalid("canonical typed fragment length changed"));
            }
            (2, span.offset() as u64)
        }
        super::super::source::SemanticPayloadSource::CanonicalModelPart(span) => {
            if span.len() != bytes {
                return Err(invalid("canonical typed fragment length changed"));
            }
            (2, span.offset() as u64)
        }
    };
    use_fragment(
        [
            tag,
            key.source_sequence,
            key.item_index,
            offset,
            bytes as u64,
        ],
        column_bytes(row, 4)?,
    )
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
    let query=rows_query(true).replace("r.order_sequence=?11","?11 IS NULL").replace("?13 IS NULL","?15 IS NULL").replace("json_extract(?13,'$.base')","?15").replace("json_extract(?13,'$.current')","?16").replace("SELECT r.row_json FROM","SELECT r.rowid,r.source_sequence,r.source_index,r.revision,r.order_sequence,r.order_index,length(CAST(r.row_json AS BLOB)),r.directory_bytes FROM");
    let mut statement=raw.prepare(&query)?;
    let mut rows=statement.query(params![&selection.session,selection.after as i64,selection.through as i64,selection.captured_through as i64,selection.before.min(i64::MAX as u64) as i64,&selection.lineage,point.order.source_sequence as i64,point.order.item_index as i64,point.id.source_sequence as i64,point.id.item_index as i64,None::<i64>,i64::MAX,None::<i64>,selection.prior_unknown,selection.replay.as_ref().map(|r|r.base as i64),selection.replay.as_ref().map(|r|r.current.as_str())])?;
    let mut last=None;let mut more=false;
    while let Some(r)=rows.next()?{
        let encoded=column_bytes(r,7)?;
     let directory:RowDirectory=codec::decode(encoded)?;
     let id=RowPosition{source_sequence:crate::sequence_number(r.get(1)?)?,item_index:crate::sequence_number(r.get(2)?)?};
     let order=RowPosition{source_sequence:crate::sequence_number(r.get(4)?)?,item_index:crate::sequence_number(r.get(5)?)?};
     let mut metadata=[u64::try_from(r.get::<_,i64>(0)?).map_err(|_|invalid("negative directory rowid"))?,id.source_sequence,id.item_index,order.source_sequence,order.item_index,crate::sequence_number(r.get(3)?)?,crate::sequence_number(r.get(6)?)?,0,0,0,0,0];
     let pushed=match directory.payload() {
        Some(PartSource::Complete(key))=>with_fragment(raw,key,|fragment,payload|{metadata[7..12].copy_from_slice(&fragment);push_row(&mut packed,metadata,encoded,payload)})?,
        None=>push_row(&mut packed,metadata,encoded,&[])?,
     };
     if !pushed {more=true;break;}last=Some(SemanticCursor{order,id});
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
    let mut statement=raw.prepare("SELECT ordinal,directory_bytes FROM context_semantic_directory_children WHERE source_sequence=? AND source_index=? AND list_kind=? AND ordinal>? ORDER BY ordinal")?;
    let mut rows=statement.query(params![key.source_sequence as i64,key.item_index as i64,kind.as_str(),after.unwrap_or(-1)])?;
    let mut packed=Packed::new(buffer);let mut last=None;let mut more=false;
    while let Some(r)=rows.next()?{if !packed.push(&[column_bytes(r,1)?])?{more=true;break;}last=Some(crate::sequence_number(r.get(0)?)?);}
    Ok(ChildPage{packed,next:if more{last}else{None}})
   })})).await;let closed=tx.rollback().await;settle_read(result,closed)
  })).await
    }
}
