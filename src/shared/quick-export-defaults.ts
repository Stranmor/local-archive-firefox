import { browser } from 'wxt/browser';
import { normalizeQuickExportDefaultsInRust } from '@/src/rust/core';
import type { ExportFormat } from './export-request';

export const QUICK_EXPORT_DEFAULTS_KEY = 'localArchive.quickExportDefaults.v1';

export interface QuickExportDefaults {
  format: ExportFormat;
  includeMedia: boolean;
  recentCount: number;
}

export const DEFAULT_QUICK_EXPORT_DEFAULTS: QuickExportDefaults = Object.freeze({
  format: 'both',
  includeMedia: true,
  recentCount: 500,
});

export function normalizeQuickExportDefaults(value: unknown): QuickExportDefaults {
  return normalizeQuickExportDefaultsInRust<QuickExportDefaults>(value);
}

export async function loadQuickExportDefaults(): Promise<QuickExportDefaults> {
  const stored = await browser.storage.local.get(QUICK_EXPORT_DEFAULTS_KEY);
  return normalizeQuickExportDefaults(stored[QUICK_EXPORT_DEFAULTS_KEY]);
}

export async function saveQuickExportDefaults(value: QuickExportDefaults): Promise<QuickExportDefaults> {
  const normalized = normalizeQuickExportDefaults(value);
  await browser.storage.local.set({ [QUICK_EXPORT_DEFAULTS_KEY]: normalized });
  return normalized;
}

export async function resetQuickExportDefaults(): Promise<QuickExportDefaults> {
  await browser.storage.local.remove(QUICK_EXPORT_DEFAULTS_KEY);
  return { ...DEFAULT_QUICK_EXPORT_DEFAULTS };
}
