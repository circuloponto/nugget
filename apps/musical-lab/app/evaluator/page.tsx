import AppShell from "../ui/AppShell";

export const metadata = { title: "Engine evaluator — Nugget" };

// The phase-1 engine evaluator, kept as it was, now one tab of the app.
export default function Evaluator() {
  return <AppShell initial="evaluator" />;
}
