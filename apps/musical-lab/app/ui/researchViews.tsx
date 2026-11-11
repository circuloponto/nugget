import dynamic from "next/dynamic";
import type { ComponentType } from "react";

/**
 * The research tools' views, loaded on demand. This module is what a normal production build leaves out: next.config.mjs
 * points the import "research-views" at researchViews.off.tsx unless the build is a development one or was made with
 * NEXT_PUBLIC_NUGGET_RESEARCH=1, so the tools' code is not in the output at all (not just hidden).
 */
type View = ComponentType<{ active?: boolean }>;
export const CorpusExplorer: View | null = dynamic(() => import("../corpus/CorpusExplorer"), { ssr: false });
export const ComparisonView: View | null = dynamic(() => import("../corpus/compare/ComparisonView"), { ssr: false });
export const AbListening: View | null = dynamic(() => import("../ab/AbListening"), { ssr: false });
export const Lab: View | null = dynamic(() => import("../Lab"), { ssr: false });
