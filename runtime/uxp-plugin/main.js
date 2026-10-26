"use strict";

const photoshop = require("photoshop");
const uxp = require("uxp");
const { createPhotoshopAdapter } = require("./photoshop-adapter.js");
const adapter = createPhotoshopAdapter(photoshop, uxp);
const statusElement = document.getElementById("status");
const logElement = document.getElementById("log");
const connectButton = document.getElementById("connect");
const disconnectButton = document.getElementById("disconnect");
let running = false;
let activeLoop = null;
let connection = null;

function status(text) { statusElement.textContent = text; }
function log(text) {
  const line = `${new Date().toISOString().slice(11, 19)} ${text}`;
  logElement.textContent = `${line}\n${logElement.textContent}`.slice(0, 5000);
}
function controls() { connectButton.disabled = activeLoop !== null; disconnectButton.disabled = !running; }

async function request(path, options) {
  const response = await fetch(connection.baseUrl + path, {
    method: options && options.method || "GET",
    headers: { "Authorization": `Bearer ${connection.token}`, "Content-Type": "application/json" },
    ...(options && options.body ? { body: JSON.stringify(options.body) } : {})
  });
  if (!response.ok) {
    const error = new Error(`本地服务返回 HTTP ${response.status}；请检查服务和插件连接`);
    error.code = "BRIDGE_HTTP_ERROR";
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function loop(sessionId) {
  // Exactly one command at a time. Failed result delivery ends the loop: executing
  // it again could duplicate a mutation whose real outcome the bridge cannot know.
  while (running) {
    const response = await request(`/plugin/next?sessionId=${encodeURIComponent(sessionId)}`);
    if (!response || !response.command) continue;
    const command = response.command;
    if (!running) {
      await request("/plugin/result", { method: "POST", body: { sessionId, id: command.id, ok: false, error: { code: "PLUGIN_STOPPED", message: "用户已停止接收任务；本命令未执行" } } });
      break;
    }
    log(`执行 ${command.operation} [${command.id}]`);
    let result;
    try {
      result = { sessionId, id: command.id, ok: true, result: await adapter.execute(command.operation, command.args) };
    } catch (error) {
      result = { sessionId, id: command.id, ok: false, error: { code: error.code || "PHOTOSHOP_ERROR", message: error.message || String(error), ...(error.details !== undefined ? { details: error.details } : {}) } };
      log(`失败 ${result.error.code}: ${result.error.message}`);
    }
    // Result POST is never followed by automatic re-execution.
    await request("/plugin/result", { method: "POST", body: result });
    if (result.ok) log(`完成 ${command.operation}`);
  }
}

connectButton.addEventListener("click", async () => {
  if (activeLoop) return;
  connectButton.disabled = true;
  try {
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["json"], allowMultiple: false });
    if (!file) { connectButton.disabled = false; return; }
    const config = JSON.parse(await file.read());
    if (config.baseUrl !== "http://127.0.0.1:57123" || config.protocolVersion !== 1 || typeof config.token !== "string" || config.token.length < 32) throw new Error("连接文件无效；仅接受协议 v1 的本机 127.0.0.1:57123 服务");
    connection = { baseUrl: config.baseUrl, token: config.token };
    const response = await request("/plugin/hello", { method: "POST", body: { pluginVersion: "0.1.0", photoshopVersion: photoshop.app.version, protocolVersion: 1 } });
    if (!response || typeof response.sessionId !== "string") throw new Error("服务未返回有效会话");
    running = true;
    status(`已连接 · Photoshop ${photoshop.app.version}`);
    activeLoop = loop(response.sessionId);
    controls();
    await activeLoop;
    // The polling loop has exited normally: every delivered command has either
    // completed or been explicitly rejected before this session is released.
    try {
      await request("/plugin/disconnect", { method: "POST", body: { sessionId: response.sessionId } });
      status("已断开连接");
    } catch (error) {
      status("已停止接收任务；服务会话尚未释放");
      log(`断开会话失败：${error.message || String(error)}。请检查服务状态；不会重放任何操作。`);
    }
  } catch (error) {
    status(`已停止：${error.message || String(error)}`);
    log("连接或通信失败；不会自动重放操作。请检查本地日志后手动重新连接。");
  } finally {
    running = false;
    activeLoop = null;
    connection = null;
    controls();
  }
});

disconnectButton.addEventListener("click", () => {
  running = false;
  status("停止中；当前命令完成后结束，未执行命令将被拒绝");
  controls();
});
