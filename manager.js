import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv_();

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET || '',
  appsScriptApiUrl: process.env.APPS_SCRIPT_API_URL || '',
  appsScriptApiToken: process.env.APPS_SCRIPT_API_TOKEN || '',
  healthCheckMs: 60000,
  restartDelayMs: 5000
};

const PATHS = {
  serverOut: path.join(__dirname, 'server.out.log'),
  serverErr: path.join(__dirname, 'server.err.log'),
  tunnelOut: path.join(__dirname, 'ssh-tunnel.out.log'),
  tunnelErr: path.join(__dirname, 'ssh-tunnel.err.log'),
  managerLog: path.join(__dirname, 'manager.log')
};

let serverProcess = null;
let tunnelProcess = null;
let currentTunnelUrl = '';
let restartingTunnel = false;
let restartingServer = false;
let shuttingDown = false;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(PATHS.managerLog, `${line}\n`, 'utf8');
}

function appendStream(stream, targetPath, parser) {
  stream.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    fs.appendFileSync(targetPath, text, 'utf8');
    if (parser) parser(text);
  });
}

function ensureCleanLog(pathname) {
  fs.writeFileSync(pathname, '', 'utf8');
}

function startServer() {
  if (serverProcess || shuttingDown) return;

  ensureCleanLog(PATHS.serverOut);
  ensureCleanLog(PATHS.serverErr);
  log('Starting LINE reply server');

  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  appendStream(serverProcess.stdout, PATHS.serverOut);
  appendStream(serverProcess.stderr, PATHS.serverErr);

  serverProcess.on('exit', (code, signal) => {
    log(`Server exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    serverProcess = null;
    if (!shuttingDown) scheduleServerRestart();
  });
}

function scheduleServerRestart() {
  if (restartingServer || shuttingDown) return;
  restartingServer = true;
  setTimeout(() => {
    restartingServer = false;
    startServer();
  }, CONFIG.restartDelayMs);
}

function startTunnel() {
  if (tunnelProcess || shuttingDown) return;

  ensureCleanLog(PATHS.tunnelOut);
  ensureCleanLog(PATHS.tunnelErr);
  log('Starting public tunnel');

  tunnelProcess = spawn(
    'ssh',
    [
      '-o',
      'ServerAliveInterval=30',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ExitOnForwardFailure=yes',
      '-R',
      `80:localhost:${CONFIG.port}`,
      'nokey@localhost.run'
    ],
    {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  appendStream(tunnelProcess.stdout, PATHS.tunnelOut, handleTunnelOutput);
  appendStream(tunnelProcess.stderr, PATHS.tunnelErr, handleTunnelErrorOutput);

  tunnelProcess.on('exit', (code, signal) => {
    log(`Tunnel exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    tunnelProcess = null;
    currentTunnelUrl = '';
    if (!shuttingDown) scheduleTunnelRestart();
  });
}

function handleTunnelOutput(text) {
  const match = text.match(/https:\/\/([a-z0-9]+\.lhr\.life)/i);
  if (!match) return;

  const url = `https://${match[1]}`;
  if (url === currentTunnelUrl) return;

  currentTunnelUrl = url;
  log(`Tunnel url detected: ${url}`);
  void syncWebhook(url);
}

function handleTunnelErrorOutput(text) {
  if (!text.trim()) return;
  log(`Tunnel stderr: ${text.trim()}`);
}

function scheduleTunnelRestart() {
  if (restartingTunnel || shuttingDown) return;
  restartingTunnel = true;
  setTimeout(() => {
    restartingTunnel = false;
    startTunnel();
  }, CONFIG.restartDelayMs);
}

async function syncWebhook(baseUrl) {
  const webhookUrl = `${baseUrl}/webhook`;
  try {
    await updateLineWebhook(webhookUrl);
    const result = await testLineWebhook();
    log(`LINE webhook synced: ${webhookUrl} / test=${result.success} ${result.reason}`);
  } catch (error) {
    log(`Failed to sync LINE webhook: ${error.message}`);
  }
}

async function updateLineWebhook(webhookUrl) {
  const response = await fetch('https://api.line.me/v2/bot/channel/webhook/endpoint', {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${CONFIG.lineChannelAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ endpoint: webhookUrl })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LINE webhook update failed ${response.status}: ${body}`);
  }
}

async function testLineWebhook() {
  const response = await fetch('https://api.line.me/v2/bot/channel/webhook/test', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.lineChannelAccessToken}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`LINE webhook test failed ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function healthCheck() {
  if (!currentTunnelUrl || shuttingDown) return;

  try {
    const response = await fetch(`${currentTunnelUrl}/`, {
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      throw new Error(`status ${response.status}`);
    }
  } catch (error) {
    log(`Tunnel health check failed: ${error.message}`);
    restartTunnel();
  }
}

function restartTunnel() {
  if (restartingTunnel || shuttingDown) return;
  restartingTunnel = true;

  if (tunnelProcess) {
    log('Restarting public tunnel');
    tunnelProcess.kill();
  }

  setTimeout(() => {
    restartingTunnel = false;
    if (!tunnelProcess) startTunnel();
  }, CONFIG.restartDelayMs);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down manager');

  if (tunnelProcess) tunnelProcess.kill();
  if (serverProcess) serverProcess.kill();
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

ensureCleanLog(PATHS.managerLog);
log('Manager booted');
startServer();
startTunnel();
setInterval(() => {
  void healthCheck();
}, CONFIG.healthCheckMs);

function loadDotEnv_() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = String(line || '').trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  });
}
