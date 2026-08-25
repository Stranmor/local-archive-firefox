import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { assertReleaseArchive, readReleaseManifest } from './release-contract.mjs';
import { firefoxProxyPreferences } from './firefox-proxy.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const extensionArchive = path.join(projectRoot, '.output', `${packageJson.name}-${packageJson.version}-firefox.zip`);
const artifactsRoot = path.resolve(
  process.env.LOCAL_ARCHIVE_TELEGRAM_E2E_ARTIFACTS
    || process.env.LOCAL_ARCHIVE_E2E_ARTIFACTS
    || path.join(projectRoot, '.output', 'e2e-firefox-v3'),
);
const firefoxBinary = process.env.FIREFOX_BIN || '/usr/lib/firefox/firefox';
const geckodriverBinary = process.env.GECKODRIVER_BIN
  || path.join(os.homedir(), '.local', 'state', 'telearchive-test', 'geckodriver', 'bin', 'geckodriver');
const addonId = '{893462e9-4b44-4be5-97d6-f7178ef693b6}';

await Promise.all([access(extensionArchive), access(firefoxBinary), access(geckodriverBinary)]);
const releaseManifest = await readReleaseManifest(
  projectRoot,
  process.env.LOCAL_ARCHIVE_RELEASE_MANIFEST || 'artifacts/RELEASE-MANIFEST.json',
);
const extensionBytes = await readFile(extensionArchive);
const extensionSha256 = createHash('sha256').update(extensionBytes).digest('hex');
const packageDescriptor = releaseManifest
  ? await assertReleaseArchive({ archivePath: extensionArchive, packageJson, releaseManifest })
  : { file: path.basename(extensionArchive), sha256: extensionSha256 };
await mkdir(artifactsRoot, { recursive: true });

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function seedTelegramFixture() {
  window.stop();
  window.__localArchiveLazyHistory = { requests: 0, pages: 0 };
  window.__localArchiveNativeHistory = { requests: [], pages: 0 };
  window.__localArchiveNativeMedia = { requests: 0 };
  const initial = [
    ['4','2026-08-04T08:00:00.000Z','Fourth day'],
    ['5','2026-08-05T08:00:00.000Z','Newest message'],
  ];
  const render = ([id,date,text]) => '<article data-mid="message-' + id + '" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="' + date + '">' + id + '</time><div data-scope="text">' + text + '</div></article>';
  document.body.innerHTML = '<aside id="column-left"><a class="chatlist-chat active" data-peer-id="123"><span class="peer-title">Release Chat</span></a></aside><main><header><span data-scope="peer-title">Release Chat</span></header><div class="bubbles-scrollable" data-scope="bubbles" style="height:320px;overflow:auto"><div class="bubbles-inner">'
    + initial.map(render).join('')
    + '</div><div style="height:900px"></div></div><div class="input-message-input" data-peer-id="123"></div></main>';
  const container = document.querySelector('.bubbles-scrollable');
  container.addEventListener('scroll', () => {
    if (container.scrollTop <= 24 && !window.__localArchiveLazyHistory.pages) {
      window.__localArchiveLazyHistory.requests += 1;
      const delayMs = Number(window.__localArchiveHistoryDelayMs) || 80;
      setTimeout(() => {
        container.querySelector('.bubbles-inner').insertAdjacentHTML('afterbegin', [
          ['1','2026-08-01T08:00:00.000Z','Oldest message'],
          ['2','2026-08-02T08:00:00.000Z','Second day'],
          ['3','2026-08-03T08:00:00.000Z','<span class="spoiler">Visible spoiler text</span>'],
        ].map(render).join(''));
        window.__localArchiveLazyHistory.pages = 1;
      }, 80);
    }
  });
  const nativeMessages = [
    ['1', 1785561600, 'Oldest message'],
    ['2', 1785648000, 'Second day'],
    ['3', 1785734400, 'Visible spoiler text'],
    ['4', 1785820800, 'Fourth day'],
    ['5', 1785907200, 'Newest message'],
  ].map(([id, date, message]) => ({
    _: 'message', id: Number(id), date: Number(date), message,
    from_id: {_: 'peerUser', user_id: 7}, entities: [],
    ...(id === '3' ? {
      media: {
        _: 'messageMediaDocument',
        document: {
          _: 'document', id: '9003', access_hash: '7', size: 12, mime_type: 'text/plain',
          attributes: [{_: 'documentAttributeFilename', file_name: 'native-note.txt'}],
        },
      },
    } : {}),
  }));
  window.appImManager = { chat: { peerId: 123, threadId: 0, type: 'Chat', title: 'Release Chat' } };
  window.apiManagerProxy = { getPeer: () => ({_: 'chat', id: 123, title: 'Release Chat'}) };
  window.rootScope = {
    managers: {
      appMessagesManager: {
        requestHistory: async (options) => {
          window.__localArchiveNativeHistory.requests.push({...options});
          const offset = Number(options?.offsetId || 0);
          const eligible = offset ? nativeMessages.filter((message) => message.id < offset) : nativeMessages;
          const page = eligible.slice(-3).reverse();
          window.__localArchiveNativeHistory.pages += 1;
          return {
            _: 'messages.messagesSlice',
            count: nativeMessages.length,
            messages: page,
            users: [{_: 'user', id: 7, first_name: 'Alice', last_name: 'Tester'}],
            chats: [{_: 'chat', id: 123, title: 'Release Chat'}],
          };
        },
      },
    },
  };
  window.appDownloadManager = {
    downloadMedia: async ({media}) => {
      window.__localArchiveNativeMedia.requests += 1;
      if (!media || media.id !== '9003') throw new Error('Unexpected native media target');
      return new Blob(['native media'], {type: 'text/plain'});
    },
  };
  return document.querySelectorAll('[data-mid]').length;
}

const telegramFixtureFunctionSource = seedTelegramFixture.toString();

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitFor(check, { timeoutMs = 30_000, intervalMs = 120, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

const port = await reservePort();
const driverUrl = `http://127.0.0.1:${port}`;
const workRoot = await mkdtemp(path.join(os.tmpdir(), 'local-archive-v2-e2e-'));
const profileRoot = path.join(workRoot, 'profiles');
const downloadsRoot = path.join(workRoot, 'downloads');
await Promise.all([mkdir(profileRoot), mkdir(downloadsRoot)]);

const driverLog = [];
const driver = spawn(geckodriverBinary, [
  '--host', '127.0.0.1', '--port', String(port), '--allow-system-access',
  '--profile-root', profileRoot, '--log', 'info',
], {
  cwd: projectRoot,
  env: { ...process.env, DISPLAY: undefined, XAUTHORITY: undefined },
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [driver.stdout, driver.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    driverLog.push(chunk);
    if (driverLog.length > 200) driverLog.shift();
  });
}

async function webdriver(method, endpoint, body, timeoutMs = 60_000) {
  const response = await fetch(`${driverUrl}${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json();
  if (!response.ok || payload?.value?.error) {
    throw new Error(payload?.value?.message || `${method} ${endpoint} failed: ${JSON.stringify(payload?.value)}`);
  }
  return payload.value;
}

let sessionId;
let mainWindow;
let inspectionWindow;
let extensionBaseUrl;
let telegramTabId;
let chromeTabDebug;
async function session(method, endpoint = '', body, timeoutMs) {
  assert.ok(sessionId);
  return webdriver(method, `/session/${sessionId}${endpoint}`, body, timeoutMs);
}
async function context(value) { await session('POST', '/moz/context', { context: value }); }
async function execute(script, args = []) { return session('POST', '/execute/sync', { script, args }); }
async function executeAsync(script, args = []) { return session('POST', '/execute/async', { script, args }); }

function elementId(element) {
  return element?.['element-6066-11e4-a52e-4f735466cecf'] || element?.ELEMENT;
}

async function screenshotElement(element, filename) {
  const id = elementId(element);
  assert.ok(id, `Screenshot element missing: ${filename}`);
  const png = await session('GET', `/element/${id}/screenshot`);
  const target = path.join(artifactsRoot, filename);
  await writeFile(target, Buffer.from(png, 'base64'));
  return target;
}

async function filesInDownloads() {
  return (await readdir(downloadsRoot)).filter((name) => name.endsWith('.zip') && !name.endsWith('.part')).sort();
}

async function waitForNewArchive(before) {
  const known = new Set(before);
  let candidatePath = null;
  let lastSize = -1;
  let stableObservations = 0;
  return waitFor(async () => {
    const names = await readdir(downloadsRoot);
    if (names.some((name) => name.endsWith('.part'))) return null;
    const archiveName = names.find((name) => name.endsWith('.zip') && !known.has(name));
    if (!archiveName) return null;
    candidatePath ||= path.join(downloadsRoot, archiveName);
    let currentSize;
    try {
      currentSize = (await stat(candidatePath)).size;
    } catch {
      return null;
    }
    if (currentSize > 0 && currentSize === lastSize) stableObservations += 1;
    else stableObservations = 0;
    lastSize = currentSize;
    return stableObservations >= 2 ? candidatePath : null;
  }, { timeoutMs: 90_000, intervalMs: 250, label: 'stable downloaded archive' });
}

async function openActionPopup() {
  if (telegramTabId) {
    await context('content');
    const activated = await executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.tabs.update(arguments[0], { active: true })
        .then(() => done(true))
        .catch((error) => done({ error: String(error) }));
    `, [telegramTabId]);
    assert.equal(activated, true, `Could not reactivate Telegram before opening the toolbar action: ${JSON.stringify(activated)}`);
    await delay(200);
  }
  await context('chrome');
  const actionId = `${addonId.replaceAll('{', '_').replaceAll('}', '_')}-BAP`;
  const menuOpened = await execute(`
    const menu = document.getElementById('unified-extensions-button');
    if (!menu) return false;
    menu.click();
    return true;
  `);
  assert.equal(menuOpened, true, 'Firefox Extensions menu is unavailable');
  await waitFor(async () => execute(`
    const button = document.getElementById(arguments[0])
      || [...document.querySelectorAll('toolbarbutton')].find((item) => item.getAttribute('label')?.startsWith('Local Archive'));
    if (!button) return false;
    button.click();
    return true;
  `, [actionId]), { timeoutMs: 15_000, label: 'browser action button' });
  await waitFor(async () => execute(`
    return Boolean(document.querySelector('browser[webextension-view-type="popup"]'));
  `), { timeoutMs: 10_000, label: 'toolbar popup surface' });
  await delay(800);
  await execute(`
    document.querySelector('browser[webextension-view-type="popup"]')?.closest('panel')?.hidePopup?.();
    return true;
  `);
  const popupWindow = await session('POST', '/window/new', { type: 'tab' });
  assert.ok(popupWindow?.handle, 'Could not create the isolated popup inspection tab');
  assert.notEqual(popupWindow.handle, mainWindow, 'Firefox reused the Telegram tab for popup inspection');
  inspectionWindow = popupWindow.handle;
  await session('POST', '/window', { handle: inspectionWindow });
  await context('content');
  await session('POST', '/url', { url: `${extensionBaseUrl}popup.html?standalone=1` });
  await waitFor(async () => execute(`return Boolean(document.querySelector('#popup'));`), {
    timeoutMs: 10_000, label: 'standalone popup bootstrap',
  });
  telegramTabId = await executeAsync(`
    const done = arguments[arguments.length - 1];
    Promise.all([browser.tabs.query({}), browser.tabs.getCurrent()])
      .then(([tabs, current]) => {
        const candidates = tabs.filter((tab) => tab.id !== current?.id);
        const target = candidates.find((tab) => String(tab.url || '').startsWith('https://web.telegram.org/'))
          || candidates.find((tab) => tab.active)
          || candidates[0];
        done(target?.id || null);
      })
      .catch(() => done(null));
  `);
  assert.ok(Number.isInteger(telegramTabId) && telegramTabId > 0, `Could not resolve Telegram tab id: ${telegramTabId}`);
  await context('chrome');
  chromeTabDebug = await execute(`
    return gBrowser.tabs.map((tab, index) => ({
      index,
      selected: tab.selected,
      url: tab.linkedBrowser?.currentURI?.spec || '',
      browsingContextId: tab.linkedBrowser?.browsingContext?.id || null,
    }));
  `);
  await context('content');
  await session('POST', '/url', { url: `${extensionBaseUrl}popup.html?standalone=1&targetTabId=${telegramTabId}` });
  return waitFor(async () => execute(`
    const popup = document.querySelector('#popup');
    if (!popup || popup.getAttribute('aria-busy') === 'true') return null;
    return popup;
  `), { timeoutMs: 20_000, label: 'loaded popup document' });
}

async function installTelegramWorkerFixtureBootstrap() {
  await context('content');
  const result = await executeAsync(`
    const done = arguments[arguments.length - 1];
    if (globalThis.__localArchiveWorkerFixtureBridge) {
      done({ installed: true, reused: true });
      return;
    }
    const fixture = ${telegramFixtureFunctionSource};
    const injected = new Set();
    const created = [];
    const candidates = new Set();
    const pending = new Set();
    const inject = async (tabId) => {
      if (!Number.isInteger(tabId) || injected.has(tabId) || pending.has(tabId)) return;
      pending.add(tabId);
      try {
        // Model the real Telegram SPA: navigation can be complete while the
        // conversation surface is still hydrating in the inactive helper tab.
        // The background exporter must wait for the connector's readiness
        // contract instead of starting on a bare document.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        let results;
        try {
          results = await browser.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: fixture });
        } catch (_) {
          results = await browser.scripting.executeScript({
            target: { tabId },
            args: [${JSON.stringify(telegramFixtureFunctionSource)}],
            func: (fixtureSource) => {
              window.eval('(' + fixtureSource.toString() + ')();');
              return true;
            },
          });
        }
        if (results?.[0]?.result == null) throw new Error('Telegram fixture bootstrap returned no result');
        injected.add(tabId);
        if (!created.includes(tabId)) created.push(tabId);
      } catch (_) {
        // Firefox can reject the first injection while the document is still
        // being created. The onUpdated listener retries at loading/complete.
      } finally {
        pending.delete(tabId);
      }
    };
    const watch = (tabId) => {
      const onUpdated = (updatedId, changeInfo) => {
        if (updatedId !== tabId || !['loading', 'complete'].includes(changeInfo.status)) return;
        void inject(tabId).then(() => {
          if (injected.has(tabId)) browser.tabs.onUpdated.removeListener(onUpdated);
        });
      };
      browser.tabs.onUpdated.addListener(onUpdated);
      void inject(tabId);
    };
    const onCreated = (tab) => {
      if (tab.id && tab.id !== arguments[0]) candidates.add(tab.id);
    };
    const onUpdated = (tabId, changeInfo, tab) => {
      if (!candidates.has(tabId) || !['loading', 'complete'].includes(changeInfo.status)) return;
      watch(tabId);
    };
    browser.tabs.onCreated.addListener(onCreated);
    browser.tabs.onUpdated.addListener(onUpdated);
    globalThis.__localArchiveWorkerFixtureBridge = { onCreated, onUpdated, injected, created };
    done({ installed: true, reused: false });
  `, [telegramTabId]);
  assert.equal(result?.installed, true, `Could not install background fixture bridge: ${JSON.stringify(result)}`);
  return result;
}

async function popupSnapshot() {
  return execute(`
    const doc = document;
    if (!doc) return null;
    const selected = doc.querySelector('input[name="range"]:checked');
    return {
      title: doc.querySelector('h1')?.textContent || '',
      chat: doc.querySelector('#chat-name')?.textContent || '',
      range: selected?.value || '',
      exportLabel: doc.querySelector('#export-button')?.textContent || '',
      exportDisabled: Boolean(doc.querySelector('#export-button')?.disabled),
      text: doc.body.textContent || '',
      width: doc.querySelector('#popup')?.getBoundingClientRect().width || 0,
      errorDetail: doc.querySelector('#popup')?.dataset.errorDetail || '',
      ready: !doc.querySelector('#export-view')?.hidden,
    };
  `);
}

async function assertLocalizedPopupSurfaces() {
  const expected = {
    en: ['Export conversation', 'Export ZIP'],
    ru: ['Экспорт переписки', 'Экспортировать ZIP'],
    uk: ['Експорт розмови', 'Експортувати ZIP'],
    de: ['Unterhaltung exportieren', 'ZIP exportieren'],
    fr: ['Exporter la conversation', 'Exporter le ZIP'],
    es: ['Exportar conversación', 'Exportar ZIP'],
    'pt-BR': ['Exportar conversa', 'Exportar ZIP'],
    pl: ['Eksportuj rozmowę', 'Eksportuj ZIP'],
  };
  for (const [locale, [title, exportLabel]] of Object.entries(expected)) {
    const surface = await execute(`
      const language = document.querySelector('#language');
      language.value = arguments[0];
      language.dispatchEvent(new Event('change', { bubbles: true }));
      return {
        locale: language.value,
        title: document.querySelector('h1')?.textContent || '',
        exportLabel: document.querySelector('#export-button')?.textContent || '',
      };
    `, [locale]);
    assert.deepEqual(surface, { locale, title, exportLabel });
  }
  await execute(`
    const language = document.querySelector('#language');
    language.value = 'en';
    language.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  return Object.keys(expected);
}

async function configureAndExport({ range, locale = 'en', includeMedia = false }) {
  const configured = await execute(`
    const doc = document;
    if (!doc) return null;
    const language = doc.querySelector('#language');
    language.value = arguments[1];
    language.dispatchEvent(new Event('change', { bubbles: true }));
    const mode = doc.querySelector('input[name="range"][value="' + arguments[0].mode + '"]');
    mode.click();
    if (arguments[0].mode === 'recent') doc.querySelector('#recent-count').value = String(arguments[0].count);
    if (arguments[0].mode === 'dates') {
      doc.querySelector('#date-from').value = arguments[0].from;
      doc.querySelector('#date-to').value = arguments[0].to;
      doc.querySelector('#date-from').dispatchEvent(new Event('input', { bubbles: true }));
      doc.querySelector('#date-to').dispatchEvent(new Event('input', { bubbles: true }));
    }
    doc.querySelector('#include-media').checked = Boolean(arguments[2]);
    doc.querySelector('#include-media').dispatchEvent(new Event('change', { bubbles: true }));
    doc.querySelector('#format').value = 'both';
    return {
      button: doc.querySelector('#export-button'),
      needsPermission: !(doc.querySelector('#visible-count')?.textContent || '').trim(),
    };
  `, [range, locale, includeMedia]);
  const id = elementId(configured?.button);
  assert.ok(id, 'Popup controls were unavailable');
  await session('POST', `/element/${id}/click`, {});
  await acceptTelegramPermissionIfRequested();
}

async function acceptTelegramPermissionIfRequested() {
  await context('chrome');
  const deadline = Date.now() + 8_000;
  let lastPromptState = null;
  while (Date.now() < deadline) {
    const result = await executeAsync(`
      const done = arguments[arguments.length - 1];
      const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
      ExtensionPermissions.get(arguments[0]).then((permissions) => {
        const granted = permissions.origins?.includes('https://web.telegram.org/*') || false;
        if (granted) {
          done({ granted: true, visible: false, origins: permissions.origins });
          return;
        }
        const panel = globalThis.PopupNotifications?.panel || document.getElementById('notification-popup');
        const isOpen = panel?.state === 'open'
          || panel?.getAttribute('panelopen') === 'true'
          || panel?.hasAttribute('open');
        const notification = panel?.querySelector('popupnotification[popupid="addon-webext-permissions"]')
          || document.querySelector('#addon-webext-permissions-notification[popupid="addon-webext-permissions"]');
        const primary = notification?.querySelector('.popup-notification-primary-button');
        if (!isOpen || !notification || notification.hidden || !primary || primary.disabled) {
          done({ visible: false, panelState: panel?.state || '', popupId: notification?.getAttribute('popupid') || '', origins: permissions.origins });
          return;
        }
        primary.click();
        done({ visible: true, origins: permissions.origins });
      }).catch((error) => done({ visible: false, permissionReadError: String(error) }));
    `, [addonId]);
    lastPromptState = result;
    if (result?.granted) return;
    if (result?.visible) {
      await delay(250);
      continue;
    }
    await delay(100);
  }
  const chromeState = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');
    ExtensionPermissions.get(arguments[0]).then((permissions) => {
      const panel = globalThis.PopupNotifications?.panel || document.getElementById('notification-popup');
      const notification = document.querySelector('#addon-webext-permissions-notification');
      done({
        panelState: panel?.state || '',
        panelOpen: panel?.getAttribute('panelopen') || '',
        notificationHidden: notification?.hidden,
        popupId: notification?.getAttribute('popupid') || '',
        buttonLabel: notification?.querySelector('.popup-notification-primary-button')?.label || '',
        origins: permissions.origins,
      });
    }).catch((error) => done({ permissionReadError: String(error) }));
  `, [addonId]);
  if (inspectionWindow) await session('POST', '/window', { handle: inspectionWindow });
  await context('content');
  const popupState = await executeAsync(`
    const done = arguments[arguments.length - 1];
    const page = {
      url: location.href,
      error: document.querySelector('#error')?.textContent || '',
      body: (document.body.textContent || '').slice(0, 1000),
    };
    if (!globalThis.browser?.permissions) {
      done({ permission: null, ...page });
      return;
    }
    browser.permissions.contains({ origins: ['https://web.telegram.org/*'] })
      .then((permission) => done({ permission, ...page }))
      .catch((error) => done({ permission: null, permissionError: String(error), ...page }));
  `);
  throw new Error(`Telegram permission prompt was not accepted: ${JSON.stringify({ lastPromptState, chromeState, popupState })}`);
}

async function waitForQuickResult() {
  await context('content');
  try {
    return await waitFor(async () => {
      const probe = await executeAsync(`
      const done = arguments[arguments.length - 1];
      browser.scripting.executeScript({
        target: { tabId: arguments[0] },
        func: () => {
          const host = document.getElementById('local-archive-progress-root');
          const root = host?.shadowRoot;
          const panel = root?.querySelector('.panel');
          if (!panel || panel.dataset.state === 'working') return null;
          return {
            state: panel.dataset.state,
            status: root.querySelector('.status')?.textContent || '',
            detail: root.querySelector('.detail')?.textContent || '',
            hasLegacyModal: Boolean(document.getElementById('telearchive-extension-root')),
          };
        },
      }).then((results) => done(results[0]?.result || null)).catch((error) => done({ probeError: String(error) }));
      `, [telegramTabId]);
      if (probe?.probeError) throw new Error(probe.probeError);
      return probe;
    }, { timeoutMs: 60_000, label: 'terminal quick export panel' });
  } catch (error) {
    const diagnostics = await executeAsync(`
      const done = arguments[arguments.length - 1];
      Promise.all([
        browser.tabs.query({}),
        browser.storage.session.get(null),
        browser.scripting.executeScript({
          target: { tabId: arguments[0] },
          func: () => ({
            url: location.href,
            panel: (() => {
              const host = document.getElementById('local-archive-progress-root');
              const root = host?.shadowRoot;
              const panel = root?.querySelector('.panel');
              return panel ? {
                state: panel.dataset.state || '',
                status: root.querySelector('.status')?.textContent || '',
                detail: root.querySelector('.detail')?.textContent || '',
                errorCode: panel.dataset.errorCode || '',
              } : null;
            })(),
            exporter: globalThis.TeleArchiveExporter?.inspect?.() || null,
            lazy: globalThis.__localArchiveLazyHistory || null,
            messages: Array.from(document.querySelectorAll('[data-mid]')).map((e) => e.getAttribute('data-mid')),
            scroll: (() => {
              const c = document.querySelector('.bubbles-scrollable');
              return c ? {
                top: c.scrollTop,
                height: c.scrollHeight,
                client: c.clientHeight,
                overflowY: getComputedStyle(c).overflowY,
              } : null;
            })(),
          }),
        }),
      ]).then(([tabs, sessionState, results]) => done({
        page: location.href,
        targetTabId: arguments[0],
        target: results[0]?.result || null,
        tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active })),
        backgroundJobs: Object.entries(sessionState || {}).filter(([key]) => key.startsWith('localArchive.backgroundExport.v1.')).map(([key, value]) => ({ key, value })),
      })).catch((probeError) => done({ probeError: String(probeError) }));
    `, [telegramTabId]);
    throw new Error(`${error.message}: ${JSON.stringify(diagnostics)}`);
  }
}

async function popupRuntimeSnapshot() {
  await context('content');
  return executeAsync(`
    const done = arguments[arguments.length - 1];
    Promise.all([
      browser.permissions.contains({ origins: ['https://web.telegram.org/*'] }),
      browser.permissions.getAll(),
      browser.tabs.get(arguments[0]),
    ]).then(([contains, permissions, tab]) => done({
      contains,
      permissions,
      tab: { id: tab.id, url: tab.url, active: tab.active, status: tab.status },
      popupError: document.querySelector('#error')?.textContent || '',
      popupBusy: document.querySelector('#popup')?.getAttribute('aria-busy') || '',
    })).catch((error) => done({ error: String(error) }));
  `, [telegramTabId]);
}

async function exporterRuntimeSnapshot() {
  await context('content');
  return executeAsync(`
    const done = arguments[arguments.length - 1];
    browser.scripting.executeScript({
      target: { tabId: arguments[0] },
      func: () => {
        const api = globalThis.TeleArchiveExporter;
        return api ? {
          exporterVersion: api.version || null,
          engine: api.engine || null,
          coreVersion: api.coreVersion || null,
        } : null;
      },
    }).then((results) => done(results[0]?.result || null)).catch((error) => done({ error: String(error) }));
  `, [telegramTabId]);
}

async function screenshotTelegram(filename) {
  await context('content');
  const dataUrl = await executeAsync(`
    const done = arguments[arguments.length - 1];
    browser.tabs.get(arguments[0])
      .then((tab) => browser.tabs.update(tab.id, { active: true }).then(() => tab.windowId))
      .then((windowId) => new Promise((resolve) => setTimeout(() => resolve(windowId), 200)))
      .then((windowId) => browser.tabs.captureVisibleTab(windowId, { format: 'png' }))
      .then((value) => done(value))
      .catch((error) => done({ error: String(error) }));
  `, [telegramTabId]);
  assert.match(String(dataUrl), /^data:image\/png;base64,/u, `Could not capture isolated Telegram fixture: ${JSON.stringify(dataUrl)}`);
  const target = path.join(artifactsRoot, filename);
  await writeFile(target, Buffer.from(String(dataUrl).split(',', 2)[1], 'base64'));
  return target;
}

async function readArchive(filePath) {
  const zip = await JSZip.loadAsync(await readFile(filePath));
  const result = JSON.parse(await zip.file('result.json').async('string'));
  const summary = JSON.parse(await zip.file('export-summary.json').async('string'));
  const htmlEntry = zip.file('messages.html') || Object.values(zip.files).find((entry) => entry.name.endsWith('/messages.html'));
  assert.ok(htmlEntry, 'Readable HTML is missing');
  const html = await htmlEntry.async('string');
  return { zip, result, summary, html };
}

try {
  await waitFor(async () => {
    const response = await fetch(`${driverUrl}/status`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  }, { timeoutMs: 15_000, label: 'geckodriver readiness' });

  const created = await webdriver('POST', '/session', {
    capabilities: { alwaysMatch: {
      browserName: 'firefox',
      'moz:firefoxOptions': {
        binary: firefoxBinary,
        args: ['-headless'],
      prefs: {
          ...firefoxProxyPreferences(),
          'browser.download.alwaysOpenPanel': false,
          'browser.download.dir': downloadsRoot,
          'browser.download.folderList': 2,
          'browser.download.useDownloadDir': true,
          'browser.helperApps.neverAsk.saveToDisk': 'application/octet-stream,application/zip',
          'intl.accept_languages': 'en-US,en',
        },
      },
    } },
  }, 120_000);
  sessionId = created.sessionId;
  await session('POST', '/window/rect', { width: 1100, height: 760 });
  [mainWindow] = await session('GET', '/window/handles');
  assert.ok(mainWindow, 'Firefox did not expose its main tab');
  assert.equal(await session('POST', '/moz/addon/install', { path: extensionArchive, temporary: true }), addonId);

  await context('chrome');
  extensionBaseUrl = await execute(`
    const policy = WebExtensionPolicy.getByID(arguments[0]);
    return policy ? policy.getURL('') : null;
  `, [addonId]);
  assert.match(extensionBaseUrl || '', /^moz-extension:\/\//u);

  await context('content');
  await session('POST', '/url', { url: 'https://web.telegram.org/k/' }, 120_000);
  await execute(`(${telegramFixtureFunctionSource})();`);

  const popupBrowser = await openActionPopup();
  await installTelegramWorkerFixtureBootstrap();
  const verifiedLocales = await assertLocalizedPopupSurfaces();
  const initialPopup = await popupSnapshot();
  const tabDebug = await executeAsync(`
    const done = arguments[arguments.length - 1];
    browser.tabs.query({}).then((tabs) => done({
      target: new URLSearchParams(location.search).get('targetTabId'),
      tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, active: tab.active, windowId: tab.windowId })),
    })).catch((error) => done({ error: String(error) }));
  `);
  assert.equal(initialPopup.ready, true, JSON.stringify({ initialPopup, tabDebug, telegramTabId }));
  assert.ok(
    initialPopup.chat === 'Release Chat' || initialPopup.chat === 'Current conversation',
    `Unexpected pre-permission conversation label: ${initialPopup.chat}`,
  );
  assert.equal(initialPopup.range, 'recent');
  assert.equal(initialPopup.width, 390);
  assert.doesNotMatch(initialPopup.text, /PeaZip|7-Zip|unzip|extract the archive/iu);
  await screenshotElement(popupBrowser, '01-popup-en.png');

  const beforeRecent = await filesInDownloads();
  await configureAndExport({ range: { mode: 'recent', count: 2 }, locale: 'ru' });
  await screenshotTelegram('05-background-progress-ru.png');
  const permissionSnapshot = await popupRuntimeSnapshot();
  assert.match(
    permissionSnapshot.tab?.url || '',
    /^https:\/\/web\.telegram\.org\//u,
    JSON.stringify({ permissionSnapshot, chromeTabDebug }),
  );
  const recentResult = await waitForQuickResult();
  assert.equal(recentResult.state, 'complete', JSON.stringify({ recentResult, tabDebug, telegramTabId, permissionSnapshot }));
  assert.equal(recentResult.hasLegacyModal, false);
  assert.match(recentResult.status, /сохранён/iu);
  const runtimeIdentity = await exporterRuntimeSnapshot();
  assert.deepEqual(runtimeIdentity, {
    exporterVersion: '5.0.0',
    engine: 'rust-wasm',
    coreVersion: packageJson.version,
  });
  await screenshotTelegram('02-result-ru.png');
  const recentArchivePath = await waitForNewArchive(beforeRecent);
  const recentArchive = await readArchive(recentArchivePath);
  assert.deepEqual(recentArchive.result.messages.map((message) => message.id), [4, 5]);
  assert.deepEqual(recentArchive.result.telearchive.requested_range, { mode: 'recent', count: 2 });
  assert.equal(recentArchive.result.telearchive.history_source, 'telegram-web-api');
  assert.equal(recentArchive.result.telearchive.history_complete, true);
  assert.equal(recentArchive.result.telearchive.history_load?.scrollAttempts, 0);
  assert.equal(recentArchive.result.telearchive.history_load?.transport, 'page-manager');
  assert.ok(Number(recentArchive.result.telearchive.history_load?.nativeBatches) >= 1);

  const popupBrowserRu = await openActionPopup();
  const russianPopup = await popupSnapshot();
  assert.match(russianPopup.title, /Экспорт переписки/u);
  await execute(`
    const mode = document.querySelector('input[name="range"][value="dates"]');
    mode.click();
    document.querySelector('#date-from').value = '2026-08-02';
    document.querySelector('#date-to').value = '2026-08-03';
    document.querySelector('#date-from').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#date-to').dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await screenshotElement(popupBrowserRu, '03-popup-ru.png');
  const beforeDates = await filesInDownloads();
  await configureAndExport({ range: { mode: 'dates', from: '2026-08-02', to: '2026-08-03' }, locale: 'ru' });
  const dateResult = await waitForQuickResult();
  if (dateResult.state !== 'complete') {
    const permissionDebug = await popupRuntimeSnapshot();
    const historyDebug = await execute(`
      const c = document.querySelector('.bubbles-scrollable');
      return {
        lazy: window.__localArchiveLazyHistory || null,
        scrollTop: c?.scrollTop ?? null,
        scrollHeight: c?.scrollHeight ?? null,
        clientHeight: c?.clientHeight ?? null,
        messages: Array.from(document.querySelectorAll('[data-mid]')).map((e) => e.getAttribute('data-mid')),
      };
    `);
    throw new Error(`Date export failed: ${JSON.stringify({ dateResult, permissionDebug, historyDebug })}`);
  }
  const dateArchivePath = await waitForNewArchive(beforeDates);
  const dateArchive = await readArchive(dateArchivePath);
  assert.deepEqual(dateArchive.result.messages.map((message) => message.id), [2, 3]);
  assert.deepEqual(dateArchive.result.telearchive.requested_range, {
    mode: 'dates', from: '2026-08-02', to: '2026-08-03',
  });
  assert.equal(dateArchive.result.telearchive.history_source, 'telegram-web-api');
  assert.equal(dateArchive.result.telearchive.history_load?.scrollAttempts, 0);
  assert.equal(dateArchive.result.telearchive.history_load?.transport, 'page-manager');
  assert.match(dateArchive.html, /Visible spoiler text/u);
  assert.doesNotMatch(dateArchive.html, /spoiler hidden|data-tgx-action="spoiler"/u);

  const popupBrowserAll = await openActionPopup();
  const popupWindowAll = inspectionWindow;
  const allPopup = await popupSnapshot();
  assert.equal(allPopup.range, 'recent');
  await execute(`
    const language = document.querySelector('#language');
    if (language) {
      language.value = 'en';
      language.dispatchEvent(new Event('change', { bubbles: true }));
    }
    document.querySelector('input[name="range"][value="all"]')?.click();
    return document.querySelector('input[name="range"]:checked')?.value || null;
  `);
  await screenshotElement(popupBrowserAll, '04-popup-all-en.png');
  const beforeAll = await filesInDownloads();
  await executeAsync(`
    const done = arguments[arguments.length - 1];
    browser.scripting.executeScript({
      target: { tabId: arguments[0] },
      func: () => { window.__localArchiveHistoryDelayMs = 1800; return true; },
    }).then((results) => done(results[0]?.result || false)).catch((error) => done({ error: String(error) }));
  `, [telegramTabId]);
  await configureAndExport({ range: { mode: 'all' }, locale: 'en', includeMedia: true });
  await context('content');
  await waitFor(async () => execute(`
    return browser.storage.session.get(null).then((state) => Object.values(state).some((job) => job && job.terminal === false));
  `), { timeoutMs: 15_000, label: 'active background job before source reload' });
  await session('POST', '/url', { url: `${extensionBaseUrl}popup.html?standalone=1&targetTabId=${telegramTabId}` });
  const busyPopup = await waitFor(async () => {
    const snapshot = await popupSnapshot();
    return snapshot?.ready ? snapshot : null;
  }, { timeoutMs: 20_000, label: 'busy popup during active background export' });
  assert.equal(busyPopup.exportDisabled, true, JSON.stringify({ busyPopup }));
  assert.match(busyPopup.text, /already running|уже ид[её]т|триває|bereits|déjà|ya hay|já existe|trwa/u);
  await executeAsync(`
    const done = arguments[arguments.length - 1];
    browser.tabs.reload(arguments[0]).then(() => done(true)).catch((error) => done({ error: String(error) }));
  `, [telegramTabId]);
  await delay(450);
  await session('POST', '/window', { handle: mainWindow });
  await context('content');
  await execute(`(${telegramFixtureFunctionSource})();`);
  await session('POST', '/window', { handle: popupWindowAll });
  await context('content');
  const recoveredPopup = await openActionPopup();
  const recoveredPanel = await waitFor(async () => executeAsync(`
    const done = arguments[arguments.length - 1];
    browser.scripting.executeScript({
      target: { tabId: arguments[0] },
      func: () => {
        const host = document.getElementById('local-archive-progress-root');
        const root = host?.shadowRoot;
        const panel = root?.querySelector('.panel');
        return panel ? {
          state: panel.dataset.state || '',
          status: root.querySelector('.status')?.textContent || '',
          meta: root.querySelector('.meta')?.textContent || '',
        } : null;
      },
    }).then((results) => done(results[0]?.result || null)).catch((error) => done({ error: String(error) }));
  `, [telegramTabId]), { timeoutMs: 15_000, label: 'background progress restored after source reload' });
  assert.ok(recoveredPanel && !recoveredPanel.error, JSON.stringify({ recoveredPanel }));
  assert.match(`${recoveredPanel.status} ${recoveredPanel.meta}`, /(?:Читаю|Reading|сохран|saved|Прошло|Elapsed)/iu);
  const allResult = await waitForQuickResult();
  assert.equal(allResult.state, 'complete', JSON.stringify({ allResult, telegramTabId }));
  assert.equal(allResult.hasLegacyModal, false);
  const allArchivePath = await waitForNewArchive(beforeAll);
  const allArchive = await readArchive(allArchivePath);
  assert.deepEqual(allArchive.result.messages.map((message) => message.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(allArchive.result.telearchive.requested_range, { mode: 'all' });
  assert.ok(allArchive.result.telearchive.history_load?.attempted);
  assert.equal(allArchive.result.telearchive.history_source, 'telegram-web-api');
  assert.equal(allArchive.result.telearchive.history_complete, true);
  assert.equal(allArchive.result.telearchive.history_load?.scrollAttempts, 0);
  assert.equal(allArchive.result.telearchive.history_load?.transport, 'page-manager');
  assert.equal(allArchive.result.telearchive.history_load?.edgeReached, false);
  assert.equal(allArchive.result.telearchive.history_load?.stoppedReason, 'count-reached');
  assert.ok(Number(allArchive.result.telearchive.history_load?.messagesCollected) >= 5);
  assert.equal(allArchive.result.telearchive.media?.included, 1, JSON.stringify({
    media: allArchive.result.telearchive.media,
    message3: allArchive.result.messages.find((message) => message.id === 3),
    files: Object.keys(allArchive.zip.files).filter((name) => /media|files/u.test(name)),
  }));
  const nativeMediaEntries = allArchive.zip.file(/files\/.*native-note\.txt/u);
  assert.equal(nativeMediaEntries.length, 1, 'Native Telegram media is missing from the ZIP');
  assert.equal(await nativeMediaEntries[0].async('string'), 'native media');

  const backgroundTrace = await executeAsync(`
    const done = arguments[arguments.length - 1];
    Promise.all([
      browser.tabs.query({}),
      browser.scripting.executeScript({
        target: { tabId: arguments[0] },
        func: () => ({ workerTabId: globalThis.__LOCAL_ARCHIVE_BACKGROUND_WORKER_TAB_ID__ || null }),
      }),
    ]).then(([tabs, results]) => done({
      workerTabId: results[0]?.result?.workerTabId || null,
      workerTabStillOpen: tabs.some((tab) => tab.id === results[0]?.result?.workerTabId),
    })).catch((error) => done({ error: String(error) }));
  `, [telegramTabId]);
  assert.ok(Number.isInteger(backgroundTrace.workerTabId) && backgroundTrace.workerTabId > 0, JSON.stringify({ backgroundTrace }));
  assert.equal(backgroundTrace.workerTabStillOpen, false, JSON.stringify({ backgroundTrace }));

  const evidence = {
    status: 'passed',
    firefox: created.capabilities?.browserVersion || null,
    extensionVersion: packageJson.version,
    package: { file: packageDescriptor.file, sha256: packageDescriptor.sha256 },
    runtime: runtimeIdentity,
    locales: verifiedLocales,
    popup: initialPopup,
    recent: { messageIds: recentArchive.result.messages.map((message) => message.id), archive: path.basename(recentArchivePath) },
    dates: { messageIds: dateArchive.result.messages.map((message) => message.id), archive: path.basename(dateArchivePath) },
    all: {
      messageIds: allArchive.result.messages.map((message) => message.id),
      archive: path.basename(allArchivePath),
      historyLoad: allArchive.result.telearchive.history_load,
      mediaIncluded: allArchive.result.telearchive.media?.included || 0,
    },
    recovery: {
      sourceReloaded: true,
      restoredPanel: recoveredPanel,
    },
    background: backgroundTrace,
    screenshots: ['01-popup-en.png', '02-result-ru.png', '03-popup-ru.png', '04-popup-all-en.png', '05-background-progress-ru.png'],
  };
  await writeFile(path.join(artifactsRoot, 'consumer-proof.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`LOCAL_ARCHIVE_FIREFOX_V3_E2E_OK ${JSON.stringify(evidence)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n${driverLog.join('').slice(-10_000)}\n`);
  process.exitCode = 1;
} finally {
  if (sessionId) {
    try { await webdriver('DELETE', `/session/${sessionId}`); } catch {}
  }
  driver.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => driver.once('exit', resolve)), delay(3_000)]);
  if (driver.exitCode === null) driver.kill('SIGKILL');
  await rm(workRoot, { recursive: true, force: true });
}
