# Multipart upload cleanup

R2's multipart upload protocol is two-phase:

1. `CreateMultipartUpload` → R2 mints an `uploadId` and starts holding
   already-uploaded parts in storage.
2. The browser uploads each part with a separate presigned `UploadPart`.
3. `CompleteMultipartUpload` stitches the parts together into the final
   object, OR `AbortMultipartUpload` discards them.

If the browser tab closes between steps 2 and 3 (network blip, user
navigates away, dispatcher hits an unrecoverable error and `aborts`
client-side but the abort itself fails), R2 keeps the uploaded parts in
storage indefinitely. They don't appear in `ListObjects`, but they DO
count against the bucket's billable size.

Prisim issues an `AbortMultipartUpload` from
`app/api/r2/multipart/abort/route.ts` when:

- The upload queue store's `removeTask` handler triggers a cleanup,
- The browser's `beforeunload` guard fires before page navigation,
- A dispatcher retry exhausts the per-part attempt budget.

These paths cover the happy and most semi-happy cases. They DO NOT cover:

- Hard browser crashes,
- `navigator.sendBeacon` failures during `beforeunload`,
- Pages worker eviction mid-multipart.

For those, R2's lifecycle rules are the only safety net.

## Recommended lifecycle rule

Apply this rule to every bucket Prisim writes to:

```json
{
  "rules": [
    {
      "id": "abort-incomplete-multipart-after-7d",
      "enabled": true,
      "abortIncompleteMultipartUpload": {
        "daysAfterInitiation": 7
      }
    }
  ]
}
```

Seven days is the canonical S3 default and balances two failure modes:

- Too short (≤ 1 day) and a user who started a 50 GB overnight upload
  loses progress if their laptop suspended.
- Too long (≥ 30 days) and a runaway flaky network costs real money.

## Applying with `wrangler`

```bash
wrangler r2 bucket lifecycle add \
  --bucket <bucket-name> \
  --id abort-incomplete-multipart-after-7d \
  --abort-incomplete-multipart-upload-days 7
```

Or paste the JSON above in the Cloudflare dashboard → R2 → Bucket →
Settings → Object lifecycle rules.

## Observing storage charge

R2 surfaces in-progress multipart bytes under "Class A operations" /
"Storage" line items on the Cloudflare billing page, but not in
`ListObjects`. To audit a bucket manually:

```bash
wrangler r2 bucket info <bucket-name>
```

The `Storage Used` figure includes in-progress multipart parts; a
spike here without a corresponding `ListObjects` size growth is the
signature of a leaking-multipart bug. File an issue with the bucket
name and the time window — Prisim writes an audit row at every
multipart create/complete/abort, so the corresponding upload(s) can be
traced via the audit_log table.
