import { useRef, useState, type FormEvent } from 'react';
import type { ApiClient, AskQuestionResponse, SessionView } from '../api/client.js';
import { askErrorMessage } from '../answer-view.js';
import { AnswerCard } from '../components/AnswerCard.js';

interface Props {
  api: ApiClient;
  session: SessionView;
  gameName: string;
  onExit: () => void;
}

interface Exchange {
  id: number;
  question: string;
  response?: AskQuestionResponse;
  error?: string;
}

export const RulesChatScreen = ({ api, session, gameName, onExit }: Props): JSX.Element => {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [ended, setEnded] = useState(false);
  const inFlight = useRef(false);
  const nextId = useRef(0);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const question = draft.trim();
    if (!question || inFlight.current || ended) return;
    inFlight.current = true;
    const id = nextId.current++;
    setExchanges((prev) => [...prev, { id, question }]);
    setDraft('');
    setPending(true);
    const update = (patch: Partial<Exchange>): void =>
      setExchanges((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      update({ response: await api.askQuestion(session.sessionId, question) });
    } catch (err) {
      const { message, sessionEnded } = askErrorMessage(err);
      if (sessionEnded) setEnded(true);
      update({ error: message });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section className="screen" aria-labelledby="chat-title">
      <button className="button" type="button" onClick={onExit}>
        Back to games
      </button>
      <h2 id="chat-title">{gameName}</h2>
      <ol className="list" aria-label="Conversation">
        {exchanges.map((x) => (
          <li key={x.id} className="list-item">
            <p className="name">{x.question}</p>
            {x.response && <AnswerCard response={x.response} />}
            {x.error && (
              <div className="error" role="alert">
                {x.error}
              </div>
            )}
            {!x.response && !x.error && (
              <p className="meta" role="status">
                Searching the rulebook…
              </p>
            )}
          </li>
        ))}
      </ol>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="chat-question">Your question</label>
          <input
            id="chat-question"
            className="input"
            type="text"
            value={draft}
            maxLength={1000}
            disabled={ended}
            onChange={(e) => setDraft(e.target.value)}
          />
        </div>
        <button className="button primary" type="submit" disabled={pending || ended}>
          Send
        </button>
      </form>
    </section>
  );
};
