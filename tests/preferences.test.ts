import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_KEY,
  loadPreferences,
  normalizePreferences,
  resetPreferences,
  savePreferences,
} from '@/src/shared/preferences';
import { browser } from 'wxt/browser';

describe('export preferences', () => {
  it('normalizes unsafe and incomplete values', () => {
    expect(normalizePreferences({
      formatHtml: false,
      maxPhotoSizeMb: -8,
      maxVideoSizeMb: 'not-a-number',
      maxFileSizeMb: 999_999,
    })).toEqual({
      ...DEFAULT_PREFERENCES,
      formatHtml: false,
      maxPhotoSizeMb: 1,
      maxVideoSizeMb: 100,
      maxFileSizeMb: 20_000,
    });
  });

  it('repairs an impossible no-format default to readable HTML and JSON', () => {
    expect(normalizePreferences({ formatHtml: false, formatJson: false })).toMatchObject({
      formatHtml: true,
      formatJson: true,
    });
  });

  it('round-trips settings through extension storage', async () => {
    const saved = await savePreferences({
      ...DEFAULT_PREFERENCES,
      formatJson: false,
      exportVideos: false,
      maxPhotoSizeMb: 24,
    });

    expect(await loadPreferences()).toEqual(saved);
    expect((await browser.storage.local.get(PREFERENCES_KEY))[PREFERENCES_KEY]).toEqual(saved);

    expect(await resetPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(await loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });
});
