import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = process.cwd();
describe('frontend static file exposure (real server handler, loopback only)', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const require = createRequire(resolve(root, 'frontend/server.js'));
    let ready: Promise<void>;
    const sandbox = {
      __dirname: resolve(root, 'frontend'),
      process: { env: { PORT: '0', API_BASE_URL: 'http://localhost:8080' } },
      console: { log: () => {} },
      require: (name: string) => name === 'http' ? {
        createServer: (handler: any) => ({ listen: (_port: number, callback: () => void) => {
          server = createServer(handler);
          ready = new Promise<void>(resolveReady => server.listen(0, '127.0.0.1', () => { callback(); resolveReady(); }));
        } }),
      } : require(name),
    };
    // Execute unchanged server code; only bind to a random local port for isolation.
    vm.runInNewContext(readFileSync(resolve(root, 'frontend/server.js'), 'utf8'), sandbox);
    await ready!;
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async () => { if (server) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); });
  it('normal static page remains available', async () => expect((await fetch(base + '/')).status).toBe(200));
  it.each(['/server.js', '/.env.example'])('non-public file %s must not be served', async path => {
    const response = await fetch(base + path);
    await response.arrayBuffer();
    expect([403, 404].includes(response.status)).toBe(true);
  });
});

describe('frontend profile output encoding (renderer, no browser script execution)', () => {
  it('profile input must not create unescaped HTML in output', () => {
    const sandbox: any = {
      window: { addEventListener: () => {}, scrollTo: () => {} },
      sessionStorage: { getItem: () => null },
      location: { hash: '#/' },
      document: { querySelector: () => ({ innerHTML: '', querySelector: () => null }) },
    };
    const source = readFileSync(resolve(root, 'frontend/app.js'), 'utf8');
    const marker = '<img src=x data-security-test=unescaped>';
    vm.runInNewContext(source + `\nstate.profile = { displayName: ${JSON.stringify(marker)}, intro: ${JSON.stringify(marker)} }; globalThis.output = profile();`, sandbox);
    expect(sandbox.output.includes(marker)).toBe(false);
  });
});

describe('production config (isolated process, empty environment fixture)', () => {
  it('empty production JWT signing key must fail on startup', () => {
    const configUrl = pathToFileURL(resolve(root, 'backend/dist/src/config.js')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)})`], {
      cwd: mkdtempSync(resolve(tmpdir(), 'kkagung-empty-config-')),
      env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '', DOTENV_CONFIG_PATH: 'does-not-exist.env' },
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).not.toBe(0);
  });
});
