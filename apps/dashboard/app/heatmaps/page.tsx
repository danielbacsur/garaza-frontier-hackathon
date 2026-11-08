import { HeatmapGif, NoRecording, RecordingPanel } from "@/components/heatmap-player";
import { Body, Heading, TopBar, rise } from "@/components/ui";
import { minutes, recordings } from "@/lib/recordings";

export const metadata = { title: "Heatmaps · Second Cursor" };

/**
 * A recorded workflow played back with its heatmap building up over the screen, and beside it the
 * recording's properties and how far it has come on the way to a skill.
 */
export default async function HeatmapsPage({ searchParams }: PageProps<"/heatmaps">) {
  const { r } = await searchParams;
  const all = await recordings();
  const recording = all.find((rec) => rec.slug === r) ?? all[0];

  return (
    <>
      <TopBar title="Heatmaps">
        {recording ? <span>{minutes(recording.durationSec)} recorded</span> : null}
        <span>
          {all.length} {all.length === 1 ? "recording" : "recordings"}
        </span>
      </TopBar>

      {recording ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_320px] max-lg:grid-cols-1">
          <div className="min-h-0 overflow-y-auto">
            <div className="mx-auto max-w-[1040px] px-5 pt-8 pb-16">
              <Heading
                at={0}
                title={recording.title}
                lead="Where the cursor went while the task was done once, end to end. Warm spots are where it lingered and clicked."
              />
              <div className="card rise mt-6 overflow-hidden" style={rise(1)}>
                <HeatmapGif recording={recording} />
              </div>
              <div className="rise mt-3 flex items-center gap-4 text-[12px] text-fg-4" style={rise(2)}>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-16 rounded-full bg-[linear-gradient(90deg,#3b5bdb,#22b8cf,#40c057,#fab005,#f03e3e)]" />
                  Less to more time
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full shadow-[inset_0_0_0_1.5px_#fff,0_0_0_1.5px_var(--accent)]" />
                  Click
                </span>
              </div>
            </div>
          </div>
          <div className="min-h-0 overflow-y-auto shadow-[inset_1px_0_0_rgb(0_0_0/0.06)] max-lg:shadow-[inset_0_1px_0_rgb(0_0_0/0.06)]">
            <RecordingPanel recording={recording} />
          </div>
        </div>
      ) : (
        <Body>
          <Heading at={0} title="Heatmaps" lead="How people move through the software they work in, recorded one workflow at a time." />
          <div className="rise mt-6" style={rise(1)}>
            <NoRecording />
          </div>
        </Body>
      )}
    </>
  );
}
