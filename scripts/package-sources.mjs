import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BlobWriter,
  Uint8ArrayReader,
  ZipWriter,
} from '@zip.js/zip.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, '.output');
const artifacts = path.join(root, 'artifacts');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const baseName = `${packageJson.name}-${packageJson.version}`;
const artifactBaseName = `Local-Archive-Telegram-${packageJson.version}`;
const extensionSource = path.join(output, `${baseName}-firefox.zip`);
const sourceOutput = path.join(output, `${baseName}-sources.zip`);
const artifactExtension = path.join(artifacts, `${artifactBaseName}-firefox-unsigned.zip`);
const artifactSources = path.join(artifacts, `${artifactBaseName}-sources.zip`);
const releaseManifest = path.join(artifacts, 'RELEASE-MANIFEST.json');
const excludedReleaseSources = new Set([
  'docs/discord-connector-decision.md',
  'entrypoints/discord-exporter.ts',
  'scripts/e2e-firefox-discord.mjs',
  'src/connectors/discord-web.ts',
]);

const sourceRoots = [
  '.github',
  '.gitignore',
  'Cargo.lock',
  'Cargo.toml',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'crates',
  'LICENSE',
  'NOTICE.md',
  'PRIVACY.md',
  'README.md',
  'SECURITY.md',
  'assets',
  'docs',
  'entrypoints',
  'legacy',
  'package-lock.json',
  'package.json',
  'public',
  'scripts',
  'src',
  'telegram-chat-exporter-hardened.user.js',
  'telegram-chat-exporter-hardening.diff',
  'tests',
  'tsconfig.json',
  'vitest.config.ts',
  'wxt.config.ts',
  'rust-toolchain.toml',
];

async function collect(absolute, relative = '') {
  const info = await stat(absolute);
  if (info.isFile()) return [{ absolute, relative: relative.replaceAll(path.sep, '/') }];
  if (!info.isDirectory()) throw new Error(`Unsupported source entry: ${absolute}`);

  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new Error(`Source archive cannot contain symlinks: ${entry.name}`);
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (childRelative.replaceAll(path.sep, '/').startsWith('src/generated/')) continue;
    files.push(...await collect(path.join(absolute, entry.name), childRelative));
  }
  return files;
}

const files = [];
for (const source of sourceRoots) {
  const collected = await collect(path.join(root, source), source);
  files.push(...collected.filter((file) => !excludedReleaseSources.has(file.relative)));
}
files.sort((left, right) => left.relative.localeCompare(right.relative));

for (const required of [
  'package.json',
  'package-lock.json',
  'Cargo.lock',
  'Cargo.toml',
  'rust-toolchain.toml',
  'crates/local-archive-core/Cargo.toml',
  'crates/local-archive-core/LICENSE',
  'crates/local-archive-core/src/lib.rs',
  'tests/archive-service.test.ts',
  'tests/exporter.test.ts',
  'tests/preferences.test.ts',
  'tests/quick-export-defaults.test.ts',
  'scripts/e2e-firefox-v3.mjs',
  'scripts/smoke-telegram-web.mjs',
  'scripts/run-rust.mjs',
  'scripts/package-sources.mjs',
  'scripts/prepare-amo-submission.mjs',
  'scripts/verify-release-artifacts.mjs',
  'scripts/release-contract.mjs',
  'scripts/firefox-proxy.mjs',
  'scripts/prepare-release-consumer.mjs',
  'scripts/verify-consumer-proof.mjs',
]) {
  if (!files.some((file) => file.relative === required)) throw new Error(`Source archive is missing ${required}`);
}
if (files.some((file) => /^(?:artifacts|node_modules|tmp|\.output|\.wxt|src\/generated)\//u.test(file.relative))) {
  throw new Error('Source archive crossed an excluded boundary');
}
if (files.some((file) => excludedReleaseSources.has(file.relative))) {
  throw new Error('Telegram-only source archive contains a retired connector source');
}

const zipWriter = new ZipWriter(new BlobWriter('application/zip'), {
  level: 9,
  useCompressionStream: false,
  useWebWorkers: false,
});
const deterministicDate = new Date('1980-01-01T00:00:00.000Z');
for (const file of files) {
  const bytes = await readFile(file.absolute);
  await zipWriter.add(file.relative, new Uint8ArrayReader(bytes), {
    lastModDate: deterministicDate,
    level: 9,
    useCompressionStream: false,
    useWebWorkers: false,
  });
}
const sourceBlob = await zipWriter.close();
await writeFile(sourceOutput, new Uint8Array(await sourceBlob.arrayBuffer()));

await mkdir(artifacts, { recursive: true });
await Promise.all([
  copyFile(extensionSource, artifactExtension),
  copyFile(sourceOutput, artifactSources),
]);

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
const checksums = [
  `${await sha256(artifactExtension)}  artifacts/${path.basename(artifactExtension)}`,
  `${await sha256(artifactSources)}  artifacts/${path.basename(artifactSources)}`,
].join('\n');
await writeFile(path.join(artifacts, 'SHA256SUMS.txt'), `${checksums}\n`, 'utf8');
await writeFile(releaseManifest, `${JSON.stringify({
  schemaVersion: 1,
  product: packageJson.name,
  version: packageJson.version,
  scope: 'telegram-web',
  extension: {
    file: path.basename(artifactExtension),
    bytes: (await stat(artifactExtension)).size,
    sha256: await sha256(artifactExtension),
  },
  sources: {
    file: path.basename(artifactSources),
    bytes: (await stat(artifactSources)).size,
    sha256: await sha256(artifactSources),
    fileCount: files.length,
  },
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`, 'utf8');
await Promise.all([
  chmod(artifactExtension, 0o644),
  chmod(artifactSources, 0o644),
  chmod(path.join(artifacts, 'SHA256SUMS.txt'), 0o644),
  chmod(releaseManifest, 0o644),
]);

console.log(`Packaged ${files.length} source files without build output, dependencies, temporary files, or prior artifacts.`);
