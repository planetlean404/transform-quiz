# Transform Readiness Scorecard — Kickoff

**What & who:** A lead-gen quiz for planetlean.com (lean manufacturing consultancy).
Plant managers / ops leaders answer a few multiple-choice questions and get a
personalized "Transformation Readiness" result tied to planet LEAN's existing
4-phase model. Modeled after https://scorecard.plantmanagerblueprint.com/.

**Primary user:** Plant managers / operations leaders — professional B2B audience,
likely arriving from a LinkedIn link. Design for desktop first, but must work
cleanly on mobile since LinkedIn traffic is often on phone.

**Core flow (target, full build):**
1. Answer quiz questions, one per screen, progress bar.
2. Email gate: first name + email you check frequently.
3. Personalized results page (rendered from scores) + PDF download.
4. Lead + phase tags pushed to Kartra via API (background call, doesn't block reveal).

**This pass (prototype):** Just the question-flow UI — 3 sample questions, 4
answers each, tied to the 4-phase model (Formative → Localized → Broad-based →
Benchmark), ordered low-to-high maturity. No scoring math, no PDF, no Kartra call
yet — those come after Jim reviews question content and flow feel.

**Platform/stack intent (later, once flow is locked):**
- Next.js app, hosted on DigitalOcean App Platform (same provider as pL-chatbot).
- Subdomain `transform.planetlean.com`, CNAME added in eNom (eNom hosts DNS for
  planetlean.com).
- Kartra REST API for lead handoff (tags by phase, e.g. `phase-formative`), so
  existing Kartra automations can segment nurture sequences by result.

**Hard don'ts:**
- No medical/compliance-style claims — this is a business maturity assessment.
- Don't build scoring/PDF/Kartra logic in this pass — question UI only.
- Stay on-brand — reuse planetlean.com's existing visual language (see
  DESIGN-DECISIONS.md), don't invent a new palette.
