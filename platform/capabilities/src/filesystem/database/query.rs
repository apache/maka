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

use super::{Cell, Error, Query, Table};
use rusqlite::{
    Connection, OpenFlags,
    fallible_iterator::FallibleIterator,
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit as SqlLimit,
    types::{ToSqlOutput, ValueRef},
};
use std::{path::Path, time::Duration};
use tokio_util::sync::CancellationToken;

/// Reads a trusted, already authorized pathname. The embedding must retain its
/// source grant and worker custody, and validate directory and sidecar access.
pub fn read(
    path: &Path,
    queries: Vec<Query>,
    cancelled: &CancellationToken,
    stopping: &CancellationToken,
) -> Result<Vec<Table>, Error> {
    if cancelled.is_cancelled() || stopping.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(failed)?;
    read_connection(connection, queries, cancelled, stopping)
}

fn read_connection(
    mut connection: Connection,
    queries: Vec<Query>,
    cancelled: &CancellationToken,
    stopping: &CancellationToken,
) -> Result<Vec<Table>, Error> {
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(failed)?;
    connection
        .pragma_update(None, "query_only", true)
        .map_err(failed)?;
    connection
        .pragma_update(None, "trusted_schema", false)
        .map_err(failed)?;
    connection
        .pragma_update(None, "temp_store", "FILE")
        .map_err(failed)?;
    connection
        .pragma_update(None, "cache_size", -2048)
        .map_err(failed)?;
    // Data shape uses SQLite's physical defaults. ATTACH remains forbidden.
    connection
        .set_limit(SqlLimit::SQLITE_LIMIT_ATTACHED, 0)
        .map_err(failed)?;
    let abort = cancelled.clone();
    let retired = stopping.clone();
    connection
        .progress_handler(
            1000,
            Some(move || abort.is_cancelled() || retired.is_cancelled()),
        )
        .map_err(failed)?;
    connection.execute_batch("BEGIN DEFERRED").map_err(failed)?;
    connection.authorizer(Some(authorize)).map_err(failed)?;
    let result = collect(&connection, queries, cancelled, stopping);
    // Closing the connection releases the read transaction even after a rejected
    // statement. Never send user SQL a COMMIT/ROLLBACK or control hook capability.
    let closed = connection.close().map_err(|(_, error)| failed(error));
    if cancelled.is_cancelled() || stopping.is_cancelled() {
        return Err(Error::Cancelled);
    }
    closed?;
    result
}
fn authorize(context: AuthContext<'_>) -> Authorization {
    use Authorization::{Allow, Deny};
    match context.action {
        // SQLite also reports statement-local CTE reads without a database name.
        // ATTACH and user-created temporary tables remain forbidden below.
        AuthAction::Read { .. } if matches!(context.database_name, None | Some("main")) => Allow,
        AuthAction::Select | AuthAction::Recursive => Allow,
        AuthAction::Function { function_name }
            if [
                "coalesce",
                "ifnull",
                "nullif",
                "length",
                "octet_length",
                "typeof",
                "lower",
                "upper",
                "trim",
                "ltrim",
                "rtrim",
                "substr",
                "substring",
                "instr",
                "like",
                "glob",
                "min",
                "max",
                "count",
                "sum",
                "total",
                "avg",
                "json_valid",
                "json_extract",
                "json_type",
                "json_array_length",
            ]
            .iter()
            .any(|name| function_name.eq_ignore_ascii_case(name)) =>
        {
            Allow
        }
        // Schema inspection is observational; arbitrary PRAGMA is not.
        AuthAction::Pragma { pragma_name, .. }
            if [
                "table_info",
                "table_xinfo",
                "table_list",
                "index_list",
                "index_info",
            ]
            .iter()
            .any(|name| pragma_name.eq_ignore_ascii_case(name)) =>
        {
            Allow
        }
        _ => Deny,
    }
}
fn collect(
    connection: &Connection,
    queries: Vec<Query>,
    cancelled: &CancellationToken,
    stopping: &CancellationToken,
) -> Result<Vec<Table>, Error> {
    let mut tables = Vec::new();
    for query in queries {
        if cancelled.is_cancelled() || stopping.is_cancelled() {
            return Err(Error::Cancelled);
        }
        // Batch rejects additional statements instead of silently executing a prefix.
        let mut statements = rusqlite::Batch::new(connection, &query.sql);
        let mut statement = statements
            .next()
            .map_err(failed)?
            .ok_or_else(|| Error::Invalid("empty statement".into()))?;
        if statements.next().map_err(failed)?.is_some() {
            return Err(Error::Invalid(
                "each query must contain one statement".into(),
            ));
        }
        if !statement.readonly() {
            return Err(Error::Invalid("statement is not a read-only query".into()));
        }
        let columns: Vec<String> = statement.column_names().map(String::from).collect();
        let parameters = query.parameters.iter().map(Parameter).collect::<Vec<_>>();
        let mut rows = statement
            .query(rusqlite::params_from_iter(parameters.iter()))
            .map_err(failed)?;
        let mut values = Vec::new();
        while let Some(row) = rows.next().map_err(failed)? {
            if cancelled.is_cancelled() || stopping.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let mut value = Vec::with_capacity(columns.len());
            for index in 0..columns.len() {
                let field = row.get_ref(index).map_err(failed)?;
                let cell = match field {
                    ValueRef::Null => Cell::Null,
                    ValueRef::Integer(value) => Cell::Integer(value),
                    ValueRef::Real(value) if value.is_finite() => Cell::Real(value),
                    ValueRef::Real(_) => {
                        return Err(Error::Invalid("non-finite database number".into()));
                    }
                    ValueRef::Text(bytes) => Cell::Text(
                        std::str::from_utf8(bytes)
                            .map_err(|_| Error::Invalid("database text is not UTF-8".into()))?
                            .into(),
                    ),
                    ValueRef::Blob(bytes) => Cell::Blob(bytes.into()),
                };
                value.push(cell);
            }
            values.push(value);
        }
        tables.push(Table {
            columns,
            rows: values,
        });
    }
    Ok(tables)
}
struct Parameter<'a>(&'a Cell);
impl rusqlite::ToSql for Parameter<'_> {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Borrowed(match self.0 {
            Cell::Null => ValueRef::Null,
            Cell::Integer(value) => ValueRef::Integer(*value),
            Cell::Real(value) => ValueRef::Real(*value),
            Cell::Text(value) => ValueRef::Text(value.as_bytes()),
            Cell::Blob(value) => ValueRef::Blob(value),
        }))
    }
}
fn failed(error: rusqlite::Error) -> Error {
    match error.sqlite_error_code() {
        Some(
            rusqlite::ErrorCode::AuthorizationForStatementDenied | rusqlite::ErrorCode::ReadOnly,
        ) => Error::Invalid("statement is not an allowed database read".into()),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            Error::Busy
        }
        _ => Error::Unavailable(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn query(sql: &str) -> Query {
        Query {
            sql: sql.into(),
            parameters: vec![],
        }
    }
    #[test]
    fn wal_snapshot_covers_the_batch_and_policy_denies_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("source.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE source(value INTEGER); INSERT INTO source VALUES(1)").unwrap();
        let reader = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let source = path.clone();
        // Deterministically commit a real second connection between batch reads.
        // Override an allowed builtin only in this test; production registers no
        // plugin-defined SQL functions or special test authorizer exceptions.
        reader
            .create_scalar_function(
                "length",
                1,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    let writer = Connection::open(&source)?;
                    writer.execute("UPDATE source SET value=2", [])?;
                    Ok(0_i64)
                },
            )
            .unwrap();
        let cancelled = CancellationToken::new();
        let retired = CancellationToken::new();
        let tables = read_connection(
            reader,
            vec![
                query("SELECT value FROM source"),
                query("SELECT length('advance writer')"),
                query("SELECT value, 9223372036854775807, x'00FF' FROM source"),
            ],
            &cancelled,
            &retired,
        )
        .unwrap();
        assert_eq!(tables[0].rows, [vec![Cell::Integer(1)]]);
        assert_eq!(
            tables[2].rows,
            [vec![
                Cell::Integer(1),
                Cell::Integer(i64::MAX),
                Cell::Blob(vec![0, 255])
            ]]
        );
        assert_eq!(
            serde_json::to_value(&tables[2]).unwrap()["rows"][0][1]["value"],
            "9223372036854775807"
        );
        assert_eq!(
            writer
                .query_row("SELECT value FROM source", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        for sql in [
            "UPDATE source SET value=3",
            "CREATE TEMP TABLE scratch(x)",
            "ATTACH DATABASE ':memory:' AS other",
            "PRAGMA query_only=OFF",
            "PRAGMA journal_mode=DELETE",
            "SELECT load_extension('outside')",
            "SELECT randomblob(8000000)",
            "SELECT zeroblob(9000000)",
            "SELECT printf('%0*d',9000000,0)",
            "SELECT 1; SELECT 2",
        ] {
            assert!(
                read(&path, vec![query(sql)], &cancelled, &retired).is_err(),
                "{sql}"
            );
        }
        let joined = read(&path, vec![query("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<35) SELECT value FROM source,n")], &cancelled, &retired).unwrap();
        assert_eq!(joined[0].rows.len(), 35);
        writer
            .execute_batch("CREATE TABLE oversized(payload BLOB)")
            .unwrap();
        writer
            .execute("INSERT INTO oversized VALUES(?1)", [vec![0_u8; 9_000_000]])
            .unwrap();
        let tables = read(
            &path,
            vec![query("SELECT payload FROM oversized")],
            &cancelled,
            &retired,
        )
        .unwrap();
        assert_eq!(tables[0].rows, [vec![Cell::Blob(vec![0; 9_000_000])]]);
        cancelled.cancel();
        assert!(matches!(
            read(&path, vec![query("SELECT 1")], &cancelled, &retired),
            Err(Error::Cancelled)
        ));
        assert_eq!(
            writer
                .query_row("SELECT value FROM source", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        writer
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .unwrap();
    }
    #[test]
    fn complete_request_preserves_many_queries_parameters_columns_and_large_text() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("complete.sqlite");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE source(value)")
            .unwrap();
        let original = "complete evidence 🦀\n".repeat(10000);
        let mut parameters = vec![Cell::Text(original.clone())];
        parameters.extend((2..=129).map(Cell::Integer));
        let mut queries = vec![Query {
            sql: format!(
                "SELECT {}",
                (1..=129)
                    .map(|index| format!("?{index}"))
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            parameters,
        }];
        queries.extend((1..=16).map(|value| query(&format!("SELECT {value}"))));
        let request = super::super::Read {
            path: path.to_string_lossy().into(),
            queries,
        };
        request.validate().unwrap();
        let tables = read(
            &path,
            request.queries,
            &CancellationToken::new(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(tables.len(), 17);
        assert_eq!(tables[0].columns.len(), 129);
        assert_eq!(tables[0].rows[0][0], Cell::Text(original));
        assert_eq!(tables[0].rows[0][128], Cell::Integer(129));
        assert_eq!(tables[16].rows, [vec![Cell::Integer(16)]]);
    }

    #[test]
    fn active_query_cancellation_and_stopping_release_the_snapshot() {
        use std::sync::{
            Arc,
            atomic::{AtomicI64, Ordering},
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory
            .path()
            .canonicalize()
            .unwrap()
            .join("cancel.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer
            .execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE source(value)")
            .unwrap();
        for stop_owner in [false, true] {
            let cancelled = CancellationToken::new();
            let stopping = CancellationToken::new();
            let abort = if stop_owner {
                stopping.clone()
            } else {
                cancelled.clone()
            };
            let visited = Arc::new(AtomicI64::new(0));
            let observed = visited.clone();
            let reader =
                Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
            reader
                .create_scalar_function(
                    "length",
                    1,
                    rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                    move |context| {
                        let value = context.get::<i64>(0)?;
                        observed.store(value, Ordering::Relaxed);
                        if value == 2000 {
                            abort.cancel();
                        }
                        Ok(value)
                    },
                )
                .unwrap();
            let result = read_connection(
                reader,
                vec![query(
                    "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT length(x+1) FROM n WHERE x<1000000) SELECT sum(x) FROM n",
                )],
                &cancelled,
                &stopping,
            );
            assert!(matches!(result, Err(Error::Cancelled)));
            let stopped_at = visited.load(Ordering::Relaxed);
            assert!(
                (2000..1000000).contains(&stopped_at),
                "progress hook did not stop the active query: {stopped_at}"
            );
            writer
                .execute(
                    "INSERT INTO source VALUES(?1)",
                    [if stop_owner { 2 } else { 1 }],
                )
                .unwrap();
            writer
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
                .unwrap();
        }
        assert_eq!(
            writer
                .query_row("SELECT sum(value) FROM source", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }
}
