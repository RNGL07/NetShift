/**
 * Prepares a document for the transcription endpoint.
 *
 * The problem this solves: Vercel caps a serverless function's request body at
 * 4.5 MB, and the file travels base64-encoded (4/3 inflation), so anything over
 * roughly 3.3 MB of raw bytes is rejected by the platform before the function
 * runs. Simply raising the client-side number does not work — the request never
 * arrives, and the platform's HTML error is not something the client can parse,
 * so the user sees a bare "Something went wrong".
 *
 * So instead of rejecting large files, this shrinks them to fit:
 *
 * - A **photo or screenshot** is decoded, scaled so its long edge is at most
 *   1568 px, and re-encoded as JPEG. That is not a quality compromise for this
 *   purpose: Anthropic downsamples images above that edge anyway, so a 12 MP
 *   phone photo and a 1568 px one are read identically — one is just 30× the
 *   bytes. A 10 MB screenshot lands around 300 KB.
 *
 * - A **large or scanned PDF** is rendered page by page to images at the same
 *   bound and sent as a sequence of pages. A 40 MB scan becomes a few hundred
 *   KB per page. Small PDFs are still forwarded untouched, because the native
 *   PDF path preserves the real text layer and reads better than a picture of
 *   the same page.
 *
 * The practical effect is that there is no longer a file size the user has to
 * care about. The only remaining ceiling is a page count.
 */

import { fileToBase64, openPdf } from './pdfText';

/**
 * Longest edge, in pixels, of an image sent for transcription.
 *
 * Anthropic scales anything larger down to roughly this before the model sees
 * it, so sending more pixels costs bytes and time and buys nothing.
 */
const MAX_IMAGE_EDGE = 1568;

/**
 * Total encoded payload budget, under Vercel's 4.5 MB request-body cap.
 *
 * The margin covers the JSON envelope and the per-page field names.
 */
const MAX_ENCODED_BYTES = 4.0 * 1024 * 1024;

/** Raw PDFs at or under this are forwarded as-is, text layer intact. */
const PDF_PASSTHROUGH_BYTES = 3 * 1024 * 1024;

/**
 * Most pages rendered from one PDF.
 *
 * A pay stub is one or two pages and a wage scale rarely more than a few. The
 * cap exists so a 200-page export cannot turn one upload into a very large,
 * very slow request.
 */
const MAX_PDF_PAGES = 8;

/** JPEG qualities tried in order until a page fits its budget. */
const QUALITY_STEPS = [0.85, 0.72, 0.6, 0.45];

export type PreparedMediaType = 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';

export interface PreparedPage {
  base64: string;
  mediaType: PreparedMediaType;
}

export interface PreparedDocument {
  pages: PreparedPage[];
  /**
   * What was done to the file, in the user's terms, or null when it was sent
   * untouched. Shown on screen so shrinking never happens invisibly.
   */
  note: string | null;
}

export class DocumentPrepError extends Error {}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Encoded length of a base64 string, which is what the platform measures. */
function encodedLength(pages: PreparedPage[]): number {
  return pages.reduce((total, page) => total + page.base64.length, 0);
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Draws a source onto a canvas scaled so its long edge is at most `maxEdge`,
 * then encodes it as the largest JPEG that fits `budgetBytes`.
 *
 * An image already inside the bound is not upscaled — that would invent detail
 * and cost bytes.
 */
async function encodeToBudget(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  budgetBytes: number,
  maxEdge = MAX_IMAGE_EDGE,
): Promise<string> {
  const longEdge = Math.max(sourceWidth, sourceHeight);
  let scale = longEdge > maxEdge ? maxEdge / longEdge : 1;

  // Two passes at most: try the target size at falling quality, then, if even
  // the lowest quality is too big, halve the dimensions once and repeat.
  for (let attempt = 0; attempt < 2; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));

    const context = canvas.getContext('2d');
    if (!context) throw new DocumentPrepError('This browser cannot resize images.');
    // White rather than transparent: a transparent PNG flattened onto black
    // turns dark text invisible.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    let smallest: string | null = null;
    for (const quality of QUALITY_STEPS) {
      const blob = await canvasToBlob(canvas, quality);
      if (!blob) continue;
      const base64 = await fileToBase64(blob);
      smallest = base64;
      if (base64.length <= budgetBytes) return base64;
    }
    if (attempt === 1 && smallest) return smallest;
    scale *= 0.65;
  }

  throw new DocumentPrepError('That image could not be prepared for transcribing.');
}

/** Shrinks a photo or screenshot to something that will fit in one request. */
async function prepareImage(file: File): Promise<PreparedDocument> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new DocumentPrepError(
      'That image could not be opened. It may be corrupt, or in a format this browser cannot read.',
    );
  }

  try {
    const originalBytes = file.size;
    const base64 = await encodeToBudget(bitmap, bitmap.width, bitmap.height, MAX_ENCODED_BYTES);
    const shrank = base64.length * 0.75 < originalBytes * 0.9;
    return {
      pages: [{ base64, mediaType: 'image/jpeg' }],
      note: shrank
        ? `Resized from ${megabytes(originalBytes)} to about ${megabytes(base64.length * 0.75)} before sending. Text stays readable at this size.`
        : null,
    };
  } finally {
    bitmap.close();
  }
}

/** Renders a PDF's pages to images when the file itself is too big to send. */
async function preparePdfAsImages(file: File): Promise<PreparedDocument> {
  const pdf = await openPdf(file);
  const pageCount = Math.min(pdf.numPages, MAX_PDF_PAGES);
  if (pageCount === 0) throw new DocumentPrepError('That PDF has no pages.');

  // Split the budget evenly so one dense page cannot crowd out the rest.
  const perPageBudget = Math.floor(MAX_ENCODED_BYTES / pageCount);
  const pages: PreparedPage[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const unscaled = page.getViewport({ scale: 1 });
    const longEdge = Math.max(unscaled.width, unscaled.height);
    // Render at up to 2× the target edge, then let encodeToBudget scale down —
    // rendering above the final size keeps small print sharp.
    const renderScale = Math.min((MAX_IMAGE_EDGE * 2) / longEdge, 4);
    const viewport = page.getViewport({ scale: Math.max(renderScale, 1) });

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    if (!context) throw new DocumentPrepError('This browser cannot render PDF pages.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: context, viewport }).promise;

    const base64 = await encodeToBudget(canvas, canvas.width, canvas.height, perPageBudget);
    pages.push({ base64, mediaType: 'image/jpeg' });
    page.cleanup();
  }

  const skipped = pdf.numPages - pageCount;
  const pageWord = pageCount === 1 ? 'page' : 'pages';
  return {
    pages,
    note:
      `That PDF is ${megabytes(file.size)}, too large to send whole, so its ${pageCount} ${pageWord} ` +
      `${pageCount === 1 ? 'was' : 'were'} converted to images first.` +
      (skipped > 0
        ? ` Only the first ${pageCount} of ${pdf.numPages} pages were read — split the file if the figures are later in it.`
        : ''),
  };
}

/**
 * Turns any accepted file into pages small enough to reach the server.
 *
 * Throws `DocumentPrepError` with a message written for the user. Callers show
 * that message as-is.
 */
export async function prepareForUpload(file: File): Promise<PreparedDocument> {
  if (file.size === 0) throw new DocumentPrepError('That file is empty.');

  if (file.type === 'application/pdf') {
    if (file.size <= PDF_PASSTHROUGH_BYTES) {
      // Small enough to send as a real PDF, which reads better than a picture
      // of the same page when there is a text layer.
      return {
        pages: [{ base64: await fileToBase64(file), mediaType: 'application/pdf' }],
        note: null,
      };
    }
    return preparePdfAsImages(file);
  }

  const prepared = await prepareImage(file);
  if (encodedLength(prepared.pages) > MAX_ENCODED_BYTES) {
    throw new DocumentPrepError(
      'That image is too detailed to send even after resizing. Try a screenshot of the page instead of a photo.',
    );
  }
  return prepared;
}

/** Exposed for tests and for the copy shown beside the file picker. */
export const PREP_LIMITS = {
  maxImageEdge: MAX_IMAGE_EDGE,
  maxEncodedBytes: MAX_ENCODED_BYTES,
  pdfPassthroughBytes: PDF_PASSTHROUGH_BYTES,
  maxPdfPages: MAX_PDF_PAGES,
} as const;
