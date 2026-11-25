const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const roles = {admin:'总控端', purchase:'采购端', warehouse:'仓库端'};
const roleName = role => roles[role] || (role==='legacy'?'历史记录':'—');
let state, tab, toastTimer, busy = false, seen = new Set(), selectedStore, salesData=null, salesLoading=null, salesOffset=0, stateEtag=null;
const salesPageSize=200;
const categoryFilters = {};
let catalogSearch = {name:'', sku:'', offer:''};
let inventoryQuery = '';
let entryRole = location.pathname.split('/').filter(Boolean)[0] || '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date = value => new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const input = (name, title, type='text', attrs='') => `<label>${title}<input name="${name}" type="${type}" required ${attrs}></label>`;
const button = (text, alt=false) => `<button ${alt?'class="alt"':''}>${text}</button>`;
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const form = (action, fields) => `<form data-action="${action}">${fields}</form>`;
const option = (value, caption=value, selected=false) => `<option value="${esc(value)}" ${selected?'selected':''}>${esc(caption)}</option>`;
const select = (name, title, options) => `<label>${title}<select name="${name}" required>${options}</select></label>`;
const panel = (title, body) => `<section class="panel"><h2>${title}</h2>${body}</section>`;
const pill = (label, warn=false) => `<span class="pill ${warn?'warn':''}">${label}</span>`;
const table = (columns, rows, empty, rowAttrs=[]) => rows.length ? `<div class="scroll"><table><thead><tr>${columns.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r,i)=>`<tr ${rowAttrs[i]||''}>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : `<p>${empty}</p>`;
function message(text) {
  toast.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>toast.textContent='', 7500);
}
async function api(action, data) {
  const options = action === 'state' && stateEtag ? {headers:{'If-None-Match':stateEtag}} : {};
  if(data !== undefined) Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const response = await fetch('/api/'+action, options);
  if(response.status===304) return {notModified:true};
  if(action==='state') stateEtag=response.headers.get('ETag');
  if (response.status === 401 && action === 'state') return null;
  const body = await response.json();
  if (!response.ok) throw Error(body.error);
  return body;
}
async function loadStoreSales(client, force=false, offset=salesOffset) {
  const shop=state?.stores?.[client];
  if(!shop||(!force&&salesData?.client===client&&salesData.cursor===shop.cursor&&salesData.offset===offset)||salesLoading===client)return;
  salesLoading=client;
  try {
    const response=await fetch('/api/sales?client='+encodeURIComponent(client)+'&offset='+offset,{cache:'no-store'});
    const body=await response.json();
    if(!response.ok) throw Error(body.error||'读取店铺出单信息失败');
    salesData=body;
  } catch(error) {
    salesData={client,name:shop.name,cursor:shop.cursor,offset,error:error.message,total:0,limit:salesPageSize,sales:[]};
  } finally {
    if(salesLoading===client) salesLoading=null;
    if(state&&tab==='店铺出单'&&selectedStore===client) render();
  }
}
function purchaseOrderRow() {
  return `<tr data-order-row>
    <td><input data-order-field="item" aria-label="仓库商品 ID" placeholder="仓库商品 ID"></td>
    <td><input data-order-field="number" aria-label="采购单号" placeholder="采购单号"></td>
    <td><input data-order-field="sku" aria-label="商品 SKU" placeholder="商品 SKU"></td>
    <td><input data-order-field="name" aria-label="商品名称" placeholder="商品名称"></td>
    <td><input data-order-field="quantity" aria-label="采购数量" type="number" min="1" step="1" placeholder="数量"></td>
    <td><input data-order-field="platform" aria-label="采购平台" placeholder="采购平台"></td>
    <td><button type="button" class="alt" data-remove-order-row>移除</button></td>
  </tr>`;
}
async function encodeFileBase64(file) {
  const bytes=new Uint8Array(await file.arrayBuffer());
  const chunks=[];
  for(let start=0;start<bytes.length;start+=0x8000) chunks.push(String.fromCharCode(...bytes.subarray(start,start+0x8000)));
  return btoa(chunks.join(''));
}
function procurement() {
  return `<section class="panel batch-order-panel"><h2>新建采购单</h2>
    <p>可导入 Excel（.xlsx）或 CSV / TSV 表格。首行列名需要包含：仓库商品 ID、采购单号、商品 SKU、商品名称、采购数量、采购平台。导入后可在下方检查和修改，再批量提交。</p>
    <form class="order-import-form" data-action="import-orders">
      <label>选择采购表格<input name="file" type="file" accept=".xlsx,.csv,.tsv,.txt" required></label>
      <button type="submit" class="alt">导入到下方表格</button>
    </form>
    <p>也可以直接在表格中逐行填写采购单，再一次性批量提交。</p>
    <form class="batch-order-form" data-action="order-batch">
      <div class="scroll"><table class="batch-order-table"><thead><tr><th>仓库商品 ID</th><th>采购单号</th><th>商品 SKU</th><th>商品名称</th><th>采购数量</th><th>采购平台</th><th>操作</th></tr></thead>
        <tbody data-order-rows>${purchaseOrderRow()}</tbody>
      </table></div>
      <div class="batch-order-actions"><button type="button" class="alt" data-add-order-row>添加一行</button><button type="submit">批量提交待确认订单</button></div>
    </form>
  </section>`;
}
function orders() {
  const rows = state.orders.map(o=>[
    esc(o.number),roleName(o.created_by),esc(o.item),esc(o.sku),esc(o.name),esc(o.platform),o.quantity,
    o.actual===null ? pill('待确认',true) : pill('已确认'),
    o.actual===null && state.role!=='purchase' ? form('receipt', hidden('id',o.id)+
      `<input aria-label="实际入库数量" name="actual" type="number" min="0" step="1" value="${o.quantity}" required>`+button('确认入库')) : o.actual ?? '—',
    o.confirmed_by ? roleName(o.confirmed_by) : '—',
    state.role==='admin' && o.legacy_record
      ? form('delete-legacy-order',hidden('id',o.id)+button('删除旧记录',true))
      : o.actual===null && (state.role==='admin' || (state.role==='purchase' && o.created_by==='purchase'))
        ? form('delete-order',hidden('id',o.id)+button('删除',true)) : '—'
  ]);
  return panel('采购订单',table(['采购单号','发起端','仓库商品 ID','SKU','商品名称','采购平台','采购数量','状态','实收数量','确认端','操作'],rows,'当前没有采购订单。'));
}
function inventory() {
  const query = inventoryQuery.trim().toLocaleLowerCase('zh-CN');
  const entries = Object.entries(state.items);
  const rows = entries.map(([id,i])=>[
    esc(id),
    esc(i.name),
    (i.skus||[]).length ? `<div class="inventory-tags">${i.skus.map(sku=>`<span class="pill">${esc(sku)}</span>`).join('')}</div>` : '—',
    (i.purchase_orders||[]).length ? `<div class="inventory-tags">${i.purchase_orders.map(number=>`<span class="pill">${esc(number)}</span>`).join('')}</div>` : '—',
    i.stock,
    state.role==='admin' ? form('watch',hidden('item',id)+button(i.watch?'取消关注':'特别关注',true)) : (i.watch ? pill(i.stock<10?'低于 10 件':'已关注',i.stock<10) : '—'),
    `<div class="row-actions"><button type="button" class="alt" data-edit-item data-item-id="${esc(id)}" data-item-name="${esc(i.name)}" data-item-stock="${i.stock}" data-item-skus="${esc((i.skus||[]).join(';'))}">修改</button>${state.role==='admin'||state.role==='warehouse'?form('delete-item',hidden('item',id)+button('删除',true)):''}</div>`
  ]);
  const rowAttrs = entries.map(([id])=>`data-inventory-item data-item-id="${esc(id)}"${query && !id.toLocaleLowerCase('zh-CN').includes(query)?' hidden':''}`);
  const noMatch = !!query && entries.length>0 && !entries.some(([id])=>id.toLocaleLowerCase('zh-CN').includes(query));
  return `<section class="panel inventory-panel"><div class="section-heading"><h2>仓库库存</h2><label class="item-search">搜索仓库商品 ID<input type="search" data-item-search value="${esc(inventoryQuery)}" placeholder="输入完整或部分商品 ID"></label></div>`+
    table(['仓库商品 ID','商品名称','关联 SKU','采购订单号','库存数量','特别关注','操作'],rows,entries.length?'':'确认采购入库后，商品会出现在这里。',rowAttrs)+
    `<p class="empty-search" data-inventory-empty ${noMatch?'':'hidden'}>没有匹配的仓库商品 ID。</p></section>`+
    `<dialog class="item-dialog" data-item-dialog><form data-action="edit-item" class="item-dialog-form">
      <div class="dialog-heading"><div><span class="eyebrow">仓库库存</span><h2>修改商品信息</h2></div><button type="button" class="close-dialog" data-close-item aria-label="关闭">×</button></div>
      ${hidden('item','')}${input('new_item','仓库商品 ID')}${input('name','商品名称')}${input('stock','库存数量','number','min="0" step="1"')}
      <label>关联 SKU（多个用“;”分隔）<input name="skus" type="text" maxlength="2000" placeholder="SKU001;SKU002"></label>
      <div class="dialog-actions"><button type="button" class="alt" data-close-item>取消</button><button type="submit">保存修改</button></div>
    </form></dialog>`;
}
function inventoryMoves() {
  return panel('库存流水',table(['时间（北京时间）','操作端口','仓库商品 ID','库存变动','来源','操作'],state.moves.map(m=>[
    date(m.at),esc(m.actor||'历史记录'),esc(m.item),m.delta>0?'+'+m.delta:m.delta,esc(m.ref),
    state.role==='admin'&&m.legacy_record
      ? form('delete-legacy-move',hidden('id',m.id)+button('删除旧记录',true)) : '—'
  ]),'当前没有库存变动。'));
}
function stores() {
  const shops = Object.values(state.stores || {});
  if (!shops.some(shop=>shop.client===selectedStore)) selectedStore=shops[0]?.client;
  const selected = shops.find(shop=>shop.client===selectedStore);
  const searching = Object.values(catalogSearch).some(value=>String(value).trim());
  const bindableItems = state.items
    ? Object.entries(state.items)
    : (state.item_options || []).map(item=>[item.id,item]);
  const storeSelect = shops.length
    ? `<label class="store-select">当前店铺<select data-store-select>${shops.map(shop=>option(shop.client,shop.name,shop.client===selectedStore)).join('')}</select></label>`
    : '<span class="store-empty">尚未绑定店铺</span>';
  const searchToolbar = `<form class="catalog-search" data-catalog-search>
    <label>商品名称<input name="name" value="${esc(catalogSearch.name)}" placeholder="搜索名称"></label>
    <label>商品 SKU<input name="sku" value="${esc(catalogSearch.sku)}" placeholder="搜索 SKU"></label>
    <label>商品货号<input name="offer" value="${esc(catalogSearch.offer)}" placeholder="搜索货号"></label>
    <div class="catalog-search-actions"><button type="submit">搜索所有店铺</button><button type="button" class="alt" data-clear-catalog-search>清除</button></div>
  </form>`;
  const storeToolbar = `<div class="store-toolbar">${storeSelect}<button type="button" class="alt" data-open-store>绑定新店铺</button>${selected?form('sync',hidden('client',selected.client)+button('同步所选店铺')):''}</div>`;
  const selectedProducts = selected ? (selected.catalog || []).map(product=>({
    ...product, _client:selected.client, _store:selected.name, _bindings:selected.bindings || {},
  })) : [];
  const allProducts = shops.flatMap(shop=>(shop.catalog || []).map(product=>({
    ...product, _client:shop.client, _store:shop.name, _bindings:shop.bindings || {},
  })));
  const sourceProducts = searching ? allProducts : selectedProducts;
  const categorySource = searching ? allProducts : selectedProducts;
  const nameQuery = catalogSearch.name.trim().toLocaleLowerCase('zh-CN');
  const skuQuery = catalogSearch.sku.trim().toLocaleLowerCase('zh-CN');
  const offerQuery = catalogSearch.offer.trim().toLocaleLowerCase('zh-CN');
  const matchingProducts = sourceProducts.filter(product=>
    (!nameQuery || String(product.name || '').toLocaleLowerCase('zh-CN').includes(nameQuery)) &&
    (!skuQuery || String(product.sku || '').toLocaleLowerCase('zh-CN').includes(skuQuery)) &&
    (!offerQuery || String(product.offer_id || '').toLocaleLowerCase('zh-CN').includes(offerQuery))
  );
  const categoryNames = new Map();
  for (const product of categorySource) {
    const categoryId = String(product.category_id ?? '');
    if (categoryId) categoryNames.set(categoryId,product.category || `类目 ${categoryId}`);
  }
  const unclassified = categorySource.some(product=>!String(product.category_id ?? ''));
  const categoryKey = searching ? 'all-stores' : selected?.client || 'none';
  const selectedCategory = String(categoryFilters[categoryKey] ?? 'all');
  const products = matchingProducts.filter(product=>{
    const categoryId = String(product.category_id ?? '');
    if (selectedCategory==='unclassified') return !categoryId;
    return selectedCategory==='all' || categoryId===selectedCategory;
  });
  const categoryControl = `<label class="category-filter">商品类目<select data-category-filter data-category-key="${esc(categoryKey)}">${option('all','全部类目',selectedCategory==='all')}${[...categoryNames].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,name])=>option(id,name,selectedCategory===id)).join('')}${unclassified?option('unclassified','未分类',selectedCategory==='unclassified'):''}</select></label>`;
  const catalogRows = products.map(product=>{
    const image = typeof product.primary_image === 'string' && product.primary_image.startsWith('https://')
      ? `<img class="product-thumb" src="${esc(product.primary_image)}" alt="" loading="lazy">`
      : '<span class="image-placeholder">无主图</span>';
    const productInfo = `<div class="catalog-product">${image}<div class="catalog-product-copy"><strong>${esc(product.name||'未命名商品')}</strong><span>货号：${esc(product.offer_id)}</span><span>SKU：${esc(product.sku||'—')}</span><span>类目：${esc(product.category||product.category_id||'未分类')}</span></div></div>`;
    const boundItem = product._bindings[product.offer_id];
    const binding = boundItem
      ? `<div class="bound-cell"><span class="pill">${esc(boundItem)}</span>${form('unbind',hidden('client',product._client)+hidden('offer',product.offer_id)+button('解绑',true))}</div>`
      : bindableItems.length
        ? form('bind',hidden('client',product._client)+hidden('offer',product.offer_id)+
          `<label class="inline-bind"><span class="sr-only">绑定到仓库商品</span><select name="item" aria-label="${esc(product.offer_id)} 绑定到仓库商品 ID" required><option value="">选择仓库商品 ID</option>${bindableItems.map(([id,item])=>option(id,id+' · '+item.name)).join('')}</select></label>`+
          button('绑定',true))
        : '<span class="pill warn">暂无可绑定的仓库商品</span>';
    return [productInfo,esc(product._store),binding];
  });
  const summary = searching
    ? `<p class="catalog-summary">搜索范围：全部 ${shops.length} 家店铺 · 找到 ${products.length} 个商品</p>`
    : selected
      ? `<p class="catalog-summary">${esc(selected.name)} · ${selected.catalog?.length ?? selected.offers?.length ?? 0} 个商品 · ${Object.keys(selected.bindings || {}).length} 个货号已绑定 · ${selected.pending ?? 0} 条订单待匹配${selected.error?' · '+esc(selected.error):''}</p><p class="catalog-summary">上次同步 ${date(selected.cursor)}</p>`
      : '<p class="catalog-summary">绑定店铺后，可以在上方选择店铺并查看商品。</p>';
  const dialog = `<dialog class="store-dialog" data-store-dialog><form data-action="store" class="store-dialog-form">
    <div class="dialog-heading"><div><span class="eyebrow">OZON 店铺</span><h2>绑定新店铺</h2></div><button type="button" class="close-dialog" data-close-store aria-label="关闭">×</button></div>
    ${input('name','店铺名称')}${input('client','Client-Id')}${input('key','API Key','password','autocomplete="off"')}
    <div class="dialog-actions"><button type="button" class="alt" data-close-store>取消</button><button type="submit">保存店铺</button></div>
  </form></dialog>`;
  return `<section class="panel ozon-panel"><div class="section-heading"><h2>OZON 店铺商品</h2>${storeToolbar}</div>${searchToolbar}${summary}
    <div class="catalog-filter">${categoryControl}<span>${products.length} 个商品</span></div>
    ${table(['商品信息','店铺','仓库商品 ID'],catalogRows,searching?'没有符合条件的商品。':'当前店铺没有已抓取商品。')}
  </section>${dialog}`;
}
function storeSales() {
  const shops=Object.values(state.stores||{});
  if(!shops.some(shop=>shop.client===selectedStore)) selectedStore=shops[0]?.client;
  const selected=shops.find(shop=>shop.client===selectedStore);
  const data=salesData?.client===selectedStore&&salesData.offset===salesOffset?salesData:null;
  const today=new Date().toISOString().slice(0,10);
  const historyStart=new Date(Date.now()-90*24*60*60*1000).toISOString().slice(0,10);
  const picker=shops.length
    ? `<div class="sales-toolbar"><label>选择店铺<select data-sales-store>${shops.map(shop=>option(shop.client,shop.name,shop.client===selectedStore)).join('')}</select></label>${selected?form('sync',hidden('client',selected.client)+button('同步店铺出单')):''}${selected?`<form class="history-sync-form" data-action="sync-history">${hidden('client',selected.client)}<label>历史开始日期<input name="since" type="date" value="${historyStart}" max="${today}" required></label><button type="submit" class="alt">读取历史出单</button></form><button type="button" class="alt" data-refresh-sales>重新读取</button>`:''}</div>`
    : '<p>请先在 OZON 店铺页面绑定店铺。</p>';
  const summary=selected
    ? `<p class="catalog-summary">${esc(selected.name)} · ${data?`第 ${Math.floor(data.offset/data.limit)+1} 页，共 ${data.total} 个订单`:(salesLoading===selected.client?'正在读取出单信息…':'尚未读取订单')} · 上次同步 ${date(selected.cursor)}${(data?.error||selected.error)?' · '+esc(data?.error||selected.error):''}</p><p class="sales-note">历史订单仅写入出单记录，不会扣减当前仓库库存；开始日期默认近 90 天，可向前调整。</p>`
    : '';
  const rows=selected?(data?.sales||[]).flatMap(sale=>(sale.products||[]).map(product=>[
    sale.created_at||sale.in_process_at?date(sale.created_at||sale.in_process_at):'—',
    esc(sale.number),esc(sale.status||'—'),esc(sale.substatus||'—'),
    esc(product.name||'—'),esc(product.sku||'—'),esc(product.offer_id||'—'),product.quantity,
    esc(selected.bindings?.[product.offer_id]||'未绑定')
  ])):[];
  const empty=salesLoading===selected?.client?'正在读取出单信息…':'当前店铺还没有已同步的出单信息。';
  const pagination=data&&data.total>data.limit?`<div class="sales-pagination"><button type="button" class="alt" data-sales-offset="${Math.max(0,data.offset-data.limit)}" ${data.offset<=0?'disabled':''}>上一页</button><span>第 ${Math.floor(data.offset/data.limit)+1} / ${Math.ceil(data.total/data.limit)} 页</span><button type="button" class="alt" data-sales-offset="${data.offset+data.limit}" ${data.offset+data.limit>=data.total?'disabled':''}>下一页</button></div>`:'';
  return `<section class="panel sales-panel"><div class="section-heading"><h2>店铺出单信息</h2>${picker}</div>${summary}${table(['出单时间','店铺订单号','状态','子状态','商品名称','SKU','货号','数量','仓库商品 ID'],rows,empty)}${pagination}</section>`;
}
function permissions() {
  const featureNames = {orders:'订单',inventory:'库存',moves:'库存流水',ozon:'OZON 店铺'};
  return panel('端口功能权限',Object.entries(state.enabled || {}).map(([role,features])=>
    `<section class="permission-role"><h3>${roles[role]}</h3><div class="permission-grid">${Object.entries(featureNames).map(([feature,label])=>{
      const enabled=!!features[feature];
      return `<div class="permission-row"><span>${label}</span>${form('toggle',hidden('role',role)+hidden('feature',feature)+button(enabled?'已开放':'未开放',true))}</div>`;
    }).join('')}</div></section>`).join(''));
}
function notices() {
  const labels={low:'低库存',pending:'待确认订单',receipt:'入库确认',order_deleted:'订单删除',record_deleted:'历史记录删除',item_deleted:'库存商品删除'};
  const rows=state.notices.map(n=>[
    date(n.at),pill(labels[n.kind]||'通知',n.kind==='low'||n.kind==='pending'),esc(n.actor||'—'),esc(n.message),
    n.read ? pill('已读') : form('read-notice',hidden('id',n.id)+button('标记已读',true))
  ]);
  const rowAttrs=state.notices.map(n=>n.read?'':'class="notice-unread"');
  const readAll=state.unread_count ? form('read-all-notices',button('全部标为已读',true)) : '';
  return `<section class="panel notice-panel"><div class="section-heading"><h2>消息通知</h2>${readAll}</div>${table(['时间（北京时间）','类型','操作端口','内容','状态 / 操作'],rows,'当前没有消息。',rowAttrs)}</section>`;
}
function render() {
  if (!state) {
    if (!Object.hasOwn(roles,entryRole)) {
      app.innerHTML = `<header><b>仓库管理系统</b></header><main><div class="eyebrow">仓库管理工作台</div><h1>选择工作入口</h1><p>不同岗位使用各自的登录入口和权限。</p><div class="portal-grid">${Object.entries(roles).map(([role,name])=>
        `<a class="portal-card" href="/${role}"><span>${esc(name)}</span><strong>进入工作台 <b aria-hidden="true">→</b></strong></a>`).join('')}</div></main>`;
      return;
    }
    const roleName = roles[entryRole];
    app.innerHTML = `<header><b>仓库管理系统</b><a class="header-link" href="/">返回入口</a></header><main class="login"><div class="eyebrow">独立登录入口</div><h1>${esc(roleName)}</h1>${panel(`${esc(roleName)}登录`,form('login',
      hidden('role',entryRole)+input('password','登录密码','password','autocomplete="current-password"')+button('进入工作台')))}</main>`;
    return;
  }
  const role = state.role;
  const features = state.features || {orders:true,inventory:true,moves:true,ozon:true};
  const tabs = {};
  if (features.orders) tabs['订单'] = ()=> ((role==='purchase'||role==='admin')?procurement():'')+orders();
  if (features.inventory) tabs['库存'] = inventory;
  if (features.moves) tabs['库存流水'] = inventoryMoves;
  if (features.ozon) tabs['OZON 店铺'] = stores;
  if (features.ozon) tabs['店铺出单'] = storeSales;
  if (role==='admin') tabs['权限管理'] = permissions;
  tabs['消息'] = notices;
  if (!Object.hasOwn(tabs,tab)) tab = Object.keys(tabs)[0];
  const stats=[];
  if (features.orders && state.orders) {
    stats.push(['待确认订单',state.orders.filter(order=>order.actual===null).length]);
    stats.push(['已确认订单',state.orders.filter(order=>order.actual!==null).length]);
  }
  if (features.inventory && state.items) stats.push(['低库存关注商品',Object.values(state.items).filter(item=>item.watch&&item.stock<10).length]);
  const statsHtml = stats.length ? `<div class="stats">${stats.map(([title,count])=>`<div class="card"><span>${title}</span><strong>${count}</strong></div>`).join('')}</div>` : '';
  app.innerHTML = `<header><b>仓库管理系统</b>${form('logout',button('退出登录',true))}</header><main><div class="eyebrow">仓库运营</div><h1>${roles[role]}工作台</h1>
    ${statsHtml}<nav aria-label="工作台导航">${Object.keys(tabs).map(t=>`<button class="alt" data-tab="${t}" aria-current="${t===tab}">${t}${t==='消息'&&state.unread_count?' · '+state.unread_count:''}</button>`).join('')}</nav>${tabs[tab]()}</main>`;
  if(tab==='店铺出单'&&selectedStore) loadStoreSales(selectedStore);
}
async function refresh(force=false) {
  const next = await api('state');
  if(next?.notModified) return;
  if (!next) {
    if (state || force) { state = null; seen.clear(); render(); }
    return;
  }
  const unseenUnread = (next.notices || []).filter(n=>!n.read&&!seen.has(n.id));
  for (const n of next.notices || []) seen.add(n.id);
  if (unseenUnread.length) message(unseenUnread[0].message + (unseenUnread.length>1?`（另有 ${unseenUnread.length-1} 条未读消息）`:''));
  if (force || JSON.stringify(next)!==JSON.stringify(state)) {
    if (!force && next.allowed && (document.querySelector('form[data-dirty]') || document.querySelector('dialog[open]'))) return;
    state = next;
    if (location.pathname==='/' && Object.hasOwn(roles,next.role)) {
      entryRole=next.role;
      history.replaceState(null,'',`/${next.role}`);
    }
    render();
  } else if (app.querySelector('h1')?.textContent === '登录工作台') render();
}
app.addEventListener('input', e=>{
  if(e.target.matches('[data-item-search]')) {
    inventoryQuery=e.target.value;
    const query=inventoryQuery.trim().toLocaleLowerCase('zh-CN');
    let visible=0;
    for(const row of app.querySelectorAll('[data-inventory-item]')) {
      row.hidden=!!query&&!row.dataset.itemId.toLocaleLowerCase('zh-CN').includes(query);
      if(!row.hidden) visible++;
    }
    const empty=app.querySelector('[data-inventory-empty]');
    if(empty) empty.hidden=visible>0;
  }
  if(e.target.form) e.target.form.dataset.dirty = 'true';
});
app.addEventListener('click', e=>{
  const tabButton=e.target.closest('[data-tab]');
  if(tabButton){tab=tabButton.dataset.tab;render();}
  if(e.target.closest('[data-add-order-row]')) {
    const rows=app.querySelector('[data-order-rows]');
    rows?.insertAdjacentHTML('beforeend',purchaseOrderRow());
    const batchForm=app.querySelector('form[data-action="order-batch"]');
    if(batchForm) batchForm.dataset.dirty='true';
  }
  const removeOrderRow=e.target.closest('[data-remove-order-row]');
  if(removeOrderRow) {
    const rows=app.querySelectorAll('[data-order-row]');
    const row=removeOrderRow.closest('[data-order-row]');
    if(rows.length>1) row.remove();
    else row.querySelectorAll('input').forEach(field=>field.value='');
    const batchForm=app.querySelector('form[data-action="order-batch"]');
    if(batchForm) batchForm.dataset.dirty='true';
  }
  if(e.target.closest('[data-open-store]')) app.querySelector('[data-store-dialog]')?.showModal();
  if(e.target.closest('[data-close-store]')) app.querySelector('[data-store-dialog]')?.close();
  const editItem=e.target.closest('[data-edit-item]');
  if(editItem) {
    const dialog=app.querySelector('[data-item-dialog]');
    dialog.querySelector('[name="item"]').value=editItem.dataset.itemId;
    dialog.querySelector('[name="new_item"]').value=editItem.dataset.itemId;
    dialog.querySelector('[name="name"]').value=editItem.dataset.itemName;
    dialog.querySelector('[name="stock"]').value=editItem.dataset.itemStock;
    dialog.querySelector('[name="skus"]').value=editItem.dataset.itemSkus;
    dialog.showModal();
  }
  if(e.target.closest('[data-close-item]')) app.querySelector('[data-item-dialog]')?.close();
  if(e.target.closest('[data-clear-catalog-search]')) {catalogSearch={name:'',sku:'',offer:''};render();}
  if(e.target.closest('[data-refresh-sales]')&&selectedStore) loadStoreSales(selectedStore,true,salesOffset);
  const salesPage=e.target.closest('[data-sales-offset]');
  if(salesPage&&selectedStore) {
    salesOffset=Number(salesPage.dataset.salesOffset);
    loadStoreSales(selectedStore,true,salesOffset);
  }
});
app.addEventListener('change', e=>{
  if(e.target.matches('[data-category-filter]')) {
    categoryFilters[e.target.dataset.categoryKey]=e.target.value;
    render();
  }
  if(e.target.matches('[data-store-select]')) {
    selectedStore=e.target.value;
    catalogSearch={name:'',sku:'',offer:''};
    render();
  }
  if(e.target.matches('[data-sales-store]')) {
    selectedStore=e.target.value;
    salesOffset=0;
    render();
  }
});
app.addEventListener('submit',async e=>{
  e.preventDefault();
  if(e.target.matches('[data-catalog-search]')) {
    catalogSearch=Object.fromEntries(new FormData(e.target));
    render();
    return;
  }
  if(busy)return;
  if(e.target.dataset.action==='import-orders') {
    busy=true;
    const importButton=e.submitter;
    if(importButton) importButton.disabled=true;
    try {
      const file=e.target.querySelector('input[type="file"]')?.files?.[0];
      if(!file) throw Error('请选择要导入的采购表格');
      const result=await api('import-orders',{filename:file.name,content:await encodeFileBase64(file)});
      const orderRows=app.querySelector('[data-order-rows]');
      orderRows.innerHTML=result.orders.map(()=>purchaseOrderRow()).join('');
      Array.from(orderRows.querySelectorAll('[data-order-row]')).forEach((row,index)=>{
        for(const field of row.querySelectorAll('[data-order-field]')) field.value=result.orders[index][field.dataset.orderField]??'';
      });
      const batchForm=app.querySelector('form[data-action="order-batch"]');
      if(batchForm) batchForm.dataset.dirty='true';
      e.target.querySelector('input[type="file"]').value='';
      message(`已导入 ${result.orders.length} 条采购单，请检查后批量提交。`);
    } catch(error) { message(error.message); }
    finally { busy=false; if(importButton) importButton.disabled=false; }
    return;
  }
  busy=true;
  const action=e.target.dataset.action;
  let data=Object.fromEntries(new FormData(e.target));
  if(action==='order-batch') {
    const orders=Array.from(e.target.querySelectorAll('[data-order-row]')).map(row=>
      Object.fromEntries(Array.from(row.querySelectorAll('[data-order-field]')).map(field=>[field.dataset.orderField,field.value.trim()]))
    ).filter(order=>Object.values(order).some(value=>value!==''));
    if(!orders.length){busy=false;message('请至少填写一条采购单。');return;}
    data={orders:orders.map(order=>({...order,quantity:Number(order.quantity)}))};
  }
  if(action==='delete-legacy-order'&&!window.confirm('删除这条旧版本采购单记录？不会改变当前库存。')){busy=false;return;}
  if(action==='delete-legacy-move'&&!window.confirm('删除这条旧版本库存流水？不会改变当前库存。')){busy=false;return;}
  if(action==='delete-item'&&!window.confirm(`确定删除仓库商品 ${data.item} 及其采购单、库存流水和货号绑定？删除后当前库存不会恢复。`)){busy=false;return;}
  for(const key of ['quantity','actual','stock']) if(key in data) data[key]=Number(data[key]);
  const submit=e.submitter;
  if(submit) submit.disabled=true;
  try{
    if(action==='store') selectedStore=data.client;
    await api(action,data);
    if(action==='sync'||action==='sync-history') {
      salesOffset=0;
      salesData=null;
    }
    if(action==='login') {
      stateEtag=null;
      entryRole=data.role;
      history.replaceState(null,'',`/${entryRole}`);
      tab='订单';
      seen.clear();
      salesData=null;
      salesLoading=null;
      salesOffset=0;
    }
    if(action==='logout') {
      stateEtag=null;
      const loggedRole=state?.role || entryRole;
      entryRole=loggedRole;
      history.replaceState(null,'',`/${loggedRole}`);
      tab=null;
      seen.clear();
      inventoryQuery='';
      salesData=null;
      salesLoading=null;
      salesOffset=0;
    }
    const success={order:'已提交待确认采购单','order-batch':'批量采购单已提交',receipt:'已确认入库','delete-order':'待确认采购单已删除','delete-legacy-order':'历史采购单记录已删除','delete-legacy-move':'历史库存流水已删除','delete-item':'仓库商品和关联数据已删除','read-notice':'消息已标记为已读','read-all-notices':'未读消息已全部标记为已读','edit-item':'商品 ID、名称、库存和 SKU 已更新',store:'店铺已添加并保存',bind:'已保存绑定',unbind:'货号绑定已解除',sync:'同步完成','sync-history':'历史出单读取完成',toggle:'权限已更新',watch:'关注设置已更新',stock:'库存已手动调整','rename-item':'仓库商品 ID 已更新'};
    if(success[action]) message(success[action]);
    await refresh(true);
  }catch(error){message(error.message);}
  finally{busy=false;if(submit)submit.disabled=false;}
});
render();
refresh().catch(error=>message(error.message));
setInterval(()=>{if(!busy)refresh().catch(()=>{});},5000);

