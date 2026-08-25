import {
  createArchiveInRust,
  RustCoreError,
  verifyArchiveInRust,
} from '@/src/rust/core';
import {
  type ArchiveCreateFailure,
  type ArchiveCreateRequest,
  type ArchiveCreateResponse,
  type ArchiveErrorCode,
  type ArchiveVerifyErrorCode,
  type ArchiveVerifyFailure,
  type ArchiveVerifyRequest,
  type ArchiveVerifyResponse,
  type ArchiveVerifySuccess,
  type ArchiveWireContent,
  isArchiveCreateRequest,
  isArchiveVerifyRequest,
} from './archive-protocol';

const MAX_ENTRY_COUNT = 100_000;

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function failure(
  requestId: string,
  code: ArchiveErrorCode,
  message: string,
): ArchiveCreateFailure {
  return { ok: false, requestId, code, message };
}

function verifyFailure(
  requestId: string,
  code: ArchiveVerifyErrorCode,
  message: string,
): ArchiveVerifyFailure {
  return { ok: false, requestId, code, message };
}

function isArchiveContent(value: unknown): value is ArchiveWireContent {
  return typeof value === 'string'
    || value instanceof Blob
    || value instanceof ArrayBuffer
    || value instanceof Uint8Array;
}

function decodeBase64(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value.replace(/\s+/gu, ''));
  } catch {
    throw new RustCoreError('invalid-entry', 'One archive entry contained invalid base64 data.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function archiveContentToBytes(content: ArchiveWireContent, base64: boolean): Promise<Uint8Array> {
  if (base64) {
    if (typeof content !== 'string') {
      throw new RustCoreError('invalid-entry', 'Base64 archive entries must be strings.');
    }
    return decodeBase64(content);
  }
  if (typeof content === 'string') return new TextEncoder().encode(content);
  if (content instanceof Blob) return new Uint8Array(await content.arrayBuffer());
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  return new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
}

function createFailureFromError(requestId: string, error: unknown): ArchiveCreateFailure {
  if (error instanceof RustCoreError) {
    const code: ArchiveErrorCode = error.code === 'invalid-request' || error.code === 'invalid-entry'
      ? error.code
      : 'archive-engine-failed';
    return failure(requestId, code, error.message);
  }
  return failure(
    requestId,
    'archive-engine-failed',
    error instanceof Error ? error.message : 'The ZIP could not be created.',
  );
}

function verifyFailureFromError(requestId: string, error: unknown): ArchiveVerifyFailure {
  const supported = new Set<ArchiveVerifyErrorCode>([
    'invalid-request',
    'filename-mismatch',
    'password-required',
    'wrong-password',
    'not-telearchive',
    'verification-limit',
    'archive-engine-failed',
  ]);
  if (error instanceof RustCoreError) {
    const code = supported.has(error.code as ArchiveVerifyErrorCode)
      ? error.code as ArchiveVerifyErrorCode
      : 'archive-engine-failed';
    return verifyFailure(requestId, code, error.message);
  }
  return verifyFailure(
    requestId,
    'archive-engine-failed',
    error instanceof Error ? error.message : 'The ZIP could not be verified.',
  );
}

export async function createArchiveFromRequest(value: unknown): Promise<ArchiveCreateResponse> {
  if (!isArchiveCreateRequest(value)) {
    return failure('', 'invalid-request', 'The archive request was incomplete.');
  }
  const request: ArchiveCreateRequest = value;
  if (request.entries.length === 0 || request.entries.length > MAX_ENTRY_COUNT) {
    return failure(request.requestId, 'invalid-request', 'The archive entry count is invalid.');
  }

  try {
    const entries = await Promise.all(request.entries.map(async (entry) => {
      if (
        !entry
        || typeof entry.name !== 'string'
        || typeof entry.base64 !== 'boolean'
        || !isArchiveContent(entry.content)
      ) {
        throw new RustCoreError('invalid-entry', 'One archive entry was invalid.');
      }
      return {
        name: entry.name,
        bytes: await archiveContentToBytes(entry.content, entry.base64),
      };
    }));
    const artifact = createArchiveInRust(
      request.requestId,
      request.compressionLevel,
      request.password,
      entries,
    );
    const archiveBuffer = new ArrayBuffer(artifact.bytes.byteLength);
    new Uint8Array(archiveBuffer).set(artifact.bytes);
    const blob = new Blob([archiveBuffer], { type: 'application/zip' });
    if (blob.size !== artifact.size) {
      return failure(
        request.requestId,
        'archive-engine-failed',
        'The browser did not preserve the Rust archive bytes.',
      );
    }
    return {
      ok: true,
      requestId: request.requestId,
      blob,
      size: artifact.size,
      entryCount: artifact.entryCount,
      encrypted: artifact.encrypted,
      validation: {
        requestId: artifact.requestId,
        artifactId: artifact.artifactId,
        size: artifact.size,
        structureVerified: true,
        entryCount: artifact.entryCount,
        reportReadable: artifact.reportReadable,
        encrypted: artifact.encrypted,
        partial: artifact.partial,
        messagesIncluded: artifact.messagesIncluded,
      },
    };
  } catch (error) {
    return createFailureFromError(request.requestId, error);
  }
}

export async function verifyArchiveFromRequest(value: unknown): Promise<ArchiveVerifyResponse> {
  if (!isArchiveVerifyRequest(value)) {
    return verifyFailure('', 'invalid-request', 'The local verification request was incomplete.');
  }
  const request: ArchiveVerifyRequest = value;
  try {
    const bytes = new Uint8Array(await request.blob.arrayBuffer());
    const receipt = verifyArchiveInRust<Omit<ArchiveVerifySuccess, 'ok'>>(
      bytes,
      request.requestId,
      request.filename,
      request.expectedFilename,
      request.password,
    );
    return { ok: true, ...receipt };
  } catch (error) {
    return verifyFailureFromError(request.requestId, error);
  }
}
