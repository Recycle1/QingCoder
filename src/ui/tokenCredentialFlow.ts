import * as vscode from 'vscode';
import type { ModelProfilePayload } from '../types/protocol';
import { resolveModelProfiles } from '../core/profileConfigFile';
import type { SettingsStore } from '../core/settingsStore';
import type { SecretsService } from '../core/secretsService';

type ActionPick = vscode.QuickPickItem & { action: 'set' | 'clear' };

/**
 * 使用 VS Code 原生 QuickPick / InputBox（顶部输入区体验）配置或清除 Token。
 */
export async function runTokenCredentialWizard(settings: SettingsStore, secrets: SecretsService): Promise<void> {
  const first = await vscode.window.showQuickPick<ActionPick>(
    [
      {
        label: '$(key) 配置 / 更换 Token',
        description: '选择模型档案后在输入框粘贴 API Key',
        action: 'set',
      },
      {
        label: '$(trash) 清除 Token',
        description: '从本机 SecretStorage 移除某档案的密钥',
        action: 'clear',
      },
    ],
    {
      title: 'QingCoder：密钥',
      placeHolder: '选择操作（Enter 确认）',
      ignoreFocusOut: true,
    }
  );
  if (!first) return;

  const profiles = resolveModelProfiles(settings);
  if (!profiles.length) {
    void vscode.window.showWarningMessage('没有可用的模型档案。');
    return;
  }

  const configured = await secrets.getTokenConfiguredMap(profiles.map((p) => p.id));
  const profilePick = await vscode.window.showQuickPick(
    profiles.map((p) => profileToPick(p, configured[p.id])),
    {
      title: first.action === 'set' ? '选择要配置 Token 的厂商 / 档案' : '选择要清除 Token 的档案',
      placeHolder: '可输入过滤，Enter 确认',
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    }
  );
  if (!profilePick || !profilePick.description) return;
  const profileId = profilePick.description;

  if (first.action === 'clear') {
    const ok = await vscode.window.showWarningMessage(
      `确定清除档案「${profileId}」保存在本机的 Token？`,
      { modal: true },
      '确定'
    );
    if (ok !== '确定') return;
    await secrets.deleteToken(profileId);
    void vscode.window.showInformationMessage('已清除 Token');
    return;
  }

  const token = await vscode.window.showInputBox({
    title: `输入「${profilePick.label}」的 API Token`,
    prompt: '密钥仅写入本机 VS Code SecretStorage，不会出现在项目文件中',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v || !v.trim()) return '请输入非空密钥';
      return undefined;
    },
  });
  if (token === undefined) return;
  await secrets.setToken(profileId, token.trim());
  await settings.setActiveProfileId(profileId);
  void vscode.window.showInformationMessage(`已为「${profilePick.label}」保存 Token，并已切换为当前模型档案。`);
}

function profileToPick(p: ModelProfilePayload, hasToken: boolean): vscode.QuickPickItem {
  return {
    label: p.label,
    description: p.id,
    detail: `${p.defaultModel} · ${p.baseUrl} · Token: ${hasToken ? '已配置' : '未配置'}`,
  };
}
