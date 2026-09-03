import { ReactNode, useCallback } from "react";
import { useRouter } from "next/router";
import Sidebar from "./Sidebar";
import TourGate from "@/components/onboarding/TourGate";
import RunnerHealthBanner from "./RunnerHealthBanner";

const NO_LAYOUT_PATHS = ["/login"];

export default function Layout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const handleCollapse = useCallback(() => {}, []);

  if (NO_LAYOUT_PATHS.includes(router.pathname)) {
    return <>{children}</>;
  }

  return (
    <div className="h-screen overflow-hidden bg-base-100 flex">
      <TourGate />
      <Sidebar onCollapse={handleCollapse} />
      {/* Below the NO_LAYOUT_PATHS early return above, so the banner never
          mounts — and never polls — on /login. Structural, not a condition
          inside the component that a later edit could quietly drop. */}
      <div className="ml-13 flex-1 flex flex-col overflow-hidden transition-[margin] duration-200">
        <RunnerHealthBanner />
        <main className="flex-1 p-6 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
