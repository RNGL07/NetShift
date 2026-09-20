const { useState, useEffect, useMemo, useRef } = React;

const TOKENS = {
  bg: "#14171A",
  panel: "#1C2024",
  panelBorder: "#2A2F35",
  text: "#ECE9E2",
  textDim: "#8B9198",
  amber: "#F2A93B",
  green: "#5FBF83",
  rust: "#C9573B",
  panel2: "#22262B",
};

const PAY_SCALE_EFFECTIVE = "March 23, 2026";
const PAY_SCALE = {
  skilled: {
    label: "Skilled Team Member",
    shiftPremium: 0.8,
    teamLeaderPremium: 2.25,
    steps: [
      { key: "start", label: "Start", rate: 35.9 },
      { key: "6mo", label: "6 Months", rate: 39.15 },
      { key: "1yr", label: "1 Year", rate: 40.61 },
      { key: "1.5yr", label: "1.5 Years", rate: 42.18 },
      { key: "2yr", label: "2 Years", rate: 43.55 },
      { key: "2.5yr", label: "2.5 Years", rate: 45.75 },
      { key: "3yr", label: "3 Years (Top Rate)", rate: 47.95 },
    ],
  },
  production: {
    label: "Production Team Member",
    shiftPremium: 0.8,
    teamLeaderPremium: 1.75,
    steps: [
      { key: "start", label: "Start", rate: 23.0 },
      { key: "6mo", label: "6 Months", rate: 25.97 },
      { key: "1yr", label: "1 Year", rate: 26.91 },
      { key: "1.5yr", label: "1.5 Years", rate: 27.84 },
      { key: "2yr", label: "2 Years", rate: 28.76 },
      { key: "2.5yr", label: "2.5 Years", rate: 31.55 },
      { key: "3yr", label: "3 Years", rate: 32.47 },
      { key: "3.5yr", label: "3.5 Years", rate: 34.77 },
      { key: "4yr", label: "4 Years (Top Rate)", rate: 37.11 },
    ],
  },
};

function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toFixed(1) + "%";
}
function fmtHours(n) {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toFixed(2);
}

function stripCodeFences(s) {
  const b = String.fromCharCode(96);
  const triple = b + b + b;
  let out = s.split(triple + "json").join("");
  out = out.split(triple).join("");
  return out.trim();
}

function extractJsonObject(text) {
  const cleaned = stripCodeFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in response. Raw reply: " + cleaned.slice(0, 300));
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error("Couldn't parse JSON from response. Raw reply: " + cleaned.slice(0, 300));
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// Local (free) PDF parsing
//
// A PDF exported straight out of a payroll portal carries a real text layer, so
// the numbers can be read in the browser with no upload and no API call. A
// photo, or a scan that happens to be saved as a PDF, has no text layer — those
// keep going to the vision path below, unchanged.
// ---------------------------------------------------------------------------

// Below this many non-whitespace characters, whatever pdf.js handed back is
// stray metadata rather than a real text layer.
const MIN_TEXT_LAYER_CHARS = 40;

// Returns the PDF's text layer as newline-separated lines, with the items on
// each visual row joined in reading order, or null when there's no usable text
// layer (the caller reads null as "fall back to the vision path").
async function extractPdfTextLayer(file) {
  if (!window.pdfjsLib) return null;
  try {
    const buffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise;
    const lines = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      // Group items into visual rows by baseline, so a label and the amount
      // sitting beside it land on one line — the field parsers lean on that.
      const rows = new Map();
      (content.items || []).forEach((item) => {
        if (!item || typeof item.str !== "string" || !item.str.trim()) return;
        const x = item.transform ? item.transform[4] : 0;
        const y = item.transform ? item.transform[5] : 0;
        const bucket = Math.round(y / 3); // ~3pt tolerance for baseline jitter
        if (!rows.has(bucket)) rows.set(bucket, []);
        rows.get(bucket).push({ x: x, str: item.str });
      });
      Array.from(rows.keys())
        .sort((a, b) => b - a) // top of the page downward
        .forEach((bucket) => {
          const text = rows
            .get(bucket)
            .sort((a, b) => a.x - b.x) // left to right
            .map((it) => it.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text) lines.push(text);
        });
    }
    const text = lines.join("\n");
    if (text.replace(/\s/g, "").length < MIN_TEXT_LAYER_CHARS) return null;
    return text;
  } catch (e) {
    // Encrypted, corrupt, or otherwise unreadable — treat it like a scan.
    return null;
  }
}

function toTextLines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// "$1,234.56" / "(1,234.56)" / "-1234.56" -> a plain number.
function parseLocalNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  const negative = /^\(.*\)$/.test(s) || /^-|\$\s*-/.test(s);
  s = s.replace(/[()]/g, "").replace(/[$,\s-]/g, "");
  if (!s || !/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (isNaN(n)) return null;
  return negative ? -n : n;
}

function firstNumberIn(segment) {
  const m = String(segment).match(/\(?-?\$\s?-?\d[\d,]*(?:\.\d+)?\)?|\(?-?\d[\d,]*(?:\.\d+)?\)?/);
  return m ? parseLocalNumber(m[0]) : null;
}

// Money is either $-prefixed or written with cents — requiring one of those
// keeps years, employee numbers, and check numbers from being read as amounts.
function moneyIn(segment) {
  const m = String(segment).match(/\(?-?\$\s?-?\d[\d,]*(?:\.\d+)?\)?|\(?-?\d[\d,]*\.\d{2}\)?/);
  if (!m) return null;
  const n = parseLocalNumber(m[0]);
  return n === null ? null : Math.abs(n);
}

function numberIn(segment) {
  const n = firstNumberIn(segment);
  return n === null ? null : Math.abs(n);
}

// Hourly premiums are small per-hour dollar figures; anything larger is some
// other number that happened to sit next to the label.
function premiumIn(segment) {
  const n = firstNumberIn(segment);
  if (n === null) return null;
  const abs = Math.abs(n);
  return abs <= 50 ? abs : null;
}

const LOCAL_DATE_RE = new RegExp(
  "\\d{4}-\\d{2}-\\d{2}" +
    "|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}" +
    "|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2},?\\s+\\d{4}",
  "i"
);

function dateIn(segment) {
  const m = String(segment).match(LOCAL_DATE_RE);
  return m ? m[0].trim() : null;
}

function textIn(segment) {
  const t = String(segment).replace(/^[\s:\-–—]+/, "").trim();
  return t && /[a-z]/i.test(t) ? t.slice(0, 80) : null;
}

// Matches a label as a whole word, tolerating however the PDF spaced it out.
function localLabelPattern(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return new RegExp("(?:^|[^a-z0-9])" + escaped + "(?:[^a-z0-9]|$)", "i");
}

// Walks the synonym list most-specific first, and for each one scans every
// line, pulling the value from the rest of that line or from the line below
// (payroll PDFs put the amount in either place depending on the layout).
function findLabeledValue(lines, labels, extract, opts) {
  const allowNextLine = !opts || opts.allowNextLine !== false;
  for (let li = 0; li < labels.length; li++) {
    const re = localLabelPattern(labels[li]);
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const after = lines[i].slice(m.index + m[0].length);
      const here = extract(after);
      if (here !== null && here !== undefined) return here;
      if (allowNextLine && i + 1 < lines.length) {
        const below = extract(lines[i + 1]);
        if (below !== null && below !== undefined) return below;
      }
    }
  }
  return null;
}

// Returns { data, confidence } where data is exactly the shape
// extractStubData() returns, so the save path stays identical.
function parseStubTextLocally(text) {
  const lines = toTextLines(text);

  const data = {
    pay_date: findLabeledValue(
      lines,
      ["pay date", "check date", "payment date", "advice date", "date of pay", "pay period ending", "period ending", "pay period end", "period end"],
      dateIn
    ),
    gross_pay: findLabeledValue(
      lines,
      ["total gross pay", "gross pay", "total gross", "gross earnings", "gross wages", "total earnings", "gross income", "gross"],
      moneyIn
    ),
    federal_tax: findLabeledValue(
      lines,
      ["federal income tax", "federal withholding", "fed income tax", "federal tax", "fed tax", "fed w/h", "fed withholding", "fed inc tax", "fitw", "fit w/h", "fit"],
      moneyIn
    ),
    state_tax: findLabeledValue(
      lines,
      ["state income tax", "state withholding", "state tax", "state w/h", "st income tax", "st tax", "sitw", "sit w/h", "sit"],
      moneyIn
    ),
    social_security: findLabeledValue(
      lines,
      ["social security tax", "social security", "soc sec tax", "soc sec", "ss tax", "ss w/h", "fica ss", "fica soc sec", "oasdi"],
      moneyIn
    ),
    medicare: findLabeledValue(lines, ["medicare tax", "medicare w/h", "medicare", "med tax", "fica med", "fica medicare"], moneyIn),
    other_deductions_total: findLabeledValue(
      lines,
      ["total other deductions", "other deductions", "other ded", "voluntary deductions", "post tax deductions", "pre tax deductions"],
      moneyIn
    ),
    net_pay: findLabeledValue(
      lines,
      ["net pay", "net amount", "take home pay", "take-home pay", "net check", "net earnings", "net deposit", "direct deposit amount", "check amount", "net"],
      moneyIn
    ),
    hours_worked: findLabeledValue(
      lines,
      ["total hours worked", "hours worked", "total hours", "regular hours", "reg hours", "reg hrs", "total hrs", "hours"],
      numberIn
    ),
    hourly_rate: findLabeledValue(lines, ["hourly rate", "base rate", "regular rate", "reg rate", "rate of pay", "pay rate", "rate"], numberIn),
  };

  // "Total deductions" includes the taxes, so it only stands in for the "other"
  // bucket once every tax line has been found and can be subtracted back out.
  if (data.other_deductions_total === null) {
    const totalDed = findLabeledValue(lines, ["total deductions", "deductions total", "total dedns"], moneyIn);
    const taxes = [data.federal_tax, data.state_tax, data.social_security, data.medicare];
    if (totalDed !== null && taxes.every((t) => t !== null)) {
      const remainder = totalDed - taxes.reduce((sum, t) => sum + t, 0);
      if (remainder >= 0) data.other_deductions_total = Math.round(remainder * 100) / 100;
    }
  }

  const fieldsFound = Object.keys(data).filter((k) => data[k] !== null && data[k] !== undefined).length;
  const coreFound = [data.gross_pay, data.net_pay].filter((v) => v !== null && v !== undefined).length;
  // Net above gross means the labels matched the wrong numbers somewhere.
  const sane = coreFound === 2 && data.net_pay > 0 && data.net_pay <= data.gross_pay * 1.05;

  return { data: data, confidence: { fieldsFound: fieldsFound, coreFound: coreFound, confident: coreFound === 2 && sane } };
}

const STEP_LABEL_CORE =
  "(?:start(?:ing)?(?:\\s*rate)?|hire(?:\\s*in)?(?:\\s*rate)?|probation(?:ary)?|top(?:\\s*(?:rate|out))?|max(?:imum)?(?:\\s*rate)?|final(?:\\s*rate)?|step\\s*\\d+|level\\s*\\d+|tier\\s*\\d+|\\d+(?:\\.\\d+)?\\s*\\+?\\s*(?:mos?|months?|yrs?|years?|wks?|weeks?|days?))";
const STEP_LABEL_ANCHORED = new RegExp("^\\s*" + STEP_LABEL_CORE + "\\b", "i");
const STEP_LABEL_ANYWHERE = new RegExp("(?:^|[^a-z0-9])" + STEP_LABEL_CORE + "\\b", "i");

function collectRateSteps(lines, labelRe) {
  const steps = [];
  const seen = {};
  lines.forEach((line) => {
    const m = labelRe.exec(line);
    if (!m) return;
    const rest = line.slice(m.index + m[0].length);
    const rateMatch = rest.match(/\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*\.\d{1,2}/);
    if (!rateMatch) return;
    const rate = parseLocalNumber(rateMatch[0]);
    // Plausible hourly rates only — this keeps years, counts, and percentages out.
    if (rate === null || rate < 1 || rate > 500) return;
    const cutAt = line.length - rest.length + rest.indexOf(rateMatch[0]);
    const label = line.slice(0, cutAt).replace(/[\s:\-–—.]+$/, "").trim() || m[0].trim();
    const key = label.toLowerCase() + "|" + rate;
    if (seen[key]) return;
    seen[key] = true;
    steps.push({ label: label, rate: rate });
  });
  return steps;
}

// Returns { data, confidence } where data is exactly the shape
// extractPayProfile() returns.
function parseWageSheetTextLocally(text) {
  const lines = toTextLines(text);

  // Most wage sheets list each tenure step at the start of its own row; some
  // prefix the row with the track name, so retry unanchored if the strict pass
  // came up short.
  let steps = collectRateSteps(lines, STEP_LABEL_ANCHORED);
  if (steps.length < 2) {
    const loose = collectRateSteps(lines, STEP_LABEL_ANYWHERE);
    if (loose.length > steps.length) steps = loose;
  }

  let trackLabel = findLabeledValue(
    lines,
    ["job classification", "classification", "job title", "position", "pay track", "wage group", "pay grade", "job group", "track", "role"],
    textIn
  );
  if (!trackLabel) {
    // Fall back to a heading that names a job track. An effective date often
    // rides along on that same line, so drop it before checking for numbers —
    // any other digits mean the line is a rate row, not a heading.
    const heading = lines
      .map((l) =>
        l
          .replace(LOCAL_DATE_RE, " ")
          .replace(/\s+/g, " ")
          .replace(/[\s:\-–—]*\b(?:eff(?:ective)?\.?(?:\s*date)?|as of)\s*$/i, "")
          .trim()
      )
      .find((l) => /team member|team leader|technician|operator|associate|maintenance|production|skilled|apprentice|journeyman/i.test(l) && !/\d/.test(l));
    if (heading) trackLabel = heading.slice(0, 80);
  }

  const data = {
    track_label: trackLabel,
    effective_date: findLabeledValue(lines, ["effective date", "effective as of", "eff date", "effective", "in effect"], dateIn),
    shift_premium: findLabeledValue(
      lines,
      ["shift premium", "shift differential", "shift diff", "off shift premium", "night premium", "night differential", "second shift", "third shift"],
      premiumIn
    ),
    team_leader_premium: findLabeledValue(
      lines,
      ["team leader premium", "team lead premium", "group leader premium", "crew leader premium", "leader premium", "lead premium", "lead differential", "team leader", "team lead", "group leader"],
      premiumIn
    ),
    steps: steps,
  };

  return {
    data: data,
    confidence: {
      stepsFound: steps.length,
      fieldsFound: ["track_label", "effective_date", "shift_premium", "team_leader_premium"].filter((k) => data[k] !== null && data[k] !== undefined).length,
      confident: steps.length >= 2,
    },
  };
}

// Drives both the review form for locally parsed stubs and the conversion back
// out of it, so the saved entry keeps exactly the schema the vision path returns.
const LOCAL_STUB_FIELDS = [
  { key: "pay_date", label: "Pay date", type: "text" },
  { key: "gross_pay", label: "Gross pay", type: "number" },
  { key: "federal_tax", label: "Federal tax", type: "number" },
  { key: "state_tax", label: "State tax", type: "number" },
  { key: "social_security", label: "Social Security", type: "number" },
  { key: "medicare", label: "Medicare", type: "number" },
  { key: "other_deductions_total", label: "Other deductions", type: "number" },
  { key: "net_pay", label: "Net pay", type: "number" },
  { key: "hours_worked", label: "Hours worked", type: "number" },
  { key: "hourly_rate", label: "Hourly rate", type: "number" },
];

async function extractStubData(base64, mediaType, isPdf) {
  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  const systemPrompt =
    "You are a payroll data extraction assistant. Look at the pay stub provided and respond with ONLY valid JSON " +
    "(no markdown fences, no commentary). Schema: " +
    '{"pay_date": string|null, "gross_pay": number|null, "federal_tax": number|null, "state_tax": number|null, ' +
    '"social_security": number|null, "medicare": number|null, "other_deductions_total": number|null, ' +
    '"net_pay": number|null, "hours_worked": number|null, "hourly_rate": number|null}. ' +
    "All money values as plain numbers, no $ or commas. Use null for anything not present on the stub.";

  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [contentBlock, { type: "text", text: "Extract the pay stub data as JSON per the schema." }],
        },
      ],
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message ? " — " + errBody.error.message : " — " + JSON.stringify(errBody).slice(0, 200);
    } catch (e) {
      detail = "";
    }
    throw new Error("Extraction request failed (" + response.status + ")" + detail);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in response: " + JSON.stringify(data).slice(0, 200));
  const cleaned = stripCodeFences(textBlock.text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Couldn't parse the model's response as JSON. Raw reply: " + cleaned.slice(0, 300));
  }
}

async function extractPayProfile(base64, mediaType, isPdf) {
  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };

  const systemPrompt =
    "You are a payroll data extraction assistant. Look at the uploaded wage rate / pay scale document " +
    "(could be a company wage sheet, grow-in scale, or offer letter) and respond with ONLY valid JSON " +
    "(no markdown fences, no commentary). Schema: " +
    '{"track_label": string|null, "effective_date": string|null, "shift_premium": number|null, ' +
    '"team_leader_premium": number|null, "steps": [{"label": string, "rate": number}]}. ' +
    "\"steps\" should be the tenure-based pay progression (start rate through top rate) in order, using whatever " +
    "milestone labels the document uses (e.g. Start, 6 Months, 1 Year). If the document shows more than one job " +
    "track, extract the track that looks most like a general/primary rate table. Money values as plain numbers, " +
    "no $ or commas. Use null or an empty array for anything not present.";

  const response = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [contentBlock, { type: "text", text: "Extract the pay profile data as JSON per the schema." }],
        },
      ],
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errBody = await response.json();
      detail = errBody?.error?.message ? " — " + errBody.error.message : " — " + JSON.stringify(errBody).slice(0, 200);
    } catch (e) {
      detail = "";
    }
    throw new Error("Extraction request failed (" + response.status + ")" + detail);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in response: " + JSON.stringify(data).slice(0, 200));
  const cleaned = stripCodeFences(textBlock.text);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error("Couldn't parse the model's response as JSON. Raw reply: " + cleaned.slice(0, 300));
  }
}


// Marks where a saved result came from, so it's visible later how often the
// free local path is actually being used. Entries saved before this existed have
// no source and show nothing.
function SourceTag({ source }) {
  if (source !== "local" && source !== "ai") return null;
  const isLocal = source === "local";
  return (
    <span className={"pc-source-tag" + (isLocal ? " local" : " ai")} title={isLocal ? "Read from the PDF's text layer in your browser — no API call" : "Read by Claude's vision model"}>
      {isLocal ? "parsed locally" : "AI-parsed"}
    </span>
  );
}

function StampBadge({ value, label, tone = "amber", spin }) {
  const color = TOKENS[tone] || TOKENS.amber;
  return (
    <div className="stamp" style={{ borderColor: color }}>
      <svg viewBox="0 0 100 100" className={"stamp-ticks" + (spin ? " spin" : "")} aria-hidden="true">
        {Array.from({ length: 24 }).map((_, i) => {
          const angle = (i / 24) * 360;
          return (
            <line
              key={i}
              x1="50" y1="6" x2="50" y2={i % 6 === 0 ? "14" : "11"}
              stroke={color}
              strokeWidth={i % 6 === 0 ? 2 : 1}
              transform={`rotate(${angle} 50 50)`}
              opacity={i % 6 === 0 ? 1 : 0.45}
            />
          );
        })}
        <circle cx="50" cy="50" r="34" fill="none" stroke={color} strokeWidth="1.5" opacity="0.5" />
      </svg>
      <div className="stamp-center">
        <div className="stamp-value">{value}</div>
        <div className="stamp-label">{label}</div>
      </div>
    </div>
  );
}

function DayGrid({ label, values, onChange, dayLabels }) {
  const total = values.reduce((sum, v) => sum + (Number(v) || 0), 0);
  return (
    <div className="pc-daygrid">
      <div className="pc-daygrid-head">
        <span className="pc-daygrid-label">{label}</span>
        <span className="pc-daygrid-total">{total.toFixed(2)} hrs</span>
      </div>
      <div className="pc-daygrid-row">
        {dayLabels.map((d, i) => {
          const isWeekend = d === "Sat" || d === "Sun";
          return (
            <div className={"pc-day" + (isWeekend ? " weekend" : "")} key={d}>
              <label htmlFor={label + "-" + d}>{d}</label>
              <input
                id={label + "-" + d}
                type="number"
                min="0"
                step="0.25"
                inputMode="decimal"
                value={values[i]}
                onChange={(e) => {
                  const next = values.slice();
                  next[i] = e.target.value;
                  onChange(next);
                }}
                onFocus={(e) => e.target.select()}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StaticDayRow({ label, hoursPerDay, dayLabels, flagLabel, flagDay }) {
  const over8 = hoursPerDay > 8;
  return (
    <div className="pc-daygrid">
      <div className="pc-daygrid-head">
        <span className="pc-daygrid-label">{label}</span>
      </div>
      <div className="pc-daygrid-row">
        {dayLabels.map((d) => (
          <div className={"pc-day pc-day-static" + (over8 ? " over" : "")} key={d}>
            <label>{d}{flagDay === d ? <span className="pc-day-flag">{flagLabel}</span> : null}</label>
            <div className="pc-day-static-value">{hoursPerDay.toFixed(2)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function App() {
  const [tab, setTab] = useState("upload");
  const [stubs, setStubs] = useState([]);
  const [stubsLoading, setStubsLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [justStamped, setJustStamped] = useState(false);
  const fileInputRef = useRef(null);

  const [rate, setRate] = useState("");
  const [payPeriod, setPayPeriod] = useState("biweekly");
  const [hoursInputMode, setHoursInputMode] = useState("daily");
  const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const [week1Days, setWeek1Days] = useState(["8", "8", "8", "8", "8", "0", "0"]);
  const [week2Days, setWeek2Days] = useState(["8", "8", "8", "8", "8", "0", "0"]);
  const [week1SundayType, setWeek1SundayType] = useState("regular");
  const [week2SundayType, setWeek2SundayType] = useState("regular");
  const [week1Shift, setWeek1Shift] = useState("day");
  const [week2Shift, setWeek2Shift] = useState("day");
  const [totalsShift, setTotalsShift] = useState("day");
  const [totalRegHours, setTotalRegHours] = useState("");
  const [totalOtHours, setTotalOtHours] = useState("");

  const [shiftPremium, setShiftPremium] = useState("0.00");
  const [teamLeaderPremium, setTeamLeaderPremium] = useState("0.00");
  const [isTeamLeader, setIsTeamLeader] = useState(false);
  const [premiumsLoading, setPremiumsLoading] = useState(true);
  const [profileUploading, setProfileUploading] = useState(false);
  const [profileUploadError, setProfileUploadError] = useState(null);
  const [profileUploadResult, setProfileUploadResult] = useState(null);

  // Locally parsed results are held here for review first. Rule-based parsing is
  // less reliable than the vision model, so nothing is saved until it's confirmed.
  // The originating file is kept alongside so "read it with AI instead" can rerun
  // the vision path without a second upload.
  const [pendingStub, setPendingStub] = useState(null);
  const [pendingStubFile, setPendingStubFile] = useState(null);
  const [pendingProfile, setPendingProfile] = useState(null);
  const [pendingProfileFile, setPendingProfileFile] = useState(null);
  const [ladderSource, setLadderSource] = useState(null);
  const profileFileInputRef = useRef(null);

  const [perDiemRate, setPerDiemRate] = useState("");
  const [perDiemDays, setPerDiemDays] = useState("");

  const [targetNet, setTargetNet] = useState("");
  const [targetRate, setTargetRate] = useState("");
  const [assumeOT, setAssumeOT] = useState(false);
  const [targetDaysPerWeek, setTargetDaysPerWeek] = useState("5");
  const [sundayDoubleTime, setSundayDoubleTime] = useState(false);
  const [targetShift, setTargetShift] = useState("day");

  const DEFAULT_LADDER = [
    { id: 1, label: "Start", rate: "" },
    { id: 2, label: "Step 2", rate: "" },
  ];
  const [ladderSteps, setLadderSteps] = useState(DEFAULT_LADDER);
  const [currentStepId, setCurrentStepId] = useState(null);
  const [ladderLoading, setLadderLoading] = useState(true);

  const DEFAULT_INVEST_ACCOUNTS = [
    { id: 1, name: "401k", kind: "holdings", holdings: [{ id: 1, ticker: "VOO", shares: "", manualPrice: "" }] },
    { id: 2, name: "Roth IRA", kind: "holdings", holdings: [{ id: 1, ticker: "SCHD", shares: "", manualPrice: "" }] },
    { id: 3, name: "Brokerage", kind: "holdings", holdings: [{ id: 1, ticker: "VOO", shares: "", manualPrice: "" }] },
    { id: 4, name: "SPAXX / Savings", kind: "cash", balance: "" },
  ];
  const [investAccounts, setInvestAccounts] = useState(DEFAULT_INVEST_ACCOUNTS);
  const [investLoading, setInvestLoading] = useState(true);
  const [livePrices, setLivePrices] = useState({});
  const [pricesRefreshing, setPricesRefreshing] = useState(false);
  const [pricesError, setPricesError] = useState(null);

  const [calcStart, setCalcStart] = useState("");
  const [calcMonthly, setCalcMonthly] = useState("");
  const [calcRatePct, setCalcRatePct] = useState("7");
  const [calcYears, setCalcYears] = useState("10");
  const [calcResult, setCalcResult] = useState(null);
  const [calcError, setCalcError] = useState(null);

  const [marketReports, setMarketReports] = useState([]);
  const [marketLoading, setMarketLoading] = useState(true);
  const [marketGenerating, setMarketGenerating] = useState(false);
  const [marketError, setMarketError] = useState(null);
  const [viewingReportId, setViewingReportId] = useState(null);

  const avgDedPct = useMemo(() => {
    const valid = stubs.filter((s) => s.gross_pay && s.net_pay);
    if (valid.length === 0) return null;
    const total = valid.reduce((sum, s) => sum + (1 - s.net_pay / s.gross_pay) * 100, 0);
    return total / valid.length;
  }, [stubs]);

  const [dedPctInput, setDedPctInput] = useState("");
  useEffect(() => {
    if (avgDedPct !== null && dedPctInput === "") setDedPctInput(avgDedPct.toFixed(1));
  }, [avgDedPct]);

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get("paycheck-stubs", false);
        if (result && result.value) setStubs(JSON.parse(result.value));
      } catch (e) {
        // no saved stubs yet
      } finally {
        setStubsLoading(false);
      }
    })();
  }, []);

  async function persistStubs(next) {
    setStubs(next);
    try {
      await window.storage.set("paycheck-stubs", JSON.stringify(next), false);
    } catch (e) {
      console.error("Could not save stub history", e);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get("pay-ladder", false);
        if (result && result.value) {
          const parsed = JSON.parse(result.value);
          if (parsed.steps) setLadderSteps(parsed.steps);
          if (parsed.currentStepId !== undefined) setCurrentStepId(parsed.currentStepId);
          if (parsed.source !== undefined) setLadderSource(parsed.source);
        }
      } catch (e) {
        // no saved ladder yet, defaults stand
      } finally {
        setLadderLoading(false);
      }
    })();
  }, []);

  // `source` records where the steps came from ("local", "ai", or null for
  // hand-built/example ladders). Callers that are only editing an existing
  // ladder leave it out, which keeps whatever source is already recorded.
  async function persistLadder(steps, currentId, source) {
    const nextSource = source === undefined ? ladderSource : source;
    setLadderSteps(steps);
    setCurrentStepId(currentId);
    setLadderSource(nextSource);
    try {
      await window.storage.set("pay-ladder", JSON.stringify({ steps, currentStepId: currentId, source: nextSource }), false);
    } catch (e) {
      console.error("Could not save pay ladder", e);
    }
  }

  function updateLadderStep(id, field, value) {
    const next = ladderSteps.map((s) => (s.id === id ? { ...s, [field]: value } : s));
    persistLadder(next, currentStepId);
  }

  function addLadderStep() {
    const nextId = ladderSteps.length ? Math.max(...ladderSteps.map((s) => s.id)) + 1 : 1;
    const next = [...ladderSteps, { id: nextId, label: "Step " + nextId, rate: "" }];
    persistLadder(next, currentStepId);
  }

  function removeLadderStep(id) {
    const next = ladderSteps.filter((s) => s.id !== id);
    persistLadder(next, currentStepId === id ? null : currentStepId);
  }

  // Applies an extracted pay profile to the ladder and premiums. Shared by the
  // vision path (saves straight away) and the local path (saves on confirm).
  function applyPayProfile(parsed, source) {
    const steps = (parsed.steps || [])
      .filter((s) => s && s.rate !== null && s.rate !== undefined && s.rate !== "")
      .map((s, i) => ({ id: i + 1, label: s.label || "Step " + (i + 1), rate: String(s.rate) }));
    if (steps.length) {
      persistLadder(steps, null, source);
    }
    const nextShiftPremium = parsed.shift_premium !== null && parsed.shift_premium !== undefined && parsed.shift_premium !== "" ? String(parsed.shift_premium) : shiftPremium;
    const nextTLPremium = parsed.team_leader_premium !== null && parsed.team_leader_premium !== undefined && parsed.team_leader_premium !== "" ? String(parsed.team_leader_premium) : teamLeaderPremium;
    persistPremiums(nextShiftPremium, nextTLPremium, isTeamLeader);
    setProfileUploadResult({
      trackLabel: parsed.track_label || null,
      effectiveDate: parsed.effective_date || null,
      stepsCount: steps.length,
      shiftPremium: nextShiftPremium,
      teamLeaderPremium: nextTLPremium,
      source: source,
    });
  }

  async function handleProfileFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await readProfileFile(file, false);
    if (profileFileInputRef.current) profileFileInputRef.current.value = "";
  }

  // `forceVision` skips the local attempt — that's the "read it with AI instead"
  // button on the review form.
  async function readProfileFile(file, forceVision) {
    setProfileUploading(true);
    setProfileUploadError(null);
    setProfileUploadResult(null);
    setPendingProfile(null);
    try {
      const isPdf = file.type === "application/pdf";

      // A PDF exported from a payroll system has a text layer, which can be read
      // here for free. Photos, scans, and anything the local parser isn't sure
      // about fall through to the vision call below.
      if (isPdf && !forceVision) {
        const text = await extractPdfTextLayer(file);
        if (text) {
          const local = parseWageSheetTextLocally(text);
          if (local.confidence.confident) {
            setPendingProfileFile(file);
            setPendingProfile({
              track_label: local.data.track_label || "",
              effective_date: local.data.effective_date || "",
              shift_premium: local.data.shift_premium === null ? "" : String(local.data.shift_premium),
              team_leader_premium: local.data.team_leader_premium === null ? "" : String(local.data.team_leader_premium),
              steps: local.data.steps.map((s) => ({ label: s.label, rate: String(s.rate) })),
            });
            return;
          }
        }
      }

      const base64 = await fileToBase64(file);
      const parsed = await extractPayProfile(base64, file.type, isPdf);
      applyPayProfile(parsed, "ai");
      setPendingProfileFile(null);
    } catch (err) {
      setProfileUploadError(err.message || "Couldn't read that document. Try a clearer image or enter your rates manually below.");
    } finally {
      setProfileUploading(false);
    }
  }

  function updatePendingProfile(field, value) {
    setPendingProfile((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  function updatePendingProfileStep(index, field, value) {
    setPendingProfile((prev) => {
      if (!prev) return prev;
      const steps = prev.steps.map((s, i) => (i === index ? { ...s, [field]: value } : s));
      return { ...prev, steps };
    });
  }

  function removePendingProfileStep(index) {
    setPendingProfile((prev) => (prev ? { ...prev, steps: prev.steps.filter((s, i) => i !== index) } : prev));
  }

  function confirmPendingProfile() {
    if (!pendingProfile) return;
    applyPayProfile(
      {
        track_label: pendingProfile.track_label.trim() || null,
        effective_date: pendingProfile.effective_date.trim() || null,
        shift_premium: pendingProfile.shift_premium === "" ? null : Number(pendingProfile.shift_premium),
        team_leader_premium: pendingProfile.team_leader_premium === "" ? null : Number(pendingProfile.team_leader_premium),
        steps: pendingProfile.steps
          .filter((s) => s.rate !== "" && !isNaN(Number(s.rate)))
          .map((s) => ({ label: s.label, rate: Number(s.rate) })),
      },
      "local"
    );
    setPendingProfile(null);
    setPendingProfileFile(null);
  }

  function discardPendingProfile() {
    setPendingProfile(null);
    setPendingProfileFile(null);
  }

  function loadScaleIntoLadder(track) {
    const steps = PAY_SCALE[track].steps.map((s, i) => ({ id: i + 1, label: s.label, rate: String(s.rate) }));
    persistLadder(steps, null, null);
    setShiftPremium(String(PAY_SCALE[track].shiftPremium.toFixed(2)));
    setTeamLeaderPremium(String(PAY_SCALE[track].teamLeaderPremium.toFixed(2)));
    persistPremiums(String(PAY_SCALE[track].shiftPremium.toFixed(2)), String(PAY_SCALE[track].teamLeaderPremium.toFixed(2)), isTeamLeader);
  }

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get("pay-premiums", false);
        if (result && result.value) {
          const parsed = JSON.parse(result.value);
          if (parsed.shiftPremium !== undefined) setShiftPremium(parsed.shiftPremium);
          if (parsed.teamLeaderPremium !== undefined) setTeamLeaderPremium(parsed.teamLeaderPremium);
          if (parsed.isTeamLeader !== undefined) setIsTeamLeader(parsed.isTeamLeader);
        }
      } catch (e) {
        // no saved premiums yet, defaults stand
      } finally {
        setPremiumsLoading(false);
      }
    })();
  }, []);

  async function persistPremiums(shiftVal, teamLeaderVal, teamLeaderFlag) {
    setShiftPremium(shiftVal);
    setTeamLeaderPremium(teamLeaderVal);
    setIsTeamLeader(teamLeaderFlag);
    try {
      await window.storage.set(
        "pay-premiums",
        JSON.stringify({ shiftPremium: shiftVal, teamLeaderPremium: teamLeaderVal, isTeamLeader: teamLeaderFlag }),
        false
      );
    } catch (e) {
      console.error("Could not save premiums", e);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get("invest-accounts", false);
        if (result && result.value) setInvestAccounts(JSON.parse(result.value));
      } catch (e) {
        // no saved accounts yet, defaults stand
      } finally {
        setInvestLoading(false);
      }
      try {
        const priceResult = await window.storage.get("invest-live-prices", false);
        if (priceResult && priceResult.value) setLivePrices(JSON.parse(priceResult.value));
      } catch (e) {
        // no cached prices
      }
    })();
  }, []);

  async function persistInvestAccounts(next) {
    setInvestAccounts(next);
    try {
      await window.storage.set("invest-accounts", JSON.stringify(next), false);
    } catch (e) {
      console.error("Could not save investment accounts", e);
    }
  }

  function addInvestAccount() {
    const nextId = investAccounts.length ? Math.max(...investAccounts.map((a) => a.id)) + 1 : 1;
    persistInvestAccounts([...investAccounts, { id: nextId, name: "New Account", kind: "holdings", holdings: [{ id: 1, ticker: "", shares: "", manualPrice: "" }] }]);
  }
  function removeInvestAccount(id) {
    persistInvestAccounts(investAccounts.filter((a) => a.id !== id));
  }
  function renameInvestAccount(id, name) {
    persistInvestAccounts(investAccounts.map((a) => (a.id === id ? { ...a, name } : a)));
  }
  function updateCashBalance(id, balance) {
    persistInvestAccounts(investAccounts.map((a) => (a.id === id ? { ...a, balance } : a)));
  }
  function addHolding(accountId) {
    persistInvestAccounts(
      investAccounts.map((a) => {
        if (a.id !== accountId) return a;
        const nextId = a.holdings.length ? Math.max(...a.holdings.map((h) => h.id)) + 1 : 1;
        return { ...a, holdings: [...a.holdings, { id: nextId, ticker: "", shares: "", manualPrice: "" }] };
      })
    );
  }
  function removeHolding(accountId, holdingId) {
    persistInvestAccounts(
      investAccounts.map((a) => (a.id === accountId ? { ...a, holdings: a.holdings.filter((h) => h.id !== holdingId) } : a))
    );
  }
  function updateHolding(accountId, holdingId, field, value) {
    persistInvestAccounts(
      investAccounts.map((a) =>
        a.id === accountId
          ? { ...a, holdings: a.holdings.map((h) => (h.id === holdingId ? { ...h, [field]: value } : h)) }
          : a
      )
    );
  }

  function getPrice(ticker, manualPrice) {
    const t = (ticker || "").trim().toUpperCase();
    if (t && livePrices[t] && livePrices[t].price) return livePrices[t].price;
    return Number(manualPrice) || 0;
  }

  async function refreshLivePrices() {
    const tickers = Array.from(
      new Set(
        investAccounts
          .filter((a) => a.kind === "holdings")
          .flatMap((a) => a.holdings.map((h) => (h.ticker || "").trim().toUpperCase()))
          .filter(Boolean)
      )
    );
    if (tickers.length === 0) {
      setPricesError("Add at least one ticker to a holdings account first.");
      return;
    }
    setPricesRefreshing(true);
    setPricesError(null);

    const systemPrompt =
      "You are a financial data assistant with web search. For each ticker symbol given, search the web for " +
      "its current or most recent closing stock/ETF price. Your entire response must be nothing but a single " +
      "valid JSON object — no markdown fences, no explanation, no summary, no text before or after it: " +
      "{\"TICKER1\": price_number, \"TICKER2\": price_number}. Use null for any symbol that isn't a real public " +
      "ticker or that you can't find a price for (e.g. an internal 401k fund name, not an exchange-traded " +
      "symbol). Money values as plain numbers, no $ or commas. Do not narrate your search process.";

    try {
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 2000,
          system: systemPrompt,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: "Look up current prices for these tickers: " + tickers.join(", ") }],
        }),
      });

      if (!response.ok) {
        let detail = "";
        try {
          const errBody = await response.json();
          detail = errBody?.error?.message ? " — " + errBody.error.message : "";
        } catch (e) {}
        throw new Error("Request failed (" + response.status + ")" + detail);
      }

      const data = await response.json();
      const combinedText = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (!combinedText) throw new Error("No price data came back in the response.");
      const parsed = extractJsonObject(combinedText);

      const next = { ...livePrices };
      const failed = [];
      tickers.forEach((t) => {
        if (parsed[t] !== null && parsed[t] !== undefined && !isNaN(Number(parsed[t]))) {
          next[t] = { price: Number(parsed[t]), updatedAt: new Date().toISOString() };
        } else {
          failed.push(t);
        }
      });
      setLivePrices(next);
      try {
        await window.storage.set("invest-live-prices", JSON.stringify(next), false);
      } catch (e) {
        console.error("Could not cache live prices", e);
      }
      if (failed.length) setPricesError("No price found for: " + failed.join(", ") + ". Using manual price for those.");
    } catch (err) {
      setPricesError(err.message || "Couldn't refresh prices. Try again in a moment.");
    } finally {
      setPricesRefreshing(false);
    }
  }

  function accountValue(account) {
    if (account.kind === "cash") return Number(account.balance) || 0;
    return account.holdings.reduce((sum, h) => sum + (Number(h.shares) || 0) * getPrice(h.ticker, h.manualPrice), 0);
  }

  const investTotal = investAccounts.reduce((sum, a) => sum + accountValue(a), 0);

  const investAllocation = useMemo(() => {
    const byTicker = {};
    let cashTotal = 0;
    investAccounts.forEach((a) => {
      if (a.kind === "cash") {
        cashTotal += Number(a.balance) || 0;
      } else {
        a.holdings.forEach((h) => {
          const t = (h.ticker || "").trim().toUpperCase() || "\u2014";
          const val = (Number(h.shares) || 0) * getPrice(h.ticker, h.manualPrice);
          byTicker[t] = (byTicker[t] || 0) + val;
        });
      }
    });
    if (cashTotal) byTicker["Cash"] = (byTicker["Cash"] || 0) + cashTotal;
    const total = Object.values(byTicker).reduce((s, v) => s + v, 0);
    return Object.entries(byTicker)
      .map(([ticker, value]) => ({ ticker, value, pct: total ? (value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
  }, [investAccounts, livePrices]);

  function calculateGrowth() {
    const start = Number(calcStart) || 0;
    const monthly = Number(calcMonthly) || 0;
    const ratePct = Number(calcRatePct);
    const years = Number(calcYears);
    if (!years || isNaN(ratePct)) {
      setCalcError("Enter a rate and number of years.");
      setCalcResult(null);
      return;
    }
    setCalcError(null);
    const rMonthly = ratePct / 100 / 12;
    const n = years * 12;
    let fv;
    if (rMonthly === 0) {
      fv = start + monthly * n;
    } else {
      fv = start * Math.pow(1 + rMonthly, n) + monthly * ((Math.pow(1 + rMonthly, n) - 1) / rMonthly);
    }
    const totalContributed = start + monthly * n;
    const totalGrowth = fv - totalContributed;
    setCalcResult({ fv, totalContributed, totalGrowth, years, ratePct });
  }

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get("market-reports", false);
        if (result && result.value) {
          const parsed = JSON.parse(result.value);
          setMarketReports(parsed);
          if (parsed.length) setViewingReportId(parsed[0].id);
        }
      } catch (e) {
        // no saved reports yet
      } finally {
        setMarketLoading(false);
      }
    })();
  }, []);

  async function persistMarketReports(next) {
    setMarketReports(next);
    try {
      await window.storage.set("market-reports", JSON.stringify(next), false);
    } catch (e) {
      console.error("Could not save market reports", e);
    }
  }

  async function generateMarketReport() {
    setMarketGenerating(true);
    setMarketError(null);

    const systemPrompt =
      "You are a financial market analyst assistant with web search. Search the web for today's stock market " +
      "close (or the most recent trading day if the market hasn't closed yet), current housing market " +
      "conditions, and gold/commodities markets. Your entire response must be nothing but a single valid JSON " +
      "object \u2014 no markdown fences, no explanation before or after it: " +
      "{\"as_of\": \"date/time this reflects\", \"stock_market\": \"3-5 sentence summary of how major indices " +
      "(S&P 500, Dow, Nasdaq) performed and overall sentiment/drivers\", \"stocks_to_watch\": " +
      "[{\"ticker\": \"...\", \"note\": \"1 sentence on why it's notable right now\"}] (4-6 items, real current " +
      "tickers), \"housing_market\": \"3-4 sentence summary of current mortgage rates, inventory, and price " +
      "trends\", \"commodities\": \"3-4 sentence summary of gold and broader commodities (oil, etc) right now\"}. " +
      "Base everything on real, current search results. Do not narrate your search process.";

    try {
      const response = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 3000,
          system: systemPrompt,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          messages: [{ role: "user", content: "Give me today's market report: stocks, housing, and commodities/gold." }],
        }),
      });

      if (!response.ok) {
        let detail = "";
        try {
          const errBody = await response.json();
          detail = errBody?.error?.message ? " — " + errBody.error.message : "";
        } catch (e) {}
        throw new Error("Request failed (" + response.status + ")" + detail);
      }

      const data = await response.json();
      const combinedText = (data.content || [])
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      if (!combinedText) throw new Error("No report content came back in the response.");
      const parsed = extractJsonObject(combinedText);

      const entry = {
        id: Date.now(),
        generatedAt: new Date().toISOString(),
        asOf: parsed.as_of || null,
        stockMarket: parsed.stock_market || null,
        stocksToWatch: Array.isArray(parsed.stocks_to_watch) ? parsed.stocks_to_watch : [],
        housingMarket: parsed.housing_market || null,
        commodities: parsed.commodities || null,
      };
      const next = [entry, ...marketReports].slice(0, 30);
      await persistMarketReports(next);
      setViewingReportId(entry.id);
    } catch (err) {
      setMarketError(err.message || "Couldn't generate the report. Try again in a moment.");
    } finally {
      setMarketGenerating(false);
    }
  }

  async function removeMarketReport(id) {
    const next = marketReports.filter((r) => r.id !== id);
    await persistMarketReports(next);
    if (viewingReportId === id) setViewingReportId(next.length ? next[0].id : null);
  }

  const viewingReport = marketReports.find((r) => r.id === viewingReportId) || null;

  const ladderCurrentIndex = ladderSteps.findIndex((s) => s.id === currentStepId);
  const ladderCurrent = ladderCurrentIndex >= 0 ? ladderSteps[ladderCurrentIndex] : null;
  const ladderNext = ladderCurrentIndex >= 0 && ladderCurrentIndex < ladderSteps.length - 1 ? ladderSteps[ladderCurrentIndex + 1] : null;
  const ladderDiff = ladderCurrent && ladderNext ? Number(ladderNext.rate) - Number(ladderCurrent.rate) : null;
  const ladderPct = ladderDiff !== null && Number(ladderCurrent.rate) ? (ladderDiff / Number(ladderCurrent.rate)) * 100 : null;

  async function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    await readStubFile(file, false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // `forceVision` skips the local attempt — that's the "read it with AI instead"
  // button on the review form.
  async function readStubFile(file, forceVision) {
    setUploading(true);
    setUploadError(null);
    setPendingStub(null);
    try {
      const isPdf = file.type === "application/pdf";

      // A PDF exported from a payroll portal carries a text layer, so it can be
      // read here for free. Photos, scans, and low-confidence local parses fall
      // through to the vision call below.
      if (isPdf && !forceVision) {
        const text = await extractPdfTextLayer(file);
        if (text) {
          const local = parseStubTextLocally(text);
          if (local.confidence.confident) {
            const draft = {};
            LOCAL_STUB_FIELDS.forEach((f) => {
              const v = local.data[f.key];
              draft[f.key] = v === null || v === undefined ? "" : String(v);
            });
            setPendingStubFile(file);
            setPendingStub(draft);
            return;
          }
        }
      }

      const base64 = await fileToBase64(file);
      const parsed = await extractStubData(base64, file.type, isPdf);
      const entry = { id: Date.now(), uploadedAt: new Date().toISOString(), ...parsed, source: "ai" };
      const next = [entry, ...stubs].slice(0, 30);
      await persistStubs(next);
      setPendingStubFile(null);
      setJustStamped(true);
      setTimeout(() => setJustStamped(false), 900);
    } catch (err) {
      setUploadError(err.message || "Couldn't read that stub. Try a clearer image or paste the numbers manually.");
    } finally {
      setUploading(false);
    }
  }

  function updatePendingStub(key, value) {
    setPendingStub((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  async function confirmPendingStub() {
    if (!pendingStub) return;
    const entry = { id: Date.now(), uploadedAt: new Date().toISOString(), source: "local" };
    LOCAL_STUB_FIELDS.forEach((f) => {
      const raw = String(pendingStub[f.key] === undefined ? "" : pendingStub[f.key]).trim();
      if (raw === "") {
        entry[f.key] = null;
      } else if (f.type === "number") {
        entry[f.key] = isNaN(Number(raw)) ? null : Number(raw);
      } else {
        entry[f.key] = raw;
      }
    });
    setPendingStub(null);
    setPendingStubFile(null);
    await persistStubs([entry, ...stubs].slice(0, 30));
    setJustStamped(true);
    setTimeout(() => setJustStamped(false), 900);
  }

  function discardPendingStub() {
    setPendingStub(null);
    setPendingStubFile(null);
  }

  async function removeStub(id) {
    const next = stubs.filter((s) => s.id !== id);
    await persistStubs(next);
  }

  const dedPct = dedPctInput === "" ? 25 : Math.max(0, Math.min(100, Number(dedPctInput)));
  const ladderNetBump = ladderDiff !== null ? ladderDiff * 80 * (1 - dedPct / 100) : null;

  const [hoursCalc, setHoursCalc] = useState(null);
  const [hoursCalcError, setHoursCalcError] = useState(null);

  function weekTotals(daysArr, sundayType) {
    const rest = daysArr.slice(0, 6); // Mon-Sat
    const sun = Number(daysArr[6]) || 0;

    let dailyOT = 0;
    let regPool = 0;
    rest.forEach((h) => {
      const hh = Number(h) || 0;
      if (hh > 8) {
        dailyOT += hh - 8;
        regPool += 8;
      } else {
        regPool += hh;
      }
    });
    const weeklyOT = Math.max(0, regPool - 40);
    let regular = regPool - weeklyOT;
    let ot = dailyOT + weeklyOT;
    let doubleTime = 0;

    if (sundayType === "ot") ot += sun;
    else if (sundayType === "double") doubleTime += sun;
    else regular += sun;

    return { regular, ot, doubleTime };
  }

  function effRate(base, shift) {
    let eff = base;
    if (shift !== "day") eff += Number(shiftPremium) || 0;
    if (isTeamLeader) eff += Number(teamLeaderPremium) || 0;
    return eff;
  }

  function grossFromBucket(bucket, eff) {
    return bucket.regular * eff + bucket.ot * eff * 1.5 + bucket.doubleTime * eff * 2;
  }

  function periodWeeks(period) {
    return period === "weekly" ? 1 : period === "biweekly" ? 2 : 52 / 12;
  }

  function calculateHoursToPay() {
    const r = Number(rate);
    const weeks = periodWeeks(payPeriod);
    const perDiemTotal = (Number(perDiemRate) || 0) * (Number(perDiemDays) || 0) * weeks;

    if (hoursInputMode === "total") {
      const regular = Number(totalRegHours) || 0;
      const ot = Number(totalOtHours) || 0;
      if (!r || (regular === 0 && ot === 0)) {
        setHoursCalcError("Enter an hourly rate and at least some hours.");
        setHoursCalc(null);
        return;
      }
      setHoursCalcError(null);
      const eff = effRate(r, totalsShift);
      const gross = regular * eff + ot * eff * 1.5;
      const taxableNet = gross * (1 - dedPct / 100);
      const net = taxableNet + perDiemTotal;
      setHoursCalc({
        regular, ot, doubleTime: 0, gross, taxableNet, perDiemTotal, net, keepPct: 100 - dedPct,
        note: "entered as totals" + (eff !== r ? " \u2014 eff. rate " + fmtMoney(eff) + "/hr" : ""),
        payPeriod,
      });
      return;
    }

    const w1 = weekTotals(week1Days, week1SundayType);
    const w2 = weekTotals(week2Days, week2SundayType);
    const w1Total = w1.regular + w1.ot + w1.doubleTime;
    if (!r || w1Total === 0) {
      setHoursCalcError("Enter an hourly rate and at least some hours.");
      setHoursCalc(null);
      return;
    }
    setHoursCalcError(null);

    const eff1 = effRate(r, week1Shift);
    const eff2 = effRate(r, week2Shift);

    let regular, ot, doubleTime, gross, note;
    if (payPeriod === "weekly") {
      regular = w1.regular;
      ot = w1.ot;
      doubleTime = w1.doubleTime;
      gross = grossFromBucket(w1, eff1);
      note = "1 week, OT after 8/day or 40/week";
    } else if (payPeriod === "biweekly") {
      regular = w1.regular + w2.regular;
      ot = w1.ot + w2.ot;
      doubleTime = w1.doubleTime + w2.doubleTime;
      gross = grossFromBucket(w1, eff1) + grossFromBucket(w2, eff2);
      note = "2 weeks, OT after 8/day or 40/week, each week";
    } else {
      const weeksPerMonth = 52 / 12;
      regular = w1.regular * weeksPerMonth;
      ot = w1.ot * weeksPerMonth;
      doubleTime = w1.doubleTime * weeksPerMonth;
      gross = grossFromBucket(w1, eff1) * weeksPerMonth;
      note = "approx. — week 1 pattern \u00d7 " + weeksPerMonth.toFixed(2) + " weeks/month";
    }

    if (eff1 !== r || eff2 !== r) {
      const parts = [];
      if (eff1 !== r) parts.push("Wk1 eff. " + fmtMoney(eff1) + "/hr");
      if (payPeriod === "biweekly" && eff2 !== r) parts.push("Wk2 eff. " + fmtMoney(eff2) + "/hr");
      note += " \u2014 " + parts.join(", ");
    }

    const taxableNet = gross * (1 - dedPct / 100);
    const net = taxableNet + perDiemTotal;
    setHoursCalc({ regular, ot, doubleTime, gross, taxableNet, perDiemTotal, net, keepPct: 100 - dedPct, note, payPeriod });
  }

  const [targetPeriod, setTargetPeriod] = useState("biweekly");
  const REGULAR_THRESHOLD = {
    weekly: 40,
    biweekly: 80,
    monthly: 40 * (52 / 12),
  };

  const targetCalc = useMemo(() => {
    const target = Number(targetNet);
    const baseR = Number(targetRate);
    if (!target || !baseR) return null;
    let r = baseR;
    if (targetShift !== "day") r += Number(shiftPremium) || 0;
    if (isTeamLeader) r += Number(teamLeaderPremium) || 0;
    const rateNote = r !== baseR ? " (eff. " + fmtMoney(r) + "/hr)" : "";
    const threshold = REGULAR_THRESHOLD[targetPeriod];
    const grossNeeded = target / (1 - dedPct / 100);
    const daysPerWeek = Math.max(1, Math.min(7, Number(targetDaysPerWeek) || 5));
    const weeksInPeriod = targetPeriod === "weekly" ? 1 : targetPeriod === "biweekly" ? 2 : 52 / 12;

    if (daysPerWeek === 7 && sundayDoubleTime) {
      // 1 of every 7 days (Sunday) is paid at 2x; the other 6 days follow the
      // regular/OT threshold split (if assumeOT is on) or straight time.
      const xCaseA = grossNeeded / (8 * r * weeksInPeriod);
      const nonSundayA = 6 * weeksInPeriod * xCaseA;
      let x, note;
      if (!assumeOT || nonSundayA <= threshold) {
        x = xCaseA;
        note = (assumeOT
          ? "7-day week, Sun @ 2x, rest straight (under " + threshold.toFixed(0) + " hrs)"
          : "7-day week, Sun @ 2x, rest straight time") + rateNote;
      } else {
        x = (grossNeeded + 0.5 * threshold * r) / (11 * r * weeksInPeriod);
        note = "7-day week, Sun @ 2x, rest OT after " + threshold.toFixed(0) + " hrs" + rateNote;
      }
      return { grossNeeded, hours: 7 * weeksInPeriod * x, note };
    }

    if (!assumeOT) {
      return { grossNeeded, hours: grossNeeded / r, note: "straight time" + rateNote };
    }
    const regGrossAtThreshold = threshold * r;
    if (grossNeeded <= regGrossAtThreshold) {
      return { grossNeeded, hours: grossNeeded / r, note: "under " + threshold.toFixed(0) + " hrs, straight time" + rateNote };
    }
    const remainingGross = grossNeeded - regGrossAtThreshold;
    const otHoursNeeded = remainingGross / (r * 1.5);
    return { grossNeeded, hours: threshold + otHoursNeeded, note: threshold.toFixed(0) + " reg + OT after that" + rateNote };
  }, [targetNet, targetRate, dedPct, assumeOT, targetPeriod, targetDaysPerWeek, sundayDoubleTime, targetShift, shiftPremium, teamLeaderPremium, isTeamLeader]);

  const targetDailyBreakdown = useMemo(() => {
    if (!targetCalc) return null;
    const daysPerWeek = Math.max(1, Math.min(7, Number(targetDaysPerWeek) || 5));
    const weeksInPeriod = targetPeriod === "weekly" ? 1 : targetPeriod === "biweekly" ? 2 : 52 / 12;
    const totalWorkDays = daysPerWeek * weeksInPeriod;
    if (!totalWorkDays) return null;
    const hoursPerDay = targetCalc.hours / totalWorkDays;

    if (targetPeriod === "monthly") {
      return { type: "summary", hoursPerDay, totalWorkDays, daysPerWeek };
    }
    const dayLabels = DAY_LABELS.slice(0, daysPerWeek);
    const weeks = targetPeriod === "biweekly" ? 2 : 1;
    return { type: "grid", hoursPerDay, dayLabels, weeks, daysPerWeek };
  }, [targetCalc, targetPeriod, targetDaysPerWeek]);

  return (
    <div className="pc-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
        .pc-root {
          background: ${TOKENS.bg};
          color: ${TOKENS.text};
          font-family: 'IBM Plex Sans', system-ui, sans-serif;
          min-height: 100%;
          padding: 28px 20px 60px;
          box-sizing: border-box;
        }
        .pc-root * { box-sizing: border-box; }
        .pc-header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 4px; flex-wrap: wrap; }
        .pc-title {
          font-family: 'Big Shoulders Display', sans-serif;
          font-weight: 800;
          font-size: 34px;
          letter-spacing: 0.5px;
          text-transform: uppercase;
          line-height: 1;
          margin: 0;
        }
        .pc-title span { color: ${TOKENS.amber}; }
        .pc-sub {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: ${TOKENS.textDim};
          letter-spacing: 0.08em;
          text-transform: uppercase;
          margin: 0 0 22px 0;
        }
        .pc-tabs { display: flex; gap: 6px; margin-bottom: 18px; flex-wrap: wrap; }
        .pc-tab {
          background: transparent;
          border: 1px solid ${TOKENS.panelBorder};
          color: ${TOKENS.textDim};
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 9px 14px;
          border-radius: 4px;
          cursor: pointer;
          transition: border-color 0.15s, color 0.15s;
        }
        .pc-tab:hover { color: ${TOKENS.text}; border-color: ${TOKENS.amber}; }
        .pc-tab.active { color: ${TOKENS.bg}; background: ${TOKENS.amber}; border-color: ${TOKENS.amber}; font-weight: 600; }
        .pc-tab:focus-visible { outline: 2px solid ${TOKENS.amber}; outline-offset: 2px; }
        .pc-panel {
          background: ${TOKENS.panel};
          border: 1px solid ${TOKENS.panelBorder};
          border-radius: 8px;
          padding: 22px;
          max-width: 640px;
        }
        .pc-panel-title {
          font-family: 'Big Shoulders Display', sans-serif;
          font-weight: 600;
          font-size: 18px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
          margin: 0 0 4px 0;
        }
        .pc-panel-desc { font-size: 13px; color: ${TOKENS.textDim}; margin: 0 0 18px 0; line-height: 1.5; }
        .pc-field { margin-bottom: 14px; }
        .pc-field label {
          display: block;
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: ${TOKENS.textDim};
          margin-bottom: 6px;
        }
        .pc-field input[type="number"], .pc-field input[type="text"] {
          width: 100%;
          background: ${TOKENS.panel2};
          border: 1px solid ${TOKENS.panelBorder};
          color: ${TOKENS.text};
          font-family: 'IBM Plex Mono', monospace;
          font-size: 15px;
          padding: 10px 12px;
          border-radius: 4px;
        }
        .pc-field input:focus-visible { outline: 2px solid ${TOKENS.amber}; outline-offset: 1px; }
        .pc-field select {
          width: 100%;
          background: ${TOKENS.panel2};
          border: 1px solid ${TOKENS.panelBorder};
          color: ${TOKENS.text};
          font-family: 'IBM Plex Mono', monospace;
          font-size: 14px;
          padding: 10px 12px;
          border-radius: 4px;
          appearance: none;
        }
        .pc-field select:focus-visible { outline: 2px solid ${TOKENS.amber}; outline-offset: 1px; }
        .pc-daygrid { margin-bottom: 18px; }
        .pc-daygrid-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }
        .pc-daygrid-label {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: ${TOKENS.textDim};
        }
        .pc-daygrid-total {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          color: ${TOKENS.amber};
          font-weight: 600;
        }
        .pc-daygrid-row { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; }
        .pc-day {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 5px;
          background: ${TOKENS.panel2};
          border: 1px solid ${TOKENS.panelBorder};
          border-radius: 5px;
          padding: 7px 2px 8px;
        }
        .pc-day.weekend { background: transparent; border-style: dashed; opacity: 0.75; }
        .pc-day label {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 9.5px;
          letter-spacing: 0.04em;
          color: ${TOKENS.textDim};
          text-transform: uppercase;
        }
        .pc-day input {
          width: 100%;
          background: transparent;
          border: none;
          border-bottom: 1px solid ${TOKENS.panelBorder};
          color: ${TOKENS.text};
          font-family: 'IBM Plex Mono', monospace;
          font-size: 14px;
          font-weight: 600;
          padding: 2px 0 4px;
          text-align: center;
          border-radius: 0;
        }
        .pc-day input:focus-visible { outline: none; border-bottom-color: ${TOKENS.amber}; }
        .pc-day-flag {
          display: inline-block;
          margin-left: 3px;
          color: ${TOKENS.amber};
          font-weight: 700;
        }
        .pc-day-static { cursor: default; }
        .pc-day-static-value {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 14px;
          font-weight: 600;
          color: ${TOKENS.green};
          border-bottom: 1px solid ${TOKENS.panelBorder};
          width: 100%;
          text-align: center;
          padding: 2px 0 4px;
        }
        .pc-day-static.over .pc-day-static-value { color: ${TOKENS.rust}; }
        .pc-daydays-field { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
        .pc-daydays-field label { font-family: 'IBM Plex Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: ${TOKENS.textDim}; }
        .pc-daydays-field input { width: 56px; background: ${TOKENS.panel2}; border: 1px solid ${TOKENS.panelBorder}; color: ${TOKENS.text}; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 6px 8px; border-radius: 4px; text-align: center; }
        .pc-sunday-field { margin-top: -6px; margin-bottom: 20px; max-width: 220px; }
        .pc-sunday-field select { font-size: 12.5px; padding: 8px 10px; }
        .pc-apply-both {
          background: none; border: none; color: ${TOKENS.amber};
          font-family: 'IBM Plex Mono', monospace; font-size: 11px; cursor: pointer;
          text-decoration: underline; padding: 6px 0 0; display: block;
        }
        .pc-breakdown-note { font-size: 12px; color: ${TOKENS.textDim}; margin-top: 6px; }
        .pc-scale-load { margin-bottom: 18px; padding: 10px 12px; background: ${TOKENS.panel2}; border: 1px solid ${TOKENS.panelBorder}; border-radius: 5px; }
        .pc-scale-load-label { display: block; font-family: 'IBM Plex Mono', monospace; font-size: 11px; color: ${TOKENS.textDim}; margin-bottom: 8px; }
        .pc-scale-load-btns { display: flex; gap: 16px; flex-wrap: wrap; }
        .pc-divider { height: 1px; background: ${TOKENS.panelBorder}; margin: 26px 0; }
        .pc-scale-table { margin-bottom: 18px; overflow-x: auto; }
        .pc-scale-table-title { font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; color: ${TOKENS.amber}; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px; }
        .pc-scale-table-row { display: flex; gap: 10px; min-width: max-content; }
        .pc-scale-table-row span { font-family: 'IBM Plex Mono', monospace; font-size: 12px; min-width: 64px; padding: 4px 0; }
        .pc-scale-table-head span { color: ${TOKENS.textDim}; font-size: 10px; text-transform: uppercase; }
        .pc-scale-table-row:not(.pc-scale-table-head) span { color: ${TOKENS.green}; font-weight: 600; border-top: 1px solid ${TOKENS.panelBorder}; }
        .pc-scale-table-premiums { font-size: 11px; color: ${TOKENS.textDim}; margin-top: 8px; }
        .pc-invest-account {
          background: ${TOKENS.panel2}; border: 1px solid ${TOKENS.panelBorder}; border-radius: 6px;
          padding: 12px; margin-bottom: 12px;
        }
        .pc-invest-account-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .pc-invest-account-name {
          flex: 1; min-width: 0; background: transparent; border: none; color: ${TOKENS.text};
          font-family: 'Big Shoulders Display', sans-serif; font-weight: 600; font-size: 15px;
          text-transform: uppercase; letter-spacing: 0.02em; padding: 2px 0;
        }
        .pc-invest-account-name:focus-visible { outline: 1px solid ${TOKENS.amber}; }
        .pc-invest-account-value { font-family: 'IBM Plex Mono', monospace; font-size: 14px; color: ${TOKENS.green}; font-weight: 600; white-space: nowrap; }
        .pc-invest-cash-field { margin-bottom: 0; }
        .pc-holding-row { display: grid; grid-template-columns: 64px 1fr 1fr 90px 20px; gap: 6px; align-items: center; margin-bottom: 6px; }
        .pc-holding-ticker, .pc-holding-shares, .pc-holding-price {
          background: ${TOKENS.panel}; border: 1px solid ${TOKENS.panelBorder}; border-radius: 4px;
          color: ${TOKENS.text}; font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; padding: 7px 6px; text-align: center; min-width: 0;
        }
        .pc-holding-ticker { text-transform: uppercase; font-weight: 600; }
        .pc-holding-price.live { color: ${TOKENS.green}; border-color: ${TOKENS.green}; opacity: 0.9; }
        .pc-holding-value { font-family: 'IBM Plex Mono', monospace; font-size: 12.5px; color: ${TOKENS.textDim}; text-align: right; white-space: nowrap; }
        .pc-btn-link:disabled { opacity: 0.5; cursor: default; }
        .pc-breakdown-note.warn { color: ${TOKENS.rust}; }
        .pc-ladder-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
        .pc-ladder-row {
          display: flex; align-items: center; gap: 8px;
          background: ${TOKENS.panel2}; border: 1px solid ${TOKENS.panelBorder}; border-radius: 5px;
          padding: 8px 10px;
        }
        .pc-ladder-row.current { border-color: ${TOKENS.amber}; }
        .pc-ladder-mark {
          background: none; border: 1px solid ${TOKENS.panelBorder}; border-radius: 50%;
          width: 24px; height: 24px; flex-shrink: 0; cursor: pointer;
          color: ${TOKENS.amber}; font-size: 12px; display: flex; align-items: center; justify-content: center;
        }
        .pc-ladder-row.current .pc-ladder-mark { border-color: ${TOKENS.amber}; }
        .pc-ladder-label {
          flex: 1; min-width: 0; background: transparent; border: none; color: ${TOKENS.text};
          font-family: 'IBM Plex Sans', sans-serif; font-size: 13px; padding: 4px 0;
        }
        .pc-ladder-label:focus-visible { outline: 1px solid ${TOKENS.amber}; }
        .pc-ladder-rate {
          width: 84px; background: transparent; border: none; border-bottom: 1px solid ${TOKENS.panelBorder};
          color: ${TOKENS.amber}; font-family: 'IBM Plex Mono', monospace; font-size: 14px; font-weight: 600;
          text-align: right; padding: 4px 2px;
        }
        .pc-ladder-rate:focus-visible { outline: none; border-bottom-color: ${TOKENS.amber}; }
        .pc-ladder-remove { background: none; border: none; color: ${TOKENS.textDim}; cursor: pointer; font-size: 15px; flex-shrink: 0; }
        .pc-ladder-remove:hover { color: ${TOKENS.rust}; }
        .pc-mode-toggle { display: inline-flex; border: 1px solid ${TOKENS.panelBorder}; border-radius: 4px; overflow: hidden; margin-bottom: 18px; }
        .pc-mode-btn {
          background: transparent; border: none; color: ${TOKENS.textDim};
          font-family: 'IBM Plex Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
          padding: 7px 14px; cursor: pointer; transition: background 0.15s, color 0.15s;
        }
        .pc-mode-btn.active { background: ${TOKENS.amber}; color: ${TOKENS.bg}; font-weight: 600; }
        .pc-mode-btn:not(.active):hover { color: ${TOKENS.text}; }
        .pc-mode-btn:focus-visible { outline: 2px solid ${TOKENS.amber}; outline-offset: -2px; }
        .pc-panel-subtitle {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          color: ${TOKENS.amber};
          margin-bottom: 12px;
        }
        .pc-panel-subtitle span { color: ${TOKENS.textDim}; text-transform: none; letter-spacing: normal; font-size: 11px; }
        .pc-calc-note { font-size: 12px; color: ${TOKENS.textDim}; margin-top: 10px; font-style: italic; }
        .pc-row { display: flex; gap: 12px; flex-wrap: wrap; }
        .pc-row > .pc-field { flex: 1; min-width: 110px; }
        .pc-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; color: ${TOKENS.textDim}; margin-bottom: 16px; cursor: pointer; }
        .pc-checkbox input { accent-color: ${TOKENS.amber}; width: 15px; height: 15px; }
        .pc-upload-zone {
          border: 1.5px dashed ${TOKENS.panelBorder};
          border-radius: 6px;
          padding: 28px 16px;
          text-align: center;
          cursor: pointer;
          transition: border-color 0.15s;
        }
        .pc-upload-zone:hover { border-color: ${TOKENS.amber}; }
        .pc-upload-zone input { display: none; }
        .pc-upload-label { font-size: 13px; color: ${TOKENS.textDim}; }
        .pc-upload-label strong { color: ${TOKENS.amber}; }
        .pc-btn-link {
          background: none; border: none; color: ${TOKENS.amber};
          font-family: 'IBM Plex Mono', monospace; font-size: 12px; cursor: pointer;
          text-decoration: underline; padding: 0;
        }
        .pc-error { color: ${TOKENS.rust}; font-size: 13px; margin-top: 10px; }
        .pc-source-tag {
          display: inline-block; font-family: 'IBM Plex Mono', monospace; font-size: 10px;
          letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap;
          padding: 2px 6px; border-radius: 3px; border: 1px solid ${TOKENS.panelBorder};
          color: ${TOKENS.textDim}; vertical-align: middle;
        }
        .pc-source-tag.local { color: ${TOKENS.green}; border-color: ${TOKENS.green}; opacity: 0.85; }
        .pc-source-tag.ai { color: ${TOKENS.amber}; border-color: ${TOKENS.amber}; opacity: 0.75; }
        .pc-review {
          margin-top: 14px; padding: 14px; border-radius: 6px;
          background: ${TOKENS.panel2}; border: 1px solid ${TOKENS.green};
        }
        .pc-review-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
        .pc-review-title {
          font-family: 'Big Shoulders Display', sans-serif; font-weight: 600; font-size: 15px;
          text-transform: uppercase; letter-spacing: 0.02em; color: ${TOKENS.text};
        }
        .pc-review-desc { font-size: 12px; color: ${TOKENS.textDim}; margin: 0 0 12px; line-height: 1.5; }
        .pc-review-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0 12px; }
        .pc-review-steps-title {
          font-family: 'IBM Plex Mono', monospace; font-size: 11px; letter-spacing: 0.06em;
          text-transform: uppercase; color: ${TOKENS.textDim}; margin: 4px 0 8px;
        }
        .pc-review-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 4px; }
        .pc-calc-btn {
          background: ${TOKENS.amber};
          color: ${TOKENS.bg};
          border: none;
          font-family: 'IBM Plex Mono', monospace;
          font-weight: 600;
          font-size: 13px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          padding: 11px 20px;
          border-radius: 4px;
          cursor: pointer;
          margin-top: 4px;
          transition: opacity 0.15s;
        }
        .pc-calc-btn:hover { opacity: 0.85; }
        .pc-calc-btn:focus-visible { outline: 2px solid ${TOKENS.text}; outline-offset: 2px; }
        .pc-results { margin-top: 18px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
        .pc-result-list { flex: 1; min-width: 200px; }
        .pc-result-line { display: flex; justify-content: space-between; font-family: 'IBM Plex Mono', monospace; font-size: 13px; padding: 5px 0; border-bottom: 1px solid ${TOKENS.panelBorder}; }
        .pc-result-line .k { color: ${TOKENS.textDim}; }
        .pc-result-line .v { color: ${TOKENS.text}; }
        .pc-result-line.net .v { color: ${TOKENS.green}; font-weight: 600; }
        .stamp { width: 108px; height: 108px; border-radius: 50%; border: 1.5px solid; position: relative; flex-shrink: 0; }
        .stamp-ticks { position: absolute; inset: 0; width: 100%; height: 100%; }
        .stamp-ticks.spin { animation: stampIn 0.7s ease-out; }
        @keyframes stampIn { from { transform: scale(1.4) rotate(-12deg); opacity: 0; } to { transform: scale(1) rotate(0deg); opacity: 1; } }
        .stamp-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
        .stamp-value { font-family: 'Big Shoulders Display', sans-serif; font-weight: 800; font-size: 22px; line-height: 1; }
        .stamp-label { font-family: 'IBM Plex Mono', monospace; font-size: 9px; letter-spacing: 0.05em; text-transform: uppercase; color: ${TOKENS.textDim}; margin-top: 3px; }
        .pc-history { margin-top: 26px; }
        .pc-history-title { font-family: 'IBM Plex Mono', monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: ${TOKENS.textDim}; margin-bottom: 10px; }
        .pc-chip-row { display: flex; gap: 8px; flex-wrap: wrap; }
        .pc-chip {
          background: ${TOKENS.panel2}; border: 1px solid ${TOKENS.panelBorder}; border-radius: 5px;
          padding: 6px 8px; font-family: 'IBM Plex Mono', monospace; font-size: 12px; display: flex; align-items: center; gap: 8px;
        }
        .pc-chip.active-chip { border-color: ${TOKENS.amber}; }
        .pc-chip .remove { color: ${TOKENS.textDim}; cursor: pointer; background: none; border: none; font-size: 13px; }
        .pc-chip .remove:hover { color: ${TOKENS.rust}; }
        .pc-chip-select { background: none; border: none; color: ${TOKENS.text}; font-family: inherit; font-size: 12px; cursor: pointer; padding: 2px 0; }
        .pc-chip.active-chip .pc-chip-select { color: ${TOKENS.amber}; font-weight: 600; }
        .pc-market-report { margin-top: 18px; }
        .pc-market-report-meta { font-size: 11px; color: ${TOKENS.textDim}; font-family: 'IBM Plex Mono', monospace; margin-bottom: 16px; }
        .pc-market-report-text { font-size: 13.5px; color: ${TOKENS.text}; line-height: 1.6; margin: 0 0 18px 0; }
        .pc-avg-note { font-size: 12px; color: ${TOKENS.textDim}; margin-top: 14px; }
        .pc-avg-note button { color: ${TOKENS.amber}; background: none; border: none; text-decoration: underline; cursor: pointer; font-size: 12px; font-family: inherit; padding: 0; }
        @media (prefers-reduced-motion: reduce) { .stamp-ticks.spin { animation: none; } }
      `}</style>

      <div className="pc-header">
        <h1 className="pc-title">NET<span>/</span>SHIFT</h1>
      </div>
      <p className="pc-sub">net pay calculator &mdash; keep %, hours-to-target</p>

      <div className="pc-tabs" role="tablist">
        <button className={"pc-tab" + (tab === "upload" ? " active" : "")} onClick={() => setTab("upload")} role="tab" aria-selected={tab === "upload"}>Upload Stub</button>
        <button className={"pc-tab" + (tab === "hours" ? " active" : "")} onClick={() => setTab("hours")} role="tab" aria-selected={tab === "hours"}>Hours &rarr; Pay</button>
        <button className={"pc-tab" + (tab === "target" ? " active" : "")} onClick={() => setTab("target")} role="tab" aria-selected={tab === "target"}>Target &rarr; Hours</button>
        <button className={"pc-tab" + (tab === "ladder" ? " active" : "")} onClick={() => setTab("ladder")} role="tab" aria-selected={tab === "ladder"}>Pay Profile</button>
        <button className={"pc-tab" + (tab === "invest" ? " active" : "")} onClick={() => setTab("invest")} role="tab" aria-selected={tab === "invest"}>Investments</button>
        <button className={"pc-tab" + (tab === "market" ? " active" : "")} onClick={() => setTab("market")} role="tab" aria-selected={tab === "market"}>Market Report</button>
      </div>

      {tab === "upload" && (
        <div className="pc-panel">
          <h2 className="pc-panel-title">Upload a pay stub</h2>
          <p className="pc-panel-desc">Photo, screenshot, or PDF. It'll pull gross pay, taxes, deductions, and net &mdash; and calculate the percentage you actually keep.</p>

          <label className="pc-upload-zone">
            <input ref={fileInputRef} type="file" accept="image/*,application/pdf" onChange={handleFile} />
            <div className="pc-upload-label">
              {uploading ? "Reading stub…" : <><strong>Click to upload</strong> or drop a file here</>}
            </div>
          </label>
          {uploadError && <div className="pc-error">{uploadError}</div>}

          {pendingStub && (
            <div className="pc-review">
              <div className="pc-review-head">
                <span className="pc-review-title">Check these before saving</span>
                <SourceTag source="local" />
              </div>
              <p className="pc-review-desc">
                Read straight out of the PDF in your browser &mdash; no upload, no API call. Rule-based reading is less
                reliable than the AI, so give these a look and fix anything that's off.
              </p>
              <div className="pc-review-grid">
                {LOCAL_STUB_FIELDS.map((f) => (
                  <div className="pc-field" key={f.key}>
                    <label htmlFor={"pending-" + f.key}>{f.label}</label>
                    <input
                      id={"pending-" + f.key}
                      type={f.type === "number" ? "number" : "text"}
                      step={f.type === "number" ? "0.01" : undefined}
                      value={pendingStub[f.key]}
                      placeholder={f.type === "number" ? "—" : "MM/DD/YYYY"}
                      onChange={(e) => updatePendingStub(f.key, e.target.value)}
                    />
                  </div>
                ))}
              </div>
              <div className="pc-review-actions">
                <button className="pc-calc-btn" onClick={confirmPendingStub}>Save this stub</button>
                {pendingStubFile && (
                  <button className="pc-btn-link" onClick={() => readStubFile(pendingStubFile, true)} disabled={uploading}>
                    Read it with AI instead
                  </button>
                )}
                <button className="pc-btn-link" onClick={discardPendingStub}>Discard</button>
              </div>
            </div>
          )}

          {stubs.length > 0 && stubs[0].net_pay && stubs[0].gross_pay && (
            <div className="pc-results">
              <StampBadge value={fmtPct(100 - (1 - stubs[0].net_pay / stubs[0].gross_pay) * 100)} label="kept" tone="green" spin={justStamped} />
              <div className="pc-result-list">
                <div className="pc-result-line"><span className="k">Gross</span><span className="v">{fmtMoney(stubs[0].gross_pay)}</span></div>
                <div className="pc-result-line"><span className="k">Federal tax</span><span className="v">{fmtMoney(stubs[0].federal_tax)}</span></div>
                <div className="pc-result-line"><span className="k">State tax</span><span className="v">{fmtMoney(stubs[0].state_tax)}</span></div>
                <div className="pc-result-line"><span className="k">Social Security</span><span className="v">{fmtMoney(stubs[0].social_security)}</span></div>
                <div className="pc-result-line"><span className="k">Medicare</span><span className="v">{fmtMoney(stubs[0].medicare)}</span></div>
                <div className="pc-result-line"><span className="k">Other deductions</span><span className="v">{fmtMoney(stubs[0].other_deductions_total)}</span></div>
                <div className="pc-result-line net"><span className="k">Net</span><span className="v">{fmtMoney(stubs[0].net_pay)}</span></div>
              </div>
            </div>
          )}

          {!stubsLoading && stubs.length > 0 && (
            <div className="pc-history">
              <div className="pc-history-title">History ({stubs.length})</div>
              <div className="pc-chip-row">
                {stubs.map((s) => (
                  <div className="pc-chip" key={s.id}>
                    <span>{s.pay_date || new Date(s.uploadedAt).toLocaleDateString()}</span>
                    <span style={{ color: TOKENS.green }}>{fmtMoney(s.net_pay)}</span>
                    <SourceTag source={s.source} />
                    <button className="remove" onClick={() => removeStub(s.id)} aria-label="Remove this stub">&times;</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "hours" && (
        <div className="pc-panel">
          <h2 className="pc-panel-title">Hours &rarr; Pay</h2>
          <p className="pc-panel-desc">Enter hours per day. OT is calculated after 8 hours in a day or 40 in a week, whichever gives you more.</p>

          <div className="pc-field">
            <label htmlFor="h-period">Pay period</label>
            <select id="h-period" value={payPeriod} onChange={(e) => setPayPeriod(e.target.value)}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-Weekly (2 weeks)</option>
              <option value="monthly">Monthly (est.)</option>
            </select>
          </div>

          <div className="pc-field">
            <label htmlFor="h-rate">Hourly rate ($)</label>
            <input id="h-rate" type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="41.41" />
          </div>

          <div className="pc-mode-toggle" role="tablist" aria-label="Hours input mode">
            <button className={"pc-mode-btn" + (hoursInputMode === "daily" ? " active" : "")} onClick={() => setHoursInputMode("daily")}>By day</button>
            <button className={"pc-mode-btn" + (hoursInputMode === "total" ? " active" : "")} onClick={() => setHoursInputMode("total")}>Regular / OT totals</button>
          </div>

          {hoursInputMode === "daily" ? (
            <>
              <DayGrid
                label={payPeriod === "monthly" ? "Typical week" : payPeriod === "biweekly" ? "Week 1" : "This week"}
                values={week1Days}
                onChange={setWeek1Days}
                dayLabels={DAY_LABELS}
              />
              <div className="pc-row">
                <div className="pc-field pc-sunday-field">
                  <label htmlFor="h-sun-1">Week 1 Sunday hours count as</label>
                  <select id="h-sun-1" value={week1SundayType} onChange={(e) => setWeek1SundayType(e.target.value)}>
                    <option value="regular">Regular</option>
                    <option value="ot">Overtime (1.5x)</option>
                    <option value="double">Double time (2x)</option>
                  </select>
                  {payPeriod === "biweekly" && week2SundayType !== week1SundayType && (
                    <button type="button" className="pc-apply-both" onClick={() => setWeek2SundayType(week1SundayType)}>
                      Apply to Week 2 too
                    </button>
                  )}
                </div>
                <div className="pc-field pc-sunday-field">
                  <label htmlFor="h-shift-1">Week 1 shift</label>
                  <select id="h-shift-1" value={week1Shift} onChange={(e) => setWeek1Shift(e.target.value)}>
                    <option value="day">Day</option>
                    <option value="mid">Mid</option>
                    <option value="night">Night</option>
                  </select>
                  {payPeriod === "biweekly" && week2Shift !== week1Shift && (
                    <button type="button" className="pc-apply-both" onClick={() => setWeek2Shift(week1Shift)}>
                      Apply to Week 2 too
                    </button>
                  )}
                </div>
              </div>
              {payPeriod === "biweekly" && (
                <>
                  <DayGrid label="Week 2" values={week2Days} onChange={setWeek2Days} dayLabels={DAY_LABELS} />
                  <div className="pc-row">
                    <div className="pc-field pc-sunday-field">
                      <label htmlFor="h-sun-2">Week 2 Sunday hours count as</label>
                      <select id="h-sun-2" value={week2SundayType} onChange={(e) => setWeek2SundayType(e.target.value)}>
                        <option value="regular">Regular</option>
                        <option value="ot">Overtime (1.5x)</option>
                        <option value="double">Double time (2x)</option>
                      </select>
                    </div>
                    <div className="pc-field pc-sunday-field">
                      <label htmlFor="h-shift-2">Week 2 shift</label>
                      <select id="h-shift-2" value={week2Shift} onChange={(e) => setWeek2Shift(e.target.value)}>
                        <option value="day">Day</option>
                        <option value="mid">Mid</option>
                        <option value="night">Night</option>
                      </select>
                    </div>
                  </div>
                </>
              )}
              {!premiumsLoading && (
                <p className="pc-breakdown-note">
                  Mid/Night adds {fmtMoney(Number(shiftPremium) || 0)}/hr shift premium{isTeamLeader ? ", plus " + fmtMoney(Number(teamLeaderPremium) || 0) + "/hr Team Leader premium" : ""}. Edit these in the Pay Ladder tab.
                </p>
              )}
            </>
          ) : (
            <div className="pc-row">
              <div className="pc-field">
                <label htmlFor="h-total-reg">Regular hours</label>
                <input id="h-total-reg" type="number" min="0" step="0.25" value={totalRegHours} onChange={(e) => setTotalRegHours(e.target.value)} placeholder="80" />
              </div>
              <div className="pc-field">
                <label htmlFor="h-total-ot">OT hours (1.5x)</label>
                <input id="h-total-ot" type="number" min="0" step="0.25" value={totalOtHours} onChange={(e) => setTotalOtHours(e.target.value)} placeholder="0" />
              </div>
              <div className="pc-field">
                <label htmlFor="h-total-shift">Shift</label>
                <select id="h-total-shift" value={totalsShift} onChange={(e) => setTotalsShift(e.target.value)}>
                  <option value="day">Day</option>
                  <option value="mid">Mid</option>
                  <option value="night">Night</option>
                </select>
              </div>
            </div>
          )}

          <div className="pc-field">
            <label htmlFor="h-ded">Deduction rate (%)</label>
            <input id="h-ded" type="number" min="0" max="100" step="0.1" value={dedPctInput} onChange={(e) => setDedPctInput(e.target.value)} placeholder="25" />
          </div>
          {avgDedPct !== null && (
            <div className="pc-avg-note">
              Your average from uploaded stubs is {fmtPct(avgDedPct)}.{" "}
              <button onClick={() => setDedPctInput(avgDedPct.toFixed(1))}>Use it</button>
            </div>
          )}

          <div className="pc-divider" />
          <div className="pc-panel-subtitle">Per Diem <span>(non-taxed, added on top)</span></div>
          <div className="pc-row">
            <div className="pc-field">
              <label htmlFor="h-perdiem-rate">Per diem ($/day)</label>
              <input id="h-perdiem-rate" type="number" min="0" step="0.01" value={perDiemRate} onChange={(e) => setPerDiemRate(e.target.value)} placeholder="0" />
            </div>
            <div className="pc-field">
              <label htmlFor="h-perdiem-days">Days/week on per diem</label>
              <input id="h-perdiem-days" type="number" min="0" max="7" step="1" value={perDiemDays} onChange={(e) => setPerDiemDays(e.target.value)} placeholder="0" />
            </div>
          </div>

          <button className="pc-calc-btn" onClick={calculateHoursToPay}>Calculate</button>
          {hoursCalcError && <div className="pc-error">{hoursCalcError}</div>}

          {hoursCalc && (
            <div className="pc-results">
              <StampBadge value={fmtMoney(hoursCalc.net)} label="total take-home" tone="amber" spin />
              <div className="pc-result-list">
                <div className="pc-result-line"><span className="k">Regular hours</span><span className="v">{fmtHours(hoursCalc.regular)}</span></div>
                <div className="pc-result-line"><span className="k">OT hours (1.5x)</span><span className="v">{fmtHours(hoursCalc.ot)}</span></div>
                <div className="pc-result-line"><span className="k">Double time hours (2x)</span><span className="v">{fmtHours(hoursCalc.doubleTime)}</span></div>
                <div className="pc-result-line"><span className="k">Gross (taxable)</span><span className="v">{fmtMoney(hoursCalc.gross)}</span></div>
                <div className="pc-result-line"><span className="k">Est. deductions</span><span className="v">{fmtMoney(hoursCalc.gross - hoursCalc.taxableNet)}</span></div>
                <div className="pc-result-line"><span className="k">Net after tax</span><span className="v">{fmtMoney(hoursCalc.taxableNet)}</span></div>
                <div className="pc-result-line"><span className="k">Per diem (non-taxed)</span><span className="v">{fmtMoney(hoursCalc.perDiemTotal)}</span></div>
                <div className="pc-result-line net"><span className="k">Total take-home</span><span className="v">{fmtMoney(hoursCalc.net)}</span></div>
                <div className="pc-result-line"><span className="k">You keep</span><span className="v">{fmtPct(hoursCalc.keepPct)}</span></div>
              </div>
            </div>
          )}
          {hoursCalc && <p className="pc-calc-note">{hoursCalc.note}</p>}
        </div>
      )}

      {tab === "target" && (
        <div className="pc-panel">
          <h2 className="pc-panel-title">Target &rarr; Hours</h2>
          <p className="pc-panel-desc">Tell it what you want to net this check, and it works out how many hours that takes.</p>

          <div className="pc-field">
            <label htmlFor="t-period">Pay period</label>
            <select id="t-period" value={targetPeriod} onChange={(e) => setTargetPeriod(e.target.value)}>
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-Weekly (2 weeks)</option>
              <option value="monthly">Monthly (est.)</option>
            </select>
          </div>

          <div className="pc-row">
            <div className="pc-field">
              <label htmlFor="t-target">Target net pay ($)</label>
              <input id="t-target" type="number" min="0" step="1" value={targetNet} onChange={(e) => setTargetNet(e.target.value)} placeholder="3000" />
            </div>
            <div className="pc-field">
              <label htmlFor="t-rate">Hourly rate ($)</label>
              <input id="t-rate" type="number" min="0" step="0.01" value={targetRate} onChange={(e) => setTargetRate(e.target.value)} placeholder="41.41" />
            </div>
          </div>
          <div className="pc-field">
            <label htmlFor="t-shift">Shift</label>
            <select id="t-shift" value={targetShift} onChange={(e) => setTargetShift(e.target.value)}>
              <option value="day">Day</option>
              <option value="mid">Mid</option>
              <option value="night">Night</option>
            </select>
          </div>
          <div className="pc-field">
            <label htmlFor="t-ded">Deduction rate (%)</label>
            <input id="t-ded" type="number" min="0" max="100" step="0.1" value={dedPctInput} onChange={(e) => setDedPctInput(e.target.value)} placeholder="25" />
          </div>
          {avgDedPct !== null && (
            <div className="pc-avg-note">
              Your average from uploaded stubs is {fmtPct(avgDedPct)}.{" "}
              <button onClick={() => setDedPctInput(avgDedPct.toFixed(1))}>Use it</button>
            </div>
          )}
          <label className="pc-checkbox">
            <input type="checkbox" checked={assumeOT} onChange={(e) => setAssumeOT(e.target.checked)} />
            Assume time-and-a-half after {REGULAR_THRESHOLD[targetPeriod].toFixed(0)} regular hours
          </label>

          <div className="pc-daydays-field">
            <label htmlFor="t-days-per-week">Days worked per week</label>
            <input
              id="t-days-per-week"
              type="number"
              min="1"
              max="7"
              step="1"
              value={targetDaysPerWeek}
              onChange={(e) => setTargetDaysPerWeek(e.target.value)}
            />
          </div>

          {Number(targetDaysPerWeek) === 7 && (
            <label className="pc-checkbox">
              <input type="checkbox" checked={sundayDoubleTime} onChange={(e) => setSundayDoubleTime(e.target.checked)} />
              Sunday is double time (2x)
            </label>
          )}

          {targetCalc && (
            <div className="pc-results">
              <StampBadge value={fmtHours(targetCalc.hours)} label="hours needed" tone="green" />
              <div className="pc-result-list">
                <div className="pc-result-line"><span className="k">Gross needed</span><span className="v">{fmtMoney(targetCalc.grossNeeded)}</span></div>
                <div className="pc-result-line"><span className="k">Basis</span><span className="v">{targetCalc.note}</span></div>
                <div className="pc-result-line net"><span className="k">Hours needed</span><span className="v">{fmtHours(targetCalc.hours)}</span></div>
              </div>
            </div>
          )}

          {targetDailyBreakdown && targetDailyBreakdown.type === "grid" && (
            <>
              <StaticDayRow
                label={targetDailyBreakdown.weeks === 2 ? "Week 1 — hrs/day needed" : "Hrs/day needed"}
                hoursPerDay={targetDailyBreakdown.hoursPerDay}
                dayLabels={targetDailyBreakdown.dayLabels}
                flagDay={Number(targetDaysPerWeek) === 7 && sundayDoubleTime ? "Sun" : null}
                flagLabel="2x"
              />
              {targetDailyBreakdown.weeks === 2 && (
                <StaticDayRow
                  label="Week 2 — hrs/day needed"
                  hoursPerDay={targetDailyBreakdown.hoursPerDay}
                  dayLabels={targetDailyBreakdown.dayLabels}
                  flagDay={Number(targetDaysPerWeek) === 7 && sundayDoubleTime ? "Sun" : null}
                  flagLabel="2x"
                />
              )}
              <p className={"pc-breakdown-note" + (targetDailyBreakdown.hoursPerDay > 8 ? " warn" : "")}>
                {targetDailyBreakdown.hoursPerDay > 8
                  ? "Averages over 8 hrs/day — you'd likely hit daily OT before reaching the period total assumed above, so actual pay may come in higher than estimated."
                  : "Evenly split across " + targetDailyBreakdown.daysPerWeek + " work days/week."}
              </p>
            </>
          )}
          {targetDailyBreakdown && targetDailyBreakdown.type === "summary" && (
            <p className="pc-breakdown-note">
              &asymp; {targetDailyBreakdown.hoursPerDay.toFixed(2)} hrs/day across ~{targetDailyBreakdown.totalWorkDays.toFixed(1)} work days over the month ({targetDailyBreakdown.daysPerWeek}/week).
            </p>
          )}
        </div>
      )}

      {tab === "ladder" && (
        <div className="pc-panel">
          <h2 className="pc-panel-title">Pay Profile</h2>
          <p className="pc-panel-desc">
            Optional. Upload your own company's wage sheet and this fills in your rate steps, shift premium, and
            team leader premium automatically. No profile? Skip this whole tab — just type your hourly rate
            directly in Hours &rarr; Pay or Target &rarr; Hours and everything still works.
          </p>

          <label className="pc-upload-zone">
            <input ref={profileFileInputRef} type="file" accept="image/*,application/pdf" onChange={handleProfileFile} />
            <div className="pc-upload-label">
              {profileUploading ? "Reading pay profile…" : <><strong>Upload your pay profile</strong> — photo, screenshot, or PDF</>}
            </div>
          </label>
          {profileUploadError && <div className="pc-error">{profileUploadError}</div>}

          {pendingProfile && (
            <div className="pc-review">
              <div className="pc-review-head">
                <span className="pc-review-title">Check these before saving</span>
                <SourceTag source="local" />
              </div>
              <p className="pc-review-desc">
                Read straight out of the PDF in your browser &mdash; no upload, no API call. Rule-based reading is less
                reliable than the AI, so give these a look and fix anything that's off.
              </p>
              <div className="pc-review-grid">
                <div className="pc-field">
                  <label htmlFor="pending-track">Track label</label>
                  <input id="pending-track" type="text" value={pendingProfile.track_label} onChange={(e) => updatePendingProfile("track_label", e.target.value)} />
                </div>
                <div className="pc-field">
                  <label htmlFor="pending-eff">Effective date</label>
                  <input id="pending-eff" type="text" value={pendingProfile.effective_date} onChange={(e) => updatePendingProfile("effective_date", e.target.value)} />
                </div>
                <div className="pc-field">
                  <label htmlFor="pending-shift">Shift premium ($/hr)</label>
                  <input id="pending-shift" type="number" step="0.01" value={pendingProfile.shift_premium} onChange={(e) => updatePendingProfile("shift_premium", e.target.value)} />
                </div>
                <div className="pc-field">
                  <label htmlFor="pending-tl">Team leader premium ($/hr)</label>
                  <input id="pending-tl" type="number" step="0.01" value={pendingProfile.team_leader_premium} onChange={(e) => updatePendingProfile("team_leader_premium", e.target.value)} />
                </div>
              </div>
              <div className="pc-review-steps-title">Rate steps ({pendingProfile.steps.length})</div>
              <div className="pc-ladder-list">
                {pendingProfile.steps.map((s, i) => (
                  <div className="pc-ladder-row" key={i}>
                    <input className="pc-ladder-label" type="text" value={s.label} onChange={(e) => updatePendingProfileStep(i, "label", e.target.value)} />
                    <input className="pc-ladder-rate" type="number" min="0" step="0.01" value={s.rate} onChange={(e) => updatePendingProfileStep(i, "rate", e.target.value)} />
                    <button className="pc-ladder-remove" onClick={() => removePendingProfileStep(i)} aria-label={"Remove " + s.label}>&times;</button>
                  </div>
                ))}
              </div>
              <div className="pc-review-actions">
                <button className="pc-calc-btn" onClick={confirmPendingProfile}>Save this profile</button>
                {pendingProfileFile && (
                  <button className="pc-btn-link" onClick={() => readProfileFile(pendingProfileFile, true)} disabled={profileUploading}>
                    Read it with AI instead
                  </button>
                )}
                <button className="pc-btn-link" onClick={discardPendingProfile}>Discard</button>
              </div>
            </div>
          )}

          {profileUploadResult && (
            <p className="pc-breakdown-note">
              <SourceTag source={profileUploadResult.source} />{" "}
              Loaded{profileUploadResult.trackLabel ? " \u201c" + profileUploadResult.trackLabel + "\u201d" : ""}
              {profileUploadResult.effectiveDate ? " (effective " + profileUploadResult.effectiveDate + ")" : ""}
              {profileUploadResult.stepsCount ? " \u2014 " + profileUploadResult.stepsCount + " rate steps" : ""},
              shift premium {fmtMoney(Number(profileUploadResult.shiftPremium))}/hr, team leader premium {fmtMoney(Number(profileUploadResult.teamLeaderPremium))}/hr.
            </p>
          )}

          <div className="pc-divider" />

          <h2 className="pc-panel-title">Rate Ladder <SourceTag source={ladderSource} /></h2>
          <p className="pc-panel-desc">From your uploaded profile, or build/edit it by hand below. Mark where you are now to see what the next step is worth.</p>

          <div className="pc-scale-load">
            <span className="pc-scale-load-label">Or load the TMMTX grow-in scale as an example ({PAY_SCALE_EFFECTIVE}):</span>
            <div className="pc-scale-load-btns">
              <button className="pc-btn-link" onClick={() => loadScaleIntoLadder("skilled")}>Skilled Team Member</button>
              <button className="pc-btn-link" onClick={() => loadScaleIntoLadder("production")}>Production Team Member</button>
            </div>
          </div>

          <div className="pc-ladder-list">
            {ladderSteps.map((s) => (
              <div className={"pc-ladder-row" + (s.id === currentStepId ? " current" : "")} key={s.id}>
                <button
                  className="pc-ladder-mark"
                  onClick={() => persistLadder(ladderSteps, s.id)}
                  aria-label={"Mark " + s.label + " as current"}
                  title="Mark as current step"
                >
                  {s.id === currentStepId ? "\u25CF" : "\u25CB"}
                </button>
                <input
                  className="pc-ladder-label"
                  type="text"
                  value={s.label}
                  onChange={(e) => updateLadderStep(s.id, "label", e.target.value)}
                />
                <input
                  className="pc-ladder-rate"
                  type="number"
                  min="0"
                  step="0.01"
                  value={s.rate}
                  onChange={(e) => updateLadderStep(s.id, "rate", e.target.value)}
                  placeholder="0.00"
                />
                <button className="pc-ladder-remove" onClick={() => removeLadderStep(s.id)} aria-label={"Remove " + s.label}>&times;</button>
              </div>
            ))}
          </div>
          <button className="pc-btn-link" onClick={addLadderStep}>+ Add step</button>

          {ladderCurrent && (
            <div className="pc-results">
              <StampBadge
                value={ladderNext ? "+" + fmtMoney(ladderDiff) + "/hr" : "Top step"}
                label={ladderNext ? "next raise" : "reached"}
                tone="green"
              />
              <div className="pc-result-list">
                <div className="pc-result-line"><span className="k">Current</span><span className="v">{ladderCurrent.label} &mdash; {fmtMoney(Number(ladderCurrent.rate))}/hr</span></div>
                {ladderNext ? (
                  <>
                    <div className="pc-result-line"><span className="k">Next</span><span className="v">{ladderNext.label} &mdash; {fmtMoney(Number(ladderNext.rate))}/hr</span></div>
                    <div className="pc-result-line"><span className="k">Increase</span><span className="v">{fmtMoney(ladderDiff)}/hr ({fmtPct(ladderPct)})</span></div>
                    <div className="pc-result-line net"><span className="k">Est. net bump/check</span><span className="v">{fmtMoney(ladderNetBump)}</span></div>
                  </>
                ) : (
                  <div className="pc-result-line"><span className="k">Status</span><span className="v">Top of the ladder</span></div>
                )}
              </div>
            </div>
          )}
          {ladderNext && (
            <p className="pc-calc-note">Est. net bump assumes 80 regular hours/check at your current deduction rate ({fmtPct(dedPct)}).</p>
          )}
          {!ladderCurrent && !ladderLoading && (
            <p className="pc-calc-note">Tap the circle next to a step to mark where you are now.</p>
          )}

          <div className="pc-divider" />

          <h2 className="pc-panel-title">Premiums</h2>
          <p className="pc-panel-desc">Applied automatically in Hours &rarr; Pay and Target &rarr; Hours when you pick a Mid/Night shift or turn on Team Leader.</p>

          <div className="pc-row">
            <div className="pc-field">
              <label htmlFor="p-shift">Shift premium ($/hr)</label>
              <input
                id="p-shift"
                type="number"
                min="0"
                step="0.01"
                value={shiftPremium}
                onChange={(e) => persistPremiums(e.target.value, teamLeaderPremium, isTeamLeader)}
              />
            </div>
            <div className="pc-field">
              <label htmlFor="p-tl">Team Leader premium ($/hr)</label>
              <input
                id="p-tl"
                type="number"
                min="0"
                step="0.01"
                value={teamLeaderPremium}
                onChange={(e) => persistPremiums(shiftPremium, e.target.value, isTeamLeader)}
              />
            </div>
          </div>
          <label className="pc-checkbox">
            <input
              type="checkbox"
              checked={isTeamLeader}
              onChange={(e) => persistPremiums(shiftPremium, teamLeaderPremium, e.target.checked)}
            />
            I'm a Team Leader
          </label>

          <div className="pc-divider" />

          <h2 className="pc-panel-title">TMMTX Wage Reference (example)</h2>
          <p className="pc-panel-desc">Effective {PAY_SCALE_EFFECTIVE}. Just a built-in example dataset — your own uploaded or manually-entered profile above is what actually gets used.</p>
          {Object.entries(PAY_SCALE).map(([key, track]) => (
            <div className="pc-scale-table" key={key}>
              <div className="pc-scale-table-title">{track.label}</div>
              <div className="pc-scale-table-row pc-scale-table-head">
                {track.steps.map((s) => (
                  <span key={s.key}>{s.label}</span>
                ))}
              </div>
              <div className="pc-scale-table-row">
                {track.steps.map((s) => (
                  <span key={s.key}>{fmtMoney(s.rate)}</span>
                ))}
              </div>
              <div className="pc-scale-table-premiums">
                Shift: {fmtMoney(track.shiftPremium)}/hr &nbsp;&middot;&nbsp; Team Leader: {fmtMoney(track.teamLeaderPremium)}/hr
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "invest" && (
        <div className="pc-panel">
          <h2 className="pc-panel-title">Investments</h2>
          <p className="pc-panel-desc">
            Track your accounts by hand &mdash; no bank or brokerage connection, just what you tell it. Live
            prices are looked up via web search, no signup or key needed &mdash; or leave prices manual and
            update them yourself.
          </p>

          <p className="pc-breakdown-note">
            Live prices only work for public ticker symbols (VOO, SCHD, QQQM, etc). Many 401k plans use
            institutional trust funds with names like &ldquo;VG INST 500 IDX TR&rdquo; instead of a tradeable
            ticker &mdash; those aren't on any public exchange, so no price lookup can find them. Put a short
            code in the ticker field (even a made-up one) and just fill in the manual price yourself for those.
          </p>
          <button className="pc-btn-link" onClick={refreshLivePrices} disabled={pricesRefreshing}>
            {pricesRefreshing ? "Refreshing…" : "Refresh live prices"}
          </button>
          {pricesError && <div className="pc-error">{pricesError}</div>}

          <div className="pc-divider" />

          {investAccounts.map((account) => (
            <div className="pc-invest-account" key={account.id}>
              <div className="pc-invest-account-head">
                <input
                  className="pc-invest-account-name"
                  type="text"
                  value={account.name}
                  onChange={(e) => renameInvestAccount(account.id, e.target.value)}
                />
                <span className="pc-invest-account-value">{fmtMoney(accountValue(account))}</span>
                <button className="pc-ladder-remove" onClick={() => removeInvestAccount(account.id)} aria-label={"Remove " + account.name}>&times;</button>
              </div>

              {account.kind === "cash" ? (
                <div className="pc-field pc-invest-cash-field">
                  <label htmlFor={"cash-" + account.id}>Balance ($)</label>
                  <input
                    id={"cash-" + account.id}
                    type="number"
                    min="0"
                    step="0.01"
                    value={account.balance}
                    onChange={(e) => updateCashBalance(account.id, e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              ) : (
                <>
                  {account.holdings.map((h) => {
                    const t = (h.ticker || "").trim().toUpperCase();
                    const isLive = t && livePrices[t] && livePrices[t].price;
                    const price = getPrice(h.ticker, h.manualPrice);
                    const value = (Number(h.shares) || 0) * price;
                    return (
                      <div className="pc-holding-row" key={h.id}>
                        <input
                          className="pc-holding-ticker"
                          type="text"
                          value={h.ticker}
                          onChange={(e) => updateHolding(account.id, h.id, "ticker", e.target.value.toUpperCase())}
                          placeholder="VOO"
                        />
                        <input
                          className="pc-holding-shares"
                          type="number"
                          min="0"
                          step="0.0001"
                          value={h.shares}
                          onChange={(e) => updateHolding(account.id, h.id, "shares", e.target.value)}
                          placeholder="shares"
                        />
                        <input
                          className={"pc-holding-price" + (isLive ? " live" : "")}
                          type="number"
                          min="0"
                          step="0.01"
                          value={isLive ? price : h.manualPrice}
                          onChange={(e) => updateHolding(account.id, h.id, "manualPrice", e.target.value)}
                          placeholder="price"
                          disabled={isLive}
                          title={isLive ? "Live price (web search)" : "Manual price"}
                        />
                        <span className="pc-holding-value">{fmtMoney(value)}</span>
                        <button className="pc-ladder-remove" onClick={() => removeHolding(account.id, h.id)} aria-label="Remove holding">&times;</button>
                      </div>
                    );
                  })}
                  <button className="pc-btn-link" onClick={() => addHolding(account.id)}>+ Add holding</button>
                </>
              )}
            </div>
          ))}
          <button className="pc-btn-link" onClick={addInvestAccount}>+ Add account</button>

          <div className="pc-divider" />

          <div className="pc-results">
            <StampBadge value={fmtMoney(investTotal)} label="total portfolio" tone="green" />
            <div className="pc-result-list">
              {investAllocation.map((row) => (
                <div className="pc-result-line" key={row.ticker}>
                  <span className="k">{row.ticker}</span>
                  <span className="v">{fmtMoney(row.value)} ({fmtPct(row.pct)})</span>
                </div>
              ))}
            </div>
          </div>

          <div className="pc-divider" />

          <h2 className="pc-panel-title">Growth Calculator</h2>
          <p className="pc-panel-desc">Project a future value from a starting amount, monthly contributions, and an assumed annual return.</p>

          <div className="pc-row">
            <div className="pc-field">
              <label htmlFor="c-start">Starting amount ($)</label>
              <input id="c-start" type="number" min="0" step="1" value={calcStart} onChange={(e) => setCalcStart(e.target.value)} placeholder="0" />
            </div>
            <div className="pc-field">
              <label htmlFor="c-monthly">Monthly contribution ($)</label>
              <input id="c-monthly" type="number" min="0" step="1" value={calcMonthly} onChange={(e) => setCalcMonthly(e.target.value)} placeholder="0" />
            </div>
          </div>
          {investTotal > 0 && (
            <button type="button" className="pc-apply-both" onClick={() => setCalcStart(investTotal.toFixed(2))}>
              Use my total portfolio ({fmtMoney(investTotal)})
            </button>
          )}
          <div className="pc-row">
            <div className="pc-field">
              <label htmlFor="c-rate">Annual return (%)</label>
              <input id="c-rate" type="number" step="0.1" value={calcRatePct} onChange={(e) => setCalcRatePct(e.target.value)} placeholder="7" />
            </div>
            <div className="pc-field">
              <label htmlFor="c-years">Years</label>
              <input id="c-years" type="number" min="1" step="1" value={calcYears} onChange={(e) => setCalcYears(e.target.value)} placeholder="10" />
            </div>
          </div>

          <button className="pc-calc-btn" onClick={calculateGrowth}>Calculate</button>
          {calcError && <div className="pc-error">{calcError}</div>}

          {calcResult && (
            <div className="pc-results">
              <StampBadge value={fmtMoney(calcResult.fv)} label={calcResult.years + " yr projection"} tone="amber" spin />
              <div className="pc-result-list">
                <div className="pc-result-line"><span className="k">Total contributed</span><span className="v">{fmtMoney(calcResult.totalContributed)}</span></div>
                <div className="pc-result-line net"><span className="k">Total growth</span><span className="v">{fmtMoney(calcResult.totalGrowth)}</span></div>
                <div className="pc-result-line"><span className="k">Assumed return</span><span className="v">{fmtPct(calcResult.ratePct)}/yr</span></div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "market" && (
        <div className="pc-panel">
          <h2 className="pc-panel-title">Market Report</h2>
          <p className="pc-panel-desc">
            On-demand, not automatic &mdash; tap Generate whenever you want a fresh read on stocks, housing, and
            commodities/gold. Pulled live via web search each time you click.
          </p>

          <button className="pc-calc-btn" onClick={generateMarketReport} disabled={marketGenerating}>
            {marketGenerating ? "Generating…" : "Generate Today's Report"}
          </button>
          {marketError && <div className="pc-error">{marketError}</div>}

          {viewingReport && (
            <div className="pc-market-report">
              <div className="pc-market-report-meta">
                Generated {new Date(viewingReport.generatedAt).toLocaleString()}
                {viewingReport.asOf ? " \u2014 as of " + viewingReport.asOf : ""}
              </div>

              {viewingReport.stockMarket && (
                <>
                  <div className="pc-panel-subtitle">Stock Market</div>
                  <p className="pc-market-report-text">{viewingReport.stockMarket}</p>
                </>
              )}

              {viewingReport.stocksToWatch && viewingReport.stocksToWatch.length > 0 && (
                <>
                  <div className="pc-panel-subtitle">Stocks to Watch</div>
                  <div className="pc-result-list">
                    {viewingReport.stocksToWatch.map((s, i) => (
                      <div className="pc-result-line" key={i}>
                        <span className="k">{s.ticker}</span>
                        <span className="v" style={{ textAlign: "right", maxWidth: "70%" }}>{s.note}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {viewingReport.housingMarket && (
                <>
                  <div className="pc-panel-subtitle">Housing Market</div>
                  <p className="pc-market-report-text">{viewingReport.housingMarket}</p>
                </>
              )}

              {viewingReport.commodities && (
                <>
                  <div className="pc-panel-subtitle">Gold &amp; Commodities</div>
                  <p className="pc-market-report-text">{viewingReport.commodities}</p>
                </>
              )}
            </div>
          )}

          {!marketLoading && marketReports.length > 0 && (
            <div className="pc-history">
              <div className="pc-history-title">Past Reports ({marketReports.length})</div>
              <div className="pc-chip-row">
                {marketReports.map((r) => (
                  <div className={"pc-chip" + (r.id === viewingReportId ? " active-chip" : "")} key={r.id}>
                    <button className="pc-chip-select" onClick={() => setViewingReportId(r.id)}>
                      {new Date(r.generatedAt).toLocaleDateString()}
                    </button>
                    <button className="remove" onClick={() => removeMarketReport(r.id)} aria-label="Remove this report">&times;</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!marketLoading && marketReports.length === 0 && !viewingReport && (
            <p className="pc-calc-note">No reports yet &mdash; generate one above.</p>
          )}
        </div>
      )}
    </div>
  );
}
