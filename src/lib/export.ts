/**
 * Client-side CSV and JSON export.
 *
 * Done in the browser from data the user already has loaded, so exporting
 * needs no server round trip and no new way for data to leave the account.
 */

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Real numbers are written as-is. Applying the formula guard below to them
  // would turn every negative figure — and NetShift's exports are full of
  // them — into a text cell, silently breaking any sum in the spreadsheet.
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') return String(value);

  const text = String(value);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula.
  // Prefixing with a quote is the standard mitigation for CSV injection.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(escapeCsvCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCsvCell).join(','));
  return lines.join('\r\n');
}

function triggerDownload(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoking immediately can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv(filename: string, headers: string[], rows: unknown[][]): void {
  triggerDownload(filename, toCsv(headers, rows), 'text/csv;charset=utf-8');
}

export function downloadJson(filename: string, data: unknown): void {
  triggerDownload(filename, JSON.stringify(data, null, 2), 'application/json');
}
