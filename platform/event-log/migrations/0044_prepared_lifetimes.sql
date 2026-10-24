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

-- Prepared projections have no execution authority. New Hosts keep them in a
-- private temporary database with explicit live leases and bounded cache slots.
-- Removing the old cache never removes canonical facts or Session history.
DROP TABLE main.context_prepared_wire_dirty;
DROP TABLE main.context_prepared_dirty;
DROP TABLE main.context_prepared_wire_views;
DROP TABLE main.context_prepared_builds;
DROP TABLE main.context_prepared_nodes;
DROP TABLE main.context_prepared_groups;
DROP TABLE main.context_prepared_chunks;
DROP TABLE main.context_prepared_wire_groups;
DROP TABLE main.context_prepared_mcp_ids;
DROP TABLE main.context_prepared_mcp_refs;
DROP TABLE main.context_prepared_orphan_wires;
