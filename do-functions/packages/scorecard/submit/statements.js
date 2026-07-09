// Per-statement content used to feed the live Claude call that writes each
// report's category-level "Good" / "Opportunity" text. Source: Z:\10 pL\plant
// manager blueprint\RPA Statement Background & Scoring.docx (Jim's doc).
// Order matches PRINCIPLES.flatMap() in index.html exactly — index 0-19,
// Standardization(0-3), People Involvement(4-7), Short Lead Time(8-11),
// Built-In Quality(12-15), Continuous Improvement(16-19). The frontend sends
// each answer's stable statement index ("si") so a shuffled quiz order can
// still be mapped back to this array.

'use strict';

const STATEMENTS = [
  // Standardization
  {
    principle: "Standardization",
    text: "Standardized work is documented, posted (workstation), and followed by the production operator.",
    why: "Standard work is the \"current best known method\" — not a cage, but the baseline everything else stands on. Skip it and training time doubles, tribal knowledge walks out the door with turnover, and there's no way to tell normal from abnormal.",
    strength: "Training time drops sharply because there's one correct way to teach, not a personality-dependent one. Cycle time variation shrinks because everyone's running the same method. Abnormalities become visible in real time instead of hiding inside \"operator style.\"",
    weakness: "Pick one pilot station — ideally your highest-turnover or highest-variability one. Watch your best operator, document what they actually do, write it with them, post it, and train the rest of the team to it. Have a leader verify adherence for two weeks — that's the step everyone skips, and it's the one that locks in the standard."
  },
  {
    principle: "Standardization",
    text: "Work areas are clean / organized and properly marked / labeled with an audit process in place to score the condition and maintain the standard.",
    why: "5S without an audit is a one-time event, not a standard — it decays within weeks. Hidden problems (leaks, near-misses, safety hazards) stay buried in clutter, and search waste eats real capacity every shift without ever showing up on a schedule.",
    strength: "Problems surface the moment they happen instead of hiding until they force a bigger failure. Operators spend their time producing, not searching. Auditors, customers, and new hires read the floor as disciplined and trustworthy at a glance.",
    weakness: "Pick one area — the most cluttered or highest safety risk. Run one structured 5S event (sort, set in order, shine, standardize), add shadow boards or floor marking, then build a short 5-10 item audit checklist with a named owner and a weekly scoring cadence, posted visibly."
  },
  {
    principle: "Standardization",
    text: "Production Operators perform routine equipment care, including cleaning, inspecting, and basic maintenance, as part of their daily work.",
    why: "This is autonomous maintenance — the plant's earliest possible warning system for equipment failure. Skip it and small problems become big failures, maintenance stays trapped in firefighting, and the earliest, cheapest warning signal is lost before it reaches anyone.",
    strength: "Unplanned downtime drops because small issues are caught before they cascade into failures. Maintenance's time shifts from reactive repair to real preventive work. Operators develop genuine ownership over \"their\" machine.",
    weakness: "Pick one piece of equipment — ideally your least reliable or highest-downtime asset. Walk it with maintenance to identify 3-5 checks an operator can safely do (look, listen, clean, tighten, lubricate), build a simple daily checklist, and have a leader review it for the first month to build the habit."
  },
  {
    principle: "Standardization",
    text: "Work areas have a visual dashboard that displays business plan, metric targets / performance, and countermeasures for missed targets.",
    why: "A dashboard is where the other Standards statements become visible and actionable instead of staying private knowledge. Without one, performance stays invisible to the people who drive it, and a missed target with no visible countermeasure quietly signals that red is acceptable.",
    strength: "Everyone on the floor — not just leadership — knows in real time whether they're winning or losing, which turns problem-solving into a daily habit instead of a monthly surprise. Wins get seen and celebrated, not just misses.",
    weakness: "Pick one area and the 2-3 metrics that matter most there. Build a simple, visible board (a whiteboard is fine to start) with a clear target for each metric, and require one written countermeasure — owner and date — for anything red before the next shift starts."
  },
  // People Involvement
  {
    principle: "People Involvement",
    text: "Production operators participate in team-based weekly problem solving using a standard form / process posted in their area.",
    why: "The people closest to the work see problems no report or leader walk ever will — but that knowledge is worthless without a structured way to surface it. Skip it and the same problem gets \"solved\" repeatedly, and good ideas from the floor never reach leadership.",
    strength: "Problems get solved at the level closest to where they occur, permanently, instead of being escalated, patched, and repeated. The team builds real ownership over their own area because they're the ones solving its problems.",
    weakness: "Pick one team and one recurring problem everyone already agrees is worth fixing. Use a single-page form (a simple PDCA template works well), set a fixed weekly 15-minute slot and protect it from production pressure, and make sure every action item has a named owner and due date."
  },
  {
    principle: "People Involvement",
    text: "Leaders coach and teach through daily participation in dashboard reviews as well as formal instruction of the company's production / operating system.",
    why: "Leadership presence is what separates a real operating system from a poster on the wall. Skip it and words and actions diverge — the floor reads the gap accurately and calibrates its own effort to match, and dashboards decay into wallpaper within weeks.",
    strength: "The whole organization sees leadership behavior matching leadership words — the single strongest predictor of whether a lean effort survives past its first year. Problems get caught early because a leader is physically present before they escalate.",
    weakness: "Pick one leader and one area to start. Set a fixed, protected 10-minute daily dashboard walk that's a conversation (what's red, why, what's the countermeasure) not an inspection, and track the leader's own attendance and consistency the same way you'd track any other standard."
  },
  {
    principle: "People Involvement",
    text: "Employees have a clearly defined help chain and a call for help mechanism along with an agreed escalation process and documented acceptable response times.",
    why: "Without a real help chain, an operator facing a problem only has two options — stop and wait, or push through alone — and both are bad. Silent workarounds become normal, hiding exactly the issues leadership most needs to see.",
    strength: "Problems get real-time support instead of silent workarounds, protecting throughput and quality at the same time instead of forcing a trade-off. Operators feel backed up rather than exposed, which measurably increases how willing they are to flag a problem immediately.",
    weakness: "Pick one area and define the trigger conditions for a call for help. Choose a simple, visible signal (a light, a flag), define who responds and in what order, and set a documented response-time target, even a rough one, then track actual response times and refine."
  },
  {
    principle: "People Involvement",
    text: "Employees have clearly defined roles and responsibilities for their position, which includes the requirement to participate in continuous improvement of their job.",
    why: "If continuous improvement isn't explicitly written into the job, it's treated as optional extra work — the first thing dropped the moment schedule pressure hits. Accountability has no anchor, and new hires never learn it's expected.",
    strength: "Improvement becomes part of \"how we work here\" rather than a program that competes with production for time and attention. The organization taps into a steady stream of small, compounding gains from the people who understand each job best.",
    weakness: "Pick one role or team to start with. Add one explicit, simple CI expectation to that role's description — even something as small as one improvement idea per month — tied to something concrete and trackable, then reference it in that person's next review."
  },
  // Short Lead Time
  {
    principle: "Short Lead Time",
    text: "Material flows directly from one operation to the next without interim staging or double handling with clearly defined and adhered to buffer min / max rules.",
    why: "Every interim staging point is inventory sitting still — a place for defects to hide, cash to tie up, and extra handling to add cost without adding value. Lead time balloons invisibly because staging time between operations rarely gets measured.",
    strength: "Lead time drops because material isn't sitting idle between operations. Defects get caught closer to the point they're actually created. The plant needs less space and less material tied up to produce the same output.",
    weakness: "Pick one value stream and physically map the current flow. Identify the single biggest staging point, define a real min/max based on actual consumption, and physically shrink the space available for staging to force the new limit to hold."
  },
  {
    principle: "Short Lead Time",
    text: "Inventory locations (raw, WIP, finished) are clearly labeled (part number, min/max) with limits followed and correct location used.",
    why: "Unlabeled or over-full inventory locations hide two costs at once — cash tied up in excess stock, and time wasted searching for parts — both invisible until someone actually measures them. Search time is a hidden tax on every shift.",
    strength: "Anyone can walk the floor and instantly see what's in stock, what's short, and what's overflowing. Search time drops because there's one correct place for everything, and it becomes safe to build pull systems and replenishment rules on top of trustworthy data.",
    weakness: "Start with your highest-volume or highest-value parts. Label each location clearly with part number and a visible min/max range, physically define the space so \"correct location\" is unambiguous, and check compliance weekly until it becomes habit."
  },
  {
    principle: "Short Lead Time",
    text: "Material replenishment is triggered by actual consumption via Electronic Pull System (EPS) or Kanban, not by pushing to a schedule.",
    why: "Push scheduling builds inventory based on forecasts that are always somewhat wrong — pull systems respond to what's actually being consumed. Forecast error becomes physical inventory, and slow-moving stock accumulates quietly.",
    strength: "Inventory naturally sizes itself to actual demand, freeing cash and floor space without anyone having to manually rebalance it. Demand shifts get noticed and reacted to far faster than under a periodic push schedule.",
    weakness: "Start with one stable, moderate-volume part number. Calculate a simple kanban quantity from actual consumption rate and replenishment lead time, set up a basic signal that fires replenishment only when the part is consumed, and run it alongside the existing process before fully cutting over."
  },
  {
    principle: "Short Lead Time",
    text: "Production areas are actively (weekly progress) working to reduce tool / equipment changeover times and batch processing.",
    why: "Long changeovers force large batch sizes to \"make them worth it\" — exactly backwards, since large batches create the staging, inventory, and quality-detection-lag problems the rest of Logistics is trying to eliminate.",
    strength: "Smaller batches become economically viable, which shrinks lead time, inventory, and the gap between making a defect and discovering it. The plant gains real scheduling flexibility to respond to actual demand.",
    weakness: "Pick your worst changeover and time it honestly, step by step, before changing anything. Separate steps that must happen while equipment is stopped from steps that could happen while it's still running, run one focused event to convert or eliminate stopped-equipment steps, then standardize the new method."
  },
  // Built-In Quality
  {
    principle: "Built-In Quality",
    text: "Quality standards are clear for each workstation with quality confirmation checks built into the standardized work.",
    why: "If quality checks aren't literally written into the standard work, they get skipped under schedule pressure. Without a shared definition of \"acceptable,\" the same part can pass at one station and fail at the next.",
    strength: "Quality isn't a separate step competing with production — it's inseparable from doing the job correctly, so it never gets sacrificed under pressure. Every operator, on every shift, is checking the same things the same way.",
    weakness: "Pick your highest-risk station — the one where a missed defect has the biggest downstream cost. Add one explicit, visible quality check directly into that station's standard work, make it physically impossible to skip, and verify adherence for two weeks."
  },
  {
    principle: "Built-In Quality",
    text: "Defects are prevented or contained at the point of cause with high-risk operations protected by error proofing that is verified on a shift/daily/weekly schedule.",
    why: "A defect caught at its source costs a fraction of one discovered downstream or by a customer — and error proofing that isn't verified regularly can silently fail, giving false confidence while defects flow through undetected.",
    strength: "Defects stop at their source instead of traveling — protecting cost, schedule, and customer trust at the same time. Silent device failures get caught quickly instead of running undetected for weeks.",
    weakness: "Identify your single highest-risk operation. Add one error-proofing device or check sized to that specific failure mode, define exactly what \"verified\" means, put a realistic verification schedule on it, and assign a named owner for the verification."
  },
  {
    principle: "Built-In Quality",
    text: "Work areas have a layered audit process used by leadership to confirm adherence to standardized work, process checks, business plan, and performance meeting cadence and content.",
    why: "Without leadership auditing the system itself — not just the output — standards and checks quietly erode over weeks, and nobody notices until a quality escape forces a painful root-cause investigation.",
    strength: "Drift gets caught and corrected in days, not discovered in a customer complaint months later. Every level of leadership works from the same objective picture of how the system is actually performing.",
    weakness: "Start with a simple leader audit checklist for one area — 3 to 5 of the most critical standards. Define a realistic weekly cadence, have the leader physically walk the area and check adherence directly, and record findings visibly alongside the area's dashboard."
  },
  {
    principle: "Built-In Quality",
    text: "Work areas have quality confirmation stations strategically located to provide timely feedback to production operations.",
    why: "Quality feedback that arrives hours or shifts after production gives operators no chance to correct course — the same mistake repeats dozens or hundreds of times before anyone finds out.",
    strength: "Operators learn and correct in real time, turning quality from a downstream inspection function into an active feedback loop embedded in production itself. Defect volume per incident stays low.",
    weakness: "Map how long it currently takes a defect to get discovered and reported back, for your worst-case process. Identify the biggest single source of delay, move the check point physically closer to the point of creation if possible, and build a fast feedback path back to the operator."
  },
  // Continuous Improvement
  {
    principle: "Continuous Improvement",
    text: "Problems are solved with the Plan Do Check Act (PDCA) approach, from informal quick fix to formal root cause analysis.",
    why: "Without a structured method, \"problem solving\" defaults to whoever's loudest or most experienced guessing at a fix — which often treats symptoms, leaves the root cause intact, and guarantees the problem returns.",
    strength: "The organization gets measurably better at solving its own problems over time instead of re-solving the same ones repeatedly. Fixes get verified before they're trusted, so the plant doesn't quietly trade one problem for another.",
    weakness: "Pick one recurring problem that keeps coming back despite previous attempts to fix it. Define the problem and a likely root cause, try one specific change on a small scale, honestly check whether it worked, then standardize it or use what you learned to try again."
  },
  {
    principle: "Continuous Improvement",
    text: "Performance metrics are updated to a dashboard in real time (at least hourly), visible, and reviewed regularly (at least once per shift) by the teams that influence them.",
    why: "Metrics reviewed weekly or monthly are historical records, not management tools — by the time a problem shows up in a monthly report, it's cost weeks of lost performance that could have been caught on day one.",
    strength: "Problems get caught and addressed within the shift they occur, not weeks later — turning management from reactive to real-time. The team closest to a metric has the visibility to self-correct before anyone above them needs to intervene.",
    weakness: "Start with your single most important metric in one area. Update it hourly even if manually at first, post it somewhere the team naturally passes by, and require the shift team to glance at it before every break as a low-friction review checkpoint."
  },
  {
    principle: "Continuous Improvement",
    text: "Missed-target metric performance triggers countermeasures posted in the area with a clear owner and due date.",
    why: "A red metric with no required countermeasure is just decoration — it tells everyone something's wrong without requiring anyone to fix it, which trains the organization to tolerate red instead of act on it.",
    strength: "Every red metric automatically triggers action with a named owner — nothing sits unaddressed, and accountability is visible to everyone on the floor. The whole team develops confidence that red gets a response.",
    weakness: "Pick one metric that's currently red with no action attached. Require a posted countermeasure — what's being done, who owns it, by when — before the next shift, keep the rule simple (any red metric gets one, no exceptions), and follow up on the due date."
  },
  {
    principle: "Continuous Improvement",
    text: "Employees submit improvement ideas at least monthly through a structured floor-based process reviewed on a weekly basis by leadership.",
    why: "The people doing the work every day see more small improvement opportunities than any improvement team ever will — without a structured channel, those ideas stay in people's heads and the organization loses its best source of incremental gains.",
    strength: "Improvement becomes crowdsourced from the entire workforce, not just a dedicated team. Employees feel heard and see tangible evidence that their input matters, which reinforces further participation.",
    weakness: "Put a simple idea box or form in one area. Commit to reviewing submissions weekly, make sure every submitter gets a response (accepted, declined with a reason, or still evaluating), and track submissions and outcomes visibly."
  }
];

module.exports = { STATEMENTS };
