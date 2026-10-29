const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;

const analytics = require("./analytics");

// Helper to parse JSON request body
function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(data));
}

// Resilient WebSocket send helper with active connection check and error trapping
function safeWsSend(ws, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    ws.send(raw);
    return true;
  } catch (err) {
    console.warn("safeWsSend warning:", err.message);
    return false;
  }
}

// HTTP Server for serving index.html, admin.html, API endpoints, and static assets
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  let reqUrl = urlObj.pathname;

  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  // Rewrite routes
  if (reqUrl === "/" || reqUrl === "") reqUrl = "/index.html";
  if (reqUrl === "/admin" || reqUrl === "/admin/") reqUrl = "/admin.html";

  // System & Game Status
  if (reqUrl === "/status") {
    const roomSummaries = Array.from(rooms.entries()).map(([code, r]) => ({
      code,
      players: r.players.size,
      maxPlayers: r.maxPlayers,
      mapId: r.mapId,
      inGame: r.inGame
    }));
    return sendJson(res, 200, {
      status: "online",
      activeRooms: rooms.size,
      totalPlayers: Array.from(rooms.values()).reduce((sum, r) => sum + r.players.size, 0),
      rooms: roomSummaries
    });
  }

  // =========================================================================
  // ANALYTICS & ADMIN API ENDPOINTS (SEPARATED FOR ANALYTIC PURPOSE)
  // =========================================================================

  // 1. Analytics Summary (Traffic, Devices: Android vs Desktop vs Other, KPIs)
  if (reqUrl === "/api/analytics/summary" && req.method === "GET") {
    const timeRange = urlObj.searchParams.get("timeRange") || "7d";
    const totalPlayersOnline = Array.from(rooms.values()).reduce((sum, r) => sum + r.players.size, 0);
    const summary = await analytics.getSummary(timeRange, {
      activeRooms: rooms.size,
      playersOnline: totalPlayersOnline
    });
    return sendJson(res, 200, summary);
  }

  // 2. Registered Players List (Search, Filter by Device / Status, Sort)
  if (reqUrl === "/api/analytics/players" && req.method === "GET") {
    const search = urlObj.searchParams.get("search") || "";
    const device = urlObj.searchParams.get("device") || "all";
    const status = urlObj.searchParams.get("status") || "all";
    const sortBy = urlObj.searchParams.get("sortBy") || "recent";
    const limit = parseInt(urlObj.searchParams.get("limit") || "50", 10);
    const page = parseInt(urlObj.searchParams.get("page") || "1", 10);

    const result = await analytics.getPlayers({ search, device, status, sortBy, limit, page });
    return sendJson(res, 200, result);
  }

  // 3. Track Traffic / Visitor Beacon (Android, Desktop, Other devices)
  if (reqUrl === "/api/analytics/track" && req.method === "POST") {
    const body = await parseBody(req);
    const result = analytics.trackVisit(body, req);
    return sendJson(res, 200, result);
  }

  // 4. Register New Player / Update Racer Account
  if (reqUrl === "/api/auth/register" && req.method === "POST") {
    const body = await parseBody(req);
    const result = analytics.registerPlayer(body, req);
    return sendJson(res, 200, result);
  }

  // 5. Export Analytics or Players Data (CSV / JSON)
  if (reqUrl === "/api/analytics/export" && req.method === "GET") {
    const format = urlObj.searchParams.get("format") || "csv";
    const type = urlObj.searchParams.get("type") || "players";
    const exported = analytics.exportData(format, type);

    const contentType = format === "json" ? "application/json" : "text/csv; charset=utf-8";
    const filename = `turbokart_${type}_${new Date().toISOString().split("T")[0]}.${format}`;

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Access-Control-Allow-Origin": "*"
    });
    return res.end(exported);
  }

  // Static files handling
  if (reqUrl === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  // Auto-track landing on /index.html
  if (reqUrl === "/index.html") {
    analytics.trackVisit({ page: "/" }, req);
  }

  const filePath = path.join(__dirname, reqUrl);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 Not Found");
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon"
    };

    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
});


// WebSocket Server for Multi-Room Realtime Battle Arena
const wss = new WebSocketServer({ server });

const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

class Room {
  constructor(code, hostId, maxPlayers = 6, matchDuration = 120, mapId = "stadium") {
    this.code = code;
    this.hostId = hostId;
    this.maxPlayers = maxPlayers;
    this.matchDuration = matchDuration;
    this.mapId = mapId;
    this.timer = matchDuration;
    this.inGame = false;
    this.players = new Map(); // id -> client
    this.mysteryBoxes = this.initMysteryBoxes();
    this.tickInterval = null;
  }

  initMysteryBoxes() {
    return [
      { id: 0, x: -16, z: -16, active: true },
      { id: 1, x: 16, z: -16, active: true },
      { id: 2, x: -16, z: 16, active: true },
      { id: 3, x: 16, z: 16, active: true },
      { id: 4, x: -44, z: -35, active: true },
      { id: 5, x: 44, z: -35, active: true },
      { id: 6, x: -44, z: 35, active: true },
      { id: 7, x: 44, z: 35, active: true }
    ];
  }

  broadcast(message, excludeId = null) {
    const raw = typeof message === "string" ? message : JSON.stringify(message);
    this.players.forEach((client, id) => {
      if (id !== excludeId && client.ws) {
        safeWsSend(client.ws, raw);
      }
    });
  }

  startMatch() {
    this.inGame = true;
    this.timer = this.matchDuration;

    // Automatic Arena Rotation every round
    const MAP_IDS = ["stadium", "canyon", "lava"];
    const curIdx = MAP_IDS.indexOf(this.mapId);
    this.mapId = MAP_IDS[(curIdx + 1) % MAP_IDS.length];

    // Reset players
    this.players.forEach(p => {
      p.hp = 100;
      p.smashes = 0;
      p.deaths = 0;
      p.score = 0;
    });

    this.broadcast({
      type: "MATCH_START",
      timer: this.timer,
      mapId: this.mapId,
      mysteryBoxes: this.mysteryBoxes
    });

    if (this.tickInterval) clearInterval(this.tickInterval);

    // 20Hz Tick Loop
    let lastTime = Date.now();
    this.tickInterval = setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      if (this.inGame) {
        this.timer -= dt;

        // Broadcast World State
        const playerStates = [];
        this.players.forEach((p, id) => {
          playerStates.push({
            id,
            name: p.name,
            color: p.color,
            hat: p.hat,
            chassis: p.chassis,
            wheels: p.wheels,
            trail: p.trail,
            x: p.x,
            y: p.y,
            z: p.z,
            rotationY: p.rotationY,
            speed: p.speed,
            steer: p.steer,
            drift: p.drift,
            nitro: p.nitro,
            hp: p.hp,
            smashes: p.smashes,
            deaths: p.deaths,
            score: p.score
          });
        });

        this.broadcast({
          type: "WORLD_TICK",
          timer: Math.max(0, Math.ceil(this.timer)),
          players: playerStates
        });

        if (this.timer <= 0) {
          this.endMatch();
        }
      }
    }, 50); // 20 updates per second
  }

  endMatch() {
    this.inGame = false;
    if (this.tickInterval) clearInterval(this.tickInterval);

    const rankings = Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      smashes: p.smashes,
      deaths: p.deaths,
      score: p.score
    })).sort((a, b) => b.smashes - a.smashes || b.score - a.score);

    this.broadcast({
      type: "MATCH_END",
      rankings
    });
  }
}

wss.on("connection", (ws) => {
  const clientId = "usr_" + Math.random().toString(36).substring(2, 9);
  let currentRoom = null;

  const client = {
    id: clientId,
    ws,
    name: "Racer",
    color: 0x10b981,
    hat: "crown",
    chassis: "standard",
    wheels: "slicks",
    trail: "flame",
    x: 0,
    y: 0,
    z: 0,
    rotationY: 0,
    speed: 0,
    steer: 0,
    drift: false,
    nitro: false,
    hp: 100,
    smashes: 0,
    deaths: 0,
    score: 0
  };

  safeWsSend(ws, { type: "WELCOME", clientId });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case "CREATE_ROOM": {
          let code = (msg.roomCode || generateRoomCode()).toUpperCase().trim();
          if (rooms.has(code)) {
            code = generateRoomCode();
          }
          const room = new Room(code, clientId, msg.maxPlayers || 6, msg.matchDuration || 120, msg.mapId || "stadium");
          rooms.set(code, room);
          currentRoom = room;

          Object.assign(client, msg.playerData || {});
          room.players.set(clientId, client);

          safeWsSend(ws, {
            type: "ROOM_JOINED",
            roomCode: code,
            isHost: true,
            mapId: room.mapId,
            maxPlayers: room.maxPlayers,
            players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, color: p.color }))
          });
          break;
        }

        case "CHANGE_MAP": {
          if (currentRoom && currentRoom.hostId === clientId) {
            currentRoom.mapId = msg.mapId || "stadium";
            currentRoom.broadcast({
              type: "MAP_CHANGED",
              mapId: currentRoom.mapId
            });
          }
          break;
        }

        case "JOIN_ROOM": {
          const code = (msg.roomCode || "").toUpperCase().trim();
          const room = rooms.get(code);
          if (!room) {
            return safeWsSend(ws, { type: "ERROR", message: "Room not found!" });
          }
          if (room.players.size >= room.maxPlayers) {
            return safeWsSend(ws, { type: "ERROR", message: "Room is full!" });
          }

          currentRoom = room;
          Object.assign(client, msg.playerData || {});
          room.players.set(clientId, client);

          safeWsSend(ws, {
            type: "ROOM_JOINED",
            roomCode: code,
            isHost: room.hostId === clientId,
            mapId: room.mapId,
            maxPlayers: room.maxPlayers,
            players: Array.from(room.players.values()).map(p => ({ id: p.id, name: p.name, color: p.color }))
          });

          room.broadcast({
            type: "PLAYER_JOINED",
            player: { id: client.id, name: client.name, color: client.color }
          }, clientId);
          break;
        }

        case "START_GAME": {
          if (currentRoom && currentRoom.hostId === clientId) {
            currentRoom.startMatch();
          }
          break;
        }

        case "UPDATE_POSITION": {
          if (currentRoom) {
            client.x = msg.x;
            client.y = msg.y;
            client.z = msg.z;
            client.rotationY = msg.rotationY;
            client.speed = msg.speed;
            client.steer = msg.steer;
            client.drift = msg.drift;
            client.nitro = msg.nitro;
          }
          break;
        }

        case "FIRE_WEAPON": {
          if (currentRoom) {
            currentRoom.broadcast({
              type: "REMOTE_FIRE",
              playerId: clientId,
              weaponId: msg.weaponId,
              origin: msg.origin,
              dir: msg.dir
            }, clientId);
          }
          break;
        }

        case "BOX_PICKED": {
          if (currentRoom) {
            currentRoom.broadcast({
              type: "BOX_COLLECTED",
              boxId: msg.boxId,
              byPlayer: clientId
            });
          }
          break;
        }

        case "PLAYER_SMASHED": {
          if (currentRoom) {
            const victim = currentRoom.players.get(msg.victimId);
            const killer = currentRoom.players.get(msg.killerId);
            if (victim) victim.deaths++;
            if (killer) {
              killer.smashes++;
              killer.score += 100;
            }

            currentRoom.broadcast({
              type: "KILLFEED_EVENT",
              killerName: killer ? killer.name : "Arena",
              victimName: victim ? victim.name : "Racer",
              weaponIcon: msg.weaponIcon || "💥"
            });
          }
          break;
        }

        case "PING": {
          safeWsSend(ws, { type: "PONG", timestamp: msg.timestamp });
          break;
        }
      }
    } catch (e) {
      console.error("Error handling message:", e);
    }
  });

  ws.on("close", () => {
    if (currentRoom) {
      currentRoom.players.delete(clientId);
      currentRoom.broadcast({ type: "PLAYER_LEFT", playerId: clientId });

      if (currentRoom.players.size === 0) {
        if (currentRoom.tickInterval) clearInterval(currentRoom.tickInterval);
        rooms.delete(currentRoom.code);
      } else if (currentRoom.hostId === clientId) {
        // Elect new host
        const nextHost = currentRoom.players.keys().next().value;
        currentRoom.hostId = nextHost;
        const newHostClient = currentRoom.players.get(nextHost);
        if (newHostClient && newHostClient.ws) {
          safeWsSend(newHostClient.ws, { type: "HOST_PROMOTED" });
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚗 Turbo Smash Karts 3D Server running!`);
  console.log(`🌐 Local URL: http://localhost:${PORT}`);
  console.log(`⚡ WebSocket ready on ws://localhost:${PORT}`);
  console.log(`===============================================`);
});

// ============================================================================
// 24/7 KEEP-ALIVE SYSTEM FOR RENDER / CLOUD HOSTING
// Automatically pings the server every 3.5 minutes to prevent Render free-tier sleep
// ============================================================================
const KEEP_ALIVE_URL = process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : "") ||
  "https://turbo-kart-7e0n.onrender.com";

function pingKeepAlive() {
  try {
    const pingTarget = `${KEEP_ALIVE_URL.replace(/\/$/, "")}/status`;
    const httpLib = pingTarget.startsWith("https") ? require("https") : require("http");
    const req = httpLib.get(pingTarget, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TurboKartKeepAlive/2.0",
        "Accept": "application/json"
      },
      timeout: 15000
    }, (res) => {
      console.log(`[KeepAlive] 24/7 Ping sent to ${pingTarget} - Status: ${res.statusCode}`);
      res.resume();
    });
    req.on("error", (err) => {
      console.log(`[KeepAlive] Ping notice: ${err.message}`);
    });
    req.on("timeout", () => {
      req.destroy();
    });
  } catch (e) {
    console.warn("[KeepAlive] Exception during ping:", e.message);
  }
}

// Initial warm-up ping 20 seconds after server launch
setTimeout(pingKeepAlive, 20000);

// Continuous recurring ping every 3.5 minutes (210,000 ms, well below Render's 15-minute sleep threshold)
setInterval(pingKeepAlive, 3.5 * 60 * 1000);

