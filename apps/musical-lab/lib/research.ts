/**
 * The research tools (corpus explorer, generator-against-corpus comparison, engine evaluator) are internal: they
 * exist for developing the generator, not for people who use the app. They are available in development, and in a
 * production build only if it was built with NEXT_PUBLIC_NUGGET_RESEARCH=1. Both inputs are replaced at build time,
 * so in an ordinary production build the code behind this flag is removed, not just hidden, and their routes answer
 * 404 (see the pages) and /api/corpus refuses (see corpusAccess).
 */
export const RESEARCH_TOOLS: boolean = process.env.NODE_ENV !== "production" || process.env.NEXT_PUBLIC_NUGGET_RESEARCH === "1";
