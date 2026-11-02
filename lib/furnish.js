// Buyer furnishing tool for the 3D tours: pick furniture from a catalog, place it on the floor,
// drag to move, rotate, duplicate, delete, and share the layout as a link.
// Furniture is real-size (lib/furniture/catalog.json) and blocks walking like the built-ins.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const MAX_ITEMS = 40;
const ROT_STEP = Math.PI / 4;            // rotate buttons turn by 45 degrees
const ITEM_ENV = .8;                     // furniture isn't in the bake: it is lit by the environment map
const WALK_INSET = .05;                  // walking boxes are a touch smaller than the footprint
const ACCENT = 0xe0a066;

export async function initFurnish(tour, opts){
  const { scene, camera, canvas, segs, boxes, input } = tour;
  const catalog = (await fetch(opts.lib + 'catalog.json').then(r => r.json())).items;
  // ready-made layouts are per house (they depend on its rooms); optional
  const presets = opts.presets ? await fetch(opts.presets).then(r => r.ok ? r.json() : { presets:[] }).then(j => j.presets).catch(() => []) : [];
  const byId = Object.fromEntries(catalog.map(c => [c.id, c]));
  const loader = new GLTFLoader(), models = new Map();
  const items = [];
  let selected = null, drag = null;

  /* ---------------- models ---------------- */
  function loadModel(id){
    if (!models.has(id)){
      models.set(id, loader.loadAsync(opts.lib + byId[id].file).then(g => {
        g.scene.traverse(o => {
          if (!o.isMesh) return;
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of ms) m.envMapIntensity = ITEM_ENV;
        });
        return g.scene;
      }));
    }
    return models.get(id);
  }

  const shadowTex = (() => {               // soft contact shadow, stretched to each footprint
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,.42)'); grad.addColorStop(.6, 'rgba(0,0,0,.22)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const shadowMat = new THREE.MeshBasicMaterial({ map:shadowTex, transparent:true, depthWrite:false, toneMapped:false });
  const ringMat = new THREE.MeshBasicMaterial({ color:ACCENT, transparent:true, opacity:.9, depthWrite:false, toneMapped:false });

  function outline(w, d){                 // selection frame around the footprint
    const pad = .06, t = .035, W = w / 2 + pad, D = d / 2 + pad;
    const s = new THREE.Shape([new THREE.Vector2(-W - t, -D - t), new THREE.Vector2(W + t, -D - t), new THREE.Vector2(W + t, D + t), new THREE.Vector2(-W - t, D + t)]);
    s.holes.push(new THREE.Path([new THREE.Vector2(-W, -D), new THREE.Vector2(-W, D), new THREE.Vector2(W, D), new THREE.Vector2(W, -D)]));
    const m = new THREE.Mesh(new THREE.ShapeGeometry(s), ringMat);
    m.rotation.x = -Math.PI / 2; m.position.y = .02; m.renderOrder = 2; m.visible = false;
    return m;
  }

  async function addItem(id, x, z, rot, select){
    const c = byId[id];
    if (!c || items.length >= MAX_ITEMS){ if (c) toast(`Up to ${MAX_ITEMS} pieces per layout`); return null; }
    const model = (await loadModel(id)).clone(true);
    const group = new THREE.Group();
    const isRug = c.cat === 'Living' && /^rug_/.test(id);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), shadowMat);
    sh.rotation.x = -Math.PI / 2; sh.scale.set(c.w * 1.25, c.d * 1.25, 1); sh.position.y = isRug ? .003 : .016; sh.renderOrder = 1;
    if (isRug) sh.scale.set(c.w * 1.06, c.d * 1.06, 1);
    const ring = outline(c.w, c.d);
    group.add(model, sh, ring);
    scene.add(group);
    const it = { id, c, group, ring, isRug, x, z, rot, px:x, pz:z, box:null };
    items.push(it);
    clampToWalls(it); apply(it);
    if (select) selectItem(it);
    save();
    return it;
  }

  function apply(it){
    it.group.position.set(it.x, 0, it.z); it.group.rotation.y = it.rot;
    if (it.isRug) return;                 // rugs don't block walking
    const cs = Math.abs(Math.cos(it.rot)), sn = Math.abs(Math.sin(it.rot));
    const hx = (it.c.w * cs + it.c.d * sn) / 2 - WALK_INSET, hz = (it.c.w * sn + it.c.d * cs) / 2 - WALK_INSET;
    if (!it.box){ it.box = {}; boxes.push(it.box); }
    Object.assign(it.box, { x0:it.x - hx, z0:it.z - hz, x1:it.x + hx, z1:it.z + hz });
  }

  function removeItem(it){
    scene.remove(it.group);
    if (it.box){ const k = boxes.indexOf(it.box); if (k >= 0) boxes.splice(k, 1); }
    items.splice(items.indexOf(it), 1);
    if (selected === it) selectItem(null);
    save();
  }

  // keep the (rotated) footprint out of walls and fences, staying on the side it came from
  function clampToWalls(it){
    const hw = it.c.w / 2, hd = it.c.d / 2, c = Math.cos(it.rot), s = Math.sin(it.rot);
    const ax = [c, -s], az = [s, c];                 // item's local x / z axes on the floor
    for (let iter = 0; iter < 4; iter++){
      let moved = false;
      for (const g of segs){
        const ex = g.x1 - g.x0, ez = g.z1 - g.z0, L = Math.hypot(ex, ez) || 1e-9, ux = ex / L, uz = ez / L, nx = -uz, nz = ux;
        const extU = hw * Math.abs(ax[0] * ux + ax[1] * uz) + hd * Math.abs(az[0] * ux + az[1] * uz);
        const extN = hw * Math.abs(ax[0] * nx + ax[1] * nz) + hd * Math.abs(az[0] * nx + az[1] * nz);
        const along = (it.x - g.x0) * ux + (it.z - g.z0) * uz;
        const dist = (it.x - g.x0) * nx + (it.z - g.z0) * nz, need = extN + g.t + .01;
        const prev = (it.px - g.x0) * nx + (it.pz - g.z0) * nz;
        // jumped past the wall line in one move: check where along the wall it crossed (doorway gaps stay open)
        const crossed = Math.abs(prev) > 1e-4 && Math.sign(prev) !== Math.sign(dist);
        const alongPrev = (it.px - g.x0) * ux + (it.pz - g.z0) * uz;
        const at = crossed ? alongPrev + (along - alongPrev) * (prev / (prev - dist)) : along;
        if (at < -extU || at > L + extU) continue;
        if (Math.abs(dist) >= need && !crossed) continue;
        const side = Math.abs(prev) > 1e-4 ? Math.sign(prev) : (Math.sign(dist) || 1);
        it.x += nx * (side * need - dist); it.z += nz * (side * need - dist); moved = true;
      }
      if (!moved) break;
    }
    it.px = it.x; it.pz = it.z;
  }

  /* ---------------- picking + dragging ---------------- */
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  function setRay(e){
    const r = canvas.getBoundingClientRect();
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  function pick(e){
    setRay(e);
    const hits = ray.intersectObjects(items.map(i => i.group), true).filter(h => h.object.material !== shadowMat);
    if (!hits.length) return null;
    // rugs are under everything: prefer whatever else was hit
    const owners = hits.map(h => items.find(i => { let o = h.object; while (o){ if (o === i.group) return true; o = o.parent; } return false; }));
    return owners.find(i => i && !i.isRug) || owners[0];
  }
  const floorPoint = e => { setRay(e); return ray.ray.intersectPlane(floor, hit) ? hit.clone() : null; };

  // Furniture can only be grabbed while furnishing (panel open, or the "Moving furniture" pill showing).
  // Otherwise a touch that happens to land on a piece while walking or looking around would drag it.
  let editing = false, downAt = null;
  addEventListener('pointerdown', e => {
    if (e.target !== canvas || !opts.started() || !editing) return;
    downAt = { x:e.clientX, y:e.clientY };
    const it = pick(e);
    if (!it) return;
    input.claimed = true;                 // the tour's look/joystick handlers ignore this press
    selectItem(it);
    const p = floorPoint(e);
    drag = { id:e.pointerId, it, dx:p ? it.x - p.x : 0, dz:p ? it.z - p.z : 0 };
    canvas.setPointerCapture(e.pointerId);
  }, true);
  addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const p = floorPoint(e); if (!p) return;
    const it = drag.it; it.x = p.x + drag.dx; it.z = p.z + drag.dz;
    clampToWalls(it); apply(it);
  });
  const endDrag = e => {
    if (drag && e.pointerId === drag.id){ drag = null; save(); }
    else if (e.type === 'pointerup' && e.target === canvas && selected && downAt
             && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6 && !pick(e)) selectItem(null);   // tap on empty floor
    input.claimed = false; downAt = null;
  };
  addEventListener('pointerup', endDrag); addEventListener('pointercancel', endDrag);

  /* ---------------- UI ---------------- */
  const css = document.createElement('style');
  css.textContent = `
    #fpanel{position:fixed;right:10px;top:calc(64px + env(safe-area-inset-top));width:340px;max-height:calc(100dvh - 84px);display:none;flex-direction:column;z-index:6;overflow:hidden}
    #fpanel.open{display:flex}
    #fpanel header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px 6px;font-weight:650}
    #fpanel header button{width:36px;height:36px;padding:0}
    .fsec{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:6px 14px 4px;flex:none}
    #fpresets{display:flex;gap:8px;padding:2px 14px 8px;overflow-x:auto;flex:none}
    .fpre{flex:1 0 0;min-width:96px;display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:9px 10px;white-space:normal;text-align:left;border-radius:10px}
    .fpre b{font-size:12px;font-weight:650}
    .fpre span{font-size:10.5px;line-height:1.3;color:var(--muted)}
    .fpre.on{background:rgba(224,160,102,.22);border-color:var(--accent);color:var(--text);font-weight:inherit}
    .fpre.busy{opacity:.55;pointer-events:none}
    #fcats{display:flex;gap:6px;padding:4px 14px 8px;overflow-x:auto;flex:none}
    #fcats button{padding:6px 10px;font-size:12px}
    #fgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:4px 14px 10px;overflow-y:auto;-webkit-overflow-scrolling:touch}
    .fitem{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 4px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid var(--line);white-space:normal;cursor:pointer}
    .fitem img{width:72px;height:72px;object-fit:contain}
    .fitem b{font-size:11px;font-weight:600;line-height:1.2;text-align:center}
    .fitem span{font-size:10px;color:var(--muted)}
    .fitem.loading{opacity:.5}
    #ffoot{display:flex;gap:8px;padding:10px 14px 14px;border-top:1px solid var(--line);flex:none}
    #ffoot button{flex:1}
    #fbar{position:fixed;left:50%;bottom:calc(64px + env(safe-area-inset-bottom));transform:translateX(-50%);display:none;align-items:center;gap:6px;padding:6px;z-index:6;max-width:calc(100vw - 20px)}
    #fbar.show{display:flex}
    #fbar .nm{font-size:13px;font-weight:600;padding:0 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
    #fbar button{width:44px;height:44px;padding:0;display:grid;place-items:center}
    #fmode{position:fixed;left:50%;top:calc(104px + env(safe-area-inset-top));transform:translateX(-50%);display:none;align-items:center;gap:6px;padding:5px 5px 5px 12px;font-size:13px;font-weight:600;z-index:6;white-space:nowrap}
    #fmode.show{display:flex}
    #fmode button{padding:7px 12px;font-size:12px}
    #ftoast{position:fixed;left:50%;top:calc(150px + env(safe-area-inset-top));transform:translateX(-50%);padding:8px 14px;font-size:13px;z-index:11;opacity:0;transition:opacity .25s;pointer-events:none}
    #ftoast.show{opacity:1}
    body.fopen #help{display:none}
    @media (max-width:700px){
      #fpanel{left:0;right:0;top:auto;bottom:0;width:auto;max-height:52dvh;border-radius:16px 16px 0 0;padding-bottom:env(safe-area-inset-bottom)}
      #fgrid{grid-template-columns:repeat(4,1fr)}
      .fitem img{width:60px;height:60px}
      .fpre span{display:none}
      .fpre{min-width:0;align-items:center}
      body.fopen #joyhint{display:none}
    }`;
  document.head.appendChild(css);

  const icon = p => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const panel = document.createElement('div'); panel.id = 'fpanel'; panel.className = 'card';
  panel.innerHTML = `<header><span>Furnish this home</span><button aria-label="Close">${icon('<path d="M6 6l12 12M18 6L6 18"/>')}</button></header>
    <div class="fsec" id="fpresec">Ready-made layouts</div><div id="fpresets"></div>
    <div class="fsec">Add pieces</div><div id="fcats"></div><div id="fgrid"></div>
    <div id="ffoot"><button id="fshare">Share layout</button><button id="fclear">Clear all</button></div>`;
  const bar = document.createElement('div'); bar.id = 'fbar'; bar.className = 'card';
  bar.innerHTML = `<span class="nm"></span>
    <button data-a="left" aria-label="Rotate left">${icon('<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 3v6h6"/>')}</button>
    <button data-a="right" aria-label="Rotate right">${icon('<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/>')}</button>
    <button data-a="dup" aria-label="Duplicate">${icon('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>')}</button>
    <button data-a="del" aria-label="Delete">${icon('<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>')}</button>
    <button data-a="done" aria-label="Done">${icon('<path d="M5 12l5 5L20 7"/>')}</button>`;
  const toastEl = document.createElement('div'); toastEl.id = 'ftoast'; toastEl.className = 'card';
  const modeEl = document.createElement('div'); modeEl.id = 'fmode'; modeEl.className = 'card';
  modeEl.innerHTML = `<span>Moving furniture</span><button data-a="add">Add more</button><button data-a="done" class="on">Done</button>`;
  document.body.append(panel, bar, toastEl, modeEl);
  let toastT;
  function toast(msg){ toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2200); }

  const cats = ['All', ...new Set(catalog.map(c => c.cat))];
  let cat = 'All';
  const catsEl = panel.querySelector('#fcats'), grid = panel.querySelector('#fgrid');
  function renderGrid(){
    catsEl.innerHTML = ''; grid.innerHTML = '';
    for (const k of cats){
      const b = document.createElement('button'); b.textContent = k; b.classList.toggle('on', k === cat);
      b.onclick = () => { cat = k; renderGrid(); }; catsEl.appendChild(b);
    }
    for (const c of catalog.filter(c => cat === 'All' || c.cat === cat)){
      const b = document.createElement('button'); b.className = 'fitem';
      b.innerHTML = `<img src="${opts.lib + c.thumb}" alt="" loading="lazy"><b>${c.name}</b><span>${c.w.toFixed(1)} × ${c.d.toFixed(1)} m</span>`;
      b.onclick = () => placeNew(c, b);
      grid.appendChild(b);
    }
  }
  renderGrid();

  /* ---------------- ready-made layouts ---------------- */
  const preEl = panel.querySelector('#fpresets');
  let activePreset = null;
  if (!presets.length){ preEl.style.display = 'none'; panel.querySelector('#fpresec').style.display = 'none'; }
  for (const p of presets){
    const b = document.createElement('button'); b.className = 'fpre'; b.dataset.id = p.id; b.title = p.desc || '';
    b.innerHTML = `<b>${p.name}</b><span>${p.desc || ''}</span>`;
    b.onclick = () => applyPreset(p, b);
    preEl.appendChild(b);
  }
  const markPreset = id => { activePreset = id; preEl.querySelectorAll('.fpre').forEach(b => b.classList.toggle('on', b.dataset.id === id)); };
  async function applyPreset(p, btn){
    if (items.length && activePreset !== p.id && !confirm(`Replace your current furniture with the "${p.name}" layout?`)) return;
    btn.classList.add('busy');
    [...items].forEach(removeItem);
    try {
      await Promise.all(p.items.map(([id, x, z, r]) => byId[id] ? addItem(id, x, z, r * ROT_STEP, false) : null));
      markPreset(p.id); toast(`${p.name} layout placed. Drag any piece to move it`);
    } catch (e){ toast('Could not load some pieces. Check your connection.'); console.warn(e); }
    btn.classList.remove('busy'); save();
    if (innerWidth <= 700) setPanel(false, true);    // let them walk around and see it (still adjustable)
  }

  async function placeNew(c, tile){
    tile.classList.add('loading');
    const p = tour.player, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), dist = 1.3 + c.d / 2;
    // face the viewer, snapped to 45 degrees so pieces line up with the walls
    const rot = Math.round(Math.atan2(-fx, -fz) / ROT_STEP) * ROT_STEP;
    try {
      const it = await addItem(c.id, p.x + fx * dist, p.z + fz * dist, rot, true);
      if (it && innerWidth <= 700) setPanel(false, true);    // let them see (and drag) what they placed
    } catch (e){ toast('Could not load that piece. Check your connection.'); console.warn(e); }
    tile.classList.remove('loading');
  }

  function selectItem(it){
    if (selected) selected.ring.visible = false;
    selected = it;
    bar.classList.toggle('show', !!it);
    if (it){ it.ring.visible = true; bar.querySelector('.nm').textContent = it.c.name; }
  }
  bar.onclick = e => {
    const a = e.target.closest('button')?.dataset.a, it = selected; if (!a || !it) return;
    if (a === 'left' || a === 'right'){ it.rot += a === 'left' ? ROT_STEP : -ROT_STEP; clampToWalls(it); apply(it); save(); }
    if (a === 'dup') addItem(it.id, it.x + .3, it.z + .3, it.rot, true);
    if (a === 'del') removeItem(it);
    if (a === 'done') selectItem(null);
  };
  addEventListener('keydown', e => {
    if (!selected || e.target.tagName === 'INPUT') return;
    if (e.code === 'KeyR'){ selected.rot -= ROT_STEP; clampToWalls(selected); apply(selected); save(); }
    if (e.code === 'Delete' || e.code === 'Backspace') removeItem(selected);
    if (e.code === 'Escape') selectItem(null);
  });

  // keepEditing: the panel steps aside (phones, after placing) but pieces stay movable until "Done"
  const setPanel = (open, keepEditing = false) => {
    panel.classList.toggle('open', open); document.body.classList.toggle('fopen', open);
    editing = open || keepEditing;
    opts.button.classList.toggle('on', editing);
    modeEl.classList.toggle('show', !open && editing);
    if (!editing) selectItem(null);
    if (open) document.getElementById('mapwrap')?.classList.add('hidden');
  };
  modeEl.onclick = e => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'add') setPanel(true);
    if (a === 'done') setPanel(false);
  };
  opts.button.onclick = () => setPanel(!editing);
  panel.querySelector('header button').onclick = () => setPanel(false);
  panel.querySelector('#fclear').onclick = () => { if (items.length && confirm('Remove all furniture?')){ [...items].forEach(removeItem); markPreset(null); } };
  panel.querySelector('#fshare').onclick = async () => {
    if (!items.length){ toast('Place some furniture first'); return; }
    save();
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title:document.title, text:'My furniture layout', url });
      else { await navigator.clipboard.writeText(url); toast('Link copied. Anyone who opens it sees your layout'); }
    } catch (e){ if (e.name !== 'AbortError') prompt('Copy this link:', url); }
  };

  /* ---------------- layout in the link (and remembered on this device) ---------------- */
  const KEY = 'furnish:' + location.pathname;
  function encode(){
    return items.map(i => [i.id, Math.round(i.x * 100), Math.round(i.z * 100), ((Math.round(i.rot / ROT_STEP) % 8) + 8) % 8].join('.')).join('~');
  }
  function save(){
    const s = encode();
    history.replaceState(null, '', s ? '#f=' + s : location.pathname + location.search);
    try { localStorage.setItem(KEY, s); } catch {}
  }
  async function restore(){
    let s = (location.hash.match(/f=([^&]*)/) || [])[1];
    if (s === undefined){ try { s = localStorage.getItem(KEY) || ''; } catch { s = ''; } }
    const parts = decodeURIComponent(s).split('~').filter(Boolean).slice(0, MAX_ITEMS);
    await Promise.all(parts.map(p => {
      const [id, x, z, r] = p.split('.');
      return byId[id] ? addItem(id, +x / 100, +z / 100, (+r || 0) * ROT_STEP, false).catch(() => {}) : null;
    }));
    selectItem(null); save();
  }
  restore();
}
