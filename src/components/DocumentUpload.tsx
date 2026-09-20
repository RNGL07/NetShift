/**
 * Document upload with a local-first parsing path.
 *
 * The order matters for both cost and privacy: a PDF exported from a payroll
 * portal has a real text layer, which is read **in the browser**. Nothing is
 * uploaded, nothing is sent to an AI provider, and no allowance is spent. Only
 * a photo, a scan, or a low-confidence local parse falls through to the server.
 *
 * The privacy notice is shown before the file picker, not after, and it says
 * plainly which path a file will take.
 */

import { useRef, useState, type ChangeEvent } from 'react';
import { Button, Callout, ErrorMessage, Spinner } from '@/components/ui';
import { extractPdfTextLayer, fileToBase64, isPdf } from '@/lib/parsing/pdfText';
import { apiRequest, ApiClientError } from '@/lib/api/client';
import { useEntitlement } from '@/features/billing/EntitlementContext';
import './document-upload.css';

export type UploadKind = 'paystub' | 'wage-sheet';

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
const MAX_CLIENT_BYTES = 8 * 1024 * 1024;

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
  const [busy, setBusy] = useState<'reading' | 'uploading' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const endpoint = kind === 'paystub' ? '/api/ai/parse-paystub' : '/api/ai/parse-wage-sheet';
  const parses = subscription.documentParses;
  const allowanceSpent = parses.remaining !== null && parses.remaining <= 0;

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (inputRef.current) inputRef.current.value = '';
    if (!file) return;

    setError(null);
    setNotice(null);

    if (file.size > MAX_CLIENT_BYTES) {
      setError(
        `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 8 MB — try a smaller scan, or photograph the stub instead.`,
      );
      return;
    }

    await readFile(file, false);
  }

  async function readFile(file: File, forceAi: boolean) {
    setBusy('reading');
    setError(null);

    try {
      // --- Local path: free, private, no upload ---------------------------
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

      setBusy('uploading');
      const base64 = await fileToBase64(file);
      const response = await apiRequest<{
        data: T;
        issues: { field: string; message: string }[];
      }>(endpoint, {
        body: { base64, mediaType: file.type },
      });

      onParsed({ data: response.data, source: 'ai', issues: response.issues ?? [], file });
      // The allowance just changed, so the counter shown on screen should too.
      void refresh();
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        setError(caught.message);
      } else {
        setError('That document could not be read. Try a clearer photo, or enter the figures by hand.');
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="ns-upload">
      <Callout tone="neutral" icon="i">
        <strong>How your document is read.</strong> A PDF downloaded from a payroll portal is read{' '}
        <strong>inside your browser</strong> — it is never uploaded and costs nothing. A photo or a
        scan has no text to read, so it is sent to Anthropic&rsquo;s AI service to be transcribed,
        which uses one of your monthly parses. NetShift stores the figures, not the document, and
        deletes the file as soon as it has been read.
      </Callout>

      <div className="ns-upload__box">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          id={`upload-${kind}`}
          className="sr-only"
          onChange={(event) => void handleFile(event)}
          disabled={busy !== null}
        />
        <label htmlFor={`upload-${kind}`} className="ns-upload__label">
          <span className="ns-upload__icon" aria-hidden="true">
            ⇪
          </span>
          <span className="ns-upload__title">{label}</span>
          <span className="ns-upload__desc">{description}</span>
          <span className="ns-upload__formats">PDF, JPEG, PNG, or WebP · up to 8 MB</span>
        </label>

        {busy && (
          <div className="ns-upload__busy" role="status">
            <Spinner />
            <span>
              {busy === 'reading'
                ? 'Reading the document in your browser…'
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

      {notice && <Callout tone="success" icon="✓">{notice}</Callout>}
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
            const base64 = await fileToBase64(file);
            const response = await apiRequest<{
              data: unknown;
              issues: { field: string; message: string }[];
            }>(endpoint, { body: { base64, mediaType: file.type } });
            onParsed({ data: response.data, issues: response.issues ?? [] });
          } catch (caught) {
            setError(caught instanceof ApiClientError ? caught.message : 'That did not work.');
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
