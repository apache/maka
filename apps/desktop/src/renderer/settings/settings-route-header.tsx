// The header of a settings sub-level: back affordance, title, and one quiet
// line of context.
//
// Deliberately a `Toolbar` with everything in `startContent`: the back button,
// the optional logo, and the title block read as one left-aligned cluster, so
// the title sits where the list's rows started and the eye does not travel.
// Modelled on the settings-sidebar template's detail view, which puts this
// same Toolbar inside the content area rather than reaching for a second page
// shell.
import type { ReactNode } from 'react';
import { Heading, HStack, IconButton, Text, Toolbar, VStack } from '@astryxdesign/core';
import { ArrowLeft } from '@maka/ui/icons';

export function SettingsRouteHeader(props: {
  onBack(): void;
  backLabel: string;
  /** True while a write is in flight: leaving would discard the draft. */
  isBackDisabled?: boolean;
  logo?: ReactNode;
  title: string;
  /** Wire the level's `aria-labelledby` to this heading, so it is announced. */
  titleId?: string;
  badge?: ReactNode;
  subtitle?: string;
}) {
  return (
    <Toolbar
      label={props.title}
      gap={2}
      startContent={(
        <>
          <IconButton
            variant="ghost"
            label={props.backLabel}
            tooltip={props.backLabel}
            icon={<ArrowLeft size={16} aria-hidden="true" />}
            isDisabled={props.isBackDisabled}
            onClick={props.onBack}
          />
          {props.logo}
          <VStack gap={0}>
            <HStack gap={2} vAlign="center">
              <Heading level={3} id={props.titleId}>{props.title}</Heading>
              {props.badge}
            </HStack>
            {props.subtitle && (
              <Text type="supporting" color="secondary">{props.subtitle}</Text>
            )}
          </VStack>
        </>
      )}
    />
  );
}
