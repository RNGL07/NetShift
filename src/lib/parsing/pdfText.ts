/**
 * Reads a PDF's text layer in the browser.
 *
 * pdf.js is loaded as a real dependency (rather than the prototype's CDN
 * script tag) and imported lazily, so the ~1 MB of PDF machinery is only
 * fetched when someone actually uploads a document.
 */

/** Below this many non-whitespace characters, it is metadata, not a text layer. */
const MIN_TEXT_LAYER_CHARS = 40;

type PdfTextItem = { str?: string; transform?: number[] };

/**
 * Opens a PDF with pdf.js, wiring up the worker.
 *
 * Shared by the text-layer reader and the page rasteriser so the worker URL is
 * resolved in exactly one place — Vite rewrites it to a real asset URL at build
 * time, and without it pdf.js silently hangs instead of failing.
 */
export async function openPdf(file: File | Blob) {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buffer = await file.arrayBuffer();
  return pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
}

/**
 * Returns the PDF's text layer as newline-separated lines, with the items on
 * each visual row joined in reading order, or `null` when there is no usable
 * text layer — the caller reads `null` as "this needs the AI path".
 */
export async function extractPdfTextLayer(file: File | Blob): Promise<string | null> {
  try {
    const pdf = await openPdf(file);

    const lines: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      // Group items into visual rows by baseline, so a label and the amount
      // sitting beside it land on one line — the field parsers rely on that.
      const rows = new Map<number, { x: number; str: string }[]>();
      for (const rawItem of content.items as PdfTextItem[]) {
        if (!rawItem || typeof rawItem.str !== 'string' || !rawItem.str.trim()) continue;
        const x = rawItem.transform ? rawItem.transform[4] : 0;
        const y = rawItem.transform ? rawItem.transform[5] : 0;
        const bucket = Math.round(y / 3); // ~3pt tolerance for baseline jitter
        const row = rows.get(bucket) ?? [];
        row.push({ x, str: rawItem.str });
        rows.set(bucket, row);
      }

      [...rows.keys()]
        .sort((a, b) => b - a) // top of the page downward
        .forEach((bucket) => {
          const text = (rows.get(bucket) ?? [])
            .sort((a, b) => a.x - b.x) // left to right
            .map((item) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) lines.push(text);
        });
    }

    const text = lines.join('\n');
    if (text.replace(/\s/g, '').length < MIN_TEXT_LAYER_CHARS) return null;
    return text;
  } catch {
    // Encrypted, corrupt, or otherwise unreadable — treat it like a scan.
    return null;
  }
}

export function isPdf(file: File | Blob): boolean {
  return file.type === 'application/pdf';
}

export async function fileToBase64(file: File | Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
