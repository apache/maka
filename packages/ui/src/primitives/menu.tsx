'use client';

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuItem as AstryxDropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { Divider } from '@astryxdesign/core/Divider';
import { Fragment, type ComponentProps, type ReactNode, useCallback } from 'react';

/**
 * Maka's menu vocabulary is a direct Astryx surface. Product callers provide
 * the trigger through `button` and render Astryx items as children; Astryx owns
 * the native-popover layer, focus loop, typeahead, dismissal, and item state.
 */
export const Menu = DropdownMenu;
export const MenuCheckboxItem = DropdownMenuCheckboxItem;
export const MenuRadioGroup = DropdownMenuRadioGroup;
export const MenuRadioItem = DropdownMenuRadioItem;

// Astryx 0.1.9 calls an item's action before closing the menu. Defer Maka's
// action by one microtask so the menu can restore its trigger first; dialogs
// opened by that action then capture a connected element as their opener.
export function MenuItem({
  onClick,
  ...props
}: ComponentProps<typeof AstryxDropdownMenuItem>) {
  const handleClick = useCallback(() => {
    if (onClick) queueMicrotask(onClick);
  }, [onClick]);

  return (
    <AstryxDropdownMenuItem
      {...props}
      onClick={onClick ? handleClick : undefined}
    />
  );
}

export function MenuSeparator(
  props: Omit<ComponentProps<typeof Divider>, 'orientation'>,
) {
  return <Divider {...props} orientation="horizontal" />;
}

/**
 * Frozen compatibility names from the retired Base UI compound surface.
 * Internal callers use the Astryx API above. Keeping these inert exports
 * preserves the append-only barrel without retaining a second menu engine.
 */
export const MenuCreateHandle = () => ({});
export function MenuPortal(props: { children?: ReactNode }) {
  return <>{props.children}</>;
}
export function MenuTrigger(): null {
  return null;
}
export function MenuPopup(): null {
  return null;
}
export function MenuGroup(props: { children?: ReactNode }) {
  return <>{props.children}</>;
}
export function MenuGroupLabel(props: { children?: ReactNode }) {
  return <div role="presentation">{props.children}</div>;
}
export function MenuLinkItem(): null {
  return null;
}
export function MenuShortcut(props: ComponentProps<'kbd'>) {
  return <kbd {...props} />;
}
export function MenuSub(props: { children?: ReactNode }) {
  return <Fragment>{props.children}</Fragment>;
}
export function MenuSubTrigger(): null {
  return null;
}
export function MenuSubPopup(props: { children?: ReactNode }) {
  return <>{props.children}</>;
}

export const MenuPrimitive = {
  Root: Menu,
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
};

export {
  MenuCreateHandle as DropdownMenuCreateHandle,
  Menu as DropdownMenu,
  MenuPortal as DropdownMenuPortal,
  MenuTrigger as DropdownMenuTrigger,
  MenuPopup as DropdownMenuContent,
  MenuGroup as DropdownMenuGroup,
  MenuItem as DropdownMenuItem,
  MenuCheckboxItem as DropdownMenuCheckboxItem,
  MenuRadioGroup as DropdownMenuRadioGroup,
  MenuRadioItem as DropdownMenuRadioItem,
  MenuGroupLabel as DropdownMenuLabel,
  MenuSeparator as DropdownMenuSeparator,
  MenuShortcut as DropdownMenuShortcut,
  MenuSub as DropdownMenuSub,
  MenuSubTrigger as DropdownMenuSubTrigger,
  MenuSubPopup as DropdownMenuSubContent,
};
