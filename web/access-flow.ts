type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = 'blackout.pending-invitation';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const resumeRoutes = new Set(['', '#/', '#/entrar', '#/conta', '#/convite']);
export function isPortalRoute(hash: string) {
  return new Set([
    '#/comprar',
    '#/entrar',
    '#/conta',
    '#/convite',
    '#/minha-loja',
    '#/gestao',
    '#/configuracao',
    '#/central',
    '#/revenda',
    '#/saude',
  ]).has(hash.split('?')[0]);
}
export class PendingInvitation {
  private memory: { token: string; expires: number; accountCreated?: boolean } | null = null;
  constructor(
    private storage?: StorageLike,
    private now = () => Date.now(),
  ) {}
  read(hash: string): string | null {
    const route = hash.split('?')[0];
    const explicit =
      route === '#/convite' ? new URLSearchParams(hash.split('?')[1] ?? '').get('token') : null;
    let saved = this.memory;
    try {
      if (this.storage) saved = JSON.parse(this.storage.getItem(key) ?? 'null');
    } catch {
      /* Storage can be blocked. */
    }
    if (!saved || !tokenPattern.test(saved.token) || !(saved.expires > this.now())) saved = null;
    if (explicit && tokenPattern.test(explicit) && explicit !== saved?.token) {
      saved = { token: explicit, expires: this.now() + 7 * 86400000 };
      try {
        this.storage?.setItem(key, JSON.stringify(saved));
      } catch {
        /* Keep same-tab fallback. */
      }
    }
    this.memory = saved;
    return resumeRoutes.has(route) ? (saved?.token ?? null) : null;
  }
  clear() {
    this.memory = null;
    try {
      this.storage?.removeItem(key);
    } catch {
      /* Storage can be blocked. */
    }
  }
  get accountCreated() {
    return this.memory?.accountCreated === true;
  }
  markAccountCreated() {
    if (!this.memory) return;
    this.memory.accountCreated = true;
    try {
      this.storage?.setItem(key, JSON.stringify(this.memory));
    } catch {
      /* Keep same-tab fallback. */
    }
  }
}
