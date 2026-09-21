/**
 * Document upload with a local-first parsing path.
 *
 * The order matters for both cost and privacy: a PDF exported from a payroll
 * portal has a real text layer, which is read **in the browser**. Nothing is
 * uploaded, nothing is sent to an AI provider, and no allowance is spent. Only
 * a photo, a screenshot, a scan, or a low-confidence local parse falls through
 * to the server.
 *
 * There is no file size limit to speak of. Vercel caps a function's request
 * body at 4.5 MB, but rather than refusing anything bigger, `prepareForUpload`
 * shrinks it to fit: a photo is scaled to the resolution the model actually
 * reads at, and a large PDF is rendered to page images. What that costs is
 * spelled out on screen, because shrinking a document should never happen
 * behind the user's back.
 *
 * A screenshot can be pasted straight in with Ctrl/Cmd-V or dropped on the
 * box — for most payroll portals that is faster than saving a file first.
 *
 * The privacy notice is shown before the file picker, not after, and it says
 * plainly which path a file will take.
 */

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Button, Callout, ErrorMessage, Spinner } from '@/components/ui';
import { extractPdfTextLayer, isPdf } from '@/lib/parsing/pdfText';
import { DocumentPrepError, prepareForUpload } from '@/lib/parsing/documentPrep';
import { apiRequest, ApiClientError } from '@/lib/api/client';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import './document-upload.css';

export type UploadKind = 'paystub' | 'wage-sheet';

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
const ACCEPTED_TYPES = new Set(ACCEPT.split(','));

export interface ParseOutcome<T> {
  data: T;
  source: 'local' | 'ai';
  issues: { field: string; message: string }[];
  /** Kept so "read it with AI instead" can rerun without a second upload. */
  file: File;
}

export function DocumentUpload<T>({
  kind,
  parseLocally,
  onParsed,
  label,
  description,
}: {
  kind: UploadKind;
  /** Returns null when the local parse is not confident enough to use. */
  parseLocally: (text: string) => { data: T; confident: boolean } | null;
  onParsed: (outcome: ParseOutcome<T>) => void;
  label: string;
  description: string;
}) {
  const { subscription, refresh } = useEntitlement();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'reading' | 'preparing' | 'uploading' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const endpoint = kind === 'paystub' ? '/api/ai/parse-paystub' : '/api/ai/parse-wage-sheet';
  const parses = subscription.documentParses;
  const allowanceSpent = parses.remaining !== null && parses.remaining <= 0;

  // A screenshot on the clipboard has no file on disk, so pasting is the
  // shortest path from a payroll portal to a parsed stub. The listener is on
  // the document because the paste target is wherever the caret happens to be,
  // and it steps aside for a real text field so it cannot eat a normal paste.
  useEffect(() => {
    if (busy !== null) return undefined;

    function onPaste(event: ClipboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;

      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file || !ACCEPTED_TYPES.has(file.type)) continue;
        event.preventDefault();
        setNotice(null);
        void readFile(file, false);
        return;
      }
    }

    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
    // readFile is stable for the life of a render pass and only reads state
    // that is re-read on each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, allowanceSpent, endpoint]);

  function accept(file: File | null | undefined) {
    if (!file) return;
    setError(null);
    setNotice(null);
    if (!ACCEPTED_TYPES.has(file.type)) {
      setError('That file type is not supported. Use a PDF, JPEG, PNG, or WebP.');
      return;
    }
    void readFile(file, false);
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    accept(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (busy !== null) return;
    accept(event.dataTransfer.files?.[0]);
  }

  async function readFile(file: File, forceAi: boolean) {
    setBusy('reading');
    setError(null);

    try {
      // --- Local path: free, private, no upload ---------------------------
      // Tried on any PDF regardless of size: reading the text layer happens
      // entirely in the browser, so a 50 MB payroll export costs nothing and
      // never leaves the machine.
      if (!forceAi && isPdf(file)) {
        const text = await extractPdfTextLayer(file);
        if (text) {
          const local = parseLocally(text);
          if (local?.confident) {
            onParsed({ data: local.data, source: 'local', issues: [], file });
            setNotice(
              'Read from the PDF in your browser. Nothing was uploaded and no AI parse was used.',
            );
            return;
          }
        }
      }

      // --- Server path: costs one parse from the allowance ----------------
      if (allowanceSpent) {
        setError(
          `You have used all ${parses.limit} of this month's document parses. Your allowance resets next month, and NetShift Pro raises it.`,
        );
        return;
      }

      setBusy('preparing');
      const prepared = await prepareForUpload(file);

      setBusy('uploading');
      const response = await apiRequest<{
        data: T;
        issues: { field: string; message: string }[];
      }>(endpoint, {
        body: { pages: prepared.pages },
      });

      onParsed({ data: response.data, source: 'ai', issues: response.issues ?? [], file });
      if (prepared.note) setNotice(prepared.note);
      // The allowance just changed, so the counter shown on screen should too.
      void refresh();
    } catch (caught) {
      if (caught instanceof DocumentPrepError || caught instanceof ApiClientError) {
        setError(caught.message);
      } else {
        setError(
          'That document could not be read. Try a clearer photo, or enter the figures by hand.',
        );
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ns-upload">
      <Callout tone="neutral" icon="i">
        <strong>How your document is read.</strong> A PDF downloaded from a payroll portal is read{' '}
        <strong>inside your browser</strong> — it is never uploaded and costs nothing, at any size.
        A photo, screenshot, or scan has no text to read, so it is sent to Anthropic&rsquo;s AI
        service to be transcribed, which uses one of your monthly parses. NetShift stores the
        figures, not the document, and deletes the file as soon as it has been read.
      </Callout>

      <div
        className={`ns-upload__box${dragging ? ' ns-upload__box--dragging' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          if (busy === null) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          id={`upload-${kind}`}
          className="sr-only"
          onChange={handleFile}
          disabled={busy !== null}
        />
        <label htmlFor={`upload-${kind}`} className="ns-upload__label">
          <span className="ns-upload__icon" aria-hidden="true">
            ⇪
          </span>
          <span className="ns-upload__title">{label}</span>
          <span className="ns-upload__desc">{description}</span>
          <span className="ns-upload__formats">
            PDF, JPEG, PNG, or WebP — any size. Drop a file here, or paste a screenshot with
            Ctrl&#8209;V.
          </span>
        </label>

        {busy && (
          <div className="ns-upload__busy" role="status">
            <Spinner />
            <span>
              {busy === 'reading'
                ? 'Reading the document in your browser…'
                : busy === 'preparing'
                  ? 'Preparing the document…'
                  : 'Sending to be transcribed…'}
            </span>
          </div>
        )}
      </div>

      {parses.limit !== null && (
        <p className="ns-upload__allowance">
          {parses.remaining} of {parses.limit} document {parses.limit === 1 ? 'parse' : 'parses'}{' '}
          left this month. Reading a payroll PDF locally does not use one.
        </p>
      )}

      {notice && (
        <Callout tone="success" icon="✓">
          {notice}
        </Callout>
      )}
      <ErrorMessage>{error}</ErrorMessage>
    </div>
  );
}

/** "Read it with AI instead" — the escape hatch from a poor local parse. */
export function RetryWithAi({
  file,
  kind,
  onParsed,
  disabled,
}: {
  file: File;
  kind: UploadKind;
  onParsed: (outcome: { data: unknown; issues: { field: string; message: string }[] }) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = kind === 'paystub' ? '/api/ai/parse-paystub' : '/api/ai/parse-wage-sheet';

  return (
    <>
      <Button
        variant="ghost"
        loading={busy}
        disabled={disabled}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const prepared = await prepareForUpload(file);
            const response = await apiRequest<{
              data: unknown;
              issues: { field: string; message: string }[];
            }>(endpoint, { body: { pages: prepared.pages } });
            onParsed({ data: response.data, issues: response.issues ?? [] });
          } catch (caught) {
            setError(
              caught instanceof DocumentPrepError || caught instanceof ApiClientError
                ? caught.message
                : 'That did not work.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        Read it with AI instead
      </Button>
      <ErrorMessage>{error}</ErrorMessage>
    </>
  );
}
