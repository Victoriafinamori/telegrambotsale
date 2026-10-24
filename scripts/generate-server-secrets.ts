import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
await mkdir('.local', { recursive: true });
await writeFile(
  '.local/server-secrets.env',
  [
    'BOT_TOKEN_ENCRYPTION_KEY=' + randomBytes(32).toString('base64url'),
    'ADMIN_MFA_ENCRYPTION_KEY=' + randomBytes(32).toString('base64url'),
    '',
  ].join('\n'),
  { flag: 'wx', mode: 0o600 },
);
console.log(
  'Segredos gerados em .local/server-secrets.env, fora do Git. Transfira-os somente para as configurações privadas da hospedagem. Não sobrescreva sem planejar a recifragem dos dados.',
);
