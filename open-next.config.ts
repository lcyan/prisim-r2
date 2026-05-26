// open-next.config.ts
//
// Minimal OpenNext config for Cloudflare Workers deploy.
// `defineCloudflareConfig` injects the required Cloudflare overrides
// (wrapper: cloudflare-node, converter: edge, proxyExternalRequest: fetch);
// hand-rolling the OpenNextConfig object skips those defaults and the build
// rejects the config schema.
//
// We intentionally do NOT enable incremental cache (no ISR/SSG in this app),
// image optimization (no Next/Image usage), or multi-worker split.
// See docs/superpowers/specs/2026-05-26-migrate-pages-to-workers-design.md.

import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
