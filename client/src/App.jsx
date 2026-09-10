import { useEffect } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { Aurora } from "./components/Aurora";
import { Home } from "./pages/Home";
import { AssignedPRs } from "./pages/AssignedPRs";
import { Review } from "./pages/Review";

// Every navigation lands at the top of the new screen. Without this, jumping
// from a scrolled diff into another route keeps the old scroll position and the
// entrance animation plays somewhere off-screen.
function ScrollToTop() {
  const { pathname } = useLocation();
  // Block body, not a concise arrow: an effect's return value is treated as its
  // cleanup function, and `window.scrollTo` is a common target for extension /
  // smooth-scroll-polyfill patching that makes it return something non-void.
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [pathname]);
  return null;
}

// The working shell: sidebar + content, over a dimmed version of the landing
// page's aurora so the two halves of the app feel like one product.
function AppShell() {
  const { pathname } = useLocation();
  // The diff needs the full width; every other screen reads better centred.
  const wide = pathname.startsWith("/review/");

  return (
    <div className="relative flex min-h-screen">
      <Aurora intensity="soft" grid={false} />
      <Sidebar />
      <main className="min-w-0 flex-1 px-6 py-8 lg:px-10">
        <div
          key={pathname}
          className={`animate-fade-up ${wide ? "" : "mx-auto max-w-6xl"}`}
        >
          <Outlet />
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route element={<AppShell />}>
          <Route path="/prs" element={<AssignedPRs />} />
          <Route path="/review/:owner/:repo/:number" element={<Review />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
