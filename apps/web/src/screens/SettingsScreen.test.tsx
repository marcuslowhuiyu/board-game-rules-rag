import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type ApiClient, type ModelSettingsView } from '../api/client.js';
import { SettingsScreen } from './SettingsScreen.js';

const view = (answerer = 'gpt-6-luna'): ModelSettingsView => ({
  roles: [
    {
      role: 'router',
      chosen: 'nova-micro',
      default: 'nova-micro',
      options: [
        {
          key: 'nova-micro',
          displayName: 'Nova Micro',
          inputUsdPerMTok: 0.035,
          outputUsdPerMTok: 0.14,
        },
      ],
    },
    {
      role: 'reranker',
      chosen: 'gpt-6-luna',
      default: 'gpt-6-luna',
      options: [
        {
          key: 'nova-micro',
          displayName: 'Nova Micro',
          inputUsdPerMTok: 0.035,
          outputUsdPerMTok: 0.14,
        },
        { key: 'gpt-6-luna', displayName: 'GPT-6 Luna', inputUsdPerMTok: 0.5, outputUsdPerMTok: 2 },
      ],
    },
    {
      role: 'answerer',
      chosen: answerer,
      default: 'gpt-6-luna',
      options: [
        { key: 'gpt-6-luna', displayName: 'GPT-6 Luna', inputUsdPerMTok: 0.5, outputUsdPerMTok: 2 },
        { key: 'opus', displayName: 'Opus', inputUsdPerMTok: 5, outputUsdPerMTok: 25 },
      ],
    },
  ],
});

const fakeApi = (setModelChoice = vi.fn(async () => view('opus'))) =>
  ({ getModelSettings: vi.fn(async () => view()), setModelChoice }) as unknown as ApiClient;

describe('SettingsScreen', () => {
  it('shows a labelled select per role with priced options and the chosen key selected', async () => {
    render(<SettingsScreen api={fakeApi()} onBack={() => {}} />);
    const answerer = await screen.findByLabelText<HTMLSelectElement>('Answerer');
    expect(answerer.value).toBe('gpt-6-luna');
    expect(screen.getByLabelText<HTMLSelectElement>('Router').options).toHaveLength(1);
    expect(screen.getByLabelText<HTMLSelectElement>('Reranker').value).toBe('gpt-6-luna');
    expect(
      screen.getByRole('option', { name: 'Opus — $5 in / $25 out per 1M tokens' }),
    ).toBeInTheDocument();
  });

  it('saves a changed answerer and says so', async () => {
    const set = vi.fn(async () => view('opus'));
    const user = userEvent.setup();
    render(<SettingsScreen api={fakeApi(set)} onBack={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Answerer'), 'opus');
    expect(set).toHaveBeenCalledWith('answerer', 'opus');
    expect(
      await screen.findByText('Saved. New questions use it within about a minute.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLSelectElement>('Answerer').value).toBe('opus');
  });

  it('shows a rejected save and reverts the select', async () => {
    const set = vi.fn(async () => {
      throw new ApiError(400, 'VALIDATION', 'model "opus" is not approved for answerer');
    });
    const user = userEvent.setup();
    render(<SettingsScreen api={fakeApi(set)} onBack={() => {}} />);
    await user.selectOptions(await screen.findByLabelText('Answerer'), 'opus');
    expect(await screen.findByText(/not approved for answerer/)).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLSelectElement>('Answerer').value).toBe('gpt-6-luna');
  });

  it('always shows the open-in-dev notice', async () => {
    render(<SettingsScreen api={fakeApi()} onBack={() => {}} />);
    expect(
      await screen.findByText('Settings are open to anyone with the link in dev.'),
    ).toBeInTheDocument();
  });
});
