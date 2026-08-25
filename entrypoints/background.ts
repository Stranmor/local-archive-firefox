import { browser } from 'wxt/browser';
import { archiveConnectors, findArchiveConnector } from '@/src/connectors';
import { createArchiveFromRequest, sha256Hex, verifyArchiveFromRequest } from '@/src/shared/archive-service';
import {
  BACKGROUND_EXPORT_CANCEL_MESSAGE,
  BACKGROUND_EXPORT_PROGRESS_MESSAGE,
  BACKGROUND_EXPORT_START_MESSAGE,
  isBackgroundExportCancelRequest,
  isBackgroundExportProgressMessage,
  isBackgroundExportStatusRequest,
  isBackgroundExportStartRequest,
  type BackgroundExportCancelResponse,
  type BackgroundExportProgressMessage,
  type BackgroundExportStatusResponse,
  type BackgroundExportStartFailure,
  type BackgroundExportStartResponse,
} from '@/src/shared/background-export-protocol';
import {
  isArchiveCreateRequest,
  isArchiveSaveRequest,
  isArchiveVerifyRequest,
  isDownloadStatusRequest,
  isShowDownloadRequest,
  matchesArchiveFilename,
  type ArchiveSaveRequest,
  type ArchiveSaveResponse,
  type ArchiveVerifyResponse,
  type DownloadStatusRequest,
  type DownloadStatusResponse,
  type ExactDownloadRequest,
  type ShowDownloadRequest,
  type ShowDownloadResponse,
} from '@/src/shared/archive-protocol';
import type { QuickExportRequest } from '@/src/shared/export-request';
import { installTelegramPageBridge } from '@/src/connectors/telegram-native-history';

const DOWNLOAD_BINDING_PREFIX = 'localArchive.downloadBinding.v1.';
const BACKGROUND_JOB_STORAGE_PREFIX = 'localArchive.backgroundExport.v1.';
const BACKGROUND_JOB_TTL_MS = 5 * 60_000;
const activeObjectUrls = new Map<number, string>();
const liveBindings = new Map<number, ExactDownloadRequest>();

interface BackgroundJob {
  jobId: string;
  sourceTabId: number;
  sourceUrl: string;
  workerTabId: number;
  connectorId: string;
  phase: BackgroundExportProgressMessage['phase'];
  labels: ReturnType<typeof normalizeBackgroundStartRequest>['request']['labels'];
  lastProgress: BackgroundExportProgressMessage;
  updatedAt: number;
  terminal: boolean;
}

const backgroundJobs = new Map<string, BackgroundJob>();

function isAuthorizedConnectorSender(url: string | undefined): boolean {
  return findArchiveConnector(url) != null;
}

function connectorPermissionPattern(connector: { allowedOrigins: readonly string[] }): string {
  const origin = connector.allowedOrigins[0]?.replace(/\/+$/u, '');
  return origin ? `${origin}/*` : '';
}

async function waitForConnectorPermission(
  connector: { allowedOrigins: readonly string[] },
  timeoutMs = 5_000,
): Promise<void> {
  const pattern = connectorPermissionPattern(connector);
  if (!pattern) throw new Error('The connector has no authorized source origin.');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await browser.permissions.contains({ origins: [pattern] })) return;
    } catch {
      // Permission state can lag immediately after the popup grant in Firefox.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Missing host permission for ${pattern}`);
}

async function injectConnectorEntrypoint(
  tabId: number,
  connector: { entrypoint: string },
  attempts = 8,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await browser.scripting.executeScript({
        target: { tabId },
        files: [connector.entrypoint as '/telegram-exporter.js'],
      });
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const retryable = /Missing host permission|Cannot access contents|The tab was closed|No such tab/iu.test(message);
      if (!retryable || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 + attempt * 150));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError || 'The connector could not be injected.'));
}

async function injectTelegramPageBridge(tabId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['/telegram-page-bridge.js' as never],
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Missing host permission|execution world|unsupported|not supported/iu.test(message)) throw error;
  }
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installTelegramPageBridge,
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/Missing host permission|execution world|unsupported|not supported/iu.test(message)) throw error;
  }
  // Firefox versions that reject MAIN-world scripting can still execute a
  // web-accessible static bridge through the page's own script loader. The
  // script is exposed only to Telegram's exact origin and is loaded only
  // after the user starts an export.
  await browser.scripting.executeScript({
    target: { tabId },
    args: [browser.runtime.getURL('/telegram-page-bridge.js' as never)],
    func: (scriptUrl: string) => new Promise<boolean>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>('script[data-local-archive-telegram-page-bridge]');
      if (existing?.dataset.loaded === 'true') {
        resolve(true);
        return;
      }
      const script = existing || document.createElement('script');
      script.dataset.localArchiveTelegramPageBridge = 'true';
      const finish = (ok: boolean) => {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        if (ok) script.dataset.loaded = 'true';
        ok ? resolve(true) : reject(new Error('Telegram page bridge script could not be loaded.'));
      };
      const onLoad = () => finish(true);
      const onError = () => finish(false);
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      if (!existing) {
        script.src = scriptUrl;
        script.async = false;
        (document.head || document.documentElement).appendChild(script);
      }
    }),
  });
}

function basename(value: string): string {
  return value.replaceAll('\\', '/').split('/').at(-1) || '';
}

function bindingKey(downloadId: number): string {
  return `${DOWNLOAD_BINDING_PREFIX}${downloadId}`;
}

function backgroundJobKey(jobId: string): string {
  return `${BACKGROUND_JOB_STORAGE_PREFIX}${jobId}`;
}

async function persistBackgroundJob(job: BackgroundJob): Promise<void> {
  backgroundJobs.set(job.jobId, job);
  await browser.storage.session.set({ [backgroundJobKey(job.jobId)]: job });
}

async function readBackgroundJob(jobId: string): Promise<BackgroundJob | null> {
  const live = backgroundJobs.get(jobId);
  if (live) return live;
  const stored = await browser.storage.session.get(backgroundJobKey(jobId));
  const value = stored[backgroundJobKey(jobId)] as BackgroundJob | undefined;
  if (!value || value.jobId !== jobId) return null;
  backgroundJobs.set(jobId, value);
  return value;
}

function isFreshBackgroundJob(job: BackgroundJob): boolean {
  return Number.isFinite(job.updatedAt) && Date.now() - job.updatedAt <= BACKGROUND_JOB_TTL_MS;
}

function sourceIdentity(value: string | undefined): string {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}${url.hash}`;
  } catch {
    return '';
  }
}

async function readBackgroundJobs(): Promise<BackgroundJob[]> {
  const stored = await browser.storage.session.get(null);
  const jobs: BackgroundJob[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(BACKGROUND_JOB_STORAGE_PREFIX)) continue;
    const job = value as BackgroundJob;
    if (!job || typeof job.jobId !== 'string' || !isFreshBackgroundJob(job)) {
      try { await browser.storage.session.remove(key); } catch {}
      continue;
    }
    backgroundJobs.set(job.jobId, job);
    jobs.push(job);
  }
  return jobs;
}

async function removeBackgroundJob(jobId: string): Promise<void> {
  backgroundJobs.delete(jobId);
  await browser.storage.session.remove(backgroundJobKey(jobId));
}

function scheduleBackgroundJobCleanup(job: BackgroundJob): void {
  const expectedUpdatedAt = job.updatedAt;
  setTimeout(() => {
    void (async () => {
      const current = await readBackgroundJob(job.jobId);
      if (!current || !current.terminal || current.updatedAt !== expectedUpdatedAt) return;
      await removeBackgroundJob(job.jobId);
    })().catch(() => undefined);
  }, BACKGROUND_JOB_TTL_MS);
}

function internalExtensionSender(sender: Browser.runtime.MessageSender): boolean {
  return sender.id === browser.runtime.id
    && Boolean(sender.url?.startsWith(browser.runtime.getURL('')));
}

async function waitForWorkerTab(tabId: number, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId);
    lastStatus = String(tab.status || '');
    // The extension deliberately does not request the broad `tabs` permission.
    // Firefox may therefore redact the URL of an inactive worker tab even
    // though the navigation itself is complete. The source tab was validated
    // before creation; readiness here is only the document lifecycle boundary.
    if (lastStatus === 'complete') return;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`The background exporter tab did not become ready (${lastStatus || 'unknown'}).`);
}

/**
 * `tabs.Tab.status === "complete"` only describes the navigation document.
 * Telegram hydrates its application shell after navigation, and an inactive
 * helper tab can take noticeably longer to render the conversation.
 * Starting collection before the connector reports a readable surface makes
 * the exporter fail with a misleading live-layout error. Wait for the actual
 * connector contract instead of treating navigation completion as readiness.
 */
async function waitForWorkerExporterReady(tabId: number, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastState = 'connector-not-ready';
  while (Date.now() < deadline) {
    try {
      const [execution] = await browser.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const native = (globalThis as typeof globalThis & {
            __LOCAL_ARCHIVE_TELEGRAM_NATIVE__?: { inspect?: () => Promise<{ ready?: unknown }> };
          }).__LOCAL_ARCHIVE_TELEGRAM_NATIVE__;
          try {
            const nativeInspection = await native?.inspect?.();
            if (nativeInspection?.ready === true) return { ready: true, state: 'native-ready' };
          } catch {
            // Fall through to the rendered connector readiness contract.
          }
          const api = (globalThis as typeof globalThis & {
            LocalArchiveExporter?: { inspect?: () => unknown };
            TeleArchiveExporter?: { inspect?: () => unknown };
          }).LocalArchiveExporter || (globalThis as typeof globalThis & {
            TeleArchiveExporter?: { inspect?: () => unknown };
          }).TeleArchiveExporter;
          const inspection = api?.inspect?.();
          if (!inspection || typeof inspection !== 'object') {
            return { ready: false, state: 'connector-not-injected' };
          }
          const value = inspection as {
            ready?: unknown;
            busy?: unknown;
            visibleMessages?: unknown;
          };
          return {
            ready: value.ready === true && value.busy !== true,
            state: value.ready === true ? 'ready' : `messages-${Math.max(0, Number(value.visibleMessages) || 0)}`,
          };
        },
      });
      const result = execution?.result as { ready?: unknown; state?: unknown } | undefined;
      lastState = String(result?.state || 'connector-not-ready');
      if (result?.ready === true) return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastState = /closed|no such tab|cannot access/iu.test(message)
        ? 'worker-tab-unavailable'
        : 'connector-starting';
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The background exporter did not receive a readable conversation (${lastState}).`);
}

async function notifyBackgroundSource(job: BackgroundJob, progress: BackgroundExportProgressMessage): Promise<void> {
  try {
    const response = await browser.tabs.sendMessage(job.sourceTabId, progress);
    if (response?.ok !== false) return;
  } catch {
    // Firefox can drop listeners created by a one-shot scripting injection
    // after a page lifecycle change. Re-inject and deliver through the same
    // extension isolated world below; persisted state remains the recovery
    // source if the tab has actually closed.
  }
  try {
    const connector = archiveConnectors.find((candidate) => candidate.id === job.connectorId);
    if (!connector) return;
    await browser.scripting.executeScript({
      target: { tabId: job.sourceTabId },
      files: [connector.entrypoint as '/telegram-exporter.js'],
    });
    await browser.scripting.executeScript({
      target: { tabId: job.sourceTabId },
      args: [{ progress, jobId: job.jobId, sourceTabId: job.sourceTabId, labels: job.labels }],
      func: (payload: {
        progress: BackgroundExportProgressMessage;
        jobId: string;
        sourceTabId: number;
        labels: QuickExportRequest['labels'];
      }) => {
        const api = (globalThis as typeof globalThis & {
          LocalArchiveExporter?: {
            beginBackgroundProgress?: (value: unknown) => unknown;
            backgroundProgress?: (value: unknown) => unknown;
          };
          TeleArchiveExporter?: {
            beginBackgroundProgress?: (value: unknown) => unknown;
            backgroundProgress?: (value: unknown) => unknown;
          };
        }).LocalArchiveExporter || (globalThis as typeof globalThis & {
          TeleArchiveExporter?: {
            beginBackgroundProgress?: (value: unknown) => unknown;
            backgroundProgress?: (value: unknown) => unknown;
          };
        }).TeleArchiveExporter;
        if (!api?.backgroundProgress) return { ok: false };
        api.beginBackgroundProgress?.({ jobId: payload.jobId, sourceTabId: payload.sourceTabId, labels: payload.labels });
        return api.backgroundProgress(payload.progress) || { ok: false };
      },
    });
  } catch {
    // The source tab may be closed or navigated away. The persisted job state
    // remains the recovery/readback source for the terminal result.
  }
}

async function startBackgroundExport(request: ReturnType<typeof normalizeBackgroundStartRequest>): Promise<BackgroundExportStartResponse> {
  const source = await browser.tabs.get(request.sourceTabId);
  const connector = archiveConnectors.find((candidate) => candidate.id === request.connectorId);
  const sourceUrl = String(source.url || request.sourceUrl);
  const detected = findArchiveConnector(sourceUrl);
  if (!source.id || !connector || !detected || detected.id !== connector.id) {
    return { ok: false, message: 'The source tab is no longer an authorized exporter tab.', reason: 'invalid' };
  }
  await waitForConnectorPermission(connector);
  const existing = await readBackgroundJob(request.jobId);
  if (existing && !existing.terminal) return { ok: true, jobId: request.jobId };
  await readBackgroundJobs();
  const duplicate = [...backgroundJobs.values()].find((job) => job.sourceTabId === request.sourceTabId && !job.terminal);
  if (duplicate) return { ok: false, message: 'An export is already running for this source tab.', reason: 'busy' };

  let workerTabId: number | null = null;
  const job: BackgroundJob = {
    jobId: request.jobId,
    sourceTabId: request.sourceTabId,
    sourceUrl,
    workerTabId: 0,
    connectorId: connector.id,
    phase: 'preparing',
    labels: request.request.labels,
    lastProgress: {
      type: BACKGROUND_EXPORT_PROGRESS_MESSAGE,
      jobId: request.jobId,
      phase: 'preparing',
      text: request.request.labels.preparing || 'Preparing export…',
      pct: 2,
      messages: 0,
    },
    updatedAt: Date.now(),
    terminal: false,
  };
  try {
    if (connector.id === 'telegram-web') await injectTelegramPageBridge(request.sourceTabId);
    const worker = await browser.tabs.create({
      url: sourceUrl,
      active: false,
      ...(Number.isInteger(source.windowId) ? { windowId: source.windowId } : {}),
    });
    if (!worker.id) throw new Error('Firefox did not create the background exporter tab.');
    workerTabId = worker.id;
    job.workerTabId = worker.id;
    job.lastProgress.workerTabId = job.workerTabId;
    await persistBackgroundJob(job);
    await notifyBackgroundSource(job, job.lastProgress);
    await waitForWorkerTab(worker.id);
    if (connector.id === 'telegram-web') await injectTelegramPageBridge(worker.id);
    await injectConnectorEntrypoint(worker.id, connector);
    await waitForWorkerExporterReady(worker.id);
    const [execution] = await browser.scripting.executeScript({
      target: { tabId: worker.id },
      args: [{ jobId: request.jobId, payload: request.request }],
      func: (payload: { jobId: string; payload: unknown }) => {
        (globalThis as typeof globalThis & { __LOCAL_ARCHIVE_BACKGROUND_JOB_ID__?: string }).__LOCAL_ARCHIVE_BACKGROUND_JOB_ID__ = payload.jobId;
        const api = (globalThis as typeof globalThis & {
          LocalArchiveExporter?: { isExporting?: () => boolean; quickExport?: (value: unknown) => unknown };
          TeleArchiveExporter?: { isExporting?: () => boolean; quickExport?: (value: unknown) => unknown };
        }).LocalArchiveExporter || (globalThis as typeof globalThis & {
          TeleArchiveExporter?: { isExporting?: () => boolean; quickExport?: (value: unknown) => unknown };
        }).TeleArchiveExporter;
        if (!api?.quickExport) return { accepted: false, reason: 'unavailable' };
        if (api.isExporting?.()) return { accepted: false, reason: 'busy' };
        void api.quickExport(payload.payload);
        return { accepted: true };
      },
    });
    const result = execution?.result as { accepted?: boolean; reason?: string } | undefined;
    if (!result?.accepted) throw new Error(`The background exporter was not accepted (${result?.reason || 'unknown'}).`);
    return { ok: true, jobId: request.jobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The background exporter could not start.';
    job.phase = 'error';
    job.terminal = true;
    job.updatedAt = Date.now();
    job.lastProgress = {
      type: BACKGROUND_EXPORT_PROGRESS_MESSAGE,
      jobId: job.jobId,
      phase: 'error',
      text: message,
      pct: 100,
      messages: 0,
      workerTabId: job.workerTabId || undefined,
      errorCode: 'background-start-failed',
    };
    try { await persistBackgroundJob(job); } catch {}
    await notifyBackgroundSource(job, job.lastProgress);
    if (workerTabId) {
      try { await browser.tabs.remove(workerTabId); } catch {}
    }
    scheduleBackgroundJobCleanup(job);
    const failure: BackgroundExportStartFailure = { ok: false, message, reason: 'start-failed' };
    return failure;
  }
}

function normalizeBackgroundStartRequest(value: unknown) {
  if (!isBackgroundExportStartRequest(value)) throw new Error('Invalid background export request.');
  return value;
}

async function handleBackgroundProgress(
  message: BackgroundExportProgressMessage,
  sender: Browser.runtime.MessageSender,
): Promise<{ ok: boolean }> {
  const job = await readBackgroundJob(message.jobId);
  if (!job || sender.tab?.id !== job.workerTabId) return { ok: false };
  // A throttled reading update may arrive after the worker has already sent
  // its terminal receipt. Never let that stale packet reopen a finished job.
  if (job.terminal) return { ok: true };
  const normalizedMessage: BackgroundExportProgressMessage = {
    ...message,
    workerTabId: message.workerTabId || job.workerTabId,
  };
  job.phase = normalizedMessage.phase;
  job.lastProgress = normalizedMessage;
  job.updatedAt = Date.now();
  job.terminal = normalizedMessage.phase === 'complete' || normalizedMessage.phase === 'error';
  await persistBackgroundJob(job);
  await notifyBackgroundSource(job, normalizedMessage);
  if (job.terminal) {
    // The worker tab exists only for history collection. Once the terminal
    // receipt has reached the source tab, remove it synchronously so it never
    // lingers in the user's tab strip after a completed export.
    try { await browser.tabs.remove(job.workerTabId); } catch {}
    scheduleBackgroundJobCleanup(job);
  }
  return { ok: true };
}

async function handleBackgroundStatus(sender: Browser.runtime.MessageSender): Promise<BackgroundExportStatusResponse> {
  const sourceTabId = sender.tab?.id;
  if (!sourceTabId || !isAuthorizedConnectorSender(sender.url || sender.tab?.url)) return { ok: true };
  let currentUrl = String(sender.url || sender.tab?.url || '');
  if (!currentUrl) {
    try { currentUrl = String((await browser.tabs.get(sourceTabId)).url || ''); } catch {}
  }
  const candidates = (await readBackgroundJobs())
    .filter((job) => job.sourceTabId === sourceTabId && sourceIdentity(job.sourceUrl) === sourceIdentity(currentUrl))
    .sort((left, right) => right.updatedAt - left.updatedAt);
  const job = candidates[0];
  if (!job) return { ok: true };
  return {
    ok: true,
    jobId: job.jobId,
    sourceTabId: job.sourceTabId,
    labels: job.labels,
    progress: job.lastProgress,
  };
}

async function handleBackgroundCancel(
  request: ReturnType<typeof normalizeBackgroundCancelRequest>,
  sender: Browser.runtime.MessageSender,
): Promise<BackgroundExportCancelResponse> {
  const sourceSender = sender.id === browser.runtime.id
    && sender.tab?.id === request.sourceTabId
    && isAuthorizedConnectorSender(sender.url || sender.tab.url);
  if (!internalExtensionSender(sender) && !sourceSender) {
    return { ok: false, message: 'The cancellation sender is not authorized.' };
  }
  const job = await readBackgroundJob(request.jobId);
  if (!job || job.sourceTabId !== request.sourceTabId || job.terminal) return { ok: false, message: 'The background export is no longer running.' };
  try {
    await browser.tabs.sendMessage(job.workerTabId, {
      type: BACKGROUND_EXPORT_CANCEL_MESSAGE,
      jobId: job.jobId,
    });
    return { ok: true };
  } catch {
    return { ok: false, message: 'The background exporter tab is no longer available.' };
  }
}

function normalizeBackgroundCancelRequest(value: unknown) {
  if (!isBackgroundExportCancelRequest(value)) throw new Error('Invalid background cancellation request.');
  return value;
}

async function persistBinding(binding: ExactDownloadRequest): Promise<void> {
  liveBindings.set(binding.downloadId, binding);
  await browser.storage.session.set({ [bindingKey(binding.downloadId)]: binding });
}

async function readBinding(downloadId: number): Promise<ExactDownloadRequest | null> {
  const live = liveBindings.get(downloadId);
  if (live) return live;
  const stored = await browser.storage.session.get(bindingKey(downloadId));
  const value = stored[bindingKey(downloadId)] as ExactDownloadRequest | undefined;
  if (!value || value.downloadId !== downloadId) return null;
  liveBindings.set(downloadId, value);
  return value;
}

function sameBinding(left: ExactDownloadRequest, right: ExactDownloadRequest): boolean {
  return left.requestId === right.requestId
    && left.artifactId === right.artifactId
    && left.downloadId === right.downloadId
    && left.filename === right.filename
    && left.size === right.size;
}

async function findExactDownload(request: ExactDownloadRequest) {
  const binding = await readBinding(request.downloadId);
  if (!binding || !sameBinding(binding, request)) return null;
  const [item] = await browser.downloads.search({ id: request.downloadId });
  if (!item || !matchesArchiveFilename(basename(item.filename), request.filename)) return null;
  return item;
}

async function saveArchive(request: ArchiveSaveRequest): Promise<ArchiveSaveResponse> {
  let actualArtifactId: string;
  try {
    actualArtifactId = await sha256Hex(request.blob);
  } catch {
    return {
      ok: false,
      requestId: request.requestId,
      artifactId: request.artifactId,
      message: 'The archive bytes could not be hashed before saving.',
    };
  }
  if (actualArtifactId !== request.artifactId) {
    return {
      ok: false,
      requestId: request.requestId,
      artifactId: request.artifactId,
      message: 'The archive bytes no longer match the Rust validation receipt.',
    };
  }
  const objectUrl = URL.createObjectURL(request.blob);
  try {
    const downloadId = await browser.downloads.download({
      url: objectUrl,
      filename: request.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    const binding: ExactDownloadRequest = {
      requestId: request.requestId,
      artifactId: request.artifactId,
      downloadId,
      filename: request.filename,
      size: request.validation.size,
    };
    await persistBinding(binding);
    activeObjectUrls.set(downloadId, objectUrl);
    setTimeout(() => {
      if (activeObjectUrls.get(downloadId) === objectUrl) {
        activeObjectUrls.delete(downloadId);
        URL.revokeObjectURL(objectUrl);
      }
    }, 300_000);
    return { ok: true, ...binding };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    return {
      ok: false,
      requestId: request.requestId,
      artifactId: request.artifactId,
      message: error instanceof Error ? error.message : 'Firefox could not start the ZIP download.',
    };
  }
}

async function showRequestedDownload(request: ShowDownloadRequest): Promise<ShowDownloadResponse> {
  try {
    const item = await findExactDownload(request);
    if (item) {
      await browser.downloads.show(item.id);
      return { ok: true, requestId: request.requestId, mode: 'file' };
    }
    await browser.downloads.showDefaultFolder();
    return { ok: true, requestId: request.requestId, mode: 'folder' };
  } catch {
    return {
      ok: false,
      requestId: request.requestId,
      message: 'The downloaded ZIP could not be shown.',
    };
  }
}

async function getRequestedDownloadStatus(request: DownloadStatusRequest): Promise<DownloadStatusResponse> {
  try {
    const item = await findExactDownload(request);
    if (!item) {
      return {
        ok: true,
        requestId: request.requestId,
        artifactId: request.artifactId,
        downloadId: request.downloadId,
        found: false,
      };
    }
    const totalBytes = Math.max(0, Number(item.totalBytes) || 0);
    const bytesReceived = Math.max(0, Number(item.bytesReceived) || 0);
    const actualSize = totalBytes || bytesReceived;
    if (item.state === 'complete' && actualSize !== request.size) {
      return {
        ok: false,
        requestId: request.requestId,
        artifactId: request.artifactId,
        downloadId: request.downloadId,
        found: true,
        message: 'Firefox completed a download whose size differs from the bound archive.',
      };
    }
    return {
      ok: true,
      requestId: request.requestId,
      artifactId: request.artifactId,
      downloadId: request.downloadId,
      found: true,
      filename: basename(item.filename),
      size: actualSize || request.size,
      state: item.state,
      bytesReceived,
      totalBytes,
    };
  } catch {
    return {
      ok: false,
      requestId: request.requestId,
      artifactId: request.artifactId,
      downloadId: request.downloadId,
      found: false,
      message: 'The Firefox download state could not be read.',
    };
  }
}

export default defineBackground(() => {
  browser.downloads.onChanged.addListener((delta) => {
    if (!delta.state || !['complete', 'interrupted'].includes(delta.state.current || '')) return;
    const objectUrl = activeObjectUrls.get(delta.id);
    if (!objectUrl) return;
    activeObjectUrls.delete(delta.id);
    URL.revokeObjectURL(objectUrl);
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    for (const job of backgroundJobs.values()) {
      if (job.terminal) continue;
      if (job.sourceTabId === tabId) {
        // There is no longer a consumer for progress or the terminal receipt.
        // Stop the extension-owned worker instead of leaving a hidden export
        // running after the user closes the source tab.
        job.phase = 'error';
        job.terminal = true;
        job.updatedAt = Date.now();
        job.lastProgress = {
          type: BACKGROUND_EXPORT_PROGRESS_MESSAGE,
          jobId: job.jobId,
          phase: 'error',
          text: 'The source tab closed before the archive was saved.',
          pct: 100,
          messages: job.lastProgress.messages,
          workerTabId: job.workerTabId || undefined,
          errorCode: 'source-tab-closed',
        };
        void (async () => {
          try { await persistBackgroundJob(job); } catch {}
          try {
            await browser.tabs.sendMessage(job.workerTabId, {
              type: BACKGROUND_EXPORT_CANCEL_MESSAGE,
              jobId: job.jobId,
            });
          } catch {}
          try { await browser.tabs.remove(job.workerTabId); } catch {}
          scheduleBackgroundJobCleanup(job);
        })();
        continue;
      }
      if (job.workerTabId !== tabId) continue;
      job.phase = 'error';
      job.terminal = true;
      job.updatedAt = Date.now();
      job.lastProgress = {
        type: BACKGROUND_EXPORT_PROGRESS_MESSAGE,
        jobId: job.jobId,
        phase: 'error',
        text: 'The background exporter tab closed before the archive was saved.',
        pct: 100,
        messages: job.lastProgress.messages,
        errorCode: 'background-tab-closed',
      };
      void persistBackgroundJob(job)
        .then(() => notifyBackgroundSource(job, job.lastProgress))
        .then(() => scheduleBackgroundJobCleanup(job))
        .catch(() => undefined);
    }
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    if (isBackgroundExportStartRequest(message)) {
      if (!internalExtensionSender(sender)) {
        return Promise.resolve<BackgroundExportStartResponse>({ ok: false, message: 'The background export request is not authorized.' });
      }
      return startBackgroundExport(normalizeBackgroundStartRequest(message));
    }
    if (isBackgroundExportCancelRequest(message)) {
      return handleBackgroundCancel(normalizeBackgroundCancelRequest(message), sender);
    }
    if (isBackgroundExportProgressMessage(message)) {
      return handleBackgroundProgress(message, sender);
    }
    if (isBackgroundExportStatusRequest(message)) {
      return handleBackgroundStatus(sender);
    }
    const authorized = sender.id === browser.runtime.id
      && sender.tab?.id != null
      && isAuthorizedConnectorSender(sender.url || sender.tab.url);
    if (isDownloadStatusRequest(message)) {
      if (!authorized) {
        return Promise.resolve<DownloadStatusResponse>({
          ok: false,
          requestId: message.requestId,
          artifactId: message.artifactId,
          downloadId: message.downloadId,
          found: false,
          message: 'The request did not come from an authorized source tab.',
        });
      }
      return getRequestedDownloadStatus(message);
    }
    if (isShowDownloadRequest(message)) {
      if (!authorized) {
        return Promise.resolve<ShowDownloadResponse>({
          ok: false,
          requestId: message.requestId,
          message: 'The request did not come from an authorized source tab.',
        });
      }
      return showRequestedDownload(message);
    }
    if (isArchiveSaveRequest(message)) {
      if (!authorized) {
        return Promise.resolve<ArchiveSaveResponse>({
          ok: false,
          requestId: message.requestId,
          artifactId: message.artifactId,
          message: 'The save request did not come from an authorized source tab.',
        });
      }
      return saveArchive(message);
    }
    if (isArchiveVerifyRequest(message)) {
      if (!authorized) {
        return Promise.resolve<ArchiveVerifyResponse>({
          ok: false,
          requestId: message.requestId,
          code: 'invalid-request',
          message: 'The verification request did not come from an authorized source tab.',
        });
      }
      return verifyArchiveFromRequest(message);
    }
    if (!isArchiveCreateRequest(message)) return undefined;
    if (!authorized) {
      return Promise.resolve({
        ok: false,
        requestId: message.requestId,
        code: 'invalid-request',
        message: 'The archive request did not come from an authorized source tab.',
      });
    }
    return createArchiveFromRequest(message);
  });
});
