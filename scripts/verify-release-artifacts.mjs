import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(projectRoot, 'artifacts');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const receipt = JSON.parse(await readFile(path.join(artifactsRoot, 'RELEASE-MANIFEST.json'), 'utf8'));
const amoSubmission = JSON.parse(await readFile(path.join(artifactsRoot, 'AMO-SUBMISSION.json'), 'utf8'));

assert.equal(receipt.schemaVersion, 1, 'Release manifest schema is unsupported');
assert.equal(receipt.product, packageJson.name, 'Release manifest product differs from package.json');
assert.equal(receipt.version, packageJson.version, 'Release manifest version differs from package.json');
assert.equal(receipt.scope, 'telegram-web', 'Release manifest does not identify the Telegram-only scope');
assert.equal(amoSubmission.schemaVersion, 1, 'AMO submission receipt schema is unsupported');
assert.equal(amoSubmission.status, 'prepared_unpublished', 'AMO submission must remain unpublished');
assert.equal(amoSubmission.product, packageJson.name, 'AMO submission product differs from package.json');
assert.equal(amoSubmission.version, packageJson.version, 'AMO submission version differs from package.json');
assert.equal(amoSubmission.scope, 'telegram-web', 'AMO submission is not Telegram-only');
assert.equal(amoSubmission.publication?.publicMutation, false, 'AMO preparation cannot publish');

async function inspectFile(descriptor) {
  const absolute = path.join(artifactsRoot, descriptor.file);
  const bytes = await readFile(absolute);
  assert.equal(bytes.byteLength, descriptor.bytes, `${descriptor.file} size changed after packaging`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), descriptor.sha256, `${descriptor.file} hash changed`);
  return bytes;
}

const extensionBytes = await inspectFile(receipt.extension);
const sourceBytes = await inspectFile(receipt.sources);
const checksums = await readFile(path.join(artifactsRoot, 'SHA256SUMS.txt'), 'utf8');
assert.equal(
  checksums,
  `${receipt.extension.sha256}  artifacts/${receipt.extension.file}\n${receipt.sources.sha256}  artifacts/${receipt.sources.file}\n`,
  'SHA256SUMS.txt is not rooted at the project directory or does not match the manifest',
);

async function readZip(bytes, label) {
  const reader = new ZipReader(new BlobReader(new Blob([bytes])));
  const entries = await reader.getEntries();
  assert.ok(entries.length > 0, `${label} archive is empty`);
  const byName = new Map(entries.map((entry) => [entry.filename, entry]));
  return { reader, entries, byName };
}

const extension = await readZip(extensionBytes, 'Firefox package');
const manifestEntry = extension.byName.get('manifest.json');
assert.ok(manifestEntry, 'Firefox package has no manifest.json');
const manifest = JSON.parse(await manifestEntry.getData(new TextWriter()));
assert.equal(manifest.version, packageJson.version, 'Firefox package version differs from package.json');
assert.equal(manifest.browser_specific_settings?.gecko?.id, '{893462e9-4b44-4be5-97d6-f7178ef693b6}', 'Firefox add-on ID changed');
assert.equal(extension.entries.some((entry) => /discord/iu.test(entry.filename)), false, 'Firefox package contains a retired Discord entrypoint');
await extension.reader.close();

const sources = await readZip(sourceBytes, 'Source package');
for (const required of [
  'package.json',
  'package-lock.json',
  'Cargo.lock',
  '.rustfmt.toml',
  'rust-toolchain.toml',
  'docs/launch-checklist.md',
  'scripts/run-rust.mjs',
  'scripts/verify-release-artifacts.mjs',
  'scripts/release-contract.mjs',
  'scripts/firefox-proxy.mjs',
  'scripts/prepare-release-consumer.mjs',
  'scripts/prepare-amo-submission.mjs',
  'scripts/verify-consumer-proof.mjs',
]) {
  assert.ok(sources.byName.has(required), `Source package is missing ${required}`);
}
assert.equal(sources.entries.some((entry) => /^(?:node_modules|artifacts|\.output)\//u.test(entry.filename)), false, 'Source package crossed an excluded boundary');
assert.equal(
  sources.entries.some((entry) => /^(?:docs\/discord-connector-decision\.md|entrypoints\/discord-exporter\.ts|scripts\/e2e-firefox-discord\.mjs|src\/connectors\/discord-web\.ts)$/u.test(entry.filename)),
  false,
  'Telegram-only source package contains a retired Discord connector source',
);
await sources.reader.close();

console.log(`Verified release artifacts for ${packageJson.name} ${packageJson.version}: ${receipt.extension.file}, ${receipt.sources.file}.`);
