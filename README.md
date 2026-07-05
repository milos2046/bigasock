# 本地实时版策略看板

启动方式：

```powershell
cd C:\Users\123\Documents\Codex\2026-06-28\x\outputs\realtime-dashboard
node server.mjs
```

打开：<http://127.0.0.1:8788/>

当前版本已经是实时架构：后端每 10 秒刷新一次状态，网页通过 SSE 自动更新。现在默认使用模拟数据，后续可以把 `ASTOCK_DATA_URL` 和 `INVESTMENT_NEWS_URL` 指向本地服务或接口。

可选环境变量：

- `PORT`：服务端口，默认 8788。
- `ASTOCK_DATA_URL`：a-stock-data 输出的 JSON API。
- `INVESTMENT_NEWS_URL`：investment-news 输出的 JSON API。

接口：

- `/api/state`：当前看板状态。
- `/api/refresh`：手动刷新一次。
- `/events`：实时推送。
