import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(root, 'backend/package.json'));
const ts = require('typescript');

// Executes unchanged Git application modules. Only the Prisma boundary is replaced.
export function snapshotApp(revision, production = false) {
  process.env.JWT_SECRET = randomUUID() + randomUUID();
  process.env.NODE_ENV = production ? 'production' : 'development';
  process.env.APP_ENV = production ? 'production' : 'development';
  process.env.ENABLE_TEST_ACCOUNTS = 'true';
  process.env.ADMIN_ALLOWED_IP_CIDRS = '127.0.0.1';
  process.env.AUTH_JWT_ISSUER = 'kkagung-api'; process.env.AUTH_JWT_AUDIENCE = 'kkagung-client';
  delete process.env.JWT_EXPIRES_IN;
  const state = { user: null, passwordHash: '', revoked: new Map(), counters: new Map(), audit: [], settingWrites: 0 };
  const tx = {
    adminSetting: { findFirst: async () => null, upsert: async () => { state.settingWrites++; return {}; } },
    adminAuditLog: { create: async ({ data }) => { state.audit.push(data); return { id: 1n }; } },
  };
  const prisma = {
    user: { findUnique: async () => state.user, update: async () => state.user },
    revokedAccessToken: {
      findUnique: async ({ where }) => state.revoked.get(where.tokenHash) ?? null,
      upsert: async ({ create }) => { state.revoked.set(create.tokenHash, create); return create; },
    },
    rateLimitCounter: { upsert: async ({ create }) => {
      const key = create.keyHash + create.windowStart.toISOString();
      const count = (state.counters.get(key) ?? 0) + 1; state.counters.set(key, count); return { count };
    } },
    $transaction: async operation => operation(tx),
  };
  const cache = new Map(), sourceHashes = {};
  function load(path) {
    if (path === 'backend/src/prisma.ts') return { prisma };
    if (cache.has(path)) return cache.get(path).exports;
    const source = execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' });
    sourceHashes[path] = createHash('sha256').update(source).digest('hex');
    const module = { exports: {} }; cache.set(path, module);
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const resolveImport = name => name.startsWith('.')
      ? load(posix.normalize(posix.join(posix.dirname(path), name)).replace(/\.js$/, '.ts')) : require(name);
    vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename: path })(resolveImport, module, module.exports);
    return module.exports;
  }
  const app = load('backend/src/app.ts').app;
  const config = load('backend/src/config.ts').config;
  return { app, state, config, sourceHashes, revision };
}
