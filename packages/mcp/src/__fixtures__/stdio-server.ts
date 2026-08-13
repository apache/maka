import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

if (process.argv.includes('--crash')) {
  process.stderr.write('fixture startup failed: deliberate diagnostic\n');
  process.exit(23);
}
if (process.argv.includes('--crash-secret-tail')) {
  process.stderr.write('token=sk-live-secret-token-value');
  process.exit(24);
}
if (process.argv.includes('--crash-hostile-stderr')) {
  process.stderr.write(`${'x'.repeat(1_998)}sk`);
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.stderr.write('-live-secret-token-value\r\u2028\u206a\n');
  process.stderr.write(`${'z'.repeat(10_000)}\n`);
  process.stderr.write('after\u2029line\n');
  process.stderr.write('sk-live-\u001b12345678\n');
  process.stderr.write('AWS_SECRET_ACCESS_KEY\\\n=environment-secret\n');
  process.stderr.write('aws configure set aws_secret_access_key \\\ncontinued-secret\n');
  process.exit(25);
}
if (process.argv.includes('--crash-many-stderr-lines')) {
  process.stderr.write('x\n'.repeat(1_000));
  process.exit(26);
}
if (process.argv.includes('--slow-start')) {
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}

const server = new Server(
  { name: 'maka-mcp-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
  if (!params?.cursor) {
    return {
      tools: [
        tool('echo', 'Echo text', true),
        tool('rich', 'Return rich content', true),
        ...(process.argv.includes('--environment')
          ? [tool('environment', 'Read selected environment variables', true)]
          : []),
      ],
      nextCursor: 'page-2',
    };
  }
  if (params.cursor === 'page-2') {
    return {
      tools: [tool('fail', 'Return MCP isError', false), tool('slow', 'Wait until aborted', false)],
    };
  }
  throw new Error('unexpected cursor');
});

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === 'echo') {
    return {
      content: [{ type: 'text', text: String(params.arguments?.value ?? '') }],
      structuredContent: { echoed: params.arguments?.value },
    };
  }
  if (params.name === 'rich') {
    return {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
        {
          type: 'resource',
          resource: { uri: 'file:///fixture.txt', text: 'resource text', mimeType: 'text/plain' },
        },
        {
          type: 'resource_link',
          uri: 'https://example.com/item',
          name: 'item',
          mimeType: 'text/html',
        },
      ],
    };
  }
  if (params.name === 'fail') {
    return { isError: true, content: [{ type: 'text', text: 'deliberate failure' }] };
  }
  if (params.name === 'slow') {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    return { content: [{ type: 'text', text: 'too late' }] };
  }
  if (params.name === 'environment') {
    const names = Array.isArray(params.arguments?.names) ? params.arguments.names : [];
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            Object.fromEntries(
              names
                .filter((name): name is string => typeof name === 'string')
                .map((name) => [name, process.env[name] ?? null]),
            ),
          ),
        },
      ],
    };
  }
  return { isError: true, content: [{ type: 'text', text: 'unknown tool' }] };
});

function tool(name: string, description: string, readOnlyHint: boolean) {
  return {
    name,
    description,
    inputSchema: { type: 'object' as const, properties: { value: { type: 'string' } } },
    annotations: { readOnlyHint },
  };
}

await server.connect(new StdioServerTransport());

if (process.argv.includes('--runtime-stderr')) {
  setTimeout(() => process.stderr.write('runtime diagnostic\n'), 500);
}
