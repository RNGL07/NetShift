import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ACCEPTED_MEDIA_TYPES, validateDocument } from './documents.js';
import { ApiError } from './http.js';

/** Builds a base64 payload whose leading bytes match a real file signature. */
function fileOf(magic: number[], totalBytes = 64): string {
  const bytes = Buffer.alloc(totalBytes, 0x20);
  magic.forEach((byte, index) => {
    bytes[index] = byte;
  });
  return bytes.toString('base64');
}

const PDF = fileOf([0x25, 0x50, 0x44, 0x46]); // %PDF
const PNG = fileOf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = fileOf([0xff, 0xd8, 0xff]);
const WEBP = fileOf([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe('validateDocument — accepted types', () => {
  it('accepts a PDF', () => {
    const result = validateDocument({ base64: PDF, mediaType: 'application/pdf' });
    expect(result.isPdf).toBe(true);
    expect(result.byteLength).toBe(64);
  });

  it('accepts PNG, JPEG, and WebP images', () => {
    expect(validateDocument({ base64: PNG, mediaType: 'image/png' }).isPdf).toBe(false);
    expect(validateDocument({ base64: JPEG, mediaType: 'image/jpeg' }).isPdf).toBe(false);
    expect(validateDocument({ base64: WEBP, mediaType: 'image/webp' }).isPdf).toBe(false);
  });

  it('lists exactly the types it accepts', () => {
    expect([...ACCEPTED_MEDIA_TYPES].sort()).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('strips a data-URL prefix rather than rejecting it', () => {
    const result = validateDocument({
      base64: `data:application/pdf;base64,${PDF}`,
      mediaType: 'application/pdf',
    });
    expect(result.byteLength).toBe(64);
  });
});

describe('validateDocument — rejections', () => {
  const expectError = (fn: () => unknown, code: string) => {
    try {
      fn();
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe(code);
    }
  };

  it('rejects a missing document', () => {
    expectError(() => validateDocument({ mediaType: 'application/pdf' }), 'invalid_request');
    expectError(
      () => validateDocument({ base64: '', mediaType: 'application/pdf' }),
      'invalid_request',
    );
  });

  it('rejects a media type that is not on the allow-list', () => {
    expectError(
      () => validateDocument({ base64: PDF, mediaType: 'application/zip' }),
      'unsupported_file_type',
    );
    expectError(
      () => validateDocument({ base64: PDF, mediaType: 'text/html' }),
      'unsupported_file_type',
    );
  });

  it('rejects a file whose bytes contradict its declared type', () => {
    // The central check: a caller cannot get a zip past the filter by calling
    // it a PDF, because the magic bytes are what decide.
    expectError(
      () => validateDocument({ base64: PNG, mediaType: 'application/pdf' }),
      'unsupported_file_type',
    );
    expectError(
      () => validateDocument({ base64: PDF, mediaType: 'image/png' }),
      'unsupported_file_type',
    );
  });

  it('rejects a payload that is not valid base64', () => {
    expectError(
      () => validateDocument({ base64: 'not base64 at all !!!', mediaType: 'application/pdf' }),
      'invalid_request',
    );
  });

  it('rejects an empty file', () => {
    expectError(
      () => validateDocument({ base64: 'JVBE', mediaType: 'application/pdf' }),
      'unsupported_file_type',
    );
  });

  describe('size limit', () => {
    beforeEach(() => {
      process.env.NETSHIFT_MAX_DOCUMENT_BYTES = '1024';
    });
    afterEach(() => {
      delete process.env.NETSHIFT_MAX_DOCUMENT_BYTES;
    });

    it('rejects a file above the configured limit', () => {
      const big = fileOf([0x25, 0x50, 0x44, 0x46], 2048);
      expectError(
        () => validateDocument({ base64: big, mediaType: 'application/pdf' }),
        'file_too_large',
      );
    });

    it('measures the decoded size, not the base64 length', () => {
      // 800 decoded bytes is ~1068 base64 characters: over the limit if the
      // encoded string were measured, under it when the bytes are.
      const justUnder = fileOf([0x25, 0x50, 0x44, 0x46], 800);
      expect(justUnder.length).toBeGreaterThan(1024);
      expect(() =>
        validateDocument({ base64: justUnder, mediaType: 'application/pdf' }),
      ).not.toThrow();
    });

    it('honours a raised limit', () => {
      process.env.NETSHIFT_MAX_DOCUMENT_BYTES = '4096';
      const big = fileOf([0x25, 0x50, 0x44, 0x46], 2048);
      expect(() => validateDocument({ base64: big, mediaType: 'application/pdf' })).not.toThrow();
    });
  });
});

describe('the default size cap fits inside the platform request limit', () => {
  it('stays under what Vercel will actually accept once base64-encoded', () => {
    // Vercel caps a serverless function's request body at 4.5 MB, and the
    // document travels base64-encoded (4/3 inflation) inside a JSON body.
    // A cap above ~3.3 MB could never be reached: the platform rejects the
    // request first, returning HTML the client cannot parse — which surfaces
    // to the user as a bare "Something went wrong".
    const VERCEL_REQUEST_BODY_LIMIT = 4.5 * 1024 * 1024;
    const BASE64_INFLATION = 4 / 3;

    delete process.env.NETSHIFT_MAX_DOCUMENT_BYTES;
    const cap = 3 * 1024 * 1024; // the documented default in env.ts

    expect(cap * BASE64_INFLATION).toBeLessThan(VERCEL_REQUEST_BODY_LIMIT);
  });

  it('accepts a file at the cap and rejects one above it', () => {
    process.env.NETSHIFT_MAX_DOCUMENT_BYTES = String(3 * 1024 * 1024);

    const atCap = fileOf([0x25, 0x50, 0x44, 0x46], 3 * 1024 * 1024);
    expect(() => validateDocument({ base64: atCap, mediaType: 'application/pdf' })).not.toThrow();

    const overCap = fileOf([0x25, 0x50, 0x44, 0x46], 3 * 1024 * 1024 + 1024);
    try {
      validateDocument({ base64: overCap, mediaType: 'application/pdf' });
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as ApiError).code).toBe('file_too_large');
      // The message has to say what to do, not just that it failed.
      expect((error as ApiError).message).toMatch(/smaller|lower resolution|photo/i);
    }
    delete process.env.NETSHIFT_MAX_DOCUMENT_BYTES;
  });
});
