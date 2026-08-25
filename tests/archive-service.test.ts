import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import JSZip from 'jszip';
import { browser } from 'wxt/browser';
import { describe, expect, it, vi } from 'vitest';
import { TeleArchiveRemoteZip } from '@/src/shared/archive-client';
import {
  ARCHIVE_CREATE_MESSAGE,
  ARCHIVE_VERIFY_MESSAGE,
  SHOW_DOWNLOAD_MESSAGE,
  isArchiveVerifyRequest,
  isShowDownloadRequest,
} from '@/src/shared/archive-protocol';
import { createArchiveFromRequest, sha256Hex, verifyArchiveFromRequest } from '@/src/shared/archive-service';

async function createVerifiableArchive(password: string | null = null): Promise<Blob> {
  const encrypted = Boolean(password);
  const summary = {
    formatVersion: '1.1',
    historySource: 'rendered-telegram-web',
    completeHistoryNotGuaranteed: true,
    contentUploaded: false,
    archiveEncrypted: encrypted,
    partial: false,
    chatsIncluded: 1,
    messagesIncluded: 1,
    media: { included: 0 },
  };
  const result = {
    telearchive: {
      format_version: '1.1',
      history_source: 'rendered-telegram-web',
      complete_history_not_guaranteed: true,
      content_uploaded: false,
      archive_encrypted: encrypted,
      messages_in_this_chat: 1,
    },
    messages: [{ id: 1, text: 'verified locally' }],
  };
  const response = await createArchiveFromRequest({
    type: ARCHIVE_CREATE_MESSAGE,
    requestId: 'create-verifiable',
    compressionLevel: 6,
    password,
    entries: [
      { name: 'messages.html', content: '<!doctype html><html><head><meta name="local-archive-message-count" content="1"><meta name="local-archive-media-count" content="0"></head><body>verified locally</body></html>', base64: false },
      { name: 'result.json', content: JSON.stringify(result), base64: false },
      { name: 'export-summary.json', content: JSON.stringify(summary), base64: false },
    ],
  });
  if (!response.ok) throw new Error(response.message);
  return response.blob;
}

describe('isolated archive service boundary', () => {
  it('hashes the exact archive bytes used by the save boundary', async () => {
    await expect(sha256Hex(new Blob(['abc']))).resolves.toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('round-trips content through the exact runtime-message contract', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (message) => (
      createArchiveFromRequest(message)
    ));

    const blob = await new TeleArchiveRemoteZip()
      .file('messages/readme.txt', 'built outside the page realm')
      .file('media/bytes.bin', new Uint8Array([11, 22, 33]))
      .file('images/pixel.bin', 'BwgJ', { base64: true })
      .file('messages.html', '<!doctype html><html><head><meta name="local-archive-message-count" content="1"><meta name="local-archive-media-count" content="0"></head><body>one</body></html>')
      .file('result.json', JSON.stringify({
        telearchive: {
          history_source: 'rendered-telegram-web', content_uploaded: false,
          complete_history_not_guaranteed: true, archive_encrypted: false,
          messages_in_this_chat: 1,
        },
        messages: [{ id: 1 }],
      }))
      .file('export-summary.json', JSON.stringify({
        formatVersion: '1.1', historySource: 'rendered-telegram-web', contentUploaded: false,
        completeHistoryNotGuaranteed: true, archiveEncrypted: false, partial: false,
        chatsIncluded: 1, messagesIncluded: 1, media: { included: 0 },
      }))
      .generateAsync({ type: 'blob', compressionOptions: { level: 6 } });

    const zip = await JSZip.loadAsync(blob);
    expect(await zip.file('messages/readme.txt')?.async('string')).toBe('built outside the page realm');
    expect([...await zip.file('media/bytes.bin')!.async('uint8array')]).toEqual([11, 22, 33]);
    expect([...await zip.file('images/pixel.bin')!.async('uint8array')]).toEqual([7, 8, 9]);
    expect(blob.telearchiveValidation).toMatchObject({
      requestId: expect.any(String),
      artifactId: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: blob.size,
      structureVerified: true,
      entryCount: 6,
      reportReadable: true,
      encrypted: false,
      partial: false,
      messagesIncluded: 1,
    });
  });

  it('rejects unsafe entries without producing an archive', async () => {
    const response = await createArchiveFromRequest({
      type: ARCHIVE_CREATE_MESSAGE,
      requestId: 'unsafe-entry',
      compressionLevel: 6,
      password: null,
      entries: [{ name: '../outside.txt', content: 'blocked', base64: false }],
    });

    expect(response).toMatchObject({
      ok: false,
      requestId: 'unsafe-entry',
      code: 'invalid-entry',
    });
  });

  it('rejects out-of-contract compression and entry payloads', async () => {
    await expect(createArchiveFromRequest({
      type: ARCHIVE_CREATE_MESSAGE,
      requestId: 'bad-compression',
      compressionLevel: 99,
      password: null,
      entries: [{ name: 'result.json', content: '{}', base64: false }],
    })).resolves.toMatchObject({ ok: false, code: 'invalid-request' });

    await expect(createArchiveFromRequest({
      type: ARCHIVE_CREATE_MESSAGE,
      requestId: 'bad-base64',
      compressionLevel: 6,
      password: null,
      entries: [{ name: 'media.bin', content: new Uint8Array([1]), base64: true }],
    })).resolves.toMatchObject({ ok: false, code: 'invalid-entry' });
  });

  it('creates AES-256 password-protected archives without persisting the password', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async (message) => (
      createArchiveFromRequest(message)
    ));

    const password = 'correct horse battery staple';
    const blob = await new TeleArchiveRemoteZip()
      .file('result.json', JSON.stringify({
        telearchive: {
          history_source: 'rendered-telegram-web', content_uploaded: false,
          complete_history_not_guaranteed: true, archive_encrypted: true,
          messages_in_this_chat: 1,
        },
        messages: [{ id: 1, text: 'private local archive' }],
      }))
      .file('export-summary.json', JSON.stringify({
        formatVersion: '1.1', historySource: 'rendered-telegram-web', contentUploaded: false,
        completeHistoryNotGuaranteed: true, archiveEncrypted: true, partial: false,
        chatsIncluded: 1, messagesIncluded: 1, media: { included: 0 },
      }))
      .generateAsync({ type: 'blob', password });

    expect(blob.telearchiveValidation).toMatchObject({
      artifactId: expect.stringMatching(/^[a-f0-9]{64}$/),
      size: blob.size,
      structureVerified: true,
      entryCount: 2,
      reportReadable: true,
      encrypted: true,
      partial: false,
      messagesIncluded: 1,
    });

    const reader = new ZipReader(new BlobReader(blob));
    const entries = await reader.getEntries();
    expect(entries).toHaveLength(2);
    const entry = entries[0];
    if (!entry || entry.directory || !('getData' in entry)) throw new Error('Encrypted file entry is missing');
    expect(entry).toMatchObject({ encrypted: true, zipCrypto: false });
    await expect(entry.getData(new TextWriter(), { password: 'wrong password' }))
      .rejects.toThrow(/password/i);
    await expect(entry.getData(new TextWriter(), { password }))
      .resolves.toContain('private local archive');
    await reader.close();
  });

  it('turns missing or malformed service responses into a typed recoverable error', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(async () => (
      { ok: true, blob: 'not-a-blob' } as never
    ));

    await expect(new TeleArchiveRemoteZip()
      .file('messages/readme.txt', 'hello')
      .generateAsync({ type: 'blob' }))
      .rejects.toMatchObject({
        name: 'ArchiveGenerationError',
        code: 'archive-service-unavailable',
      });
  });

  it('accepts only bounded exact-filename requests at the downloaded-file reveal boundary', () => {
    expect(isShowDownloadRequest({
      type: SHOW_DOWNLOAD_MESSAGE,
      requestId: 'show-archive',
      artifactId: 'a'.repeat(64),
      downloadId: 42,
      filename: 'Telegram_Export_2026-08-10T08-00-00.zip',
      size: 512,
    })).toBe(true);
    expect(isShowDownloadRequest({
      type: SHOW_DOWNLOAD_MESSAGE,
      requestId: 'unsafe-path',
      artifactId: 'a'.repeat(64),
      downloadId: 42,
      filename: '../private.zip',
      size: 512,
    })).toBe(false);
    expect(isShowDownloadRequest({
      type: SHOW_DOWNLOAD_MESSAGE,
      requestId: 'missing-clock',
      artifactId: 'a'.repeat(64),
      filename: 'archive.zip',
      size: 512,
    })).toBe(false);
  });

  it('reopens and verifies the exact downloaded TeleArchive ZIP locally', async () => {
    const blob = await createVerifiableArchive();
    const response = await verifyArchiveFromRequest({
      type: ARCHIVE_VERIFY_MESSAGE,
      requestId: 'verify-unencrypted',
      blob,
      filename: 'Telegram_Export (1).zip',
      expectedFilename: 'Telegram_Export.zip',
      password: null,
    });

    expect(response).toEqual({
      ok: true,
      requestId: 'verify-unencrypted',
      filename: 'Telegram_Export (1).zip',
      size: blob.size,
      entryCount: 3,
      encrypted: false,
      report: {
        outputsVerified: true,
        reportReadable: true,
        chatsIncluded: 1,
        messagesIncluded: 1,
        mediaIncluded: 0,
        partial: false,
        htmlFiles: 1,
        resultJsonFiles: 1,
      },
    });
  });

  it('requires and validates the in-memory password for an AES archive', async () => {
    const password = 'correct horse battery staple';
    const blob = await createVerifiableArchive(password);
    const request = {
      type: ARCHIVE_VERIFY_MESSAGE,
      requestId: 'verify-encrypted',
      blob,
      filename: 'Telegram_Private.zip',
      expectedFilename: 'Telegram_Private.zip',
    } as const;

    await expect(verifyArchiveFromRequest({ ...request, password: null }))
      .resolves.toMatchObject({ ok: false, code: 'password-required' });
    await expect(verifyArchiveFromRequest({ ...request, password: 'incorrect password' }))
      .resolves.toMatchObject({ ok: false, code: 'wrong-password' });
    await expect(verifyArchiveFromRequest({ ...request, password }))
      .resolves.toMatchObject({
        ok: true,
        encrypted: true,
        report: { outputsVerified: true, messagesIncluded: 1 },
      });
  });

  it('rejects a mismatched or non-TeleArchive file without reading it as a receipt match', async () => {
    const blob = await createVerifiableArchive();
    await expect(verifyArchiveFromRequest({
      type: ARCHIVE_VERIFY_MESSAGE,
      requestId: 'verify-mismatch',
      blob,
      filename: 'Some_other_archive.zip',
      expectedFilename: 'Telegram_Export.zip',
      password: null,
    })).resolves.toMatchObject({ ok: false, code: 'filename-mismatch' });

    const foreignZip = await new JSZip()
      .file('notes.txt', 'not a TeleArchive export')
      .generateAsync({ type: 'blob' });
    await expect(verifyArchiveFromRequest({
      type: ARCHIVE_VERIFY_MESSAGE,
      requestId: 'verify-foreign',
      blob: foreignZip,
      filename: 'Telegram_Export.zip',
      expectedFilename: 'Telegram_Export.zip',
      password: null,
    })).resolves.toMatchObject({ ok: false, code: 'not-telearchive' });
  });

  it('defers ZIP filename policy to the Rust verifier', async () => {
    expect(isArchiveVerifyRequest({
      type: ARCHIVE_VERIFY_MESSAGE,
      requestId: 'verify-contract',
      blob: new Blob(['zip']),
      filename: 'archive.zip',
      expectedFilename: 'archive.zip',
      password: null,
    })).toBe(true);
    const unsafeRequest = {
      type: ARCHIVE_VERIFY_MESSAGE,
      requestId: 'verify-unsafe-name',
      blob: new Blob(['zip']),
      filename: '../archive.zip',
      expectedFilename: 'archive.zip',
      password: null,
    } as const;
    expect(isArchiveVerifyRequest(unsafeRequest)).toBe(true);
    await expect(verifyArchiveFromRequest(unsafeRequest)).resolves.toMatchObject({
      ok: false,
      code: 'invalid-request',
    });
  });
});
