---
name: modal-drawer-system
description: Implements accessible modals and drawers with focus trap, ESC to close, scroll lock, portal rendering, and ARIA attributes. Includes sample implementations for common use cases like edit forms, confirmations, and detail views. Use when building "modals", "dialogs", "drawers", "sidebars", or "overlays".
---

# Modal & Drawer System Generator

Create accessible, polished modal dialogs and drawer components.

## Core Workflow

1. **Choose type**: Modal (center), Drawer (side), Bottom Sheet
2. **Setup portal**: Render outside DOM hierarchy
3. **Focus management**: Focus trap and restoration
4. **Accessibility**: ARIA attributes, keyboard shortcuts
5. **Animations**: Smooth enter/exit transitions
6. **Scroll lock**: Prevent body scroll when open
7. **Backdrop**: Click outside to close

## Base Modal Component

```typescript
"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl" | "full";
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
}

export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  size = "md",
  closeOnEscape = true,
  closeOnBackdrop = true,
}: ModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);

  // ESC key handler
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, closeOnEscape, onClose]);

  // Focus trap
  useEffect(() => {
    if (!isOpen) return;

    const focusableElements = modalRef.current?.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements?.[0] as HTMLElement;
    const lastElement = focusableElements?.[
      focusableElements.length - 1
    ] as HTMLElement;

    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement?.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement?.focus();
      }
    };

    firstElement?.focus();
    document.addEventListener("keydown", handleTab);
    return () => document.removeEventListener("keydown", handleTab);
  }, [isOpen]);

  // Body scroll lock
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
    xl: "max-w-xl",
    full: "max-w-full mx-4",
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? "modal-title" : undefined}
      aria-describedby={description ? "modal-description" : undefined}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-in fade-in"
        onClick={closeOnBackdrop ? onClose : undefined}
      />

      {/* Modal */}
      <div
        ref={modalRef}
        className={`relative z-10 w-full ${sizeClasses[size]} animate-in zoom-in-95 slide-in-from-bottom-4 duration-200`}
      >
        <div className="rounded-lg bg-white shadow-xl">
          {/* Header */}
          {(title || description) && (
            <div className="border-b px-6 py-4">
              {title && (
                <h2 id="modal-title" className="text-xl font-semibold">
                  {title}
                </h2>
              )}
              {description && (
                <p
                  id="modal-description"
                  className="mt-1 text-sm text-gray-600"
                >
                  {description}
                </p>
              )}
            </div>
          )}

          {/* Close button */}
          <button
            onClick={onClose}
            className="absolute right-4 top-4 rounded-lg p-1 hover:bg-gray-100"
            aria-label="Close modal"
          >
            <X className="h-5 w-5" />
          </button>

          {/* Content */}
          <div className="p-6">{children}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

## Drawer Component

```typescript
interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  position?: "left" | "right" | "bottom";
  title?: string;
  children: React.ReactNode;
}

export function Drawer({
  isOpen,
  onClose,
  position = "right",
  title,
  children,
}: DrawerProps) {
  // Similar hooks as Modal (ESC, focus trap, scroll lock)

  const positionClasses = {
    left: "left-0 top-0 h-full w-80 animate-in slide-in-from-left",
    right: "right-0 top-0 h-full w-80 animate-in slide-in-from-right",
    bottom: "bottom-0 left-0 right-0 h-96 animate-in slide-in-from-bottom",
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={`absolute ${positionClasses[position]} bg-white shadow-xl`}
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between border-b px-6 py-4">
            <h2 className="text-xl font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Close drawer">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-6">{children}</div>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

## Common Use Cases

### Confirmation Dialog

```typescript
interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "danger" | "default";
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "default",
}: ConfirmDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} size="sm">
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">{title}</h3>
          <p className="mt-2 text-sm text-gray-600">{description}</p>
        </div>
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onClose}>
            {cancelText}
          </Button>
          <Button
            variant={variant === "danger" ? "destructive" : "default"}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

### Edit Form Modal

```typescript
export function EditUserModal({ user, isOpen, onClose }: EditUserModalProps) {
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    // Save logic
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit User" size="md">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" defaultValue={user.name} />
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" defaultValue={user.email} />
        </div>
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isLoading={isSaving}>
            Save Changes
          </Button>
        </div>
      </form>
    </Modal>
  );
}
```

### Detail View Drawer

```typescript
export function UserDetailDrawer({
  user,
  isOpen,
  onClose,
}: UserDetailDrawerProps) {
  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={user.name}>
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Avatar src={user.avatar} size="lg" />
          <div>
            <h3 className="font-semibold">{user.name}</h3>
            <p className="text-sm text-gray-600">{user.email}</p>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <h4 className="text-sm font-medium text-gray-700">Role</h4>
            <p className="mt-1">{user.role}</p>
          </div>
          <div>
            <h4 className="text-sm font-medium text-gray-700">Department</h4>
            <p className="mt-1">{user.department}</p>
          </div>
          <div>
            <h4 className="text-sm font-medium text-gray-700">Joined</h4>
            <p className="mt-1">{formatDate(user.joinedAt)}</p>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
```

## Best Practices

1. **Portal rendering**: Render outside parent DOM
2. **Focus management**: Trap focus, restore on close
3. **Keyboard support**: ESC to close, Tab navigation
4. **ARIA attributes**: role, aria-modal, aria-labelledby
5. **Scroll lock**: Prevent body scroll when open
6. **Backdrop**: Click outside to close (optional)
7. **Animations**: Smooth enter/exit transitions
8. **Mobile responsive**: Full screen on small devices

## Output Checklist

- [ ] Modal component with portal
- [ ] Drawer component (left/right/bottom)
- [ ] Focus trap implementation
- [ ] ESC key handler
- [ ] Scroll lock on body
- [ ] Backdrop with click-to-close
- [ ] ARIA attributes
- [ ] Smooth animations
- [ ] Close button
- [ ] Sample use cases (confirm, edit, detail)
