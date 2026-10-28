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
export const configurations = {
  agent: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AgentConfiguration',
    type: 'object',
    properties: {
      mcpServers: {
        description: 'Explicitly trusted MCP servers. Catalogs are captured on Agent activation.',
        type: 'array',
        items: {
          $ref: '#/$defs/McpServerConfiguration',
        },
        default: [],
      },
      locale: {
        description: 'Deployment locale fallback; saved Root preference takes precedence.',
        type: 'string',
        default: '',
      },
      toolDiscovery: {
        description:
          'Defer optional tool schemas until the model discovers them. This affects\npresentation only; every call still uses its current authorized binding.',
        type: 'boolean',
        default: false,
      },
      isolatedWorkspaces: {
        description: 'Permit creation of Host-owned Git worktrees from published directories.',
        type: 'boolean',
        default: false,
      },
      assistant: {
        description: "Select Maka's assistant policy and workspace guidance explicitly.",
        anyOf: [
          {
            $ref: '#/$defs/AgentAssistantConfiguration',
          },
          {
            type: 'null',
          },
        ],
        default: null,
      },
      scheduledTasks: {
        description: 'Enable model proposals and approved scheduled work for this Agent.',
        type: 'boolean',
        default: false,
      },
      goals: {
        description: 'Enable explicitly approved, bounded Goal continuation.',
        type: 'boolean',
        default: false,
      },
      plans: {
        description: 'Enable planning, reviewed approval and execution progress.',
        type: 'boolean',
        default: false,
      },
      todo: {
        description: 'Enable the session-scoped, model-maintained checklist.',
        type: 'boolean',
        default: false,
      },
      automaticTitles: {
        description: 'Generate a bounded auxiliary title for automatically named conversations.',
        type: 'boolean',
        default: false,
      },
      recaps: {
        description: 'Enable explicit, bounded session recap requests and cached reads.',
        type: 'boolean',
        default: false,
      },
      recall: {
        description: 'Explicit access to this Agent’s earlier conversations for model tools.',
        type: 'boolean',
        default: false,
      },
      executors: {
        description: 'Explicit service backends; discovery does not authorize execution.',
        type: 'array',
        items: {
          $ref: '#/$defs/AgentServiceExecutor',
        },
      },
      skillLibrary: {
        description:
          'Explicit Library import for immutable skill input preparation and metadata.\nThis does not select model tools or confer a service grant.',
        type: ['string', 'null'],
        minLength: 1,
        default: null,
      },
      permissions: {
        description: 'Initial policy within the selected workspace capability.',
        $ref: '#/$defs/AgentWorkspacePermissions',
      },
      workspaceRoots: {
        description:
          'Installation-published directories, captured without creating workspace markers.',
        type: 'array',
        items: {
          $ref: '#/$defs/DirectoryRootSpec',
        },
      },
      importRoots: {
        description: 'Explicit read-only roots for user-selected conversation sources.',
        type: 'array',
        items: {
          $ref: '#/$defs/DirectoryRootSpec',
        },
        default: [],
      },
      tools: {
        description:
          'Explicitly selected, frozen application service tools, alongside configured native tools.',
        type: 'array',
        items: {
          $ref: '#/$defs/AgentServiceTool',
        },
      },
    },
    additionalProperties: false,
    required: ['permissions', 'workspaceRoots', 'tools'],
    $defs: {
      McpServerConfiguration: {
        description:
          'Explicit installation trust for an external MCP server. Tool annotations\nnever expand these permissions. Changes require reactivating the Agent.',
        type: 'object',
        properties: {
          name: {
            description: 'Stable namespace, using ASCII letters, digits, underscores and hyphens.',
            type: 'string',
          },
          transport: {
            $ref: '#/$defs/McpTransport',
          },
          tools: {
            description:
              'Omitted selects all tools discovered from this explicitly trusted server.',
            type: ['array', 'null'],
            items: {
              type: 'string',
            },
          },
          readOnlyTools: {
            description:
              "Explicitly permit these remote tools in read-only workspaces and plans.\nThe server's readOnlyHint is descriptive and cannot grant this access.",
            type: 'array',
            items: {
              type: 'string',
            },
            default: [],
          },
          preapproved: {
            description: 'Skip per-call confirmation only when the installer explicitly grants it.',
            type: 'boolean',
            default: false,
          },
          startupTimeoutMs: {
            type: 'integer',
            format: 'uint64',
            minimum: 0,
            default: 10000,
          },
          callTimeoutMs: {
            type: 'integer',
            format: 'uint64',
            minimum: 0,
            default: 120000,
          },
        },
        additionalProperties: false,
        required: ['name', 'transport'],
      },
      McpTransport: {
        oneOf: [
          {
            description:
              'Trusted installation process. Runs outside the session filesystem sandbox.',
            type: 'object',
            properties: {
              type: {
                type: 'string',
                const: 'stdio',
              },
              command: {
                type: 'string',
              },
              args: {
                type: 'array',
                items: {
                  type: 'string',
                },
                default: [],
              },
              cwd: {
                description:
                  'Absolute working directory, independent of model-controlled arguments.',
                type: 'string',
              },
              env: {
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
                default: {},
              },
              passEnv: {
                description: 'Environment variable names explicitly forwarded from the Host.',
                type: 'array',
                items: {
                  type: 'string',
                },
                default: [],
              },
            },
            additionalProperties: false,
            required: ['type', 'command', 'cwd'],
          },
          {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                const: 'streamable_http',
              },
              url: {
                type: 'string',
              },
              headers: {
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
                default: {},
              },
              headerEnv: {
                description:
                  'Header name to Host environment variable; keeps tokens out of config.',
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
                default: {},
              },
            },
            additionalProperties: false,
            required: ['type', 'url'],
          },
        ],
      },
      AgentAssistantConfiguration: {
        type: 'object',
        properties: {
          home: {
            description: 'Select this home for global instructions and explicit AGENTS.md editing.',
            type: ['string', 'null'],
            minLength: 1,
            default: null,
          },
        },
        additionalProperties: false,
      },
      AgentServiceExecutor: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            pattern: '^[a-zA-Z][a-zA-Z0-9._:-]*$',
          },
          import: {
            type: 'string',
            minLength: 1,
          },
          member: {
            description: 'Exact member of the explicitly bound import, never a discovery index.',
            type: 'integer',
            format: 'uint',
            minimum: 0,
            default: 0,
          },
          setup: {
            anyOf: [
              {
                $ref: '#/$defs/ExecutorSetupBinding',
              },
              {
                type: 'null',
              },
            ],
            default: null,
          },
        },
        additionalProperties: false,
        required: ['name', 'import'],
      },
      ExecutorSetupBinding: {
        type: 'object',
        properties: {
          import: {
            type: 'string',
            minLength: 1,
          },
          member: {
            type: 'integer',
            format: 'uint',
            minimum: 0,
            default: 0,
          },
        },
        additionalProperties: false,
        required: ['import'],
      },
      AgentWorkspacePermissions: {
        type: 'object',
        properties: {
          access: {
            $ref: '#/$defs/AgentWorkspaceAccess',
          },
          requestPermissions: {
            type: 'boolean',
          },
        },
        additionalProperties: false,
        required: ['access', 'requestPermissions'],
      },
      AgentWorkspaceAccess: {
        description:
          'Session sandbox policy. Full access explicitly disables filesystem and process isolation.',
        type: 'string',
        enum: ['read_only', 'workspace_write', 'danger_full_access'],
      },
      DirectoryRootSpec: {
        type: 'object',
        properties: {
          label: {
            type: 'string',
          },
          path: {
            type: 'string',
          },
        },
        additionalProperties: false,
        required: ['label', 'path'],
      },
      AgentServiceTool: {
        type: 'object',
        properties: {
          nestable: {
            description:
              'Allow this selected service inside Code Mode. Binding and permission\nchecks are identical to a direct call; omitted keeps direct-only behavior.',
            type: 'boolean',
          },
          input: {
            description:
              'Explicit input projection. Skill tools receive the actual Agent tool names,\noutside model-controlled arguments; this is compatibility data, not authority.',
            $ref: '#/$defs/AgentToolInput',
            default: 'json',
          },
          presentation: {
            description:
              'Explicit versioned renderer key, frozen with the call; never inferred from its name.',
            type: ['string', 'null'],
            minLength: 1,
            default: null,
          },
          title: {
            description:
              'Display only; the selected name, contract and binding still identify execution.',
            anyOf: [
              {
                $ref: '#/$defs/DisplayText',
              },
              {
                type: 'null',
              },
            ],
            default: null,
          },
          result: {
            description:
              'Explicit model projection; JSON data never implicitly grants image access.',
            $ref: '#/$defs/AgentToolResult',
          },
          confirmation: {
            description:
              'Additional user consent for this exact call; service grants remain independent.',
            $ref: '#/$defs/AgentToolConfirmation',
          },
          name: {
            type: 'string',
            minLength: 1,
          },
          description: {
            type: 'string',
            minLength: 1,
          },
          import: {
            type: 'string',
            minLength: 1,
          },
          method: {
            type: 'string',
            minLength: 1,
          },
        },
        additionalProperties: false,
        required: ['result', 'confirmation', 'name', 'description', 'import', 'method'],
      },
      AgentToolInput: {
        oneOf: [
          {
            type: 'string',
            enum: ['json', 'skill', 'web'],
          },
          {
            description:
              'Display-only command title; recorded in history, not forwarded to the process service.',
            type: 'string',
            const: 'shell',
          },
        ],
      },
      DisplayText: {
        description: 'Presentation text is distinct from the stable identity used for navigation.',
        type: 'object',
        properties: {
          fallback: {
            type: 'string',
          },
          translations: {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
            default: {},
          },
        },
        additionalProperties: false,
        required: ['fallback'],
      },
      AgentToolResult: {
        oneOf: [
          {
            type: 'string',
            enum: ['json', 'image'],
          },
          {
            description: 'Session-owned Computer REPL output, retained with its original receipt.',
            type: 'string',
            const: 'computer',
          },
        ],
      },
      AgentToolConfirmation: {
        type: 'string',
        enum: ['required', 'preapproved'],
      },
    },
  },
  acpExecutor: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'AcpExecutorConfiguration',
    type: 'object',
    properties: {
      agent: {
        $ref: '#/$defs/AcpAgent',
      },
      permissions: {
        description: 'Requested launch access, still subject to installation limits and consent.',
        anyOf: [
          {
            $ref: '#/$defs/Permissions',
          },
          {
            type: 'null',
          },
        ],
      },
    },
    additionalProperties: false,
    required: ['agent'],
    $defs: {
      AcpAgent: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
          },
          displayName: {
            type: 'string',
          },
          executable: {
            type: 'string',
          },
          args: {
            type: 'array',
            items: {
              type: 'string',
            },
            default: [],
          },
          env: {
            description:
              "Ordinary launch settings only. Credentials belong to the agent's login store.",
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
            default: {},
          },
        },
        additionalProperties: false,
        required: ['id', 'displayName', 'executable'],
      },
      Permissions: {
        type: 'object',
        properties: {
          filesystem: {
            type: 'array',
            items: {
              $ref: '#/$defs/Rule',
            },
          },
          network: {
            $ref: '#/$defs/Network',
          },
        },
        additionalProperties: false,
        required: ['filesystem', 'network'],
      },
      Rule: {
        description:
          'Paths have executor-native meaning. Validate and materialize them on the\nexecution host, never on a remote Desktop. This document alone grants nothing.',
        type: 'object',
        properties: {
          path: {
            type: 'string',
          },
          scope: {
            $ref: '#/$defs/Scope',
          },
          access: {
            $ref: '#/$defs/Access',
          },
        },
        additionalProperties: false,
        required: ['path', 'scope', 'access'],
      },
      Scope: {
        type: 'string',
        enum: ['subtree', 'exact'],
      },
      Access: {
        description: 'Equal-path conflict priority is different from authority breadth: deny wins.',
        type: 'string',
        enum: ['read', 'write', 'deny'],
      },
      Network: {
        oneOf: [
          {
            type: 'string',
            enum: ['denied', 'allowed'],
          },
          {
            type: 'object',
            properties: {
              restricted: {
                type: 'object',
                properties: {
                  destinations: {
                    type: 'array',
                    uniqueItems: true,
                    items: {
                      $ref: '#/$defs/Destination',
                    },
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
        description:
          'Destination authority, independent of the upstream proxy used to reach it.\nA domain grant does not authorize its subdomains or other ports.',
        type: 'object',
        properties: {
          host: {
            type: 'string',
            minLength: 1,
            maxLength: 253,
          },
          port: {
            type: 'integer',
            format: 'uint16',
            minimum: 1,
            maximum: 65535,
          },
        },
        additionalProperties: false,
        required: ['host', 'port'],
      },
    },
  },
  workhub: {
    type: 'object',
    additionalProperties: false,
    properties: {
      agent: {
        $ref: '#/$defs/AgentConfiguration',
      },
      workers: {
        type: 'array',
        items: {
          type: 'string',
        },
        description: 'Exactly selected imports of Agent services. Native grants are independent.',
        uniqueItems: true,
      },
    },
    required: ['agent', 'workers'],
    title: 'WorkHubConfiguration',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      AgentConfiguration: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mcpServers: {
            type: 'array',
            items: {
              $ref: '#/$defs/McpServerConfiguration',
            },
            description:
              'Explicitly trusted MCP servers. Catalogs are captured on Agent activation.',
            default: [],
          },
          locale: {
            type: 'string',
            description: 'Deployment locale fallback; saved Root preference takes precedence.',
            default: '',
          },
          toolDiscovery: {
            type: 'boolean',
            description:
              'Defer optional tool schemas until the model discovers them. This affects\npresentation only; every call still uses its current authorized binding.',
            default: false,
          },
          isolatedWorkspaces: {
            type: 'boolean',
            description: 'Permit creation of Host-owned Git worktrees from published directories.',
            default: false,
          },
          assistant: {
            anyOf: [
              {
                $ref: '#/$defs/AgentAssistantConfiguration',
              },
              {
                type: 'null',
              },
            ],
            description: "Select Maka's assistant policy and workspace guidance explicitly.",
            default: null,
          },
          scheduledTasks: {
            type: 'boolean',
            description: 'Enable model proposals and approved scheduled work for this Agent.',
            default: false,
          },
          goals: {
            type: 'boolean',
            description: 'Enable explicitly approved, bounded Goal continuation.',
            default: false,
          },
          plans: {
            type: 'boolean',
            description: 'Enable planning, reviewed approval and execution progress.',
            default: false,
          },
          todo: {
            type: 'boolean',
            description: 'Enable the session-scoped, model-maintained checklist.',
            default: false,
          },
          automaticTitles: {
            type: 'boolean',
            description:
              'Generate a bounded auxiliary title for automatically named conversations.',
            default: false,
          },
          recaps: {
            type: 'boolean',
            description: 'Enable explicit, bounded session recap requests and cached reads.',
            default: false,
          },
          recall: {
            type: 'boolean',
            description: 'Explicit access to this Agent’s earlier conversations for model tools.',
            default: false,
          },
          executors: {
            type: 'array',
            items: {
              $ref: '#/$defs/AgentServiceExecutor',
            },
            description: 'Explicit service backends; discovery does not authorize execution.',
          },
          skillLibrary: {
            type: ['string', 'null'],
            description:
              'Explicit Library import for immutable skill input preparation and metadata.\nThis does not select model tools or confer a service grant.',
            minLength: 1,
            default: null,
          },
          permissions: {
            $ref: '#/$defs/AgentWorkspacePermissions',
            description: 'Initial policy within the selected workspace capability.',
          },
          workspaceRoots: {
            type: 'array',
            items: {
              $ref: '#/$defs/DirectoryRootSpec',
            },
            description:
              'Installation-published directories, captured without creating workspace markers.',
          },
          importRoots: {
            type: 'array',
            items: {
              $ref: '#/$defs/DirectoryRootSpec',
            },
            description: 'Explicit read-only roots for user-selected conversation sources.',
            default: [],
          },
          tools: {
            type: 'array',
            items: {
              $ref: '#/$defs/AgentServiceTool',
            },
            description:
              'Explicitly selected, frozen application service tools, alongside configured native tools.',
          },
        },
        required: ['permissions', 'workspaceRoots', 'tools'],
      },
      McpServerConfiguration: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'Stable namespace, using ASCII letters, digits, underscores and hyphens.',
          },
          transport: {
            $ref: '#/$defs/McpTransport',
          },
          tools: {
            type: ['array', 'null'],
            items: {
              type: 'string',
            },
            description:
              'Omitted selects all tools discovered from this explicitly trusted server.',
          },
          readOnlyTools: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              "Explicitly permit these remote tools in read-only workspaces and plans.\nThe server's readOnlyHint is descriptive and cannot grant this access.",
            default: [],
          },
          preapproved: {
            type: 'boolean',
            description: 'Skip per-call confirmation only when the installer explicitly grants it.',
            default: false,
          },
          startupTimeoutMs: {
            type: 'integer',
            format: 'uint64',
            minimum: 0,
            default: 10000,
          },
          callTimeoutMs: {
            type: 'integer',
            format: 'uint64',
            minimum: 0,
            default: 120000,
          },
        },
        required: ['name', 'transport'],
        description:
          'Explicit installation trust for an external MCP server. Tool annotations\nnever expand these permissions. Changes require reactivating the Agent.',
      },
      McpTransport: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                const: 'stdio',
              },
              command: {
                type: 'string',
              },
              args: {
                type: 'array',
                items: {
                  type: 'string',
                },
                default: [],
              },
              cwd: {
                type: 'string',
                description:
                  'Absolute working directory, independent of model-controlled arguments.',
              },
              env: {
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
                default: {},
              },
              passEnv: {
                type: 'array',
                items: {
                  type: 'string',
                },
                description: 'Environment variable names explicitly forwarded from the Host.',
                default: [],
              },
            },
            required: ['type', 'command', 'cwd'],
            description:
              'Trusted installation process. Runs outside the session filesystem sandbox.',
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              type: {
                type: 'string',
                const: 'streamable_http',
              },
              url: {
                type: 'string',
              },
              headers: {
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
                default: {},
              },
              headerEnv: {
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
                description:
                  'Header name to Host environment variable; keeps tokens out of config.',
                default: {},
              },
            },
            required: ['type', 'url'],
          },
        ],
      },
      AgentAssistantConfiguration: {
        type: 'object',
        additionalProperties: false,
        properties: {
          home: {
            type: ['string', 'null'],
            description: 'Select this home for global instructions and explicit AGENTS.md editing.',
            minLength: 1,
            default: null,
          },
        },
      },
      AgentServiceExecutor: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            pattern: '^[a-zA-Z][a-zA-Z0-9._:-]*$',
          },
          import: {
            type: 'string',
            minLength: 1,
          },
          member: {
            type: 'integer',
            format: 'uint',
            minimum: 0,
            description: 'Exact member of the explicitly bound import, never a discovery index.',
            default: 0,
          },
          setup: {
            anyOf: [
              {
                $ref: '#/$defs/ExecutorSetupBinding',
              },
              {
                type: 'null',
              },
            ],
            default: null,
          },
        },
        required: ['name', 'import'],
      },
      ExecutorSetupBinding: {
        type: 'object',
        additionalProperties: false,
        properties: {
          import: {
            type: 'string',
            minLength: 1,
          },
          member: {
            type: 'integer',
            format: 'uint',
            minimum: 0,
            default: 0,
          },
        },
        required: ['import'],
      },
      AgentWorkspacePermissions: {
        type: 'object',
        additionalProperties: false,
        properties: {
          access: {
            $ref: '#/$defs/AgentWorkspaceAccess',
          },
          requestPermissions: {
            type: 'boolean',
          },
        },
        required: ['access', 'requestPermissions'],
      },
      AgentWorkspaceAccess: {
        type: 'string',
        enum: ['read_only', 'workspace_write', 'danger_full_access'],
        description:
          'Session sandbox policy. Full access explicitly disables filesystem and process isolation.',
      },
      DirectoryRootSpec: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: {
            type: 'string',
          },
          path: {
            type: 'string',
          },
        },
        required: ['label', 'path'],
      },
      AgentServiceTool: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nestable: {
            type: 'boolean',
            description:
              'Allow this selected service inside Code Mode. Binding and permission\nchecks are identical to a direct call; omitted keeps direct-only behavior.',
          },
          input: {
            $ref: '#/$defs/AgentToolInput',
            description:
              'Explicit input projection. Skill tools receive the actual Agent tool names,\noutside model-controlled arguments; this is compatibility data, not authority.',
            default: 'json',
          },
          presentation: {
            type: ['string', 'null'],
            description:
              'Explicit versioned renderer key, frozen with the call; never inferred from its name.',
            minLength: 1,
            default: null,
          },
          title: {
            anyOf: [
              {
                $ref: '#/$defs/DisplayText',
              },
              {
                type: 'null',
              },
            ],
            description:
              'Display only; the selected name, contract and binding still identify execution.',
            default: null,
          },
          result: {
            $ref: '#/$defs/AgentToolResult',
            description:
              'Explicit model projection; JSON data never implicitly grants image access.',
          },
          confirmation: {
            $ref: '#/$defs/AgentToolConfirmation',
            description:
              'Additional user consent for this exact call; service grants remain independent.',
          },
          name: {
            type: 'string',
            minLength: 1,
          },
          description: {
            type: 'string',
            minLength: 1,
          },
          import: {
            type: 'string',
            minLength: 1,
          },
          method: {
            type: 'string',
            minLength: 1,
          },
        },
        required: ['result', 'confirmation', 'name', 'description', 'import', 'method'],
      },
      AgentToolInput: {
        oneOf: [
          {
            type: 'string',
            enum: ['json', 'skill', 'web'],
          },
          {
            type: 'string',
            const: 'shell',
            description:
              'Display-only command title; recorded in history, not forwarded to the process service.',
          },
        ],
      },
      DisplayText: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fallback: {
            type: 'string',
          },
          translations: {
            type: 'object',
            additionalProperties: {
              type: 'string',
            },
            default: {},
          },
        },
        required: ['fallback'],
        description: 'Presentation text is distinct from the stable identity used for navigation.',
      },
      AgentToolResult: {
        oneOf: [
          {
            type: 'string',
            enum: ['json', 'image'],
          },
          {
            type: 'string',
            const: 'computer',
            description: 'Session-owned Computer REPL output, retained with its original receipt.',
          },
        ],
      },
      AgentToolConfirmation: {
        type: 'string',
        enum: ['required', 'preapproved'],
      },
    },
  },
  skillLibrary: {
    type: 'object',
    additionalProperties: false,
    properties: {
      home: {
        type: ['string', 'null'],
        description:
          'Explicit user root; only its standard .maka/skills and .agents/skills collections are scanned.',
        minLength: 1,
      },
      projectRoots: {
        type: 'array',
        items: {
          $ref: '#/$defs/DirectoryRootSpec',
        },
        description:
          "Explicit ceilings for a request's selected project. An observation grants no access.",
        default: [],
      },
      bundled: {
        type: 'boolean',
        description:
          'Include the immutable skill instructions and resources shipped with this build.',
        default: false,
      },
      manage: {
        type: 'boolean',
        description: "Enable installation into this instance's own private collection.",
        default: false,
      },
      preferences: {
        type: 'boolean',
        description: 'Allow edits to enabled/pinned preferences, independently of file management.',
        default: false,
      },
      sources: {
        type: 'array',
        items: {
          $ref: '#/$defs/SkillLibrarySource',
        },
      },
    },
    required: ['sources'],
    description: 'Installation-selected skill collections. No ambient home or workspace scan.',
    title: 'SkillLibraryConfiguration',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      DirectoryRootSpec: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: {
            type: 'string',
          },
          path: {
            type: 'string',
          },
        },
        required: ['label', 'path'],
      },
      SkillLibrarySource: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            pattern: '^[a-z0-9][a-z0-9_-]*$',
          },
          label: {
            type: 'string',
            minLength: 1,
          },
          path: {
            type: 'string',
            description: 'Absolute directory containing skill directories. Captured at activation.',
            minLength: 1,
          },
        },
        required: ['id', 'label', 'path'],
      },
    },
  },
  workspaceProcesses: {
    type: 'object',
    additionalProperties: false,
    properties: {
      isolatedWorkspaces: {
        type: 'boolean',
        description:
          "Allow the selected native Session's verified owned worktree, within its\nown access policy. Other Host-private paths remain denied.",
        default: false,
      },
      filesystem: {
        $ref: '#/$defs/Policy',
      },
      network: {
        $ref: '#/$defs/Network',
      },
      helper: {
        type: ['string', 'null'],
        description: 'Trusted CLI supporting the original platform sandbox bootstrap.',
      },
      setupDirectory: {
        type: ['string', 'null'],
        description:
          'Explicit directory for application setup processes. Launch still needs\nits own grant and uses only the installation filesystem/network ceiling.',
        default: null,
      },
      sessionOwner: {
        anyOf: [
          {
            $ref: '#/$defs/InstanceId',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Trusted Agent Session owner in this Root/deployment. This selects a data\nnamespace only; Terminal endpoints still require their own explicit grants.',
        default: null,
      },
      sessionKind: {
        $ref: '#/$defs/WorkspaceProcessSessionKind',
        description: 'Explicit data namespace of the selected Session owner.',
        default: 'agent',
      },
    },
    required: ['filesystem', 'network'],
    description: 'Immutable installation ceiling selected by trusted native composition.',
    title: 'WorkspaceProcessConfiguration',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      Policy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          default: {
            $ref: '#/$defs/Access',
          },
          rules: {
            type: 'array',
            items: {
              $ref: '#/$defs/Rule',
            },
          },
          denyGlobs: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: ['default', 'rules', 'denyGlobs'],
        description:
          'Longest path wins; at the same path exact wins over subtree, then deny wins\nover write over read. Deny globs are absolute and cannot be reopened by paths.\nMatching directories deny their descendants.\nHost file operations match at access time. Linux and Windows subprocesses\nsnapshot existing glob matches during preparation; macOS enforces them live.\nEmpty restricted policy denies all access, rather than falling back to defaults.',
      },
      Access: {
        type: 'string',
        enum: ['read', 'write', 'deny'],
        description: 'Equal-path conflict priority is different from authority breadth: deny wins.',
      },
      Rule: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
          },
          scope: {
            $ref: '#/$defs/Scope',
          },
          access: {
            $ref: '#/$defs/Access',
          },
        },
        required: ['path', 'scope', 'access'],
        description:
          'Paths have executor-native meaning. Validate and materialize them on the\nexecution host, never on a remote Desktop. This document alone grants nothing.',
      },
      Scope: {
        type: 'string',
        enum: ['subtree', 'exact'],
      },
      Network: {
        oneOf: [
          {
            type: 'string',
            enum: ['denied', 'allowed'],
          },
          {
            type: 'object',
            properties: {
              restricted: {
                type: 'object',
                properties: {
                  destinations: {
                    type: 'array',
                    uniqueItems: true,
                    items: {
                      $ref: '#/$defs/Destination',
                    },
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
          host: {
            type: 'string',
            minLength: 1,
            maxLength: 253,
          },
          port: {
            type: 'integer',
            format: 'uint16',
            minimum: 1,
            maximum: 65535,
          },
        },
        required: ['host', 'port'],
        description:
          'Destination authority, independent of the upstream proxy used to reach it.\nA domain grant does not authorize its subdomains or other ports.',
      },
      InstanceId: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid',
        },
        description:
          'Hierarchical, stable source keys. Display aliases never become data identities.',
      },
      WorkspaceProcessSessionKind: {
        type: 'string',
        enum: ['agent', 'workhub'],
      },
    },
  },
  protocolProcesses: {
    type: 'object',
    additionalProperties: false,
    properties: {
      isolatedWorkspaces: {
        type: 'boolean',
        description:
          "Allow the selected native Session's verified owned worktree, within its\nown access policy. Other Host-private paths remain denied.",
        default: false,
      },
      filesystem: {
        $ref: '#/$defs/Policy',
      },
      network: {
        $ref: '#/$defs/Network',
      },
      helper: {
        type: ['string', 'null'],
        description: 'Trusted CLI supporting the original platform sandbox bootstrap.',
      },
      setupDirectory: {
        type: ['string', 'null'],
        description:
          'Explicit directory for application setup processes. Launch still needs\nits own grant and uses only the installation filesystem/network ceiling.',
        default: null,
      },
      sessionOwner: {
        anyOf: [
          {
            $ref: '#/$defs/InstanceId',
          },
          {
            type: 'null',
          },
        ],
        description:
          'Trusted Agent Session owner in this Root/deployment. This selects a data\nnamespace only; Terminal endpoints still require their own explicit grants.',
        default: null,
      },
      sessionKind: {
        $ref: '#/$defs/WorkspaceProcessSessionKind',
        description: 'Explicit data namespace of the selected Session owner.',
        default: 'agent',
      },
    },
    required: ['filesystem', 'network'],
    description: 'Immutable installation ceiling selected by trusted native composition.',
    title: 'WorkspaceProcessConfiguration',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      Policy: {
        type: 'object',
        additionalProperties: false,
        properties: {
          default: {
            $ref: '#/$defs/Access',
          },
          rules: {
            type: 'array',
            items: {
              $ref: '#/$defs/Rule',
            },
          },
          denyGlobs: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
        },
        required: ['default', 'rules', 'denyGlobs'],
        description:
          'Longest path wins; at the same path exact wins over subtree, then deny wins\nover write over read. Deny globs are absolute and cannot be reopened by paths.\nMatching directories deny their descendants.\nHost file operations match at access time. Linux and Windows subprocesses\nsnapshot existing glob matches during preparation; macOS enforces them live.\nEmpty restricted policy denies all access, rather than falling back to defaults.',
      },
      Access: {
        type: 'string',
        enum: ['read', 'write', 'deny'],
        description: 'Equal-path conflict priority is different from authority breadth: deny wins.',
      },
      Rule: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: {
            type: 'string',
          },
          scope: {
            $ref: '#/$defs/Scope',
          },
          access: {
            $ref: '#/$defs/Access',
          },
        },
        required: ['path', 'scope', 'access'],
        description:
          'Paths have executor-native meaning. Validate and materialize them on the\nexecution host, never on a remote Desktop. This document alone grants nothing.',
      },
      Scope: {
        type: 'string',
        enum: ['subtree', 'exact'],
      },
      Network: {
        oneOf: [
          {
            type: 'string',
            enum: ['denied', 'allowed'],
          },
          {
            type: 'object',
            properties: {
              restricted: {
                type: 'object',
                properties: {
                  destinations: {
                    type: 'array',
                    uniqueItems: true,
                    items: {
                      $ref: '#/$defs/Destination',
                    },
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
          host: {
            type: 'string',
            minLength: 1,
            maxLength: 253,
          },
          port: {
            type: 'integer',
            format: 'uint16',
            minimum: 1,
            maximum: 65535,
          },
        },
        required: ['host', 'port'],
        description:
          'Destination authority, independent of the upstream proxy used to reach it.\nA domain grant does not authorize its subdomains or other ports.',
      },
      InstanceId: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid',
        },
        description:
          'Hierarchical, stable source keys. Display aliases never become data identities.',
      },
      WorkspaceProcessSessionKind: {
        type: 'string',
        enum: ['agent', 'workhub'],
      },
    },
  },
  workspaceComputer: {
    type: 'object',
    additionalProperties: false,
    properties: {
      desktop: {
        $ref: '#/$defs/Desktop',
        default: 'auto',
      },
      browsers: {
        type: 'array',
        items: {
          $ref: '#/$defs/BrowserConnection',
        },
        default: [],
      },
      audio: {
        type: 'boolean',
        description: 'Explicit opt-in to recording computer output audio.',
        default: false,
      },
    },
    title: 'ComputerConfiguration',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      Desktop: {
        type: 'string',
        enum: ['auto', 'local', 'windows'],
        description:
          "Selects the Host's local desktop or its Windows host when running in WSL.\nExecutables and transport addresses are exclusively Host configuration.",
      },
      BrowserConnection: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
          },
          endpoint: {
            type: 'string',
          },
        },
        required: ['id', 'endpoint'],
        description:
          'An explicitly configured browser provider. The REPL cannot supply endpoints,\nrestart a browser, switch profiles or enable remote debugging by itself.',
      },
    },
  },
  workspaceWeb: {
    type: 'object',
    additionalProperties: false,
    properties: {
      network: {
        $ref: '#/$defs/Network',
      },
    },
    required: ['network'],
    title: 'WorkspaceWebConfiguration',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      Network: {
        oneOf: [
          {
            type: 'string',
            enum: ['denied', 'allowed'],
          },
          {
            type: 'object',
            properties: {
              restricted: {
                type: 'object',
                properties: {
                  destinations: {
                    type: 'array',
                    uniqueItems: true,
                    items: {
                      $ref: '#/$defs/Destination',
                    },
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
          host: {
            type: 'string',
            minLength: 1,
            maxLength: 253,
          },
          port: {
            type: 'integer',
            format: 'uint16',
            minimum: 1,
            maximum: 65535,
          },
        },
        required: ['host', 'port'],
        description:
          'Destination authority, independent of the upstream proxy used to reach it.\nA domain grant does not authorize its subdomains or other ports.',
      },
    },
  },
  workspaceJev: {
    type: 'object',
    additionalProperties: false,
    properties: {
      network: {
        $ref: '#/$defs/Network',
      },
    },
    required: ['network'],
    title: 'WorkspaceJevConfiguration',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: {
      Network: {
        oneOf: [
          {
            type: 'string',
            enum: ['denied', 'allowed'],
          },
          {
            type: 'object',
            properties: {
              restricted: {
                type: 'object',
                properties: {
                  destinations: {
                    type: 'array',
                    uniqueItems: true,
                    items: {
                      $ref: '#/$defs/Destination',
                    },
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
          host: {
            type: 'string',
            minLength: 1,
            maxLength: 253,
          },
          port: {
            type: 'integer',
            format: 'uint16',
            minimum: 1,
            maximum: 65535,
          },
        },
        required: ['host', 'port'],
        description:
          'Destination authority, independent of the upstream proxy used to reach it.\nA domain grant does not authorize its subdomains or other ports.',
      },
    },
  },
} as const;
