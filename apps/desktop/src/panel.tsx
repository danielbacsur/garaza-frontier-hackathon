import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { ask, type Control, reset } from "./agent";

// Shows the prompt that opens with the hotkey, and refocuses it each time,
// so a person can start typing straight away from any app.
export function Panel() {
  const input = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const summoned = listen("summoned", () => input.current?.focus());

    return () => void summoned.then((stop) => stop());
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
      className="panel"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === "Escape") close();
      }}
    >
      {reply && <p>{reply}</p>}

      <input
        ref={input}
        value={question}
        placeholder={busy ? "Looking…" : "Ask anything"}
        onChange={(event) => setQuestion(event.target.value)}
        autoFocus
      />
    </form>
  );
}
