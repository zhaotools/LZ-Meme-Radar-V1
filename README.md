# LZ-Meme Radar V1

面向 BNB Smart Chain 的早期 Meme 扫描雷达。它寻找“资金、筹码和注意力正在同步加速，但价格尚未充分反映”的标的，不是涨幅排行榜，也不包含自动交易。

## 当前能力

- 链上优先发现：TokenManager2/OpenFour 创建事件与 PancakeSwap V2/V3 新池日志；Four.meme、DEX Screener 与 GeckoTerminal 作为补充源。
- 持久候选队列与活跃追踪池：新币不再因临时榜单变化或单轮 30 个上限而丢失；前 30 分钟每分钟跟踪，之后按币龄动态降频。
- DEX Screener 最新资料、Boost、搜索候选和交易/流动性数据补全。
- GeckoTerminal BSC New Pools 作为 Four.meme 或 DEX 搜索受限时的容灾新池源。
- GoPlus Token Security 风险检查，结果分为 `PASS / UNKNOWN / FAIL`。
- 双赛道 100 分评分：`EARLY_ALPHA` 寻找趋势前加速，`MOMENTUM_BREAKOUT` 捕捉快速跨越大市值的市场突破。
- 严格准入：高危项一票否决；安全未知永远不能进入 Alpha Signal；Signal 需要至少两轮连续扫描和 80% 数据覆盖。
- Alpha Inflection：币龄、市值、资金/筹码/热度加速与非抛物线价格的联合状态。
- Cloudflare D1 保存最新状态、7 日快照、扫描运行和通知审计。
- Telegram 实时通知：Flash 发现、首次 Watch/Signal、市值突破 5M/10M/20M/50M、成交量加速、安全验证、LP/大户/Dev 风险和数据源降级。
- 数据源健康面板：显示各来源最近成功、失败、候选数量与延迟；超过 5 分钟没有成功扫描会明确标红。
- 时间语义分离：Token 创建、交易池创建、Radar 首次发现、最近评分分别保存，并展示真实发现延迟。
- GitHub Pages 只读前端；密钥、扫描和通知全部留在 Cloudflare Worker。
- 桌面高密度表格、手机紧凑信号列表、本地自选、详情抽屉、浅色/深色主题。

## 状态规则

| 状态 | 规则 |
| --- | --- |
| 噪音 | 0–49 |
| 观察 | 50–64，或未满足通道准入 |
| Alpha Watch | 65–79；或高分但尚未满足 Signal 确认条件 |
| Alpha Signal | 80–100，安全 PASS、覆盖率 ≥80%、连续扫描 ≥2；抛物线状态单独标记风险 |
| Breakout Watch | 币龄 ≤24H、市值 ≥$5M、LP ≥$100K、成交放大且买盘占优；安全可暂为 UNKNOWN |
| Breakout Signal | Breakout Watch 基础上，安全 PASS、覆盖率 ≥70%、连续扫描 ≥2、总分 ≥70 |
| 抛物线风险 | 5m ≥80% 或 15m/1h ≥180%；作为风险标签，不再从榜单淘汰 |
| 风险淘汰 | Honeypot、买卖限制、恶意合约/创建者、Owner 改余额、极端税率、危险权限、极端集中度或 LP 风险 |

缺失数据不填成 0。可用字段会在各维度内部归一化，同时降低总覆盖率；因此“分数高但覆盖低”的币只能观察，不能成为正式信号。

## 架构

```text
BSC 第三方 RPC ─┐
DEX Screener ───┼─> Cloudflare Worker 扫描/评分 ─> D1 历史与告警审计
GoPlus ─────────┤                         └─> Telegram Bot
链上分析适配器 ──┘
                                           ↑
GitHub Pages React 前端 ───── 只读 API ─────┘
```

Worker 内置三个支持日志查询的公共第三方 RPC 作为容灾，同时优先使用秘密变量中的专用 RPC。公共 RPC 可能限流，生产环境仍建议配置 `BSC_RPC_URL` 和 `BSC_RPC_FALLBACK_URL`。DEX Screener 用于行情补全，不被当作完整的新池索引。

## 本地前端

本机未配置 Worker 时，页面读取明确标注的演示数据，用于视觉和交互测试。

```bash
pnpm install
pnpm test
pnpm dev
```

生产构建：

```bash
pnpm build
pnpm preview
```

连接 Worker：

```bash
VITE_RADAR_API_URL=http://localhost:8787 pnpm dev
```

## Worker 与 D1

1. 登录 Cloudflare，并创建数据库：

   ```bash
   pnpm wrangler login
   pnpm wrangler d1 create lz-meme-radar
   ```

2. 把返回的 `database_id` 写入 `wrangler.jsonc`，再执行迁移：

   ```bash
   pnpm run db:migrate:local
   pnpm run db:migrate:remote
   ```

3. 本地需要管理接口时，在被 Git 忽略的 `.dev.vars` 中配置 `ADMIN_TOKEN`；生产环境建议另外配置支持 `eth_getLogs` 的 `BSC_RPC_URL` 与 `BSC_RPC_FALLBACK_URL`。

4. 本地运行：

   ```bash
   pnpm run worker:dev
   ```

5. 部署前设置秘密：

   ```bash
   pnpm wrangler secret put BSC_RPC_URL
   pnpm wrangler secret put BSC_RPC_FALLBACK_URL
   pnpm wrangler secret put ADMIN_TOKEN
   pnpm wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm wrangler secret put TELEGRAM_CHAT_ID
   pnpm run deploy:worker
   ```

Worker 默认每分钟扫描。手动扫描必须带管理令牌：

```bash
curl -X POST https://YOUR_WORKER/api/v1/scan -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Launchpad 事件配置

`DISCOVERY_CONTRACTS_JSON` 是 `DiscoveryContract[]`。部署前应从平台官方资料或链上已验证合约确认地址和事件 topic：

```json
[
  {
    "name": "Four.meme TokenCreated",
    "kind": "launchpad",
    "address": "0xVERIFIED_CONTRACT",
    "topic0": "0xVERIFIED_EVENT_TOPIC",
    "tokenTopicIndex": 3,
    "fromBlock": 0
  }
]
```

PancakeSwap V2/V3 Factory、Four.meme TokenManager2 与 OpenFour Registry 发现已内置。其他版本也应以相同方式在验证后增加适配器，不能用猜测的地址上线。

### 独立钱包与资金流

DEX Screener 的 `txns.buys/sells` 是交易笔数，不是独立钱包。本项目不会把它伪装成独立买家。若要达到完整资金/筹码覆盖率，可配置 `ANALYTICS_URL` 与 `ANALYTICS_TOKEN`。适配器接收：

```json
{ "chainId": "56", "addresses": ["0x..."] }
```

返回：

```json
{
  "result": {
    "0x...": {
      "buyers1h": 120,
      "priorBuyers1h": 75,
      "freshWallets1h": 44,
      "priorFreshWallets1h": 20,
      "netBuy1hUsd": 36000,
      "whaleNetFlow1hUsd": 9000,
      "devNetFlow1hUsd": 0
    }
  }
}
```

没有该适配器时，相关字段保持未知并降低覆盖率，不会生成虚假的 Smart Money 或独立买家结论。

## Telegram 上线流程

当前生产配置使用 `ALERT_MODE=live`。普通通知遵守安静时段；20M/50M 突破、安全降级、LP 骤降和数据源中断等高危通知仍可发送。首次等级、Flash 和每个市值档位只成功发送一次；发送失败不会被误记为永久已通知。

## API

- `GET /api/v1/status`：运行、配置与最近扫描状态。
- `GET /api/v1/radar`：当前雷达结果与 KPI。
- `GET /api/v1/tokens/:address`：单币最新状态。
- `GET /api/v1/tokens/:address/history`：7 日扫描历史。
- `GET /api/v1/alerts/recent`：最近告警审计，不返回 Bot 密钥。
- `POST /api/v1/scan`：手动扫描，需要 Bearer 管理令牌。
- `POST /api/v1/telegram/test`：发送专用 Telegram 测试消息，需要 Bearer 管理令牌。

## GitHub Pages

仓库 Settings → Pages 的 Source 选择 **GitHub Actions**。在 Actions Variables 添加：

```text
VITE_RADAR_API_URL=https://YOUR_WORKER.workers.dev
```

推送 `main` 后，工作流会先测试和构建，再发布 Pages。若变量为空，Pages 会显示清楚标注的演示模式，而不是冒充实时数据。

## 数据源说明

- [BNB Chain JSON-RPC 官方说明](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)
- [DEX Screener API 官方文档](https://docs.dexscreener.com/api/reference)
- [GoPlus Token Security API](https://docs.gopluslabs.io/reference/tokensecurityusingget_1)
- [GoPlus 风险字段说明](https://docs.gopluslabs.io/reference/response-details)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare D1 定价与限额](https://developers.cloudflare.com/d1/platform/pricing/)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Four.meme Token 查询与排行接口](https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/references/token-query-api.md)
- [OpenFour 第三方集成指南](https://github.com/four-meme-community/openfour-docs/blob/main/integration-guide.md)

## 风险声明

这是研究和预警工具，不构成投资建议。`PASS` 只表示已检查字段没有触发当前门槛，不代表合约、流动性或价格绝对安全；链上数据、第三方接口和合约权限随时可能变化。
