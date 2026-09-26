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

use super::Collection;

/// Closed native controls; every message is supplied by the owning presenter.
#[derive(Clone)]
pub enum Control<M> {
    Query {
        state: Collection,
        label: String,
        placeholder: String,
    },
    Item {
        state: Collection,
        item: String,
        select: M,
        commit: Option<M>,
    },
    Destination {
        state: Collection,
        group: String,
    },
}
impl<M> Control<M> {
    pub fn map<N>(self, f: &dyn Fn(M) -> N) -> Control<N> {
        match self {
            Self::Query {
                state,
                label,
                placeholder,
            } => Control::Query {
                state,
                label,
                placeholder,
            },
            Self::Item {
                state,
                item,
                select,
                commit,
            } => Control::Item {
                state,
                item,
                select: f(select),
                commit: commit.map(f),
            },
            Self::Destination { state, group } => Control::Destination { state, group },
        }
    }
    pub fn state(&self) -> &Collection {
        match self {
            Self::Query { state, .. }
            | Self::Item { state, .. }
            | Self::Destination { state, .. } => state,
        }
    }
}
