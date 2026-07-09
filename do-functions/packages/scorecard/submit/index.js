// scorecard/submit — accepts a completed quiz, stores the report row in the
// Google Sheet ("scorecard" tab), pushes the lead to Kartra (when credentials
// are configured), and returns the unique report id for the shareable URL.
//
// Storage reuses the same service account + spreadsheet as the pL-chatbot
// conversation log (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON_B64).

'use strict';
const crypto = require('crypto');
const { STATEMENTS } = require('./statements');

const SHEET_TAB = 'scorecard';
const PRINCIPLE_ORDER = [
  'Standardization',
  'People Involvement',
  'Short Lead Time',
  'Built-In Quality',
  'Continuous Improvement'
];

// ─── AI-generated category text (Good / Opportunity) ─────────────────────────
// Runs once per submission, off the plant's actual per-statement answers, so
// the report's Good/Opportunity boxes reflect which specific statements
// scored well vs. poorly instead of one fixed paragraph per category. Non-
// fatal on any failure — the frontend falls back to its static category
// copy if categoryText comes back empty.

const ANTHROPIC_MODEL = 'claude-opus-4-8';
const ANTHROPIC_CALL_TIMEOUT_MS = 20000;

function statementStatus(maturity) {
  if (maturity >= 8) return 'green';
  if (maturity >= 5) return 'yellow';
  return 'red';
}

function buildCategoryPrompt(answers) {
  const byPrinciple = {};
  PRINCIPLE_ORDER.forEach(name => { byPrinciple[name] = []; });

  answers.forEach(a => {
    const stmt = STATEMENTS[a.si];
    if (!stmt) return;
    byPrinciple[stmt.principle].push({ stmt, status: statementStatus(Number(a.m)) });
  });

  return PRINCIPLE_ORDER.map(name => {
    const lines = byPrinciple[name].map(({ stmt, status }) => {
      if (status === 'red') {
        return `- [RED] "${stmt.text}"\n  Why it matters: ${stmt.why}\n  First step if this is the gap: ${stmt.weakness}`;
      }
      return `- [${status.toUpperCase()}] "${stmt.text}"\n  Payoff if this is a strength: ${stmt.strength}`;
    }).join('\n');
    return `## ${name}\n${lines || '(no answers recorded for this category)'}`;
  }).join('\n\n');
}

async function generateCategoryText(answers) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !Array.isArray(answers) || !answers.length) return {};

  const system = `You write the "Good" and "Opportunity" sections of a lean-manufacturing plant assessment report, for a plant manager reading their own results.

For each of the 5 categories provided, using ONLY the statement content given for that category, write:
- "good": 2-3 sentences on the concrete benefits the plant is realizing, based only on statements marked GREEN or YELLOW. If there are none, use "".
- "opportunity": 2-3 sentences naming the specific gap(s) from statements marked RED, the concrete cost of leaving them, ending with ONE clear first action. Base this only on RED statements. If there are none, write one short sentence encouraging them to keep pushing toward full consistency — do not invent a gap.

Tone: direct, concrete, specific to what was actually answered — never generic filler. Match this style exactly:
Good example: "Standard work, 5S discipline, and a dashboard your team actually reviews mean your improvements have something to hold onto — this is the foundation most plants skip, and you haven't."
Opportunity example: "Without a documented, followed standard, nothing else in your plant has anywhere to attach — quality checks, problem-solving, and daily dashboards all depend on a stable baseline that isn't there yet. Start with one pilot station: document what your best operator actually does, post it, and hold the team to it for two weeks."

Return ONLY valid JSON, no markdown fences, no commentary, exactly this shape with all 5 category names as keys:
{"Standardization":{"good":"...","opportunity":"..."},"People Involvement":{"good":"...","opportunity":"..."},"Short Lead Time":{"good":"...","opportunity":"..."},"Built-In Quality":{"good":"...","opportunity":"..."},"Continuous Improvement":{"good":"...","opportunity":"..."}}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ANTHROPIC_CALL_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1500,
        system,
        messages: [{ role: 'user', content: buildCategoryPrompt(answers) }]
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic error: ${JSON.stringify(data).slice(0, 200)}`);
  const text = (data.content || []).map(b => b.text || '').join('');
  const parsed = JSON.parse(text);

  const out = {};
  PRINCIPLE_ORDER.forEach(name => {
    if (parsed[name]) out[name] = { good: String(parsed[name].good || ''), opportunity: String(parsed[name].opportunity || '') };
  });
  return out;
}

// ─── Google Sheets (JWT + append) ────────────────────────────────────────────

function base64url(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(serviceAccountJson) {
  const { client_email, private_key } = serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })));
  const signingInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const jwt = `${signingInput}.${base64url(sign.sign(private_key))}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`No access token: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function appendRow(sheetId, accessToken, row) {
  // RAW: values are stored literally — a first name starting with "=" must
  // never be interpreted as a spreadsheet formula.
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${SHEET_TAB}%21A1:append?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets append error: ${JSON.stringify(data)}`);
}

// ─── Email verification (ZeroBounce) ─────────────────────────────────────────
// Runs before the Kartra push only — never blocks or delays the visitor's
// results, which render from the submitted answers before this even starts.
// Goal: only real, deliverable addresses ever reach Kartra. "catch-all" and
// "unknown" (e.g. a verification timeout) are let through on purpose — both
// are common for legitimate corporate mail servers, and blocking them would
// silently drop real plant-manager leads. Only confirmed-bad statuses skip
// the Kartra push. If ZeroBounce itself errors (bad key, out of credits,
// network), we fail OPEN (still push to Kartra) so an infra hiccup on our
// side never costs Jim a real lead — the error is recorded either way.
const ZB_BLOCK_STATUSES = ['invalid', 'spamtrap', 'abuse', 'do_not_mail'];

async function verifyEmail(email) {
  const key = process.env.ZEROBOUNCE_API_KEY;
  if (!key || key === 'unset') return { status: 'skipped-no-key', good: true };

  const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(key)}&email=${encodeURIComponent(email)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) return { status: `zb-error: ${String(data.error).slice(0, 80)}`, good: true };

  const status = String(data.status || 'unknown');
  return { status, good: !ZB_BLOCK_STATUSES.includes(status) };
}

// ─── Kartra lead push ─────────────────────────────────────────────────────────
// Form-encoded POST to https://app.kartra.com/api, PHP-style bracket encoding:
//   lead[email]=...&actions[0][cmd]=create_lead&actions[1][cmd]=assign_tag...
// Tags must already exist in the Kartra account. Failures are non-fatal — the
// visitor still gets their report; the Kartra status is recorded in the sheet.

function phpEncode(params, prefix, out) {
  for (const [key, val] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (val !== null && typeof val === 'object') phpEncode(val, name, out);
    else out.append(name, String(val));
  }
  return out;
}

async function kartraCall(params) {
  const res = await fetch('https://app.kartra.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: phpEncode(params, '', new URLSearchParams())
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) {
    return { status: 'Unparseable', message: text.slice(0, 120) };
  }
}

async function pushToKartra({ firstName, email, phase }) {
  const { KARTRA_API_KEY, KARTRA_API_PASSWORD, KARTRA_APP_ID } = process.env;
  const missing = v => !v || v === 'unset';
  if (missing(KARTRA_API_KEY) || missing(KARTRA_API_PASSWORD) || missing(KARTRA_APP_ID)) {
    return 'kartra-skipped-no-creds';
  }

  const auth = { api_key: KARTRA_API_KEY, api_password: KARTRA_API_PASSWORD, app_id: KARTRA_APP_ID };
  // Kartra's WAF rejects names containing markup; strip anything suspicious
  // for the Kartra copy only (the sheet keeps the original).
  const safeName = firstName.replace(/[<>={}\[\]\\]/g, '').trim().slice(0, 60) || 'Visitor';

  // Two separate calls because create_lead ERRORS on an existing contact and
  // kills every action bundled with it — repeat visitors would lose their
  // tags. Tags are assigned in their own call, which works for new and
  // existing leads alike.
  const created = await kartraCall({
    ...auth,
    lead: { email, first_name: safeName },
    actions: [{ cmd: 'create_lead' }]
  });
  const createStatus = created.status === 'Success' ? 'created' : 'existing';

  // Minimal tag set (Jim's call): "scorecard" identifies the lead source,
  // phase number tag (phase1–phase4) drives segmented follow-up. The pattern
  // is stored in the sheet if pattern-level segmentation is ever wanted.
  const phaseNum = { 'Formative': 1, 'Localized': 2, 'Broad-based': 3, 'Benchmark': 4 }[phase];
  const tagged = await kartraCall({
    ...auth,
    lead: { email },
    actions: [
      { cmd: 'assign_tag', tag_name: 'scorecard' },
      { cmd: 'assign_tag', tag_name: `phase${phaseNum}` }
    ]
  });

  if (tagged.status !== 'Success') {
    return `kartra-tag-failed(${createStatus}): ${String(tagged.message || tagged.status).slice(0, 100)}`;
  }
  return `kartra-Success(${createStatus})`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(event) {
  const errors = [];
  const firstName = String(event.firstName || '').trim().slice(0, 60);
  const email = String(event.email || '').trim().slice(0, 120);
  if (!firstName) errors.push('firstName required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('valid email required');

  // Roadmap scores are stored on Jim's raw 0–4 scale (avg of per-statement
  // values 0/2.25/3.25/4) — no curve conversion. Upper bound 4.5 tolerated
  // for rows written under the old 1–4.5 curve scale.
  const score = Number(event.score);
  if (!(score >= 0 && score <= 4.5)) errors.push('score out of range');
  const phase = String(event.phase || '');
  if (!['Formative', 'Localized', 'Broad-based', 'Benchmark'].includes(phase)) errors.push('bad phase');

  const principles = event.principles;
  if (!Array.isArray(principles) || principles.length !== PRINCIPLE_ORDER.length ||
      !PRINCIPLE_ORDER.every((name, i) => principles[i] && principles[i].name === name &&
        Number(principles[i].score) >= 0 && Number(principles[i].score) <= 4.5)) {
    errors.push('bad principles');
  }

  const maturity = Number(event.maturity);
  if (!(maturity >= 0 && maturity <= 100)) errors.push('maturity out of range');
  const principleMaturity = event.principleMaturity;
  if (!Array.isArray(principleMaturity) || principleMaturity.length !== PRINCIPLE_ORDER.length ||
      !PRINCIPLE_ORDER.every((name, i) => principleMaturity[i] && principleMaturity[i].name === name &&
        Number(principleMaturity[i].maturity) >= 0 && Number(principleMaturity[i].maturity) <= 100)) {
    errors.push('bad principleMaturity');
  }

  const pattern = String(event.pattern || '').slice(0, 40);

  return { errors, firstName, email, score, phase, principles, maturity, principleMaturity, pattern };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
}

async function main(event) {
  const method = (event.__ow_method || '').toLowerCase();
  if (method === 'options') return { statusCode: 200, headers: corsHeaders() };

  // Honeypot: bots that fill the hidden "website" field get a fake success.
  if (event.website) {
    return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id: 'rpa-' + crypto.randomBytes(4).toString('hex').toUpperCase() } };
  }

  const v = validate(event);
  if (v.errors.length) {
    return { statusCode: 400, headers: corsHeaders(), body: { ok: false, errors: v.errors } };
  }

  const id = 'rpa-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  let emailCheck = { status: 'not-run', good: true };
  try {
    emailCheck = await verifyEmail(v.email);
  } catch (err) {
    console.error('Email verification failed (non-fatal, failing open):', err.message);
    emailCheck = { status: 'zb-error: ' + err.message.slice(0, 80), good: true };
  }

  let kartraStatus;
  if (emailCheck.good) {
    try {
      kartraStatus = await pushToKartra(v);
    } catch (err) {
      console.error('Kartra push failed (non-fatal):', err.message);
      kartraStatus = 'kartra-error: ' + err.message.slice(0, 120);
    }
  } else {
    kartraStatus = `kartra-skipped-bad-email(${emailCheck.status})`;
  }
  kartraStatus += ` | zb:${emailCheck.status}`;

  let categoryText = {};
  try {
    categoryText = await generateCategoryText(event.answers);
  } catch (err) {
    console.error('Category text generation failed (non-fatal, frontend falls back to static copy):', err.message);
  }

  try {
    const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'));
    const token = await getAccessToken(sa);
    await appendRow(process.env.GOOGLE_SHEET_ID, token, [
      id,
      new Date().toISOString(),
      v.firstName,
      v.email,
      v.score,
      v.phase,
      ...v.principles.map(p => Number(p.score)),
      v.pattern,
      JSON.stringify(event.answers || []),
      kartraStatus,
      v.maturity,
      ...v.principleMaturity.map(p => Number(p.maturity)),
      JSON.stringify(categoryText)
    ]);
  } catch (err) {
    console.error('Sheet write failed:', err.message);
    return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'storage-failed' } };
  }

  return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id } };
}

exports.main = main;
