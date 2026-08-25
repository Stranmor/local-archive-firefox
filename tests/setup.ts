import { beforeEach, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

const translations: Record<string, string> = {
  completeTitle: 'Archive saved',
  errorTitle: 'Export stopped',
  exporterTitle: 'Local Archive',
};

function installBrowserGlobal(): void {
  Object.defineProperty(globalThis, 'browser', {
    configurable: true,
    value: browser,
    writable: true,
  });
}

installBrowserGlobal();

beforeEach(() => {
  fakeBrowser.reset();
  document.body.replaceChildren();
  document.documentElement.lang = 'en';
  installBrowserGlobal();

  vi.spyOn(browser.i18n, 'getMessage').mockImplementation((key: string) => translations[key] || '');
  vi.spyOn(browser.i18n, 'getUILanguage').mockReturnValue('en-US');
});
