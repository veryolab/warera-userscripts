// ==UserScript==
// @name         WarEra Craft Advisor
// @namespace    local.warera.craft-advisor
// @version      0.5.7
// @description  Read-only crafting recommendations for WarEra inventory pages. Exports state.json for the WarEra bot.
// @author       Codex
// @match        https://app.warera.io/user/*/inventory
// @match        https://app.warera.io/me/inventory
// @connect      api2.warera.io
// @connect      api3.warera.io
// @connect      api4.warera.io
// @connect      api5.warera.io
// @connect      api6.warera.io
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraCraftAdvisor.user.js
// @downloadURL  https://raw.githubusercontent.com/veryolab/warera-userscripts/main/WarEraCraftAdvisor.user.js
// ==/UserScript==

(function () {
  "use strict";

  const API_BASES = [
    "https://api2.warera.io",
    "https://api3.warera.io",
    "https://api4.warera.io",
    "https://api5.warera.io",
    "https://api6.warera.io",
  ];

  // Auto-sync do estado para o bot local (se o state-server estiver a correr).
  // O bot: node src/state-server.js  →  escreve data/state.json a cada POST.
  const STATE_ENDPOINT = "http://127.0.0.1:8787/state";
  const AUTOSYNC_MS = 60000;

  const CRAFT_COSTS = {
    common: { scraps: 6, steel: 1 },
    uncommon: { scraps: 18, steel: 2 },
    rare: { scraps: 54, steel: 4 },
    epic: { scraps: 162, steel: 8 },
    legendary: { scraps: 486, steel: 16 },
    mythic: { scraps: 1458, steel: 32 },
  };

  const RARITY_ORDER = {
    common: 1,
    uncommon: 2,
    rare: 3,
    epic: 4,
    legendary: 5,
    mythic: 6,
  };

  const MODE_BUDGET = {
    conservative: 0.15,
    normal: 0.35,
    aggressive: 0.65,
    allin: 1,
  };

  const MODE_POLICY = {
    conservative: {
      label: "Safe",
      maxRarity: "rare",
      maxItems: 2,
      countOwnedMaterialsAsBudget: true,
      sort: "efficiency",
      objective: "efficiency",
      minDamageRatio: 0.65,
      investmentWeight: 0.35,
      rarityPenaltyWeight: 0.25,
      stockBalanceWeight: 1.2,
      scrapsReserveRatio: 0.15,
      steelReserveRatio: 0.35,
    },
    normal: {
      label: "Normal",
      maxRarity: "epic",
      maxItems: 3,
      countOwnedMaterialsAsBudget: false,
      sort: "balanced",
      objective: "balanced",
      minDamageRatio: 0.8,
      investmentWeight: 0.18,
      rarityPenaltyWeight: 0.12,
      stockBalanceWeight: 0.6,
      scrapsReserveRatio: 0.08,
      steelReserveRatio: 0.2,
    },
    aggressive: {
      label: "Push",
      maxRarity: "legendary",
      maxItems: 4,
      countOwnedMaterialsAsBudget: false,
      sort: "damage",
      objective: "damage",
      minDamageRatio: 0.95,
      investmentWeight: 0.06,
      rarityPenaltyWeight: 0.04,
      stockBalanceWeight: 0.2,
      scrapsReserveRatio: 0,
      steelReserveRatio: 0.05,
    },
    allin: {
      label: "All-in",
      maxRarity: "mythic",
      maxItems: 6,
      countOwnedMaterialsAsBudget: false,
      sort: "damage",
      objective: "allin",
      minDamageRatio: 1,
      investmentWeight: 0,
      rarityPenaltyWeight: 0,
      stockBalanceWeight: 0,
      scrapsReserveRatio: 0,
      steelReserveRatio: 0,
    },
  };

  const PERIOD_HOURS = {
    burst: 0,
    h8: 8,
    h24: 24,
  };

  const ROLL_MODE = {
    min: 0,
    average: 0.5,
    max: 1,
  };

  const SKILL_CONFIG = {
    attack: { base: 100, perLevel: 25 },
    precision: { base: 50, perLevel: 5 },
    criticalChance: { base: 10, perLevel: 5 },
    criticalDamages: { base: 100, perLevel: 20 },
    armor: { base: 0, perLevel: 6 },
    dodge: { base: 0, perLevel: 4 },
    health: { base: 100, perLevel: 10 },
    hunger: { base: 4, perLevel: 1 },
    lootChance: { base: 5, perLevel: 2 },
  };

  const FOOD = {
    none: 0,
    bread: 10,
    steak: 20,
    cookedFish: 30,
  };

  const AMMO = {
    none: 0,
    lightAmmo: 10,
    ammo: 20,
    heavyAmmo: 40,
  };
  const CONSUMABLE_CODES = [...Object.keys(FOOD).filter((code) => code !== "none"), ...Object.keys(AMMO).filter((code) => code !== "none")];

  const AMMO_WEAPONS = new Set(["gun", "rifle", "sniper", "tank", "jet"]);
  const EQUIPMENT_SLOTS = ["weapon", "helmet", "chest", "pants", "boots", "gloves"];
  const SLOT_STOCK_TARGETS = {
    weapon: { usable: 3, cheap: 2, premium: 1, comfortableCheap: 6 },
    helmet: { usable: 2, cheap: 1, premium: 1, comfortableCheap: 4 },
    chest: { usable: 2, cheap: 1, premium: 1, comfortableCheap: 4 },
    pants: { usable: 2, cheap: 1, premium: 1, comfortableCheap: 4 },
    boots: { usable: 2, cheap: 1, premium: 1, comfortableCheap: 4 },
    gloves: { usable: 2, cheap: 1, premium: 1, comfortableCheap: 4 },
  };
  const ITEM_ASSET_BASE = "/images/items/";
  const ITEM_ASSET_FALLBACK_BASE = "https://warerastats.io/items/";
  const BASIC_ITEM_RARITY = {
    bread: "common",
    steak: "uncommon",
    cookedFish: "rare",
    lightAmmo: "uncommon",
    ammo: "rare",
    heavyAmmo: "epic",
    scraps: "common",
    steel: "uncommon",
  };

  const MONEY_SVG = `
    <svg class="wca-money" stroke="currentColor" fill="currentColor" stroke-width="0" viewBox="0 0 24 24" height="1em" width="1em" aria-hidden="true">
      <path d="M12 5C7.031 5 2 6.546 2 9.5S7.031 14 12 14c4.97 0 10-1.546 10-4.5S16.97 5 12 5zm-5 9.938v3c1.237.299 2.605.482 4 .541v-3a21.166 21.166 0 0 1-4-.541zm6 .54v3a20.994 20.994 0 0 0 4-.541v-3a20.994 20.994 0 0 1-4 .541zm6-1.181v3c1.801-.755 3-1.857 3-3.297v-3c0 1.44-1.199 2.542-3 3.297zm-14 3v-3C3.2 13.542 2 12.439 2 11v3c0 1.439 1.2 2.542 3 3.297z"></path>
    </svg>
  `;

  const state = {
    mode: loadSetting("wca.mode", "normal"),
    period: loadSetting("wca.period", "burst"),
    roll: loadSetting("wca.roll", "average"),
    cashOverride: loadSetting("wca.cashOverride", ""),
    damageBonusOverride: loadSetting("wca.damageBonus", ""),
    last: null,
    loading: false,
    error: null,
  };

  addStyles();
  const panel = createPanel();
  document.body.appendChild(panel);
  initIconFallbacks(panel);

  run();
  setInterval(applyCraftHighlights, 2000);
  setInterval(syncLiquidMoney, 1500);
  setInterval(() => { if (state.last) pushState(state.last); }, AUTOSYNC_MS);

  let lastPath = location.pathname;
  setInterval(() => {
    if (lastPath !== location.pathname) {
      lastPath = location.pathname;
      setTimeout(run, 700);
    }
  }, 1000);

  async function run() {
    if (state.loading) return;
    state.loading = true;
    state.error = null;
    render();

    try {
      const userId = await getUserId();
      if (!userId) throw new Error("Nao consegui detectar o userId.");

      const [gameConfig, equipment, prices, user, myInventory] = await Promise.all([
        trpc("gameConfig.getGameConfig", {}),
        trpc("inventory.fetchCurrentEquipment", { userId }),
        trpc("itemTrading.getPrices", {}),
        trpc("user.getUserById", { userId }),
        trpc("inventory.getMyInventory", {}).catch(() => null),
      ]);

      const resources = readResources(myInventory);
      const consumables = readConsumables(myInventory);
      const liquidMoney = readLiquidMoney(user);
      const model = buildModel({ userId, gameConfig, equipment, prices, user, myInventory, resources, consumables, liquidMoney }, plannerOptionsFromState());
      state.last = model;
      applyCraftHighlights();
      pushState(model);
    } catch (error) {
      state.error = error && error.message ? error.message : String(error);
    } finally {
      state.loading = false;
      render();
    }
  }

  // ---- Export de estado para o bot (enxuto: só o que a API pública não vê) ----
  function slotFromCode(code) {
    const match = String(code || "").match(/^(helmet|chest|pants|boots|gloves)\d*$/i);
    return match ? match[1].toLowerCase() : "weapon";
  }
  function durabilityPct(it) {
    return it && it.maxState ? Math.round((it.state / it.maxState) * 100) : null;
  }
  function buildStateExport(m) {
    if (!m) return null;
    const inv = m.myInventory || {};
    const basics = (inv.items && inv.items.basics) || {};
    const owned = [...((inv.items && inv.items.weapons) || []), ...((inv.items && inv.items.equipments) || [])];

    // stock vendável: itens básicos com quantidade > 0
    const stock = Object.entries(basics)
      .filter(([, q]) => Number(q) > 0)
      .map(([code, qty]) => ({ code, qty: Number(qty) }))
      .sort((a, b) => b.qty - a.qty);

    // equipado: usa a mesma normalização do advisor (user.equipment + inventário + fallback endpoint).
    const equipped = {};
    const eq = m.equipment || {};
    for (const slot of EQUIPMENT_SLOTS) {
      const it = eq[slot];
      if (it && it.code) equipped[slot] = { id: it.id || null, code: it.code, skills: it.skills || {}, dur: durabilityPct(it) };
    }
    if (eq.ammo) equipped.ammo = eq.ammo;
    const equippedIds = new Set(Object.values(equipped).map((e) => e && e.id).filter(Boolean));
    const equippedCodes = new Set(Object.values(equipped).map((e) => e && e.code).filter(Boolean));

    // peças possuídas (com durabilidade), marcando as equipadas
    const ownedList = owned.map((it) => ({
      id: it._id || it.id || null,
      code: it.code, slot: slotFromCode(it.code), skills: it.skills || {},
      dur: durabilityPct(it),
      equipped: equippedIds.size ? equippedIds.has(it._id || it.id) : equippedCodes.has(it.code),
    }));

    // Nota: o buff de org (ex.: B.E.E.R) NÃO vive no perfil (user.getMe.buffs = null) nem tem
    // endpoint de org — é calculado no contexto da batalha. É global (~5%), não afeta a escolha de frente.
    return {
      exportedAt: new Date().toISOString(),
      userId: m.userId,
      username: m.username,
      money: m.liquidMoney,
      skills: m.combat ? m.combat.skillLevels : null, // níveis
      stock,        // [{code, qty}] vendável
      equipped,     // {slot: {code, skills, dur}}
      owned: ownedList, // [{code, slot, skills, dur, equipped}]
    };
  }

  // Auto-sync silencioso para o servidor local do bot (ignora falhas se não estiver a correr).
  function pushState(model) {
    const payload = buildStateExport(model);
    if (!payload) return;
    try {
      fetch(STATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).then((r) => { state.synced = r && r.ok ? Date.now() : state.synced; render(); })
        .catch(() => {});
    } catch (_) {}
  }

  // Export manual: download do ficheiro + cópia para o clipboard.
  function exportState() {
    const payload = buildStateExport(state.last);
    if (!payload) { state.error = "Sem dados ainda. Abre o inventário e espera carregar."; render(); return; }
    const json = JSON.stringify(payload, null, 2);
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "state.json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (_) {}
    try { if (navigator.clipboard) navigator.clipboard.writeText(json); } catch (_) {}
    pushState(state.last);
  }

  async function trpc(path, input) {
    const encoded = encodeURIComponent(JSON.stringify(input ?? {}));
    let lastError = null;

    for (const base of API_BASES) {
      try {
        const response = await fetch(`${base}/trpc/${path}?input=${encoded}`, {
          method: "GET",
          credentials: "include",
          headers: readWareraHeaders(),
        });

        if (!response.ok) {
          lastError = new Error(`${path}: HTTP ${response.status}`);
          continue;
        }

        const payload = await response.json();
        if (payload && payload.error) {
          throw new Error(payload.error.message || `${path}: API error`);
        }

        return payload && payload.result ? payload.result.data : payload;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(`${path}: request failed`);
  }

  function readWareraHeaders() {
    return {
      "x-vid": readCookie("vid") || "",
      "x-gr": readCookie("gr") || "",
    };
  }

  async function getUserId() {
    const match = location.pathname.match(/\/user\/([^/]+)\/inventory/);
    if (match) return match[1];

    try {
      const me = await trpc("user.getMe", {});
      return me && me._id;
    } catch (_) {
      return null;
    }
  }

  function buildModel({ userId, gameConfig, equipment, prices, user, myInventory, resources, consumables, liquidMoney }, options) {
    const items = gameConfig.items || {};
    const wealth = user && user.stats && user.stats.wealth ? user.stats.wealth : {};
    const plannerOptions = normalizePlannerOptions(options);
    const normalizedEquipment = normalizeEquipment(user, equipment, myInventory);
    const ownedEquipment = normalizeOwnedEquipment(myInventory);
    const inventoryBalance = buildInventoryBalance(ownedEquipment, normalizedEquipment, plannerOptions);
    const combat = buildCombatContext(user, normalizedEquipment, prices, plannerOptions, consumables);
    const candidates = buildCandidates(items, normalizedEquipment, prices, resources, combat, plannerOptions, ownedEquipment, inventoryBalance);
    const plan = buildPlan(candidates, resources, liquidMoney, prices, combat, plannerOptions);
    plan.build = buildCompleteBuild(plan.items, normalizedEquipment, plan.result);
    const avoid = buildAvoidList(candidates);

    return {
      userId,
      username: user && user.username,
      user,
      wealth,
      rankings: user && user.rankings,
      liquidMoney,
      resources,
      consumables,
      equipment: normalizedEquipment,
      ownedEquipment,
      inventoryBalance,
      rawEquipment: equipment,
      combat,
      prices,
      items,
      myInventory,
      options: plannerOptions,
      candidates,
      plan,
      avoid,
    };
  }

  function normalizeEquipment(user, equipment, myInventory) {
    const normalized = {};
    const inv = myInventory || {};
    const owned = [...((inv.items && inv.items.weapons) || []), ...((inv.items && inv.items.equipments) || [])];
    const byId = new Map(owned.map((it) => [it._id || it.id, it]).filter(([id]) => id));
    const userEquipment = (user && user.equipment) || {};

    for (const slot of EQUIPMENT_SLOTS) {
      const equippedId = userEquipment[slot];
      const fromInventory = equippedId ? byId.get(equippedId) : null;
      const fromEndpoint = equipment && equipment[slot] && typeof equipment[slot] === "object" ? equipment[slot] : null;
      const item = fromInventory || fromEndpoint;
      normalized[slot] = item ? normalizeEquipmentItem(item, slot, equippedId) : emptyEquipmentSlot(slot);
    }

    normalized.ammo = userEquipment.ammo || (equipment && equipment.ammo) || null;
    return normalized;
  }

  function normalizeEquipmentItem(item, slot, fallbackId) {
    return {
      id: item._id || item.id || fallbackId || null,
      code: item.code || null,
      name: item.name || item.label || item.title || item.code || null,
      slot,
      rarity: item.rarity || rarityFromCode(item.code),
      skills: item.skills || {},
      state: item.state,
      maxState: item.maxState,
      dur: item.dur,
    };
  }

  function emptyEquipmentSlot(slot) {
    return { id: null, code: null, name: null, slot, rarity: "", skills: {}, state: null, maxState: null };
  }

  function normalizeOwnedEquipment(myInventory) {
    const inv = myInventory || {};
    const owned = [...((inv.items && inv.items.weapons) || []), ...((inv.items && inv.items.equipments) || [])];
    return owned
      .map((it) => normalizeEquipmentItem(it, slotFromCode(it.code), it._id || it.id))
      .filter((it) => it.code && EQUIPMENT_SLOTS.includes(it.slot));
  }

  function buildInventoryBalance(ownedEquipment, equipment, options) {
    const rows = EQUIPMENT_SLOTS.map((slot) => {
      const target = SLOT_STOCK_TARGETS[slot] || { usable: 2, cheap: 1, comfortable: 4 };
      const items = ownedItemsForSlot(ownedEquipment, equipment, slot);
      const usable = items.filter((item) => itemDurabilityPercent(item) >= 30);
      const lowDur = items.filter((item) => itemDurabilityPercent(item) > 0 && itemDurabilityPercent(item) < 30);
      const broken = items.filter((item) => itemDurabilityPercent(item) <= 0);
      const cheapUsable = usable.filter((item) => isCheapRarity(item.rarity));
      const premiumUsable = usable.filter((item) => isPremiumRarity(item.rarity));
      const byRarity = {};
      for (const item of items) byRarity[item.rarity || "unknown"] = (byRarity[item.rarity || "unknown"] || 0) + 1;

      let status = "ok";
      let note = "ok";
      let needScore = 0;
      if (usable.length < target.usable) {
        status = "low";
        note = `poucos usaveis`;
        needScore += target.usable - usable.length;
      } else if (cheapUsable.length < target.cheap) {
        status = "low";
        note = `faltam baratos`;
        needScore += (target.cheap - cheapUsable.length) * 0.8;
      } else if (premiumUsable.length < target.premium) {
        status = "premium-low";
        note = `falta premium`;
        needScore += (target.premium - premiumUsable.length) * 0.35;
      } else if (cheapUsable.length > target.comfortableCheap) {
        status = "excess";
        note = `muitos baratos`;
        needScore -= Math.min(1.5, (cheapUsable.length - target.comfortableCheap) * 0.4);
      }
      if (lowDur.length && status === "ok") note = `${lowDur.length} quase partidos`;

      return {
        slot,
        total: items.length,
        usable: usable.length,
        cheapUsable: cheapUsable.length,
        premiumUsable: premiumUsable.length,
        lowDur: lowDur.length,
        broken: broken.length,
        byRarity,
        target,
        status,
        note,
        needScore,
      };
    });

    const warnings = rows
      .filter((row) => row.status !== "ok" || row.lowDur)
      .sort((a, b) => b.needScore - a.needScore || b.lowDur - a.lowDur)
      .slice(0, 3);

    return {
      rows,
      warnings,
      bySlot: Object.fromEntries(rows.map((row) => [row.slot, row])),
      mode: options && options.mode,
    };
  }

  function ownedItemsForSlot(ownedEquipment, equipment, slot) {
    const items = (ownedEquipment || []).filter((item) => item.slot === slot);
    const current = equipment && equipment[slot];
    if (current && current.code && !items.some((item) => item.id && current.id && item.id === current.id)) {
      items.push(current);
    }
    return items;
  }

  function craftInventoryNeed(slot, rarity, inventoryBalance, policy) {
    const row = inventoryBalance && inventoryBalance.bySlot && inventoryBalance.bySlot[slot];
    if (!row) return 0;
    const maxRank = RARITY_ORDER[policy && policy.maxRarity] || RARITY_ORDER.mythic;
    const rank = RARITY_ORDER[rarity] || 0;
    if (rank > maxRank) return -1;
    const cheapBonus = isCheapRarity(rarity) && row.cheapUsable < row.target.cheap ? 0.7 : 0;
    const premiumBonus = isPremiumRarity(rarity) && row.premiumUsable < row.target.premium ? 0.6 : 0;
    return row.needScore + cheapBonus + premiumBonus;
  }

  function itemDurabilityPercent(item) {
    if (!item) return 0;
    if (finiteNumber(Number(item.state)) && finiteNumber(Number(item.maxState)) && Number(item.maxState) > 0) {
      return Number(item.state) / Number(item.maxState) * 100;
    }
    if (finiteNumber(Number(item.dur))) return Number(item.dur);
    return 100;
  }

  function isCheapRarity(rarity) {
    return (RARITY_ORDER[rarity] || 0) > 0 && (RARITY_ORDER[rarity] || 0) <= RARITY_ORDER.rare;
  }

  function isPremiumRarity(rarity) {
    return (RARITY_ORDER[rarity] || 0) >= RARITY_ORDER.epic;
  }

  function buildCandidates(items, equipment, prices, resources, combat, options, ownedEquipment, inventoryBalance) {
    const candidates = [];
    const baseResult = combat.baseResult;
    const policy = plannerPolicy(options);

    for (const item of Object.values(items)) {
      if (!item || !item.code || !item.dynamicStats) continue;
      if (item.type !== "weapon" && item.type !== "equipment") continue;
      if (!CRAFT_COSTS[item.rarity]) continue;

      const slot = item.usage;
      if (!EQUIPMENT_SLOTS.includes(slot)) continue;
      const current = (equipment && equipment[slot]) || emptyEquipmentSlot(slot);

      const analysis = analyzeUpgrade(item, current, combat, options);
      const cost = CRAFT_COSTS[item.rarity];
      const costValue = cost.scraps * (prices.scraps || 1) + cost.steel * (prices.steel || 0);
      const canCraft = resourceCraftCount(resources, cost);
      const buyNeedValue = materialBuyNeed(cost, resources, prices).total;
      const riskPenalty = analysis.damageChance >= 1 ? 1 : 0.65 + analysis.damageChance * 0.35;
      const inventoryNeed = craftInventoryNeed(slot, item.rarity, inventoryBalance, policy);
      const score = costValue > 0
        ? ((analysis.damageGain * riskPenalty) / costValue) * (1 + inventoryNeed * 0.3)
        : 0;

      candidates.push({
        code: item.code,
        name: item.name || item.label || item.title || item.code,
        slot,
        rarity: item.rarity,
        currentCode: current.code,
        currentState: current.state,
        currentMaxState: current.maxState,
        maxState: item.maxState || current.maxState || null,
        cost,
        costValue,
        buyNeedValue,
        canCraft,
        source: "craft",
        inventoryNeed,
        ...analysis,
        baseResult,
        score,
      });
    }

    for (const owned of ownedEquipment || []) {
      const current = (equipment && equipment[owned.slot]) || emptyEquipmentSlot(owned.slot);
      if (owned.id && current.id && owned.id === current.id) continue;
      const analysis = analyzeFixedItem(owned, current, combat);
      const costValue = craftValueForItem(owned, prices);
      const score = costValue > 0 ? analysis.result.totalDamage / costValue : analysis.result.totalDamage;
      candidates.push({
        code: owned.code,
        name: owned.name || owned.code,
        slot: owned.slot,
        rarity: owned.rarity,
        id: owned.id,
        currentCode: current.code,
        currentState: current.state,
        currentMaxState: current.maxState,
        state: owned.state,
        maxState: owned.maxState,
        cost: { scraps: 0, steel: 0 },
        costValue,
        buyNeedValue: 0,
        canCraft: null,
        source: "owned",
        inventoryNeed: 0,
        ...analysis,
        baseResult,
        score,
      });
    }

    return candidates
      .filter((candidate) => candidate.result && candidate.result.totalDamage > 0)
      .sort((a, b) => b.score - a.score || b.damageGain - a.damageGain || RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity]);
  }

  function analyzeUpgrade(item, current, combat, options) {
    let totalStatChance = 0;
    const details = [];
    const statNames = Object.keys(item.dynamicStats || {});
    const rollBonuses = {};
    const bestBonuses = {};

    for (const stat of statNames) {
      const range = item.dynamicStats[stat];
      const min = Number(range[0]);
      const max = Number(range[1]);
      const currentValue = Number((current.skills && current.skills[stat]) || 0);
      const dist = integerDistribution(min, max);
      const gains = dist.map((value) => Math.max(0, value - currentValue));
      const chance = gains.filter((gain) => gain > 0).length / gains.length;
      const rolled = rollValue(min, max, options);

      rollBonuses[stat] = rolled;
      bestBonuses[stat] = max;
      totalStatChance += chance;

      details.push({ stat, min, max, current: currentValue, rolled, chance });
    }

    const simulated = simulateCandidate(combat, item.usage, item.code, rollBonuses);
    const bestSimulated = simulateCandidate(combat, item.usage, item.code, bestBonuses);

    return {
      chance: statNames.length ? totalStatChance / statNames.length : 0,
      damageChance: simulated.damageGain > 0 ? 1 : bestSimulated.damageGain > 0 ? 0.5 : 0,
      damageGain: simulated.damageGain,
      bestDamageGain: bestSimulated.damageGain,
      result: simulated.result,
      bestResult: bestSimulated.result,
      rolledSkills: rollBonuses,
      details,
    };
  }

  function analyzeFixedItem(item, current, combat) {
    const skills = item.skills || {};
    const simulated = simulateCandidate(combat, item.slot, item.code, skills);
    const details = [];
    for (const stat of Object.keys(SKILL_CONFIG)) {
      const currentValue = Number((current.skills && current.skills[stat]) || 0);
      const value = Number(skills[stat] || 0);
      if (value || currentValue) details.push({ stat, min: value, max: value, current: currentValue, rolled: value, chance: value > currentValue ? 1 : 0 });
    }
    return {
      chance: 1,
      damageChance: simulated.damageGain > 0 ? 1 : 0,
      damageGain: simulated.damageGain,
      bestDamageGain: simulated.damageGain,
      result: simulated.result,
      bestResult: simulated.result,
      rolledSkills: skills,
      details,
    };
  }

  function buildPlan(candidates, resources, liquidMoney, prices, combat, options) {
    const plannerOptions = normalizePlannerOptions(options);
    const policy = plannerPolicy(plannerOptions);
    const budgetRatio = MODE_BUDGET[plannerOptions.mode] ?? MODE_BUDGET.normal;
    const cashBudget = finiteNumber(liquidMoney)
      ? plannerOptions.manualCashBudget ? liquidMoney : liquidMoney * budgetRatio
      : null;
    const resourcesSafe = {
      scraps: finiteNumber(resources.scraps) ? resources.scraps : 0,
      steel: finiteNumber(resources.steel) ? resources.steel : 0,
    };
    const bySlot = EQUIPMENT_SLOTS.map((slot) => {
      return candidates
        .filter((candidate) => candidate.slot === slot && candidateViableForPlan(candidate, combat, policy) && candidateAllowedByPolicy(candidate, policy, cashBudget))
        .sort((a, b) => compareCandidatesForPolicy(a, b, policy))
        .slice(0, 8);
    });

    const baseObjective = planObjective(policy, combat.baseResult, combat, [], 0, resourcesSafe, prices);
    let best = {
      combo: [],
      result: combat.baseResult,
      damageGain: 0,
      totalCostValue: 0,
      buyNeed: { scraps: 0, steel: 0, total: 0 },
      adjustedCost: combat.baseResult.totalCost || 0,
      stockPressure: 0,
      objective: baseObjective,
    };

    function visit(slotIndex, combo) {
      if (slotIndex >= bySlot.length) {
        const totals = comboMaterialTotals(combo);
        const buyNeed = materialBuyNeed(totals, resourcesSafe, prices);
        if (cashBudget !== null && buyNeed.total > cashBudget) return;

        const evaluated = evaluateCandidateCombo(combo, combat, prices);
        const damageGain = evaluated.totalDamage - combat.baseResult.totalDamage;
        const totalCostValue = totals.scraps * (Number(prices.scraps) || 0) + totals.steel * (Number(prices.steel) || 0);
        if (policy.countOwnedMaterialsAsBudget && cashBudget !== null && totalCostValue > cashBudget) return;
        const stockPressure = materialStockPressure(totals, resourcesSafe, prices, policy);
        const objective = planObjective(policy, evaluated, combat, combo, totalCostValue, resourcesSafe, prices);
        const adjustedCost = adjustedPlanCost(policy, evaluated, combo, totalCostValue, resourcesSafe, prices);
        const beatsObjective = objective > best.objective;
        const beatsTie = objective === best.objective && damageGain > best.damageGain;
        const beatsCostTie = objective === best.objective && damageGain === best.damageGain && buyNeed.total < best.buyNeed.total;
        if (beatsObjective || beatsTie || beatsCostTie) {
          best = { combo: combo.slice(), result: evaluated, damageGain, totalCostValue, buyNeed, adjustedCost, stockPressure, objective };
        }
        return;
      }

      visit(slotIndex + 1, combo);
      for (const candidate of bySlot[slotIndex]) {
        if (policy.maxItems && combo.length >= policy.maxItems) continue;
        combo.push(candidate);
        visit(slotIndex + 1, combo);
        combo.pop();
      }
    }

    visit(0, []);

    let remainingScraps = resourcesSafe.scraps;
    let remainingSteel = resourcesSafe.steel;
    let remainingCash = cashBudget === null ? null : cashBudget;
    const plan = best.combo
      .slice()
      .sort((a, b) => (b.damageGain / Math.max(0.001, b.costValue)) - (a.damageGain / Math.max(0.001, a.costValue)))
      .map((candidate) => {
        const buyNeed = materialBuyNeed(candidate.cost, { scraps: remainingScraps, steel: remainingSteel }, prices);
        remainingScraps = Math.max(0, remainingScraps - candidate.cost.scraps);
        remainingSteel = Math.max(0, remainingSteel - candidate.cost.steel);
        if (remainingCash !== null) remainingCash -= buyNeed.total;
        return { ...candidate, buyNeed };
      });

    return {
      items: plan,
      budgetRatio,
      manualCashBudget: plannerOptions.manualCashBudget,
      cashBudget,
      remainingScraps,
      remainingSteel,
      remainingCash,
      totalDamageGain: best.damageGain,
      totalCostValue: best.totalCostValue,
      adjustedCost: best.adjustedCost,
      stockPressure: best.stockPressure,
      objective: best.objective,
      result: best.result,
      policy,
    };
  }

  function plannerOptionsFromState() {
    return normalizePlannerOptions({ mode: state.mode, period: state.period, roll: state.roll, manualCashBudget: hasManualCashBudget(), damageBonus: readDamageBonusOverride() });
  }

  function normalizePlannerOptions(options) {
    return {
      mode: options && MODE_BUDGET[options.mode] !== undefined ? options.mode : "normal",
      period: options && PERIOD_HOURS[options.period] !== undefined ? options.period : "burst",
      roll: options && ROLL_MODE[options.roll] !== undefined ? options.roll : "average",
      manualCashBudget: !!(options && options.manualCashBudget),
      damageBonus: finiteNumber(Number(options && options.damageBonus)) ? Number(options.damageBonus) : 0,
    };
  }

  function plannerPolicy(options) {
    const mode = options && options.mode ? options.mode : "normal";
    return MODE_POLICY[mode] || MODE_POLICY.normal;
  }

  function candidateAllowedByPolicy(candidate, policy, cashBudget) {
    const maxRank = RARITY_ORDER[policy.maxRarity] || RARITY_ORDER.mythic;
    if ((RARITY_ORDER[candidate.rarity] || 0) > maxRank) return false;
    if (candidate.source === "craft" && policy.countOwnedMaterialsAsBudget && cashBudget !== null && candidate.costValue > cashBudget) return false;
    return true;
  }

  function candidateViableForPlan(candidate, combat, policy) {
    if (!candidate || !candidate.result) return false;
    const baseDamage = combat && combat.baseResult ? Number(combat.baseResult.totalDamage) || 0 : 0;
    const resultDamage = Number(candidate.result.totalDamage) || 0;
    if (candidate.source !== "owned") return candidate.bestDamageGain > 0;
    if (candidate.damageGain > 0) return true;
    const minRatio = policy && finiteNumber(policy.minDamageRatio) ? policy.minDamageRatio : 1;
    return baseDamage <= 0 ? resultDamage > 0 : resultDamage >= baseDamage * minRatio;
  }

  function compareCandidatesForPolicy(a, b, policy) {
    if (policy.sort === "efficiency") return candidateEfficiency(b) - candidateEfficiency(a) || rarityAsc(a, b) || b.damageGain - a.damageGain;
    if (policy.sort === "balanced") return b.score - a.score || b.damageGain - a.damageGain || rarityAsc(a, b);
    return b.damageGain - a.damageGain || b.score - a.score || RARITY_ORDER[b.rarity] - RARITY_ORDER[a.rarity];
  }

  function candidateEfficiency(candidate) {
    const damage = candidate && candidate.result ? Number(candidate.result.totalDamage) || 0 : 0;
    const cost = Number(candidate && candidate.costValue) || 0;
    const rarityDrag = 1 + Math.max(0, (RARITY_ORDER[candidate.rarity] || 0) - RARITY_ORDER.rare) * 0.35;
    return damage / Math.max(1, cost * rarityDrag);
  }

  function rarityAsc(a, b) {
    return (RARITY_ORDER[a.rarity] || 0) - (RARITY_ORDER[b.rarity] || 0);
  }

  function planObjective(policy, result, combat, combo, totalCostValue, resources, prices) {
    const damage = Number(result && result.totalDamage) || 0;
    if (damage <= 0) return -Infinity;
    if (policy.objective === "allin") return damage;

    const adjustedCost = adjustedPlanCost(policy, result, combo, totalCostValue, resources, prices);
    if (policy.objective === "efficiency") {
      return damage / Math.max(1, adjustedCost);
    }
    if (policy.objective === "balanced") {
      return damage - adjustedCost * 0.08;
    }
    return damage - adjustedCost * 0.015;
  }

  function adjustedPlanCost(policy, result, combo, totalCostValue, resources, prices) {
    const totals = comboMaterialTotals(combo);
    return (Number(result && result.totalCost) || 0)
      + totalCostValue * (Number(policy && policy.investmentWeight) || 0)
      + materialStockPressure(totals, resources, prices, policy)
      + strategicRarityPenalty(combo, policy)
      + strategicWearPenalty(result, policy);
  }

  function materialStockPressure(totals, resources, prices, policy) {
    const weight = Number(policy && policy.stockBalanceWeight) || 0;
    if (!weight || !totals) return 0;

    const scrapsStock = Math.max(0, Number(resources && resources.scraps) || 0);
    const steelStock = Math.max(0, Number(resources && resources.steel) || 0);
    const scrapsUse = Math.max(0, Number(totals.scraps) || 0);
    const steelUse = Math.max(0, Number(totals.steel) || 0);
    const scrapsPrice = Number(prices && prices.scraps) || 0;
    const steelPrice = Number(prices && prices.steel) || 0;

    const scrapsReserve = scrapsStock * (Number(policy.scrapsReserveRatio) || 0);
    const steelReserve = steelStock * (Number(policy.steelReserveRatio) || 0);
    const usableScraps = Math.max(0, scrapsStock - scrapsReserve);
    const usableSteel = Math.max(0, steelStock - steelReserve);
    const overScraps = Math.max(0, scrapsUse - usableScraps);
    const overSteel = Math.max(0, steelUse - usableSteel);
    const scrapsPressure = Math.pow(scrapsUse / Math.max(1, scrapsStock), 2) * scrapsUse * scrapsPrice;
    const steelPressure = Math.pow(steelUse / Math.max(1, steelStock), 2) * steelUse * steelPrice * 1.6;
    const reservePenalty = overScraps * scrapsPrice + overSteel * steelPrice * 1.6;

    return (reservePenalty + (scrapsPressure + steelPressure) * 0.25) * weight;
  }

  function strategicRarityPenalty(combo, policy) {
    const weight = Number(policy && policy.rarityPenaltyWeight) || 0;
    if (!weight) return 0;
    return (combo || []).reduce((total, candidate) => {
      const rank = RARITY_ORDER[candidate.rarity] || 0;
      const premiumRank = Math.max(0, rank - RARITY_ORDER.rare);
      return total + (Number(candidate.costValue) || 0) * premiumRank * weight;
    }, 0);
  }

  function strategicWearPenalty(result, policy) {
    const weight = Number(policy && policy.rarityPenaltyWeight) || 0;
    const maxRank = RARITY_ORDER[policy && policy.maxRarity] || RARITY_ORDER.mythic;
    if (!weight || !result || !Array.isArray(result.durabilityWear)) return 0;
    return result.durabilityWear.reduce((total, wear) => {
      const rank = RARITY_ORDER[wear.rarity] || 0;
      const premiumRank = Math.max(0, rank - maxRank);
      return total + (Number(wear.cost) || 0) * premiumRank * weight * 2;
    }, 0);
  }

  function comboMaterialTotals(combo) {
    return combo.reduce((totals, candidate) => {
      totals.scraps += candidate.cost.scraps;
      totals.steel += candidate.cost.steel;
      return totals;
    }, { scraps: 0, steel: 0 });
  }

  function evaluateCandidateCombo(combo, combat, prices) {
    const equipmentBonuses = { ...combat.equipmentBonuses };
    let weaponCode = combat.weaponCode;

    for (const candidate of combo) {
      const currentSlotBonuses = combat.slotBonuses[candidate.slot] || {};
      for (const [stat, value] of Object.entries(currentSlotBonuses)) {
        equipmentBonuses[stat] = (equipmentBonuses[stat] || 0) - Number(value || 0);
      }
      for (const [stat, value] of Object.entries(candidate.rolledSkills || {})) {
        equipmentBonuses[stat] = (equipmentBonuses[stat] || 0) + Number(value || 0);
      }
      if (candidate.slot === "weapon") weaponCode = candidate.code;
    }

    const stats = buildCombatStats(combat.skillLevels, equipmentBonuses);
    const result = optimizeConsumables(stats, weaponCode, combat.period, prices, combat.consumables, combat.policy, combat.damageBonus);
    result.durabilityCost = estimateDurabilityCost(combo, combat, result.totalHits, prices);
    result.durabilityBreaks = estimateDurabilityCost.lastBreaks || [];
    result.durabilityWear = estimateDurabilityCost.lastWear || [];
    result.totalCost = result.consumableCost + result.durabilityCost;
    annotateCombatResult(result);
    return result;
  }

  function buildCompleteBuild(planItems, equipment, result) {
    const plannedBySlot = new Map(planItems.map((item) => [item.slot, item]));
    const wearBySlot = new Map((result?.durabilityWear || []).map((w) => [w.slot, w]));

    return EQUIPMENT_SLOTS.map((slot) => {
      const planned = plannedBySlot.get(slot);
      const current = equipment && equipment[slot] && typeof equipment[slot] !== "string"
        ? equipment[slot]
        : null;
      const wear = wearBySlot.get(slot);

      if (planned) {
        const action = planned.source === "owned" ? "equip" : "craft";
        return {
          action,
          slot,
          code: planned.code,
          name: planned.name,
          rarity: planned.rarity,
          skills: planned.rolledSkills || {},
          damageGain: planned.damageGain,
          details: planned.details,
          buyNeed: planned.buyNeed,
          cost: planned.cost,
          costValue: planned.costValue,
          currentCode: current && current.code,
          currentState: action === "equip" ? planned.state : current && current.state,
          currentMaxState: action === "equip" ? planned.maxState : current && current.maxState,
          wear,
        };
      }

      return {
        action: "keep",
        slot,
        code: current && current.code,
        name: current && (current.name || current.code),
        rarity: current && (current.rarity || rarityFromCode(current.code)),
        skills: current && current.skills ? current.skills : {},
        currentState: current && current.state,
        currentMaxState: current && current.maxState,
        wear,
      };
    });
  }

  function recomputePlan(model, options) {
    model.options = normalizePlannerOptions(options || plannerOptionsFromState());
    model.combat = buildCombatContext(model.user, model.equipment, model.prices, model.options, model.consumables);
    model.inventoryBalance = buildInventoryBalance(model.ownedEquipment, model.equipment, model.options);
    model.candidates = buildCandidates(model.items, model.equipment, model.prices, model.resources, model.combat, model.options, model.ownedEquipment, model.inventoryBalance);
    model.plan = buildPlan(model.candidates, model.resources, model.liquidMoney, model.prices, model.combat, model.options);
    model.plan.build = buildCompleteBuild(model.plan.items, model.equipment, model.plan.result);
    model.avoid = buildAvoidList(model.candidates);
    return model.plan;
  }

  function buildAvoidList(candidates) {
    const bySlot = new Map();
    for (const candidate of candidates) {
      if (!bySlot.has(candidate.slot)) bySlot.set(candidate.slot, []);
      bySlot.get(candidate.slot).push(candidate);
    }

    const avoid = [];
    for (const [slot, list] of bySlot) {
      const zeroOrBad = list
        .filter((candidate) => candidate.source === "craft")
        .filter((candidate) => candidate.damageGain <= 0)
        .sort((a, b) => RARITY_ORDER[a.rarity] - RARITY_ORDER[b.rarity]);
      if (zeroOrBad[0]) avoid.push({ slot, ...zeroOrBad[0] });
    }

    return avoid.slice(0, 4);
  }

  function readResources(myInventory) {
    const basics = myInventory && myInventory.items && myInventory.items.basics;
    const fromApi = {
      scraps: basics && finiteNumber(basics.scraps) ? basics.scraps : null,
      steel: basics && finiteNumber(basics.steel) ? basics.steel : null,
    };

    return {
      scraps: fromApi.scraps ?? readResourceFromCraftDom("scraps"),
      steel: fromApi.steel ?? readResourceFromCraftDom("steel"),
    };
  }

  function readConsumables(myInventory) {
    const basics = myInventory && myInventory.items && myInventory.items.basics;
    if (!basics) return null;
    const out = {};
    for (const code of CONSUMABLE_CODES) out[code] = basics && finiteNumber(Number(basics[code])) ? Number(basics[code]) : 0;
    return out;
  }

  function readResourceFromCraftDom(code) {
    const imgs = Array.from(document.querySelectorAll(`img[alt="${cssEscape(code)}"]`));
    for (const img of imgs.reverse()) {
      const container = closestWithText(img, "/");
      if (!container) continue;
      const text = normalizeText(container.textContent);
      const match = text.match(/([0-9]+(?:\.[0-9]+)?[KMB]?)\s*\/\s*([0-9]+(?:\.[0-9]+)?[KMB]?)/i);
      if (match) return parseWareraNumber(match[1]);
    }
    return null;
  }

  function readMoney() {
    const el = document.querySelector("#money");
    return el ? parseWareraNumber(el.textContent) : null;
  }

  function readLiquidMoney(user) {
    const override = parseWareraNumber(state.cashOverride);
    if (finiteNumber(override)) return override;

    const fromDom = readMoney();
    if (finiteNumber(fromDom)) return fromDom;

    return null;
  }

  function hasManualCashBudget() {
    return finiteNumber(parseWareraNumber(state.cashOverride));
  }

  function readDamageBonusOverride() {
    const raw = String(state.damageBonusOverride || "").replace("%", "").replace(",", ".").trim();
    if (!raw) return 0;
    const value = Number(raw.replace(/^\+/, ""));
    return Number.isFinite(value) ? value : 0;
  }

  function syncLiquidMoney() {
    if (state.loading || !state.last || state.cashOverride.trim()) return;

    const fromDom = readMoney();
    if (!finiteNumber(fromDom) || fromDom === state.last.liquidMoney) return;

    state.last.liquidMoney = fromDom;
    recomputePlan(state.last);
    render();
    applyCraftHighlights();
  }

  function resourceCraftCount(resources, cost) {
    if (!resources || !finiteNumber(resources.scraps) || !finiteNumber(resources.steel)) return null;
    return Math.max(0, Math.min(
      Math.floor(resources.scraps / cost.scraps),
      Math.floor(resources.steel / cost.steel),
    ));
  }

  function buildCombatContext(user, equipment, prices, options, consumables) {
    const policy = plannerPolicy(options);
    const skillLevels = readSkillLevels(user);
    const slotBonuses = readEquipmentSlotBonuses(equipment);
    const equipmentBonuses = sumSlotBonuses(slotBonuses);
    const baseStats = buildCombatStats(skillLevels, equipmentBonuses);
    const weaponCode = equipment && equipment.weapon && equipment.weapon.code;
    const period = options && PERIOD_HOURS[options.period] !== undefined ? options.period : "burst";
    const damageBonus = Number(options && options.damageBonus) || 0;
    const baseResult = optimizeConsumables(baseStats, weaponCode, period, prices, consumables, policy, damageBonus);
    baseResult.durabilityCost = estimateDurabilityCost([], { equipment }, baseResult.totalHits, prices);
    baseResult.durabilityBreaks = estimateDurabilityCost.lastBreaks || [];
    baseResult.durabilityWear = estimateDurabilityCost.lastWear || [];
    baseResult.totalCost = baseResult.consumableCost + baseResult.durabilityCost;
    annotateCombatResult(baseResult);

    return {
      skillLevels,
      equipmentBonuses,
      slotBonuses,
      equipment,
      baseStats,
      baseResult,
      weaponCode,
      period,
      policy,
      damageBonus,
      consumables: consumables || {},
    };
  }

  function readSkillLevels(user) {
    const levels = {};
    for (const skill of Object.keys(SKILL_CONFIG)) {
      levels[skill] = findSkillLevel(user, skill);
    }
    return levels;
  }

  function findSkillLevel(user, skill) {
    const collections = [
      user && user.skills,
      user && user.playInfo && user.playInfo.skills,
      user && user.stats && user.stats.skills,
    ];

    for (const collection of collections) {
      const fromCollection = readSkillFromCollection(collection, skill);
      if (fromCollection !== null) return fromCollection;
    }

    const candidates = [
      user && user.skills && user.skills[skill],
      user && user.playInfo && user.playInfo.skills && user.playInfo.skills[skill],
      user && user.playInfo && user.playInfo[skill],
      user && user.stats && user.stats.skills && user.stats.skills[skill],
    ];

    for (const entry of candidates) {
      if (finiteNumber(entry)) return entry;
      if (entry && finiteNumber(entry.level)) return entry.level;
      if (entry && finiteNumber(entry.currentLevel)) return entry.currentLevel;
    }

    return 0;
  }

  function readSkillFromCollection(collection, skill) {
    if (!collection) return null;
    if (Array.isArray(collection)) {
      const entry = collection.find((item) => {
        return item && (item.name === skill || item.code === skill || item.skill === skill || item.type === skill);
      });
      return readSkillEntryLevel(entry);
    }
    return readSkillEntryLevel(collection[skill]);
  }

  function readSkillEntryLevel(entry) {
    if (finiteNumber(entry)) return entry;
    if (entry && finiteNumber(entry.level)) return entry.level;
    if (entry && finiteNumber(entry.currentLevel)) return entry.currentLevel;
    if (entry && finiteNumber(entry.value) && finiteNumber(entry.perLevel) && finiteNumber(entry.base)) {
      return Math.max(0, Math.round((entry.value - entry.base) / entry.perLevel));
    }
    return null;
  }

  function readEquipmentSlotBonuses(equipment) {
    const slotBonuses = {};
    for (const slot of EQUIPMENT_SLOTS) {
      const item = equipment && equipment[slot];
      if (!item || typeof item === "string" || !item.skills) continue;
      slotBonuses[slot] = {};
      for (const [stat, value] of Object.entries(item.skills)) {
        if (!finiteNumber(Number(value))) continue;
        slotBonuses[slot][stat] = Number(value);
      }
    }
    return slotBonuses;
  }

  function sumSlotBonuses(slotBonuses) {
    const bonuses = {};
    for (const skills of Object.values(slotBonuses || {})) {
      for (const [stat, value] of Object.entries(skills || {})) {
        bonuses[stat] = (bonuses[stat] || 0) + Number(value || 0);
      }
    }
    return bonuses;
  }

  function buildCombatStats(skillLevels, equipmentBonuses) {
    const stats = {};
    for (const [skill, config] of Object.entries(SKILL_CONFIG)) {
      stats[skill] = config.base + config.perLevel * (Number(skillLevels[skill]) || 0) + (Number(equipmentBonuses[skill]) || 0);
    }
    return stats;
  }

  function simulateCandidate(combat, slot, itemCode, slotBonuses) {
    const equipmentBonuses = { ...combat.equipmentBonuses };
    const currentSlotBonuses = combat.slotBonuses[slot] || {};

    for (const [stat, value] of Object.entries(currentSlotBonuses)) {
      equipmentBonuses[stat] = (equipmentBonuses[stat] || 0) - value;
    }
    for (const [stat, value] of Object.entries(slotBonuses)) {
      equipmentBonuses[stat] = (equipmentBonuses[stat] || 0) + Number(value || 0);
    }

    const stats = buildCombatStats(combat.skillLevels, equipmentBonuses);
    const weaponCode = slot === "weapon" ? itemCode : combat.weaponCode;
    const result = optimizeConsumables(stats, weaponCode, combat.period, {}, combat.consumables, combat.policy, combat.damageBonus);

    return {
      result,
      damageGain: result.totalDamage - combat.baseResult.totalDamage,
    };
  }

  function optimizeConsumables(stats, weaponCode, period, prices, consumables, policy, damageBonus) {
    const canUseAmmo = AMMO_WEAPONS.has(weaponCode);
    let best = null;

    for (const [foodCode, foodPercent] of Object.entries(FOOD)) {
      for (const [ammoCode, ammoPercent] of Object.entries(AMMO)) {
        if (!canUseAmmo && ammoCode !== "none") continue;
        const result = evaluateCombat(stats, period, foodCode, foodPercent, ammoCode, ammoPercent, prices, consumables, damageBonus);
        if (!best || consumableObjective(result, policy) > consumableObjective(best, policy)) best = result;
      }
    }

    return best || evaluateCombat(stats, period, "bread", FOOD.bread, "none", 0, prices, consumables, damageBonus);
  }

  function consumableObjective(result, policy) {
    if (!result) return -Infinity;
    const objective = policy && policy.objective ? policy.objective : "balanced";
    const damage = Number(result.totalDamage) || 0;
    const cost = Number(result.consumableCost) || 0;
    if (objective === "efficiency") return damage / Math.max(1, cost);
    if (objective === "balanced") return damage - cost * 0.08;
    if (objective === "damage") return damage - cost * 0.015;
    return damage;
  }

  function evaluateCombat(stats, period, foodCode, foodPercent, ammoCode, ammoPercent, prices, consumables, damageBonus) {
    const damagePerHit = averageDamagePerHit(stats) * (1 + ammoPercent / 100) * (1 + (Number(damageBonus) || 0) / 100);
    const healthCost = healthCostPerHit(stats.armor, stats.dodge);
    const periodHours = PERIOD_HOURS[period] || 0;
    const regenHealth = periodHours > 0 ? stats.health * 0.1 * periodHours : 0;
    const baseHealthPool = stats.health + regenHealth;
    const plannedFoodCharges = Math.max(0, stats.hunger + (periodHours > 0 ? stats.hunger * 0.1 * periodHours : 0));
    const plannedHealthPool = baseHealthPool + plannedFoodCharges * foodPercent;
    const plannedHits = Math.max(0, Math.floor(plannedHealthPool / healthCost));
    const stockLimit = combatStockLimit({
      plannedHits,
      foodCode,
      foodHp: foodPercent,
      plannedFoodCharges,
      baseHealthPool,
      healthCost,
      ammoCode,
      damageBonus: Number(damageBonus) || 0,
      consumables,
    });
    const totalHits = stockLimit.totalHits;
    const totalDamage = totalHits * damagePerHit;
    const foodUsed = estimateFoodUsed(totalHits, healthCost, baseHealthPool, foodPercent, stockLimit.foodChargesAvailable);
    const ammoUsed = ammoCode === "none" ? 0 : totalHits;
    const consumableCost = estimateConsumableCost(foodUsed, ammoUsed, foodCode, ammoCode, prices);

    return {
      period,
      foodCode,
      ammoCode,
      plannedHits,
      totalHits,
      foodHp: foodPercent,
      foodUsed,
      ammoUsed,
      damagePerHit,
      totalDamage,
      healthCost,
      baseHealthPool,
      plannedFoodCharges,
      consumableCost,
      stockLimit,
      durabilityCost: 0,
      totalCost: consumableCost,
      costPer1k: costPerDamage(consumableCost, totalDamage),
    };
  }

  function annotateCombatResult(result) {
    if (!result) return result;
    result.totalCost = (Number(result.consumableCost) || 0) + (Number(result.durabilityCost) || 0);
    result.costPer1k = costPerDamage(result.totalCost, result.totalDamage);
    result.consumableCostPer1k = costPerDamage(result.consumableCost, result.totalDamage);
    result.durabilityCostPer1k = costPerDamage(result.durabilityCost, result.totalDamage);
    return result;
  }

  function costPerDamage(cost, damage) {
    const totalDamage = Number(damage) || 0;
    if (totalDamage <= 0) return 0;
    return (Number(cost) || 0) / totalDamage * 1000;
  }

  function averageDamagePerHit(stats) {
    const precision = clamp(stats.precision, 0, 100) / 100;
    const critChance = clamp(stats.criticalChance, 0, 100) / 100;
    const half = stats.attack * 0.5;
    const normal = stats.attack;
    const crit = stats.attack * (1 + stats.criticalDamages / 100);
    return (1 - precision) * half + precision * (1 - critChance) * normal + precision * critChance * crit;
  }

  function healthCostPerHit(armor, dodge) {
    const armorFactor = 10 * (1 - softRatio(armor));
    return Math.max(0.001, armorFactor * (1 - softRatio(dodge)));
  }

  function softRatio(value) {
    return value / (value + 40);
  }

  function capHitsByOwnedConsumables(plannedHits, foodCode, ammoCode, consumables) {
    return combatStockLimit({
      plannedHits,
      foodCode,
      foodHp: FOOD[foodCode] || 0,
      plannedFoodCharges: plannedHits,
      baseHealthPool: 0,
      healthCost: 1,
      ammoCode,
      consumables,
    }).totalHits;
  }

  function combatStockLimit(input) {
    const plannedHits = input.plannedHits;
    const foodCode = input.foodCode;
    const ammoCode = input.ammoCode;
    const consumables = input.consumables;
    const plannedFoodCharges = Number(input.plannedFoodCharges) || 0;
    const foodHp = Number(input.foodHp) || 0;
    const baseHealthPool = Number(input.baseHealthPool) || 0;
    const healthCost = Math.max(0.001, Number(input.healthCost) || 1);
    const usesFood = foodCode && foodCode !== "none" && foodHp > 0;
    if (!consumables) {
      return {
        plannedHits,
        totalHits: plannedHits,
        limited: false,
        limitedBy: [],
        foodCode,
        foodQty: usesFood ? Infinity : 0,
        foodChargesNeeded: plannedFoodCharges,
        foodChargesAvailable: usesFood ? plannedFoodCharges : 0,
        foodHits: plannedHits,
        ammoCode,
        ammoQty: ammoCode === "none" ? Infinity : 0,
        ammoHits: ammoCode === "none" ? Infinity : 0,
      };
    }
    const foodQty = usesFood ? Number(consumables[foodCode] || 0) : 0;
    const foodChargesAvailable = usesFood ? Math.min(plannedFoodCharges, foodQty) : 0;
    const foodLimitedHealthPool = usesFood ? baseHealthPool + foodChargesAvailable * foodHp : baseHealthPool;
    const foodHits = usesFood ? Math.max(0, Math.floor(foodLimitedHealthPool / healthCost)) : plannedHits;
    const ammoHits = ammoCode === "none" ? Infinity : Math.floor(Number(consumables[ammoCode] || 0));
    const totalHits = Math.max(0, Math.min(plannedHits, foodHits, ammoHits));
    const limitedBy = [];
    if (usesFood && foodHits <= totalHits && totalHits < plannedHits) limitedBy.push("food");
    if (ammoHits <= totalHits && totalHits < plannedHits) limitedBy.push("ammo");
    return {
      plannedHits,
      totalHits,
      limited: totalHits < plannedHits,
      limitedBy,
      foodCode,
      foodQty,
      foodChargesNeeded: plannedFoodCharges,
      foodChargesAvailable,
      foodHits,
      ammoCode,
      ammoQty: ammoCode === "none" ? Infinity : Number(consumables[ammoCode] || 0),
      ammoHits,
    };
  }

  function estimateDurabilityCost(combo, combat, totalHits, prices) {
    estimateDurabilityCost.lastBreaks = [];
    estimateDurabilityCost.lastWear = [];
    if (!totalHits || !combat) return 0;
    const after = equipmentAfterCombo(combo, combat.equipment || {});
    let total = 0;
    const breaks = [];
    const wearDetails = [];
    for (const slot of EQUIPMENT_SLOTS) {
      const item = after[slot];
      if (!item || !item.code) continue;
      const wear = wearPerHit(slot) * totalHits;
      const maxState = Number(item.maxState || item.currentMaxState || 0);
      const stateLeft = finiteNumber(Number(item.state)) ? Number(item.state) : maxState;
      const rarity = item.rarity || rarityFromCode(item.code);
      const itemValue = craftValueForItem(item, prices);
      const unit = maxState > 0 ? itemValue / maxState : 0;
      const chargedWear = Math.min(wear, stateLeft || wear);
      const cost = chargedWear * unit;
      const willBreak = stateLeft > 0 && wear >= stateLeft;
      total += cost;
      wearDetails.push({ slot, code: item.code, rarity, wear, chargedWear, stateLeft, maxState, itemValue, cost, willBreak });
      if (willBreak) breaks.push({ slot, code: item.code, cost });
    }
    estimateDurabilityCost.lastBreaks = breaks;
    estimateDurabilityCost.lastWear = wearDetails;
    return total;
  }

  function equipmentAfterCombo(combo, equipment) {
    const out = { ...(equipment || {}) };
    for (const c of combo || []) {
      out[c.slot] = {
        code: c.code,
        rarity: c.rarity,
        skills: c.rolledSkills || {},
        state: c.state != null && finiteNumber(Number(c.state)) ? Number(c.state) : c.maxState || c.currentMaxState || null,
        maxState: c.maxState || c.currentMaxState || null,
      };
    }
    return out;
  }

  function wearPerHit(slot) {
    return slot === "weapon" ? 1 : 2 / 3;
  }

  function craftValueForItem(item, prices) {
    const rarity = item.rarity || rarityFromCode(item.code);
    const cost = CRAFT_COSTS[rarity];
    if (!cost) return 0;
    return cost.scraps * (Number(prices.scraps) || 0) + cost.steel * (Number(prices.steel) || 0);
  }

  function estimateFoodUsed(totalHits, healthCost, baseHealthPool, foodHp, availableFoodCharges) {
    if (!totalHits || !foodHp) return 0;
    const requiredFoodHealth = Math.max(0, totalHits * healthCost - baseHealthPool);
    return Math.max(0, Math.min(availableFoodCharges, Math.ceil(requiredFoodHealth / foodHp)));
  }

  function estimateConsumableCost(foodUsed, ammoUsed, foodCode, ammoCode, prices) {
    const foodPrice = Number(prices && prices[foodCode]) || 0;
    const ammoPrice = ammoCode === "none" ? 0 : Number(prices && prices[ammoCode]) || 0;
    return (Number(foodUsed) || 0) * foodPrice + (Number(ammoUsed) || 0) * ammoPrice;
  }

  function materialBuyNeed(cost, resources, prices) {
    const scrapsNeed = Math.max(0, cost.scraps - (Number(resources && resources.scraps) || 0));
    const steelNeed = Math.max(0, cost.steel - (Number(resources && resources.steel) || 0));
    const scrapsValue = scrapsNeed * (Number(prices.scraps) || 0);
    const steelValue = steelNeed * (Number(prices.steel) || 0);
    return {
      scraps: scrapsNeed,
      steel: steelNeed,
      scrapsValue,
      steelValue,
      total: scrapsValue + steelValue,
    };
  }

  function rollValue(min, max, options) {
    const mode = options && ROLL_MODE[options.roll] !== undefined ? options.roll : "average";
    if (mode === "min") return min;
    if (mode === "max") return max;
    return (min + max) / 2;
  }

  function applyCraftHighlights() {
    document.querySelectorAll(".wca-highlight").forEach((el) => el.classList.remove("wca-highlight", "wca-highlight-top"));
    const model = state.last;
    if (!model || !model.plan || !model.plan.items.length) return;

    const topCodes = new Set(model.plan.items.map((item) => item.code));
    const skinAlts = new Set();
    const skins = model.user && model.user.equippedSkinKeys;
    if (skins) {
      for (const candidate of model.plan.items) {
        const item = model.items[candidate.code];
        if (item && item.skinSlot && skins[item.skinSlot]) skinAlts.add(skins[item.skinSlot]);
      }
    }

    document.querySelectorAll("img[alt]").forEach((img) => {
      const alt = img.getAttribute("alt");
      if (!topCodes.has(alt) && !skinAlts.has(alt)) return;
      const card = img.closest('[aria-haspopup="dialog"]') || img.parentElement;
      if (!card) return;
      card.classList.add("wca-highlight");
      if (model.plan.items[0] && (model.plan.items[0].code === alt || skinAlts.has(alt))) {
        card.classList.add("wca-highlight-top");
      }
    });
  }

  function createPanel() {
    const root = document.createElement("div");
    root.id = "wca-panel";
    const savedX = Number(loadSetting("wca.x", "NaN"));
    const savedY = Number(loadSetting("wca.y", "NaN"));
    if (finiteNumber(savedX) && finiteNumber(savedY)) {
      root.style.left = `${savedX}px`;
      root.style.top = `${savedY}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    }
    root.innerHTML = `
      <div class="wca-head">
        <div>
          <div class="wca-title">Craft Advisor</div>
          <div class="wca-subtitle">read-only</div>
        </div>
        <button class="wca-icon" data-action="refresh" title="Refresh">R</button>
      </div>
      <div class="wca-controls">
        <button data-mode="conservative">Safe</button>
        <button data-mode="normal">Normal</button>
        <button data-mode="aggressive">Push</button>
        <button data-mode="allin">All-in</button>
      </div>
      <div class="wca-controls">
        <button data-period="burst">Burst</button>
        <button data-period="h8">8h</button>
        <button data-period="h24">24h</button>
      </div>
      <div class="wca-controls">
        <button data-roll="average">Avg</button>
        <button data-roll="max">Max</button>
        <button data-roll="min">Min</button>
      </div>
      <div class="wca-budget">
        <span>Budget</span>
        <input data-budget-input type="text" inputmode="decimal" placeholder="auto cash" value="${escapeHtml(state.cashOverride)}">
        <button data-action="clear-budget">Auto</button>
      </div>
      <div class="wca-budget">
        <span>Dmg +%</span>
        <input data-damage-bonus-input type="text" inputmode="decimal" placeholder="0" value="${escapeHtml(state.damageBonusOverride)}">
        <button data-action="clear-damage-bonus">0</button>
      </div>
      <div class="wca-controls" style="grid-template-columns: minmax(0,1fr) auto;">
        <button data-action="export" title="Descarrega state.json + copia p/ clipboard + envia p/ o bot">Export state.json</button>
        <button data-action="export" class="wca-sync-badge" title="Estado da auto-sync com o bot local">sync</button>
      </div>
      <div class="wca-body"></div>
    `;

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const mode = target.getAttribute("data-mode");
      const period = target.getAttribute("data-period");
      const roll = target.getAttribute("data-roll");
      const action = target.getAttribute("data-action");
      const sectionToggle = target.closest("[data-section-toggle]");

      if (sectionToggle) {
        const key = sectionToggle.getAttribute("data-section-toggle");
        const next = isSectionOpen(key) ? "closed" : "open";
        saveSetting(`wca.section.${key}`, next);
        render();
        return;
      }

      if (mode) {
        state.mode = mode;
        saveSetting("wca.mode", mode);
        if (state.last) recomputePlan(state.last);
        render();
        applyCraftHighlights();
      }

      if (period) {
        state.period = period;
        saveSetting("wca.period", period);
        run();
      }

      if (roll) {
        state.roll = roll;
        saveSetting("wca.roll", roll);
        run();
      }

      if (action === "refresh") run();

      if (action === "export") exportState();

      if (action === "clear-budget") {
        state.cashOverride = "";
        saveSetting("wca.cashOverride", "");
        const budgetInput = root.querySelector("[data-budget-input]");
        if (budgetInput) budgetInput.value = "";
        if (state.last) {
          state.last.liquidMoney = readLiquidMoney(state.last.user);
          recomputePlan(state.last);
        }
        render();
        applyCraftHighlights();
      }

      if (action === "clear-damage-bonus") {
        state.damageBonusOverride = "";
        saveSetting("wca.damageBonus", "");
        const bonusInput = root.querySelector("[data-damage-bonus-input]");
        if (bonusInput) bonusInput.value = "";
        if (state.last) recomputePlan(state.last);
        render();
        applyCraftHighlights();
      }
    });

    root.addEventListener("input", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (target.hasAttribute("data-budget-input")) {
        state.cashOverride = target.value.trim();
        saveSetting("wca.cashOverride", state.cashOverride);
      } else if (target.hasAttribute("data-damage-bonus-input")) {
        state.damageBonusOverride = target.value.trim();
        saveSetting("wca.damageBonus", state.damageBonusOverride);
      } else {
        return;
      }
      if (state.last) {
        state.last.liquidMoney = readLiquidMoney(state.last.user);
        recomputePlan(state.last);
        render();
        applyCraftHighlights();
      }
    });

    const refresh = root.querySelector('[data-action="refresh"]');
    if (refresh) refresh.textContent = "R";
    initPanelDrag(root);
    return root;
  }

  function initPanelDrag(root) {
    const handle = root.querySelector(".wca-head");
    if (!handle) return;
    let dragging = null;

    handle.addEventListener("pointerdown", (event) => {
      if (event.target && event.target.closest && event.target.closest("button")) return;
      const rect = root.getBoundingClientRect();
      dragging = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      handle.setPointerCapture(event.pointerId);
      root.classList.add("dragging");
      event.preventDefault();
    });

    handle.addEventListener("pointermove", (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      const rect = root.getBoundingClientRect();
      const x = clamp(event.clientX - dragging.offsetX, 8, window.innerWidth - rect.width - 8);
      const y = clamp(event.clientY - dragging.offsetY, 8, window.innerHeight - rect.height - 8);
      root.style.left = `${x}px`;
      root.style.top = `${y}px`;
      root.style.right = "auto";
      root.style.bottom = "auto";
    });

    handle.addEventListener("pointerup", (event) => {
      if (!dragging || dragging.pointerId !== event.pointerId) return;
      dragging = null;
      root.classList.remove("dragging");
      const rect = root.getBoundingClientRect();
      saveSetting("wca.x", String(Math.round(rect.left)));
      saveSetting("wca.y", String(Math.round(rect.top)));
    });
  }

  function initIconFallbacks(root) {
    root.addEventListener("error", (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("wca-item-img")) return;

      const fallbacks = (img.getAttribute("data-fallback-srcs") || "")
        .split("|")
        .filter(Boolean);
      const index = Number(img.dataset.fallbackIndex || "0");
      const next = fallbacks[index];
      if (next) {
        img.dataset.fallbackIndex = String(index + 1);
        img.src = next;
        return;
      }

      img.classList.add("broken");
      img.removeAttribute("src");
    }, true);
  }

  function render() {
    const root = document.querySelector("#wca-panel");
    if (!root) return;

    root.querySelectorAll("[data-mode]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-mode") === state.mode);
    });
    root.querySelectorAll("[data-period]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-period") === state.period);
    });
    root.querySelectorAll("[data-roll]").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-roll") === state.roll);
    });
    const syncBadge = root.querySelector(".wca-sync-badge");
    if (syncBadge) {
      const ok = state.synced && Date.now() - state.synced < AUTOSYNC_MS * 2;
      syncBadge.textContent = ok ? "bot ✓" : "bot —";
      syncBadge.classList.toggle("active", !!ok);
    }

    const body = root.querySelector(".wca-body");
    if (state.loading) {
      body.innerHTML = `<div class="wca-muted">A ler API e pagina...</div>`;
      return;
    }

    if (state.error) {
      body.innerHTML = `<div class="wca-error">${escapeHtml(state.error)}</div>`;
      return;
    }

    if (!state.last) {
      body.innerHTML = `<div class="wca-muted">Sem dados ainda.</div>`;
      return;
    }

    const model = state.last;
    const planItems = model.plan.items;
    const base = model.combat.baseResult;
    const result = model.plan.result || base;
    const policyNote = model.plan.policy && model.plan.policy.countOwnedMaterialsAsBudget ? " | material value counts" : "";
    const budgetLine = model.plan.cashBudget !== null
      ? `${model.plan.policy?.label || "Mode"} budget ${money(model.plan.cashBudget)} | left ${money(model.plan.remainingCash)}${policyNote}`
      : "cash budget indisponivel";
    const limitLine = result.stockLimit && result.stockLimit.limited
      ? stockLimitTitle(result.stockLimit)
      : "Sem limite de stock neste plano";
    const stockDetail = result.stockLimit && result.stockLimit.limited
      ? stockLimitDetail(result.stockLimit)
      : `${itemChip(result.foodCode, "xs")}${result.ammoCode !== "none" ? itemChip(result.ammoCode, "xs") : " sem ammo"}`;
    const breakLine = result.durabilityBreaks && result.durabilityBreaks.length
      ? `Parte nesta luta: ${result.durabilityBreaks.map((x) => itemLabel(x.code)).join(", ")}`
      : "Durabilidade aguenta";

    body.innerHTML = `
      <div class="wca-hero">
        <div class="wca-hero-main">
          <b>Dano previsto</b>
          <span>${fmt(result.totalDamage)}</span>
          <small>${result.totalHits} hits · ${fmt(result.damagePerHit)} / hit · ${money(result.costPer1k || 0)}/1k</small>
        </div>
        <div class="wca-hero-main cost">
          <b>Custo da luta</b>
          <span>${money(result.totalCost || 0)}</span>
          <small>${money(result.consumableCost || 0)} cons · ${money(result.durabilityCost || 0)} dur</small>
        </div>
      </div>
      <div class="wca-signal ${result.plannedHits > result.totalHits ? "warn" : ""}">
        <b>${limitLine}</b>
        <span>${stockDetail} · ${breakLine}</span>
      </div>
      <div class="wca-mini-grid">
        <div><b>Cash</b><span>${money(model.liquidMoney)}</span></div>
        <div><b>Gear</b><span>${fmt(model.ownedEquipment?.length || 0)}</span></div>
        <div><b>Delta</b><span>${signedFmt(model.plan.totalDamageGain)}</span></div>
        <div><b>Modo</b><span>${periodLabel(model.combat.period)} · ${rollLabel(model.options?.roll || state.roll)}${model.options?.damageBonus ? ` · +${fmt(model.options.damageBonus)}%` : ""}</span></div>
      </div>
      <div class="wca-stock">
        ${stockPill("scraps", model.resources.scraps)}
        ${stockPill("steel", model.resources.steel)}
        ${stockPill("bread", model.consumables?.bread || 0)}
        ${stockPill("steak", model.consumables?.steak || 0)}
        ${stockPill("cookedFish", model.consumables?.cookedFish || 0)}
        ${stockPill("ammo", model.consumables?.ammo || 0)}
        ${stockPill("heavyAmmo", model.consumables?.heavyAmmo || 0)}
      </div>
      <div class="wca-muted">${budgetLine} · ${objectiveLabel(model.plan.policy)} · craft ${money(model.plan.totalCostValue)} · pressão stock ${money(model.plan.stockPressure || 0)} · desgaste ${money(result.durabilityCost || 0)}</div>
      ${renderSection("balance", "Balanço do inventário", renderInventoryBalance(model.inventoryBalance))}
      ${renderSection("build", "Build recomendada", `
        ${model.plan.build && model.plan.build.length ? model.plan.build.map(renderBuildSlot).join("") : `<div class="wca-muted">Sem build calculada.</div>`}
        ${renderConsumableBuild(result)}
      `)}
      ${renderSection("actions", "Ações sugeridas", planItems.length ? planItems.map(renderPlanItem).join("") : `<div class="wca-muted">Mantem a build atual dentro deste budget. Tenta Push/All-in ou muda roll/periodo.</div>`)}
      ${renderSection("avoid", "Crafts a evitar", model.avoid.length ? model.avoid.map(renderAvoidItem).join("") : `<div class="wca-muted">Sem alertas fortes.</div>`)}
    `;
  }

  function renderSection(key, title, content) {
    const open = isSectionOpen(key);
    return `
      <div class="wca-collapse ${open ? "open" : "closed"}">
        <button class="wca-section-toggle" data-section-toggle="${escapeHtml(key)}" type="button">
          <span>${escapeHtml(title)}</span>
          <b>${open ? "-" : "+"}</b>
        </button>
        ${open ? `<div class="wca-section-body">${content}</div>` : ""}
      </div>
    `;
  }

  function isSectionOpen(key) {
    const saved = loadSetting(`wca.section.${key}`, "");
    if (saved === "open") return true;
    if (saved === "closed") return false;
    const mobile = window.matchMedia && window.matchMedia("(max-width: 420px)").matches;
    if (mobile) return key === "build";
    return key !== "avoid";
  }

  function stockPill(code, qty) {
    return `<span class="wca-stock-pill">${itemIcon(code, itemLabel(code), "xxs", null)}<b>${fmt(Number(qty) || 0)}</b></span>`;
  }

  function renderInventoryBalance(balance) {
    if (!balance || !balance.rows || !balance.rows.length) return `<div class="wca-muted">Sem dados de gear suficientes.</div>`;
    const warning = balance.warnings && balance.warnings.length
      ? `<div class="wca-muted">${balance.warnings.map((row) => `${slotLabel(row.slot)}: ${row.note}`).join(" · ")}</div>`
      : `<div class="wca-muted">Stock de gear equilibrado para este modo.</div>`;
    return `
      <div class="wca-balance">
        ${warning}
        ${balance.rows.map(renderInventoryBalanceRow).join("")}
      </div>
    `;
  }

  function renderInventoryBalanceRow(row) {
    const status = row.status === "low" ? "baixo" : row.status === "premium-low" ? "falta premium" : row.status === "excess" ? "muitos baratos" : "ok";
    const detail = `${fmt(row.total)} total · ${fmt(row.usable)} ok · ${fmt(row.cheapUsable)} baratos · ${fmt(row.premiumUsable)} premium${row.lowDur ? ` · ${fmt(row.lowDur)} fracos` : ""}`;
    return `
      <div class="wca-balance-row ${escapeHtml(row.status)}">
        <b>${slotLabel(row.slot)}</b>
        <span>${escapeHtml(detail)}</span>
        <em>${escapeHtml(status)}</em>
      </div>
    `;
  }

  function stockLimitTitle(limit) {
    if (!limit || !limit.limited) return "Sem limite de stock neste plano";
    return `Stock corta ${fmt(limit.plannedHits)} -> ${fmt(limit.totalHits)} hits`;
  }

  function stockLimitDetail(limit) {
    if (!limit) return "";
    const parts = [];
    if (limit.foodCode === "none") {
      parts.push("sem comida");
    } else if (limit.limitedBy.includes("food")) {
      parts.push(`${itemChip(limit.foodCode, "xs")} ${fmt(limit.foodQty)} stock x ${fmt(FOOD[limit.foodCode] || 0)} HP = ${fmt(limit.foodHits)} hits`);
    } else {
      parts.push(`${itemChip(limit.foodCode, "xs")} ${fmt(FOOD[limit.foodCode] || 0)} HP`);
    }
    if (limit.ammoCode === "none") {
      parts.push("sem ammo");
    } else if (limit.limitedBy.includes("ammo")) {
      parts.push(`${itemChip(limit.ammoCode, "xs")} ${fmt(limit.ammoQty)} stock = ${fmt(limit.ammoHits)} hits`);
    } else {
      parts.push(itemChip(limit.ammoCode, "xs"));
    }
    return parts.filter(Boolean).join(" · ");
  }

  function renderBuildSlot(row) {
    const isCraft = row.action === "craft";
    const isEquip = row.action === "equip";
    const stateText = row.currentState && row.currentMaxState ? `state ${row.currentState}/${row.currentMaxState}` : "";
    const title = isCraft
      ? `${slotLabel(row.slot)} -> ${rarityLabel(row.rarity)} ${itemLabel(row.code)}`
      : isEquip
        ? `${slotLabel(row.slot)} -> equip ${rarityLabel(row.rarity)} ${itemLabel(row.code)}`
      : `${slotLabel(row.slot)} -> keep ${itemLabel(row.code)}`;
    const detail = isCraft
      ? row.details.map((entry) => `${statLabel(entry.stat)} ${fmt(entry.current)} -> ${fmt(entry.rolled)}`).join(", ")
      : Object.entries(row.skills || {}).map(([stat, value]) => `${statLabel(stat)} ${fmt(Number(value))}`).join(", ");
    const badge = isCraft ? "Craft" : isEquip ? "Equip" : "Keep";
    const right = isCraft ? signedFmt(row.damageGain) : isEquip && row.damageGain ? signedFmt(row.damageGain) : stateText;
    const wear = row.wear;
    const wearLine = wear && row.code
      ? `<div class="wca-muted ${wear.willBreak ? "wca-danger" : ""}">valor ${money(wear.itemValue || 0)} · gasto ${money(wear.cost || 0)}${wear.maxState ? ` · depois ${fmt(Math.max(0, (wear.stateLeft || 0) - wear.wear))}/${fmt(wear.maxState)}` : ""}${wear.willBreak ? " · parte nesta luta" : ""}</div>`
      : "";

    return `
      <div class="wca-build-slot ${isCraft || isEquip ? "craft" : "keep"}">
        ${itemIcon(row.code, row.name, "sm", row.rarity)}
        <div class="wca-item-main">
          <div class="wca-row">
            <b>${escapeHtml(title)}</b>
            <span>${escapeHtml(right || "")}</span>
          </div>
          <div class="wca-muted"><span class="wca-badge">${badge}</span>${detail ? ` ${escapeHtml(detail)}` : ""}</div>
          ${wearLine}
        </div>
      </div>
    `;
  }

  function renderConsumableBuild(result) {
    if (!result) return "";
    const capped = result.plannedHits > result.totalHits ? ` · stock limita ${fmt(result.plannedHits)} -> ${fmt(result.totalHits)}` : "";
    const breaks = result.durabilityBreaks && result.durabilityBreaks.length
      ? ` · parte: ${result.durabilityBreaks.map((x) => itemLabel(x.code)).join(", ")}`
      : "";
    return `
      <div class="wca-build-slot keep">
        ${itemIcon(result.foodCode, itemLabel(result.foodCode), "sm", null)}
        <div class="wca-item-main">
          <div class="wca-row">
            <b>Consumables</b>
            <span>${fmt(result.totalHits)} hits</span>
          </div>
          <div class="wca-muted">
            <span class="wca-badge">Usar</span>${result.foodCode === "none" ? " sem comida" : `${itemChip(result.foodCode, "xs")} x${fmt(result.foodUsed || 0)}`}${result.ammoCode !== "none" ? `${itemChip(result.ammoCode, "xs")} x${fmt(result.ammoUsed || 0)}` : " sem ammo"}${capped}
          </div>
          <div class="wca-muted">
            custo ${money(result.totalCost || 0)} = ${money(result.consumableCost || 0)} cons + ${money(result.durabilityCost || 0)} dur · ${money(result.costPer1k || 0)}/1k${breaks}
          </div>
        </div>
      </div>
    `;
  }

  function renderPlanItem(item, index) {
    const detail = item.details.map((entry) => {
      return `${statLabel(entry.stat)} ${fmt(entry.current)} -> ${fmt(entry.rolled)} (${entry.min}-${entry.max})`;
    }).join(", ");
    const owned = item.source === "owned";
    const stateText = owned && item.state != null && item.maxState
      ? ` | state ${fmt(item.state)}/${fmt(item.maxState)}`
      : item.currentState && item.currentMaxState ? ` | atual ${item.currentState}/${item.currentMaxState}` : "";
    const buyText = item.buyNeed
      ? `buy ${materialIcon("scraps")} ${fmt(item.buyNeed.scraps)} + ${materialIcon("steel")} ${fmt(item.buyNeed.steel)} = ${money(item.buyNeed.total)}`
      : `buy need ${money(item.buyNeedValue)}`;
    const ownedText = `owned gear value ${money(item.costValue || 0)}`;

    return `
      <div class="wca-card ${index === 0 ? "top" : ""}">
        <div class="wca-item-row">
          ${itemIcon(item.code, item.name, "md", item.rarity)}
          <div class="wca-item-main">
            <div class="wca-row">
              <b>${index + 1}. ${rarityLabel(item.rarity)} ${slotLabel(item.slot)}</b>
            <span>${signedFmt(item.damageGain)}</span>
          </div>
          <div class="wca-muted">${detail}${stateText}</div>
        </div>
      </div>
        <div class="wca-muted">${owned ? ownedText : `craft value ${money(item.costValue)} (${materialIcon("scraps")} ${item.cost.scraps} + ${materialIcon("steel")} ${item.cost.steel})`}</div>
        <div class="wca-muted">${owned ? "equipar do inventário" : buyText} | eficiencia ${item.score.toFixed(3)}</div>
      </div>
    `;
  }

  function renderAvoidItem(item) {
    return `
      <div class="wca-avoid">
        <span class="wca-avoid-title">${itemIcon(item.code, item.name, "xs", item.rarity)}<b>${rarityLabel(item.rarity)} ${slotLabel(item.slot)}</b></span>
        <span>+${fmt(item.bestDamageGain)} best</span>
      </div>
    `;
  }
  function addStyles() {
    const style = document.createElement("style");
    style.textContent = `
      #wca-panel {
        position: fixed;
        right: 12px;
        bottom: 86px;
        z-index: 2147483647;
        width: min(360px, calc(100vw - 24px));
        max-height: min(720px, calc(100dvh - 112px));
        overflow: auto;
        color: #edf2f7;
        background: rgba(17, 24, 31, .94);
        border: 1px solid rgba(130, 160, 227, .45);
        box-shadow: 0 12px 40px rgba(0, 0, 0, .42);
        border-radius: 8px;
        padding: 12px;
        font-family: Saira, system-ui, sans-serif;
        font-size: 12px;
      }
      #wca-panel .wca-head,
      #wca-panel .wca-row,
      #wca-panel .wca-avoid {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #wca-panel .wca-head {
        cursor: grab;
        user-select: none;
      }
      #wca-panel.dragging .wca-head {
        cursor: grabbing;
      }
      #wca-panel .wca-title { font-size: 16px; font-weight: 800; line-height: 1; }
      #wca-panel .wca-subtitle,
      #wca-panel .wca-muted { color: #aab7c8; }
      #wca-panel .wca-danger { color: #ffc9c9; }
      #wca-panel .wca-icon,
      #wca-panel button {
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
        color: inherit;
        border-radius: 6px;
        padding: 5px 8px;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }
      #wca-panel button.active {
        background: rgba(130, 160, 227, .28);
        border-color: rgba(130, 160, 227, .8);
      }
      #wca-panel .wca-controls {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
        margin-top: 10px;
      }
      #wca-panel .wca-controls + .wca-controls {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
      #wca-panel .wca-budget {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px;
        margin-top: 10px;
        color: #aab7c8;
        font-weight: 800;
      }
      #wca-panel .wca-budget input {
        min-width: 0;
        border: 1px solid rgba(255,255,255,.14);
        background: rgba(255,255,255,.06);
        color: #edf2f7;
        border-radius: 6px;
        padding: 5px 8px;
        font: inherit;
        font-weight: 800;
      }
      #wca-panel .wca-body { margin-top: 12px; display: grid; gap: 8px; }
      #wca-panel .wca-hero {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #wca-panel .wca-hero-main {
        background: rgba(130, 160, 227, .13);
        border: 1px solid rgba(130, 160, 227, .55);
        border-radius: 7px;
        padding: 9px;
        min-width: 0;
      }
      #wca-panel .wca-hero-main.cost {
        background: rgba(246, 211, 101, .08);
        border-color: rgba(246, 211, 101, .35);
      }
      #wca-panel .wca-hero-main b,
      #wca-panel .wca-mini-grid b {
        display: block;
        color: #aab7c8;
        font-size: 10px;
        line-height: 1.1;
        text-transform: uppercase;
        letter-spacing: 0;
      }
      #wca-panel .wca-hero-main span {
        display: block;
        margin-top: 3px;
        font-size: 18px;
        font-weight: 900;
        line-height: 1.05;
        color: #edf2f7;
      }
      #wca-panel .wca-hero-main small {
        display: block;
        margin-top: 5px;
        color: #aab7c8;
        font-size: 11px;
        line-height: 1.25;
      }
      #wca-panel .wca-signal {
        display: grid;
        gap: 3px;
        background: rgba(255,255,255,.055);
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 7px;
        padding: 8px;
      }
      #wca-panel .wca-signal.warn {
        background: rgba(246, 211, 101, .1);
        border-color: rgba(246, 211, 101, .35);
      }
      #wca-panel .wca-signal b {
        color: #edf2f7;
        font-size: 12px;
      }
      #wca-panel .wca-signal span {
        color: #aab7c8;
        font-weight: 800;
      }
      #wca-panel .wca-mini-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 6px;
      }
      #wca-panel .wca-mini-grid > div {
        min-width: 0;
        background: rgba(255,255,255,.045);
        border: 1px solid rgba(255,255,255,.08);
        border-radius: 7px;
        padding: 7px;
      }
      #wca-panel .wca-mini-grid span {
        display: block;
        margin-top: 3px;
        font-size: 12px;
        font-weight: 900;
        line-height: 1.2;
        white-space: normal;
        overflow: hidden;
      }
      #wca-panel .wca-stock {
        display: flex;
        flex-wrap: wrap;
        gap: 5px;
      }
      #wca-panel .wca-stock-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 3px 6px;
        border-radius: 6px;
        background: rgba(255,255,255,.055);
        border: 1px solid rgba(255,255,255,.08);
        color: #d8e2ff;
        font-weight: 900;
      }
      #wca-panel .wca-balance {
        display: grid;
        gap: 5px;
      }
      #wca-panel .wca-balance-row {
        display: grid;
        grid-template-columns: 58px minmax(0, 1fr) auto;
        align-items: center;
        gap: 6px;
        padding: 6px 7px;
        border-radius: 7px;
        background: rgba(255,255,255,.045);
        border: 1px solid rgba(255,255,255,.08);
      }
      #wca-panel .wca-balance-row.low {
        border-color: rgba(246, 211, 101, .42);
        background: rgba(246, 211, 101, .075);
      }
      #wca-panel .wca-balance-row.excess {
        border-color: rgba(130, 160, 227, .36);
        background: rgba(130, 160, 227, .075);
      }
      #wca-panel .wca-balance-row.premium-low {
        border-color: rgba(198, 143, 255, .38);
        background: rgba(198, 143, 255, .075);
      }
      #wca-panel .wca-balance-row b,
      #wca-panel .wca-balance-row em {
        color: #edf2f7;
        font-style: normal;
        font-weight: 900;
      }
      #wca-panel .wca-balance-row span {
        color: #aab7c8;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #wca-panel .wca-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      #wca-panel .wca-grid > div,
      #wca-panel .wca-card,
      #wca-panel .wca-avoid,
      #wca-panel .wca-build-slot {
        background: rgba(255,255,255,.055);
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 7px;
        padding: 8px;
      }
      #wca-panel .wca-grid b,
      #wca-panel .wca-grid span { display: block; }
      #wca-panel .wca-grid span { font-size: 15px; font-weight: 800; }
      #wca-panel .wca-money-wrap {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      #wca-panel .wca-money {
        width: 1em;
        height: 1em;
        color: #f6d365;
        filter: drop-shadow(black 1px 1px 0);
        flex: 0 0 auto;
      }
      #wca-panel .wca-item-row {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 8px;
      }
      #wca-panel .wca-item-main {
        min-width: 0;
      }
      #wca-panel .wca-item-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        background-image: linear-gradient(45deg, rgb(44, 30, 64), rgb(19, 15, 25));
        border: 1px solid rgba(255,255,255,.08);
        overflow: hidden;
        vertical-align: middle;
        flex: 0 0 auto;
      }
      #wca-panel .wca-item-icon.rarity-common { background-image: linear-gradient(45deg, rgb(42, 49, 57), rgb(18, 22, 26)); }
      #wca-panel .wca-item-icon.rarity-uncommon { background-image: linear-gradient(45deg, rgb(24, 58, 40), rgb(12, 26, 19)); }
      #wca-panel .wca-item-icon.rarity-rare { background-image: linear-gradient(45deg, rgb(24, 45, 76), rgb(11, 18, 31)); }
      #wca-panel .wca-item-icon.rarity-epic { background-image: linear-gradient(45deg, rgb(44, 30, 64), rgb(19, 15, 25)); }
      #wca-panel .wca-item-icon.rarity-legendary { background-image: linear-gradient(45deg, rgb(78, 49, 18), rgb(31, 18, 8)); }
      #wca-panel .wca-item-icon.rarity-mythic { background-image: linear-gradient(45deg, rgb(64, 21, 21), rgb(25, 11, 11)); }
      #wca-panel .wca-item-icon img {
        width: 82%;
        height: 82%;
        object-fit: contain;
        display: block;
      }
      #wca-panel .wca-item-icon img.broken {
        display: none;
      }
      #wca-panel .wca-item-icon.md { width: 42px; height: 42px; }
      #wca-panel .wca-item-icon.sm { width: 30px; height: 30px; }
      #wca-panel .wca-item-icon.xs { width: 20px; height: 20px; border-radius: 5px; }
      #wca-panel .wca-item-icon.xxs { width: 16px; height: 16px; border-radius: 4px; }
      #wca-panel .wca-chip,
      #wca-panel .wca-avoid-title {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      #wca-panel .wca-chip {
        margin-left: 5px;
        color: #d8e2ff;
        font-weight: 800;
      }
      #wca-panel .wca-section {
        color: #d8e2ff;
        font-weight: 900;
        text-transform: uppercase;
        letter-spacing: 0;
        margin-top: 4px;
      }
      #wca-panel .wca-collapse {
        display: grid;
        gap: 6px;
      }
      #wca-panel .wca-section-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        margin-top: 4px;
        padding: 5px 0;
        border: 0;
        background: transparent;
        color: #d8e2ff;
        text-transform: uppercase;
        letter-spacing: 0;
        font-weight: 900;
        text-align: left;
      }
      #wca-panel .wca-section-toggle b {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 5px;
        background: rgba(255,255,255,.08);
        color: #edf2f7;
      }
      #wca-panel .wca-section-body {
        display: grid;
        gap: 8px;
      }
      #wca-panel .wca-card.top {
        border-color: rgba(130, 160, 227, .75);
        background: rgba(130, 160, 227, .16);
      }
      #wca-panel .wca-build-slot {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr);
        align-items: center;
        gap: 8px;
      }
      #wca-panel .wca-build-slot.craft {
        border-color: rgba(130, 160, 227, .65);
        background: rgba(130, 160, 227, .12);
      }
      #wca-panel .wca-badge {
        display: inline-block;
        min-width: 34px;
        margin-right: 4px;
        border-radius: 4px;
        padding: 1px 5px;
        background: rgba(255,255,255,.1);
        color: #d8e2ff;
        font-weight: 900;
        text-align: center;
      }
      #wca-panel .wca-error {
        color: #ffc9c9;
        background: rgba(255, 64, 64, .12);
        border: 1px solid rgba(255, 64, 64, .35);
        border-radius: 7px;
        padding: 8px;
      }
      .wca-highlight {
        outline: 2px solid rgba(130, 160, 227, .95) !important;
        outline-offset: 2px !important;
      }
      .wca-highlight-top {
        outline-color: #f6d365 !important;
      }
      @media (max-width: 420px) {
        #wca-panel {
          left: 6px !important;
          right: 6px !important;
          bottom: 6px;
          top: auto !important;
          width: calc(100vw - 12px);
          max-height: min(82dvh, 680px);
          padding: 9px;
          font-size: 11px;
        }
        #wca-panel .wca-title {
          font-size: 14px;
        }
        #wca-panel .wca-icon,
        #wca-panel button {
          min-height: 34px;
          padding: 6px 7px;
        }
        #wca-panel .wca-controls {
          gap: 5px;
          margin-top: 8px;
        }
        #wca-panel .wca-budget {
          margin-top: 8px;
        }
        #wca-panel .wca-hero {
          grid-template-columns: 1fr;
          gap: 6px;
        }
        #wca-panel .wca-hero-main {
          padding: 8px;
        }
        #wca-panel .wca-hero-main span {
          font-size: 16px;
        }
        #wca-panel .wca-mini-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        #wca-panel .wca-balance-row {
          grid-template-columns: 54px minmax(0, 1fr);
          row-gap: 2px;
        }
        #wca-panel .wca-balance-row em {
          grid-column: 2;
          justify-self: start;
          color: #d8e2ff;
        }
        #wca-panel .wca-balance-row span {
          white-space: normal;
          line-height: 1.25;
        }
        #wca-panel .wca-build-slot,
        #wca-panel .wca-card {
          padding: 7px;
        }
        #wca-panel .wca-build-slot {
          grid-template-columns: 28px minmax(0, 1fr);
          gap: 7px;
        }
        #wca-panel .wca-item-icon.md { width: 34px; height: 34px; }
        #wca-panel .wca-item-icon.sm { width: 28px; height: 28px; }
        #wca-panel .wca-row {
          align-items: flex-start;
        }
        #wca-panel .wca-row > span {
          text-align: right;
          max-width: 42%;
        }
        #wca-panel .wca-muted {
          line-height: 1.3;
        }
        #wca-panel .wca-section-toggle {
          min-height: 32px;
          padding: 4px 0;
        }
        #wca-panel .wca-section-body {
          gap: 6px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function parseWareraNumber(value) {
    const text = normalizeText(value).replace(/,/g, ".").toUpperCase();
    const match = text.match(/([0-9]+(?:\.[0-9]+)?)([KMB])?/);
    if (!match) return null;

    const number = Number(match[1]);
    if (!Number.isFinite(number)) return null;

    const suffix = match[2];
    if (suffix === "K") return number * 1000;
    if (suffix === "M") return number * 1000000;
    if (suffix === "B") return number * 1000000000;
    return number;
  }

  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, "").trim();
  }

  function integerDistribution(min, max) {
    const values = [];
    for (let value = Math.ceil(min); value <= Math.floor(max); value += 1) values.push(value);
    return values.length ? values : [min, max];
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function closestWithText(el, needle) {
    let node = el;
    for (let i = 0; node && i < 8; i += 1) {
      if (node.textContent && node.textContent.includes(needle)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function readCookie(name) {
    const part = document.cookie.split("; ").find((item) => item.startsWith(`${name}=`));
    return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
  }

  function loadSetting(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveSetting(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function fmt(value) {
    if (!finiteNumber(value)) return "?";
    if (Math.abs(value) >= 1000000) return `${(value / 1000000).toFixed(2)}M`;
    if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)}K`;
    return value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  }

  function signedFmt(value) {
    const number = Number(value) || 0;
    if (number === 0) return "0";
    return `${number > 0 ? "+" : ""}${fmt(number)}`;
  }

  function money(value) {
    return `<span class="wca-money-wrap">${MONEY_SVG}<span>${fmt(value)}</span></span>`;
  }

  function objectiveLabel(policy) {
    const objective = policy && policy.objective;
    if (objective === "efficiency") return "objetivo barato";
    if (objective === "balanced") return "objetivo equilibrado";
    if (objective === "damage") return "objetivo dano";
    if (objective === "allin") return "objetivo max dano";
    return "objetivo plano";
  }

  function itemIcon(code, label, size, rarity) {
    if (!code || code === "none") return "";
    const safeCode = String(code);
    const safeLabel = escapeHtml(label || itemLabel(safeCode));
    const visualRarity = rarity || itemVisualRarity(safeCode);
    const rarityClass = visualRarity ? ` rarity-${escapeHtml(visualRarity)}` : "";
    const urls = itemAssetUrls(safeCode);
    const src = urls[0];
    const fallbackSrcs = urls.slice(1).join("|");
    return `
      <span class="wca-item-icon ${size || "sm"}${rarityClass}" title="${safeLabel}">
        <img class="wca-item-img" src="${src}" data-fallback-srcs="${fallbackSrcs}" alt="" aria-label="${safeLabel}" loading="lazy">
      </span>
    `;
  }

  function itemChip(code, size) {
    if (!code || code === "none") return "";
    const label = itemLabel(code);
    return `<span class="wca-chip">${itemIcon(code, label, size || "xs")}<span>${escapeHtml(label)}</span></span>`;
  }

  function materialIcon(code) {
    return itemIcon(code, itemLabel(code), "xxs", null);
  }

  function itemAssetUrls(code) {
    const iconCode = itemIconCode(code);
    return uniqueStrings([
      findExistingItemSrc(code),
      findExistingItemSrc(iconCode),
      `${ITEM_ASSET_BASE}${encodeURIComponent(iconCode)}.png?v=33`,
      `${ITEM_ASSET_BASE}${encodeURIComponent(code)}.png?v=33`,
      `${ITEM_ASSET_FALLBACK_BASE}${encodeURIComponent(code)}.png`,
      `${ITEM_ASSET_FALLBACK_BASE}${encodeURIComponent(iconCode)}.png`,
    ]).filter(Boolean);
  }

  function itemIconCode(code) {
    const text = String(code || "");
    const equipment = text.match(/^(boots|helmet|gloves|chest|pants)\d+$/i);
    if (equipment) return equipment[1];
    return text;
  }

  function itemVisualRarity(code) {
    return BASIC_ITEM_RARITY[code] || rarityFromCode(code);
  }

  function findExistingItemSrc(code) {
    if (!code) return null;
    const exactAlt = document.querySelector(`img[alt="${cssEscape(code)}"][src]`);
    if (exactAlt && !exactAlt.closest("#wca-panel")) return exactAlt.getAttribute("src");

    const pattern = new RegExp(`/images/items/${escapeRegExp(code)}\\.png(?:[?#].*)?$|/items/${escapeRegExp(code)}\\.png(?:[?#].*)?$`, "i");
    const imgs = Array.from(document.querySelectorAll("img[src]"));
    for (const img of imgs) {
      if (img.closest("#wca-panel")) continue;
      const src = img.getAttribute("src") || "";
      if (pattern.test(src)) return src;
      try {
        const url = new URL(src, location.origin);
        if (pattern.test(url.pathname)) return url.href;
      } catch (_) {}
    }
    return null;
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  function itemLabel(code) {
    const labels = {
      cookedFish: "Cooked Fish",
      heavyAmmo: "Heavy Ammo",
      lightAmmo: "Light Ammo",
      ammo: "Ammo",
      bread: "Bread",
      steak: "Steak",
      scraps: "Scraps",
      steel: "Steel",
      jet: "Fighter Jet",
      tank: "Tank",
      sniper: "Sniper",
      rifle: "Rifle",
      gun: "Gun",
      knife: "Knife",
    };
    if (labels[code]) return labels[code];
    return String(code || "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/(\D)(\d+)$/, "$1 $2")
      .replace(/^\w/, (letter) => letter.toUpperCase());
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function rarityLabel(value) {
    return String(value || "").replace(/^\w/, (letter) => letter.toUpperCase());
  }

  function rarityFromCode(code) {
    const text = String(code || "");
    if (/6$/.test(text) || text === "jet") return "mythic";
    if (/5$/.test(text) || text === "tank") return "legendary";
    if (/4$/.test(text) || text === "sniper") return "epic";
    if (/3$/.test(text) || text === "rifle") return "rare";
    if (/2$/.test(text) || text === "gun") return "uncommon";
    if (/1$/.test(text) || text === "knife") return "common";
    return "";
  }

  function slotLabel(value) {
    const labels = {
      weapon: "Weapon",
      helmet: "Helmet",
      chest: "Chest",
      pants: "Pants",
      boots: "Boots",
      gloves: "Gloves",
    };
    return labels[value] || value;
  }

  function statLabel(value) {
    const labels = {
      attack: "atk",
      criticalChance: "crit",
      criticalDamages: "crit dmg",
      armor: "armor",
      dodge: "dodge",
      precision: "precision",
    };
    return labels[value] || value;
  }

  function periodLabel(value) {
    const labels = {
      burst: "Burst",
      h8: "8h",
      h24: "24h",
    };
    return labels[value] || value;
  }

  function rollLabel(value) {
    const labels = {
      min: "Minimum",
      average: "Average",
      max: "Maximum",
    };
    return labels[value] || value;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
