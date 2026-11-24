import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  type ApiClient,
  type AskQuestionResponse,
  type SessionView,
} from '../api/client.js';
import { RulesChatScreen } from './RulesChatScreen.js';

const session: SessionView = {
  sessionId: 's_1',
  gameId: 'g_1',
  editionId: 'e_1',
  enabledContentIds: [],
  configurationFingerprint: 'x'.repeat(64),
  createdAt: '2026-09-16T00:00:00.000Z',
  updatedAt: '2026-09-16T00:00:00.000Z',
  expiresAt: '2026-09-17T00:00:00.000Z',
};

const response = (text: string): AskQuestionResponse => ({
  messageId: 'm1',
  answer: {
    certainty: 'DEFINITIVE',
    authority: 'OFFICIAL_RULES',
    answer: text,
    explanation: 'Because.',
    evidence: [{ chunkId: 'c1' }],
    needsResearch: false,
    confidence: { level: 'HIGH', reasons: [] },
    appliedTier: 'OFFICIAL',
    tiers: [
      {
        tier: 'OFFICIAL',
        answer: text,
        certainty: 'DEFINITIVE',
        evidence: [{ chunkId: 'c1' }],
        confidence: { level: 'HIGH', reasons: [] },
      },
    ],
    sourcesDisagree: false,
    requiresPlayerChoice: false,
  },
  citations: [
    {
      chunkId: 'c1',
      documentId: 'd1',
      title: 'Core Rules',
      sourceType: 'RULEBOOK',
      authority: 'OFFICIAL_RULES',
      pageStart: 3,
      pageEnd: 3,
      headingPath: [],
      text: 'Deal five cards.',
      provenance: [{ kind: 'SOURCE_HOST', host: 'rules.example.com' }],
    },
  ],
  models: {},
  promptVersions: {},
});

const setup = (askQuestion: ApiClient['askQuestion']) => {
  const api = { askQuestion } as unknown as ApiClient;
  const onExit = vi.fn();
  render(<RulesChatScreen api={api} session={session} gameName="Catan" onExit={onExit} />);
  return { onExit };
};

describe('RulesChatScreen', () => {
  it('shows the game name, the question, a searching state, then the answer, and clears input', async () => {
    let resolve!: (r: AskQuestionResponse) => void;
    const ask = vi.fn(
      () =>
        new Promise<AskQuestionResponse>((r) => {
          resolve = r;
        }),
    );
    setup(ask);
    const user = userEvent.setup();
    expect(screen.getByRole('heading', { name: 'Catan' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/question/i), 'How many cards?');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(ask).toHaveBeenCalledWith('s_1', 'How many cards?');
    expect(screen.getByText('How many cards?')).toBeInTheDocument();
    expect(screen.getByText('Searching the rulebook…')).toBeInTheDocument();
    expect(screen.getByLabelText(/question/i)).toHaveValue('');
    resolve(response('Five cards each.'));
    expect(await screen.findByText('Five cards each.')).toBeInTheDocument();
    expect(screen.queryByText('Searching the rulebook…')).not.toBeInTheDocument();
  });

  it('disables send while pending and does not ask twice', async () => {
    const ask = vi.fn(() => new Promise<AskQuestionResponse>(() => {}));
    setup(ask);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/question/i), 'one');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await user.type(screen.getByLabelText(/question/i), 'two{Enter}');
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('on 404 shows the session-ended message and disables input and button', async () => {
    const ask = vi.fn(async () => {
      throw new ApiError(404, 'NOT_FOUND', 'raw not found');
    });
    setup(ask);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/question/i), 'q');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(
      await screen.findByText('This session has ended. Start a new one from the game screen.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/raw not found/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/question/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('on daily limit shows its message and keeps input enabled', async () => {
    const ask = vi.fn(async () => {
      throw new ApiError(429, 'DAILY_LIMIT_REACHED', 'limit');
    });
    setup(ask);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/question/i), 'q');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(await screen.findByText(/question limit is used up/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/question/i)).toBeEnabled();
    await waitFor(() => expect(screen.queryByText('Searching the rulebook…')).toBeNull());
  });

  it('does not send an empty or whitespace question', async () => {
    const ask = vi.fn(async () => response('x'));
    setup(ask);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/question/i), '   ');
    await user.click(screen.getByRole('button', { name: /send/i }));
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeps earlier exchanges but sends only the new question', async () => {
    const ask = vi
      .fn<ApiClient['askQuestion']>()
      .mockResolvedValueOnce(response('First answer.'))
      .mockResolvedValueOnce(response('Second answer.'));
    setup(ask);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/question/i), 'first q');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText('First answer.');
    await user.type(screen.getByLabelText(/question/i), 'second q');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await screen.findByText('Second answer.');
    expect(screen.getByText('First answer.')).toBeInTheDocument();
    expect(ask).toHaveBeenLastCalledWith('s_1', 'second q');
  });

  it('calls onExit', async () => {
    const { onExit } = setup(vi.fn());
    await userEvent.setup().click(screen.getByRole('button', { name: /back to games/i }));
    expect(onExit).toHaveBeenCalled();
  });

  it('limits the question input to the server maximum', () => {
    setup(vi.fn());
    expect(screen.getByLabelText('Your question')).toHaveAttribute('maxlength', '1000');
  });

  it('marks the searching state as a status', async () => {
    const user = userEvent.setup();
    setup(vi.fn(() => new Promise<AskQuestionResponse>(() => undefined)));
    await user.type(screen.getByLabelText('Your question'), 'How?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('status')).toHaveTextContent('Searching the rulebook…');
  });

  it('puts the question input and the Send button in the composer', () => {
    setup(vi.fn());
    const composer = screen.getByRole('form', { name: 'Ask the referee' });
    expect(within(composer).getByLabelText('Your question')).toBeInTheDocument();
    expect(within(composer).getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });
});
