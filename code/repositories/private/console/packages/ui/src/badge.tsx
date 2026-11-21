import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './cn';

const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'border-transparent bg-success/15 text-success',
        warning: 'border-transparent bg-warning/15 text-warning',
        danger: 'border-transparent bg-destructive/15 text-destructive',
        info: 'border-transparent bg-info/15 text-info',
        muted: 'border-transparent bg-muted text-muted-foreground',
        // 治理域状态语义（实心，原 console src/ui/badge 收编）：p0/p1/p2 优先级，pass/pending/blocked 状态
        p0: 'border-transparent bg-destructive text-destructive-foreground',
        p1: 'border-transparent bg-warning text-warning-foreground',
        p2: 'border-transparent bg-success text-success-foreground',
        pass: 'border-transparent bg-success text-success-foreground',
        pending: 'border-transparent bg-warning text-warning-foreground',
        blocked: 'border-transparent bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
