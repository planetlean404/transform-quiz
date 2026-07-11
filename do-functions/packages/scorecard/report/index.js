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
// G–K principle scores (order above) | L pattern | M answers JSON | N kartra |
// O maturity | P–T principle maturity scores (order above) |
// U categoryText JSON (AI-generated per-category Good/Opportunity text) |
// V plan JSON (AI-generated 4-week 30-day plan)

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
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/${SHEET_TAB}%21A:AA`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(data));

    const row = (data.values || []).find(r => (r[0] || '').toLowerCase() === id.toLowerCase());
    if (!row) {
      return { statusCode: 404, headers: corsHeaders(), body: { ok: false, error: 'not-found' } };
    }

    // Industry-average comparison record — one "Industry Averages" sheet, one
    // row per sector: [industry, standardization, people, short_lead_time,
    // built_in_quality, continuous_improvement, overall]. Read LIVE so manual
    // updates show immediately. Optional: blank industry or no match -> null.
    const industry = row[23] || '';
    let industryAverage = null;
    if (industry) {
      try {
        const avgUrl = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/${encodeURIComponent('Industry Averages!A2:G100')}`;
        const avgRes = await fetch(avgUrl, { headers: { 'Authorization': `Bearer ${token}` } });
        const avgRows = ((await avgRes.json()).values) || [];
        const match = avgRows.find(r => (r[0] || '').trim() === industry.trim());
        if (match && match.length >= 7) industryAverage = match.slice(1, 7).map(v => Number(v));
      } catch (e) { /* no comparison available */ }
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
        industry,
        industryAverage,
        principles: PRINCIPLE_ORDER.map((name, i) => ({ name, score: Number(row[6 + i]) })),
        pattern: row[11] || '',
        // O–T (maturity + per-principle maturity) are absent on rows written
        // before the dual-scoring model shipped — fall back to 0 so old
        // report links still render instead of showing NaN.
        maturity: row[14] != null && row[14] !== '' ? Number(row[14]) : 0,
        principleMaturity: PRINCIPLE_ORDER.map((name, i) => ({
          name,
          maturity: row[15 + i] != null && row[15 + i] !== '' ? Number(row[15 + i]) : 0
        })),
        // M holds the per-statement answers [{m,r,si}] — needed for the
        // Insights statement-level drill-down. Older rows may predate the si
        // field; the frontend simply skips any answer it can't map.
        answers: (() => {
          try { return row[12] ? JSON.parse(row[12]) : []; }
          catch (e) { return []; }
        })(),
        // U is absent on rows written before AI category text shipped — the
        // frontend falls back to its static copy when this comes back {}.
        categoryText: (() => {
          try { return row[20] ? JSON.parse(row[20]) : {}; }
          catch (e) { return {}; }
        })(),
        // V (AI 30-day plan) is absent on older rows — frontend falls back to
        // its static buildPlan() when this comes back [].
        plan: (() => {
          try { return row[21] ? JSON.parse(row[21]) : []; }
          catch (e) { return []; }
        })(),
        // AA (AI 6-month plan) is absent on older rows — the frontend falls
        // back to its static buildSixMonth() when this comes back {}.
        plan6: (() => {
          try { return row[26] ? JSON.parse(row[26]) : {}; }
          catch (e) { return {}; }
        })()
      }
    };
  } catch (err) {
    console.error('Report fetch failed:', err.message);
    return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'fetch-failed' } };
  }
}

exports.main = main;
