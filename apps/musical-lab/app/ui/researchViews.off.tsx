import type { ComponentType } from "react";

/** The stand-in for researchViews.tsx in a normal production build: there are no research views. */
type View = ComponentType<{ active?: boolean }>;
export const CorpusExplorer: View | null = null;
export const ComparisonView: View | null = null;
export const AbListening: View | null = null;
export const Lab: View | null = null;
