# Design Decisions — Transform Readiness Scorecard

Source of truth: planet LEAN brand blue `#1595D3`, sampled directly from the
official high-res logo files Jim supplied (transform-quiz/pL Logo FINAL-01.png
= globe mark 301px, pL Logo kartra HC.png = full lockup 1940x546; working
copies logo-mark.png / logo-full.png). Other neutrals reused from the chatbot
widget palette (pL-chatbot/do-functions/packages/widget/serve/widget-source.js).
Header: full lockup image at 48px height.

## Color tokens
| Token | Hex | Meaning |
|---|---|---|
| `--pl-accent` | `#1595D3` | Brand blue — primary action (buttons, progress bar, selected answer) |
| `--pl-accent-dark` | `#2c3e50` | Headings, primary text, dark UI chrome |
| `--pl-orange` | `#ff8c00` | Highlight / emphasis accent (used sparingly — e.g. phase badge) |
| `--pl-bg` | `#ffffff` | Page background |
| `--pl-bg-soft` | `#f5f6f7` | Card/section background |
| `--pl-text` | `#2c3e50` | Body text |
| `--pl-text-muted` | `#7f8c95` | Secondary text, helper copy |
| `--pl-border` | `#dfe3e6` | Borders, dividers |

## Type
**Inter** (Google Fonts, weights 400–800), falling back to the system stack.
- Landing headline: 33px / 800 / -0.5px letter-spacing.
- Question text: 25px / 700; principle eyebrow above it: 12px / 700 / uppercase / accent blue.
- Answer options: 15.5px; helper/progress text: ~13px muted.
- Section titles on results: 19px / 700 with accent-blue section numbers (01–06).

## Layout & components ("professional pass" — July 2026, modeled on PMB scorecard)
- **Landing screen before Q1**: headline + sub + three ✓ reassurance chips
  ("Under 5 minutes / No cost / Instant personalized report") + big start
  button + trust line. Never drop visitors straight into a question.
- Card: max-width 720px, radius 14px, soft two-layer shadow, 48px padding.
- One question per screen; principle name shown as eyebrow above the question.
- Answer options: lettered A–D key chips, 1.5px border, hover lift, selected
  state (blue fill on key + tinted background) shown for 220ms before
  auto-advance; entrance animation (fade/slide 250ms) per question.
- Back link (← Back) visible from Q2 onward; pops the previous answer.
- Email gate: "Your report is ready" framing + privacy microcopy.
- Results page: numbered sections 01–06 (Overview / Strengths / Breakdown /
  Insights / Action Plan / Download) with pill nav at top.
- Buttons/inputs: radius 10px; other cards 8px.
- Phase labels (Formative/Localized/Broad-based/Benchmark) are internal-only
  during the quiz — never shown to the visitor mid-quiz, only on the final
  results page.

## Change here first
Adjust colors/type/spacing in this file's table first, then apply consistently
across index.html — don't hand-tune individual elements.
