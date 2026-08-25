import { browser } from 'wxt/browser';
import { archiveConnectors, defaultArchiveConnector, findArchiveConnector } from '@/src/connectors';
import {
  BACKGROUND_EXPORT_START_MESSAGE,
  type BackgroundExportStartResponse,
} from '@/src/shared/background-export-protocol';
import type { ArchiveConnectorDescriptor } from '@/src/shared/connector';
import {
  normalizeQuickExportRequest,
  type QuickExportRequest,
} from '@/src/shared/export-request';
import {
  quickExportLabels,
  resolveUiLocale,
  UI_LOCALES,
  uiText,
  type UiLocale,
} from '@/src/shared/product-i18n';
import {
  DEFAULT_QUICK_EXPORT_DEFAULTS,
  loadQuickExportDefaults,
  saveQuickExportDefaults,
} from '@/src/shared/quick-export-defaults';
import './style.css';

const UI_LOCALE_KEY = 'localArchive.uiLocale.v1';
const LAST_TARGET_TAB_KEY = 'localArchive.lastTargetTabId.v1';

interface ExporterInspection {
  ready: boolean;
  chatName: string;
  visibleMessages: number;
  busy: boolean;
  needsPermission?: boolean;
  source?: string;
  historySource?: string;
  loadedScope?: string;
}

interface ExporterApi {
  isExporting?: () => boolean;
  quickExport?: (value: QuickExportRequest) => unknown;
  beginBackgroundProgress?: (value: { jobId: string; labels: QuickExportRequest['labels'] }) => unknown;
}

type PopupState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'no-chat'; tabId: number; connector: ArchiveConnectorDescriptor }
  | { kind: 'ready'; tabId: number; connector: ArchiveConnectorDescriptor; inspection: ExporterInspection }
  | { kind: 'error'; message: string };

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Popup element is missing: ${selector}`);
  return element;
}

const popup = required<HTMLElement>('#popup');
const loadingView = required<HTMLElement>('#loading-view');
const unsupportedView = required<HTMLElement>('#unsupported-view');
const noChatView = required<HTMLElement>('#no-chat-view');
const exportView = required<HTMLElement>('#export-view');
const language = required<HTMLSelectElement>('#language');
const chatName = required<HTMLElement>('#chat-name');
const sourceName = required<HTMLElement>('#source-name');
const sourceIcon = required<HTMLElement>('.source-icon');
const visibleCount = required<HTMLElement>('#visible-count');
const form = required<HTMLFormElement>('#export-form');
const recentPanel = required<HTMLElement>('#recent-panel');
const recentHint = required<HTMLElement>('#recent-hint');
const datesPanel = required<HTMLElement>('#dates-panel');
const allPanel = required<HTMLElement>('#all-panel');
const recentCount = required<HTMLInputElement>('#recent-count');
const dateFrom = required<HTMLInputElement>('#date-from');
const dateTo = required<HTMLInputElement>('#date-to');
const dateFromDisplay = required<HTMLElement>('#date-from-display');
const dateToDisplay = required<HTMLElement>('#date-to-display');
const datesHint = required<HTMLElement>('#dates-hint');
const format = required<HTMLSelectElement>('#format');
const includeMedia = required<HTMLInputElement>('#include-media');
const attachmentsHint = required<HTMLElement>('#attachments-hint');
const exportButton = required<HTMLButtonElement>('#export-button');
const error = required<HTMLElement>('#error');
const version = required<HTMLElement>('#version');

let locale: UiLocale = resolveUiLocale(browser.i18n.getUILanguage?.());
let state: PopupState = { kind: 'loading' };
let starting = false;

const genericCopy: Record<UiLocale, { unsupportedTitle: string; unsupportedBody: string; openSource: string; noChatTitle: string; noChatBody: string }> = {
  en: { unsupportedTitle: 'Open Telegram Web first', unsupportedBody: 'Open a conversation in Telegram Web, then click the extension again.', openSource: 'Open Telegram Web', noChatTitle: 'Open a conversation', noChatBody: 'Choose a conversation in Telegram Web, then reopen this panel.' },
  ru: { unsupportedTitle: 'Открой Telegram Web', unsupportedBody: 'Открой переписку в Telegram Web и снова нажми на расширение.', openSource: 'Открыть Telegram Web', noChatTitle: 'Открой переписку', noChatBody: 'Выбери переписку в Telegram Web и снова открой это окно.' },
  uk: { unsupportedTitle: 'Відкрий Telegram Web', unsupportedBody: 'Відкрий розмову в Telegram Web і знову натисни розширення.', openSource: 'Відкрити Telegram Web', noChatTitle: 'Відкрий розмову', noChatBody: 'Обери розмову в Telegram Web і знову відкрий цю панель.' },
  de: { unsupportedTitle: 'Telegram Web öffnen', unsupportedBody: 'Öffne eine Unterhaltung in Telegram Web und klicke die Erweiterung erneut.', openSource: 'Telegram Web öffnen', noChatTitle: 'Unterhaltung öffnen', noChatBody: 'Wähle eine Unterhaltung in Telegram Web und öffne dieses Panel erneut.' },
  fr: { unsupportedTitle: 'Ouvrez Telegram Web', unsupportedBody: 'Ouvrez une conversation dans Telegram Web, puis cliquez à nouveau sur l’extension.', openSource: 'Ouvrir Telegram Web', noChatTitle: 'Ouvrez une conversation', noChatBody: 'Choisissez une conversation dans Telegram Web, puis rouvrez ce panneau.' },
  es: { unsupportedTitle: 'Abre Telegram Web', unsupportedBody: 'Abre una conversación en Telegram Web y vuelve a pulsar la extensión.', openSource: 'Abrir Telegram Web', noChatTitle: 'Abre una conversación', noChatBody: 'Elige una conversación en Telegram Web y vuelve a abrir este panel.' },
  'pt-BR': { unsupportedTitle: 'Abra o Telegram Web', unsupportedBody: 'Abra uma conversa no Telegram Web e clique novamente na extensão.', openSource: 'Abrir Telegram Web', noChatTitle: 'Abra uma conversa', noChatBody: 'Escolha uma conversa no Telegram Web e reabra este painel.' },
  pl: { unsupportedTitle: 'Otwórz Telegram Web', unsupportedBody: 'Otwórz rozmowę w Telegram Web i kliknij rozszerzenie ponownie.', openSource: 'Otwórz Telegram Web', noChatTitle: 'Otwórz rozmowę', noChatBody: 'Wybierz rozmowę w Telegram Web i otwórz panel ponownie.' },
};

function localDate(daysAgo = 0): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

dateFrom.value = localDate(30);
dateTo.value = localDate();
dateFrom.max = dateTo.max = localDate();

for (const [value, label] of UI_LOCALES) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  language.append(option);
}

function applyLocale(): void {
  document.documentElement.lang = locale.split('-')[0] || 'en';
  language.value = locale;
  language.setAttribute('aria-label', uiText(locale, 'language'));
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n as Parameters<typeof uiText>[1] | undefined;
    if (key) element.textContent = uiText(locale, key);
  });
  version.textContent = uiText(locale, 'version', { version: browser.runtime.getManifest().version });
  render();
}

function showError(message = ''): void {
  error.textContent = message;
  error.hidden = !message;
}

function renderRange(): void {
  const selected = form.elements.namedItem('range') as RadioNodeList;
  const mode = selected.value || 'recent';
  recentPanel.hidden = mode !== 'recent';
  datesPanel.hidden = mode !== 'dates';
  allPanel.hidden = mode !== 'all';
  const formatDate = (value: string): string => {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (!match) return value;
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
  };
  datesHint.textContent = uiText(locale, 'datesHint', {
    from: formatDate(dateFrom.value),
    to: formatDate(dateTo.value),
  });
  dateFromDisplay.textContent = formatDate(dateFrom.value);
  dateToDisplay.textContent = formatDate(dateTo.value);
}

function render(): void {
  loadingView.hidden = state.kind !== 'loading';
  unsupportedView.hidden = state.kind !== 'unsupported';
  noChatView.hidden = state.kind !== 'no-chat';
  exportView.hidden = state.kind !== 'ready';
  popup.setAttribute('aria-busy', String(state.kind === 'loading' || starting));
  exportButton.disabled = starting || state.kind !== 'ready' || (state.kind === 'ready' && state.inspection.busy);
  exportButton.textContent = uiText(locale, starting ? 'starting' : 'exportZip');
  const unsupportedTitle = document.querySelector<HTMLElement>('[data-i18n="unsupportedTitle"]');
  const unsupportedBody = document.querySelector<HTMLElement>('[data-i18n="unsupportedBody"]');
  const openSource = document.querySelector<HTMLElement>('[data-i18n="openTelegram"]');
  const noChatTitle = document.querySelector<HTMLElement>('[data-i18n="noChatTitle"]');
  const noChatBody = document.querySelector<HTMLElement>('[data-i18n="noChatBody"]');
  if (unsupportedTitle) unsupportedTitle.textContent = genericCopy[locale].unsupportedTitle;
  if (unsupportedBody) unsupportedBody.textContent = genericCopy[locale].unsupportedBody;
  if (openSource) openSource.textContent = genericCopy[locale].openSource;
  if (state.kind === 'no-chat') {
    if (noChatTitle) noChatTitle.textContent = genericCopy[locale].noChatTitle;
    if (noChatBody) noChatBody.textContent = genericCopy[locale].noChatBody;
  }
  if (state.kind === 'ready') {
    sourceName.textContent = state.connector.displayName;
    sourceIcon.textContent = 'T';
    chatName.textContent = state.inspection.chatName || uiText(locale, 'currentChat');
    visibleCount.textContent = state.inspection.needsPermission ? '' : uiText(
      locale, state.inspection.visibleMessages === 1 ? 'messageVisible' : 'messagesVisible',
      { count: state.inspection.visibleMessages },
    );
    if (state.inspection.busy) showError(uiText(locale, 'busy'));
    attachmentsHint.textContent = uiText(locale, 'attachmentsHint');
  } else {
    attachmentsHint.textContent = uiText(locale, 'attachmentsHint');
  }
  if (state.kind === 'error') showError(state.message);
  renderRange();
}

async function inspectTab(tabId: number, connector: ArchiveConnectorDescriptor): Promise<ExporterInspection | null> {
  await browser.scripting.executeScript({ target: { tabId }, files: [connector.entrypoint as '/telegram-exporter.js'] });
  const [execution] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      const api = (globalThis as typeof globalThis & {
        LocalArchiveExporter?: { inspect?: () => ExporterInspection };
        TeleArchiveExporter?: { inspect?: () => ExporterInspection };
      }).LocalArchiveExporter || (globalThis as typeof globalThis & {
        TeleArchiveExporter?: { inspect?: () => ExporterInspection };
      }).TeleArchiveExporter;
      return api?.inspect?.() ?? null;
    },
  });
  return execution?.result as ExporterInspection | null;
}

function selectedRequest(): QuickExportRequest {
  const selected = form.elements.namedItem('range') as RadioNodeList;
  const mode = selected.value || 'recent';
  const range = mode === 'all'
    ? { mode: 'all' as const }
    : mode === 'dates'
      ? { mode: 'dates' as const, from: dateFrom.value, to: dateTo.value }
      : { mode: 'recent' as const, count: Number(recentCount.value) };
  return normalizeQuickExportRequest({
    format: format.value,
    includeMedia: includeMedia.checked,
    locale,
    range,
    labels: quickExportLabels(locale),
  });
}

function createBackgroundJobId(): string {
  if (typeof crypto.randomUUID === 'function') return `job-${crypto.randomUUID()}`;
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

async function waitForConnectorPermission(connector: ArchiveConnectorDescriptor, timeoutMs = 5_000): Promise<boolean> {
  const origin = connector.allowedOrigins[0]?.replace(/\/+$/u, '');
  if (!origin) return false;
  const pattern = `${origin}/*`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await browser.permissions.contains({ origins: [pattern] })) return true;
    } catch {
      // Firefox can briefly surface the grant before the extension process sees it.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function startBackgroundExport(tabId: number, connector: ArchiveConnectorDescriptor, request: QuickExportRequest): Promise<boolean> {
  const jobId = createBackgroundJobId();
  const sourceTab = await browser.tabs.get(tabId);
  const sourceUrl = String(sourceTab.url || '');
  const allowedOrigin = connector.allowedOrigins[0] || '';
  if (!allowedOrigin || !sourceUrl.startsWith(allowedOrigin)) return false;
  const [progressExecution] = await browser.scripting.executeScript({
    target: { tabId },
    args: [{ jobId, sourceTabId: tabId, labels: request.labels }],
    func: (payload: { jobId: string; sourceTabId: number; labels: QuickExportRequest['labels'] }) => {
      const api = (globalThis as typeof globalThis & { LocalArchiveExporter?: ExporterApi; TeleArchiveExporter?: ExporterApi }).LocalArchiveExporter
        || (globalThis as typeof globalThis & { TeleArchiveExporter?: ExporterApi }).TeleArchiveExporter;
      if (!api?.beginBackgroundProgress) return { accepted: false, reason: 'unavailable' };
      const result = api.beginBackgroundProgress(payload);
      return result === false ? { accepted: false, reason: 'busy' } : { accepted: true };
    },
  });
  const progressResult = progressExecution?.result as { accepted?: boolean; reason?: string } | undefined;
  if (!progressResult?.accepted) {
    if (progressResult?.reason === 'busy' && state.kind === 'ready') {
      state = { ...state, inspection: { ...state.inspection, busy: true } };
      render();
    }
    return false;
  }
  const response = await browser.runtime.sendMessage({
    type: BACKGROUND_EXPORT_START_MESSAGE,
    jobId,
    sourceTabId: tabId,
    sourceUrl,
    connectorId: connector.id,
    request,
  }) as BackgroundExportStartResponse;
  if (!response?.ok) {
    if (response.reason === 'busy' && state.kind === 'ready') {
      state = { ...state, inspection: { ...state.inspection, busy: true } };
      render();
      return false;
    }
    await browser.scripting.executeScript({
      target: { tabId },
      args: [{ jobId, message: response?.message || 'The background exporter could not start.' }],
      func: (payload: { jobId: string; message: string }) => {
        const api = (globalThis as typeof globalThis & { LocalArchiveExporter?: { backgroundProgress?: (value: unknown) => unknown }; TeleArchiveExporter?: { backgroundProgress?: (value: unknown) => unknown } }).LocalArchiveExporter
          || (globalThis as typeof globalThis & { TeleArchiveExporter?: { backgroundProgress?: (value: unknown) => unknown } }).TeleArchiveExporter;
        api?.backgroundProgress?.({
          type: 'telearchive.background-export.progress.v1',
          jobId: payload.jobId,
          phase: 'error',
          text: payload.message,
          pct: 100,
          messages: 0,
          errorCode: 'background-start-failed',
        });
      },
    });
    return false;
  }
  return true;
}

async function startExport(tabId: number, connector: ArchiveConnectorDescriptor, request: QuickExportRequest): Promise<boolean> {
  if (connector.capabilities.history.automatic) {
    return startBackgroundExport(tabId, connector, request);
  }
  await browser.scripting.executeScript({ target: { tabId }, files: [connector.entrypoint as '/telegram-exporter.js'] });
  const [execution] = await browser.scripting.executeScript({
    target: { tabId },
    args: [request],
    func: (payload) => {
      const api = (globalThis as typeof globalThis & { LocalArchiveExporter?: ExporterApi; TeleArchiveExporter?: ExporterApi }).LocalArchiveExporter
        || (globalThis as typeof globalThis & { TeleArchiveExporter?: ExporterApi }).TeleArchiveExporter;
      if (!api?.quickExport) return { accepted: false, reason: 'unavailable' };
      if (api.isExporting?.()) return { accepted: false, reason: 'busy' };
      void api.quickExport(payload);
      return { accepted: true };
    },
  });
  return Boolean((execution?.result as { accepted?: boolean } | undefined)?.accepted);
}

form.addEventListener('change', () => {
  renderRange();
  showError('');
});
dateFrom.addEventListener('input', renderRange);
dateTo.addEventListener('input', renderRange);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (starting || state.kind !== 'ready') return;
  showError('');
  let request: QuickExportRequest;
  try {
    request = selectedRequest();
  } catch {
    showError(uiText(locale, 'invalidDates'));
    return;
  }
  void saveQuickExportDefaults({
    format: request.format,
    includeMedia: request.includeMedia,
    recentCount: Number(recentCount.value),
  }).catch(() => undefined);
  starting = true;
  render();
  try {
    // Automatic history connectors run in a second inactive tab. activeTab is
    // enough for the current tab, but Firefox requires the connector's host
    // permission before that background tab can be injected.
    const needsConnectorPermission = state.connector.capabilities.history.automatic || state.inspection.needsPermission;
    if (needsConnectorPermission) {
      const granted = await browser.permissions.request({ origins: [`${state.connector.allowedOrigins[0]}/*`] });
      if (!granted || !(await waitForConnectorPermission(state.connector))) {
        showError(uiText(locale, 'permissionDenied'));
        starting = false;
        render();
        return;
      }
      const inspection = await inspectTab(state.tabId, state.connector);
      if (!inspection?.ready) {
        state = { kind: 'no-chat', tabId: state.tabId, connector: state.connector };
        starting = false;
        render();
        return;
      }
        state = { kind: 'ready', tabId: state.tabId, connector: state.connector, inspection };
    }
    const accepted = await startExport(state.tabId, state.connector, request);
    if (!accepted) {
      showError(uiText(locale, state.inspection.busy ? 'busy' : 'injectionError'));
      starting = false;
      render();
      return;
    }
    if (new URLSearchParams(location.search).get('standalone') !== '1') window.close();
  } catch {
    showError(uiText(locale, 'injectionError'));
    starting = false;
    render();
  }
});

language.addEventListener('change', () => {
  locale = resolveUiLocale(language.value);
  void browser.storage.local.set({ [UI_LOCALE_KEY]: locale });
  applyLocale();
});

required<HTMLButtonElement>('#open-source').addEventListener('click', () => {
  void browser.tabs.create({ url: defaultArchiveConnector.launchUrl });
});

required<HTMLButtonElement>('#settings').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
});

applyLocale();
async function resolveTargetTab(): Promise<Browser.tabs.Tab | undefined> {
  const parameters = new URLSearchParams(location.search);
  const directTabId = Number(parameters.get('targetTabId'));
  if (Number.isInteger(directTabId) && directTabId > 0) {
    try {
      const direct = await browser.tabs.get(directTabId);
      if (findArchiveConnector(direct.url) || parameters.get('standalone') === '1') return direct;
    } catch {}
  }
  if (parameters.get('standalone') === '1') {
    try {
      const stored = await browser.storage.session.get(LAST_TARGET_TAB_KEY);
      const tabId = Number(stored[LAST_TARGET_TAB_KEY]);
      if (Number.isInteger(tabId) && tabId > 0) {
        const storedTab = await browser.tabs.get(tabId);
        if (findArchiveConnector(storedTab.url)) return storedTab;
      }
    } catch {
      // Fall through to the host-scoped development lookup below.
    }
    const sourceTabs = await browser.tabs.query({ url: ['https://web.telegram.org/*'] });
    return sourceTabs.sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
  }
  return (await browser.tabs.query({ active: true, currentWindow: true }))[0];
}

function connectorFromParameters(): ArchiveConnectorDescriptor | undefined {
  const id = new URLSearchParams(location.search).get('connectorId');
  return archiveConnectors.find((candidate) => candidate.id === id);
}

void Promise.all([
  browser.storage.local.get(UI_LOCALE_KEY),
  resolveTargetTab(),
  loadQuickExportDefaults().catch(() => ({ ...DEFAULT_QUICK_EXPORT_DEFAULTS })),
]).then(async ([stored, tab, defaults]) => {
  locale = resolveUiLocale(stored[UI_LOCALE_KEY] as string | undefined || browser.i18n.getUILanguage?.());
  format.value = defaults.format;
  includeMedia.checked = defaults.includeMedia;
  recentCount.value = String(defaults.recentCount);
  const standalone = new URLSearchParams(location.search).get('standalone') === '1';
  const connector = findArchiveConnector(tab?.url) || connectorFromParameters() || (standalone ? defaultArchiveConnector : undefined);
  if (!tab?.id || !connector) {
    state = { kind: 'unsupported' };
    applyLocale();
    return;
  }
  try { await browser.storage.session.set({ [LAST_TARGET_TAB_KEY]: tab.id }); } catch {}
  try {
    const inspection = await inspectTab(tab.id, connector);
    state = inspection?.ready
      ? { kind: 'ready', tabId: tab.id, connector, inspection }
      : { kind: 'no-chat', tabId: tab.id, connector };
  } catch (cause) {
    if (String(cause).includes('Missing host permission')) {
      state = {
        kind: 'ready', tabId: tab.id, connector,
        inspection: { ready: true, chatName: '', visibleMessages: 0, busy: false, needsPermission: true },
      };
    } else throw cause;
  }
  applyLocale();
}).catch((cause) => {
  popup.dataset.errorDetail = cause instanceof Error ? cause.message : String(cause);
  state = { kind: 'error', message: uiText(locale, 'injectionError') };
  render();
});
