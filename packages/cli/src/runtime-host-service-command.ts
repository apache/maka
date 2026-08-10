import {
  installRuntimeHostLogCapture,
  runRuntimeHostProcessLifecycle,
  startExecutionRuntimeHostService,
} from '@maka/runtime-host/server';
import { readFile } from 'node:fs/promises';

export interface RuntimeHostServiceCliOptions {
  readonly rootPath: string;
  readonly websocket?: {
    readonly host: string;
    readonly port: number;
    readonly path?: string;
    readonly tlsCertificatePath?: string;
    readonly tlsPrivateKeyPath?: string;
    readonly allowedOrigins?: readonly string[];
  };
}

export async function runRuntimeHostServiceCli(
  options: RuntimeHostServiceCliOptions,
): Promise<number> {
  installRuntimeHostLogCapture();
  const websocket = options.websocket
    ? {
        host: options.websocket.host,
        port: options.websocket.port,
        ...(options.websocket.path ? { path: options.websocket.path } : {}),
        ...(options.websocket.allowedOrigins
          ? { allowedOrigins: options.websocket.allowedOrigins }
          : {}),
        ...(options.websocket.tlsCertificatePath && options.websocket.tlsPrivateKeyPath
          ? {
              tls: {
                certificate: await readFile(options.websocket.tlsCertificatePath),
                privateKey: await readFile(options.websocket.tlsPrivateKeyPath),
              },
            }
          : {}),
      }
    : undefined;
  const host = await startExecutionRuntimeHostService({
    rootPath: options.rootPath,
    ...(websocket ? { websocket } : {}),
  });
  await runRuntimeHostProcessLifecycle(host, {
    onReady: () => {
      process.stdout.write(`Runtime Host service is ready at ${host.endpoint}\n`);
      for (const endpoint of host.websocketEndpoints) {
        process.stdout.write(`Runtime Host WebSocket is ready at ${endpoint}\n`);
      }
    },
  });
  return 0;
}
