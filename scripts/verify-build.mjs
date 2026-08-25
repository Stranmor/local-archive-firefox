import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.join(projectRoot, '.output', 'firefox-mv3');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute));
    else files.push(absolute);
  }
  return files;
}

const localeDirectories = ['en', 'ru', 'uk', 'de', 'fr', 'es', 'pt_BR', 'pl'];
const [manifest, packageJson, ...locales] = await Promise.all([
  readJson(path.join(outputRoot, 'manifest.json')),
  readJson(path.join(projectRoot, 'package.json')),
  ...localeDirectories.map((locale) => readJson(path.join(outputRoot, '_locales', locale, 'messages.json'))),
]);

assert.equal(manifest.manifest_version, 3, 'Firefox package must use Manifest V3');
assert.equal(manifest.version, packageJson.version, 'Manifest and package versions must match');
assert.equal(manifest.version, '3.0.0', 'The Rust-core release must remain versioned as 3.0.0');
assert.deepEqual(
  [...manifest.permissions].sort(),
  ['activeTab', 'downloads', 'scripting', 'storage'].sort(),
  'Permission set changed; review the privacy boundary explicitly',
);
assert.ok(!('host_permissions' in manifest), 'Telegram access must not be granted before the user starts an export');
assert.deepEqual(
  manifest.optional_host_permissions,
  ['https://web.telegram.org/*'],
  'The Telegram-only release must request only the Telegram origin',
);
assert.ok(!('content_scripts' in manifest), 'The exporter must run only after an explicit toolbar action');
assert.deepEqual(
  manifest.web_accessible_resources,
  [
    { resources: ['icon-48.png'], matches: ['https://web.telegram.org/*'] },
    { resources: ['telegram-page-bridge.js'], matches: ['https://web.telegram.org/*'] },
  ],
  'Only the Telegram dialog icon and page bridge may be exposed to the exact source origin',
);
assert.ok('background' in manifest, 'The isolated archive service background entrypoint is missing');
assert.ok(
  manifest.background?.service_worker === 'background.js'
    || manifest.background?.scripts?.includes('background.js'),
  'The archive service must be owned by background.js',
);
assert.equal(manifest.action?.default_popup, 'popup.html', 'Toolbar popup is missing');
assert.equal(manifest.options_ui?.page, 'options.html', 'Options page is missing');
assert.equal(manifest.options_ui?.open_in_tab, true, 'Options should open as a full tab');
assert.deepEqual(
  manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required,
  ['none'],
  'Firefox data-collection declaration must remain explicit and empty',
);
assert.equal(
  manifest.content_security_policy?.extension_pages,
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
  'The extension CSP must allow only bundled scripts plus local WebAssembly compilation',
);

for (const [index, messages] of locales.entries()) {
  assert.ok(messages.extensionName?.message, `${localeDirectories[index]} extension name is missing`);
  assert.ok(messages.extensionDescription?.message, `${localeDirectories[index]} extension description is missing`);
}

const englishMessageNames = Object.keys(locales[0]).sort();
const englishPlaceholderNames = new Map(
  Object.entries(locales[0]).map(([name, descriptor]) => [
    name,
    Object.keys(descriptor.placeholders ?? {}).sort(),
  ]),
);
function messagePlaceholderNames(descriptor) {
  return [...new Set(
    [...String(descriptor.message ?? '').matchAll(/\$([A-Z][A-Z0-9_]*)\$/gu)]
      .map((match) => match[1].toLowerCase()),
  )].sort();
}
for (const [index, messages] of locales.entries()) {
  const locale = localeDirectories[index];
  assert.deepEqual(
    Object.keys(messages).sort(),
    englishMessageNames,
    `${locale} locale must contain exactly the English message catalog`,
  );
  for (const [name, descriptor] of Object.entries(messages)) {
    assert.ok(descriptor.message?.trim(), `${locale}.${name} message is empty`);
    assert.deepEqual(
      Object.keys(descriptor.placeholders ?? {}).sort(),
      englishPlaceholderNames.get(name),
      `${locale}.${name} placeholders differ from English`,
    );
    assert.deepEqual(
      messagePlaceholderNames(descriptor),
      Object.keys(descriptor.placeholders ?? {}).map((placeholder) => placeholder.toLowerCase()).sort(),
      `${locale}.${name} message placeholders do not match its metadata`,
    );
  }
}

for (const required of [
  'popup.html',
  'options.html',
  'telegram-exporter.js',
  'telegram-page-bridge.js',
  'icon-16.png',
  'icon-48.png',
  'icon-96.png',
  'icon-128.png',
]) {
  await stat(path.join(outputRoot, required));
}

const files = await walk(outputRoot);
const totalBytes = (await Promise.all(files.map(async (file) => (await stat(file)).size)))
  .reduce((sum, size) => sum + size, 0);
// The complete eight-locale catalog is intentional release payload, not dead weight.
// Keep a hard ceiling that leaves room for translated copy while catching accidental
// bundling of source maps, test fixtures, or duplicate runtimes.
assert.ok(totalBytes < 8 * 1024 * 1024, `Build unexpectedly grew to ${totalBytes} bytes`);
assert.equal(files.some((file) => file.endsWith('.map')), false, 'Production package contains source maps');

const javascriptSources = await Promise.all(
  files.filter((entry) => entry.endsWith('.js')).map((file) => readFile(file, 'utf8')),
);
assert.ok(
  javascriptSources.some((source) => source.includes('new WebAssembly.Module')),
  'The packaged extension does not contain the synchronous Rust/WASM runtime',
);
assert.ok(
  javascriptSources.some((source) => source.includes("engine:'rust-wasm'") || source.includes('engine: "rust-wasm"')),
  'The packaged connector does not expose its Rust engine identity',
);
assert.equal(
  files.some((file) => /discord/iu.test(path.relative(outputRoot, file)))
    || javascriptSources.some((source) => /discord\.com|discord-exporter|discord-web/iu.test(source)),
  false,
  'The Telegram-only release must not contain Discord files, origins, or connector code',
);
assert.equal(
  javascriptSources.some((source) => /Authorization\s*[:=]/u.test(source) || /localStorage\.getItem\(['"]token['"]\)/u.test(source)),
  false,
  'The Telegram connector must not capture or replay a user token',
);

for (const file of files.filter((entry) => /\.(?:html|css)$/u.test(entry))) {
  const source = await readFile(file, 'utf8');
  assert.equal(
    /<(?:script|link)\b[^>]*(?:src|href)=["']https?:/iu.test(source),
    false,
    `Remote executable or stylesheet reference found in ${path.relative(outputRoot, file)}`,
  );
  assert.equal(
    /url\(["']?https?:/iu.test(source),
    false,
    `Remote CSS asset found in ${path.relative(outputRoot, file)}`,
  );
}

for (const [index, file] of files.filter((entry) => entry.endsWith('.js')).entries()) {
  const source = javascriptSources[index];
  assert.equal(/\beval\s*\(/u.test(source), false, `Dynamic eval found in ${path.relative(outputRoot, file)}`);
  assert.equal(/new\s+Function\s*\(/u.test(source), false, `Dynamic Function found in ${path.relative(outputRoot, file)}`);
  assert.equal(
    /import\s*\(\s*["']https?:\/\//u.test(source),
    false,
    `Remote dynamic import found in ${path.relative(outputRoot, file)}`,
  );
}

console.log(`Verified Firefox MV3 package: ${files.length} files, ${(totalBytes / 1024).toFixed(1)} KiB, least-privilege manifest.`);
