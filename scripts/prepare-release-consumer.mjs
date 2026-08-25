import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseArchive, readReleaseManifest } from './release-contract.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const releaseManifest = await readReleaseManifest(projectRoot, process.env.LOCAL_ARCHIVE_RELEASE_MANIFEST || 'artifacts/RELEASE-MANIFEST.json');
const sourceArchive = path.join(projectRoot, 'artifacts', releaseManifest.extension.file);
const expectedArchive = path.join(projectRoot, '.output', `${packageJson.name}-${packageJson.version}-firefox.zip`);

await stat(sourceArchive);
await assertReleaseArchive({ archivePath: sourceArchive, packageJson, releaseManifest });
await mkdir(path.dirname(expectedArchive), { recursive: true });
await copyFile(sourceArchive, expectedArchive);
assert.equal((await stat(expectedArchive)).size, releaseManifest.extension.bytes, 'Prepared consumer archive size changed');
console.log(`Prepared exact release consumer archive ${releaseManifest.extension.file} -> ${path.relative(projectRoot, expectedArchive)} (${releaseManifest.extension.sha256}).`);
