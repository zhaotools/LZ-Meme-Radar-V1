import { useCallback, useEffect, useMemo, useState } from "react";
import type { RadarResponse, RadarToken, SecurityFacts, SignalLevel, SourceHealth } from "./shared/types";

const API_BASE = (import.meta.env.VITE_RADAR_API_URL ?? "").replace(/\/$/, "");
const LEVEL_LABEL: Record<SignalLevel, string> = {
  NOISE: "噪音",
  OBSERVE: "观察",
  ALPHA_WATCH: "Alpha Watch",
  ALPHA_SIGNAL: "Alpha Signal",
  BREAKOUT_WATCH: "Breakout Watch",
  BREAKOUT_SIGNAL: "Breakout Signal",
  OVERHEATED: "过热",
  RISK_FAIL: "风险淘汰",
};
const SECURITY_LABEL = { PASS: "安全通过", UNKNOWN: "安全未知", FAIL: "安全失败" } as const;
const COMPONENTS = [
  ["funds", "资金", 30], ["chips", "筹码", 25], ["heat", "热度", 20],
  ["structure", "交易结构", 15], ["safety", "安全质量", 10],
] as const;

function money(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 }).format(value);
}
function number(value?: number | null) {
  if (value == null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}
function percent(value?: number | null, fraction = false) {
  if (value == null || !Number.isFinite(value)) return "--";
  return `${(fraction ? value * 100 : value).toFixed(1)}%`;
}
function age(minutes: number) {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}
function shortAddress(address: string) { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

async function copyToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall back for browsers that deny the async Clipboard API.
    }
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("copy failed");
}

function CopyAddressButton({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    try {
      await copyToClipboard(address);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className={`copy-contract ${copied ? "copied" : ""}`}
    aria-label={copied ? "合约地址已复制" : "复制完整合约地址"} title={copied ? "已复制" : "复制合约地址"}
    data-label={copied ? "已复制" : "复制合约"} onClick={copy} onKeyDown={(event) => event.stopPropagation()}>
    {copied
      ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
      : <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>}
  </button>;
}

function StatusBadge({ token }: { token: RadarToken }) {
  return <span className={`badge level-${token.score.level.toLowerCase()}`}>{LEVEL_LABEL[token.score.level]}</span>;
}

function Change({ value }: { value?: number | null }) {
  return <span className={value == null ? "muted" : value >= 0 ? "positive" : "negative"}>{percent(value)}</span>;
}

function TokenMark({ token }: { token: RadarToken }) {
  if (token.imageUrl) return <img className="token-mark" src={token.imageUrl} alt="" />;
  return <span className="token-mark fallback">{token.symbol.slice(0, 2)}</span>;
}

function Sparkline({ token }: { token: RadarToken }) {
  const values = [token.metrics.priceChange5mPct, token.metrics.priceChange15mPct, token.metrics.priceChange1hPct]
    .map((value) => value ?? 0);
  const min = Math.min(...values, 0); const max = Math.max(...values, 0); const span = Math.max(max - min, 1);
  const points = values.map((value, index) => `${index * 28},${24 - ((value - min) / span) * 20}`).join(" ");
  return <svg className="sparkline" viewBox="0 0 56 28" aria-label="短周期价格走势"><polyline points={points} /></svg>;
}

function ScoreRing({ score }: { score: number }) {
  return <div className="score-ring" style={{ "--score": `${score * 3.6}deg` } as React.CSSProperties}>
    <span>{score}</span><small>/100</small>
  </div>;
}

interface Filters { query: string; level: string; lane: string; security: string; age: string; watchlist: boolean }
interface HistoryPoint { observedAt: string; score: number; level: SignalLevel }
interface ApiStatus { configuration?: { telegram?: boolean; alertMode?: string }; sourceHealth?: SourceHealth[] }

function TokenTable({ tokens, onSelect, watched, toggleWatch }: {
  tokens: RadarToken[]; onSelect: (token: RadarToken) => void; watched: Set<string>; toggleWatch: (address: string) => void;
}) {
  return <div className="table-shell">
    <table>
      <thead><tr>
        <th className="watch-col" aria-label="自选" />
        <th>标的 / 来源</th><th>信号</th><th>Alpha</th><th>安全</th><th>资金</th><th>筹码</th><th>热度</th>
        <th>市值</th><th>LP</th><th>1H 成交</th><th>1H 买/卖笔</th><th>Holder</th><th>Top10</th><th>5m / 1h</th><th>走势</th>
      </tr></thead>
      <tbody>{tokens.map((token) => <tr key={token.address} onClick={() => onSelect(token)} tabIndex={0}
        onKeyDown={(event) => { if (event.key === "Enter") onSelect(token); }}>
        <td><button className={`star ${watched.has(token.address) ? "active" : ""}`} aria-label="切换自选"
          onClick={(event) => { event.stopPropagation(); toggleWatch(token.address); }}>{watched.has(token.address) ? "★" : "☆"}</button></td>
        <td><div className="token-cell"><TokenMark token={token} /><div><strong>{token.symbol}</strong><span>{token.name}</span>
          <small>{token.score.track ?? (token.lane === "launchpad" ? "LAUNCHPAD" : "EARLY_ALPHA")} · {age(token.ageMinutes)} · {token.source}</small>
          <div className="contract-line"><code>{shortAddress(token.address)}</code><CopyAddressButton address={token.address} /></div></div></div></td>
        <td><StatusBadge token={token} />{token.score.alphaInflection && <span className="inflection">拐点</span>}
          {token.score.overheated && <span className="risk-flag">抛物线</span>}</td>
        <td><b className="score-number">{token.score.total}</b><small className="coverage">覆盖 {token.score.coverage}%</small></td>
        <td><span className={`security security-${token.score.securityStatus.toLowerCase()}`}>{token.score.securityStatus}</span></td>
        <td>{token.score.components.funds}<small>/30</small></td><td>{token.score.components.chips}<small>/25</small></td>
        <td>{token.score.components.heat}<small>/20</small></td><td>{money(token.metrics.marketCapUsd)}</td>
        <td>{money(token.metrics.liquidityUsd)}</td><td>{money(token.metrics.volume1hUsd)}</td>
        <td>{number(token.metrics.txBuys1h)} / {number(token.metrics.txSells1h)}</td><td>{number(token.metrics.holders)}</td>
        <td>{percent(token.security.effectiveTop10Pct, true)}</td><td><Change value={token.metrics.priceChange5mPct} /> / <Change value={token.metrics.priceChange1hPct} /></td>
        <td><Sparkline token={token} /></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function MobileList({ tokens, onSelect, watched, toggleWatch }: {
  tokens: RadarToken[]; onSelect: (token: RadarToken) => void; watched: Set<string>; toggleWatch: (address: string) => void;
}) {
  return <div className="mobile-list">{tokens.map((token) => <article className="mobile-row" key={token.address} onClick={() => onSelect(token)}>
    <div className="mobile-primary"><TokenMark token={token} /><div><strong>{token.symbol}</strong><span>{token.name} · {age(token.ageMinutes)}</span>
      <div className="contract-line"><code>{shortAddress(token.address)}</code><CopyAddressButton address={token.address} /></div></div>
      <button className={`star ${watched.has(token.address) ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); toggleWatch(token.address); }}>{watched.has(token.address) ? "★" : "☆"}</button></div>
    <div className="mobile-signal"><div><b>{token.score.total}</b><small>Alpha</small></div><StatusBadge token={token} />
      <span className={`security security-${token.score.securityStatus.toLowerCase()}`}>{token.score.securityStatus}</span></div>
    <div className="mobile-metrics"><span>MC <b>{money(token.metrics.marketCapUsd)}</b></span><span>LP <b>{money(token.metrics.liquidityUsd)}</b></span>
      <span>1H量 <b>{money(token.metrics.volume1hUsd)}</b></span><span>1H <Change value={token.metrics.priceChange1hPct} /></span></div>
    <div className="mini-components"><i style={{ width: `${token.score.components.funds / 30 * 100}%` }} /><i style={{ width: `${token.score.components.chips / 25 * 100}%` }} /><i style={{ width: `${token.score.components.heat / 20 * 100}%` }} /></div>
  </article>)}</div>;
}

function RiskItem({ label, value, invert = false }: { label: string; value: boolean | null | undefined; invert?: boolean }) {
  const unknown = value == null; const safe = !unknown && (invert ? value : !value);
  return <div className="risk-item"><span className={unknown ? "unknown-dot" : safe ? "pass-dot" : "fail-dot"} />
    <span>{label}</span><b>{unknown ? "未知" : safe ? "通过" : "风险"}</b></div>;
}

function DetailDrawer({ token, onClose, watched, toggleWatch }: {
  token: RadarToken; onClose: () => void; watched: boolean; toggleWatch: () => void;
}) {
  const security: SecurityFacts = token.security;
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  useEffect(() => {
    if (!API_BASE) return;
    const controller = new AbortController();
    fetch(`${API_BASE}/api/v1/tokens/${token.address}/history`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(String(response.status))))
      .then((body: { history?: HistoryPoint[] }) => setHistory((body.history ?? []).reverse()))
      .catch(() => undefined);
    return () => controller.abort();
  }, [token.address]);
  const chartPoints = history.map((point, index) => {
    const width = 470; const height = 80;
    const x = history.length <= 1 ? 0 : index / (history.length - 1) * width;
    const y = height - Math.max(0, Math.min(100, point.score)) / 100 * height;
    return `${x},${y}`;
  }).join(" ");
  return <div className="drawer-layer" role="dialog" aria-modal="true" aria-label={`${token.symbol} 详情`}>
    <button className="drawer-scrim" onClick={onClose} aria-label="关闭详情" />
    <aside className="drawer">
      <header className="drawer-header"><div className="token-cell"><TokenMark token={token} /><div><strong>{token.name}</strong><span>{token.symbol} · BSC</span>
        <div className="contract-line"><code>{shortAddress(token.address)}</code><CopyAddressButton address={token.address} /></div></div></div>
        <div className="drawer-actions"><button className={`star ${watched ? "active" : ""}`} onClick={toggleWatch}>{watched ? "★" : "☆"}</button><button onClick={onClose} aria-label="关闭">×</button></div></header>
      <div className="drawer-scroll">
        <section className="signal-overview"><ScoreRing score={token.score.total} /><div><StatusBadge token={token} />
          {token.score.alphaInflection && <span className="inflection">Alpha 拐点</span>}<p>数据覆盖 {token.score.coverage}% · 安全 {SECURITY_LABEL[token.score.securityStatus]}</p>
          <p>{token.score.track ?? "EARLY_ALPHA"}{token.score.overheated ? " · 抛物线风险" : ""}</p>
          <p>Radar 首见 {new Date(token.firstSeenAt ?? token.discoveredAt).toLocaleString("zh-CN")} · 更新 {new Date(token.observedAt).toLocaleTimeString("zh-CN")}</p>
          {token.tokenCreatedAt && <p>Token 创建 {new Date(token.tokenCreatedAt).toLocaleString("zh-CN")} · 发现延迟 {token.discoveryLatencySeconds == null ? "--" : age(token.discoveryLatencySeconds / 60)}</p>}</div></section>

        <section><h3>评分瀑布</h3><div className="score-bars">{COMPONENTS.map(([key, label, max]) => <div key={key}>
          <div><span>{label}</span><b>{token.score.components[key]} / {max}</b></div><i><em style={{ width: `${token.score.components[key] / max * 100}%` }} /></i>
        </div>)}</div></section>

        <section><h3>扫描历史</h3>{history.length >= 2 ? <div className="history-chart"><svg viewBox="0 0 470 90" preserveAspectRatio="none"><line x1="0" y1="18" x2="470" y2="18" /><line x1="0" y1="46" x2="470" y2="46" /><polyline points={chartPoints} /></svg>
          <div><span>{new Date(history[0].observedAt).toLocaleString("zh-CN")}</span><b>最新 {history.at(-1)?.score}</b></div></div> : <p className="muted history-empty">连接实时 Worker 后，将在这里显示最多 7 日评分轨迹。</p>}</section>

        <section><h3>市场结构</h3><div className="detail-grid">
          <div><span>市值</span><b>{money(token.metrics.marketCapUsd)}</b></div><div><span>流动性</span><b>{money(token.metrics.liquidityUsd)}</b></div>
          <div><span>1H 成交额</span><b>{money(token.metrics.volume1hUsd)}</b></div><div><span>1H 买/卖笔</span><b>{number(token.metrics.txBuys1h)} / {number(token.metrics.txSells1h)}</b></div>
          <div><span>Holder</span><b>{number(token.metrics.holders)}</b></div><div><span>有效 Top10</span><b>{percent(security.effectiveTop10Pct, true)}</b></div>
          <div><span>独立买家</span><b>{number(token.metrics.buyers1h)}</b></div><div><span>净买入</span><b>{money(token.metrics.netBuy1hUsd)}</b></div>
        </div><p className="footnote">“买/卖笔”为 DEX 交易笔数；独立买家与净买入仅在链上分析源提供时展示，不做推算。</p></section>

        <section><h3>Rug Filter</h3><div className="risk-grid">
          <RiskItem label="Honeypot" value={security.isHoneypot} /><RiskItem label="买入限制" value={security.cannotBuy} />
          <RiskItem label="卖出限制" value={security.cannotSellAll} /><RiskItem label="黑名单权限" value={security.blacklisted} />
          <RiskItem label="暂停转账" value={security.transferPausable} /><RiskItem label="Mint 权限" value={security.mintable} />
          <RiskItem label="合约开源" value={security.openSource} invert /><RiskItem label="Owner 已放弃" value={security.ownerRenounced} invert />
        </div><div className="tax-row"><span>买入税 <b>{percent(security.buyTax, true)}</b></span><span>卖出税 <b>{percent(security.sellTax, true)}</b></span><span>LP 锁定 <b>{percent(security.lpLockedPct, true)}</b></span></div></section>

        <section><h3>判断依据</h3>{token.score.reasons.length ? <ul>{token.score.reasons.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="muted">当前未触发额外风险或拐点说明。</p>}
          {token.score.missing.length > 0 && <details><summary>缺失字段（{token.score.missing.length}）</summary><p>{token.score.missing.join("、")}</p></details>}</section>

        <section><h3>数据来源</h3><div className="source-list">{Object.entries(token.fieldSources ?? {}).map(([key, value]) => <p key={key}><span>{key}</span><b>{value}</b></p>)}</div></section>
      </div>
      <footer className="drawer-footer">{token.dexUrl && <a href={token.dexUrl} target="_blank" rel="noreferrer">DEX Screener ↗</a>}
        {token.fourUrl && <a href={token.fourUrl} target="_blank" rel="noreferrer">Four.meme ↗</a>}
        <a href={`https://bscscan.com/token/${token.address}`} target="_blank" rel="noreferrer">BscScan ↗</a></footer>
    </aside>
  </div>;
}

function App() {
  const [data, setData] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<RadarToken | null>(null);
  const [apiStatus, setApiStatus] = useState<ApiStatus | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem("lz-radar-theme") ?? "light");
  const [filters, setFilters] = useState<Filters>({ query: "", level: "ALL", lane: "ALL", security: "ALL", age: "72", watchlist: false });
  const [watched, setWatched] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem("lz-radar-watchlist") ?? "[]") as string[]));

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const url = API_BASE ? `${API_BASE}/api/v1/radar` : `${import.meta.env.BASE_URL}demo-radar.json`;
      const [response, statusResponse] = await Promise.all([
        fetch(url, { cache: "no-store" }),
        API_BASE ? fetch(`${API_BASE}/api/v1/status`, { cache: "no-store" }).catch(() => null) : Promise.resolve(null),
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setData(await response.json() as RadarResponse);
      if (statusResponse?.ok) setApiStatus(await statusResponse.json() as ApiStatus);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "数据加载失败");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(timer); }, [load]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("lz-radar-theme", theme); }, [theme]);
  useEffect(() => { localStorage.setItem("lz-radar-watchlist", JSON.stringify([...watched])); }, [watched]);
  useEffect(() => { if (!selected) return; const close = (event: KeyboardEvent) => event.key === "Escape" && setSelected(null); window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [selected]);

  const toggleWatch = (address: string) => setWatched((old) => { const next = new Set(old); next.has(address) ? next.delete(address) : next.add(address); return next; });
  const tokens = useMemo(() => (data?.tokens ?? []).filter((token) => {
    const query = filters.query.trim().toLowerCase();
    return (!query || token.name.toLowerCase().includes(query) || token.symbol.toLowerCase().includes(query) || token.address.toLowerCase().includes(query)) &&
      (filters.level === "ALL" || token.score.level === filters.level) && (filters.lane === "ALL" || token.lane === filters.lane) &&
      (filters.security === "ALL" || token.score.securityStatus === filters.security) && token.ageMinutes <= Number(filters.age) * 60 &&
      (!filters.watchlist || watched.has(token.address));
  }).sort((a, b) => b.score.total - a.score.total), [data, filters, watched]);
  const scanStatus = data?.sourceMode === "demo" ? "demo" : data?.scanStatus ?? "error";
  const scanLabel = scanStatus === "ok" ? "扫描正常" : scanStatus === "partial" ? "扫描降级" : scanStatus === "demo" ? "演示模式" : "扫描中断";

  return <div className="app-shell">
    <header className="topbar"><div className="brand"><span className="radar-logo"><i /></span><div><h1>LZ-Meme Radar <em>V1</em></h1><p>BSC Meme Alpha Scanner</p></div></div>
      <div className="top-actions"><span className={`live-state status-${scanStatus}`}><i />{scanLabel}</span>
        {data?.sourceMode === "live" && <span className="notification-state">{apiStatus?.configuration?.telegram ? (apiStatus.configuration.alertMode === "live" ? "Telegram 已启用" : "Telegram 影子模式") : "通知待配置"}</span>}
        <button onClick={() => void load()} disabled={loading} aria-label="刷新">{loading ? "扫描中…" : "刷新"}</button>
        <button className="theme-button" onClick={() => setTheme(theme === "light" ? "dark" : "light")} aria-label="切换主题">{theme === "light" ? "◐" : "◑"}</button></div></header>

    <main>
      {data?.sourceMode === "demo" && <div className="notice"><b>当前为演示数据</b><span>前端尚未连接生产 Worker。页面、评分与通知逻辑可测试，但这里不代表实时荐币。</span></div>}
      {error && <div className="notice error"><b>数据连接失败</b><span>{error}</span><button onClick={() => void load()}>重试</button></div>}
      {data?.sourceMode === "live" && data.notices?.map((notice) => <div className="notice error" key={notice}><b>扫描状态提醒</b><span>{notice}</span></div>)}

      {data?.sourceMode === "live" && (data.sourceHealth?.length ?? 0) > 0 && <section className="source-health" aria-label="数据源状态">
        {data?.sourceHealth?.map((source) => <div key={source.source} className={`source-${source.status}`}>
          <i /><span>{source.source}</span><b>{source.status === "ok" ? "正常" : source.status === "degraded" ? "降级" : source.status === "disabled" ? "未启用" : "失败"}</b>
          <small>{source.candidateCount} 个 · {source.latencyMs}ms</small>
        </div>)}
      </section>}

      <section className="summary-grid">
        {[["24H 新发现", data?.summary.discovered24h ?? 0], ["安全通过", data?.summary.riskPass ?? 0], ["Alpha Watch", data?.summary.alphaWatch ?? 0], ["Alpha Signal", data?.summary.alphaSignal ?? 0], ["Breakout", (data?.summary.breakoutWatch ?? 0) + (data?.summary.breakoutSignal ?? 0)], ["已发送提醒", data?.summary.alertsSent ?? 0]].map(([label, value], index) =>
          <div className={`summary-card accent-${index}`} key={String(label)}><span>{label}</span><b>{value}</b><small>{index === 0 ? "真实首次发现时间" : index === 5 ? "近 24 小时" : "当前结果集"}</small></div>)}
      </section>

      <section className="radar-panel">
        <div className="panel-head"><div><h2>Alpha 扫描结果</h2><p>优先看加速度与结构，不按涨幅排名</p></div><div className="scan-meta">更新 {data ? new Date(data.generatedAt).toLocaleTimeString("zh-CN") : "--"}<span>每 60 秒刷新</span></div></div>
        <div className="filters">
          <label className="search"><span>⌕</span><input value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder="搜索名称、代码或合约" /></label>
          <select value={filters.level} onChange={(event) => setFilters({ ...filters, level: event.target.value })}><option value="ALL">全部信号</option><option value="BREAKOUT_SIGNAL">Breakout Signal</option><option value="BREAKOUT_WATCH">Breakout Watch</option><option value="ALPHA_SIGNAL">Alpha Signal</option><option value="ALPHA_WATCH">Alpha Watch</option><option value="OBSERVE">观察</option><option value="OVERHEATED">旧版过热</option><option value="RISK_FAIL">风险淘汰</option></select>
          <select value={filters.lane} onChange={(event) => setFilters({ ...filters, lane: event.target.value })}><option value="ALL">全部通道</option><option value="launchpad">Launchpad</option><option value="dex">DEX 池</option></select>
          <select value={filters.security} onChange={(event) => setFilters({ ...filters, security: event.target.value })}><option value="ALL">全部安全状态</option><option value="PASS">安全通过</option><option value="UNKNOWN">安全未知</option><option value="FAIL">安全失败</option></select>
          <select value={filters.age} onChange={(event) => setFilters({ ...filters, age: event.target.value })}><option value="24">币龄 ≤ 24H</option><option value="72">币龄 ≤ 72H</option></select>
          <button className={filters.watchlist ? "filter-active" : ""} onClick={() => setFilters({ ...filters, watchlist: !filters.watchlist })}>★ 自选</button>
        </div>
        <div className="result-caption"><span>显示 {tokens.length} / {data?.tokens.length ?? 0} 个标的</span><span>安全 UNKNOWN 仅允许 Watch/Flash，不进入正式 Signal</span></div>
        {loading && !data ? <div className="empty-state"><span className="loader" /><p>正在读取雷达数据…</p></div> : tokens.length ? <>
          <TokenTable tokens={tokens} onSelect={setSelected} watched={watched} toggleWatch={toggleWatch} />
          <MobileList tokens={tokens} onSelect={setSelected} watched={watched} toggleWatch={toggleWatch} />
        </> : <div className="empty-state"><b>没有符合条件的标的</b><p>调整筛选条件，或等待下一轮扫描。</p></div>}
      </section>
      <footer className="app-footer"><span>LZ-Meme Radar V1 · 研究工具，不构成投资建议</span><span>身份键：BSC chainId + 合约地址</span></footer>
    </main>
    {selected && <DetailDrawer token={selected} onClose={() => setSelected(null)} watched={watched.has(selected.address)} toggleWatch={() => toggleWatch(selected.address)} />}
  </div>;
}

export default App;
