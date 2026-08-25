import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(
  path.join(projectRoot, 'package.json'),
  'utf8',
));
const extensionArchive = path.join(
  projectRoot,
  '.output',
  `${packageJson.name}-${packageJson.version}-firefox.zip`,
);
const artifactsRoot = path.resolve(
  process.env.TELEARCHIVE_SMOKE_ARTIFACTS
  || path.join(projectRoot, '.output', 'telegram-web-live-smoke'),
);
const firefoxBinary = process.env.FIREFOX_BIN || 'firefox';
const geckodriverBinary = process.env.GECKODRIVER_BIN || 'geckodriver';
const addonId = '{893462e9-4b44-4be5-97d6-f7178ef693b6}';

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
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 250, label = 'condition' } = {}) {
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
const workRoot = await mkdtemp(path.join(os.tmpdir(), 'telearchive-live-smoke-'));
const profileRoot = path.join(workRoot, 'profiles');
const downloadsRoot = path.join(workRoot, 'downloads');
await mkdir(downloadsRoot);
await mkdir(profileRoot);

const driverEnvironment = { ...process.env };
delete driverEnvironment.DISPLAY;
delete driverEnvironment.XAUTHORITY;

const driverLog = [];
let driverSpawnError = null;
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
driver.once('error', (error) => {
  driverSpawnError = error;
  driverLog.push(`geckodriver spawn failed: ${error.message}`);
});
for (const stream of [driver.stdout, driver.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    driverLog.push(chunk);
    if (driverLog.length > 200) driverLog.shift();
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

async function session(method, endpoint = '', body, timeoutMs) {
  assert.ok(sessionId, 'WebDriver session is unavailable');
  return webdriver(method, `/session/${sessionId}${endpoint}`, body, timeoutMs);
}

async function setContext(context) {
  await session('POST', '/moz/context', { context });
}

async function execute(script, args = []) {
  return session('POST', '/execute/sync', { script, args });
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

try {
  await waitFor(async () => {
    if (driverSpawnError) throw driverSpawnError;
    const response = await fetch(`${driverBaseUrl}/status`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  }, { timeoutMs: 15_000, label: 'geckodriver readiness' });

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

  const installedId = await session('POST', '/moz/addon/install', {
    path: extensionArchive,
    temporary: true,
  });
  assert.equal(installedId, addonId, 'Firefox installed an unexpected extension identity');

  await setContext('content');
  await session('POST', '/url', { url: 'https://web.telegram.org/k/' }, 120_000);
  const liveShell = await waitFor(async () => execute(`
    if (location.origin !== 'https://web.telegram.org' || !document.body) return null;
    const scripts = [...document.scripts]
      .map((item) => item.src)
      .filter(Boolean)
      .map((value) => new URL(value, location.href))
      .filter((value) => value.origin === location.origin)
      .map((value) => value.pathname.split('/').filter(Boolean).at(-1) || '')
      .filter(Boolean);
    if (document.readyState === 'loading' || scripts.length === 0) return null;
    const resources = performance.getEntriesByType('resource')
      .map((entry) => {
        try { return new URL(entry.name); } catch (_) { return null; }
      })
      .filter((value) => value?.origin === location.origin);
    return {
      origin: location.origin,
      path: location.pathname,
      title: document.title,
      language: document.documentElement.lang || '',
      readyState: document.readyState,
      bodyPresent: Boolean(document.body),
      sameOriginScriptCount: scripts.length,
      sameOriginResourceCount: resources.length,
      assetNames: [...new Set(scripts)].slice(0, 12),
      authShellDetected: Boolean(document.querySelector('[class*="auth" i], [id*="auth" i], canvas')),
    };
  `), { timeoutMs: 120_000, intervalMs: 500, label: 'live Telegram Web K shell' });
  assert.equal(liveShell.origin, 'https://web.telegram.org');
  assert.match(liveShell.path, /^\/k\/?/u);
  assert.ok(liveShell.sameOriginScriptCount > 0, 'Telegram Web loaded no same-origin application scripts');

  await setContext('chrome');
  const actionButtonId = `${addonId.replaceAll('{', '_').replaceAll('}', '_')}-BAP`;
  const menuOpened = await execute(`
    const button = document.getElementById('unified-extensions-button');
    if (!button) return false;
    button.click();
    return true;
  `);
  assert.equal(menuOpened, true, 'Firefox did not expose its Extensions menu');
  const actionButton = await waitFor(async () => execute(`
    const button = document.getElementById(arguments[0])
      || [...document.querySelectorAll('toolbarbutton')]
        .find((candidate) => candidate.getAttribute('label') === 'Local Archive — Conversation Exporter');
    return button ? { id: button.id, label: button.getAttribute('label') || '' } : null;
  `, [actionButtonId]), { timeoutMs: 15_000, label: 'Local Archive browser action registration' });
  const actionClicked = await execute(`
    const button = document.getElementById(arguments[0]);
    if (!button) return false;
    button.click();
    return true;
  `, [actionButton.id]);
  assert.equal(actionClicked, true, 'Local Archive could not be invoked on the live Telegram Web origin');

  await setContext('content');
  const extensionState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    if (!root) return null;
    const diagnostic = root.querySelector('#tgx-compatibility-diagnostic');
    const boundary = root.querySelector('#tgx-export-boundary');
    const action = root.querySelector('#tgx-export');
    const liveCheck = root.querySelector('#tgx-live-check');
    if (!diagnostic || !boundary || !action || !liveCheck) return null;
    action.click();
    return {
      title: root.querySelector('#tgx-title')?.textContent || '',
      diagnosticVisible: diagnostic.hidden === false,
      diagnostic: diagnostic.textContent || '',
      compatibilityState: boundary.dataset.compatibility || '',
      boundaryOpen: boundary.open === true,
      liveCheckState: liveCheck.dataset.state || '',
      liveCheck: liveCheck.textContent || '',
      actionDisabled: action.disabled === true,
      actionText: action.textContent || '',
      formError: root.querySelector('#tgx-form-error')?.textContent || '',
      messageCount: document.querySelectorAll('[data-mid], [data-message-id], [data-scope="bubble"], .message-list-item, .im_message_wrap').length,
    };
  `), { timeoutMs: 20_000, label: 'Local Archive live-origin fail-closed diagnostic' });
  assert.equal(extensionState.title, 'Local Archive');
  assert.equal(extensionState.diagnosticVisible, true, 'Live Telegram Web without an open chat did not show a compatibility diagnostic');
  assert.equal(extensionState.compatibilityState, 'error', 'Live Telegram Web without messages did not fail closed');
  assert.equal(extensionState.boundaryOpen, true, 'The live-origin diagnostic did not reveal its recovery guidance');
  assert.equal(extensionState.liveCheckState, 'error', 'The per-tab live layout canary did not fail closed');
  assert.match(extensionState.liveCheck, /Telegram layout check:.*Not ready/u);
  assert.match(extensionState.diagnostic, /No open chat|No rendered messages|No readable messages/u);
  assert.equal(extensionState.actionDisabled, true, 'The main action remained enabled without a readable conversation');
  assert.match(extensionState.actionText, /Open a readable conversation first/u);

  // The public smoke has no account by design. Add a representative current
  // Telegram Web message surface inside that exact live shell, then exercise
  // the real toolbar -> content -> background ZIP -> Firefox download path.
  const fixtureInjected = await execute(`
    const old = document.getElementById('telearchive-live-positive-fixture');
    old?.remove();
    const fixture = document.createElement('section');
    fixture.id = 'telearchive-live-positive-fixture';
    fixture.innerHTML = \`
      <aside class="chatlist-container">
        <a class="chatlist-chat active" data-peer-id="987" href="#987">
          <span class="user-title"><span class="peer-title">Representative live shell</span></span>
        </a>
      </aside>
      <main>
        <header><span data-scope="peer-title">Representative live shell</span></header>
        <div data-scope="bubbles" style="height:360px;overflow:auto">
          <article data-mid="901" data-peer-id="987">
            <span class="peer-title">Representative sender</span>
            <time datetime="2026-08-12T08:00:00.000Z">11:00</time>
            <div data-scope="text">Representative current-shell message</div>
          </article>
        </div>
        <div class="input-message-input" data-peer-id="987"></div>
      </main>\`;
    const root = document.getElementById('telearchive-extension-root');
    if (root) document.body.insertBefore(fixture, root);
    else document.body.appendChild(fixture);
    return {
      fixturePresent: Boolean(document.querySelector('#telearchive-live-positive-fixture [data-mid="901"]')),
      inputPeer: document.querySelector('#telearchive-live-positive-fixture .input-message-input')?.getAttribute('data-peer-id') || '',
    };
  `);
  assert.deepEqual(fixtureInjected, { fixturePresent: true, inputPeer: '987' });

  const positiveReady = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const refresh = root?.querySelector('#tgx-compatibility-refresh');
    if (!root || !refresh) return null;
    refresh.click();
    const liveCheck = root.querySelector('#tgx-live-check');
    const diagnostic = root.querySelector('#tgx-compatibility-diagnostic');
    const action = root.querySelector('#tgx-export');
    if (!liveCheck || !action) return null;
    return {
      liveCheckState: liveCheck.dataset.state || '',
      diagnosticVisible: diagnostic?.hidden === false,
      actionText: action.textContent || '',
      messageCount: document.querySelectorAll('#telearchive-live-positive-fixture [data-mid]').length,
    };
  `), { timeoutMs: 15_000, intervalMs: 250, label: 'representative live Telegram message surface' });
  assert.equal(positiveReady.liveCheckState, 'passed', 'Representative live Telegram surface did not pass the in-product canary');
  assert.equal(positiveReady.diagnosticVisible, false, 'The positive representative surface stayed behind the compatibility diagnostic');
  assert.equal(positiveReady.messageCount, 1);

  const previousDownloads = new Set(await readdir(downloadsRoot));
  const positiveExportStarted = await execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const none = root?.querySelector('#tgx-protection-none');
    const history = root?.querySelector('#tgx-history-ready');
    const action = root?.querySelector('#tgx-export');
    if (!none || !history || !action) return false;
    none.click();
    if (!history.checked) history.click();
    window.__telearchiveLiveDownload = null;
    document.addEventListener('telearchive:download', (event) => {
      window.__telearchiveLiveDownload = event.detail || null;
    }, { once: true });
    action.click();
    return {
      unencryptedSelected: root.querySelector('#tgx-protection-none')?.getAttribute('aria-pressed') === 'true',
      historyReady: history.checked === true,
    };
  `);
  assert.deepEqual(positiveExportStarted, { unencryptedSelected: true, historyReady: true });

  const livePositiveState = await waitFor(async () => execute(`
    const root = document.getElementById('telearchive-extension-root')?.shadowRoot;
    const progress = root?.querySelector('#tgx-progress');
    const event = window.__telearchiveLiveDownload;
    if (!progress || progress.hidden || progress.dataset.state !== 'complete' || !event) return null;
    return {
      liveCheck: root.querySelector('#tgx-live-check')?.textContent || '',
      messageCount: document.querySelectorAll('#telearchive-live-positive-fixture [data-mid]').length,
      resultFile: root.querySelector('#tgx-result-file')?.textContent || '',
      resultProtection: root.querySelector('#tgx-result-protection')?.textContent || '',
      resultValidation: root.querySelector('#tgx-result-validation')?.textContent || '',
      resultSummary: root.querySelector('#tgx-result-summary')?.textContent || '',
      downloadEvent: event,
    };
  `), { timeoutMs: 90_000, intervalMs: 250, label: 'representative live Telegram positive export' });
  assert.equal(livePositiveState.messageCount, 1);
  assert.match(livePositiveState.liveCheck, /Telegram layout readable in this open chat/u);
  assert.match(livePositiveState.resultProtection, /No password/u);
  assert.match(livePositiveState.resultValidation, /Passed/u);
  assert.equal(livePositiveState.downloadEvent.filename, livePositiveState.resultFile);
  assert.ok(Number(livePositiveState.downloadEvent.size) > 0);

  const liveArchivePath = await waitFor(async () => {
    const names = await readdir(downloadsRoot);
    const name = names.find((candidate) => candidate.endsWith('.zip') && !candidate.endsWith('.part') && !previousDownloads.has(candidate));
    if (!name) return null;
    const candidatePath = path.join(downloadsRoot, name);
    const size = (await stat(candidatePath)).size;
    return size > 0 ? candidatePath : null;
  }, { timeoutMs: 90_000, intervalMs: 250, label: 'representative live downloaded ZIP' });
  const liveZip = await JSZip.loadAsync(await readFile(liveArchivePath));
  const liveEntries = Object.keys(liveZip.files).filter((name) => !liveZip.files[name].dir).sort();
  assert.ok(liveEntries.includes('messages.html'), 'The positive live ZIP is missing messages.html');
  assert.ok(liveEntries.includes('result.json'), 'The positive live ZIP is missing result.json');
  assert.ok(liveEntries.includes('export-summary.json'), 'The positive live ZIP is missing export-summary.json');
  const liveSummary = JSON.parse(await liveZip.file('export-summary.json').async('string'));
  assert.equal(liveSummary.messagesIncluded, 1);
  assert.equal(liveSummary.contentUploaded, false);
  livePositiveState.downloadedZip = {
    filename: path.basename(liveArchivePath),
    bytes: (await stat(liveArchivePath)).size,
    entries: liveEntries,
    messagesIncluded: liveSummary.messagesIncluded,
    contentUploaded: liveSummary.contentUploaded,
  };

  const evidence = {
    observedAt: new Date().toISOString(),
    firefox: created.capabilities?.browserVersion || '',
    extensionVersion: packageJson.version,
    installedId,
    liveShell,
    extensionState,
    livePositiveState,
    isolation: {
      headless: true,
      disposableProfile: true,
      loopbackWebDriver: true,
      authenticatedAccountUsed: false,
      userProfileTouched: false,
      screenInputClipboardUsed: false,
      persistedPageContent: false,
    },
  };
  await writeFile(path.join(artifactsRoot, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Live Telegram Web smoke passed on Firefox ${evidence.firefox}: current shell loaded, no-chat export failed closed, and a representative current-shell surface produced and reopened a local ZIP.`);
  console.log(`Evidence: ${artifactsRoot}`);
} catch (error) {
  const tail = driverLog.join('').slice(-4_000);
  throw new Error(`${error?.stack || error}\nGeckodriver tail:\n${tail}`);
} finally {
  if (sessionId) await webdriver('DELETE', `/session/${sessionId}`).catch(() => undefined);
  await stopDriver();
  await rm(workRoot, { recursive: true, force: true });
}
