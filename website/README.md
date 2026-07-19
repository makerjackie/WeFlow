# WeFlow website

`weflow.01mvp.com` 是 WeFlow 的简洁下载页。静态页面由 Cloudflare Workers Static Assets 提供，安装包保存在私有 R2 bucket `weflow-releases`，只有 Worker 中明确列出的版本可公开下载。

## 发布

```sh
wrangler r2 bucket create weflow-releases --location=apac
wrangler r2 object put weflow-releases/releases/5.0.4/WeFlow-5.0.4-Setup.dmg \
  --remote \
  --file=release/WeFlow-5.0.4-Setup.dmg \
  --content-type=application/x-apple-diskimage \
  --content-disposition='attachment; filename="WeFlow-5.0.4-Setup.dmg"' \
  --cache-control='public, max-age=86400'
wrangler deploy --config website/wrangler.jsonc
```

发布新版本时，同时更新 `website/src/index.js`、`website/public/index.html` 中的版本号和 SHA256。
