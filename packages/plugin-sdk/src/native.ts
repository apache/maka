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

// Generated from Rust runtime schemas. Run npm run schema:generate -w @maka-agent/plugin-sdk.
import { contracts } from './contracts.js';
import { configurations } from './configurations.js';

export const nativeImplementations = /* @__PURE__ */ ((): {
  label: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Label: typeof contracts.label };
  };
  locale: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Locale: typeof contracts.locale };
  };
  textReader: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Reader: typeof contracts.textReader };
  };
  textarea: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Textarea: typeof contracts.textarea };
  };
  markdown: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Markdown: typeof contracts.markdown };
  };
  markdownText: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { MarkdownText: typeof contracts.markdownText };
  };
  diff: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Diff: typeof contracts.diff };
  };
  sourceText: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { SourceText: typeof contracts.sourceText };
  };
  filePicker: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { FilePicker: typeof contracts.filePicker };
  };
  terminalView: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { TerminalView: typeof contracts.terminalView };
  };
  readingArea: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { ReadingArea: typeof contracts.readingArea };
  };
  rows: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Rows: typeof contracts.rows };
  };
  valueCheckpoint: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Checkpoint: typeof contracts.valueCheckpoint };
  };
  textFile: {
    implementation: string;
    configuration: {
      type: 'object';
      additionalProperties: false;
      properties: { path: { type: ['string', 'null']; minLength: 1 } };
      title: 'TextFileConfiguration';
      $schema: 'https://json-schema.org/draft/2020-12/schema';
    };
    exports: { TextFile: typeof contracts.textFile };
  };
  morphMark: {
    implementation: string;
    configuration: {
      type: 'object';
      additionalProperties: false;
      properties: {
        shapes: { type: 'array'; items: { $ref: '#/$defs/MorphShape' }; minItems: 2; maxItems: 2 };
        color: { $ref: '#/$defs/TerminalColor' };
        period: { type: 'integer'; format: 'uint32'; minimum: 1000; maximum: 60000 };
      };
      required: ['shapes', 'color', 'period'];
      title: 'MorphMarkConfiguration';
      $schema: 'https://json-schema.org/draft/2020-12/schema';
      $defs: {
        MorphShape: {
          type: 'object';
          additionalProperties: false;
          properties: {
            paths: {
              type: 'array';
              items: {
                type: 'array';
                items: {
                  type: 'array';
                  items: { type: 'number'; format: 'float' };
                  minItems: 2;
                  maxItems: 2;
                };
              };
              minItems: 1;
            };
            radius: { type: 'number'; format: 'float'; minimum: 0.01; maximum: 0.2 };
            miters: { type: 'array'; items: { type: 'integer'; format: 'uint'; minimum: 0 } };
            columns: { type: 'integer'; format: 'uint'; minimum: 32; maximum: 256 };
          };
          required: ['paths', 'radius', 'miters', 'columns'];
        };
        TerminalColor: {
          anyOf: [
            { type: 'integer'; format: 'uint32'; minimum: 0; maximum: 16777215 },
            { $ref: '#/$defs/TerminalNamedColor' },
          ];
          description: "Terminal colors retain the user's ANSI palette and default background.\nNumeric values are RGB; named values are emitted as terminal attributes.";
        };
        TerminalNamedColor: {
          type: 'string';
          enum: [
            'reset',
            'black',
            'red',
            'green',
            'yellow',
            'blue',
            'magenta',
            'cyan',
            'gray',
            'dark_gray',
            'light_red',
            'light_green',
            'light_yellow',
            'light_blue',
            'light_magenta',
            'light_cyan',
            'white',
          ];
        };
      };
    };
    exports: { MorphMark: typeof contracts.morphMark };
  };
  selectionMenu: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { SelectionMenu: typeof contracts.selectionMenu };
  };
  input: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { SecretInput: typeof contracts.secretInput; TextInput: typeof contracts.textInput };
  };
  terminalSurface: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Surface: typeof contracts.terminalSurface };
  };
  callerHistory: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: {
      DeploymentHistory: typeof contracts.callerHistory;
      History: typeof contracts.callerHistory;
    };
  };
  receiptReader: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Receipts: typeof contracts.receiptReader };
  };
  deploymentManager: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Management: typeof contracts.deploymentManager };
  };
  gateway: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: {};
  };
  uiDeploymentManager: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Management: typeof contracts.deploymentManager };
  };
  agent: {
    implementation: string;
    configuration: typeof configurations.agent;
    exports: { agent: typeof contracts.agent };
  };
  acpExecutor: {
    implementation: string;
    configuration: {
      type: 'object';
      additionalProperties: false;
      properties: {
        agent: { $ref: '#/$defs/AcpAgent' };
        permissions: {
          anyOf: [{ $ref: '#/$defs/Permissions' }, { type: 'null' }];
          description: 'Requested launch access, still subject to installation limits and consent.';
        };
      };
      required: ['agent'];
      title: 'AcpExecutorConfiguration';
      $schema: 'https://json-schema.org/draft/2020-12/schema';
      $defs: {
        AcpAgent: {
          type: 'object';
          additionalProperties: false;
          properties: {
            id: { type: 'string' };
            displayName: { type: 'string' };
            executable: { type: 'string' };
            args: { type: 'array'; items: { type: 'string' }; default: [] };
            env: {
              type: 'object';
              additionalProperties: { type: 'string' };
              description: "Ordinary launch settings only. Credentials belong to the agent's login store.";
              default: {};
            };
          };
          required: ['id', 'displayName', 'executable'];
        };
        Permissions: {
          type: 'object';
          additionalProperties: false;
          properties: {
            filesystem: { type: 'array'; items: { $ref: '#/$defs/Rule' } };
            network: { $ref: '#/$defs/Network' };
          };
          required: ['filesystem', 'network'];
        };
        Rule: {
          type: 'object';
          additionalProperties: false;
          properties: {
            path: { type: 'string' };
            scope: { $ref: '#/$defs/Scope' };
            access: { $ref: '#/$defs/Access' };
          };
          required: ['path', 'scope', 'access'];
          description: 'Paths have executor-native meaning. Validate and materialize them on the\nexecution host, never on a remote Desktop. This document alone grants nothing.';
        };
        Scope: { type: 'string'; enum: ['subtree', 'exact'] };
        Access: {
          type: 'string';
          enum: ['read', 'write', 'deny'];
          description: 'Equal-path conflict priority is different from authority breadth: deny wins.';
        };
        Network: {
          oneOf: [
            { type: 'string'; enum: ['denied', 'allowed'] },
            {
              type: 'object';
              properties: {
                restricted: {
                  type: 'object';
                  properties: {
                    destinations: {
                      type: 'array';
                      uniqueItems: true;
                      items: { $ref: '#/$defs/Destination' };
                    };
                  };
                  additionalProperties: false;
                  required: ['destinations'];
                };
              };
              required: ['restricted'];
              additionalProperties: false;
            },
          ];
        };
        Destination: {
          type: 'object';
          additionalProperties: false;
          properties: {
            host: { type: 'string'; minLength: 1; maxLength: 253 };
            port: { type: 'integer'; format: 'uint16'; minimum: 1; maximum: 65535 };
          };
          required: ['host', 'port'];
          description: 'Destination authority, independent of the upstream proxy used to reach it.\nA domain grant does not authorize its subdomains or other ports.';
        };
      };
    };
    exports: { executor: typeof contracts.executor; setup: typeof contracts.executorSetup };
  };
  workhub: {
    implementation: string;
    configuration: typeof configurations.workhub;
    exports: { agent: typeof contracts.agent; workhub: typeof contracts.workhubCoordinator };
  };
  workspaceComputer: {
    implementation: string;
    configuration: typeof configurations.workspaceComputer;
    exports: { computer: typeof contracts.workspaceComputer };
  };
  workspaceFiles: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { files: typeof contracts.workspaceFiles };
  };
  workspaceProcesses: {
    implementation: string;
    configuration: typeof configurations.workspaceProcesses;
    exports: {
      processes: typeof contracts.workspaceProcesses;
      terminal: typeof contracts.terminal;
    };
  };
  protocolProcesses: {
    implementation: string;
    configuration: typeof configurations.workspaceProcesses;
    exports: { protocol: typeof contracts.protocolProcesses };
  };
  uiAuthoring: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Authoring: typeof contracts.uiAuthoring };
  };
  workspaceWeb: {
    implementation: string;
    configuration: typeof configurations.workspaceWeb;
    exports: { web: typeof contracts.workspaceWeb };
  };
  workspaceJev: {
    implementation: string;
    configuration: typeof configurations.workspaceJev;
    exports: { jev: typeof contracts.workspaceJev };
  };
  skillLibrary: {
    implementation: string;
    configuration: typeof configurations.skillLibrary;
    exports: { skills: typeof contracts.skillLibrary };
  };
  skillOutcomes: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { Outcomes: typeof contracts.skillOutcomes };
  };
  questions: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { questions: typeof contracts.questions };
  };
  forms: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { forms: typeof contracts.forms };
  };
  settings: {
    implementation: string;
    configuration: {
      $schema: 'https://json-schema.org/draft/2020-12/schema';
      title: 'Configuration';
      type: 'object';
      properties: {
        locale: { type: 'string'; default: '' };
        workspaceLocations: {
          anyOf: [{ $ref: '#/$defs/Configuration' }, { type: 'null' }];
          default: null;
        };
      };
      additionalProperties: false;
      $defs: {
        Configuration: {
          type: 'object';
          properties: {
            agent: { type: 'string' };
            skills: { type: ['string', 'null'] };
            processes: { type: ['string', 'null'] };
          };
          additionalProperties: false;
          required: ['agent'];
        };
      };
    };
    exports: { Settings: typeof contracts.settings };
  };
  settingsAuthentication: {
    implementation: string;
    configuration: {
      $schema: 'https://json-schema.org/draft/2020-12/schema';
      title: 'Configuration';
      type: 'object';
      properties: {
        locale: { type: 'string'; default: '' };
        workspaceLocations: {
          anyOf: [{ $ref: '#/$defs/Configuration' }, { type: 'null' }];
          default: null;
        };
      };
      additionalProperties: false;
      $defs: {
        Configuration: {
          type: 'object';
          properties: {
            agent: { type: 'string' };
            skills: { type: ['string', 'null'] };
            processes: { type: ['string', 'null'] };
          };
          additionalProperties: false;
          required: ['agent'];
        };
      };
    };
    exports: { Authentication: typeof contracts.settingsAuthentication };
  };
  hostLogs: {
    implementation: string;
    configuration: { type: 'object'; properties: {}; required: []; additionalProperties: false };
    exports: { HostLogs: typeof contracts.hostLogs };
  };
  settingsSetup: {
    implementation: string;
    configuration: {
      $schema: 'https://json-schema.org/draft/2020-12/schema';
      title: 'Configuration';
      type: 'object';
      properties: {
        locale: { type: 'string'; default: '' };
        workspaceLocations: {
          anyOf: [{ $ref: '#/$defs/Configuration' }, { type: 'null' }];
          default: null;
        };
      };
      additionalProperties: false;
      $defs: {
        Configuration: {
          type: 'object';
          properties: {
            agent: { type: 'string' };
            skills: { type: ['string', 'null'] };
            processes: { type: ['string', 'null'] };
          };
          additionalProperties: false;
          required: ['agent'];
        };
      };
    };
    exports: { Setup: typeof contracts.settingsSetup };
  };
} => ({
  label: {
    implementation: 'maka.ui.label',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Label: contracts.label },
  },
  locale: {
    implementation: 'maka.ui.locale',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Locale: contracts.locale },
  },
  textReader: {
    implementation: 'maka.text.reader',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Reader: contracts.textReader },
  },
  textarea: {
    implementation: 'maka.ui.textarea',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Textarea: contracts.textarea },
  },
  markdown: {
    implementation: 'maka.ui.markdown',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Markdown: contracts.markdown },
  },
  markdownText: {
    implementation: 'maka.text.markdown.tui',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { MarkdownText: contracts.markdownText },
  },
  diff: {
    implementation: 'maka.ui.diff',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Diff: contracts.diff },
  },
  sourceText: {
    implementation: 'maka.ui.source',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { SourceText: contracts.sourceText },
  },
  filePicker: {
    implementation: 'maka.ui.file',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { FilePicker: contracts.filePicker },
  },
  terminalView: {
    implementation: 'maka.ui.terminal',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { TerminalView: contracts.terminalView },
  },
  readingArea: {
    implementation: 'maka.ui.reading',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { ReadingArea: contracts.readingArea },
  },
  rows: {
    implementation: 'maka.ui.rows',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Rows: contracts.rows },
  },
  valueCheckpoint: {
    implementation: 'maka.ui.checkpoint',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Checkpoint: contracts.valueCheckpoint },
  },
  textFile: {
    implementation: 'maka.ui.text-file',
    configuration: {
      type: 'object',
      additionalProperties: false,
      properties: { path: { type: ['string', 'null'], minLength: 1 } },
      title: 'TextFileConfiguration',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
    },
    exports: { TextFile: contracts.textFile },
  },
  morphMark: {
    implementation: 'maka.ui.morph-mark',
    configuration: {
      type: 'object',
      additionalProperties: false,
      properties: {
        shapes: { type: 'array', items: { $ref: '#/$defs/MorphShape' }, minItems: 2, maxItems: 2 },
        color: { $ref: '#/$defs/TerminalColor' },
        period: { type: 'integer', format: 'uint32', minimum: 1000, maximum: 60000 },
      },
      required: ['shapes', 'color', 'period'],
      title: 'MorphMarkConfiguration',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        MorphShape: {
          type: 'object',
          additionalProperties: false,
          properties: {
            paths: {
              type: 'array',
              items: {
                type: 'array',
                items: {
                  type: 'array',
                  items: { type: 'number', format: 'float' },
                  minItems: 2,
                  maxItems: 2,
                },
              },
              minItems: 1,
            },
            radius: { type: 'number', format: 'float', minimum: 0.01, maximum: 0.2 },
            miters: { type: 'array', items: { type: 'integer', format: 'uint', minimum: 0 } },
            columns: { type: 'integer', format: 'uint', minimum: 32, maximum: 256 },
          },
          required: ['paths', 'radius', 'miters', 'columns'],
        },
        TerminalColor: {
          anyOf: [
            { type: 'integer', format: 'uint32', minimum: 0, maximum: 16777215 },
            { $ref: '#/$defs/TerminalNamedColor' },
          ],
          description:
            "Terminal colors retain the user's ANSI palette and default background.\nNumeric values are RGB; named values are emitted as terminal attributes.",
        },
        TerminalNamedColor: {
          type: 'string',
          enum: [
            'reset',
            'black',
            'red',
            'green',
            'yellow',
            'blue',
            'magenta',
            'cyan',
            'gray',
            'dark_gray',
            'light_red',
            'light_green',
            'light_yellow',
            'light_blue',
            'light_magenta',
            'light_cyan',
            'white',
          ],
        },
      },
    },
    exports: { MorphMark: contracts.morphMark },
  },
  selectionMenu: {
    implementation: 'maka.ui.selection-menu',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { SelectionMenu: contracts.selectionMenu },
  },
  input: {
    implementation: 'maka.ui.input',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { SecretInput: contracts.secretInput, TextInput: contracts.textInput },
  },
  terminalSurface: {
    implementation: 'maka.ui.surface.tui',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Surface: contracts.terminalSurface },
  },
  callerHistory: {
    implementation: 'maka.operations.history',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { DeploymentHistory: contracts.callerHistory, History: contracts.callerHistory },
  },
  receiptReader: {
    implementation: 'maka.operations.receipts',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Receipts: contracts.receiptReader },
  },
  deploymentManager: {
    implementation: 'maka.application.management',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Management: contracts.deploymentManager },
  },
  gateway: {
    implementation: 'maka.application.gateway',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: {},
  },
  uiDeploymentManager: {
    implementation: 'maka.application.ui-management',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Management: contracts.deploymentManager },
  },
  agent: {
    implementation: 'maka.agent.api',
    configuration: configurations.agent,
    exports: { agent: contracts.agent },
  },
  acpExecutor: {
    implementation: 'maka.agent.acp',
    configuration: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agent: { $ref: '#/$defs/AcpAgent' },
        permissions: {
          anyOf: [{ $ref: '#/$defs/Permissions' }, { type: 'null' }],
          description: 'Requested launch access, still subject to installation limits and consent.',
        },
      },
      required: ['agent'],
      title: 'AcpExecutorConfiguration',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        AcpAgent: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            displayName: { type: 'string' },
            executable: { type: 'string' },
            args: { type: 'array', items: { type: 'string' }, default: [] },
            env: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description:
                "Ordinary launch settings only. Credentials belong to the agent's login store.",
              default: {},
            },
          },
          required: ['id', 'displayName', 'executable'],
        },
        Permissions: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filesystem: { type: 'array', items: { $ref: '#/$defs/Rule' } },
            network: { $ref: '#/$defs/Network' },
          },
          required: ['filesystem', 'network'],
        },
        Rule: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            scope: { $ref: '#/$defs/Scope' },
            access: { $ref: '#/$defs/Access' },
          },
          required: ['path', 'scope', 'access'],
          description:
            'Paths have executor-native meaning. Validate and materialize them on the\nexecution host, never on a remote Desktop. This document alone grants nothing.',
        },
        Scope: { type: 'string', enum: ['subtree', 'exact'] },
        Access: {
          type: 'string',
          enum: ['read', 'write', 'deny'],
          description:
            'Equal-path conflict priority is different from authority breadth: deny wins.',
        },
        Network: {
          oneOf: [
            { type: 'string', enum: ['denied', 'allowed'] },
            {
              type: 'object',
              properties: {
                restricted: {
                  type: 'object',
                  properties: {
                    destinations: {
                      type: 'array',
                      uniqueItems: true,
                      items: { $ref: '#/$defs/Destination' },
                    },
                  },
                  additionalProperties: false,
                  required: ['destinations'],
                },
              },
              required: ['restricted'],
              additionalProperties: false,
            },
          ],
        },
        Destination: {
          type: 'object',
          additionalProperties: false,
          properties: {
            host: { type: 'string', minLength: 1, maxLength: 253 },
            port: { type: 'integer', format: 'uint16', minimum: 1, maximum: 65535 },
          },
          required: ['host', 'port'],
          description:
            'Destination authority, independent of the upstream proxy used to reach it.\nA domain grant does not authorize its subdomains or other ports.',
        },
      },
    },
    exports: { executor: contracts.executor, setup: contracts.executorSetup },
  },
  workhub: {
    implementation: 'maka.workhub.api',
    configuration: configurations.workhub,
    exports: { agent: contracts.agent, workhub: contracts.workhubCoordinator },
  },
  workspaceComputer: {
    implementation: 'maka.workspace.computer',
    configuration: configurations.workspaceComputer,
    exports: { computer: contracts.workspaceComputer },
  },
  workspaceFiles: {
    implementation: 'maka.workspace.files',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { files: contracts.workspaceFiles },
  },
  workspaceProcesses: {
    implementation: 'maka.workspace.processes',
    configuration: configurations.workspaceProcesses,
    exports: { processes: contracts.workspaceProcesses, terminal: contracts.terminal },
  },
  protocolProcesses: {
    implementation: 'maka.workspace.protocol-processes',
    configuration: configurations.workspaceProcesses,
    exports: { protocol: contracts.protocolProcesses },
  },
  uiAuthoring: {
    implementation: 'maka.application.authoring',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Authoring: contracts.uiAuthoring },
  },
  workspaceWeb: {
    implementation: 'maka.workspace.web',
    configuration: configurations.workspaceWeb,
    exports: { web: contracts.workspaceWeb },
  },
  workspaceJev: {
    implementation: 'maka.workspace.jev',
    configuration: configurations.workspaceJev,
    exports: { jev: contracts.workspaceJev },
  },
  skillLibrary: {
    implementation: 'maka.skills.library',
    configuration: configurations.skillLibrary,
    exports: { skills: contracts.skillLibrary },
  },
  skillOutcomes: {
    implementation: 'maka.skills.outcomes',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { Outcomes: contracts.skillOutcomes },
  },
  questions: {
    implementation: 'maka.interactions.questions',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { questions: contracts.questions },
  },
  forms: {
    implementation: 'maka.interactions.forms',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { forms: contracts.forms },
  },
  settings: {
    implementation: 'maka.settings',
    configuration: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Configuration',
      type: 'object',
      properties: {
        locale: { type: 'string', default: '' },
        workspaceLocations: {
          anyOf: [{ $ref: '#/$defs/Configuration' }, { type: 'null' }],
          default: null,
        },
      },
      additionalProperties: false,
      $defs: {
        Configuration: {
          type: 'object',
          properties: {
            agent: { type: 'string' },
            skills: { type: ['string', 'null'] },
            processes: { type: ['string', 'null'] },
          },
          additionalProperties: false,
          required: ['agent'],
        },
      },
    },
    exports: { Settings: contracts.settings },
  },
  settingsAuthentication: {
    implementation: 'maka.settings.authentication',
    configuration: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Configuration',
      type: 'object',
      properties: {
        locale: { type: 'string', default: '' },
        workspaceLocations: {
          anyOf: [{ $ref: '#/$defs/Configuration' }, { type: 'null' }],
          default: null,
        },
      },
      additionalProperties: false,
      $defs: {
        Configuration: {
          type: 'object',
          properties: {
            agent: { type: 'string' },
            skills: { type: ['string', 'null'] },
            processes: { type: ['string', 'null'] },
          },
          additionalProperties: false,
          required: ['agent'],
        },
      },
    },
    exports: { Authentication: contracts.settingsAuthentication },
  },
  hostLogs: {
    implementation: 'maka.host.logs',
    configuration: { type: 'object', properties: {}, required: [], additionalProperties: false },
    exports: { HostLogs: contracts.hostLogs },
  },
  settingsSetup: {
    implementation: 'maka.settings.setup',
    configuration: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'Configuration',
      type: 'object',
      properties: {
        locale: { type: 'string', default: '' },
        workspaceLocations: {
          anyOf: [{ $ref: '#/$defs/Configuration' }, { type: 'null' }],
          default: null,
        },
      },
      additionalProperties: false,
      $defs: {
        Configuration: {
          type: 'object',
          properties: {
            agent: { type: 'string' },
            skills: { type: ['string', 'null'] },
            processes: { type: ['string', 'null'] },
          },
          additionalProperties: false,
          required: ['agent'],
        },
      },
    },
    exports: { Setup: contracts.settingsSetup },
  },
}))();
