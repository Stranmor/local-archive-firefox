import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { browser } from 'wxt/browser';
import { telegramWebConnector } from '@/src/connectors/telegram-web';
import {
  BACKGROUND_EXPORT_CANCEL_MESSAGE,
  BACKGROUND_EXPORT_STATUS_MESSAGE,
  isBackgroundExportProgressMessage,
  type BackgroundExportStatusResponse,
} from '@/src/shared/background-export-protocol';
import {
  filterMessagesForRangeInRust,
  normalizeExportRangeInRust,
  normalizePreferencesInRust,
  normalizeQuickExportRequestInRust,
  RustExportSession,
  validateArchivePasswordInRust,
  rustCoreVersion,
} from '@/src/rust/core';
import { TeleArchiveRemoteZip } from '@/src/shared/archive-client';
import exporterCss from '@/src/exporter.css?inline';
import universalExporterCss from '@/src/exporter-universal.css?inline';
import {
  collectTelegramNativeHistory,
  downloadTelegramNativeMedia,
  inspectTelegramNativeHistory,
} from '@/src/connectors/telegram-native-history';

const TELEGRAM_ORIGIN = 'https://web.telegram.org';

export default defineUnlistedScript({
  async main() {
    if (location.origin !== TELEGRAM_ORIGIN) {
      return { status: 'unsupported-page' as const };
    }

    const runtime = globalThis as unknown as {
      JSZip?: typeof TeleArchiveRemoteZip;
      __TELEARCHIVE_EXTENSION_LOADED__?: boolean;
      __TELEARCHIVE_UI_CSS__?: string;
      __LOCAL_ARCHIVE_UI_CSS__?: string;
      __LOCAL_ARCHIVE_CONNECTOR__?: typeof telegramWebConnector;
      __LOCAL_ARCHIVE_RUST_CORE__?: {
        version: string;
        normalizeExportRange: typeof normalizeExportRangeInRust;
        normalizePreferences: typeof normalizePreferencesInRust;
        normalizeQuickExportRequest: typeof normalizeQuickExportRequestInRust;
        filterMessagesForRange: typeof filterMessagesForRangeInRust;
        createExportSession: (request: unknown) => RustExportSession;
        validateArchivePassword: (value: string) => void;
      };
      __LOCAL_ARCHIVE_RUNTIME_LISTENER__?: boolean;
      __LOCAL_ARCHIVE_TELEGRAM_NATIVE__?: {
        inspect: typeof inspectTelegramNativeHistory;
        collect: typeof collectTelegramNativeHistory;
        downloadMedia: typeof downloadTelegramNativeMedia;
      };
    };
    runtime.JSZip = TeleArchiveRemoteZip;
    runtime.__TELEARCHIVE_UI_CSS__ = exporterCss;
    runtime.__LOCAL_ARCHIVE_UI_CSS__ = universalExporterCss;
    runtime.__LOCAL_ARCHIVE_CONNECTOR__ = telegramWebConnector;
    runtime.__LOCAL_ARCHIVE_RUST_CORE__ = Object.freeze({
      version: rustCoreVersion(),
      normalizeExportRange: normalizeExportRangeInRust,
      normalizePreferences: normalizePreferencesInRust,
      normalizeQuickExportRequest: normalizeQuickExportRequestInRust,
      filterMessagesForRange: filterMessagesForRangeInRust,
      createExportSession: (request: unknown) => new RustExportSession(request),
      validateArchivePassword: validateArchivePasswordInRust,
    });
    runtime.__LOCAL_ARCHIVE_TELEGRAM_NATIVE__ = Object.freeze({
      inspect: inspectTelegramNativeHistory,
      collect: collectTelegramNativeHistory,
      downloadMedia: downloadTelegramNativeMedia,
    });

    if (!runtime.__TELEARCHIVE_EXTENSION_LOADED__) {
      await import('../telegram-chat-exporter-hardened.user.js');
      runtime.__TELEARCHIVE_EXTENSION_LOADED__ = true;
    }
    if (!runtime.__LOCAL_ARCHIVE_RUNTIME_LISTENER__) {
      browser.runtime.onMessage.addListener((message) => {
        const api = (globalThis as typeof globalThis & {
          LocalArchiveExporter?: {
            backgroundProgress?: (value: unknown) => unknown;
            restoreBackgroundProgress?: (value: unknown) => unknown;
            backgroundJobId?: () => string;
            cancel?: () => unknown;
          };
          TeleArchiveExporter?: {
            backgroundProgress?: (value: unknown) => unknown;
            restoreBackgroundProgress?: (value: unknown) => unknown;
            backgroundJobId?: () => string;
            cancel?: () => unknown;
          };
        }).LocalArchiveExporter || (globalThis as typeof globalThis & {
          TeleArchiveExporter?: {
            backgroundProgress?: (value: unknown) => unknown;
            restoreBackgroundProgress?: (value: unknown) => unknown;
            backgroundJobId?: () => string;
            cancel?: () => unknown;
          };
        }).TeleArchiveExporter;
        if (isBackgroundExportProgressMessage(message)) {
          return Promise.resolve(api?.backgroundProgress?.(message) ?? { ok: false });
        }
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === BACKGROUND_EXPORT_CANCEL_MESSAGE) {
          const jobId = String((message as { jobId?: unknown }).jobId || '');
          if (jobId && api?.backgroundJobId?.() === jobId) {
            api.cancel?.();
            return Promise.resolve({ ok: true });
          }
        }
        return undefined;
      });
      runtime.__LOCAL_ARCHIVE_RUNTIME_LISTENER__ = true;
    }
    void browser.runtime.sendMessage({ type: BACKGROUND_EXPORT_STATUS_MESSAGE }).then((response: BackgroundExportStatusResponse) => {
      if (!response?.ok || !response.jobId || !response.progress) return;
      const api = (globalThis as typeof globalThis & {
        LocalArchiveExporter?: { restoreBackgroundProgress?: (value: unknown) => unknown };
        TeleArchiveExporter?: { restoreBackgroundProgress?: (value: unknown) => unknown };
      }).LocalArchiveExporter || (globalThis as typeof globalThis & {
        TeleArchiveExporter?: { restoreBackgroundProgress?: (value: unknown) => unknown };
      }).TeleArchiveExporter;
      api?.restoreBackgroundProgress?.(response);
    }).catch(() => undefined);
    return { status: 'ready' as const };
  },
});
