import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { ask, type Control, reset } from "./agent";

const FALLBACK = "Something went wrong. Please try again.";

// Shows the field that travels beside the cursor, refocused on each press of
// the hotkey so a person can start typing straight away from any app.
export function Panel() {
  const input = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");

  useEffect(() => {
    const summoned = listen("summoned", () => input.current?.focus());
    const closing = listen("close", close);

    return () => {
      void summoned.then((stop) => stop());
      void closing.then((stop) => stop());
    };
  }, []);

  // Hands the question over to the second cursor, which then points at the
  // control the agent picks and says the reply in its own bubble.
  async function submit(event: FormEvent) {
    event.preventDefault();

    if (!question.trim()) return;

    setQuestion("");

    try {
      const elements = await invoke<Control[]>("screen");

      await invoke("think");

      const result = await ask(question, elements, ({ elementId }) => {
        if (elementId !== null) void invoke("point", { elementId });
      });

      void invoke("say", { text: result.reply ?? FALLBACK });
    } catch {
      void invoke("say", { text: FALLBACK });
    }
  }

  // Ends the conversation and hides everything, which hands focus back to
  // the app the person was using before the prompt opened.
  function close() {
    reset();
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
      <input
        ref={input}
        value={question}
        placeholder="Ask anything"
        onChange={(event) => setQuestion(event.target.value)}
        autoFocus
      />
    </form>
  );
}
