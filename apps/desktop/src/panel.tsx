import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { ask, type Control, reset } from "./agent";

// Shows the field that travels beside the cursor, refocused on each press of
// the hotkey so a person can start typing straight away from any app.
export function Panel() {
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const summoned = listen("summoned", () => input.current?.focus());
    const closing = listen("close", close);

    const fit = new ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.contentRect.height);

      void invoke("fit_panel", { height });
    });

    if (form.current) fit.observe(form.current);

    return () => {
      fit.disconnect();
      void summoned.then((stop) => stop());
      void closing.then((stop) => stop());
    };
  }, []);

  // Sends the question with the controls read when the panel opened, and
  // moves the second cursor as soon as the agent picks one of them.
  async function submit(event: FormEvent) {
    event.preventDefault();

    if (!question.trim() || busy) return;

    setBusy(true);
    setReply("");

    try {
      const elements = await invoke<Control[]>("screen");

      const result = await ask(question, elements, ({ elementId, caption }) => {
        if (elementId !== null) void invoke("point", { elementId, caption });
      });

      setReply(result.reply ?? "");
      setQuestion("");
    } catch (error) {
      setReply(`Something went wrong: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  // Ends the conversation and hides everything, which hands focus back to
  // the app the person was using before the panel opened.
  function close() {
    reset();
    setReply("");
    setQuestion("");
    void invoke("dismiss");
  }

  return (
    <form
      ref={form}
      className="panel"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      <div className="card">
        <input
          ref={input}
          value={question}
          placeholder={busy ? "Looking…" : "Ask anything"}
          onChange={(event) => setQuestion(event.target.value)}
          autoFocus
        />

        {reply && <p>{reply}</p>}
      </div>
    </form>
  );
}
