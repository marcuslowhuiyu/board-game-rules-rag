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
    <section className="screen chat-screen" aria-labelledby="chat-title">
      <button className="button back" type="button" onClick={onExit}>
        Back to games
      </button>
      <h2 id="chat-title">{gameName}</h2>
      <ol className="list conversation" aria-label="Conversation">
        {exchanges.map((x) => (
          <li key={x.id} className="exchange">
            <p className="bubble">{x.question}</p>
            {x.response && <AnswerCard response={x.response} />}
            {x.error && (
              <div className="error" role="alert">
                {x.error}
              </div>
            )}
            {!x.response && !x.error && (
              <p className="thinking" role="status">
                <span className="dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span>Searching the rulebook…</span>
              </p>
            )}
          </li>
        ))}
      </ol>
      <form className="composer" aria-label="Ask the referee" onSubmit={submit}>
        <label htmlFor="chat-question" className="sr-only">
          Your question
        </label>
        <input
          id="chat-question"
          className="input"
          type="text"
          placeholder="Ask a rules question…"
          value={draft}
          maxLength={1000}
          disabled={ended}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button className="button primary" type="submit" disabled={pending || ended}>
          Send
        </button>
      </form>
    </section>
  );
};
