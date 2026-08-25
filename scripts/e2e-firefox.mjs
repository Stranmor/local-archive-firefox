import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import JSZip from 'jszip';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const extensionArchive = path.join(
  projectRoot,
  '.output',
  `${packageJson.name}-${packageJson.version}-firefox.zip`,
);
const firefoxBinary = process.env.FIREFOX_BIN || 'firefox';
const geckodriverBinary = process.env.GECKODRIVER_BIN || 'geckodriver';
const artifactsRoot = path.resolve(
  process.env.TELEARCHIVE_E2E_ARTIFACTS || path.join(projectRoot, '.output', 'e2e-firefox'),
);
const addonId = '{893462e9-4b44-4be5-97d6-f7178ef693b6}';

assert.ok(addonId, 'The Firefox action identifier could not be derived');
await access(extensionArchive);
await mkdir(artifactsRoot, { recursive: true });

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

const port = await reserveLoopbackPort();
const driverBaseUrl = `http://127.0.0.1:${port}`;
const workRoot = await mkdtemp(path.join(os.tmpdir(), 'telearchive-e2e-'));
const profileRoot = path.join(workRoot, 'profiles');
const downloadsRoot = path.join(workRoot, 'downloads');
const xdgConfigRoot = path.join(workRoot, 'xdg-config');
const xdgDataRoot = path.join(workRoot, 'xdg-data');
const desktopApplicationsRoot = path.join(xdgDataRoot, 'applications');
const showDownloadProbe = path.join(workRoot, 'show-download-probe.txt');
const showDownloadProbeScript = path.join(workRoot, 'show-download-probe.sh');
await Promise.all([
  mkdir(profileRoot),
  mkdir(downloadsRoot),
  mkdir(xdgConfigRoot),
  mkdir(desktopApplicationsRoot, { recursive: true }),
]);
await writeFile(
  showDownloadProbeScript,
  `#!/bin/sh\nprintf '%s\\n' "$1" > '${showDownloadProbe}'\n`,
);
await chmod(showDownloadProbeScript, 0o700);
await writeFile(
  path.join(desktopApplicationsRoot, 'telearchive-folder-probe.desktop'),
  `[Desktop Entry]
Type=Application
Name=Local Archive isolated folder probe
Exec=${showDownloadProbeScript} %u
NoDisplay=true
MimeType=inode/directory;
`,
);
await writeFile(
  path.join(xdgConfigRoot, 'mimeapps.list'),
  `[Default Applications]
inode/directory=telearchive-folder-probe.desktop

[Added Associations]
inode/directory=telearchive-folder-probe.desktop;
  `,
);
const privateBusConfig = path.join(workRoot, 'dbus-session.conf');
await writeFile(privateBusConfig, `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=${workRoot}</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow own="*"/>
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
  </policy>
</busconfig>
`);
const privateBusLog = [];
const privateBus = spawn('/usr/bin/dbus-daemon', [
  '--config-file', privateBusConfig,
  '--nofork',
  '--print-address=1',
], { stdio: ['ignore', 'pipe', 'pipe'] });
privateBus.stderr.setEncoding('utf8');
privateBus.stderr.on('data', (chunk) => privateBusLog.push(chunk));
const privateBusAddress = await new Promise((resolve, reject) => {
  let output = '';
  const timeout = setTimeout(() => reject(new Error('Timed out starting isolated D-Bus')), 5_000);
  const onExit = (code) => {
    clearTimeout(timeout);
    reject(new Error(`Isolated D-Bus exited with ${code}: ${privateBusLog.join('').slice(-2_000)}`));
  };
  privateBus.once('exit', onExit);
  privateBus.stdout.setEncoding('utf8');
  privateBus.stdout.on('data', (chunk) => {
    output += chunk;
    const newline = output.indexOf('\n');
    if (newline < 0) return;
    clearTimeout(timeout);
    privateBus.off('exit', onExit);
    resolve(output.slice(0, newline).trim());
  });
});
const driverEnvironment = {
  ...process.env,
  DBUS_SESSION_BUS_ADDRESS: privateBusAddress,
  XDG_CONFIG_HOME: xdgConfigRoot,
  XDG_DATA_HOME: xdgDataRoot,
  XDG_DATA_DIRS: `${xdgDataRoot}:${process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'}`,
};
delete driverEnvironment.DISPLAY;
delete driverEnvironment.XAUTHORITY;

const driverLog = [];
const driver = spawn(geckodriverBinary, [
  '--host', '127.0.0.1',
  '--port', String(port),
  '--allow-system-access',
  '--profile-root', profileRoot,
  '--log', 'info',
], {
  cwd: projectRoot,
  env: driverEnvironment,
  stdio: ['ignore', 'pipe', 'pipe'],
});

for (const stream of [driver.stdout, driver.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    driverLog.push(chunk);
    if (driverLog.length > 300) driverLog.shift();
  });
}

async function webdriver(method, endpoint, body, timeoutMs = 60_000) {
  const response = await fetch(`${driverBaseUrl}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json();
  const webdriverError = payload?.value
    && typeof payload.value === 'object'
    && typeof payload.value.error === 'string'
    && typeof payload.value.message === 'string';
  if (!response.ok || webdriverError) {
    throw new Error(
      payload?.value?.message
      || `${method} ${endpoint} failed with HTTP ${response.status}: ${JSON.stringify(payload?.value)}`,
    );
  }
  return payload.value;
}

let sessionId;
let mainWindow;
let targetMissedEvidence = null;

async function session(method, endpoint = '', body, timeoutMs) {
  assert.ok(sessionId, 'WebDriver session is not available');
  return webdriver(method, `/session/${sessionId}${endpoint}`, body, timeoutMs);
}

async function setContext(context) {
  await session('POST', '/moz/context', { context });
}

async function execute(script, args = []) {
  return session('POST', '/execute/sync', { script, args });
}

async function setShadowFileInput(selector, filePath) {
  await setContext('content');
  await execute(`
    const input = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector(arguments[0]);
    if (input) input.value = '';
    return Boolean(input);
  `, [selector]);
  const element = await execute(`
    return document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector(arguments[0]) || null;
  `, [selector]);
  const elementId = element?.['element-6066-11e4-a52e-4f735466cecf'] || element?.ELEMENT;
  assert.ok(elementId, `WebDriver did not resolve shadow file input ${selector}`);
  await session('POST', `/element/${elementId}/value`, {
    text: filePath,
    value: [...filePath],
  });
  const selectedName = await execute(`
    const input = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector(arguments[0]);
    if (!input?.files?.length) return '';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files[0].name || '';
  `, [selector]);
  assert.equal(selectedName, path.basename(filePath), `Firefox did not bind ${path.basename(filePath)} to ${selector}`);
}

async function switchToMainWindow() {
  if (mainWindow) await session('POST', '/window', { handle: mainWindow });
}

async function screenshot(name) {
  await switchToMainWindow();
  return screenshotCurrent(name);
}

async function screenshotCurrent(name) {
  await setContext('content');
  const base64 = await session('GET', '/screenshot');
  const destination = path.join(artifactsRoot, name);
  await writeFile(destination, Buffer.from(base64, 'base64'));
  return destination;
}

async function elementScreenshot(selector, name) {
  await setContext('content');
  const element = await session('POST', '/element', { using: 'css selector', value: selector });
  const elementId = element['element-6066-11e4-a52e-4f735466cecf'];
  assert.ok(elementId, `WebDriver did not resolve ${selector}`);
  const base64 = await session('GET', `/element/${elementId}/screenshot`);
  const destination = path.join(artifactsRoot, name);
  await writeFile(destination, Buffer.from(base64, 'base64'));
  return destination;
}

async function completedArchiveNames() {
  return new Set((await readdir(downloadsRoot)).filter((name) => name.endsWith('.zip') && !name.endsWith('.part')));
}

async function waitForNewArchive(previousNames, label) {
  let candidatePath = null;
  let lastSize = -1;
  let stableObservations = 0;
  return waitFor(async () => {
    const names = await readdir(downloadsRoot);
    const archiveName = names.find((name) => name.endsWith('.zip') && !name.endsWith('.part') && !previousNames.has(name));
    if (!archiveName) return null;
    candidatePath ||= path.join(downloadsRoot, archiveName);
    const currentSize = (await stat(candidatePath)).size;
    if (currentSize > 0 && currentSize === lastSize) stableObservations += 1;
    else stableObservations = 0;
    lastSize = currentSize;
    return stableObservations >= 2 ? candidatePath : null;
  }, { timeoutMs: 90_000, intervalMs: 250, label });
}

async function loadArchive(archivePath) {
  return JSZip.loadAsync(await readFile(archivePath));
}

async function readJsonEntry(zip, name) {
  const entry = zip.file(name);
  assert.ok(entry, `The consumer ZIP is missing ${name}`);
  return JSON.parse(await entry.async('string'));
}

async function resetTerminalResult() {
  const reset = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const button = root?.querySelector('#tgx-export');
    if (!button) return false;
    if (button.textContent?.includes('Create another')) button.click();
    return Boolean(root?.querySelector('#tgx-progress')?.hidden);
  `);
  assert.equal(reset, true, 'The exporter could not reset for another archive');
  await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    return Boolean(root?.querySelector('#tgx-progress')?.hidden && root?.querySelector('#tgx-export')?.textContent?.includes('Save conversation'));
  `), { timeoutMs: 5_000, label: 'reset export dialog' });
}

async function acknowledgeHistoryReady() {
  const state = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const checkbox = root?.querySelector('#tgx-history-ready');
    if (!checkbox) return null;
    if (!checkbox.checked) checkbox.click();
    return {
      checked: checkbox.checked,
      text: root.querySelector('#tgx-history-ready-text')?.textContent || '',
    };
  `);
  assert.ok(state, 'The history acknowledgement was not available');
  assert.equal(state.checked, true, 'The supported source layout did not become export-ready automatically');
  return state;
}

async function requireHistoryAcknowledgement() {
  const state = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const button = root?.querySelector('#tgx-export');
    const checkbox = root?.querySelector('#tgx-history-ready');
    const confirmation = root?.querySelector('#tgx-unencrypted-confirm');
    if (!button || !checkbox || !confirmation) return null;
    return {
      checked: checkbox.checked,
      buttonDisabled: button.disabled,
      buttonText: button.textContent || '',
      inlineErrorVisible: root.querySelector('#tgx-history-error')?.hidden === false,
      boundaryInvalid: root.querySelector('#tgx-export-boundary')?.dataset.invalid === 'true',
      boundaryOpen: root.querySelector('#tgx-export-boundary')?.open === true,
      badge: root.querySelector('#tgx-history-badge')?.textContent || '',
      unencryptedConfirmationHidden: confirmation.hidden,
    };
  `);
  assert.ok(state, 'The history validation state was not available');
  assert.equal(state.checked, false);
  assert.equal(state.buttonDisabled, true, 'Export remains clickable before the required review');
  assert.match(state.buttonText, /Complete required review first/u);
  assert.equal(state.inlineErrorVisible, false, 'A disabled action should not manufacture an error state');
  assert.equal(state.boundaryInvalid, false, 'The untouched required review should not look like a failed submission');
  assert.equal(state.boundaryOpen, true, 'The required review is not visible beside the blocked action');
  assert.match(state.badge, /Review required/u);
  assert.equal(state.unencryptedConfirmationHidden, true, 'Unencrypted confirmation bypassed history validation');
  return state;
}

async function stageUnencryptedConfirmation() {
  const state = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const button = root?.querySelector('#tgx-export');
    const confirmation = root?.querySelector('#tgx-unencrypted-confirm');
    if (!button || !confirmation) return null;
    return {
      confirmationVisible: !confirmation.hidden,
      confirmationText: confirmation.textContent || '',
      buttonText: button.textContent || '',
      buttonDisabled: button.disabled,
    };
  `);
  assert.ok(state, 'The unencrypted export confirmation was not available');
  assert.equal(state.confirmationVisible, false, 'The ordinary save path still asks for a redundant second confirmation');
  assert.equal(state.buttonDisabled, false, 'The ordinary save path is not ready after the source check passed');
  assert.match(state.buttonText, /Save conversation/u);
  return state;
}

async function chooseUnencryptedProtection() {
  const state = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const toggle = root?.querySelector('#tgx-encrypt');
    if (!toggle) return null;
    if (toggle.checked) toggle.click();
    return {
      checked: toggle.checked,
      panelHidden: root.querySelector('#tgx-password-panel')?.hidden === true,
      footer: root.querySelector('#tgx-footer-protection')?.textContent || '',
      preparation: root.querySelector('#tgx-preparation-protection')?.textContent || '',
      compact: root.querySelector('#tgx-boundary-compact')?.textContent || '',
      aesPressed: root.querySelector('#tgx-protection-aes')?.getAttribute('aria-pressed') || '',
      nonePressed: root.querySelector('#tgx-protection-none')?.getAttribute('aria-pressed') || '',
    };
  `);
  assert.ok(state, 'The archive protection choice was not available');
  assert.equal(state.checked, false, 'The explicit no-password choice was not applied');
  assert.equal(state.panelHidden, true, 'Password fields remained visible after choosing no password');
  assert.equal(state.aesPressed, 'false', 'The protected choice remained visually selected');
  assert.equal(state.nonePressed, 'true', 'The unencrypted choice was not visibly selected');
  assert.match(state.footer, /Unencrypted ZIP.*unzip.*open in Firefox.*anyone with the file can read it/u);
  assert.match(state.preparation, /No password:/u);
  assert.match(state.preparation, /Verify downloaded ZIP/u);
  assert.match(state.compact, /unencrypted ZIP/ui);
}

async function confirmUnencryptedExport() {
  const started = await execute(`
    const button = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-export');
    button?.click();
    return Boolean(button);
  `);
  assert.equal(started, true, 'The confirmed unencrypted export could not start');
}

async function startUnencryptedExport() {
  await acknowledgeHistoryReady();
  await chooseUnencryptedProtection();
  await stageUnencryptedConfirmation();
  await confirmUnencryptedExport();
}

async function waitForTerminalExport(label) {
  return waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const progress = root?.querySelector('#tgx-progress');
    if (!progress || progress.hidden) return null;
    const state = progress.getAttribute('data-state');
    if (state !== 'complete' && state !== 'error') return null;
    const downloadState = progress.getAttribute('data-download-state') || '';
    if (state === 'complete' && downloadState !== 'complete') return null;
    return {
      state,
      downloadState,
      errorCode: progress.getAttribute('data-error-code'),
      text: progress.textContent || '',
      filename: root.querySelector('#tgx-result-file')?.textContent || '',
      summary: root.querySelector('#tgx-result-summary')?.textContent || '',
      primarySummary: root.querySelector('#tgx-result-primary-summary')?.textContent || '',
      primaryMissing: root.querySelector('#tgx-result-primary-missing')?.textContent || '',
      primaryOmissions: root.querySelector('#tgx-result-primary-omissions')?.textContent || '',
      primaryNext: root.querySelector('#tgx-result-primary-next')?.textContent || '',
      omissionAction: root.querySelector('#tgx-result-omission-action')?.textContent || '',
      omissionActionVisible: (() => {
        const action = root.querySelector('#tgx-result-omission-action');
        return Boolean(action && !action.hidden && action.getBoundingClientRect().height > 0);
      })(),
      target: root.querySelector('#tgx-result-target')?.textContent || '',
      targetState: root.querySelector('#tgx-result-target')?.getAttribute('data-state') || '',
      targetStatus: root.querySelector('#tgx-result-target-status')?.textContent || '',
      targetStatusState: root.querySelector('#tgx-result-target-status')?.getAttribute('data-state') || '',
      omissions: root.querySelector('#tgx-result-omissions')?.textContent || '',
      coverage: root.querySelector('#tgx-result-coverage')?.textContent || '',
      note: root.querySelector('#tgx-result-note')?.textContent || '',
      protection: root.querySelector('#tgx-result-protection')?.textContent || '',
      validation: root.querySelector('#tgx-result-validation')?.textContent || '',
      help: root.querySelector('#tgx-result-help')?.textContent || '',
      progressBoundary: root.querySelector('#tgx-progress-boundary')?.textContent || '',
      aesGuideVisible: root.querySelector('#tgx-result-aes-guide')?.hidden === false,
      aesGuideText: root.querySelector('#tgx-result-aes-guide')?.textContent || '',
      partial: root.querySelector('#tgx-result-note')?.getAttribute('data-partial') === 'true',
    };
  `), { timeoutMs: 90_000, label });
}

async function stopDriver() {
  if (driver.exitCode != null) return;
  driver.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => driver.once('exit', resolve)),
    delay(5_000),
  ]);
  if (driver.exitCode == null) driver.kill('SIGKILL');
}

async function stopPrivateBus() {
  if (privateBus.exitCode != null) return;
  privateBus.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => privateBus.once('exit', resolve)),
    delay(3_000),
  ]);
  if (privateBus.exitCode == null) privateBus.kill('SIGKILL');
}

try {
  await waitFor(
    async () => {
      const response = await fetch(`${driverBaseUrl}/status`, { signal: AbortSignal.timeout(1_000) });
      return response.ok;
    },
    { timeoutMs: 15_000, label: 'geckodriver readiness' },
  );

  const created = await webdriver('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        acceptInsecureCerts: false,
        'moz:firefoxOptions': {
          binary: firefoxBinary,
          args: ['-headless'],
          prefs: {
            'browser.download.alwaysOpenPanel': false,
            'browser.download.dir': downloadsRoot,
            'browser.download.folderList': 2,
            'browser.download.manager.showWhenStarting': false,
            'browser.download.useDownloadDir': true,
            'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream,application/zip',
            'intl.accept_languages': 'en-US,en',
          },
        },
      },
    },
  }, 120_000);
  sessionId = created.sessionId;
  assert.ok(sessionId, 'Firefox did not return a WebDriver session id');

  await session('POST', '/window/rect', { width: 1100, height: 760 });
  [mainWindow] = await session('GET', '/window/handles');
  assert.ok(mainWindow, 'Firefox did not expose its main window');

  const installedId = await session('POST', '/moz/addon/install', {
    path: extensionArchive,
    temporary: true,
  });
  assert.equal(installedId, addonId, 'Firefox installed an unexpected extension identity');

  await setContext('chrome');
  const extensionBaseUrl = await execute(`
    const policy = WebExtensionPolicy.getByID(arguments[0]);
    return policy ? policy.getURL('') : null;
  `, [addonId]);
  assert.match(extensionBaseUrl || '', /^moz-extension:\/\//u, 'Firefox did not expose the installed extension URL');

  await setContext('content');
  await session('POST', '/url', { url: 'https://web.telegram.org/k/' }, 120_000);
  await execute(`
    window.stop();
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X9x1AAAAAElFTkSuQmCC';
    const tinyVideo = 'data:video/mp4;base64,AAAAHGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAAhmcmVl';
    const tinyVoice = 'data:audio/ogg;base64,T2dnUwACAAAAAAAAAADxQY8fAAAAABYz1xUBHgF2b3JiaXMAAAAAAkSsAAAAAAA=';
    const noteFile = 'data:text/plain;base64,VGVsZUFyY2hpdmUgbG9jYWwgZmlsZQ==';
    window.__telearchiveOversizeUrl = URL.createObjectURL(new Blob(
      [new Uint8Array(2 * 1024 * 1024)],
      { type: 'application/octet-stream' },
    ));
    const chatFixtures = {
      '123': {
        name: 'E2E Archive',
        messages: \`
          <article data-mid="message-42" data-peer-id="123">
            <span class="peer-title">Alice</span>
            <time datetime="2026-08-10T08:00:00.000Z">11:00</time>
            <div data-scope="text">A durable Firefox hello</div>
          </article>\`,
      },
      '456': {
        name: 'Media Lab',
        messages: \`
          <article data-mid="message-101" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:01:00.000Z">11:01</time><div data-scope="text">Photo</div><img class="archive-photo" alt="pixel.png" src="\${tinyPng}"></article>
          <article data-mid="message-102" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:02:00.000Z">11:02</time><div data-scope="text">Video</div><video data-media-type="video_file" src="\${tinyVideo}"></video></article>
          <article data-mid="message-103" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:03:00.000Z">11:03</time><div data-scope="text">Voice</div><audio src="\${tinyVoice}"></audio></article>
          <article data-mid="message-104" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:04:00.000Z">11:04</time><div data-scope="text">Sticker</div><div class="sticker-media"><img alt="sticker.png" src="\${tinyPng}"></div></article>
          <article data-mid="message-105" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:05:00.000Z">11:05</time><div data-scope="text">File</div><div data-scope="document"><a download="note.txt" href="\${noteFile}">note.txt</a></div></article>
          <article data-mid="message-106" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:06:00.000Z">11:06</time><div data-scope="text">Video message</div><div class="round-video"><video data-media-type="video_message" src="\${tinyVideo}"></video></div></article>
          <article data-mid="message-107" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:07:00.000Z">11:07</time><div data-scope="text">Oversize file</div><div data-scope="document"><a download="oversize.bin" href="\${window.__telearchiveOversizeUrl}">oversize.bin</a></div></article>
          <article data-mid="message-108" data-peer-id="456"><span class="peer-title">Bob</span><time datetime="2026-08-10T08:08:00.000Z">11:08</time><div data-scope="text">Animation</div><video data-media-type="animation" src="\${tinyVideo}"></video></article>\`,
      },
    };
    const extraBatchChats = Array.from({ length: 53 }, (_, index) => {
      const peerId = -(2000 + index);
      return '<a class="chatlist-chat" data-peer-id="' + peerId + '" href="#' + peerId + '"><span class="user-title"><span class="peer-title">Batch Planning ' + String(index + 1).padStart(2, '0') + '</span></span></a>';
    }).join('');
    document.body.innerHTML = \`
      <aside id="column-left">
        <a class="chatlist-chat active" data-peer-id="123" href="#123"><span class="user-title"><span class="peer-title">E2E Archive</span></span></a>
        <a class="chatlist-chat" data-peer-id="456" href="#456"><span class="user-title"><span class="peer-title">Media Lab</span></span></a>
        \${extraBatchChats}
      </aside>
      <main></main>\`;
    window.__renderTeleArchiveChat = (peerId, options = {}) => {
      const fixture = chatFixtures[String(peerId)];
      if (!fixture) {
        const link = document.querySelector('#column-left .chatlist-chat[data-peer-id="' + String(peerId) + '"]');
        const name = link?.querySelector('.peer-title')?.textContent || ('Batch Planning ' + String(Math.abs(Number(peerId)) - 1999).padStart(2, '0'));
        const numericId = Math.abs(Number(peerId)) || 1;
        const main = document.querySelector('main');
        main.innerHTML = '<header><span data-scope="peer-title">' + name + '</span></header>'
          + '<div data-scope="bubbles" style="height:520px;overflow:auto"><article data-mid="message-' + numericId + '" data-peer-id="' + String(peerId) + '"><span class="peer-title">' + name + '</span><time datetime="2026-08-10T08:00:00.000Z">11:00</time><div data-scope="text">' + name + ' message</div></article></div>'
          + '<div class="input-message-input" data-peer-id="' + String(peerId) + '"></div>';
        return true;
      }
      document.querySelectorAll('#column-left .chatlist-chat').forEach((link) => {
        link.classList.toggle('active', link.getAttribute('data-peer-id') === String(peerId));
      });
      const main = document.querySelector('main');
      main.innerHTML = \`
        <header><span data-scope="peer-title">\${fixture.name}</span></header>
        <div data-scope="bubbles" style="height:\${options.tall ? 120 : 520}px; overflow:auto">\${fixture.messages}</div>
        <div class="input-message-input" data-peer-id="\${peerId}"></div>\`;
      const bubbles = main.querySelector('[data-scope="bubbles"]');
      if (options.tall) {
        const filler = document.createElement('div');
        filler.style.height = '1400px';
        bubbles.prepend(filler);
        bubbles.scrollTop = bubbles.scrollHeight;
      }
      return true;
    };
    document.querySelectorAll('#column-left .chatlist-chat').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        window.__renderTeleArchiveChat(link.getAttribute('data-peer-id'));
      });
    });
    window.__renderTeleArchiveChat('123');
    return location.origin;
  `);

  await setContext('chrome');
  const actionButtonId = `${addonId.replaceAll('{', '_').replaceAll('}', '_')}-BAP`;
  const extensionsMenuOpened = await execute(`
    const button = document.getElementById('unified-extensions-button');
    if (!button) return false;
    button.click();
    return true;
  `);
  assert.equal(extensionsMenuOpened, true, 'Firefox did not expose its Extensions menu');
  const actionButton = await waitFor(async () => execute(`
    const button = document.getElementById(arguments[0])
      || [...document.querySelectorAll('toolbarbutton')].find((candidate) => candidate.getAttribute('label')?.startsWith('Local Archive'));
    return button ? { id: button.id, label: button.getAttribute('label') } : null;
  `, [actionButtonId]), { timeoutMs: 15_000, label: 'Local Archive browser action registration' });
  const actionClicked = await execute(`
    const button = document.getElementById(arguments[0]);
    if (!button) return false;
    button.click();
    return true;
  `, [actionButton.id]);
  assert.equal(actionClicked, true, 'The Local Archive toolbar action was not available');

  await waitFor(async () => {
    await switchToMainWindow();
    await setContext('content');
    return execute('return Boolean(document.getElementById("telearchive-extension-root")?.shadowRoot?.querySelector("#tgx-export"));');
  }, { timeoutMs: 20_000, label: 'one-click exporter injection' });

  const initialLayout = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const host = document.getElementById('telearchive-extension-root');
    if (!root || !host) return null;
    const modal = root.querySelector('.tgx-modal');
    const footer = root.querySelector('.tgx-footer');
    const action = root.querySelector('#tgx-export');
    const icon = root.querySelector('.tgx-brand');
    const customize = root.querySelector('#tgx-customize');
    const customizeToggle = root.querySelector('#tgx-customize-toggle');
    const quickStatus = root.querySelector('#tgx-quick-status');
    if (!modal || !footer || !action || !icon || !customize || !customizeToggle || !quickStatus) return null;
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const fullyInViewport = (element) => {
      const rect = element.getBoundingClientRect();
      return visible(element) && rect.top >= -1 && rect.left >= -1 && rect.bottom <= innerHeight + 1 && rect.right <= innerWidth + 1;
    };
    return {
      interfaceVersion: host.dataset.interfaceVersion || '',
      firstRun: host.dataset.firstRun || '',
      eyebrow: root.querySelector('.tgx-eyebrow')?.textContent || '',
      title: root.querySelector('#tgx-title')?.textContent || '',
      subtitle: root.querySelector('#tgx-description')?.textContent || '',
      source: root.querySelector('#tgx-quick-source-name')?.textContent || '',
      quickTitle: root.querySelector('#tgx-quick-title')?.textContent || '',
      chat: root.querySelector('#tgx-quick-chat-name')?.textContent || '',
      history: root.querySelector('#tgx-quick-history')?.textContent || '',
      content: root.querySelector('#tgx-quick-content')?.textContent || '',
      media: root.querySelector('#tgx-quick-media')?.textContent || '',
      protection: root.querySelector('#tgx-quick-protection')?.textContent || '',
      readyState: quickStatus.dataset.state || '',
      readyTitle: quickStatus.querySelector('strong')?.textContent || '',
      readyText: root.querySelector('#tgx-quick-status-text')?.textContent || '',
      recheckHidden: root.querySelector('#tgx-quick-recheck')?.hidden === true,
      customizeOpen: customize.open === true,
      customizeExpanded: customizeToggle.getAttribute('aria-expanded') || '',
      customizeText: customizeToggle.textContent || '',
      actionText: action.querySelector('span:first-child')?.textContent || action.textContent || '',
      actionDisabled: action.disabled,
      footerVisible: visible(footer),
      actionVisible: visible(action),
      settingsVisible: visible(root.querySelector('#tgx-settings')),
      oldGuideVisible: visible(root.querySelector('#tgx-beginner-guide')),
      oldBoundaryVisible: visible(root.querySelector('#tgx-export-boundary')),
      historyReady: root.querySelector('#tgx-history-ready')?.checked === true,
      encrypt: root.querySelector('#tgx-encrypt')?.checked === true,
      nonePressed: root.querySelector('#tgx-protection-none')?.getAttribute('aria-pressed') || '',
      aesPressed: root.querySelector('#tgx-protection-aes')?.getAttribute('aria-pressed') || '',
      passwordPanelHidden: root.querySelector('#tgx-password-panel')?.hidden === true,
      confirmationHidden: root.querySelector('#tgx-unencrypted-confirm')?.hidden === true,
      iconLoaded: icon.complete && icon.naturalWidth > 0,
      modalFitsViewport: fullyInViewport(modal),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  `), { timeoutMs: 10_000, label: 'universal one-action exporter layout' });

  assert.equal(initialLayout.interfaceVersion, 'universal-v2');
  assert.equal(initialLayout.firstRun, 'false');
  assert.equal(initialLayout.eyebrow, 'CONVERSATION EXPORTER');
  assert.equal(initialLayout.title, 'Local Archive');
  assert.match(initialLayout.subtitle, /readable copy.*reusable data.*saved on this device/u);
  assert.equal(initialLayout.source, 'Telegram');
  assert.equal(initialLayout.quickTitle, 'E2E Archive');
  assert.equal(initialLayout.chat, 'E2E Archive');
  assert.match(initialLayout.history, /1 message is available now.*More history may be loaded while saving/u);
  assert.equal(initialLayout.content, 'Readable page + reusable data');
  assert.match(initialLayout.media, /Photos.*Voice messages.*Stickers/u);
  assert.equal(initialLayout.protection, 'ZIP without password');
  assert.equal(initialLayout.readyState, 'ready');
  assert.equal(initialLayout.readyTitle, 'Ready to save');
  assert.match(initialLayout.readyText, /E2E Archive can be read from the Telegram source.*Keep the source tab open/u);
  assert.equal(initialLayout.recheckHidden, true);
  assert.equal(initialLayout.customizeOpen, false);
  assert.equal(initialLayout.customizeExpanded, 'false');
  assert.match(initialLayout.customizeText, /Change what is saved.*Readable HTML.*Reusable data.*Photos.*Voice messages.*Stickers.*ZIP without password/u);
  assert.equal(initialLayout.actionText, 'Save conversation');
  assert.equal(initialLayout.actionDisabled, false);
  assert.equal(initialLayout.footerVisible, true);
  assert.equal(initialLayout.actionVisible, true);
  assert.equal(initialLayout.settingsVisible, false);
  assert.equal(initialLayout.oldGuideVisible, false);
  assert.equal(initialLayout.oldBoundaryVisible, false);
  assert.equal(initialLayout.historyReady, true);
  assert.equal(initialLayout.encrypt, false);
  assert.equal(initialLayout.nonePressed, 'true');
  assert.equal(initialLayout.aesPressed, 'false');
  assert.equal(initialLayout.passwordPanelHidden, true);
  assert.equal(initialLayout.confirmationHidden, true);
  assert.equal(initialLayout.iconLoaded, true);
  assert.equal(initialLayout.modalFitsViewport, true, `The exporter does not fit the desktop viewport: ${JSON.stringify(initialLayout)}`);
  assert.equal(initialLayout.horizontalOverflow, false);
  const initialScreenshot = await screenshot('01-ready.png');

  await session('POST', '/window/rect', { width: 480, height: 900 });
  await delay(250);
  const mobileLayout = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const modal = root?.querySelector('.tgx-modal');
    const body = root?.querySelector('.tgx-body');
    const footer = root?.querySelector('.tgx-footer');
    const action = root?.querySelector('#tgx-export');
    const cards = [...root?.querySelectorAll('.tgx-quick-summary > div') || []];
    if (!modal || !body || !footer || !action || cards.length !== 3) return null;
    const rect = (element) => {
      const value = element.getBoundingClientRect();
      return { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height };
    };
    const modalRect = rect(modal);
    return {
      modalRect,
      viewport: { width: innerWidth, height: innerHeight },
      bodyScrollable: body.scrollHeight >= body.clientHeight,
      footerHeight: rect(footer).height,
      actionHeight: rect(action).height,
      cardWidths: cards.map((card) => rect(card).width),
      cardOrder: cards.map((card) => card.textContent || ''),
      customizeVisible: rect(root.querySelector('#tgx-customize-toggle')).height > 0,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      bodyHorizontalOverflow: body.scrollWidth > body.clientWidth + 1,
      actionText: action.querySelector('span:first-child')?.textContent || action.textContent || '',
    };
  `);
  const mobileScreenshot = await screenshot('01-mobile.png');
  assert.ok(mobileLayout, 'The mobile quick-save surface did not render');
  assert.ok(
    mobileLayout.modalRect.width <= mobileLayout.viewport.width + 1
      && mobileLayout.modalRect.height <= mobileLayout.viewport.height + 1,
    `The mobile modal overflows: ${JSON.stringify(mobileLayout)}`,
  );
  assert.ok(mobileLayout.footerHeight > 0 && mobileLayout.actionHeight > 0, 'The mobile save action is not reachable');
  assert.equal(mobileLayout.cardWidths.length, 3);
  assert.equal(mobileLayout.cardWidths.every((width) => width > 0), true);
  assert.match(mobileLayout.cardOrder.join(' '), /Archive.*Attachments.*Access/u);
  assert.equal(mobileLayout.customizeVisible, true);
  assert.equal(mobileLayout.horizontalOverflow, false);
  assert.equal(mobileLayout.bodyHorizontalOverflow, false);
  assert.equal(mobileLayout.actionText, 'Save conversation');

  await session('POST', '/window/rect', { width: 1100, height: 760 });
  await delay(250);
  const customizeState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    root?.querySelector('#tgx-customize-toggle')?.click();
    const details = root?.querySelector('#tgx-customize');
    return {
      open: details?.open === true,
      expanded: root?.querySelector('#tgx-customize-toggle')?.getAttribute('aria-expanded') || '',
      sections: [...root?.querySelectorAll('#tgx-customize .tgx-section') || []]
        .filter((section) => getComputedStyle(section).display !== 'none' && section.getBoundingClientRect().height > 0)
        .map((section) => section.id),
      coverageOpen: root?.querySelector('#tgx-coverage-settings')?.open === true,
      moreMediaOpen: root?.querySelector('#tgx-more-media')?.open === true,
      protectionGrid: getComputedStyle(root?.querySelector('.tgx-protection-choices')).display,
      passwordPanelHidden: root?.querySelector('#tgx-password-panel')?.hidden === true,
    };
  `);
  assert.equal(customizeState.open, true);
  assert.equal(customizeState.expanded, 'true');
  assert.deepEqual(customizeState.sections, ['tgx-output-section', 'tgx-scope-section', 'tgx-media-section', 'tgx-protection-section']);
  assert.equal(customizeState.coverageOpen, false);
  assert.equal(customizeState.moreMediaOpen, false);
  assert.equal(customizeState.protectionGrid, 'grid');
  assert.equal(customizeState.passwordPanelHidden, true);
  const advancedScreenshot = await screenshot('03-advanced.png');

  const advancedProtectionLayout = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const aes = root?.querySelector('#tgx-protection-aes');
    aes?.click();
    return {
      encrypt: root?.querySelector('#tgx-encrypt')?.checked === true,
      aesPressed: aes?.getAttribute('aria-pressed') || '',
      nonePressed: root?.querySelector('#tgx-protection-none')?.getAttribute('aria-pressed') || '',
      passwordVisible: root?.querySelector('#tgx-password-panel')?.hidden === false,
      actionText: root?.querySelector('#tgx-export span:first-child')?.textContent || '',
      quickProtection: root?.querySelector('#tgx-quick-protection')?.textContent || '',
    };
  `);
  assert.deepEqual(advancedProtectionLayout, {
    encrypt: true,
    aesPressed: 'true',
    nonePressed: 'false',
    passwordVisible: true,
    actionText: 'Save with password',
    quickProtection: 'Password-protected ZIP',
  });
  await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    root?.querySelector('#tgx-protection-none')?.click();
    root?.querySelector('#tgx-customize-toggle')?.click();
    return true;
  `);

  const unsupportedLayoutState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const message = document.querySelector('[data-mid]');
    window.__telearchiveRemovedMessage = message?.outerHTML || '';
    message?.remove();
    root?.querySelector('#tgx-quick-recheck')?.click();
    const status = root?.querySelector('#tgx-quick-status');
    const recheck = root?.querySelector('#tgx-quick-recheck');
    const action = root?.querySelector('#tgx-export');
    return {
      state: status?.dataset.state || '',
      title: status?.querySelector('strong')?.textContent || '',
      text: root?.querySelector('#tgx-quick-status-text')?.textContent || '',
      recheckVisible: recheck?.hidden === false && recheck.getBoundingClientRect().height > 0,
      recheckText: recheck?.textContent || '',
      actionDisabled: action?.disabled === true,
      actionText: action?.querySelector('span:first-child')?.textContent || action?.textContent || '',
      legacyDiagnosticVisible: (() => {
        const diagnostic = root?.querySelector('#tgx-compatibility-diagnostic');
        return Boolean(diagnostic && getComputedStyle(diagnostic).display !== 'none' && diagnostic.getBoundingClientRect().height > 0);
      })(),
    };
  `);
  assert.equal(unsupportedLayoutState.state, 'error');
  assert.equal(unsupportedLayoutState.title, 'Cannot read this conversation yet');
  assert.match(unsupportedLayoutState.text, /Wait for messages to load in Telegram.*check again/u);
  assert.equal(unsupportedLayoutState.recheckVisible, true);
  assert.match(unsupportedLayoutState.recheckText, /Check again/u);
  assert.equal(unsupportedLayoutState.actionDisabled, true);
  assert.equal(unsupportedLayoutState.actionText, 'Open a readable conversation first');
  assert.equal(unsupportedLayoutState.legacyDiagnosticVisible, false, 'The legacy technical diagnostic leaked into the ordinary-user surface');
  await delay(120);
  const unsupportedLayoutScreenshot = await screenshot('01-unsupported-layout.png');
  const restoredLayoutState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const bubbles = document.querySelector('[data-scope="bubbles"]');
    if (bubbles && window.__telearchiveRemovedMessage) bubbles.insertAdjacentHTML('beforeend', window.__telearchiveRemovedMessage);
    delete window.__telearchiveRemovedMessage;
    root?.querySelector('#tgx-quick-recheck')?.click();
    return {
      state: root?.querySelector('#tgx-quick-status')?.dataset.state || '',
      recheckHidden: root?.querySelector('#tgx-quick-recheck')?.hidden === true,
      actionDisabled: root?.querySelector('#tgx-export')?.disabled === true,
      actionText: root?.querySelector('#tgx-export span:first-child')?.textContent || '',
      history: root?.querySelector('#tgx-quick-history')?.textContent || '',
    };
  `);
  assert.equal(restoredLayoutState.state, 'ready');
  assert.equal(restoredLayoutState.recheckHidden, true);
  assert.equal(restoredLayoutState.actionDisabled, false);
  assert.equal(restoredLayoutState.actionText, 'Save conversation');
  assert.match(restoredLayoutState.history, /1 message is available now/u);

  await session('POST', '/window/rect', { width: 480, height: 800 });
  await delay(250);
  const advancedMobileLayout = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    root?.querySelector('#tgx-customize-toggle')?.click();
    const modal = root?.querySelector('.tgx-modal');
    const body = root?.querySelector('.tgx-body');
    const footer = root?.querySelector('.tgx-footer');
    const action = root?.querySelector('#tgx-export');
    const protectionChoices = root?.querySelector('.tgx-protection-choices');
    const aesChoice = root?.querySelector('#tgx-protection-aes');
    const noneChoice = root?.querySelector('#tgx-protection-none');
    if (!modal || !body || !footer || !action || !protectionChoices || !aesChoice || !noneChoice) return null;
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
    };
    return {
      modal: rectOf(modal),
      viewport: { width: innerWidth, height: innerHeight },
      footerHeight: rectOf(footer).height,
      actionHeight: rectOf(action).height,
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
      bodyHorizontalOverflow: body.scrollWidth > body.clientWidth + 1,
      customizeOpen: root?.querySelector('#tgx-customize')?.open === true,
      protectionGridDisplay: getComputedStyle(protectionChoices).display,
      protectionChoiceRects: { aes: rectOf(aesChoice), none: rectOf(noneChoice) },
    };
  `);
  const advancedMobileScreenshot = await screenshot('03-mobile-advanced.png');
  assert.ok(
    advancedMobileLayout.modal.width <= advancedMobileLayout.viewport.width + 1
      && advancedMobileLayout.modal.height <= advancedMobileLayout.viewport.height + 1,
    `The advanced mobile modal overflows: ${JSON.stringify(advancedMobileLayout)}`,
  );
  assert.ok(advancedMobileLayout.footerHeight > 0 && advancedMobileLayout.actionHeight > 0);
  assert.equal(advancedMobileLayout.horizontalOverflow, false);
  assert.equal(advancedMobileLayout.bodyHorizontalOverflow, false);
  assert.equal(advancedMobileLayout.customizeOpen, true);
  assert.equal(advancedMobileLayout.protectionGridDisplay, 'grid');
  assert.ok(
    advancedMobileLayout.protectionChoiceRects.none.top >= advancedMobileLayout.protectionChoiceRects.aes.bottom - 1,
    `Protection cards do not stack on the narrow viewport: ${JSON.stringify(advancedMobileLayout.protectionChoiceRects)}`,
  );
  assert.ok(
    Math.abs(advancedMobileLayout.protectionChoiceRects.aes.width - advancedMobileLayout.protectionChoiceRects.none.width) <= 2,
    `Protection cards have inconsistent mobile widths: ${JSON.stringify(advancedMobileLayout.protectionChoiceRects)}`,
  );

  await session('POST', '/window/rect', { width: 1100, height: 760 });
  await delay(250);
  await execute(`document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-customize-toggle')?.click(); return true;`);

  const currentCoverageTarget = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const target = root?.querySelector('#tgx-coverage-target');
    if (!target) return null;
    target.value = '2026-08-10';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: target.value, settingsOpen: root.querySelector('#tgx-coverage-settings')?.open === true };
  `);
  assert.deepEqual(currentCoverageTarget, { value: '2026-08-10', settingsOpen: false });
  const archivesBeforeCurrent = await completedArchiveNames();
  await chooseUnencryptedProtection();
  await acknowledgeHistoryReady();
  await stageUnencryptedConfirmation();
  await confirmUnencryptedExport();

  const resultState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const progress = root?.querySelector('#tgx-progress');
    if (!progress || progress.hidden) return null;
    const state = progress.getAttribute('data-state');
    if (state !== 'complete' && state !== 'error') return null;
    const downloadState = progress.getAttribute('data-download-state') || '';
    if (state === 'complete' && downloadState !== 'complete') return null;
    return {
      state,
      downloadState,
      title: root.querySelector('#tgx-progress-title')?.textContent || '',
      primaryTitle: root.querySelector('#tgx-result-primary strong')?.textContent || '',
      terminalHint: root.querySelector('#tgx-progress-simple')?.textContent || '',
      errorCode: progress.getAttribute('data-error-code'),
      text: progress.textContent || '',
      receiptVisible: !progress.querySelector('#tgx-receipt')?.hidden,
      progressVisible: progress.getBoundingClientRect().top >= 0
        && progress.getBoundingClientRect().bottom <= innerHeight,
      createAnotherVisible: !root.querySelector('#tgx-export')?.hidden
        && root.querySelector('#tgx-export')?.textContent?.includes('Create another'),
      closeLabel: root.querySelector('#tgx-cancel')?.textContent || '',
      summary: root.querySelector('#tgx-result-summary')?.textContent || '',
      primarySummary: root.querySelector('#tgx-result-primary-summary')?.textContent || '',
      primaryMissing: root.querySelector('#tgx-result-primary-missing')?.textContent || '',
      primaryNext: root.querySelector('#tgx-result-primary-next')?.textContent || '',
      scopeNote: root.querySelector('.tgx-scope-note')?.textContent || '',
      resultNote: root.querySelector('#tgx-result-note')?.textContent || '',
      resultHelp: root.querySelector('#tgx-result-help')?.textContent || '',
      readableLimit: root.querySelector('#tgx-result-readable-limit')?.textContent || '',
      extractionCheck: root.querySelector('#tgx-result-check')?.textContent || '',
      showDownloadVisible: root.querySelector('#tgx-show-download')?.hidden === false,
      showDownloadText: root.querySelector('#tgx-show-download')?.textContent || '',
      verifyDownloadVisible: root.querySelector('#tgx-verify-download')?.hidden === false,
      verifyDownloadText: root.querySelector('#tgx-verify-download')?.textContent || '',
      verifyDownloadBackground: getComputedStyle(root.querySelector('#tgx-verify-download')).backgroundColor,
      createAnotherBackground: getComputedStyle(root.querySelector('#tgx-export')).backgroundColor,
      protection: root.querySelector('#tgx-result-protection')?.textContent || '',
      validation: root.querySelector('#tgx-result-validation')?.textContent || '',
      target: root.querySelector('#tgx-result-target')?.textContent || '',
      targetState: root.querySelector('#tgx-result-target')?.getAttribute('data-state') || '',
      targetStatus: root.querySelector('#tgx-result-target-status')?.textContent || '',
      targetStatusState: root.querySelector('#tgx-result-target-status')?.getAttribute('data-state') || '',
      progressBoundary: root.querySelector('#tgx-progress-boundary')?.textContent || '',
      aesGuideVisible: root.querySelector('#tgx-result-aes-guide')?.hidden === false,
      aesGuideText: root.querySelector('#tgx-result-aes-guide')?.textContent || '',
      terminalAsideWidth: root.querySelector('.tgx-aside')?.getBoundingClientRect().width || 0,
      receiptHorizontalOverflow: (() => {
        const receipt = root.querySelector('#tgx-receipt');
        return receipt ? receipt.scrollWidth > receipt.clientWidth + 1 : true;
      })(),
      receiptEndsBeforeAction: (() => {
        const receipt = root.querySelector('#tgx-receipt');
        const button = root.querySelector('#tgx-show-download');
        if (!receipt || !button) return false;
        return receipt.getBoundingClientRect().bottom <= button.getBoundingClientRect().top + 1;
      })(),
    };
  `), { timeoutMs: 60_000, label: 'terminal export result' });

  assert.notEqual(
    resultState.state,
    'error',
    `Firefox consumer export failed (${resultState.errorCode || 'unknown'}): ${resultState.text}`,
  );
  assert.equal(resultState.state, 'complete');
  assert.equal(resultState.downloadState, 'complete');
  assert.match(resultState.title, /Download complete/u);
  assert.match(resultState.primaryTitle, /Saved ZIP checked locally.*download complete/u);
  assert.match(resultState.terminalHint, /ZIP downloaded.*you can close this tab/u);
  assert.doesNotMatch(resultState.terminalHint, /collected so far|keep this Telegram tab open/u);
  assert.equal(resultState.receiptVisible, true, 'The saved-file receipt was not shown');
  assert.equal(resultState.progressVisible, true, 'The terminal result was outside the viewport');
  assert.equal(resultState.createAnotherVisible, true, 'The repeat-export action was not shown');
  assert.match(resultState.closeLabel, /Close/u);
  assert.match(resultState.summary, /1 chat/u);
  assert.match(resultState.summary, /1 message/u);
  assert.doesNotMatch(resultState.summary, /1 chats|1 messages/u);
  assert.match(resultState.text, /1 message saved/u);
  assert.match(resultState.summary, /Saved range/u);
  assert.match(resultState.primarySummary, /History goal: reached/u);
  assert.match(resultState.primaryMissing, /Scope: this Telegram tab only.*exact saved range.*not a complete Telegram backup/u);
  assert.match(resultState.primaryNext, /verify the downloaded ZIP.*open messages\.html/u);
  assert.match(resultState.scopeNote, /scans toward newer and older messages automatically/u);
  assert.match(resultState.resultNote, /not a complete Telegram backup/u);
  assert.match(resultState.resultHelp, /Verify the downloaded ZIP below.*extract it.*messages\.html/u);
  assert.match(resultState.readableLimit, /512 MB.*PeaZip.*7-Zip/u);
  assert.match(resultState.extractionCheck, /Verify downloaded ZIP.*open messages\.html/u);
  assert.equal(resultState.showDownloadVisible, true, 'The receipt has no direct downloaded-ZIP action');
  assert.match(resultState.showDownloadText, /Show downloaded ZIP/u);
  assert.equal(resultState.verifyDownloadVisible, true, 'The receipt has no exact downloaded-ZIP verification action');
  assert.match(resultState.verifyDownloadText, /Verify ZIP \(recommended\)/u);
  assert.notEqual(resultState.verifyDownloadBackground, resultState.createAnotherBackground, 'ZIP verification is not visually stronger than repeat export');
  assert.ok(resultState.terminalAsideWidth >= 340, `The terminal receipt did not expand at desktop width: ${resultState.terminalAsideWidth}`);
  assert.equal(resultState.receiptHorizontalOverflow, false, 'The terminal receipt still truncates content horizontally');
  assert.equal(resultState.receiptEndsBeforeAction, true, 'The downloaded-ZIP action overlaps the scrollable receipt');
  assert.match(resultState.protection, /No password/u);
  assert.match(resultState.validation, /Passed.*files.*report readable/u);
  assert.match(resultState.target, /reaches Aug 10, 2026 in 1\/1 requested chats/u);
  assert.match(resultState.target, /not complete Telegram history/u);
  assert.equal(resultState.targetState, 'reached');
  assert.match(resultState.targetStatus, /History goal reached.*Aug 10, 2026.*1\/1 chats/u);
  assert.equal(resultState.targetStatusState, 'reached');
  assert.match(resultState.progressBoundary, /not a complete Telegram backup.*only messages this tab exposes/u);
  assert.equal(resultState.aesGuideVisible, true, 'The completed unencrypted receipt did not surface the next opening action');
  assert.match(resultState.aesGuideText, /Next: open this ZIP/u);
  assert.match(resultState.aesGuideText, /Open the downloaded ZIP in Firefox or any archive app/u);
  assert.match(resultState.aesGuideText, /Keep result\.json for reusable data/u);
  const successScreenshot = await screenshot('02-saved.png');

  const downloadedArchive = await waitForNewArchive(archivesBeforeCurrent, 'downloaded current-chat ZIP');
  await rm(showDownloadProbe, { force: true });
  const showDownloadClicked = await execute(`
    const button = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-show-download');
    button?.click();
    return Boolean(button);
  `);
  assert.equal(showDownloadClicked, true, 'The downloaded-ZIP action could not be invoked');
  const showDownloadAction = await waitFor(async () => {
    const probe = await readFile(showDownloadProbe, 'utf8').catch(() => '');
    const ui = await execute(`
      const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
      const button = root?.querySelector('#tgx-show-download');
      const status = root?.querySelector('#tgx-show-download-status');
      return button ? {
        mode: button.dataset.mode || '',
        text: button.textContent || '',
        statusVisible: status?.hidden === false,
        statusText: status?.textContent || '',
        statusState: status?.dataset.state || '',
      } : null;
    `);
    return probe.trim() && ui?.mode ? { probe: probe.trim(), ...ui } : null;
  }, { timeoutMs: 10_000, label: 'isolated operating-system reveal of the downloaded ZIP' });
  assert.equal(showDownloadAction.mode, 'file', 'Firefox fell back to the generic Downloads folder instead of the exact ZIP');
  assert.equal(
    showDownloadAction.probe.includes(downloadsRoot),
    true,
    `The isolated folder handler received an unexpected location: ${showDownloadAction.probe}`,
  );
  assert.match(showDownloadAction.text, /Show downloaded ZIP/u);
  assert.equal(showDownloadAction.statusVisible, true, 'The downloaded-file action has no visible receipt');
  assert.equal(showDownloadAction.statusState, 'file');
  assert.match(showDownloadAction.statusText, /Shown in its folder/u);
  assert.equal(showDownloadAction.statusText.includes(path.basename(downloadedArchive)), true);
  const showDownloadScreenshot = await screenshot('02-show-download.png');

  await setShadowFileInput('#tgx-verify-file', downloadedArchive);
  const verificationState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const status = root?.querySelector('#tgx-verify-status');
    if (!status || status.hidden || status.dataset.state !== 'file') return null;
    return {
      state: status.dataset.state,
      text: status.textContent || '',
      passwordPanelHidden: root.querySelector('#tgx-verify-panel')?.hidden === true,
      passwordCleared: root.querySelector('#tgx-verify-password')?.value === '',
    };
  `), { timeoutMs: 30_000, label: 'local verification of the downloaded current-chat ZIP' });
  assert.equal(verificationState.passwordPanelHidden, true, 'An unencrypted ZIP unexpectedly requested a password');
  assert.equal(verificationState.passwordCleared, true, 'The local verifier retained password input');
  assert.match(verificationState.text, /Verified locally/u);
  assert.equal(verificationState.text.includes(path.basename(downloadedArchive)), true);
  assert.match(verificationState.text, /export-summary\.json \+ messages\.html \+ result\.json/u);
  assert.match(verificationState.text, /1 chat/u);
  assert.match(verificationState.text, /1 message/u);
  assert.match(verificationState.text, /No password/u);
  assert.match(verificationState.text, /never left this device/u);
  await execute(`
    const form = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('.tgx-form');
    if (form) form.scrollTop = 0;
  `);
  const verifiedDownloadScreenshot = await screenshot('02-verified-download.png');

  const copiedArchive = path.join(artifactsRoot, 'consumer-export.zip');
  await cp(downloadedArchive, copiedArchive);
  const zip = await loadArchive(downloadedArchive);
  for (const requiredEntry of ['messages.html', 'result.json', 'css/style.css']) {
    assert.ok(zip.file(requiredEntry), `The consumer ZIP is missing ${requiredEntry}`);
  }
  const resultJson = JSON.parse(await zip.file('result.json').async('string'));
  assert.equal(resultJson.messages.length, 1);
  assert.deepEqual(
    { id: resultJson.messages[0].id, text: resultJson.messages[0].text },
    { id: 42, text: 'A durable Firefox hello' },
  );
  const currentSummary = await readJsonEntry(zip, 'export-summary.json');
  assert.deepEqual(
    {
      partial: currentSummary.partial,
      chatsIncluded: currentSummary.chatsIncluded,
      messagesIncluded: currentSummary.messagesIncluded,
      mediaIncluded: currentSummary.media.included,
      mediaSkipped: currentSummary.media.skipped,
      contentUploaded: currentSummary.contentUploaded,
      archiveEncrypted: currentSummary.archiveEncrypted,
      coverageTargetDate: currentSummary.coverageTargetDate,
      coverageTargetReached: currentSummary.coverageTargetReached,
      chatCoverageTargetReached: currentSummary.chatCoverage[0].coverageTargetReached,
    },
    {
      partial: false,
      chatsIncluded: 1,
      messagesIncluded: 1,
      mediaIncluded: 0,
      mediaSkipped: 0,
      contentUploaded: false,
      archiveEncrypted: false,
      coverageTargetDate: '2026-08-10',
      coverageTargetReached: true,
      chatCoverageTargetReached: true,
    },
  );
  assert.equal(resultJson.telearchive.content_uploaded, false);
  assert.equal(resultJson.telearchive.archive_encrypted, false);

  await resetTerminalResult();
  const missedTargetConfigured = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const target = root?.querySelector('#tgx-coverage-target');
    if (!root || !target) return false;
    window.__renderTeleArchiveChat('123');
    target.value = '2026-08-09';
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return target.value;
  `);
  assert.equal(missedTargetConfigured, '2026-08-09');
  const archivesBeforeMissedTarget = await completedArchiveNames();
  await startUnencryptedExport();
  const missedTargetTerminal = await waitForTerminalExport('missed oldest-date target result');
  assert.equal(missedTargetTerminal.state, 'complete', `Missed-target export failed: ${missedTargetTerminal.text}`);
  assert.equal(missedTargetTerminal.targetStatusState, 'missed');
  assert.match(missedTargetTerminal.targetStatus, /History goal not reached.*Aug 9, 2026.*0\/1 chats/u);
  assert.match(missedTargetTerminal.target, /does not reach Aug 9, 2026/u);
  const missedTargetArchive = await waitForNewArchive(archivesBeforeMissedTarget, 'downloaded missed-target ZIP');
  targetMissedEvidence = {
    status: missedTargetTerminal.targetStatus,
    result: missedTargetTerminal.target,
    archive: path.basename(missedTargetArchive),
  };
  await resetTerminalResult();
  const alternateLayoutConfigured = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const main = document.querySelector('main');
    if (!root || !main) return null;
    const current = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'current');
    current?.click();
    root.querySelector('[data-tgx-preset="text"]')?.click();
    main.innerHTML = '<header><span data-scope="peer-title">Layout Direction Lab</span></header>'
      + '<div id="telearchive-virtualized-layout" data-scope="bubbles" style="height:120px;overflow:auto"></div>'
      + '<div class="input-message-input" data-peer-id="321"></div>';
    const container = document.getElementById('telearchive-virtualized-layout');
    const messages = {
      oldest: '<article class="im_message_wrap" id="message301" data-peer-id="321"><span class="peer-title">Layout Lab</span><time datetime="2026-08-10T07:01:00.000Z">10:01</time><div class="message-text">Oldest alternate-layout message</div></article>',
      middle: '<article data-scope="bubble" id="message302" data-peer-id="321"><span class="peer-title">Layout Lab</span><time datetime="2026-08-10T08:02:00.000Z">11:02</time><div data-scope="text">Middle scoped-bubble message</div></article>',
      newest: '<article class="message-list-item" id="message303" data-peer-id="321"><span class="peer-title">Layout Lab</span><time datetime="2026-08-10T09:03:00.000Z">12:03</time><div class="message-text">Newest list-item message</div></article>',
    };
    const renderBucket = (bucket) => {
      const currentTop = container.scrollTop;
      const topHeight = bucket === 'oldest' ? 0 : bucket === 'middle' ? 720 : 1440;
      const bottomHeight = 2160 - topHeight;
      container.innerHTML = '<div aria-hidden="true" style="height:' + topHeight + 'px"></div>'
        + messages[bucket]
        + '<div aria-hidden="true" style="height:' + bottomHeight + 'px"></div>';
      container.dataset.bucket = bucket;
      container.scrollTop = currentTop;
    };
    renderBucket('middle');
    container.scrollTop = 800;
    window.__telearchiveVirtualTrace = [{ top: container.scrollTop, bucket: container.dataset.bucket }];
    container.addEventListener('scroll', () => {
      const bucket = container.scrollTop < 320 ? 'oldest' : container.scrollTop > 1120 ? 'newest' : 'middle';
      if (bucket !== container.dataset.bucket) renderBucket(bucket);
      window.__telearchiveVirtualTrace.push({ top: container.scrollTop, bucket: container.dataset.bucket });
    });
    return {
      bucket: container.dataset.bucket,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      visibleMessage: container.querySelector('[data-scope="bubble"]')?.id || '',
    };
  `);
  assert.ok(alternateLayoutConfigured, 'The alternate virtualized Telegram layout could not be prepared');
  assert.equal(alternateLayoutConfigured.bucket, 'middle');
  assert.equal(alternateLayoutConfigured.visibleMessage, 'message302');
  assert.ok(alternateLayoutConfigured.scrollTop > 0 && alternateLayoutConfigured.scrollHeight > alternateLayoutConfigured.scrollTop);
  const archivesBeforeAlternate = await completedArchiveNames();
  await startUnencryptedExport();
  const alternateTerminal = await waitForTerminalExport('alternate-layout bidirectional export');
  assert.notEqual(alternateTerminal.state, 'error', `Alternate-layout export failed: ${alternateTerminal.text}`);
  const alternateScrollTrace = await execute(`
    const container = document.getElementById('telearchive-virtualized-layout');
    return { trace: window.__telearchiveVirtualTrace || [], finalTop: container?.scrollTop || 0, finalBucket: container?.dataset.bucket || '' };
  `);
  assert.match(
    alternateTerminal.summary,
    /3 messages/u,
    `The bidirectional virtualized export did not traverse every page: ${JSON.stringify(alternateScrollTrace)}`,
  );
  const alternateLayoutScreenshot = await screenshot('09-layout-direction-result.png');
  const alternateArchivePath = await waitForNewArchive(archivesBeforeAlternate, 'downloaded alternate-layout ZIP');
  const copiedAlternateArchive = path.join(artifactsRoot, 'consumer-layout-direction-export.zip');
  await cp(alternateArchivePath, copiedAlternateArchive);
  const alternateZip = await loadArchive(alternateArchivePath);
  const alternateResult = await readJsonEntry(alternateZip, 'result.json');
  const alternateSummary = await readJsonEntry(alternateZip, 'export-summary.json');
  assert.deepEqual(
    alternateResult.messages.map((message) => ({ id: message.id, text: message.text })),
    [
      { id: 301, text: 'Oldest alternate-layout message' },
      { id: 302, text: 'Middle scoped-bubble message' },
      { id: 303, text: 'Newest list-item message' },
    ],
  );
  assert.equal(alternateSummary.messagesIncluded, 3);
  assert.equal(alternateSummary.chatCoverage[0].oldestMessageDate, '2026-08-10T07:01:00.000Z');
  assert.equal(alternateSummary.chatCoverage[0].newestMessageDate, '2026-08-10T09:03:00.000Z');

  await resetTerminalResult();
  const stressConfigured = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const main = document.querySelector('main');
    if (!root || !main) return null;
    const messages = [];
    const mediaCount = 16;
    const bytesPerFile = 2 * 1024 * 1024;
    const bytes = new Uint8Array(bytesPerFile);
    for (let offset = 0; offset < bytes.length; offset += 65_536) {
      crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
    }
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 32_768, bytes.length)));
    }
    const stressUrl = 'data:application/octet-stream;base64,' + btoa(binary);
    for (let index = 0; index < mediaCount; index += 1) {
      const id = 400 + index;
      const minute = String(index).padStart(2, '0');
      messages.push('<article data-mid="message-' + id + '" data-peer-id="654"><span class="peer-title">Stress Lab</span><time datetime="2026-08-10T10:' + minute + ':00.000Z">13:' + minute + '</time><div data-scope="text">Stress file ' + (index + 1) + '</div><div data-scope="document"><a download="stress-' + String(index + 1).padStart(2, '0') + '.bin" href="' + stressUrl + '">stress file</a></div></article>');
    }
    main.innerHTML = '<header><span data-scope="peer-title">Media Stress Lab</span></header>'
      + '<div data-scope="bubbles" style="height:520px;overflow:auto">' + messages.join('') + '</div>'
      + '<div class="input-message-input" data-peer-id="654"></div>';
    const current = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'current');
    current?.click();
    root.querySelector('[data-tgx-preset="text"]')?.click();
    const files = root.querySelector('#tgx-files');
    if (files && !files.checked) files.click();
    const fileLimit = root.querySelector('#tgx-file-size');
    if (fileLimit) fileLimit.value = '3';
    return {
      messages: document.querySelectorAll('[data-mid]').length,
      filesEnabled: files?.checked === true,
      fileLimit: fileLimit?.value || '',
      totalFixtureBytes: mediaCount * bytesPerFile,
    };
  `);
  assert.deepEqual(stressConfigured, {
    messages: 16,
    filesEnabled: true,
    fileLimit: '3',
    totalFixtureBytes: 32 * 1024 * 1024,
  });
  const archivesBeforeStress = await completedArchiveNames();
  await startUnencryptedExport();
  const stressTerminal = await waitForTerminalExport('media-heavy stress export');
  assert.notEqual(stressTerminal.state, 'error', `Media-heavy stress export failed: ${stressTerminal.text}`);
  assert.match(stressTerminal.summary, /16 messages/u);
  assert.match(stressTerminal.summary, /16 media items included/u);
  const stressScreenshot = await screenshot('10-media-stress-result.png');
  const stressArchivePath = await waitForNewArchive(archivesBeforeStress, 'downloaded media-heavy ZIP');
  const stressArchiveBytes = (await readFile(stressArchivePath)).byteLength;
  assert.ok(stressArchiveBytes > 30 * 1024 * 1024, `The media-heavy archive is unexpectedly small: ${stressArchiveBytes} bytes`);
  const copiedStressArchive = path.join(artifactsRoot, 'consumer-media-stress-export.zip');
  await cp(stressArchivePath, copiedStressArchive);
  const stressZip = await loadArchive(stressArchivePath);
  const stressSummary = await readJsonEntry(stressZip, 'export-summary.json');
  const stressResult = await readJsonEntry(stressZip, 'result.json');
  assert.equal(stressSummary.messagesIncluded, 16);
  assert.equal(stressSummary.media.discovered, 16);
  assert.equal(stressSummary.media.included, 16);
  assert.equal(stressSummary.media.skipped, 0);
  assert.equal(stressResult.messages.length, 16);
  assert.equal(
    Object.keys(stressZip.files).filter((name) => name.startsWith('files/') && !name.endsWith('/')).length,
    16,
  );
  await setShadowFileInput('#tgx-verify-file', stressArchivePath);
  const stressVerification = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const status = root?.querySelector('#tgx-verify-status');
    if (!status || status.hidden || status.dataset.state !== 'file') return null;
    return { text: status.textContent || '', panelHidden: root.querySelector('#tgx-verify-panel')?.hidden === true };
  `), { timeoutMs: 60_000, label: 'local verification of the media-heavy ZIP' });
  assert.equal(stressVerification.panelHidden, true);
  assert.match(stressVerification.text, /Verified locally/u);
  assert.match(stressVerification.text, /16 messages/u);

  await resetTerminalResult();
  const primaryChatRestored = await execute(`
    return window.__renderTeleArchiveChat('123');
  `);
  assert.equal(primaryChatRestored, true, 'The primary Telegram fixture was not restored after stress coverage');

  const selectedModeRequested = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    if (!root) return false;
    root.querySelector('[data-tgx-preset="complete"]')?.click();
    const fileLimit = root.querySelector('#tgx-file-size');
    if (fileLimit) fileLimit.value = '1';
    const radio = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'selectable');
    radio?.click();
    return Boolean(radio);
  `);
  assert.equal(selectedModeRequested, true, 'The choose-chats mode was not available');
  const selectedListState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const panel = root?.querySelector('#tgx-chat-list-panel');
    const rows = [...(root?.querySelectorAll('.tgx-chat-row') || [])];
    if (!panel || panel.hidden || rows.length !== 55) return null;
    return {
      count: rows.length,
      firstNames: rows.slice(0, 2).map((row) => row.querySelector('.tgx-chat-name')?.textContent || ''),
    };
  `), { timeoutMs: 15_000, label: 'choose-chats list' });
  assert.deepEqual(selectedListState, { count: 55, firstNames: ['E2E Archive', 'Media Lab'] });
  const batchPlannerState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const planner = root?.querySelector('#tgx-batch-planner');
    const wizard = root?.querySelector('#tgx-manual-wizard');
    const selectedCount = () => [...root.querySelectorAll('.tgx-chat-check')].filter((input) => input.checked).length;
    if (!planner || planner.hidden) return null;
    const initial = {
      activeBatch: planner.dataset.activeBatch || '',
      totalBatches: planner.dataset.totalBatches || '',
      totalChats: planner.dataset.totalChats || '',
      batchSize: planner.dataset.batchSize || '',
      batchStart: planner.dataset.batchStart || '',
      batchEnd: planner.dataset.batchEnd || '',
      selected: selectedCount(),
      title: root.querySelector('#tgx-batch-title')?.textContent || '',
      detail: root.querySelector('#tgx-batch-detail')?.textContent || '',
      tabGuidance: root.querySelector('#tgx-batch-tab-guidance')?.textContent || '',
      handoff: root.querySelector('#tgx-batch-handoff')?.textContent || '',
      progress: root.querySelector('#tgx-batch-progress')?.textContent || '',
      next: root.querySelector('#tgx-batch-next')?.textContent || '',
      nextChat: root.querySelector('#tgx-batch-next-chat')?.textContent || '',
      chatProgress: root.querySelector('#tgx-batch-chat-progress')?.textContent || '',
      runAllVisible: root.querySelector('#tgx-batch-run-all')?.hidden === false,
      runAllText: root.querySelector('#tgx-batch-run-all')?.textContent || '',
      manifest: [...root.querySelectorAll('#tgx-batch-manifest-rows .tgx-batch-manifest-row')].map((row) => row.textContent || ''),
      wizard: {
        hidden: wizard?.hidden !== false,
        title: root.querySelector('#tgx-manual-wizard-title')?.textContent || '',
        meta: root.querySelector('#tgx-manual-wizard-meta')?.textContent || '',
        open: root.querySelector('#tgx-manual-wizard-open')?.textContent || '',
        steps: [...root.querySelectorAll('#tgx-manual-wizard .tgx-manual-wizard-steps li')].map((step) => step.textContent || ''),
        next: root.querySelector('#tgx-manual-wizard-next')?.textContent || '',
        action: root.querySelector('#tgx-manual-wizard-action')?.textContent || '',
        currentStep: wizard?.dataset.currentStep || '',
      },
    };
    root.querySelector('#tgx-batch-run-all')?.click();
    const queuedProgress = root.querySelector('#tgx-batch-progress')?.textContent || '';
    root.querySelector('#tgx-batch-next')?.click();
    const second = {
      activeBatch: planner.dataset.activeBatch || '',
      batchSize: planner.dataset.batchSize || '',
      batchStart: planner.dataset.batchStart || '',
      batchEnd: planner.dataset.batchEnd || '',
      selected: selectedCount(),
      detail: root.querySelector('#tgx-batch-detail')?.textContent || '',
      tabGuidance: root.querySelector('#tgx-batch-tab-guidance')?.textContent || '',
      handoff: root.querySelector('#tgx-batch-handoff')?.textContent || '',
      progress: root.querySelector('#tgx-batch-progress')?.textContent || '',
      nextChat: root.querySelector('#tgx-batch-next-chat')?.textContent || '',
      chatProgress: root.querySelector('#tgx-batch-chat-progress')?.textContent || '',
    };
    root.querySelector('#tgx-batch-previous')?.click();
    planner.scrollIntoView({ block: 'center' });
    return {
      initial,
      queuedProgress,
      second,
      restoredActiveBatch: planner.dataset.activeBatch || '',
      restoredSelected: selectedCount(),
      display: getComputedStyle(planner).display,
      columns: getComputedStyle(planner).gridTemplateColumns,
    };
  `);
  assert.ok(batchPlannerState, 'The guided batch planner was not shown for 55 selected chats');
  assert.deepEqual(
    {
      activeBatch: batchPlannerState.initial.activeBatch,
      totalBatches: batchPlannerState.initial.totalBatches,
      totalChats: batchPlannerState.initial.totalChats,
      batchSize: batchPlannerState.initial.batchSize,
      batchStart: batchPlannerState.initial.batchStart,
      batchEnd: batchPlannerState.initial.batchEnd,
      selected: batchPlannerState.initial.selected,
    },
    { activeBatch: '1', totalBatches: '2', totalChats: '55', batchSize: '50', batchStart: '1', batchEnd: '50', selected: 55 },
  );
  assert.match(batchPlannerState.initial.title, /Multi-chat mode.*55 chats.*2 ZIP batches/u);
  assert.match(batchPlannerState.initial.detail, /Batch 1 of 2.*chats 1–50.*50 in this ZIP/u);
  assert.match(batchPlannerState.initial.tabGuidance, /Keep Telegram open.*opens and checks chats.*one ZIP per batch/u);
  assert.match(batchPlannerState.initial.handoff, /opens.*E2E Archive.*checks.*adds.*verify/iu);
  assert.match(batchPlannerState.initial.nextChat, /Continue automatic chat check/u);
  assert.match(batchPlannerState.initial.chatProgress, /Chat-by-chat progress.*E2E Archive.*Media Lab/u);
  assert.equal(batchPlannerState.initial.wizard.hidden, false, 'The manual selected-chat checklist is not visible');
  assert.match(batchPlannerState.initial.wizard.title, /Multi-chat mode.*automatic per-chat check/u);
  assert.match(batchPlannerState.initial.wizard.meta, /Chat 1 of 55.*included.*one ZIP per batch/u);
  assert.match(batchPlannerState.initial.wizard.open, /Local Archive opens.*E2E Archive.*Telegram/u);
  assert.equal(batchPlannerState.initial.wizard.steps.length, 4);
  assert.match(batchPlannerState.initial.wizard.steps.join(' · '), /Local Archive checks.*Add.*ZIP.*Verify.*ZIP/u);
  assert.match(batchPlannerState.initial.wizard.next, /Next: verify the ZIP after export/u);
  assert.match(batchPlannerState.initial.wizard.action, /Review and save ZIP/u);
  assert.equal(batchPlannerState.initial.wizard.currentStep, '3');
  assert.match(batchPlannerState.initial.next, /Next: batch 2 \(51–55\)/u);
  assert.match(batchPlannerState.initial.progress, /0 of 2 batches complete/u);
  assert.equal(batchPlannerState.initial.runAllVisible, true);
  assert.match(batchPlannerState.initial.runAllText, /Queue all batches.*verify each ZIP/u);
  assert.equal(batchPlannerState.initial.manifest.length, 2);
  assert.match(batchPlannerState.initial.manifest[0], /Batch 1.*chats 1–50.*current batch/u);
  assert.match(batchPlannerState.initial.manifest[1], /Batch 2.*chats 51–55.*not started/u);
  assert.match(batchPlannerState.queuedProgress, /Batch 1 is ready.*before Batch 2.*0 of 2 batches complete/u);
  assert.deepEqual(
    {
      activeBatch: batchPlannerState.second.activeBatch,
      batchSize: batchPlannerState.second.batchSize,
      batchStart: batchPlannerState.second.batchStart,
      batchEnd: batchPlannerState.second.batchEnd,
      selected: batchPlannerState.second.selected,
    },
    { activeBatch: '2', batchSize: '5', batchStart: '51', batchEnd: '55', selected: 55 },
  );
  assert.match(batchPlannerState.second.detail, /Batch 2 of 2.*chats 51–55.*5 in this ZIP/u);
  assert.match(batchPlannerState.second.tabGuidance, /Keep Telegram open.*opens and checks chats.*one ZIP per batch/u);
  assert.match(batchPlannerState.second.handoff, /opens.*Batch Planning 49.*checks.*adds.*verify/iu);
  assert.match(batchPlannerState.second.progress, /Batch 2 is ready.*0 of 2 batches complete/u);
  assert.equal(batchPlannerState.restoredActiveBatch, '1');
  assert.equal(batchPlannerState.restoredSelected, 55);
  assert.equal(batchPlannerState.display, 'grid');
  assert.match(batchPlannerState.columns, /\S+\s+\S+\s+\S+/u);
  await delay(150);
  const batchPlannerScreenshot = await screenshot('05-batch-planner.png');

  const batchArchiveBefore = await completedArchiveNames();
  await startUnencryptedExport();
  const batchTerminal = await waitForTerminalExport('first real batch export for resume proof');
  assert.equal(batchTerminal.state, 'complete', `The first batch export failed: ${batchTerminal.text}`);
  assert.match(batchTerminal.summary, /Batch 1 of 2/u);
  assert.match(batchTerminal.primaryNext, /next batch|Batch Planning/u);
  const batchArchivePath = await waitForNewArchive(batchArchiveBefore, 'downloaded first batch ZIP for resume proof');
  const batchCompleteScreenshot = await screenshot('05-batch-complete.png');

  const closedBatchDialog = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const close = root?.querySelector('#tgx-cancel');
    if (!close) return false;
    close.click();
    return true;
  `);
  assert.equal(closedBatchDialog, true, 'The completed batch dialog could not be closed for resume proof');
  await waitFor(async () => execute('return !document.getElementById("telearchive-extension-root");'), { timeoutMs: 5_000, label: 'closed batch dialog before resume' });

  await switchToMainWindow();
  await setContext('content');
  assert.equal(await execute('return window.__renderTeleArchiveChat("123");'), true, 'The primary Telegram fixture was not restored before reopening the exporter');
  await setContext('chrome');
  const resumeMenuOpened = await execute(`
    const button = document.getElementById('unified-extensions-button');
    if (!button) return false;
    button.click();
    return true;
  `);
  assert.equal(resumeMenuOpened, true, 'Firefox did not reopen its Extensions menu for batch resume');
  await waitFor(async () => execute(`
    const button = document.getElementById(arguments[0])
      || [...document.querySelectorAll('toolbarbutton')].find((candidate) => candidate.getAttribute('label') === 'Local Archive');
    return button ? true : null;
  `, [actionButton.id]), { timeoutMs: 15_000, label: 'Local Archive action after closing batch receipt' });
  const resumeActionClicked = await execute(`
    const button = document.getElementById(arguments[0]);
    if (!button) return false;
    button.click();
    return true;
  `, [actionButton.id]);
  assert.equal(resumeActionClicked, true, 'The Local Archive action could not reopen the exporter');
  await switchToMainWindow();
  await setContext('content');
  await waitFor(async () => execute('return Boolean(document.getElementById("telearchive-extension-root")?.shadowRoot?.querySelector("#tgx-export"));'), { timeoutMs: 20_000, label: 'reopened exporter after a saved batch handoff' });
  await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    root.querySelector('[data-tgx-preset="complete"]')?.click();
    const radio = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'selectable');
    radio?.click();
    return Boolean(radio);
  `);
  await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const rows = [...(root?.querySelectorAll('.tgx-chat-row') || [])];
    return rows.length === 55 ? rows.length : null;
  `), { timeoutMs: 15_000, label: 'reloaded selected-chat list for batch resume' });
  const batchResumeState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const rows = [...root.querySelectorAll('.tgx-chat-row')];
    for (const row of rows) {
      const input = row.querySelector('.tgx-chat-check');
      if (!input.checked) {
        input.checked = true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const planner = root.querySelector('#tgx-batch-planner');
    return {
      selected: [...root.querySelectorAll('.tgx-chat-check')].filter((input) => input.checked).length,
      resumed: planner?.dataset.resumed === 'true',
      activeBatch: planner?.dataset.activeBatch || '',
      completedBatches: planner?.dataset.completedBatches || '',
      progress: root.querySelector('#tgx-batch-progress')?.textContent || '',
      handoff: root.querySelector('#tgx-batch-handoff')?.textContent || '',
      manifest: [...root.querySelectorAll('#tgx-batch-manifest-rows .tgx-batch-manifest-row')].map((row) => row.textContent || ''),
    };
  `);
  assert.equal(batchResumeState.selected, 55);
  assert.equal(batchResumeState.resumed, true, `The exporter did not mark the reopened batch plan as resumed: ${JSON.stringify(batchResumeState)}`);
  assert.equal(batchResumeState.activeBatch, '2');
  assert.equal(batchResumeState.completedBatches, '1');
  assert.match(batchResumeState.progress, /1 of 2 batches complete/u);
  assert.match(batchResumeState.handoff, /Resuming: 1 of 2 ZIPs verified.*batch 2.*opens and checks.*verify/i);
  assert.match(batchResumeState.manifest[0], /verified ZIP:/u);
  assert.match(batchResumeState.manifest[0], new RegExp(path.basename(batchArchivePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
  assert.match(batchResumeState.manifest[1], /current batch/u);
  await delay(150);
  const batchResumeScreenshot = await screenshot('05-batch-resume.png');
  assert.equal(await execute('return window.__renderTeleArchiveChat("123");'), true, 'The primary Telegram fixture was not restored after batch resume proof');

  const selectedConfigured = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    root.querySelector('#tgx-batch-previous')?.click();
    const rows = [...root.querySelectorAll('.tgx-chat-row')];
    for (const row of rows) {
      const input = row.querySelector('.tgx-chat-check');
      const name = row.querySelector('.tgx-chat-name')?.textContent || '';
      input.checked = name === 'E2E Archive' || name === 'Media Lab';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const target = root.querySelector('#tgx-coverage-target');
    if (target) {
      target.value = '2026-08-10';
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return {
      selected: [...root.querySelectorAll('.tgx-chat-check')].filter((input) => input.checked).length,
      completePreset: root.querySelector('[data-tgx-preset="complete"]')?.getAttribute('aria-pressed') === 'true',
      fileLimit: root.querySelector('#tgx-file-size')?.value,
      scopeSummary: root.querySelector('#tgx-summary-scope')?.textContent || '',
      coveragePreflight: root.querySelector('#tgx-coverage-preflight')?.textContent || '',
      boundary: root.querySelector('#tgx-preexport-title')?.textContent || '',
      coverageTarget: target?.value || '',
      coverageTargetReadable: root.querySelector('#tgx-coverage-target-readable')?.textContent || '',
      scaleGuidance: root.querySelector('#tgx-scale-guidance')?.textContent || '',
      coverageSettingsOpen: root.querySelector('#tgx-coverage-settings')?.open === true,
      moreMediaOpen: root.querySelector('#tgx-more-media')?.open === true,
      workloadText: root.querySelector('#tgx-workload-estimate')?.textContent || '',
      workloadLevel: root.querySelector('#tgx-workload-estimate')?.dataset.level || '',
      workloadAdvice: root.querySelector('#tgx-workload-advice')?.textContent || '',
      workloadAdviceVisible: root.querySelector('#tgx-workload-advice')?.hidden === false,
      workloadAdviceSampleVisible: root.querySelector('#tgx-workload-advice [data-tgx-run-sample]')?.hidden !== true,
      collapsedSampleHidden: root.querySelector('#tgx-collapsed-sample')?.hidden === true,
      collapsedSampleText: root.querySelector('#tgx-collapsed-sample')?.textContent || '',
      scopeEffortVisible: root.querySelector('#tgx-scope-effort')?.hidden === false,
      scopeEffortText: root.querySelector('#tgx-scope-effort')?.textContent || '',
      commitSummaryVisible: root.querySelector('#tgx-commit-summary')?.hidden === false,
      commitSummaryText: root.querySelector('#tgx-commit-summary')?.textContent || '',
      wizardHidden: root.querySelector('#tgx-manual-wizard')?.hidden === true,
      wizardMeta: root.querySelector('#tgx-manual-wizard-meta')?.textContent || '',
      wizardOpen: root.querySelector('#tgx-manual-wizard-open')?.textContent || '',
      wizardNext: root.querySelector('#tgx-manual-wizard-next')?.textContent || '',
      wizardAction: root.querySelector('#tgx-manual-wizard-action')?.textContent || '',
      batchChatProgress: root.querySelector('#tgx-batch-chat-progress')?.textContent || '',
      batchNextChat: root.querySelector('#tgx-batch-next-chat')?.textContent || '',
      wizardStep: root.querySelector('#tgx-manual-wizard')?.dataset.currentStep || '',
      batchPlannerHidden: root.querySelector('#tgx-batch-planner')?.hidden === true,
      runBoundaryVisible: root.querySelector('#tgx-run-boundary')?.hidden === false,
      runBoundaryText: root.querySelector('#tgx-run-boundary')?.textContent || '',
      preparationNext: root.querySelector('#tgx-preparation-next-text')?.textContent || '',
      reviewOpen: root.querySelector('#tgx-export-boundary')?.open === true,
    };
  `);
  assert.equal(selectedConfigured.selected, 2);
  assert.equal(selectedConfigured.completePreset, true);
  assert.equal(selectedConfigured.fileLimit, '1');
  assert.equal(selectedConfigured.coverageTarget, '2026-08-10');
  assert.match(selectedConfigured.coverageTargetReadable, /Selected date: Aug 10, 2026/u);
  assert.equal(selectedConfigured.coverageSettingsOpen, true);
  assert.equal(selectedConfigured.moreMediaOpen, true);
  assert.equal(selectedConfigured.batchPlannerHidden, true, 'The batch planner remained visible after reducing the selection below 50 chats');
  assert.match(selectedConfigured.scopeSummary, /2 selected/u);
  assert.match(selectedConfigured.scopeSummary, /E2E Archive/u);
  assert.match(selectedConfigured.scopeSummary, /Media Lab/u);
  assert.match(selectedConfigured.coveragePreflight, /E2E Archive.*1 message loaded now.*oldest/u);
  assert.match(selectedConfigured.coveragePreflight, /Media Lab.*exact range reported after export/u);
  assert.match(selectedConfigured.coveragePreflight, /Goal: reach Aug 10, 2026 in every chosen chat/u);
  assert.match(selectedConfigured.boundary, /Required goal: save every chosen chat back to Aug 10, 2026/u);
  assert.match(selectedConfigured.scaleGuidance, /chats to process.*2.*up to 50 per archive/u);
  assert.match(selectedConfigured.scaleGuidance, /processed one at a time.*export batches of 50.*next batch/u);
  assert.match(selectedConfigured.scaleGuidance, /Automatic chat check: Local Archive opens 2 chats one by one.*checks each readable format.*builds 1 ZIP/u);
  assert.equal(selectedConfigured.workloadLevel, 'moderate');
  assert.equal(selectedConfigured.workloadAdviceVisible, true, 'Moderate workloads do not expose the optional sample check');
  assert.equal(selectedConfigured.workloadAdviceSampleVisible, true, 'The moderate workload sample action is not visible');
  assert.equal(selectedConfigured.collapsedSampleHidden, false, 'The compact sample action is not visible for a selected-chat review');
  assert.match(selectedConfigured.collapsedSampleText, /Run optional ZIP sample/u);
  assert.equal(selectedConfigured.scopeEffortVisible, true, 'The selected-chat manual handoff summary is not visible beside scope controls');
  assert.match(selectedConfigured.scopeEffortText, /Multi-chat mode.*Local Archive opens each selected chat.*checks whether Telegram displays it in a readable format.*Plan: 2 chats.*1 ZIP/u);
  assert.match(selectedConfigured.scopeEffortText, /0 of 2 chats included.*next: E2E Archive/u);
  assert.equal(selectedConfigured.commitSummaryVisible, true, 'The pre-export formats/media summary is not visible');
  assert.match(selectedConfigured.commitSummaryText, /Before you start.*Readable HTML.*Reusable data \(JSON\).*Photos.*Videos and GIFs.*omissions/u);
  assert.match(selectedConfigured.workloadAdvice, /Recommended before.*test nearby history first/u);
  assert.equal(selectedConfigured.wizardHidden, false, 'The selected-chat checklist is not visible for a two-chat run');
  assert.match(selectedConfigured.wizardMeta, /Chat 1 of 2.*included.*one ZIP per batch/u);
  assert.match(selectedConfigured.wizardOpen, /Local Archive opens.*E2E Archive.*Telegram/u);
  assert.match(selectedConfigured.wizardNext, /Next: verify the ZIP after export/u);
  assert.match(selectedConfigured.wizardAction, /Review and save ZIP/u);
  assert.equal(selectedConfigured.wizardStep, '3');
  assert.equal(selectedConfigured.runBoundaryVisible, false, 'The multi-chat review repeats a boundary warning already shown in the plain-language card');
  assert.equal(selectedConfigured.reviewOpen, false, 'The hidden legacy review unexpectedly reopened in the simplified interface');
  assert.match(selectedConfigured.preparationNext, /start the automatic chat check.*opens and checks.*builds this ZIP.*verify it/u);
  assert.match(selectedConfigured.workloadText, /2 chats.*1 loaded in the open chat now.*5 media types/u);
  assert.match(selectedConfigured.workloadText, /Other counts are measured during export/u);
  assert.match(selectedConfigured.workloadText, /Files 1 MB/u);
  assert.match(selectedConfigured.workloadText, /512 MB.*HTML\/JSON/u);
  await execute(`
    const panel = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-chat-list-panel');
    panel?.scrollIntoView({ block: 'center' });
    const aside = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('.tgx-aside');
    if (aside) aside.scrollTop = aside.scrollHeight;
  `);
  await delay(150);
  const selectedReadyScreenshot = await screenshot('05-selected-ready.png');
  await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const guidance = root?.querySelector('#tgx-scale-guidance');
    const form = root?.querySelector('.tgx-form');
    if (guidance && form) {
      const guidanceRect = guidance.getBoundingClientRect();
      const formRect = form.getBoundingClientRect();
      form.scrollTop += guidanceRect.top - formRect.top - (form.clientHeight - guidanceRect.height) / 2;
    }
  `);
  await delay(100);
  const scalePlanningScreenshot = await screenshot('05-scale-planning.png');
  await execute(`
    const aside = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('.tgx-aside');
    if (aside) aside.scrollTop = 0;
  `);
  const archivesBeforeSelected = await completedArchiveNames();
  await startUnencryptedExport();
  const selectedTerminal = await waitForTerminalExport('selected-chat media export');
  assert.notEqual(selectedTerminal.state, 'error', `Selected-chat export failed: ${selectedTerminal.text}`);
  assert.match(selectedTerminal.summary, /2 chats/u);
  assert.match(selectedTerminal.summary, /9 messages/u);
  assert.match(selectedTerminal.summary, /7 media items included/u);
  assert.match(selectedTerminal.summary, /1 skipped/u);
  assert.match(selectedTerminal.summary, /size limit/u);
  assert.match(selectedTerminal.primarySummary, /History goal: reached/u);
  assert.match(selectedTerminal.primaryOmissions, /Skipped: oversize\.bin.*Files.*2(?:\.0)? MB exceeds the 1(?:\.0)? MB limit.*message 107.*Media Lab/u);
  assert.match(selectedTerminal.primaryNext, /Recovery:.*Files.*1(?:\.0)? MB.*at least 2(?:\.0)? MB.*Create another archive.*Verify the new ZIP.*All selected chats/u);
  assert.match(selectedTerminal.omissionAction, /Fix oversize\.bin.*set Files limit to at least 2(?:\.0)? MB/u);
  assert.equal(selectedTerminal.omissionActionVisible, true, 'Omission recovery action is not visible in the completed receipt');
  assert.match(selectedTerminal.omissions, /oversize/u);
  assert.match(selectedTerminal.omissions, /2(?:\.0)? MB > 1(?:\.0)? MB/u);
  assert.match(selectedTerminal.coverage, /Saved by chat/u);
  assert.match(selectedTerminal.coverage, /E2E Archive.*1 message/u);
  assert.match(selectedTerminal.coverage, /Media Lab.*8 messages/u);
  assert.match(selectedTerminal.target, /reaches Aug 10, 2026 in 2\/2 requested chats/u);
  assert.match(selectedTerminal.target, /not complete Telegram history/u);
  assert.equal(selectedTerminal.targetState, 'reached');
  assert.match(selectedTerminal.targetStatus, /History goal reached.*Aug 10, 2026.*2\/2 chats/u);
  assert.equal(selectedTerminal.targetStatusState, 'reached');
  assert.match(selectedTerminal.validation, /Passed.*files.*report readable/u);
  await execute(`
    const receipt = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-receipt');
    if (receipt) receipt.scrollTop = 0;
  `);
  const mediaScreenshot = await screenshot('05-media-result.png');
  const omissionRecoveryState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    root?.querySelector('#tgx-result-omission-action')?.click();
    const action = root?.querySelector('#tgx-result-omission-action');
    return {
      detailsOpen: root?.querySelector('#tgx-result-details')?.open === true,
      customizeOpen: root?.querySelector('#tgx-customize')?.open === true,
      progressHidden: root?.querySelector('#tgx-progress')?.hidden === true,
      moreMediaOpen: root?.querySelector('#tgx-more-media')?.open === true,
      activeId: root?.activeElement?.id || '',
      actionVisible: Boolean(action && !action.hidden && action.getBoundingClientRect().height > 0),
    };
  `);
  assert.equal(omissionRecoveryState.detailsOpen, false);
  assert.equal(omissionRecoveryState.customizeOpen, true);
  assert.equal(omissionRecoveryState.progressHidden, true);
  assert.equal(omissionRecoveryState.moreMediaOpen, true);
  assert.match(omissionRecoveryState.activeId, /tgx-(videos|stickers|files|photos|voice|photo-size|video-size|file-size)/u);
  assert.equal(omissionRecoveryState.actionVisible, false);
  await delay(350);
  const omissionTargetVisibility = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const form = root?.querySelector('.tgx-form');
    const target = root?.querySelector('[data-omission-target="true"]');
    if (!form || !target) return null;
    const formRect = form.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return targetRect.top >= formRect.top && targetRect.bottom <= formRect.bottom;
  `);
  assert.equal(omissionTargetVisibility, true, 'The exact media limit remains clipped after opening omission recovery');
  const mediaRecoveryScreenshot = await screenshot('05-media-recovery.png');
  await execute(`
    const progress = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-progress');
    progress?.scrollIntoView({ block: 'end' });
  `);
  await delay(100);
  const mediaCoverageScreenshot = await screenshot('05-media-coverage.png');
  await execute(`
    const aside = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('.tgx-aside');
    if (aside) aside.scrollTop = 0;
  `);

  const selectedArchivePath = await waitForNewArchive(archivesBeforeSelected, 'downloaded selected-chat media ZIP');
  const copiedMediaArchive = path.join(artifactsRoot, 'consumer-media-export.zip');
  await cp(selectedArchivePath, copiedMediaArchive);
  const selectedZip = await loadArchive(selectedArchivePath);
  const selectedSummary = await readJsonEntry(selectedZip, 'export-summary.json');
  assert.equal(selectedSummary.media.skippedItems.length, 1);
  assert.match(selectedSummary.media.skippedItems[0].name, /oversize/u);
  assert.equal(selectedSummary.media.skippedItems[0].reason, 'size_limit');
  assert.equal(selectedSummary.media.skippedItems[0].actualBytes, 2 * 1024 * 1024);
  assert.equal(selectedSummary.media.skippedItems[0].limitBytes, 1024 * 1024);
  assert.deepEqual(
    selectedSummary.chatCoverage.map((chat) => ({
      name: chat.name,
      messagesIncluded: chat.messagesIncluded,
      oldestMessageDate: chat.oldestMessageDate,
      newestMessageDate: chat.newestMessageDate,
      oldestCalendarDate: chat.oldestCalendarDate,
      coverageTargetReached: chat.coverageTargetReached,
    })),
    [
      {
        name: 'E2E Archive',
        messagesIncluded: 1,
        oldestMessageDate: '2026-08-10T08:00:00.000Z',
        newestMessageDate: '2026-08-10T08:00:00.000Z',
        oldestCalendarDate: '2026-08-10',
        coverageTargetReached: true,
      },
      {
        name: 'Media Lab',
        messagesIncluded: 8,
        oldestMessageDate: '2026-08-10T08:01:00.000Z',
        newestMessageDate: '2026-08-10T08:08:00.000Z',
        oldestCalendarDate: '2026-08-10',
        coverageTargetReached: true,
      },
    ],
  );
  assert.deepEqual(
    {
      partial: selectedSummary.partial,
      scopeMode: selectedSummary.scopeMode,
      chatsRequested: selectedSummary.chatsRequested,
      chatsIncluded: selectedSummary.chatsIncluded,
      messagesIncluded: selectedSummary.messagesIncluded,
      coverageTargetDate: selectedSummary.coverageTargetDate,
      coverageTargetReached: selectedSummary.coverageTargetReached,
      media: {
        discovered: selectedSummary.media.discovered,
        included: selectedSummary.media.included,
        skipped: selectedSummary.media.skipped,
        pending: selectedSummary.media.pending,
        reasons: selectedSummary.media.skippedByReason,
        byType: selectedSummary.media.byType,
      },
    },
    {
      partial: false,
      scopeMode: 'selectable',
      chatsRequested: 2,
      chatsIncluded: 2,
      messagesIncluded: 9,
      coverageTargetDate: '2026-08-10',
      coverageTargetReached: true,
      media: {
        discovered: 8,
        included: 7,
        skipped: 1,
        pending: 0,
        reasons: { size_limit: 1 },
        byType: {
          photo: 1,
          video_file: 1,
          video_message: 1,
          animation: 1,
          voice_message: 1,
          sticker: 1,
          file: 1,
        },
      },
    },
  );
  for (const requiredEntry of [
    'chats/chat_01/messages.html',
    'chats/chat_01/result.json',
    'chats/chat_02/messages.html',
    'chats/chat_02/result.json',
  ]) {
    assert.ok(selectedZip.file(requiredEntry), `The selected-chat ZIP is missing ${requiredEntry}`);
  }
  for (const folder of ['photos/', 'video_files/', 'animations/', 'voice_messages/', 'stickers/', 'video_message_files/', 'files/']) {
    assert.ok(
      Object.keys(selectedZip.files).some((name) => name.startsWith(`chats/chat_02/${folder}`) && !name.endsWith('/')),
      `The selected-chat ZIP contains no ${folder} media`,
    );
  }
  const selectedResults = await Promise.all([
    readJsonEntry(selectedZip, 'chats/chat_01/result.json'),
    readJsonEntry(selectedZip, 'chats/chat_02/result.json'),
  ]);
  assert.deepEqual(selectedResults.map((result) => result.chats.list[0].name), ['E2E Archive', 'Media Lab']);
  const selectedResult = selectedResults[1];
  assert.equal(selectedResult.chats.list[0].messages.length, 8);
  assert.equal(selectedResult.telearchive.partial, false);
  assert.equal(selectedResult.telearchive.history_source, 'rendered-telegram-web');
  assert.equal(selectedResult.telearchive.coverage_target_date, '2026-08-10');
  assert.equal(selectedResult.telearchive.coverage_target_reached, true);

  await resetTerminalResult();
  const categoryModeRequested = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const target = root?.querySelector('#tgx-coverage-target');
    if (target) {
      target.value = '2026-08-10';
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const radio = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'all');
    radio?.click();
    return Boolean(radio);
  `);
  assert.equal(categoryModeRequested, true, 'The category export mode was not available');
  const categoryState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const panel = root?.querySelector('#tgx-chat-type-panel');
    const select = root?.querySelector('#tgx-chat-type');
    if (!panel || panel.hidden || !select || select.options.length === 0) return null;
    const personal = [...select.options].find((option) => option.value === 'Personal Chats');
    if (!personal) return null;
    select.value = personal.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: select.value, label: select.selectedOptions[0]?.textContent || '' };
  `), { timeoutMs: 10_000, label: 'category selector' });
  assert.deepEqual(categoryState, { value: 'Personal Chats', label: 'Personal chats' });
  const archivesBeforeCategory = await completedArchiveNames();
  await startUnencryptedExport();
  const categoryTerminal = await waitForTerminalExport('category export');
  assert.notEqual(categoryTerminal.state, 'error', `Category export failed: ${categoryTerminal.text}`);
  assert.match(categoryTerminal.summary, /2 chats/u);
  assert.match(categoryTerminal.summary, /9 messages/u);
  assert.match(categoryTerminal.target, /reaches Aug 10, 2026 in 2\/2 requested chats/u);
  assert.match(categoryTerminal.target, /not complete Telegram history/u);
  assert.equal(categoryTerminal.targetState, 'reached');
  assert.match(categoryTerminal.targetStatus, /History goal reached.*Aug 10, 2026.*2\/2 chats/u);
  assert.equal(categoryTerminal.targetStatusState, 'reached');
  const categoryScreenshot = await screenshot('06-category-result.png');
  const categoryArchivePath = await waitForNewArchive(archivesBeforeCategory, 'downloaded category ZIP');
  const copiedCategoryArchive = path.join(artifactsRoot, 'consumer-category-export.zip');
  await cp(categoryArchivePath, copiedCategoryArchive);
  const categoryZip = await loadArchive(categoryArchivePath);
  const categorySummary = await readJsonEntry(categoryZip, 'export-summary.json');
  assert.deepEqual(
    {
      partial: categorySummary.partial,
      scopeMode: categorySummary.scopeMode,
      scopeLabel: categorySummary.scopeLabel,
      chatsRequested: categorySummary.chatsRequested,
      chatsIncluded: categorySummary.chatsIncluded,
      chatsSkipped: categorySummary.chatsSkipped,
      messagesIncluded: categorySummary.messagesIncluded,
      mediaIncluded: categorySummary.media.included,
      mediaSkipped: categorySummary.media.skipped,
      coverageTargetDate: categorySummary.coverageTargetDate,
      coverageTargetReached: categorySummary.coverageTargetReached,
      chatCoverageTargetReached: categorySummary.chatCoverage.map((chat) => chat.coverageTargetReached),
    },
    {
      partial: false,
      scopeMode: 'all',
      scopeLabel: 'Personal Chats',
      chatsRequested: 2,
      chatsIncluded: 2,
      chatsSkipped: 0,
      messagesIncluded: 9,
      mediaIncluded: 7,
      mediaSkipped: 1,
      coverageTargetDate: '2026-08-10',
      coverageTargetReached: true,
      chatCoverageTargetReached: [true, true],
    },
  );
  const categoryResults = await Promise.all([
    readJsonEntry(categoryZip, 'chats/chat_01/result.json'),
    readJsonEntry(categoryZip, 'chats/chat_02/result.json'),
  ]);
  assert.deepEqual(categoryResults.map((result) => result.chats.list[0].name), ['E2E Archive', 'Media Lab']);

  await resetTerminalResult();
  const partialConfigured = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const current = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'current');
    current?.focus();
    current?.click();
    window.__renderTeleArchiveChat('123', { tall: true });
    const target = root.querySelector('#tgx-coverage-target');
    if (target) {
      target.value = '2026-08-09';
      target.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const bubbles = document.querySelector('[data-scope="bubbles"]');
    if (!bubbles) return false;
    bubbles.innerHTML = Array.from({ length: 40 }, (_, index) => {
      const id = index + 200;
      const minute = String(index % 60).padStart(2, '0');
      return '<article data-mid="message-' + id + '" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-10T09:' + minute + ':00.000Z">12:' + minute + '</time><div data-scope="text">Partial message ' + id + '</div></article>';
    }).join('');
    bubbles.style.height = '120px';
    bubbles.style.overflow = 'auto';
    const filler = document.createElement('div');
    filler.style.height = '1400px';
    bubbles.prepend(filler);
    bubbles.scrollTop = bubbles.scrollHeight;
    return true;
  `);
  assert.equal(partialConfigured, true, 'The partial-export fixture could not be prepared');
  const archivesBeforePartial = await completedArchiveNames();
  await startUnencryptedExport();
  await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const progress = root?.querySelector('#tgx-progress');
    return Boolean(progress && !progress.hidden && progress.getAttribute('data-state') === 'working');
  `), { timeoutMs: 10_000, label: 'partial export progress' });
  const liveCollectionText = await waitFor(async () => execute(`
    const text = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-progress-text')?.textContent || '';
    return /(?:Checking newer messages|Loading older messages automatically).*40 found/u.test(text) ? text : null;
  `), { timeoutMs: 10_000, label: 'live collected-message count' });
  assert.match(liveCollectionText, /40 found/u);
  const partialProgressScreenshot = await screenshot('07-partial-progress.png');
  await delay(100);
  const partialCancelled = await execute(`
    const button = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-cancel');
    if (!button || !button.textContent?.includes('Stop')) return false;
    button.click();
    return true;
  `);
  assert.equal(partialCancelled, true, 'The stop-and-save-partial action was not available');
  const partialTerminal = await waitForTerminalExport('partial export result');
  assert.notEqual(partialTerminal.state, 'error', `Partial export failed: ${partialTerminal.text}`);
  assert.equal(partialTerminal.partial, true, 'The terminal receipt did not mark the archive partial');
  assert.equal(partialTerminal.targetStatusState, 'unknown');
  assert.match(partialTerminal.targetStatus, /History goal unknown.*Aug 9, 2026/u);
  assert.match(partialTerminal.filename, /_partial\.zip$/u);
  assert.match(partialTerminal.note, /Partial archive/u);
  const partialScreenshot = await screenshot('07-partial-result.png');
  const partialArchivePath = await waitForNewArchive(archivesBeforePartial, 'downloaded partial ZIP');
  const copiedPartialArchive = path.join(artifactsRoot, 'consumer-partial-export.zip');
  await cp(partialArchivePath, copiedPartialArchive);
  const partialZip = await loadArchive(partialArchivePath);
  const partialSummary = await readJsonEntry(partialZip, 'export-summary.json');
  const partialResult = await readJsonEntry(partialZip, 'result.json');
  assert.equal(partialSummary.partial, true);
  assert.equal(partialResult.telearchive.partial, true);
  assert.equal(partialSummary.chatsIncluded, 1);
  assert.equal(partialSummary.messagesIncluded, partialResult.messages.length);
  assert.ok(partialResult.messages.length > 0, 'The partial archive did not preserve collected messages');

  await resetTerminalResult();
  const privateNearbyHistoryConfigured = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const main = document.querySelector('main');
    if (!root || !main) return null;
    const current = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'current');
    current?.focus();
    current?.click();
    root.querySelector('[data-tgx-preset="text"]')?.click();
    main.innerHTML = '<header><span data-scope="peer-title">E2E Archive</span></header>'
      + '<div id="telearchive-private-nearby-history" data-scope="bubbles" style="height:120px;overflow:auto"></div>'
      + '<div class="input-message-input" data-peer-id="123"></div>';
    const container = document.getElementById('telearchive-private-nearby-history');
    const messages = {
      oldest: '<article data-mid="message-501" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-10T10:01:00.000Z">13:01</time><div data-scope="text">Older private-check message</div></article>',
      middle: '<article data-mid="message-502" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-10T10:02:00.000Z">13:02</time><div data-scope="text">Current private-check message</div></article>',
      newest: '<article data-mid="message-503" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-10T10:03:00.000Z">13:03</time><div data-scope="text">Newer private-check message</div></article>',
    };
    const renderBucket = (bucket) => {
      const currentTop = container.scrollTop;
      const topHeight = bucket === 'oldest' ? 0 : bucket === 'middle' ? 720 : 1440;
      const bottomHeight = 2160 - topHeight;
      container.innerHTML = '<div aria-hidden="true" style="height:' + topHeight + 'px"></div>'
        + messages[bucket]
        + '<div aria-hidden="true" style="height:' + bottomHeight + 'px"></div>';
      container.dataset.bucket = bucket;
      container.scrollTop = currentTop;
    };
    renderBucket('middle');
    container.scrollTop = 800;
    window.__telearchivePrivateNearbyTrace = [{ top: container.scrollTop, bucket: container.dataset.bucket }];
    container.addEventListener('scroll', () => {
      const bucket = container.scrollTop < 320 ? 'oldest' : container.scrollTop > 1120 ? 'newest' : 'middle';
      if (bucket !== container.dataset.bucket) renderBucket(bucket);
      window.__telearchivePrivateNearbyTrace.push({ top: container.scrollTop, bucket: container.dataset.bucket });
    });
    return {
      bucket: container.dataset.bucket,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      visibleMessage: container.querySelector('[data-mid]')?.getAttribute('data-mid') || '',
    };
  `);
  assert.ok(privateNearbyHistoryConfigured, 'The private nearby-history fixture could not be prepared');
  assert.equal(privateNearbyHistoryConfigured.bucket, 'middle');
  assert.equal(privateNearbyHistoryConfigured.visibleMessage, 'message-502');
  assert.ok(
    privateNearbyHistoryConfigured.scrollTop > 0
      && privateNearbyHistoryConfigured.scrollHeight > privateNearbyHistoryConfigured.scrollTop,
    `The private nearby-history fixture is not scrollable: ${JSON.stringify(privateNearbyHistoryConfigured)}`,
  );
  const encryptionPassword = 'Local Archive E2E 2026!';
  const encryptedConfigured = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    if (!root) return false;
    const current = [...root.querySelectorAll('input[name="tgx-chats"]')].find((item) => item.value === 'current');
    current?.focus();
    current?.click();
    root.querySelector('[data-tgx-preset="text"]')?.click();
    const toggle = root.querySelector('#tgx-encrypt');
    const password = root.querySelector('#tgx-password');
    const confirm = root.querySelector('#tgx-password-confirm');
    if (toggle && !toggle.checked) toggle.click();
    if (!toggle?.checked || !password || !confirm) return false;
    password.value = ${JSON.stringify(encryptionPassword)};
    confirm.value = ${JSON.stringify(encryptionPassword)};
    return {
      panelVisible: !root.querySelector('#tgx-password-panel')?.hidden,
      passwordMasked: password.type === 'password',
      confirmationMasked: confirm.type === 'password',
      passwordPresent: password.value.length >= 8,
      confirmationMatches: confirm.value === password.value,
      hint: root.querySelector('.tgx-password-note')?.textContent || '',
      footerProtection: root.querySelector('#tgx-footer-protection')?.textContent || '',
      preparationProtection: root.querySelector('#tgx-preparation-protection')?.textContent || '',
      aesGuideButtonText: root.querySelector('#tgx-open-aes-guide')?.textContent || '',
    };
  `);
  assert.equal(encryptedConfigured.panelVisible, true, 'AES-256 password protection could not be configured');
  assert.equal(encryptedConfigured.passwordMasked, true, 'The archive password is not masked');
  assert.equal(encryptedConfigured.confirmationMasked, true, 'The archive password confirmation is not masked');
  assert.equal(encryptedConfigured.passwordPresent, true, 'The archive password field is empty');
  assert.equal(encryptedConfigured.confirmationMatches, true, 'The archive password confirmation does not match');
  assert.match(encryptedConfigured.hint, /write down or store this password elsewhere/u);
  assert.match(encryptedConfigured.hint, /clears it after export and cannot recover it/u);
  assert.match(encryptedConfigured.footerProtection, /AES-256.*keep password elsewhere.*PeaZip.*7-Zip/u);
  assert.match(encryptedConfigured.preparationProtection, /Write down or store the password elsewhere.*On Linux.*PeaZip or 7-Zip/u);
  assert.match(encryptedConfigured.preparationProtection, /Verify downloaded ZIP/u);
  assert.match(encryptedConfigured.aesGuideButtonText, /First-use walkthrough/u);
  await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    root?.querySelector('.tgx-protection-warning')?.scrollIntoView({ block: 'center' });
  `);
  await delay(150);
  const protectionWarningScreenshot = await screenshot('08-protection-warning.png');
  const liveSmokeStarted = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const boundary = root?.querySelector('#tgx-export-boundary');
    const button = root?.querySelector('#tgx-run-live-smoke');
    if (!boundary || !button) return false;
    boundary.open = true;
    const details = root?.querySelector('#tgx-preparation-toggle');
    if (details?.getAttribute('aria-expanded') !== 'true') details.click();
    button.click();
    return true;
  `);
  assert.equal(liveSmokeStarted, true, 'The one-message live smoke test could not start');
  const liveSmokeState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const smoke = root?.querySelector('#tgx-live-smoke');
    if (!smoke || !['passed', 'error'].includes(smoke.dataset.state || '')) return null;
    smoke.scrollIntoView({ block: 'center' });
    return {
      state: smoke.dataset.state || '',
      text: root.querySelector('#tgx-live-smoke-text')?.textContent || '',
      action: root.querySelector('#tgx-run-live-smoke')?.textContent || '',
      messageId: smoke.dataset.messageId || '',
      messageCount: Number(smoke.dataset.messageCount || 0),
      entryCount: Number(smoke.dataset.entryCount || 0),
      size: Number(smoke.dataset.size || 0),
      encrypted: smoke.dataset.encrypted || '',
      display: getComputedStyle(smoke).display,
    };
  `), { timeoutMs: 30_000, label: 'one-message live smoke ZIP create-and-reopen test' });
  assert.equal(liveSmokeState.state, 'passed', `One-message live smoke failed: ${liveSmokeState.text}`);
  assert.match(liveSmokeState.text, /Passed.*1 real message.*ZIP reopened locally.*no file saved/u);
  assert.match(liveSmokeState.action, /one-message check/u);
  assert.equal(liveSmokeState.messageCount, 1);
  assert.ok(liveSmokeState.messageId, 'The one-message smoke did not bind a real message id');
  assert.ok(liveSmokeState.entryCount >= 4, `The one-message smoke archive is incomplete: ${JSON.stringify(liveSmokeState)}`);
  assert.ok(liveSmokeState.size > 0, 'The one-message smoke produced an empty archive');
  assert.equal(liveSmokeState.encrypted, 'true');
  assert.equal(liveSmokeState.display, 'none', 'The redundant one-message diagnostic became user-visible again');
  const liveSmokeScreenshot = await screenshot('01-live-smoke.png');
  const archivesBeforePrivatePreflight = await completedArchiveNames();
  const privatePreflightStarted = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const boundary = root?.querySelector('#tgx-export-boundary');
    const button = root?.querySelector('#tgx-run-private-preflight');
    if (!boundary || !button) return false;
    boundary.open = true;
    const details = root?.querySelector('#tgx-preparation-toggle');
    if (details?.getAttribute('aria-expanded') !== 'true') details.click();
    button.click();
    return true;
  `);
  assert.equal(privatePreflightStarted, true, 'The private nearby-history ZIP test could not start');
  const privatePreflightState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const preflight = root?.querySelector('#tgx-private-preflight');
    if (!preflight || !['passed', 'error'].includes(preflight.dataset.state || '')) return null;
    preflight.scrollIntoView({ block: 'center' });
    const style = getComputedStyle(preflight);
    return {
      state: preflight.dataset.state || '',
      text: root.querySelector('#tgx-private-preflight-text')?.textContent || '',
      action: root.querySelector('#tgx-run-private-preflight')?.textContent || '',
      messageIds: preflight.dataset.messageIds || '',
      messageCount: Number(preflight.dataset.messageCount || 0),
      directions: preflight.dataset.directions || '',
      positionRestored: preflight.dataset.positionRestored || '',
      scrollStart: Number(preflight.dataset.scrollStart || 0),
      scrollFinal: Number(preflight.dataset.scrollFinal || 0),
      entryCount: Number(preflight.dataset.entryCount || 0),
      size: Number(preflight.dataset.size || 0),
      encrypted: preflight.dataset.encrypted || '',
      preparationDetailsOpen: root.querySelector('#tgx-preparation-toggle')?.getAttribute('aria-expanded') === 'true',
      display: style.display,
      columns: style.gridTemplateColumns,
    };
  `), { timeoutMs: 30_000, label: 'private nearby-history ZIP create-and-reopen test' });
  assert.equal(privatePreflightState.state, 'passed', `Private ZIP test failed: ${privatePreflightState.text}`);
  assert.match(privatePreflightState.text, /Passed.*3 real messages.*newer \+ older nearby history.*reopened locally.*AES-256 password.*position restored.*no file saved/u);
  assert.match(privatePreflightState.action, /Run sample again/u);
  assert.deepEqual(privatePreflightState.messageIds.split(','), ['501', '502', '503']);
  assert.equal(privatePreflightState.messageCount, 3);
  assert.equal(privatePreflightState.directions, 'newer,older');
  assert.equal(privatePreflightState.positionRestored, 'true');
  assert.ok(Math.abs(privatePreflightState.scrollStart - 800) <= 2, `Unexpected private-test start position: ${JSON.stringify(privatePreflightState)}`);
  assert.ok(Math.abs(privatePreflightState.scrollFinal - 800) <= 2, `The private test did not restore its position: ${JSON.stringify(privatePreflightState)}`);
  assert.ok(privatePreflightState.entryCount >= 4, `The private ZIP test archive is incomplete: ${JSON.stringify(privatePreflightState)}`);
  assert.ok(privatePreflightState.size > 0, 'The private ZIP test produced an empty archive');
  assert.equal(privatePreflightState.encrypted, 'true');
  assert.equal(privatePreflightState.preparationDetailsOpen, true, 'The private test did not reveal its optional detail panel');
  assert.equal(privatePreflightState.display, 'grid', 'The private ZIP test fell back to an unstyled block');
  const privateNearbyHistoryTrace = await execute(`
    const container = document.getElementById('telearchive-private-nearby-history');
    return {
      trace: window.__telearchivePrivateNearbyTrace || [],
      finalTop: container?.scrollTop || 0,
      finalBucket: container?.dataset.bucket || '',
      visibleMessage: container?.querySelector('[data-mid]')?.getAttribute('data-mid') || '',
    };
  `);
  assert.ok(
    privateNearbyHistoryTrace.trace.some((item) => item.bucket === 'oldest')
      && privateNearbyHistoryTrace.trace.some((item) => item.bucket === 'newest'),
    `The private test did not visit both nearby virtualized pages: ${JSON.stringify(privateNearbyHistoryTrace)}`,
  );
  assert.ok(Math.abs(privateNearbyHistoryTrace.finalTop - 800) <= 2);
  assert.equal(privateNearbyHistoryTrace.finalBucket, 'middle');
  assert.equal(privateNearbyHistoryTrace.visibleMessage, 'message-502');
  const archivesAfterPrivatePreflight = await completedArchiveNames();
  assert.deepEqual(
    [...archivesAfterPrivatePreflight].sort(),
    [...archivesBeforePrivatePreflight].sort(),
    'The private ZIP test saved a file instead of keeping the archive in memory',
  );
  await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const preflight = root?.querySelector('#tgx-private-preflight');
    preflight?.scrollIntoView({ block: 'center' });
  `);
  await delay(150);
  const encryptedReadyScreenshot = await screenshot('08-encrypted-ready.png');
  const aesHelpState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const help = root?.querySelector('#tgx-aes-help');
    const form = root?.querySelector('.tgx-form');
    if (!help || !form) return null;
    root.querySelector('#tgx-open-aes-guide')?.click();
    return { open: help.open, text: help.textContent || '', preparationDetailsOpen: root.querySelector('#tgx-preparation-toggle')?.getAttribute('aria-expanded') === 'true' };
  `);
  await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const help = root?.querySelector('#tgx-aes-help');
    const summary = help?.querySelector('summary');
    return help?.open && (root?.activeElement === summary || root?.activeElement === help) ? true : null;
  `), { timeoutMs: 2_000, label: 'AES guide focus' });
  aesHelpState.focused = true;
  assert.equal(aesHelpState.open, true, 'The AES opening guide did not expand');
  assert.equal(aesHelpState.focused, true, 'The preparation shortcut did not move focus to the expanded AES guide');
  assert.equal(aesHelpState.preparationDetailsOpen, true, 'The AES walkthrough did not reveal its optional opening details');
  assert.match(aesHelpState.text, /Let Firefox finish downloading the ZIP/u);
  assert.match(aesHelpState.text, /PeaZip.*7-Zip/u);
  assert.match(aesHelpState.text, /Enter the password you saved/u);
  assert.match(aesHelpState.text, /open messages.html in Firefox/u);
  assert.match(aesHelpState.text, /AES-256 \/ WinZip AES ZIPs.*not legacy ZipCrypto/u);
  assert.match(aesHelpState.text, /documentation explicitly lists AES-256 ZIP or WinZip AES support/u);
  assert.match(aesHelpState.text, /Recommended on Linux: PeaZip or 7-Zip|Recommended: PeaZip/u);
  assert.match(aesHelpState.text, /Get PeaZip.*Official source/u);
  assert.match(aesHelpState.text, /Get 7-Zip.*Official source/u);
  assert.match(aesHelpState.text, /Test the extracted archive before deleting/u);
  await delay(100);
  const aesHelpScreenshot = await screenshot('08-aes-help.png');
  const archivesBeforeEncrypted = await completedArchiveNames();
  await acknowledgeHistoryReady();
  const encryptedStarted = await execute(`
    const button = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('#tgx-export');
    button?.click();
    return Boolean(button);
  `);
  assert.equal(encryptedStarted, true, 'The encrypted export could not start');
  const encryptedTerminal = await waitForTerminalExport('encrypted export result');
  assert.notEqual(encryptedTerminal.state, 'error', `Encrypted export failed: ${encryptedTerminal.text}`);
  assert.match(encryptedTerminal.protection, /AES-256 password/u);
  assert.match(encryptedTerminal.validation, /Passed.*files.*report readable/u);
  assert.match(encryptedTerminal.help, /Verify this AES ZIP below/u);
  assert.match(encryptedTerminal.help, /PeaZip.*7-Zip/u);
  assert.match(encryptedTerminal.progressBoundary, /not a complete Telegram backup.*only messages this tab exposes/u);
  assert.equal(encryptedTerminal.aesGuideVisible, true, 'The completed AES receipt did not surface the next opening action');
  assert.match(encryptedTerminal.aesGuideText, /Next: open this protected ZIP/u);
  assert.match(encryptedTerminal.aesGuideText, /How to open this ZIP/u);
  assert.match(encryptedTerminal.aesGuideText, /Open the downloaded ZIP in PeaZip or 7-Zip/u);
  assert.match(encryptedTerminal.aesGuideText, /Get PeaZip.*Get 7-Zip/u);
  const encryptedUiState = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    return {
      toggleChecked: root?.querySelector('#tgx-encrypt')?.checked === true,
      passwordCleared: root?.querySelector('#tgx-password')?.value === '',
      confirmationCleared: root?.querySelector('#tgx-password-confirm')?.value === '',
      panelHidden: root?.querySelector('#tgx-password-panel')?.hidden === true,
    };
  `);
  assert.deepEqual(encryptedUiState, {
    toggleChecked: true,
    passwordCleared: true,
    confirmationCleared: true,
    panelHidden: true,
  });
  await session('POST', '/window/rect', { width: 1100, height: 900 });
  await delay(150);
  const encryptedScreenshot = await screenshot('08-encrypted-result.png');
  const encryptedArchivePath = await waitForNewArchive(archivesBeforeEncrypted, 'downloaded encrypted ZIP');
  const copiedEncryptedArchive = path.join(artifactsRoot, 'consumer-encrypted-export.zip');
  await cp(encryptedArchivePath, copiedEncryptedArchive);

  await setShadowFileInput('#tgx-verify-file', encryptedArchivePath);
  const encryptedPasswordPrompt = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const panel = root?.querySelector('#tgx-verify-panel');
    const status = root?.querySelector('#tgx-verify-status');
    if (!panel || panel.hidden || !status || status.hidden) return null;
    return {
      filename: root.querySelector('#tgx-verify-filename')?.textContent || '',
      status: status.textContent || '',
      warning: panel.querySelector('p')?.textContent || '',
      passwordType: root.querySelector('#tgx-verify-password')?.type || '',
    };
  `), { timeoutMs: 30_000, label: 'AES password prompt for local ZIP verification' });
  assert.equal(encryptedPasswordPrompt.filename, path.basename(encryptedArchivePath));
  assert.match(encryptedPasswordPrompt.status, /needs its password/u);
  assert.match(encryptedPasswordPrompt.warning, /cannot recover a forgotten password/u);
  assert.match(encryptedPasswordPrompt.warning, /cleared immediately after the check/u);
  assert.equal(encryptedPasswordPrompt.passwordType, 'password');

  await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const password = root?.querySelector('#tgx-verify-password');
    if (password) password.value = 'wrong password';
    root?.querySelector('#tgx-verify-now')?.click();
    return true;
  `);
  const wrongPasswordState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const status = root?.querySelector('#tgx-verify-status');
    const password = root?.querySelector('#tgx-verify-password');
    if (!status || status.hidden || !/did not open this ZIP/u.test(status.textContent || '')) return null;
    return {
      state: status.dataset.state || '',
      text: status.textContent || '',
      passwordCleared: password?.value === '',
      panelVisible: root.querySelector('#tgx-verify-panel')?.hidden === false,
    };
  `), { timeoutMs: 30_000, label: 'wrong AES password rejection' });
  assert.equal(wrongPasswordState.state, 'error');
  assert.equal(wrongPasswordState.passwordCleared, true, 'The rejected AES password remained in the field');
  assert.equal(wrongPasswordState.panelVisible, true, 'The verifier did not keep a recoverable password retry path');

  await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const password = root?.querySelector('#tgx-verify-password');
    if (password) password.value = ${JSON.stringify(encryptionPassword)};
    root?.querySelector('#tgx-verify-now')?.click();
    return true;
  `);
  const encryptedVerificationState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const status = root?.querySelector('#tgx-verify-status');
    if (!status || status.hidden || status.dataset.state !== 'file') return null;
    return {
      text: status.textContent || '',
      passwordCleared: root.querySelector('#tgx-verify-password')?.value === '',
      panelHidden: root.querySelector('#tgx-verify-panel')?.hidden === true,
    };
  `), { timeoutMs: 30_000, label: 'successful AES ZIP verification' });
  assert.equal(encryptedVerificationState.passwordCleared, true, 'The successful AES password remained in the field');
  assert.equal(encryptedVerificationState.panelHidden, true, 'The AES verification panel did not close after success');
  assert.match(encryptedVerificationState.text, /Verified locally/u);
  assert.match(encryptedVerificationState.text, /export-summary\.json \+ messages\.html \+ result\.json/u);
  assert.match(encryptedVerificationState.text, /AES-256 password/u);
  assert.match(encryptedVerificationState.text, /never left this device/u);
  await execute(`
    const form = document.getElementById('telearchive-extension-root')?.shadowRoot?.querySelector('.tgx-form');
    if (form) form.scrollTop = 0;
  `);
  const encryptedVerifiedScreenshot = await screenshot('08-verified-download.png');

  const encryptedBlob = new Blob([await readFile(encryptedArchivePath)]);
  const encryptedReader = new ZipReader(new BlobReader(encryptedBlob));
  const encryptedEntries = await encryptedReader.getEntries();
  const encryptedFiles = encryptedEntries.filter((entry) => !entry.directory);
  assert.ok(encryptedFiles.length > 0, 'The encrypted ZIP contained no file entries');
  assert.equal(encryptedFiles.every((entry) => entry.encrypted === true && entry.zipCrypto === false), true);
  const encryptedSummaryEntry = encryptedFiles.find((entry) => entry.filename === 'export-summary.json');
  assert.ok(encryptedSummaryEntry && 'getData' in encryptedSummaryEntry, 'The encrypted report entry is missing');
  await assert.rejects(
    encryptedSummaryEntry.getData(new TextWriter(), { password: 'wrong password' }),
    /password/i,
  );
  const encryptedSummary = JSON.parse(await encryptedSummaryEntry.getData(new TextWriter(), { password: encryptionPassword }));
  assert.equal(encryptedSummary.archiveEncrypted, true);
  assert.equal(encryptedSummary.contentUploaded, false);
  assert.equal(encryptedSummary.messagesIncluded, 3);
  const encryptedResultEntry = encryptedFiles.find((entry) => entry.filename === 'result.json');
  assert.ok(encryptedResultEntry && 'getData' in encryptedResultEntry, 'The encrypted JSON export is missing');
  const encryptedResult = JSON.parse(await encryptedResultEntry.getData(new TextWriter(), { password: encryptionPassword }));
  assert.deepEqual(encryptedResult.messages.map((message) => message.id), [501, 502, 503]);
  await encryptedReader.close();

  await session('POST', '/window/rect', { width: 1280, height: 1200 });
  await session('POST', '/url', { url: `${extensionBaseUrl}options.html` });
  const optionsState = await waitFor(async () => execute(`
    const shell = document.querySelector('#options-shell');
    if (!shell || shell.getAttribute('aria-busy') !== 'false') return null;
    return {
      balancedPreset: document.querySelector('[data-preset="balanced"]')?.getAttribute('aria-pressed') === 'true',
      saveDisabled: document.querySelector('#save-button')?.disabled === true,
      resetDisabled: document.querySelector('#reset-button')?.disabled === true,
      formatHtml: document.querySelector('[data-preference="formatHtml"]')?.checked === true,
      formatJson: document.querySelector('[data-preference="formatJson"]')?.checked === true,
    };
  `), { timeoutMs: 10_000, label: 'loaded options page' });
  assert.deepEqual(optionsState, {
    balancedPreset: false,
    saveDisabled: true,
    resetDisabled: false,
    formatHtml: true,
    formatJson: true,
  });
  const optionsScreenshot = await screenshot('03-options.png');

  const invalidFormatAttempt = await execute(`
    const html = document.querySelector('[data-preference="formatHtml"]');
    const json = document.querySelector('[data-preference="formatJson"]');
    html?.click();
    json?.click();
    return {
      formatHtml: html?.checked === true,
      formatJson: json?.checked === true,
      status: document.querySelector('#save-status')?.textContent || '',
    };
  `);
  assert.deepEqual(invalidFormatAttempt, {
    formatHtml: true,
    formatJson: true,
    status: 'Select HTML, JSON, or both.',
  });

  const optionsPresetChanged = await execute(`
    document.querySelector('[data-preset="balanced"]')?.click();
    return {
      balancedPreset: document.querySelector('[data-preset="balanced"]')?.getAttribute('aria-pressed') === 'true',
      saveDisabled: document.querySelector('#save-button')?.disabled === true,
      resetDisabled: document.querySelector('#reset-button')?.disabled === true,
    };
  `);
  assert.deepEqual(optionsPresetChanged, { balancedPreset: true, saveDisabled: false, resetDisabled: false });
  await execute('document.querySelector("#save-button")?.click(); return true;');
  await waitFor(async () => execute(`
    return document.querySelector('#save-status')?.textContent?.length > 0
      && document.querySelector('#save-button')?.disabled === true;
  `), { timeoutMs: 5_000, label: 'saved default preset' });
  await execute('document.querySelector("#reset-button")?.click(); return true;');
  await waitFor(async () => execute(`
    return document.querySelector('[data-preset="balanced"]')?.getAttribute('aria-pressed') === 'true'
      && document.querySelector('#reset-button')?.disabled === true;
  `), { timeoutMs: 5_000, label: 'restored default preset' });

  await session('POST', '/window/rect', { width: 380, height: 720 });
  await setContext('content');
  await session('POST', '/url', { url: `${extensionBaseUrl}popup.html` });
  const popupState = await waitFor(async () => execute(`
    const shell = document.querySelector('#popup-shell');
    if (!shell || shell.getAttribute('aria-busy') !== 'false') return null;
    return {
      action: document.querySelector('#primary-label')?.textContent || '',
      version: document.querySelector('#version-label')?.textContent || '',
      width: shell.getBoundingClientRect().width,
      viewportHeight: innerHeight,
      documentHeight: document.documentElement.scrollHeight,
    };
  `), { timeoutMs: 10_000, label: 'loaded non-Telegram popup state' });
  assert.match(popupState.action, /Open Telegram/u);
  assert.match(popupState.version, /1\.1\.0/u);
  assert.equal(popupState.width, 380);
  const popupWindowRect = await session('GET', '/window/rect');
  await session('POST', '/window/rect', {
    width: 380,
    height: popupWindowRect.height + popupState.documentHeight - popupState.viewportHeight,
  });
  await delay(200);
  const popupScreenshot = await elementScreenshot('#popup-shell', '04-popup.png');

  const evidence = {
    firefox: created.capabilities?.browserVersion || null,
    extensionVersion: packageJson.version,
    installedId,
    entryCount: Object.keys(zip.files).length,
    exportedMessage: { id: resultJson.messages[0].id, text: resultJson.messages[0].text },
    scenarioReceipts: {
      current: {
        summary: currentSummary,
        archive: path.basename(copiedArchive),
        verification: verificationState,
      },
      coverageMissed: targetMissedEvidence,
      alternateLayout: {
        summary: alternateSummary,
        messageIds: alternateResult.messages.map((message) => message.id),
        archive: path.basename(copiedAlternateArchive),
      },
      mediaStress: {
        summary: stressSummary,
        archiveBytes: stressArchiveBytes,
        archive: path.basename(copiedStressArchive),
        verification: stressVerification,
      },
      selectedMedia: {
        summary: selectedSummary,
        archive: path.basename(copiedMediaArchive),
        targetStatus: {
          text: selectedTerminal.targetStatus,
          state: selectedTerminal.targetStatusState,
        },
      },
      category: {
        summary: categorySummary,
        archive: path.basename(copiedCategoryArchive),
      },
      partial: {
        summary: partialSummary,
        messageCount: partialResult.messages.length,
        archive: path.basename(copiedPartialArchive),
        targetStatus: {
          text: partialTerminal.targetStatus,
          state: partialTerminal.targetStatusState,
        },
      },
      encrypted: {
        summary: encryptedSummary,
        archive: path.basename(copiedEncryptedArchive),
        liveSmoke: liveSmokeState,
        privatePreflight: privatePreflightState,
        wrongPassword: wrongPasswordState,
        verification: encryptedVerificationState,
      },
    },
    initialLayout,
    mobileLayout,
    customizeState,
    advancedProtectionLayout,
    advancedMobileLayout,
    unsupportedLayoutState,
    restoredLayoutState,
    batchPlannerState,
    selectedConfigured,
    optionsState,
    popupState,
    resultState,
    artifacts: {
      initialScreenshot: path.basename(initialScreenshot),
      unsupportedLayoutScreenshot: path.basename(unsupportedLayoutScreenshot),
      mobileScreenshot: path.basename(mobileScreenshot),
      advancedScreenshot: path.basename(advancedScreenshot),
      advancedMobileScreenshot: path.basename(advancedMobileScreenshot),
      successScreenshot: path.basename(successScreenshot),
      showDownloadScreenshot: path.basename(showDownloadScreenshot),
      verifiedDownloadScreenshot: path.basename(verifiedDownloadScreenshot),
      alternateLayoutScreenshot: path.basename(alternateLayoutScreenshot),
      stressScreenshot: path.basename(stressScreenshot),
      batchPlannerScreenshot: path.basename(batchPlannerScreenshot),
      selectedReadyScreenshot: path.basename(selectedReadyScreenshot),
      scalePlanningScreenshot: path.basename(scalePlanningScreenshot),
      mediaScreenshot: path.basename(mediaScreenshot),
      mediaRecoveryScreenshot: path.basename(mediaRecoveryScreenshot),
      mediaCoverageScreenshot: path.basename(mediaCoverageScreenshot),
      categoryScreenshot: path.basename(categoryScreenshot),
      partialProgressScreenshot: path.basename(partialProgressScreenshot),
      partialScreenshot: path.basename(partialScreenshot),
      protectionWarningScreenshot: path.basename(protectionWarningScreenshot),
      liveSmokeScreenshot: path.basename(liveSmokeScreenshot),
      encryptedReadyScreenshot: path.basename(encryptedReadyScreenshot),
      aesHelpScreenshot: path.basename(aesHelpScreenshot),
      encryptedScreenshot: path.basename(encryptedScreenshot),
      encryptedVerifiedScreenshot: path.basename(encryptedVerifiedScreenshot),
      optionsScreenshot: path.basename(optionsScreenshot),
      popupScreenshot: path.basename(popupScreenshot),
      archive: path.basename(copiedArchive),
    },
    showDownloadAction,
  };
  await writeFile(path.join(artifactsRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Firefox E2E passed: current=${resultJson.messages.length} message + local ZIP verification; alternate-layout=${alternateResult.messages.length} messages from both scroll directions; media-stress=${stressSummary.media.included} files/${(stressArchiveBytes / 1024 / 1024).toFixed(1)} MiB; selected=${selectedSummary.chatsIncluded} chats/${selectedSummary.messagesIncluded} messages; category=${categorySummary.chatsIncluded} chats; partial=${partialResult.messages.length} messages; encrypted=AES-256 + wrong/correct password verification.`);
  console.log(`Evidence: ${artifactsRoot}`);
} catch (error) {
  const logTail = driverLog.join('').slice(-12_000);
  throw new Error(`${error.stack || error.message}\n\nGeckodriver log tail:\n${logTail}`);
} finally {
  if (sessionId) {
    try {
      await webdriver('DELETE', `/session/${sessionId}`, undefined, 15_000);
    } catch {
      // The owned headless session may already have exited after a failed assertion.
    }
  }
  await stopDriver();
  await stopPrivateBus();
  await rm(workRoot, { recursive: true, force: true });
}
