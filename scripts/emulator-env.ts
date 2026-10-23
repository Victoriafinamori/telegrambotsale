import { resolve } from 'node:path';
export const emulatorEnv = () => ({
  ...process.env,
  // This CLI dispatcher ignores NO_PROXY. Keep loopback emulator calls off the proxy.
  HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
  http_proxy: '', https_proxy: '', all_proxy: '',
  GOOGLE_APPLICATION_CREDENTIALS: '',
  XDG_CONFIG_HOME: resolve('.local/cli-config'),
  FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true',
  CI: 'true',
  NO_PROXY: [process.env.NO_PROXY, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(','),
  no_proxy: [process.env.no_proxy, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(','),
});
