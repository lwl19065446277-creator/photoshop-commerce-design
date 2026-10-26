"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("./main.js"), "utf8");

function panelHarness(mode) {
  const elements = Object.fromEntries(["status", "log", "connect", "disconnect"].map(id => [id, { textContent: "", disabled: id === "disconnect", handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } }]));
  const requests = [];
  let executions = 0;
  const connection = { baseUrl: "http://127.0.0.1:57123", token: "test-only-token-000000000000000000000", protocolVersion: 1 };
  vm.runInNewContext(source, {
    document: { getElementById: id => elements[id] },
    require(name) {
      if (name === "photoshop") return { app: { version: "27.0" } };
      if (name === "uxp") return { storage: { localFileSystem: { getFileForOpening: async () => ({ read: async () => JSON.stringify(connection) }) } } };
      if (name === "./photoshop-adapter.js") return { createPhotoshopAdapter: () => ({ execute: async () => { executions++; return { changed: true }; } }) };
      throw new Error(`Unexpected dependency ${name}`);
    },
    fetch: async (url, options) => {
      const route = url.slice(connection.baseUrl.length);
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ route, body });
      if (route === "/plugin/hello") return { ok: true, status: 200, json: async () => ({ sessionId: "test-session" }) };
      if (route.startsWith("/plugin/next")) {
        if (mode !== "result-failure") elements.disconnect.handlers.click();
        if (mode === "normal") return { ok: true, status: 204 };
        return { ok: true, status: 200, json: async () => ({ command: { id: "command-1", operation: "set_text", args: { documentId: 2, layerId: 10, text: "原文" } } }) };
      }
      if (route === "/plugin/result" && mode === "result-failure") return { ok: false, status: 500 };
      if (route === "/plugin/disconnect" && mode === "disconnect-failure") return { ok: false, status: 400 };
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    }
  });
  return { elements, requests, executions: () => executions, connect: () => elements.connect.handlers.click() };
}

test("panel releases a stopped session after the final poll and restores controls", async () => {
  const h = panelHarness("normal");
  await h.connect();
  assert.equal(h.requests.at(-1).route, "/plugin/disconnect");
  assert.deepEqual(h.requests.at(-1).body, { sessionId: "test-session" });
  assert.equal(h.elements.status.textContent, "已断开连接");
  assert.equal(h.elements.connect.disabled, false);
  assert.equal(h.elements.disconnect.disabled, true);
  assert.equal(h.executions(), 0);
});

test("stopping during a poll rejects its new command before disconnecting", async () => {
  const h = panelHarness("stop-before-command");
  await h.connect();
  const result = h.requests.find(r => r.route === "/plugin/result");
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, "PLUGIN_STOPPED");
  assert.equal(h.requests.at(-1).route, "/plugin/disconnect");
  assert.equal(h.executions(), 0);
});

test("failed result delivery stops without replaying or releasing an uncertain session", async () => {
  const h = panelHarness("result-failure");
  await h.connect();
  assert.equal(h.executions(), 1);
  assert.equal(h.requests.filter(r => r.route === "/plugin/result").length, 1);
  assert.equal(h.requests.filter(r => r.route === "/plugin/disconnect").length, 0);
  assert.equal(h.elements.connect.disabled, false);
  assert.equal(h.elements.disconnect.disabled, true);
  assert.match(h.elements.log.textContent, /不会自动重放操作/);
});
