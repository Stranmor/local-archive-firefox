import JSZipLibrary from 'jszip';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { browser } from 'wxt/browser';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeleArchiveRemoteZip } from '@/src/shared/archive-client';
import { createArchiveFromRequest, verifyArchiveFromRequest } from '@/src/shared/archive-service';
import {
  filterMessagesForRangeInRust,
  normalizeExportRangeInRust,
  normalizePreferencesInRust,
  normalizeQuickExportRequestInRust,
  RustExportSession,
  rustCoreVersion,
  validateArchivePasswordInRust,
} from '@/src/rust/core';

interface TestApi {
  closeDialog: () => void;
  inspectQuickExportContext: () => { busy: boolean };
  getActiveChatInfo: () => { name: string; peerId: string } | null;
  getChatList: () => Array<{ name: string; peerId: string }>;
  getMessageElements: () => NodeListOf<Element> | Element[];
  findScrollContainer: () => HTMLElement | null;
  scrollAllMessages: () => Promise<void>;
  normalizeMediaUrl: (value: string) => string;
  normalizeExportRange: (value: unknown) =>
    | { mode: 'all' }
    | { mode: 'recent'; count: number }
    | { mode: 'dates'; from: string; to: string };
  filterMessagesForRange: (
    messages: Array<{ id: number; date: string; date_unixtime: string }>,
    range: unknown,
  ) => Array<{ id: number; date: string; date_unixtime: string }>;
  parseMessageId: (value: string) => number | null;
  safeHref: (value: string) => string;
  sanitizeFilename: (value: string, fallback?: string) => string;
  showModernExportDialog: () => Promise<void>;
  state: {
    dialog: HTMLElement | null;
    dialogRoot: ShadowRoot | null;
    isExporting: boolean;
    backgroundJobId: string;
    backgroundRemote: boolean;
    lastOutcome: string | null;
    lastExportStats: {
      partial: boolean;
      chatsIncluded: number;
      messagesIncluded: number;
      media: { included: number; skipped: number; pending: number };
    } | null;
  };
}

declare global {
  // Test-only hooks exposed by the legacy-compatible exporter.
  var __TELEARCHIVE_CONFIG__: Record<string, unknown> | undefined;
  var __TELEARCHIVE_TEST__: boolean | undefined;
  var __TELEARCHIVE_TEST_API__: TestApi | undefined;
  var JSZip: typeof JSZipLibrary | undefined;
  var __LOCAL_ARCHIVE_RUST_CORE__: {
    version: string;
    normalizeExportRange: typeof normalizeExportRangeInRust;
    normalizePreferences: typeof normalizePreferencesInRust;
    normalizeQuickExportRequest: typeof normalizeQuickExportRequestInRust;
    filterMessagesForRange: typeof filterMessagesForRangeInRust;
    createExportSession: (request: unknown) => RustExportSession;
    validateArchivePassword: (value: string) => void;
  } | undefined;
}

function telegramFixture(): void {
  document.body.innerHTML = `
    <aside id="column-left">
      <a class="chatlist-chat active" data-peer-id="123" href="#123">
        <span class="user-title"><span class="peer-title">Alice Archive</span></span>
      </a>
    </aside>
    <main>
      <header><span data-scope="peer-title">Alice Archive</span></header>
      <div data-scope="bubbles">
        <article data-mid="message-42" data-peer-id="123">
          <span class="peer-title">Alice</span>
          <time datetime="2026-08-10T08:00:00.000Z">11:00</time>
          <div data-scope="text">A durable hello</div>
        </article>
      </div>
      <div class="input-message-input" data-peer-id="123"></div>
    </main>
  `;
}

function telegramLargeFixture(messageCount: number): void {
  const baseTime = Date.parse('2026-08-10T08:00:00.000Z');
  const messages = Array.from({ length: messageCount }, (_, index) => {
    const timestamp = new Date(baseTime + index * 1000).toISOString();
    return `
      <article data-mid="message-${index + 1}" data-peer-id="987">
        <span class="peer-title">Load Test</span>
        <time datetime="${timestamp}">${index + 1}</time>
        <div data-scope="text">Stress message ${index + 1}</div>
      </article>`;
  }).join('');
  document.body.innerHTML = `
    <aside id="column-left">
      <a class="chatlist-chat active" data-peer-id="987" href="#987">
        <span class="user-title"><span class="peer-title">1,000 Message Contract</span></span>
      </a>
    </aside>
    <main>
      <header><span data-scope="peer-title">1,000 Message Contract</span></header>
      <div data-scope="bubbles">${messages}</div>
      <div class="input-message-input" data-peer-id="987"></div>
    </main>`;
}

function telegramBatchFixture(): void {
  const chats = [701, 702, 703];
  document.body.innerHTML = `
    <aside id="column-left">
      ${chats.map((peerId, index) => `
        <a class="chatlist-chat${index === 0 ? ' active' : ''}" data-peer-id="${peerId}" href="#${peerId}">
          <span class="user-title"><span class="peer-title">Batch Chat ${index + 1}</span></span>
        </a>`).join('')}
    </aside>
    <main></main>`;
  const render = (peerId: number): void => {
    const index = chats.indexOf(peerId);
    document.querySelectorAll<HTMLAnchorElement>('#column-left .chatlist-chat').forEach((link) => {
      link.classList.toggle('active', link.dataset.peerId === String(peerId));
    });
    const main = document.querySelector('main');
    if (!main || index < 0) return;
    main.innerHTML = `
      <header><span data-scope="peer-title">Batch Chat ${index + 1}</span></header>
      <div data-scope="bubbles">
        <article data-mid="message-${peerId}" data-peer-id="${peerId}">
          <span class="peer-title">Batch Sender ${index + 1}</span>
          <time datetime="2026-08-10T08:0${index}:00.000Z">11:0${index}</time>
          <div data-scope="text">Batch message ${index + 1}</div>
        </article>
      </div>
      <div class="input-message-input" data-peer-id="${peerId}"></div>`;
  };
  document.querySelectorAll<HTMLAnchorElement>('#column-left .chatlist-chat').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      render(Number(link.dataset.peerId));
    });
  });
  render(chats[0]!);
}

function api(): TestApi {
  if (!globalThis.__TELEARCHIVE_TEST_API__) throw new Error('Exporter test API was not initialized');
  return globalThis.__TELEARCHIVE_TEST_API__;
}

function startUnencryptedExport(root: ShadowRoot): void {
  const historyReady = root.querySelector('#tgx-history-ready') as HTMLInputElement;
  expect(historyReady.checked).toBe(true);
  const protection = root.querySelector('#tgx-encrypt') as HTMLInputElement;
  expect(protection.checked).toBe(false);
  const button = root.querySelector('#tgx-export') as HTMLButtonElement;
  expect(button.textContent).toContain('Save conversation');
  button.click();
}

beforeAll(async () => {
  globalThis.__TELEARCHIVE_TEST__ = true;
  globalThis.__TELEARCHIVE_CONFIG__ = {
    scrollWaitMs: 0,
    historyEdgeWaitMs: 30,
    historyEdgeStaleThreshold: 2,
    staleThreshold: 1,
    mediaFetchTimeoutMs: 250,
    maxChats: 2,
  };
  // Exercise the exact production archive constructor; JSZip is used only
  // below as an independent reader of the resulting consumer artifact.
  globalThis.JSZip = TeleArchiveRemoteZip as unknown as typeof JSZipLibrary;
  globalThis.__LOCAL_ARCHIVE_RUST_CORE__ = Object.freeze({
    version: rustCoreVersion(),
    normalizeExportRange: normalizeExportRangeInRust,
    normalizePreferences: normalizePreferencesInRust,
    normalizeQuickExportRequest: normalizeQuickExportRequestInRust,
    filterMessagesForRange: filterMessagesForRangeInRust,
    createExportSession: (request: unknown) => new RustExportSession(request),
    validateArchivePassword: validateArchivePasswordInRust,
  });
  const exporterSource = await readFile(path.join(process.cwd(), 'telegram-chat-exporter-hardened.user.js'), 'utf8');
  // The userscript is a self-contained IIFE. Executing its exact bytes avoids
  // making Vitest transform the 370+ KiB legacy-compatible bundle as a module.
  Function(exporterSource)();
});

beforeEach(() => {
  telegramFixture();
  globalThis.JSZip = TeleArchiveRemoteZip as unknown as typeof JSZipLibrary;
  let downloadId = 100;
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (message) => {
    const request = message as unknown as Record<string, unknown>;
    if (request?.type === 'telearchive.archive.create.v1') {
      return createArchiveFromRequest(message);
    }
    if (request?.type === 'telearchive.archive.verify.v1') {
      return verifyArchiveFromRequest(message);
    }
    if (request?.type === 'telearchive.archive.save.v1') {
      URL.createObjectURL(request.blob as Blob);
      downloadId += 1;
      return {
        ok: true,
        requestId: String(request.requestId),
        artifactId: String(request.artifactId),
        downloadId,
        filename: String(request.filename),
        size: (request.blob as Blob).size,
      };
    }
    if (request?.type === 'telearchive.ui.download-status.v1') {
      return {
        ok: true,
        requestId: String(request.requestId),
        artifactId: String(request.artifactId),
        downloadId: Number(request.downloadId),
        found: true,
        state: 'complete',
        filename: String(request.filename),
        size: Number(request.size),
        bytesReceived: Number(request.size),
        totalBytes: Number(request.size),
      };
    }
    return { ok: true, requestId: String(request.requestId || '') };
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

afterEach(() => {
  api().closeDialog();
});

describe('legacy-derived export core', () => {
  it('reports a remote Telegram export as busy to prevent duplicate starts', () => {
    const state = api().state;
    state.backgroundJobId = 'job-active';
    state.backgroundRemote = true;
    expect(api().inspectQuickExportContext().busy).toBe(true);
    state.backgroundJobId = '';
    state.backgroundRemote = false;
  });

  it('keeps dangerous links and filenames out of exported paths', () => {
    expect(api().sanitizeFilename('../report:final?.zip')).toBe('_report_final_.zip');
    expect(api().safeHref('javascript:alert(1)')).toBe('#');
    expect(api().safeHref('https://example.com/path')).toBe('https://example.com/path');
    expect(api().normalizeMediaUrl('http://example.com/file.jpg')).toBe('');
    expect(api().parseMessageId('peer-100-message-42')).toBe(42);
  });

  it('applies recent and inclusive date ranges to the exported messages', () => {
    const messages = [
      { id: 1, date: '2026-08-01T08:00:00.000Z', date_unixtime: '1785571200' },
      { id: 2, date: '2026-08-02T08:00:00.000Z', date_unixtime: '1785657600' },
      { id: 3, date: '2026-08-03T08:00:00.000Z', date_unixtime: '1785744000' },
      { id: 4, date: '2026-08-04T08:00:00.000Z', date_unixtime: '1785830400' },
    ];

    expect(api().filterMessagesForRange(messages, { mode: 'recent', count: 2 }).map(({ id }) => id)).toEqual([3, 4]);
    expect(api().filterMessagesForRange(messages, {
      mode: 'dates', from: '2026-08-02', to: '2026-08-03',
    }).map(({ id }) => id)).toEqual([2, 3]);
    expect(api().filterMessagesForRange(messages, { mode: 'all' }).map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(() => api().normalizeExportRange({
      mode: 'dates', from: '2026-08-04', to: '2026-08-03',
    })).toThrow('The start date must not be later than the end date.');
  });

  it('recognizes maintained Telegram Web selector variations', () => {
    document.body.innerHTML = `
      <aside class="chat-list">
        <div class="ListItem active" data-peer-id="456"><span class="chat-name">Layout Fallback</span></div>
      </aside>
      <main>
        <h1>Layout Fallback</h1>
        <div data-scope="bubbles">
          <div data-message-id="message-77" data-peer-id="456"><div data-scope="text">Fallback message</div></div>
        </div>
        <div class="input-message-input" data-peer-id="456"></div>
      </main>`;

    expect(Array.from(api().getMessageElements())).toHaveLength(1);
    expect(api().getChatList().map(({ name, peerId }) => ({ name, peerId }))).toEqual([
      { name: 'Layout Fallback', peerId: '456' },
    ]);
    expect(api().getActiveChatInfo()).toMatchObject({ name: 'Layout Fallback', peerId: '456' });
  });

  it('accepts id-backed Web A, scoped-bubble, and list-item message containers', () => {
    const variants = [
      '<article class="im_message_wrap" id="message201"><time datetime="2026-08-10T08:00:00.000Z"></time><div class="message-text">Web A</div></article>',
      '<article data-scope="bubble" id="message202"><time datetime="2026-08-10T08:00:00.000Z"></time><div data-scope="text">Scoped bubble</div></article>',
      '<article class="message-list-item" id="message203"><time datetime="2026-08-10T08:00:00.000Z"></time><div class="message-text">List item</div></article>',
    ];
    for (const markup of variants) {
      document.body.innerHTML = `<div data-scope="bubbles">${markup}</div>`;
      expect(Array.from(api().getMessageElements())).toHaveLength(1);
    }
  });

  it('opens an isolated, keyboard-focusable dialog', async () => {
    await api().showModernExportDialog();

    const host = document.getElementById('telearchive-extension-root');
    const root = host?.shadowRoot;
    expect(host).toBeTruthy();
    expect(root?.querySelector('[role="dialog"]')).toBeTruthy();
    expect(root?.querySelector('#tgx-title')?.textContent).toContain('Local Archive');
    expect(root?.querySelector('#tgx-export')).toBeTruthy();
    expect(root?.querySelector('#tgx-quick-source-name')?.textContent).toBe('Telegram');
    expect(root?.querySelector('#tgx-quick-chat-name')?.textContent).toBe('Alice Archive');
    expect(root?.querySelector('#tgx-quick-history')?.textContent).toContain('1 message is loaded now');
    expect(root?.querySelector('#tgx-quick-content')?.textContent).toContain('Readable page');
    expect(root?.querySelector('#tgx-quick-media')?.textContent).toMatch(/Photos.*Voice messages.*Stickers/);
    expect(root?.querySelector('#tgx-quick-protection')?.textContent).toBe('ZIP without password');
    expect(root?.querySelector('#tgx-quick-status')?.getAttribute('data-state')).toBe('ready');
    expect(root?.querySelector('#tgx-quick-status')?.textContent).toContain('Ready to save');
    expect(root?.querySelector('#tgx-quick-status')?.textContent).toContain('Telegram source');
    expect((root?.querySelector('#tgx-history-ready') as HTMLInputElement).checked).toBe(true);
    expect((root?.querySelector('#tgx-encrypt') as HTMLInputElement).checked).toBe(false);
    expect(root?.querySelector('#tgx-protection-aes')?.getAttribute('aria-pressed')).toBe('false');
    expect(root?.querySelector('#tgx-protection-none')?.textContent).toContain('Easiest to open: unencrypted ZIP');
    expect(root?.querySelector('#tgx-protection-none')?.getAttribute('aria-pressed')).toBe('true');
    expect((root?.querySelector('#tgx-password-panel') as HTMLElement).hidden).toBe(true);
    expect(root?.querySelector('#tgx-export')?.textContent).toContain('Save conversation');
    expect((root?.querySelector('#tgx-customize') as HTMLDetailsElement).open).toBe(false);
    expect(root?.querySelector('#tgx-customize-toggle')?.getAttribute('aria-expanded')).toBe('false');
    (root?.querySelector('#tgx-customize-toggle') as HTMLButtonElement).click();
    expect((root?.querySelector('#tgx-customize') as HTMLDetailsElement).open).toBe(true);
    expect(root?.querySelector('#tgx-customize-toggle')?.getAttribute('aria-expanded')).toBe('true');
    expect((root?.querySelector('#tgx-coverage-settings') as HTMLDetailsElement).open).toBe(false);
    expect((root?.querySelector('#tgx-more-media') as HTMLDetailsElement).open).toBe(false);
    const peaZipLink = root?.querySelector('#tgx-preparation-peazip') as HTMLAnchorElement;
    const sevenZipLink = root?.querySelector('#tgx-preparation-7zip') as HTMLAnchorElement;
    expect(peaZipLink.href).toBe('https://peazip.github.io/');
    expect(sevenZipLink.href).toBe('https://www.7-zip.org/');
    expect(peaZipLink.textContent).toContain('Official source');
    expect(peaZipLink.target).toBe('_blank');
    expect(peaZipLink.rel).toContain('noopener');
    expect(root?.querySelector('#tgx-live-check')?.getAttribute('data-state')).toBe('passed');
    expect(root?.querySelector('#tgx-live-check')?.textContent).toContain('1/1 readable messages');
    expect(root?.querySelector('#tgx-live-check-text')?.textContent).not.toContain('[data-mid]');
    expect(root?.querySelector('#tgx-live-check-technical')?.textContent).toContain('[data-mid]');
  });

  it('blocks an empty or unsupported current-chat surface with an actionable diagnostic', async () => {
    document.body.innerHTML = `
      <main>
        <h1>Changed Telegram Layout</h1>
        <div class="input-message-input" data-peer-id="999"></div>
        <div class="future-layout-without-supported-bubbles"></div>
      </main>`;
    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    const diagnostic = root.querySelector('#tgx-compatibility-diagnostic') as HTMLElement;
    expect(diagnostic.hidden).toBe(false);
    expect(diagnostic.textContent).toContain('No readable messages were detected');
    expect(diagnostic.textContent).toContain('layout may have changed');
    expect((root.querySelector('#tgx-compatibility-refresh') as HTMLButtonElement).hidden).toBe(false);
    expect(root.querySelector('#tgx-compatibility-refresh')?.textContent).toContain('Check again');
    expect(root.querySelector('#tgx-live-check')?.getAttribute('data-state')).toBe('error');
    expect(root.querySelector('#tgx-live-check')?.textContent).toContain('wait for messages to appear');
    expect(root.querySelector('#tgx-live-check-technical')?.textContent).toContain('Recognition detail');
    expect(root.querySelector('#tgx-export-boundary')?.getAttribute('data-compatibility')).toBe('error');
    expect(root.querySelector('#tgx-boundary-compact')?.textContent).toContain('Not ready · open a chat and check again');

    const exportButton = root.querySelector('#tgx-export') as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(exportButton.textContent).toContain('Open a readable conversation first');
    expect(root.querySelector('#tgx-quick-status')?.getAttribute('data-state')).toBe('error');
    expect(root.querySelector('#tgx-quick-status')?.textContent).toContain('Wait for messages to load');
    expect((root.querySelector('#tgx-quick-recheck') as HTMLButtonElement).hidden).toBe(false);
  });

  it('fails closed when Telegram renders message-like content without readable message ids', async () => {
    document.body.innerHTML = `
      <main>
        <h1>Future Telegram Layout</h1>
        <div class="input-message-input" data-peer-id="999"></div>
        <article class="message-row">
          <time datetime="2026-08-11T08:00:00.000Z">11:00</time>
          <div class="message-text">Visible but structurally unknown</div>
        </article>
      </main>`;
    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    expect(root.querySelector('#tgx-live-check')?.getAttribute('data-state')).toBe('error');
    expect(root.querySelector('#tgx-live-check')?.textContent).toContain('could not be read safely');
    expect(root.querySelector('#tgx-compatibility-diagnostic')?.textContent).toContain('IDs or content cannot be read safely');

    const exportButton = root.querySelector('#tgx-export') as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);
    expect(root.querySelector('#tgx-quick-status')?.textContent).toContain('not supported by the current connector');
  });

  it('lets the user load older Telegram history without losing the configured dialog', async () => {
    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    const modal = root.querySelector('.tgx-modal') as HTMLElement;
    const coach = root.querySelector('#tgx-history-coach') as HTMLElement;
    const backdrop = root.querySelector('[data-tgx-dismiss]') as HTMLElement;
    (root.querySelector('#tgx-load-history') as HTMLButtonElement).click();
    expect(modal.hidden).toBe(true);
    expect(coach.hidden).toBe(false);
    expect(backdrop.dataset.historyMode).toBe('true');

    document.querySelector('[data-scope="bubbles"]')?.insertAdjacentHTML('afterbegin', `
      <article data-mid="message-41" data-peer-id="123">
        <span class="peer-title">Alice</span>
        <time datetime="2026-08-09T08:00:00.000Z">11:00</time>
        <div data-scope="text">An older durable hello</div>
      </article>`);
    (root.querySelector('#tgx-history-return') as HTMLButtonElement).click();

    expect(modal.hidden).toBe(false);
    expect(coach.hidden).toBe(true);
    expect(backdrop.dataset.historyMode).toBeUndefined();
    expect(root.querySelector('#tgx-loaded-count')?.textContent).toContain('2 messages');
    expect(root.querySelector('#tgx-oldest-loaded')?.getAttribute('data-timestamp')).toBe('2026-08-09T08:00:00.000Z');
    expect((root.querySelector('#tgx-history-ready') as HTMLInputElement).checked).toBe(true);
    expect(root.querySelector('#tgx-quick-history')?.textContent).toContain('2 messages are loaded now');
  });

  it('keeps probing a clamped Telegram edge until an asynchronous older page arrives', async () => {
    document.body.innerHTML = `
      <main>
        <header><span data-scope="peer-title">Lazy history</span></header>
        <div class="bubbles-scrollable">
          <div class="bubbles-inner">
            <article data-mid="message-3" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-03T08:00:00.000Z"></time><div data-scope="text">Three</div></article>
            <article data-mid="message-4" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-04T08:00:00.000Z"></time><div data-scope="text">Four</div></article>
          </div>
        </div>
        <div class="input-message-input" data-peer-id="123"></div>
      </main>`;
    const container = document.querySelector('.bubbles-scrollable') as HTMLElement;
    let scrollTop = 300;
    Object.defineProperties(container, {
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Number(value) || 0; } },
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 200 },
    });
    let olderPageLoaded = false;
    container.addEventListener('scroll', () => {
      if (scrollTop <= 0 && !olderPageLoaded) {
        olderPageLoaded = true;
        setTimeout(() => {
          container.querySelector('.bubbles-inner')?.insertAdjacentHTML('afterbegin', `
            <article data-mid="message-1" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-01T08:00:00.000Z"></time><div data-scope="text">One</div></article>
            <article data-mid="message-2" data-peer-id="123"><span class="peer-title">Alice</span><time datetime="2026-08-02T08:00:00.000Z"></time><div data-scope="text">Two</div></article>`);
        }, 10);
      }
    });
    const state = api().state as TestApi['state'] & { messages?: Map<number, unknown>; scrollContainer?: HTMLElement; exportStats?: { historyLoad?: { edgeReached?: boolean; messagesCollected?: number } } };
    state.messages?.clear();
    state.scrollContainer = api().findScrollContainer() || undefined;
    await api().scrollAllMessages();
    expect(olderPageLoaded).toBe(true);
    expect(Array.from(state.messages?.keys() || []).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(state.exportStats?.historyLoad?.messagesCollected).toBe(4);
  });

  it('keeps the ordinary path one-click while password protection remains optional', async () => {
    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    const protection = root.querySelector('#tgx-encrypt') as HTMLInputElement;
    const action = root.querySelector('#tgx-export') as HTMLButtonElement;
    expect(protection.checked).toBe(false);
    expect(root.querySelector('#tgx-protection-aes')?.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('#tgx-protection-none')?.getAttribute('aria-pressed')).toBe('true');
    expect(action.disabled).toBe(false);
    expect(action.textContent).toContain('Save conversation');
    expect((root.querySelector('#tgx-unencrypted-confirm') as HTMLElement).hidden).toBe(true);

    protection.click();
    expect(protection.checked).toBe(true);
    expect(root.querySelector('#tgx-protection-aes')?.getAttribute('aria-pressed')).toBe('true');
    expect((root.querySelector('#tgx-password-panel') as HTMLElement).hidden).toBe(false);
    expect(action.disabled).toBe(false);
    expect(action.textContent).toContain('Save with password');
    expect(root.querySelector('#tgx-quick-protection')?.textContent).toContain('Password-protected ZIP');
  });

  it('offers useful presets while keeping the balanced default explicit', async () => {
    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    const balanced = root.querySelector('[data-tgx-preset="balanced"]') as HTMLButtonElement;
    const textOnly = root.querySelector('[data-tgx-preset="text"]') as HTMLButtonElement;
    const complete = root.querySelector('[data-tgx-preset="complete"]') as HTMLButtonElement;

    expect(balanced.getAttribute('aria-pressed')).toBe('true');
    expect((root.querySelector('#tgx-videos') as HTMLInputElement).checked).toBe(false);
    expect((root.querySelector('#tgx-files') as HTMLInputElement).checked).toBe(false);

    textOnly.click();
    expect(textOnly.getAttribute('aria-pressed')).toBe('true');
    expect((root.querySelector('#tgx-photos') as HTMLInputElement).checked).toBe(false);
    expect((root.querySelector('#tgx-voice') as HTMLInputElement).checked).toBe(false);

    complete.click();
    expect(complete.getAttribute('aria-pressed')).toBe('true');
    expect((root.querySelector('#tgx-more-media') as HTMLDetailsElement).open).toBe(true);
    for (const selector of ['#tgx-photos', '#tgx-videos', '#tgx-voice', '#tgx-stickers', '#tgx-files']) {
      expect((root.querySelector(selector) as HTMLInputElement).checked).toBe(true);
    }
  });

  it('keeps a large selection intact and guides verified exports through every batch', async () => {
    telegramBatchFixture();
    let downloadedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloadedBlob = blob as Blob;
      return 'blob:telearchive-batch-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.mocked(HTMLAnchorElement.prototype.click).mockImplementation(function batchAwareClick(this: HTMLAnchorElement) {
      if (this.matches('.chatlist-chat')) {
        this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });

    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');
    const selectable = [...root.querySelectorAll<HTMLInputElement>('input[name="tgx-chats"]')]
      .find((input) => input.value === 'selectable');
    selectable?.click();
    await vi.waitFor(() => expect(root.querySelectorAll('.tgx-chat-check')).toHaveLength(3));

    const planner = root.querySelector('#tgx-batch-planner') as HTMLElement;
    expect(planner.hidden).toBe(false);
    expect(planner.dataset).toMatchObject({
      activeBatch: '1',
      totalBatches: '2',
      totalChats: '3',
      batchSize: '2',
      batchStart: '1',
      batchEnd: '2',
    });
    expect(root.querySelector('#tgx-batch-title')?.textContent).toContain('Multi-chat mode · 3 chats · 2 ZIP batches');
    expect(root.querySelector('#tgx-batch-detail')?.textContent).toContain('2 in this ZIP');
    expect(root.querySelector('#tgx-batch-progress')?.textContent).toContain('0 of 2 batches complete');
    const runAll = root.querySelector('#tgx-batch-run-all') as HTMLButtonElement;
    expect(runAll.hidden).toBe(false);
    expect(runAll.textContent).toContain('Queue all batches · verify each ZIP');
    runAll.click();
    expect(planner.dataset.batchRunAll).toBe('true');
    expect(root.querySelector('#tgx-batch-progress')?.textContent).toContain('Batch 1 is ready; start and verify it before Batch 2');
    expect(root.querySelectorAll<HTMLInputElement>('.tgx-chat-check:checked')).toHaveLength(3);

    (root.querySelector('#tgx-batch-next') as HTMLButtonElement).click();
    expect(planner.dataset).toMatchObject({ activeBatch: '2', batchSize: '1', batchStart: '3', batchEnd: '3' });
    expect(root.querySelectorAll<HTMLInputElement>('.tgx-chat-check:checked')).toHaveLength(3);
    (root.querySelector('#tgx-batch-previous') as HTMLButtonElement).click();
    expect(planner.dataset.activeBatch).toBe('1');

    const firstReceipt = new Promise<CustomEvent<{ filename: string; size: number }>>((resolve) => {
      document.addEventListener('telearchive:download', (event) => resolve(event as CustomEvent<{ filename: string; size: number }>), { once: true });
    });
    startUnencryptedExport(root);
    const firstEvent = await firstReceipt;
    expect(firstEvent.detail.filename).toMatch(/_batch-01-of-02_/);
    const firstZip = await JSZipLibrary.loadAsync(downloadedBlob!);
    const firstSummary = JSON.parse(await firstZip.file('export-summary.json')!.async('string')) as {
      chatsIncluded: number;
      messagesIncluded: number;
      batch: { index: number; total: number; totalChats: number; start: number; end: number; size: number };
    };
    expect(firstSummary).toMatchObject({
      chatsIncluded: 2,
      messagesIncluded: 2,
      batch: { index: 0, total: 2, totalChats: 3, start: 1, end: 2, size: 2 },
    });
    const action = root.querySelector('#tgx-export') as HTMLButtonElement;
    expect(action.textContent).toContain('Continue to batch 2 of 2');
    expect(action.dataset.nextBatch).toBe('true');

    action.click();
    expect(planner.dataset).toMatchObject({
      activeBatch: '2',
      batchSize: '1',
      batchStart: '3',
      batchEnd: '3',
      completedBatches: '1',
    });
    expect(root.querySelector('#tgx-batch-progress')?.textContent).toContain('1 of 2 batches complete');
    expect(root.activeElement).toBe(planner);
    expect(root.querySelectorAll<HTMLInputElement>('.tgx-chat-check:checked')).toHaveLength(3);

    const secondReceipt = new Promise<CustomEvent<{ filename: string; size: number }>>((resolve) => {
      document.addEventListener('telearchive:download', (event) => resolve(event as CustomEvent<{ filename: string; size: number }>), { once: true });
    });
    startUnencryptedExport(root);
    const secondEvent = await secondReceipt;
    expect(secondEvent.detail.filename).toMatch(/_batch-02-of-02_/);
    const secondZip = await JSZipLibrary.loadAsync(downloadedBlob!);
    const secondSummary = JSON.parse(await secondZip.file('export-summary.json')!.async('string')) as {
      chatsIncluded: number;
      messagesIncluded: number;
      batch: { index: number; total: number; totalChats: number; start: number; end: number; size: number };
    };
    expect(secondSummary).toMatchObject({
      chatsIncluded: 1,
      messagesIncluded: 1,
      batch: { index: 1, total: 2, totalChats: 3, start: 3, end: 3, size: 1 },
    });
    expect(root.querySelector('#tgx-result-batch')?.textContent).toContain('All 2 batches complete');
    expect(action.textContent).toContain('Create another');
    expect(action.dataset.nextBatch).toBeUndefined();
  });

  it('creates a real ZIP containing readable and structured exports', async () => {
    let downloadedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloadedBlob = blob as Blob;
      return 'blob:telearchive-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    const receipt = new Promise<CustomEvent<{ filename: string; size: number }>>((resolve) => {
      document.addEventListener('telearchive:download', (event) => resolve(event as CustomEvent<{ filename: string; size: number }>), { once: true });
    });

    const coverageTarget = root.querySelector('#tgx-coverage-target') as HTMLInputElement;
    coverageTarget.value = '2026-08-10';
    coverageTarget.dispatchEvent(new Event('change', { bubbles: true }));
    expect(root.querySelector('#tgx-preexport-title')?.textContent).toContain('Required goal: save');

    startUnencryptedExport(root);
    const event = await receipt;

    expect(event.detail.filename).toMatch(/^Alice Archive_.*\.zip$/);
    expect(event.detail.size).toBeGreaterThan(100);
    expect(downloadedBlob).toBeTruthy();

    const zip = await JSZipLibrary.loadAsync(downloadedBlob!);
    expect(zip.file('messages.html')).toBeTruthy();
    expect(zip.file('result.json')).toBeTruthy();
    expect(zip.file('export-summary.json')).toBeTruthy();
    expect(zip.file('css/style.css')).toBeTruthy();

    const result = JSON.parse(await zip.file('result.json')!.async('string')) as {
      telearchive: {
        history_source: string;
        complete_history_not_guaranteed: boolean;
        content_uploaded: boolean;
        archive_encrypted: boolean;
        coverage_target_date: string;
        coverage_target_reached: boolean;
        oldest_message_calendar_date: string;
        oldest_message_date: string;
        newest_message_date: string;
        partial: boolean;
      };
      messages: Array<{ id: number; text: string }>;
    };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ id: 42, text: 'A durable hello' });
    expect(result.telearchive).toMatchObject({
      history_source: 'rendered-telegram-web',
      complete_history_not_guaranteed: true,
      content_uploaded: false,
      archive_encrypted: false,
      coverage_target_date: '2026-08-10',
      coverage_target_reached: true,
      oldest_message_calendar_date: '2026-08-10',
      oldest_message_date: '2026-08-10T08:00:00.000Z',
      newest_message_date: '2026-08-10T08:00:00.000Z',
      partial: false,
    });
    const summary = JSON.parse(await zip.file('export-summary.json')!.async('string')) as {
      partial: boolean;
      chatsIncluded: number;
      messagesIncluded: number;
      contentUploaded: boolean;
      archiveEncrypted: boolean;
      coverageTargetDate: string;
      coverageTargetReached: boolean;
      oldestMessageDate: string;
      newestMessageDate: string;
      chatCoverage: Array<{
        name: string;
        messagesIncluded: number;
        oldestMessageDate: string;
        newestMessageDate: string;
        oldestCalendarDate: string;
        coverageTargetReached: boolean;
      }>;
      media: { included: number; skipped: number; pending: number };
    };
    expect(summary).toMatchObject({
      partial: false,
      chatsIncluded: 1,
      messagesIncluded: 1,
      contentUploaded: false,
      archiveEncrypted: false,
      coverageTargetDate: '2026-08-10',
      coverageTargetReached: true,
      oldestMessageDate: '2026-08-10T08:00:00.000Z',
      newestMessageDate: '2026-08-10T08:00:00.000Z',
      chatCoverage: [{
        name: 'Alice Archive',
        messagesIncluded: 1,
        oldestMessageDate: '2026-08-10T08:00:00.000Z',
        newestMessageDate: '2026-08-10T08:00:00.000Z',
        oldestCalendarDate: '2026-08-10',
        coverageTargetReached: true,
      }],
      media: { included: 0, skipped: 0, pending: 0 },
    });
    expect(api().state.lastOutcome).toBe('complete');
    expect(api().state.lastExportStats).toMatchObject(summary);
    expect(root.querySelector('#tgx-progress')?.getAttribute('data-state')).toBe('complete');
    expect(root.querySelector('#tgx-result-summary')?.textContent).toContain('1 message');
    expect(root.querySelector('#tgx-result-summary')?.textContent).not.toContain('1 messages');
    expect(root.querySelector('#tgx-result-target')?.textContent).toContain('1/1 requested chats');
    expect(root.querySelector('#tgx-result-target')?.getAttribute('data-state')).toBe('reached');
    expect((root.querySelector('#tgx-result-target-row') as HTMLElement).hidden).toBe(false);
    expect(root.querySelector('#tgx-result-target-status')?.textContent).toContain('History goal reached');
    expect(root.querySelector('#tgx-result-target-status')?.textContent).toContain('1/1 chats');
    expect(root.querySelector('#tgx-result-target-status')?.getAttribute('data-state')).toBe('reached');
    expect(root.querySelector('#tgx-result-note')?.textContent).toMatch(/not a complete (?:Telegram|account) backup/u);
    expect(root.querySelector('#tgx-result-help')?.textContent).toContain('Verify the downloaded ZIP below');
    expect((root.querySelector('#tgx-verify-download') as HTMLButtonElement).hidden).toBe(false);

    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (message) => (
      verifyArchiveFromRequest(message)
    ));
    const verificationInput = root.querySelector('#tgx-verify-file') as HTMLInputElement;
    const selectedFile = new File([downloadedBlob!], event.detail.filename, { type: 'application/zip' });
    Object.defineProperty(verificationInput, 'files', { configurable: true, value: [selectedFile] });
    verificationInput.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(root.querySelector('#tgx-verify-status')?.textContent).toContain('Verified locally'));
    expect(root.querySelector('#tgx-verify-status')?.textContent).toContain('export-summary.json + messages.html + result.json');
    expect(root.querySelector('#tgx-verify-status')?.textContent).toContain('1 chat');
    expect(root.querySelector('#tgx-verify-status')?.textContent).toContain('1 message');
    expect(root.querySelector('#tgx-verify-status')?.textContent).toContain('No password');
    expect((root.querySelector('#tgx-verify-panel') as HTMLElement).hidden).toBe(true);
    expect((root.querySelector('#tgx-export') as HTMLButtonElement).textContent).toContain('Create another');

    (root.querySelector('#tgx-export') as HTMLButtonElement).click();
    expect(root.querySelector('#tgx-progress')?.hasAttribute('hidden')).toBe(true);
    expect((root.querySelector('#tgx-export') as HTMLButtonElement).disabled).toBe(false);
    expect((root.querySelector('#tgx-export') as HTMLButtonElement).textContent).toContain('Save conversation');
  });

  it('collects both newer and older virtualized messages when export starts in the middle', async () => {
    const messageMarkup = (id: number, text: string) => `
      <article data-mid="message-${id}" data-peer-id="321">
        <span class="peer-title">Virtualized Chat</span>
        <time datetime="2026-08-10T08:00:0${id}.000Z">${id}</time>
        <div data-scope="text">${text}</div>
      </article>`;
    document.body.innerHTML = `
      <aside id="column-left">
        <a class="chatlist-chat active" data-peer-id="321" href="#321">
          <span class="user-title"><span class="peer-title">Virtualized Chat</span></span>
        </a>
      </aside>
      <main>
        <header><span data-scope="peer-title">Virtualized Chat</span></header>
        <div data-scope="bubbles">${messageMarkup(2, 'Middle message')}</div>
        <div class="input-message-input" data-peer-id="321"></div>
      </main>`;
    const container = document.querySelector('[data-scope="bubbles"]') as HTMLElement;
    let virtualScrollTop = 600;
    Object.defineProperties(container, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 1800 },
      scrollTop: {
        configurable: true,
        get: () => virtualScrollTop,
        set: (value: number) => {
          virtualScrollTop = value;
          container.innerHTML = value >= 1200
            ? messageMarkup(3, 'Newest message')
            : value <= 0
              ? messageMarkup(1, 'Oldest message')
              : messageMarkup(2, 'Middle message');
        },
      },
    });

    let downloadedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloadedBlob = blob as Blob;
      return 'blob:telearchive-bidirectional-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');
    const receipt = new Promise<void>((resolve) => {
      document.addEventListener('telearchive:download', () => resolve(), { once: true });
    });
    startUnencryptedExport(root);
    await receipt;

    const zip = await JSZipLibrary.loadAsync(downloadedBlob!);
    const result = JSON.parse(await zip.file('result.json')!.async('string')) as {
      messages: Array<{ id: number; text: string }>;
    };
    expect(result.messages).toEqual([
      expect.objectContaining({ id: 1, text: 'Oldest message' }),
      expect.objectContaining({ id: 2, text: 'Middle message' }),
      expect.objectContaining({ id: 3, text: 'Newest message' }),
    ]);
  });

  it('exports a 1,000-message text history and classifies its workload before starting', async () => {
    telegramLargeFixture(1000);
    let downloadedBlob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloadedBlob = blob as Blob;
      return 'blob:telearchive-stress-test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');
    root.querySelector<HTMLButtonElement>('[data-tgx-preset="text"]')?.click();

    expect(root.querySelector('#tgx-workload-estimate')?.getAttribute('data-level')).toBe('moderate');
    expect(root.querySelector('#tgx-workload-estimate')?.textContent).toContain('1000 loaded now');
    expect(root.querySelector('#tgx-workload-estimate')?.textContent).toContain('text only');

    const receipt = new Promise<CustomEvent<{ filename: string; size: number }>>((resolve) => {
      document.addEventListener('telearchive:download', (event) => resolve(event as CustomEvent<{ filename: string; size: number }>), { once: true });
    });
    startUnencryptedExport(root);
    await receipt;

    const zip = await JSZipLibrary.loadAsync(downloadedBlob!);
    const result = JSON.parse(await zip.file('result.json')!.async('string')) as {
      messages: Array<{ id: number; text: string }>;
    };
    const summary = JSON.parse(await zip.file('export-summary.json')!.async('string')) as {
      messagesIncluded: number;
    };
    expect(result.messages).toHaveLength(1000);
    expect(result.messages[0]).toMatchObject({ id: 1, text: 'Stress message 1' });
    expect(result.messages.at(-1)).toMatchObject({ id: 1000, text: 'Stress message 1000' });
    expect(summary.messagesIncluded).toBe(1000);
  });

  it('does not mix a previous archive into a repeated current-chat export', async () => {
    const downloaded: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloaded.push(blob as Blob);
      return `blob:telearchive-test-${downloaded.length}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    const firstReceipt = new Promise<void>((resolve) => {
      document.addEventListener('telearchive:download', () => resolve(), { once: true });
    });
    startUnencryptedExport(root);
    await firstReceipt;
    (root.querySelector('#tgx-export') as HTMLButtonElement).click();

    const main = document.querySelector('main');
    if (!main) throw new Error('Telegram fixture has no main element');
    main.innerHTML = `
      <header><span data-scope="peer-title">Bob Archive</span></header>
      <div data-scope="bubbles">
        <article data-mid="message-99" data-peer-id="456">
          <span class="peer-title">Bob</span>
          <time datetime="2026-08-10T09:00:00.000Z">12:00</time>
          <div data-scope="text">Only the second chat</div>
        </article>
      </div>
      <div class="input-message-input" data-peer-id="456"></div>
    `;

    const secondReceipt = new Promise<void>((resolve) => {
      document.addEventListener('telearchive:download', () => resolve(), { once: true });
    });
    startUnencryptedExport(root);
    await secondReceipt;

    expect(downloaded).toHaveLength(2);
    const secondBlob = downloaded.at(1);
    if (!secondBlob) throw new Error('The repeated export did not produce a second archive');
    const secondZip = await JSZipLibrary.loadAsync(secondBlob);
    const secondResult = JSON.parse(await secondZip.file('result.json')!.async('string')) as {
      messages: Array<{ id: number; text: string }>;
    };
    expect(secondResult.messages).toHaveLength(1);
    expect(secondResult.messages[0]).toMatchObject({ id: 99, text: 'Only the second chat' });
  });

  it('shows a safe actionable failure instead of leaking the Firefox realm exception', async () => {
    class FailingArchive {
      file(): this {
        return this;
      }

      async generateAsync(): Promise<Blob> {
        const error = new Error('Permission denied to access property "flush"') as Error & { code: string };
        error.code = 'archive-engine-failed';
        throw error;
      }
    }
    globalThis.JSZip = FailingArchive as unknown as typeof JSZipLibrary;

    await api().showModernExportDialog();
    const root = api().state.dialogRoot;
    if (!root) throw new Error('Dialog did not open');

    startUnencryptedExport(root);
    await vi.waitFor(() => expect(api().state.lastOutcome).toBe('error'));

    const progress = root.querySelector('#tgx-progress');
    expect(progress?.getAttribute('data-state')).toBe('error');
    expect(progress?.getAttribute('data-error-code')).toBe('archive-engine-failed');
    expect(progress?.textContent).toContain('Firefox could not finish the ZIP');
    expect(progress?.textContent).not.toContain('flush');
    expect((root.querySelector('#tgx-export') as HTMLButtonElement).textContent).toContain('Try again');
  });
});
