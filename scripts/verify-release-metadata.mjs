import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function read(relativePath) {
  return readFile(path.join(projectRoot, relativePath), 'utf8');
}

const [privacy, security, listing, buildGuide, readme, launchChecklist, ci, packageJson, wxtConfig, telegramE2e] = await Promise.all([
  read('PRIVACY.md'),
  read('SECURITY.md'),
  read('docs/amo-listing.md'),
  read('docs/build-for-amo.md'),
  read('README.md'),
  read('docs/launch-checklist.md'),
  read('.github/workflows/ci.yml'),
  read('package.json'),
  read('wxt.config.ts'),
  read('scripts/e2e-firefox-v3.mjs'),
]);

for (const [name, source] of [
  ['PRIVACY.md', privacy],
  ['SECURITY.md', security],
  ['docs/amo-listing.md', listing],
  ['docs/build-for-amo.md', buildGuide],
  ['README.md', readme],
  ['docs/launch-checklist.md', launchChecklist],
]) {
  assert.match(source, /Telegram Web/u, `${name} must describe Telegram Web`);
  assert.doesNotMatch(source, /Discord/iu, `${name} still exposes the retired Discord product scope`);
}

for (const [name, source] of [
  ['docs/amo-listing.md', listing],
  ['README.md', readme],
]) {
  assert.match(source, /account(?:-| )wide|account backup|резервн(?:ая|ую) копи/u, `${name} must reject account-wide backup claims`);
}

for (const [name, source] of [
  ['docs/amo-listing.md', listing],
  ['docs/build-for-amo.md', buildGuide],
  ['README.md', readme],
]) {
  assert.doesNotMatch(source, /scroll upward first|сначала прокрутите канал вверх/u, `${name} contains stale manual scrolling guidance`);
}

assert.match(privacy, /https:\/\/web\.telegram\.org\/\*/u, 'Privacy policy must explain Telegram host access');
assert.doesNotMatch(privacy, /https:\/\/discord\.com\//u, 'Privacy policy must not retain Discord host access');
assert.match(listing, /AMO reviewer notes/u, 'AMO listing must include reviewer notes');
assert.match(buildGuide, /source archive/u, 'Build guide must explain the matching source archive');
assert.match(wxtConfig, /optional_host_permissions:\s*\['https:\/\/web\.telegram\.org\/\*'\]/u, 'WXT manifest must expose only Telegram host permission');
assert.doesNotMatch(wxtConfig, /discord\.com/iu, 'WXT manifest must not expose Discord permissions or matches');
assert.match(
  ci,
  /LOCAL_ARCHIVE_TELEGRAM_E2E_ARTIFACTS:\s+\.output\/e2e-firefox-\$\{\{\s*matrix\.firefox\s*\}\}\/telegram/u,
  'CI must preserve the Telegram consumer evidence directory expected by the E2E script',
);
assert.doesNotMatch(ci, /discord/iu, 'CI must not run or publish a Discord consumer path');
assert.doesNotMatch(packageJson, /discord/iu, 'Package scripts and description must not expose Discord');
assert.match(packageJson, /scripts\/run-rust\.mjs/u, 'Rust npm scripts must use the project toolchain runner');
assert.match(ci, /run:\s+npm run package:release/u, 'CI must build and verify the release artifacts');
assert.match(ci, /artifacts\/RELEASE-MANIFEST\.json/u, 'CI must preserve the release manifest');
assert.match(ci, /actions\/download-artifact@v4/u, 'CI consumer must download the verified release artifact');
assert.match(ci, /node scripts\/verify-release-artifacts\.mjs/u, 'CI consumer must validate the downloaded release artifact');
assert.match(ci, /node scripts\/prepare-release-consumer\.mjs/u, 'CI consumer must prepare the exact manifest-selected archive');
assert.match(ci, /LOCAL_ARCHIVE_RELEASE_MANIFEST:\s+artifacts\/RELEASE-MANIFEST\.json/u, 'CI E2E must receive the exact release manifest path');
assert.match(ci, /npm run test:e2e:firefox/u, 'CI consumer must run Telegram E2E against the downloaded release artifact');
assert.match(ci, /node scripts\/verify-consumer-proof\.mjs/u, 'CI must compare the Telegram consumer proof with the release manifest');
assert.match(telegramE2e, /assertReleaseArchive/u, 'Telegram E2E must bind the consumed archive to RELEASE-MANIFEST.json');
assert.match(telegramE2e, /packageDescriptor\.file/u, 'Telegram E2E must report the manifest-selected package filename');
assert.doesNotMatch(ci, /run:\s+npm run check:consumer/u, 'CI consumer must not rebuild a different package before E2E');

console.log('Verified Telegram-only release metadata: scope, privacy boundary, coverage claims, CI evidence path, and AMO handoff are synchronized.');
