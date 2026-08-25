import { browser } from 'wxt/browser';
import { normalizePreferencesInRust } from '@/src/rust/core';

export const PREFERENCES_KEY = 'telearchive.preferences.v1';

export interface ExportPreferences {
  onboardingCompleted: boolean;
  formatHtml: boolean;
  formatJson: boolean;
  exportPhotos: boolean;
  exportVideos: boolean;
  exportVoice: boolean;
  exportStickers: boolean;
  exportFiles: boolean;
  maxPhotoSizeMb: number;
  maxVideoSizeMb: number;
  maxFileSizeMb: number;
}

export const DEFAULT_PREFERENCES: ExportPreferences = Object.freeze({
  onboardingCompleted: false,
  formatHtml: true,
  formatJson: true,
  exportPhotos: true,
  exportVideos: false,
  exportVoice: true,
  exportStickers: true,
  exportFiles: false,
  maxPhotoSizeMb: 10,
  maxVideoSizeMb: 100,
  maxFileSizeMb: 100,
});

export function normalizePreferences(value: unknown): ExportPreferences {
  return normalizePreferencesInRust<ExportPreferences>(value);
}

export async function loadPreferences(): Promise<ExportPreferences> {
  const stored = await browser.storage.local.get(PREFERENCES_KEY);
  return normalizePreferences(stored[PREFERENCES_KEY]);
}

export async function savePreferences(value: ExportPreferences): Promise<ExportPreferences> {
  const normalized = normalizePreferences(value);
  await browser.storage.local.set({ [PREFERENCES_KEY]: normalized });
  return normalized;
}

export async function resetPreferences(): Promise<ExportPreferences> {
  await browser.storage.local.remove(PREFERENCES_KEY);
  return { ...DEFAULT_PREFERENCES };
}
