# gov-transparency-mcp

[![M8ven Score](https://m8ven.ai/badge/mcp/forgemeshlabs-gov-transparency-mcp-s0hroh)](https://m8ven.ai/mcp/forgemeshlabs-gov-transparency-mcp-s0hroh)

**Watch the watchers.** Congressional stock trades, federal contract awards, campaign finance, lobbying filings, and new regulations — nine MCP tools over official US government data, paid per call with [x402](https://x402.org) USDC on Base. No account, no API key, no subscription.

Commercial trackers sell congressional-trading data behind monthly subscriptions. Here it is per-call, in structured JSON, for agents: $0.005–$0.02 a query.

## Tools

| Tool | Price | What it returns |
|---|---|---|
| `get_congress_trades` | $0.02 | US House member stock trades parsed from official STOCK Act filings — member, ticker, buy/sell, date, amount range. Filter by member, ticker, type, state, date window. |
| `get_trade_filings` | $0.01 | The disclosure filing index — who filed trade reports and when, with official PDF links. |
| `search_federal_contracts` | $0.01 | Federal contract awards won by any company — amounts, agencies, dates, descriptions. |
| `get_contractor_profile` | $0.01 | Company → official federal recipient records with UEI and recent award totals. |
| `get_candidate_money` | $0.01 | Campaign finance totals per candidate — receipts, spending, cash on hand, debts. |
| `find_candidate` | $0.005 | Candidate name → official ids, party, office, committees. |
| `search_lobbying` | $0.01 | Lobbying filings by client or firm — money, issues, named lobbyists. |
| `watch_federal_register` | $0.005 | Newest regulations and notices matching any topic. |
| `lookup_bill` | $0.005 | Official status of any bill in Congress. |
| `get_endpoint_spec` | free | Live schemas and worked examples for all nine routes. |

## Data sources

All official, all public domain: US House Clerk financial disclosures (parsed from the source PTR PDFs), USAspending.gov, the Federal Election Commission, the Senate Lobbying Disclosure Act database, the Federal Register, and Congress.gov. Trade disclosures lag transactions by up to 45 days — that is the law's reporting window, not a data delay. Current trade coverage: US House (Senate planned); paper-filed disclosures are indexed with PDF links but not parsed into rows.

## Setup

```json
{
  "mcpServers": {
    "gov-transparency": {
      "command": "npx",
      "args": ["-y", "@forgemeshlabs/gov-transparency-mcp"],
      "env": {
        "WALLET_PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

`WALLET_PRIVATE_KEY` must be a **dedicated low-balance wallet** holding a small amount of USDC on Base mainnet — never your primary wallet. `get_endpoint_spec` works without one.

Optional env: `GOV_TRANSPARENCY_BASE_URL` (default `https://x402.forgemesh.io`), `BASE_RPC_URL` (default `https://mainnet.base.org`).

## How payment works

Each call makes a normal HTTP request; the server answers `402 Payment Required` with exact terms, the client signs a USDC transfer authorization (EIP-3009) and retries, and the settlement transaction hash comes back in the response under `_payment`. Atomic: no data without payment, no payment without data.

## License

MIT — code only. The underlying government data is public domain.
