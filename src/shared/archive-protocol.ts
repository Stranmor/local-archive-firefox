import { matchesArchiveFilenameInRust } from '@/src/rust/core';

export const ARCHIVE_CREATE_MESSAGE = 'telearchive.archive.create.v1' as const;
export const ARCHIVE_VERIFY_MESSAGE = 'telearchive.archive.verify.v1' as const;
export const ARCHIVE_SAVE_MESSAGE = 'telearchive.archive.save.v1' as const;
export const SHOW_DOWNLOAD_MESSAGE = 'telearchive.ui.show-download.v1' as const;
export const DOWNLOAD_STATUS_MESSAGE = 'telearchive.ui.download-status.v1' as const;

export type ArchiveWireContent = string | Blob | ArrayBuffer | Uint8Array;

export interface ArchiveWireEntry {
  name: string;
  content: ArchiveWireContent;
  base64: boolean;
}

export interface ArchiveCreateRequest {
  type: typeof ARCHIVE_CREATE_MESSAGE;
  requestId: string;
  compressionLevel: number;
  password: string | null;
  entries: ArchiveWireEntry[];
}

export interface ArchiveValidation {
  requestId: string;
  artifactId: string;
  size: number;
  structureVerified: true;
  entryCount: number;
  reportReadable: true;
  encrypted: boolean;
  partial: boolean;
  messagesIncluded: number;
}

export interface ArchiveSaveRequest {
  type: typeof ARCHIVE_SAVE_MESSAGE;
  requestId: string;
  artifactId: string;
  blob: Blob;
  filename: string;
  validation: ArchiveValidation;
}

export interface ExactDownloadRequest {
  requestId: string;
  artifactId: string;
  downloadId: number;
  filename: string;
  size: number;
}

export interface ShowDownloadRequest extends ExactDownloadRequest {
  type: typeof SHOW_DOWNLOAD_MESSAGE;
}

export interface DownloadStatusRequest extends ExactDownloadRequest {
  type: typeof DOWNLOAD_STATUS_MESSAGE;
}

export interface ArchiveVerifyRequest {
  type: typeof ARCHIVE_VERIFY_MESSAGE;
  requestId: string;
  blob: Blob;
  filename: string;
  expectedFilename: string;
  password: string | null;
}

export interface ArchiveSaveSuccess extends ExactDownloadRequest {
  ok: true;
}

export interface ArchiveSaveFailure {
  ok: false;
  requestId: string;
  artifactId: string;
  message: string;
}

export type ArchiveSaveResponse = ArchiveSaveSuccess | ArchiveSaveFailure;

export interface ShowDownloadResponse {
  ok: boolean;
  requestId: string;
  mode?: 'file' | 'folder';
  message?: string;
}

export interface DownloadStatusResponse {
  ok: boolean;
  requestId: string;
  artifactId: string;
  downloadId: number;
  found: boolean;
  filename?: string;
  size?: number;
  state?: 'in_progress' | 'complete' | 'interrupted';
  bytesReceived?: number;
  totalBytes?: number;
  message?: string;
}

export type ArchiveErrorCode =
  | 'invalid-request'
  | 'invalid-entry'
  | 'archive-engine-failed';

export type ArchiveVerifyErrorCode =
  | 'invalid-request'
  | 'filename-mismatch'
  | 'password-required'
  | 'wrong-password'
  | 'not-telearchive'
  | 'verification-limit'
  | 'archive-engine-failed';

const ARCHIVE_ERROR_CODES = new Set<ArchiveErrorCode>([
  'invalid-request',
  'invalid-entry',
  'archive-engine-failed',
]);

export interface ArchiveCreateSuccess {
  ok: true;
  requestId: string;
  blob: Blob;
  size: number;
  entryCount: number;
  encrypted: boolean;
  validation: ArchiveValidation;
}

export interface ArchiveCreateFailure {
  ok: false;
  requestId: string;
  code: ArchiveErrorCode;
  message: string;
}

export type ArchiveCreateResponse = ArchiveCreateSuccess | ArchiveCreateFailure;

export interface ArchiveVerifyReport {
  outputsVerified: true;
  reportReadable: true;
  chatsIncluded: number;
  messagesIncluded: number;
  mediaIncluded: number;
  partial: boolean;
  htmlFiles: number;
  resultJsonFiles: number;
}

export interface ArchiveVerifySuccess {
  ok: true;
  requestId: string;
  filename: string;
  size: number;
  entryCount: number;
  encrypted: boolean;
  report: ArchiveVerifyReport;
}

export interface ArchiveVerifyFailure {
  ok: false;
  requestId: string;
  code: ArchiveVerifyErrorCode;
  message: string;
}

export type ArchiveVerifyResponse = ArchiveVerifySuccess | ArchiveVerifyFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSafeBasename(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 255
    && !value.includes('/')
    && !value.includes('\\');
}

function isArchiveValidation(value: unknown): value is ArchiveValidation {
  if (!isRecord(value)) return false;
  return typeof value.requestId === 'string'
    && typeof value.artifactId === 'string'
    && Number.isInteger(value.size)
    && Number(value.size) > 0
    && value.structureVerified === true
    && Number.isInteger(value.entryCount)
    && Number(value.entryCount) > 0
    && value.reportReadable === true
    && typeof value.encrypted === 'boolean'
    && typeof value.partial === 'boolean'
    && Number.isInteger(value.messagesIncluded)
    && Number(value.messagesIncluded) >= 0;
}

function isExactDownloadRequest(value: unknown): value is ExactDownloadRequest {
  if (!isRecord(value)) return false;
  return typeof value.requestId === 'string'
    && typeof value.artifactId === 'string'
    && Number.isInteger(value.downloadId)
    && Number(value.downloadId) > 0
    && isSafeBasename(value.filename)
    && Number.isInteger(value.size)
    && Number(value.size) > 0;
}

export function isArchiveErrorCode(value: unknown): value is ArchiveErrorCode {
  return typeof value === 'string' && ARCHIVE_ERROR_CODES.has(value as ArchiveErrorCode);
}

export function isArchiveCreateRequest(value: unknown): value is ArchiveCreateRequest {
  if (!isRecord(value)) return false;
  return value.type === ARCHIVE_CREATE_MESSAGE
    && typeof value.requestId === 'string'
    && typeof value.compressionLevel === 'number'
    && (value.password === null || typeof value.password === 'string')
    && Array.isArray(value.entries);
}

export function matchesArchiveFilename(actualName: string, requestedName: string): boolean {
  return matchesArchiveFilenameInRust(actualName, requestedName);
}

export function isArchiveVerifyRequest(value: unknown): value is ArchiveVerifyRequest {
  if (!isRecord(value)) return false;
  return value.type === ARCHIVE_VERIFY_MESSAGE
    && typeof value.requestId === 'string'
    && value.blob instanceof Blob
    && typeof value.filename === 'string'
    && typeof value.expectedFilename === 'string'
    && (value.password === null || typeof value.password === 'string');
}

export function isArchiveSaveRequest(value: unknown): value is ArchiveSaveRequest {
  if (!isRecord(value)) return false;
  return value.type === ARCHIVE_SAVE_MESSAGE
    && typeof value.requestId === 'string'
    && typeof value.artifactId === 'string'
    && value.blob instanceof Blob
    && isSafeBasename(value.filename)
    && isArchiveValidation(value.validation)
    && value.requestId === value.validation.requestId
    && value.artifactId === value.validation.artifactId
    && value.blob.size === value.validation.size;
}

export function isShowDownloadRequest(value: unknown): value is ShowDownloadRequest {
  return isRecord(value) && value.type === SHOW_DOWNLOAD_MESSAGE && isExactDownloadRequest(value);
}

export function isDownloadStatusRequest(value: unknown): value is DownloadStatusRequest {
  return isRecord(value) && value.type === DOWNLOAD_STATUS_MESSAGE && isExactDownloadRequest(value);
}

export function isArchiveVerifyResponse(value: unknown): value is ArchiveVerifyResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || typeof value.requestId !== 'string') return false;
  if (!value.ok) return typeof value.code === 'string' && typeof value.message === 'string';
  return typeof value.filename === 'string'
    && Number.isInteger(value.size)
    && Number(value.size) > 0
    && Number.isInteger(value.entryCount)
    && Number(value.entryCount) > 0
    && typeof value.encrypted === 'boolean'
    && isRecord(value.report)
    && value.report.outputsVerified === true
    && value.report.reportReadable === true
    && Number.isInteger(value.report.chatsIncluded)
    && Number.isInteger(value.report.messagesIncluded)
    && Number.isInteger(value.report.mediaIncluded)
    && typeof value.report.partial === 'boolean'
    && Number.isInteger(value.report.htmlFiles)
    && Number.isInteger(value.report.resultJsonFiles);
}

export function isArchiveCreateResponse(value: unknown): value is ArchiveCreateResponse {
  if (!isRecord(value) || typeof value.ok !== 'boolean' || typeof value.requestId !== 'string') return false;
  if (!value.ok) return isArchiveErrorCode(value.code) && typeof value.message === 'string';
  return value.blob instanceof Blob
    && Number.isInteger(value.size)
    && value.size === value.blob.size
    && Number.isInteger(value.entryCount)
    && Number(value.entryCount) > 0
    && typeof value.encrypted === 'boolean'
    && isArchiveValidation(value.validation)
    && value.validation.requestId === value.requestId
    && value.validation.size === value.size
    && value.validation.entryCount === value.entryCount
    && value.validation.encrypted === value.encrypted;
}

export function isArchiveSaveResponse(value: unknown): value is ArchiveSaveResponse {
  if (!isRecord(value)
    || typeof value.ok !== 'boolean'
    || typeof value.requestId !== 'string'
    || typeof value.artifactId !== 'string') return false;
  if (!value.ok) return typeof value.message === 'string';
  return isExactDownloadRequest(value);
}
