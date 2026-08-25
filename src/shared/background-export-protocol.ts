import type { QuickExportRequest } from './export-request';

export const BACKGROUND_EXPORT_START_MESSAGE = 'telearchive.background-export.start.v1' as const;
export const BACKGROUND_EXPORT_CANCEL_MESSAGE = 'telearchive.background-export.cancel.v1' as const;
export const BACKGROUND_EXPORT_PROGRESS_MESSAGE = 'telearchive.background-export.progress.v1' as const;
export const BACKGROUND_EXPORT_STATUS_MESSAGE = 'telearchive.background-export.status.v1' as const;

export type BackgroundExportPhase = 'preparing' | 'reading' | 'saving' | 'complete' | 'error';

export interface BackgroundExportStartRequest {
  type: typeof BACKGROUND_EXPORT_START_MESSAGE;
  jobId: string;
  sourceTabId: number;
  sourceUrl: string;
  connectorId: string;
  request: QuickExportRequest;
}

export interface BackgroundExportCancelRequest {
  type: typeof BACKGROUND_EXPORT_CANCEL_MESSAGE;
  jobId: string;
  sourceTabId: number;
}

export interface BackgroundExportReceipt {
  requestId: string;
  artifactId: string;
  downloadId: number;
  filename: string;
  size: number;
  state: 'complete';
}

export interface BackgroundExportProgressMessage {
  type: typeof BACKGROUND_EXPORT_PROGRESS_MESSAGE;
  jobId: string;
  phase: BackgroundExportPhase;
  text: string;
  pct: number;
  messages: number;
  workerTabId?: number;
  receipt?: BackgroundExportReceipt;
  stats?: Record<string, unknown>;
  errorCode?: string;
}

export interface BackgroundExportStatusRequest {
  type: typeof BACKGROUND_EXPORT_STATUS_MESSAGE;
}

export interface BackgroundExportStatusResponse {
  ok: true;
  jobId?: string;
  sourceTabId?: number;
  labels?: QuickExportRequest['labels'];
  progress?: BackgroundExportProgressMessage;
}

export interface BackgroundExportStartSuccess {
  ok: true;
  jobId: string;
}

export interface BackgroundExportStartFailure {
  ok: false;
  message: string;
  reason?: 'busy' | 'invalid' | 'start-failed';
}

export type BackgroundExportStartResponse = BackgroundExportStartSuccess | BackgroundExportStartFailure;

export interface BackgroundExportCancelResponse {
  ok: boolean;
  message?: string;
}

export function isBackgroundExportStartRequest(value: unknown): value is BackgroundExportStartRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<BackgroundExportStartRequest>;
  return candidate.type === BACKGROUND_EXPORT_START_MESSAGE
    && typeof candidate.jobId === 'string'
    && /^[A-Za-z0-9._:-]{8,160}$/u.test(candidate.jobId)
    && Number.isInteger(candidate.sourceTabId)
    && Number(candidate.sourceTabId) > 0
    && typeof candidate.sourceUrl === 'string'
    && /^https:\/\//u.test(candidate.sourceUrl)
    && candidate.sourceUrl.length <= 4096
    && typeof candidate.connectorId === 'string'
    && candidate.connectorId.length > 0
    && Boolean(candidate.request && typeof candidate.request === 'object');
}

export function isBackgroundExportCancelRequest(value: unknown): value is BackgroundExportCancelRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<BackgroundExportCancelRequest>;
  return candidate.type === BACKGROUND_EXPORT_CANCEL_MESSAGE
    && typeof candidate.jobId === 'string'
    && /^[A-Za-z0-9._:-]{8,160}$/u.test(candidate.jobId)
    && Number.isInteger(candidate.sourceTabId)
    && Number(candidate.sourceTabId) > 0;
}

export function isBackgroundExportProgressMessage(value: unknown): value is BackgroundExportProgressMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<BackgroundExportProgressMessage>;
  return candidate.type === BACKGROUND_EXPORT_PROGRESS_MESSAGE
    && typeof candidate.jobId === 'string'
    && /^[A-Za-z0-9._:-]{8,160}$/u.test(candidate.jobId)
    && ['preparing', 'reading', 'saving', 'complete', 'error'].includes(String(candidate.phase))
    && typeof candidate.text === 'string'
    && candidate.text.length <= 2000
    && Number.isFinite(Number(candidate.pct))
    && Number(candidate.pct) >= 0
    && Number(candidate.pct) <= 100
    && Number.isInteger(candidate.messages)
    && Number(candidate.messages) >= 0
    && (candidate.workerTabId === undefined
      || (Number.isInteger(candidate.workerTabId) && Number(candidate.workerTabId) > 0));
}

export function isBackgroundExportStatusRequest(value: unknown): value is BackgroundExportStatusRequest {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Partial<BackgroundExportStatusRequest>).type === BACKGROUND_EXPORT_STATUS_MESSAGE;
}
