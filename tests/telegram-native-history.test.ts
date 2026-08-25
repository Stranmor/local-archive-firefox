import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectTelegramNativeHistory,
  downloadTelegramNativeMedia,
  installTelegramPageBridge,
  inspectTelegramNativeHistory,
} from '@/src/connectors/telegram-native-history';

type TestGlobal = typeof globalThis & {
  __LOCAL_ARCHIVE_TELEGRAM_PAGE_BRIDGE__?: unknown;
  rootScope?: unknown;
  appDownloadManager?: unknown;
  appImManager?: unknown;
  apiManagerProxy?: unknown;
};

const testGlobal = globalThis as TestGlobal;
const originalPostMessage = window.postMessage.bind(window);

function clearPageBridge(): void {
  const bridge = testGlobal.__LOCAL_ARCHIVE_TELEGRAM_PAGE_BRIDGE__;
  if (bridge && typeof bridge === 'object' && 'listener' in bridge && typeof bridge.listener === 'function') {
    window.removeEventListener('message', bridge.listener as EventListener);
  }
  testGlobal.__LOCAL_ARCHIVE_TELEGRAM_PAGE_BRIDGE__ = undefined;
}

function installMessageShim(): void {
  window.postMessage = ((message: unknown, targetOrigin?: string) => {
    queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', {
      data: message,
      origin: targetOrigin || location.origin,
      source: window,
    })));
  }) as typeof window.postMessage;
}

function installMockTelegramPage(batches: unknown[]): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  clearPageBridge();
  testGlobal.appImManager = {
    chat: { peerId: 42, threadId: 0, type: 'Chat' },
  };
  testGlobal.apiManagerProxy = {
    getPeer: () => ({_: 'channel', id: 42, title: 'Native archive chat'}),
  };
  testGlobal.rootScope = {
    managers: {
      appMessagesManager: {
        requestHistory: async (options: Record<string, unknown>) => {
          calls.push({...options});
          return batches.shift() || {count: 3, messages: [], users: [], chats: []};
        },
      },
    },
  };
  document.body.innerHTML = '<h1>Native archive chat</h1>';
  installMessageShim();
  installTelegramPageBridge();
  return {calls};
}

afterEach(() => {
  clearPageBridge();
  testGlobal.rootScope = undefined;
  testGlobal.appDownloadManager = undefined;
  testGlobal.appImManager = undefined;
  testGlobal.apiManagerProxy = undefined;
  window.postMessage = originalPostMessage;
  vi.useRealTimers();
});

describe('Telegram Web native history bridge', () => {
  it('reads every page from the authenticated Telegram manager and normalizes TL messages', async () => {
    const {calls} = installMockTelegramPage([
      {
        _: 'messages.messagesSlice',
        count: 3,
        messages: [
          {_:'message', id: 3, date: 300, message: 'new', from_id: {_:'peerUser', user_id: 7}, entities: []},
          {_:'message', id: 2, date: 200, message: 'bold', from_id: {_:'peerUser', user_id: 7}, entities: [{_: 'messageEntityBold', offset: 0, length: 4}]},
        ],
        users: [{_: 'user', id: 7, first_name: 'Alice', last_name: 'Tester'}],
        chats: [{_: 'channel', id: 42, title: 'Native archive chat'}],
      },
      {
        _: 'messages.messages',
        count: 3,
        messages: [
          {_:'messageService', id: 1, date: 100, message: '', from_id: {_:'peerUser', user_id: 7}, action: {_:'messageActionChatCreate'}},
        ],
        users: [{_: 'user', id: 7, first_name: 'Alice', last_name: 'Tester'}],
        chats: [{_: 'channel', id: 42, title: 'Native archive chat'}],
      },
    ]);

    await expect(inspectTelegramNativeHistory()).resolves.toMatchObject({
      ready: true,
      peerId: 42,
      chatName: 'Native archive chat',
      bridgeVersion: 3,
    });

    const progress: number[] = [];
    const result = await collectTelegramNativeHistory({
      range: {mode: 'all'},
      onProgress: (value) => progress.push(value.messages),
    });

    expect(result.available).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.stoppedReason).toBe('count-reached');
    expect(result.count).toBe(3);
    expect(result.messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(result.messages[0]).toMatchObject({
      type: 'service',
      from: 'Alice Tester',
      from_id: 'user7',
      actor: 'Alice Tester',
      action: 'messageActionChatCreate',
    });
    expect(result.messages[1]).toMatchObject({
      text: 'bold',
      text_entities: [{type: 'bold', text: 'bold'}],
    });
    expect(progress).toEqual([2, 3]);
    expect(calls.map((call) => call.offsetId)).toEqual([0, 2]);
    expect(calls.map((call) => call.addOffset)).toEqual([0, -1]);
  }, 5_000);

  it('starts an inclusive date export at the requested upper calendar boundary', async () => {
    const {calls} = installMockTelegramPage([
      {
        _: 'messages.messages',
        count: 1,
        messages: [{_: 'message', id: 1, date: 100, message: 'old', entities: []}],
        users: [],
        chats: [],
      },
    ]);

    const result = await collectTelegramNativeHistory({
      range: {mode: 'dates', from: '1970-01-01', to: '1970-01-02'},
    });

    expect(result.complete).toBe(true);
    expect(calls[0]?.offsetDate).toBe(172800);
  }, 5_000);

  it('proves the oldest edge when Telegram omits the total count', async () => {
    const {calls} = installMockTelegramPage([
      {
        _: 'messages.messages',
        messages: [
          {_:'message', id: 3, date: 300, message: 'new', entities: []},
          {_:'message', id: 2, date: 200, message: 'middle', entities: []},
        ],
        users: [],
        chats: [],
      },
      {
        _: 'messages.messages',
        messages: [{_:'message', id: 1, date: 100, message: 'old', entities: []}],
        users: [],
        chats: [],
      },
      {_: 'messages.messages', messages: [], users: [], chats: []},
    ]);

    const result = await collectTelegramNativeHistory({range: {mode: 'all'}});

    expect(result.available).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.count).toBeNull();
    expect(result.stoppedReason).toBe('oldest-edge');
    expect(result.messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(calls.map((call) => call.offsetId)).toEqual([0, 2, 1]);
  }, 8_000);

  it('returns an unavailable result when the Telegram manager is absent', async () => {
    testGlobal.__LOCAL_ARCHIVE_TELEGRAM_PAGE_BRIDGE__ = undefined;
    testGlobal.rootScope = {managers: {}};
    testGlobal.appImManager = {chat: {peerId: 42, type: 'Chat'}};
    installMessageShim();
    installTelegramPageBridge();

    const result = await collectTelegramNativeHistory({range: {mode: 'all'}});
    expect(result.available).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.messages).toEqual([]);
    expect(result.stoppedReason).toBe('telegram-manager-not-ready');
  });

  it('downloads native Telegram media through the page media manager without exposing the TL object', async () => {
    const downloaded: unknown[] = [];
    const {calls} = installMockTelegramPage([
      {
        _: 'messages.messages',
        count: 1,
        messages: [{
          _: 'message',
          id: 9,
          date: 900,
          message: 'attachment',
          entities: [],
          media: {
            _: 'messageMediaDocument',
            document: {
              _: 'document', id: '99', access_hash: '7', size: 3, mime_type: 'text/plain',
              attributes: [{_: 'documentAttributeFilename', file_name: 'note.txt'}],
            },
          },
        }],
        users: [],
        chats: [],
      },
    ]);
    testGlobal.appDownloadManager = {
      downloadMedia: async ({media}: {media: unknown}) => {
        downloaded.push(media);
        return new Blob(['abc'], {type: 'text/plain'});
      },
    };

    const result = await collectTelegramNativeHistory({range: {mode: 'all'}});
    expect(result.messages[0]).toMatchObject({
      media_type: 'file',
      media_file_name: 'note.txt',
      _telegram_media_ref: '42:0:9',
    });
    expect((result.messages[0] as Record<string, unknown>).media).toBeUndefined();
    const blob = await downloadTelegramNativeMedia('42:0:9');
    expect(await blob.text()).toBe('abc');
    expect(downloaded).toHaveLength(1);
    expect(calls).toHaveLength(1);
  }, 8_000);

  it('keeps photo media on the same opaque page-session route', async () => {
    const {calls} = installMockTelegramPage([
      {
        _: 'messages.messages',
        count: 1,
        messages: [{
          _: 'message', id: 10, date: 1_000, message: 'photo', entities: [],
          media: {
            _: 'messageMediaPhoto',
            photo: {
              _: 'photo', id: '100', access_hash: '8',
              sizes: [{_: 'photoSize', w: 2, h: 2, size: 4}],
            },
          },
        }],
        users: [],
        chats: [],
      },
    ]);
    testGlobal.appDownloadManager = {
      downloadMedia: async () => new Blob(['png'], {type: 'image/png'}),
    };

    const result = await collectTelegramNativeHistory({range: {mode: 'all'}});
    expect(result.messages[0]).toMatchObject({media_type: 'photo', _telegram_media_ref: '42:0:10'});
    const blob = await downloadTelegramNativeMedia('42:0:10');
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('png');
    expect(calls).toHaveLength(1);
  }, 8_000);
});
