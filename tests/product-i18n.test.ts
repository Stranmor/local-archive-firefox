import { describe, expect, it } from 'vitest';
import {
  resolveUiLocale,
  UI_KEYS,
  UI_LOCALES,
  uiText,
} from '../src/shared/product-i18n';

describe('product interface localization', () => {
  it('renders every product message in every advertised language', () => {
    for (const [locale] of UI_LOCALES) {
      for (const key of UI_KEYS) {
        const rendered = uiText(locale, key, {
          count: 2,
          from: '2026-08-01',
          to: '2026-08-16',
          version: '3.0.0',
          time: '00:42',
          filename: 'Chat.zip',
          size: '1.2 MB',
        });
        expect(rendered.trim(), `${locale}.${key}`).not.toBe('');
        expect(rendered, `${locale}.${key}`).not.toMatch(/\{[a-zA-Z]+\}/u);
      }
    }
  });

  it('maps browser locale variants onto supported catalogs', () => {
    expect(resolveUiLocale('pt_BR')).toBe('pt-BR');
    expect(resolveUiLocale('uk-UA')).toBe('uk');
    expect(resolveUiLocale('de-DE')).toBe('de');
    expect(resolveUiLocale('ja-JP')).toBe('en');
  });
});
