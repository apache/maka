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

use super::Error;

/// A single admitted refresh. It owns the provider instance until settlement.
pub struct RefreshCall {
    pub(super) implementation: std::sync::Arc<dyn super::Provider>,
    pub(super) connection: super::Connection,
    pub(super) credential: super::authentication::Credential,
}

impl RefreshCall {
    pub async fn run(
        self,
        context: super::Context,
    ) -> Result<super::authentication::Credential, Error> {
        let Self {
            implementation,
            connection,
            credential,
        } = self;
        let credential = implementation
            .refresh(connection, credential, context)
            .await?;
        credential.validate().map_err(Error::Invalid)?;
        Ok(credential)
    }
}
