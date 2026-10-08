#!/usr/bin/env node
"use strict";

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const { x402Client, x402HTTPClient } = require("@x402/core/client");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { toClientEvmSigner } = require("@x402/evm");
const { privateKeyToAccount } = require("viem/accounts");
const { createGuard } = require("./x402-guard");

const VERSION = require("./package.json").version;
const BASE_URL = "https://x402.forgemesh.io";
// Highest listed price is $0.02; the guard refuses to sign for any other payee, network, asset, or higher amount.
const guard = createGuard({
  baseUrl: BASE_URL,
  payTo: ["0x850363a27F0aC6fEb9C7a3eC4C1d295262dF9432", "0x84A1827F1705C257e80771fDc2B152Aea4A57a08"],
  maxPriceUsd: 0.02,
  sessionBudgetUsd: 10,
});

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
  const coreClient = new x402Client().register("eip155:*", new ExactEvmScheme(toClientEvmSigner(account))).registerPolicy(guard.policy);
  return { httpClient: new x402HTTPClient(coreClient), account };
}

function paidPost(ctx, path, body) {
  return guard.callPaid(ctx.httpClient, path, { method: "POST", body: body || {} });
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
  const res = await guard.fetchBounded(`${BASE_URL}/openapi.json`);
  if (!res.ok) throw new Error(`Failed to fetch discovery doc: HTTP ${res.status}`);
  let spec;
  try { spec = JSON.parse(res.text); } catch { throw new Error("Failed to fetch discovery doc: non-JSON response"); }
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
        member: { type: "string", maxLength: 100, description: "Member name substring, e.g. 'wittman'" },
        ticker: { type: "string", maxLength: 10, pattern: "^[A-Za-z0-9.-]+$", description: "Exact ticker, e.g. 'NVDA'" },
        type: { type: "string", enum: ["purchase", "sale", "sale_partial", "exchange"] },
        state: { type: "string", maxLength: 8, pattern: "^[A-Za-z0-9]+$", description: "State or district prefix, e.g. 'VA' or 'VA01'" },
        since: { type: "string", maxLength: 32, pattern: "^\\d{4}-\\d{2}-\\d{2}([T ][0-9:.Z+-]{1,20})?$", description: "ISO date lower bound on transaction date" },
        until: { type: "string", maxLength: 32, pattern: "^\\d{4}-\\d{2}-\\d{2}([T ][0-9:.Z+-]{1,20})?$", description: "ISO date upper bound on transaction date" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max rows (default 25, max 100)" },
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
        member: { type: "string", maxLength: 100, description: "Member name substring" },
        state: { type: "string", maxLength: 8, pattern: "^[A-Za-z0-9]+$", description: "State or district prefix" },
        filing_type: { type: "string", maxLength: 3, pattern: "^[A-Za-z]+$", description: "Filing type code, e.g. 'P' for trade reports" },
        year: { type: "integer", minimum: 1990, maximum: 2100, description: "Filing year, e.g. 2026" },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Max rows (default 25, max 100)" },
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
        recipient: { type: "string", maxLength: 200, description: "Company name, min 3 chars (required)" },
        agency: { type: "string", maxLength: 200, description: "Awarding top-tier agency, e.g. 'Department of Defense'" },
        since: { type: "string", maxLength: 32, pattern: "^\\d{4}-\\d{2}-\\d{2}([T ][0-9:.Z+-]{1,20})?$", description: "ISO start date (default: 2 years back)" },
        until: { type: "string", maxLength: 32, pattern: "^\\d{4}-\\d{2}-\\d{2}([T ][0-9:.Z+-]{1,20})?$", description: "ISO end date (default: today)" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Max awards (default 10, max 50)" },
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
        company: { type: "string", maxLength: 200, description: "Company name, min 3 chars (required)" },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Max entities (default 5, max 20)" },
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
        candidate: { type: "string", maxLength: 200, description: "Candidate name, min 3 chars" },
        candidate_id: { type: "string", maxLength: 20, pattern: "^[A-Za-z0-9]+$", description: "Exact FEC candidate id (alternative to name)" },
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
        candidate: { type: "string", maxLength: 200, description: "Candidate name, min 3 chars (required)" },
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
        client: { type: "string", maxLength: 200, description: "Client organization name, e.g. 'coinbase'" },
        registrant: { type: "string", maxLength: 200, description: "Lobbying firm name" },
        year: { type: "string", maxLength: 4, pattern: "^\\d{4}$", description: "Filing year, e.g. '2025'" },
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
        q: { type: "string", maxLength: 200, description: "Search term, e.g. 'stablecoin'" },
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
        congress: { type: "string", maxLength: 3, pattern: "^\\d{1,3}$", description: "Congress number, e.g. '119'" },
        type: { type: "string", enum: ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"], description: "Bill type: hr, s, hjres, sjres, hconres, sconres, hres, sres" },
        number: { type: "string", maxLength: 6, pattern: "^\\d{1,6}$", description: "Bill number, e.g. '1'" },
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
        path: { type: "string", maxLength: 100, pattern: "^/?[A-Za-z0-9._-]+$", description: "Route path, e.g. 'congress-stock-trades'" },
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

// Validate arguments against the tool's own inputSchema before any network call or payment.
function validateArgs(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object");
  for (const key of tool.inputSchema.required || []) if (args[key] === undefined) throw new Error(`Missing required argument: ${key}`);
  for (const [key, spec] of Object.entries(tool.inputSchema.properties)) {
    const v = args[key];
    if (v === undefined) continue;
    if (spec.type === "string") {
      if (typeof v !== "string" || v.length > (spec.maxLength || 2000)) throw new Error(`Invalid ${key}: expected string up to ${spec.maxLength || 2000} chars`);
      if (spec.enum && !spec.enum.includes(v)) throw new Error(`Invalid ${key}: must be one of ${spec.enum.join(", ")}`);
      if (spec.pattern && !new RegExp(spec.pattern).test(v)) throw new Error(`Invalid ${key}: unexpected format`);
    } else if (spec.type === "integer") {
      if (!Number.isInteger(v)) throw new Error(`Invalid ${key}: expected integer`);
      if (v < spec.minimum || v > spec.maximum) throw new Error(`Invalid ${key}: must be between ${spec.minimum} and ${spec.maximum}`);
    }
  }
}

// Forward only the arguments the tool declares.
function pickArgs(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  return Object.fromEntries(Object.entries(args).filter(([k]) => k in tool.inputSchema.properties));
}

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
      validateArgs(name, args);
      let data;
      if (name === "get_endpoint_spec") {
        data = await getEndpointSpec(args);
      } else if (TOOL_ROUTES[name]) {
        data = await paidPost(await getPaymentContext(), TOOL_ROUTES[name], pickArgs(name, args));
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
  console.error(`gov-transparency-mcp v${VERSION} ready`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("Fatal:", e.message);
    process.exit(1);
  });
}

module.exports = { TOOLS, TOOL_ROUTES, validateArgs, pickArgs, getEndpointSpec, buildBaseHttpClient };
