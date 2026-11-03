import { createHash } from 'node:crypto';

// Shared with the isolated merchant runtime: no account service or database imports.
export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
