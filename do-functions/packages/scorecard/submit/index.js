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
const ANTHROPIC_CALL_TIMEOUT_MS = 35000;

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
      // Yellow AND red statements both feed the Opportunity section — red is
      // missing, yellow is happening but not yet consistent plant-wide. Only
      // green (fully in place) feeds Good. The improvement steps in
      // stmt.weakness are deliberately NOT sent — the category text names the
      // gap/cost only; action steps live in the 30-day plan and Deep Insights.
      if (status === 'red') {
        return `- [RED] "${stmt.text}"\n  What's missing / what it costs: ${stmt.why}`;
      }
      if (status === 'yellow') {
        return `- [YELLOW] "${stmt.text}"\n  Happening but not yet consistent across the plant / why fuller, standardized coverage matters: ${stmt.why}`;
      }
      return `- [GREEN] "${stmt.text}"\n  Payoff being realized: ${stmt.strength}`;
    }).join('\n');
    return `## ${name}\n${lines || '(no answers recorded for this category)'}`;
  }).join('\n\n');
}

// Shared Anthropic call — posts one message, returns the parsed JSON from the
// model's text (throws on HTTP error, timeout, or unparseable JSON). Callers
// wrap it in try/catch so any failure is non-fatal.
async function callAnthropicJSON(system, userContent, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('no-api-key');

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
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userContent }]
      }),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic error: ${JSON.stringify(data).slice(0, 200)}`);
  const text = (data.content || []).map(b => b.text || '').join('');
  return JSON.parse(text);
}

// Build a one-line plant context string from the optional dropdowns. Empty
// when nothing usable was provided (so the AI writes stay fully generic).
function plantContext(v) {
  const parts = [];
  if (v.industry && v.industry !== 'Other') parts.push(`sector: ${v.industry}`);
  if (v.plantSize) parts.push(`plant size: ${v.plantSize}`);
  if (v.role && v.role !== 'Other') parts.push(`reader's role: ${v.role}`);
  return parts.join('; ');
}

// LIGHT sector flavor only — sector-appropriate examples/vocabulary and tone,
// never invented facts and never a change to substance or scoring.
function flavorInstruction(ctx) {
  return ctx
    ? `\n\nPLANT CONTEXT (light flavor only): ${ctx}. Where it reads naturally, choose sector-appropriate examples and vocabulary and pitch the tone to this reader's role. Do NOT invent sector-specific facts, metrics, regulations, or requirements, and do NOT let this change the substance, the scoring, or which statements count as strengths vs gaps. Ignore any part that is blank.`
    : '';
}

async function generateCategoryText(answers, ctx) {
  if (!Array.isArray(answers) || !answers.length) return {};

  const system = `You write the "Good" and "Opportunity" sections of a lean-manufacturing plant assessment report, for a plant manager reading their own results.

For each of the 5 categories provided, using ONLY the statement content given for that category, write:
- "good": 2-3 sentences on the concrete benefits the plant is realizing, based ONLY on statements marked GREEN (fully in place across the plant). If the category has NO green statements, use "" (empty string) — do not invent a strength.
- "opportunity": 2-3 sentences on the statements marked YELLOW or RED and the concrete cost of leaving them where they are. For RED, name the specific missing gap and its cost. For YELLOW, frame it as a practice that is happening but not yet consistent plant-wide, and what standardizing it fully would secure — do not call it missing. If the category has NO yellow or red statements, use "" (empty string) — do not invent a gap.

CRITICAL: Do NOT include any "how to fix it" steps, action items, or next-move advice in the opportunity text — name the gap/cost only. Improvement steps are handled elsewhere in the report.

Tone: direct, concrete, specific to what was actually answered — never generic filler. Match this style exactly:
Good example: "Standard work, 5S discipline, and a dashboard your team actually reviews mean your improvements have something to hold onto — this is the foundation most plants skip, and you haven't."
Opportunity example (note: no fix steps): "Without a documented, followed standard, nothing else in your plant has anywhere to attach — quality checks, problem-solving, and daily dashboards all depend on a stable baseline that isn't there yet, so every gain made elsewhere has to be re-won instead of holding on its own."

Return ONLY valid JSON, no markdown fences, no commentary, exactly this shape with all 5 category names as keys:
{"Standardization":{"good":"...","opportunity":"..."},"People Involvement":{"good":"...","opportunity":"..."},"Short Lead Time":{"good":"...","opportunity":"..."},"Built-In Quality":{"good":"...","opportunity":"..."},"Continuous Improvement":{"good":"...","opportunity":"..."}}` + flavorInstruction(ctx);

  const parsed = await callAnthropicJSON(system, buildCategoryPrompt(answers), 1500);
  const out = {};
  PRINCIPLE_ORDER.forEach(name => {
    if (parsed[name]) out[name] = { good: String(parsed[name].good || ''), opportunity: String(parsed[name].opportunity || '') };
  });
  return out;
}

// ─── AI-generated 30-day plan ────────────────────────────────────────────────
// Builds a tailored 4-week PDCA plan from the plant's best-fit Lean Maturity
// Profile's first-30-days template (below) plus this plant's actual weakest
// areas and specific red statements. Non-fatal — the frontend falls back to
// its static buildPlan() if this comes back empty.

// First-30-days template per profile, from the RPA background doc. These are
// the starting shape the AI adapts to the plant's real red statements.
const PROFILE_PLANS = {
  "The Firefighter": "Week 1 (Plan): pick one high-pain pilot area; document what the best operator actually does; identify the single highest-risk step where defects escape undetected. Week 2 (Do): post the new standard and train the team to it; add one built-in quality check at that highest-risk step; put up a simple visual dashboard with 2–3 metrics. Week 3 (Check): a leader verifies the standard is actually being followed on the floor; require a posted countermeasure for any red metric; hold the first weekly team problem-solving session on the biggest recurring issue. Week 4 (Act): assess whether the area shifted from reactive to structured; standardize what worked; pick the next pilot area.",
  "The Tool Show": "Week 1 (Plan): pick one area that already has strong tools installed; assign one leader to it and define what daily coaching will look like; identify who currently owns problem solving there (usually staff, not the floor). Week 2 (Do): start the leader's fixed daily 10-minute dashboard walk; hand ownership of the weekly problem-solving session to the floor team, not the improvement staff; add one explicit CI expectation to that team's role. Week 3 (Check): track the leader's actual walk attendance; track the floor team's problem-solving consistency; track early idea submissions coming from the floor. Week 4 (Act): compare floor-driven activity before and after — that's the signal culture is catching up to the tools; standardize what worked; expand the coaching habit to the next area.",
  "The Cracked Foundation": "Week 1 (Plan): pick the area where the strong capability (the quality system, the CI program) is being undermined most visibly by inconsistency; observe what's actually happening versus what that strong system assumes. Week 2 (Do): document actual current practice as real standard work; reconcile it with what the quality or CI system assumes and close the gaps; post the standard and train the team. Week 3 (Check): hold the team to the new standard and verify adherence directly on the floor; track whether the existing strong-system results start becoming more consistent. Week 4 (Act): confirm the standard is holding without active enforcement — that's proof the crack is closing; apply the same standard-first sequencing to the next area on an unstable foundation.",
  "The Sprinter": "Week 1 (Plan): pick your highest-volume, fastest-moving flow; identify the single highest-risk step where a defect currently escapes undetected; establish a baseline defect-escape rate for that step. Week 2 (Do): add one built-in quality check at that step directly into the standard work; if a check alone isn't reliable enough, add one error-proofing device at the same step. Week 3 (Check): set and run a verification schedule for the new check or device; track the defect-escape rate against the baseline. Week 4 (Act): confirm the drop is real and holding; standardize the check or device as the new normal; apply the same sequencing to the next-fastest flow.",
  "The Believer": "Week 1 (Plan): pick your 2–3 highest-scoring statements; walk them personally, station by station, against the real scoring criteria rather than the self-assessment. Week 2 (Do): bring in an outside set of eyes to confirm the level; document any gap between the self-score and what's actually happening on the floor. Week 3 (Check): for any gap found, treat it as standard-work drift and re-anchor the standard with the team. Week 4 (Act): where the strong score is confirmed, shift the focus to sustaining — lock in the audit cadence that keeps it there; pick the next set of strong claims to verify.",
  "The Warehouse": "Week 1 (Plan): pick one value stream and physically map the current flow operation by operation; identify the single biggest staging point — the one holding the most inventory or sitting idle the longest. Week 2 (Do): define a real min/max for that staging point based on actual consumption, not habit; physically shrink the space available so the new limit has to hold; stand up one simple pull signal (a card, a bin, or an electronic trigger) that replenishes only on consumption. Week 3 (Check): verify the buffer is actually holding and measure the change in door-to-door lead time and on-hand inventory for that stream. Week 4 (Act): standardize the new min/max and pull signal, then move to the next-biggest staging point in the same value stream.",
  "The Plateau": "Week 1 (Plan): pick one recurring problem everyone already agrees is worth fixing; define it clearly and identify a likely root cause rather than the symptom. Week 2 (Do): run one real PDCA cycle on it (plan a change, try it small, don't skip the check); require a posted countermeasure — owner and due date — on every red metric in one pilot area. Week 3 (Check): verify whether the fix actually held and whether countermeasures are really being posted before the next shift; start a weekly floor-idea review, even with just two or three ideas. Week 4 (Act): standardize what worked, and lock in the cadence so PDCA and the idea review become routine — the goal is a habit, not a one-time project; then extend it to the next area."
};

// Shared inputs for both plans: category maturity weakest-first, and the
// specific red statements grouped by category.
function planInputs(answers, principleMaturity) {
  const areasByScore = [...(principleMaturity || [])].sort((a, b) => Number(a.maturity) - Number(b.maturity));
  const areaLines = areasByScore.map(a => `- ${a.name}: ${Math.round(Number(a.maturity))}/100`).join('\n');
  const weakest = areasByScore.length ? areasByScore[0].name : '(unknown)';

  const redByPrinciple = {};
  (answers || []).forEach(a => {
    const stmt = STATEMENTS[a.si];
    if (!stmt || Number(a.m) >= 5) return;
    (redByPrinciple[stmt.principle] = redByPrinciple[stmt.principle] || []).push(stmt.text);
  });
  const redLines = Object.keys(redByPrinciple).length
    ? Object.entries(redByPrinciple).map(([p, list]) =>
        `${p}:\n${list.map(t => `  - "${t}"`).join('\n')}`).join('\n')
    : '(no red statements — every area is at least developing)';

  return { areaLines, redLines, weakest };
}

function buildPlanPrompt(profile, answers, principleMaturity) {
  const { areaLines, redLines } = planInputs(answers, principleMaturity);
  return `Best-fit Lean Maturity Profile: ${profile || '(unspecified)'}

This profile's standard first-30-days template:
${PROFILE_PLANS[profile] || PROFILE_PLANS["The Firefighter"]}

This plant's category maturity (weakest first):
${areaLines}

This plant's red (lowest-scoring) statements — where the plan should focus:
${redLines}`;
}

function build6MonthPrompt(profile, phase, answers, principleMaturity) {
  const { areaLines, redLines, weakest } = planInputs(answers, principleMaturity);
  return `Best-fit Lean Maturity Profile: ${profile || '(unspecified)'}
Current roadmap phase: ${phase || '(unspecified)'}
The 30-day pilot area (month 1 must match this): ${weakest}

This plant's category maturity (weakest first):
${areaLines}

This plant's red (lowest-scoring) statements:
${redLines}`;
}

async function generatePlan(profile, answers, principleMaturity, ctx) {
  if (!Array.isArray(answers) || !answers.length) return {};

  const system = `You write the 30-day plan for a lean-manufacturing plant assessment report, for a plant manager reading their own results.

Produce a focused, runnable 30-day project: ONE pilot area, ONE PDCA cycle (Week 1 = Plan, Week 2 = Do, Week 3 = Check, Week 4 = Act). Start from the best-fit profile's first-30-days template provided, but ADAPT it to this specific plant — name the actual weakest area and bite on its specific red statements rather than staying generic. This is month 1 of a longer transformation, so it should read like a real project a plant manager could hand to a team on Monday.

Return ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{
 "pilotArea": "the single area to focus — one of: Standards, People, Logistics, Quality, Continuous Improvement (normally the weakest)",
 "objective": "one sentence: the concrete 30-day goal for the pilot area",
 "metric": "the single before/after measure to track (e.g., defect escapes at one step, changeover time, new-operator training time) — one specific measure, not a list",
 "weeks": [
   {"week":1,"title":"Plan","tag":"<area>","text":"2-3 sentences, concrete and specific, second-person","artifact":"the tangible thing that exists by end of week (a document, a posted standard, a check) — one short phrase","owner":"who runs it — a role, e.g., 'Line lead + area supervisor'"},
   {"week":2,"title":"Do","tag":"<area>","text":"...","artifact":"...","owner":"..."},
   {"week":3,"title":"Check","tag":"<area>","text":"...","artifact":"...","owner":"..."},
   {"week":4,"title":"Act","tag":"<area or All>","text":"...","artifact":"...","owner":"..."}
 ],
 "outcome": "1-2 sentences: what the plant manager will see if this worked — the proof point, and the pattern they'll carry into month 2. Do NOT begin with 'By day 30' — that label is added automatically."
}

Tone: direct, plainspoken, second-person ("you", "your team"). No preamble, no filler. Every field specific to THIS plant's weakest area and red statements.` + flavorInstruction(ctx);

  const parsed = await callAnthropicJSON(system, buildPlanPrompt(profile, answers, principleMaturity), 1600);
  if (!parsed || !Array.isArray(parsed.weeks) || parsed.weeks.length !== 4) throw new Error('plan-bad-shape');
  return {
    pilotArea: String(parsed.pilotArea || ''),
    objective: String(parsed.objective || ''),
    metric: String(parsed.metric || ''),
    weeks: parsed.weeks.map(w => ({
      week: Number(w.week),
      title: String(w.title || ''),
      tag: String(w.tag || ''),
      text: String(w.text || ''),
      artifact: String(w.artifact || ''),
      owner: String(w.owner || '')
    })),
    outcome: String(parsed.outcome || '')
  };
}

// ─── AI-generated 6-month plan ───────────────────────────────────────────────
// Six monthly cycles that continue the 30-day pilot: month 1 = prove the model
// in the weakest area, then dependency-sequenced spread + sustain. Non-fatal —
// the frontend falls back to a static buildSixMonth() if this comes back empty.
async function generate6MonthPlan(profile, phase, answers, principleMaturity, ctx) {
  if (!Array.isArray(answers) || !answers.length) return {};

  const system = `You write the 6-MONTH transformation plan for a lean-manufacturing plant assessment report, for a plant manager reading their own results.

Produce SIX monthly cycles that move this plant one clear stage up the lean maturity curve. This is the continuation of their 30-day plan, so:
- MONTH 1 = prove the model in the single weakest area (the same pilot as the 30-day plan), in ONE pilot area.
- Then sequence months 2-6 with lean dependency logic and the pilot-then-spread pattern:
  * Foundational gaps first. Standardization is the load-bearing wall — if it's weak it must be strengthened before the things that depend on it: built-in quality checks depend on standard work; continuous-improvement/PDCA depends on a documented standard to compare against. People and flow can advance alongside once a standard exists.
  * Prove in one area (month 1), then SPREAD the proven method to more lines/value streams (months 2-3).
  * Close the next dependency-linked gap (month 4).
  * Build the SUSTAINING mechanisms — leader standard work, an audit/review cadence, a real improvement habit — so gains don't decay (month 5).
  * Scale and lock in the management system; measure the shift (month 6).

Adapt every month to THIS plant's actual weakest areas and red statements — name them. Month-level themes, NOT weekly detail.

Return ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{
 "arc": "one sentence framing the journey from their current phase toward the next, as pilot -> spread -> sustain",
 "months": [
   {"month":1,"theme":"short title","focus":"area label — Standards, People, Logistics, Quality, Continuous Improvement, or All","text":"2-3 sentences, concrete, second-person","milestone":"the month-end proof point / what exists by month end"},
   {"month":2,"theme":"...","focus":"...","text":"...","milestone":"..."},
   {"month":3,"theme":"...","focus":"...","text":"...","milestone":"..."},
   {"month":4,"theme":"...","focus":"...","text":"...","milestone":"..."},
   {"month":5,"theme":"...","focus":"...","text":"...","milestone":"..."},
   {"month":6,"theme":"...","focus":"...","text":"...","milestone":"..."}
 ],
 "destination": "1-2 sentences: where the plant should be after 6 months if this held — tie it to moving up the maturity curve"
}

Tone: direct, plainspoken, second-person. Specific to THIS plant. No preamble, no filler.` + flavorInstruction(ctx);

  const parsed = await callAnthropicJSON(system, build6MonthPrompt(profile, phase, answers, principleMaturity), 2000);
  if (!parsed || !Array.isArray(parsed.months) || parsed.months.length !== 6) throw new Error('sixmonth-bad-shape');
  return {
    arc: String(parsed.arc || ''),
    months: parsed.months.map(m => ({
      month: Number(m.month),
      theme: String(m.theme || ''),
      focus: String(m.focus || ''),
      text: String(m.text || ''),
      milestone: String(m.milestone || '')
    })),
    destination: String(parsed.destination || '')
  };
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
  // updatedRange looks like "scorecard!A7:U7" — pull the row number out so a
  // later best-effort update can target this exact row without a re-read.
  const match = /![A-Z]+(\d+):/.exec(data.updates && data.updates.updatedRange || '');
  return match ? Number(match[1]) : null;
}

async function updateAiCells(sheetId, accessToken, rowNumber, categoryText, plan, aiStatus, plan6) {
  // Patches this row's AI columns in one write: U = categoryText, V = plan
  // (30-day), Z = ai_status (human-readable "ok"/failure), AA = plan6_json
  // (6-month plan). All JSON strings except ai_status.
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [
        { range: `${SHEET_TAB}!U${rowNumber}:V${rowNumber}`, values: [[JSON.stringify(categoryText || {}), JSON.stringify(plan || {})]] },
        { range: `${SHEET_TAB}!Z${rowNumber}`, values: [[aiStatus || '']] },
        { range: `${SHEET_TAB}!AA${rowNumber}`, values: [[JSON.stringify(plan6 || {})]] }
      ]
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets cell update error: ${JSON.stringify(data)}`);
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

async function pushToKartra({ firstName, email, phase }, id) {
  const { KARTRA_API_KEY, KARTRA_API_PASSWORD, KARTRA_APP_ID } = process.env;
  const missing = v => !v || v === 'unset';
  if (missing(KARTRA_API_KEY) || missing(KARTRA_API_PASSWORD) || missing(KARTRA_APP_ID)) {
    return 'kartra-skipped-no-creds';
  }

  const auth = { api_key: KARTRA_API_KEY, api_password: KARTRA_API_PASSWORD, app_id: KARTRA_APP_ID };
  // Kartra's WAF rejects names containing markup; strip anything suspicious
  // for the Kartra copy only (the sheet keeps the original).
  const safeName = firstName.replace(/[<>={}\[\]\\]/g, '').trim().slice(0, 60) || 'Visitor';

  // Custom fields carry the lead's report links so a Kartra automation/email
  // can send them. Identifiers must already exist in the Kartra account
  // (RPAreportURL, RPA6planURL) or Kartra silently ignores them.
  const reportUrl = id ? `https://rpa.planetlean.com/r/${id}` : '';
  const customFields = reportUrl ? [
    { field_identifier: 'RPAreportURL', field_value: reportUrl },
    { field_identifier: 'RPA6planURL', field_value: `${reportUrl}?v=plan` }
  ] : [];

  // Two separate calls because create_lead ERRORS on an existing contact and
  // kills every action bundled with it — repeat visitors would lose their
  // tags. Tags are assigned in their own call, which works for new and
  // existing leads alike.
  const created = await kartraCall({
    ...auth,
    lead: { email, first_name: safeName, ...(customFields.length ? { custom_fields: customFields } : {}) },
    actions: [{ cmd: 'create_lead' }]
  });
  const createStatus = created.status === 'Success' ? 'created' : 'existing';

  // Minimal tag set (Jim's call): "scorecard" identifies the lead source,
  // phase number tag (phase1–phase4) drives segmented follow-up, and "6plan"
  // is the trigger tag Jim's automation watches to email the report + 6-month
  // plan URLs (the RPAreportURL / RPA6planURL custom fields set above). The
  // pattern is stored in the sheet if pattern-level segmentation is ever wanted.
  const phaseNum = { 'Formative': 1, 'Localized': 2, 'Broad-based': 3, 'Benchmark': 4 }[phase];
  const tagged = await kartraCall({
    ...auth,
    lead: { email },
    actions: [
      { cmd: 'assign_tag', tag_name: 'scorecard' },
      { cmd: 'assign_tag', tag_name: `phase${phaseNum}` },
      { cmd: 'assign_tag', tag_name: '6plan' }
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
  // Best-fit profile name (drives the AI 30-day plan). Optional — the plan
  // generator falls back to a default template if it's missing or unknown.
  const profile = String(event.profile || '').slice(0, 40);

  // General plant info (dropdowns) — optional. Stored for benchmarking and
  // used for light sector flavor in the AI writes. Never affects scoring.
  const plantSize = String(event.plantSize || '').slice(0, 40);
  const industry = String(event.industry || '').slice(0, 60);
  const role = String(event.role || '').slice(0, 60);

  return { errors, firstName, email, score, phase, principles, maturity, principleMaturity, pattern, profile, plantSize, industry, role };
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
      kartraStatus = await pushToKartra(v, id);
    } catch (err) {
      console.error('Kartra push failed (non-fatal):', err.message);
      kartraStatus = 'kartra-error: ' + err.message.slice(0, 120);
    }
  } else {
    kartraStatus = `kartra-skipped-bad-email(${emailCheck.status})`;
  }
  kartraStatus += ` | zb:${emailCheck.status}`;

  // The row lands with empty AI cells first — lead capture must never wait on
  // or be threatened by an AI call. The two generations (category text +
  // 30-day plan) can each take up to their own 20s timeout; if that ever ate
  // into the function's total budget before the sheet write ran, a real lead
  // could be lost. So we write the row immediately, then run both AI calls in
  // parallel and best-effort patch columns U (categoryText) and V (plan).
  let rowNumber;
  try {
    const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'));
    const token = await getAccessToken(sa);
    rowNumber = await appendRow(process.env.GOOGLE_SHEET_ID, token, [
      id,
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET',
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
      '{}',
      '{}',
      v.plantSize,
      v.industry,
      v.role
    ]);

    if (rowNumber) {
      const ctx = plantContext(v);
      const [catResult, planResult, sixResult] = await Promise.allSettled([
        generateCategoryText(event.answers, ctx),
        generatePlan(v.profile, event.answers, v.principleMaturity, ctx),
        generate6MonthPlan(v.profile, v.phase, event.answers, v.principleMaturity, ctx)
      ]);
      const categoryText = catResult.status === 'fulfilled' ? catResult.value : {};
      const plan = planResult.status === 'fulfilled' ? planResult.value : {};
      const plan6 = sixResult.status === 'fulfilled' ? sixResult.value : {};
      if (catResult.status === 'rejected') console.error('Category text generation failed (non-fatal, static fallback):', catResult.reason && catResult.reason.message);
      if (planResult.status === 'rejected') console.error('Plan generation failed (non-fatal, static fallback):', planResult.reason && planResult.reason.message);
      if (sixResult.status === 'rejected') console.error('6-month plan generation failed (non-fatal, static fallback):', sixResult.reason && sixResult.reason.message);
      // Human-readable status for the sheet's ai_status column (col Z).
      const shortErr = res => String((res && res.reason && res.reason.message) || 'error').slice(0, 60);
      const catPart = catResult.status === 'fulfilled'
        ? (Object.keys(categoryText).length ? 'ok' : 'empty')
        : `FAIL(${shortErr(catResult)})`;
      const planPart = planResult.status === 'fulfilled'
        ? (plan && plan.weeks && plan.weeks.length ? 'ok' : 'empty')
        : `FAIL(${shortErr(planResult)})`;
      const sixPart = sixResult.status === 'fulfilled'
        ? (plan6 && plan6.months && plan6.months.length ? 'ok' : 'empty')
        : `FAIL(${shortErr(sixResult)})`;
      const aiStatus = (catPart === 'ok' && planPart === 'ok' && sixPart === 'ok')
        ? 'ok' : `category:${catPart} | plan:${planPart} | 6mo:${sixPart}`;
      // Always write — so a total failure (all empty) still records its status.
      try {
        await updateAiCells(process.env.GOOGLE_SHEET_ID, token, rowNumber, categoryText, plan, aiStatus, plan6);
      } catch (err) {
        console.error('AI cell write failed (non-fatal):', err.message);
      }
    }
  } catch (err) {
    console.error('Sheet write failed:', err.message);
    return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'storage-failed' } };
  }

  // emailBad = the address came back CLEARLY undeliverable (invalid/spamtrap/
  // abuse/do_not_mail). The frontend uses it to gate the "book a call" CTA.
  // Catch-all/unknown/valid all pass (good), so real corporate emails aren't
  // blocked.
  return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id, emailBad: !emailCheck.good } };
}

exports.main = main;
