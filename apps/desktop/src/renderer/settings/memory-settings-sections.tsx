import { Button } from '@maka/ui';
import { SettingsField, SettingsSection } from './settings-section';
import type { MemorySettingsCopy } from '../locales/settings-memory-copy';

export function MemoryPromptPreviewSection(props: {
  copy: MemorySettingsCopy;
  active: boolean;
  preview: string;
  budgetLabel: string;
  blockedReason: string;
  safeMode: boolean;
  copyPending: boolean;
  onCopy(): void | Promise<void>;
}) {
  return (
    <SettingsSection
      title={props.copy.text.promptPreview}
      description={props.copy.text.promptPreviewHelp}
      action={(
        <div className="settingsFormRowControlCluster">
          <span className="settingsMemoryInjectState" data-active={props.active ? 'true' : 'false'}>
            {props.active ? props.copy.text.willInject : props.copy.text.willNotInject}
          </span>
          <Button
            variant="ghost"
            size="sm"
            isDisabled={!props.preview || props.copyPending}
            onClick={() => void props.onCopy()}
            label={props.copyPending ? props.copy.text.copying : props.copy.text.copyContext}
          />
        </div>
      )}
    >
      <SettingsField className="settingsMemoryPromptPreview">
        <small className="settingsMemoryPromptPreviewBudget">{props.budgetLabel}</small>
        {props.preview ? (
          <pre>{props.preview}</pre>
        ) : (
          <p>{props.safeMode ? props.copy.text.safeModePreview : props.copy.text.emptyPromptPreview}</p>
        )}
        {props.blockedReason && props.preview && <small>{props.blockedReason}</small>}
      </SettingsField>
    </SettingsSection>
  );
}
