import Link from "next/link";
import { PersonAvatar } from "@/components/avatar";
import { HeatmapGif, NoRecording } from "@/components/heatmap-player";
import { ArrowUpRight } from "@/components/icons";
import { AppChip, Body, Heading, SectionTitle, Stat, TopBar, Trend, rise } from "@/components/ui";
import { questions, sum, users } from "@/lib/data";
import { minutes, recordings } from "@/lib/recordings";

/** The week at a glance: how much the second cursor helped, the top questions, the latest heatmap. */
export default async function OverviewPage() {
  const [latest] = await recordings();
  const asked = sum(users.map((user) => sum(user.week)));
  const steps = sum(users.map((user) => user.steps));
  const live = users.filter((user) => user.live);

  const more = (href: string) => (
    <Link href={href} className="flex items-center gap-0.5 text-[12px] font-medium text-fg-3 hover:text-fg-2">
      See all
      <ArrowUpRight size={12} />
    </Link>
  );

  return (
    <>
      <TopBar title="Overview">
        <span>This week</span>
      </TopBar>
      <Body wide>
        <Heading at={0} title="This week at Kovács & Társa" lead="How much the second cursor helped people through their legacy software." />

        <div className="mt-6 grid grid-cols-4 gap-3 max-md:grid-cols-2">
          <Stat at={1} label="Active people" value={users.length} note={`${live.length} online now`} />
          <Stat at={2} label="Questions asked" value={asked} note={<Trend value={14} />} />
          <Stat at={3} label="Steps guided" value={steps.toLocaleString("en-US")} note="pointed at and seen done" />
          <Stat at={4} label="Handled alone" value="91%" note="no colleague interrupted" />
        </div>

        <div className="mt-8 grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-6 max-lg:grid-cols-1">
          <section className="rise" style={rise(5)}>
            <SectionTitle end={more("/questions")}>Most asked</SectionTitle>
            <ol className="card mt-2 overflow-hidden">
              {questions.slice(0, 5).map((q, i) => (
                <li key={q.text} className={`flex items-center gap-3 px-4 py-2.5 ${i < 4 ? "hairline-b" : ""}`}>
                  <span className="w-4 text-[13px] text-fg-4 tabular-nums">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-fg">{q.text}</div>
                    <div className="mt-1">
                      <AppChip app={q.app} />
                    </div>
                  </div>
                  <span className="text-[14px] font-semibold text-fg tabular-nums">{q.asks}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="rise" style={rise(6)}>
            <SectionTitle end={more("/heatmaps")}>Latest heatmap</SectionTitle>
            {latest ? (
              <Link href="/heatmaps" className="card mt-2 block overflow-hidden">
                <HeatmapGif recording={latest} />
                <div className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                  <span className="truncate font-medium text-fg">{latest.title}</span>
                  <span className="shrink-0 pl-3 text-fg-4 tabular-nums">
                    {latest.clicks} clicks · {minutes(latest.durationSec)}
                  </span>
                </div>
              </Link>
            ) : (
              <div className="mt-2">
                <NoRecording />
              </div>
            )}

            <div className="mt-6">
              <SectionTitle end={more("/users")}>Online now</SectionTitle>
              <ul className="card mt-2">
                {live.map((user, i) => (
                  <li key={user.id} className={`flex items-center gap-2.5 px-4 py-2.5 text-[13px] ${i < live.length - 1 ? "hairline-b" : ""}`}>
                    <PersonAvatar name={user.name} size={24} />
                    <span className="font-medium text-fg">{user.name}</span>
                    <span className="truncate text-fg-4">{user.role}</span>
                    <span className="ml-auto">
                      <AppChip app={user.topApp} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </Body>
    </>
  );
}
