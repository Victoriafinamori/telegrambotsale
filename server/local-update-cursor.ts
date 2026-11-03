import type { DocumentStore } from './document-store.js';

// Local display updates do not touch the central offset. Preserve their position
// across worker restarts, scoped to both the bot and current runtime authorization.
export class LocalUpdateCursor {
  private readonly path: string;
  constructor(
    private store: DocumentStore,
    accountId: string,
    private botId: string,
    private generation: string,
    private now = () => Date.now(),
  ) {
    this.path = 'bot_shops/' + accountId + '/local/cursor';
  }
  async resume(centralOffset: number) {
    const row = await this.store.get(this.path);
    if (
      !this.generation ||
      row?.generation !== this.generation ||
      row.botId !== this.botId ||
      !(row.updated_at instanceof Date) ||
      row.updated_at.getTime() > this.now() ||
      this.now() - row.updated_at.getTime() >= 6 * 86400000 ||
      !Number.isSafeInteger(row.offset) ||
      row.offset < 0
    )
      return centralOffset;
    return Math.max(centralOffset, row.offset);
  }
  async advance(offset: number) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Invalid local update cursor');
    await this.store.transaction(async (tx) =>
      tx.set(this.path, {
        botId: this.botId,
        generation: this.generation,
        offset,
        updated_at: new Date(this.now()),
      }),
    );
  }
}
