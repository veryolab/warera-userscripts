// ==UserScript==
// @name         WarEra Batalhas HUD
// @namespace    local.warera.batalhas-hud
// @version      0.14.0
// @description  Força dos lados e PREVISÃO num glance, dentro dos cartões da lista de batalhas (torneio, guerra e resistência). Read-only.
// @match        https://app.warera.io/*
// @connect      api2.warera.io
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraBatalhasHUD.user.js
// @downloadURL  https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraBatalhasHUD.user.js
// ==/UserScript==

/*
  Objetivo: num glance no cartão da batalha saber QUEM É O FAVORITO e porquê.
  Cada cartão ganha 2 linhas:
    linha 1: ⚔ lutadores nesta batalha · dano semanal do lado (MU ou país) + tier · 👑 carry >50%
    linha 2: barra de previsão com % de cada lado + estado da série (ex.: 1–1·R3)
  Tooltip nativo (hover) com a decomposição factual da previsão.

  Tipos de batalha (todos com a mesma mecânica: best-of, rounds = corrida até 300 pontos):
    - tournament: MU vs MU. Força de papel = mu.rankings.muWeeklyDamages.
      MU de cada lado: avatares do cartão (…/avatars/mu/mu-<id>-…) — 0 chamadas; se faltarem
      (avatar por defeito), fallback battleRanking type:'mu' por lado (battle.muOrders NÃO serve,
      vem muitas vezes vazio).
    - war/resistance: país vs país. Força de papel = country.rankings.weeklyCountryDamages
      (getAllCountries, 1 chamada cacheada 6h). Países vêm de battle.attacker/defender.country.
  Lado ESQUERDO do cartão = DEFENSOR (verificado em torneio: barra 37.4K = defenderDamages;
  assumido igual p/ guerra — mesma componente de UI).

  API gentil: só batalhas presentes no DOM, prioridade às visíveis no viewport, orçamento de
  ~60 chamadas por ciclo (o resto continua 15s depois), TTLs por tipo de dado, pausa com o
  separador escondido.

  Previsão (factual, sem magia):
    pRound = mistura de [share de dano nesta batalha] com [share de dano semanal]
             (peso do observado cresce com o volume já batido).
    round atual: share de pontos com pseudo-contagens (início ≈ pRound, fim ≈ placar).
    série (best-of): binomial recursiva com pRound; o round em curso usa pCur.
*/
(() => {
  "use strict";

  // o jogo faz failover entre vários hosts de API (api2–api5) — fazemos o mesmo:
  // em erro de REDE/5xx tentamos o host seguinte e fixamos o que funcionar
  const HOSTS = ["https://api2.warera.io", "https://api3.warera.io", "https://api4.warera.io", "https://api5.warera.io"];
  const LS = { mu: "wbs.mu", geo: "wbs.geo", scout: "wbs.scout" };
  const TTL = { live: 2 * 60e3, info: 5 * 60e3, rank: 5 * 60e3, mu: 60 * 60e3, geo: 6 * 3600e3 };
  const SCAN_MS = 5e3;          // re-aplicar chips (SPA re-render)
  const REFRESH_MS = 2 * 60e3;  // ciclo de dados
  const MAX_CARDS = 120;        // salvaguarda absurda; o travão real é o BUDGET
  const BUDGET = 60;            // máx. chamadas à API por ciclo (o resto continua 15s depois)

  // ---------- API de sessão (padrão dos outros HUDs) ----------
  const TICK_MS = 2 * 60e3;      // pontos de round avancam de 2 em 2 min (ticksCount da API)
  const ROUND_POINTS = 300;
  const TICK_POINTS = [[1, 1], [100, 2], [200, 3], [300, 4], [400, 5], [500, 6]];

  const readCookie = (name) => {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  };
  let hostI = 0;
  async function trpc(path, input) {
    const qs = `?input=${encodeURIComponent(JSON.stringify(input ?? {}))}`;
    let lastErr;
    for (let t = 0; t < HOSTS.length; t++) {
      const i = (hostI + t) % HOSTS.length;
      try {
        const res = await fetch(`${HOSTS[i]}/trpc/${path}${qs}`, {
          method: "GET", credentials: "include",
          headers: { "x-vid": readCookie("vid") || "", "x-gr": readCookie("gr") || "" },
        });
        if (res.status >= 500) throw new Error(`${path}: HTTP ${res.status}`); // servidor em baixo → roda
        hostI = i; // host bom: fica para os próximos pedidos
        if (!res.ok) throw { final: new Error(`${path}: HTTP ${res.status}`) }; // 4xx = erro nosso, não rodar
        const body = await res.json();
        if (body && body.error) throw { final: new Error(body.error.message || path) };
        return body && body.result ? body.result.data : body;
      } catch (e) {
        if (e && e.final) throw e.final;
        lastErr = e; // erro de rede/CORS/5xx → tenta o próximo host
      }
    }
    throw lastErr || new Error(path);
  }
  const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---------- estado ----------
  const S = {
    mu: load(LS.mu, {}),    // muId → {at, name, members, weekly, tier}
    geo: load(LS.geo, null),// {at, byId:{countryId:{name, weekly, tier, activePop}}}
    batt: {},               // battleId → {info, live, rank, type, sideMU, sDef, sAtk}
    scout: load(LS.scout, {}), // muId → {at, n, total, on24, on72, avgLv, topName, topWk} (cache 1h)
    lite: {},               // userId → {at, d} (getUserLite, só em memória)
    busy: false, calls: 0, moreT: 0,
    view: null,             // scout aberto: {bid, phase, done, weapons, sides:[…]}
  };

  // ---------- helpers ----------
  const fmt = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(Math.round(n || 0));
  const MEDAL = { bronze: "🥉", silver: "🥈", gold: "🥇", platinum: "💠", diamond: "💎", master: "🏆" };
  const PRIO = { high: ["alta", 15], medium: ["média", 10], low: ["baixa", 5] }; // bónus de ordem (calibrado)
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- previsão ----------
  // P(lado A ganha a série) — A precisa de needA rounds, B de needB; round em curso com pCur.
  function seriesProb(pRound, needA, needB, pCur) {
    const memo = {};
    const P = (a, b) => {
      if (a <= 0) return 1;
      if (b <= 0) return 0;
      const k = a + "," + b;
      if (!(k in memo)) memo[k] = pRound * P(a - 1, b) + (1 - pRound) * P(a, b - 1);
      return memo[k];
    };
    return pCur * P(needA - 1, needB) + (1 - pCur) * P(needA, needB - 1);
  }
  // P(A ganha uma corrida: precisa de needA ticks antes de B somar needB), tick ganho por A c/ prob q.
  // DP iterativa (needs podem ser ~300 → nada de recursão).
  function raceProb(q, needA, needB) {
    let prev = new Float64Array(needB + 1).fill(1); // a=0 → A já ganhou
    for (let a = 1; a <= needA; a++) {
      const cur = new Float64Array(needB + 1);
      cur[0] = 0; // b=0 → B ganhou
      for (let bb = 1; bb <= needB; bb++) cur[bb] = q * prev[bb] + (1 - q) * cur[bb - 1];
      prev = cur;
    }
    return prev[needB];
  }
  // previsão para o DEFENSOR (lado esquerdo do cartão)
  function predict(b) {
    const info = b.info?.d, live = b.live?.d;
    if (!info) return null;
    const hist = live?.battle?.roundHistory || info.roundsHistory || [];
    const wonD = hist.filter((r) => r.wonBy === "defender").length;
    const wonA = hist.filter((r) => r.wonBy === "attacker").length;
    const toWin = info.roundsToWin || 2;
    if (!info.isActive || wonD >= toWin || wonA >= toWin)
      return { done: true, winner: wonD >= toWin ? "def" : "atk", wonD, wonA, toWin };

    // 1) força de papel: dano semanal (MU ou país)
    const wD = b.sDef?.weekly || 0, wA = b.sAtk?.weekly || 0;
    const weeklyShare = wD + wA > 0 ? wD / (wD + wA) : 0.5;
    // 2) o que se passou NESTA batalha (rounds fechados)
    let dD = 0, dA = 0;
    for (const r of hist) { dD += r.defenderDamages || 0; dA += r.attackerDamages || 0; }
    const battShare = dD + dA > 0 ? dD / (dD + dA) : weeklyShare;
    const w = clamp((dD + dA) / 150e3, 0, 0.8); // peso do observado cresce com o volume
    const pRound = clamp(w * battShare + (1 - w) * weeklyShare, 0.05, 0.95);
    // 3) round em curso = CORRIDA REAL até 300 pontos. Os pontos já marcados são "banco"
    //    (dizem quanto falta a cada lado), mas quem ganha os ticks FUTUROS é quem está a
    //    bater AGORA → prob. de ganhar um tick vem do DANO DO ROUND ao vivo (não do placar).
    //    (corrige o caso visto no jogo: placar 6–85 mas dano do round 932K–524K — o placar
    //     é história, o dano é o que vem aí)
    const rd = live?.round;
    let pCur = pRound, ptsD = 0, ptsA = 0, rdD = 0, rdA = 0;
    if (rd && rd.isActive) {
      ptsD = rd.defenderPoints || 0; ptsA = rd.attackerPoints || 0;
      rdD = rd.defenderDamages || 0; rdA = rd.attackerDamages || 0;
      const roundShare = rdD + rdA > 0 ? rdD / (rdD + rdA) : pRound;
      const wq = clamp((rdD + rdA) / 100e3, 0, 0.85); // confiança no dano do round cresce com o volume
      const q = clamp(wq * roundShare + (1 - wq) * pRound, 0.03, 0.97); // P(defensor ganha um tick futuro)
      const tick = rd.actualTickPoints || 1;
      const needD = Math.max(1, Math.ceil((300 - ptsD) / tick));
      const needA = Math.max(1, Math.ceil((300 - ptsA) / tick));
      // o ritmo de dano NÃO é fixo (bursts, gente a entrar/sair) — sem isto a corrida
      // fica confiante demais (99%+). Mistura de 3 cenários: ritmo observado ± incerteza.
      const s = 1.5 * Math.sqrt(q * (1 - q) / 30); // ~30 'ticks efetivos' de evidência
      pCur = 0.25 * raceProb(clamp(q - s, 0.03, 0.97), needD, needA)
           + 0.5 * raceProb(q, needD, needA)
           + 0.25 * raceProb(clamp(q + s, 0.03, 0.97), needD, needA);
    }
    const pDef = seriesProb(pRound, toWin - wonD, toWin - wonA, pCur);
    return { done: false, pDef, pRound, pCur, dD, dA, wonD, wonA, toWin, ptsD, ptsA, rdD, rdA, roundN: hist.length + 1 };
  }

  // ---------- "HOT": ritmo REAL de dano agora (Δdano entre duas amostras live) ----------
  // acumulado engana (27M podem estar mortos, 200K ao rubro) — o que interessa é o AGORA.
  const liveCum = (lv) => {
    if (!lv?.d) return null;
    let t = 0;
    for (const r of lv.d.battle?.roundHistory || []) t += (r.defenderDamages || 0) + (r.attackerDamages || 0);
    t += (lv.d.round?.defenderDamages || 0) + (lv.d.round?.attackerDamages || 0);
    return t;
  };
  function heatRate(b) { // dano/minuto (ambos os lados) ou null se ainda só há 1 amostra
    const a = b.prevLive, c = b.live;
    if (!a || !c) return null;
    const dt = (c.at - a.at) / 60e3;
    if (dt < 0.5) return null;
    const d = liveCum(c) - liveCum(a);
    return d >= 0 ? d / dt : null; // round pode ter rodado entre amostras → delta negativo = ignora
  }
  const HEAT = [100, 1e3, 5e3, 25e3]; // dano/min: ❄️ <100 · — · 🔥 · 🔥🔥 · 🔥🔥🔥
  const heatIcon = (r) => r == null ? "" : r < HEAT[0] ? "❄️" : r < HEAT[1] ? "" : r < HEAT[2] ? "🔥" : r < HEAT[3] ? "🔥🔥" : "🔥🔥🔥";

  // ---------- tempo na barra: inicio + fim estimado transparente ----------
  const dateMs = (v) => {
    if (!v) return 0;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const firstDate = (...xs) => xs.map(dateMs).find((x) => x > 0) || 0;
  const fmtClock = (ms) => new Date(ms).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  const fmtDur = (ms) => {
    if (!Number.isFinite(ms) || ms < 0) return "?";
    const m = Math.max(1, Math.round(ms / 60000));
    if (m < 90) return `${m}m`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `${h}h${String(r).padStart(2, "0")}` : `${h}h`;
  };
  function battleStartMs(b) {
    const info = b.info?.d, hist = b.live?.d?.battle?.roundHistory || info?.roundsHistory || [];
    return firstDate(info?.startedAt, info?.startsAt, info?.startAt, info?.createdAt,
      hist[0]?.startedAt, hist[0]?.startsAt, hist[0]?.createdAt);
  }
  function avgClosedRoundMs(b) {
    const info = b.info?.d, hist = b.live?.d?.battle?.roundHistory || info?.roundsHistory || [];
    const ds = [];
    for (const r of hist) {
      const s = firstDate(r.startedAt, r.startsAt, r.startAt, r.createdAt);
      const e = firstDate(r.endedAt, r.endsAt, r.endAt, r.updatedAt);
      if (s && e && e > s) ds.push(e - s);
    }
    if (!ds.length) return 0;
    ds.sort((a, b) => a - b);
    return ds[Math.floor(ds.length / 2)];
  }
  function tickValueAt(points) {
    let v = TICK_POINTS[0][1];
    for (const [min, val] of TICK_POINTS) {
      if (points >= min) v = val;
      else break;
    }
    return v;
  }
  function ticksForSideToWin(sidePoints, otherPoints) {
    let pts = Math.max(0, Number(sidePoints || 0));
    let total = pts + Math.max(0, Number(otherPoints || 0));
    let ticks = 0;
    while (pts < ROUND_POINTS && ticks < 1000) {
      const val = tickValueAt(total);
      const next = TICK_POINTS.find(([min]) => min > total)?.[0] || ROUND_POINTS;
      const target = Math.min(next, ROUND_POINTS);
      const step = Math.max(1, Math.ceil(Math.min(target - total, ROUND_POINTS - pts) / val));
      ticks += step;
      pts += step * val;
      total += step * val;
    }
    return ticks;
  }
  function currentRoundEtaMs(b, p, side) {
    const rd = b.live?.d?.round;
    if (!rd || !rd.isActive) return 0;
    const ownPts = side === "def" ? p.ptsD || 0 : p.ptsA || 0;
    const otherPts = side === "def" ? p.ptsA || 0 : p.ptsD || 0;
    const ticks = ticksForSideToWin(ownPts, otherPts);
    if (!ticks) return 0;
    const next = dateMs(rd.nextTickAt);
    if (next) {
      const wait = ((next - Date.now()) % TICK_MS + TICK_MS) % TICK_MS;
      return Math.max(1000, wait) + Math.max(0, ticks - 1) * TICK_MS;
    }
    const nowPts = Math.max(p.ptsD || 0, p.ptsA || 0);
    const remain = Math.max(0, ROUND_POINTS - nowPts);
    if (!remain) return 0;
    const prev = b.prevLive?.d?.round;
    if (prev) {
      const prevPts = Math.max(prev.defenderPoints || 0, prev.attackerPoints || 0);
      const dt = b.live.at - b.prevLive.at;
      const dp = nowPts - prevPts;
      if (dt > 30e3 && dp > 0) return remain / (dp / dt);
    }
    const st = firstDate(rd.startedAt, rd.startsAt, rd.startAt, rd.createdAt);
    if (st && nowPts > 0) {
      const elapsed = Date.now() - st;
      if (elapsed > 30e3) return remain / (nowPts / elapsed);
    }
    return 0;
  }
  function expectedRounds(pRound, needD, needA) {
    const memo = {};
    const E = (a, b) => {
      if (a <= 0 || b <= 0) return 0;
      const k = a + "," + b;
      if (!(k in memo)) memo[k] = 1 + pRound * E(a - 1, b) + (1 - pRound) * E(a, b - 1);
      return memo[k];
    };
    return E(needD, needA);
  }
  function battleEta(b, p) {
    if (!p || p.done) return null;
    const curDef = currentRoundEtaMs(b, p, "def");
    const curAtk = currentRoundEtaMs(b, p, "atk");
    if (!curDef && !curAtk) return null;
    const fullRound = avgClosedRoundMs(b) || ticksForSideToWin(0, 0) * TICK_MS;
    const after = (side) => {
      const wonD = p.wonD + (side === "def" ? 1 : 0);
      const wonA = p.wonA + (side === "atk" ? 1 : 0);
      if (wonD >= p.toWin || wonA >= p.toWin) return 0;
      return expectedRounds(p.pRound, p.toWin - wonD, p.toWin - wonA) * fullRound;
    };
    const defMs = curDef ? curDef + after("def") : 0;
    const atkMs = curAtk ? curAtk + after("atk") : 0;
    const q = clamp(p.pCur ?? p.pDef ?? 0.5, 0, 1);
    const ms = defMs && atkMs ? q * defMs + (1 - q) * atkMs : (defMs || atkMs);
    return { ms, defMs, atkMs, q };
  }
  function timeBarHtml(b, p) {
    const st = battleStartMs(b);
    const eta = battleEta(b, p);
    if (!st && !eta) return "";
    const left = st ? fmtClock(st) : "";
    let right = "fim ?";
    if (eta) {
      const end = (ms) => fmtClock(Date.now() + ms);
      const lo = Math.min(eta.defMs || eta.atkMs, eta.atkMs || eta.defMs);
      const hi = Math.max(eta.defMs || eta.atkMs, eta.atkMs || eta.defMs);
      right = hi - lo >= 5 * 60e3 ? `${end(lo)}-${end(hi)}` : end(eta.ms);
    }
    return `<span class="wbs-time">${left}${left ? " | " : ""}${right}</span>`;
  }

  // ---------- fetch (gentil: orçamento por ciclo, TTLs, sequencial) ----------
  const fresh = (slot, ttl) => slot && Date.now() - slot.at < ttl;
  const take = (n) => { if (S.calls + n > BUDGET) return false; S.calls += n; return true; };

  // quem sou eu (país + MU) — 1× por sessão, p/ detetar AS MINHAS ordens nas batalhas
  async function ensureMe() {
    if (S.me || S.meFail) return;
    try {
      const me = await trpc("user.getMe", {});
      const u = me?._id ? await trpc("user.getUserLite", { userId: me._id }) : null;
      if (!u) { S.meFail = true; return; }
      S.me = { c: u.country || null, mu: u.mu || null }; // país + MU p/ detetar AS MINHAS ordens
    } catch { S.meFail = true; }
  }

  async function ensureGeo() {
    if (fresh(S.geo, TTL.geo) && S.geo.v === 2) return true;
    if (!take(1)) return false;
    const cs = await trpc("country.getAllCountries", {}).catch(() => null);
    if (!cs) return false;
    const byId = {};
    for (const c of cs) byId[c._id] = {
      name: c.name || "?",
      code: (c.code || "").toLowerCase(), // p/ a bandeira: /images/flags/<code>.svg
      weekly: c.rankings?.weeklyCountryDamages?.value || 0,
      tier: c.rankings?.weeklyCountryDamages?.tier || "",
      activePop: c.rankings?.countryActivePopulation?.value || 0,
    };
    S.geo = { at: Date.now(), v: 2, byId };
    save(LS.geo, S.geo);
    return true;
  }
  // ranking GERAL dinâmico da MU = média ponderada dos ranks globais das métricas relevantes
  // (dano semanal pesa mais = força ATUAL; dano total = história; riqueza/terreno = músculo económico)
  const RANK_METRICS = [
    ["muWeeklyDamages", "dano semanal", 3],
    ["muDamages", "dano total", 1],
    ["muWealth", "riqueza", 1],
    ["muTerrain", "terreno", 1],
  ];
  async function ensureMu(muId) {
    if (fresh(S.mu[muId], TTL.mu) && S.mu[muId].ranks && "av" in S.mu[muId]) return true;
    if (!take(1)) return false;
    const mu = await trpc("mu.getById", { muId }).catch(() => null);
    if (!mu) return false;
    const wk = mu.rankings?.muWeeklyDamages;
    const ranks = [];
    let sum = 0, wsum = 0;
    for (const [key, label, w] of RANK_METRICS) {
      const r = mu.rankings?.[key];
      if (!r || !r.rank) continue;
      ranks.push({ label, rank: r.rank, tier: r.tier || "", w });
      sum += r.rank * w; wsum += w;
    }
    // construções (só as ATIVAS vêm em activeUpgradeLevels): QG +5%/nível de ataque em
    // batalha, dormitórios = capacidade 5/nível (verificado no gameConfig 2026-07-04).
    // O QG NÃO entra na previsão — o dano semanal observado JÁ inclui o bónus (dupla contagem).
    const hq = mu.activeUpgradeLevels?.headquarters || 0;
    const dorm = mu.activeUpgradeLevels?.dormitories || 0;
    S.mu[muId] = {
      at: Date.now(), name: mu.name || "?", country: mu.country || null,
      av: mu.avatarUrl || "", members: (mu.members || []).length,
      weekly: wk?.value || 0, tier: wk?.tier || "",
      overall: wsum ? Math.round(sum / wsum) : 0, ranks,
      hq, cap: dorm * 5,
    };
    save(LS.mu, S.mu);
    return true;
  }

  // devolve false se ficou trabalho por fazer (orçamento esgotado)
  async function fetchBattle(id, musHint) {
    const b = (S.batt[id] = S.batt[id] || {});
    if (!fresh(b.info, TTL.info)) {
      if (!take(1)) return false;
      const d = await trpc("battle.getById", { battleId: id }).catch(() => null);
      if (d) b.info = { at: Date.now(), d };
    }
    const info = b.info?.d;
    if (!info) return true; // sem info não há mais nada a fazer
    b.type = info.type || "war";

    if (b.type === "tournament") {
      // MU de cada lado: avatares do cartão; fallback ranking type:'mu' (muOrders não é fiável)
      if (!b.sideMU) {
        if (musHint && musHint.length === 2 && musHint[0] !== musHint[1]) b.sideMU = musHint;
        else {
          if (!take(2)) return false;
          const muOf = async (side) => {
            const r = await trpc("battleRanking.getRanking", { battleId: id, dataType: "damage", side, type: "mu", limit: 1 }).catch(() => null);
            return (r?.items || r || [])[0]?.mu || null;
          };
          const [md, ma] = [await muOf("defender"), await muOf("attacker")];
          if (md && ma) b.sideMU = [md, ma];
        }
      }
      if (b.sideMU) {
        if (!(await ensureMu(b.sideMU[0])) || !(await ensureMu(b.sideMU[1]))) return false;
        if (!(await ensureGeo())) return false; // p/ mapear country da MU → bandeira/nome
        const m0 = S.mu[b.sideMU[0]], m1 = S.mu[b.sideMU[1]];
        const side = (m) => {
          const ci = m.country ? S.geo.byId[m.country] : null;
          return { ...m, flag: ci?.code || "", sub: `${m.members} membros${ci ? ", " + ci.name : ""}` };
        };
        b.sDef = m0 && side(m0);
        b.sAtk = m1 && side(m1);
      }
    } else {
      if (!(await ensureGeo())) return false;
      const c0 = S.geo.byId[info.defender?.country], c1 = S.geo.byId[info.attacker?.country];
      b.sDef = c0 && { ...c0, sub: `${c0.activePop} ativos` };
      b.sAtk = c1 && { ...c1, sub: `${c1.activePop} ativos` };
    }

    if (info.isActive && !fresh(b.live, TTL.live)) {
      if (!take(1)) return false;
      const d = await trpc("battle.getLiveBattleData", { battleId: id }).catch(() => null);
      if (d) { if (b.live) b.prevLive = b.live; b.live = { at: Date.now(), d }; } // prev → ritmo (hot)
    }
    if (info.isActive && !fresh(b.rank, TTL.rank)) {
      const isWar = b.type !== "tournament";
      if (!take(isWar ? 4 : 2)) return false;
      const side = async (s) => {
        const r = await trpc("battleRanking.getRanking", { battleId: id, dataType: "damage", side: s, type: "user", limit: 100 }).catch(() => null);
        const items = r?.items || (Array.isArray(r) ? r : []);
        const tot = items.reduce((x, i) => x + (i.value || 0), 0);
        // n é TETO quando bate no limit do pedido (guerras grandes têm mais de 100)
        return { n: items.length, cap: items.length >= 100, top1: items.length && tot ? (items[0].value || 0) / tot : 0 };
      };
      b.rank = { at: Date.now(), def: await side("defender"), atk: await side("attacker") };
      if (isWar) {
        // COLIGAÇÃO: que países estão de facto a bater em cada lado (aliados incluídos)
        const coal = async (s) => {
          const r = await trpc("battleRanking.getRanking", { battleId: id, dataType: "damage", side: s, type: "country", limit: 10 }).catch(() => null);
          return (r?.items || (Array.isArray(r) ? r : [])).map((x) => ({ c: x.country, v: x.value || 0 }));
        };
        b.coal = { def: await coal("defender"), atk: await coal("attacker") };
        if (b.sDef) b.sDef.coalN = b.coal.def.length;
        if (b.sAtk) b.sAtk.coalN = b.coal.atk.length;
      }
    }
    // AS MINHAS ordens: battle.countryOrders/muOrders (ids, grátis) dizem SE tenho ordem e
    // de que lado; a prioridade exata (5/10/15%) busca-se só nessas batalhas (1 chamada).
    if (S.me && info.isActive) {
      const has = (so) => (so?.countryOrders || []).includes(S.me.c) || (so?.muOrders || []).includes(S.me.mu);
      const side = has(info.defender) ? "defender" : has(info.attacker) ? "attacker" : null;
      if (!side) b.myOrd = null;
      else if (!fresh(b.myOrd, TTL.rank)) {
        if (!take(1)) return false;
        const r = await trpc("battleOrder.getByBattle", { battleId: id, side }).catch(() => null);
        const list = (Array.isArray(r) ? r : r?.items || []).filter((o) => o.isActive);
        const parts = [];
        const oc = list.find((o) => o.country === S.me.c && !o.mu);
        const om = list.find((o) => o.mu === S.me.mu);
        if (oc && PRIO[oc.priority]) parts.push(["país " + PRIO[oc.priority][0], PRIO[oc.priority][1]]);
        if (om && PRIO[om.priority]) parts.push(["MU " + PRIO[om.priority][0], PRIO[om.priority][1]]);
        b.myOrd = { at: Date.now(), side, pct: parts.reduce((s, p) => s + p[1], 0), parts };
      }
    }
    // contexto de GUERRA (placar batalhas/rounds da guerra inteira) e REGIÃO (base militar)
    if (b.type !== "tournament" && info.war && !fresh(b.warI, 30 * 60e3)) {
      if (!take(1)) return false;
      const w = await trpc("war.getById", { warId: info.war }).catch(() => null);
      if (w) b.warI = { at: Date.now(), d: w };
    }
    if (b.type !== "tournament" && info.region && !b.regionI) {
      if (!take(1)) return false;
      const rg = await trpc("region.getById", { regionId: info.region }).catch(() => null);
      if (rg) b.regionI = { name: rg.name || "?", base: rg.activeUpgradeLevels?.base || 0 };
    }
    return true;
  }

  // ---------- SCOUT ao clique (análise profunda, on-demand) ----------
  // custo: ~25 getUserLite por MU (cache 1h em localStorage) + 1 round + 2 rankings + 6 lite.
  // Só corre quando CLICAS num chip — nunca em background.
  async function lite(uid) {
    const c = S.lite[uid];
    if (c && Date.now() - c.at < 6 * 3600e3) return c.d;
    const d = await trpc("user.getUserLite", { userId: uid }).catch(() => null);
    if (d) S.lite[uid] = { at: Date.now(), d };
    return d;
  }
  // atividade REAL da MU: % membros ligados nas últimas 24h/72h (lastConnectionAt),
  // nível médio, jogador mais forte da semana. 1 chamada por membro → só no scout.
  async function scoutMu(muId, onStep) {
    const c = S.scout[muId];
    if (c && Date.now() - c.at < 3600e3) return c;
    const mu = await trpc("mu.getById", { muId }).catch(() => null);
    if (!mu) return null;
    const ids = mu.members || [];
    let on24 = 0, on72 = 0, lv = 0, n = 0, top = { wk: 0, name: "" };
    for (let i = 0; i < ids.length; i++) {
      onStep && onStep(i + 1, ids.length);
      const u = await lite(ids[i]);
      if (!u) continue;
      n++;
      const h = (Date.now() - new Date(u.dates?.lastConnectionAt || 0).getTime()) / 3.6e6;
      if (h <= 24) on24++;
      if (h <= 72) on72++;
      lv += u.leveling?.level || 0;
      const wk = u.rankings?.weeklyUserDamages?.value || 0;
      if (wk > top.wk) top = { wk, name: u.username || "?" };
    }
    const out = { at: Date.now(), n, total: ids.length, on24, on72, avgLv: n ? Math.round(lv / n) : 0, topName: top.name, topWk: top.wk };
    S.scout[muId] = out;
    save(LS.scout, S.scout);
    return out;
  }
  // armas em uso no round ATUAL (amostra = lastHits por lado): top armas + estado médio do gear
  async function roundWeapons(b) {
    const rid = b.info?.d?.currentRound;
    if (!rid) return null;
    const rd = await trpc("round.getById", { roundId: rid }).catch(() => null);
    if (!rd) return null;
    const agg = (hits) => {
      const cnt = {}, st = [];
      for (const h of hits || []) {
        const w = h.weapon;
        if (!w) continue;
        cnt[w.code] = (cnt[w.code] || 0) + 1;
        if (w.maxState) st.push(w.state / w.maxState);
      }
      const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c);
      return { top, st: st.length ? Math.round((st.reduce((a, b) => a + b, 0) / st.length) * 100) : null };
    };
    return { def: agg(rd.defender?.lastHits), atk: agg(rd.attacker?.lastHits) };
  }
  // top 3 lutadores (com nome) de um lado desta batalha
  async function topFighters(bid, side) {
    const r = await trpc("battleRanking.getRanking", { battleId: bid, dataType: "damage", side, type: "user", limit: 3 }).catch(() => null);
    const items = r?.items || (Array.isArray(r) ? r : []);
    const out = [];
    for (const it of items.slice(0, 3)) {
      const u = await lite(it.user);
      out.push({ name: u?.username || "?", dmg: it.value || 0 });
    }
    return out;
  }
  async function runScout(bid) {
    const b = S.batt[bid];
    if (!b || !b.info) return;
    // reutiliza a view aberta (mantém a âncora do popover)
    const v = S.view && S.view.bid === bid ? S.view : (S.view = { bid });
    v.phase = "a analisar…"; v.done = false;
    const step = (side) => (i, t) => { v.phase = `a analisar membros (${side}) ${i}/${t}…`; renderScout(); };
    try {
      v.weapons = await roundWeapons(b);
      v.topDef = await topFighters(bid, "defender");
      v.topAtk = await topFighters(bid, "attacker");
      renderScout();
      if (b.type === "tournament" && b.sideMU) {
        v.actDef = await scoutMu(b.sideMU[0], step(b.sDef?.name || "defesa"));
        renderScout();
        v.actAtk = await scoutMu(b.sideMU[1], step(b.sAtk?.name || "ataque"));
      } else if (b.type !== "tournament") {
        // GUERRA: ordens de batalha ativas por lado. Cada ordem é de um PAÍS ou de uma MU
        // (campo country OU mu) e só bonifica os membros dessa entidade.
        const ord = async (side) => {
          const r = await trpc("battleOrder.getByBattle", { battleId: bid, side }).catch(() => null);
          const list = (Array.isArray(r) ? r : r?.items || []).filter((o) => o.isActive);
          for (const o of list) if (o.mu && !S.mu[o.mu]) await ensureMu(o.mu); // nome da MU
          return list;
        };
        v.ordDef = await ord("defender");
        v.ordAtk = await ord("attacker");
      }
      v.done = true; v.phase = "";
      v.at = Date.now();
      b.scoutV = v; // persiste na batalha: voltar à página reaproveita sem recomeçar
    } catch (e) { v.phase = "erro: " + (e?.message || e); }
    renderScout();
  }

  // ---------- cartões: encontrar e ler ----------
  // cartão = <a href="/battle/<id>"> com pelo menos um avatar lá dentro (exclui links soltos).
  // ordem no DOM: 1º avatar = lado ESQUERDO = DEFENSOR.
  function scanCards() {
    const out = [];
    scanCards._sc = new WeakMap(); // cache de "é scrollable?" por elemento, por varrimento
    const cleanup = (a) => { for (const el of a.querySelectorAll(":scope .wbs, :scope .wbs-rk")) el.remove(); };
    // O mapa e o painel "Batalhas" coexistem na MESMA rota (o mapa fica atrás do painel),
    // e o cartão é o MESMO componente nos dois sítios. Discriminador que funciona:
    // a LISTA vive dentro de um painel com SCROLL (overflow-y auto/scroll); os marcadores
    // do MAPA não — o mapa faz pan por transform, não scroll. (A heurística anterior por
    // position/transform inline apanhava o próprio painel e limpava a lista — visto 0.5.3.)
    const inScrollPanel = (a) => {
      for (let n = a.parentElement; n && n !== document.body; n = n.parentElement) {
        let v = scanCards._sc.get(n);
        if (v === undefined) {
          const o = getComputedStyle(n).overflowY;
          // aceita também "overlay" e scroll REAL (conteúdo maior que a caixa) — o painel
          // pode usar scroll customizado; o mapa faz pan por transform (não altera scrollHeight)
          v = o === "auto" || o === "scroll" || o === "overlay" ||
              (o !== "visible" && n.scrollHeight > n.clientHeight + 4);
          scanCards._sc.set(n, v);
        }
        if (v) return true;
      }
      return false;
    };
    for (const a of document.querySelectorAll('a[href^="/battle/"]')) {
      const href = a.getAttribute("href");
      // links com query (?round=N) = separadores de rounds DENTRO da página da batalha,
      // não cartões — injetar lá desformata o cabeçalho (visto 2026-07-04)
      if (href.includes("?") || !inScrollPanel(a)) { cleanup(a); continue; }
      const bid = (href.match(/^\/battle\/([a-f0-9]{24})$/) || [])[1];
      if (!bid || !a.querySelector("img")) continue;
      const mus = [];
      for (const img of a.querySelectorAll('img[src*="/avatars/mu/mu-"]')) {
        const m = img.src.match(/\/avatars\/mu\/mu-([a-f0-9]{24})/);
        if (m) mus.push(m[1]);
      }
      // 1º e último avatar de MU = esquerda/direita (dica; se faltar, o fetch usa o ranking)
      out.push({ a, bid, mus: mus.length >= 2 ? [mus[0], mus[mus.length - 1]] : [] });
    }
    // prioridade: cartões visíveis no viewport primeiro
    out.sort((x, y) => {
      const vx = x.a.getBoundingClientRect(), vy = y.a.getBoundingClientRect();
      const d = (r) => r.bottom < 0 || r.top > innerHeight ? Math.min(Math.abs(r.top), Math.abs(r.bottom - innerHeight)) : 0;
      return d(vx) - d(vy);
    });
    return out.slice(0, MAX_CARDS);
  }

  // ---------- UI ----------
  function css() {
    if (document.getElementById("wbs-css")) return;
    const st = document.createElement("style");
    st.id = "wbs-css";
    st.textContent = `
.wbs{margin:4px 6px 5px;font:600 10.5px/1.4 Inter,system-ui,Segoe UI,sans-serif;color:#dbe4ee;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.wbs-row{display:flex;align-items:center;justify-content:space-between;gap:4px;margin-bottom:2px}
.wbs-side{overflow:hidden;text-overflow:ellipsis}
.wbs-mid{color:#8494a8;font-weight:500;font-size:10px}
.wbs-dim{color:#8494a8;font-weight:500}
.wbs-bar{position:relative;height:11px;border-radius:6px;overflow:hidden;background:#2b3441}
.wbs-bar>i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#58c26e88,#58c26e44);
  border-right:1.5px solid #dbe4ee66}
.wbs-bar>b{position:absolute;top:0;z-index:2;font:700 9px/11px inherit;padding:0 4px}
.wbs-bar>b.l{left:0}.wbs-bar>b.r{right:0;color:#dbe4ee99}
.wbs-time{position:absolute;inset:0 36px;z-index:1;display:flex;align-items:center;justify-content:center;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;
  color:#dbe4ee;opacity:.46;text-shadow:0 1px 2px #000,0 0 4px #000;
  font:800 8.5px/11px Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums}
.wbs-done{color:#f0b13e}
.wbs-flag{width:11px;height:8px;object-fit:cover;border-radius:2px;vertical-align:-0.5px;
  margin:0 2px 0 0;filter:drop-shadow(black 0.5px 0.5px 0px)}
/* badge de ranking: OVERLAY ancorado ao avatar (position:absolute) — não ocupa espaço
   no layout do cartão, senão empurrava os avatares para fora (visto em 0.3.2) */
.wbs-rk{position:absolute;bottom:-13px;left:50%;transform:translateX(-50%);z-index:3;
  padding:0 3px;border-radius:4px;background:#151a21ee;border:1px solid #ffffff22;
  font:700 8.5px/1.5 Inter,system-ui,sans-serif;color:#f0b13e;
  font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:auto}
/* painel SCOUT na página da batalha — EM FLUXO dentro da coluna do jogo (a seguir ao
   cabeçalho); .float é o fallback flutuante se a âncora não existir */
#wbs-scout{display:none;margin:6px 10px;background:#151a21f2;border:1px solid #2b3441;
  border-radius:11px;font:500 11.5px/1.6 Inter,system-ui,Segoe UI,sans-serif;color:#dbe4ee;
  white-space:normal;text-align:left}
#wbs-scout.float{position:fixed;z-index:99990;bottom:14px;left:14px;width:min(340px,94vw);
  box-shadow:0 8px 28px #0009;backdrop-filter:blur(6px);margin:0}
#wbs-scout .hd{display:flex;align-items:center;gap:8px;padding:7px 11px;background:#1a212b;
  border-radius:11px 11px 0 0}
#wbs-scout .hd b{flex:1;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#f0b13e;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#wbs-scout .bt{cursor:pointer;border:0;background:#232c38;color:#8494a8;border-radius:6px;
  padding:1px 7px;font-size:11px}
#wbs-scout .bt:hover{color:#dbe4ee}
#wbs-scout .bd{padding:8px 10px 10px;border-top:1px solid #2b3441}
#wbs-scout .g{display:grid;grid-template-columns:1fr 1fr;gap:6px}
#wbs-scout .dim{color:#8494a8}
#wbs-scout .up{color:#58c26e}#wbs-scout .down{color:#e05252}
#wbs-scout .side{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* previsão: barra generosa com % dentro */
#wbs-scout .pbar{position:relative;height:16px;border-radius:8px;overflow:hidden;background:#2b3441;margin:3px 0 2px}
#wbs-scout .pbar>i{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,#58c26e99,#58c26e44);border-right:1.5px solid #dbe4ee88}
#wbs-scout .pbar>b{position:absolute;top:0;font:700 11px/16px Inter,system-ui,sans-serif;padding:0 6px}
#wbs-scout .pbar>b.l{left:0}#wbs-scout .pbar>b.r{right:0;color:#dbe4ee99}
/* coluna de cada lado = mini-cartão com identidade */
#wbs-scout .col{background:#ffffff06;border:1px solid #ffffff0d;border-radius:9px;padding:6px 8px;min-width:0}
#wbs-scout .ttl{display:flex;align-items:center;gap:5px;margin-bottom:4px;font-weight:700;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#wbs-scout .ttl img.mu{width:18px;height:18px;border-radius:5px;object-fit:cover;flex:none}
#wbs-scout .lbl{font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:#617083;margin-top:5px}
#wbs-scout .abar{height:4px;border-radius:3px;background:#2b3441;overflow:hidden;margin:2px 0 1px}
#wbs-scout .abar>i{display:block;height:100%;border-radius:3px}
#wbs-scout .wpn{display:flex;align-items:center;gap:4px}
#wbs-scout .wpn img{width:16px;height:16px;object-fit:contain;filter:drop-shadow(black 1px 1px 0px)}
#wbs-scout .num{font-variant-numeric:tabular-nums}`;
    document.head.appendChild(st);
  }

  const flagImg = (code, tip) => code ? `<img class="wbs-flag" src="/images/flags/${encodeURIComponent(code)}.svg?v=16" alt="${esc(code)}" title="${esc(tip || "")}">` : "";
  const sideHtml = (s, rk, crown) =>
    `<span class="wbs-side">⚔${rk ? rk.n + (rk.cap ? "+" : "") : "·"}${crown ? "👑" : ""}${s?.coalN > 1 ? `<span class="wbs-dim">🤝${s.coalN}</span>` : ""} <b>${s ? fmt(s.weekly) : "…"}</b>${s ? MEDAL[s.tier] || "" : ""}</span>`;

  function chipHtml(b) {
    const p = predict(b);
    if (!p) return `<div class="wbs-row"><span class="wbs-dim">a carregar…</span></div>`;
    const crownD = b.rank && b.rank.def.n > 1 && b.rank.def.top1 > 0.5;
    const crownA = b.rank && b.rank.atk.n > 1 && b.rank.atk.top1 > 0.5;
    if (p.done) {
      const name = p.winner === "def" ? b.sDef?.name : b.sAtk?.name;
      return `<div class="wbs-row">${sideHtml(b.sDef, b.rank?.def, crownD)}<span class="wbs-done">✔ ${esc(name || p.winner)} ${p.wonD}–${p.wonA}</span>${sideHtml(b.sAtk, b.rank?.atk, crownA, true)}</div>`;
    }
    const pct = Math.round(p.pDef * 100);
    // honestidade: 0%/100% não existem — mostrar <1% / >99% (a barra pode ficar a 0/100)
    const lbl = (x) => x <= 0 ? "<1%" : x >= 100 ? ">99%" : x + "%";
    // HOT: 🔥 = ritmo de dano agora · ⚡ = último round possível E renhido (o teu dano decide)
    const hi = heatIcon(heatRate(b));
    const decisive = p.toWin - p.wonD === 1 && p.toWin - p.wonA === 1 && pct >= 25 && pct <= 75 ? "⚡" : "";
    // ⭐ = TENS ordem aqui (país+MU somados) — o teu bónus de escolha, visível na lista
    const my = b.myOrd?.pct ? `<span style="color:#f0b13e">⭐+${b.myOrd.pct}%</span>` : "";
    return `
      <div class="wbs-row">
        ${sideHtml(b.sDef, b.rank?.def, crownD)}
        <span class="wbs-mid">${p.wonD}–${p.wonA}·R${p.roundN}${hi || decisive ? " " + hi + decisive : ""}${my ? " " + my : ""}</span>
        ${sideHtml(b.sAtk, b.rank?.atk, crownA, true)}
      </div>
      <div class="wbs-bar"><i style="width:${pct}%"></i>${timeBarHtml(b, p)}<b class="l">${lbl(pct)}</b><b class="r">${lbl(100 - pct)}</b></div>`;
  }

  function chipTitle(b) {
    const p = predict(b);
    if (!p || p.done) return "";
    const who = b.type === "tournament" ? "das MUs" : "dos países";
    const L = [];
    const pc = Math.round(p.pDef * 100);
    const plbl = (x) => x <= 0 ? "<1%" : x >= 100 ? ">99%" : x + "%";
    L.push(`Previsão: ${plbl(pc)} ${b.sDef?.name || "defensor"} · ${plbl(100 - pc)} ${b.sAtk?.name || "atacante"}`);
    if (p.dD + p.dA > 0) L.push(`· dano em rounds fechados: ${fmt(p.dD)} vs ${fmt(p.dA)}`);
    L.push(`· dano semanal ${who}: ${fmt(b.sDef?.weekly || 0)} (${b.sDef?.sub || "?"}) vs ${fmt(b.sAtk?.weekly || 0)} (${b.sAtk?.sub || "?"})`);
    L.push(`· round atual: ${p.ptsD}–${p.ptsA} pts (corrida até 300) · dano no round: ${fmt(p.rdD)} vs ${fmt(p.rdA)}`);
    const st = battleStartMs(b), eta = battleEta(b, p);
    if (st || eta) {
      const end = (ms) => ms ? fmtClock(Date.now() + ms) : "?";
      L.push(`tempo: inicio ${st ? fmtClock(st) : "?"} | fim provavel ${eta ? end(eta.ms) : "?"}` +
        (eta ? ` (se defensor ${end(eta.defMs)}, se atacante ${end(eta.atkMs)})` : ""));
    }
    const hr = heatRate(b);
    if (hr != null) L.push(`· ritmo AGORA: ${fmt(hr)}/min ${heatIcon(hr) || "(calmo)"} — medido entre atualizações (~2 min)`);
    if (p.toWin - p.wonD === 1 && p.toWin - p.wonA === 1) L.push(`⚡ round DECISIVO: quem o ganhar leva a série`);
    if (b.myOrd?.pct) L.push(`⭐ TENS ordem aqui (lado ${b.myOrd.side === "defender" ? "defensor" : "atacante"}): ${b.myOrd.parts.map((x) => `${x[0]} +${x[1]}%`).join(" + ")} = +${b.myOrd.pct}% p/ ti`);
    L.push(`· série: ${p.wonD}–${p.wonA}, à melhor de ${p.toWin * 2 - 1}`);
    if (b.rank) {
      L.push(`Lutadores nesta batalha: ${b.rank.def.n}${b.rank.def.cap ? "+" : ""} vs ${b.rank.atk.n}${b.rank.atk.cap ? "+" : ""}`);
      if (b.rank.def.n > 1 && b.rank.def.top1 > 0.5) L.push(`👑 top1 do defensor fez ${Math.round(b.rank.def.top1 * 100)}% do dano do lado`);
      if (b.rank.atk.n > 1 && b.rank.atk.top1 > 0.5) L.push(`👑 top1 do atacante fez ${Math.round(b.rank.atk.top1 * 100)}% do dano do lado`);
    }
    // contexto extra das GUERRAS: coligação, placar da guerra, região/base
    if (b.coal) {
      const names = (list) => list.slice(0, 3).map((x) => S.geo?.byId?.[x.c]?.name || "?").join(", ") + (list.length > 3 ? ` +${list.length - 3}` : "");
      if (b.coal.def.length > 1 || b.coal.atk.length > 1)
        L.push(`🤝 coligações — defesa: ${names(b.coal.def) || "—"} · ataque: ${names(b.coal.atk) || "—"}`);
    }
    const wi = b.warI?.d, info2 = b.info?.d;
    if (wi && info2) {
      const defIsWarDef = wi.defender?.country === info2.defender?.country;
      const wd = defIsWarDef ? wi.defender : wi.attacker, wa = defIsWarDef ? wi.attacker : wi.defender;
      L.push(`⚔ guerra inteira: ${wd?.wonBattlesCount || 0}–${wa?.wonBattlesCount || 0} batalhas · dano ${fmt(wd?.damages || 0)} vs ${fmt(wa?.damages || 0)}`);
    }
    if (b.regionI) L.push(`📍 ${b.regionI.name}${b.regionI.base ? ` · base militar L${b.regionI.base} (defesa +${b.regionI.base * 5}%, atacante ganha metade)` : " · sem base militar"}`);
    L.push(`(esquerda = defensor · ⚔ = lutadores · 👑 = 1 jogador fez >50% do lado · 🤝 = países na coligação)`);
    return L.join("\n");
  }

  // badge "#N" (ranking geral dinâmico) ao lado de cada avatar de MU do cartão
  function applyRankBadges(a, b) {
    if (b.type !== "tournament" || !b.sideMU) return;
    for (const img of a.querySelectorAll('img[src*="/avatars/mu/mu-"]')) {
      const m = img.src.match(/\/avatars\/mu\/mu-([a-f0-9]{24})/);
      const mu = m && S.mu[m[1]];
      if (!mu || !mu.overall) continue;
      // overlay DENTRO do wrapper do avatar (identificado por data-mu; sobrevive a re-renders)
      const wrap = img.closest("div[aria-haspopup]") || img.parentElement;
      let badge = wrap.querySelector(`:scope > .wbs-rk`);
      if (!badge) {
        wrap.style.position = "relative"; // âncora do overlay
        badge = document.createElement("span");
        badge.className = "wbs-rk";
        wrap.appendChild(badge);
      }
      badge.dataset.mu = m[1];
      // bandeira do PAÍS da MU à esquerda do rank (edifícios só no tooltip — sem espaço)
      const ci = mu.country ? S.geo?.byId?.[mu.country] : null;
      const html = `${flagImg(ci?.code, ci?.name)}#${mu.overall}`;
      if (badge.dataset.h !== html) {
        badge.dataset.h = html;
        badge.innerHTML = html;
        const infra = [];
        if (mu.hq) infra.push(`🏰 QG nível ${mu.hq}: +${mu.hq * 5}% ataque dos membros em batalha (já refletido no dano semanal)`);
        if (mu.cap) infra.push(`🛏 dormitórios: ${mu.members}/${mu.cap} membros${mu.members >= mu.cap ? " (cheia)" : " (com vagas)"}`);
        if (!mu.hq) infra.push(`sem QG ativo (0% de bónus de ataque)`);
        badge.title = `${mu.name} — ranking geral (média ponderada dos ranks): #${mu.overall}\n` +
          mu.ranks.map((r) => `· ${r.label}: #${r.rank} ${MEDAL[r.tier] || ""}${r.w > 1 ? ` (peso ${r.w})` : ""}`).join("\n") +
          (infra.length ? "\n" + infra.join("\n") : "");
      }
    }
  }

  // ---------- painel SCOUT na PÁGINA DA BATALHA ----------
  // Os cartões da lista são o GLANCE; clicar num cartão navega para /battle/<id> e É AÍ
  // que o scout abre sozinho com a profundidade (previsão + atividade + carries + armas).
  function renderScout() {
    css();
    let box = document.getElementById("wbs-scout");
    if (!box) {
      box = document.createElement("div");
      box.id = "wbs-scout";
      document.body.appendChild(box);
      box.addEventListener("click", (e) => {
        const id = e.target && e.target.id;
        if (id === "wbs-x") { S.view = null; renderScout(); }
        else if (id === "wbs-min") { S.min = !S.min; renderScout(); }
      });
    }
    const v = S.view;
    if (!v) { box.style.display = "none"; return; }
    const b = S.batt[v.bid] || {};
    const p = predict(b);
    const nm = (s) => esc(s?.name || "?");
    const lbl = (x) => x <= 0 ? "<1%" : x >= 100 ? ">99%" : x + "%";
    // identidade de cada lado: avatar da MU (torneio) + bandeira (MU ou país)
    const ident = (s) => `${s?.av ? `<img class="mu" src="${esc(s.av)}" alt="">` : ""}${flagImg(s?.flag || s?.code, s?.sub)}<span class="side">${nm(s)}</span>`;
    let predHtml = `<div class="dim">a carregar previsão…</div>`;
    if (p && p.done) predHtml = `<div style="color:#f0b13e;font-weight:700">✔ série decidida: ${p.winner === "def" ? nm(b.sDef) : nm(b.sAtk)} ${p.wonD}–${p.wonA}</div>`;
    else if (p) {
      const pct = Math.round(p.pDef * 100);
      predHtml = `
        <div class="pbar"><i style="width:${pct}%"></i><b class="l">${lbl(pct)}</b><b class="r">${lbl(100 - pct)}</b></div>
        <div class="dim num" style="text-align:center">série ${p.wonD}–${p.wonA} · R${p.roundN}: ${p.ptsD}–${p.ptsA} pts · dano no round ${fmt(p.rdD)} vs ${fmt(p.rdA)}${(() => { const hr = heatRate(b); return hr != null ? ` · ${fmt(hr)}/min ${heatIcon(hr)}` : ""; })()}</div>`;
    }
    // coluna de um lado: atividade (MU) OU coligação/ordens (guerra), tops, armas
    const cname = (id) => S.geo?.byId?.[id]?.name || "?";
    const cflag = (id) => flagImg(S.geo?.byId?.[id]?.code, cname(id));
    const colHtml = (s, a, t, w, coal, ords) => {
      const pctOn = a && a.total ? a.on24 / a.total : null;
      const cls = pctOn == null ? "" : pctOn >= 0.6 ? "up" : pctOn < 0.3 ? "down" : "";
      const barColor = pctOn == null ? "#617083" : pctOn >= 0.6 ? "#58c26e" : pctOn < 0.3 ? "#e05252" : "#f0b13e";
      const actHtml = a ? `<div class="lbl">atividade</div>
          <span class="${cls} num"><b>${a.on24}/${a.total}</b> em 24h</span>
          <div class="abar"><i style="width:${Math.round((pctOn || 0) * 100)}%;background:${barColor}"></i></div>
          <span class="dim num">${a.on72} em 72h · nível médio ${a.avgLv}</span>
          ${a.topName ? `<div class="lbl">mais forte da semana</div><span class="side">${esc(a.topName)} <span class="dim num">${fmt(a.topWk)}</span></span>` : ""}` : "";
      const coalHtml = coal && coal.length ? `<div class="lbl">coligação (${coal.length})</div>
          ${coal.slice(0, 4).map((x) => `<div class="side num">${cflag(x.c)}${esc(cname(x.c))} <span class="dim">${fmt(x.v)}</span></div>`).join("")}` : "";
      const ordHtml = ords && ords.length ? `<div class="lbl">ordens ativas</div>
          ${ords.slice(0, 4).map((o) => {
            const p = PRIO[o.priority] || [o.priority, "?"];
            // ordem de PAÍS (bandeira) ou de MU (🎖 + nome da MU) — só bonifica os seus membros
            const mine = S.me && ((o.mu && o.mu === S.me.mu) || (!o.mu && o.country === S.me.c));
            const who = o.mu ? `🎖${esc(S.mu[o.mu]?.name || "MU")}` : `${cflag(o.country)}${esc(cname(o.country))}`;
            return `<div class="side">${mine ? "⭐" : ""}${who} <span class="${o.priority === "high" ? "up" : "dim"}">${p[0]} +${p[1]}%</span></div>`;
          }).join("")}
          <div class="dim" style="font-size:9px;line-height:1.3">cada ordem só bonifica membros desse país/MU</div>` : "";
      return `<div class="col">
        <div class="ttl">${ident(s)}</div>
        ${actHtml}${coalHtml}${ordHtml}
        <div class="lbl">top nesta batalha</div>
        ${t && t.length ? t.map((x) => `<div class="side num">${esc(x.name)} <span class="dim">${fmt(x.dmg)}</span></div>`).join("") : `<span class="dim">ninguém ainda</span>`}
        <div class="lbl">armas no round</div>
        ${w && w.top && w.top.length ? `<div class="wpn">${w.top.map((c) => `<img src="/images/items/${encodeURIComponent(c)}.png?v=33" alt="${esc(c)}" title="${esc(c)}">`).join("")}${w.st != null ? `<span class="dim num">gear ${w.st}%</span>` : ""}</div>` : `<span class="dim">—</span>`}
      </div>`;
    };
    box.innerHTML = `
      <div class="hd">
        <b>Scout · ${nm(b.sDef)} vs ${nm(b.sAtk)}</b>
        <button class="bt" id="wbs-min">${S.min ? "▸" : "▾"}</button>
        <button class="bt" id="wbs-x">×</button>
      </div>
      ${S.min ? "" : `<div class="bd">
        <div class="g" style="margin-bottom:2px">
          <div class="ttl" style="margin:0">${ident(b.sDef)}</div>
          <div class="ttl" style="margin:0;justify-content:flex-end">${ident(b.sAtk)}</div>
        </div>
        ${predHtml}
        ${(() => { // meta de GUERRA: região/base + placar da guerra inteira
          if (b.type === "tournament") return "";
          const bits = [];
          if (b.regionI) bits.push(`📍 ${esc(b.regionI.name)}${b.regionI.base ? ` · base L${b.regionI.base}` : ""}`);
          const wi = b.warI?.d, inf = b.info?.d;
          if (wi && inf) {
            const dIsD = wi.defender?.country === inf.defender?.country;
            const wd = dIsD ? wi.defender : wi.attacker, wa = dIsD ? wi.attacker : wi.defender;
            bits.push(`guerra: ${wd?.wonBattlesCount || 0}–${wa?.wonBattlesCount || 0} batalhas`);
          }
          return bits.length ? `<div class="dim num" style="text-align:center;margin-top:2px">${bits.join(" · ")}</div>` : "";
        })()}
        <div class="g" style="margin-top:7px">
          ${colHtml(b.sDef, v.actDef, v.topDef, v.weapons?.def, b.coal?.def, v.ordDef)}
          ${colHtml(b.sAtk, v.actAtk, v.topAtk, v.weapons?.atk, b.coal?.atk, v.ordAtk)}
        </div>
        ${v.phase ? `<div class="dim" style="margin-top:5px">${esc(v.phase)}</div>` : ""}
        ${v.done ? `<div class="dim" style="margin-top:5px;font-size:10px">read-only · atividade em cache 1h</div>` : ""}
      </div>`}`;
    attachScout(box, v.bid);
    box.style.display = "block";
  }
  // ancora o painel DENTRO da coluna da batalha: logo a seguir ao cabeçalho (a grelha de
  // 3 colunas que contém os separadores ?round=N). Se a âncora não existir → flutuante.
  function attachScout(box, bid) {
    const tab = document.querySelector(`a[href="/battle/${bid}?round=1"]`);
    const grid = tab && tab.closest('div[style*="repeat(3"]');
    if (grid && grid.parentElement) {
      if (box.previousElementSibling !== grid) grid.insertAdjacentElement("afterend", box);
      box.classList.remove("float");
    } else {
      if (box.parentElement !== document.body) document.body.appendChild(box);
      box.classList.add("float");
    }
  }
  // vigia a rota: entrar em /battle/<id> abre o scout dessa batalha; sair fecha-o.
  // NÃO recriar a view se já é desta batalha, e REUTILIZAR o scout persistido na batalha
  // (senão qualquer soluço de rota apagava a recomendação e recomeçava do zero).
  let curPage = null;
  setInterval(() => {
    const m = location.pathname.match(/^\/battle\/([a-f0-9]{24})$/);
    const bid = m ? m[1] : null;
    if (bid === curPage) return;
    curPage = bid;
    if (!bid) { S.view = null; renderScout(); return; }
    if (S.view?.bid === bid) return; // mesma batalha, view intacta
    const prev = S.batt[bid]?.scoutV;
    if (prev && prev.done && Date.now() - prev.at < 10 * 60e3) {
      S.view = prev; renderScout(); return; // scout fresco já calculado — instantâneo
    }
    S.view = { bid, phase: "a carregar dados da batalha…" };
    renderScout();
    (async () => {
      S.calls = 0;                    // orçamento novo para a página
      await ensureMe();
      await fetchBattle(bid, []);     // info/MUs/live/rankings (usa caches se frescos)
      renderScout();
      await runScout(bid);            // armas + carries + atividade dos membros
    })().catch(() => {});
  }, 800);

  function applyCards() {
    css();
    for (const { a, bid } of scanCards()) {
      const b = S.batt[bid];
      if (!b) continue;
      applyRankBadges(a, b);
      let chip = a.querySelector(":scope .wbs");
      if (!chip) {
        chip = document.createElement("div");
        chip.className = "wbs";
        // dentro do wrapper interno do cartão (o <a> é flex-column) — fica no fundo
        (a.firstElementChild || a).appendChild(chip);
      }
      chip.dataset.bid = bid; // p/ o scout ao clique
      const html = chipHtml(b);
      if (chip.dataset.h !== html) { chip.dataset.h = html; chip.innerHTML = html; chip.title = chipTitle(b); }
    }
  }

  // ---------- ciclo ----------
  async function refresh() {
    if (S.busy || document.visibilityState !== "visible") return;
    const cards = scanCards();
    if (!cards.length) return;
    S.busy = true; S.calls = 0;
    await ensureMe(); // 1× por sessão (país + MU p/ detetar as minhas ordens)
    let leftover = false;
    try {
      for (const c of cards) {           // sequencial = gentil com a API
        const done = await fetchBattle(c.bid, c.mus);
        applyCards();                    // vai pintando à medida que chega
        if (!done) { leftover = true; break; }
      }
    } finally { S.busy = false; }
    // orçamento esgotado → continua daqui a 15s (os já feitos estão frescos e não repetem)
    clearTimeout(S.moreT);
    if (leftover) S.moreT = setTimeout(refresh, 15e3);
  }

  const mo = new MutationObserver(() => {
    clearTimeout(mo._t);
    mo._t = setTimeout(() => { applyCards(); refresh(); }, 500);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  // re-aplica chips E re-ancora o scout (re-renders do React podem removê-lo do fluxo)
  setInterval(() => { applyCards(); if (S.view) renderScout(); }, SCAN_MS);
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refresh(); });
  refresh();
})();
