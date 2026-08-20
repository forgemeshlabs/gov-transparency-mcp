"use strict";
const { test } = require("node:test");
const assert = require("node:assert");
const { TOOLS, TOOL_ROUTES, buildBaseHttpClient } = require("..");

test("every paid tool maps to a route; free tool does not", () => {
  const paid = TOOLS.filter((t) => t.description.startsWith("PAID"));
  const free = TOOLS.filter((t) => t.description.startsWith("FREE"));
  assert.strictEqual(paid.length, 9);
  assert.strictEqual(free.length, 1);
  for (const t of paid) {
    assert.ok(TOOL_ROUTES[t.name], `${t.name} has a route`);
    assert.match(TOOL_ROUTES[t.name], /^\/[a-z-]+$/);
    assert.match(t.description, /\$\d/, `${t.name} states its price`);
    assert.ok(t.description.includes("WALLET_PRIVATE_KEY"), `${t.name} states the wallet requirement`);
  }
  assert.ok(!TOOL_ROUTES[free[0].name]);
});

test("tool input schemas are valid JSON-schema objects", () => {
  for (const t of TOOLS) {
    assert.strictEqual(t.inputSchema.type, "object", t.name);
    assert.ok(t.inputSchema.properties && typeof t.inputSchema.properties === "object", t.name);
    for (const req of t.inputSchema.required || []) {
      assert.ok(t.inputSchema.properties[req], `${t.name}: required "${req}" is defined`);
    }
  }
});

test("missing wallet key produces a guiding error, not a crash", () => {
  const saved = process.env.WALLET_PRIVATE_KEY;
  delete process.env.WALLET_PRIVATE_KEY;
  try {
    assert.throws(buildBaseHttpClient, /WALLET_PRIVATE_KEY is not set.*dedicated low-balance/s);
  } finally {
    if (saved !== undefined) process.env.WALLET_PRIVATE_KEY = saved;
  }
});
