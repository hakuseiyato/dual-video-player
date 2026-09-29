'use strict';

/**
 * Session Manager for Dual Video Player
 * Handles WebSocket server (host) and client connections.
 * Runs in Electron main process.
 */

const { WebSocket, WebSocketServer } = require('ws');
const crypto = require('crypto');
const os = require('os');

// ===== CONSTANTS =====
const DEFAULT_PORT = 9877;
const MAX_CLIENTS = 30;
const HEARTBEAT_INTERVAL = 15000;  // 15s
const AUTH_TIMEOUT = 5000;         // 5s for auth after connect
const MAX_MESSAGE_SIZE = 65536;    // 64KB
const RATE_LIMIT_PER_SEC = 30;
const SYNC_THROTTLE_MS = 50;       // throttle frame-step broadcasts

// Valid message types from clients
const CLIENT_MSG_TYPES = ['auth', 'timestamp-add', 'timestamp-delete', 'timestamp-edit', 'file-info', 'pong-app'];
// Host-only message types (clients cannot send these)
const HOST_ONLY_TYPES = ['playback-sync', 'speed-change', 'session-end'];

class SessionManager {
  constructor() {
    this.role = null;           // 'host' | 'client' | null
    this.wss = null;            // WebSocketServer (host)
    this.ws = null;             // WebSocket client connection
    this.userName = '';
    this.password = '';         // session password (host sets, client provides)
    this.port = DEFAULT_PORT;
    this.clients = new Map();   // ws → { userName, authenticated, msgCount, msgCountReset }
    this.users = [];            // [ { name, role } ]
    this.heartbeatTimer = null;
    this.onEvent = null;        // callback: (eventType, data) => void

    // Throttle state for broadcast
    this._lastSyncTime = 0;
    this._pendingSync = null;
    this._syncDebounceTimer = null;
  }

  // ===== HOST: Start Session =====
  startHost(userName, port, password = '') {
    return new Promise((resolve, reject) => {
      if (this.role) {
        reject(new Error('既にセッション中です'));
        return;
      }

      this.role = 'host';
      this.userName = userName;
      this.password = password;
      this.port = port || DEFAULT_PORT;
      this.users = [{ name: userName, role: 'host' }];

      try {
        this.wss = new WebSocketServer({
          port: this.port,
          maxPayload: MAX_MESSAGE_SIZE,
        });
      } catch (err) {
        this.role = null;
        reject(new Error(`ポート ${this.port} でサーバーを起動できません: ${err.message}`));
        return;
      }

      this.wss.on('listening', () => {
        this._startHeartbeat();
        this._emit('session-started', {
          hostName: this.userName,
          port: this.port,
          ip: this._getLocalIP(),
          users: this.users,
        });
        resolve({ port: this.port, ip: this._getLocalIP() });
      });

      this.wss.on('error', (err) => {
        if (this.role === 'host' && this.wss) {
          this._emit('session-error', { message: `サーバーエラー: ${err.message}` });
        }
        if (!this.wss?.address()) {
          // Not yet listening — startup failed
          this.role = null;
          this.wss = null;
          reject(new Error(`ポート ${this.port} は使用中です。別のポートを試してください。`));
        }
      });

      this.wss.on('connection', (ws) => {
        this._handleNewConnection(ws);
      });
    });
  }

  // ===== CLIENT: Join Session =====
  joinSession(userName, host, port, password = '') {
    return new Promise((resolve, reject) => {
      if (this.role) {
        reject(new Error('既にセッション中です'));
        return;
      }

      this.role = 'client';
      this.userName = userName;
      this.password = password;
      this.port = port || DEFAULT_PORT;

      const url = `ws://${host}:${this.port}`;
      const timeout = setTimeout(() => {
        this.ws?.close();
        this.role = null;
        this.ws = null;
        reject(new Error('接続タイムアウト（5秒）'));
      }, AUTH_TIMEOUT);

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(timeout);
        this.role = null;
        reject(new Error(`接続失敗: ${err.message}`));
        return;
      }

      this.ws.on('open', () => {
        // Send auth message
        this._send(this.ws, {
          type: 'auth',
          payload: {
            userName: this.userName,
            password: this.password,
            appVersion: '1.0.0',
          },
        });
      });

      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'auth-result') {
          clearTimeout(timeout);
          if (msg.payload.success) {
            this._emit('session-joined', msg.payload);
            resolve(msg.payload);
          } else {
            this.ws.close();
            this.role = null;
            this.ws = null;
            reject(new Error(msg.payload.reason || '認証失敗'));
          }
          return;
        }

        this._handleClientMessage(msg);
      });

      this.ws.on('close', () => {
        clearTimeout(timeout);
        if (this.role === 'client') {
          this._emit('session-disconnected', { reason: 'connection_closed' });
          this.role = null;
          this.ws = null;
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(timeout);
        if (this.role === 'client') {
          this.role = null;
          this.ws = null;
          reject(new Error(`接続エラー: ${err.message}`));
        }
      });
    });
  }

  // ===== Leave / Stop Session =====
  async stopSession() {
    if (this.role === 'host') {
      // Broadcast session-end to all clients
      this._broadcast({ type: 'session-end', payload: { reason: 'host_closed' } });
      await new Promise(r => setTimeout(r, 500));
      // Close all client connections
      if (this.wss) {
        for (const client of this.wss.clients) {
          client.close(1000, 'session_ended');
        }
        this.wss.close();
        this.wss = null;
      }
      this._stopHeartbeat();
      this.clients.clear();
      this.users = [];
      this.role = null;
      this._emit('session-stopped', {});
    } else if (this.role === 'client') {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this._send(this.ws, { type: 'user-leave', payload: { userName: this.userName } });
        this.ws.close(1000, 'user_left');
      }
      this.ws = null;
      this.role = null;
      this._emit('session-stopped', {});
    }
  }

  // ===== HOST: Handle new WebSocket connection =====
  _handleNewConnection(ws) {
    const clientInfo = {
      userName: null,
      authenticated: false,
      msgCount: 0,
      msgCountReset: Date.now(),
    };
    this.clients.set(ws, clientInfo);

    // Auth timeout — disconnect if not authenticated within 5s
    const authTimer = setTimeout(() => {
      if (!clientInfo.authenticated) {
        ws.close(4001, 'auth_timeout');
        this.clients.delete(ws);
      }
    }, AUTH_TIMEOUT);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      const rawStr = raw.toString();

      // Size check
      if (rawStr.length > MAX_MESSAGE_SIZE) {
        ws.close(4002, 'message_too_large');
        return;
      }

      // Rate limiting
      const now = Date.now();
      if (now - clientInfo.msgCountReset > 1000) {
        clientInfo.msgCount = 0;
        clientInfo.msgCountReset = now;
      }
      clientInfo.msgCount++;
      if (clientInfo.msgCount > RATE_LIMIT_PER_SEC) {
        this._send(ws, { type: 'rate-limit-warning', payload: { message: 'メッセージ送信が速すぎます' } });
        if (clientInfo.msgCount > RATE_LIMIT_PER_SEC * 2) {
          ws.close(4003, 'rate_limit_exceeded');
        }
        return;
      }

      // Parse JSON
      let msg;
      try { msg = JSON.parse(rawStr); } catch {
        return; // silently ignore malformed messages
      }

      // Type check
      if (!msg.type || typeof msg.type !== 'string') return;

      // Handle auth
      if (msg.type === 'auth' && !clientInfo.authenticated) {
        clearTimeout(authTimer);
        this._handleAuth(ws, clientInfo, msg.payload);
        return;
      }

      // Must be authenticated for anything else
      if (!clientInfo.authenticated) return;

      // Check it's a valid client message type
      if (!CLIENT_MSG_TYPES.includes(msg.type)) return;

      // Block host-only operations from clients
      if (HOST_ONLY_TYPES.includes(msg.type)) return;

      // Sanitize strings
      if (msg.payload) {
        if (typeof msg.payload.memo === 'string') msg.payload.memo = this._sanitize(msg.payload.memo);
        if (typeof msg.payload.userName === 'string') msg.payload.userName = this._sanitize(msg.payload.userName);
      }

      // Process and relay
      this._handleHostMessage(ws, clientInfo, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      const info = this.clients.get(ws);
      this.clients.delete(ws);
      if (info?.authenticated && info.userName) {
        this.users = this.users.filter(u => u.name !== info.userName);
        this._broadcast({ type: 'user-leave', payload: { userName: info.userName } });
        this._emit('user-left', { userName: info.userName, users: this.users });
      }
    });

    ws.on('error', () => {
      // Will trigger close event
    });
  }

  // ===== HOST: Authentication =====
  _handleAuth(ws, clientInfo, payload) {
    if (!payload || typeof payload.userName !== 'string') {
      this._send(ws, { type: 'auth-result', payload: { success: false, reason: 'ユーザー名が必要です' } });
      ws.close(4004, 'invalid_auth');
      return;
    }

    // Check max clients
    const authenticatedCount = Array.from(this.clients.values()).filter(c => c.authenticated).length;
    if (authenticatedCount >= MAX_CLIENTS) {
      this._send(ws, { type: 'auth-result', payload: { success: false, reason: 'session_full' } });
      ws.close(4005, 'session_full');
      return;
    }

    // Check password
    if (this.password && payload.password !== this.password) {
      this._send(ws, { type: 'auth-result', payload: { success: false, reason: 'パスワードが違います' } });
      ws.close(4006, 'auth_failed');
      return;
    }

    // Check duplicate username
    const sanitizedName = this._sanitize(payload.userName);
    const nameExists = this.users.some(u => u.name === sanitizedName);
    const finalName = nameExists ? `${sanitizedName}_${Date.now() % 1000}` : sanitizedName;

    clientInfo.authenticated = true;
    clientInfo.userName = finalName;

    this.users.push({ name: finalName, role: 'client' });

    // Send auth success + session state
    this._send(ws, {
      type: 'auth-result',
      payload: {
        success: true,
        userName: finalName,
        users: this.users,
      },
    });

    // Notify host renderer + request session state to send to new client
    this._emit('user-joined', { userName: finalName, users: this.users, ws });

    // Broadcast to other clients
    this._broadcastExcept(ws, { type: 'user-join', payload: { userName: finalName, users: this.users } });
  }

  // ===== HOST: Process client messages and relay =====
  _handleHostMessage(ws, clientInfo, msg) {
    // Attach sender info
    msg.sender = clientInfo.userName;
    msg.timestamp = Date.now();

    switch (msg.type) {
      case 'timestamp-add':
      case 'timestamp-delete':
      case 'timestamp-edit':
        // Relay to all (including sender, for confirmation) and to host renderer
        this._broadcast(msg);
        this._emit('session-message', msg);
        break;

      case 'file-info':
        // Just forward to host renderer for file matching
        this._emit('session-message', msg);
        break;

      case 'pong-app':
        // Application-level pong (not WebSocket pong), no action needed
        break;

      default:
        break;
    }
  }

  // ===== CLIENT: Handle messages from host =====
  _handleClientMessage(msg) {
    switch (msg.type) {
      case 'session-state':
        this.users = msg.payload?.users || [];
        this._emit('session-state', msg.payload);
        break;

      case 'playback-sync':
        this._emit('playback-sync', msg.payload);
        break;

      case 'speed-change':
        this._emit('speed-change', msg.payload);
        break;

      case 'timestamp-add':
      case 'timestamp-delete':
      case 'timestamp-edit':
        this._emit('session-message', msg);
        break;

      case 'user-join':
        this.users = msg.payload?.users || this.users;
        this._emit('user-joined', msg.payload);
        break;

      case 'user-leave':
        this.users = this.users.filter(u => u.name !== msg.payload?.userName);
        this._emit('user-left', msg.payload);
        break;

      case 'file-mismatch':
        this._emit('file-mismatch', msg.payload);
        break;

      case 'session-end':
        this._emit('session-disconnected', { reason: msg.payload?.reason || 'host_ended' });
        this.ws?.close();
        this.ws = null;
        this.role = null;
        break;

      case 'rate-limit-warning':
        this._emit('session-notification', { message: msg.payload?.message });
        break;

      default:
        break;
    }
  }

  // ===== HOST: Send session state to newly connected client =====
  sendSessionState(ws, state) {
    if (this.role !== 'host') return;
    this._send(ws, {
      type: 'session-state',
      payload: {
        hostName: this.userName,
        users: this.users,
        ...state,
      },
    });
  }

  // ===== HOST: Broadcast playback sync (with throttling) =====
  broadcastPlayback(action, currentTime, extra = {}) {
    if (this.role !== 'host') return;

    const msg = {
      type: 'playback-sync',
      payload: { action, currentTime, ...extra },
      sender: this.userName,
      timestamp: Date.now(),
    };

    const now = Date.now();

    // Throttle frame-step messages
    if (action === 'frame-step' && now - this._lastSyncTime < SYNC_THROTTLE_MS) {
      this._pendingSync = msg;
      if (!this._syncDebounceTimer) {
        this._syncDebounceTimer = setTimeout(() => {
          this._syncDebounceTimer = null;
          if (this._pendingSync) {
            this._broadcast(this._pendingSync);
            this._pendingSync = null;
            this._lastSyncTime = Date.now();
          }
        }, SYNC_THROTTLE_MS);
      }
      return;
    }

    this._lastSyncTime = now;
    this._pendingSync = null;
    this._broadcast(msg);
  }

  // ===== HOST: Broadcast speed change =====
  broadcastSpeed(speed) {
    if (this.role !== 'host') return;
    this._broadcast({
      type: 'speed-change',
      payload: { speed },
      sender: this.userName,
      timestamp: Date.now(),
    });
  }

  // ===== HOST: Broadcast timestamp operations =====
  broadcastTimestamp(type, payload) {
    if (this.role !== 'host') return;
    this._broadcast({
      type,
      payload: { ...payload, author: payload.author || this.userName },
      sender: this.userName,
      timestamp: Date.now(),
    });
  }

  // ===== HOST: Send file mismatch warning =====
  sendFileMismatch(ws, details) {
    this._send(ws, {
      type: 'file-mismatch',
      payload: details,
    });
  }

  // ===== UTILITY: Heartbeat =====
  _startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      if (!this.wss) return;
      for (const ws of this.wss.clients) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ===== UTILITY: Send/Broadcast =====
  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  _broadcast(msg) {
    if (!this.wss) return;
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch { /* ignore */ }
      }
    }
  }

  _broadcastExcept(excludeWs, msg) {
    if (!this.wss) return;
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        try { client.send(data); } catch { /* ignore */ }
      }
    }
  }

  // ===== UTILITY: Sanitize strings =====
  _sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>&"']/g, c => ({
      '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#x27;',
    }[c] || c)).substring(0, 200); // limit length
  }

  // ===== UTILITY: Get local IP =====
  _getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return '127.0.0.1';
  }

  // ===== UTILITY: Emit event to main process =====
  _emit(eventType, data) {
    if (typeof this.onEvent === 'function') {
      this.onEvent(eventType, data);
    }
  }

  // ===== GETTERS =====
  get isHost() { return this.role === 'host'; }
  get isClient() { return this.role === 'client'; }
  get isInSession() { return this.role !== null; }
  get sessionInfo() {
    return {
      role: this.role,
      userName: this.userName,
      port: this.port,
      ip: this._getLocalIP(),
      users: this.users,
    };
  }

  // Client sends message to host
  sendToHost(msg) {
    if (this.role !== 'client' || !this.ws) return;
    this._send(this.ws, { ...msg, sender: this.userName, timestamp: Date.now() });
  }
}

module.exports = { SessionManager };
