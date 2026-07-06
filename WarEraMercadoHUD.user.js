// ==UserScript==
// @name         WarEra Mercado HUD
// @namespace    local.warera.mercado-hud
// @version      0.6.0
// @description  Conselheiro de trading na tela do mercado: diz "vende/compra" com bid/ask, VWAP, volume e tendência (Rising/Falling/Stable…) de trades reais via daemon local (fallback API). Read-only.
// @match        https://app.warera.io/*
// @connect      api2.warera.io
// @connect      127.0.0.1
// @connect      localhost
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraMercadoHUD.user.js
// @downloadURL  https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraMercadoHUD.user.js
// ==/UserScript==

/*
  Objetivo: na tela do Mercado, olhar para cada item e saber SE é a minha jogada e SE o preço
  está bom AGORA. Glance = anel de cor no tile (🟡 vender / 🟢 comprar); a FRASE ("vende steel,
  está caro") vive no painel "Ações" e no tooltip ao clique.

  Como decide (factual, sem "valor justo" inventado):
    - LADO: item que PRODUZES ou tens em STOCK → candidato a VENDER; item que é INPUT do que
      produzes → candidato a COMPRAR.
    - PREÇO BOM: posição do preço no intervalo recente (histórico localStorage) + tendência.
      Vender no topo do intervalo / a subir; comprar no fundo / a cair.
    - Para o que produzes mostro a margem (preço − inputs) como reforço.

  Ancoragem robusta: o tile do mercado é #item-code-selector-<code> com um img[alt=<code>] — hook
  estável (dá o itemCode direto), ao contrário das classes hasheadas do jogo.

  API gentil: itemTrading.getPrices (1 chamada, todos os preços) + histórico local. O order book
  real (bid/ask por item) fica para v0.2. Read-only: só lê com a tua sessão; o humano decide.
*/
(() => {
  "use strict";

  // failover de hosts (api2–api5), igual aos outros HUDs
  const HOSTS = ["https://api2.warera.io", "https://api3.warera.io", "https://api4.warera.io", "https://api5.warera.io"];
  const DAEMON = "http://127.0.0.1:8799"; // coletor local (src/daemon.js): histórico contínuo + bid/ask
  const LS = { hist: "wmh.hist", cfg: "wmh.cfg", ui: "wmh.ui" };
  const REFRESH_MS = 5 * 60 * 1000;    // ciclo de dados (mercado mexe mais que empresas)
  const SAMPLE_MS = 30 * 60 * 1000;    // amostra de preços p/ histórico
  const HIST_MAX = 480;                // ~10 dias a 30 min
  const DOM_MS = 4 * 1000;             // re-aplicar marcadores (SPA re-render)

  const COIN = `<svg class="wmh-coin" stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 5C7.031 5 2 6.546 2 9.5S7.031 14 12 14c4.97 0 10-1.546 10-4.5S16.97 5 12 5zm-5 9.938v3c1.237.299 2.605.482 4 .541v-3a21.166 21.166 0 0 1-4-.541zm6 .54v3a20.994 20.994 0 0 0 4-.541v-3a20.994 20.994 0 0 1-4 .541zm6-1.181v3c1.801-.755 3-1.857 3-3.297v-3c0 1.44-1.199 2.542-3 3.297zm-14 3v-3C3.2 13.542 2 12.439 2 11v3c0 1.439 1.2 2.542 3 3.297z"></path></svg>`;

  // ---------- API de sessão ----------
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
        if (res.status >= 500) throw new Error(`${path}: HTTP ${res.status}`);
        hostI = i;
        if (!res.ok) throw { final: new Error(`${path}: HTTP ${res.status}`) };
        const body = await res.json();
        if (body && body.error) throw { final: new Error(body.error.message || path) };
        return body && body.result ? body.result.data : body;
      } catch (e) {
        if (e && e.final) throw e.final;
        lastErr = e;
      }
    }
    throw lastErr || new Error(path);
  }
  // lê do daemon local via GM_xmlhttpRequest — CONTORNA o CSP/mixed-content/Private-Network
  // (o jogo é HTTPS e um fetch de página p/ http://127.0.0.1 é bloqueado pelo browser).
  // null se o daemon estiver desligado. Na 1ª vez o Tampermonkey pede para permitir 127.0.0.1.
  function db(path) {
    return new Promise((resolve) => {
      try {
        GM_xmlhttpRequest({
          method: "GET", url: DAEMON + path, timeout: 1500,
          onload: (r) => { try { resolve(r.status >= 200 && r.status < 300 ? JSON.parse(r.responseText) : null); } catch { resolve(null); } },
          onerror: () => resolve(null), ontimeout: () => resolve(null),
        });
      } catch { resolve(null); }
    });
  }
  const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---------- estado ----------
  const S = {
    userId: null,
    cfg: null,                 // {items:{code:{pp,needs}}}
    prices: {}, inv: {},
    produce: new Set(),        // itemCodes que produzo (empresas ativas ou não)
    inputs: new Map(),         // input code -> [itemCodes que o consomem]
    sig: {},                   // code -> {side, price, bid, ask, t, pctile, action, why[], marginPP}
    dstats: null,              // code -> stats do daemon (trendPct/pctile/bid/ask) ou null (fallback local)
    dsamples: null,            // {tx, px} do daemon (volume real acumulado)
    src: "local",              // "daemon" | "local"
    hist: load(LS.hist, []),
    err: null, at: 0, busy: false,
  };

  // ---------- econ mínimo ----------
  function trimConfig(cfg) {
    const items = {};
    for (const [code, it] of Object.entries(cfg.items || {}))
      items[code] = { pp: it.productionPoints, needs: it.productionNeeds || null };
    return { items, at: Date.now() };
  }
  const inputCost = (code) => {
    const needs = S.cfg?.items?.[code]?.needs; if (!needs) return null;
    let c = 0; for (const [m, q] of Object.entries(needs)) c += (S.prices[m] || 0) * q;
    return c;
  };
  const marginPP = (code) => {
    const it = S.cfg?.items?.[code]; const ic = inputCost(code);
    if (!it || !it.pp || ic == null) return null;
    return ((S.prices[code] || 0) - ic) / it.pp;
  };
  // (a lógica de caixas abrir-vs-vender e o VEREDITO vivem agora no DAEMON — o cérebro único.
  //  O HUD só renderiza; ver localVerdict abaixo para o fallback quando o daemon está off.)

  // ---------- histórico + tendência + intervalo ----------
  function samplePrices() {
    const now = Date.now();
    const last = S.hist[S.hist.length - 1];
    if (last && now - last.t < SAMPLE_MS) return;
    const p = {};
    for (const [c, v] of Object.entries(S.prices)) if (v != null) p[c] = +Number(v).toFixed(4);
    if (!Object.keys(p).length) return;
    S.hist.push({ t: now, p });
    if (S.hist.length > HIST_MAX) S.hist = S.hist.slice(-HIST_MAX);
    save(LS.hist, S.hist);
  }
  const series = (code) => S.hist.map((s) => s.p[code]).filter((v) => v != null);
  function trend(code) { // % de variação recente vs anterior
    const v = series(code);
    if (v.length < 4) return null;
    const rec = v.slice(-6), old = v.slice(-30, -6);
    if (!old.length) return null;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const a = avg(old), b = avg(rec);
    return a ? ((b - a) / a) * 100 : null;
  }
  function rangePct(code) { // posição do preço atual no intervalo min–max recente (0..1)
    const v = series(code).slice(-48);
    if (v.length < 6) return null;
    const min = Math.min(...v), max = Math.max(...v);
    if (max - min < 1e-9) return null;
    return ((S.prices[code] || 0) - min) / (max - min);
  }
  function spark(code, w = 76, h = 16) {
    const v = series(code).slice(-40);
    if (v.length < 2) return "";
    const min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
    const pts = v.map((y, i) => `${(i / (v.length - 1)) * w},${h - 2 - ((y - min) / rng) * (h - 4)}`).join(" ");
    const up = v[v.length - 1] >= v[0];
    return `<svg class="wmh-spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${pts}" fill="none" stroke="${up ? "#58c26e" : "#e05252"}" stroke-width="1.5"/></svg>`;
  }

  // ---------- sinal por item ----------
  // O VEREDITO (decidir VENDER/COMPRAR/ABRIR/esperar) vive no DAEMON — cérebro único. Aqui só:
  //  (1) determinamos o LADO (precisa do teu inventário, que é de sessão); (2) buscamos o veredito
  //  do daemon; (3) fallback local mínimo quando o daemon está off.
  function localVerdict(code, side) { // fallback: histórico local, sem labels/caixas
    const near = rangePct(code), t = trend(code);
    const falling = t != null && t < -2;
    const pc = (x) => Math.round(x * 100) + "%";
    const why = []; let action = false, wait = false;
    if (side === "sell") {
      if (near != null && near >= 0.7) { action = true; why.push(`perto do máximo (${pc(near)})`); }
      else if (falling && near != null && near < 0.5) { wait = true; why.push(`a cair — segura`); }
      else if (near != null && near <= 0.3) { wait = true; why.push(`perto do mínimo — mau p/ vender`); }
    } else {
      if (near != null && near <= 0.3) { action = true; why.push(`perto do mínimo (${pc(near)})`); }
      else if (falling && near != null && near <= 0.55) { action = true; why.push(`a cair — apanha a queda`); }
      else if (near != null && near >= 0.7) { wait = true; why.push(`perto do máximo — caro`); }
    }
    const verb = side === "sell" ? (action ? "VENDER" : wait ? "segurar" : "vender?") : (action ? "COMPRAR" : wait ? "esperar" : "comprar?");
    return { action, wait, why, verb };
  }
  function computeSignals() {
    S.sig = {};
    for (const code of Object.keys(S.prices)) {
      const price = S.prices[code];
      if (price == null) continue;
      const produce = S.produce.has(code);
      const held = (S.inv[code] || 0) > 0;
      const isInput = S.inputs.has(code) && !produce; // se produzo, o lado é vender
      const side = produce || held ? "sell" : isInput ? "buy" : null;
      const ds = S.dstats?.[code]; // item do daemon (métricas + veredito) se ligado
      // VEREDITO: do daemon (cérebro) quando ligado; senão fallback local mínimo
      let v = null;
      if (side) v = (ds && (side === "sell" ? ds.sellVerdict : ds.buyVerdict)) || localVerdict(code, side);
      const bid = ds?.bid ?? null, ask = ds?.ask ?? null;
      S.sig[code] = {
        side, price, bid, ask, buyQty: ds?.buyQty ?? null, sellQty: ds?.sellQty ?? null,
        action: v?.action || false, wait: v?.wait || false, why: v?.why || [], verb: v?.verb || null,
        openVal: ds?.openVal ?? null, openBetter: ds?.openBetter || false, openMkt: ds?.openVal != null,
        labels: ds?.labels || [], vwap: ds?.vwap7 ?? null, trades7: ds?.trades7 ?? null, volume7: ds?.volume7 ?? null,
        spreadPct: ds?.spreadPct ?? null, depthImb: ds?.depthImbalancePct ?? null, d30: ds?.d30 || null,
        t: ds ? ds.trendPct : trend(code), pctile: ds ? (ds.d30?.pctile ?? ds.pctile) : rangePct(code),
        held: S.inv[code] || 0, produce, marginPP: produce ? marginPP(code) : null,
        consumers: S.inputs.get(code) || null,
      };
    }
  }

  // ---------- ciclo de dados ----------
  async function refresh() {
    if (S.busy) return;
    S.busy = true;
    try {
      // SESSÃO (sempre do browser — o daemon não vê inventário/cash): quem sou + stock
      const me = await trpc("user.getMe", {});
      S.userId = me?._id;
      const inv = await trpc("inventory.getMyInventory", {}).catch(() => null);
      S.inv = inv?.items?.basics || {};
      // config (cache local 24h; preciso das recipes p/ a margem)
      let cfg = load(LS.cfg, null);
      if (!cfg || !cfg.items || Date.now() - cfg.at > 24 * 3.6e6) { cfg = trimConfig(await trpc("gameConfig.getGameConfig", {})); save(LS.cfg, cfg); }
      S.cfg = cfg;

      // FONTE dos dados de mercado: DAEMON primeiro (histórico contínuo + bid/ask), senão API viva
      const mkt = await db("/market");
      if (mkt && mkt.items) {
        S.src = "daemon"; S.dstats = mkt.items; S.dsamples = mkt.samples || null;
        S.prices = {}; for (const [c, it] of Object.entries(mkt.items)) S.prices[c] = it.price;
        S.produce = new Set(mkt.mine?.produce || []);
        S.inputs = new Map(Object.entries(mkt.mine?.inputs || {}));
      } else {
        S.src = "local"; S.dstats = null; S.dsamples = null;
        S.prices = (await trpc("itemTrading.getPrices", {})) || {};
        // o que PRODUZO + inputs (fallback: empresas via API pública)
        S.produce = new Set(); S.inputs = new Map();
        const listRes = await trpc("company.getCompanies", { userId: S.userId, perPage: 100 }).catch(() => null);
        const ids = (listRes?.items || listRes || []).map((x) => (typeof x === "string" ? x : x._id));
        const comps = (await Promise.all(ids.map((id) => trpc("company.getById", { companyId: id }).catch(() => null)))).filter(Boolean);
        for (const c of comps) {
          if (!c.itemCode) continue;
          S.produce.add(c.itemCode);
          for (const m of Object.keys(S.cfg.items[c.itemCode]?.needs || {})) {
            const arr = S.inputs.get(m) || []; if (!arr.includes(c.itemCode)) arr.push(c.itemCode); S.inputs.set(m, arr);
          }
        }
      }

      samplePrices();     // mantém histórico local como BACKUP (se o daemon cair, os sinais sobrevivem)
      computeSignals();
      S.err = null; S.at = Date.now();
    } catch (e) {
      S.err = e?.message || String(e);
    } finally { S.busy = false; }
    renderPanel();
    applyTiles();
  }

  // ---------- helpers de UI ----------
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const num = (n, d = 2) => Number(n || 0).toFixed(d);
  const fmtN = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "K" : String(Math.round(n || 0));
  const coins = (n, d = 2, cls = "wmh-gold") => `<span class="${cls}">${COIN}${num(n, d)}</span>`;
  const itemIcon = (code) => `<img class="wmh-item" src="/images/items/${encodeURIComponent(code)}.png?v=33" alt="${esc(code)}">`;

  function css() {
    if (document.getElementById("wmh-css")) return;
    const st = document.createElement("style");
    st.id = "wmh-css";
    st.textContent = `
.wmh-gold{color:#f0b13e;white-space:nowrap}
.wmh-sellc{color:#f0b13e}.wmh-buyc{color:#58c26e}.wmh-dim{color:#8494a8}.wmh-wait{color:#e0a952}
.wmh-up{color:#58c26e}.wmh-down{color:#e05252}.wmh-flat{color:#8494a8}
.wmh-coin{width:1em;height:1em;vertical-align:-0.14em;margin-right:2px;filter:drop-shadow(black 1px 1px 0px)}
.wmh-item{width:15px;height:15px;object-fit:contain;vertical-align:-3px;filter:drop-shadow(black 1px 1px 0px)}
.wmh-spark{display:inline-block;vertical-align:middle}

/* MARCADOR no tile do mercado: anel de cor (inset, não corta) + canto. Glance = SE é a minha
   jogada e SE o preço está bom. Detalhe ao clique (tooltip) e no painel "Ações". */
.wmh-tile{position:relative;border-radius:8px;transition:box-shadow .15s}
.wmh-tile.sell{box-shadow:inset 0 0 0 2px #f0b13e88}
.wmh-tile.buy{box-shadow:inset 0 0 0 2px #58c26e88}
.wmh-tile.act.sell{box-shadow:inset 0 0 0 2px #f0b13e,0 0 8px #f0b13e66}
.wmh-tile.act.buy{box-shadow:inset 0 0 0 2px #58c26e,0 0 8px #58c26e66}
.wmh-tile.wait{box-shadow:inset 0 0 0 2px #e0a95266}
.wmh-tag{position:absolute;top:-5px;left:-5px;z-index:6;pointer-events:none;
  font:800 9px/1.3 Inter,system-ui,sans-serif;padding:0 3px;border-radius:5px;
  color:#151a21;filter:drop-shadow(0 1px 1px #000a)}
.wmh-tag.sell{background:#f0b13e}.wmh-tag.buy{background:#58c26e}.wmh-tag.wait{background:#e0a952}

/* painel "Ações" — INTEGRADO no topo da secção Comércio (em fluxo; rola com a página) */
#wmh{margin:2px 0 12px;color:#dbe4ee;font:12px/1.45 Inter,system-ui,Segoe UI,sans-serif;user-select:none}
#wmh .box{background:#151a21f2;border:1px solid #2b3441;border-radius:11px;overflow:hidden}
#wmh .head{display:flex;align-items:center;gap:8px;padding:7px 11px;cursor:pointer;background:#1a212b}
#wmh .head b{font-size:11px;letter-spacing:.07em;color:#f0b13e;text-transform:uppercase;flex:1}
#wmh .btn{cursor:pointer;border:0;background:#232c38;color:#8494a8;border-radius:6px;padding:2px 7px;font-size:11px}
#wmh .body{max-height:56vh;overflow-y:auto;padding:4px 0 8px}
#wmh .body::-webkit-scrollbar{width:8px}#wmh .body::-webkit-scrollbar-thumb{background:#2b3441;border-radius:8px}
#wmh h4{margin:8px 11px 2px;font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:#617083}
#wmh .row{display:flex;align-items:center;gap:7px;padding:4px 11px}
#wmh .row:hover{background:#1a212b}
#wmh .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#wmh .why{color:#8494a8;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#wmh .foot{padding:5px 11px 7px;color:#617083;font-size:10px}
#wmh .err{padding:7px 11px;color:#e05252}

/* tooltip ao clique num tile */
#wmh-tip{position:fixed;z-index:99999;display:none;max-width:min(300px,92vw);
  background:#1a212bfa;border:1px solid #2b3441;border-radius:9px;padding:8px 11px;
  box-shadow:0 8px 24px #000b;backdrop-filter:blur(6px);
  font:500 11.5px/1.6 Inter,system-ui,Segoe UI,sans-serif;color:#dbe4ee}
#wmh-tip .wmh-dim{color:#8494a8}#wmh-tip>div+div{margin-top:3px}`;
    document.head.appendChild(st);
  }

  // ---------- tiles do mercado ----------
  const tileCode = (el) => (el.id.match(/^item-code-selector-(.+)$/) || [])[1]
    || el.querySelector('img[alt]')?.getAttribute("alt") || null;
  function marketTiles() {
    return [...document.querySelectorAll('[id^="item-code-selector-"]')];
  }
  // âncora do painel = contentor da grelha do mercado (LCA do 1º e último tile).
  // Injetamos o painel logo ANTES dele → topo da secção Comércio, em fluxo (rola com a página).
  function marketAnchor() {
    const tiles = marketTiles();
    if (tiles.length < 2) return null;
    const up = new Set();
    for (let n = tiles[0]; n && n !== document.body; n = n.parentElement) up.add(n);
    for (let n = tiles[tiles.length - 1]; n && n !== document.body; n = n.parentElement) if (up.has(n)) return n;
    return null;
  }
  function applyTiles() {
    css();
    for (const el of marketTiles()) {
      const code = tileCode(el);
      const s = code && S.sig[code];
      el.classList.add("wmh-tile");
      el.classList.remove("sell", "buy", "act", "wait");
      let tag = el.querySelector(":scope > .wmh-tag");
      if (!s || !s.side) { if (tag) tag.remove(); el.classList.remove("wmh-tile"); continue; }
      el.dataset.wmh = code;
      const cls = s.side; // sell | buy
      el.classList.add(cls);
      if (s.action) el.classList.add("act");
      else if (s.wait) el.classList.add("wait");
      // canto: ▲ vender / ▼ comprar (só quando é AÇÃO recomendada, p/ não poluir)
      if (s.action) {
        if (!tag) { tag = document.createElement("span"); tag.className = "wmh-tag"; el.appendChild(tag); }
        tag.className = "wmh-tag " + cls;
        tag.textContent = cls === "sell" ? "▲" : "▼";
      } else if (tag) tag.remove();
    }
  }

  // ---------- painel "Ações" ----------
  function actionList() {
    const arr = Object.entries(S.sig).filter(([, s]) => s.side).map(([code, s]) => ({ code, ...s }));
    // ordenar: ações primeiro, depois esperar, depois neutros; dentro, por |tendência|
    const rank = (s) => (s.action ? 0 : s.wait ? 1 : 2);
    arr.sort((a, b) => rank(a) - rank(b) || Math.abs(b.t || 0) - Math.abs(a.t || 0));
    return arr;
  }
  const verb = (s) => s.verb || (s.side === "sell" ? "vender?" : "comprar?"); // veredito vem do daemon
  // preço mostrado: caixa a abrir → valor de abrir; a vender → BID; a comprar → ASK (fallback: preço médio)
  const dealPrice = (s) => s.openBetter ? s.openVal : s.side === "sell" ? (s.bid ?? s.price) : (s.ask ?? s.price);
  function renderPanel() {
    css();
    const anchor = marketAnchor(); // contentor da grelha do mercado
    let root = document.getElementById("wmh");
    if (!anchor) { if (root) root.style.display = "none"; return; } // fora da tela do mercado
    if (!root) {
      root = document.createElement("div"); root.id = "wmh";
      root.addEventListener("click", (e) => {
        const id = e.target?.id;
        if (id === "wmh-min" || e.target.closest?.(".head")) { const u = load(LS.ui, {}); u.open = !u.open; save(LS.ui, u); renderPanel(); }
        else if (id === "wmh-re") { e.stopPropagation(); refresh(); }
      });
    }
    // injeta/reancora no topo da grelha (sobrevive aos re-renders do React)
    if (anchor.parentElement && root.nextElementSibling !== anchor) anchor.parentElement.insertBefore(root, anchor);
    root.style.display = "block";
    const ui = load(LS.ui, {}); const open = !!ui.open;
    const acts = actionList();
    const doNow = acts.filter((s) => s.action);
    const line = (s) => `<div class="row">
        <span class="nm">${itemIcon(s.code)} <span class="${s.side === "sell" ? "wmh-sellc" : "wmh-buyc"}">${verb(s)}</span> <span class="wmh-dim">${esc(s.code)}</span></span>
        <span>${coins(dealPrice(s), 3)}</span>${s.t != null ? (s.t > 1.5 ? `<span class="wmh-up">↗</span>` : s.t < -1.5 ? `<span class="wmh-down">↘</span>` : `<span class="wmh-flat">→</span>`) : ""}
      </div>${s.why.length ? `<div class="row" style="padding-top:0"><span class="why">↳ ${esc(s.why[0])}</span></div>` : ""}`;
    root.innerHTML = `
      <div class="box">
        <div class="head">
          <b>Mercado</b>
          <span class="wmh-dim">${doNow.length} ${doNow.length === 1 ? "ação" : "ações"}</span>
          ${S.err ? `<span class="wmh-down" title="${esc(S.err)}">⚠</span>` : ""}
          <button class="btn" id="wmh-re" title="atualizar">↻</button>
          <button class="btn" id="wmh-min">${open ? "▾" : "▸"}</button>
        </div>
        ${!open ? "" : `<div class="body">
          ${S.err ? `<div class="err">⚠ ${esc(S.err)}</div>` : ""}
          ${doNow.length ? `<h4>Fazer agora</h4>${doNow.map(line).join("")}` : `<div class="row wmh-dim">sem jogadas óbvias agora</div>`}
          ${acts.some((s) => s.wait) ? `<h4>Esperar</h4>${acts.filter((s) => s.wait).map(line).join("")}` : ""}
          <div class="foot">🟡 vender · 🟢 comprar · fonte: ${S.src === "daemon" ? `daemon ✓ · ${fmtN(S.dsamples?.tx || 0)} trades` : `API (daemon off) · ${S.hist.length} amostras locais`} · ${S.at ? new Date(S.at).toLocaleTimeString("pt-PT") : "…"}</div>
        </div>`}
      </div>`;
  }

  // ---------- tooltip ao clique num tile ----------
  function tipFor(code) {
    const s = S.sig[code]; if (!s) return "";
    const L = [];
    const head = s.side === "sell" ? `<span class="wmh-sellc">${verb(s)} ${esc(code)}</span>` : s.side === "buy" ? `<span class="wmh-buyc">${verb(s)} ${esc(code)}</span>` : esc(code);
    L.push(`<div><b>${head}</b> · ${coins(s.price, 3)} <span class="wmh-dim">mercado</span></div>`);
    if (s.openVal != null) L.push(`<div>🎁 abrir ≈ ${coins(s.openVal, 2)} <span class="wmh-dim">(gear a ${s.openMkt ? "preço de mercado" : "preço de craft — estimativa"})</span> · vender ≈ ${coins(s.bid ?? s.price, 2)} → <b>${s.openBetter ? "ABRIR" : "VENDER"}</b></div>`);
    if (s.bid != null || s.ask != null) {
      const spread = (s.bid && s.ask) ? ((s.ask - s.bid) / s.ask * 100) : null;
      L.push(`<div>${s.bid != null ? `vende ao bid <b class="wmh-sellc">${num(s.bid, 3)}</b>` : ""}${s.bid != null && s.ask != null ? " · " : ""}${s.ask != null ? `compra ao ask <b class="wmh-buyc">${num(s.ask, 3)}</b>` : ""}${spread != null ? ` <span class="wmh-dim">(spread ${spread.toFixed(1)}%)</span>` : ""}</div>`);
      if (s.buyQty != null || s.sellQty != null) L.push(`<div class="wmh-dim">profundidade: ${Number(s.buyQty || 0).toLocaleString()} compra / ${Number(s.sellQty || 0).toLocaleString()} venda</div>`);
    }
    // detalhe do daemon (trades reais): labels de tendência + estatísticas de janela
    if (s.labels.length) L.push(`<div>tendência 7D: <b>${s.labels.map(esc).join(" · ")}</b>${s.depthImb != null ? ` <span class="wmh-dim">· livro ${s.depthImb > 0 ? "+" : ""}${Math.round(s.depthImb)}% ${s.depthImb > 0 ? "compra" : "venda"}</span>` : ""}</div>`);
    if (s.trades7) L.push(`<div class="wmh-dim">7D: ${s.trades7} trades · vol ${Number(s.volume7 || 0).toLocaleString()}${s.vwap != null ? ` · VWAP ${num(s.vwap, 3)}` : ""}</div>`);
    if (s.d30 && s.d30.low != null) L.push(`<div class="wmh-dim">30D: ${num(s.d30.low, 3)}–${num(s.d30.high, 3)}${s.d30.pctile != null ? ` · agora ${Math.round(s.d30.pctile * 100)}% (0=barato, 100=caro)` : ""}</div>`);
    if (s.produce) L.push(`<div class="wmh-dim">produzes isto${s.marginPP != null ? ` · margem ${num(s.marginPP, 3)}/pp` : ""}</div>`);
    if (s.held) L.push(`<div class="wmh-dim">tens ${Number(s.held).toLocaleString()} em stock</div>`);
    if (s.consumers) L.push(`<div class="wmh-dim">input de: ${s.consumers.map(esc).join(", ")}</div>`);
    if (s.t != null) L.push(`<div>tendência: ${s.t > 1.5 ? `<span class="wmh-up">↗ +${s.t.toFixed(1)}%</span>` : s.t < -1.5 ? `<span class="wmh-down">↘ ${s.t.toFixed(1)}%</span>` : `<span class="wmh-flat">→ estável</span>`} ${spark(code)}</div>`);
    if (s.pctile != null) L.push(`<div class="wmh-dim">no intervalo recente: ${Math.round(s.pctile * 100)}% (0=barato, 100=caro)</div>`);
    if (s.why.length) L.push(`<div>${s.why.map((w) => "• " + esc(w)).join("<br>")}</div>`);
    if (!s.why.length) L.push(`<div class="wmh-dim">${series(code).length < 6 ? "a aprender o histórico de preços…" : "sem sinal forte agora"}</div>`);
    return L.join("");
  }
  function showTip(el) {
    const code = el.dataset.wmh; const html = code && tipFor(code); if (!html) return;
    let tip = document.getElementById("wmh-tip");
    if (!tip) { tip = document.createElement("div"); tip.id = "wmh-tip"; document.body.appendChild(tip); }
    tip.innerHTML = html; tip.style.display = "block"; tip.style.left = "0"; tip.style.top = "0";
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.max(8, Math.min(r.left, innerWidth - tw - 8));
    let y = r.bottom + 6; if (y + th > innerHeight - 8) y = r.top - th - 6;
    tip.style.left = x + "px"; tip.style.top = Math.max(8, y) + "px";
    S.tipCode = code;
  }
  const hideTip = () => { const t = document.getElementById("wmh-tip"); if (t) t.style.display = "none"; S.tipCode = null; };
  // clique num tile marcado → tooltip. NÃO bloqueamos o clique do jogo (deixa abrir o item);
  // só mostramos o nosso tooltip por cima. Fecha ao clicar fora.
  document.addEventListener("click", (e) => {
    const tile = e.target.closest?.(".wmh-tile[data-wmh]");
    if (tile) { S.tipCode === tile.dataset.wmh ? hideTip() : showTip(tile); }
    else if (!e.target.closest?.("#wmh-tip, #wmh")) hideTip();
  }, true);

  // ---------- arranque ----------
  const mo = new MutationObserver(() => { clearTimeout(mo._t); mo._t = setTimeout(() => { applyTiles(); renderPanel(); }, 400); });
  mo.observe(document.body, { childList: true, subtree: true });
  setInterval(() => { applyTiles(); renderPanel(); }, DOM_MS);
  setInterval(refresh, REFRESH_MS);
  refresh();
})();
