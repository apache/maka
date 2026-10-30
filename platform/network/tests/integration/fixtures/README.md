<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Local TLS fixtures

These certificates and the **public test-only** private key were generated for Maka's
loopback network tests with OpenSSL. They grant no access to any service. Never use
this key or CA outside tests. The CA private key and signing request were discarded.

The leaf certificate is valid from September 2026 for 7,300 days, with SANs
`localhost`, `127.0.0.1`, and `models.maka.invalid`. The tests inject this CA into
one reqwest client only; they never install it in the OS trust store. Separate
cases retain platform roots or request `wrong.maka.invalid` and require rejection.

The fixtures avoid an OpenSSL executable or a certificate-generation dependency
at test time, including on Windows. Regeneration requires a new local P-256 CA,
a P-256 leaf with `CA:FALSE` and `serverAuth`, signed with those SANs.
