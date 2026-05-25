[English](./multipart-cleanup.md) | 中文

# 分片上传清理

R2 的分片上传 (multipart) 协议是两阶段的:

1. `CreateMultipartUpload` → R2 生成一个 `uploadId`,并开始把已上传的
   分片保存在存储里。
2. 浏览器为每一片各发起一次预签名 `UploadPart`。
3. `CompleteMultipartUpload` 把所有分片拼成最终对象,或者用
   `AbortMultipartUpload` 抛弃它们。

如果浏览器标签页在第 2 步和第 3 步之间关闭 (网络抖动、用户跳走、
调度器遇到不可恢复错误后客户端发起 `abort` 但 abort 本身又失败),
R2 会一直把这些已上传的分片留在存储里。它们不会出现在 `ListObjects`
里,但是 _会_ 计入桶的可计费体积。

Prisim 在以下时机会从 `app/api/r2/multipart/abort/route.ts` 发起
`AbortMultipartUpload`:

- 上传队列 store 的 `removeTask` 触发清理时,
- 浏览器 `beforeunload` 守卫在页面跳转前触发时,
- 调度器对某个分片的重试预算用完时。

这些路径覆盖了正常流程和大部分半失败场景。它们 _不会_ 覆盖:

- 浏览器硬崩溃,
- `beforeunload` 期间 `navigator.sendBeacon` 失败,
- Pages worker 在分片上传中途被回收。

针对这些场景,R2 的生命周期规则是唯一的兜底。

## 推荐的生命周期规则

对每一个 Prisim 会写入的桶都应用这条规则:

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

七天是 S3 的标准默认值,在两类失败模式之间取了平衡:

- 设得太短 (≤ 1 天),如果用户启了个 50 GB 的过夜上传,笔记本休眠就
  会丢进度。
- 设得太长 (≥ 30 天),网络一直抖会真烧钱。

## 用 `wrangler` 应用

```bash
wrangler r2 bucket lifecycle add \
  --bucket <bucket-name> \
  --id abort-incomplete-multipart-after-7d \
  --abort-incomplete-multipart-upload-days 7
```

或者直接在 Cloudflare 控制台 → R2 → 存储桶 → Settings → Object
lifecycle rules 里粘贴上面的 JSON。

## 观察存储费用

R2 在 Cloudflare 计费页里把进行中的分片字节归在 "Class A operations" /
"Storage" 项下,但 `ListObjects` 看不到。要手工审计一个桶:

```bash
wrangler r2 bucket info <bucket-name>
```

`Storage Used` 这一项是把进行中的分片也算进去的;如果它突然涨了一截
但 `ListObjects` 体积没有相应增长,那就是分片泄漏 bug 的典型特征。
带着桶名和时间窗口提一个 issue —— Prisim 在每次 multipart
create/complete/abort 时都会写一条审计行,因此可以从 audit_log 表
回溯到对应的那次上传。
