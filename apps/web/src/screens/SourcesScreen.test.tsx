import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiClient,
  CreateIngestionJobInput,
  GameWithContent,
  IngestionJobView,
} from '../api/client.js';
import { SourcesScreen } from './SourcesScreen.js';

const now = '2026-10-21T00:00:00.000Z';

const twoEditionGame: GameWithContent = {
  gameId: 'g_1',
  slug: 'game',
  name: 'Game',
  editions: [
    {
      editionId: 'e_1',
      gameId: 'g_1',
      name: 'First',
      knowledgeRevision: 0,
      createdAt: now,
      updatedAt: now,
    },
    {
      editionId: 'e_2',
      gameId: 'g_1',
      name: 'Second',
      knowledgeRevision: 0,
      createdAt: now,
      updatedAt: now,
    },
  ],
  content: [
    {
      contentId: 'c_1',
      gameId: 'g_1',
      editionId: 'e_1',
      slug: 'base',
      name: 'Base One',
      contentType: 'BASE',
      dependencies: [],
      status: 'READY',
    },
    {
      contentId: 'c_2',
      gameId: 'g_1',
      editionId: 'e_2',
      slug: 'base',
      name: 'Base Two',
      contentType: 'BASE',
      dependencies: [],
      status: 'READY',
    },
  ],
  createdAt: now,
  updatedAt: now,
};

const runningJob = (jobId: string, input: CreateIngestionJobInput): IngestionJobView => ({
  jobId,
  gameId: input.gameId,
  editionId: input.editionId,
  contentId: input.contentId,
  title: input.title,
  sourceType: input.sourceType,
  authority: input.authority,
  source: input.source,
  status: 'RUNNING',
  stage: 'FETCH',
  completedStages: ['VALIDATE'],
  createdAt: now,
  updatedAt: now,
});

function fakeApi() {
  const created: CreateIngestionJobInput[] = [];
  const getIngestion = vi.fn(async (jobId: string) => {
    const input = created[Number(jobId.slice(4)) - 1]!;
    return runningJob(jobId, input);
  });
  const api = {
    getGame: vi.fn(async () => twoEditionGame),
    createIngestion: vi.fn(async (input: CreateIngestionJobInput) => {
      created.push(input);
      return runningJob(`job_${created.length}`, input);
    }),
    getIngestion,
  } as unknown as ApiClient;
  return { api, created, getIngestion };
}

describe('SourcesScreen', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const fillUrlForm = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.type(screen.getByLabelText('Title'), 'Living Rules');
    const tier = screen.getByLabelText<HTMLSelectElement>('Trust tier');
    if (!tier.value) await user.selectOptions(tier, 'OFFICIAL_RULES');
    await user.type(
      screen.getByPlaceholderText('https://publisher.example.com/living-rules'),
      'https://publisher.example.com/rules',
    );
  };

  it('upload and URL buttons stay disabled until a trust tier is chosen', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { api, created } = fakeApi();
    render(<SourcesScreen api={api} gameId="g_1" onBack={() => {}} />);
    await screen.findByLabelText('Edition');
    await user.type(screen.getByLabelText('Title'), 'Living Rules');
    const urlInput = screen.getByPlaceholderText('https://publisher.example.com/living-rules');
    await user.type(urlInput, 'https://publisher.example.com/rules');
    const file = new File(['%PDF'], 'rules.pdf', { type: 'application/pdf' });
    await user.upload(document.querySelector<HTMLInputElement>('input[type="file"]')!, file);

    expect(screen.getByRole('button', { name: 'Ingest URL' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Upload & ingest PDF' })).toBeDisabled();

    await user.type(urlInput, '{Enter}');
    expect(created).toHaveLength(0);
    expect(api.createIngestion).not.toHaveBeenCalled();

    await user.selectOptions(screen.getByLabelText('Trust tier'), 'OFFICIAL_RULES');
    expect(screen.getByRole('button', { name: 'Ingest URL' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Upload & ingest PDF' })).toBeEnabled();
  });

  it('choosing FAQ does not pick a tier', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { api } = fakeApi();
    render(<SourcesScreen api={api} gameId="g_1" onBack={() => {}} />);
    await screen.findByLabelText('Edition');

    await user.selectOptions(screen.getByLabelText('Source type'), 'FAQ');
    const tier = screen.getByLabelText<HTMLSelectElement>('Trust tier');
    expect(tier.value).toBe('');
    expect(
      screen.getByRole('option', { name: 'Choose how official this source is…' }),
    ).toBeDisabled();
    expect(tier).toHaveAccessibleDescription(/A FAQ written by players is community discussion\./);
  });

  it('sends the chosen tier', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { api, created } = fakeApi();
    render(<SourcesScreen api={api} gameId="g_1" onBack={() => {}} />);
    await screen.findByLabelText('Edition');

    await user.selectOptions(screen.getByLabelText('Source type'), 'FAQ');
    await user.selectOptions(screen.getByLabelText('Trust tier'), 'COMMUNITY_DISCUSSION');
    await fillUrlForm(user);
    await user.click(screen.getByRole('button', { name: 'Ingest URL' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ sourceType: 'FAQ', authority: 'COMMUNITY_DISCUSSION' });
  });

  it('switches the content package to the new edition’s when the edition changes', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { api, created } = fakeApi();
    render(<SourcesScreen api={api} gameId="g_1" onBack={() => {}} />);
    await screen.findByLabelText('Edition');

    await user.selectOptions(screen.getByLabelText('Edition'), 'e_2');
    expect(screen.getByLabelText<HTMLSelectElement>('Content package').value).toBe('c_2');

    await fillUrlForm(user);
    await user.click(screen.getByRole('button', { name: 'Ingest URL' }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ editionId: 'e_2', contentId: 'c_2' });
  });

  it('stops polling the previous job when a new ingestion starts', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { api, getIngestion } = fakeApi();
    render(<SourcesScreen api={api} gameId="g_1" onBack={() => {}} />);
    await screen.findByLabelText('Edition');
    await fillUrlForm(user);

    await user.click(screen.getByRole('button', { name: 'Ingest URL' }));
    await waitFor(() => expect(getIngestion).toHaveBeenCalledWith('job_1'));
    await user.click(screen.getByRole('button', { name: 'Ingest URL' }));
    await waitFor(() => expect(getIngestion).toHaveBeenCalledWith('job_2'));

    getIngestion.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    const polled = getIngestion.mock.calls.map(([id]) => id);
    expect(polled).toContain('job_2');
    expect(polled).not.toContain('job_1');
  });

  it('stops polling after unmount', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { api, getIngestion } = fakeApi();
    const { unmount } = render(<SourcesScreen api={api} gameId="g_1" onBack={() => {}} />);
    await screen.findByLabelText('Edition');
    await fillUrlForm(user);
    await user.click(screen.getByRole('button', { name: 'Ingest URL' }));
    await waitFor(() => expect(getIngestion).toHaveBeenCalledWith('job_1'));

    unmount();
    getIngestion.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getIngestion).not.toHaveBeenCalled();
  });
});
