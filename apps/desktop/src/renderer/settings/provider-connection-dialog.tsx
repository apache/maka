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
    >
      <Layout
        header={
          <DialogHeader
            startContent={<ProviderLogo type={props.providerType} compact />}
            title={props.title}
            subtitle={props.subtitle}
            onOpenChange={props.onOpenChange}
          />
        }
        content={
          <LayoutContent padding={0}>
            <div className="providerConnectionDialogBody">
              {props.children}
            </div>
          </LayoutContent>
        }
      />
    </Dialog>
  );
}
