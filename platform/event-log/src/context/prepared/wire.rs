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

//! The second phase stores provider bytes only. Wire roots share unchanged
//! groups and tree paths; logical stats/media snapshots remain independently fixed.
use super::*;
use maka_agent_facts::model::prompt_source::{
    WireChunk, WireFormat, WireGroup, WireMetadata, WirePosition,
};

#[derive(Clone, Debug)]
pub struct PreparedWireBuild {
    pub(super) id: String,
    pub(super) view: PreparedView,
    pub format: WireFormat,
    pub codec: String,
    lease: lifetime::Lease,
}
#[derive(Clone, Debug)]
pub struct PreparedWireView {
    id: String,
    session: String,
    pub identity: String,
    pub message_count: usize,
    pub format: WireFormat,
    pub codec: String,
    root: Option<String>,
    lease: lifetime::Lease,
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct PreparedWireCursor {
    pub message_offset: usize,
    pub piece_index: usize,
}
pub struct PreparedWirePage {
    pub chunks: Vec<WireChunk>,
    pub next_cursor: Option<PreparedWireCursor>,
}
pub struct PreparedWireMetadataPage {
    pub items: Vec<WireMetadata>,
    pub next_cursor: Option<PreparedWireCursor>,
}

impl EventLog {
    pub async fn prepare_wire_view(
        &self,
        view: &PreparedView,
        format: WireFormat,
        codec: &str,
    ) -> Result<PreparedWireBuild, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.build_id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.selection.session)?;
        let view = view.clone();
        let codec = codec.to_owned();
        let registry = self.prepared.clone();
        let build=self.connection.run(move |connection| Box::pin(async move {
            let mut tx = connection.begin().await?;
            require_build_session(&mut tx, expected_session.as_deref(), &scope_id).await?;
            let exists: Option<String> = sqlx::query_scalar("SELECT id FROM context_prepared_wire_views WHERE build_id=? AND codec=? AND format_json=? AND retiring=0")
                .bind(&view.build_id).bind(&codec).bind(encoded(&format)?).fetch_optional(&mut *tx).await?;
            if let Some(id) = exists {
                let lease=registry.acquire("wire_view",&id,Some(view.lease.clone()))?;
                tx.commit().await?;
                return Ok(PreparedWireBuild {id,view,format,codec,lease});
            }
            let parent_id: Option<String> = sqlx::query_scalar("SELECT parent_id FROM context_prepared_builds WHERE id=? AND retiring=0").bind(&view.build_id).fetch_one(&mut *tx).await?;
            let previous = sqlx::query("SELECT w.root,b.root AS logical_root FROM context_prepared_wire_views w JOIN context_prepared_builds b ON b.id=w.build_id
                WHERE w.build_id=? AND w.codec=? AND w.format_json=? AND w.complete=1 AND w.retiring=0 AND b.retiring=0")
                .bind(parent_id).bind(&codec).bind(encoded(&format)?).fetch_optional(&mut *tx).await?;
            let warm=previous.is_some();
            let root:Option<String>=previous.as_ref().map(|row|row.try_get("root")).transpose()?.flatten();
            let old_logical:Option<String>=previous.as_ref().map(|row|row.try_get("logical_root")).transpose()?.flatten();
            let id=uuid::Uuid::new_v4().to_string();
            let lease=registry.acquire("wire_view",&id,Some(view.lease.clone()))?;
            sqlx::query("INSERT INTO context_prepared_wire_views(id,build_id,codec,format_json,root,discovery_json,discovery_root) VALUES(?,?,?,?,?,?,?)")
                .bind(&id).bind(&view.build_id).bind(&codec).bind(encoded(&format)?).bind(root).bind(encoded(&discovery::Wire::new(warm,old_logical.clone()))?).bind(old_logical).execute(&mut *tx).await?;
            tx.commit().await?;
            lease.wake();
            Ok(PreparedWireBuild{id,view,format,codec,lease})
        })).await?;
        loop {
            let chunk_build = build.clone();
            let ready = self
                .connection
                .run(move |connection| {
                    Box::pin(async move {
                        let mut tx = connection.begin().await?;
                        let ready = discovery::wire(&mut tx, &chunk_build).await?;
                        tx.commit().await?;
                        Ok(ready)
                    })
                })
                .await?;
            if ready {
                break;
            }
        }
        Ok(build)
    }
    pub async fn prepared_wire_dirty_groups(
        &self,
        build: &PreparedWireBuild,
        after: Option<&str>,
        limit: usize,
    ) -> Result<Vec<PreparedGroup>, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = build.id.clone();
        build.lease.validate(&self.prepared)?;
        self.check_bound_session(&build.view.selection.session)?;
        let lease = build.lease.clone();
        let id = build.id.clone();
        let after = after
            .map(str::parse::<i64>)
            .transpose()
            .map_err(|_| invalid("invalid wire group cursor"))?
            .unwrap_or(-1);
        if limit == 0 {
            return Err(invalid("wire group page limit must be positive"));
        }
        self.connection.read_interruptible(move |connection|Box::pin(async move {
            let mut scope_transaction = connection.begin().await?;
            let connection = &mut *scope_transaction;
            require_wire_session(connection, expected_session.as_deref(), &scope_id).await?;let _lease=lease;
            assembly::require_discovered(connection,assembly::Kind::Wire,&id).await?;
            let ids:Vec<i64>=sqlx::query_scalar("SELECT group_sequence FROM context_prepared_wire_dirty WHERE view_id=? AND group_sequence>? AND done=0 ORDER BY group_sequence LIMIT ?")
                .bind(id).bind(after).bind(limit.min(1024) as i64).fetch_all(connection).await?;
            Ok(ids.into_iter().map(|id|PreparedGroup{id:id.to_string()}).collect())
        })).await
    }
    pub async fn put_prepared_wire_group(
        &self,
        build: &PreparedWireBuild,
        group: &PreparedGroup,
        wire: WireGroup,
    ) -> Result<(), StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = build.id.clone();
        build.lease.validate(&self.prepared)?;
        self.check_bound_session(&build.view.selection.session)?;
        let build = build.clone();
        let sequence = group_number(group)?;
        if wire.codec != build.codec || wire.format != build.format {
            return Err(invalid("prepared wire codec does not match its view"));
        }
        self.connection.run(move |connection|Box::pin(async move {
            let mut tx=connection.begin().await?;
            require_wire_session(&mut tx, expected_session.as_deref(), &scope_id).await?;
            assembly::require_discovered(&mut tx,assembly::Kind::Wire,&build.id).await?;
            let dirty:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_wire_dirty WHERE view_id=? AND group_sequence=?)").bind(&build.id).bind(sequence as i64).fetch_one(&mut *tx).await?;
            if !dirty {return Err(invalid("wire group was not selected for encoding"));}
            let logical_content=tree::content_id(&mut tx,build.view.root.as_deref(),sequence).await?;
            let mut group=tree::group(&mut tx,&logical_content).await?;
            if wire.message_count!=group.messages.len(){return Err(invalid("wire group changed the logical message count"));}
            let stage=format!("pending:{}:{sequence}",build.id);
            sqlx::query("DELETE FROM context_prepared_chunks WHERE wire_id=?").bind(&stage).execute(&mut *tx).await?;
            let mut digest=Sha256::new();let mut previous_message=0usize;let mut wire_bytes=0usize;
            for (index,result) in wire.chunks.enumerate() {
                let chunk=result.map_err(|error|StoreError::InvalidTransition(format!("prepared wire encoding: {error}")))?;
                if chunk.bytes.len()>32*1024 || chunk.message_index>=wire.message_count || (index>0 && chunk.message_index<previous_message) {
                    return Err(invalid("invalid prepared wire fragment boundary"));
                }
                previous_message=chunk.message_index;
                let metadata=chunk.metadata.as_ref().map(encoded).transpose()?;
                wire_bytes=wire_bytes.saturating_add(chunk.bytes.len())
                    .saturating_add(metadata.as_ref().map_or(0, String::len)).saturating_add(512);
                digest.update((chunk.bytes.len() as u64).to_be_bytes());digest.update(&chunk.bytes);
                let descriptor=encoded(&(chunk.message_index,chunk.item_start,chunk.item_end,&metadata))?;
                digest.update((descriptor.len() as u64).to_be_bytes());digest.update(descriptor.as_bytes());
                sqlx::query("INSERT INTO context_prepared_chunks(wire_id,piece_index,message_index,item_start,item_end,metadata_json,bytes) VALUES(?,?,?,?,?,?,?)")
                    .bind(&stage).bind(index as i64).bind(chunk.message_index as i64).bind(chunk.item_start).bind(chunk.item_end).bind(metadata).bind(chunk.bytes).execute(&mut *tx).await?;
            }
            let wire_id=hex::encode(digest.finalize());
            sqlx::query("INSERT OR IGNORE INTO context_prepared_chunks SELECT ?,piece_index,message_index,item_start,item_end,metadata_json,bytes FROM context_prepared_chunks WHERE wire_id=?").bind(&wire_id).bind(&stage).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM context_prepared_chunks WHERE wire_id=?").bind(stage).execute(&mut *tx).await?;
            group.wire_id=Some(wire_id);group.wire_bytes=wire_bytes;
            let content=tree::save_group(&mut tx,&group).await?;
            assembly::stage(&mut tx,assembly::Kind::Wire,&build.id,sequence,&content).await?;
            tx.commit().await?;build.lease.wake();Ok(())
        })).await
    }
    pub async fn finish_prepared_wire(
        &self,
        build: &PreparedWireBuild,
    ) -> Result<PreparedWireView, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = build.id.clone();
        build.lease.validate(&self.prepared)?;
        self.check_bound_session(&build.view.selection.session)?;
        loop {
            let id = build.id.clone();
            let lease = build.lease.clone();
            let expected = expected_session.clone();
            let ready = self
                .connection
                .run(move |connection| {
                    Box::pin(async move {
                        let _lease = lease;
                        let mut tx = connection.begin().await?;
                        require_wire_session(&mut tx, expected.as_deref(), &id).await?;
                        let ready = assembly::advance(&mut tx, assembly::Kind::Wire, &id).await?;
                        tx.commit().await?;
                        Ok(ready)
                    })
                })
                .await?;
            if ready {
                break;
            }
        }
        let build = build.clone();
        self.connection.run(move |connection|Box::pin(async move {
            let mut tx=connection.begin().await?;
            require_wire_session(&mut tx, expected_session.as_deref(), &scope_id).await?;
            let pending:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM context_prepared_wire_dirty WHERE view_id=? AND done=0)").bind(&build.id).fetch_one(&mut *tx).await?;
            if pending {return Err(invalid("wire view has unencoded groups"));}
            let root:Option<String>=sqlx::query_scalar("SELECT root FROM context_prepared_wire_views WHERE id=?").bind(&build.id).fetch_one(&mut *tx).await?;
            let (count,breakdown)=tree::totals(&mut tx,root.as_deref()).await?;
            if count!=build.view.message_count || breakdown!=build.view.breakdown {return Err(invalid("wire view differs from logical snapshot"));}
            let first=sqlx::query("UPDATE context_prepared_wire_views SET complete=1 WHERE id=? AND complete=0").bind(&build.id).execute(&mut *tx).await?.rows_affected()>0;
            let identity=hash(encoded(&(&root,build.format,&build.codec))?.as_bytes());
            if first { let weight=tree::weight(&mut tx,root.as_deref()).await?;
            gc::publish_wire(&mut tx,&build.view.build_id,&build.id,weight).await?; }
            tx.commit().await?;build.lease.wake();Ok(PreparedWireView{id:build.id.clone(),session:build.view.selection.session.clone(),identity,message_count:count,format:build.format,codec:build.codec,root,lease:build.lease})
        })).await
    }
    pub async fn prepared_wire_page(
        &self,
        view: &PreparedWireView,
        cursor: PreparedWireCursor,
        limit: usize,
    ) -> Result<PreparedWirePage, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.session)?;
        if limit == 0 || cursor.message_offset > view.message_count {
            return Err(invalid("invalid prepared wire page"));
        }
        let view = view.clone();
        self.connection.read_interruptible(move |connection|Box::pin(async move {
            let mut scope_transaction = connection.begin().await?;
            let connection = &mut *scope_transaction;
            require_wire_session(connection, expected_session.as_deref(), &scope_id).await?;
            crate::connection::worker_query(connection,move |connection|Box::pin(async move {
            let _lease = view.lease;
            let mut cursor=cursor;let mut chunks=Vec::new();let limit=limit.min(128);
            let mut walk=tree::GroupWalk::at(connection,view.root.as_deref(),cursor.message_offset).await?;
            while chunks.len()<limit && cursor.message_offset<view.message_count {
                let (_,base,content,group_count)=walk.next_descriptor(connection).await?.ok_or_else(||invalid("wire cursor is outside its root"))?;
                let wire_id=wire_id(connection,&content).await?;
                let Some(piece)=starting_piece(connection,&wire_id,cursor.message_offset-base,cursor.piece_index,false).await? else {
                    cursor=PreparedWireCursor{message_offset:base+group_count,piece_index:0};continue;
                };
                cursor.piece_index=piece;
                let rows=sqlx::query("SELECT piece_index,message_index,item_start,item_end,metadata_json,bytes FROM context_prepared_chunks WHERE wire_id=? AND message_index>=? AND piece_index>=? ORDER BY piece_index LIMIT ?")
                    .bind(wire_id).bind((cursor.message_offset-base) as i64).bind(cursor.piece_index as i64).bind((limit-chunks.len()+1) as i64).fetch_all(&mut *connection).await?;
                if rows.is_empty() {cursor=PreparedWireCursor{message_offset:base+group_count,piece_index:0};continue;}
                let more=rows.len()>limit-chunks.len();
                for row in rows.into_iter().take(limit-chunks.len()) {
                    cursor.piece_index=row.try_get::<i64,_>("piece_index")? as usize+1;
                    let metadata:Option<String>=row.try_get("metadata_json")?;
                    chunks.push(WireChunk{bytes:row.try_get("bytes")?,item_start:row.try_get("item_start")?,item_end:row.try_get("item_end")?,message_index:base+row.try_get::<i64,_>("message_index")? as usize,metadata:metadata.map(|value|serde_json::from_str(&value)).transpose()?});
                }
                if more {break;}
                cursor=PreparedWireCursor{message_offset:base+group_count,piece_index:0};
            }
            Ok(PreparedWirePage{chunks,next_cursor:(cursor.message_offset<view.message_count).then_some(cursor)})
            })).await
        })).await
    }
    pub async fn prepared_wire_metadata_page(
        &self,
        view: &PreparedWireView,
        cursor: PreparedWireCursor,
        limit: usize,
    ) -> Result<PreparedWireMetadataPage, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.session)?;
        if limit == 0 || cursor.message_offset > view.message_count {
            return Err(invalid("invalid prepared metadata page"));
        }
        let view = view.clone();
        self.connection.read_interruptible(move |connection|Box::pin(async move {
            let mut scope_transaction = connection.begin().await?;
            let connection = &mut *scope_transaction;
            require_wire_session(connection, expected_session.as_deref(), &scope_id).await?;
            crate::connection::worker_query(connection,move |connection|Box::pin(async move {
            let _lease = view.lease;
            let mut cursor=cursor;let mut items=Vec::new();let limit=limit.min(256);
            let mut walk=tree::GroupWalk::at(connection,view.root.as_deref(),cursor.message_offset).await?;
            while items.len()<limit && cursor.message_offset<view.message_count {
                let (_,base,content,group_count)=walk.next_descriptor(connection).await?.ok_or_else(||invalid("metadata cursor is outside its root"))?;
                let wire_id=wire_id(connection,&content).await?;
                let Some(piece)=starting_piece(connection,&wire_id,cursor.message_offset-base,cursor.piece_index,true).await? else {
                    cursor=PreparedWireCursor{message_offset:base+group_count,piece_index:0};continue;
                };
                cursor.piece_index=piece;
                let rows=sqlx::query("SELECT piece_index,message_index,metadata_json FROM context_prepared_chunks INDEXED BY context_prepared_metadata_page WHERE wire_id=? AND message_index>=? AND piece_index>=? AND metadata_json IS NOT NULL ORDER BY piece_index LIMIT ?")
                    .bind(wire_id).bind((cursor.message_offset-base) as i64).bind(cursor.piece_index as i64).bind((limit-items.len()+1) as i64).fetch_all(&mut *connection).await?;
                if rows.is_empty() {cursor=PreparedWireCursor{message_offset:base+group_count,piece_index:0};continue;}
                let more=rows.len()>limit-items.len();
                for row in rows.into_iter().take(limit-items.len()) {
                    cursor.piece_index=row.try_get::<i64,_>("piece_index")? as usize+1;
                    items.push(WireMetadata{position:WirePosition{message_index:base+row.try_get::<i64,_>("message_index")? as usize,piece_index:row.try_get::<i64,_>("piece_index")? as usize},message_index:base+row.try_get::<i64,_>("message_index")? as usize,metadata:serde_json::from_str(row.try_get("metadata_json")?)?});
                }
                if more {break;}
                cursor=PreparedWireCursor{message_offset:base+group_count,piece_index:0};
            }
            Ok(PreparedWireMetadataPage{items,next_cursor:(cursor.message_offset<view.message_count).then_some(cursor)})
            })).await
        })).await
    }
    pub async fn prepared_wire_prefix_identity(
        &self,
        view: &PreparedWireView,
        count: usize,
    ) -> Result<Option<String>, StoreError> {
        self.validate_root()?;
        let expected_session = self.expected_session.clone();
        let scope_id = view.id.clone();
        view.lease.validate(&self.prepared)?;
        self.check_bound_session(&view.session)?;
        if count > view.message_count {
            return Err(invalid("wire prefix exceeds view"));
        }
        let view = view.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut scope_transaction = connection.begin().await?;
                    let connection = &mut *scope_transaction;
                    require_wire_session(connection, expected_session.as_deref(), &scope_id)
                        .await?;
                    let _lease = view.lease;
                    let prefix = tree::prefix(connection, view.root.as_deref(), count).await?;
                    Ok(Some(hash(
                        encoded(&(prefix, view.format, view.codec))?.as_bytes(),
                    )))
                })
            })
            .await
    }
}

/// An offset cursor first seeks the message index. Reading in piece order from
/// zero and filtering earlier messages would walk the skipped prefix's chunks.
async fn starting_piece(
    connection: &mut sqlx::sqlite::SqliteWorkerConnection<'_>,
    wire: &str,
    message: usize,
    piece: usize,
    metadata: bool,
) -> Result<Option<usize>, StoreError> {
    if piece != 0 || message == 0 {
        return Ok(Some(piece));
    }
    let query = if metadata {
        "SELECT piece_index FROM context_prepared_chunks INDEXED BY context_prepared_metadata_seek WHERE wire_id=? AND message_index>=? AND metadata_json IS NOT NULL ORDER BY message_index,piece_index LIMIT 1"
    } else {
        "SELECT piece_index FROM context_prepared_chunks INDEXED BY context_prepared_wire_seek WHERE wire_id=? AND message_index>=? ORDER BY message_index,piece_index LIMIT 1"
    };
    let value: Option<i64> = sqlx::query_scalar(query)
        .bind(wire)
        .bind(message as i64)
        .fetch_optional(connection)
        .await?;
    Ok(value.map(|piece| piece as usize))
}

/// Wire readers need no semantic members, resource manifest or per-message
/// counters. Extract only the immutable body address on the SQLite worker.
async fn wire_id(
    connection: &mut sqlx::sqlite::SqliteWorkerConnection<'_>,
    content: &str,
) -> Result<String, StoreError> {
    let id: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(group_json,'$.wire_id') FROM context_prepared_groups WHERE id=?",
    )
    .bind(content)
    .fetch_one(connection)
    .await?;
    id.ok_or_else(|| invalid("wire group has no body"))
}
