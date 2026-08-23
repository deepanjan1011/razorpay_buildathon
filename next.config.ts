import type { NextConfig } from "next";

/**
 * `next dev` otherwise appends a generated block to CLAUDE.md on every run
 * (`next/dist/server/lib/generate-agent-files.js`).
 *
 * CLAUDE.md is hand-maintained, and every rule in it was earned from a specific
 * failure on this project. A tool that rewrites it on each dev run will
 * eventually clobber one, and the way we would find out is a rule quietly
 * ceasing to be followed — the worst possible failure signature for an
 * instruction file. See OBSTACLES.md.
 */
const config: NextConfig = {
  agentRules: false,
};

export default config;
