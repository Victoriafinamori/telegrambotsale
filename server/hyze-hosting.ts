import { HostingError, buildRuntimeArchive, type HostingProvider } from './square-hosting.js';

const safeId = (id: unknown): id is string =>
  typeof id === 'string' && /^[A-Za-z0-9_-]{6,120}$/.test(id);
export const buildHyzeRuntimeArchive = (name: string) => buildRuntimeArchive(name, 'hyze');
export class HyzeHosting implements HostingProvider {
  constructor(
    private key: string,
    private request: typeof fetch = fetch,
  ) {}
  private async call(path: string, method = 'GET', body?: BodyInit) {
    let response: Response;
    const deploy = path === '/apps/deploy' && method === 'POST';
    try {
      response = await this.request('https://api.hyzecloud.com/api' + path, {
        method,
        redirect: 'error',
        headers: {
          Authorization: 'Bearer ' + this.key,
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        signal: AbortSignal.timeout(deploy ? 120000 : 20000),
      });
    } catch {
      throw new HostingError('NETWORK', deploy);
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.success === false || data.ok === false || data.error) {
      const code = data?.error?.code ?? data?.code;
      const mapped =
        response.status === 401
          ? 'ACCESS_DENIED'
          : response.status === 403
            ? 'MISSING_SCOPE'
            : response.status === 429
              ? 'RATE_LIMITED'
              : ['INSUFFICIENT_MEMORY', 'INSUFFICIENT_RAM', 'RAM_LIMIT_EXCEEDED'].includes(code)
                ? 'INSUFFICIENT_MEMORY'
                : 'PROVIDER_ERROR';
      throw new HostingError(
        mapped,
        deploy &&
          !['ACCESS_DENIED', 'MISSING_SCOPE', 'RATE_LIMITED', 'INSUFFICIENT_MEMORY'].includes(
            mapped,
          ),
      );
    }
    return data;
  }
  async account() {
    const plan = await this.call('/plans/current'),
      list = await this.call('/apps/');
    if (
      !Number.isFinite(plan?.usage?.availableRAM) ||
      !Array.isArray(list?.apps) ||
      list.apps.some((app: any) => !safeId(app.id) || typeof app.name !== 'string')
    )
      throw new HostingError('INVALID_RESPONSE');
    return {
      available: plan.usage.availableRAM as number,
      apps: list.apps as { id: string; name: string }[],
    };
  }
  async upload(archive: Uint8Array, name?: string) {
    if (!name || !/^Blackout-[0-9a-f-]{36}$/.test(name))
      throw new HostingError('INVALID_DEPLOYMENT_NAME');
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(archive)], { type: 'application/zip' }),
      'blackout-bot.zip',
    );
    form.set('name', name);
    form.set('runtime', 'node');
    form.set('memoryMB', '256');
    form.set('startupCommand', './node_modules/node/bin/node dist-server/server/bot-runner.js');
    form.set('autoRestart', 'true');
    // Worker has no public endpoint. Hyze owns reserved NODE_ENV/PORT variables.
    const data = await this.call('/apps/deploy', 'POST', form),
      id = data.appId ?? data.container?.id ?? data.id;
    if (!safeId(id)) throw new HostingError('INVALID_RESPONSE', true);
    return id;
  }
  async configure(id: string, env: Record<string, string>) {
    if (!safeId(id)) throw new HostingError('INVALID_APP_ID');
    const allowed = { BOT_API_ORIGIN: env.BOT_API_ORIGIN, BOT_RUNTIME_KEY: env.BOT_RUNTIME_KEY };
    await this.call('/apps/' + id + '/env', 'PUT', JSON.stringify({ envVars: allowed }));
    await this.call('/apps/' + id + '/restart', 'POST');
  }
  async running(id: string) {
    if (!safeId(id)) throw new HostingError('INVALID_APP_ID');
    return (await this.call('/apps/' + id))?.container?.status === 'running';
  }
}
