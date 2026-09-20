/**
 * Upload validation for documents sent to the AI endpoints.
 *
 * Validation is by *content*, not by the client-declared MIME type or the file
 * extension: both are attacker-controlled, and a mislabelled file would
 * otherwise be forwarded to a paid API on the client's say-so. The magic bytes
 * are checked against the declared type and the declared type must be one we
 * actually accept.
 */

import { maxDocumentBytes } from './env.js';
import { ApiError } from './http.js';

export type DocumentMediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

const ACCEPTED: DocumentMediaType[] = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

export const ACCEPTED_MEDIA_TYPES: readonly string[] = ACCEPTED;

/** Leading bytes that identify each accepted format. */
const MAGIC: Record<DocumentMediaType, (bytes: Uint8Array) => boolean> = {
  'application/pdf': (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46, // %PDF
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) =>
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a,
  'image/webp': (b) =>
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // RIFF
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50, // WEBP
};

export interface ValidatedDocument {
  base64: string;
  mediaType: DocumentMediaType;
  byteLength: number;
  isPdf: boolean;
}

function isAccepted(value: unknown): value is DocumentMediaType {
  return typeof value === 'string' && (ACCEPTED as string[]).includes(value);
}

/**
 * Validates a base64 document from a request body.
 *
 * Checks, in order: presence, declared type, decoded size, and magic bytes.
 * Size is measured on the *decoded* bytes because base64 inflates by a third —
 * checking the encoded length would let a file a third larger than the limit
 * through.
 */
export function validateDocument(input: {
  base64?: unknown;
  mediaType?: unknown;
}): ValidatedDocument {
  if (typeof input.base64 !== 'string' || input.base64.length === 0) {
    throw new ApiError('invalid_request', 'No document was included in the request.');
  }
  if (!isAccepted(input.mediaType)) {
    throw new ApiError(
      'unsupported_file_type',
      'That file type is not supported. Upload a PDF, JPEG, PNG, or WebP.',
      { accepted: ACCEPTED },
    );
  }

  // Strip a data-URL prefix if one slipped through, then validate the alphabet
  // so a malformed payload fails here rather than inside the provider call.
  const base64 = input.base64.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ApiError('invalid_request', 'The uploaded document could not be read.');
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    throw new ApiError('invalid_request', 'The uploaded document could not be read.');
  }

  const limit = maxDocumentBytes();
  if (bytes.byteLength === 0) {
    throw new ApiError('invalid_request', 'The uploaded document is empty.');
  }
  if (bytes.byteLength > limit) {
    throw new ApiError(
      'file_too_large',
      `That file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB. The limit is ${(limit / 1024 / 1024).toFixed(0)} MB — try a smaller scan or a photo at lower resolution.`,
      { limitBytes: limit, actualBytes: bytes.byteLength },
    );
  }

  // The declared type must match what the bytes actually are.
  const check = MAGIC[input.mediaType];
  if (bytes.byteLength < 12 || !check(new Uint8Array(bytes.subarray(0, 12)))) {
    throw new ApiError(
      'unsupported_file_type',
      'That file does not look like the type it claims to be. Upload a PDF, JPEG, PNG, or WebP.',
    );
  }

  return {
    base64,
    mediaType: input.mediaType,
    byteLength: bytes.byteLength,
    isPdf: input.mediaType === 'application/pdf',
  };
}

/** Builds the content block Anthropic expects for a validated document. */
export function documentContentBlock(document: ValidatedDocument) {
  return document.isPdf
    ? {
        type: 'document' as const,
        source: {
          type: 'base64' as const,
          media_type: 'application/pdf' as const,
          data: document.base64,
        },
      }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: document.mediaType,
          data: document.base64,
        },
      };
}
