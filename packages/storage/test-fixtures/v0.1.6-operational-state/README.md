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

# v0.1.6 operational state

`runtime.sqlite` was created through the public storage APIs at tag `v0.1.6` (`2e4c1aabf1f562e0aa0f817201e60ee22e84c3f8`). It contains one Session and user message, one Plan Reminder, and one durable cron Automation. SHA-256: `634d514c07df704b7f30794e5fd5aa53221b20e2833e036cdb166dfe663221e5`.

The source distribution stores this database as `runtime.sql`, a SQLite SQL dump of that exact historical fixture, including its `user_version=10`. Tests restore the dump into a temporary database before exercising current migration code. Foreign keys are disabled during import so table creation order does not matter, then enabled again. Keep the historical schema, version and rows intact; do not regenerate it through current storage APIs. The original binary SHA-256 above records provenance, not the byte layout of a restored database.
