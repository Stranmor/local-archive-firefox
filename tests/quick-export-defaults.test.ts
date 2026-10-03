import { browser } from 'wxt/browser';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUICK_EXPORT_DEFAULTS,
  QUICK_EXPORT_DEFAULTS_KEY,
  loadQuickExportDefaults,
  normalizeQuickExportDefaults,
  resetQuickExportDefaults,
  saveQuickExportDefaults,
} from '@/src/shared/quick-export-defaults';

describe('quick export defaults', () => {
  it('normalizes malformed stored values', () => {
    expect(normalizeQuickExportDefaults({
      format: 'pdf',
      includeMedia: false,
      recentCount: 999_999,
    })).toEqual({ format: 'both', includeMedia: false, recentCount: 100_000 });
    expect(normalizeQuickExportDefaults({ recentCount: 0 })).toEqual({
      ...DEFAULT_QUICK_EXPORT_DEFAULTS,
      recentCount: 1,
    });
  });

  it('round-trips the values used by the popup', async () => {
    const saved = await saveQuickExportDefaults({
      format: 'json',
      includeMedia: false,
      recentCount: 1200,
    });
    expect(await loadQuickExportDefaults()).toEqual(saved);
    expect((await browser.storage.local.get(QUICK_EXPORT_DEFAULTS_KEY))[QUICK_EXPORT_DEFAULTS_KEY]).toEqual(saved);
    expect(await resetQuickExportDefaults()).toEqual(DEFAULT_QUICK_EXPORT_DEFAULTS);
  });
});
