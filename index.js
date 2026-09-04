(() => {
  'use strict';

  const TOOL_ID = 'st-browser-storage-migrator';
  const FORMAT = 'STBrowserStorageBackup';
  const BACKUP_VERSION = 1;
  const UI_VERSION = '1.0.3';
  const EDGE = 8;
  const ICON_SIZE = 46;
  const GAP = 8;

  if (document.getElementById(TOOL_ID)) return;

  const req = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('IndexedDB request failed'));
  });

  const txDone = tx => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });

  const bytesToBase64 = bytes => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };

  const base64ToBytes = s => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  async function encode(v) {
    if (v === undefined) return { __stType: 'Undefined' };
    if (v === null) return null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return { __stType: 'BigInt', value: String(v) };
    if (v instanceof Date) return { __stType: 'Date', value: v.toISOString() };
    if (v instanceof ArrayBuffer) return { __stType: 'ArrayBuffer', value: bytesToBase64(new Uint8Array(v)) };
    if (ArrayBuffer.isView(v)) return {
      __stType: 'TypedArray', ctor: v.constructor?.name || 'Uint8Array',
      value: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
    };
    if (v instanceof Blob) return {
      __stType: 'Blob', mime: v.type || '',
      value: bytesToBase64(new Uint8Array(await v.arrayBuffer()))
    };
    if (v instanceof Map) {
      const entries = [];
      for (const [k, val] of v) entries.push([await encode(k), await encode(val)]);
      return { __stType: 'Map', entries };
    }
    if (v instanceof Set) {
      const values = [];
      for (const val of v) values.push(await encode(val));
      return { __stType: 'Set', values };
    }
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) out.push(await encode(x));
      return out;
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = await encode(v[k]);
    return out;
  }

  async function decode(v) {
    if (v === null) return null;
    if (Array.isArray(v)) return Promise.all(v.map(decode));
    if (typeof v !== 'object') return v;
    if (v.__stType === 'Undefined') return undefined;
    if (v.__stType === 'BigInt') return BigInt(v.value);
    if (v.__stType === 'Date') return new Date(v.value);
    if (v.__stType === 'ArrayBuffer') return base64ToBytes(v.value).buffer;
    if (v.__stType === 'Blob') return new Blob([base64ToBytes(v.value)], { type: v.mime || '' });
    if (v.__stType === 'TypedArray') {
      const bytes = base64ToBytes(v.value);
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const ctors = {
        Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array,
        BigInt64Array: globalThis.BigInt64Array, BigUint64Array: globalThis.BigUint64Array
      };
      const Ctor = ctors[v.ctor] || Uint8Array;
      return new Ctor(buf);
    }
    if (v.__stType === 'Map') {
      const m = new Map();
      for (const [k, val] of v.entries || []) m.set(await decode(k), await decode(val));
      return m;
    }
    if (v.__stType === 'Set') {
      const s = new Set();
      for (const val of v.values || []) s.add(await decode(val));
      return s;
    }
    const out = {};
    for (const k of Object.keys(v)) out[k] = await decode(v[k]);
    return out;
  }

  async function listDatabases() {
    if (typeof indexedDB.databases === 'function') {
      return (await indexedDB.databases()).filter(x => x?.name).map(x => ({ name: x.name, version: x.version || 1 }));
    }
    const raw = prompt('当前浏览器不能自动枚举 IndexedDB。\n请输入要备份的数据库名，用英文逗号分隔。');
    return raw ? raw.split(',').map(x => x.trim()).filter(Boolean).map(name => ({ name, version: 1 })) : [];
  }

  async function exportDatabase(info) {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(info.name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    try {
      const stores = [];
      for (const storeName of Array.from(db.objectStoreNames)) {
        const tx = db.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const schema = {
          name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: []
        };
        for (const name of Array.from(store.indexNames)) {
          const i = store.index(name);
          schema.indexes.push({ name: i.name, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry });
        }
        const records = [];
        await new Promise((resolve, reject) => {
          const c = store.openCursor();
          c.onerror = () => reject(c.error);
          c.onsuccess = async () => {
            const cur = c.result;
            if (!cur) return resolve();
            try {
              records.push({ key: await encode(cur.primaryKey), value: await encode(cur.value) });
              cur.continue();
            } catch (e) { reject(e); }
          };
        });
        await txDone(tx);
        stores.push({ schema, records });
      }
      return { name: db.name, version: db.version, stores };
    } finally { db.close(); }
  }

  async function makeBackup(setStatus) {
    const backup = {
      format: FORMAT, backupVersion: BACKUP_VERSION, origin: location.origin,
      createdAt: new Date().toISOString(), localStorage: {}, sessionStorage: {}, indexedDB: []
    };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); backup.localStorage[k] = localStorage.getItem(k);
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i); backup.sessionStorage[k] = sessionStorage.getItem(k);
    }
    const dbs = await listDatabases();
    for (let i = 0; i < dbs.length; i++) {
      setStatus(`正在导出 IndexedDB ${i + 1}/${dbs.length}：${dbs[i].name}`);
      backup.indexedDB.push(await exportDatabase(dbs[i]));
    }
    return backup;
  }

  async function saveBackupFile(backup) {
    const text = JSON.stringify(backup, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `ST-browser-storage-backup-${stamp}.json`;
    const file = new File([text], filename, { type: 'application/json' });
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'SillyTavern 浏览器存档备份', files: [file] });
        return;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.style.display = 'none'; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  async function ensureSchema(dbBackup) {
    let currentVersion = 0;
    let currentStores = [];
    try {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(dbBackup.name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onupgradeneeded = () => r.transaction.abort();
      });
      currentVersion = db.version || 1;
      currentStores = Array.from(db.objectStoreNames);
      db.close();
    } catch (_) {}

    const missing = dbBackup.stores.map(x => x.schema.name).filter(x => !currentStores.includes(x));
    if (currentStores.length && !missing.length) return;

    const version = Math.max(Number(dbBackup.version) || 1, currentVersion ? currentVersion + 1 : 1);
    await new Promise((resolve, reject) => {
      const r = indexedDB.open(dbBackup.name, version);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const item of dbBackup.stores) {
          const s = item.schema;
          let store;
          if (!db.objectStoreNames.contains(s.name)) {
            const opt = { autoIncrement: !!s.autoIncrement };
            if (s.keyPath !== null && s.keyPath !== undefined) opt.keyPath = s.keyPath;
            store = db.createObjectStore(s.name, opt);
          } else store = r.transaction.objectStore(s.name);
          for (const idx of s.indexes || []) {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, { unique: !!idx.unique, multiEntry: !!idx.multiEntry });
            }
          }
        }
      };
      r.onsuccess = () => { r.result.close(); resolve(); };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error(`数据库 ${dbBackup.name} 升级被阻止，请关闭其他打开酒馆的标签页后重试。`));
    });
  }

  async function restoreDatabase(dbBackup, setStatus) {
    await ensureSchema(dbBackup);
    const db = await req(indexedDB.open(dbBackup.name));
    try {
      for (let i = 0; i < dbBackup.stores.length; i++) {
        const item = dbBackup.stores[i];
        const s = item.schema;
        if (!db.objectStoreNames.contains(s.name)) continue;
        setStatus(`恢复 ${dbBackup.name} / ${s.name}（${i + 1}/${dbBackup.stores.length}）`);
        const tx = db.transaction(s.name, 'readwrite');
        const store = tx.objectStore(s.name);
        await req(store.clear());
        for (const record of item.records || []) {
          const value = await decode(record.value);
          const key = await decode(record.key);
          if (s.keyPath !== null && s.keyPath !== undefined) store.put(value);
          else store.put(value, key);
        }
        await txDone(tx);
      }
    } finally { db.close(); }
  }

  async function restoreBackup(backup, setStatus) {
    if (!backup || backup.format !== FORMAT) throw new Error('不是本工具生成的备份文件。');
    if (backup.origin !== location.origin && !confirm(`备份来源：${backup.origin}\n当前地址：${location.origin}\n\n来源不同，仍然继续导入吗？`)) {
      throw new Error('用户取消导入');
    }
    if (!confirm('导入会覆盖当前 LocalStorage、SessionStorage，并恢复备份中的 IndexedDB。\n\n建议先导出当前设备备份。继续吗？')) {
      throw new Error('用户取消导入');
    }
    setStatus('恢复 LocalStorage…');
    localStorage.clear();
    for (const [k, v] of Object.entries(backup.localStorage || {})) localStorage.setItem(k, v);
    setStatus('恢复 SessionStorage…');
    sessionStorage.clear();
    for (const [k, v] of Object.entries(backup.sessionStorage || {})) sessionStorage.setItem(k, v);
    for (let i = 0; i < (backup.indexedDB || []).length; i++) {
      const db = backup.indexedDB[i];
      setStatus(`正在恢复 IndexedDB ${i + 1}/${backup.indexedDB.length}：${db.name}`);
      await restoreDatabase(db, setStatus);
    }
  }

  // UI
  const root = document.createElement('div');
  root.id = TOOL_ID;
  root.style.cssText = `position:fixed;left:calc(100vw - 60px);top:calc(100vh - 130px);width:${ICON_SIZE}px;height:${ICON_SIZE}px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;-webkit-user-select:none;`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = '⇄';
  btn.title = '浏览器存档迁移';
  btn.style.cssText = `position:absolute;left:0;top:0;width:${ICON_SIZE}px;height:${ICON_SIZE}px;padding:0;border:1px solid rgba(255,255,255,.55);border-radius:50%;background:rgba(18,18,22,.94);color:#fff;font-size:25px;line-height:44px;font-weight:700;box-shadow:0 5px 18px rgba(0,0,0,.42);cursor:grab;touch-action:none;-webkit-tap-highlight-color:transparent;`;

  const panel = document.createElement('div');
  panel.style.cssText = 'display:none;position:absolute;width:320px;padding:13px;border-radius:12px;background:rgba(18,18,22,.98);color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.48);border:1px solid rgba(255,255,255,.24);box-sizing:border-box;touch-action:none;';
  panel.innerHTML = `
    <div data-drag-handle style="display:flex;align-items:center;justify-content:space-between;margin:-5px -4px 8px;padding:5px 4px 8px;cursor:grab;touch-action:none;">
      <b>浏览器存档迁移</b><span style="color:#bbb;font-size:16px;">⠿</span>
    </div>
    <div style="font-size:12px;color:#eee;line-height:1.5;margin-bottom:11px;">迁移 LocalStorage、SessionStorage 和当前站点全部 IndexedDB。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button data-act="export" style="flex:1;min-width:120px;padding:10px 8px;border-radius:8px;border:1px solid #999;background:#fff;color:#111;font-weight:700;">📤 导出备份</button>
      <button data-act="import" style="flex:1;min-width:120px;padding:10px 8px;border-radius:8px;border:1px solid #999;background:#fff;color:#111;font-weight:700;">📥 导入备份</button>
    </div>
    <div data-status style="font-size:12px;color:#eee;margin-top:10px;word-break:break-word;">当前：${location.origin}</div>
    <div style="text-align:right;margin-top:7px;"><button data-close style="border:0;background:transparent;color:#fff;font-size:12px;text-decoration:underline;">关闭面板</button></div>`;

  const status = panel.querySelector('[data-status]');
  const dragHandle = panel.querySelector('[data-drag-handle]');
  const fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.style.display = 'none';
  const setStatus = text => { status.textContent = text; console.log('[ST Storage Migrator]', text); };

  function viewport() {
    const vv = window.visualViewport;
    return { w: vv?.width || innerWidth, h: vv?.height || innerHeight, x: vv?.offsetLeft || 0, y: vv?.offsetTop || 0 };
  }

  function clampRoot(left, top) {
    const v = viewport();
    const minL = v.x + EDGE, minT = v.y + EDGE;
    const maxL = Math.max(minL, v.x + v.w - ICON_SIZE - EDGE);
    const maxT = Math.max(minT, v.y + v.h - ICON_SIZE - EDGE);
    return { left: Math.min(maxL, Math.max(minL, left)), top: Math.min(maxT, Math.max(minT, top)) };
  }

  function placePanel() {
    if (panel.style.display === 'none') return;
    const v = viewport();
    const rr = root.getBoundingClientRect();
    const pw = Math.min(320, Math.max(180, v.w - EDGE * 2));
    panel.style.width = `${pw}px`;
    const ph = panel.offsetHeight || 220;
    const above = rr.top - v.y;
    const below = v.y + v.h - rr.bottom;
    let top = (above >= ph + GAP || above >= below) ? -(ph + GAP) : ICON_SIZE + GAP;
    let left = rr.left + pw > v.x + v.w - EDGE ? ICON_SIZE - pw : 0;
    let absLeft = Math.min(v.x + v.w - pw - EDGE, Math.max(v.x + EDGE, rr.left + left));
    let absTop = Math.min(v.y + v.h - ph - EDGE, Math.max(v.y + EDGE, rr.top + top));
    panel.style.left = `${absLeft - rr.left}px`;
    panel.style.top = `${absTop - rr.top}px`;
  }

  let dragging = false, moved = false, suppressClick = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0, pointerId = null;

  function startDrag(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const r = root.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY; startLeft = r.left; startTop = r.top;
    moved = false; dragging = true; pointerId = e.pointerId;
    btn.style.cursor = dragHandle.style.cursor = 'grabbing';
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();
  }

  function moveDrag(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) + Math.abs(dy) > 5) moved = true;
    const p = clampRoot(startLeft + dx, startTop + dy);
    root.style.left = `${p.left}px`; root.style.top = `${p.top}px`;
    placePanel();
    e.preventDefault();
  }

  function endDrag(e) {
    if (!dragging || (pointerId !== null && e.pointerId !== pointerId)) return;
    dragging = false; pointerId = null;
    btn.style.cursor = dragHandle.style.cursor = 'grab';
    if (moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; moved = false; }, 180);
    }
  }

  for (const target of [btn, dragHandle]) {
    target.addEventListener('pointerdown', startDrag);
    target.addEventListener('pointermove', moveDrag);
    target.addEventListener('pointerup', endDrag);
    target.addEventListener('pointercancel', endDrag);
  }

  btn.addEventListener('click', () => {
    if (suppressClick || moved) return;
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display !== 'none') requestAnimationFrame(placePanel);
  });

  panel.querySelector('[data-close]').addEventListener('click', () => { panel.style.display = 'none'; });

  panel.querySelector('[data-act="export"]').addEventListener('click', async () => {
    try {
      setStatus('正在导出…');
      const backup = await makeBackup(setStatus);
      setStatus('备份已生成，正在保存/分享…');
      await saveBackupFile(backup);
      setStatus(`✅ 导出完成：${backup.indexedDB.length} 个 IndexedDB 数据库`);
    } catch (e) {
      console.error(e); setStatus(`❌ 导出失败：${e?.message || e}`); alert(`导出失败：\n${e?.message || e}`);
    }
  });

  panel.querySelector('[data-act="import"]').addEventListener('click', () => { fileInput.value = ''; fileInput.click(); });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0]; if (!file) return;
    try {
      setStatus('读取备份文件…');
      await restoreBackup(JSON.parse(await file.text()), setStatus);
      setStatus('✅ 导入完成。请重新打开 SillyTavern 页面。');
      alert('导入完成。\n\n请关闭当前 SillyTavern 页面并重新打开。');
    } catch (e) {
      console.error(e); setStatus(`❌ 导入失败：${e?.message || e}`);
      if (!String(e?.message || e).includes('用户取消')) alert(`导入失败：\n${e?.message || e}`);
    }
  });

  root.append(panel, btn, fileInput);
  document.body.appendChild(root);
  const initial = clampRoot(innerWidth - 60, innerHeight - 130);
  root.style.left = `${initial.left}px`; root.style.top = `${initial.top}px`;

  const onViewportChange = () => {
    const r = root.getBoundingClientRect();
    const p = clampRoot(r.left, r.top);
    root.style.left = `${p.left}px`; root.style.top = `${p.top}px`;
    placePanel();
  };
  window.addEventListener('resize', onViewportChange, { passive: true });
  window.visualViewport?.addEventListener('resize', onViewportChange, { passive: true });
  window.visualViewport?.addEventListener('scroll', onViewportChange, { passive: true });

  console.log(`[ST Storage Migrator] loaded v${UI_VERSION}`);
})();
