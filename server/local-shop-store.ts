import { SqliteDocumentStore } from './sqlite-document-store.js';

export class LocalShopStore extends SqliteDocumentStore {
  constructor(
    filename: string,
    readonly accountId: string,
    key: string,
  ) {
    if (!/^[a-f0-9-]{36}$/.test(accountId)) throw Error('Invalid local shop account');
    const root = 'bot_shops/' + accountId;
    super(filename, accountId, key, (path) => path === root || path.startsWith(root + '/'));
  }
}
