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

const layers = {
  map: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap'
  }),
  sat: L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19, attribution: 'Esri World Imagery'
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 19
    })
  ]),
  cycle: L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', {
    maxZoom: 20, subdomains: 'abc', attribution: 'CyclOSM | &copy; OpenStreetMap'
  })
};
let currentLayer = null;
function setLayer(name) {
  if (!layers[name]) name = 'map';
  if (currentLayer) map.removeLayer(currentLayer);
  currentLayer = layers[name].addTo(map);
  document.querySelectorAll('#layers button').forEach(b => b.classList.toggle('active', b.dataset.layer === name));
  view.layer = name;
  save('cycmap.view', view);
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
  points.push(e.latlng);
  renderMarkers();
  updateRoute();
});

$('#btnClear').addEventListener('click', () => {
  points.length = 0;
  renderMarkers();
  updateRoute();
});

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
function drawMini() {
  const cv = $('#mini');
  const dpr = window.devicePixelRatio || 1;
  const W = 120, H = 120;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const path = routeCoords.length >= 2 ? routeCoords : points.map(p => [p.lat, p.lng]);
  if (path.length) {
    const lat0 = path.reduce((s, p) => s + p[0], 0) / path.length;
    const kx = Math.cos(lat0 * Math.PI / 180);
    const xs = path.map(p => p[1] * kx), ys = path.map(p => p[0]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = 14;
    const span = Math.max(maxX - minX, maxY - minY) || 1e-6;
    const sc = (W - pad * 2) / span;
    const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
    const P = i => [ox + (xs[i] - minX) * sc, H - (oy + (ys[i] - minY) * sc)];

    if (path.length >= 2) {
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      const stroke = (w, c) => {
        ctx.beginPath();
        path.forEach((_, i) => { const [x, y] = P(i); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.lineWidth = w; ctx.strokeStyle = c; ctx.stroke();
      };
      stroke(7, 'rgba(0,0,0,0.6)');
      stroke(4, '#ffffff');
      stroke(1.5, '#60a5fa');
    }
    const dot = (i, c) => {
      const [x, y] = P(i);
      ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
    };
    if (path.length >= 2) dot(path.length - 1, '#dc2626');
    dot(0, '#16a34a');
  }

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.beginPath(); ctx.moveTo(W - 12, 6); ctx.lineTo(W - 16, 15); ctx.lineTo(W - 8, 15); ctx.closePath();
  ctx.fillStyle = '#ef4444'; ctx.fill();
  ctx.fillStyle = '#fff'; ctx.fillText('N', W - 12, 25);
}

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
