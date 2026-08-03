import { useMemo, useState } from 'react';
import { Card, Item } from '@astryxdesign/core';
import {
  connectionEnabledModelIds,
  isSafeSubagentPresetId,
  type AppSettings,
  type LlmConnection,
  type SubagentPreset,
  type SubagentProfile,
  type UpdateAppSettingsResult,
} from '@maka/core';
import { Button, FormLayout, Selector, Switch, TextInput, useToast, useUiLocale } from '@maka/ui';
import { settingsActionErrorMessage } from './settings-error-copy';

const PROFILE_OPTIONS: Array<{ value: SubagentProfile; label: string }> = [
  { value: 'local_read', label: 'Local Read' },
  { value: 'web_research', label: 'Web Research' },
  { value: 'implementation', label: 'Implementation' },
];

export function SubagentPresetsPanel(props: {
  settings: AppSettings;
  connections: readonly LlmConnection[];
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
}) {
  const locale = useUiLocale();
  const zh = locale === 'zh';
  const toast = useToast();
  const usableConnections = useMemo(
    () => props.connections.filter((connection) => connection.enabled),
    [props.connections],
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [id, setId] = useState('');
  const [profile, setProfile] = useState<SubagentProfile>('local_read');
  const [connectionSlug, setConnectionSlug] = useState(usableConnections[0]?.slug ?? '');
  const selectedConnection =
    usableConnections.find((connection) => connection.slug === connectionSlug) ??
    usableConnections[0];
  const modelIds = selectedConnection ? connectionEnabledModelIds(selectedConnection) : [];
  const [model, setModel] = useState(modelIds[0] ?? '');
  const selectedModel = modelIds.includes(model) ? model : (modelIds[0] ?? '');
  const [saving, setSaving] = useState(false);

  async function persist(presets: SubagentPreset[]): Promise<boolean> {
    setSaving(true);
    try {
      await props.onUpdate({ subagents: { presets } });
      return true;
    } catch (error) {
      toast.error(
        zh ? '保存子 Agent 配置失败' : 'Failed to save subagent presets',
        settingsActionErrorMessage(error, locale),
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function addPreset() {
    const presetId = id.trim();
    if (
      !isSafeSubagentPresetId(presetId) ||
      !name.trim() ||
      !selectedConnection ||
      !selectedModel ||
      props.settings.subagents.presets.some((preset) => preset.id === presetId)
    ) {
      toast.error(
        zh
          ? '请填写唯一且有效的 ID、名称、连接和模型'
          : 'Enter a unique valid id, name, connection, and model',
      );
      return;
    }
    const saved = await persist([
      ...props.settings.subagents.presets,
      {
        id: presetId,
        name: name.trim(),
        description: description.trim(),
        profile,
        connectionSlug: selectedConnection.slug,
        model: selectedModel,
        enabled: true,
      },
    ]);
    if (!saved) return;
    setName('');
    setDescription('');
    setId('');
  }

  return (
    <Card padding={0} className="settingsRows subagentPresetPanel">
      <Item
        label={zh ? '子 Agent 模型路由' : 'Subagent model routing'}
        description={
          zh
            ? '主 Agent 从这里批准的配置中选择 subagent_id；能力边界由 Profile 决定，Provider 与模型在子会话创建时冻结。'
            : 'The main agent selects an approved subagent_id. The profile owns capabilities; provider and model are frozen when the child session is created.'
        }
      />
      {props.settings.subagents.presets.map((preset) => (
        <Item
          key={preset.id}
          label={`${preset.name} · ${preset.id}`}
          description={`${preset.description ? `${preset.description} · ` : ''}${preset.profile} · ${preset.connectionSlug} / ${preset.model}`}
          endContent={
            <div className="subagentPresetActions">
              <Switch
                label={zh ? '启用' : 'Enabled'}
                isLabelHidden
                value={preset.enabled}
                isDisabled={saving}
                onChange={(enabled) =>
                  void persist(
                    props.settings.subagents.presets.map((candidate) =>
                      candidate.id === preset.id ? { ...candidate, enabled } : candidate,
                    ),
                  )
                }
              />
              <Button
                variant="secondary"
                label={zh ? '删除' : 'Remove'}
                isDisabled={saving}
                onClick={() =>
                  void persist(
                    props.settings.subagents.presets.filter(
                      (candidate) => candidate.id !== preset.id,
                    ),
                  )
                }
              />
            </div>
          }
        />
      ))}
      <div className="subagentPresetForm">
        <FormLayout className="settingsFormLayout" direction="horizontal">
          <TextInput
            label={zh ? '显示名称' : 'Display name'}
            value={name}
            onChange={setName}
            placeholder={zh ? '快速代码阅读' : 'Fast code reader'}
          />
          <TextInput label="subagent_id" value={id} onChange={setId} placeholder="fast-reader" />
          <Selector
            label="Profile"
            value={profile}
            options={PROFILE_OPTIONS}
            width="100%"
            onChange={(value) => setProfile(value as SubagentProfile)}
          />
        </FormLayout>
        <TextInput
          label={zh ? '适用场景' : 'When to use'}
          value={description}
          onChange={setDescription}
          placeholder={
            zh ? '适合快速、低成本地阅读大型仓库' : 'Fast, low-cost exploration of large repositories'
          }
          width="100%"
        />
        <FormLayout className="settingsFormLayout" direction="horizontal">
          <Selector
            label={zh ? '模型连接' : 'Model connection'}
            value={selectedConnection?.slug ?? ''}
            options={usableConnections.map((connection) => ({
              value: connection.slug,
              label: connection.name,
            }))}
            width="100%"
            onChange={(value) => {
              setConnectionSlug(value);
              const connection = usableConnections.find((candidate) => candidate.slug === value);
              setModel(connection ? (connectionEnabledModelIds(connection)[0] ?? '') : '');
            }}
          />
          <Selector
            label={zh ? '模型' : 'Model'}
            value={selectedModel}
            options={modelIds.map((modelId) => ({
              value: modelId,
              label: modelId,
            }))}
            width="100%"
            onChange={setModel}
          />
        </FormLayout>
        <div className="settingsActionRow">
          <Button
            variant="primary"
            label={zh ? '添加子 Agent 配置' : 'Add subagent preset'}
            isDisabled={saving || usableConnections.length === 0}
            onClick={() => void addPreset()}
          />
        </div>
      </div>
    </Card>
  );
}
