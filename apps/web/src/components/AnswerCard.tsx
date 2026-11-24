import { useState } from 'react';
import type { AskQuestionResponse, Citation, PanelTier, TierAnswer } from '../api/client.js';
import { confidencePercent, provenanceLine, sourceSummary, tierLabel } from '../answer-view.js';

function Meter({ level }: { level: 'HIGH' | 'MEDIUM' | 'LOW' }) {
  const pct = confidencePercent(level);
  return (
    <div
      className="bar"
      role="meter"
      aria-label="Confidence"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

function CitationDetails({ citation, all }: { citation: Citation; all: Citation[] }) {
  const label = sourceSummary([{ chunkId: citation.chunkId }], all) || citation.title;
  return (
    <details className="citation">
      <summary>{label}</summary>
      <div className="muted">
        {citation.pageEnd > citation.pageStart
          ? `Pages ${citation.pageStart}–${citation.pageEnd}`
          : `Page ${citation.pageStart}`}
      </div>
      {citation.headingPath.length > 0 && (
        <div className="muted">{citation.headingPath.join(' › ')}</div>
      )}
      <blockquote className="passage">{citation.text}</blockquote>
    </details>
  );
}

function TierPanel({
  tier,
  applied,
  meter,
  citations,
}: {
  tier: TierAnswer;
  applied: boolean;
  meter: boolean;
  citations: Citation[];
}) {
  const byId = new Map(citations.map((c) => [c.chunkId, c]));
  const ids = [...new Set(tier.evidence.map((e) => e.chunkId))];
  const cited = ids.flatMap((id) => {
    const c = byId.get(id);
    return c ? [c] : [];
  });
  const provenance = provenanceLine(cited.flatMap((c) => c.provenance));
  const name = tierLabel(tier.tier);
  return (
    <div className={applied ? 'tier pick' : 'tier'} role="group" aria-label={name}>
      <div className="th">
        <span className="tname">
          {name} {applied && <span className="tag">applied</span>}
        </span>
        <span className="muted">{`confidence: ${tier.confidence.level.toLowerCase()}`}</span>
      </div>
      {meter && <Meter level={tier.confidence.level} />}
      <div className="says">{tier.answer}</div>
      {provenance && <div className="muted">{provenance}</div>}
      {cited.map((c) => (
        <CitationDetails key={c.chunkId} citation={c} all={citations} />
      ))}
    </div>
  );
}

function CompactPanel({ tier }: { tier: TierAnswer }) {
  return (
    <div className="tier" role="group" aria-label={tierLabel(tier.tier)}>
      <div className="th">
        <span className="tname">{tierLabel(tier.tier)}</span>
        <span className="muted">{`confidence: ${tier.confidence.level.toLowerCase()}`}</span>
      </div>
      <div className="says">{tier.answer}</div>
    </div>
  );
}

const CONFLICT_TIERS: PanelTier[] = ['OFFICIAL', 'DESIGNER_OR_PUBLISHER'];

const CERTAINTY_WORDS = { DEFINITIVE: 'Stated directly', QUALIFIED: 'Best reading' } as const;

/** The tiers to show, adding the applied ruling's own panel when the validator left it out. */
function withAppliedPanel(
  answer: AskQuestionResponse['answer'],
  inconclusive: boolean,
): TierAnswer[] {
  const { appliedTier, tiers } = answer;
  if (inconclusive || !appliedTier || tiers.some((t) => t.tier === appliedTier)) return tiers;
  if (tiers.length === 0 && answer.evidence.length === 0) return tiers;
  const applied: TierAnswer = {
    tier: appliedTier,
    answer: answer.answer,
    certainty: answer.certainty === 'QUALIFIED' ? 'QUALIFIED' : 'DEFINITIVE',
    evidence: answer.evidence,
    confidence: answer.confidence,
  };
  return [applied, ...tiers];
}

export function AnswerCard({ response }: { response: AskQuestionResponse }) {
  const { answer, citations } = response;
  const [open, setOpen] = useState(false);
  const inconclusive = answer.certainty === 'INCONCLUSIVE';
  const tiers = withAppliedPanel(answer, inconclusive);

  const panels = tiers.map((t) => (
    <TierPanel
      key={t.tier}
      tier={t}
      applied={!inconclusive && t.tier === answer.appliedTier}
      meter={!inconclusive}
      citations={citations}
    />
  ));
  const link = open
    ? 'Hide sources ▴'
    : answer.sourcesDisagree
      ? 'See what each source says ▸'
      : 'See sources ▸';
  const toggle = tiers.length > 0 && (
    <button type="button" className="link" onClick={() => setOpen(!open)}>
      {link}
    </button>
  );
  const sideBySide = (
    <>
      <div className="chip">Sources disagree: choose a ruling at your table</div>
      {tiers
        .filter((t) => CONFLICT_TIERS.includes(t.tier))
        .map((t) => (
          <CompactPanel key={t.tier} tier={t} />
        ))}
    </>
  );

  if (inconclusive) {
    return (
      <div className="answer-card card">
        <div className="settle">
          <div className="ans">The rules don't settle this.</div>
          <div className="says">{answer.explanation}</div>
        </div>
        {answer.requiresPlayerChoice
          ? sideBySide
          : answer.sourcesDisagree && <div className="chip">⚠️ Sources disagree</div>}
        {toggle}
        {open && panels}
      </div>
    );
  }

  if (answer.requiresPlayerChoice) {
    return (
      <div className="answer-card card">
        {sideBySide}
        {toggle}
        {open && panels}
      </div>
    );
  }

  const summary = sourceSummary(answer.evidence, citations);
  const confidence = `Confidence: ${answer.confidence.level.toLowerCase()}${summary ? ` · ${summary}` : ''}`;
  const certaintyWord =
    answer.certainty === 'QUALIFIED' ? CERTAINTY_WORDS.QUALIFIED : CERTAINTY_WORDS.DEFINITIVE;
  const standing = [answer.appliedTier ? tierLabel(answer.appliedTier) : null, certaintyWord]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="answer-card card">
      <div className="ans">{answer.answer}</div>
      <div className="tag">{standing}</div>
      {answer.certainty === 'QUALIFIED' && <div className="says">{answer.explanation}</div>}
      <div className="muted">{confidence}</div>
      <Meter level={answer.confidence.level} />
      {answer.sourcesDisagree && <div className="chip">⚠️ Sources disagree</div>}
      {toggle}
      {open && answer.certainty === 'DEFINITIVE' && (
        <div className="says">{answer.explanation}</div>
      )}
      {open && panels}
    </div>
  );
}
