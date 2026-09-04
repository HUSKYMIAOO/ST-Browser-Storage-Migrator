(() => {
  'use strict';

  const TOOL_ID = 'st-browser-storage-migrator';
  const FORMAT = 'STBrowserStorageBackup';
  const VERSION = 1;

  if (document.getElementById(TOOL_ID)) return;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function encode(v) {
    if (v === undefined) return { __stType: 'Undefined' };
    if (v === null) return null;

    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return { __stType: 'BigInt', value: v.toString() };

    if (v instanceof Date) return { __stType: 'Date', value: v.toISOString() };

    if (v instanceof ArrayBuffer) {
      return { __stType: 'ArrayBuffer', value: bytesToBase64(new Uint8Array(v)) };
    }

    if (ArrayBuffer.isView(v)) {
      return {
        __stType: 'TypedArray',
        ctor: v.constructor?.name || 'Uint8Array',
        value: bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))
      };
    }

    if (v instanceof Blob) {
      const buf = await v.arrayBuffer();
      return {
        __stType: 'Blob',
        mime: v.type || '',
        value: bytesToBase64(new Uint8Array(buf))
      };
    }

    if (v instanceof Map) {
      const entries = [];
      for (const [k, val] of v.entries()) entries.push([await encode(k), await encode(val)]);
      return { __stType: 'Map', entries };
    }

    if (v instanceof Set) {
      const values = [];
      for (const val of v.values()) values.push(await encode(val));
      return { __stType: 'Set', values };
    }

    if (Array.isArray(v)) {
      const arr = [];
      for (const item of v) arr.push(await encode(item));
      return arr;
    }

    const obj = {};
    for (const key of Object.keys(v)) obj[key] = await encode(v[key]);
    return obj;
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
        BigInt64Array: globalThis.BigInt64Array,
        BigUint64Array: globalThis.BigUint64Array,
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

    const obj = {};
    for (const key of Object.keys(v)) obj[key] = await decode(v[key]);
    return obj;
  }

  async function listDatabases() {
    if (typeof indexedDB.databases === 'function') {
      const infos = await indexedDB.databases();
      return infos.filter(x => x && x.name).map(x => ({ name: x.name, version: x.version || 1 }));
    }

    // Safari/older browser fallback: ask user for names.
    const raw = prompt(
      '当前浏览器不能自动枚举 IndexedDB。\n请输入要备份的数据库名，用英文逗号分隔。\n\n' +
      '例如：ImperialCheckpoint,yuzuki_memory'
    );
    if (!raw) return [];
    return raw.split(',').map(x => x.trim()).filter(Boolean).map(name => ({ name, version: 1 }));
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
          name: storeName,
          keyPath: store.keyPath,
          autoIncrement: store.autoIncrement,
          indexes: []
        };

        for (const idxName of Array.from(store.indexNames)) {
          const idx = store.index(idxName);
          schema.indexes.push({
            name: idx.name,
            keyPath: idx.keyPath,
            unique: idx.unique,
            multiEntry: idx.multiEntry
          });
        }

        const records = [];

        await new Promise((resolve, reject) => {
          const c = store.openCursor();
          c.onerror = () => reject(c.error);
          c.onsuccess = async () => {
            const cursor = c.result;
            if (!cursor) return resolve();
            try {
              records.push({
                key: await encode(cursor.primaryKey),
                value: await encode(cursor.value)
              });
              cursor.continue();
            } catch (e) {
              reject(e);
            }
          };
        });

        await txDone(tx);
        stores.push({ schema, records });
      }

      return {
        name: db.name,
        version: db.version,
        stores
      };
    } finally {
      db.close();
    }
  }

  async function makeBackup(setStatus) {
    const backup = {
      format: FORMAT,
      backupVersion: VERSION,
      origin: location.origin,
      createdAt: new Date().toISOString(),
      localStorage: {},
      sessionStorage: {},
      indexedDB: []
    };

    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      backup.localStorage[k] = localStorage.getItem(k);
    }

    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      backup.sessionStorage[k] = sessionStorage.getItem(k);
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

    // iPhone/iPad Safari: share sheet is usually more reliable than forced download.
    try {
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({
          title: 'SillyTavern 浏览器存档备份',
          text: 'LocalStorage / SessionStorage / IndexedDB 备份',
          files: [file]
        });
        return;
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.warn('Web Share failed, falling back to download', e);
    }

    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1500);
  }

  async function ensureDatabaseSchema(dbBackup) {
    // First open current DB if it exists.
    let currentVersion = 0;
    let currentStores = [];

    try {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(dbBackup.name);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onupgradeneeded = () => {
          // A missing DB was just created. We'll close it and upgrade below.
          r.transaction.abort();
        };
      });
      currentVersion = db.version || 1;
      currentStores = Array.from(db.objectStoreNames);
      db.close();
    } catch (_) {
      // Missing DB / aborted creation: continue below.
    }

    const desiredStores = dbBackup.stores.map(x => x.schema.name);
    const missingStores = desiredStores.filter(x => !currentStores.includes(x));

    if (currentStores.length > 0 && missingStores.length === 0) {
      return;
    }

    const targetVersion = Math.max(
      Number(dbBackup.version) || 1,
      currentVersion > 0 ? currentVersion + 1 : 1
    );

    await new Promise((resolve, reject) => {
      const r = indexedDB.open(dbBackup.name, targetVersion);

      r.onupgradeneeded = () => {
        const db = r.result;

        for (const item of dbBackup.stores) {
          const s = item.schema;
          let store;

          if (!db.objectStoreNames.contains(s.name)) {
            const options = { autoIncrement: !!s.autoIncrement };
            if (s.keyPath !== null && s.keyPath !== undefined) options.keyPath = s.keyPath;
            store = db.createObjectStore(s.name, options);
          } else {
            store = r.transaction.objectStore(s.name);
          }

          for (const idx of s.indexes || []) {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, {
                unique: !!idx.unique,
                multiEntry: !!idx.multiEntry
              });
            }
          }
        }
      };

      r.onsuccess = () => {
        r.result.close();
        resolve();
      };
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error(`数据库 ${dbBackup.name} 升级被阻止，请关闭其他打开酒馆的标签页后重试。`));
    });
  }

  async function restoreDatabase(dbBackup, setStatus) {
    await ensureDatabaseSchema(dbBackup);

    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open(dbBackup.name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

    try {
      for (let i = 0; i < dbBackup.stores.length; i++) {
        const item = dbBackup.stores[i];
        const s = item.schema;

        if (!db.objectStoreNames.contains(s.name)) {
          console.warn(`跳过不存在的 Object Store: ${dbBackup.name}/${s.name}`);
          continue;
        }

        setStatus(`恢复 ${dbBackup.name} / ${s.name}（${i + 1}/${dbBackup.stores.length}）`);

        const tx = db.transaction(s.name, 'readwrite');
        const store = tx.objectStore(s.name);

        await reqToPromise(store.clear());

        for (const record of item.records || []) {
          const value = await decode(record.value);
          const key = await decode(record.key);

          if (s.keyPath !== null && s.keyPath !== undefined) {
            store.put(value);
          } else {
            store.put(value, key);
          }
        }

        await txDone(tx);
      }
    } finally {
      db.close();
    }
  }

  async function restoreBackup(backup, setStatus) {
    if (!backup || backup.format !== FORMAT) {
      throw new Error('不是本工具生成的备份文件。');
    }

    if (backup.origin !== location.origin) {
      const ok = confirm(
        `备份来源与当前地址不同：\n\n` +
        `备份：${backup.origin}\n` +
        `当前：${location.origin}\n\n` +
        `电脑用 127.0.0.1、手机用局域网 IP 时这是正常的。\n\n继续导入吗？`
      );
      if (!ok) throw new Error('用户取消：Origin 不一致');
    }

    const ok = confirm(
      '即将覆盖当前页面的 LocalStorage、SessionStorage，' +
      '并清空后恢复备份中每个 IndexedDB Object Store 的数据。\n\n' +
      '建议先在当前设备也导出一次备份。\n\n继续吗？'
    );
    if (!ok) throw new Error('用户取消导入');

    setStatus('恢复 LocalStorage…');
    localStorage.clear();
    for (const [k, v] of Object.entries(backup.localStorage || {})) {
      localStorage.setItem(k, v);
    }

    setStatus('恢复 SessionStorage…');
    sessionStorage.clear();
    for (const [k, v] of Object.entries(backup.sessionStorage || {})) {
      sessionStorage.setItem(k, v);
    }

    for (let i = 0; i < (backup.indexedDB || []).length; i++) {
      const db = backup.indexedDB[i];
      setStatus(`正在恢复 IndexedDB ${i + 1}/${backup.indexedDB.length}：${db.name}`);
      await restoreDatabase(db, setStatus);
    }
  }

  // ---------- UI ----------
  const root = document.createElement('div');
  root.id = 'st-browser-storage-migrator';
  root.style.cssText = `position:fixed;right:14px;bottom:84px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;user-select:none;-webkit-user-select:none;`;

  const btn = document.createElement('button');
  btn.type='button'; btn.title='浏览器存档迁移'; btn.setAttribute('aria-label','浏览器存档迁移'); btn.textContent='⇄';
  btn.style.cssText = `width:46px;height:46px;padding:0;border:1px solid rgba(255,255,255,.55);border-radius:50%;background:rgba(18,18,22,.94);color:#fff;font-size:25px;line-height:44px;font-weight:700;text-align:center;box-shadow:0 5px 18px rgba(0,0,0,.42);cursor:pointer;touch-action:none;-webkit-tap-highlight-color:transparent;`;

  const panel=document.createElement('div');
  panel.style.cssText=`display:none;width:min(320px,calc(100vw - 28px));margin-bottom:8px;padding:13px;border-radius:12px;background:rgba(18,18,22,.98);color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.48);border:1px solid rgba(255,255,255,.24);user-select:text;-webkit-user-select:text;`;
  panel.innerHTML=`
    <div style="font-weight:700;font-size:15px;margin-bottom:8px;color:#fff;">浏览器存档迁移</div>
    <div style="font-size:12px;color:#eee;line-height:1.5;margin-bottom:11px;">迁移 LocalStorage、SessionStorage 和当前站点的全部 IndexedDB。</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button data-act="export" type="button" style="flex:1;min-width:120px;padding:10px 8px;border-radius:8px;border:1px solid #999;background:#fff;color:#111;font-weight:700;font-size:14px;cursor:pointer;">📤 导出备份</button>
      <button data-act="import" type="button" style="flex:1;min-width:120px;padding:10px 8px;border-radius:8px;border:1px solid #999;background:#fff;color:#111;font-weight:700;font-size:14px;cursor:pointer;">📥 导入备份</button>
    </div>
    <div data-status style="font-size:12px;color:#eee;margin-top:10px;word-break:break-word;">当前：${location.origin}</div>
    <div data-close style="text-align:right;margin-top:7px;"><button type="button" style="border:0;background:transparent;color:#fff;font-size:12px;text-decoration:underline;cursor:pointer;padding:3px 0;">关闭面板</button></div>`;

  const status=panel.querySelector('[data-status]');
  const setStatus=text=>{status.textContent=text;console.log('[ST Storage Migrator]',text);};
  const fileInput=document.createElement('input'); fileInput.type='file'; fileInput.accept='.json,application/json'; fileInput.style.display='none';

  let dragging=false,moved=false,suppressClick=false,startX=0,startY=0,startLeft=0,startTop=0;
  function pos(){const r=root.getBoundingClientRect();return {left:r.left,top:r.top};}
  function beginDrag(x,y){const p=pos();startX=x;startY=y;startLeft=p.left;startTop=p.top;moved=false;dragging=true;root.style.right='auto';root.style.bottom='auto';root.style.left=`${startLeft}px`;root.style.top=`${startTop}px`;}
  function moveDrag(x,y){if(!dragging)return;const dx=x-startX,dy=y-startY;if(Math.abs(dx)+Math.abs(dy)>6)moved=true;const m=6,maxL=Math.max(m,innerWidth-root.offsetWidth-m),maxT=Math.max(m,innerHeight-root.offsetHeight-m);root.style.left=`${Math.min(maxL,Math.max(m,startLeft+dx))}px`;root.style.top=`${Math.min(maxT,Math.max(m,startTop+dy))}px`;}
  function endDrag(){if(!dragging)return;dragging=false;if(moved){suppressClick=true;setTimeout(()=>suppressClick=false,150);}}
  btn.addEventListener('pointerdown',e=>{if(e.button!==undefined&&e.button!==0)return;try{btn.setPointerCapture(e.pointerId);}catch(_){}beginDrag(e.clientX,e.clientY);});
  btn.addEventListener('pointermove',e=>moveDrag(e.clientX,e.clientY)); btn.addEventListener('pointerup',endDrag); btn.addEventListener('pointercancel',endDrag);
  btn.addEventListener('click',()=>{if(suppressClick||moved)return;panel.style.display=panel.style.display==='none'?'block':'none';});
  panel.querySelector('[data-close] button').addEventListener('click',()=>panel.style.display='none');
  panel.querySelector('[data-act="export"]').addEventListener('click',async()=>{try{setStatus('正在导出…');const backup=await makeBackup(setStatus);setStatus('备份已生成，正在保存/分享…');await saveBackupFile(backup);setStatus(`✅ 导出完成：${backup.indexedDB.length} 个 IndexedDB 数据库`);}catch(e){console.error(e);setStatus(`❌ 导出失败：${e?.message||e}`);alert(`导出失败：\n${e?.message||e}`);}});
  panel.querySelector('[data-act="import"]').addEventListener('click',()=>{fileInput.value='';fileInput.click();});
  fileInput.addEventListener('change',async()=>{const file=fileInput.files?.[0];if(!file)return;try{setStatus('读取备份文件…');const backup=JSON.parse(await file.text());await restoreBackup(backup,setStatus);setStatus('✅ 导入完成。请完全刷新/重新打开 SillyTavern 页面。');alert('导入完成。\n\n请关闭当前 SillyTavern 页面并重新打开，让重前端脚本重新读取存档。');}catch(e){console.error(e);setStatus(`❌ 导入失败：${e?.message||e}`);if(!String(e?.message||e).includes('用户取消'))alert(`导入失败：\n${e?.message||e}`);}});
  root.appendChild(panel);root.appendChild(btn);root.appendChild(fileInput);document.body.appendChild(root);console.log('[ST Storage Migrator] loaded v1.0.2');
})();
