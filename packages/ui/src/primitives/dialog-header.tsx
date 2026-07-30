// packages/ui/src/primitives/dialog-header.tsx
//
// Compatibility name for Maka consumers. Astryx owns title semantics,
// autofocus, spacing, divider treatment, and the localized close affordance.

import {
  DialogHeader as AstryxDialogHeader,
  type DialogHeaderProps as AstryxDialogHeaderProps,
} from '@astryxdesign/core/Dialog';
import type { ReactNode } from 'react';

export interface DialogHeaderProps
  extends Omit<AstryxDialogHeaderProps, 'onOpenChange' | 'startContent'> {
  icon?: ReactNode;
  onClose(): void;
}

export function DialogHeader({ icon, onClose, ...props }: DialogHeaderProps) {
  return (
    <AstryxDialogHeader
      {...props}
      startContent={icon}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      data-slot="dialog-header"
    />
  );
}
