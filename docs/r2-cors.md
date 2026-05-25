English | [中文](./r2-cors.zh-CN.md)

# R2 CORS configuration

The browser uploads and downloads object bytes directly to R2 via presigned
URLs (CLAUDE.md Security Invariant #3). R2 enforces a same-origin policy by
default, so every bucket Prisim writes to needs a CORS rule that allows the
dashboard origin to issue `PUT` (upload) and `GET` (download) requests, plus
the wildcard `Authorization`/`Content-Type` headers presigned URLs carry.

Without this rule, the very first upload fails the CORS preflight silently
— the browser cancels the `PUT` before the request reaches R2 and the only
client-visible signal is "Upload failed: TypeError: failed to fetch".

## Recommended rule

```json
[
  {
    "AllowedOrigins": ["https://your-prisim.example.com"],
    "AllowedMethods": ["GET", "PUT"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Replace `https://your-prisim.example.com` with the value of
`NEXT_PUBLIC_APP_URL` (the origin the dashboard runs on). The local
preview server is `http://localhost:8788` — add it as a second origin
during development if you want to exercise upload/download locally
against a real R2 bucket.

`ExposeHeaders: ["ETag"]` is required so the multipart upload UI can read
the per-part ETag the browser receives from `UploadPart` — the
control-plane `CompleteMultipartUpload` call expects every part's ETag,
and without the expose rule the browser strips it before our JS reads
the response.

## Applying with `wrangler`

```bash
wrangler r2 bucket cors set \
  --rules ./docs/cors-rules.json \
  <bucket-name>
```

`docs/cors-rules.json` is not committed by default — copy the JSON above,
substitute your origin, and save it locally. The Cloudflare dashboard
also accepts the same JSON under R2 → Bucket → Settings → CORS.

## Multi-environment setup

Prisim is single-user V1 but production deployments still typically have
a staging environment that talks to the same R2 buckets. Add every
deployed origin to `AllowedOrigins`:

```json
"AllowedOrigins": [
  "https://prisim.example.com",
  "https://staging.prisim.example.com",
  "http://localhost:8788"
]
```

Wildcards (`*`) are accepted by R2 but actively discouraged — a wildcard
CORS rule lets any site in the user's browser issue authenticated `PUT`s
against your bucket if they ever obtain a presigned URL. Always enumerate.

## Troubleshooting

| Symptom                                                                        | Likely cause                                                                                |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Upload fails immediately with no network entry visible                         | Browser cancelled the preflight; `AllowedOrigins` doesn't include the dashboard origin      |
| Upload reaches R2, returns 200, but the file is corrupted                      | `Content-Type` wasn't allowed; widen `AllowedHeaders` to `["*"]`                            |
| Multipart upload completes but `CompleteMultipartUpload` returns "InvalidPart" | `ExposeHeaders` is missing `ETag` — the browser stripped it before our JS could collect it  |
| 403 with `<Code>InvalidAccessKeyId</Code>`                                     | Not a CORS problem — the credentials Prisim minted into the presigned URL are wrong/rotated |
