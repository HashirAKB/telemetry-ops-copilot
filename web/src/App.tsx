// Chat with the agent and approve or deny its pending write actions.
// State lives in two polling loops: one for runs in progress, one for
// pending approvals. Simple and good enough for a local operator console.
import { useEffect, useState, type FormEvent } from "react";
import { api, setToken, UnauthorizedError, type PendingApproval, type RunState } from "./api";

const EXAMPLES = ["Why is D-17 alerting?", "Which devices have low battery?", "Open an incident for D-17 and restart it"];

export function App() {
  const [runs, setRuns] = useState<RunState[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [needsToken, setNeedsToken] = useState(false);

  // Poll runs that are still running, and the pending approvals.
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        setApprovals(await api.listApprovals());
        const running = runs.filter((r) => r.status === "running");
        if (running.length) {
          const updated = await Promise.all(running.map((r) => api.getRun(r.id)));
          setRuns((all) => all.map((r) => updated.find((u) => u.id === r.id) ?? r));
        }
        setError("");
        setNeedsToken(false);
      } catch (err) {
        if (err instanceof UnauthorizedError) setNeedsToken(true);
        else setError(`Cannot reach the agent API: ${(err as Error).message}`);
      }
    }, 700);
    return () => clearInterval(timer);
  }, [runs]);

  async function send(message: string) {
    if (!message.trim()) return;
    setInput("");
    try {
      const { runId } = await api.startRun(message.trim());
      setRuns((all) => [...all, { id: runId, question: message.trim(), status: "running" }]);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function decide(id: string, approved: boolean) {
    await api.decide(id, approved).catch((err: Error) => setError(err.message));
    setApprovals((all) => all.filter((a) => a.id !== id));
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(input);
  };

  return (
    <main>
      <header>
        <h1>Ops Copilot</h1>
        <p>Ask about the fleet. Write actions wait for your approval.</p>
      </header>

      {needsToken && (
        <form
          className="token"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get("token");
            setToken(String(value ?? ""));
            setNeedsToken(false);
          }}
        >
          <input name="token" type="password" aria-label="API token" placeholder="API token (AGENT_API_TOKEN)" />
          <button type="submit">Save</button>
        </form>
      )}

      {approvals.length > 0 && (
        <section className="approvals" aria-label="Pending approvals">
          <h2>Waiting for your approval</h2>
          {approvals.map((a) => (
            <div className="approval" key={a.id}>
              <div>
                <strong>{a.tool}</strong>
                <code>{JSON.stringify(a.args)}</code>
              </div>
              <div className="buttons">
                <button className="approve" onClick={() => decide(a.id, true)}>
                  Approve
                </button>
                <button className="deny" onClick={() => decide(a.id, false)}>
                  Deny
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="chat" aria-label="Conversation">
        {runs.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((q) => (
              <button key={q} onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>
        )}
        {runs.map((run) => (
          <article key={run.id}>
            <p className="question">{run.question}</p>
            {run.status === "running" && <p className="muted">Working...</p>}
            {run.error && <p className="error">{run.error}</p>}
            {run.result && (
              <div className="answer">
                <ul className="tools">
                  {run.result.toolCalls.map((call, i) => (
                    <li key={i} className={call.status}>
                      {call.name} <span>{call.status}</span>
                    </li>
                  ))}
                </ul>
                <p data-testid="answer">{run.result.answer}</p>
                <p className="muted">
                  {run.result.steps} LLM calls, {run.result.usage.inputTokens + run.result.usage.outputTokens} tokens, USD{" "}
                  {run.result.usage.costUsd.toFixed(4)} · <a href={`/viewer?trace=${run.id}`} target="_blank" rel="noreferrer">trace</a>
                </p>
              </div>
            )}
          </article>
        ))}
      </section>

      {error && <p className="error">{error}</p>}

      <form onSubmit={onSubmit}>
        <input
          aria-label="Message"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='e.g. "Why is D-33 alerting?"'
          maxLength={2000}
        />
        <button type="submit">Send</button>
      </form>
    </main>
  );
}
