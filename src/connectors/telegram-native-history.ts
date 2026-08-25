export const TELEGRAM_PAGE_BRIDGE_REQUEST = 'local-archive.telegram.page.request.v3';
export const TELEGRAM_PAGE_BRIDGE_RESPONSE = 'local-archive.telegram.page.response.v3';

export interface TelegramNativeInspection {
  ready: boolean;
  peerId: number;
  threadId: number;
  chatName: string;
  chatType: string;
  bridgeVersion: number;
  reason?: string;
}

export interface TelegramNativeMessage {
  id: number;
  type: 'message' | 'service';
  date: string;
  date_unixtime: string;
  from?: string;
  from_id?: string;
  text: string | Array<Record<string, unknown>>;
  text_entities: Array<Record<string, unknown>>;
  action?: string;
  actor?: string;
  actor_id?: string;
  forwarded_from?: string;
  forwarded_from_id?: string;
  reply_to_message_id?: number;
  edited?: string;
  edited_unixtime?: string;
  native_type?: string;
  native_peer_id?: number;
  media_type?: string;
  media_file_name?: string;
  media_file_size?: number;
  /** Opaque page-realm reference used only while the ZIP is being built. */
  _telegram_media_ref?: string;
  duration_seconds?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export interface TelegramNativeProgress {
  batch: number;
  messages: number;
  oldestDate: string;
  newestDate: string;
  count: number | null;
}

export interface TelegramNativeHistoryOptions {
  range: { mode: 'recent'; count: number } | { mode: 'dates'; from: string; to: string } | { mode: 'all' };
  threadId?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TelegramNativeProgress) => void;
}

export interface TelegramNativeHistoryResult {
  available: boolean;
  complete: boolean;
  messages: TelegramNativeMessage[];
  inspection: TelegramNativeInspection;
  batches: number;
  count: number | null;
  stoppedReason: string;
  error?: string;
}

export interface TelegramNativeMediaDownloadOptions {
  maxBytes?: number;
  signal?: AbortSignal;
}

interface TelegramPageResponse {
  source?: unknown;
  type?: unknown;
  requestId?: unknown;
  ok?: unknown;
  result?: unknown;
  error?: unknown;
}

interface TelegramPageBatch {
  peerId?: unknown;
  threadId?: unknown;
  count?: unknown;
  messages?: unknown;
  users?: unknown;
  chats?: unknown;
}

const PAGE_BATCH_SIZE = 100;
const MIN_REQUEST_INTERVAL_MS = 1_000;
const PAGE_REQUEST_TIMEOUT_MS = 20_000;
const MEDIA_REQUEST_TIMEOUT_MS = 180_000;

function requestId(): string {
  return typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function normalizePageError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (isRecord(value) && typeof value.message === 'string') return new Error(value.message);
  return new Error(String(value || 'Telegram Web did not return a history batch.'));
}

async function callPageBridge<T>(
  operation: string,
  payload: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = PAGE_REQUEST_TIMEOUT_MS,
): Promise<T> {
  if (typeof window === 'undefined') throw new Error('Telegram page bridge is unavailable outside a browser tab.');
  const id = requestId();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new DOMException('The Telegram history request was cancelled.', 'AbortError')));
    const onMessage = (event: MessageEvent<TelegramPageResponse>) => {
      if (event.source !== window || event.origin !== location.origin) return;
      const message = event.data;
      if (!message || message.source !== TELEGRAM_PAGE_BRIDGE_RESPONSE || message.requestId !== id) return;
      if (message.ok === true) finish(() => resolve(message.result as T));
      else finish(() => reject(normalizePageError(message.error)));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    window.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(() => reject(new Error('Telegram Web request timed out.'))), timeoutMs);
    window.postMessage({
      source: TELEGRAM_PAGE_BRIDGE_REQUEST,
      requestId: id,
      operation,
      payload,
    }, location.origin);
  });
}

export async function downloadTelegramNativeMedia(
  reference: string,
  options: TelegramNativeMediaDownloadOptions = {},
): Promise<Blob> {
  if (!reference || /^-?\d+:-?\d+:\d+$/u.test(reference) === false) {
    throw new Error('Telegram media reference is invalid.');
  }
  const chunkSize = 512 * 1024;
  const parts: BlobPart[] = [];
  let offset = 0;
  let mime = '';
  let declaredSize = 0;
  try {
    while (true) {
      if (options.signal?.aborted) throw new DOMException('The Telegram media download was cancelled.', 'AbortError');
      const result = await callPageBridge<{
        kind?: unknown;
        mime?: unknown;
        size?: unknown;
        offset?: unknown;
        done?: unknown;
        base64?: unknown;
      }>('media', {
        reference,
        maxBytes: options.maxBytes || 0,
        offset,
        chunkSize,
      }, options.signal, MEDIA_REQUEST_TIMEOUT_MS);
      mime ||= typeof result?.mime === 'string' ? result.mime : '';
      declaredSize = Number(result?.size) || declaredSize;
      const encoded = typeof result?.base64 === 'string' ? result.base64 : '';
      if (!encoded && result?.done !== true) throw new Error('Telegram Web returned an empty media chunk.');
      const binary = encoded ? atob(encoded) : '';
      const chunk = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) chunk[index] = binary.charCodeAt(index);
      parts.push(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer);
      offset += chunk.byteLength;
      if (options.maxBytes && offset > options.maxBytes) {
        throw new Error(`Telegram media exceeds the ${options.maxBytes} byte limit.`);
      }
      if (result?.done === true) break;
    }
  } finally {
    // Release the page-realm Blob even when the export is cancelled.
    void callPageBridge('media', {reference, release: true}, undefined, 5_000).catch(() => undefined);
  }
  if (declaredSize && declaredSize !== offset) throw new Error('Telegram Web returned truncated media.');
  return new Blob(parts, {type: mime || 'application/octet-stream'});
}

export async function inspectTelegramNativeHistory(): Promise<TelegramNativeInspection> {
  try {
    const raw = await callPageBridge<TelegramNativeInspection>('inspect', {});
    return {
      ready: raw?.ready === true,
      peerId: finiteInteger(raw?.peerId) ?? 0,
      threadId: finiteInteger(raw?.threadId) ?? 0,
      chatName: String(raw?.chatName || ''),
      chatType: String(raw?.chatType || ''),
      bridgeVersion: finiteInteger(raw?.bridgeVersion) ?? 0,
      ...(raw?.reason ? { reason: String(raw.reason) } : {}),
    };
  } catch (error) {
    return {
      ready: false,
      peerId: 0,
      threadId: 0,
      chatName: '',
      chatType: '',
      bridgeVersion: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function messageDate(message: TelegramNativeMessage): number {
  const value = Date.parse(message.date);
  return Number.isFinite(value) ? value : 0;
}

function oldestDate(messages: readonly TelegramNativeMessage[]): string {
  return [...messages].sort((left, right) => messageDate(left) - messageDate(right))[0]?.date || '';
}

function newestDate(messages: readonly TelegramNativeMessage[]): string {
  return [...messages].sort((left, right) => messageDate(right) - messageDate(left))[0]?.date || '';
}

function dateAtOrBefore(value: string, target: string): boolean {
  if (!value || !target) return false;
  return value.slice(0, 10) <= target.slice(0, 10);
}

interface PeerDirectory {
  names: Map<string, string>;
}

function peerDirectory(): PeerDirectory {
  return { names: new Map() };
}

function peerName(directory: PeerDirectory, value: unknown): string {
  const label = peerLabel(value);
  return label ? directory.names.get(label) || label : '';
}

function addPeerDirectoryEntries(directory: PeerDirectory, users: unknown, chats: unknown): void {
  const entries = [
    ...(Array.isArray(users) ? users : []),
    ...(Array.isArray(chats) ? chats : []),
  ];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const key = peerLabel(entry);
    if (!key) continue;
    const type = String(entry._ || '');
    const name = type === 'user'
      ? [entry.first_name, entry.last_name].filter((part) => typeof part === 'string' && part.trim()).join(' ').trim()
      || (typeof entry.username === 'string' && entry.username ? `@${entry.username}` : '')
      : typeof entry.title === 'string' ? entry.title.trim() : '';
    if (name) directory.names.set(key, name);
  }
}

function normalizeNativeMessage(value: unknown, directory: PeerDirectory): TelegramNativeMessage | null {
  if (!isRecord(value)) return null;
  const id = finiteInteger(value.id);
  if (id === null || id <= 0) return null;
  const rawType = String(value._ || value.native_type || '');
  const type = rawType === 'messageService' || value.type === 'service' ? 'service' : 'message';
  const rawDate = finiteInteger(value.date);
  const date = typeof value.date === 'string'
    ? value.date
    : rawDate && rawDate > 0 ? new Date(rawDate * 1000).toISOString().replace('.000Z', '') : '';
  const dateUnix = typeof value.date_unixtime === 'string'
    ? value.date_unixtime
    : rawDate && rawDate > 0 ? String(rawDate) : '0';
  if (!date) return null;
  const rawText = typeof value.message === 'string' ? value.message : value.text;
  const text = typeof rawText === 'string' || Array.isArray(rawText) ? rawText as TelegramNativeMessage['text'] : '';
  const entities = Array.isArray(value.text_entities)
    ? value.text_entities.filter(isRecord)
    : Array.isArray(value.entities) ? entitySegments(String(rawText || ''), value.entities) : (rawText ? [{ type: 'plain', text: String(rawText) }] : []);
  const fromId = peerLabel(value.from_id);
  const fromName = peerName(directory, value.from_id);
  const reply = isRecord(value.reply_to) ? finiteInteger(value.reply_to.reply_to_msg_id) : null;
  const editedUnix = finiteInteger(value.edit_date);
  const edited = editedUnix && editedUnix > 0 ? new Date(editedUnix * 1000).toISOString().replace('.000Z', '') : '';
  const mediaMeta = isRecord(value.__local_archive_media) ? value.__local_archive_media : null;
  const media = isRecord(value.media) ? value.media : null;
  const mediaDocument = media && isRecord(media.document) ? media.document : null;
  const mediaPhoto = media && isRecord(media.photo) ? media.photo : null;
  const mediaType = typeof mediaMeta?.type === 'string' && mediaMeta.type
    ? mediaMeta.type
    : mediaDocument
    ? documentMediaType(mediaDocument)
    : mediaPhoto ? 'photo' : '';
  const action = isRecord(value.action) ? String(value.action._ || '') : '';
  const peer = isRecord(value.peer_id) ? value.peer_id : null;
  const forwardedFromId = isRecord(value.fwd_from) ? peerLabel(value.fwd_from.from_id) : '';
  const forwardedFromName = isRecord(value.fwd_from) ? peerName(directory, value.fwd_from.from_id) : '';
  const nativePeerId = peer ? finiteInteger(peer.user_id || peer.chat_id || peer.channel_id) : null;
  const rawViews = finiteInteger(value.views);
  const rawForwards = finiteInteger(value.forwards);
  const groupedId = value.grouped_id !== undefined ? String(value.grouped_id) : '';
  const replyMarkup = isRecord(value.reply_markup) ? value.reply_markup : null;
  const mediaDuration = finiteInteger(mediaMeta?.duration);
  const mediaWidth = finiteInteger(mediaMeta?.width);
  const mediaHeight = finiteInteger(mediaMeta?.height);
  return {
    id,
    type,
    date,
    date_unixtime: dateUnix,
    text,
    text_entities: entities,
    native_type: rawType || type,
    ...(nativePeerId !== null ? { native_peer_id: nativePeerId } : {}),
    ...(fromId ? { from: fromName || fromId, from_id: fromId } : {}),
    ...(reply ? { reply_to_message_id: reply } : {}),
    ...(edited ? { edited, edited_unixtime: String(editedUnix) } : {}),
    ...(action ? { action, actor: fromName || fromId || 'Unknown', actor_id: fromId || '' } : {}),
    ...(forwardedFromId ? { forwarded_from: forwardedFromName || forwardedFromId, forwarded_from_id: forwardedFromId } : {}),
    ...(rawViews !== null ? { views: rawViews } : {}),
    ...(rawForwards !== null ? { forwards: rawForwards } : {}),
    ...(groupedId ? { grouped_id: groupedId } : {}),
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    ...(mediaType ? { media_type: mediaType } : {}),
    ...((mediaDocument?.size || mediaMeta?.size) ? { media_file_size: finiteInteger(mediaDocument?.size ?? mediaMeta?.size) || 0 } : {}),
    ...((mediaDocument?.attributes || mediaMeta?.fileName) ? { media_file_name: documentName(mediaDocument?.attributes) || String(mediaMeta?.fileName || '') } : {}),
    ...(mediaDuration !== null && mediaDuration > 0 ? { duration_seconds: mediaDuration } : {}),
    ...(mediaWidth !== null && mediaWidth > 0 ? { width: mediaWidth } : {}),
    ...(mediaHeight !== null && mediaHeight > 0 ? { height: mediaHeight } : {}),
    ...(typeof value.__local_archive_media_ref === 'string' && value.__local_archive_media_ref
      ? { _telegram_media_ref: value.__local_archive_media_ref.slice(0, 160) }
      : {}),
  };
}

function peerLabel(value: unknown): string {
  if (!isRecord(value)) return '';
  const type = String(value._ || '');
  if (type === 'user' && value.id !== undefined) return `user${String(value.id)}`;
  if (type === 'channel' && value.id !== undefined) return `channel${String(value.id)}`;
  if (type === 'chat' && value.id !== undefined) return `chat${String(value.id)}`;
  if (type === 'peerUser' || value.user_id !== undefined) return `user${String(value.user_id || '')}`;
  if (type === 'peerChannel' || value.channel_id !== undefined) return `channel${String(value.channel_id || '')}`;
  if (type === 'peerChat' || value.chat_id !== undefined) return `chat${String(value.chat_id || '')}`;
  return '';
}

function entityType(value: Record<string, unknown>): string {
  const type = String(value._ || '').replace(/^messageEntity/iu, '');
  const map: Record<string, string> = {
    Bold: 'bold', Italic: 'italic', Underline: 'underline', Strike: 'strikethrough',
    Code: 'code', Pre: 'pre', Blockquote: 'blockquote', Spoiler: 'spoiler',
    TextUrl: 'text_link', Url: 'link', Mention: 'mention', Hashtag: 'hashtag',
    Cashtag: 'cashtag', BotCommand: 'bot_command', Email: 'email', Phone: 'phone',
    CustomEmoji: 'custom_emoji',
  };
  return map[type] || 'plain';
}

function entitySegments(text: string, rawEntities: unknown): Array<Record<string, unknown>> {
  if (!text) return [];
  const entities = Array.isArray(rawEntities)
    ? rawEntities.filter(isRecord).map((entity) => ({
      offset: finiteInteger(entity.offset) || 0,
      length: finiteInteger(entity.length) || 0,
      type: entityType(entity),
      url: typeof entity.url === 'string' ? entity.url : undefined,
      language: typeof entity.language === 'string' ? entity.language : undefined,
    })).filter((entity) => entity.length > 0 && entity.offset >= 0)
    : [];
  if (!entities.length) return [{ type: 'plain', text }];
  entities.sort((left, right) => left.offset - right.offset || right.length - left.length);
  const result: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (const entity of entities) {
    const start = Math.min(text.length, Math.max(cursor, entity.offset));
    const end = Math.min(text.length, start + entity.length);
    if (start > cursor) result.push({ type: 'plain', text: text.slice(cursor, start) });
    if (end > start) {
      result.push({
        type: entity.type,
        text: text.slice(start, end),
        ...(entity.url ? { href: entity.url } : {}),
        ...(entity.language ? { language: entity.language } : {}),
      });
      cursor = end;
    }
  }
  if (cursor < text.length) result.push({ type: 'plain', text: text.slice(cursor) });
  return result;
}

function documentMediaType(document: Record<string, unknown>): string {
  const attributes = Array.isArray(document.attributes) ? document.attributes.filter(isRecord) : [];
  if (attributes.some((attribute) => String(attribute._ || '') === 'documentAttributeSticker')) return 'sticker';
  if (attributes.some((attribute) => String(attribute._ || '') === 'documentAttributeAudio')) return 'voice_message';
  if (attributes.some((attribute) => String(attribute._ || '') === 'documentAttributeVideo')) return 'video_file';
  return 'file';
}

function documentName(attributes: unknown): string {
  if (!Array.isArray(attributes)) return '';
  const attribute = attributes.find((value) => isRecord(value) && String(value._ || '') === 'documentAttributeFilename');
  return isRecord(attribute) && typeof attribute.file_name === 'string' ? attribute.file_name : '';
}

export async function collectTelegramNativeHistory(options: TelegramNativeHistoryOptions): Promise<TelegramNativeHistoryResult> {
  const inspection = await inspectTelegramNativeHistory();
  if (!inspection.ready || !inspection.peerId) {
    return {
      available: false,
      complete: false,
      messages: [],
      inspection,
      batches: 0,
      count: null,
      stoppedReason: inspection.reason || 'telegram-page-api-unavailable',
    };
  }

  const messages = new Map<number, TelegramNativeMessage>();
  const directory = peerDirectory();
  let offsetId = 0;
  let count: number | null = null;
  let batches = 0;
  let nextAllowedAt = 0;
  let stoppedReason = 'oldest-edge';
  let complete = false;
  let previousOffsetId = -1;
  let repeatedPages = 0;
  let pageError = '';
  const range = options.range;
  const targetDate = range.mode === 'dates' ? range.from : '';
  const recentTarget = range.mode === 'recent' ? Math.max(1, Math.min(1_000_000, range.count)) : null;

  while (true) {
    if (options.signal?.aborted) throw new DOMException('The Telegram history export was cancelled.', 'AbortError');
    if (recentTarget !== null && messages.size >= recentTarget) {
      stoppedReason = 'recent-count-reached';
      complete = true;
      break;
    }
    if (targetDate && dateAtOrBefore(oldestDate([...messages.values()]), targetDate)) {
      stoppedReason = 'date-range-reached';
      complete = true;
      break;
    }
    const waitMs = nextAllowedAt - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    let raw: TelegramPageBatch;
    try {
      raw = await callPageBridge<TelegramPageBatch>('history', {
        peerId: inspection.peerId,
        threadId: options.threadId ?? inspection.threadId,
        offsetId,
        limit: PAGE_BATCH_SIZE,
        // Start a date export at the exclusive next-day boundary. This avoids
        // walking newer history that the requested range will discard anyway.
        offsetDate: offsetId === 0 && range.mode === 'dates' ? dateRangeUpperBound(range.to) : 0,
        // Telegram's offset_id is inclusive in some surfaces; duplicates are
        // harmless because the Rust/TS collector owns a typed ID set.
        addOffset: offsetId ? -1 : 0,
      }, options.signal);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      pageError = normalizePageError(error).message;
      stoppedReason = 'page-manager-error';
      complete = false;
      break;
    }
    nextAllowedAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
    batches += 1;
    addPeerDirectoryEntries(directory, raw?.users, raw?.chats);
    const batch = Array.isArray(raw?.messages)
      ? raw.messages.map((message) => normalizeNativeMessage(message, directory)).filter((message): message is TelegramNativeMessage => Boolean(message))
      : [];
    const before = messages.size;
    for (const message of batch) messages.set(message.id, message);
    count = finiteInteger(raw?.count);
    const oldest = oldestDate([...messages.values()]);
    const newest = newestDate([...messages.values()]);
    options.onProgress?.({ batch: batches, messages: messages.size, oldestDate: oldest, newestDate: newest, count });

    if (recentTarget !== null && messages.size >= recentTarget) {
      stoppedReason = 'recent-count-reached';
      complete = true;
      break;
    }
    if (targetDate && dateAtOrBefore(oldest, targetDate)) {
      stoppedReason = 'date-range-reached';
      complete = true;
      break;
    }
    if (count !== null && messages.size >= count) {
      stoppedReason = 'count-reached';
      complete = true;
      break;
    }
    if (batch.length === 0) {
      stoppedReason = 'oldest-edge';
      complete = count === null || messages.size >= count || range.mode !== 'all';
      break;
    }
    const ids = batch.map((message) => message.id).filter((id) => id > 0);
    const nextOffset = Math.min(...ids);
    const noNewMessages = before === messages.size;
    if (!Number.isFinite(nextOffset) || nextOffset <= 0) {
      stoppedReason = 'oldest-edge';
      complete = count === null || messages.size >= count || range.mode !== 'all';
      break;
    }
    if (offsetId > 0 && nextOffset >= offsetId) {
      stoppedReason = 'cursor-stalled';
      complete = count !== null && messages.size >= count;
      break;
    }
    if (noNewMessages || nextOffset === previousOffsetId) {
      repeatedPages += 1;
      if (repeatedPages >= 2) {
        stoppedReason = 'repeated-page';
        complete = false;
        break;
      }
    } else {
      repeatedPages = 0;
    }
    previousOffsetId = offsetId;
    offsetId = nextOffset;
  }

  const ordered = [...messages.values()].sort((left, right) => messageDate(left) - messageDate(right) || left.id - right.id);
  const available = !pageError || ordered.length > 0;
  return {
    available,
    complete,
    messages: recentTarget === null ? ordered : ordered.slice(-recentTarget),
    inspection,
    batches,
    count,
    stoppedReason,
    ...(pageError ? { error: pageError } : {}),
  };
}

function dateRangeUpperBound(value: string): number {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) + 86_400 : 0;
}

/**
 * Runs in Telegram Web's MAIN world. Keep this function self-contained: it is
 * serialized by Firefox's scripting API and must not capture extension state.
 */
export function installTelegramPageBridge(): void {
  const global = globalThis as typeof globalThis & {
    __LOCAL_ARCHIVE_TELEGRAM_PAGE_BRIDGE__?: {
      version: number;
      listener: (event: MessageEvent) => void;
    };
    rootScope?: { managers?: { appMessagesManager?: { requestHistory?: (options: Record<string, unknown>) => Promise<unknown> } } };
    appDownloadManager?: { downloadMedia?: (options: { media: unknown }) => Promise<unknown> };
    appImManager?: { chat?: { peerId?: unknown; threadId?: unknown; type?: unknown; title?: unknown; name?: unknown } };
    apiManagerProxy?: { getPeer?: (peerId: unknown) => unknown };
  };
  const bridgeVersion = 3;
  const previous = global.__LOCAL_ARCHIVE_TELEGRAM_PAGE_BRIDGE__;
  if (previous?.version === bridgeVersion) return;
  if (previous?.listener) window.removeEventListener('message', previous.listener);
  const requestType = 'local-archive.telegram.page.request.v3';
  const responseType = 'local-archive.telegram.page.response.v3';
  const mediaCache = new Map<string, {media: unknown; kind: string; type: string; size: number; fileName: string; mime: string}>();
  const mediaBlobCache = new Map<string, {blob: Blob; size: number; mime: string; lastUsedAt: number}>();
  let mediaScope = '';
  let nextMediaAllowedAt = 0;
  let mediaQueue: Promise<unknown> = Promise.resolve();
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const plain = (value: unknown, depth = 0, seen = new WeakSet<object>(), budget = {remaining: 1_500_000}): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return String(value);
    if (depth > 10 || budget.remaining <= 0) return null;
    if (value instanceof ArrayBuffer) {
      const bytes = new Uint8Array(value);
      if (bytes.byteLength > 256_000) return {_: 'bytes', size: bytes.byteLength, truncated: true};
      budget.remaining -= bytes.byteLength;
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {_: 'bytes', size: bytes.byteLength, base64: btoa(binary)};
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      if (bytes.byteLength > 256_000) return {_: 'bytes', size: bytes.byteLength, truncated: true};
      budget.remaining -= bytes.byteLength;
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return {_: 'bytes', size: bytes.byteLength, base64: btoa(binary)};
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return {_: 'blob', size: value.size, type: value.type};
    }
    if (Array.isArray(value)) return value.slice(0, 256).map((item) => plain(item, depth + 1, seen, budget));
    if (typeof value !== 'object') return null;
    if (seen.has(value)) return null;
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).slice(0, 256)) {
      if (key === 'promise' || key === 'middleware' || key === 'manager') continue;
      try {
        result[key] = plain((value as Record<string, unknown>)[key], depth + 1, seen, budget);
        budget.remaining -= key.length + 8;
      } catch { /* omit inaccessible getters */ }
    }
    seen.delete(value);
    return result;
  };
  const number = (value: unknown): number | null => {
    if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || typeof value === 'boolean') return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const documentType = (document: Record<string, unknown>): string => {
    const attributes = Array.isArray(document.attributes) ? document.attributes.filter(record) : [];
    if (attributes.some((attribute) => String(attribute._ || '') === 'documentAttributeSticker')) return 'sticker';
    if (attributes.some((attribute) => String(attribute._ || '') === 'documentAttributeAudio')) return 'voice_message';
    if (attributes.some((attribute) => String(attribute._ || '') === 'documentAttributeVideo')) return 'video_file';
    return 'file';
  };
  const documentFileName = (document: Record<string, unknown>): string => {
    const attributes = Array.isArray(document.attributes) ? document.attributes.filter(record) : [];
    const attribute = attributes.find((value) => String(value._ || '') === 'documentAttributeFilename');
    return typeof attribute?.file_name === 'string' ? attribute.file_name : '';
  };
  const mediaTarget = (message: Record<string, unknown>): {media: unknown; kind: string; type: string; size: number; fileName: string; mime: string; duration: number; width: number; height: number} | null => {
    const media = record(message.media) ? message.media : null;
    const document = media && record(media.document) ? media.document : null;
    const photo = media && record(media.photo) ? media.photo : null;
    const webpage = media && record(media.webpage) ? media.webpage : null;
    const webpageDocument = webpage && record(webpage.document) ? webpage.document : null;
    const webpagePhoto = webpage && record(webpage.photo) ? webpage.photo : null;
    const target = document || photo || webpageDocument || webpagePhoto;
    if (!target) return null;
    const isDocument = target === document || target === webpageDocument;
    const sizes = !isDocument && Array.isArray(target.sizes) ? target.sizes.filter(record) : [];
    const largest = sizes.sort((left, right) => (number(right.w) || 0) * (number(right.h) || 0) - (number(left.w) || 0) * (number(left.h) || 0))[0];
    const attributes = isDocument && Array.isArray(target.attributes) ? target.attributes.filter(record) : [];
    const videoAttribute = attributes.find((attribute) => String(attribute._ || '') === 'documentAttributeVideo');
    const audioAttribute = attributes.find((attribute) => String(attribute._ || '') === 'documentAttributeAudio');
    return {
      media: target,
      kind: isDocument ? 'document' : 'photo',
      type: isDocument ? documentType(target) : 'photo',
      size: isDocument ? number(target.size) || 0 : 0,
      fileName: isDocument ? documentFileName(target) : '',
      mime: isDocument && typeof target.mime_type === 'string' ? target.mime_type : '',
      duration: number(videoAttribute?.duration) || number(audioAttribute?.duration) || 0,
      width: number(videoAttribute?.w) || number(largest?.w) || 0,
      height: number(videoAttribute?.h) || number(largest?.h) || 0,
    };
  };
  const mediaReference = (peerId: number, threadId: number, messageId: number): string => `${peerId}:${threadId}:${messageId}`;
  const ensureMediaScope = (peerId: number, threadId: number) => {
    const nextScope = `${peerId}:${threadId}`;
    if (nextScope !== mediaScope) {
      mediaScope = nextScope;
      mediaCache.clear();
      mediaBlobCache.clear();
    }
  };
  const encodeBase64 = (buffer: ArrayBuffer): string => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const step = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += step) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + step)));
    }
    return btoa(binary);
  };
  const chatInfo = () => {
    const chat = global.appImManager?.chat;
    const peerId = number(chat?.peerId);
    const threadId = number(chat?.threadId) || 0;
    const peer = peerId && global.apiManagerProxy?.getPeer ? global.apiManagerProxy.getPeer(peerId) : null;
    const titleSelectors = ['[data-scope="peer-title"]', '.peer-title', '[class*="peer-title"]', '.chat-name', 'h1'];
    let chatName = typeof chat?.title === 'string' ? chat.title.trim() : typeof chat?.name === 'string' ? chat.name.trim() : '';
    if (!chatName && record(peer)) chatName = typeof peer.title === 'string' ? peer.title.trim() : '';
    for (const selector of titleSelectors) {
      const element = document.querySelector(selector);
      if (element?.textContent?.trim()) { chatName = element.textContent.trim(); break; }
    }
    return {
      peerId: peerId || 0,
      threadId,
      chatName,
      chatType: String(chat?.type || ''),
    };
  };
  const respond = (requestId: string, ok: boolean, result?: unknown, error?: unknown) => {
    try {
      window.postMessage({
        source: responseType,
        requestId,
        ok,
        ...(ok ? { result: plain(result) } : { error: { message: error instanceof Error ? error.message : String(error || 'Telegram Web request failed.') } }),
      }, location.origin);
    } catch (postError) {
      window.postMessage({
        source: responseType,
        requestId,
        ok: false,
        error: { message: postError instanceof Error ? postError.message : 'Telegram Web returned an unserializable result.' },
      }, location.origin);
    }
  };
  const listener = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const request = event.data as { source?: unknown; requestId?: unknown; operation?: unknown; payload?: unknown } | null;
    if (!request || request.source !== requestType || typeof request.requestId !== 'string') return;
    void (async () => {
      try {
        const operation = String(request.operation || '');
        const payload = request.payload && typeof request.payload === 'object' ? request.payload as Record<string, unknown> : {};
        const info = chatInfo();
        const manager = global.rootScope?.managers?.appMessagesManager;
        if (operation === 'inspect') {
          ensureMediaScope(info.peerId, info.threadId);
          respond(request.requestId as string, true, {
            ready: Boolean(manager?.requestHistory && info.peerId),
            bridgeVersion,
            ...info,
            reason: manager?.requestHistory ? (info.peerId ? '' : 'no-open-chat') : 'telegram-manager-not-ready',
          });
          return;
        }
        if (operation === 'media') {
          if (!info.peerId) throw new Error('No Telegram chat is open.');
          const reference = typeof payload.reference === 'string' ? payload.reference : '';
          const expectedPrefix = `${info.peerId}:${Math.max(0, number(payload.threadId) || info.threadId || 0)}:`;
          if (!reference.startsWith(expectedPrefix)) throw new Error('The open Telegram chat changed; restart the export.');
          const cached = mediaCache.get(reference);
          if (!cached) throw new Error('Telegram media is no longer available in this page session.');
          if (payload.release === true) {
            mediaBlobCache.delete(reference);
            respond(request.requestId as string, true, {released: true});
            return;
          }
          const maxBytes = Math.max(0, number(payload.maxBytes) || 0);
          if (maxBytes && cached.size && cached.size > maxBytes) {
            throw new Error(`Telegram media exceeds the ${maxBytes} byte limit.`);
          }
          if (typeof global.appDownloadManager?.downloadMedia !== 'function') {
            throw new Error('Telegram Web media manager is not ready.');
          }
          const run = mediaQueue.then(async () => {
            let downloaded = mediaBlobCache.get(reference);
            if (!downloaded) {
              const waitMs = nextMediaAllowedAt - Date.now();
              if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
              nextMediaAllowedAt = Date.now() + 1_000;
              const value = await global.appDownloadManager!.downloadMedia!({media: cached.media});
              const blob = typeof Blob !== 'undefined' && value instanceof Blob
                ? value
                : value && typeof (value as {arrayBuffer?: unknown}).arrayBuffer === 'function'
                  ? new Blob([await (value as Blob).arrayBuffer()])
                  : value instanceof ArrayBuffer
                    ? new Blob([value])
                    : null;
              if (!blob) throw new Error('Telegram Web returned an invalid media blob.');
              if (maxBytes && blob.size > maxBytes) throw new Error(`Telegram media exceeds the ${maxBytes} byte limit.`);
              downloaded = {blob, size: blob.size, mime: blob.type || cached.mime || 'application/octet-stream', lastUsedAt: Date.now()};
              mediaBlobCache.set(reference, downloaded);
              while (mediaBlobCache.size > 2) {
                const oldest = [...mediaBlobCache.entries()].sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt)[0]?.[0];
                if (!oldest) break;
                mediaBlobCache.delete(oldest);
              }
            }
            downloaded.lastUsedAt = Date.now();
            const offset = Math.max(0, number(payload.offset) || 0);
            const chunkSize = Math.max(16 * 1024, Math.min(512 * 1024, number(payload.chunkSize) || 512 * 1024));
            if (offset > downloaded.size) throw new Error('Telegram media chunk offset is invalid.');
            const end = Math.min(downloaded.size, offset + chunkSize);
            const bytes = await downloaded.blob.slice(offset, end).arrayBuffer();
            return {
              base64: encodeBase64(bytes),
              mime: downloaded.mime,
              size: downloaded.size,
              offset,
              done: end >= downloaded.size,
            };
          });
          mediaQueue = run.catch(() => undefined);
          const result = await run;
          respond(request.requestId as string, true, {kind: 'telegram-media', ...result});
          return;
        }
        if (operation !== 'history') throw new Error('Unsupported Telegram page operation.');
        if (!manager?.requestHistory) throw new Error('Telegram Web history manager is not ready.');
        const peerId = number(payload.peerId);
        if (!peerId || peerId !== info.peerId) throw new Error('The open Telegram chat changed; restart the export.');
        const limit = Math.max(1, Math.min(100, number(payload.limit) || 100));
        const offsetId = Math.max(0, number(payload.offsetId) || 0);
        const offsetDate = Math.max(0, number(payload.offsetDate) || 0);
        const addOffset = Math.max(-100, Math.min(0, number(payload.addOffset) || 0));
        const threadId = Math.max(0, number(payload.threadId) || info.threadId || 0);
        ensureMediaScope(peerId, threadId);
        const result = await manager.requestHistory({
          peerId,
          offsetId,
          offsetDate,
          limit,
          addOffset,
          ...(threadId ? { threadId } : {}),
        });
        const response = result as Record<string, unknown>;
        const responseMessages = Array.isArray(response.messages) ? response.messages : [];
        const responseUsers = Array.isArray(response.users) ? response.users : [];
        const responseChats = Array.isArray(response.chats) ? response.chats : [];
        respond(request.requestId as string, true, {
          peerId,
          threadId,
          count: number(response.count),
          messages: responseMessages.map((message: unknown) => {
            if (!record(message)) return null;
            const descriptor = mediaTarget(message);
            const id = number(message.id);
            const reference = id ? mediaReference(peerId, threadId, id) : '';
            if (descriptor && reference) {
              mediaCache.set(reference, descriptor);
              while (mediaCache.size > 10_000) {
                const oldest = mediaCache.keys().next().value;
                if (typeof oldest !== 'string') break;
                mediaCache.delete(oldest);
              }
            }
            const serializable: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(message)) {
              if (key !== 'media') serializable[key] = value;
            }
            const normalized = plain(serializable);
            if (record(normalized) && descriptor) {
              normalized.__local_archive_media = {
                type: descriptor.type,
                size: descriptor.size,
                fileName: descriptor.fileName,
                mime: descriptor.mime,
                duration: descriptor.duration,
                width: descriptor.width,
                height: descriptor.height,
              };
              if (reference) normalized.__local_archive_media_ref = reference;
            }
            return normalized;
          }).filter(Boolean),
          users: responseUsers.map((user: unknown) => plain(user)),
          chats: responseChats.map((chat: unknown) => plain(chat)),
        });
      } catch (error) {
        respond(request.requestId as string, false, undefined, error);
      }
    })();
  };
  global.__LOCAL_ARCHIVE_TELEGRAM_PAGE_BRIDGE__ = {version: bridgeVersion, listener};
  window.addEventListener('message', listener);
}
