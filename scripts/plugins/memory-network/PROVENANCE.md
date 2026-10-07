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

# Provenance

This plugin is developed in the Maka repository. Runtime tools, storage and prompt contributions use Maka's plugin APIs. Host additions are generic history-source registration/read APIs, a cheap durable Session history revision, and persistent background Agent Session creation. Maka history retains Recall privacy and revision-selection rules. No task scheduler or memory index logic is embedded in the Host.

The Host bundle is built with esbuild and includes Zod; the extension archive includes Maka's LICENSE/NOTICE and Zod's license. Test adapters bundle the repository source into ignored `.artifacts` files and are not part of the shipped Host plugin.
