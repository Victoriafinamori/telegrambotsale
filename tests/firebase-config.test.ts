import test from 'node:test';
import assert from 'node:assert/strict';
import registered from '../config/firebase.web.json' with { type: 'json' };
import { loadConfig, publicFirebaseOptions } from '../server/config.js';
import { fixture, testConfig } from './helpers.js';

test('Projeto Web registrado é aplicado com appId e sem Analytics ou credenciais privadas', async () => {
  const config = loadConfig({
    NODE_ENV: 'development',
    APP_ORIGIN: 'http://127.0.0.1:3000',
    DATABASE_URL: 'postgresql://user:private-test-only@localhost/db',
  });
  assert.equal(config.FIREBASE_PROJECT_ID, registered.projectId);
  assert.equal(config.FIREBASE_APP_ID, registered.appId);
  const f = await fixture(undefined, config);
  try {
    const user = await f.agent(),
      response = await user.request('/config'),
      value = await response.json();
    assert.deepEqual(value.firebase, {
      apiKey: registered.apiKey,
      authDomain: registered.authDomain,
      projectId: registered.projectId,
      appId: registered.appId,
    });
    assert.equal(value.emulatorHost, null);
    assert(!JSON.stringify(value).includes('private-test-only'));
    assert(!('measurementId' in value.firebase));
  } finally {
    await f.close();
  }
});

test('Configuração real não é herdada por emuladores nem por outro projeto', () => {
  const local = testConfig();
  assert.equal(local.FIREBASE_PROJECT_ID, 'demo-blackout-create');
  assert.equal(publicFirebaseOptions(local).appId, undefined);
  assert.equal(local.FIREBASE_WEB_API_KEY, 'demo-key');
  assert.throws(() =>
    loadConfig({
      APP_ORIGIN: 'http://127.0.0.1:3000',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    }),
  );
  assert.throws(() =>
    loadConfig({ APP_ORIGIN: 'http://127.0.0.1:3000', FIREBASE_PROJECT_ID: 'another-project' }),
  );
});
