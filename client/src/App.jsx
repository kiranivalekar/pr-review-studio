import { Routes, Route } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { AssignedPRs } from "./pages/AssignedPRs";
import { Review } from "./pages/Review";

export default function App() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 px-8 py-6">
        <Routes>
          <Route path="/" element={<AssignedPRs />} />
          <Route path="/review/:owner/:repo/:number" element={<Review />} />
        </Routes>
      </main>
    </div>
  );
}
