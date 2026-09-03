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

export const PEER_MESH_MAX_MEMBERS = 64;
export const PEER_MESH_MAX_MESHES = 16;
export const PEER_MESH_MAX_PENDING_INVITATIONS = 32;
export const PEER_MESH_MAX_INVITATION_RECORDS = PEER_MESH_MAX_PENDING_INVITATIONS * 3;
export const PEER_MESH_MAX_ROUTE_HINTS = 16;
export const PEER_MESH_MAX_TRANSIT_RELAY_ADDRESSES = 256;
export const PEER_MESH_MAX_TRANSIT_ADDRESSES_PER_RELAY = 4;
export const PEER_MESH_MEMBER_ADVERTISEMENT_MAX_BYTES = 2 * 1024;
