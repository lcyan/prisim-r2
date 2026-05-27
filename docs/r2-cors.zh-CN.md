[English](./r2-cors.md) | 中文

# R2 CORS 配置

浏览器通过预签名 URL 直接和 R2 交换对象字节 (见 CLAUDE.md 安全
不变量 #3)。R2 默认强制同源策略,所以每一个 Prisim 会写入的桶都需要
一条 CORS 规则,允许控制面板源发起 `PUT` (上传) 和 `GET` (下载) 请求,
以及预签名 URL 携带的通配 `Authorization` / `Content-Type` 等头。

不配这条规则,第一次上传就会在 CORS 预检阶段悄无声息地失败 ——
浏览器会在 `PUT` 抵达 R2 之前就取消请求,客户端唯一能看到的信号是
"Upload failed: TypeError: failed to fetch"。

## 推荐规则

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

把 `https://your-prisim.example.com` 换成 `NEXT_PUBLIC_APP_URL`
的值 (控制面板运行的源)。本地的 preview 服务器是
`http://localhost:8787` —— 如果开发期间想对真实的 R2 桶做上传/下载
本地验证,把它加成第二个源即可。

`ExposeHeaders: ["ETag"]` 是必需的,这样分片上传 UI 才能读取浏览器
从 `UploadPart` 拿到的每个分片的 ETag —— 控制面 `CompleteMultipartUpload`
调用需要每片的 ETag,没有这条 expose 规则,浏览器会在我们的 JS
读到响应之前就把它去掉。

## 用 `wrangler` 应用

```bash
wrangler r2 bucket cors set \
  --rules ./docs/cors-rules.json \
  <bucket-name>
```

`docs/cors-rules.json` 默认不入库 —— 复制上面的 JSON,替换源地址,
然后保存到本地。Cloudflare 控制台也接受同样的 JSON,路径是
R2 → 存储桶 → Settings → CORS。

## 多环境配置

Prisim V1 是单用户,但生产部署一般还是会有一个 staging 环境对接
同一组 R2 桶。把每个部署源都加进 `AllowedOrigins`:

```json
"AllowedOrigins": [
  "https://prisim.example.com",
  "https://staging.prisim.example.com",
  "http://localhost:8787"
]
```

R2 接受通配符 (`*`),但要主动避免 —— 通配符 CORS 规则意味着用户浏览器里
的任何站点,只要拿到了一个预签名 URL,都能对你的桶发起带认证的 `PUT`。
请一定枚举具体源。

## 故障排查

| 现象                                                           | 可能原因                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| 上传立刻失败,网络面板里看不到对应请求                          | 浏览器在预检阶段就取消了;`AllowedOrigins` 不包含控制面板源          |
| 上传打到了 R2,返回 200,但文件损坏                              | `Content-Type` 没在允许列表里;把 `AllowedHeaders` 放宽到 `["*"]`    |
| 分片上传走完了,但 `CompleteMultipartUpload` 返回 "InvalidPart" | `ExposeHeaders` 里缺 `ETag` —— 浏览器在我们的 JS 收集之前把它剥掉了 |
| 403 并伴有 `<Code>InvalidAccessKeyId</Code>`                   | 不是 CORS 问题 —— Prisim 写进预签名 URL 的凭据本身就错了或已被轮换  |
