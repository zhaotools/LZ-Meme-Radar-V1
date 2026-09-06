export interface Env {
  DB: D1Database;
  BSC_RPC_URL?: string;
  GOPLUS_TOKEN?: string;
  ADMIN_TOKEN?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  ALERT_MODE?: "shadow" | "live" | "off";
  ALERT_TIMEZONE_OFFSET?: string;
  QUIET_HOURS?: string;
  ALLOWED_ORIGIN?: string;
  DISCOVERY_CONTRACTS_JSON?: string;
  ANALYTICS_URL?: string;
  ANALYTICS_TOKEN?: string;
}

export interface DiscoveryContract {
  name: string;
  kind: "pancake-v2" | "pancake-v3" | "launchpad";
  address: string;
  topic0: string;
  tokenTopicIndex?: number;
  tokenDataWord?: number;
  pairTopicIndex?: number;
  fromBlock?: number;
}
