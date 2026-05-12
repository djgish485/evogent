const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');
const {
  OPENCLAW_UNREACHABLE_MESSAGE,
  resolveOpenClawConnectionConfig,
} = require('./config.js');

const PROTOCOL_VERSION = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 15_000;
const INITIAL_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 30_000;

function normalizeGatewayErrorMessage(error) {
  if (error && typeof error === 'object') {
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : '';
    const code = typeof error.code === 'string' && error.code.trim()
      ? error.code.trim()
      : '';
    if (message) return message;
    if (code) return code;
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return OPENCLAW_UNREACHABLE_MESSAGE;
}

class OpenClawGatewayError extends Error {
  constructor(error) {
    super(normalizeGatewayErrorMessage(error));
    this.name = 'OpenClawGatewayError';
    this.details = error && typeof error === 'object' ? error : null;
  }
}

class OpenClawGatewayClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.pending = new Map();
    this.reconnectTimer = null;
    this.reconnectMs = INITIAL_RECONNECT_MS;
    this.pingTimer = null;
    this.sessionEventsSubscribed = false;
    this.sessionMessageSubscriptions = new Set();
    this.lastError = null;
    this.lastStatus = {
      connected: false,
      error: null,
    };
  }

  status() {
    return {
      connected: this.connected,
      error: this.lastStatus.error,
    };
  }

  ensureConnected() {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve(this);
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
    });
    this.openSocket();
    return this.connectPromise;
  }

  openSocket() {
    this.clearReconnectTimer();
    this.clearPingTimer();

    let config;
    try {
      config = resolveOpenClawConnectionConfig();
    } catch (error) {
      this.failConnect(error);
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(config.gatewayUrl, {
      handshakeTimeout: CONNECT_TIMEOUT_MS,
    });
    this.ws = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      this.failConnect(new Error(OPENCLAW_UNREACHABLE_MESSAGE));
    }, CONNECT_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (frame?.type === 'event' && frame.event === 'connect.challenge') {
        this.sendConnectFrame(config);
        return;
      }

      if (frame?.type === 'res') {
        if (frame.id === 'connect') {
          clearTimeout(connectTimeout);
          if (frame.ok) {
            this.finishConnect(frame.payload);
          } else {
            this.failConnect(new OpenClawGatewayError(frame.error));
            ws.close();
          }
          return;
        }

        this.handleResponseFrame(frame);
        return;
      }

      if (frame?.type === 'event') {
        this.emit('event', {
          event: frame.event,
          payload: frame.payload,
          seq: frame.seq,
          stateVersion: frame.stateVersion,
        });

        if (frame.event === 'shutdown') {
          this.lastStatus = {
            connected: false,
            error: 'OpenClaw is restarting',
          };
          this.emit('status', this.lastStatus);
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(connectTimeout);
      if (this.ws === ws) {
        this.ws = null;
      }
      this.markDisconnected(OPENCLAW_UNREACHABLE_MESSAGE);
      this.rejectAllPending(new Error(OPENCLAW_UNREACHABLE_MESSAGE));
      this.scheduleReconnect();
    });

    ws.on('error', (error) => {
      clearTimeout(connectTimeout);
      this.lastError = error;
      this.failConnect(new Error(OPENCLAW_UNREACHABLE_MESSAGE));
      this.markDisconnected(OPENCLAW_UNREACHABLE_MESSAGE);
    });
  }

  sendConnectFrame(config) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    ws.send(JSON.stringify({
      type: 'req',
      id: 'connect',
      method: 'connect',
      params: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: 'gateway-client',
          version: 'evogent',
          platform: process.platform,
          mode: 'backend',
        },
        role: 'operator',
        scopes: ['operator.read', 'operator.write'],
        caps: [],
        commands: [],
        permissions: {},
        auth: config.token ? { token: config.token } : {},
        locale: 'en-US',
        userAgent: 'evogent/openclaw-mirror',
      },
    }));
  }

  finishConnect(payload) {
    this.connected = true;
    this.reconnectMs = INITIAL_RECONNECT_MS;
    this.lastError = null;
    this.lastStatus = {
      connected: true,
      error: null,
    };
    this.emit('status', this.lastStatus);

    const tickIntervalMs = typeof payload?.policy?.tickIntervalMs === 'number'
      ? payload.policy.tickIntervalMs
      : 30_000;
    this.startPingTimer(tickIntervalMs);

    const resolve = this.connectResolve;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    resolve?.(this);

    this.replaySubscriptions();
  }

  failConnect(error) {
    const message = normalizeGatewayErrorMessage(error);
    this.lastError = error;
    this.lastStatus = {
      connected: false,
      error: message,
    };
    this.emit('status', this.lastStatus);

    if (this.connectReject) {
      this.connectReject(new Error(message));
      this.connectPromise = null;
      this.connectResolve = null;
      this.connectReject = null;
    }
  }

  markDisconnected(message) {
    this.connected = false;
    this.clearPingTimer();
    this.lastStatus = {
      connected: false,
      error: message,
    };
    this.emit('status', this.lastStatus);
  }

  startPingTimer(intervalMs) {
    this.clearPingTimer();
    const delay = Math.max(5_000, intervalMs);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.ping();
        } catch {
          // The close handler owns reconnect behavior.
        }
      }
    }, delay);
  }

  clearPingTimer() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectMs;
    this.reconnectMs = Math.min(MAX_RECONNECT_MS, Math.max(INITIAL_RECONNECT_MS, this.reconnectMs * 2));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected().catch(() => {
        // keep retrying through scheduleReconnect
      });
    }, delay);
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  request(method, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs === null
      ? null
      : typeof options.timeoutMs === 'number'
        ? options.timeoutMs
        : REQUEST_TIMEOUT_MS;

    return this.ensureConnected().then(() => new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(OPENCLAW_UNREACHABLE_MESSAGE));
        return;
      }

      const id = `${Date.now().toString(36)}-${randomUUID()}`;
      let timer = null;
      if (timeoutMs !== null) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
      }

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      ws.send(JSON.stringify({
        type: 'req',
        id,
        method,
        params,
      }));
    }));
  }

  handleResponseFrame(frame) {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
      return;
    }
    pending.reject(new OpenClawGatewayError(frame.error));
  }

  rejectAllPending(error) {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async subscribeSessions() {
    this.sessionEventsSubscribed = true;
    return this.request('sessions.subscribe', {});
  }

  async subscribeSessionMessages(sessionKey) {
    const key = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!key) {
      throw new Error('OpenClaw session key is required');
    }
    this.sessionMessageSubscriptions.add(key);
    return this.request('sessions.messages.subscribe', { key });
  }

  replaySubscriptions() {
    if (this.sessionEventsSubscribed) {
      this.request('sessions.subscribe', {}).catch(() => {});
    }
    for (const sessionKey of this.sessionMessageSubscriptions) {
      this.request('sessions.messages.subscribe', { key: sessionKey }).catch(() => {});
    }
  }
}

const singleton = new OpenClawGatewayClient();

function getOpenClawGatewayClient() {
  return singleton;
}

module.exports = {
  OpenClawGatewayClient,
  OpenClawGatewayError,
  getOpenClawGatewayClient,
  normalizeGatewayErrorMessage,
};
