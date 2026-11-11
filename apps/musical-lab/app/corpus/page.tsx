import { notFound } from "next/navigation";
import { RESEARCH_TOOLS } from "../../lib/research";
import AppShell from "../ui/AppShell";

export const metadata = { title: "Corpus Analysis — Nugget" };

export default function CorpusPage() {
  if (!RESEARCH_TOOLS) notFound(); // internal tool: not a route of the product build
  return <AppShell initial="corpus" />;
}
