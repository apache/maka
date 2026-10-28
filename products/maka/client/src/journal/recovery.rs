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

//! Recovery queries and indexes share the same durable eligibility predicates.
pub(super) const DRAFTS: &str = "SELECT context,reference,receipt,abandoned FROM operations WHERE domain=? AND deployment=? AND draft_owner=? AND json_type(context,'$.draft')='object' AND receipt IS NULL AND abandoned=0 ORDER BY rowid DESC";
pub(super) const UPLOADS: &str = "SELECT context,reference,receipt,abandoned FROM operations WHERE domain=? AND deployment=? AND draft_owner=? AND json_type(context,'$.upload')='object' AND upload_adopted=0 AND abandoned=0 ORDER BY rowid";
pub(super) const CONTROLS: &str = "SELECT context,reference,receipt,abandoned FROM operations WHERE domain=? AND deployment=? AND draft_owner IS NULL AND json_extract(context,'$.endpoint')='agent' AND json_extract(context,'$.method') IN (SELECT value FROM json_each(?)) AND json_type(context,'$.correlation')='object' AND CASE WHEN json_extract(context,'$.method')='stop' THEN json_type(context,'$.correlation.invocationId')='text' AND length(CAST(json_extract(context,'$.correlation.invocationId') AS BLOB)) > 0 AND json_extract(json_remove(context,'$.correlation.invocationId'),'$.correlation')=? WHEN json_extract(context,'$.method')='stopComputerApp' THEN json_type(context,'$.correlation.operationId')='text' AND length(CAST(json_extract(context,'$.correlation.operationId') AS BLOB)) > 0 AND json_extract(json_remove(context,'$.correlation.operationId'),'$.correlation')=? WHEN json_extract(context,'$.method')='respond' THEN json_type(context,'$.correlation.requestId')='text' AND length(CAST(json_extract(context,'$.correlation.requestId') AS BLOB)) > 0 AND json_extract(json_remove(context,'$.correlation.requestId'),'$.correlation')=? WHEN json_extract(context,'$.method') IN ('metadata','setCompactionPrompt') THEN json_type(context,'$.correlation.expectedRevision')='integer' AND json_extract(context,'$.correlation.expectedRevision') BETWEEN 1 AND 9007199254740991 AND json_extract(json_remove(context,'$.correlation.expectedRevision'),'$.correlation')=? WHEN json_extract(context,'$.method')='changeSession' THEN json_type(context,'$.correlation.expectedRevision')='integer' AND json_extract(context,'$.correlation.expectedRevision') BETWEEN 1 AND 9007199254740991 AND json_extract(context,'$.correlation.action') IN ('archive','restore','remove') AND json_extract(json_remove(context,'$.correlation.expectedRevision','$.correlation.action'),'$.correlation')=? WHEN json_extract(context,'$.method')='fork' THEN json_type(context,'$.correlation.expectedRevision')='integer' AND json_extract(context,'$.correlation.expectedRevision') BETWEEN 1 AND 9007199254740991 AND (json_type(context,'$.correlation.turnId')='null' OR (json_type(context,'$.correlation.turnId')='text' AND length(CAST(json_extract(context,'$.correlation.turnId') AS BLOB)) > 0)) AND json_extract(json_remove(context,'$.correlation.expectedRevision','$.correlation.turnId'),'$.correlation')=? ELSE json_extract(context,'$.correlation')=? END AND receipt IS NULL AND abandoned=0 ORDER BY rowid DESC";
pub(super) const TERMINALS: &str = "SELECT context,reference,receipt,abandoned FROM operations WHERE domain=? AND deployment=? AND draft_owner IS NULL AND json_extract(context,'$.endpoint')='terminal' AND json_extract(context,'$.sessionId')=? AND json_extract(context,'$.correlation')=? AND json_extract(context,'$.method') IN ('start','stop','control','release') AND (receipt IS NULL OR json_extract(receipt,'$.cleanup.kind')!='confirmed') AND abandoned=0 ORDER BY rowid DESC";
pub(super) const SETTINGS: &str = concat!(
    "SELECT context,reference,receipt,abandoned FROM operations WHERE domain=? AND deployment=? AND ",
    settings_owner_sql!(),
    " AND receipt IS NULL AND abandoned=0 ORDER BY rowid DESC"
);

pub(super) const INDEXES: [&str; 2] = [
    "CREATE INDEX IF NOT EXISTS operations_pending_uploads ON operations(domain,deployment,draft_owner) WHERE json_type(context,'$.upload')='object' AND upload_adopted=0 AND abandoned=0",
    "CREATE INDEX IF NOT EXISTS operations_pending_terminals ON operations(domain,deployment,json_extract(context,'$.sessionId')) WHERE draft_owner IS NULL AND json_extract(context,'$.endpoint')='terminal' AND json_extract(context,'$.method') IN ('start','stop','control','release') AND (receipt IS NULL OR json_extract(receipt,'$.cleanup.kind')!='confirmed') AND abandoned=0",
];

#[cfg(test)]
mod tests;
