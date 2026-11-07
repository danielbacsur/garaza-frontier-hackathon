import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { type FormEvent, useEffect, useRef, useState } from "react";

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

  // Hands the question to the second cursor, whose window stays on screen
  // and so is never throttled the way this hidden prompt would be.
  function submit(event: FormEvent) {
    event.preventDefault();

    if (!question.trim()) return;

    setQuestion("");
    void invoke("think", { question });
  }

  // Ends the conversation and hides everything, which hands focus back to
  // the app the person was using before the prompt opened.
  function close() {
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
