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

CREATE TABLE connection_catalog (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL CHECK(revision >= 0),
    default_target TEXT
);
INSERT INTO connection_catalog VALUES(1, 0, NULL);
CREATE TABLE pricing_authority (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
    builtin_digest TEXT
);
INSERT INTO pricing_authority VALUES(1, 0, NULL);
CREATE TABLE pricing_overrides (
    model_key TEXT PRIMARY KEY,
    sort_key BLOB NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json))
);
CREATE TABLE connections (
    connection_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    document TEXT NOT NULL
);
CREATE TABLE credential_vault (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL CHECK(revision >= 0)
);
INSERT INTO credential_vault VALUES(1, 0);
CREATE TABLE credentials (
    locator TEXT PRIMARY KEY,
    credential_id TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    secret TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- A consumed or uncertain grant must not be exchanged again after a crash.
-- Replacement/logout deletes the generation; successful rotation clears the claim.
CREATE TABLE credential_refresh_claims (
    credential_id TEXT PRIMARY KEY REFERENCES credentials(credential_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0)
);

CREATE TABLE access_credentials (
    document TEXT NOT NULL CHECK(json_valid(document)),
    credential_id TEXT GENERATED ALWAYS AS (json_extract(document, '$.credentialId')) STORED NOT NULL UNIQUE,
    credential_hash TEXT GENERATED ALWAYS AS (json_extract(document, '$.credentialHash')) STORED NOT NULL UNIQUE
        CHECK(length(credential_hash) = 64)
);

CREATE TABLE runtime_policy (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    document TEXT NOT NULL CHECK(
        json_valid(document)
    )
);

-- Receipts survive logout/removal: they prove completion, not current authorization.
CREATE TABLE oauth_login_receipts (
    completion_order INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id TEXT NOT NULL UNIQUE CHECK(length(attempt_id) >= 1),
    target TEXT NOT NULL,
    method TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(json_valid(phase)),
    connection TEXT NOT NULL
);

CREATE TABLE plugin_credentials (
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    secret TEXT,
    PRIMARY KEY (package_id, scope_id, key)
) STRICT;

CREATE TABLE plugin_authorizations (
    id TEXT PRIMARY KEY NOT NULL,
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    document TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0, 1)),
    UNIQUE(package_id, scope_id, operation_id)
) STRICT;

CREATE TABLE public_catalog (
    source TEXT PRIMARY KEY NOT NULL CHECK(source IN ('models_dev', 'openrouter')),
    body TEXT NOT NULL CHECK(json_valid(body)),
    etag TEXT,
    last_modified TEXT,
    checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE project_mcp_trust (
    owner TEXT NOT NULL,
    workspace TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY (owner, workspace)
) STRICT;

PRAGMA user_version = 1;
