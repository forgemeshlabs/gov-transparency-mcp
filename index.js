#!/usr/bin/env node
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { toClientEvmSigner } = require("@x402/evm");
const { privateKeyToAccount } = require("viem/accounts");
const { createPublicClient, http } = require("viem");
const { base } = require("viem/chains");

const VERSION = "0.1.0";
const BASE_URL = (process.env.GOV_TRANSPARENCY_BASE_URL || "https://x402.forgemesh.io").replace(/\/$/, "");
const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// Every tool maps to one paid route on the ForgeMesh Utility Grid's
// gov-transparency shelf. All underlying data is official US government
// data (public domain): House Clerk financial disclosures, USAspending,
// FEC, the Senate lobbying registry, the Federal Register, and Congress.gov.

// --- payment client ---------------------------------------------------------

function buildBaseHttpClient() {
  const key = process.env.WALLET_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "WALLET_PRIVATE_KEY is not set. Calls cost $0.005-$0.02 via x402 — set a dedicated low-balance Base wallet private key (never your primary wallet) holding a small amount of USDC on Base mainnet. The get_endpoint_spec tool works without one."
    );
  }
  const pk = key.startsWith("0x") ? key : "0x" + key;
  const account = privateKeyToAccount(pk);
  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(toClientEvmSigner(account)));
  return { httpClient: new x402HTTPClient(coreClient), account };
}

// x402 derives EIP-3009 validity windows from Date.now; choose a timestamp
// valid for both Base block time and facilitator wall-clock checks (clock-skew fix).
async function createChainTimedPaymentPayload(httpClient, paymentRequired) {
  try {
    const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC_URL) });
    const block = await publicClient.getBlock();
    const chainNow = Number(block.timestamp);
    const originalNow = Date.now;
    const localNow = Math.floor(originalNow() / 1000);
    const timeout = Number(paymentRequired.accepts?.[0]?.maxTimeoutSeconds || 300);
    const lowerBound = localNow + 30 - timeout;
    const upperBound = chainNow + 600;
    const signingNow = Math.min(Math.max(chainNow, lowerBound), upperBound);
    Date.now = () => signingNow * 1000;
    try {
      return await httpClient.createPaymentPayload(paymentRequired);
    } finally {
      Date.now = originalNow;
    }
  } catch (_) {
    return httpClient.createPaymentPayload(paymentRequired);
  }
}

async function paidPost(ctx, path, body) {
  const { httpClient } = ctx;
  const url = BASE_URL + path;
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) };
  const res = await fetch(url, init);

  if (res.status === 402) {
    let challengeBody;
    try {
      challengeBody = await res.clone().json();
    } catch (_) {}
    const paymentRequired = httpClient.getPaymentRequiredResponse((name) => res.headers.get(name), challengeBody);
    const paymentPayload = await createChainTimedPaymentPayload(httpClient, paymentRequired);
    const paidRes = await fetch(url, {
      ...init,
      headers: { ...init.headers, ...httpClient.encodePaymentSignatureHeader(paymentPayload) },
    });
    if (!paidRes.ok) {
      const errBody = await paidRes.text().catch(() => paidRes.statusText);
      throw new Error(`HTTP ${paidRes.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await paidRes.json();
    try {
      const settleResponse = httpClient.getPaymentSettleResponse((name) => paidRes.headers.get(name));
      if (settleResponse && data && typeof data === "object" && !Array.isArray(data)) {
        return { ...data, _payment: settleResponse };
      }
    } catch (_) {}
    return data;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => res.statusText);
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }
  return res.json();
}

// --- free discovery ---------------------------------------------------------

const GOV_PATHS = [
  "/congress-stock-trades",
  "/congress-trade-filings",
  "/federal-contracts-search",
  "/federal-contractor-profile",
  "/fec-candidate-money",
  "/fec-candidate-lookup",
  "/lobbying-filings",
  "/federal-register-watch",
  "/congress-bill-lookup",
];

async function getEndpointSpec(args) {
  const res = await fetch(`${BASE_URL}/openapi.json`);
  if (!res.ok) throw new Error(`Failed to fetch discovery doc: HTTP ${res.status}`);
  const spec = await res.json();
  let p = String(args.path || "").trim();
  if (p && !p.startsWith("/")) p = "/" + p;
  if (!p) {
    return {
      routes: GOV_PATHS.map((gp) => {
        const post = spec.paths?.[gp]?.post || {};
        return { path: gp, price: post["x-payment-info"]?.price?.amount ? `$${post["x-payment-info"].price.amount}` : undefined, summary: post.summary || "" };
      }),
      hint: "Pass a path for its full input schema and worked examples.",
    };
  }
  const post = spec.paths?.[p]?.post;
  if (!post) throw new Error(`No gov route "${args.path}". Routes: ${GOV_PATHS.join(", ")}`);
  return {
    path: p,
    price: post["x-payment-info"]?.price?.amount ? `$${post["x-payment-info"].price.amount}` : undefined,
    description: post.description || post.summary,
    input_schema: post.requestBody?.content?.["application/json"]?.schema,
    request_example: post.requestBody?.content?.["application/json"]?.example,
    response_example: post.responses?.["200"]?.content?.["application/json"]?.example,
  };
}

// --- tools ------------------------------------------------------------------

const TOOLS = [
  {
    name: "get_congress_trades",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.02) — Congressional stock trades parsed from official STOCK Act disclosures: US House member trades with ticker, asset, buy/sell, transaction date, and disclosed amount range. Filter by member name, ticker, trade type (purchase/sale/sale_partial/exchange), state, or date window. Disclosures lag trades by up to 45 days by law. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "Member name substring, e.g. 'wittman'" },
        ticker: { type: "string", description: "Exact ticker, e.g. 'NVDA'" },
        type: { type: "string", enum: ["purchase", "sale", "sale_partial", "exchange"] },
        state: { type: "string", description: "State or district prefix, e.g. 'VA' or 'VA01'" },
        since: { type: "string", description: "ISO date lower bound on transaction date" },
        until: { type: "string", description: "ISO date upper bound on transaction date" },
        limit: { type: "integer", description: "Max rows (default 25, max 100)" },
      },
    },
  },
  {
    name: "get_trade_filings",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.01) — US House financial-disclosure filing index: who filed periodic transaction reports, annual reports, amendments, and more — filer, district, type, date, and official PDF link. Poll filing_type 'P' to catch fresh trade disclosures early. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        member: { type: "string", description: "Member name substring" },
        state: { type: "string", description: "State or district prefix" },
        filing_type: { type: "string", description: "Filing type code, e.g. 'P' for trade reports" },
        year: { type: "integer", description: "Filing year, e.g. 2026" },
        limit: { type: "integer", description: "Max rows (default 25, max 100)" },
      },
    },
  },
  {
    name: "search_federal_contracts",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.01) — Federal contract awards won by any company: award id, dollar amount, awarding agency, dates, description, and record link, sorted largest first. Optional agency and date-window filters. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Company name, min 3 chars (required)" },
        agency: { type: "string", description: "Awarding top-tier agency, e.g. 'Department of Defense'" },
        since: { type: "string", description: "ISO start date (default: 2 years back)" },
        until: { type: "string", description: "ISO end date (default: today)" },
        limit: { type: "integer", description: "Max awards (default 10, max 50)" },
      },
      required: ["recipient"],
    },
  },
  {
    name: "get_contractor_profile",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.01) — Resolve a company name to its official federal recipient records: legal name, UEI, parent/child level, recent federal award totals, profile link. Use before search_federal_contracts to disambiguate entities. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        company: { type: "string", description: "Company name, min 3 chars (required)" },
        limit: { type: "integer", description: "Max entities (default 5, max 20)" },
      },
      required: ["company"],
    },
  },
  {
    name: "get_candidate_money",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.01) — Campaign finance totals for a US federal candidate: receipts, spending, cash on hand, debts, individual vs PAC split, per recent cycle. Pass a name (fuzzy) or exact candidate_id; optional office preference. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: "Candidate name, min 3 chars" },
        candidate_id: { type: "string", description: "Exact FEC candidate id (alternative to name)" },
        office: { type: "string", enum: ["president", "senate", "house"] },
      },
    },
  },
  {
    name: "find_candidate",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.005) — Search US federal candidates by name: candidate ids, party, office, state, district, and principal campaign committees. The cheap resolver before get_candidate_money. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "string", description: "Candidate name, min 3 chars (required)" },
      },
      required: ["candidate"],
    },
  },
  {
    name: "search_lobbying",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.01) — US federal lobbying filings by client company or lobbying firm: reported income, issue areas, specific-issue text, and named lobbyists per filing. Optional year filter. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        client: { type: "string", description: "Client organization name, e.g. 'coinbase'" },
        registrant: { type: "string", description: "Lobbying firm name" },
        year: { type: "string", description: "Filing year, e.g. '2025'" },
      },
    },
  },
  {
    name: "watch_federal_register",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.005) — Newest US regulations and official notices matching a topic: proposed and final rules, executive orders, and notices with agency, date, abstract, and links, newest first. Empty query returns the latest government-wide. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search term, e.g. 'stablecoin'" },
      },
    },
  },
  {
    name: "lookup_bill",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description:
      "PAID ($0.005) — Official status of a bill in the US Congress: title, sponsor, latest action, policy area, committees, and counts of actions/cosponsors/amendments. Address by congress number, type (hr, s, hjres, sjres...), and bill number. Requires WALLET_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        congress: { type: "string", description: "Congress number, e.g. '119'" },
        type: { type: "string", description: "Bill type: hr, s, hjres, sjres, hconres, sconres, hres, sres" },
        number: { type: "string", description: "Bill number, e.g. '1'" },
      },
    },
  },
  {
    name: "get_endpoint_spec",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    description:
      "FREE — no wallet needed. Live call spec for the gov-transparency routes: price, input JSON schema, and worked request/response examples from the service's OpenAPI doc. Call with no arguments to list all nine routes, or pass a path for full detail.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Route path, e.g. 'congress-stock-trades'" },
      },
    },
  },
];

const TOOL_ROUTES = {
  get_congress_trades: "/congress-stock-trades",
  get_trade_filings: "/congress-trade-filings",
  search_federal_contracts: "/federal-contracts-search",
  get_contractor_profile: "/federal-contractor-profile",
  get_candidate_money: "/fec-candidate-money",
  find_candidate: "/fec-candidate-lookup",
  search_lobbying: "/lobbying-filings",
  watch_federal_register: "/federal-register-watch",
  lookup_bill: "/congress-bill-lookup",
};

async function main() {
  let ctxPromise;
  async function getPaymentContext() {
    if (!ctxPromise) ctxPromise = Promise.resolve().then(buildBaseHttpClient);
    return ctxPromise;
  }

  const server = new Server({ name: "gov-transparency-mcp", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      let data;
      if (name === "get_endpoint_spec") {
        data = await getEndpointSpec(args);
      } else if (TOOL_ROUTES[name]) {
        data = await paidPost(await getPaymentContext(), TOOL_ROUTES[name], args);
      } else {
        throw new Error(`Unknown tool: ${name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`gov-transparency-mcp v${VERSION} ready — ${BASE_URL}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e.message);
    process.exit(1);
  });
}

module.exports = { TOOLS, TOOL_ROUTES, getEndpointSpec, buildBaseHttpClient };
