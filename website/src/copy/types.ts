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

export type Locale = 'en' | 'zh-CN';

// One shape for both languages, so a section, claim or link added to one
// page cannot be forgotten on the other: the type checker refuses it.
export interface Copy {
  locale: Locale;
  langLabel: string;
  siteName: string;
  positioning: string;
  theme: { toDark: string; toLight: string };
  nav: {
    docs: string;
    downloads: string;
    benchmarks: string;
    community: string;
    security: string;
    asf: string;
    getMaka: string;
    // The narrow-screen menu that holds the links above.
    menu: string;
  };
  hero: {
    headline: [string, string, string];
    lede: string;
    nightly: string;
    source: string;
    fine: string;
    architecture: string;
  };
  scene: {
    events: Array<{
      tone: '' | 'mut' | 'warn' | 'ok' | 'dim' | 'dim ok';
      // The RuntimeEvent type, shown where the log tile explains the term.
      name: string;
      // What the hero card says instead of the type name.
      label: string;
      detail: string;
    }>;
    highWater: string;
    caption: string;
    formula: string;
  };
  measured: { h2: string; p: string };
  leaderboard: { h3: string; p: string; more: string; caption: string };
  paired: { h3: string; p: string; more: string; stat: string; statSmall: string };
  host: { h3: string; p: string; more: string; clients: string[]; core: string; coreSmall: string };
  log: { h3: string; p: string; more: string };
  get: {
    h3: string;
    p: string;
    nightly: { title: string; body: string; note: string };
    source: { title: string; body: string; note: string };
    releases: { title: string; body: string; note: string };
  };
  reads: {
    h2: string;
    p: string;
    blogLog: { cover: string; small: string; h3: string; meta: string };
    blogTools: { cover: string; small: string; h3: string; meta: string };
    nineArm: { cover: string; small: string; h3: string; meta: string };
    paired: { cover: string; small: string; h3: string; meta: string };
  };
  footer: {
    foundation: string;
    incubator: string;
    conduct: string;
    license: string;
    events: string;
    privacy: string;
    security: string;
    sponsorship: string;
    thanks: string;
    disclaimer: string;
    trademark: string;
  };
  downloads: {
    title: string;
    lede: string;
    onThisPage: string;
    copy: string;
    copied: string;
    status: {
      h3: string;
      release: { label: string; value: string; note: string };
      nightly: { label: string; value: string; note: string };
      source: { label: string; value: string; note: string };
    };
    releases: { h2: string; note: string; p: string; distNote: string };
    verify: { h2: string; p: string; keys: string; signature: string; checksum: string };
    nightly: { h2: string; note: string; p: string; windows: string };
    source: { h2: string; prerequisites: string[]; clone: string; build: string; after: string };
  };
}
