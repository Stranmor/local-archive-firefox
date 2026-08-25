import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readReleaseManifest(projectRoot, manifestPath = process.env.LOCAL_ARCHIVE_RELEASE_MANIFEST) {
  if (!manifestPath) return null;
  const absolutePath = path.isAbsolute(manifestPath) ? manifestPath : path.resolve(projectRoot, manifestPath);
  return JSON.parse(await readFile(absolutePath, 'utf8'));
}

export async function assertReleaseArchive({ archivePath, packageJson, releaseManifest }) {
  assert.ok(releaseManifest, 'A release manifest is required for this consumer proof');
  assert.equal(releaseManifest.schemaVersion, 1, 'Release manifest schema is unsupported');
  assert.equal(releaseManifest.product, packageJson.name, 'Release manifest product differs from package.json');
  assert.equal(releaseManifest.version, packageJson.version, 'Release manifest version differs from package.json');
  assert.equal(releaseManifest.scope, 'telegram-web', 'Consumer archive is not the Telegram-only release');
  const bytes = await readFile(archivePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.byteLength, releaseManifest.extension.bytes, 'Consumer archive size differs from RELEASE-MANIFEST.json');
  assert.equal(sha256, releaseManifest.extension.sha256, 'Consumer archive hash differs from RELEASE-MANIFEST.json');
  return {
    file: releaseManifest.extension.file,
    sha256,
    bytes: bytes.byteLength,
  };
}
