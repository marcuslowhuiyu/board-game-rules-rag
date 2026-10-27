# Source reliability, provenance and house rules

_Design, 2026-10-27. Status: draft for operator approval. Builds on MASTER_PLAN §7 (source authority tiers), §8 (ruling classification), §2.5 (newest official rules win) and ADR-0004 (sessions)._

## Why

M3 slice 4 ingested Stonemaier's Wingspan rules page and labelled it "official FAQ". Because of a parser bug, the only text stored was one reader's comment. So a community post went into the system marked as official, and nothing noticed.

The root problem goes beyond that bug. A source's reliability label today is a **claim made by whoever adds it**, and it covers the whole document. The add-source screen even fills in "official" automatically when "FAQ" is chosen. The operator wants sources to be found and added by the system (M6 discovery), not by people, so no human will vouch for each one. The system therefore has to **earn** each source's rank from evidence it checks itself.

The other goal is that players trust a ruling mid-game. That needs **transparency**: where each source came from, and how confident the app is. When sources disagree, players must see every side and choose, including community house rules they may prefer.

## Goals

1. **Each source earns its tier from checked evidence**, using MASTER_PLAN §7's five tiers. Examples of evidence:
   - publisher-hosted vs a copy elsewhere;
   - an official or verified designer or publisher account vs an anonymous post;
   - a copy whose text matches the official file.

   The evidence is stored with the rank, so "why do you trust this?" always has an answer.
2. **Rank per post, not per page.** On a page that mixes kinds of content (staff answers and reader comments, a designer's reply in a forum thread), each part gets its own tier.
3. **Answers show provenance and confidence**, in the layout the operator chose:
   - **First view:** the applied ruling, one confidence meter, and its source in a few words ("Days of Wonder ruling, Jul 2025"). A ⚠️ "Sources disagree" marker appears only when sources conflict, with a "See what each source says ▸" link (just "See sources" when they agree).
   - **Expanded view:** the same answer at the top, then one panel per tier. Each panel shows that tier's answer, its own confidence, and how its sources were checked. The applied tier is highlighted.
   - The mockups are in `.superpowers/brainstorm/` (not committed). The chosen one is `provenance-expand.html`; the agree-state wording is on the same screen.
4. **Which ruling is applied** (operator's decisions):
   - **Edition first.** Only sources for the edition the table is playing count. A ruling for a different edition never competes; sessions already pick an edition and retrieval filters by it.
   - **Same edition, official tier (rulebook, rules reference, official FAQ, errata).** A newer errata or FAQ entry corrects older rulebook wording and is applied (MASTER_PLAN §2.5). _(Builder's call: errata are corrections by definition, so this is not left to the players.)_
   - **Same edition, a designer or publisher ruling that contradicts the rulebook.** No default. Both appear side by side in the first view under ⚠️, each with its confidence, and the players choose. Their choice can be saved like a house rule.
   - **When only one tier covers the question,** that tier's answer is applied, as in the Ticket to Ride locomotive example.
5. **House rules next to official rules.**
   - Show the house rule when the community broadly agrees on a variant of a rule the official sources *do* cover. It appears next to the official answer with a caveat: what players do instead, why, its confidence, and "not official".
   - The players choose which to use. The app never swaps one in on its own.
   - **Contents of a house-rule box** (mockup `house-rule-v3.html`), each section marked "Not official":
     - the rule;
     - how it plays;
     - why players use it;
     - the trade-off;
     - where it comes from (thread count and date range);
     - its confidence;
     - a "Use at our table" button.
   - **Three colour schemes** — neutral grey with an amber tag, slate blue with a side stripe, amber outline. All are acceptable, and the user switches between them in the app's options, saved like other preferences. Each must hold its contrast in light and dark themes.
6. **House rules the table states itself** (operator's decision).
   - **What gets recorded:** if players say they play with a house rule, in their own words or in a question ("we let both double-route tracks open late"), the app records it as one of their saved preferences, even if it never came from the community.
   - **The record:** the rule's wording as stated, the rule it changes, and when it was added.
   - **Confirmation:** the app confirms the record in one line ("Saved as your table's house rule"), so a passing remark isn't recorded silently.
   - **On later answers:** it is applied like a chosen community house rule, labelled "your table's house rule (added by you)", with the official rule shown underneath.
7. **Saved preferences, per user.**
   - When a table picks a house rule, later answers apply it, with a note saying so.
   - Preferences must last across visits. Until accounts exist they live in the current session; that is "guest" mode, 24 h, ADR-0004.
   - One user's preferences never affect another user's answers.

## Non-goals

- **User accounts now.** Account management becomes the last milestone, after M10. Until then, preferences are session-scoped guest preferences.
- **Re-verifying sources at question time.** Verification happens when a source is ingested or refreshed.
- **Ranking within a tier.** There is no ordering of, say, two official rulebooks; §2.5 recency already settles conflicts there.

## Anti-goals: it fails even if it runs

- **Community content presented as official**, through a page-level label, a rehost, or an unverified account (§7: "never silently treat Tier 3–5 sources as Tier 1").
- **A confidence meter that can't explain itself.** Every confidence shown must trace back to stored evidence.
- **One user's house rule leaking into another's answer.** The planned M6 ruling cache is shared across users. It may hold only the **user-independent** answer: every tier's panel, including community panels and answers that rest on community consensus where official sources are silent. A table's chosen house rule is applied on top, per user, and is never cached. _(Builder's call at design review: caching every tier keeps a cache hit's expanded view complete and avoids repeat research, which matters for MASTER_PLAN §2.6 cost.)_
- **Hiding disagreement.** If tiers conflict, the first view must show the ⚠️ marker, even when the applied ruling has high confidence.
- **Applying a house rule without the player choosing it.**

## Decisions made with the operator

| Decision | Choice |
|---|---|
| Operator-added official sources | Rank the same as a verified official source found online. Provenance shows "added by the app operator" as the evidence |
| Conflicting designer/publisher ruling vs rulebook | Match the table's edition first. In the same edition, show both and let the players choose |
| Who adds sources | The system (M6 discovery); its rank must be earned, not declared |
| Unverifiable sources | Shown and clearly labelled, but they never decide the ruling |
| Answer layout | Compact first view; per-tier detail on tap (mockup `provenance-expand.html`) |
| Conflicting tiers | Each tier shows its own answer and confidence; the app says which it applies and why |
| House rules | Shown with a caveat next to the official rule; players choose |
| Preferences | Saved per user, never shared. Session-scoped "guest" until accounts; accounts are the last milestone |

## Where each piece lands

| Milestone | Piece |
|---|---|
| **Before M4 (small ingestion change)** | Record provenance evidence on each document, and on each part where a page mixes kinds. Stop the add-source screen deriving "official" from the chosen type alone. |
| **M4: rules answering** | The two-state answer view; per-tier answers and confidence; the applied-ruling rule; conflict marker. Confidence calibration is measured in M4's evals. |
| **M6: web research and cache** | Discovery plus verification: official host, official or designer accounts, rehost detection. Per-post tiers for forum and comment pages. Community-consensus detection for house rules. The ruling cache holds the user-independent answer (see Anti-goals). **Guest preferences also land here:** house rules only exist once M6 detects them. _(Builder's call: moved from M5, which has nothing for a table to choose yet.)_ A saved preference attaches to a stable house-rule record per game, edition and rule. |
| **New last milestone: accounts** | Durable per-user preferences; how guest preferences carry over is decided there. |

## Disagreement and house rules: definitions

_Builder's calls, made at design review._
- **⚠️ "Sources disagree" appears only when two tiers give different answers to the same question.**
  - A tier that is silent is not a disagreement. It shows as "The rulebook doesn't cover this" in the first view, without ⚠️. (The earlier mockup used ⚠️ for silence; that is corrected here.)
  - An unverified source alone never triggers ⚠️.
  - Community posts dated before a later official ruling are shown as "earlier discussion" and don't trigger ⚠️.
- **What players can choose:** a community **variant** of a rule (a house rule) or a community **reading** that differs from the official text. Both are offered with the same caveat, because the operator wants players to decide by preference. Either way, the official answer stays the applied ruling unless the table opts in.

## Operator-added sources

- **Before M6 can verify anything,** sources the operator adds count as evidence at the type they were added as. An official rulebook uploaded by the operator ranks the same as one verified from the publisher's site, and the provenance view says "added by the app operator".
- **What happens to the `authority` input on ingestion.** It stays as the *operator's declaration*, stored as an evidence item of kind "operator-attested". It is no longer silently derived on the add-source screen. _(Builder's call.)_
- **Who may attest:**
  - The system's own discoveries (M6) never attest themselves. They earn their tier from checks.
  - M6's "a human confirms low-confidence finds" step is an operator attestation.
  - If players ever add sources themselves, that is not operator attestation. Its tier ceiling is left to the accounts milestone. _(Builder's call.)_

## Constraints

- The tier scale stays §7's five tiers. The existing `authority` field and its values remain the stored tier. What's new is the **evidence** behind it and **per-part** ranking.
- Retrieved and fetched content is untrusted data (CLAUDE.md). Verification evidence must come from checks the system performs (host, account, file match), never from what the content says about itself.
- Model ids, thresholds and similar settings live in config.

## Left to the builder

- The provenance evidence schema (fields, enums) and where it lives (document, chunk or both).
- How confidence is computed, within the constraint that it is explainable from stored evidence. Calibrate it against M4/M7 evals.
- Rehost detection (e.g. matching a copy's text or hash against the official file) and how official accounts are recognised.
- What "broad community agreement" means numerically for offering a house rule.
- The exact copy and wording on the answer screens.
