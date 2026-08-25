import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifactsRoot = path.join(root, 'artifacts');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const releaseManifest = JSON.parse(await readFile(path.join(artifactsRoot, 'RELEASE-MANIFEST.json'), 'utf8'));
const extensionManifest = JSON.parse(await readFile(path.join(root, '.output/firefox-mv3/manifest.json'), 'utf8'));
const repositoryUrl = packageJson.homepage;
const supportUrl = packageJson.bugs?.url;
const securityUrl = `${repositoryUrl}/security/advisories/new`;

assert.equal(releaseManifest.product, packageJson.name, 'Release product differs from package.json');
assert.equal(releaseManifest.version, packageJson.version, 'Release version differs from package.json');
assert.equal(releaseManifest.scope, 'telegram-web', 'AMO package must be Telegram-only');
assert.equal(extensionManifest.version, packageJson.version, 'Built manifest version differs from package.json');
assert.equal(
  extensionManifest.browser_specific_settings?.gecko?.id,
  '{893462e9-4b44-4be5-97d6-f7178ef693b6}',
  'Firefox add-on ID changed',
);

const metadataFiles = [
  'docs/amo-listing.md',
  'docs/build-for-amo.md',
  'PRIVACY.md',
  'SECURITY.md',
  'README.md',
];
const metadata = {};
for (const relative of metadataFiles) {
  const content = await readFile(path.join(root, relative), 'utf8');
  assert.match(content, /Telegram/iu, `${relative} does not describe Telegram support`);
  assert.doesNotMatch(content, /Discord/iu, `${relative} contains a retired public source`);
  metadata[relative] = {
    bytes: Buffer.byteLength(content),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function descriptor(relative, expected) {
  const absolute = path.join(artifactsRoot, relative);
  const bytes = await readFile(absolute);
  const actual = {
    file: relative,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  assert.equal(actual.bytes, expected.bytes, `${relative} size differs from RELEASE-MANIFEST.json`);
  assert.equal(actual.sha256, expected.sha256, `${relative} hash differs from RELEASE-MANIFEST.json`);
  return actual;
}

const extension = await descriptor(releaseManifest.extension.file, releaseManifest.extension);
const sources = await descriptor(releaseManifest.sources.file, releaseManifest.sources);
const submission = {
  schemaVersion: 1,
  status: 'prepared_unpublished',
  product: packageJson.name,
  version: packageJson.version,
  scope: 'telegram-web',
  generatedAt: new Date().toISOString(),
  listing: {
    draft: 'docs/amo-listing.md',
    locales: ['en-US', 'ru', 'uk', 'de', 'fr', 'es', 'pt-BR', 'pl'],
    reviewerNotes: 'docs/amo-listing.md#amo-reviewer-notes',
  },
  privacy: {
    policy: 'PRIVACY.md',
    dataCollection: extensionManifest.browser_specific_settings?.gecko?.data_collection_permissions ?? null,
  },
  permissions: {
    required: extensionManifest.permissions ?? [],
    optional: extensionManifest.optional_permissions ?? [],
    optionalHost: extensionManifest.optional_host_permissions ?? [],
  },
  package: {
    ...extension,
    signed: false,
    signing: 'Mozilla AMO must sign the submitted Firefox package',
  },
  sources: {
    ...sources,
    manifest: 'RELEASE-MANIFEST.json',
  },
  metadata,
  support: {
    status: 'configured',
    publicIssueTracker: supportUrl,
    action: 'Use the public issue tracker for product questions and reproducible bugs',
  },
  security: {
    status: 'configured',
    privateAdvisory: securityUrl,
    action: 'Use private GitHub Security Advisories for vulnerability reports',
  },
  signing: {
    status: 'external_amo_required',
    provider: 'Mozilla Add-ons',
    localSigning: false,
  },
  publication: {
    status: 'not_published',
    destination: 'Mozilla Add-ons',
    publicMutation: false,
    owner: null,
    authority: null,
  },
};

const serialized = JSON.stringify(submission, null, 2);
assert.doesNotMatch(serialized, /(?:jwt|secret|password|cookie|authorization)/iu, 'Submission receipt contains a secret-like field');
await writeFile(path.join(artifactsRoot, 'AMO-SUBMISSION.json'), `${serialized}\n`, 'utf8');
const receiptInfo = await stat(path.join(artifactsRoot, 'AMO-SUBMISSION.json'));
console.log(`Prepared unpublished AMO submission receipt for ${packageJson.name} ${packageJson.version} (${receiptInfo.size} bytes).`);
