import { notFound } from "next/navigation";
import { RESEARCH_TOOLS } from "../../lib/research";
import AppShell from "../ui/AppShell";

export const metadata = { title: "Engine evaluator — Nugget" };

// The phase-1 engine evaluator, kept as it was, now one tab of the app.
export default function Evaluator() {
  if (!RESEARCH_TOOLS) notFound(); // internal tool: not a route of the product build
  return <AppShell initial="evaluator" />;
}
