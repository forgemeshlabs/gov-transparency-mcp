"use strict";
/**
 * x402-guard — client-side payment and HTTP guard for ForgeMesh MCP servers (vendored copy per repo).
 *
 *   const { createGuard } = require("./x402-guard");
 *   const guard = createGuard({
 *     baseUrl: "https://x402.coinopai.com",          // the ONLY origin this server talks to
 *     payTo: ["0x1304EC1A8945365e43A5c18a734065f107B417cA"], // wallets a 402 may name
 *     maxPriceUsd: 1.00,                               // per-call ceiling (env X402_MAX_PRICE_USD overrides, lower only)
 *     sessionBudgetUsd: 10.00,                         // cumulative ceiling per process (env X402_SESSION_BUDGET_USD)
 *   });
 *   const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer)).registerPolicy(guard.policy);
 *   const data = await guard.callPaid(httpClient, "/api/route", { method: "POST", body: {...} });
 *
 * What it enforces, before any signature is produced:
 *   network  = eip155:8453 (Base mainnet), asset = USDC on Base, payTo in the allowlist,
 *   amount  <= maxPriceUsd, running total <= sessionBudgetUsd.
 * What it enforces on every HTTP call: same origin as baseUrl, https, no redirects,
 *   REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES. No global monkeypatching anywhere.
 */

const BASE_MAINNET = "eip155:8453";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 2_000_000;

function usdFromRequirement(r) {
  const raw = r.amount ?? r.maxAmountRequired ?? r.value;
  if (raw === undefined || raw === null) return NaN;
  const s = String(raw);
  if (s.startsWith("$")) return Number(s.slice(1));
  return Number(BigInt(s)) / 1e6; // USDC atomic units
}

function lowerCap(defaultUsd, envName) {
  const env = Number(process.env[envName]);
  return Number.isFinite(env) && env > 0 ? Math.min(env, defaultUsd) : defaultUsd;
}

function createGuard(opts) {
  if (!opts || !opts.baseUrl) throw new Error("x402-guard: baseUrl is required");
  const base = new URL(opts.baseUrl);
  if (base.protocol !== "https:") throw new Error("x402-guard: baseUrl must be https");
  const origin = base.origin;
  // An empty allowlist means "this server never signs payments": the policy refuses every 402 and
  // only fetchBounded is useful. Pass payTo: [] explicitly for free-only servers.
  if (!Array.isArray(opts.payTo)) throw new Error("x402-guard: payTo allowlist is required (use [] for a server that never signs)");
  const payTo = new Set(opts.payTo.map((a) => String(a).toLowerCase()));
  const maxPriceUsd = lowerCap(opts.maxPriceUsd ?? 1.0, "X402_MAX_PRICE_USD");
  const sessionBudgetUsd = lowerCap(opts.sessionBudgetUsd ?? 10.0, "X402_SESSION_BUDGET_USD");
  let spentUsd = 0; // reserved at signing time, never released: a signed authorization can be settled even if our retry fails

  function policy(_version, requirements) {
    if (payTo.size === 0) throw new Error("x402-guard refused to sign: this server has no payee allowlist and never signs payments");
    const kept = requirements.filter((r) => {
      if (r.network !== BASE_MAINNET) return false;
      if (String(r.asset || "").toLowerCase() !== USDC_BASE) return false;
      if (!payTo.has(String(r.payTo || "").toLowerCase())) return false;
      const usd = usdFromRequirement(r);
      if (!Number.isFinite(usd) || usd <= 0 || usd > maxPriceUsd) return false;
      if (spentUsd + usd > sessionBudgetUsd) return false;
      return true;
    });
    if (kept.length === 0) {
      const seen = requirements.map((r) => `${r.network} ${r.payTo} $${usdFromRequirement(r)}`).join("; ");
      throw new Error(`x402-guard refused to sign: no payment option passed the guard (network must be ${BASE_MAINNET}, asset USDC, payTo in allowlist, price <= $${maxPriceUsd}, session total <= $${sessionBudgetUsd}). Offered: ${seen}`);
    }
    // Hand the selector exactly one option so the amount we reserve is the amount that gets signed.
    const chosen = kept.reduce((a, b) => (usdFromRequirement(b) < usdFromRequirement(a) ? b : a));
    spentUsd += usdFromRequirement(chosen);
    return [chosen];
  }

  async function fetchBounded(url, init = {}) {
    const target = new URL(String(url), origin);
    if (target.origin !== origin) throw new Error(`x402-guard: refusing request to ${target.origin}; this server only talks to ${origin}`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(target.toString(), { ...init, signal: ctrl.signal, redirect: "error" });
      const declared = Number(res.headers.get("content-length") || 0);
      if (declared > MAX_RESPONSE_BYTES) { ctrl.abort(); throw new Error(`x402-guard: response too large (${declared} bytes)`); }
      const chunks = [];
      let received = 0;
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_RESPONSE_BYTES) { ctrl.abort(); throw new Error("x402-guard: response too large"); }
          chunks.push(value);
        }
      }
      const bytes = Buffer.concat(chunks);
      return { status: res.status, ok: res.ok, headers: res.headers, bytes, text: bytes.toString("utf8") };
    } finally {
      clearTimeout(timer);
    }
  }

  function parseJson(res) {
    try { return JSON.parse(res.text); } catch { throw new Error(`HTTP ${res.status}: non-JSON response`); }
  }

  // GET or POST a paid route: unpaid request → 402 → guarded signature → retry. Returns parsed JSON;
  // on a paid response attaches the settlement receipt as `_payment` when the body is an object.
  async function callPaid(httpClient, path, { method = "GET", body, query, headers = {} } = {}) {
    const url = new URL(path, origin);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const init = { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) };
    const res = await fetchBounded(url, init);
    if (res.status !== 402) {
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 200)}`);
      return parseJson(res);
    }
    let challenge;
    try { challenge = JSON.parse(res.text); } catch { challenge = undefined; }
    const paymentRequired = httpClient.getPaymentRequiredResponse((n) => res.headers.get(n), challenge);
    const payload = await httpClient.createPaymentPayload(paymentRequired); // policy runs (and reserves budget) inside
    const paid = await fetchBounded(url, { ...init, headers: { ...init.headers, ...httpClient.encodePaymentSignatureHeader(payload) } });
    if (!paid.ok) throw new Error(`Payment failed — HTTP ${paid.status}: ${paid.text.slice(0, 200)}`);
    let settle = null;
    try { settle = httpClient.getPaymentSettleResponse((n) => paid.headers.get(n)) || null; } catch { settle = null; }
    const contentType = paid.headers.get("content-type") || "";
    // Non-JSON paid responses (audio, images) come back as raw bytes, never decoded as text.
    if (!contentType.includes("json")) return { _binary: true, content_type: contentType, bytes: paid.bytes, _payment: settle };
    const data = parseJson(paid);
    if (settle && data && typeof data === "object" && !Array.isArray(data)) return { ...data, _payment: settle };
    return data;
  }

  return {
    policy,
    fetchBounded,
    callPaid,
    limits: () => ({ maxPriceUsd, sessionBudgetUsd, spentUsd, origin, payTo: [...payTo] }),
  };
}

module.exports = { createGuard, REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES, BASE_MAINNET, USDC_BASE };
