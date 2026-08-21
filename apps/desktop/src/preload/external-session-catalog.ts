import type { ExternalSessionCatalogItem } from '@maka/runtime-host/protocol';
import {
  desktopSessionKey,
  type DesktopHostRef,
} from '../shared/runtime-host-identity.js';

/** Main-process projection before Host-local Session ids enter the preload boundary. */
export type DesktopHostExternalSessionCatalogItem = Omit<
  ExternalSessionCatalogItem,
  'hostCwd'
> & {
  /** Main maps the Host-only path name onto Desktop's existing cwd vocabulary. */
  readonly cwd: string;
};

/** Renderer import state whose Session ids are scoped Desktop Session keys. */
export type DesktopExternalSessionImportState = Omit<
  ExternalSessionCatalogItem['importState'],
  'importedSessionIds'
> & {
  /** Values produced by desktopSessionKey for the selected Runtime Host. */
  readonly importedSessionIds: readonly string[];
};

/** Renderer projection of a Host external Session catalog item. */
export type DesktopExternalSessionCatalogItem = Omit<
  DesktopHostExternalSessionCatalogItem,
  'importState'
> & {
  readonly importState: DesktopExternalSessionImportState;
};

export function projectDesktopExternalSessionCatalogItem(
  host: DesktopHostRef,
  item: DesktopHostExternalSessionCatalogItem,
): DesktopExternalSessionCatalogItem {
  return {
    ...item,
    importState: {
      ...item.importState,
      importedSessionIds: item.importState.importedSessionIds.map((sessionId) =>
        desktopSessionKey({ hostId: host.hostId, sessionId }),
      ),
    },
  };
}
