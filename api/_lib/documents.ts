/**
 * Upload validation for documents sent to the AI endpoints.
 *
 * Validation is by *content*, not by the client-declared MIME type or the file
 * extension: both are attacker-controlled, and a mislabelled file would
 * otherwise be forwarded to a paid API on the client's say-so. The magic bytes
 * are checked against the declared type and the declared type must be one we
 * actually accept.
 */

import { maxDocumentBytes, maxDocumentPages, maxDocumentTotalBytes } from './env.js';
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

/**
 * Validates a document that may arrive as several pages.
 *
 * A file too large to send whole is split by the browser into page images, so
 * the request body carries a `pages` array instead of a single document. The
 * older single-document shape is still accepted, because a client that has not
 * reloaded since the last deploy still sends it, and because the
 * "read it with AI instead" retry has only ever had one file to send.
 *
 * Every page is validated exactly as a lone document is — declared type on the
 * allow-list, magic bytes matching that type, size within the per-document cap
 * — and the set additionally has a page count and a combined size limit, so a
 * caller cannot turn one allowance-spending request into an unbounded upload.
 */
export function validateDocumentSet(input: Record<string, unknown>): ValidatedDocument[] {
  const raw = input.pages;

  if (raw === undefined || raw === null) {
    return [validateDocument(input as { base64?: unknown; mediaType?: unknown })];
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError('invalid_request', 'No document was included in the request.');
  }

  const pageLimit = maxDocumentPages();
  if (raw.length > pageLimit) {
    throw new ApiError(
      'invalid_request',
      `That document has ${raw.length} pages and ${pageLimit} is the most that can be read at once. Split the file and upload the part with the figures on it.`,
      { limitPages: pageLimit, actualPages: raw.length },
    );
  }

  const pages = raw.map((page) => {
    if (typeof page !== 'object' || page === null) {
      throw new ApiError('invalid_request', 'The uploaded document could not be read.');
    }
    return validateDocument(page as { base64?: unknown; mediaType?: unknown });
  });

  const totalBytes = pages.reduce((sum, page) => sum + page.byteLength, 0);
  const totalLimit = maxDocumentTotalBytes();
  if (totalBytes > totalLimit) {
    throw new ApiError(
      'file_too_large',
      `Those pages come to ${(totalBytes / 1024 / 1024).toFixed(1)} MB together, and the limit is ${(totalLimit / 1024 / 1024).toFixed(0)} MB. Upload fewer pages at a time.`,
      { limitBytes: totalLimit, actualBytes: totalBytes },
    );
  }

  return pages;
}

/**
 * Builds the content blocks for a document set, labelling each page.
 *
 * The label matters: without it a two-page stub reads as two unrelated
 * documents, and the model has no way to say which figure came from which page.
 */
export function documentContentBlocks(
  documents: ValidatedDocument[],
): ({ type: 'text'; text: string } | ReturnType<typeof documentContentBlock>)[] {
  if (documents.length === 1) return [documentContentBlock(documents[0])];

  return documents.flatMap((document, index) => [
    { type: 'text' as const, text: `Page ${index + 1} of ${documents.length}:` },
    documentContentBlock(document),
  ]);
}
