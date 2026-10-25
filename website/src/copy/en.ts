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

import type { Copy } from './types';
export const incubatorDisclaimer =
  'Apache Maka is an effort undergoing incubation at The Apache Software Foundation (ASF), sponsored by the Apache Incubator PMC. Incubation is required of all newly accepted projects until a further review indicates that the infrastructure, communications, and decision-making process have stabilized in a manner consistent with other successful ASF projects. While incubation status is not necessarily a reflection of the completeness or stability of the code, it does indicate that the project has yet to be fully endorsed by the ASF.';

export const en: Copy = {
  locale: 'en',
  langLabel: 'EN',
  siteName: 'Apache Maka (Incubating)',
  positioning:
    'Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record of everything it did.',
  theme: {
    toDark: 'Switch to dark mode',
    toLight: 'Switch to light mode',
  },
  sceneAlt:
    'One turn of RuntimeEvents: the model speaks, runs a command, asks permission, you approve, it gets the result, edits a file, the turn ends.',
  nav: {
    docs: 'Docs',
    downloads: 'Downloads',
    community: 'Community',
    security: 'Security',
    asf: 'ASF',
    getMaka: 'Get Maka',
    menu: 'Menu',
  },
  hero: {
    headline: [
      'A high-performance agent workspace that ',
      'keeps a complete record',
      ' of everything it did.',
    ],
    lede: 'A native Rust CLI and TUI, with public plugin capabilities and recoverable records of model interactions and tool effects.',
    nightly: 'CLI distribution',
    source: 'Build from source',
    fine: 'Native previews are not ASF releases',
    architecture: 'Read the architecture',
  },
  scene: {
    events: [
      {
        tone: 'mut',
        name: 'Text',
        label: 'Model says',
        detail: '"I\'ll rerun the failing test."',
      },
      {
        tone: '',
        name: 'FunctionCall',
        label: 'Runs a command',
        detail: 'Shell · just test',
      },
      {
        tone: 'warn',
        name: 'permissionRequest',
        label: 'Asks permission',
        detail: 'leaves the sandbox',
      },
      {
        tone: 'ok',
        name: 'permissionDecision',
        label: 'You approve',
        detail: 'written to the log',
      },
      {
        tone: '',
        name: 'FunctionResponse',
        label: 'Gets the result',
        detail: 'exit 1 · pruned, kept',
      },
      {
        tone: 'dim',
        name: 'FunctionCall',
        label: 'Edits a file',
        detail: 'resume.rs',
      },
      {
        tone: 'dim ok',
        name: 'endInvocation',
        label: 'Turn ends',
        detail: 'run completed',
      },
    ],
    highWater: 'confirmed up to here',
    caption: 'one turn · seven RuntimeEvents · append-only',
    formula: 'State(t) = Project(Log[0…t])',
  },
  host: {
    h3: 'One Runtime Host',
    p: 'The CLI, TUI and plugins share one execution and permission boundary.',
    more: 'How the host works',
    clients: ['CLI / TUI', 'Plugins'],
    core: 'Runtime Host',
    coreSmall: 'owns execution',
  },
  log: {
    h3: 'The log is the runtime',
    p: 'Every message, tool call, permission decision and termination is an append-only RuntimeEvent. The UI, the next prompt and crash recovery are projections of that log, never the only copy.',
    more: 'Log Is the Runtime',
  },
  get: {
    h3: 'Get Maka',
    p: 'Three paths, kept separate on purpose.',
    nightly: {
      title: 'Native CLI distribution',
      body: 'A thin npm launcher selects the matching Rust executable.',
      note: 'Preview',
    },
    source: {
      title: 'Build from source',
      body: 'Clone the repository, then run just setup and just run.',
      note: 'APACHE-2.0',
    },
    releases: {
      title: 'Apache Releases',
      body: 'Maka has not made an Apache release yet. When one exists, the signed source archive is the release; installers are convenience artifacts.',
      note: 'KEYS · SHA-512 · .asc',
    },
  },
  footer: {
    foundation: 'Foundation',
    incubator: 'Incubator',
    conduct: 'Code of Conduct',
    license: 'License',
    events: 'Events',
    privacy: 'Privacy',
    security: 'Security',
    sponsorship: 'Sponsorship',
    thanks: 'Thanks',
    disclaimer: incubatorDisclaimer,
    trademark:
      'Copyright © 2026 The Apache Software Foundation, licensed under the Apache License, Version 2.0. Apache Maka, Apache Incubator, Apache and the Apache feather logo are trademarks of The Apache Software Foundation.',
  },
  downloads: {
    title: 'Downloads',
    lede: 'The signed source archive is the release. Everything else on this page is a convenience build, and says so.',
    onThisPage: 'On this page',
    copy: 'Copy',
    copied: 'Copied',
    status: {
      h3: 'Current status',
      release: {
        label: 'Apache release',
        value: 'None yet. The first one appears here after its vote.',
        note: 'NOT YET',
      },
      nightly: {
        label: 'Native CLI',
        value: 'Source-bound platform packages',
        note: 'Preview',
      },
      source: {
        label: 'Source',
        value: 'apache/maka on GitHub, Apache License 2.0.',
        note: 'APACHE-2.0',
      },
    },
    releases: {
      h2: 'Apache releases',
      note: 'NO APACHE RELEASE YET',
      p: 'Apache Maka (Incubating) has not made an Apache release. When the first one passes its vote, this section will list it: the source archive, its SHA-512 checksum and detached GPG signature from the ASF distribution directory, and the KEYS file the signature verifies against.',
      distNote: 'Until then the distribution directory does not exist:',
    },
    verify: {
      h2: 'Verify a release',
      p: 'Every Apache release is verified the same way, and every reviewer on the vote does this before voting.',
      keys: 'Step 1: Import the release managers’ keys',
      signature: 'Step 2: Check the signature',
      checksum: 'Step 3: Check the checksum',
    },
    nightly: {
      h2: 'Native CLI distribution',
      note: 'Preview software, not an ASF release',
      p: 'The Rust CLI is distributed as exact-version native platform packages. The npm launcher only selects and runs the executable; see the CLI distribution documentation for building and publishing.',
      windows: 'macOS arm64, Linux x64 (glibc), Windows x64.',
    },
    source: {
      h2: 'Build from source',
      prerequisites: [
        'Rust stable, Node.js 26, npm 12.2.1 and just.',
        'macOS needs Xcode Command Line Tools; Linux Computer Use needs the X11 development libraries.',
      ],
      clone: 'Step 1: Clone the repository',
      build: 'Step 2: Install and build every workspace',
      after: 'The contribution guide covers builds, validation and plugin development.',
    },
  },
  features: {
    h2: 'One native runtime',
    p: 'Execution, permissions and durable state belong to one Rust Runtime Host.',
  },
};
