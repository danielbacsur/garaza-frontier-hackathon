import { PersonAvatar } from "@/components/avatar";
import { AppChip, Body, Heading, TopBar, WeekBars, rise } from "@/components/ui";
import { sum, users } from "@/lib/data";

export const metadata = { title: "Users · Second Cursor" };

const days = ["M", "T", "W", "T", "F", "S", "S"];

/** Everyone with the second cursor installed: who they are, how much they lean on it, and where. */
export default function UsersPage() {
  const max = Math.max(...users.flatMap((user) => user.week));
  const sorted = [...users].sort((a, b) => sum(b.week) - sum(a.week));
  const live = users.filter((user) => user.live).length;

  return (
    <>
      <TopBar title="Users">
        <span className="flex items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-green" />
          {live} online
        </span>
        <span>{users.length} people</span>
      </TopBar>
      <Body wide>
        <Heading
          at={0}
          title="Users"
          lead="Everyone at the firm with the second cursor installed, by how often they asked it for help this week."
        />

        <div className="card rise mt-6 overflow-hidden" style={rise(1)}>
          <div className="hairline-b grid h-9 grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_96px_minmax(0,1.6fr)_80px_88px] items-center gap-4 px-4 text-[12px] font-medium text-fg-4">
            <span>Person</span>
            <span>Team</span>
            <span className="flex justify-between pr-1">
              {days.map((day, i) => (
                <span key={i} className="w-[5px] text-center text-[10px]">
                  {day}
                </span>
              ))}
            </span>
            <span>Asks most about</span>
            <span className="text-right">Steps</span>
            <span className="text-right">Active</span>
          </div>

          {sorted.map((user, i) => (
            <div
              key={user.id}
              className={`grid h-14 grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_96px_minmax(0,1.6fr)_80px_88px] items-center gap-4 px-4 text-[13px] ${
                i < sorted.length - 1 ? "hairline-b" : ""
              }`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="relative">
                  <PersonAvatar name={user.name} size={28} />
                  {user.live ? (
                    <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-green shadow-[0_0_0_2px_#fff]" />
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-fg">{user.name}</span>
                  <span className="block truncate text-[12px] text-fg-4">{user.role}</span>
                </span>
              </span>
              <span className="truncate text-fg-3">{user.team}</span>
              <span className="flex items-center gap-2">
                <WeekBars week={user.week} max={max} />
                <span className="text-[12px] text-fg-4 tabular-nums">{sum(user.week)}</span>
              </span>
              <span className="min-w-0">
                <AppChip app={user.topApp} />
              </span>
              <span className="text-right text-fg-2 tabular-nums">{user.steps}</span>
              <span className={`text-right tabular-nums ${user.live ? "font-medium text-green" : "text-fg-4"}`}>
                {user.lastActive}
              </span>
            </div>
          ))}
        </div>
      </Body>
    </>
  );
}
