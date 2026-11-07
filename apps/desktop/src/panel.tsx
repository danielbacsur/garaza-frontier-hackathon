import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";

// Shows the prompt that opens with the hotkey, and refocuses it each time,
// so a person can start typing straight away from any app.
export function Panel() {
  const input = useRef<HTMLInputElement>(null);
  const [question, setQuestion] = useState("");

  useEffect(() => {
    const summoned = listen("summoned", () => input.current?.focus());

    return () => void summoned.then((stop) => stop());
  }, []);

  return (
    <form
      className="panel"
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") void invoke("dismiss");
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
