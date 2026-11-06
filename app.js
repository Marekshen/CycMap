const $ = s => document.querySelector(s);

function load(key, def) {
  try { return Object.assign(def, JSON.parse(localStorage.getItem(key) || '{}')); } catch { return def; }
}
function save(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

const settings = load('cycmap.settings', { flat: 20, steep: 5 });
const view = load('cycmap.view', { lat: 25.0330, lng: 121.5654, z: 13, layer: 'map' });

const map = L.map('map', { zoomControl: true, attributionControl: true }).setView([view.lat, view.lng], view.z);

const TILE = {
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  sat: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  satLabels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  cycle: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png'
};
const MINI_TILE = { map: TILE.osm, sat: TILE.sat, cycle: TILE.cycle };
const ATTRIB = { map: '© OpenStreetMap', sat: 'Esri World Imagery', cycle: 'CyclOSM | © OpenStreetMap' };
const xo = { crossOrigin: 'anonymous' };

const layers = {
  map: L.tileLayer(TILE.osm, { ...xo, maxZoom: 19, attribution: '&copy; OpenStreetMap' }),
  sat: L.layerGroup([
    L.tileLayer(TILE.sat, { ...xo, maxZoom: 19, attribution: 'Esri World Imagery' }),
    L.tileLayer(TILE.satLabels, { ...xo, maxZoom: 19 })
  ]),
  cycle: L.tileLayer(TILE.cycle, { ...xo, maxZoom: 20, subdomains: 'abc', attribution: 'CyclOSM | &copy; OpenStreetMap' })
};
let currentLayer = null;
function setLayer(name) {
  if (!layers[name]) name = 'map';
  if (currentLayer) map.removeLayer(currentLayer);
  currentLayer = layers[name].addTo(map);
  document.querySelectorAll('#layers button').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
  view.layer = name;
  save('cycmap.view', view);
  if (typeof drawMini === 'function' && !$('#card').classList.contains('hidden')) drawMini();
}
setLayer(view.layer);
$('#layers').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) setLayer(b.dataset.layer);
});
map.on('moveend', () => {
  const c = map.getCenter();
  Object.assign(view, { lat: c.lat, lng: c.lng, z: map.getZoom() });
  save('cycmap.view', view);
});

// ---------- waypoints ----------
const points = [];
const markers = [];
const routeCasing = L.polyline([], { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(map);
const routeLine = L.polyline([], { color: '#2563eb', weight: 5, opacity: 1, interactive: false }).addTo(map);

function pinIcon(i, n) {
  const cls = i === 0 ? 'start' : (i === n - 1 && n > 1 ? 'end' : '');
  const label = i === 0 ? 'S' : (i === n - 1 && n > 1 ? 'G' : String(i));
  return L.divIcon({ className: '', html: `<div class="pin ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}

function renderMarkers() {
  markers.forEach(m => map.removeLayer(m));
  markers.length = 0;
  points.forEach((p, i) => {
    const m = L.marker(p, { icon: pinIcon(i, points.length), draggable: true, bubblingMouseEvents: false }).addTo(map);
    m.on('click', e => {
      L.DomEvent.stopPropagation(e);
      points.splice(i, 1);
      renderMarkers();
      updateRoute();
    });
    m.on('dragend', () => {
      points[i] = m.getLatLng();
      updateRoute();
    });
    markers.push(m);
  });
}

map.on('click', e => {
  closeResults();
  if (Date.now() < ignoreClickUntil) return;
  points.push(e.latlng);
  renderMarkers();
  updateRoute();
});

$('#btnClear').addEventListener('click', () => {
  points.length = 0;
  renderMarkers();
  updateRoute();
});

$('#btnReverse').addEventListener('click', () => {
  if (points.length < 2) return;
  points.reverse();
  renderMarkers();
  updateRoute();
});

// ---------- drag route to insert waypoint ----------
let ignoreClickUntil = 0;
const ghostLine = L.polyline([], { color: '#2563eb', weight: 3, dashArray: '6 6', interactive: false });
const ghostPin = L.marker([0, 0], { icon: L.divIcon({ className: '', html: '<div class="pin ghost"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false });

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function nearestRouteIndex(cp) {
  let best = Infinity, idx = -1;
  let prev = map.latLngToContainerPoint(routeCoords[0]);
  for (let i = 1; i < routeCoords.length; i++) {
    const cur = map.latLngToContainerPoint(routeCoords[i]);
    const d = distToSeg(cp, prev, cur);
    if (d < best) { best = d; idx = i; }
    prev = cur;
  }
  return { idx, dist: best };
}

function insertIndexFor(routeIdx) {
  let from = 0, pos = 1;
  for (let w = 1; w < points.length - 1; w++) {
    let best = Infinity, bi = from;
    const wp = [points[w].lat, points[w].lng];
    for (let i = from; i < routeCoords.length; i++) {
      const d = haversine(wp, routeCoords[i]);
      if (d < best) { best = d; bi = i; }
    }
    from = bi;
    if (bi < routeIdx) pos = w + 1;
  }
  return pos;
}

const mapEl = map.getContainer();
mapEl.addEventListener('pointerdown', e => {
  if (e.button > 0 || routeCoords.length < 2 || points.length < 2) return;
  if (e.target.closest('.leaflet-marker-icon, .leaflet-control')) return;
  const rect = mapEl.getBoundingClientRect();
  const cp = L.point(e.clientX - rect.left, e.clientY - rect.top);
  const hit = nearestRouteIndex(cp);
  if (hit.dist > (e.pointerType === 'mouse' ? 10 : 20)) return;

  e.stopPropagation();
  e.preventDefault();
  map.dragging.disable();
  const insertAt = insertIndexFor(hit.idx);
  const sx = e.clientX, sy = e.clientY;
  let moved = false;

  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
    moved = true;
    const ll = map.containerPointToLatLng(L.point(ev.clientX - rect.left, ev.clientY - rect.top));
    ghostLine.setLatLngs([points[insertAt - 1], ll, points[insertAt]]).addTo(map);
    ghostPin.setLatLng(ll).addTo(map);
  };
  const up = ev => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    map.dragging.enable();
    map.removeLayer(ghostLine);
    map.removeLayer(ghostPin);
    if (!moved || ev.type === 'pointercancel') return;
    ignoreClickUntil = Date.now() + 400;
    const ll = map.containerPointToLatLng(L.point(ev.clientX - rect.left, ev.clientY - rect.top));
    points.splice(insertAt, 0, ll);
    renderMarkers();
    updateRoute();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}, true);

// ---------- geo helpers ----------
function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function resample(coords, step) {
  const out = [coords[0]];
  let carry = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1], b = coords[i];
    const d = haversine(a, b);
    let pos = step - carry;
    while (pos <= d) {
      const t = pos / d;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      pos += step;
    }
    carry = d - (pos - step);
  }
  const last = coords[coords.length - 1];
  if (haversine(out[out.length - 1], last) > step * 0.2) out.push(last);
  return out;
}

// ---------- remote services ----------
async function fetchRoute(pts) {
  const coords = pts.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const r = await fetch(url);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code || '路徑規劃失敗');
  return {
    coords: j.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    distance: j.routes[0].distance
  };
}

async function fetchElevations(pts) {
  const chunks = [];
  for (let i = 0; i < pts.length; i += 100) chunks.push(pts.slice(i, i + 100));
  const res = await Promise.all(chunks.map(async c => {
    const lat = c.map(p => p[0].toFixed(5)).join(',');
    const lng = c.map(p => p[1].toFixed(5)).join(',');
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`);
    if (!r.ok) throw new Error('高度資料取得失敗');
    return (await r.json()).elevation;
  }));
  return res.flat();
}

// ---------- route computation ----------
let segments = null;
let routeCoords = [];
let reqId = 0;

async function updateRoute() {
  const id = ++reqId;
  segments = null;
  routeCoords = [];
  routeLine.setLatLngs([]);
  routeCasing.setLatLngs([]);

  if (points.length === 0) { $('#card').classList.add('hidden'); return; }
  $('#card').classList.remove('hidden');
  if (points.length === 1) {
    showStats(null);
    setStatus('再點一個點以規劃路線');
    drawMini();
    return;
  }

  setStatus('規劃路線中…');
  showStats(null);
  let route;
  try {
    route = await fetchRoute(points);
  } catch (err) {
    if (id === reqId) setStatus(String(err.message || err));
    return;
  }
  if (id !== reqId) return;

  routeCoords = route.coords;
  routeLine.setLatLngs(routeCoords);
  routeCasing.setLatLngs(routeCoords);
  drawMini();

  const step = Math.max(80, route.distance / 400);
  const samples = resample(routeCoords, step);
  const dists = [];
  for (let i = 1; i < samples.length; i++) dists.push(haversine(samples[i - 1], samples[i]));
  const scale = route.distance / (dists.reduce((a, b) => a + b, 0) || 1);

  segments = dists.map(d => ({ d: d * scale, dh: 0 }));
  showStats();
  setStatus('取得高度資料中…');

  try {
    const raw = await fetchElevations(samples);
    if (id !== reqId) return;
    const ele = raw.map((_, i) => {
      const a = raw[Math.max(0, i - 1)], b = raw[i], c = raw[Math.min(raw.length - 1, i + 1)];
      return (a + b + c) / 3;
    });
    segments = dists.map((d, i) => ({ d: d * scale, dh: ele[i + 1] - ele[i] }));
    setStatus('');
  } catch {
    if (id !== reqId) return;
    setStatus('無法取得高度，以平地估算');
  }
  showStats();
}

function speedFor(grade) {
  const { flat, steep } = settings;
  if (grade <= 0) return flat;
  if (grade >= 10) return steep;
  return flat - (flat - steep) * grade / 10;
}

function showStats(empty) {
  if (empty === null || !segments) {
    $('#dist').textContent = '--';
    $('#time').textContent = '--';
    $('#climb').textContent = '--';
    $('#avg').textContent = '--';
    return;
  }
  let dist = 0, hours = 0, climb = 0;
  for (const s of segments) {
    const grade = s.d > 0 ? (s.dh / s.d) * 100 : 0;
    dist += s.d;
    hours += (s.d / 1000) / speedFor(grade);
    if (s.dh > 0) climb += s.dh;
  }
  const km = dist / 1000;
  $('#dist').textContent = km < 10 ? `${km.toFixed(2)} km` : `${km.toFixed(1)} km`;
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  $('#time').textContent = h ? `${h} 時 ${m} 分` : `${m} 分`;
  $('#climb').textContent = `${Math.round(climb)} m`;
  $('#avg').textContent = hours > 0 ? `${(km / hours).toFixed(1)} km/h` : '--';
}

function setStatus(t) { $('#status').textContent = t; }

// ---------- mini map ----------
const tileCache = new Map();
function loadTile(url) {
  if (!tileCache.has(url)) {
    tileCache.set(url, new Promise(res => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = () => { tileCache.delete(url); res(null); };
      img.src = url;
    }));
  }
  return tileCache.get(url);
}
function tileUrl(tpl, z, x, y) {
  return tpl.replace('{s}', 'abc'[(x + y) % 3]).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

let miniToken = 0;
function drawMini() {
  const token = ++miniToken;
  const cv = $('#mini');
  const dpr = window.devicePixelRatio || 1;
  const W = 120, H = 120, pad = 14;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  const crs = L.CRS.EPSG3857;

  const path = routeCoords.length >= 2 ? routeCoords : points.map(p => [p.lat, p.lng]);
  let z = 14, s = 1, cx = 0, cy = 0;
  if (path.length) {
    const w0 = path.map(p => crs.latLngToPoint(L.latLng(p[0], p[1]), 0));
    const xs = w0.map(p => p.x), ys = w0.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY);
    if (span > 0) {
      const k = (W - pad * 2) / span;
      z = Math.max(0, Math.min(17, Math.floor(Math.log2(k))));
      s = k / 2 ** z;
    }
    cx = (minX + maxX) / 2 * 2 ** z;
    cy = (minY + maxY) / 2 * 2 ** z;
  }
  const P = ll => {
    const p = crs.latLngToPoint(L.latLng(ll[0], ll[1]), z);
    return [W / 2 + (p.x - cx) * s, H / 2 + (p.y - cy) * s];
  };

  const tiles = [];
  if (path.length) {
    const ts = 256 * s, n = 2 ** z;
    const x0 = Math.floor((cx - W / 2 / s) / 256), x1 = Math.floor((cx + W / 2 / s) / 256);
    const y0 = Math.max(0, Math.floor((cy - H / 2 / s) / 256)), y1 = Math.min(n - 1, Math.floor((cy + H / 2 / s) / 256));
    const tpl = MINI_TILE[view.layer] || TILE.osm;
    for (let tx = x0; tx <= x1; tx++) for (let ty = y0; ty <= y1; ty++) {
      tiles.push({ url: tileUrl(tpl, z, ((tx % n) + n) % n, ty), x: W / 2 + (tx * 256 - cx) * s, y: H / 2 + (ty * 256 - cy) * s, size: ts });
    }
  }

  const paint = imgs => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (imgs) {
      ctx.globalAlpha = 0.45;
      tiles.forEach((t, i) => { if (imgs[i]) ctx.drawImage(imgs[i], t.x, t.y, t.size + 0.5, t.size + 0.5); });
      ctx.globalAlpha = 1;
    }
    if (path.length >= 2) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const pts = path.map(P);
      const stroke = (w, c) => {
        ctx.beginPath();
        pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
        ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke();
      };
      stroke(7, 'rgba(0,0,0,0.6)');
      stroke(4, '#ffffff');
      stroke(1.5, '#2563eb');
    }
    const dot = (ll, c) => {
      const [x, y] = P(ll);
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    };
    if (path.length >= 2) dot(path[path.length - 1], '#dc2626');
    if (path.length) dot(path[0], '#16a34a');

    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.beginPath(); ctx.moveTo(W - 12, 6); ctx.lineTo(W - 16, 15); ctx.lineTo(W - 8, 15); ctx.closePath();
    ctx.fillStyle = '#ef4444'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText('N', W - 12, 25);
  };

  paint(null);
  if (tiles.length) {
    Promise.all(tiles.map(t => loadTile(t.url))).then(imgs => { if (token === miniToken) paint(imgs); });
  }
}

// ---------- export ----------
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function renderExport() {
  const el = map.getContainer();
  const box = el.getBoundingClientRect();
  const W = box.width, H = box.height;
  const dpr = Math.max(2, window.devicePixelRatio || 1);
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#ddd';
  ctx.fillRect(0, 0, W, H);

  const tls = currentLayer.getLayers ? currentLayer.getLayers() : [currentLayer];
  for (const tl of tls) {
    tl.getContainer().querySelectorAll('img.leaflet-tile-loaded').forEach(img => {
      const r = img.getBoundingClientRect();
      if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) return;
      ctx.drawImage(img, r.left - box.left, r.top - box.top, r.width + 0.5, r.height + 0.5);
    });
  }

  if (routeCoords.length >= 2) {
    const pts = routeCoords.map(c => map.latLngToContainerPoint(c));
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const stroke = (w, c, a) => {
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
      ctx.lineWidth = w; ctx.strokeStyle = c; ctx.globalAlpha = a; ctx.stroke();
    };
    stroke(9, '#fff', 0.9);
    stroke(5, '#2563eb', 1);
    ctx.globalAlpha = 1;
  }

  points.forEach((p, i) => {
    const n = points.length;
    const c = map.latLngToContainerPoint(p);
    const isEnd = i === n - 1 && n > 1;
    ctx.beginPath(); ctx.arc(c.x, c.y, 13, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#16a34a' : isEnd ? '#dc2626' : '#2563eb';
    ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(i === 0 ? 'S' : isEnd ? 'G' : String(i), c.x, c.y + 0.5);
  });

  const card = $('#card');
  if (!card.classList.contains('hidden')) {
    const r = card.getBoundingClientRect();
    const x = r.left - box.left, y = r.top - box.top;
    const snap = document.createElement('canvas');
    snap.width = cv.width; snap.height = cv.height;
    snap.getContext('2d').drawImage(cv, 0, 0);
    ctx.save();
    roundRect(ctx, x, y, r.width, r.height, 16);
    ctx.clip();
    ctx.filter = 'blur(10px)';
    ctx.drawImage(snap, 0, 0, W, H);
    ctx.filter = 'none';
    ctx.fillStyle = 'rgba(20, 24, 28, 0.55)';
    ctx.fillRect(x, y, r.width, r.height);
    ctx.restore();
    roundRect(ctx, x + 0.5, y + 0.5, r.width - 1, r.height - 1, 16);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();

    const mini = $('#mini'), mr = mini.getBoundingClientRect();
    const mx = mr.left - box.left, my = mr.top - box.top;
    ctx.save();
    roundRect(ctx, mx, my, mr.width, mr.height, 10);
    ctx.clip();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(mx, my, mr.width, mr.height);
    ctx.drawImage(mini, mx, my, mr.width, mr.height);
    ctx.restore();

    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    card.querySelectorAll('.label, .val, #climb, #avg, #status').forEach(t => {
      if (!t.textContent) return;
      const tr = t.getBoundingClientRect(), cs = getComputedStyle(t);
      ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.fillStyle = cs.color;
      ctx.fillText(t.textContent, tr.left - box.left, tr.top - box.top + tr.height / 2);
    });
  }

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  const attr = ATTRIB[view.layer] || '';
  const tw = ctx.measureText(attr).width;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillRect(W - tw - 10, H - 18, tw + 10, 18);
  ctx.fillStyle = '#333';
  ctx.fillText(attr, W - 5, H - 3);
  return cv;
}

$('#btnExport').addEventListener('click', async () => {
  const btn = $('#btnExport');
  btn.disabled = true;
  try {
    const cv = renderExport();
    const blob = await new Promise((res, rej) => cv.toBlob(b => b ? res(b) : rej(new Error('toBlob')), 'image/png'));
    const d = new Date(), pad2 = n => String(n).padStart(2, '0');
    const name = `cycmap-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}.png`;
    const file = new File([blob], name, { type: 'image/png' });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'CycMap 路線' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    alert('匯出失敗，請稍後再試');
  } finally {
    btn.disabled = false;
  }
});

// ---------- settings ----------
const dlg = $('#settings');
$('#btnSettings').addEventListener('click', () => {
  $('#sFlat').value = settings.flat;
  $('#sSteep').value = settings.steep;
  dlg.showModal();
});
dlg.addEventListener('close', () => {
  if (dlg.returnValue !== 'save') return;
  const f = parseFloat($('#sFlat').value), s = parseFloat($('#sSteep').value);
  if (f > 0) settings.flat = f;
  if (s > 0) settings.steep = s;
  save('cycmap.settings', settings);
  showStats();
});

// ---------- search ----------
const resultsEl = $('#results');
function closeResults() { resultsEl.hidden = true; }

$('#search').addEventListener('submit', async e => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  $('#q').blur();
  resultsEl.hidden = false;
  resultsEl.innerHTML = '<li class="empty">搜尋中…</li>';
  try {
    const c = map.getCenter();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&accept-language=zh-TW,zh,en&q=${encodeURIComponent(q)}`
      + `&viewbox=${c.lng - 2},${c.lat + 2},${c.lng + 2},${c.lat - 2}`;
    const list = await (await fetch(url)).json();
    if (!list.length) { resultsEl.innerHTML = '<li class="empty">找不到結果</li>'; return; }
    resultsEl.innerHTML = '';
    list.forEach(r => {
      const li = document.createElement('li');
      const parts = r.display_name.split(',').map(s => s.trim());
      li.textContent = r.name || parts[0];
      const sm = document.createElement('small');
      sm.textContent = parts.slice(r.name ? 0 : 1).join(', ');
      li.appendChild(sm);
      li.addEventListener('click', () => {
        const bb = r.boundingbox.map(Number);
        map.fitBounds([[bb[0], bb[2]], [bb[1], bb[3]]], { maxZoom: 16 });
        closeResults();
      });
      resultsEl.appendChild(li);
    });
  } catch {
    resultsEl.innerHTML = '<li class="empty">搜尋失敗，請檢查網路</li>';
  }
});
$('#q').addEventListener('input', () => { if (!$('#q').value) closeResults(); });

// ---------- PWA ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
