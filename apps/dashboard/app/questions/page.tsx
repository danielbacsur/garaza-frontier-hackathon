import Link from "next/link";
import { Heatmaps } from "@/components/icons";
import { AppChip, AvatarStack, Body, Heading, TopBar, Trend, rise } from "@/components/ui";
import { apps, questions, sum, users, type AppId } from "@/lib/data";

export const metadata = { title: "Questions · Second Cursor" };

const isApp = (value: unknown): value is AppId => typeof value === "string" && value in apps;

/**
 * The questions people ask most, phrasings of one task folded together. The most asked are the
 * workflows worth recording and turning into skills, so a recorded one links to its heatmap.
 */
export default async function QuestionsPage({ searchParams }: PageProps<"/questions">) {
  const { app } = await searchParams;
  const filter = isApp(app) ? app : null;
  const shown = filter ? questions.filter((q) => q.app === filter) : questions;
  const top = Math.max(...questions.map((q) => q.asks));
  const asked = sum(users.map((user) => sum(user.week)));
  const listed = sum(questions.map((q) => q.asks));

  const tab = (active: boolean) =>
    `inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium transition-colors ${
      active ? "bg-black/[0.055] text-fg" : "text-fg-3 hover:text-fg-2"
    }`;

  return (
    <>
      <TopBar title="Questions">
        <span>
          {listed} of {asked} asked this week are these {questions.length}
        </span>
      </TopBar>
      <Body wide>
        <Heading
          at={0}
          title="Most asked questions"
          lead="What people asked the second cursor this week, with the different phrasings of one task counted together."
        />

        <div className="rise mt-5 flex flex-wrap gap-1" style={rise(1)}>
          <Link href="/questions" className={tab(!filter)}>
            All software
          </Link>
          {(Object.keys(apps) as AppId[]).map((id) => (
            <Link key={id} href={`/questions?app=${id}`} className={tab(filter === id)}>
              {apps[id].name}
            </Link>
          ))}
        </div>

        <ol className="card rise mt-4 overflow-hidden" style={rise(2)}>
          {shown.map((q, i) => (
            <li
              key={q.text}
              className={`relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 ${
                i < shown.length - 1 ? "hairline-b" : ""
              }`}
            >
              <span className="text-[13px] font-medium text-fg-4 tabular-nums">{questions.indexOf(q) + 1}</span>
              <div className="min-w-0">
                <div className="truncate text-[14px] font-medium tracking-[-0.006em] text-fg">{q.text}</div>
                <div className="mt-1.5 flex items-center gap-3 text-[12px] text-fg-4">
                  <AppChip app={q.app} />
                  <span>{q.steps} steps</span>
                  {q.recording ? (
                    <Link href={`/heatmaps?r=${q.recording}`} className="inline-flex items-center gap-1 font-medium text-accent">
                      <Heatmaps size={13} />
                      Workflow recorded
                    </Link>
                  ) : null}
                </div>
                {/* How often, against the most asked question. */}
                <div className="mt-2.5 h-1 rounded-full bg-black/[0.05]">
                  <div className="h-full rounded-full bg-accent/60" style={{ width: `${(q.asks / top) * 100}%` }} />
                </div>
              </div>
              <div className="flex items-center gap-5 pl-4">
                <span className="flex w-[84px] justify-end">
                  <AvatarStack ids={q.askers} />
                </span>
                <span className="w-14 text-right text-[12px] whitespace-nowrap tabular-nums">
                  <Trend value={q.trend} />
                </span>
                <span className="w-10 text-right text-[15px] font-semibold text-fg tabular-nums">{q.asks}</span>
              </div>
            </li>
          ))}
        </ol>
      </Body>
    </>
  );
}
