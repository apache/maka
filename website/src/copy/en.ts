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

// The disclaimer is the first paragraph of DISCLAIMER-WIP word for word, so
// the site, the READMEs and the release file all state it the same way. It
// appears in English on every page, whatever the page language.
export const incubatorDisclaimer =
  'Apache Maka is an effort undergoing incubation at The Apache Software Foundation (ASF), sponsored by the Apache Incubator PMC. Incubation is required of all newly accepted projects until a further review indicates that the infrastructure, communications, and decision-making process have stabilized in a manner consistent with other successful ASF projects. While incubation status is not necessarily a reflection of the completeness or stability of the code, it does indicate that the project has yet to be fully endorsed by the ASF.';

export const en: Copy = {
  locale: 'en',
  langLabel: 'EN',
  siteName: 'Apache Maka (Incubating)',
  positioning:
    'Apache Maka (Incubating) is a high-performance agent workspace that keeps a complete record of everything it did.',
  theme: { toDark: 'Switch to dark mode', toLight: 'Switch to light mode' },
  nav: {
    docs: 'Docs',
    downloads: 'Downloads',
    benchmarks: 'Benchmarks',
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
    lede: 'An agent harness exists to finish tasks. We hold it to one measure: how many it completes and at what cost. We publish every run: same model, same official verifier, full per-task record.',
    nightly: 'Try Desktop Nightly',
    source: 'Build from source',
    fine: 'Nightly is a developer build, not an ASF release',
    architecture: 'Read the architecture',
  },
  scene: {
    events: [
      { tone: 'mut', name: 'Text', label: 'Model says', detail: '"I\'ll rerun the failing test."' },
      { tone: '', name: 'FunctionCall', label: 'Runs a command', detail: 'Bash · npm test' },
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
      { tone: 'dim', name: 'FunctionCall', label: 'Edits a file', detail: 'resume.ts' },
      { tone: 'dim ok', name: 'endInvocation', label: 'Turn ends', detail: 'run completed' },
    ],
    highWater: 'confirmed up to here',
    caption: 'one turn · seven RuntimeEvents · append-only',
    formula: 'State(t) = Project(Log[0…t])',
  },
  measured: {
    h2: 'Measured, not claimed. Recorded, not remembered.',
    p: 'Two things the site can prove today: where Maka stands against other harnesses on the same model, and what the runtime actually writes down while it works.',
  },
  leaderboard: {
    h3: 'Nine harnesses, one model, the official verifier',
    p: 'Terminal-Bench 2.1 on DeepSeek V4 Flash, every task, scored by the official verifier. The ranking is descriptive; the per-task CSV ships with the report.',
    more: 'Read the report',
    caption: 'pass@1 · reasoning max · Maka cost per pass $0.026',
  },
  paired: {
    h3: 'Head to head, same suite',
    p: 'A paired single run against OpenCode on the same tasks. The gap holds up under an exact McNemar test on this suite, and cost per accepted task came out about the same.',
    more: 'Read the paired report',
    stat: '+13.5',
    statSmall: 'pp · 68.5% vs 55.1%',
  },
  host: {
    h3: 'One Runtime Host',
    p: 'Desktop, TUI, CLI and Eval are thin clients of one execution authority.',
    more: 'How the host works',
    clients: ['Desktop', 'TUI / CLI', 'Eval'],
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
      title: 'Try Desktop Nightly',
      body: 'Daily builds from main for developers and testers, published on GitHub Releases. macOS on Apple Silicon and Intel; Windows and Linux are unsigned previews.',
      note: 'NOT AN ASF RELEASE · MAY BE UNSTABLE',
    },
    source: {
      title: 'Build from source',
      body: 'Clone apache/maka, then npm ci and npm run build. Desktop, TUI and CLI share one Runtime Host.',
      note: 'APACHE-2.0',
    },
    releases: {
      title: 'Apache Releases',
      body: 'Maka has not made an Apache release yet. When one exists, the signed source archive is the release; installers are convenience artifacts.',
      note: 'KEYS · SHA-512 · .asc',
    },
  },
  reads: {
    h2: 'Reports and writing',
    p: 'Everything the homepage claims links to a report or a document that owns the numbers.',
    blogLog: {
      cover: 'State(t) =\nProject(Log[0…t])',
      small: 'docs/blogs',
      h3: 'Log Is the Runtime',
      meta: 'Kun Li · English / 中文',
    },
    blogTools: {
      cover: 'Deferred\ntools',
      small: 'docs/blogs',
      h3: 'Beyond Function Calling: How Agents Reach the Real World',
      meta: 'Kun Li · English / 中文',
    },
    nineArm: {
      cover: '69 / 89',
      small: 'docs/eval · nine-arm',
      h3: 'Terminal-Bench 2.1, nine harnesses',
      meta: 'Report and per-task CSV',
    },
    paired: {
      cover: 'p = 0.0118',
      small: 'docs/eval · paired',
      h3: 'Maka vs OpenCode',
      meta: 'Report and per-task CSV',
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
        label: 'Desktop Nightly',
        value:
          'Daily from main. macOS arm64 and x64; Windows x64 and Linux x64 and arm64 as unsigned previews.',
        note: 'NOT AN ASF RELEASE',
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
      h2: 'Desktop Nightly',
      note: 'NOT AN ASF RELEASE',
      p: 'Desktop Nightly is built daily from main for developers and testers and published as a GitHub prerelease. Choose the newest Maka Desktop Nightly; after installation the app updates itself on the Nightly channel. It is not an ASF release and is not intended for production use. It ships for macOS on Apple Silicon and Intel, Windows x64, and Linux x64 and arm64.',
      windows: 'The Windows and Linux builds are unsigned previews, not a supported release tier.',
    },
    source: {
      h2: 'Build from source',
      prerequisites: [
        'Node.js 22.19 or newer',
        'npm 11',
        'Git',
        'ripgrep, which the Grep tool shells out to',
      ],
      clone: 'Step 1: Clone the repository',
      build: 'Step 2: Install and build every workspace',
      after:
        'CONTRIBUTING covers the workspace layout and how to start Desktop, the TUI and the CLI from that build.',
    },
  },
};
