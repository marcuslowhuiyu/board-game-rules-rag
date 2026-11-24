import { useState } from 'react';
import type { AskQuestionResponse, Citation, PanelTier, TierAnswer } from '../api/client.js';
import { confidencePercent, provenanceLine, sourceSummary, tierLabel } from '../answer-view.js';

function Meter({ level }: { level: 'HIGH' | 'MEDIUM' | 'LOW' }) {
  const pct = confidencePercent(level);
  const tone = level === 'HIGH' ? 'hi' : level === 'MEDIUM' ? 'mid' : 'lo';
  return (
    <div
      className="bar"
      role="meter"
      aria-label="Confidence"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={tone} style={{ width: `${pct}%` }} />
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
  citations,
}: {
  tier: TierAnswer;
  applied: boolean;
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
      <Meter level={tier.confidence.level} />
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
    <div className="tier">
      <div className="th">
        <span className="tname">{tierLabel(tier.tier)}</span>
        <span className="muted">{`confidence: ${tier.confidence.level.toLowerCase()}`}</span>
      </div>
      <div className="says">{tier.answer}</div>
    </div>
  );
}

const CONFLICT_TIERS: PanelTier[] = ['OFFICIAL', 'DESIGNER_OR_PUBLISHER'];

export function AnswerCard({ response }: { response: AskQuestionResponse }) {
  const { answer, citations } = response;
  const [open, setOpen] = useState(false);
  const inconclusive = answer.certainty === 'INCONCLUSIVE';
  const hasTiers = answer.tiers.length > 0;

  const panels = answer.tiers.map((t) => (
    <TierPanel
      key={t.tier}
      tier={t}
      applied={!inconclusive && t.tier === answer.appliedTier}
      citations={citations}
    />
  ));
  const link = open
    ? 'Hide sources ▴'
    : answer.sourcesDisagree
      ? 'See what each source says ▸'
      : 'See sources ▸';
  const toggle = hasTiers && (
    <button type="button" className="link" onClick={() => setOpen(!open)}>
      {link}
    </button>
  );

  if (inconclusive) {
    return (
      <div className="answer-card">
        <div className="ans">The rules don't settle this.</div>
        <div className="says">{answer.explanation}</div>
        {toggle}
        {open && panels}
      </div>
    );
  }

  if (answer.requiresPlayerChoice) {
    return (
      <div className="answer-card">
        <div className="chip">Sources disagree: choose a ruling at your table</div>
        {answer.tiers
          .filter((t) => CONFLICT_TIERS.includes(t.tier))
          .map((t) => (
            <CompactPanel key={t.tier} tier={t} />
          ))}
        {toggle}
        {open && panels}
      </div>
    );
  }

  const summary = sourceSummary(answer.evidence, citations);
  const confidence = `Confidence: ${answer.confidence.level.toLowerCase()}${summary ? ` · ${summary}` : ''}`;
  return (
    <div className="answer-card">
      <div className="ans">{answer.answer}</div>
      <div className="muted">{confidence}</div>
      <Meter level={answer.confidence.level} />
      {answer.sourcesDisagree && <div className="chip">⚠️ Sources disagree</div>}
      {toggle}
      {open && panels}
    </div>
  );
}
