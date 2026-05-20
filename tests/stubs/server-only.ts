// Vitest stub for the `server-only` package.
//
// The real package's index.js throws synchronously when imported in a
// browser-flavored module graph — Vitest runs in Node but webpack-style
// resolution still hits it. Aliasing to this empty module lets server-side
// libs (lib/db/*, lib/crypto/*, …) be unit-tested without bundling magic.
export {};
