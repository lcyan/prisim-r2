// lib/auth/handlers.ts
//
// Thin re-export shim — Next.js App Router requires GET / POST as named
// exports from route.ts. Pulling { handlers: { GET, POST } } from
// lib/auth/index.ts in the route file would work, but a dedicated module
// keeps the route file at three lines and makes "where the handlers come
// from" obvious during code review.

export { handlers as default } from "./index";

import { handlers } from "./index";
export const { GET, POST } = handlers;
