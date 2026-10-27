type Preferences = Pick<Storage, 'getItem' | 'setItem'>;
const memory = new Set<string>();
const key = (scope: string) => 'blackout.setup.dismissed.' + scope;
export function setupDismissed(scope: string, storage?: Preferences) {
  try {
    const saved = storage?.getItem(key(scope));
    return saved != null ? saved === 'true' : memory.has(scope);
  } catch {
    return memory.has(scope);
  }
}
export function rememberSetupDismissed(scope: string, hidden: boolean, storage?: Preferences) {
  if (hidden) memory.add(scope);
  else memory.delete(scope);
  try {
    storage?.setItem(key(scope), String(hidden));
  } catch {
    /* Optional preference. */
  }
}
export function setupVisibility(
  ready: boolean,
  scope: string,
  forceOpen: boolean,
  storage?: Preferences,
) {
  if (ready) rememberSetupDismissed(scope, true, storage);
  return forceOpen
    ? 'open'
    : ready
      ? 'complete'
      : setupDismissed(scope, storage)
        ? 'closed'
        : 'open';
}
