import { useRef, type ReactNode } from 'react';
import type { ProviderType } from '@maka/core';
import { DialogContent, DialogHeader, DialogRoot } from '@maka/ui';
import { ProviderLogo } from './provider-display';

export function ProviderConnectionDialog(props: {
  title: string;
  subtitle: string;
  providerType: ProviderType;
  onClose(): void;
  finalFocus?(): HTMLElement | null;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent
        className="providerConnectionDialog"
        width={520}
        maxHeight="calc(100dvh - 80px)"
        initialFocus={() => bodyRef.current?.querySelector<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ) ?? true}
        finalFocus={props.finalFocus}
      >
        <DialogHeader
          icon={<ProviderLogo type={props.providerType} compact />}
          title={props.title}
          subtitle={props.subtitle}
          onClose={props.onClose}
        />
        <div ref={bodyRef} className="providerConnectionDialogBody">{props.children}</div>
      </DialogContent>
    </DialogRoot>
  );
}
