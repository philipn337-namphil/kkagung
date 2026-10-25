import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';

// Findings contain paths and rule names only, never file contents or secret values.
export function inspectFile(path, bytes) {
  const normalized = path.replaceAll('\\', '/');
  const name = normalized.split('/').at(-1);
  const findings = [];
  const add = rule => findings.push({ path: normalized, rule });
  const envExample = /^\.env(?:\.[\w-]+)*\.example$/.test(name);
  if (/^\.env(?:\.|$)/.test(name) && !envExample) add('environment-file');
  if (/(^|\/)(originals|original-images|dumps|db-dumps|backups|\.aws)(\/|$)/i.test(normalized)
    || /(^|\/)(uploads\/originals?|storage\/private)(\/|$)/i.test(normalized)) add('private-data-path');
  if (/\.(pem|key|p12|pfx|jks|keystore|dump|bak)$/i.test(name)
    || /^(id_rsa|id_ed25519)(\.|$)/.test(name)
    || /^(credentials|service-account.*)\.json$/i.test(name)) add('credential-or-backup-file');
  if (/\.sql\.(gz|zip|bz2)$/i.test(name) || /^(dump.*|.*[-_]dump)\.sql$/i.test(name)) add('database-dump');
  if (bytes.includes(0)) return findings;
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)) add('private-key-content');
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) add('aws-access-key-literal');
  if (/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/.test(text)) add('jwt-literal');
  if (envExample) {
    const secretNames = /^(JWT_SECRET|[^\r\n=]*(?:API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY))[ \t]*=[ \t]*([^\r\n]*)/gm;
    for (const match of text.matchAll(secretNames)) {
      if (match[2].trim().replace(/^(['"])(.*)\1$/, '$2') !== '') add('nonempty-secret-in-example');
    }
  }
  return findings;
}

export function scanIndex(root) {
  const paths = execFileSync('git', ['ls-files', '--cached', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean);
  const findings = [];
  for (const path of paths) {
    const bytes = execFileSync('git', ['show', `:${path}`], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    findings.push(...inspectFile(path, bytes));
  }
  return { mode: 'current Git index only; not ignored local files or history', scannedFiles: paths.length, findings };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  try {
    const result = scanIndex(root);
    const evidence = { recordedAt: new Date().toISOString(), ...result };
    if (process.argv.includes('--evidence')) writeFileSync(resolve(root, 'infra/security/evidence/git-safety-results.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(`Git index safety: ${result.scannedFiles} files, ${result.findings.length} findings.`);
    for (const finding of result.findings) console.log(`${finding.rule}: ${finding.path}`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch { console.error('Git safety check could not read the index; check local Git access.'); process.exitCode = 2; }
}
