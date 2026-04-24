import * as vscode from 'vscode';

const TOKEN_KEY = (profileId: string) => `qingcoder.token.${profileId}`;

export class SecretsService {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async setToken(profileId: string, token: string): Promise<void> {
    await this.secrets.store(TOKEN_KEY(profileId), token);
  }

  async getToken(profileId: string): Promise<string | undefined> {
    return this.secrets.get(TOKEN_KEY(profileId));
  }

  async deleteToken(profileId: string): Promise<void> {
    await this.secrets.delete(TOKEN_KEY(profileId));
  }

  /** 批量探测是否已配置（不返回密钥内容） */
  async getTokenConfiguredMap(profileIds: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    await Promise.all(
      profileIds.map(async (id) => {
        const v = await this.secrets.get(TOKEN_KEY(id));
        out[id] = !!v && v.length > 0;
      })
    );
    return out;
  }
}
