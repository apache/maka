import type { ReactNode } from 'react';
import type { ProviderType } from '@maka/core';
import {
  Dialog,
  DialogHeader,
} from '@astryxdesign/core/Dialog';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { ProviderLogo } from './provider-display';

export function ProviderConnectionDialog(props: {
  title: string;
  subtitle: string;
  providerType: ProviderType;
  isOpen: boolean;
  onOpenChange(isOpen: boolean): void;
  /** Trailing header slot — the provider's category badge on the create path. */
  headerEndContent?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog
      isOpen={props.isOpen}
      onOpenChange={props.onOpenChange}
      className="providerConnectionDialog"
      width={520}
      maxHeight="calc(100dvh - 80px)"
      purpose="form"
      /* The dialog's own inset, not a header override: at the 16px default the
       * provider mark and the close button sit one plate-height from the top
       * edge and read as pinned to it. Astryx exposes this as a parameter, so
       * the fix stays inside the primitive's vocabulary. */
      padding={6}
    >
      <Layout
        header={
          <DialogHeader
            startContent={<ProviderLogo type={props.providerType} compact />}
            title={props.title}
            subtitle={props.subtitle}
            endContent={props.headerEndContent}
            onOpenChange={props.onOpenChange}
          />
        }
        content={
          <LayoutContent padding={6} isScrollable>
            {props.children}
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
