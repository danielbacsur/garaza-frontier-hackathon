import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { Sidebar } from "@/components/sidebar";
import { recordings } from "@/lib/recordings";
import "./globals.css";

const inter = Inter({
  subsets: ["latin", "latin-ext"],
  axes: ["opsz"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Second Cursor · Dashboard",
  description: "Who uses the second cursor, what they ask, and how they move through legacy software.",
};

export const viewport: Viewport = {
  themeColor: "#f6f6f7",
  colorScheme: "light",
};

/**
 * A full-screen frame: the sidebar on the frame's grey, and one white pane that holds the open
 * view and scrolls on its own.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const recorded = await recordings();

  return (
    <html lang="en" className={inter.variable}>
      <body>
        <div className="grid h-dvh grid-cols-[256px_minmax(0,1fr)] p-2 max-md:grid-cols-1">
          <Sidebar recordings={recorded.map(({ slug, title }) => ({ slug, title }))} />
          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_1px_3px_rgb(0_0_0/0.04)]">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
