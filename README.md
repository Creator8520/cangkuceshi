# 仓库管理工作台 · Cloudflare 版

此目录是完整的 Cloudflare Worker 版本：Worker 提供三端登录、业务 API、OZON 同步和静态页面；D1 保存业务数据；GitHub 推送可触发 Cloudflare 自动部署。它不依赖本地 Python 或本机 SQLite。

## 部署前准备

1. 解压本包，将解压后看到的全部文件和文件夹上传到 GitHub 仓库根目录。上传后应直接看到 `wrangler.jsonc`、`package.json`、`src/`、`public/` 和 `migrations/`，不要再套一层 `cloudflare-worker/` 文件夹。这样 Root directory 可以留空。
2. 在 Cloudflare 创建一个 D1 数据库，名称使用 `warehouse-workbench`，复制数据库 ID。
3. 将 `wrangler.jsonc` 中 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 替换为真实 ID，再上传或提交整个项目。
4. 在 Cloudflare Workers Builds 中连接 GitHub 仓库，Worker 名称使用 `warehouse-workbench-cloud`，Root directory 留空，Build command 留空，Deploy command 使用默认 `npx wrangler deploy`。完成首次部署后，推送到所选分支会自动重新部署。
5. 在已创建的 Worker 设置中添加以下 **Runtime secrets**：
   - `ADMIN_PASSWORD`：总控端登录密码
   - `PURCHASE_PASSWORD`：采购端登录密码
   - `WAREHOUSE_PASSWORD`：仓库端登录密码
   - `APP_SECRET`：至少 32 个字符的随机长密钥；用于签名登录 Cookie 和加密 OZON API Key。请妥善备份，不能随意更换。
6. 打开 Worker 提供的网址。首次调用业务接口时，Worker 会自动在 D1 中创建所需表和索引，不需要手动执行 SQL 迁移。

Cloudflare Git 集成会在连接分支有新提交时重新构建和部署。Worker 中的定时任务每两分钟拉取各店铺 FBS 新订单；手动同步还会刷新商品、SKU、主图和中文类目。若要绑定自定义域名，可在该 Worker 的设置中添加域名。

如果构建报 `The entry-point file at "src/index.js" was not found`，检查 GitHub 仓库根目录能否直接打开 `src/index.js`。若它位于 `cloudflare-worker/src/index.js`，说明上传时多保留了一层目录；请把 `cloudflare-worker` 里的内容移到仓库根目录。

## 本地预览

需要 Node.js。复制 `.dev.vars.example` 为 `.dev.vars` 并改成自己的本地测试密码和随机密钥；`.dev.vars` 已加入忽略列表。复制 `wrangler.jsonc`，把 D1 ID 换成测试库 ID，然后执行：

```powershell
npm install
npm run dev
```

生产环境应在 Worker 的 Settings → Variables and Secrets 页面添加上述四项 Runtime secrets，不要把密码或 API Key 提交到 GitHub。Workers Builds 的 Build secrets 只供构建脚本使用，应用运行时密钥必须配置在 Worker 的 Runtime secrets 中。

## 功能

- 总控、采购、仓库三个独立登录入口和端口权限。
- 批量采购单、CSV / TSV / XLSX 导入、SKU 自动匹配绑定、仓库确认入库和消息通知。
- 仓库库存、SKU 与采购单号显示、悬浮窗修改、删除商品、库存流水与低库存关注提醒。
- 多 OZON 店铺、商品同步与分类筛选、名称 / SKU / 货号跨店搜索、绑定和解绑。
- 店铺出单、历史回读、订单商品映射、已绑定货号扣减本系统库存。
- API Key 在写入 D1 前用 `APP_SECRET` 加密；登录密码只作为 Cloudflare Runtime secrets 使用。

## 数据与兼容说明

D1 是一套新的云端数据库，首次部署为空库，不会自动复制本地 `warehouse.sqlite3` 的数据。旧本地数据仍保留在本机。Cloudflare D1 单行限制为 2 MB，因此本版本按记录保存商品、订单和流水，不把整个工作台打成一个大 JSON 字段。

商品抓取和订单同步通过 Cloudflare Worker 直接访问 OZON Seller API。若店铺 API Key 权限或 Cloudflare 到 OZON 的网络访问受限，页面会显示对应同步错误；历史回读只增加出单记录，不扣减仓库库存。
