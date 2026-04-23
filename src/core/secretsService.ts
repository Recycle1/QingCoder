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
}
