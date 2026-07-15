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

// Tie-break priority for picking the single weakest area when categories tie
// on maturity. MUST stay identical to the frontend's GAP_PRIORITY (index.html)
// so the plan's pilot area is always the same category the report names as the
// "Biggest Gap" — note Built-In Quality outranks Short Lead Time here, which is
// the one place this differs from PRINCIPLE_ORDER.
const GAP_PRIORITY = [
  'Standardization',
  'People Involvement',
  'Built-In Quality',
  'Short Lead Time',
  'Continuous Improvement'
];

// Derive the biggest-gap / top-strength categories from the maturity scores —
// the same lowest / highest(>=80) + GAP_PRIORITY rule the report callouts use.
// Used as a fallback when the frontend didn't send the category names, so the
// AI focus paragraphs still generate for the right categories (e.g. an older
// cached page that omits topStrengthCat).
function deriveFocus(principleMaturity) {
  const pm = (principleMaturity || []).filter(p => p && p.name);
  if (!pm.length) return { gap: '', strength: '' };
  const sorted = dir => [...pm].sort((a, b) => {
    const d = (dir === 'hi' ? -1 : 1) * (Number(a.maturity) - Number(b.maturity));
    return d !== 0 ? d : GAP_PRIORITY.indexOf(a.name) - GAP_PRIORITY.indexOf(b.name);
  });
  const strong = sorted('hi').find(p => Number(p.maturity) >= 80);
  return { gap: sorted('lo')[0].name, strength: strong ? strong.name : '' };
}

// ─── AI-generated category text (Good / Opportunity) ─────────────────────────
// Runs once per submission, off the plant's actual per-statement answers, so
// the report's Good/Opportunity boxes reflect which specific statements
// scored well vs. poorly instead of one fixed paragraph per category. Non-
// fatal on any failure — the frontend falls back to its static category
// copy if categoryText comes back empty.

const ANTHROPIC_MODEL = 'claude-opus-4-8';
const ANTHROPIC_CALL_TIMEOUT_MS = 45000;
// Bound the two blocking third-party calls in the submit path so a hung
// provider can't stall the whole request up to the function's 55s budget (and
// lose the lead). Both fail SAFE on timeout: ZeroBounce fails open (email
// treated as valid), Kartra returns a status the caller records and moves on.
const ZEROBOUNCE_TIMEOUT_MS = 8000;
const KARTRA_TIMEOUT_MS = 10000;

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
      // Each statement feeds one side of its category, with the specific
      // content lanes that side needs. GREEN → Good (principle + connections +
      // realized payoff). YELLOW/RED → Opportunity (principle + connections +
      // cost of the gap). The `steps` lane is passed only as context so the AI
      // understands the gap fully; the Opportunity text must NOT restate it —
      // action steps live verbatim in the 30-day plan and Deep Insights, and
      // repeating them here would duplicate the report.
      if (status === 'green') {
        return `- [GREEN → feeds Good] "${stmt.text}"\n    Principle: ${stmt.why}\n    Connections: ${stmt.connections}\n    Payoff being realized: ${stmt.strength}`;
      }
      const tag = status === 'red'
        ? 'RED (missing) → feeds Opportunity'
        : 'YELLOW (happening but not yet consistent plant-wide) → feeds Opportunity';
      return `- [${tag}] "${stmt.text}"\n    Principle: ${stmt.why}\n    Connections: ${stmt.connections}\n    Cost of the gap: ${stmt.weakness}\n    (context only — do NOT restate as advice: ${stmt.steps})`;
    }).join('\n');
    return `## ${name}\n${lines || '(no answers recorded for this category)'}`;
  }).join('\n\n');
}

// Full per-statement content for ONE category, used to write the rich Biggest
// Gap / Top Strength paragraphs. Unlike buildCategoryPrompt (which sends the
// side each statement feeds), this sends EVERY lane for every statement in the
// category — why + connections for all, plus strength for greens and
// weakness + first-move for yellow/red — so the AI has the whole picture to
// summarize the category holistically.
function buildFocusBlock(answers, categoryName) {
  const items = (answers || [])
    .map(a => ({ stmt: STATEMENTS[a.si], status: statementStatus(Number(a.m)) }))
    .filter(x => x.stmt && x.stmt.principle === categoryName);
  return items.map(({ stmt, status }) => {
    const head = status === 'green' ? 'GREEN (in place)'
      : status === 'red' ? 'RED (missing)'
      : 'YELLOW (present but not yet consistent plant-wide)';
    let s = `- [${head}] "${stmt.text}"\n    Why it matters: ${stmt.why}\n    Connects to: ${stmt.connections}`;
    if (status === 'green') s += `\n    Strength realized: ${stmt.strength}`;
    else s += `\n    Cost of the gap: ${stmt.weakness}\n    First move: ${stmt.steps}`;
    return s;
  }).join('\n');
}

// Tolerant JSON parse for model output: handles a clean object, one wrapped in
// ```json fences, or one with a stray preamble / trailing character (the model
// occasionally adds a word or a code fence). Falls back to slicing the
// outermost {...}. Throws only if no JSON object can be recovered at all.
function parseModelJSON(text) {
  let t = String(text || '').trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch (e) { /* fall through to extraction */ }
  // Extract the FIRST complete, brace-balanced {...} object (string/escape
  // aware) so a stray preamble, a trailing note, or a second object after the
  // JSON can't break parsing.
  const start = t.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      } else if (c === '"') { inStr = true; }
      else if (c === '{') { depth++; }
      else if (c === '}') { if (--depth === 0) return JSON.parse(t.slice(start, i + 1)); }
    }
  }
  throw new Error('no parseable JSON object in model output: ' + t.slice(0, 80));
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
  return parseModelJSON(text);
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

// Shared voice rules for all reader-facing prose. The reader is a busy plant/ops
// manager who skims — short, plainspoken sentences survive that; dense multi-clause
// sentences ("list-in-a-sentence") do not. Appended to every generation prompt so
// the whole report reads in one consistent voice.
const WRITING_STYLE = `

WRITING STYLE — this governs every sentence you write, and matters as much as the content:
- Short, plain sentences, ONE idea each. Most sentences under ~18 words. Where you'd reach for "because", "which", "so that", or a second em-dash in one sentence, use a period and start a new one instead.
- VARY the rhythm on purpose. Mostly short sentences, with an occasional medium one to breathe, and now and then a very short 2-4 word sentence to land a point ("That's rare." / "You didn't."). Never a machine-gun run of identically clipped sentences — that reads as dumbed-down.
- Break the list-in-a-sentence apart. If you catch yourself stacking three or four items behind a colon or joined by commas and "and", make them separate short sentences.
- Keep the real lean vocabulary — standard work, PDCA, pull system, built-in quality, continuous improvement, help chain, 5S, standard work adherence. These exact terms are credibility with this reader; never soften them into vague paraphrases.
- Lead with what's working, then name what to fix as a short PRIORITIZED SEQUENCE ("fix X first, then Y"), not a long pile of weaknesses. The reader should feel pointed at one or two things, never handed an audit checklist.
- Read like a sharp coach talking to the plant manager — direct, concrete, specific to what they actually answered. No preamble, no generic filler.`;

async function generateCategoryText(answers, ctx) {
  if (!Array.isArray(answers) || !answers.length) return {};

  const system = `You write the reader-facing summary layers of a lean-manufacturing plant assessment report, for a plant manager reading their own results.

The report has several layers that must NOT repeat each other's wording — this is the single most important rule. Every layer is written from the same underlying statement content, so you must vary altitude and angle, never sentences:
- Deep Insights (written elsewhere) quotes the per-statement source text VERBATIM. You are given that same content as input — do NOT copy its phrases; abstract into your own words.
- Category Highlights (you write) — a short "good" and "opportunity" per category.
- Overview (you write) — one short paragraph over the whole plant, above the highlights.

For each of the 5 categories, using ONLY the statement content given for that category, write:
- "good": 2-3 sentences on the concrete strengths the plant is realizing, based ONLY on statements marked GREEN. Draw on the principle, how the practices connect, and the payoff being realized. If the category has NO green statements, use "" — do not invent a strength.
- "opportunity": 2-3 sentences on the statements marked YELLOW or RED and the concrete cost of leaving them where they are. For RED, name the specific missing gap and its cost. For YELLOW, frame it as a practice happening but not yet consistent plant-wide, and what standardizing it fully would secure — do not call it missing. If the category has NO yellow or red statements, use "" — do not invent a gap. Name the gap and stakes ONLY — no fix steps.

- "overview": ONE paragraph (3-4 sentences) for the very top of the report (the "Executive Summary"). Structure it deliberately in this order: (1) OPEN on the plant's genuine strength or foundation — the most legitimate thing it has going for it. If the plant is weak across the board with no real strength, open by honestly naming the starting point (e.g., an early-stage plant with a clean slate to build on) rather than inventing praise. (2) PIVOT to the single most important gap. (3) END on that gap and what closing it would unlock. Keep it a higher altitude than the category highlights, fresh wording, no sentences repeated from elsewhere.

Match this style (short sentences, varied rhythm, lean vocabulary):
Good example: "Standard work, 5S, and a dashboard your team actually uses give your improvements something to hold onto. Most plants skip that foundation. You didn't."
Opportunity example (no fix steps): "Without a documented standard people actually follow, nothing else has anywhere to attach. Quality checks, problem-solving, the daily dashboard — they all lean on a stable baseline. Right now it isn't there. So every gain you make elsewhere has to be re-won instead of holding on its own."

Return ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{"overview":"...","categories":{"Standardization":{"good":"...","opportunity":"..."},"People Involvement":{"good":"...","opportunity":"..."},"Short Lead Time":{"good":"...","opportunity":"..."},"Built-In Quality":{"good":"...","opportunity":"..."},"Continuous Improvement":{"good":"...","opportunity":"..."}}}` + WRITING_STYLE + flavorInstruction(ctx);

  const parsed = await callAnthropicJSON(system, buildCategoryPrompt(answers), 2500);
  const cats = (parsed && parsed.categories) || {};
  const out = {};
  PRINCIPLE_ORDER.forEach(name => {
    if (cats[name]) out[name] = { good: String(cats[name].good || ''), opportunity: String(cats[name].opportunity || '') };
  });
  // Overview rides along in the same col-U JSON under a reserved key.
  out._overview = String((parsed && parsed.overview) || '');
  return out;
}

// The two prominent focus paragraphs (Biggest Gap + Top Strength) are a SEPARATE
// Claude call — kept out of generateCategoryText so neither response is large
// enough to risk truncation (a single combined call overflowed and broke the
// whole JSON). They run in parallel, so this adds no wall-clock time, and a
// failure here can't take the category text down with it. focus = { gap,
// strength } category names picked by the frontend so the labels match.
async function generateFocusText(answers, ctx, focus) {
  if (!Array.isArray(answers) || !answers.length) return {};
  const gapCat = focus && PRINCIPLE_ORDER.includes(focus.gap) ? focus.gap : null;
  const strengthCat = focus && PRINCIPLE_ORDER.includes(focus.strength) ? focus.strength : null;
  if (!gapCat && !strengthCat) return {};

  const system = `You write two prominent paragraphs of a lean-manufacturing plant assessment report, for a plant manager reading their own results. Each is built from the FULL content of one category (all its statements). Abstract that content into your own words — do NOT copy the source phrases verbatim (they appear elsewhere in the report), and share no sentences between the two paragraphs.

- "biggestGap": ONE rich paragraph (4-6 sentences) on the plant's single biggest-gap category${gapCat ? ` (${gapCat})` : ''}, from the "BIGGEST GAP FOCUS" block. This is the report's most prominent gap analysis and has four statements of material to draw on, so it must NEVER lean on a generic "why it matters." Weave together why this category matters, how its practices reinforce each other, what the plant already has in place (GREEN) versus what is missing or inconsistent (YELLOW/RED), and what that gap is costing them — holistic and prioritized. If no focus block is given, use "".
- "topStrength": ONE paragraph (3-5 sentences) on the plant's single strongest category${strengthCat ? ` (${strengthCat})` : ''}, from the "TOP STRENGTH FOCUS" block — what it has in place, how those practices connect, and what that foundation enables. If no focus block is given, use "".

Return ONLY valid JSON, no markdown fences, no commentary, exactly: {"biggestGap":"...","topStrength":"..."}` + WRITING_STYLE + flavorInstruction(ctx);

  let userContent = '';
  if (gapCat) userContent += `===== BIGGEST GAP FOCUS — ${gapCat} (write "biggestGap" from this) =====\n${buildFocusBlock(answers, gapCat)}\n\n`;
  if (strengthCat) userContent += `===== TOP STRENGTH FOCUS — ${strengthCat} (write "topStrength" from this) =====\n${buildFocusBlock(answers, strengthCat)}`;

  const parsed = await callAnthropicJSON(system, userContent, 1500);
  let biggestGap = String((parsed && parsed.biggestGap) || '');
  let topStrength = String((parsed && parsed.topStrength) || '');
  // Retry once if a requested paragraph came back empty (rare model miss where
  // it returns "" despite being given the focus block).
  if ((gapCat && !biggestGap) || (strengthCat && !topStrength)) {
    try {
      const p2 = await callAnthropicJSON(system, userContent, 1500);
      if (gapCat && !biggestGap) biggestGap = String((p2 && p2.biggestGap) || '');
      if (strengthCat && !topStrength) topStrength = String((p2 && p2.topStrength) || '');
    } catch (e) { /* keep what we have */ }
  }
  return { _biggestGap: biggestGap, _topStrength: topStrength };
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
  const areasByScore = [...(principleMaturity || [])].sort((a, b) => {
    const d = Number(a.maturity) - Number(b.maturity);
    if (d !== 0) return d;
    return GAP_PRIORITY.indexOf(a.name) - GAP_PRIORITY.indexOf(b.name);
  });
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
  const { areaLines, redLines, weakest } = planInputs(answers, principleMaturity);
  return `Best-fit Lean Maturity Profile: ${profile || '(unspecified)'}

This profile's standard first-30-days template:
${PROFILE_PLANS[profile] || PROFILE_PLANS["The Firefighter"]}

The pilot area for this 30-day plan MUST be ${weakest} — this is the plant's biggest gap and the report names it as such, so the plan has to focus there. Set "pilotArea" to ${weakest}.

This plant's category maturity (weakest first):
${areaLines}

This plant's red (lowest-scoring) statements — where the plan should focus:
${redLines}`;
}

function build6MonthPrompt(profile, phase, answers, principleMaturity) {
  const { areaLines, redLines, weakest } = planInputs(answers, principleMaturity);
  return `Best-fit Lean Maturity Profile: ${profile || '(unspecified)'}
The 30-day pilot area (month 1 must match this): ${weakest}

This plant's category maturity (weakest first):
${areaLines}

This plant's red (lowest-scoring) statements:
${redLines}`;
}

// Both plans are read by a lead who has only ever seen LEAN MATURITY results —
// their score /100, category scores, and standing (Early Stage / Gaining
// Traction / Building Momentum / Benchmark). The roadmap phase names
// (Formative / Localized / Broad-based) live only under the Roadmap section and
// mean nothing to them here, so the plan copy must never use them.
const TERMINOLOGY_RULE = `

TERMINOLOGY — IMPORTANT: The reader only knows their LEAN MATURITY results: a maturity score out of 100, their five category scores, and their overall standing (one of: Early Stage, Gaining Traction, Building Momentum, Benchmark). Write ONLY in that language. Do NOT use the roadmap phase names "Formative", "Localized", or "Broad-based", and do NOT use the word "phase" anywhere — the reader has not been shown that framework and it will confuse them. Frame progress as raising their lean maturity, moving up the maturity levels, or closing category gaps — never as advancing through phases.`;

async function generatePlan(profile, answers, principleMaturity, ctx) {
  if (!Array.isArray(answers) || !answers.length) return {};

  const system = `You write the 30-day plan for a lean-manufacturing plant assessment report, for a plant manager reading their own results.

Produce a focused, runnable 30-day project: ONE pilot area, ONE PDCA cycle (Week 1 = Plan, Week 2 = Do, Week 3 = Check, Week 4 = Act). Start from the best-fit profile's first-30-days template provided, but ADAPT it to this specific plant — name the actual weakest area and bite on its specific red statements rather than staying generic. This is month 1 of a longer transformation, so it should read like a real project a plant manager could hand to a team on Monday.

Return ONLY valid JSON, no markdown fences, no commentary, exactly this shape:
{
 "pilotArea": "the single area to focus — set this to the weakest area named in the prompt (the plant's biggest gap); do not choose a different area",
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

Tone: direct, plainspoken, second-person ("you", "your team"). No preamble, no filler. Every field specific to THIS plant's weakest area and red statements.` + TERMINOLOGY_RULE + WRITING_STYLE + flavorInstruction(ctx);

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
 "arc": "one sentence framing the journey as pilot -> spread -> sustain, moving the plant up its lean maturity toward the next level — do NOT name any roadmap phase",
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

Tone: direct, plainspoken, second-person. Specific to THIS plant. No preamble, no filler.` + TERMINOLOGY_RULE + WRITING_STYLE + flavorInstruction(ctx);

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

// Writes ONLY col U (categoryText) — used to land the on-screen report's AI
// text (overview + highlights + gap/strength paragraphs) as soon as it's ready,
// without waiting on the slower 30-day / 6-month plan generations that share the
// stage:'ai' call. The plans get written afterward by updateAiCells.
async function updateCategoryCell(sheetId, accessToken, rowNumber, categoryText) {
  const range = `${SHEET_TAB}!U${rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[JSON.stringify(categoryText || {})]] })
  });
  if (!res.ok) throw new Error(`category cell update ${res.status}`);
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ZEROBOUNCE_TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(url, { signal: controller.signal });
    data = await res.json();
  } finally {
    clearTimeout(timer);
  }
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KARTRA_TIMEOUT_MS);
  try {
    const res = await fetch('https://app.kartra.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: phpEncode(params, '', new URLSearchParams()),
      signal: controller.signal
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch (e) {
      return { status: 'Unparseable', message: text.slice(0, 120) };
    }
  } catch (err) {
    // Timeout or network error — return a status so pushToKartra records it and
    // the submit continues (the lead is already stored in the sheet).
    return { status: 'RequestFailed', message: (err.name === 'AbortError' ? 'timeout' : err.message).slice(0, 120) };
  } finally {
    clearTimeout(timer);
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

  // create_lead ERRORS on an existing contact and kills every action bundled
  // with it, so it runs alone with no fields/tags attached — a repeat visitor
  // simply falls through as 'existing'.
  const created = await kartraCall({
    ...auth,
    lead: { email, first_name: safeName },
    actions: [{ cmd: 'create_lead' }]
  });
  const createStatus = created.status === 'Success' ? 'created' : 'existing';

  // Second call does the rest, and works for both new and existing contacts:
  //  - edit_lead refreshes the report-link custom fields. This MUST be edit_lead
  //    (Kartra's documented command to update an existing lead) — NOT create_lead
  //    (errors on an existing contact) and NOT update_lead (not a real command —
  //    Kartra silently ignores it and returns Success). On a RETAKE this is what
  //    makes the re-fired 6plan email carry the visitor's CURRENT report links
  //    instead of their first take's.
  //  - the tags: "scorecard" = source, phaseN = phase (accumulates across
  //    retakes, by design), "6plan" = the trigger Jim's automation watches.
  //    Re-assigning a tag the contact already has is a harmless no-op.
  const phaseNum = { 'Formative': 1, 'Localized': 2, 'Broad-based': 3, 'Benchmark': 4 }[phase];
  const tagged = await kartraCall({
    ...auth,
    lead: { email, ...(customFields.length ? { custom_fields: customFields } : {}) },
    actions: [
      ...(customFields.length ? [{ cmd: 'edit_lead' }] : []),
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

// The three plant-info fields come from fixed dropdowns. The API can't trust
// that (a direct POST can send anything), so validate() only accepts these exact
// values and blanks anything else. This closes the stored-XSS vector — the
// report renders `industry` into innerHTML, so arbitrary text there could inject
// markup — and keeps the data clean (industry must match the Industry Averages
// sheet exactly for the comparison to work). Membership is checked
// dash-insensitively so the en-dash the browser actually sends still matches a
// plain-hyphen entry here; the ORIGINAL value is stored so it still matches the
// sheet character-for-character.
const ALLOWED_PLANT_SIZES = [
  '1-50 employees', '51-200 employees', '201-500 employees',
  '501-2,000 employees', '2,000+ employees'
];
const ALLOWED_INDUSTRIES = [
  'Automotive', 'Food & Beverage', 'Medical Device & Pharma',
  'Aerospace & Defense', 'Metal Fabrication & Machining', 'Plastics & Rubber',
  'Electronics & Electrical', 'Industrial & Heavy Equipment', 'Consumer Goods', 'Other'
];
const ALLOWED_ROLES = [
  'Plant Manager', 'Operations Manager / Director',
  'Continuous Improvement / Lean Leader', 'Production / Shift Supervisor',
  'Quality Manager', 'Engineering', 'Executive / Owner', 'Other'
];
// Normalize any unicode dash variant (en/em/figure/minus) to a plain hyphen for
// comparison only, so character-encoding differences can't blank a real value.
const dashNorm = s => String(s || '').replace(/[‐-―−]/g, '-').trim();
const fromAllowed = (value, list) => {
  const v = dashNorm(value);
  return list.some(x => dashNorm(x) === v) ? String(value).trim() : '';
};

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
  // Whitelisted to the known dropdown options; anything else is blanked (see
  // ALLOWED_* above) — closes the XSS vector and keeps the data clean.
  const plantSize = fromAllowed(String(event.plantSize || '').slice(0, 40), ALLOWED_PLANT_SIZES);
  const industry = fromAllowed(String(event.industry || '').slice(0, 60), ALLOWED_INDUSTRIES);
  const role = fromAllowed(String(event.role || '').slice(0, 60), ALLOWED_ROLES);

  return { errors, firstName, email, score, phase, principles, maturity, principleMaturity, pattern, profile, plantSize, industry, role };
}

// ─── AI generation (background stage) ────────────────────────────────────────

// Runs the three Claude generations for an already-stored row and patches its
// AI cells (U categoryText, V plan, Z ai_status, AA plan6). Called by the
// background `stage:'ai'` request so the main submit can return the id fast.
// Best-effort: every failure is non-fatal and recorded in ai_status; the report
// falls back to static copy for any cell that stays empty.
async function runAiGeneration(sheetId, token, rowNumber, v, event) {
  const ctx = plantContext(v);
  // The frontend picks the biggest-gap / top-strength category (same rule the
  // report's callouts use) and sends the names so the AI paragraph matches the
  // callout label. Invalid/absent names just skip that focus paragraph.
  // Prefer the categories the frontend picked (so the AI paragraph matches the
  // callout label), but fall back to deriving them from the scores if either is
  // missing/invalid — that's why Billy's report generated a Biggest Gap but no
  // Top Strength (topStrengthCat didn't come through).
  const derived = deriveFocus(v.principleMaturity);
  const focus = {
    gap: PRINCIPLE_ORDER.includes(event.biggestGapCat) ? event.biggestGapCat : derived.gap,
    strength: PRINCIPLE_ORDER.includes(event.topStrengthCat) ? event.topStrengthCat : derived.strength
  };
  // Start all four generations at once, but DON'T wait on the slower plan
  // generations before saving the category text — the on-screen report polls
  // col U, so writing it the moment category + focus are ready (~25s) makes it
  // land fast instead of being gated behind the 30-day/6-month plans (~50s+).
  const catP = generateCategoryText(event.answers, ctx);
  const focusP = generateFocusText(event.answers, ctx, focus);
  const planP = generatePlan(v.profile, event.answers, v.principleMaturity, ctx);
  const sixP = generate6MonthPlan(v.profile, v.phase, event.answers, v.principleMaturity, ctx);

  // Phase 1 — category text (overview + highlights + gap/strength paragraphs).
  const [catResult, focusResult] = await Promise.allSettled([catP, focusP]);
  const categoryText = catResult.status === 'fulfilled' ? catResult.value : {};
  // Merge the two focus paragraphs into the same col-U object (reserved keys).
  // Independent of the category call: if that failed, the callouts still get
  // their AI text; if this failed, the highlights/overview are unaffected.
  if (focusResult.status === 'fulfilled' && focusResult.value) {
    categoryText._biggestGap = focusResult.value._biggestGap || '';
    categoryText._topStrength = focusResult.value._topStrength || '';
  }
  if (catResult.status === 'rejected') console.error('Category text generation failed (non-fatal, static fallback):', catResult.reason && catResult.reason.message);
  if (focusResult.status === 'rejected') console.error('Focus paragraphs generation failed (non-fatal, static fallback):', focusResult.reason && focusResult.reason.message);
  // Write col U now so the on-screen report can pick it up without waiting on
  // the plans. Best-effort — the final updateAiCells rewrites it anyway.
  try { await updateCategoryCell(sheetId, token, rowNumber, categoryText); }
  catch (err) { console.error('Early category-cell write failed (non-fatal):', err.message); }

  // Phase 2 — the plans (slower), then the final combined write + ai_status.
  const [planResult, sixResult] = await Promise.allSettled([planP, sixP]);
  const plan = planResult.status === 'fulfilled' ? planResult.value : {};
  const plan6 = sixResult.status === 'fulfilled' ? sixResult.value : {};
  if (planResult.status === 'rejected') console.error('Plan generation failed (non-fatal, static fallback):', planResult.reason && planResult.reason.message);
  if (sixResult.status === 'rejected') console.error('6-month plan generation failed (non-fatal, static fallback):', sixResult.reason && sixResult.reason.message);
  // Human-readable status for the sheet's ai_status column (col Z).
  const shortErr = res => String((res && res.reason && res.reason.message) || 'error').slice(0, 60);
  const focusPart = focusResult.status === 'fulfilled' ? ((categoryText._biggestGap || categoryText._topStrength) ? 'ok' : 'empty') : `FAIL(${shortErr(focusResult)})`;
  const catPart = catResult.status === 'fulfilled' ? (Object.keys(categoryText).length ? 'ok' : 'empty') : `FAIL(${shortErr(catResult)})`;
  const planPart = planResult.status === 'fulfilled' ? (plan && plan.weeks && plan.weeks.length ? 'ok' : 'empty') : `FAIL(${shortErr(planResult)})`;
  const sixPart = sixResult.status === 'fulfilled' ? (plan6 && plan6.months && plan6.months.length ? 'ok' : 'empty') : `FAIL(${shortErr(sixResult)})`;
  const aiStatus = (catPart === 'ok' && focusPart === 'ok' && planPart === 'ok' && sixPart === 'ok') ? 'ok' : `category:${catPart} | focus:${focusPart} | plan:${planPart} | 6mo:${sixPart}`;
  // Always write — so a total failure (all empty) still records its status.
  await updateAiCells(sheetId, token, rowNumber, categoryText, plan, aiStatus, plan6);
}

// Finds the 1-based sheet row number for a report id (0 if not found).
async function findRowById(sheetId, token, id) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${SHEET_TAB}%21A:A`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const rows = data.values || [];
  const idx = rows.findIndex(r => (r[0] || '').toLowerCase() === id.toLowerCase());
  return idx >= 0 ? idx + 1 : 0;
}

// Patches the kartra_status column (N) for a row. Used after the Kartra push,
// which now runs AFTER the row is written, so the row starts with a placeholder
// and this fills in the real result. Best-effort.
async function updateKartraStatus(sheetId, token, rowNumber, status) {
  const range = `${SHEET_TAB}!N${rowNumber}`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[status]] })
  });
  if (!res.ok) throw new Error(`kartra_status update ${res.status}`);
}

// Rebuild a submit event from a stored sheet row — used by the backfill sweep
// to regenerate the AI for a row whose original generation never completed. The
// biggest-gap / top-strength categories aren't stored, but runAiGeneration
// derives them from principleMaturity; profile isn't stored either, so the plan
// falls back to its default template (fine for a rescued row).
function rowToEvent(r) {
  let answers = [];
  try { answers = r[12] ? JSON.parse(r[12]) : []; } catch (e) { answers = []; }
  return {
    firstName: r[2], email: r[3], score: Number(r[4]), phase: r[5],
    principles: PRINCIPLE_ORDER.map((n, i) => ({ name: n, score: Number(r[6 + i]) })),
    pattern: r[11],
    answers,
    maturity: Number(r[14]),
    principleMaturity: PRINCIPLE_ORDER.map((n, i) => ({ name: n, maturity: Number(r[15 + i]) })),
    plantSize: r[22] || '', industry: r[23] || '', role: r[24] || ''
  };
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

  // Honeypot is handled NON-destructively in the normal submit path below. A
  // filled hidden field no longer silently drops the submission — that cost
  // real leads whose browser or password manager autofilled it. Instead the row
  // is saved and the report generates as usual, and only the Kartra push is
  // skipped, so a genuine bot still can't reach the CRM or the 6plan email.

  // Scheduled backfill sweep (a cron hits this): regenerate rows whose AI never
  // completed — so a report is never left stranded on the composed fallback just
  // because the visitor closed the page before the ~40s generation finished.
  // Token-gated, idempotent (skips rows already 'ok'), and bounded per run to
  // stay within the function timeout.
  if (event.stage === 'backfill') {
    // Gate token = SHA-256 of the (already-resolving) ANTHROPIC_API_KEY. Avoids
    // adding a new build-time env var (DO wouldn't resolve one added after the
    // fact). The public repo shows only the one-way derivation, never a value;
    // the matching hash is stored as the caller's BACKFILL_TOKEN secret.
    // Gate: sha256 of a random secret. The plaintext secret lives only in the
    // GitHub Actions secret BACKFILL_TOKEN; only its (one-way) hash is in the repo.
    const BACKFILL_TOKEN_HASH = '83d9290cfc870e125b41e923b30d38e536ce9884bcad82d036b6a2d7fe265ebe';
    const provided = event.token
      ? crypto.createHash('sha256').update(String(event.token).trim()).digest('hex') : null;
    if (!provided || provided !== BACKFILL_TOKEN_HASH) {
      return { statusCode: 403, headers: corsHeaders(), body: { ok: false, error: 'forbidden' } };
    }
    try {
      const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'));
      const token = await getAccessToken(sa);
      const listUrl = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/${SHEET_TAB}%21A:AB`;
      const rows = ((await (await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } })).json()).values) || [];
      const cands = [];
      for (let i = 1; i < rows.length; i++) {                 // skip the header row
        if (i === rows.length - 1) continue;                  // skip the freshest row (may still be generating)
        const r = rows[i];
        if (!/^rpa-[A-F0-9]{8}$/i.test(r[0] || '')) continue;
        if ((r[25] || '').trim() === 'ok') continue;          // col Z ai_status — already fully generated
        cands.push({ r, rowNumber: i + 1 });
      }
      const batch = cands.slice(0, 2);                        // bound per run (2 * 4 parallel AI calls) to fit the timeout
      const settled = await Promise.allSettled(batch.map(async c => {
        const ev = rowToEvent(c.r);
        const v = validate(ev);
        if (v.errors.length) return { id: c.r[0], skipped: v.errors[0] };
        await runAiGeneration(process.env.GOOGLE_SHEET_ID, token, c.rowNumber, v, ev);
        return { id: c.r[0], done: true };
      }));
      const processed = settled.map(x => x.status === 'fulfilled' ? x.value : { error: String(x.reason && x.reason.message).slice(0, 80) });
      return { statusCode: 200, headers: corsHeaders(), body: { ok: true, pending: cands.length, processed } };
    } catch (err) {
      console.error('Backfill sweep failed:', err.message);
      return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: err.message.slice(0, 120) } };
    }
  }

  // Admin list: returns a compact roster of all report rows (id, date, name,
  // email, main score) for the internal /admin page. Passcode-gated because it
  // exposes lead emails (PII) and the endpoint is public — same one-way-hash
  // scheme as the backfill gate (plaintext passcode never lives in the repo).
  if (event.stage === 'adminlist') {
    const ADMIN_TOKEN_HASH = 'c90c9960e766cea26f9e9cdfd556a60e86155db5eb02e6cc28ca88cc0b466a23';
    const provided = event.token
      ? crypto.createHash('sha256').update(String(event.token).trim()).digest('hex') : null;
    if (!provided || provided !== ADMIN_TOKEN_HASH) {
      return { statusCode: 403, headers: corsHeaders(), body: { ok: false, error: 'forbidden' } };
    }
    try {
      const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'));
      const token = await getAccessToken(sa);
      const listUrl = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/${SHEET_TAB}%21A:Z`;
      const rows = ((await (await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } })).json()).values) || [];
      const out = [];
      for (let i = 1; i < rows.length; i++) {                  // skip the header row
        const r = rows[i];
        if (!/^(?:rpa|pl)-[A-F0-9]{8}$/i.test(r[0] || '')) continue;
        const num = v => { const n = parseFloat(r[v]); return Number.isFinite(n) ? Math.round(n) : null; };
        out.push({
          id: r[0],
          ts: r[1] || '',                                       // friendly "...ET" string
          firstName: r[2] || '',
          email: r[3] || '',
          score: num(14),                                       // col O maturity_overall (the headline dial score)
          phase: r[5] || '',                                    // col F phase
          industry: r[23] || '',                                // col X
          aiStatus: (r[25] || '').trim()                        // col Z
        });
      }
      out.reverse();                                            // newest first
      return { statusCode: 200, headers: corsHeaders(), body: { ok: true, count: out.length, rows: out } };
    } catch (err) {
      console.error('Admin list failed:', err.message);
      return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: err.message.slice(0, 120) } };
    }
  }

  // Background AI-generation stage: the client fires this as a second request
  // right after the main submit returns the id, so the id isn't held up ~20s by
  // the Claude calls. Runs the three generations for the already-stored row and
  // patches its AI cells. Non-fatal; the report uses static fallbacks until
  // these land.
  if (event.stage === 'ai') {
    const av = validate(event);
    if (av.errors.length) return { statusCode: 400, headers: corsHeaders(), body: { ok: false, errors: av.errors } };
    const aiId = String(event.id || '').trim();
    if (!/^rpa-[A-F0-9]{8}$/i.test(aiId)) return { statusCode: 400, headers: corsHeaders(), body: { ok: false, error: 'bad-id' } };
    try {
      const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'));
      const token = await getAccessToken(sa);
      // Read the row + its ai_status (col Z). Generate ONCE per id — if ai_status
      // is already set, skip, so replaying stage:'ai' on a finished row can't
      // burn more Claude calls (it needs a valid, existing, un-generated id).
      const listUrl = `https://sheets.googleapis.com/v4/spreadsheets/${process.env.GOOGLE_SHEET_ID}/values/${SHEET_TAB}%21A:Z`;
      const listRows = ((await (await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } })).json()).values) || [];
      const idx = listRows.findIndex(r => (r[0] || '').toLowerCase() === aiId.toLowerCase());
      if (idx < 0) return { statusCode: 404, headers: corsHeaders(), body: { ok: false, error: 'not-found' } };
      // Skip regeneration only if a PRIOR run fully succeeded (ai_status 'ok').
      // A partial/failed status ('category:ok | focus:FAIL...') is allowed to
      // regenerate, so a self-heal re-fire can fix the missing piece.
      if ((listRows[idx][25] || '').trim() === 'ok') {
        return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id: aiId, note: 'already-generated' } };
      }
      await runAiGeneration(process.env.GOOGLE_SHEET_ID, token, idx + 1, av, event);
      return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id: aiId } };
    } catch (err) {
      console.error('AI stage failed (non-fatal):', err.message);
      return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'ai-failed' } };
    }
  }

  const v = validate(event);
  if (v.errors.length) {
    return { statusCode: 400, headers: corsHeaders(), body: { ok: false, errors: v.errors } };
  }

  // Suspected bot = the hidden honeypot field came back filled. We no longer
  // drop these (autofill trips it for real people); the row is still written and
  // the report still generates — only the Kartra push is skipped below.
  const suspectedBot = !!event.website;

  const id = 'rpa-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  let emailCheck = { status: 'not-run', good: true };
  try {
    emailCheck = await verifyEmail(v.email);
  } catch (err) {
    console.error('Email verification failed (non-fatal, failing open):', err.message);
    emailCheck = { status: 'zb-error: ' + err.message.slice(0, 80), good: true };
  }

  // Sheets auth once for the writes below.
  let sheetToken;
  try {
    const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'));
    sheetToken = await getAccessToken(sa);
  } catch (err) {
    console.error('Sheets auth failed:', err.message);
    return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'storage-failed' } };
  }

  // Write the lead row FIRST — before the Kartra push — so the report row (and
  // its /r/ link) exists before Kartra can fire the 6plan email. If storage
  // fails we bail here and never touch Kartra, so a lead can't get an email
  // pointing at a report that doesn't exist. kartra_status starts as a
  // placeholder and is patched after the push. AI cells start empty ('{}') —
  // the client's separate stage:'ai' request fills them, so the id returns fast.
  let rowNumber;
  try {
    rowNumber = await appendRow(process.env.GOOGLE_SHEET_ID, sheetToken, [
      id,
      new Date().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' ET',
      v.firstName,
      v.email,
      v.score,
      v.phase,
      ...v.principles.map(p => Number(p.score)),
      v.pattern,
      JSON.stringify(event.answers || []),
      `pending | zb:${emailCheck.status}`,
      v.maturity,
      ...v.principleMaturity.map(p => Number(p.maturity)),
      '{}',
      '{}',
      v.plantSize,
      v.industry,
      v.role
    ]);
  } catch (err) {
    console.error('Sheet write failed:', err.message);
    return { statusCode: 502, headers: corsHeaders(), body: { ok: false, error: 'storage-failed' } };
  }

  // Now push to Kartra — non-fatal, and safe because the row already exists.
  // Skipped for a suspected bot (honeypot filled): the row and report still
  // exist, but no CRM contact is created and no 6plan email fires.
  let kartraStatus;
  if (suspectedBot) {
    kartraStatus = 'kartra-skipped-honeypot';
  } else if (emailCheck.good) {
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

  // Patch the kartra_status column (N) with the real result — best-effort; the
  // row is already durable, so a failure here just leaves the placeholder.
  if (rowNumber) {
    try {
      await updateKartraStatus(process.env.GOOGLE_SHEET_ID, sheetToken, rowNumber, kartraStatus);
    } catch (err) {
      console.error('kartra_status write failed (non-fatal):', err.message);
    }
  }

  // emailBad = the address came back CLEARLY undeliverable (invalid/spamtrap/
  // abuse/do_not_mail). The frontend uses it to gate the "book a call" CTA.
  // Catch-all/unknown/valid all pass (good), so real corporate emails aren't
  // blocked.
  return { statusCode: 200, headers: corsHeaders(), body: { ok: true, id, emailBad: !emailCheck.good } };
}

exports.main = main;
