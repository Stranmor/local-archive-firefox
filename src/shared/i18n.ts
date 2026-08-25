import { browser } from 'wxt/browser';

export type MessageSubstitutions = string | string[];

export function t(key: string, substitutions?: MessageSubstitutions): string {
  const getMessage = browser.i18n.getMessage as unknown as (
    messageName: string,
    values?: MessageSubstitutions,
  ) => string;
  return getMessage(key, substitutions) || key;
}

export function applyDocumentLocale(): void {
  const locale = browser.i18n.getUILanguage?.() || 'en';
  document.documentElement.lang = locale.split('-')[0] || 'en';
  document.documentElement.dir = ['ar', 'fa', 'he', 'ur'].includes(document.documentElement.lang)
    ? 'rtl'
    : 'ltr';
}
