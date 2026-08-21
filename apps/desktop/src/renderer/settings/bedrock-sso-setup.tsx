import { useEffect, useRef, useState } from 'react';
import { Banner, HStack, MultiSelector, Selector, Text, VStack } from '@astryxdesign/core';
import type { ModelInfo } from '@maka/core/llm-connections';
import { Button, TextInput, useUiLocale } from '@maka/ui';
import { useRuntimeHostSettingsTarget } from './runtime-host-settings-target.js';

const POLL_MS = 500;

export function BedrockSsoSetup(props: {
  onCancel(): void;
  onCreated(slug: string): void | Promise<void>;
}) {
  const locale = useUiLocale();
  const host = useRuntimeHostSettingsTarget();
  const zh = locale === 'zh';
  const [ssoStartUrl, setSsoStartUrl] = useState('');
  const [ssoRegion, setSsoRegion] = useState('us-east-1');
  const [region, setRegion] = useState('us-east-1');
  const [attemptId, setAttemptId] = useState<string>();
  const [userCode, setUserCode] = useState<string>();
  const [accounts, setAccounts] = useState<Array<{ accountId: string; accountName?: string; emailAddress?: string }>>([]);
  const [accountId, setAccountId] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [roleName, setRoleName] = useState('');
  const [manualIds, setManualIds] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [enabledModelIds, setEnabledModelIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    if (attemptId) void window.maka.amazonBedrockSso.cancel(attemptId, host).catch(() => undefined);
  }, [attemptId, host]);

  async function login() {
    setBusy(true);
    setError(undefined);
    try {
      const started = await window.maka.amazonBedrockSso.start({ ssoStartUrl, ssoRegion, region }, host);
      setAttemptId(started.attemptId);
      setUserCode(started.userCode);
      let current = started;
      while (mounted.current && current.phase === 'awaiting_authorization') {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        current = await window.maka.amazonBedrockSso.query(started.attemptId, host);
        if (current.userCode) setUserCode(current.userCode);
      }
      if (!mounted.current) return;
      if (current.phase !== 'authenticated') throw new Error(zh ? 'AWS SSO 登录未完成。' : 'AWS SSO sign-in did not complete.');
      const listed = await window.maka.amazonBedrockSso.listAccounts(started.attemptId, host);
      if (listed.accounts.length === 0) {
        throw new Error(
          zh
            ? '该 IAM Identity Center 用户没有可用的 AWS 账号分配。'
            : 'This IAM Identity Center user has no assigned AWS accounts.',
        );
      }
      setAccounts([...listed.accounts]);
      const firstAccount = listed.accounts[0];
      if (firstAccount) {
        setAccountId(firstAccount.accountId);
        const roleResult = await window.maka.amazonBedrockSso.listRoles(
          started.attemptId,
          firstAccount.accountId,
          host,
        );
        if (roleResult.roles.length === 0) {
          throw new Error(
            zh
              ? '所选 AWS 账号没有可用的角色分配。'
              : 'The selected AWS account has no assigned roles.',
          );
        }
        setRoles([...roleResult.roles]);
        setRoleName(roleResult.roles[0] ?? '');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? 'AWS SSO 登录失败。' : 'AWS SSO sign-in failed.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function loadRoles(nextAccountId: string) {
    setAccountId(nextAccountId);
    setRoles([]);
    setRoleName('');
    setModels([]);
    if (!attemptId || !nextAccountId) return;
    setBusy(true);
    try {
      const listed = await window.maka.amazonBedrockSso.listRoles(attemptId, nextAccountId, host);
      if (listed.roles.length === 0) {
        throw new Error(
          zh
            ? '所选 AWS 账号没有可用的角色分配。'
            : 'The selected AWS account has no assigned roles.',
        );
      }
      setRoles([...listed.roles]);
      setRoleName(listed.roles[0] ?? '');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? '无法读取角色。' : 'Could not list roles.');
    } finally {
      setBusy(false);
    }
  }

  async function fetchModels() {
    if (!attemptId || !accountId || !roleName) return;
    setBusy(true);
    setError(undefined);
    try {
      const manualModelIds = manualIds.split(/[\n,]/).map((id) => id.trim()).filter(Boolean);
      const result = await window.maka.amazonBedrockSso.fetchModels(
        attemptId,
        accountId,
        roleName,
        manualModelIds,
        host,
      );
      setModels([...result.models]);
      setEnabledModelIds(result.models[0] ? [result.models[0].id] : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? '无法读取 Bedrock 模型。' : 'Could not list Bedrock models.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (attemptId) await window.maka.amazonBedrockSso.cancel(attemptId, host).catch(() => undefined);
    setAttemptId(undefined);
    setUserCode(undefined);
    setAccounts([]);
    setRoles([]);
    setModels([]);
    props.onCancel();
  }

  async function save() {
    if (!attemptId || enabledModelIds.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.maka.amazonBedrockSso.commit(attemptId, enabledModelIds, host);
      await props.onCreated(result.slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : zh ? '无法保存 Bedrock 连接。' : 'Could not save Bedrock connection.');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const signedIn = accounts.length > 0;
  return (
    <VStack gap={3} data-maka-contract="bedrock-sso-setup">
      <Text type="body">
        {zh
          ? '通过 AWS IAM Identity Center 登录。会话保存在目标 Runtime Host；临时角色密钥不会发送到界面或写入磁盘。'
          : 'Sign in with AWS IAM Identity Center. The target Runtime Host owns the session; temporary role keys are never sent to this UI or persisted.'}
      </Text>
      {!signedIn && (
        <>
          <TextInput label="SSO Start URL" value={ssoStartUrl} onChange={setSsoStartUrl} placeholder="https://d-xxxxxxxxxx.awsapps.com/start" isDisabled={busy} />
          <TextInput label={zh ? 'SSO Region' : 'SSO Region'} value={ssoRegion} onChange={setSsoRegion} placeholder="us-east-1" isDisabled={busy} />
          <TextInput label={zh ? 'Bedrock 推理 Region' : 'Bedrock inference Region'} value={region} onChange={setRegion} placeholder="us-east-1" isDisabled={busy} />
          {userCode && <Banner status="info" title={`${zh ? '设备代码' : 'Device code'}: ${userCode}`} />}
          <HStack hAlign="end"><Button variant="primary" label={busy ? (zh ? '等待授权…' : 'Waiting…') : (zh ? '使用 AWS SSO 登录' : 'Sign in with AWS SSO')} onClick={() => void login()} isDisabled={busy || !ssoStartUrl.trim()} /></HStack>
        </>
      )}
      {signedIn && (
        <>
          <Selector
            label={zh ? 'AWS 账号' : 'AWS account'}
            value={accountId}
            onChange={(value: string) => void loadRoles(value)}
            options={accounts.map((account) => ({
              value: account.accountId,
              label: `${account.accountName ?? account.emailAddress ?? 'AWS'} · ••••${account.accountId.slice(-4)}`,
            }))}
            isDisabled={busy}
          />
          {roles.length > 0 && (
            <Selector label={zh ? '角色' : 'Role'} value={roleName} onChange={(value: string) => setRoleName(value)} options={roles.map((role) => ({ value: role, label: role }))} isDisabled={busy} />
          )}
          {roleName && (
            <>
              <TextInput
                label={zh ? '手工模型 ID / ARN（可选）' : 'Manual model IDs / ARNs (optional)'}
                description={zh ? '每行一个。验证会发送一次最小 Converse 请求，可能产生少量费用。' : 'One per line. Validation sends a minimal Converse request and may incur a small charge.'}
                value={manualIds}
                onChange={setManualIds}
                isDisabled={busy}
              />
              <HStack hAlign="end"><Button variant="secondary" label={busy ? (zh ? '读取中…' : 'Loading…') : (zh ? '读取模型' : 'Load models')} onClick={() => void fetchModels()} isDisabled={busy} /></HStack>
            </>
          )}
          {models.length > 0 && (
            <MultiSelector
              label={zh ? '启用模型' : 'Enabled models'}
              options={models.map((model) => ({ value: model.id, label: model.displayName ?? model.id }))}
              value={enabledModelIds}
              onChange={setEnabledModelIds}
              hasSearch
              triggerDisplay="labels"
              width="100%"
              isDisabled={busy}
            />
          )}
        </>
      )}
      {error && <Banner status="error" title={error} />}
      <HStack hAlign="end" gap={2}>
        <Button variant="ghost" label={zh ? '取消' : 'Cancel'} onClick={() => void cancel()} />
        {models.length > 0 && <Button variant="primary" label={busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存连接' : 'Save connection')} onClick={() => void save()} isDisabled={busy || enabledModelIds.length === 0} />}
      </HStack>
    </VStack>
  );
}
