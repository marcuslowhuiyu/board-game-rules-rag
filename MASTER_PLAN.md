# Board Game Rules RAG — Master Engineering Plan

**Status:** Initial implementation plan  
**Version:** 0.1  
**Date:** 15 September 2026  
**Primary implementation agent:** Claude Code  
**Hosting:** AWS  
**Source control:** User-owned GitHub repository

---

# 1. Product Vision

Build a mobile-friendly web application that acts as a reliable **board-game rules referee** during active play.

A user selects:

1. a board game;
2. its edition;
3. the expansions in use;
4. promo content in use;
5. optional modules or other gameplay content in use;

and can then ask natural-language questions such as:

- “Can I use this ability before movement?”
- “Does the attacker or defender assign hits?”
- “Does this ability trigger before damage is dealt?”
- “Does this promo card override the normal rule?”
- “Does the expansion change how this base-game rule works?”

The system shall retrieve the relevant rules, reason over them, and return a concise answer with supporting citations.

The system must prioritize **correctness, evidence, and uncertainty awareness over giving the user an answer at all costs**.

If no defensible ruling can be established, the system must explicitly say so.

---

# 2. Product Principles

The system shall follow these principles.

## 2.1 Evidence first

Every substantive rules ruling should be grounded in identifiable source material.

Where practical, answers should provide:

- source title;
- page number;
- section/heading;
- applicable content;
- source type;
- authority level;
- web link where relevant.

## 2.2 No unsupported speculation

The model must not invent a ruling simply because the user expects an answer.

When available evidence is insufficient, contradictory, or genuinely ambiguous, the result should be classified accordingly.

## 2.3 User statements are not authoritative

Statements contained in the user's question are claims to be verified.

Example:

> “Assault Cannon happens before PDS fire, right?”

The system must not assume the premise is correct.

If the rules contradict the user, the system should politely correct the misunderstanding and cite the relevant rule.

## 2.4 Game configuration matters

Rules from content not enabled for the session must not influence the answer.

Applicable configurable content includes:

- base game;
- expansions;
- promo content;
- mini-expansions;
- optional modules;
- other explicitly selectable gameplay packages.

Errata, FAQs, and rules updates applicable to enabled content are not optional gameplay content and should normally apply automatically.

## 2.5 Latest applicable official rules take precedence

Where sources conflict, newer applicable official rules or errata should supersede older wording.

## 2.6 Cost must remain proportional to usage

The architecture should strongly prefer:

- serverless;
- on-demand;
- event-driven;
- pay-per-request;

infrastructure.

Avoid always-on databases, containers, or search clusters unless evaluation demonstrates that they are required for acceptable quality.

---

# 3. Initial Scope

## Included

- Mobile-friendly web application
- English
- Anonymous user sessions
- Game selection
- Edition selection
- Expansion selection
- Promo-content selection
- Optional-module selection
- PDF rulebook ingestion
- Rulebook URL ingestion
- Living-rules web-page ingestion
- Expansion rulebooks
- Promo rules
- Official FAQs
- Official errata
- Rules references
- Designer/publisher rulings where verifiable
- RAG-based rules answering
- Citations
- Session conversation memory
- Automatic search for missing official errata/FAQ
- Bounded web research when local knowledge is insufficient
- Caching of previously researched rulings
- AI evaluation framework
- Model comparison framework
- GitHub CI/CD
- Infrastructure as Code
- AWS deployment

## Explicitly deferred

- Persistent user accounts
- Cross-session user memory
- User personalization
- Native mobile applications
- Multilingual rulebooks
- Voice interface
- Full structured live-game-state tracking
- Unrestricted autonomous agents
- Automatic bulk crawling of BGG/Reddit/forums
- Public-user moderation system
- Payment/subscription system

These may be added later without requiring a redesign of the core architecture.

---

# 4. User Flow

## 4.1 Starting a session

User searches for a game.

Example:

```text
Twilight Imperium: Fourth Edition
```

The user selects applicable content:

```text
Game:
Twilight Imperium: Fourth Edition

Content:
☑ Base Game
☑ Prophecy of Kings
☑ Codex I
☑ Codex II
☑ Codex III
☐ Thunder's Edge
☑ Selected promo content
```

This configuration is associated with the current anonymous session.

---

# 5. Adding a New Game

If the game is not present:

```text
Can't find your game?

[ Add New Game ]
```

The user may provide:

- game name;
- edition;
- publisher where known;
- PDF rulebook;
- rulebook URL;
- living-rules URL;
- expansion rulebook;
- promo rules;
- additional official sources.

The system should then:

```text
Receive source
     ↓
Validate source
     ↓
Identify game / edition / content
     ↓
Extract and normalize text
     ↓
Search for official FAQ / errata
     ↓
Deduplicate discovered sources
     ↓
Classify source authority
     ↓
Chunk content
     ↓
Create embeddings
     ↓
Index chunks
     ↓
Mark game ready
```

Game ingestion must be asynchronous.

The UI must display processing state rather than requiring the user to keep a request open.

---

# 6. Gameplay Content Model

Gameplay content must be represented as first-class entities.

Recommended enum:

```text
BASE
EXPANSION
PROMO
MODULE
MINI_EXPANSION
OTHER_OPTIONAL_CONTENT
```

Each content package should have:

```text
contentId
gameId
editionId
name
contentType
releaseDate
dependencies[]
status
```

Example:

```text
Game:
Imperium

Content:
- Classics
- Legends
- Horizons
- Trade Routes
- Promo Cards
```

Rules associated with disabled expansions, promos, or modules must not enter the reasoning context.

---

# 7. Source Authority Model

Do not equate website/platform with authority.

A designer statement posted on BGG is still a designer ruling.

Recommended hierarchy:

## Tier 1 — Official rules

- Current rulebook
- Rules reference
- Living rules
- Official FAQ
- Official errata
- Official rules update

## Tier 2 — Verified official interpretation

- Designer ruling
- Publisher ruling
- Official support ruling

## Tier 3 — Strong community interpretation

- Community consensus
- Well-supported BGG rules discussion
- Multiple interpretations converging on the same reading with rules citations

## Tier 4 — Community discussion

- Individual BGG posts
- Reddit discussions
- Other board-game forums

## Tier 5 — General web

- Blogs
- reviews;
- unsourced explanations;
- other informal material.

The system must never silently treat Tier 3–5 sources as Tier 1.

---

# 8. Ruling Classification

Authority and certainty should be separate fields.

Recommended certainty:

```text
DEFINITIVE
QUALIFIED
INCONCLUSIVE
```

Recommended authority:

```text
OFFICIAL_RULES
OFFICIAL_ERRATA
DESIGNER_OR_PUBLISHER
COMMUNITY_CONSENSUS
COMMUNITY_DISCUSSION
UNKNOWN
```

Example:

```json
{
  "certainty": "DEFINITIVE",
  "authority": "OFFICIAL_RULES"
}
```

versus:

```json
{
  "certainty": "QUALIFIED",
  "authority": "COMMUNITY_CONSENSUS"
}
```

This allows the UI to state:

> No official ruling was found. The strongest community interpretation is X.

without misrepresenting it as official.

---

# 9. High-Level Architecture

```text
                         ┌─────────────────────┐
                         │   Mobile Web App    │
                         └─────────┬───────────┘
                                   │
                                   ▼
                         ┌─────────────────────┐
                         │     API Layer       │
                         └─────────┬───────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
              ▼                    ▼                    ▼
        Session Service      Rules Service       Ingestion Service
              │                    │                    │
              ▼                    ▼                    ▼
          DynamoDB          Retrieval Layer           S3
                                   │                    │
                         ┌─────────┴─────────┐          ▼
                         │                   │     Parse / Chunk
                         ▼                   ▼          │
                    S3 Vectors          Ruling Cache    ▼
                         │                   │       Embeddings
                         └─────────┬─────────┘          │
                                   │                    ▼
                                   ▼                S3 Vectors
                             Bedrock Converse
                                   │
                         ┌─────────┴─────────┐
                         │                   │
                    Answer locally     Evidence weak
                                             │
                                             ▼
                                    Bounded Web Research
                                             │
                                             ▼
                                       Final Answer
```

---

# 10. AWS Architecture

Initial preferred stack:

## Region

Primary workload:

```text
ap-southeast-1 — Singapore
```

unless an implementation spike discovers a material service limitation.

Regional choices must remain configuration-driven.

## Frontend

Preferred:

```text
React + TypeScript + Vite
S3 static hosting
CloudFront
```

Do not introduce server-side frontend infrastructure unless a demonstrated requirement exists.

## API

```text
Amazon API Gateway HTTP API
AWS Lambda
```

Prefer Lambda over ECS/Fargate for the initial workload.

## Primary application data

```text
Amazon DynamoDB
```

Use on-demand capacity.

## Raw and processed documents

```text
Amazon S3
```

Buckets/prefixes should distinguish:

```text
raw/
normalized/
evaluation/
temporary/
```

## Vector storage

Initial candidate:

```text
Amazon S3 Vectors
```

Initial embedding model:

```text
Amazon Titan Text Embeddings V2
```

Initial vector size:

```text
1024
```

The vector size must be configurable so 512-dimensional embeddings can later be benchmarked.

## Generation

Initial model:

```text
Amazon Nova 2 Lite
```

through:

```text
Amazon Bedrock Converse API
```

The exact model identifier must exist in configuration, not application logic.

## Web research

Preferred AWS-native implementation:

```text
Amazon Bedrock AgentCore Web Search
```

behind an abstraction layer.

Because regional availability differs from the main application, the research implementation may require a small secondary regional deployment.

The rest of the application must not depend directly on AgentCore-specific APIs.

---

# 11. Model Abstraction

Application business logic must never directly depend on Nova.

Define a model boundary similar to:

```ts
interface RulesModel {
  answerRulesQuestion(input: RulesQuestionInput): Promise<RulesAnswer>;
  summarizeSession(input: SessionSummaryInput): Promise<SessionSummary>;
  assessEvidence(input: EvidenceInput): Promise<EvidenceAssessment>;
}
```

The Bedrock implementation should normally use Converse.

Example configuration concept:

```yaml
models:
  primary:
    provider: bedrock
    model: nova-2-lite

  research:
    provider: bedrock
    model: nova-2-lite

  judge:
    provider: bedrock
    model: configurable
```

Switching the generator must not require changes to:

- retrieval;
- ingestion;
- UI;
- session storage;
- citation logic;
- game metadata.

---

# 12. Structured AI Responses

The application must not depend on parsing uncontrolled natural-language output.

Use Bedrock structured outputs through Converse where supported.

Representative schema:

```json
{
  "certainty": "DEFINITIVE",
  "authority": "OFFICIAL_RULES",
  "answer": "The attacker assigns the hits.",
  "explanation": "The combat procedure specifies...",
  "evidence": [
    {
      "chunkId": "abc123"
    }
  ],
  "needsResearch": false
}
```

Validation must occur again in application code.

The frontend generates the user-facing representation from validated structured data.

---

# 13. Document Data Model

Each source document should record at minimum:

```text
documentId
gameId
editionId
contentId
title
sourceType
authority
version
publicationDate
effectiveDate
canonicalUrl
publisherDomain
contentHash
status
supersedes[]
createdAt
updatedAt
```

Recommended source types:

```text
RULEBOOK
RULES_REFERENCE
FAQ
ERRATA
LIVING_RULES
PROMO_RULES
DESIGNER_RULING
PUBLISHER_RULING
COMMUNITY_THREAD
OTHER
```

---

# 14. Chunk Data Model

Each rule chunk should preserve:

```text
chunkId
documentId
gameId
editionId
contentId
headingPath
pageStart
pageEnd
text
tokenCount
authority
sourceType
documentVersion
```

`isCurrent` was originally listed here and removed in M2: currency comes from `SourceDocument.status` only (ADR-0008 §Chunk currency).

A vector should carry only the metadata required for efficient filtering.

Larger source metadata should live in DynamoDB/S3 and be addressed through `chunkId`.

---

# 15. Chunking Strategy

Do not initially use arbitrary fixed-size splitting only.

The chunker should prefer logical rules boundaries:

```text
Heading
  → subsection
      → paragraph / list / table
```

Preserve:

- headings;
- rule numbers;
- bullet relationships;
- examples when they clarify the rule;
- defined terminology;
- capitalized rules keywords.

Initial target:

```text
~300–700 tokens per chunk
```

with limited overlap where necessary.

This is a starting point, not a fixed truth.

Chunking parameters must be benchmarkable.

Embedding text may prepend lightweight contextual information:

```text
Game: Twilight Imperium
Content: Prophecy of Kings
Section: Space Combat > Assign Hits

<rule text>
```

---

# 16. PDF Parsing Strategy

Use a tiered approach.

## First choice

Extract existing PDF text layers using a deterministic parser.

This is:

- inexpensive;
- fast;
- reproducible.

## Quality detection

Identify:

- empty pages;
- garbled text;
- broken reading order;
- scans;
- heavily graphical rulebooks.

## Fallback

Use an enhanced document extraction mechanism only when deterministic extraction quality is inadequate.

The parser must be abstracted so alternatives can be evaluated later.

Do not automatically use expensive AI/OCR parsing for every document.

---

# 17. Web/Living Rules Ingestion

For a supplied rules URL:

1. validate URL;
2. block internal/private-network targets;
3. fetch page;
4. remove scripts/navigation/advertising;
5. identify the main content;
6. normalize text;
7. retain canonical URL;
8. snapshot source;
9. chunk;
10. embed.

A browser-rendering fallback may be introduced for JavaScript-heavy living-rules pages.

All web content must be treated as untrusted data, not instructions to the AI.

---

# 18. Ingestion Idempotency

Uploading the same source repeatedly must not create duplicate rules.

Use:

```text
canonical URL
+
content hash
+
game/edition/content identifiers
```

for deduplication.

If a new version is detected:

```text
old document → superseded
new document → current
knowledgeRevision++
```

Do not delete historical source metadata immediately.

---

# 19. Game Knowledge Revision

Each game/edition should maintain a:

```text
knowledgeRevision
```

Increment when authoritative knowledge materially changes.

Examples:

- new FAQ;
- new errata;
- new living-rules version;
- corrected source;
- new official ruling.

Cached rulings record the revision against which they were created.

If:

```text
cachedRuling.knowledgeRevision != currentGame.knowledgeRevision
```

the cached ruling must be revalidated before being trusted.

---

# 20. Retrieval Abstraction

Define:

```ts
interface RulesRetriever {
  retrieve(query: RetrievalQuery): Promise<RetrievedChunk[]>;
}
```

Initial implementation:

```text
S3VectorsRetriever
```

Potential later implementation:

```text
OpenSearchHybridRetriever
```

No rules logic should depend directly on S3 Vectors.

This allows retrieval infrastructure to be changed based on evaluation results.

---

# 21. Initial Retrieval Behaviour

Every retrieval request must include:

```text
gameId
editionId
enabledContentIds
```

The retrieval layer must filter out incompatible:

- editions;
- expansions;
- promos;
- modules;
- obsolete documents.

Recommended initial retrieval count:

```text
10–15 candidate chunks
```

Then optionally reduce/rerank to approximately:

```text
4–8 evidence chunks
```

before model inference.

The exact values are evaluation parameters.

---

# 22. Semantic vs Hybrid Search

S3 Vectors will be the first implementation because of its serverless, low-cost characteristics.

However, board games contain exact terminology such as:

```text
DEPLOY
Prey
Retaliate
Sustain Damage
Ambush
Action
Capacity
```

Semantic retrieval may sometimes underperform lexical+semantic hybrid search.

Therefore retrieval infrastructure must be selected empirically.

Benchmark:

```text
S3 Vectors semantic retrieval
            vs
Hybrid lexical + vector retrieval
```

Measure:

- Recall@1;
- Recall@3;
- Recall@5;
- MRR;
- irrelevant-result rate;
- final-answer accuracy;
- latency;
- cost.

OpenSearch or another hybrid solution must not be introduced unless the measured improvement justifies its additional cost and operational complexity.

---

# 23. Normal Question Pipeline

The normal request flow should be deterministic.

```text
Question
   ↓
Validate session
   ↓
Resolve game configuration
   ↓
Retrieve authoritative evidence
   ↓
Assess evidence
   ↓
Sufficient?
 ┌───────┴─────────┐
 YES                NO
  │                  │
  │            Check cached rulings
  │                  │
  │             Sufficient?
  │             /       \
  │           YES        NO
  │            │          │
  │            │     Research fallback
  │            │          │
  └────────────┴──────────┘
              ↓
       Generate ruling
              ↓
       Validate citations
              ↓
       Return answer
```

The LLM does not control the entire workflow.

---

# 24. Research Fallback

External research should occur only when:

- authoritative local evidence is inadequate;
- cached rulings do not resolve the question;
- contradictory evidence requires clarification.

Research should be bounded.

Initial hard limits:

```text
Maximum research iterations: 3
Maximum searches: 3
Maximum fetched pages: 5
Maximum model token budget: configurable
```

When the budget is exhausted:

```text
INCONCLUSIVE
```

is preferable to uncontrolled additional research.

---

# 25. Web Research Priority

Research order:

## Step 1 — Official sources

Search:

- publisher domain;
- designer domain;
- official FAQ;
- official errata;
- official support;
- living rules.

## Step 2 — BoardGameGeek

Prioritize rules discussions and identifiable designer/publisher comments.

## Step 3 — Reddit

Use as supporting community evidence.

## Step 4 — General web

Primarily for source discovery.

Where a general search discovers an original publisher document, use the original document rather than the search result as evidence.

---

# 26. Web Search Compliance

Search-result snippets must not be bulk-ingested as a replacement knowledge index.

When web search discovers an important official document:

```text
search result
      ↓
original source
      ↓
validate
      ↓
normal ingestion pipeline
```

Community research should normally persist:

- canonical URL;
- title;
- source classification;
- derived ruling;
- evidence references;
- timestamp;

rather than a complete duplicate of third-party forum content.

Any answer based on external search must retain appropriate source links/citations.

---

# 27. Automatic Errata Discovery

When a game is added, automatically perform a targeted search for:

```text
FAQ
Errata
Living Rules
Rules Update
Official Rules Reference
```

using:

```text
game title
publisher
edition
```

Official documents discovered should be ingested when confidence in provenance is sufficiently high.

If provenance cannot be verified, classify the source as a candidate rather than silently making it authoritative.

---

# 28. Resolved Ruling Cache

Persist expensive researched rulings.

A ruling should contain:

```text
rulingId
gameId
editionId
configurationFingerprint
canonicalQuestion
answer
certainty
authority
evidence[]
sourceUrls[]
knowledgeRevision
createdAt
lastValidatedAt
```

Create a semantic index of cached ruling questions.

Before conducting new web research:

```text
search semantically similar cached rulings
```

Only reuse a ruling when:

- game matches;
- edition matches;
- relevant content configuration is compatible;
- knowledge revision remains valid;
- semantic similarity exceeds a tested threshold.

---

# 29. Session Memory

The system must remember conversational context within the current anonymous session.

The complete conversation should be stored.

The complete conversation should **not** automatically be placed into every model prompt.

Recommended strategy:

## Short sessions

Include full conversation while it remains under a configured context budget.

## Longer sessions

Use:

```text
rolling session summary
+
most recent messages
+
current question
+
retrieved rules
```

The full raw conversation remains stored in DynamoDB.

Initial session expiration:

```text
24 hours after last activity
```

with TTL refreshed on activity.

This should be configurable.

A user may also explicitly start a new session.

---

# 30. Session Context Budget

Set explicit runtime prompt budgets.

Example target:

```text
System instructions       ~1,000 tokens
Session memory            ~1,000–2,000
Retrieved evidence        ~2,000–4,000
Question/context          ~500
```

These are targets, not exact limits.

The application must record:

```text
inputTokens
outputTokens
retrievedTokens
sessionContextTokens
researchTokens
```

for observability and evaluation.

---

# 31. Structured Game-State Tracking

Do not implement explicit game-state tracking in the initial release.

Initial system:

```text
conversation-aware
```

Future optional mode:

```text
Track This Game
```

could maintain structured state such as:

```text
phase
active player
faction
location
resources
effects
previous actions
```

The architecture must not prevent this future addition, but no state-extraction engine is required initially.

---

# 32. Model Strategy

## Initial generator

Use:

```text
Amazon Nova 2 Lite
```

as the first model to evaluate.

This is not a permanent commitment.

## Embeddings

Use:

```text
Amazon Titan Text Embeddings V2
```

initially.

## Research

Use the same generation model initially unless evaluation demonstrates the need for a stronger research model.

## Strong-model fallback

Do not implement automatically in the first release.

Benchmark first.

Only introduce:

```text
cheap model
    ↓ low confidence
strong model
```

if measured quality improvements justify the cost.

---

# 33. Converse API

Bedrock Converse should be the default generation interface where the selected model supports it.

Use it for:

- normal rules inference;
- session summarization;
- evidence assessment;
- tool-use loops;
- structured responses.

The application must capture response telemetry including:

```text
input tokens
output tokens
latency
model
```

Model-specific settings belong in adapters/configuration rather than domain code.

---

# 34. Model Evaluation Is a Core Requirement

Model selection must never rely solely on generic benchmarks or subjective impressions.

The project shall contain its own board-game-rules evaluation framework.

Create a version-controlled golden dataset.

Initial target:

```text
100–200 questions
```

Grow toward:

```text
500+
```

as the application matures.

---

# 35. Evaluation Dataset Categories

Include:

- direct lookups;
- timing questions;
- exceptions;
- keyword rules;
- expansion interactions;
- promo interactions;
- optional-module interactions;
- errata changes;
- rules-version conflicts;
- misleading user premises;
- ambiguous official rules;
- designer rulings;
- community-only interpretations;
- multi-turn follow-ups;
- questions that must return INCONCLUSIVE.

Some cases must deliberately have:

```text
expectedCertainty = INCONCLUSIVE
```

to test hallucination resistance.

---

# 36. Evaluation Case Structure

Representative case:

```yaml
id: ti4-014

game: twilight-imperium-4

edition: fourth-edition

enabledContent:
  - base
  - prophecy-of-kings

question:
  "Does the attacker or defender assign hits?"

expected:
  certainty: DEFINITIVE
  authority:
    - OFFICIAL_RULES

requiredEvidence:
  - space-combat-assign-hits

forbiddenClaims:
  - "The defender assigns hits to the attacker."
```

Promo-specific cases must verify that disabled promo content does not leak into answers.

---

# 37. Retrieval Evaluation

Evaluate retrieval independently from generation.

Metrics:

```text
Recall@1
Recall@3
Recall@5
MRR
irrelevant retrieval rate
```

The correct source should ideally appear within the top retrieved chunks before generation.

This allows failures to be classified as:

```text
retrieval failure
```

versus:

```text
reasoning failure
```

---

# 38. Generator Evaluation

When comparing models:

```text
same question
same system instructions
same evidence
same output schema
```

Only the model changes.

Measure:

- final ruling correctness;
- citation faithfulness;
- hallucination rate;
- uncertainty calibration;
- source-authority adherence;
- expansion/promo correctness;
- latency;
- input tokens;
- output tokens;
- monetary cost.

---

# 39. LLM-as-a-Judge

Use Amazon Bedrock model evaluation capabilities for scalable qualitative scoring.

Judge metrics should include custom domain criteria such as:

```text
RulingCorrectness
EvidenceGrounding
CitationFaithfulness
AuthorityCompliance
UncertaintyCalibration
ConfigurationCompliance
```

A strong judge model may be more expensive than the production model because evaluation runs are offline and comparatively infrequent.

Do not use the production generator as the only judge of itself.

---

# 40. Human Ground Truth

LLM judging must never be the sole correctness mechanism.

Evaluation combines:

```text
deterministic assertions
+
human-reviewed reference rulings
+
LLM-as-a-judge
```

High-value or contentious test cases should have human-reviewed expected answers.

---

# 41. Model Promotion

Changing the production model requires:

1. run full benchmark;
2. compare against current production baseline;
3. review quality regressions;
4. review cost;
5. review latency;
6. record decision;
7. deploy only after quality gates pass.

The model name should then change through configuration.

No application rewrite should be necessary.

---

# 42. Evaluation Frequency

## Pull requests

Run:

- deterministic AI tests;
- retrieval tests;
- small low-cost model regression subset when AI-related code changes.

## Nightly/manual

Run:

- full golden dataset;
- judge evaluation;
- retrieval metrics;
- token/cost report.

## Before model/RAG/prompt changes

Run full comparative evaluation against the current production baseline.

---

# 43. Evaluation Repository Structure

```text
/evals
  /datasets
    rules-golden-v1.jsonl
    retrieval-golden-v1.jsonl

  /cases
    ti4/
    root/
    arkham/
    spirit-island/
    other/

  /judges
    grounding.ts
    ruling-correctness.ts
    uncertainty.ts

  /reports

  run-model-eval.ts
  run-retrieval-eval.ts
  compare-models.ts
```

Evaluation reports generated during CI should normally be artifacts, not committed repeatedly.

---

# 44. Frontend Requirements

Mobile-first responsive interface.

Primary screens:

```text
Game Search
Game Configuration
Rules Chat
Add Game
Ingestion Progress
Source/Citation Viewer
```

Rules Chat should prioritize speed and readability during physical gameplay.

Answer UI should display:

```text
Answer
Authority badge
Certainty badge
Citations
Expandable explanation
```

Example:

```text
OFFICIAL • DEFINITIVE

Yes. The attacker assigns hits.

Rules Reference §X.Y

[Show evidence]
```

---

# 45. Anonymous Sessions

No accounts initially.

Backend creates a cryptographically random session identifier.

Prefer secure cookie-based handling rather than putting unnecessary session information in URLs.

Session data contains:

```text
sessionId
gameId
editionId
enabledContentIds
conversationSummary
createdAt
updatedAt
expiresAt
```

---

# 46. API Design

Representative API surface:

```text
GET    /games
GET    /games/{gameId}
POST   /games

GET    /games/{gameId}/content

POST   /uploads/presign
POST   /ingestion
GET    /ingestion/{jobId}

POST   /sessions
GET    /sessions/{sessionId}
DELETE /sessions/{sessionId}

POST   /sessions/{sessionId}/messages

GET    /sources/{sourceId}
```

Exact routes may evolve.

Version APIs where appropriate.

---

# 47. Async Ingestion

Preferred orchestration:

```text
AWS Step Functions
+
Lambda
+
S3
```

Use a state machine because ingestion consists of observable stages:

```text
Validate
Fetch
Parse
Classify
Discover Errata
Normalize
Chunk
Embed
Index
Finalize
```

Jobs must be retryable and idempotent.

A partially failed ingestion should not leave a game incorrectly marked active.

---

# 48. Security

Apply least privilege everywhere.

Requirements include:

- private S3 buckets;
- no public rulebook storage;
- IAM least privilege;
- encryption at rest;
- TLS;
- presigned uploads;
- MIME validation;
- file-size limits;
- URL allow/deny validation;
- SSRF protection;
- CORS restrictions;
- no secrets committed;
- dependency scanning;
- prompt-injection defenses;
- structured output validation.

Retrieved documents and web pages must always be treated as untrusted content.

A document saying:

> “Ignore previous instructions”

is text from a rulebook corpus, not a system instruction.

---

# 49. Upload Controls

Private MVP still requires basic controls:

```text
allowed file types
maximum file size
maximum documents per ingestion
timeout
document count limit
```

Before public release add:

- malware scanning;
- stronger quotas;
- abuse controls;
- moderation;
- ownership/copyright workflow.

---

# 50. Observability

Use structured CloudWatch logging.

Every request should carry a correlation ID.

Track:

```text
request count
answer latency
retrieval latency
model latency
input tokens
output tokens
estimated AI cost
retrieval count
research fallback frequency
web search count
INCONCLUSIVE frequency
ingestion failures
cache hit rate
```

Never log full private document contents unnecessarily.

---

# 51. Cost Controls

Implement from the beginning:

- AWS Budgets;
- billing alerts;
- DynamoDB on-demand;
- Lambda concurrency controls;
- API throttling;
- model token budgets;
- bounded research loops;
- S3 lifecycle policies;
- CloudWatch log retention;
- failed-upload cleanup;
- embedding batching;
- source deduplication.

Avoid premature always-on infrastructure.

---

# 52. GitHub

The entire project must reside in a **user-owned GitHub repository**.

Repository contains:

- frontend;
- backend;
- infrastructure;
- tests;
- evaluation framework;
- architecture documentation;
- ADRs;
- Claude Code instructions;
- CI/CD workflows.

`main` should be protected.

Claude Code should normally work through feature branches.

Example:

```text
feature/m03-retrieval
     ↓
Pull Request
     ↓
CI
     ↓
Review / verification
     ↓
main
```

---

# 53. Infrastructure as Code

Use:

```text
AWS CDK with TypeScript
```

unless an ADR establishes a compelling reason to change.

AWS console-created infrastructure should not become required hidden state.

The desired property is:

```text
repository
+
AWS account
+
documented bootstrap procedure
=
reproducible deployment
```

---

# 54. GitHub → AWS Authentication

GitHub Actions must use AWS federation/OIDC.

Do not create long-lived AWS access keys for GitHub Actions.

Separate deployment roles should exist for environments.

Example:

```text
GitHub Actions
      ↓
GitHub OIDC
      ↓
AWS STS
      ↓
Deployment Role
      ↓
CDK Deploy
```

Trust policies must restrict which repository/branch/environment can assume each deployment role.

---

# 55. CI/CD

Recommended workflows:

```text
ci.yml
deploy-dev.yml
deploy-prod.yml
eval-nightly.yml
security.yml
```

## Pull-request CI

Must run:

```text
install
format check
lint
TypeScript strict check
unit tests
integration tests
CDK synth
security/dependency checks
retrieval regression tests
appropriate AI smoke evaluations
```

## Merge to main

Automatically deploy:

```text
DEV
```

Then run smoke tests.

## Production

Production deployment should be:

```text
version/tag
+
protected GitHub environment
+
manual approval initially
```

---

# 56. SWE Practices

The project must use:

- TypeScript strict mode;
- explicit domain types;
- dependency inversion around AWS/model/search services;
- separation of concerns;
- unit testing;
- integration testing;
- end-to-end testing;
- automated formatting;
- linting;
- static analysis;
- dependency vulnerability scanning;
- structured logs;
- ADRs;
- conventional/consistent commit practices;
- reproducible builds;
- configuration validation;
- explicit error types;
- retries with backoff where appropriate;
- timeouts on external calls;
- idempotency;
- observability;
- least-privilege security.

Avoid unnecessary abstractions, microservices, or frameworks merely for theoretical future scaling.

---

# 57. Recommended Repository Structure

```text
/
├── apps/
│   ├── web/
│   └── api/
│
├── packages/
│   ├── domain/
│   ├── ai/
│   ├── retrieval/
│   ├── ingestion/
│   ├── persistence/
│   └── shared/
│
├── infrastructure/
│   └── cdk/
│
├── evals/
│
├── docs/
│   ├── architecture/
│   ├── adr/
│   └── milestones/
│
├── scripts/
│
├── .github/
│   └── workflows/
│
├── CLAUDE.md
├── CURRENT_STATE.md
├── MASTER_PLAN.md
├── package.json
└── README.md
```

Use a simple workspace solution such as pnpm workspaces.

Do not introduce monorepo orchestration tools unless they provide a demonstrated benefit.

---

# 58. Claude Code Context Strategy

Claude Code context consumption is an explicit engineering concern.

The coding agent must not rely on a single enormous conversation for project memory.

The repository is the source of truth.

## `CLAUDE.md`

Contains concise permanent instructions such as:

```text
Read CURRENT_STATE.md.
Read the current milestone specification.
Read only architecture/ADR documents referenced by that milestone.

Do not implement future milestones.

Run required tests before completion.

Update CURRENT_STATE.md when finished.
```

Keep `CLAUDE.md` concise.

Do not duplicate the entire architecture inside it.

## `CURRENT_STATE.md`

Contains only:

```text
current milestone
completed work
important active decisions
known issues
next expected work
```

Keep it short and continually replace stale information rather than endlessly appending history.

## ADRs

Long-lived architectural decisions belong in:

```text
/docs/adr/
```

Examples:

```text
ADR-001-runtime-stack.md
ADR-002-vector-store.md
ADR-003-model-interface.md
ADR-004-session-memory.md
ADR-005-web-research.md
```

---

# 59. Claude Code Execution Rules

For every milestone Claude Code must:

1. create/use the corresponding feature branch;
2. read `CLAUDE.md`;
3. read `CURRENT_STATE.md`;
4. read the current milestone spec;
5. read only referenced architecture documents;
6. implement only that milestone;
7. add/update tests;
8. run quality checks;
9. update documentation;
10. update `CURRENT_STATE.md`;
11. prepare a concise PR summary.

Claude Code must not proactively implement future milestones unless required for a minimal interface/stub.

---

# 60. Milestone 0 — Repository & Engineering Foundation

## Objective

Create a production-quality project skeleton before application features.

## Deliverables

- user-owned GitHub repository;
- TypeScript workspace;
- React/Vite frontend skeleton;
- Lambda/API skeleton;
- CDK project;
- ESLint;
- formatter;
- unit-test framework;
- strict TypeScript;
- GitHub Actions;
- Dependabot;
- CodeQL/security checks;
- OIDC AWS deployment role;
- dev environment;
- CloudWatch baseline;
- documentation structure;
- `CLAUDE.md`;
- `CURRENT_STATE.md`;
- ADR framework.

## Acceptance

```text
PR CI passes.
main deploys dev automatically.
GET /health works.
Frontend loads through deployed environment.
No long-lived AWS credentials are stored in GitHub.
```

---

# 61. Milestone 1 — Domain Model, Game Catalog & Sessions

## Objective

Establish domain concepts independently of AI.

Implement:

```text
Game
Edition
ContentPackage
SourceDocument metadata
Session
Message
```

Support:

- game search;
- game creation;
- edition selection;
- expansion selection;
- promo selection;
- optional-module selection;
- anonymous session creation;
- session TTL.

## Acceptance

User can:

```text
select game
select edition
select expansions/promos/modules
start anonymous session
```

without any RAG implementation yet.

---

# 62. Milestone 2 — Document Ingestion

## Objective

Create reliable source ingestion.

Implement:

- presigned PDF upload;
- URL ingestion;
- asynchronous job orchestration;
- PDF parsing;
- web parsing;
- normalization;
- source classification;
- content hashing;
- deduplication;
- heading-aware chunking;
- source/page metadata;
- job status UI/API.

Do not add embeddings until normalized chunks are demonstrably correct.

## Acceptance

For representative rulebooks:

```text
source uploaded
→ parsed
→ chunks inspectable
→ correct page/section metadata retained
```

Repeated upload does not duplicate content.

---

# 63. Milestone 3 — Embeddings, Retrieval & Evaluation Foundation

## Objective

Create first working RAG retriever and retrieval benchmark.

Implement:

- Titan Text Embeddings V2 adapter;
- S3 Vectors adapter;
- chunk embedding;
- game/config metadata filtering;
- retrieval API;
- evaluation dataset format;
- Recall@K evaluator;
- initial ~30–50 retrieval test cases.

Test at least 3 structurally different games.

## Acceptance

Retriever demonstrably excludes disabled:

```text
expansions
promos
modules
editions
```

Retrieval metrics are recorded.

No answer-generation model yet needs to be considered successful.

---

# 64. Milestone 4 — Rules Answering

## Objective

Add grounded AI inference.

Implement:

- `RulesModel` abstraction;
- Bedrock Converse adapter;
- Nova 2 Lite initial implementation;
- structured output;
- source hierarchy;
- evidence assessment;
- answer-generation prompt;
- citation validation;
- INCONCLUSIVE behavior;
- token/latency telemetry.

Expand golden dataset to approximately:

```text
75–100 cases
```

## Acceptance

System can answer representative rules questions from local authoritative sources with citations.

It must successfully refuse unsupported definitive rulings in designated evaluation cases.

---

# 65. Milestone 5 — Session Conversation Memory

## Objective

Allow natural multi-turn rules conversations without unbounded context growth.

Implement:

- complete message persistence;
- configurable context budget;
- rolling summaries;
- recent-turn retention;
- session refresh/TTL;
- context-token telemetry.

Add multi-turn evaluation cases.

## Acceptance

A long session does not result in linear prompt growth.

Relevant recent context is retained.

Full source conversation remains stored for the session.

---

# 66. Milestone 6 — Web Research, Errata Discovery & Ruling Cache

## Objective

Handle unresolved questions and automatically enrich knowledge.

Implement:

- `WebSearchProvider` abstraction;
- AgentCore Web Search adapter;
- official-domain-first search;
- BGG search;
- Reddit/general fallback;
- bounded research loop;
- research token/tool limits;
- source provenance;
- automatic errata/FAQ discovery;
- official-document promotion into ingestion;
- resolved-ruling cache;
- cache semantic retrieval;
- knowledge revision invalidation.

## Acceptance

When local rules are insufficient:

```text
local RAG
→ bounded research
→ cited answer OR INCONCLUSIVE
```

A repeated obscure ruling should normally reuse valid cached research instead of performing another web search.

---

# 67. Milestone 7 — Model & Retrieval Benchmarking

## Objective

Make quality/cost decisions from evidence.

Expand golden dataset toward:

```text
150–200 cases
```

Implement:

- candidate-model runner;
- fixed-context model comparison;
- deterministic scoring;
- Bedrock LLM judge jobs;
- custom judge metrics;
- cost calculation;
- latency comparison;
- report generation.

Benchmark:

```text
Nova 2 Lite
vs
at least one credible alternative
```

Also evaluate:

```text
1024 vs 512 embeddings
chunk size alternatives
retrieval top-K
reranking if applicable
```

If semantic retrieval quality is inadequate, perform controlled hybrid-search experiment.

## Acceptance

Generate an evaluation report showing:

```text
quality
hallucination rate
citation faithfulness
uncertainty behavior
latency
tokens
estimated cost
```

and record resulting choices in ADRs.

---

# 68. Milestone 8 — Mobile UX & Private Beta

## Objective

Make the system usable during real board-game sessions.

Focus on:

- fast game selection;
- good mobile layout;
- content-selection UX;
- add-game workflow;
- ingestion progress;
- answer readability;
- citation viewer;
- uncertainty presentation;
- retry/error states;
- user feedback button.

Conduct actual friend-group playtests.

Collect:

```text
question
answer
user feedback
retrieval trace
model
latency
```

where privacy permits.

Turn real failures into regression cases.

---

# 69. Milestone 9 — Production Hardening

## Objective

Prepare a reliable private production deployment.

Complete:

- production environment;
- production deployment approvals;
- budgets;
- alarms;
- log retention;
- backup/recovery strategy;
- concurrency limits;
- upload limits;
- API throttling;
- security review;
- prompt-injection review;
- SSRF testing;
- end-to-end smoke tests;
- operational runbook;
- cost dashboard.

## Acceptance

A tagged release can be reproducibly promoted from GitHub to production.

---

# 70. Milestone 10 — Public-Launch Readiness

Do not implement until private usage validates the product.

Revisit:

- authentication;
- user accounts;
- upload ownership;
- game moderation;
- publisher copyright considerations;
- terms of service;
- privacy policy;
- rate limits;
- per-user quotas;
- malicious upload scanning;
- duplicate-game moderation;
- WAF;
- abuse prevention;
- billing;
- scaling;
- public support processes.

Any user-upload design assumptions from the private product must be re-evaluated before public launch.

---

# 71. Definition of Done

A milestone is not complete merely because the feature works locally.

Unless explicitly inapplicable, every milestone must include:

```text
✓ implementation complete
✓ unit tests
✓ integration tests
✓ lint passes
✓ formatting passes
✓ type checking passes
✓ security checks pass
✓ infrastructure represented in CDK
✓ documentation updated
✓ relevant evaluation cases added
✓ deployed to dev
✓ smoke tested
✓ CURRENT_STATE.md updated
✓ ADR added/updated when architecture changed
✓ CI passes
```

---

# 72. Initial Success Criteria

The private product should eventually demonstrate:

## Functional

- new game can be added;
- relevant official sources can be ingested;
- expansions and promos are configurable;
- rules questions receive cited answers;
- ambiguous questions can return INCONCLUSIVE;
- official errata can be discovered;
- repeat researched questions avoid unnecessary search.

## Quality

Evaluation suite demonstrates acceptable:

```text
retrieval recall
ruling correctness
citation faithfulness
uncertainty handling
configuration isolation
```

## Cost

Idle AWS cost is low.

Per-query cost is observable.

Research is bounded.

No routine request uses an unnecessarily large prompt.

## Engineering

Entire environment is reproducible from GitHub and CDK.

Production model can be swapped without rewriting application business logic.

---

# 73. Key Architectural Decisions to Validate Rather Than Assume

These are intentional experiments:

## Retrieval

```text
Is semantic-only S3 Vectors sufficient?
```

Do not assume yes or no.

Benchmark it.

## Model

```text
Is Nova 2 Lite sufficiently accurate?
```

Benchmark it.

## Embedding dimensions

```text
Does 512 perform comparably to 1024?
```

Benchmark it.

## Reranking

```text
Does reranking improve enough to justify additional cost/latency?
```

Benchmark it.

## Parsing

```text
Is deterministic PDF extraction sufficient for typical rulebooks?
```

Measure extraction failures before introducing expensive fallback parsing.

---

# 74. Architectural Values

When trade-offs arise, prioritize in this order:

```text
1. Correctness
2. Evidence / provenance
3. Avoiding fabricated rulings
4. Retrieval quality
5. User latency
6. Maintainability
7. Cost efficiency
8. Feature breadth
```

Cost matters substantially, but not enough to justify materially worse rules answers.

---

# 75. Final System Character

The finished application should not behave like:

> “A chatbot that happens to know board games.”

It should behave like:

> **A source-aware digital rules referee that can explain exactly why it reached a ruling, knows when it does not have enough evidence, understands which game content is in play, learns from previously researched rulings, and can cheaply expand to new games.**

The production runtime is therefore:

```text
deterministic application workflow
+
retrieval
+
bounded generative reasoning
+
bounded research when needed
```

rather than an unrestricted autonomous AI agent.

The implementation process similarly relies on:

```text
small Claude Code milestones
+
repository-backed project memory
+
tests
+
CI/CD
```

rather than a continuously growing coding-agent context window.