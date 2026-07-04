// scorecard/submit — accepts a completed quiz, stores the report row in the
// Google Sheet ("scorecard" tab), pushes the lead to Kartra (when credentials
// are configured), and returns the unique report id for the shareable URL.
//
// Storage reuses the same service account + spreadsheet as the pL-chatbot
// conversation log (GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON_B64).

'use strict';
const crypto = require('crypto');

const SHEET_TAB = 'scorecard';
const PRINCIPLE_ORDER = [
  'Standardization',
  'People Involvement',
  'Short Lead Time',
  'Built-In Quality',
  'Continuous Improvement'
];

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
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${SHEET_TAB}%21A1:append?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets append error: ${JSON.stringify(data)}`);
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

async function pushToKartra({ firstName, email, phase, pattern }) {
  const { KARTRA_API_KEY, KARTRA_API_PASSWORD, KARTRA_APP_ID } = process.env;
  const missing = v => !v || v === 'unset';
  if (missing(KARTRA_API_KEY) || missing(KARTRA_API_PASSWORD) || missing(KARTRA_APP_ID)) {
    return 'kartra-skipped-no-creds';
  }

  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const body = phpEncode({
    api_key: KARTRA_API_KEY,
    api_password: KARTRA_API_PASSWORD,
    app_id: KARTRA_APP_ID,
    lead: { email, first_name: firstName },
    actions: [
      { cmd: 'create_lead' },
      { cmd: 'assign_tag', tag_name: 'scorecard' },
      { cmd: 'assign_tag', tag_name: `phase-${slug(phase)}` },
      { cmd: 'assign_tag', tag_name: `pattern-${slug(pattern)}` }
    ]
  }, '', new URLSearchParams());

  const res = await fetch('https://app.kartra.com/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const text = await res.text();
  let status;
  try { status = JSON.parse(text).status; } catch (e) { status = `unparseable: ${text.slice(0, 120)}`; }
  return `kartra-${status}`;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate(event) {
  const errors = [];
  const firstName = String(event.firstName || '').trim().slice(0, 60);
  const email = String(event.email || '').trim().slice(0, 120);
  if (!firstName) errors.push('firstName required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('valid email required');

  const score = Number(event.score);
  if (!(score >= 1 && score <= 4.5)) errors.push('score out of range');
  const phase = String(event.phase || '');
  if (!['Formative', 'Localized', 'Broad-based', 'Benchmark'].includes(phase)) errors.push('bad phase');

  const principles = event.principles;
  if (!Array.isArray(principles) || principles.length !== PRINCIPLE_ORDER.length ||
      !PRINCIPLE_ORDER.every((name, i) => principles[i] && principles[i].name === name &&
        Number(principles[i].score) >= 1 && Number(principles[i].score) <= 4.5)) {
    errors.push('bad principles');
  }
  const pattern = String(event.pattern || '').slice(0, 40);

  return { errors, firstName, email, score, phase, principles, pattern };
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
    return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id: 'pl-' + crypto.randomBytes(4).toString('hex').toUpperCase() } };
  }

  const v = validate(event);
  if (v.errors.length) {
    return { statusCode: 400, headers: corsHeaders(), body: { ok: false, errors: v.errors } };
  }

  const id = 'pl-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  let kartraStatus = 'kartra-error';
  try {
    kartraStatus = await pushToKartra(v);
  } catch (err) {
    console.error('Kartra push failed (non-fatal):', err.message);
    kartraStatus = 'kartra-error: ' + err.message.slice(0, 120);
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
      kartraStatus
    ]);
  } catch (err) {
    console.error('Sheet write failed:', err.message);
    return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'storage-failed' } };
  }

  return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id } };
}

exports.main = main;
