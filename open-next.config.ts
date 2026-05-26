// open-next.config.ts
//
// Minimal OpenNext config for Cloudflare Workers deploy.
// We intentionally do NOT enable incremental cache (no ISR/SSG in this app),
// image optimization (no Next/Image usage), or multi-worker split.
// See docs/superpowers/specs/2026-05-26-migrate-pages-to-workers-design.md.

import type { OpenNextConfig } from "@opennextjs/cloudflare";

const config: OpenNextConfig = {
  default: {},
};

export default config;
