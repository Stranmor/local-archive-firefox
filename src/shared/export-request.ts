export type ExportRange =
  | { mode: 'recent'; count: number }
  | { mode: 'dates'; from: string; to: string }
  | { mode: 'all' };

export type ExportFormat = 'both' | 'html' | 'json';

export interface QuickExportLabels {
  title: string;
  preparing: string;
  reading: string;
  saving: string;
  saved: string;
  failed: string;
  emptyRange: string;
  messages: string;
  mediaSkipped: string;
  cancel: string;
  close: string;
  showFile: string;
  keepOpen: string;
  elapsed: string;
  file: string;
}

export interface QuickExportRequest {
  format: ExportFormat;
  includeMedia: boolean;
  locale: string;
  range: ExportRange;
  labels: QuickExportLabels;
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    normalizeExportRangeInRust<ExportRange>({ mode: 'dates', from: value, to: value });
    return true;
  } catch {
    return false;
  }
}

export function normalizeExportRange(value: unknown): ExportRange {
  return normalizeExportRangeInRust<ExportRange>(value);
}

export function normalizeQuickExportRequest(value: unknown): QuickExportRequest {
  return normalizeQuickExportRequestInRust<QuickExportRequest>(value);
}
import {
  normalizeExportRangeInRust,
  normalizeQuickExportRequestInRust,
} from '@/src/rust/core';
