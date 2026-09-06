# LZ-Meme Radar V1

面向 BNB Smart Chain 的早期 Meme 扫描雷达。它寻找“资金、筹码和注意力正在同步加速，但价格尚未充分反映”的标的，不是涨幅排行榜，也不包含自动交易。

## 当前能力

- 双通道发现：Four.meme `NEW / HOT / PROGRESS` 列表、TokenManager2/OpenFour 创建事件与 PancakeSwap V2/V3 新池日志。
- DEX Screener 最新资料、Boost、搜索候选和交易/流动性数据补全。
- GeckoTerminal BSC New Pools 作为 Four.meme 或 DEX 搜索受限时的容灾新池源。
- GoPlus Token Security 风险检查，结果分为 `PASS / UNKNOWN / FAIL`。
- 100 分 Alpha Score：资金 30、筹码 25、热度 20、交易结构 15、安全质量 10。
- 严格准入：高危项一票否决；安全未知永远不能进入 Alpha Signal；Signal 需要至少两轮连续扫描和 80% 数据覆盖。
- Alpha Inflection：币龄、市值、资金/筹码/热度加速与非抛物线价格的联合状态。
- Cloudflare D1 保存最新状态、7 日快照、扫描运行和通知审计。
- Telegram 影子/实时通知：首次 Watch、首次 Signal、Alpha 拐点、评分跃升、LP 骤降、大户/Dev 卖出和安全降级。
- GitHub Pages 只读前端；密钥、扫描和通知全部留在 Cloudflare Worker。
- 桌面高密度表格、手机紧凑信号列表、本地自选、详情抽屉、浅色/深色主题。

## 状态规则

| 状态 | 规则 |
| --- | --- |
| 噪音 | 0–49 |
| 观察 | 50–64，或未满足通道准入 |
| Alpha Watch | 65–79；或高分但尚未满足 Signal 确认条件 |
| Alpha Signal | 80–100，安全 PASS、覆盖率 ≥80%、连续扫描 ≥2 且不过热 |
| 过热 | 5m ≥80% 或 15m/1h ≥180% |
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

BNB Chain 公共主网 RPC 不支持频繁 `eth_getLogs`，生产扫描必须使用支持日志查询的第三方 BSC RPC。DEX Screener 用于候选补充和市场数据，不被当作完整的 BSC 新池索引。Four.meme 的当前 TokenManager2、OpenFour Registry 和 Pancake V2/V3 Factory 已按公开集成资料内置；升级或新协议可继续通过环境变量添加验证后的事件适配器。

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

3. 复制 `.dev.vars.example` 为 `.dev.vars`，至少配置支持 `eth_getLogs` 的 `BSC_RPC_URL` 与 `ADMIN_TOKEN`。`.dev.vars` 已被 Git 忽略。

4. 本地运行：

   ```bash
   pnpm run worker:dev
   ```

5. 部署前设置秘密：

   ```bash
   pnpm wrangler secret put BSC_RPC_URL
   pnpm wrangler secret put ADMIN_TOKEN
   pnpm wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm wrangler secret put TELEGRAM_CHAT_ID
   pnpm run deploy:worker
   ```

Worker 默认每 2 分钟扫描。手动扫描必须带管理令牌：

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

1. 先保持 `ALERT_MODE=shadow` 运行 72 小时。所有应触发通知的事件会写入 `alerts`，但不会发送。
2. 检查误报、重复率、覆盖率和扫描延迟。
3. 配好 Bot Token 与 Chat ID，再将 Worker 变量改为 `ALERT_MODE=live`。
4. 普通通知遵守安静时段；安全降级、LP 骤降等高危通知仍可发送。每币种同类通知冷却 30 分钟，首次等级通知只发一次，全局上限为 10 分钟 5 条。

## API

- `GET /api/v1/status`：运行、配置与最近扫描状态。
- `GET /api/v1/radar`：当前雷达结果与 KPI。
- `GET /api/v1/tokens/:address`：单币最新状态。
- `GET /api/v1/tokens/:address/history`：7 日扫描历史。
- `GET /api/v1/alerts/recent`：最近告警审计，不返回 Bot 密钥。
- `POST /api/v1/scan`：手动扫描，需要 Bearer 管理令牌。

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
