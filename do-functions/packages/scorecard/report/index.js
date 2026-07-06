// scorecard/report — returns a stored scorecard report by id for the
// shareable /r/pl-XXXX URLs. Reads the "scorecard" tab of the same Google
// Sheet the submit function writes to. Never returns the visitor's email —
// report links are forwardable, so the payload stays harmless.

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

// Column layout written by scorecard/submit:
// A id | B timestamp | C firstName | D email | E score | F phase |
// G–K principle scores (order above) | L pattern | M answers JSON | N kartra

function base64url(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getAccessToken(serviceAccountJson) {
  const { client_email, private_key } = serviceAccountJson;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type'
  };
}

async function main(event) {
  const method = (event.__ow_method || '').toLowerCase();
  if (method === 'options') return { statusCode: 200, headers: corsHeaders() };

  const id = String(event.id || '').trim();
  // rpa- is the current Rapid Plant Assessment prefix; pl- kept for reports
  // stored before the rebrand so old links keep working.
  if (!/^(?:rpa|pl)-[A-F0-9]{8}$/i.test(id)) {
    return { statusCode: 400, headers: corsHeaders(), body: { ok: false, error: 'bad-id' } };
  }

  try {
    const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'));
    const token = await getAccessToken(sa);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/${SHEET_TAB}%21A:L`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    const row = (data.values || []).find(r => (r[0] || '').toLowerCase() === id.toLowerCase());
    if (!row) {
      return { statusCode: 404, headers: corsHeaders(), body: { ok: false, error: 'not-found' } };
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: {
        ok: true,
        id: row[0],
        date: row[1],
        firstName: row[2],
        // row[3] is the email — deliberately never returned
        score: Number(row[4]),
        phase: row[5],
        principles: PRINCIPLE_ORDER.map((name, i) => ({ name, score: Number(row[6 + i]) })),
        pattern: row[11] || ''
      }
    };
  } catch (err) {
    console.error('Report fetch failed:', err.message);
    return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'fetch-failed' } };
  }
}

exports.main = main;
