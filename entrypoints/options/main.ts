import { browser } from 'wxt/browser';
import {
  resolveUiLocale,
  UI_LOCALES,
  uiText,
  type UiLocale,
} from '@/src/shared/product-i18n';
import {
  DEFAULT_QUICK_EXPORT_DEFAULTS,
  loadQuickExportDefaults,
  resetQuickExportDefaults,
  saveQuickExportDefaults,
  type QuickExportDefaults,
} from '@/src/shared/quick-export-defaults';
import './style.css';

const UI_LOCALE_KEY = 'localArchive.uiLocale.v1';

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Options element is missing: ${selector}`);
  return element;
}

const root = required<HTMLElement>('#settings');
const form = required<HTMLFormElement>('#defaults-form');
const language = required<HTMLSelectElement>('#language');
const format = required<HTMLSelectElement>('#format');
const recentCount = required<HTMLInputElement>('#recent-count');
const includeMedia = required<HTMLInputElement>('#include-media');
const reset = required<HTMLButtonElement>('#reset');
const save = required<HTMLButtonElement>('#save');
const status = required<HTMLElement>('#status');

let locale: UiLocale = resolveUiLocale(browser.i18n.getUILanguage?.());
let persisted: QuickExportDefaults = { ...DEFAULT_QUICK_EXPORT_DEFAULTS };

for (const [value, label] of UI_LOCALES) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  language.append(option);
}

function applyLocale(): void {
  document.documentElement.lang = locale.split('-')[0] || 'en';
  language.value = locale;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
    const key = element.dataset.i18n as Parameters<typeof uiText>[1] | undefined;
    if (key) element.textContent = uiText(locale, key);
  });
}

function readForm(): QuickExportDefaults {
  return {
    format: format.value === 'html' || format.value === 'json' ? format.value : 'both',
    includeMedia: includeMedia.checked,
    recentCount: Number(recentCount.value),
  };
}

function render(value: QuickExportDefaults): void {
  format.value = value.format;
  includeMedia.checked = value.includeMedia;
  recentCount.value = String(value.recentCount);
  updateActions();
}

function updateActions(): void {
  const current = readForm();
  save.disabled = JSON.stringify(current) === JSON.stringify(persisted);
  reset.disabled = JSON.stringify(current) === JSON.stringify(DEFAULT_QUICK_EXPORT_DEFAULTS);
}

function setStatus(key?: 'settingsSaved' | 'defaultsReset' | 'settingsError'): void {
  status.textContent = key ? uiText(locale, key) : '';
  status.dataset.kind = key === 'settingsError' ? 'error' : key ? 'success' : '';
}

for (const control of [format, recentCount, includeMedia]) {
  control.addEventListener('input', () => { setStatus(); updateActions(); });
  control.addEventListener('change', () => { setStatus(); updateActions(); });
}

language.addEventListener('change', () => {
  locale = resolveUiLocale(language.value);
  void browser.storage.local.set({ [UI_LOCALE_KEY]: locale });
  applyLocale();
  setStatus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  root.setAttribute('aria-busy', 'true');
  try {
    persisted = await saveQuickExportDefaults(readForm());
    render(persisted);
    setStatus('settingsSaved');
  } catch {
    setStatus('settingsError');
  } finally {
    root.setAttribute('aria-busy', 'false');
  }
});

reset.addEventListener('click', async () => {
  root.setAttribute('aria-busy', 'true');
  try {
    persisted = await resetQuickExportDefaults();
    render(persisted);
    setStatus('defaultsReset');
  } catch {
    setStatus('settingsError');
  } finally {
    root.setAttribute('aria-busy', 'false');
  }
});

void Promise.all([
  browser.storage.local.get(UI_LOCALE_KEY),
  loadQuickExportDefaults(),
]).then(([stored, defaults]) => {
  locale = resolveUiLocale(stored[UI_LOCALE_KEY] as string | undefined || browser.i18n.getUILanguage?.());
  persisted = defaults;
  applyLocale();
  render(defaults);
}).catch(() => {
  applyLocale();
  render(persisted);
  setStatus('settingsError');
}).finally(() => root.setAttribute('aria-busy', 'false'));
