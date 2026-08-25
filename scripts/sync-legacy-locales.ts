import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UI_KEYS, uiText, type UiKey, type UiLocale } from '../src/shared/product-i18n';

type MessageDescriptor = {
  message: string;
  placeholders?: Record<string, { content: string }>;
  [key: string]: unknown;
};

type Catalog = Record<string, MessageDescriptor>;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localeDirectories: Record<string, UiLocale> = {
  de: 'de',
  es: 'es',
  fr: 'fr',
  pl: 'pl',
  pt_BR: 'pt-BR',
  uk: 'uk',
};

const customMessages: Partial<Record<UiLocale, Record<string, string>>> = {
  de: {
    extensionDescription: 'Speichert Unterhaltungen aus unterstützten Web-Apps als lokale ZIP-Archive mit lesbaren Seiten, wiederverwendbaren Daten und optionalen Medien.',
    popupReadyDescription: 'Öffne die Unterhaltung, die du speichern möchtest, und fahre fort.',
    popupPrivacyTitle: 'Lokal entwickelt',
    popupPrivacyBody: 'Der autorisierte Quell-Tab liefert deine Auswahl; Local Archive erstellt das ZIP auf diesem Gerät. Keine Telemetrie, kein separates Konto und kein externer Server.',
  },
  es: {
    extensionDescription: 'Guarda conversaciones de aplicaciones web compatibles como archivos ZIP locales con páginas legibles, datos reutilizables y medios opcionales.',
    popupReadyDescription: 'Abre la conversación que quieres conservar y continúa.',
    popupPrivacyTitle: 'Diseñado para funcionar en local',
    popupPrivacyBody: 'La pestaña de origen autorizada proporciona tu selección; Local Archive crea el ZIP en este dispositivo. Sin telemetría, cuenta separada ni servidor externo.',
  },
  fr: {
    extensionDescription: 'Enregistre les conversations des applications web prises en charge dans des archives ZIP locales avec pages lisibles, données réutilisables et médias facultatifs.',
    popupReadyDescription: 'Ouvrez la conversation à conserver, puis continuez.',
    popupPrivacyTitle: 'Conçu pour rester local',
    popupPrivacyBody: 'L’onglet source autorisé fournit votre sélection ; Local Archive crée le ZIP sur cet appareil. Aucune télémétrie, aucun compte séparé ni serveur externe.',
  },
  pl: {
    extensionDescription: 'Zapisuje rozmowy z obsługiwanych aplikacji internetowych jako lokalne archiwa ZIP z czytelnymi stronami, danymi do ponownego użycia i opcjonalnymi multimediami.',
    popupReadyDescription: 'Otwórz rozmowę, którą chcesz zachować, i kontynuuj.',
    popupPrivacyTitle: 'Działa lokalnie',
    popupPrivacyBody: 'Autoryzowana karta źródłowa dostarcza wybrane dane, a Local Archive tworzy ZIP na tym urządzeniu. Bez telemetrii, osobnego konta i zewnętrznego serwera.',
  },
  'pt-BR': {
    extensionDescription: 'Salva conversas de aplicativos web compatíveis como arquivos ZIP locais com páginas legíveis, dados reutilizáveis e mídia opcional.',
    popupReadyDescription: 'Abra a conversa que deseja guardar e continue.',
    popupPrivacyTitle: 'Feito para funcionar localmente',
    popupPrivacyBody: 'A aba de origem autorizada fornece sua seleção; o Local Archive cria o ZIP neste dispositivo. Sem telemetria, conta separada ou servidor externo.',
  },
  uk: {
    extensionDescription: 'Зберігає розмови з підтримуваних вебзастосунків як локальні ZIP-архіви зі зручними сторінками, даними для повторного використання та необов’язковими медіа.',
    popupReadyDescription: 'Відкрий розмову, яку хочеш зберегти, і продовжуй.',
    popupPrivacyTitle: 'Працює локально',
    popupPrivacyBody: 'Авторизована вкладка-джерело передає вибрані дані, а Local Archive створює ZIP на цьому пристрої. Без телеметрії, окремого облікового запису та зовнішнього сервера.',
  },
};

const productKeyByLegacyKey: Record<string, string> = {
  extensionName: 'brand',
  extensionActionTitle: 'brand',
  popupEyebrow: 'brand',
  popupTitle: 'exportTitle',
  popupReady: 'ready',
  popupNotTelegram: 'unsupportedTitle',
  popupNotTelegramDescription: 'unsupportedBody',
  popupOpenExporter: 'exportZip',
  popupOpenTelegram: 'openTelegram',
  popupWorking: 'starting',
  popupInjectionError: 'injectionError',
  popupSettings: 'settings',
  popupVersion: 'version',
  optionsTitle: 'settingsTitle',
  optionsIntro: 'settingsIntro',
  optionsOutputTitle: 'content',
  optionsNoMedia: 'workloadMediaNone',
  formatHtml: 'formatHtml',
  formatJson: 'formatJson',
  mediaPhotos: 'mediaPhotos',
  mediaVideos: 'mediaVideos',
  mediaVoice: 'mediaVoice',
  mediaStickers: 'mediaStickers',
  mediaFiles: 'mediaFiles',
  maxEach: 'maxEach',
  megabytesShort: 'megabytesShort',
  saveSettings: 'saveSettings',
  settingsSaved: 'settingsSaved',
  resetDefaults: 'resetDefaults',
  defaultsRestored: 'defaultsReset',
  openTelegram: 'openTelegram',
  exporterTitle: 'quickTitle',
  quickSourceLabel: 'currentChat',
  quickSaveTitle: 'quickTitle',
  quickContentLabel: 'content',
  quickMediaLabel: 'attachments',
  quickPrivacyLabel: 'quickPrivacyLabel',
  quickReadyTitle: 'ready',
  quickReadyBody: 'quickKeepOpen',
  quickCustomize: 'content',
  quickSettingsTitle: 'settingsTitle',
  quickContentHtml: 'formatHtml',
  quickContentJson: 'formatJson',
  quickMediaNone: 'workloadMediaNone',
  quickHistoryUnknown: 'noChatBody',
  quickSaveAction: 'exportZip',
  quickSaveProtectedAction: 'exportZip',
  currentChat: 'currentChat',
  unknownChat: 'noChatTitle',
  close: 'quickClose',
  cancelExport: 'quickCancel',
  quickPreparing: 'quickPreparing',
  quickReading: 'quickReading',
  quickSaving: 'quickSaving',
  quickSaved: 'quickSaved',
  quickFailed: 'quickFailed',
  quickMessages: 'quickMessages',
  quickMediaSkipped: 'quickMediaSkipped',
  quickCancel: 'quickCancel',
  quickClose: 'quickClose',
  quickShowFile: 'quickShowFile',
  quickKeepOpen: 'quickKeepOpen',
  quickElapsed: 'quickElapsed',
  quickFile: 'quickFile',
};

function browserPlaceholderName(name: string): string {
  return `$${name.toUpperCase()}$`;
}

function toBrowserPlaceholders(value: string): string {
  return value.replace(/\{([a-zA-Z]+)\}/gu, (_, name: string) => browserPlaceholderName(name));
}

function placeholderNames(descriptor: MessageDescriptor): string[] {
  return Object.keys(descriptor.placeholders ?? {}).sort();
}

const english = JSON.parse(await readFile(path.join(root, 'public/_locales/en/messages.json'), 'utf8')) as Catalog;
const englishNames = new Set(Object.keys(english));

for (const [directory, locale] of Object.entries(localeDirectories)) {
  const targetPath = path.join(root, `public/_locales/${directory}/messages.json`);
  const existing = JSON.parse(await readFile(targetPath, 'utf8')) as Catalog;
  const output: Catalog = {};
  for (const [key, descriptor] of Object.entries(english)) {
    const translated = customMessages[locale]?.[key]
      ?? (productKeyByLegacyKey[key] && UI_KEYS.includes(productKeyByLegacyKey[key] as UiKey)
        ? uiText(locale, productKeyByLegacyKey[key] as UiKey)
        : existing[key]?.message || descriptor.message);
    const message = toBrowserPlaceholders(translated);
    for (const placeholder of placeholderNames(descriptor)) {
      assertPlaceholder(message, placeholder, key, locale);
    }
    output[key] = { ...descriptor, message };
  }
  if (Object.keys(output).length !== englishNames.size) {
    throw new Error(`${directory}: generated catalog does not match English key count`);
  }
  await writeFile(targetPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

function assertPlaceholder(message: string, placeholder: string, key: string, locale: string): void {
  if (!message.includes(`$${placeholder.toUpperCase()}$`)) {
    throw new Error(`${locale}.${key}: missing placeholder ${placeholder}`);
  }
}

console.log(`Synchronized ${Object.keys(localeDirectories).length} legacy locale catalogs to ${englishNames.size} keys with localized core UI.`);
