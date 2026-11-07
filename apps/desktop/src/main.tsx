import { invoke } from "@tauri-apps/api/core";
import ReactDOM from "react-dom/client";

import { Cursor } from "./cursor";
import { Panel } from "./panel";
import "./styles.css";

// Sends window errors to the app's log, because nothing printed in a webview
// survives for anyone to read after something goes wrong.
function report(message: string) {
  void invoke("report", { message }).catch(() => undefined);
}

addEventListener("error", (event) => report(event.message));
addEventListener("unhandledrejection", (event) => report(String(event.reason)));

const root = document.getElementById("root") as HTMLElement;
const view = new URLSearchParams(location.search).get("view");

ReactDOM.createRoot(root).render(view === "cursor" ? <Cursor /> : <Panel />);
