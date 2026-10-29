const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const SUPABASE_URL = "https://puewcrexmknonfzbggvx.supabase.co";
const SUPABASE_KEY = "sb_publishable_TCL8-_v6qzsbWRTrjZYYpw_OpuU-T1s";

const DATA_DIR = path.join(__dirname, "data");
const ANALYTICS_FILE = path.join(DATA_DIR, "analytics.json");
const PLAYERS_FILE = path.join(DATA_DIR, "players.json");

if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (e) {
    console.error("Failed to create data dir:", e);
  }
}

function fetchSupabaseProfiles() {
  return new Promise((resolve) => {
    const req = https.get(`${SUPABASE_URL}/rest/v1/profiles?select=*&order=created_at.desc`, {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            resolve([]);
          }
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
  });
}

// User-Agent parser to accurately classify Android, Desktop, and Other devices
function parseUserAgent(ua = "") {
  ua = String(ua || "");
  let deviceType = "Desktop";
  let os = "Unknown OS";
  let browser = "Unknown Browser";

  if (/Android/i.test(ua)) {
    deviceType = "Android";
    const verMatch = ua.match(/Android\s+([\d.]+)/i);
    os = verMatch ? `Android ${verMatch[1]}` : "Android";
  } else if (/iPad|iPhone|iPod/i.test(ua)) {
    deviceType = "Other";
    const verMatch = ua.match(/OS\s+([\d_]+)/i);
    os = verMatch ? `iOS ${verMatch[1].replace(/_/g, ".")}` : "iOS";
  } else if (/Windows NT/i.test(ua)) {
    deviceType = "Desktop";
    if (ua.includes("Windows NT 10.0")) os = "Windows 10/11";
    else if (ua.includes("Windows NT 6.3")) os = "Windows 8.1";
    else if (ua.includes("Windows NT 6.1")) os = "Windows 7";
    else os = "Windows";
  } else if (/Mac OS X/i.test(ua)) {
    deviceType = "Desktop";
    const verMatch = ua.match(/Mac OS X\s+([\d_]+)/i);
    os = verMatch ? `macOS ${verMatch[1].replace(/_/g, ".")}` : "macOS";
  } else if (/CrOS/i.test(ua)) {
    deviceType = "Other";
    os = "ChromeOS";
  } else if (/Linux/i.test(ua)) {
    deviceType = "Desktop";
    os = "Linux";
  } else if (/PlayStation|Nintendo|Xbox|SmartTV|Tizen|WebOS/i.test(ua)) {
    deviceType = "Other";
    os = "Console / TV";
  }

  if (/Edg\//i.test(ua)) browser = "Microsoft Edge";
  else if (/Chrome\//i.test(ua) && !/Edg/i.test(ua)) {
    browser = deviceType === "Android" ? "Chrome Mobile" : "Chrome";
  } else if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) {
    browser = deviceType === "Other" ? "Mobile Safari" : "Safari";
  } else if (/Firefox\//i.test(ua)) {
    browser = "Firefox";
  } else if (/SamsungBrowser/i.test(ua)) {
    browser = "Samsung Internet";
  } else if (/Opera|OPR\//i.test(ua)) {
    browser = "Opera";
  }

  return { deviceType, os, browser };
}

function hashIp(ip = "") {
  return crypto.createHash("sha256").update(String(ip || "127.0.0.1")).digest("hex").substring(0, 10);
}

class AnalyticsManager {
  constructor() {
    this.players = [];
    this.trafficLogs = [];
    this.activeSessions = new Map();
    this.recentEvents = [];
    this.dirty = false;

    this.loadData();

    setInterval(() => {
      const now = Date.now();
      let pruned = false;
      for (const [id, s] of this.activeSessions.entries()) {
        if (now - s.lastSeen > 35000) {
          this.activeSessions.delete(id);
          pruned = true;
        }
      }
      if (this.dirty) {
        this.saveData();
      }
    }, 10000);
  }

  loadData() {
    try {
      if (fs.existsSync(PLAYERS_FILE)) {
        const raw = fs.readFileSync(PLAYERS_FILE, "utf8");
        this.players = raw ? JSON.parse(raw) : [];
      } else {
        this.players = [];
      }
    } catch (e) {
      this.players = [];
    }

    try {
      if (fs.existsSync(ANALYTICS_FILE)) {
        const raw = fs.readFileSync(ANALYTICS_FILE, "utf8");
        const data = raw ? JSON.parse(raw) : {};
        this.trafficLogs = data.trafficLogs || [];
        this.recentEvents = data.recentEvents || [];
      } else {
        this.trafficLogs = [];
        this.recentEvents = [];
      }
    } catch (e) {
      this.trafficLogs = [];
      this.recentEvents = [];
    }
  }

  saveData() {
    try {
      fs.writeFileSync(PLAYERS_FILE, JSON.stringify(this.players, null, 2), "utf8");
      if (this.trafficLogs.length > 5000) {
        this.trafficLogs = this.trafficLogs.slice(-5000);
      }
      if (this.recentEvents.length > 100) {
        this.recentEvents = this.recentEvents.slice(-100);
      }
      fs.writeFileSync(ANALYTICS_FILE, JSON.stringify({
        trafficLogs: this.trafficLogs,
        recentEvents: this.recentEvents
      }, null, 2), "utf8");
      this.dirty = false;
    } catch (e) {
      console.error("[Analytics] Failed to save data:", e);
    }
  }

  trackVisit({ sessionId, page = "/", referrer = "", screen = "", inputType = "", deviceOverride = "", duration = 0 }, req) {
    const ip = req ? (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1") : "127.0.0.1";
    const ipH = hashIp(ip.split(",")[0].trim());
    const ua = req ? (req.headers["user-agent"] || "") : "";
    const parsed = parseUserAgent(ua);

    const deviceType = deviceOverride || parsed.deviceType;
    const now = Date.now();
    const sid = sessionId || "sess_" + Math.random().toString(36).substr(2, 9);

    const existingSession = this.activeSessions.get(sid);

    if (existingSession) {
      existingSession.lastSeen = now;
      if (duration && duration > 0) {
        const log = this.trafficLogs.find(l => l.sessionId === sid);
        if (log) log.durationSec = Math.max(log.durationSec || 0, Math.round(duration));
      }
    } else {
      const sessionObj = {
        sessionId: sid,
        lastSeen: now,
        ipHash: ipH,
        deviceType,
        os: parsed.os,
        browser: parsed.browser,
        screen: screen || "Unknown",
        referrer: referrer || "Direct",
        page
      };
      this.activeSessions.set(sid, sessionObj);

      const entry = {
        id: "trf_" + Math.random().toString(36).substr(2, 9),
        sessionId: sid,
        timestamp: new Date(now).toISOString(),
        ipHash: ipH,
        deviceType,
        os: parsed.os,
        browser: parsed.browser,
        screen: screen || "Unknown",
        referrer: referrer ? (referrer.replace(/^https?:\/\//, "").split("/")[0] || "Direct") : "Direct",
        page,
        durationSec: 1
      };
      this.trafficLogs.push(entry);

      this.recentEvents.unshift({
        type: "VISIT",
        text: `New ${deviceType} visitor arrived (${parsed.os} • ${parsed.browser})`,
        time: entry.timestamp,
        device: deviceType
      });

      this.dirty = true;
    }

    return {
      success: true,
      sessionId: sid,
      activeNow: this.activeSessions.size,
      detected: { deviceType, os: parsed.os, browser: parsed.browser }
    };
  }

  registerPlayer(data, req) {
    const ua = req ? (req.headers["user-agent"] || "") : "";
    const parsed = parseUserAgent(ua);

    const username = (data.username || "").trim();
    if (!username) {
      return { success: false, message: "Username is required" };
    }
    const email = (data.email || `${username.toLowerCase().replace(/[^a-z0-9]/g, "")}@turbokart.io`).trim();

    const existing = this.players.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      existing.lastActive = new Date().toISOString();
      existing.status = "online";
      if (data.kartColor || data.color) existing.kartColor = data.kartColor || data.color;
      if (data.chassis) existing.chassis = data.chassis;
      if (data.wheels) existing.wheels = data.wheels;
      if (data.hat) existing.hat = data.hat;
      if (data.coins !== undefined) existing.coins = data.coins;
      if (data.gems !== undefined) existing.gems = data.gems;
      if (data.level !== undefined) existing.level = data.level;
      if (data.matchesPlayed !== undefined) existing.matchesPlayed = Math.max(existing.matchesPlayed || 0, data.matchesPlayed);
      if (data.smashes !== undefined) existing.smashes = Math.max(existing.smashes || 0, data.smashes);
      if (data.score !== undefined) existing.score = Math.max(existing.score || 0, data.score);
      this.dirty = true;
      this.saveData();
      return { success: true, player: existing, isExisting: true };
    }

    const deviceType = data.deviceType || parsed.deviceType || "Desktop";
    const newPlayer = {
      id: "usr_" + Math.random().toString(36).substr(2, 8),
      username,
      email,
      deviceType,
      os: data.os || parsed.os,
      browser: data.browser || parsed.browser,
      coins: data.coins || 100,
      gems: data.gems || 25,
      level: data.level || 1,
      xp: data.xp || 0,
      matchesPlayed: data.matchesPlayed || 0,
      smashes: data.smashes || 0,
      score: data.score || 0,
      registeredAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      status: "online",
      kartColor: data.kartColor || data.color || 0xef4444,
      chassis: data.chassis || "standard",
      wheels: data.wheels || "slicks",
      hat: data.hat || "none"
    };

    this.players.unshift(newPlayer);

    this.recentEvents.unshift({
      type: "PLAYER_REGISTER",
      text: `Racer "${username}" registered profile (${deviceType})`,
      time: newPlayer.registeredAt,
      device: deviceType
    });

    this.dirty = true;
    this.saveData();

    return { success: true, player: newPlayer, isExisting: false };
  }

  async getPlayers({ search = "", device = "", status = "", limit = 50, page = 1, sortBy = "recent" }) {
    const sbProfiles = await fetchSupabaseProfiles();

    // Map Supabase profiles to dashboard format
    let list = sbProfiles.map(p => ({
      id: p.id,
      username: p.username,
      email: p.email || `${p.username.toLowerCase()}@turbokart.io`,
      deviceType: p.device_type || "Desktop",
      os: p.device_type === "Android" ? "Android" : "Desktop OS",
      browser: "Supabase Player",
      matchesPlayed: Number(p.matches_played || 0),
      smashes: Number(p.smashes || 0),
      score: Number(p.score || 0),
      coins: Number(p.coins || 100),
      gems: Number(p.gems || 25),
      level: Number(p.level || 1),
      registeredAt: p.created_at || new Date().toISOString(),
      lastActive: p.updated_at || p.created_at || new Date().toISOString(),
      status: "online",
      kartColor: p.kart_color || "#10b981",
      chassis: p.chassis || "standard",
      wheels: p.wheels || "slicks",
      hat: p.hat || "crown"
    }));

    // Merge any local registered players
    this.players.forEach(lp => {
      if (!list.some(p => p.username.toLowerCase() === lp.username.toLowerCase())) {
        list.push(lp);
      }
    });

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.username.toLowerCase().includes(q) ||
        (p.email && p.email.toLowerCase().includes(q)) ||
        p.id.toLowerCase().includes(q)
      );
    }

    if (device && device !== "all") {
      list = list.filter(p => (p.deviceType || "").toLowerCase() === device.toLowerCase());
    }

    if (status && status !== "all") {
      list = list.filter(p => (p.status || "").toLowerCase() === status.toLowerCase());
    }

    if (sortBy === "score") {
      list.sort((a, b) => (b.score || 0) - (a.score || 0));
    } else if (sortBy === "smashes") {
      list.sort((a, b) => (b.smashes || 0) - (a.smashes || 0));
    } else if (sortBy === "matches") {
      list.sort((a, b) => (b.matchesPlayed || 0) - (a.matchesPlayed || 0));
    } else {
      list.sort((a, b) => new Date(b.registeredAt) - new Date(a.registeredAt));
    }

    const total = list.length;
    const offset = (page - 1) * limit;
    const paginated = list.slice(offset, offset + limit);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
      players: paginated
    };
  }

  async getSummary(timeRange = "7d", roomsInfo = { activeRooms: 0, playersOnline: 0 }) {
    const now = Date.now();
    let cutoff = now - 7 * 86400000;
    let periodDuration = 7 * 86400000;

    if (timeRange === "24h" || timeRange === "today") {
      periodDuration = 24 * 3600000;
      cutoff = now - periodDuration;
    } else if (timeRange === "30d") {
      periodDuration = 30 * 86400000;
      cutoff = now - periodDuration;
    } else if (timeRange === "all") {
      periodDuration = 0;
      cutoff = 0;
    }

    const filteredLogs = cutoff === 0 
      ? [...this.trafficLogs] 
      : this.trafficLogs.filter(l => new Date(l.timestamp).getTime() >= cutoff);

    let priorVisits = 0;
    if (periodDuration > 0) {
      const priorCutoff = cutoff - periodDuration;
      priorVisits = this.trafficLogs.filter(l => {
        const t = new Date(l.timestamp).getTime();
        return t >= priorCutoff && t < cutoff;
      }).length;
    }

    const totalVisits = filteredLogs.length;
    let trendDeltaPct = null;
    if (priorVisits > 0) {
      trendDeltaPct = Math.round(((totalVisits - priorVisits) / priorVisits) * 100);
    }

    const uniqueIps = new Set();
    let androidCount = 0;
    let desktopCount = 0;
    let otherCount = 0;

    const osStats = {};
    const browserStats = {};
    const referrerStats = {};
    const screenStats = {};
    let totalDuration = 0;
    let bouncedCount = 0;

    filteredLogs.forEach(log => {
      uniqueIps.add(log.ipHash);
      if (log.deviceType === "Android") androidCount++;
      else if (log.deviceType === "Desktop") desktopCount++;
      else otherCount++;

      if (log.os) osStats[log.os] = (osStats[log.os] || 0) + 1;
      if (log.browser) browserStats[log.browser] = (browserStats[log.browser] || 0) + 1;
      const ref = log.referrer || "Direct";
      referrerStats[ref] = (referrerStats[ref] || 0) + 1;
      if (log.screen && log.screen !== "Unknown") {
        screenStats[log.screen] = (screenStats[log.screen] || 0) + 1;
      }

      const dur = log.durationSec || 0;
      totalDuration += dur;
      if (dur < 10) bouncedCount++;
    });

    let activeAndroid = 0;
    let activeDesktop = 0;
    let activeOther = 0;
    for (const s of this.activeSessions.values()) {
      if (s.deviceType === "Android") activeAndroid++;
      else if (s.deviceType === "Desktop") activeDesktop++;
      else activeOther++;
    }

    const activeNow = this.activeSessions.size + (roomsInfo.playersOnline || 0);
    const timeline = this.generateTimeline(filteredLogs, timeRange);

    // Fetch live Supabase registered players count and breakdown
    const sbProfiles = await fetchSupabaseProfiles();
    const allProfiles = [...sbProfiles];
    this.players.forEach(lp => {
      if (!allProfiles.some(p => (p.username || '').toLowerCase() === lp.username.toLowerCase())) {
        allProfiles.push({ ...lp, device_type: lp.deviceType, created_at: lp.registeredAt });
      }
    });

    let playersAndroid = 0;
    let playersDesktop = 0;
    let playersOther = 0;
    let playersToday = 0;
    const oneDayAgo = now - 86400000;

    allProfiles.forEach(p => {
      const dev = (p.device_type || p.deviceType || "Desktop").toLowerCase();
      if (dev === "android") playersAndroid++;
      else if (dev === "desktop") playersDesktop++;
      else playersOther++;

      const createdAt = new Date(p.created_at || p.registeredAt || 0).getTime();
      if (createdAt >= oneDayAgo) playersToday++;
    });

    const avgDurationSec = totalVisits > 0 ? Math.round(totalDuration / totalVisits) : 0;
    const bounceRate = totalVisits > 0 ? Math.round((bouncedCount / totalVisits) * 100) : 0;

    return {
      timeRange,
      kpis: {
        totalVisits,
        uniqueVisitors: uniqueIps.size,
        activeNow,
        activeBreakdown: {
          android: activeAndroid,
          desktop: activeDesktop,
          other: activeOther
        },
        registeredPlayersTotal: allProfiles.length,
        registeredToday: playersToday,
        activeRooms: roomsInfo.activeRooms || 0,
        playersInGame: roomsInfo.playersOnline || 0,
        trendDeltaPct
      },
      engagement: {
        avgDurationSec,
        bounceRate
      },
      devices: {
        android: {
          count: androidCount,
          pct: totalVisits > 0 ? Math.round((androidCount / totalVisits) * 100) : 0,
          registeredCount: playersAndroid
        },
        desktop: {
          count: desktopCount,
          pct: totalVisits > 0 ? Math.round((desktopCount / totalVisits) * 100) : 0,
          registeredCount: playersDesktop
        },
        other: {
          count: otherCount,
          pct: totalVisits > 0 ? Math.round((otherCount / totalVisits) * 100) : 0,
          registeredCount: playersOther
        }
      },
      osBreakdown: Object.entries(osStats)
        .map(([name, count]) => ({ name, count, pct: totalVisits > 0 ? Math.round((count / totalVisits) * 100) : 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      browserBreakdown: Object.entries(browserStats)
        .map(([name, count]) => ({ name, count, pct: totalVisits > 0 ? Math.round((count / totalVisits) * 100) : 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
      referrers: Object.entries(referrerStats)
        .map(([name, count]) => ({ name, count, pct: totalVisits > 0 ? Math.round((count / totalVisits) * 100) : 0 }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
      screens: Object.entries(screenStats)
        .map(([res, count]) => ({ res, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
      timeline,
      recentEvents: this.recentEvents.slice(0, 20)
    };
  }

  generateTimeline(logs, timeRange) {
    if (timeRange === "24h" || timeRange === "today") {
      const buckets = [];
      const now = new Date();
      for (let i = 23; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 3600000);
        const hourStr = d.getHours().toString().padStart(2, "0") + ":00";
        buckets.push({
          label: hourStr,
          timestamp: d.getTime(),
          visits: 0,
          android: 0,
          desktop: 0,
          other: 0
        });
      }

      logs.forEach(log => {
        const t = new Date(log.timestamp).getTime();
        const b = buckets.find(b => Math.abs(b.timestamp - t) < 1800000);
        if (b) {
          b.visits++;
          if (log.deviceType === "Android") b.android++;
          else if (log.deviceType === "Desktop") b.desktop++;
          else b.other++;
        }
      });
      return buckets;
    } else {
      const numDays = timeRange === "30d" ? 30 : (timeRange === "all" ? 14 : 7);
      const buckets = [];
      const now = new Date();
      for (let i = numDays - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const dayStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        const dayKey = d.toISOString().split("T")[0];
        buckets.push({
          label: dayStr,
          dayKey,
          visits: 0,
          android: 0,
          desktop: 0,
          other: 0
        });
      }

      logs.forEach(log => {
        const dayKey = (log.timestamp || "").split("T")[0];
        const b = buckets.find(b => b.dayKey === dayKey);
        if (b) {
          b.visits++;
          if (log.deviceType === "Android") b.android++;
          else if (log.deviceType === "Desktop") b.desktop++;
          else b.other++;
        }
      });
      return buckets;
    }
  }

  exportData(format = "csv", type = "players") {
    if (type === "players") {
      if (format === "json") return JSON.stringify(this.players, null, 2);
      const headers = ["ID", "Username", "Email", "DeviceType", "OS", "Browser", "Matches", "Smashes", "Score", "Coins", "Gems", "Level", "RegisteredAt", "LastActive", "Status"];
      const rows = this.players.map(p => [
        p.id,
        `"${(p.username || '').replace(/"/g, '""')}"`,
        `"${(p.email || '').replace(/"/g, '""')}"`,
        p.deviceType || 'Desktop',
        `"${(p.os || '').replace(/"/g, '""')}"`,
        `"${(p.browser || '').replace(/"/g, '""')}"`,
        p.matchesPlayed || 0,
        p.smashes || 0,
        p.score || 0,
        p.coins || 100,
        p.gems || 25,
        p.level || 1,
        p.registeredAt || '',
        p.lastActive || '',
        p.status || 'offline'
      ]);
      return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    } else {
      if (format === "json") return JSON.stringify(this.trafficLogs, null, 2);
      const headers = ["ID", "Timestamp", "IPHash", "DeviceType", "OS", "Browser", "Screen", "Referrer", "Page", "DurationSec"];
      const rows = this.trafficLogs.map(t => [
        t.id,
        t.timestamp,
        t.ipHash,
        t.deviceType,
        `"${(t.os || '').replace(/"/g, '""')}"`,
        `"${(t.browser || '').replace(/"/g, '""')}"`,
        t.screen || '',
        `"${(t.referrer || '').replace(/"/g, '""')}"`,
        t.page,
        t.durationSec || 0
      ]);
      return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    }
  }
}

module.exports = new AnalyticsManager();
