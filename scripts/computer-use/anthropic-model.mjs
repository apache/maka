import {
  createSyntheticComputerScenario,
  canonicalizeSyntheticComputerArgs,
  SYNTHETIC_COMPUTER_ALLOWED_KEYS,
  SYNTHETIC_COMPUTER_KNOWN_KEYS,
  SYNTHETIC_COMPUTER_TOOL_PROPERTIES,
} from './synthetic-model-scenario.mjs';

const baseUrl = process.env.MAKA_CU_ANTHROPIC_BASE_URL ?? 'http://127.0.0.1:8537';
const model = process.env.MAKA_CU_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const authToken = process.env.MAKA_CU_ANTHROPIC_TOKEN ?? 'coproxy';
const scenario = createSyntheticComputerScenario();
const rejections = [];
const messages = [
  {
    role: 'user',
    content:
      'Use maka_computer to set "CUA Lab Set Value Field" in "Codex CUA Lab" ' +
      'to "model-e2e". Start with list_apps, observe the exact app/window, ' +
      'use set_value with IDs from that observation, verify, then finish.',
  },
];

for (let turn = 1; turn <= 8; turn += 1) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': authToken,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system:
        'Operate only the synthetic fixture. Treat tool results as authoritative. ' +
        'Never invent observation or element IDs. Never use coordinate input.',
      tools: [
        {
          name: 'maka_computer',
          description:
            'Accessibility-first desktop control. Start with list_apps or observe. ' +
            'Use set_value or click_element with IDs from the latest observation.',
          input_schema: {
            type: 'object',
            properties: SYNTHETIC_COMPUTER_TOOL_PROPERTIES,
            required: ['action'],
            additionalProperties: false,
          },
        },
      ],
      messages,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Anthropic model request failed ${response.status}: ${bounded(body)}`);
  }
  const decoded = JSON.parse(body);
  const toolUses = decoded.content?.filter((item) => item.type === 'tool_use') ?? [];
  if (toolUses.length === 0) {
    const text =
      decoded.content
        ?.filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('') ?? '';
    if (scenario.state.value !== 'model-e2e') {
      throw new Error(`model finished before verified mutation: ${bounded(text)}`);
    }
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          provider: 'anthropic',
          model,
          turns: turn,
          calls: scenario.calls,
          rejections,
          finalValue: scenario.state.value,
          finalTextPresent: text.trim().length > 0,
          finalTextChars: text.length,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(0);
  }
  if (toolUses.length !== 1) {
    throw new Error(`expected one serial tool use, got ${toolUses.length}`);
  }
  const toolUse = toolUses[0];
  if (toolUse.name !== 'maka_computer') {
    throw new Error(`unexpected tool ${toolUse.name}`);
  }
  let result;
  try {
    const { args, discardedKeys } = projectArgs(toolUse.input);
    result = scenario.execute(canonicalizeSyntheticComputerArgs(args), discardedKeys);
  } catch (error) {
    const message = bounded(error instanceof Error ? error.message : error);
    result = {
      kind: 'tool_error',
      error: 'invalid_semantic_binding',
      message,
      recovery:
        'Call observe again, then repeat the semantic action with the exact ' +
        'observation_id and element_id from that observation.',
    };
    rejections.push({ turn, tool: toolUse.name, message });
  }
  messages.push({ role: 'assistant', content: decoded.content });
  messages.push({
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
        ...(result.kind === 'tool_error' ? { is_error: true } : {}),
      },
    ],
  });
}

throw new Error('Anthropic model loop exceeded 8 turns');

function projectArgs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Anthropic tool arguments must be an object');
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => !SYNTHETIC_COMPUTER_KNOWN_KEYS.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`unknown Anthropic argument keys: ${unknownKeys.join(',')}`);
  }
  const action = value.action;
  if (typeof action !== 'string' || !SYNTHETIC_COMPUTER_ALLOWED_KEYS[action]) {
    throw new Error(`unsupported Anthropic action ${String(action)}`);
  }
  const allowed = SYNTHETIC_COMPUTER_ALLOWED_KEYS[action];
  return {
    args: Object.fromEntries(Object.entries(value).filter(([key]) => allowed.includes(key))),
    discardedKeys: Object.keys(value)
      .filter((key) => !allowed.includes(key))
      .sort(),
  };
}

function bounded(value) {
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length <= 300 ? text : `${text.slice(0, 300)}...[truncated]`;
}
