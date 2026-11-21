import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from './cn';

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      className={cn('text-sm font-medium leading-none', className)}
      {...props}
    />
  );
}
