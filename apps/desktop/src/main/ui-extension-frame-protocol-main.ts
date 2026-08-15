import { protocol } from 'electron';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  createUiExtensionFrameRequestHandler,
  type UiExtensionFrameClient,
} from './ui-extension-frame-protocol.js';

let installed = false;
let activeClient: UiExtensionFrameClient | null = null;

export function registerUiExtensionFrameProtocol(client: DesktopRuntimeHostClient): void {
  activeClient = client;
  if (installed) return;
  installed = true;
  protocol.handle(
    'maka-ui',
    createUiExtensionFrameRequestHandler(() => activeClient),
  );
}
