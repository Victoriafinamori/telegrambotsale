import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const api = process.env.VITE_API_ORIGIN || '';
if (api) {
  const url = new URL(api);
  if (url.origin !== api || url.protocol !== 'https:' || url.username || url.password)
    throw Error('VITE_API_ORIGIN deve ser a origem HTTPS exata da API, sem barra final.');
}
const config = JSON.parse(await readFile('firebase.json', 'utf8'));
config.firestore.rules = resolve('firestore.rules');
config.firestore.indexes = resolve('firestore.indexes.json');
config.hosting = {
  public: resolve('dist'),
  ignore: ['**/.*', '**/node_modules/**'],
  rewrites: [{ source: '**', destination: '/index.html' }],
  headers: [
    {
      source: '**',
      headers: [
        {
          key: 'Content-Security-Policy',
          value: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com ${api}; frame-ancestors 'none'; form-action 'self'; object-src 'none'; upgrade-insecure-requests`,
        },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=15552000' },
      ],
    },
    { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'no-store' }] },
  ],
};
await mkdir('.local', { recursive: true });
await writeFile('.local/firebase.hosting.json', JSON.stringify(config, null, 2) + '\n');
console.log(
  api
    ? 'Firebase Hosting preparado com a origem HTTPS da API.'
    : 'Firebase Hosting preparado para a landing pública. A área restrita ainda precisa de VITE_API_ORIGIN.',
);
