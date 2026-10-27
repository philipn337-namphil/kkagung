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
  it.each(['/server.js', '/.env.example', '/.env', '/package.json', '/Dockerfile', '/%2eenv', '/..%2fbackend%2f.env'])('non-public file %s must not be served', async path => {
    const response = await fetch(base + path);
    await response.arrayBuffer();
    expect([403, 404].includes(response.status)).toBe(true);
  });
  it.each(['/index.html', '/app.js', '/styles.css', '/config.js'])('public asset %s remains available', async path => {
    expect((await fetch(base + path)).status).toBe(200);
  });
});

describe('frontend profile output encoding (renderer, no browser script execution)', () => {
  it.each(['<img src=x data-security-test=unescaped>', '\" autofocus onfocus=alert(1) x=\"', '</textarea><script>alert(1)</script>'])('profile input must not create unescaped HTML in output (%s)', marker => {
    const sandbox: any = {
      window: { addEventListener: () => {}, scrollTo: () => {} },
      sessionStorage: { getItem: () => null },
      location: { hash: '#/' },
      document: { querySelector: (selector: string) => selector === '#app' ? { innerHTML: '', querySelector: () => null } : null },
    };
    const source = readFileSync(resolve(root, 'frontend/app.js'), 'utf8');
    vm.runInNewContext(source + `\nstate.me = { profile: { displayName: ${JSON.stringify(marker)}, intro: ${JSON.stringify(marker)} } }; globalThis.output = profile(); globalThis.escaped = escapeHtml(${JSON.stringify(marker)});`, sandbox);
    expect(sandbox.output.includes(marker)).toBe(false);
    expect(sandbox.output.includes(sandbox.escaped)).toBe(true);
  });
});

describe('production config (isolated process, empty environment fixture)', () => {
  it('APP_ENV production also selects the production TTL and registration gate', () => {
    const configUrl = pathToFileURL(resolve(root, 'backend/dist/src/config.js')).href;
    const env = { ...process.env, NODE_ENV: 'development', APP_ENV: 'production', JWT_SECRET: crypto.randomUUID() + crypto.randomUUID(), DOTENV_CONFIG_PATH: 'does-not-exist.env' };
    delete env.JWT_EXPIRES_IN;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const {config}=await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({production:config.production,ttl:config.jwtExpiresIn}));`], {
      cwd: mkdtempSync(resolve(tmpdir(), 'kkagung-app-env-')), env, encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ production: true, ttl: '900s' });
  });
  it.each(['', 'short-test-value', 'local_development_secret_change_before_production'])('development also rejects empty short or known example key (%s)', secret => {
    const configUrl = pathToFileURL(resolve(root, 'backend/dist/src/config.js')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)})`], {
      cwd: mkdtempSync(resolve(tmpdir(), 'kkagung-key-config-')),
      env: { ...process.env, NODE_ENV: 'development', JWT_SECRET: secret, DOTENV_CONFIG_PATH: 'does-not-exist.env' },
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).not.toBe(0);
  });
  it('empty production JWT signing key must fail on startup', () => {
    const configUrl = pathToFileURL(resolve(root, 'backend/dist/src/config.js')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)})`], {
      cwd: mkdtempSync(resolve(tmpdir(), 'kkagung-empty-config-')),
      env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: '', DOTENV_CONFIG_PATH: 'does-not-exist.env' },
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).not.toBe(0);
  });
  it.each([
    ['development', undefined, '12h'],
    ['production', undefined, '900s'],
    ['development', '1800s', '1800s'],
  ])('D-03 config %s override %s resolves to %s', (environment, ttl, expected) => {
    const configUrl = pathToFileURL(resolve(root, 'backend/dist/src/config.js')).href;
    const env = { ...process.env, NODE_ENV: environment, JWT_SECRET: crypto.randomUUID() + crypto.randomUUID(), DOTENV_CONFIG_PATH: 'does-not-exist.env' };
    delete env.JWT_EXPIRES_IN;
    if (ttl) env.JWT_EXPIRES_IN = ttl;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const { config } = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ ttl: config.jwtExpiresIn ?? null }));`], {
      cwd: mkdtempSync(resolve(tmpdir(), 'kkagung-ttl-config-')), env,
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(output.ttl).toBe(expected);
  });
  it.each(['', '900', '0s', '-1h', 'not-a-duration', '900s\n'])('invalid TTL %s fails before startup', ttl => {
    const configUrl = pathToFileURL(resolve(root, 'backend/dist/src/config.js')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(configUrl)})`], {
      cwd: mkdtempSync(resolve(tmpdir(), 'kkagung-invalid-ttl-')),
      env: { ...process.env, NODE_ENV: 'production', JWT_SECRET: crypto.randomUUID() + crypto.randomUUID(), JWT_EXPIRES_IN: ttl, DOTENV_CONFIG_PATH: 'does-not-exist.env' },
      encoding: 'utf8', timeout: 10000,
    });
    expect(result.status).not.toBe(0);
  });
});

describe('frontend server logout ordering', () => {
  it.each([true, false])('removes local token only after successful server revocation (%s)', async success => {
    const removed: string[] = [];
    const calls: string[] = [];
    let logoutHandler: (() => Promise<void>) | undefined;
    const app = { innerHTML: '' };
    const logout = { addEventListener: (_name: string, handler: () => Promise<void>) => { logoutHandler = handler; } };
    const sandbox: any = {
      window: { addEventListener: () => {}, scrollTo: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: (key: string) => removed.push(key) },
      location: { hash: '#/' },
      document: { querySelector: (selector: string) => selector === '#app' ? app : selector === '#logout' ? logout : null },
      fetch: async (url: string) => { calls.push(url); return { ok: success, status: success ? 200 : 500,
        json: async () => ({ success, data: {}, error: { message: 'Synthetic failure' } }) }; },
    };
    const source = readFileSync(resolve(root, 'frontend/app.js'), 'utf8');
    const context = vm.createContext(sandbox);
    vm.runInContext(source + "\nstate.token='synthetic-fixture';state.user={id:'1',role:'USER'};", context);
    expect(logoutHandler).toBeTypeOf('function');
    await logoutHandler!();
    if (success) { expect(removed).toEqual(['kkagung.access-token']); expect(vm.runInContext('state.token', context)).toBeNull(); }
    else { expect(removed).toEqual([]); expect(vm.runInContext('state.token', context)).toBe('synthetic-fixture'); }
    expect(calls).toEqual(['http://localhost:8080/api/v1/auth/logout']);
  });
});
