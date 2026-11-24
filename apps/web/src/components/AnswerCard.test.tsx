import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  AskQuestionResponse,
  Citation,
  PanelTier,
  RulesAnswer,
  TierAnswer,
} from '../api/client.js';
import { AnswerCard } from './AnswerCard.js';

const cite = (over: Partial<Citation> = {}): Citation => ({
  chunkId: 'c1',
  documentId: 'd1',
  title: 'Core Rules',
  sourceType: 'RULEBOOK',
  authority: 'OFFICIAL_RULES',
  pageStart: 3,
  pageEnd: 3,
  headingPath: ['Setup', 'Cards'],
  text: 'Deal five cards to each player.',
  provenance: [{ kind: 'SOURCE_HOST', host: 'rules.example.com' }],
  ...over,
});

const tier = (
  t: PanelTier,
  answer: string,
  chunkId: string,
  level: 'HIGH' | 'LOW',
): TierAnswer => ({
  tier: t,
  answer,
  certainty: 'DEFINITIVE',
  evidence: [{ chunkId }, { chunkId }],
  confidence: { level, reasons: [] },
});

const answerOf = (over: Partial<RulesAnswer> = {}): RulesAnswer => ({
  certainty: 'DEFINITIVE',
  authority: 'OFFICIAL_RULES',
  answer: 'Each player draws five cards.',
  explanation: 'The setup section says so.',
  evidence: [{ chunkId: 'c1' }],
  needsResearch: false,
  confidence: { level: 'HIGH', reasons: [] },
  appliedTier: 'OFFICIAL',
  tiers: [tier('OFFICIAL', 'Five cards each.', 'c1', 'HIGH')],
  sourcesDisagree: false,
  requiresPlayerChoice: false,
  ...over,
});

const responseOf = (
  answer: RulesAnswer,
  citations: Citation[] = [cite()],
): AskQuestionResponse => ({
  messageId: 'm1',
  answer,
  citations,
  models: {},
  promptVersions: {},
});

const conflict = (over: Partial<RulesAnswer> = {}) =>
  responseOf(
    answerOf({
      sourcesDisagree: true,
      appliedTier: 'DESIGNER_OR_PUBLISHER',
      tiers: [
        tier('OFFICIAL', 'Option A is described only briefly.', 'c1', 'LOW'),
        tier('DESIGNER_OR_PUBLISHER', 'Option B applies at the table.', 'c2', 'HIGH'),
      ],
      ...over,
    }),
    [
      cite(),
      cite({
        chunkId: 'c2',
        documentId: 'd2',
        title: 'Publisher FAQ',
        sourceType: 'FAQ',
        text: 'Ruling text here.',
        provenance: [{ kind: 'UPLOADED_FILE', filename: 'faq.pdf' }],
      }),
    ],
  );

describe('AnswerCard', () => {
  it('shows answer, confidence line, meter and sources link when sources agree', () => {
    render(<AnswerCard response={responseOf(answerOf())} />);
    expect(screen.getByText('Each player draws five cards.')).toBeInTheDocument();
    expect(screen.getByText('Confidence: high · Rulebook p.3')).toBeInTheDocument();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '85');
    expect(screen.getByRole('button', { name: 'See sources ▸' })).toBeInTheDocument();
    expect(screen.queryByText(/Sources disagree/)).toBeNull();
  });

  it('omits the source part of the confidence line when nothing resolves', () => {
    render(<AnswerCard response={responseOf(answerOf(), [])} />);
    expect(screen.getByText('Confidence: high')).toBeInTheDocument();
  });

  it('marks disagreement in the first view', () => {
    render(<AnswerCard response={conflict()} />);
    expect(screen.getByText('⚠️ Sources disagree')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See what each source says ▸' })).toBeInTheDocument();
  });

  it('shows compact panels up front and a toggle that opens every tier when players must choose', async () => {
    const user = userEvent.setup();
    const base = conflict({ requiresPlayerChoice: true, appliedTier: null });
    const response = {
      ...base,
      answer: {
        ...base.answer,
        tiers: [
          ...base.answer.tiers,
          tier('COMMUNITY_DISCUSSION', 'Opinions differ.', 'c3', 'LOW'),
        ],
      },
      citations: [...base.citations, cite({ chunkId: 'c3', documentId: 'd3', title: 'Forum' })],
    };
    render(<AnswerCard response={response} />);
    expect(screen.getByText('Sources disagree: choose a ruling at your table')).toBeInTheDocument();
    expect(screen.getByText('Option A is described only briefly.')).toBeInTheDocument();
    expect(screen.getByText('Option B applies at the table.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Community discussion' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'See what each source says ▸' }));
    expect(screen.getByRole('group', { name: 'Community discussion' })).toBeInTheDocument();
    // the compact row stays, so the conflicting tiers now appear twice
    expect(screen.getAllByRole('group', { name: 'Official rules' })).toHaveLength(2);
  });

  it('hides the sources toggle when there are no tiers', () => {
    render(<AnswerCard response={responseOf(answerOf({ tiers: [], evidence: [] }))} />);
    expect(screen.queryByRole('button', { name: /sources/i })).toBeNull();
  });

  it('offers tiers behind a toggle for an inconclusive answer, with no applied tag', async () => {
    const user = userEvent.setup();
    render(
      <AnswerCard
        response={responseOf(
          answerOf({
            certainty: 'INCONCLUSIVE',
            explanation: 'Nothing covers this case.',
            appliedTier: null,
            tiers: [tier('COMMUNITY_DISCUSSION', 'Players split.', 'c1', 'LOW')],
          }),
        )}
      />,
    );
    expect(screen.queryByRole('group', { name: 'Community discussion' })).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'See sources ▸' }));
    expect(screen.queryByRole('meter')).toBeNull();
    const panel = screen.getByRole('group', { name: 'Community discussion' });
    expect(within(panel).getByText('fetched from rules.example.com')).toBeInTheDocument();
    expect(screen.queryByText('applied')).toBeNull();
  });

  it('expands to one panel per tier with provenance and the applied tag', async () => {
    const user = userEvent.setup();
    render(<AnswerCard response={conflict()} />);
    expect(screen.queryByText('Option B applies at the table.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'See what each source says ▸' }));
    const official = screen.getByRole('group', { name: 'Official rules' });
    const publisher = screen.getByRole('group', { name: 'Publisher ruling' });
    expect(within(official).getByText('confidence: low')).toBeInTheDocument();
    expect(within(official).getByText('fetched from rules.example.com')).toBeInTheDocument();
    expect(within(publisher).getByText('confidence: high')).toBeInTheDocument();
    expect(within(publisher).getByText('uploaded file faq.pdf')).toBeInTheDocument();
    expect(within(publisher).getByText('applied')).toBeInTheDocument();
    expect(within(official).queryByText('applied')).toBeNull();
    expect(screen.getByRole('button', { name: 'Hide sources ▴' })).toBeInTheDocument();
  });

  it('shows a citation passage, page and heading path when opened', async () => {
    const user = userEvent.setup();
    render(<AnswerCard response={responseOf(answerOf())} />);
    await user.click(screen.getByRole('button', { name: 'See sources ▸' }));
    const panel = screen.getByRole('group', { name: 'Official rules' });
    expect(within(panel).getAllByText(/Rulebook p\.3/)).toHaveLength(1);
    await user.click(within(panel).getByText('Rulebook p.3'));
    expect(within(panel).getByText('Deal five cards to each player.')).toBeVisible();
    expect(within(panel).getByText('Page 3')).toBeInTheDocument();
    expect(within(panel).getByText('Setup › Cards')).toBeInTheDocument();
  });

  it('shows the inconclusive state without a meter or applied tag', () => {
    render(
      <AnswerCard
        response={responseOf(
          answerOf({
            certainty: 'INCONCLUSIVE',
            explanation: 'Nothing covers this case.',
            confidence: { level: 'LOW', reasons: [] },
            appliedTier: null,
            evidence: [],
            tiers: [],
          }),
        )}
      />,
    );
    expect(screen.getByText("The rules don't settle this.")).toBeInTheDocument();
    expect(screen.getByText('Nothing covers this case.')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText('applied')).toBeNull();
  });

  it('renders markup-looking passage text literally', async () => {
    const user = userEvent.setup();
    const evil = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <AnswerCard response={responseOf(answerOf(), [cite({ text: evil })])} />,
    );
    await user.click(screen.getByRole('button', { name: 'See sources ▸' }));
    await user.click(screen.getByText('Rulebook p.3', { selector: 'summary' }));
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('synthesizes the applied panel when the player-choice ruling has no tier panel', () => {
    const base = conflict({
      requiresPlayerChoice: true,
      appliedTier: 'OFFICIAL',
      answer: 'Official wording here.',
      tiers: [tier('DESIGNER_OR_PUBLISHER', 'Option B applies at the table.', 'c2', 'HIGH')],
    });
    render(<AnswerCard response={base} />);
    expect(screen.getByText('Official wording here.')).toBeInTheDocument();
    expect(screen.getByText('Option B applies at the table.')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Official rules' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Publisher ruling' })).toBeInTheDocument();
  });

  it('shows the toggle and the applied panel with its citation when tiers is empty', async () => {
    const user = userEvent.setup();
    render(<AnswerCard response={responseOf(answerOf({ tiers: [] }))} />);
    await user.click(screen.getByRole('button', { name: 'See sources ▸' }));
    const panel = screen.getByRole('group', { name: 'Official rules' });
    expect(within(panel).getByText('applied')).toBeInTheDocument();
    expect(within(panel).getByText('Rulebook p.3')).toBeInTheDocument();
  });

  it('keeps the disagreement marker and side-by-side panels for an inconclusive player choice', () => {
    render(
      <AnswerCard
        response={conflict({
          certainty: 'INCONCLUSIVE',
          requiresPlayerChoice: true,
          appliedTier: null,
          explanation: 'Nothing settles it.',
        })}
      />,
    );
    expect(screen.getByText("The rules don't settle this.")).toBeInTheDocument();
    expect(screen.getByText('Sources disagree: choose a ruling at your table')).toBeInTheDocument();
    expect(screen.getByText('Option A is described only briefly.')).toBeInTheDocument();
    expect(screen.getByText('Option B applies at the table.')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.queryByText('applied')).toBeNull();
  });

  it('shows the disagreement chip on an inconclusive card without a player choice', () => {
    render(<AnswerCard response={conflict({ certainty: 'INCONCLUSIVE', appliedTier: null })} />);
    expect(screen.getByText('⚠️ Sources disagree')).toBeInTheDocument();
  });

  it('names the compact player-choice panels', () => {
    render(<AnswerCard response={conflict({ requiresPlayerChoice: true, appliedTier: null })} />);
    expect(screen.getByRole('group', { name: 'Official rules' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Publisher ruling' })).toBeInTheDocument();
  });

  it('shows authority and certainty for a definitive ruling, and the explanation once expanded', async () => {
    const user = userEvent.setup();
    render(<AnswerCard response={responseOf(answerOf())} />);
    expect(screen.getByText('Official rules · Stated directly')).toBeInTheDocument();
    expect(screen.queryByText('The setup section says so.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'See sources ▸' }));
    expect(screen.getByText('The setup section says so.')).toBeInTheDocument();
  });

  it('shows "Best reading" and the caveat in the first view for a qualified ruling', () => {
    render(
      <AnswerCard
        response={responseOf(
          answerOf({ certainty: 'QUALIFIED', explanation: 'Only if no expansion is used.' }),
        )}
      />,
    );
    expect(screen.getByText('Official rules · Best reading')).toBeInTheDocument();
    expect(screen.getByText('Only if no expansion is used.')).toBeInTheDocument();
  });
});
