import { readFile } from 'node:fs/promises';
import hyzeBotLock from '../config/hyze-bot.package-lock.json' with { type: 'json' };
import { resolve } from 'node:path';

export class HostingError extends Error {
  constructor(
    readonly code: string,
    readonly uncertain = false,
  ) {
    super('Hosting operation failed');
  }
}
export interface HostingProvider {
  account(): Promise<{ available: number; apps: { id: string; name: string }[] }>;
  upload(archive: Uint8Array, name?: string): Promise<string>;
  configure(id: string, env: Record<string, string>): Promise<void>;
  running(id: string): Promise<boolean>;
}
export class SquareHosting implements HostingProvider {
  constructor(
    private key: string,
    private request: typeof fetch = fetch,
  ) {}
  private async call(path: string, method = 'GET', body?: BodyInit) {
    let response: Response;
    try {
      response = await this.request('https://api.squarecloud.app/v2' + path, {
        method,
        redirect: 'error',
        headers: {
          Authorization: this.key,
          ...(typeof body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        },
        body,
        signal: AbortSignal.timeout(path === '/apps' ? 120000 : 20000),
      });
    } catch {
      throw new HostingError('NETWORK', method === 'POST' && path === '/apps');
    }
    const data = await response.json().catch(() => null);
    if (!response.ok || data?.status !== 'success')
      throw new HostingError(
        [
          'INSUFFICIENT_MEMORY',
          'MISSING_SCOPE',
          'RESOURCE_NOT_ALLOWED',
          'ACCESS_DENIED',
          'RATE_LIMITED',
        ].includes(data?.code)
          ? data.code
          : 'PROVIDER_ERROR',
        path === '/apps' && method === 'POST' && (response.status >= 500 || response.ok),
      );
    return data.response;
  }
  async account() {
    const data = await this.call('/users/me');
    if (!Number.isFinite(data?.user?.plan?.memory?.available) || !Array.isArray(data?.applications))
      throw new HostingError('INVALID_RESPONSE');
    return {
      available: data.user.plan.memory.available as number,
      apps: data.applications as { id: string; name: string }[],
    };
  }
  async upload(archive: Uint8Array) {
    const form = new FormData();
    form.set(
      'file',
      new Blob([new Uint8Array(archive)], { type: 'application/zip' }),
      'blackout-bot.zip',
    );
    const data = await this.call('/apps', 'POST', form);
    if (!/^[a-f0-9]{32}$/.test(data?.id)) throw new HostingError('INVALID_RESPONSE', true);
    return data.id as string;
  }
  async configure(id: string, env: Record<string, string>) {
    await this.call('/apps/' + id + '/envs', 'POST', JSON.stringify({ envs: env }));
    await this.call('/apps/' + id + '/restart', 'POST');
  }
  async running(id: string) {
    return (await this.call('/apps/' + id + '/status'))?.running === true;
  }
}

// Small, stored ZIP with an explicit file allowlist. No platform secrets or source.
export function runtimeZip(files: Record<string, string | Uint8Array>) {
  const parts: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const [filename, content] of Object.entries(files)) {
    const name = Buffer.from(filename),
      data = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30),
      entry = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    parts.push(header, name, data);
    directory.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(directory.length / 2, 8);
  end.writeUInt16LE(directory.length / 2, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}
export async function buildRuntimeArchive(name: string, provider = 'squarecloud') {
  if (!/^Blackout-[0-9a-f-]{36}$/.test(name)) throw Error('Invalid deployment name');
  const runner = await readFile(resolve('dist-server/server/bot-runner.js'), 'utf8');
  const telegram = await readFile(resolve('dist-server/server/telegram-client.js'), 'utf8');
  return runtimeZip({
    'dist-server/server/bot-runner.js': runner.replace("import 'dotenv/config';", ''),
    'dist-server/server/telegram-client.js': telegram,
    'package.json': JSON.stringify({
      name: 'blackout-merchant-bot',
      version: '1.0.0',
      type: 'module',
      private: true,
      engines: { node: '>=24.12.0' },
      scripts: {
        start:
          provider === 'hyze'
            ? './node_modules/node/bin/node dist-server/server/bot-runner.js'
            : 'node dist-server/server/bot-runner.js',
      },
      ...(provider === 'hyze' ? { dependencies: { node: '24.18.0' } } : {}),
    }),
    ...(provider === 'hyze' ? { 'package-lock.json': JSON.stringify(hyzeBotLock) } : {}),
    ...(provider === 'squarecloud'
      ? {
          'squarecloud.app': `DISPLAY_NAME=${name}\nDESCRIPTION=Blackout managed merchant runtime\nMAIN=dist-server/server/bot-runner.js\nMEMORY=256\nVERSION=24\nRUNTIME=nodejs\nAUTORESTART=true\n`,
        }
      : {}),
  });
}
