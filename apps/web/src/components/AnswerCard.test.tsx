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
        tier('OFFICIAL', 'The rulebook is silent.', 'c1', 'LOW'),
        tier('DESIGNER_OR_PUBLISHER', 'Freeze the display.', 'c2', 'HIGH'),
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

  it('shows both panels before any click when the players must choose', () => {
    render(<AnswerCard response={conflict({ requiresPlayerChoice: true, appliedTier: null })} />);
    expect(screen.getByText('Sources disagree: choose a ruling at your table')).toBeInTheDocument();
    expect(screen.getByText('The rulebook is silent.')).toBeInTheDocument();
    expect(screen.getByText('Freeze the display.')).toBeInTheDocument();
  });

  it('expands to one panel per tier with provenance and the applied tag', async () => {
    const user = userEvent.setup();
    render(<AnswerCard response={conflict()} />);
    expect(screen.queryByText('Freeze the display.')).toBeNull();
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
});
