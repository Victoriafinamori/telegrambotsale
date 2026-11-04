import { resolve, sep } from 'node:path';

// The Hyze file manager addresses files relative to the application's persistent
// directory. Resolve that operator setting before the strict absolute-path check.
export function hyzeSqlitePath(value: string | undefined, directory = process.cwd()) {
  if (!value?.trim()) throw Error('Configure the private SQLite path');
  const root = resolve(directory),
    filename = resolve(root, value);
  if (!filename.startsWith(root + sep) || !filename.endsWith('.sqlite'))
    throw Error('Hyze SQLite path must stay inside the verified application directory');
  return filename;
}
