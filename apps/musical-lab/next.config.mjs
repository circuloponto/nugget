/**
 * The research tools (corpus explorer, generator-against-corpus comparison, blind listening, engine evaluator) are
 * internal. They exist in development, and in a production build only if it is made with NEXT_PUBLIC_NUGGET_RESEARCH=1.
 * In any other production build the import "research-views" resolves to a stub, so their code is not bundled; their
 * routes answer 404 and their APIs refuse (see lib/research.ts and lib/corpusStore.ts).
 */
const researchOff = process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_NUGGET_RESEARCH !== "1";
const real = "./app/ui/researchViews.tsx";
const stub = "./app/ui/researchViews.off.tsx";

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: { resolveAlias: { "research-views": researchOff ? stub : real } },
  webpack(config) {
    config.resolve.alias["research-views"] = new URL(researchOff ? stub : real, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    return config;
  },
};
export default nextConfig;
