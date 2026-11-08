/*
 * Sample data for the pitch: one accounting firm whose employees use the second cursor beside their
 * legacy software. Users and questions are made up; recordings (lib/recordings.ts) are real, rendered
 * from this laptop by tools/heatmap.
 */

export const workspace = "Kovács & Társa";

export type AppId = "nav" | "novitax" | "excel" | "sheets" | "anyk" | "outlook" | "github";

/** The legacy software the firm's people ask about, with the colour of its chip dot. */
export const apps: Record<AppId, { name: string; color: string }> = {
  nav: { name: "NAV Online Számla", color: "#4cad37" },
  novitax: { name: "Novitax", color: "#d9534f" },
  excel: { name: "Excel", color: "#1f8f4e" },
  sheets: { name: "Google Sheets", color: "#0f9d58" },
  anyk: { name: "ÁNYK", color: "#2f6fd6" },
  outlook: { name: "Outlook", color: "#1a73c8" },
  github: { name: "GitHub", color: "#24292f" },
};

export type User = {
  id: string;
  name: string;
  role: string;
  team: string;
  /** Questions asked over the last seven days, oldest first. */
  week: number[];
  /** Steps the second cursor pointed at and saw done. */
  steps: number;
  topApp: AppId;
  lastActive: string;
  /** Online right now, with the second cursor open. */
  live?: boolean;
};

export const users: User[] = [
  { id: "szilagyi", name: "Szilágyi Anna", role: "Senior bookkeeper", team: "Accounting", week: [6, 9, 4, 7, 11, 2, 0], steps: 214, topApp: "nav", lastActive: "now", live: true },
  { id: "nagy", name: "Nagy Balázs", role: "Junior accountant", team: "Accounting", week: [12, 14, 9, 15, 13, 1, 0], steps: 402, topApp: "novitax", lastActive: "now", live: true },
  { id: "kiss", name: "Kiss Péter", role: "Payroll specialist", team: "HR", week: [3, 5, 8, 6, 4, 0, 0], steps: 131, topApp: "anyk", lastActive: "12m" },
  { id: "horvath", name: "Horváth Réka", role: "Tax advisor", team: "Tax", week: [2, 4, 3, 5, 6, 0, 1], steps: 96, topApp: "anyk", lastActive: "34m" },
  { id: "varga", name: "Varga Gergely", role: "Accounts payable", team: "Accounting", week: [8, 7, 10, 6, 9, 0, 0], steps: 287, topApp: "nav", lastActive: "1h" },
  { id: "toth", name: "Tóth Eszter", role: "Office manager", team: "Operations", week: [4, 3, 5, 2, 4, 0, 0], steps: 88, topApp: "outlook", lastActive: "2h" },
  { id: "farkas", name: "Farkas Bence", role: "Intern", team: "Accounting", week: [15, 18, 13, 17, 12, 0, 0], steps: 516, topApp: "excel", lastActive: "3h" },
  { id: "molnar", name: "Molnár Dóra", role: "Sales assistant", team: "Sales", week: [1, 3, 2, 4, 2, 0, 0], steps: 47, topApp: "excel", lastActive: "yesterday" },
];

export type Question = {
  text: string;
  app: AppId;
  asks: number;
  /** Change against the week before, in percent. */
  trend: number;
  askers: string[];
  /** Steps a typical answer walks through. */
  steps: number;
  /** The recording of its workflow (a slug in public/heatmaps), the first step to learning it as a skill. */
  recording?: string;
};

export const questions: Question[] = [
  { text: "How do I export last month's invoices from NAV Online Számla?", app: "nav", asks: 47, trend: 18, askers: ["szilagyi", "varga", "nagy", "farkas"], steps: 6 },
  { text: "Where do I add a new supplier in Novitax?", app: "novitax", asks: 38, trend: 6, askers: ["nagy", "farkas", "varga"], steps: 5 },
  { text: "How do I make a pivot table of invoices by customer?", app: "sheets", asks: 33, trend: 41, askers: ["farkas", "molnar", "nagy"], steps: 7, recording: "sheets-pivot" },
  { text: "How do I sign and send the 08 form in ÁNYK?", app: "anyk", asks: 29, trend: -4, askers: ["kiss", "horvath"], steps: 8 },
  { text: "How do I cancel a rejected invoice in NAV?", app: "nav", asks: 24, trend: 12, askers: ["varga", "szilagyi"], steps: 5 },
  { text: "How do I import the bank statement into Novitax?", app: "novitax", asks: 19, trend: -9, askers: ["nagy", "szilagyi", "farkas"], steps: 6 },
  { text: "Where is the VAT analytics report?", app: "novitax", asks: 17, trend: 3, askers: ["horvath", "nagy"], steps: 4 },
  { text: "How do I set up an out-of-office reply?", app: "outlook", asks: 14, trend: 0, askers: ["toth", "molnar", "kiss"], steps: 4 },
  { text: "How do I freeze the header row?", app: "excel", asks: 12, trend: -15, askers: ["farkas", "molnar"], steps: 3 },
  { text: "How do I create a private repository for a client project?", app: "github", asks: 11, trend: 22, askers: ["nagy", "varga"], steps: 6, recording: "github-repo" },
  { text: "How do I update the ÁNYK form templates?", app: "anyk", asks: 9, trend: -20, askers: ["kiss"], steps: 5 },
];

export const userById = (id: string) => users.find((user) => user.id === id)!;

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
