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

//! Successful TLS configuration reuse, independent of connection task custody.
use std::sync::Mutex;

/// One fixed TLS profile's resolved configuration. Request options, routing,
/// connection pools and executors are rebuilt independently for each client.
/// The first successful client supplies the snapshot; failed builds can retry.
/// Root certificates are refreshed when this policy-scoped cache is replaced.
#[derive(Default)]
pub struct TlsConfigCache(Mutex<Option<reqwest::tls::RustlsConfig>>);

impl TlsConfigCache {
    pub fn build(
        &self,
        builder: reqwest::ClientBuilder,
    ) -> Result<reqwest::Client, reqwest::Error> {
        let mut cached = self.0.lock().unwrap();
        if let Some(config) = &*cached {
            let config = config.clone();
            drop(cached);
            return builder.tls_backend_preconfigured(config).build();
        }
        let client = builder.build()?;
        *cached = client.rustls_config();
        Ok(client)
    }
}

#[cfg(test)]
mod tests;
