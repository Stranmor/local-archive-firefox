import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseManifest } from './release-contract.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const proofPaths = process.argv.slice(2);
assert.ok(proofPaths.length > 0, 'At least one consumer-proof.json path is required');
const releaseManifest = await readReleaseManifest(projectRoot, process.env.LOCAL_ARCHIVE_RELEASE_MANIFEST || 'artifacts/RELEASE-MANIFEST.json');
assert.ok(releaseManifest, 'Release manifest is required to verify consumer proof');

for (const proofPath of proofPaths) {
  const absolutePath = path.isAbsolute(proofPath) ? proofPath : path.resolve(projectRoot, proofPath);
  const proof = JSON.parse(await readFile(absolutePath, 'utf8'));
  assert.equal(proof.status, 'passed', `${proofPath} is not a passed consumer proof`);
  assert.equal(proof.extensionVersion, releaseManifest.version, `${proofPath} version differs from RELEASE-MANIFEST.json`);
  assert.equal(proof.package?.file, releaseManifest.extension.file, `${proofPath} names a package different from RELEASE-MANIFEST.json`);
  assert.equal(proof.package?.sha256, releaseManifest.extension.sha256, `${proofPath} hash differs from RELEASE-MANIFEST.json`);
}

console.log(`Verified ${proofPaths.length} consumer proof(s) against ${releaseManifest.extension.file} (${releaseManifest.extension.sha256}).`);
