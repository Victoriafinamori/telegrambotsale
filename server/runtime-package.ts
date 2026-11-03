import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Explicit allowlist. Never recursively copy the platform server or private data.
export const runtimeFiles = [
  'bot-runner.js',
  'telegram-client.js',
  'bot-navigation.js',
  'local-navigation.js',
  'local-shop-store.js',
  'sqlite-document-store.js',
  'secret-vault.js',
  'types.js',
  'local-shop-editor.js',
  'shop-configuration.js',
  'local-update-cursor.js',
  'bot-appearance.js',
  'token-hash.js',
] as const;

export async function runtimeSources(directory = resolve('dist-server/server')) {
  const sources: Record<string, string> = {};
  for (const file of runtimeFiles) {
    const source = await readFile(resolve(directory, file), 'utf8');
    sources['dist-server/server/' + file] =
      file === 'bot-runner.js' ? source.replace("import 'dotenv/config';", '') : source;
  }
  return sources;
}
