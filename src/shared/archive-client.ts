import { browser } from 'wxt/browser';
import {
  ARCHIVE_CREATE_MESSAGE,
  type ArchiveValidation,
  type ArchiveCreateRequest,
  type ArchiveErrorCode,
  type ArchiveWireContent,
  type ArchiveWireEntry,
  isArchiveCreateResponse,
} from './archive-protocol';

type ArchiveContent = string | Blob | ArrayBuffer | ArrayBufferView;

export type ValidatedArchiveBlob = Blob & {
  telearchiveValidation?: ArchiveValidation;
};

interface ArchiveFileOptions {
  base64?: boolean;
}

interface GenerateOptions {
  type?: 'blob';
  requestId?: string;
  password?: string;
  compressionOptions?: {
    level?: number;
  };
}

function toWireContent(value: ArchiveContent): ArchiveWireContent {
  if (typeof value === 'string' || value instanceof Blob || value instanceof ArrayBuffer) {
    return value;
  }
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

function createRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class ArchiveGenerationError extends Error {
  constructor(
    readonly code: ArchiveErrorCode | 'archive-service-unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveGenerationError';
  }
}

export class TeleArchiveRemoteZip {
  readonly #entries: ArchiveWireEntry[] = [];

  file(name: string, content: ArchiveContent, options: ArchiveFileOptions = {}): this {
    if (options.base64 && typeof content !== 'string') {
      throw new TypeError('Base64 archive entries must be strings');
    }
    this.#entries.push({
      name: String(name),
      content: toWireContent(content),
      base64: options.base64 === true,
    });
    return this;
  }

  async generateAsync(options: GenerateOptions = {}): Promise<ValidatedArchiveBlob> {
    if (options.type && options.type !== 'blob') {
      throw new Error(`Unsupported archive output type: ${options.type}`);
    }

    const password = options.password || null;

    const request: ArchiveCreateRequest = {
      type: ARCHIVE_CREATE_MESSAGE,
      requestId: options.requestId ?? createRequestId(),
      compressionLevel: Number(options.compressionOptions?.level ?? 6),
      password,
      entries: [...this.#entries],
    };

    let response: unknown;
    try {
      response = await browser.runtime.sendMessage(request);
    } catch (error) {
      throw new ArchiveGenerationError(
        'archive-service-unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }

    if (!isArchiveCreateResponse(response) || response.requestId !== request.requestId) {
      throw new ArchiveGenerationError(
        'archive-service-unavailable',
        'The extension archive service returned an invalid response.',
      );
    }
    if (!response.ok) throw new ArchiveGenerationError(response.code, response.message);
    let blob = response.blob as ValidatedArchiveBlob;
    try {
      Object.defineProperty(blob, 'telearchiveValidation', {
        configurable: false,
        enumerable: false,
        value: Object.freeze({ ...response.validation }),
        writable: false,
      });
    } catch {
      blob = response.blob.slice(0, response.blob.size, response.blob.type) as ValidatedArchiveBlob;
      Object.defineProperty(blob, 'telearchiveValidation', {
        configurable: false,
        enumerable: false,
        value: Object.freeze({ ...response.validation }),
        writable: false,
      });
    }
    return blob;
  }
}
