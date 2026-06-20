const $ = (id) => document.getElementById(id);
const socket = io();

// Identidad persistente
let playerId = localStorage.getItem("cvlp_pid");
if (!playerId) { playerId = "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("cvlp_pid", playerId); }

let me = { isHost: false, code: null };
let state = null;        // último "state" del server
let myHand = [];         // cartas blancas en mano
let selected = [];       // selección actual para jugar

function show(screenId) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(screenId).classList.add("active");
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function blackHtml(black) {
  if (!black) return "—";
  // resaltar los huecos
  return escapeHtml(black.t).replace(/_{2,}|___/g, '<span class="blank"></span>');
}

// ---------- Inicio ----------
$("input-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase(); });

$("btn-create").addEventListener("click", () => {
  const name = $("input-name").value.trim();
  if (!name) { $("home-error").textContent = "Poné tu nombre."; return; }
  socket.emit("createRoom", { playerId, name });
});
$("btn-join").addEventListener("click", () => {
  const name = $("input-name").value.trim();
  const code = $("input-code").value.trim().toUpperCase();
  if (!name) { $("home-error").textContent = "Poné tu nombre."; return; }
  if (code.length !== 4) { $("home-error").textContent = "El código tiene 4 letras."; return; }
  socket.emit("joinRoom", { playerId, name, code });
});

// ---------- Lobby ----------
$("btn-share").addEventListener("click", async () => {
  const url = `${location.origin}/?sala=${me.code}`;
  const text = `Entrá a la sala ${me.code} en Cartas vs los Pibes: ${url}`;
  try {
    if (navigator.share) await navigator.share({ title: "Cartas vs los Pibes", text, url });
    else { await navigator.clipboard.writeText(text); flash($("btn-share"), "Copiado"); }
  } catch (e) {}
});
function flash(btn, txt) { const o = btn.textContent; btn.textContent = txt; setTimeout(() => (btn.textContent = o), 1200); }

$("input-target").addEventListener("change", () => {
  let v = parseInt($("input-target").value, 10);
  if (isNaN(v)) v = 5;
  v = Math.min(20, Math.max(1, v));
  $("input-target").value = v;
  socket.emit("setTarget", { target: v });
});
$("btn-start").addEventListener("click", () => socket.emit("startGame"));
$("btn-leave").addEventListener("click", () => {
  socket.emit("leaveRoom");
  localStorage.removeItem("cvlp_room");
  show("screen-home");
});

// ---------- Juego: jugar cartas ----------
$("btn-play").addEventListener("click", () => {
  if (!state || state.phase !== "play") return;
  const need = state.black ? state.black.pick : 1;
  if (selected.length !== need) return;
  socket.emit("playCards", { cards: selected.slice() });
  selected = [];
});

// ---------- Modales ----------
$("btn-scores").addEventListener("click", () => { renderScores(); $("scores-modal").style.display = "flex"; });
$("btn-close-scores").addEventListener("click", () => ($("scores-modal").style.display = "none"));
$("btn-over-close").addEventListener("click", () => ($("over-modal").style.display = "none"));
$("btn-reset").addEventListener("click", () => socket.emit("resetGame"));
$("btn-next").addEventListener("click", () => socket.emit("nextRound"));

// ---------- Socket ----------
socket.on("connect", () => socket.emit("hello", { playerId }));
socket.on("noRoom", () => {
  const params = new URLSearchParams(location.search);
  const sala = params.get("sala");
  if (sala) $("input-code").value = sala.toUpperCase().slice(0, 4);
  show("screen-home");
});
socket.on("errorMsg", (msg) => {
  const el = $("screen-home").classList.contains("active") ? $("home-error") : $("lobby-error");
  el.textContent = msg;
});
socket.on("joined", ({ code, isHost }) => {
  me.code = code; me.isHost = isHost;
  $("room-code").textContent = code;
  $("home-error").textContent = "";
});

socket.on("hand", (hand) => { myHand = hand || []; selected = selected.filter((c) => myHand.includes(c)); renderHand(); });

socket.on("state", (s) => {
  state = s;
  me.isHost = s.hostId === playerId;
  document.querySelectorAll(".host-only").forEach((el) => (el.style.display = me.isHost ? "" : "none"));
  $("player-count").textContent = s.playerCount;

  if (!s.started && s.phase === "lobby") {
    renderLobby(s);
    show("screen-lobby");
  } else {
    renderGame(s);
    show("screen-game");
  }
});

socket.on("reveal", (data) => { if (state) renderGame(state, data); });
socket.on("gameOver", ({ winnerName, scores }) => {
  $("over-winner").textContent = winnerName;
  $("over-list").innerHTML = scores.map((x) => `<li><span>${escapeHtml(x.name)}</span><b>${x.score}</b></li>`).join("");
  $("over-modal").style.display = "flex";
});
socket.on("reset", () => { lastReveal = null; });

// ---------- Render: lobby ----------
function renderLobby(s) {
  const host = s.players.find((p) => p.id === s.hostId);
  $("host-name").textContent = host ? host.name : "Quien armó la sala";
  $("player-list").innerHTML = s.players.map((p) => {
    const tags = [];
    if (p.id === s.hostId) tags.push('<span class="tag">anfitrión</span>');
    if (!p.connected) tags.push('<span class="tag off">desconectado</span>');
    if (p.id === playerId) tags.push('<span class="tag you">vos</span>');
    return `<li><span class="pname">${escapeHtml(p.name)}</span>${tags.join("")}</li>`;
  }).join("");
  document.querySelectorAll(".no-host").forEach((el) => (el.style.display = me.isHost ? "none" : "block"));
  if (document.activeElement !== $("input-target")) $("input-target").value = s.target;
}

// ---------- Render: juego ----------
let lastReveal = null;
function renderGame(s, reveal) {
  if (reveal) lastReveal = reveal;
  const amJudge = s.judgeId === playerId;
  const judge = s.players.find((p) => p.id === s.judgeId);

  $("black-text").innerHTML = blackHtml(s.black);
  $("black-pick").style.display = s.black && s.black.pick > 1 ? "inline-block" : "none";

  $("round-role").textContent = amJudge ? "Sos el JUEZ" : `Juez: ${judge ? judge.name : "—"}`;
  $("round-role").classList.toggle("is-judge", amJudge);

  const judgeArea = $("judge-area");
  const resultArea = $("result-area");
  const handArea = $("hand-area");
  judgeArea.style.display = "none";
  resultArea.style.display = "none";
  handArea.style.display = "none";

  // host o juez ven el botón "siguiente"
  const canAdvance = amJudge || me.isHost;
  document.querySelectorAll(".host-judge-only").forEach((el) => (el.style.display = canAdvance ? "" : "none"));

  if (s.phase === "play") {
    if (amJudge) {
      $("game-status").textContent = `Esperando que jueguen los demás (${s.submittedCount}/${s.needCount})...`;
    } else {
      const already = s.players.find((p) => p.id === playerId)?.submitted;
      if (already) {
        $("game-status").textContent = `Listo. Esperando al resto (${s.submittedCount}/${s.needCount})...`;
      } else {
        const need = s.black ? s.black.pick : 1;
        $("game-status").textContent = need > 1 ? "Elegí 2 cartas (en orden) y jugalas." : "Elegí tu carta y jugala.";
        handArea.style.display = "block";
        renderHand();
      }
    }
  } else if (s.phase === "judge") {
    const subs = lastReveal ? lastReveal.subs : [];
    if (amJudge) {
      $("game-status").textContent = "Sos el juez: elegí la más graciosa.";
      judgeArea.style.display = "block";
      judgeArea.innerHTML = subs.map((sub) =>
        `<button class="combo" data-i="${sub.i}">${comboHtml(s.black, sub.cards)}</button>`
      ).join("");
      judgeArea.querySelectorAll(".combo").forEach((b) =>
        b.addEventListener("click", () => socket.emit("pickWinner", { i: parseInt(b.dataset.i, 10) }))
      );
    } else {
      $("game-status").textContent = `${judge ? judge.name : "El juez"} está eligiendo la ganadora...`;
      judgeArea.style.display = "block";
      judgeArea.innerHTML = subs.map((sub) => `<div class="combo combo-static">${comboHtml(s.black, sub.cards)}</div>`).join("");
    }
  } else if (s.phase === "reveal") {
    const r = lastReveal && lastReveal.result;
    $("game-status").textContent = "";
    resultArea.style.display = "block";
    if (r) {
      $("result-winner").textContent = r.winnerName;
      $("result-combo").innerHTML = comboHtml(r.black, r.cards);
    }
  }

  renderScores();
}

function comboHtml(black, cards) {
  if (!black) return "";
  let i = 0;
  const filled = escapeHtml(black.t).replace(/_{2,}|___/g, () => `<u>${escapeHtml(cards[i++] || "—")}</u>`);
  // si la negra es pregunta sin huecos, mostrar la respuesta abajo
  if (i === 0) return `<span class="combo-q">${filled}</span><span class="combo-a">${cards.map((c) => escapeHtml(c)).join(" / ")}</span>`;
  return filled;
}

function renderHand() {
  const need = state && state.black ? state.black.pick : 1;
  $("hand").innerHTML = myHand.map((c, idx) => {
    const order = selected.indexOf(c);
    const sel = order > -1 ? ` selected${need > 1 ? ` ord-${order + 1}` : ""}` : "";
    return `<button class="white-card${sel}" data-idx="${idx}">${need > 1 && order > -1 ? `<span class="ord">${order + 1}</span>` : ""}${escapeHtml(c)}</button>`;
  }).join("");
  $("hand").querySelectorAll(".white-card").forEach((b) => {
    b.addEventListener("click", () => {
      const card = myHand[parseInt(b.dataset.idx, 10)];
      const pos = selected.indexOf(card);
      if (pos > -1) selected.splice(pos, 1);
      else { if (selected.length >= need) selected.shift(); selected.push(card); }
      renderHand();
      $("btn-play").disabled = selected.length !== need;
    });
  });
  $("btn-play").disabled = selected.length !== need;
}

function renderScores() {
  if (!state) return;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const html = sorted.map((p) => {
    const t = [];
    if (p.id === state.judgeId) t.push('<span class="tag">juez</span>');
    if (p.id === playerId) t.push('<span class="tag you">vos</span>');
    if (!p.connected) t.push('<span class="tag off">off</span>');
    return `<li><span>${escapeHtml(p.name)} ${t.join("")}</span><b>${p.score}</b></li>`;
  }).join("");
  $("scores-list").innerHTML = html;
}

// Prefill código desde ?sala=
(() => {
  const sala = new URLSearchParams(location.search).get("sala");
  if (sala) $("input-code").value = sala.toUpperCase().slice(0, 4);
})();
