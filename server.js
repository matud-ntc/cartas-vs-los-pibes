import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import os from "os";
import fs from "fs";
import { BLACK, WHITE } from "./cards.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5056;

const app = express();
app.use(express.static(join(__dirname, "public")));

const httpServer = createServer(app);
const io = new Server(httpServer);

const HAND_SIZE = 7;
const DEFAULT_TARGET = 5;

// rooms[code] = { code, hostId, players: Map, order: [], started, phase, ... }
// player = { id, name, socketId, connected, hand: [], score }
const rooms = new Map();

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newRoom(code, hostId) {
  return {
    code,
    hostId,
    players: new Map(),
    order: [],
    started: false,
    phase: "lobby", // lobby | play | judge | reveal | over
    target: DEFAULT_TARGET,
    judgeIdx: 0,
    blackDeck: [],
    whiteDeck: [],
    black: null, // { t, pick }
    subs: new Map(), // playerId -> [cards]
    reveal: [], // [{ pid, cards }] barajado, para juzgar/revelar
    lastResult: null, // { winnerId, winnerName, black, cards, all:[{name,cards}] }
  };
}

function drawWhite(room, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (room.whiteDeck.length === 0) room.whiteDeck = shuffle([...WHITE]);
    out.push(room.whiteDeck.pop());
  }
  return out;
}

function drawBlack(room) {
  if (room.blackDeck.length === 0) room.blackDeck = shuffle([...BLACK]);
  return room.blackDeck.pop();
}

function judgeId(room) {
  return room.order[room.judgeIdx % room.order.length];
}

function activePlayers(room) {
  // todos menos el juez
  return room.order.filter((pid) => pid !== judgeId(room));
}

function publicRoom(room) {
  const players = room.order.map((pid) => {
    const p = room.players.get(pid);
    return {
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      submitted: room.subs.has(pid),
    };
  });
  return {
    code: room.code,
    hostId: room.hostId,
    players,
    started: room.started,
    phase: room.phase,
    target: room.target,
    playerCount: players.length,
    judgeId: room.started ? judgeId(room) : null,
    black: room.black,
    submittedCount: room.subs.size,
    needCount: room.started ? activePlayers(room).length : 0,
  };
}

function broadcast(room) {
  io.to(room.code).emit("state", publicRoom(room));
}

function sendHand(room, player) {
  const sock = io.sockets.sockets.get(player.socketId);
  if (sock) sock.emit("hand", player.hand);
}

function sendReveal(room) {
  // durante "judge"/"reveal": mandar las combinaciones barajadas y anónimas
  io.to(room.code).emit("reveal", {
    phase: room.phase,
    black: room.black,
    subs: room.reveal.map((r, i) => ({ i, cards: r.cards })),
    result: room.phase === "reveal" ? room.lastResult : null,
  });
}

function findRoomByPlayer(playerId) {
  for (const room of rooms.values()) if (room.players.has(playerId)) return room;
  return null;
}

function startRound(room) {
  room.black = drawBlack(room);
  room.subs = new Map();
  room.reveal = [];
  room.lastResult = null;
  room.phase = "play";
  // rellenar manos a HAND_SIZE
  for (const pid of room.order) {
    const p = room.players.get(pid);
    while (p.hand.length < HAND_SIZE) p.hand.push(...drawWhite(room, 1));
    sendHand(room, p);
  }
  broadcast(room);
}

io.on("connection", (socket) => {
  socket.on("hello", ({ playerId }) => {
    if (!playerId) return;
    const room = findRoomByPlayer(playerId);
    if (!room) { socket.emit("noRoom"); return; }
    const player = room.players.get(playerId);
    player.socketId = socket.id;
    player.connected = true;
    socket.data.playerId = playerId;
    socket.data.roomCode = room.code;
    socket.join(room.code);
    socket.emit("joined", { code: room.code, playerId, isHost: room.hostId === playerId });
    broadcast(room);
    sendHand(room, player);
    if (room.phase === "judge" || room.phase === "reveal") sendReveal(room);
  });

  socket.on("createRoom", ({ playerId, name }) => {
    if (!playerId || !name) return;
    const code = genCode();
    const room = newRoom(code, playerId);
    room.players.set(playerId, { id: playerId, name: name.trim().slice(0, 20), socketId: socket.id, connected: true, hand: [], score: 0 });
    room.order.push(playerId);
    rooms.set(code, room);
    socket.data.playerId = playerId;
    socket.data.roomCode = code;
    socket.join(code);
    socket.emit("joined", { code, playerId, isHost: true });
    broadcast(room);
  });

  socket.on("joinRoom", ({ playerId, name, code }) => {
    if (!playerId || !name || !code) return;
    code = code.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) { socket.emit("errorMsg", "No existe una sala con ese código."); return; }
    if (room.started && !room.players.has(playerId)) {
      socket.emit("errorMsg", "La partida ya empezó. Esperá a que reinicien.");
      return;
    }
    if (!room.players.has(playerId)) {
      room.players.set(playerId, { id: playerId, name: name.trim().slice(0, 20), socketId: socket.id, connected: true, hand: [], score: 0 });
      room.order.push(playerId);
    } else {
      const p = room.players.get(playerId);
      p.name = name.trim().slice(0, 20);
      p.socketId = socket.id;
      p.connected = true;
    }
    socket.data.playerId = playerId;
    socket.data.roomCode = code;
    socket.join(code);
    socket.emit("joined", { code, playerId, isHost: room.hostId === playerId });
    broadcast(room);
    sendHand(room, room.players.get(playerId));
  });

  socket.on("setTarget", ({ target }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId || room.started) return;
    const v = parseInt(target, 10);
    room.target = isNaN(v) ? DEFAULT_TARGET : Math.min(20, Math.max(1, v));
    broadcast(room);
  });

  socket.on("startGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId) return;
    if (room.order.length < 3) { socket.emit("errorMsg", "Hacen falta al menos 3 jugadores."); return; }
    room.started = true;
    room.blackDeck = shuffle([...BLACK]);
    room.whiteDeck = shuffle([...WHITE]);
    room.judgeIdx = Math.floor(Math.random() * room.order.length);
    for (const pid of room.order) {
      const p = room.players.get(pid);
      p.hand = drawWhite(room, HAND_SIZE);
      p.score = 0;
    }
    startRound(room);
  });

  // Un jugador (no juez) juega sus cartas blancas
  socket.on("playCards", ({ cards }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "play") return;
    const pid = socket.data.playerId;
    if (pid === judgeId(room)) return; // el juez no juega
    if (room.subs.has(pid)) return; // ya jugó
    if (!Array.isArray(cards) || cards.length !== room.black.pick) return;
    const p = room.players.get(pid);
    // validar que tenga esas cartas
    const hand = [...p.hand];
    for (const c of cards) {
      const idx = hand.indexOf(c);
      if (idx === -1) return; // carta inválida
      hand.splice(idx, 1);
    }
    p.hand = hand;
    room.subs.set(pid, cards);
    sendHand(room, p);
    // ¿jugaron todos?
    if (room.subs.size >= activePlayers(room).length) {
      room.reveal = shuffle([...room.subs.entries()].map(([pid, cards]) => ({ pid, cards })));
      room.phase = "judge";
      broadcast(room);
      sendReveal(room);
    } else {
      broadcast(room);
    }
  });

  // El juez elige la combinación ganadora (por índice del reveal)
  socket.on("pickWinner", ({ i }) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "judge") return;
    if (socket.data.playerId !== judgeId(room)) return;
    const choice = room.reveal[i];
    if (!choice) return;
    const winner = room.players.get(choice.pid);
    if (winner) winner.score += 1;
    room.lastResult = {
      winnerId: choice.pid,
      winnerName: winner ? winner.name : "?",
      black: room.black,
      cards: choice.cards,
      all: room.reveal.map((r) => ({ name: room.players.get(r.pid)?.name || "?", cards: r.cards })),
    };
    room.phase = "reveal";
    // ¿ganó la partida?
    if (winner && winner.score >= room.target) {
      room.phase = "over";
      room.started = false;
      broadcast(room);
      io.to(room.code).emit("gameOver", {
        winnerId: winner.id,
        winnerName: winner.name,
        scores: room.order.map((pid) => ({ name: room.players.get(pid).name, score: room.players.get(pid).score })).sort((a, b) => b.score - a.score),
      });
      return;
    }
    broadcast(room);
    sendReveal(room);
  });

  // Siguiente ronda (juez o host)
  socket.on("nextRound", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.phase !== "reveal") return;
    if (socket.data.playerId !== judgeId(room) && socket.data.playerId !== room.hostId) return;
    room.judgeIdx = (room.judgeIdx + 1) % room.order.length;
    startRound(room);
  });

  socket.on("resetGame", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId) return;
    room.started = false;
    room.phase = "lobby";
    room.black = null;
    room.subs = new Map();
    room.reveal = [];
    room.lastResult = null;
    for (const pid of room.order) {
      const p = room.players.get(pid);
      p.hand = [];
      p.score = 0;
    }
    broadcast(room);
    for (const pid of room.order) sendHand(room, room.players.get(pid));
    io.to(room.code).emit("reset");
  });

  socket.on("leaveRoom", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    removePlayer(room, socket.data.playerId);
    socket.leave(room.code);
    socket.data.roomCode = null;
  });

  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.data.playerId);
    if (p) p.connected = false;
    broadcast(room);
  });
});

function removePlayer(room, playerId) {
  if (!room.players.has(playerId)) return;
  const wasStarted = room.started;
  room.players.delete(playerId);
  room.order = room.order.filter((id) => id !== playerId);
  room.subs.delete(playerId);
  if (room.order.length === 0) { rooms.delete(room.code); return; }
  if (room.hostId === playerId) room.hostId = room.order[0];
  if (room.judgeIdx >= room.order.length) room.judgeIdx = 0;
  // si jugaba y se va, reevaluar si ya jugaron todos
  if (wasStarted && room.phase === "play" && room.subs.size >= activePlayers(room).length && activePlayers(room).length > 0) {
    room.reveal = shuffle([...room.subs.entries()].map(([pid, cards]) => ({ pid, cards })));
    room.phase = "judge";
    broadcast(room);
    sendReveal(room);
    return;
  }
  broadcast(room);
}

// ---------- Persistencia: sobrevive a que la máquina se duerma ----------
const DATA_FILE = process.env.DATA_FILE || join(__dirname, "rooms.json");
function dumpRooms() {
  const out = {};
  for (const [code, r] of rooms) {
    out[code] = {
      code: r.code, hostId: r.hostId, order: r.order, started: r.started,
      phase: r.phase, target: r.target, judgeIdx: r.judgeIdx,
      blackDeck: r.blackDeck, whiteDeck: r.whiteDeck, black: r.black,
      reveal: r.reveal, lastResult: r.lastResult,
      players: [...r.players.values()].map((p) => ({ id: p.id, name: p.name, hand: p.hand, score: p.score })),
      subs: [...r.subs.entries()],
    };
  }
  return out;
}
function saveNow() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(dumpRooms())); } catch (e) {}
}
function loadRooms() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) { return; }
  for (const code in raw) {
    const r = raw[code];
    const room = newRoom(code, r.hostId);
    room.order = r.order || [];
    room.started = !!r.started;
    room.phase = r.phase || "lobby";
    room.target = r.target || DEFAULT_TARGET;
    room.judgeIdx = r.judgeIdx || 0;
    room.blackDeck = r.blackDeck || [];
    room.whiteDeck = r.whiteDeck || [];
    room.black = r.black || null;
    room.reveal = r.reveal || [];
    room.lastResult = r.lastResult || null;
    room.players = new Map();
    for (const p of r.players || []) room.players.set(p.id, { id: p.id, name: p.name, socketId: null, connected: false, hand: p.hand || [], score: p.score || 0 });
    room.subs = new Map(r.subs || []);
    rooms.set(code, room);
  }
  if (rooms.size) console.log(`Restauradas ${rooms.size} salas desde disco`);
}
loadRooms();
setInterval(saveNow, 3000);
process.on("SIGTERM", () => { saveNow(); process.exit(0); });
process.on("SIGINT", () => { saveNow(); process.exit(0); });

httpServer.listen(PORT, "0.0.0.0", () => {
  const nets = os.networkInterfaces();
  let lan = "localhost";
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) { lan = net.address; break; }
    }
  }
  console.log(`\n  Cartas vs los Pibes corriendo`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Red:     http://${lan}:${PORT}\n`);
});
