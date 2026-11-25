import { unzipSync } from "fflate";

const ROLES = ["admin", "purchase", "warehouse"];
const FEATURES = ["orders", "inventory", "moves", "ozon"];
const ACTION_FEATURES = {
  order: "orders", "order-batch": "orders", receipt: "orders", "delete-order": "orders",
  "delete-legacy-order": "orders", "delete-legacy-move": "moves", stock: "inventory",
  "rename-item": "inventory", "edit-item": "inventory", "delete-item": "inventory", watch: "inventory",
  store: "ozon", sync: "ozon", bind: "ozon", unbind: "ozon"
};
const ROLE_LABELS = { admin: "总控端", purchase: "采购端", warehouse: "仓库端", system: "系统同步", legacy: "历史记录" };
const enc = new TextEncoder();
const dec = new TextDecoder();
let schemaInitialization;

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const now = () => new Date().toISOString();
const randomId = (bytes = 12) => {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, value => value.toString(16).padStart(2, "0")).join("");
};
const roleLabel = role => ROLE_LABELS[role] || String(role || "未知");
const err = (message, status = 400) => { throw new AppError(message, status); };

function required(data, key) {
  const value = data?.[key];
  if (typeof value !== "string" || !value.trim() || value.length > 250) err("请填写有效的 " + key);
  return value.trim();
}

function quantity(data, key, minimum = 0) {
  const value = data?.[key];
  if (!Number.isInteger(value)) err("数量必须填写整数");
  if (value < minimum) err(key === "quantity" ? "采购数量必须大于 0" : "数量不能小于 0");
  if (value > 100000000) err("数量不能超过 100000000");
  return value;
}

function splitSkus(value) {
  if (value == null) return [];
  if (Array.isArray(value)) value = value.map(String).join(";");
  if (typeof value !== "string" || value.length > 2000) err("SKU 列表格式有误或长度过长");
  const result = [];
  const seen = new Set();
  for (const part of value.replaceAll("；", ";").split(";")) {
    const sku = part.trim();
    if (!sku) continue;
    if (sku.length > 250) err("单个 SKU 不能超过 250 个字符");
    if (!seen.has(sku)) {
      result.push(sku);
      seen.add(sku);
    }
  }
  return result;
}

function hasFeature(state, role, feature) {
  return role === "admin" || Boolean(state.enabled?.[role]?.[feature]);
}

function noticeVisible(role, entry) {
  const access = {
    purchase: new Set(["receipt", "order_deleted", "item_deleted"]),
    warehouse: new Set(["low", "pending", "order_deleted", "receipt", "item_deleted"])
  };
  return role === "admin" || Boolean(access[role]?.has(entry.kind));
}

function change(state, itemId, delta, ref, actor = "system") {
  const item = state.items[itemId];
  if (!item) err("找不到要调整的仓库商品");
  item.stock += delta;
  state.moves.unshift({
    id: randomId(10), legacy_record: false, item: itemId, delta, ref,
    actor: roleLabel(actor), at: now()
  });
  if (item.watch && item.stock < 10 && item.stock - delta >= 10) {
    notice(state, "low", item.name + "（" + itemId + "）库存低于 10，当前 " + item.stock + " 件", actor, null, itemId);
  }
}

function notice(state, kind, message, actor = null, orderId = null, itemId = null) {
  const entry = { id: randomId(10), kind, message, at: now(), read_by: {} };
  if (actor) entry.actor = roleLabel(actor);
  if (orderId) entry.order_id = orderId;
  if (itemId) entry.item_id = itemId;
  state.notices.unshift(entry);
}

function renameItem(state, oldId, newId, actor) {
  const item = state.items[oldId];
  if (!item) err("找不到要修改的仓库商品");
  if (oldId === newId) return item;
  if (state.items[newId]) err("该仓库商品 ID 已存在");
  state.items[newId] = item;
  delete state.items[oldId];
  for (const order of state.orders) if (order.item === oldId) order.item = newId;
  for (const store of Object.values(state.stores)) {
    for (const [offer, boundItem] of Object.entries(store.bindings)) {
      if (boundItem === oldId) store.bindings[offer] = newId;
    }
  }
  for (const move of state.moves) if (move.item === oldId) move.item = newId;
  state.moves.unshift({
    id: randomId(10), legacy_record: false, item: newId, delta: 0,
    ref: "修改仓库商品 ID：" + oldId + " → " + newId,
    actor: roleLabel(actor), at: now()
  });
  return state.items[newId];
}

function autoBindSku(state, sku, itemId, itemName, actor) {
  const normalized = String(sku).trim().toLocaleLowerCase("zh-CN");
  const matches = [];
  for (const store of Object.values(state.stores)) {
    for (const product of store.catalog || []) {
      if (String(product.sku || "").trim().toLocaleLowerCase("zh-CN") === normalized && product.offer_id) {
        matches.push([store, String(product.offer_id)]);
      }
    }
  }
  for (const [store, offer] of matches) {
    const existing = store.bindings[offer];
    if (existing && existing !== itemId) {
      err("SKU " + sku + " 对应店铺“" + store.name + "”的货号 " + offer +
        " 已绑定到仓库商品 ID " + existing + "，请先处理绑定冲突");
    }
  }
  if (!matches.length) return 0;
  const item = state.items[itemId] ||= { name: itemName, stock: 0, watch: false, manual_skus: null };
  if (item.manual_skus != null && !item.manual_skus.includes(sku)) item.manual_skus.push(sku);
  for (const [store, offer] of matches) {
    store.bindings[offer] = itemId;
    for (const [number, lines] of Object.entries(store.lines)) {
      const line = lines[offer];
      if (line && !line.applied) {
        change(state, itemId, -line.quantity, "OZON " + store.name + " / " + number + " / " + offer, actor);
        line.applied = true;
      }
    }
  }
  return matches.length;
}

function mutate(state, role, action, data) {
  const feature = ACTION_FEATURES[action];
  if (feature && !hasFeature(state, role, feature)) err("总控端尚未开放此功能权限", 403);

  if (action === "order" || action === "order-batch") {
    if (!["purchase", "admin"].includes(role)) err("只有采购端或总控端可以提交采购订单", 403);
    const rows = action === "order-batch" ? data.orders : [data];
    if (!Array.isArray(rows) || !rows.length) err("请至少填写一条采购单");
    if (rows.length > 200) err("单次最多批量提交 200 条采购单");
    const seen = new Set(state.orders.map(order => JSON.stringify([order.number, order.item, order.sku])));
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) err("采购单表格数据格式有误");
      const order = {};
      for (const key of ["item", "number", "sku", "name", "platform"]) order[key] = required(row, key);
      order.quantity = quantity(row, "quantity", 1);
      const key = JSON.stringify([order.number, order.item, order.sku]);
      if (seen.has(key)) err("采购单号 " + order.number + "、仓库商品 ID 和 SKU 的组合已存在");
      seen.add(key);
      const matched = splitSkus(order.sku).reduce((total, sku) => total + autoBindSku(state, sku, order.item, order.name, role), 0);
      Object.assign(order, {
        id: randomId(12), actual: null, at: now(), created_by: role,
        legacy_record: false, matched_offers: matched
      });
      state.orders.unshift(order);
      const summary = matched ? "（按 SKU 自动绑定 " + matched + " 个店铺货号）" : "（暂未匹配到店铺商品）";
      notice(state, "pending",
        roleLabel(role) + "提交待确认采购单 " + order.number + "：" + order.name + " × " + order.quantity + summary,
        role, order.id);
    }
    return;
  }

  if (action === "receipt") {
    if (!["warehouse", "admin"].includes(role)) err("只有仓库端或总控端可以确认入库", 403);
    const order = state.orders.find(value => value.id === data.id);
    if (!order) err("找不到对应记录");
    if (order.actual !== null) err("该订单已确认");
    const actual = quantity(data, "actual");
    state.items[order.item] ||= { name: order.name, stock: 0, watch: false, manual_skus: null };
    change(state, order.item, actual, "采购入库 / " + order.number, role);
    Object.assign(order, { actual, received: now(), confirmed_by: role });
    notice(state, "receipt",
      roleLabel(role) + "确认采购单 " + order.number + "，" + order.name + " 实收 " + actual + " 件",
      role, order.id);
    return;
  }

  if (action === "delete-order") {
    if (!["purchase", "admin"].includes(role)) err("采购单只能由采购端或总控端删除", 403);
    const index = state.orders.findIndex(order => order.id === data.id);
    if (index < 0) err("找不到对应记录");
    const order = state.orders[index];
    if (order.actual !== null) err("已确认入库的采购单不能删除");
    if (role !== "admin" && order.created_by !== role) err("只能删除由本端口发出的待确认采购单", 403);
    state.orders.splice(index, 1);
    notice(state, "order_deleted",
      roleLabel(role) + "删除了待确认采购单 " + order.number + "（" + order.name + "）",
      role, order.id);
    return;
  }

  if (action === "delete-legacy-order") {
    if (role !== "admin") err("删除历史采购单需要总控权限", 403);
    const index = state.orders.findIndex(order => order.id === data.id);
    if (index < 0) err("找不到对应记录");
    const order = state.orders[index];
    if (!order.legacy_record) err("只能删除之前版本迁移来的历史采购单");
    state.orders.splice(index, 1);
    state.notices = state.notices.filter(entry => !(entry.kind === "pending" && entry.order_id === order.id));
    notice(state, "record_deleted",
      "总控端删除了历史采购单 " + order.number + "（" + order.name + "）；库存数量未变更",
      role, order.id);
    return;
  }

  if (action === "delete-legacy-move") {
    if (role !== "admin") err("删除历史库存流水需要总控权限", 403);
    const index = state.moves.findIndex(move => move.id === data.id);
    if (index < 0) err("找不到对应记录");
    const move = state.moves[index];
    if (!move.legacy_record) err("只能删除之前版本迁移来的历史库存流水");
    state.moves.splice(index, 1);
    notice(state, "record_deleted",
      "总控端删除了历史库存流水（仓库商品 ID " + move.item + "，变动 " + move.delta + "）；库存数量未变更",
      role);
    return;
  }

  if (action === "stock") {
    const itemId = required(data, "item");
    if (!state.items[itemId]) err("找不到要调整的仓库商品");
    const stock = quantity(data, "stock");
    const delta = stock - state.items[itemId].stock;
    if (delta) change(state, itemId, delta, "手动调整库存", role);
    return;
  }

  if (action === "rename-item") {
    renameItem(state, required(data, "item"), required(data, "new_item"), role);
    return;
  }

  if (action === "edit-item") {
    const oldId = required(data, "item");
    const newId = required(data, "new_item");
    const newName = required(data, "name");
    const newStock = quantity(data, "stock");
    const skus = splitSkus(data.skus || "");
    const item = state.items[oldId];
    if (!item) err("找不到要修改的仓库商品");
    const oldName = item.name;
    const oldStock = item.stock;
    const current = renameItem(state, oldId, newId, role);
    const currentSkus = new Set(state.orders.filter(order => order.item === newId && order.sku).map(order => String(order.sku)));
    for (const store of Object.values(state.stores)) {
      const catalog = new Map((store.catalog || []).map(product => [product.offer_id, product]));
      for (const [offer, boundItem] of Object.entries(store.bindings)) {
        const product = catalog.get(offer);
        if (boundItem === newId && product?.sku) currentSkus.add(String(product.sku));
      }
    }
    current.manual_skus = skus.length === currentSkus.size && skus.every(sku => currentSkus.has(sku)) ? null : skus;
    if (oldName !== newName) {
      current.name = newName;
      state.moves.unshift({
        id: randomId(10), legacy_record: false, item: newId, delta: 0,
        ref: "修改商品名称：" + oldName + " → " + newName,
        actor: roleLabel(role), at: now()
      });
    }
    const delta = newStock - oldStock;
    if (delta) change(state, newId, delta, "手动调整库存", role);
    return;
  }

  if (action === "delete-item") {
    if (!["warehouse", "admin"].includes(role)) err("只有仓库端或总控端可以删除库存商品", 403);
    const itemId = required(data, "item");
    const item = state.items[itemId];
    if (!item) err("找不到要删除的仓库商品");
    const linked = new Set(state.orders.filter(order => order.item === itemId).map(order => order.id));
    const orderCount = linked.size;
    state.orders = state.orders.filter(order => order.item !== itemId);
    state.moves = state.moves.filter(move => move.item !== itemId);
    state.notices = state.notices.filter(entry => entry.item_id !== itemId && !linked.has(entry.order_id));
    let unbound = 0;
    for (const store of Object.values(state.stores)) {
      for (const [offer, bound] of Object.entries(store.bindings)) {
        if (bound === itemId) {
          delete store.bindings[offer];
          unbound += 1;
        }
      }
    }
    delete state.items[itemId];
    notice(state, "item_deleted",
      roleLabel(role) + "删除库存商品 " + item.name + "（" + itemId + "，原库存 " + item.stock +
        " 件），同步清理 " + orderCount + " 条采购单和 " + unbound + " 个货号绑定",
      role);
    return;
  }

  if (action === "watch") {
    const itemId = required(data, "item");
    const item = state.items[itemId];
    if (!item) err("找不到要关注的仓库商品");
    item.watch = !item.watch;
    if (item.watch && item.stock < 10) {
      notice(state, "low", item.name + "（" + itemId + "）库存低于 10，当前 " + item.stock + " 件", role, null, itemId);
    }
    return;
  }

  if (action === "toggle") {
    if (role !== "admin") err("此操作需要总控权限", 403);
    const target = required(data, "role");
    const targetFeature = required(data, "feature");
    if (!["purchase", "warehouse"].includes(target) || !FEATURES.includes(targetFeature)) err("请选择有效的端口和功能权限");
    state.enabled[target][targetFeature] = !state.enabled[target][targetFeature];
    return;
  }

  if (action === "read-notice") {
    const entry = state.notices.find(value => value.id === data.id);
    if (!entry) err("找不到对应记录");
    if (!noticeVisible(role, entry)) err("无权读取此消息", 403);
    entry.read_by ||= {};
    entry.read_by[role] = true;
    return;
  }

  if (action === "read-all-notices") {
    for (const entry of state.notices) {
      if (noticeVisible(role, entry)) {
        entry.read_by ||= {};
        entry.read_by[role] = true;
      }
    }
    return;
  }

  if (action === "store") {
    const client = required(data, "client");
    if (state.stores[client]) err("该 Client-Id 已绑定");
    state.stores[client] = {
      client, name: required(data, "name"), key: required(data, "key"), _key_encrypted: "",
      start: now(), cursor: now(), offers: [], catalog: [], bindings: {}, lines: {}, sales: [], error: ""
    };
    return;
  }

  if (action === "bind") {
    const store = state.stores[required(data, "client")];
    if (!store) err("找不到所选店铺");
    const offer = required(data, "offer");
    const itemId = required(data, "item");
    if (!store.offers.includes(offer) || !state.items[itemId]) err("请选择已抓取的货号和已入库的仓库商品");
    if (store.bindings[offer]) err("该店铺货号已有绑定");
    store.bindings[offer] = itemId;
    for (const [number, lines] of Object.entries(store.lines)) {
      const line = lines[offer];
      if (line && !line.applied) {
        change(state, itemId, -line.quantity, "OZON " + store.name + " / " + number + " / " + offer, role);
        line.applied = true;
      }
    }
    return;
  }

  if (action === "unbind") {
    const store = state.stores[required(data, "client")];
    if (!store) err("找不到所选店铺");
    const offer = required(data, "offer");
    if (!Object.hasOwn(store.bindings, offer)) err("该货号尚未绑定仓库商品");
    delete store.bindings[offer];
    return;
  }

  err("未知操作");
}

function emptyState() {
  return {
    items: {}, orders: [], notices: [], stores: {}, moves: [],
    enabled: {
      purchase: { orders: true, inventory: true, moves: true, ozon: true },
      warehouse: { orders: true, inventory: true, moves: true, ozon: true }
    }
  };
}

function ensureStore(state, client) {
  if (!state.stores[client]) {
    state.stores[client] = {
      client, name: "", key: undefined, _key_encrypted: "", start: now(), cursor: now(),
      error: "", catalog: [], offers: [], bindings: {}, lines: {}, sales: []
    };
  }
  return state.stores[client];
}

async function ensureSchema(env) {
  if (!env.DB) err("Cloudflare D1 数据库尚未绑定", 503);
  if (!schemaInitialization) {
    schemaInitialization = env.DB.batch([
      env.DB.prepare("CREATE TABLE IF NOT EXISTS app_meta (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL DEFAULT 0)"),
      env.DB.prepare("INSERT OR IGNORE INTO app_meta (id, revision) VALUES (1, 0)"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS app_docs (collection TEXT NOT NULL, doc_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (collection, doc_key))"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_app_docs_collection ON app_docs(collection)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_sales_client_time ON app_docs(collection, json_extract(payload, '$.client'), json_extract(payload, '$.sale.created_at'))"),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS sync_locks (store_id TEXT PRIMARY KEY, token TEXT NOT NULL, lease_until INTEGER NOT NULL)")
    ]).then(() => true).catch(error => {
      schemaInitialization = undefined;
      throw error;
    });
  }
  await schemaInitialization;
}

async function readSnapshot(env) {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    "SELECT m.revision, d.collection, d.doc_key, d.payload FROM app_meta m " +
    "LEFT JOIN app_docs d ON 1 = 1 WHERE m.id = 1 AND (d.collection <> 'sales' OR d.collection IS NULL)"
  ).all();
  const rows = result.results || [];
  if (!rows.length) err("数据库未初始化，请先执行 migrations/0001_init.sql", 503);
  const state = emptyState();
  const docs = new Map();
  const revision = Number(rows[0].revision || 0);

  for (const row of rows) {
    if (!row.collection) continue;
    const collection = String(row.collection);
    const key = String(row.doc_key);
    const raw = String(row.payload);
    let collectionDocs = docs.get(collection);
    if (!collectionDocs) docs.set(collection, collectionDocs = new Map());
    collectionDocs.set(key, raw);
    const payload = JSON.parse(raw);

    if (collection === "settings") state.enabled[key] = payload;
    else if (collection === "items") state.items[key] = payload;
    else if (collection === "orders") state.orders.push(payload);
    else if (collection === "notices") {
      payload.read_by = payload.read_by && typeof payload.read_by === "object" ? payload.read_by : {};
      state.notices.push(payload);
    } else if (collection === "moves") state.moves.push(payload);
    else if (collection === "stores") {
      payload._key_encrypted = payload.key_encrypted || "";
      delete payload.key_encrypted;
      payload.key = undefined;
      payload.catalog = [];
      payload.offers = [];
      payload.bindings = {};
      payload.lines = {};
      payload.sales = [];
      state.stores[key] = payload;
    } else if (collection === "catalog") {
      const store = ensureStore(state, payload.client);
      store.catalog.push(payload.product);
      store.offers.push(payload.product.offer_id);
    } else if (collection === "bindings") {
      const store = ensureStore(state, payload.client);
      store.bindings[payload.offer] = payload.item;
    } else if (collection === "lines") {
      const store = ensureStore(state, payload.client);
      store.lines[payload.number] ||= {};
      store.lines[payload.number][payload.offer] = { quantity: payload.quantity, applied: Boolean(payload.applied) };
    }
  }

  for (const role of ["purchase", "warehouse"]) {
    state.enabled[role] ||= { orders: true, inventory: true, moves: true, ozon: true };
    for (const feature of FEATURES) {
      if (typeof state.enabled[role][feature] !== "boolean") state.enabled[role][feature] = true;
    }
  }
  for (const store of Object.values(state.stores)) {
    store.catalog.sort((a, b) => String(a.offer_id).localeCompare(String(b.offer_id), "zh-CN"));
    store.offers = store.catalog.map(product => String(product.offer_id));
  }
  state.orders.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  state.notices.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  state.moves.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
  return { state, docs, revision };
}

async function stateDocs(env, state) {
  const result = new Map();
  const put = (collection, key, payload) => {
    let map = result.get(collection);
    if (!map) result.set(collection, map = new Map());
    map.set(String(key), JSON.stringify(payload));
  };

  for (const role of ["purchase", "warehouse"]) put("settings", role, state.enabled[role]);
  for (const [key, item] of Object.entries(state.items)) put("items", key, item);
  for (const order of state.orders) put("orders", order.id, order);
  for (const entry of state.notices) put("notices", entry.id, entry);
  for (const move of state.moves) put("moves", move.id, move);

  for (const [client, store] of Object.entries(state.stores)) {
    const metadata = { ...store };
    delete metadata.key;
    delete metadata.catalog;
    delete metadata.offers;
    delete metadata.bindings;
    delete metadata.lines;
    delete metadata.sales;
    if (!metadata._key_encrypted) {
      if (typeof store.key !== "string" || !store.key) err("店铺 API Key 未设置");
      metadata._key_encrypted = await encryptSecret(env, store.key);
      store._key_encrypted = metadata._key_encrypted;
    }
    metadata.key_encrypted = metadata._key_encrypted;
    delete metadata._key_encrypted;
    put("stores", client, metadata);

    for (const product of store.catalog || []) {
      put("catalog", JSON.stringify([client, product.offer_id]), { client, product });
    }
    for (const [offer, item] of Object.entries(store.bindings || {})) {
      put("bindings", JSON.stringify([client, offer]), { client, offer, item });
    }
    for (const [number, lines] of Object.entries(store.lines || {})) {
      for (const [offer, line] of Object.entries(lines)) {
        put("lines", JSON.stringify([client, number, offer]), {
          client, number, offer, quantity: line.quantity, applied: Boolean(line.applied)
        });
      }
    }
  }
  return result;
}

function chunkByBytes(records, maxBytes = 1200000) {
  const chunks = [];
  let current = [];
  let currentBytes = 2;
  for (const record of records) {
    const bytes = enc.encode(JSON.stringify(record)).length + 1;
    if (current.length && currentBytes + bytes > maxBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(record);
    currentBytes += bytes;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function commitState(env, snapshot, state, extraSales = []) {
  const nextDocs = await stateDocs(env, state);
  const statements = [
    env.DB.prepare("UPDATE app_meta SET revision = revision + 1 WHERE id = 1 AND revision = ?").bind(snapshot.revision)
  ];
  const newRevision = snapshot.revision + 1;
  const collections = new Set([...snapshot.docs.keys(), ...nextDocs.keys()]);

  for (const collection of collections) {
    const oldMap = snapshot.docs.get(collection) || new Map();
    const newMap = nextDocs.get(collection) || new Map();
    const deleted = [];
    const upserts = [];
    for (const key of oldMap.keys()) if (!newMap.has(key)) deleted.push(key);
    for (const [key, payload] of newMap) {
      if (oldMap.get(key) !== payload) upserts.push({ key, payload });
    }

    for (const group of chunkByBytes(deleted.map(key => ({ key })))) {
      const keys = JSON.stringify(group.map(row => row.key));
      statements.push(env.DB.prepare(
        "DELETE FROM app_docs WHERE collection = ? AND doc_key IN (SELECT value FROM json_each(?)) " +
        "AND EXISTS (SELECT 1 FROM app_meta WHERE id = 1 AND revision = ?)"
      ).bind(collection, keys, newRevision));
    }
    for (const group of chunkByBytes(upserts)) {
      statements.push(env.DB.prepare(
        "INSERT INTO app_docs(collection, doc_key, payload) " +
        "SELECT ?, json_extract(value, '$.key'), json_extract(value, '$.payload') FROM json_each(?) " +
        "WHERE EXISTS (SELECT 1 FROM app_meta WHERE id = 1 AND revision = ?) " +
        "ON CONFLICT(collection, doc_key) DO UPDATE SET payload = excluded.payload"
      ).bind(collection, JSON.stringify(group), newRevision));
    }
  }

  for (const group of chunkByBytes(extraSales)) {
    statements.push(env.DB.prepare(
      "INSERT INTO app_docs(collection, doc_key, payload) " +
      "SELECT 'sales', json_extract(value, '$.key'), json_extract(value, '$.payload') FROM json_each(?) " +
      "WHERE EXISTS (SELECT 1 FROM app_meta WHERE id = 1 AND revision = ?) " +
      "ON CONFLICT(collection, doc_key) DO UPDATE SET payload = excluded.payload"
    ).bind(JSON.stringify(group), newRevision));
  }

  const results = await env.DB.batch(statements);
  return Number(results?.[0]?.meta?.changes || 0) === 1;
}

async function updateState(env, transform) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const snapshot = await readSnapshot(env);
    const state = snapshot.state;
    const extraSales = await transform(state);
    const committed = await commitState(env, snapshot, state, Array.isArray(extraSales) ? extraSales : []);
    if (committed) return extraSales;
  }
  err("数据正在更新，请稍后重试", 409);
}

function bytesToB64Url(bytes) {
  let binary = "";
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function b64UrlToBytes(value) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function appKey(env, purpose) {
  if (!env.APP_SECRET || String(env.APP_SECRET).length < 32) err("Cloudflare 尚未配置 APP_SECRET（至少 32 个字符）", 503);
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(String(env.APP_SECRET) + ":" + purpose));
  return crypto.subtle.importKey("raw", digest, purpose === "cookie" ?
    { name: "HMAC", hash: "SHA-256" } : { name: "AES-GCM" }, false,
    purpose === "cookie" ? ["sign", "verify"] : ["encrypt", "decrypt"]);
}

async function encryptSecret(env, value) {
  const key = await appKey(env, "store-key");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(value));
  return "v1." + bytesToB64Url(iv) + "." + bytesToB64Url(new Uint8Array(ciphertext));
}

async function decryptSecret(env, value) {
  if (!value || !String(value).startsWith("v1.")) err("店铺 API Key 无法解密，请核对 APP_SECRET", 503);
  const parts = String(value).split(".");
  try {
    const key = await appKey(env, "store-key");
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64UrlToBytes(parts[1]) }, key, b64UrlToBytes(parts[2])
    );
    return dec.decode(plaintext);
  } catch (error) {
    if (error instanceof AppError) throw error;
    err("店铺 API Key 无法解密，请核对 APP_SECRET", 503);
  }
}

async function signSession(env, role) {
  const expires = Math.floor(Date.now() / 1000) + 12 * 60 * 60;
  const nonce = randomId(18);
  const payload = role + "." + expires + "." + nonce;
  const key = await appKey(env, "cookie");
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return { token: payload + "." + bytesToB64Url(new Uint8Array(signature)), expires };
}

async function currentRole(request, env) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  let token;
  try { token = decodeURIComponent(match[1]); } catch { return null; }
  const parts = token.split(".");
  if (parts.length !== 4 || !ROLES.includes(parts[0])) return null;
  const expires = Number(parts[1]);
  if (!Number.isFinite(expires) || expires <= Math.floor(Date.now() / 1000)) return null;
  try {
    const key = await appKey(env, "cookie");
    const valid = await crypto.subtle.verify("HMAC", key, b64UrlToBytes(parts[3]), enc.encode(parts.slice(0, 3).join(".")));
    return valid ? parts[0] : null;
  } catch { return null; }
}

function constantEqual(a, b) {
  const left = enc.encode(String(a));
  const right = enc.encode(String(b));
  let mismatch = left.length ^ right.length;
  const size = Math.max(left.length, right.length);
  for (let index = 0; index < size; index += 1) mismatch |= (left[index] || 0) ^ (right[index] || 0);
  return mismatch === 0;
}

function json(data, status = 200, headers = {}) {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("Content-Type", "application/json; charset=utf-8");
  resultHeaders.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(data), { status, headers: resultHeaders });
}

function emptyReply(status = 200, headers = {}) {
  const resultHeaders = new Headers(headers);
  resultHeaders.set("Cache-Control", "no-store");
  return new Response(null, { status, headers: resultHeaders });
}

function roleView(state, role) {
  const features = Object.fromEntries(FEATURES.map(feature => [feature, hasFeature(state, role, feature)]));
  const response = { role, allowed: role === "admin" || Object.values(features).some(Boolean), features };
  if (features.orders) response.orders = state.orders;

  const visibleNotices = state.notices.filter(entry => noticeVisible(role, entry));
  response.notices = visibleNotices.map(entry => {
    const { read_by, ...rest } = entry;
    return { ...rest, read: Boolean(read_by?.[role]) };
  });
  response.unread_count = visibleNotices.filter(entry => !entry.read_by?.[role]).length;

  if (features.inventory) {
    const metadata = new Map(Object.keys(state.items).map(id => [id, { skus: new Set(), purchase_orders: new Set() }]));
    for (const order of state.orders) {
      const meta = metadata.get(order.item);
      if (!meta) continue;
      if (order.sku) meta.skus.add(String(order.sku));
      if (order.number) meta.purchase_orders.add(String(order.number));
    }
    for (const store of Object.values(state.stores)) {
      const products = new Map((store.catalog || []).map(product => [String(product.offer_id), product]));
      for (const [offer, itemId] of Object.entries(store.bindings || {})) {
        const product = products.get(offer);
        if (product?.sku && metadata.has(itemId)) metadata.get(itemId).skus.add(String(product.sku));
      }
    }
    for (const [itemId, item] of Object.entries(state.items)) {
      if (item.manual_skus != null) metadata.get(itemId).skus = new Set(item.manual_skus);
    }
    response.items = Object.fromEntries(Object.entries(state.items).map(([id, item]) => {
      const meta = metadata.get(id);
      return [id, { ...item, skus: [...meta.skus].sort(), purchase_orders: [...meta.purchase_orders].sort() }];
    }));
  }
  if (features.moves) response.moves = state.moves;
  if (role === "admin") response.enabled = state.enabled;
  if (features.ozon) {
    response.item_options = Object.entries(state.items).map(([id, item]) => ({ id, name: item.name || "" }));
    response.stores = Object.fromEntries(Object.entries(state.stores).map(([id, store]) => {
      const { key, _key_encrypted, lines, sales, ...publicStore } = store;
      return [id, {
        ...publicStore, catalog: store.catalog || [],
        pending: Object.values(store.lines || {}).reduce((count, linesByOffer) =>
          count + Object.values(linesByOffer).filter(line => !line.applied).length, 0)
      }];
    }));
  }
  return response;
}

function xmlDecode(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function xmlAttributes(source) {
  const result = {};
  const expression = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = expression.exec(source))) result[match[1]] = xmlDecode(match[3] ?? match[4] ?? "");
  return result;
}

function xmlTexts(source) {
  const values = [];
  const expression = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let match;
  while ((match = expression.exec(source))) values.push(xmlDecode(match[1].replace(/<[^>]+>/g, "")));
  return values.join("");
}

function pathInZip(target) {
  let path = target.replace(/^\/+/, "");
  if (!path.startsWith("xl/")) path = "xl/" + path;
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const normalized = parts.join("/");
  if (!normalized.startsWith("xl/")) err("Excel 表格工作表路径无效");
  return normalized;
}

function xlsxRows(raw) {
  let files;
  try { files = unzipSync(raw); } catch { err("无法读取 Excel 文件，请使用 .xlsx 格式"); }
  const entries = Object.values(files);
  const uncompressed = entries.reduce((total, value) => total + value.length, 0);
  if (uncompressed > 50 * 1024 * 1024) err("Excel 表格内容过大");
  const read = path => {
    if (!files[path]) err("Excel 文件结构无效或已损坏");
    return dec.decode(files[path]);
  };
  const workbook = read("xl/workbook.xml");
  const sheetTag = workbook.match(/<sheet\b[^>]*>/);
  if (!sheetTag) err("Excel 表格没有工作表");
  const relationshipId = xmlAttributes(sheetTag[0])["r:id"];
  const relations = read("xl/_rels/workbook.xml.rels");
  const relExpression = /<Relationship\b[^>]*\/?>/g;
  let relation;
  let target = "";
  while ((relation = relExpression.exec(relations))) {
    const attrs = xmlAttributes(relation[0]);
    if (attrs.Id === relationshipId) { target = attrs.Target || ""; break; }
  }
  if (!target) err("Excel 表格的首个工作表无法读取");
  const sheetPath = pathInZip(target);
  const shared = [];
  if (files["xl/sharedStrings.xml"]) {
    const strings = read("xl/sharedStrings.xml");
    const siExpression = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let item;
    while ((item = siExpression.exec(strings))) shared.push(xmlTexts(item[1]));
  }
  const sheet = read(sheetPath);
  const rows = [];
  const rowExpression = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowExpression.exec(sheet))) {
    const cells = new Map();
    const cellExpression = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellExpression.exec(rowMatch[1]))) {
      const attributes = xmlAttributes(cellMatch[1]);
      const reference = (attributes.r || "").match(/^([A-Z]+)/);
      if (!reference) continue;
      let column = 0;
      for (const character of reference[1]) column = column * 26 + character.charCodeAt(0) - 64;
      column -= 1;
      const body = cellMatch[2] || "";
      let value = "";
      if (attributes.t === "inlineStr") value = xmlTexts(body);
      else {
        const valueMatch = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/);
        value = valueMatch ? xmlDecode(valueMatch[1]) : "";
        if (attributes.t === "s" && value !== "") {
          const index = Number(value);
          if (!Number.isInteger(index) || index < 0 || index >= shared.length) err("Excel 表格包含无法读取的单元格");
          value = shared[index];
        }
      }
      cells.set(column, value);
    }
    if (cells.size) {
      const maxColumn = Math.max(...cells.keys());
      rows.push(Array.from({ length: maxColumn + 1 }, (_, index) => cells.get(index) || ""));
    }
  }
  return rows;
}

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
    } else if (char === "\"" && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (quoted) err("CSV / TSV 表格格式有误");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function orderImportRows(filename, encoded) {
  if (typeof filename !== "string" || filename.length > 250 || typeof encoded !== "string") err("导入文件信息有误");
  if (encoded.length > 14 * 1024 * 1024) err("导入文件不能超过 10 MB");
  let raw;
  try {
    const binary = atob(encoded);
    if (binary.length > 10 * 1024 * 1024) err("导入文件不能超过 10 MB");
    raw = Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch (error) {
    if (error instanceof AppError) throw error;
    err("导入文件内容无效");
  }
  const extension = filename.split(".").pop().toLowerCase();
  let rows;
  if (extension === "xlsx") rows = xlsxRows(raw);
  else if (["csv", "tsv", "txt"].includes(extension)) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^\uFEFF/, ""); }
    catch {
      try { text = new TextDecoder("gb18030", { fatal: true }).decode(raw); }
      catch { err("表格编码无法读取，请另存为 UTF-8 CSV 或 TSV"); }
    }
    let delimiter = ["tsv", "txt"].includes(extension) ? "\t" : ",";
    if (extension === "csv" && text.slice(0, 4096).split("\t").length > text.slice(0, 4096).split(",").length) delimiter = "\t";
    rows = parseDelimited(text, delimiter);
  } else err("请导入 .xlsx、.csv 或 .tsv 表格");

  if (!rows.length) err("导入表格为空");
  const aliases = {
    item: new Set(["仓库商品id", "仓库id", "warehouseitemid", "itemid"]),
    number: new Set(["采购单号", "采购订单号", "采购单编号", "purchasenumber", "purchaseordernumber"]),
    sku: new Set(["商品sku", "sku", "productsku"]),
    name: new Set(["商品名称", "产品名称", "商品名", "name", "productname"]),
    quantity: new Set(["采购数量", "数量", "quantity", "qty"]),
    platform: new Set(["采购平台", "平台", "platform"])
  };
  const headers = {};
  rows[0].forEach((value, index) => {
    const header = String(value).replace(/[\s_\-:：()（）]+/g, "").toLocaleLowerCase("zh-CN");
    for (const [field, names] of Object.entries(aliases)) {
      if (names.has(header) && headers[field] === undefined) headers[field] = index;
    }
  });
  const labels = { item: "仓库商品 ID", number: "采购单号", sku: "商品 SKU", name: "商品名称", quantity: "采购数量", platform: "采购平台" };
  const missing = Object.keys(aliases).filter(field => headers[field] === undefined);
  if (missing.length) err("表格首行缺少列：" + missing.map(field => labels[field]).join("、"));
  const result = [];
  for (const row of rows.slice(1)) {
    if (!row.some(value => String(value).trim())) continue;
    const record = {};
    for (const [field, index] of Object.entries(headers)) record[field] = String(row[index] ?? "").trim();
    result.push(record);
    if (result.length > 200) err("单个文件最多导入 200 条采购单");
  }
  if (!result.length) err("表格中没有可导入的数据行");
  return result;
}

async function ozon(store, path, payload, operation) {
  let response;
  try {
    response = await fetch("https://api-seller.ozon.ru" + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Client-Id": store.client,
        "Api-Key": store.key
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new AppError(operation + "失败，Cloudflare 无法连接 api-seller.ozon.ru，请稍后重试", 502);
  }
  if (!response.ok) {
    let detail = "请稍后重试或检查 OZON 接口状态";
    if (response.status === 401) detail = "请核对 Client-Id 和 API Key";
    if (response.status === 403) detail = "请检查 API Key 的商品或 FBS 订单读取权限";
    if (response.status === 429) {
      const retry = response.headers.get("Retry-After");
      detail = "达到接口限流，请" + (retry ? retry + " 秒后" : "") + "重试";
    }
    throw new AppError(operation + "失败（HTTP " + response.status + "），" + detail, 502);
  }
  try { return await response.json(); }
  catch { throw new AppError(operation + "失败，接口返回的内容无法解析", 502); }
}

async function loadCatalog(store) {
  const products = [];
  let cursor = "";
  while (true) {
    const pageResponse = await ozon(store, "/v3/product/list", {
      filter: { visibility: "ALL" }, limit: 1000, last_id: cursor
    }, "抓取 OZON 商品货号");
    const page = pageResponse?.result;
    if (!page || !Array.isArray(page.items)) throw new AppError("抓取 OZON 商品失败，接口返回的数据格式异常");
    products.push(...page.items);
    const next = page.last_id;
    if (!page.items.length || !next) break;
    if (next === cursor) throw new AppError("商品目录分页游标重复");
    cursor = next;
  }

  const details = new Map();
  const ids = products.map(product => product.product_id).filter(Boolean);
  for (let offset = 0; offset < ids.length; offset += 20) {
    const response = await ozon(store, "/v3/product/info/list", {
      product_id: ids.slice(offset, offset + 20)
    }, "读取 OZON 商品 SKU 和主图");
    const found = response.items || response.result?.items || [];
    if (!Array.isArray(found)) throw new AppError("读取 OZON 商品 SKU 和主图失败，接口返回的数据格式异常");
    for (const detail of found) details.set(String(detail.id ?? detail.product_id ?? ""), detail);
  }

  const treeResponse = await ozon(store, "/v1/description-category/tree", { language: "ZH_HANS" }, "读取 OZON 商品类目");
  const categoryTree = treeResponse?.result;
  if (!Array.isArray(categoryTree)) throw new AppError("读取 OZON 商品类目失败，接口返回的类目数据格式异常");
  const categoryNames = {};
  const indexCategories = (nodes, parents = []) => {
    for (const node of nodes) {
      const path = node.category_name ? [...parents, node.category_name] : parents;
      if (node.description_category_id != null && path.length) categoryNames[String(node.description_category_id)] = path.join(" / ");
      if (Array.isArray(node.children)) indexCategories(node.children, path);
    }
  };
  indexCategories(categoryTree);

  const catalog = [];
  const seen = new Set();
  for (const product of products) {
    const offer = String(product.offer_id || "");
    if (!offer || seen.has(offer)) continue;
    seen.add(offer);
    const productId = String(product.product_id || "");
    const detail = details.get(productId) || {};
    let image = detail.primary_image || detail.images || [];
    if (Array.isArray(image)) image = image[0] || "";
    if (typeof image !== "string") image = "";
    const categoryId = String(detail.description_category_id || "");
    catalog.push({
      product_id: productId, offer_id: offer,
      sku: String(detail.sku || product.sku || ""),
      name: String(detail.name || ""),
      primary_image: image, category_id: categoryId,
      category: categoryNames[categoryId] || ""
    });
  }
  catalog.sort((a, b) => String(a.offer_id).localeCompare(String(b.offer_id), "zh-CN"));
  return catalog;
}

async function* postingPages(store, since, until) {
  let cursor = "";
  const seen = new Set();
  while (true) {
    const page = await ozon(store, "/v4/posting/fbs/list", {
      dir: "ASC", filter: { since, to: until }, limit: 100, cursor
    }, "同步 OZON FBS 订单");
    if (!page || !Array.isArray(page.postings) || typeof page.has_next !== "boolean") {
      throw new AppError("同步 OZON FBS 订单失败，接口返回的分页数据格式异常");
    }
    for (const posting of page.postings) yield posting;
    if (!page.has_next) return;
    cursor = page.cursor;
    if (typeof cursor !== "string" || !cursor || seen.has(cursor)) {
      throw new AppError("同步 OZON FBS 订单失败，接口返回的分页游标无效或重复");
    }
    seen.add(cursor);
  }
}

async function acquireSyncLock(env, client) {
  const token = randomId(12);
  const until = Date.now() + 10 * 60 * 1000;
  const result = await env.DB.prepare(
    "INSERT INTO sync_locks(store_id, token, lease_until) VALUES (?, ?, ?) " +
    "ON CONFLICT(store_id) DO UPDATE SET token = excluded.token, lease_until = excluded.lease_until " +
    "WHERE sync_locks.lease_until < ?"
  ).bind(client, token, until, Date.now()).run();
  return Number(result.meta?.changes || 0) === 1 ? token : null;
}

async function releaseSyncLock(env, client, token) {
  await env.DB.prepare("DELETE FROM sync_locks WHERE store_id = ? AND token = ?").bind(client, token).run();
}

async function syncStore(env, client, options = {}) {
  const lock = await acquireSyncLock(env, client);
  if (!lock) return false;
  try {
    const snapshot = await readSnapshot(env);
    const store = snapshot.state.stores[client];
    if (!store) throw new AppError("找不到所选店铺");
    store.key = await decryptSecret(env, store._key_encrypted);
    const until = now();
    let since;
    if (options.historySince) since = options.historySince;
    else {
      const cursor = new Date(store.cursor);
      const start = new Date(store.start);
      const overlap = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
      since = new Date(Math.max(start.getTime(), overlap.getTime())).toISOString();
    }

    const catalog = options.refreshCatalog ? await loadCatalog(store) : null;
    const postings = [];
    let left = new Date(since);
    const end = new Date(until);
    while (left < end) {
      const right = new Date(Math.min(left.getTime() + 7 * 24 * 60 * 60 * 1000, end.getTime()));
      for await (const posting of postingPages(store, left.toISOString(), right.toISOString())) postings.push(posting);
      left = right;
    }

    await updateState(env, state => {
      const target = state.stores[client];
      if (!target) throw new AppError("找不到所选店铺");
      if (catalog) {
        target.catalog = catalog;
        target.offers = catalog.map(product => product.offer_id);
      }

      const newSales = [];
      const catalogByOffer = new Map((target.catalog || []).map(product => [String(product.offer_id), product]));
      for (const posting of postings) {
        const number = String(posting.posting_number);
        const saleProducts = [];
        for (const product of posting.products || []) {
          const offer = String(product.offer_id || "");
          const catalogProduct = catalogByOffer.get(offer) || {};
          saleProducts.push({
            offer_id: offer,
            sku: String(product.sku || catalogProduct.sku || ""),
            name: String(product.name || catalogProduct.name || ""),
            quantity: quantity(product, "quantity", 1)
          });
        }
        const sale = {
          number, status: String(posting.status || ""), substatus: String(posting.substatus || ""),
          created_at: String(posting.created_at || ""), in_process_at: String(posting.in_process_at || ""),
          products: saleProducts
        };
        newSales.push({
          key: JSON.stringify([client, number]),
          payload: JSON.stringify({ client, sale })
        });
        if (!options.applyInventory) continue;

        if (posting.status === "cancelled" || posting.status === "canceled") {
          const prior = target.lines[number] || {};
          target.lines[number] = Object.fromEntries(Object.entries(prior).filter(([, line]) => line.applied));
          continue;
        }
        const totals = {};
        for (const product of posting.products || []) {
          const offer = String(product.offer_id);
          totals[offer] = (totals[offer] || 0) + quantity(product, "quantity", 1);
        }
        target.lines[number] ||= {};
        for (const [offer, count] of Object.entries(totals)) {
          const line = target.lines[number][offer] ||= { quantity: count, applied: false };
          if (!line.applied) line.quantity = count;
        }
      }

      if (options.applyInventory) {
        for (const [number, lines] of Object.entries(target.lines)) {
          for (const [offer, line] of Object.entries(lines)) {
            const itemId = target.bindings[offer];
            if (itemId && !line.applied) {
              change(state, itemId, -line.quantity, "OZON " + target.name + " / " + number + " / " + offer, options.actor || "system");
              line.applied = true;
            }
          }
        }
      }
      target.cursor = until;
      target.error = "";
      return newSales;
    });
  } catch (error) {
    const message = safeError(error);
    try { await updateState(env, state => { if (state.stores[client]) state.stores[client].error = message; }); } catch {}
    throw new AppError(message, error instanceof AppError ? error.status : 502);
  } finally {
    await releaseSyncLock(env, client, lock).catch(() => {});
  }
}

function safeError(error) {
  if (error instanceof AppError) return error.message;
  return "同步失败，请检查网络或接口响应";
}

async function syncAllStores(env) {
  const snapshot = await readSnapshot(env);
  for (const client of Object.keys(snapshot.state.stores)) {
    try { await syncStore(env, client, { applyInventory: true, actor: "system" }); }
    catch { /* The store error is saved by syncStore. */ }
  }
}

async function salesPage(env, role, client, offset) {
  const snapshot = await readSnapshot(env);
  if (!hasFeature(snapshot.state, role, "ozon")) err("总控端尚未开放 OZON 店铺权限", 403);
  const store = snapshot.state.stores[client];
  if (!store) err("找不到所选店铺", 404);
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM app_docs WHERE collection = 'sales' AND json_extract(payload, '$.client') = ?"
  ).bind(client).first();
  const page = await env.DB.prepare(
    "SELECT payload FROM app_docs WHERE collection = 'sales' AND json_extract(payload, '$.client') = ? " +
    "ORDER BY COALESCE(NULLIF(json_extract(payload, '$.sale.created_at'), ''), " +
    "NULLIF(json_extract(payload, '$.sale.in_process_at'), '')) DESC, doc_key DESC LIMIT 200 OFFSET ?"
  ).bind(client, offset).all();
  const entries = (page.results || []).map(row => JSON.parse(row.payload).sale);
  return {
    client, name: store.name, cursor: store.cursor, error: store.error || "",
    total: Number(count?.total || 0), offset, limit: 200, sales: entries
  };
}

async function login(request, env, data) {
  const role = data?.role;
  if (!ROLES.includes(role)) err("账号或密码不正确", 401);
  const passwordNames = { admin: "ADMIN_PASSWORD", purchase: "PURCHASE_PASSWORD", warehouse: "WAREHOUSE_PASSWORD" };
  const expected = env[passwordNames[role]];
  if (!expected || !env.APP_SECRET) err("Cloudflare 尚未配置端口登录密码或 APP_SECRET", 503);
  if (typeof data.password !== "string" || !constantEqual(data.password, expected)) err("账号或密码不正确", 401);
  const { token, expires } = await signSession(env, role);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return json({}, 200, { "Set-Cookie": "session=" + encodeURIComponent(token) +
    "; Path=/; HttpOnly; SameSite=Strict; Max-Age=" + String(expires - Math.floor(Date.now() / 1000)) + secure });
}

async function apiRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/health") {
    return json({ app: "warehouse-workbench-cloudflare", version: 1 });
  }

  if (request.method === "GET" && path === "/api/state") {
    const role = await currentRole(request, env);
    if (!role) return json({ error: "请登录" }, 401);
    await ensureSchema(env);
    const revisionRow = await env.DB.prepare("SELECT revision FROM app_meta WHERE id = 1").first();
    if (!revisionRow) err("数据库未初始化，请先执行 migrations/0001_init.sql", 503);
    const etag = "\"" + role + "-" + revisionRow.revision + "\"";
    if (request.headers.get("If-None-Match") === etag) return emptyReply(304, { ETag: etag });
    const snapshot = await readSnapshot(env);
    return json(roleView(snapshot.state, role), 200, { ETag: "\"" + role + "-" + snapshot.revision + "\"" });
  }

  if (request.method === "GET" && path === "/api/sales") {
    const role = await currentRole(request, env);
    if (!role) return json({ error: "请登录" }, 401);
    const client = url.searchParams.get("client") || "";
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    return json(await salesPage(env, role, client, offset));
  }

  if (request.method === "POST" && path.startsWith("/api/")) {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) err("请求来源无效", 403);
    let data;
    try { data = await request.json(); } catch { err("请求格式有误"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) err("请求格式有误");
    const action = path.slice("/api/".length);

    if (action === "login") return login(request, env, data);
    if (action === "logout") {
      const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
      return json({}, 200, { "Set-Cookie": "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" + secure });
    }

    const role = await currentRole(request, env);
    if (!role) err("请登录", 403);

    if (action === "import-orders") {
      if (!["purchase", "admin"].includes(role)) err("只有采购端或总控端可以导入采购单", 403);
      const snapshot = await readSnapshot(env);
      if (!hasFeature(snapshot.state, role, "orders")) err("总控端尚未开放订单权限", 403);
      return json({ orders: orderImportRows(data.filename, data.content) });
    }

    if (action === "sync" || action === "sync-history") {
      const snapshot = await readSnapshot(env);
      if (!hasFeature(snapshot.state, role, "ozon")) err("总控端尚未开放 OZON 店铺权限", 403);
      const client = required(data, "client");
      if (!snapshot.state.stores[client]) err("找不到所选店铺");
      let options = { actor: role, applyInventory: true };
      if (action === "sync") options.refreshCatalog = true;
      else {
        const dateValue = required(data, "since");
        const selected = new Date(dateValue + "T00:00:00.000Z");
        if (Number.isNaN(selected.getTime()) || dateValue > new Date().toISOString().slice(0, 10)) {
          err("历史读取开始日期不能晚于今天");
        }
        options = { actor: role, historySince: selected.toISOString(), applyInventory: false };
      }
      await syncStore(env, client, options);
      return json({});
    }

    await updateState(env, state => mutate(state, role, action, data));
    return json({});
  }

  if (path.startsWith("/api/")) return json({ error: "找不到接口" }, 404);
  return null;
}

async function serve(request, env) {
  const url = new URL(request.url);
  const apiResponse = await apiRequest(request, env);
  if (apiResponse) return apiResponse;

  if (!env.ASSETS) return new Response("Worker static assets binding is missing.", { status: 503 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });

  const pagePath = url.pathname.replace(/\/+$/, "") || "/";
  if (["/", "/admin", "/purchase", "/warehouse", "/index.html"].includes(pagePath)) {
    // Cloudflare's default asset HTML handling redirects /index.html back to /.
    // Fetch the canonical root path directly to avoid a Worker/assets redirect loop.
    url.pathname = "/";
    return assetResponse(env.ASSETS, new Request(url, request));
  }
  if (["/app.js", "/style.css"].includes(pagePath)) return assetResponse(env.ASSETS, request);
  return new Response("Not found", { status: 404 });
}

async function assetResponse(assets, request) {
  const response = await assets.fetch(request);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-cache");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    try { return await serve(request, env); }
    catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      return json({ error: error instanceof AppError ? error.message : "服务暂时无法处理请求" }, status);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncAllStores(env));
  }
};

