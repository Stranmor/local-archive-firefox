import type * as WasmPublicApi from '@/src/generated/local-archive-core/local_archive_core.js';
import * as wasmBindingModule from '@/src/generated/local-archive-core/local_archive_core_bg.js';
import { LOCAL_ARCHIVE_CORE_WASM_BASE64 } from '@/src/generated/local-archive-core/local_archive_core_wasm';

type WasmBindings = typeof WasmPublicApi & {
  __wbg_set_wasm: (exports: WebAssembly.Exports) => void;
};

function decodeWasmBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

const wasmBindings = wasmBindingModule as unknown as WasmBindings;
const wasmModule = new WebAssembly.Module(decodeWasmBase64(LOCAL_ARCHIVE_CORE_WASM_BASE64));
const wasmInstance = new WebAssembly.Instance(wasmModule, {
  './local_archive_core_bg.js': wasmBindingModule as unknown as WebAssembly.ModuleImports,
});
const wasmExports = wasmInstance.exports as WebAssembly.Exports & {
  __wbindgen_start?: () => void;
};
wasmBindings.__wbg_set_wasm(wasmExports);
wasmExports.__wbindgen_start?.();

const {
  ArchiveBuilder: WasmArchiveBuilder,
  ExportSession: WasmExportSession,
  connectorMatchesOrigin: wasmConnectorMatchesOrigin,
  coreVersion: wasmCoreVersion,
  filterMessagesForRange: wasmFilterMessagesForRange,
  matchesArchiveFilename: wasmMatchesArchiveFilename,
  normalizeConnectorDescriptor: wasmNormalizeConnectorDescriptor,
  normalizeExportRange: wasmNormalizeExportRange,
  normalizePreferences: wasmNormalizePreferences,
  normalizeQuickExportDefaults: wasmNormalizeQuickExportDefaults,
  normalizeQuickExportRequest: wasmNormalizeQuickExportRequest,
  validateArchivePassword: wasmValidateArchivePassword,
  verifyArchive: wasmVerifyArchive,
} = wasmBindings;

export interface RustCoreFailure {
  code: string;
  message: string;
}

export interface RustArchiveArtifact {
  requestId: string;
  artifactId: string;
  bytes: Uint8Array;
  size: number;
  entryCount: number;
  encrypted: boolean;
  partial: boolean;
  messagesIncluded: number;
  structureVerified: true;
  reportReadable: true;
}

export interface RustArchiveEntry {
  name: string;
  bytes: Uint8Array;
}

export class RustCoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RustCoreError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function rustCoreError(error: unknown, fallbackMessage: string): RustCoreError {
  if (error instanceof RustCoreError) return error;
  if (isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string') {
    return new RustCoreError(error.code, error.message);
  }
  if (error instanceof Error) return new RustCoreError('archive-engine-failed', error.message);
  return new RustCoreError('archive-engine-failed', fallbackMessage);
}

function callRust<T>(operation: () => T, fallbackMessage: string): T {
  try {
    return operation();
  } catch (error) {
    throw rustCoreError(error, fallbackMessage);
  }
}

export function rustCoreVersion(): string {
  return wasmCoreVersion();
}

export function normalizeExportRangeInRust<T>(value: unknown): T {
  return callRust(
    () => wasmNormalizeExportRange(value) as T,
    'The export range could not be normalized.',
  );
}

export function normalizeQuickExportRequestInRust<T>(value: unknown): T {
  return callRust(
    () => wasmNormalizeQuickExportRequest(value) as T,
    'The export request could not be normalized.',
  );
}

export function normalizePreferencesInRust<T>(value: unknown): T {
  return callRust(
    () => wasmNormalizePreferences(value) as T,
    'The export preferences could not be normalized.',
  );
}

export function normalizeQuickExportDefaultsInRust<T>(value: unknown): T {
  return callRust(
    () => wasmNormalizeQuickExportDefaults(value) as T,
    'The quick export defaults could not be normalized.',
  );
}

export function normalizeConnectorDescriptorInRust<T>(value: unknown): T {
  return callRust(
    () => wasmNormalizeConnectorDescriptor(value) as T,
    'The connector descriptor could not be normalized.',
  );
}

export function connectorMatchesOriginInRust(
  allowedOrigins: readonly string[],
  origin: string,
): boolean {
  return callRust(
    () => wasmConnectorMatchesOrigin(allowedOrigins, origin),
    'The connector origin could not be checked.',
  );
}

export function filterMessagesForRangeInRust<T>(messages: readonly T[], range: unknown): T[] {
  return callRust(
    () => wasmFilterMessagesForRange(messages, range) as T[],
    'The selected message range could not be applied.',
  );
}

export function matchesArchiveFilenameInRust(actualName: string, requestedName: string): boolean {
  return wasmMatchesArchiveFilename(actualName, requestedName);
}

export function validateArchivePasswordInRust(value: string): void {
  callRust(() => wasmValidateArchivePassword(value), 'The archive password is invalid.');
}

export function createArchiveInRust(
  requestId: string,
  compressionLevel: number,
  password: string | null,
  entries: readonly RustArchiveEntry[],
): RustArchiveArtifact {
  const builder = callRust(
    () => new WasmArchiveBuilder(requestId, compressionLevel, password),
    'The Rust archive builder could not be created.',
  );
  try {
    for (const entry of entries) {
      callRust(
        () => builder.addEntry(entry.name, entry.bytes),
        `The archive entry ${entry.name} could not be added.`,
      );
    }
    const artifact = callRust(
      () => builder.finish(),
      'The Rust archive builder could not finish the ZIP.',
    );
    try {
      if (!artifact.reportReadable || !artifact.structureVerified) {
        throw new RustCoreError(
          'archive-engine-failed',
          'Rust did not return a complete archive validation receipt.',
        );
      }
      return {
        requestId: artifact.requestId,
        artifactId: artifact.artifactId,
        bytes: artifact.bytes(),
        size: artifact.size,
        entryCount: artifact.entryCount,
        encrypted: artifact.encrypted,
        partial: artifact.partial,
        messagesIncluded: Number(artifact.messagesIncluded),
        structureVerified: true,
        reportReadable: true,
      };
    } finally {
      artifact.free();
    }
  } finally {
    builder.free();
  }
}

export function verifyArchiveInRust<T>(
  bytes: Uint8Array,
  requestId: string,
  filename: string,
  expectedFilename: string,
  password: string | null,
): T {
  return callRust(
    () => wasmVerifyArchive(bytes, requestId, filename, expectedFilename, password) as T,
    'The ZIP could not be verified by the Rust core.',
  );
}

export class RustExportSession {
  readonly #inner: WasmPublicApi.ExportSession;

  constructor(request: unknown) {
    this.#inner = callRust(
      () => new WasmExportSession(request),
      'The typed export session could not be created.',
    );
  }

  request<T>(): T {
    return callRust(() => this.#inner.request() as T, 'The export request could not be read.');
  }

  snapshot<T>(): T {
    return callRust(() => this.#inner.snapshot() as T, 'The export state could not be read.');
  }

  beginCollection(): void {
    callRust(() => this.#inner.beginCollection(), 'The export could not start collecting messages.');
  }

  finishCollection<T>(messages: readonly T[]): T[] {
    return callRust(
      () => this.#inner.finishCollection(messages) as T[],
      'The export could not finish collecting messages.',
    );
  }

  beginArchive(requestId: string): void {
    callRust(() => this.#inner.beginArchive(requestId), 'The archive build could not start.');
  }

  archiveReady(receipt: unknown): void {
    callRust(
      () => this.#inner.archiveReady(receipt),
      'The archive could not transition to ready.',
    );
  }

  beginSave(filename: string): void {
    callRust(() => this.#inner.beginSave(filename), 'The archive save could not start.');
  }

  complete(receipt: unknown): void {
    callRust(() => this.#inner.complete(receipt), 'The export could not complete.');
  }

  requestPartial(): void {
    callRust(() => this.#inner.requestPartial(), 'The export could not switch to a partial result.');
  }

  fail(code: string, message: string): void {
    callRust(() => this.#inner.fail(code, message), 'The export failure could not be recorded.');
  }

  free(): void {
    this.#inner.free();
  }
}
