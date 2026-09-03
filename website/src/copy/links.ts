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

// Every document the site points at stays authoritative where it lives. The
// site links; it does not copy.
const repo = 'https://github.com/apache/maka';
const main = `${repo}/blob/main`;

export const links = {
  repo,
  releases: `${repo}/releases`,
  discussions: `${repo}/discussions`,
  devList: 'https://lists.apache.org/list.html?dev@maka.apache.org',
  docs: `${main}/docs/README.md`,
  eval: `${repo}/tree/main/docs/eval`,
  nineArm: `${main}/docs/eval/terminal-bench-2.1-deepseek-v4-flash-nine-arm.md`,
  paired: `${main}/docs/eval/terminal-bench-2.1-deepseek-v4-flash-maka-vs-opencode.md`,
  security: `${main}/SECURITY.md`,
  windows: `${main}/docs/windows-support.md`,
  asf: 'https://www.apache.org/',
  incubator: 'https://incubator.apache.org/',
  conduct: 'https://www.apache.org/foundation/policies/conduct.html',
  license: 'https://www.apache.org/licenses/',
  events: 'https://www.apache.org/events/current-event.html',
  privacy: 'https://privacy.apache.org/policies/privacy-policy-public.html',
  asfSecurity: 'https://www.apache.org/security/',
  sponsorship: 'https://www.apache.org/foundation/sponsorship.html',
  thanks: 'https://www.apache.org/foundation/thanks.html',
  dist: 'https://downloads.apache.org/incubator/maka/',
};

// Documents that exist in both languages. The English file is the authority;
// the zh-CN file sits beside it with the same name and a `.zh-CN.md` suffix.
const bilingual = (path: string) => ({
  en: `${main}/${path}.md`,
  'zh-CN': `${main}/${path}.zh-CN.md`,
});

export const localized = {
  architecture: bilingual('ARCHITECTURE'),
  contributing: bilingual('CONTRIBUTING'),
  runtimeHost: bilingual('docs/architecture/runtime-host-architecture'),
  blogLog: bilingual('docs/blogs/log-is-the-runtime'),
  blogTools: bilingual('docs/blogs/beyond-function-calling'),
};
