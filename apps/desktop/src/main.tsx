import ReactDOM from "react-dom/client";

import { Cursor } from "./cursor";
import { Panel } from "./panel";
import "./styles.css";

const root = document.getElementById("root") as HTMLElement;
const view = new URLSearchParams(location.search).get("view");

ReactDOM.createRoot(root).render(view === "cursor" ? <Cursor /> : <Panel />);
