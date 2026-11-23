/* Gastos SCOTT-ISB 2027 · landing móvil. Sin dependencias.
   La clave se valida en el servidor (Apps Script): aquí no hay contraseñas ni listas de personas en el código.
   Sin cobertura: el gasto se guarda en el móvil (IndexedDB) y se envía solo cuando vuelve la señal. */
(function () {
  'use strict';
  var CFG = window.CONFIG || {};
  var MOCK = /[?&]mock=1/.test(location.search) || CFG.backendUrl === 'MOCK';
  var MAX_FILES = 4, MAX_PDF_MB = 7, BLUR_THRESHOLD = 200, TIMEOUT_MS = 60000;
  var $ = function (id) { return document.getElementById(id); };
  var state = { password: '', config: null, files: [], force: false, clientId: '', offline: false, flushing: false };

  /* ---------- utilidades ---------- */
  function toast(msg) { var t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 4000); }
  function busy(on, text) { $('busy').hidden = !on; if (text) $('busyText').textContent = text; }
  function show(view) {
    ['loginView', 'formView', 'doneView', 'mineView'].forEach(function (v) { $(v).hidden = v !== view; });
    $('logout').hidden = view === 'loginView'; $('tabs').hidden = view === 'loginView';
    $('tabUpload').classList.toggle('active', view !== 'mineView'); $('tabMine').classList.toggle('active', view === 'mineView');
    window.scrollTo(0, 0);
  }
  function todayISO() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function fmt(n) { return Number(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function parseAmount(v) {
    v = String(v || '').trim().replace(/[\s€]/g, '');
    if (!v) return NaN;
    if (v.indexOf(',') > -1 && v.indexOf('.') > -1) v = v.replace(/\./g, '').replace(',', '.'); else v = v.replace(',', '.');
    return Number(v);
  }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function savedPassword() { try { return localStorage.getItem('gx.pw') || sessionStorage.getItem('gx.pw') || ''; } catch (e) { return ''; } }
  function clearSession() { try { localStorage.removeItem('gx.pw'); sessionStorage.removeItem('gx.pw'); localStorage.removeItem('gx.cfg'); } catch (e) {} }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

  /* ---------- cola local (IndexedDB, con respaldo en memoria) ---------- */
  var memQ = [];
  function idb() { return new Promise(function (res, rej) { if (!window.indexedDB) return rej(new Error('sin IndexedDB')); var r = indexedDB.open('gx-queue', 1); r.onupgradeneeded = function () { r.result.createObjectStore('q', { keyPath: 'clientId' }); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function qOp(mode, fn) { return idb().then(function (db) { return new Promise(function (res, rej) { var tx = db.transaction('q', mode), r = fn(tx.objectStore('q')); tx.oncomplete = function () { res(r && r.result); }; tx.onerror = function () { rej(tx.error); }; }); }); }
  function qPut(item) { return qOp('readwrite', function (s) { return s.put(item); }).catch(function () { memQ = memQ.filter(function (x) { return x.clientId !== item.clientId; }); memQ.push(item); }); }
  function qDel(id) { return qOp('readwrite', function (s) { return s.delete(id); }).catch(function () { memQ = memQ.filter(function (x) { return x.clientId !== id; }); }); }
  function qAll() { return qOp('readonly', function (s) { return s.getAll(); }).then(function (r) { return (r || []).concat(memQ); }).catch(function () { return memQ.slice(); }); }

  function renderQueue() {
    qAll().then(function (items) {
      var b = $('queueBanner');
      if (!items.length || $('loginView').hidden === false) { b.hidden = true; return; }
      var failed = items.filter(function (i) { return i.failedMsg; });
      var wait = items.length - failed.length;
      var txt = '';
      if (wait) txt += '⏳ ' + wait + ' gasto' + (wait > 1 ? 's' : '') + ' guardado' + (wait > 1 ? 's' : '') + ' en el móvil, pendiente' + (wait > 1 ? 's' : '') + ' de enviar (se envían solos con cobertura).';
      if (failed.length) txt += (txt ? ' ' : '') + '⚠️ ' + failed.length + ' con error: ' + failed[0].failedMsg;
      $('queueText').textContent = txt; $('queueDiscard').hidden = !failed.length; b.hidden = false;
    });
  }

  /* ---------- API (real o simulada) ---------- */
  function api(body) {
    if (MOCK) return mockApi(body);
    if (!CFG.backendUrl || /PEGAR/.test(CFG.backendUrl)) return Promise.reject(netError('La plataforma aún no está conectada al servidor.'));
    var ctl = ('AbortController' in window) ? new AbortController() : null, timer = ctl ? setTimeout(function () { ctl.abort(); }, TIMEOUT_MS) : null;
    // text/plain evita el preflight CORS con Apps Script
    return fetch(CFG.backendUrl, { method: 'POST', body: JSON.stringify(body), redirect: 'follow', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (timer) clearTimeout(timer); return r.json(); })
      .catch(function (e) { if (timer) clearTimeout(timer); throw netError(e && e.name === 'AbortError' ? 'Tiempo agotado' : 'Sin conexión'); });
  }
  function netError(m) { var e = new Error(m); e.network = true; return e; }

  /* ---------- acceso ---------- */
  function startSession(pw, cfg, offline) {
    state.password = pw; state.config = cfg; state.offline = !!offline;
    initForm(); show('formView'); renderQueue(); flushQueue();
  }
  function doLogin(pw, remember, silent) {
    busy(true, 'Comprobando…');
    return api({ action: 'login', password: pw }).then(function (res) {
      busy(false);
      if (!res || !res.ok) { if (!silent) { $('loginError').textContent = (res && res.error) || 'Clave incorrecta'; $('loginError').hidden = false; } else clearSession(); return false; }
      try { (remember ? localStorage : sessionStorage).setItem('gx.pw', pw); } catch (e) {}
      lsSet('gx.cfg', JSON.stringify(res.config));
      startSession(pw, res.config, false); return true;
    }).catch(function (e) {
      busy(false);
      var cfg = null; try { cfg = JSON.parse(lsGet('gx.cfg') || 'null'); } catch (er) {}
      if (silent && cfg) { startSession(pw, cfg, true); toast('Sin cobertura: puedes registrar gastos, se enviarán después.'); return true; }
      if (!silent) { $('loginError').textContent = e.message === 'Sin conexión' ? 'No se pudo conectar. Revisa la cobertura.' : (e.message || 'Error'); $('loginError').hidden = false; }
      return false;
    });
  }

  /* ---------- formulario ---------- */
  function opt(v, t, extra) { var o = document.createElement('option'); o.value = v; o.textContent = t; if (extra) Object.keys(extra).forEach(function (k) { o.dataset[k] = extra[k]; }); return o; }
  function initForm() {
    var c = state.config, p = $('person'), e = $('event'), k = $('concept'), mp = $('minePerson');
    p.innerHTML = ''; e.innerHTML = ''; k.innerHTML = ''; mp.innerHTML = '';
    p.appendChild(opt('', 'Selecciona tu nombre…'));
    c.persons.forEach(function (x) { p.appendChild(opt(x.name, x.name, { reimb: x.reimbursable ? '1' : '0' })); mp.appendChild(opt(x.name, x.name)); });
    e.appendChild(opt('', 'Selecciona el evento…'));
    var groups = {};
    c.events.forEach(function (x) { var q = x.quarter || 0; (groups[q] = groups[q] || []).push(x); });
    Object.keys(groups).sort().forEach(function (q) {
      var g = document.createElement('optgroup'); g.label = q === '0' ? 'Sin evento' : 'Trimestre ' + q;
      groups[q].forEach(function (x) { g.appendChild(opt(x.id, x.label)); }); e.appendChild(g);
    });
    k.appendChild(opt('', 'Tipo de gasto…'));
    c.concepts.forEach(function (x) { k.appendChild(opt(x, x)); });
    var lp = lsGet('gx.person'); if (lp) { p.value = lp; mp.value = lp; }
    $('date').value = todayISO(); $('date').max = todayISO(); $('date').min = '2026-11-01';
    onPersonChange();
  }
  function onPersonChange() {
    var sel = $('person'), o = sel.options[sel.selectedIndex], n = $('personNote');
    if (o && o.dataset.reimb === '0') { n.textContent = 'Pago con la tarjeta del club: se guarda para el IVA, pero NO entra en ninguna liquidación de gastos.'; n.hidden = false; } else n.hidden = true;
    if (sel.value) { lsSet('gx.person', sel.value); $('minePerson').value = sel.value; }
  }
  function updateIva() {
    var a = parseAmount($('amount').value), r = $('ivaRate').value, el = $('ivaCalc');
    if (!isNaN(a) && a > 0 && r !== '') { var base = a / (1 + Number(r) / 100); el.textContent = 'Base imponible ' + fmt(base) + ' € · IVA ' + fmt(a - base) + ' €'; el.hidden = false; } else el.hidden = true;
  }

  /* ---------- fotos y archivos ---------- */
  function blobToBase64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1]); }; r.onerror = rej; r.readAsDataURL(blob); }); }
  function loadImage(file) { return new Promise(function (res, rej) { var url = URL.createObjectURL(file), img = new Image(); img.onload = function () { res({ img: img, url: url }); }; img.onerror = function () { rej(new Error('No se pudo leer la imagen')); }; img.src = url; }); }
  function sharpness(src) {
    var w = Math.min(500, src.width), h = Math.round(src.height * w / src.width), c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'); x.drawImage(src, 0, 0, w, h); var d = x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h), i, j;
    for (i = 0, j = 0; i < d.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    var s = 0, s2 = 0, n = 0, yy, xx;
    for (yy = 1; yy < h - 1; yy++) for (xx = 1; xx < w - 1; xx++) { i = yy * w + xx; var l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w]; s += l; s2 += l * l; n++; }
    var m = s / n; return s2 / n - m * m;
  }
  function processImage(file) {
    return loadImage(file).then(function (o) {
      var max = 1800, w = o.img.naturalWidth, h = o.img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
      w = Math.round(w * s); h = Math.round(h * s);
      var c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(o.img, 0, 0, w, h);
      var sharp = sharpness(c); URL.revokeObjectURL(o.url);
      return new Promise(function (res) { c.toBlob(res, 'image/jpeg', 0.82); }).then(function (blob) {
        return blobToBase64(blob).then(function (b64) { return { kind: 'img', name: file.name || 'foto.jpg', mime: 'image/jpeg', base64: b64, preview: URL.createObjectURL(blob), size: blob.size, sharp: sharp }; });
      });
    });
  }
  function addFiles(list) {
    var arr = Array.prototype.slice.call(list || []);
    if (!arr.length) return;
    if (state.files.length + arr.length > MAX_FILES) { toast('Máximo ' + MAX_FILES + ' archivos por gasto'); arr = arr.slice(0, MAX_FILES - state.files.length); }
    busy(true, 'Preparando imagen…');
    arr.reduce(function (p, f) {
      return p.then(function () {
        if (f.type === 'application/pdf') {
          if (f.size > MAX_PDF_MB * 1048576) { toast('El PDF pesa más de ' + MAX_PDF_MB + ' MB'); return; }
          return blobToBase64(f).then(function (b64) { state.files.push({ kind: 'pdf', name: f.name, mime: 'application/pdf', base64: b64, size: f.size }); });
        }
        return processImage(f).then(function (x) { state.files.push(x); }).catch(function () { toast('No se pudo leer "' + f.name + '"'); });
      });
    }, Promise.resolve()).then(function () { busy(false); renderThumbs(); });
  }
  function renderThumbs() {
    var ul = $('thumbs'); ul.innerHTML = ''; var blurry = false;
    state.files.forEach(function (f, i) {
      var li = document.createElement('li'), vis;
      if (f.kind === 'img') { vis = document.createElement('img'); vis.src = f.preview; vis.alt = ''; } else { vis = document.createElement('div'); vis.className = 'pdf'; vis.textContent = 'PDF'; }
      var meta = document.createElement('div'); meta.className = 'meta';
      var isBlur = f.kind === 'img' && f.sharp < BLUR_THRESHOLD; if (isBlur) blurry = true;
      var b = document.createElement('b'); b.textContent = f.name; var sp = document.createElement('span');
      sp.textContent = (f.size / 1024 < 1024 ? Math.round(f.size / 1024) + ' KB' : (f.size / 1048576).toFixed(1) + ' MB') + (isBlur ? ' · ' : '');
      meta.appendChild(b); meta.appendChild(sp);
      if (isBlur) { var s = document.createElement('span'); s.className = 'blur'; s.textContent = 'parece borrosa'; meta.appendChild(s); }
      var rm = document.createElement('button'); rm.type = 'button'; rm.setAttribute('aria-label', 'Quitar'); rm.textContent = '✕';
      rm.onclick = function () { state.files.splice(i, 1); renderThumbs(); };
      li.appendChild(vis); li.appendChild(meta); li.appendChild(rm); ul.appendChild(li);
    });
    var w = $('fileWarn'); if (blurry) { w.textContent = 'Alguna foto parece borrosa. Repítela con buena luz y el papel plano: la factura debe leerse bien.'; w.hidden = false; } else w.hidden = true;
  }

  /* ---------- envío ---------- */
  function validate() {
    var err = [], a = parseAmount($('amount').value);
    if (!$('person').value) err.push(['person', 'Elige la persona']);
    if (!$('event').value) err.push(['event', 'Elige el evento']);
    if (!$('date').value) err.push(['date', 'Indica la fecha de la factura']);
    if (isNaN(a) || a <= 0) err.push(['amount', 'Escribe el importe con IVA (mayor que 0)']);
    if (!$('concept').value) err.push(['concept', 'Elige el tipo de gasto']);
    if (!$('ivaRate').value) err.push(['ivaRate', 'Indica el tipo de IVA (mira la factura)']);
    if (!$('inClub').value) err.push(['inClub', 'Indica si la factura está a nombre del club']);
    if (!state.files.length) err.push(['btnCamera', 'Adjunta la foto de la factura o ticket']);
    return err;
  }
  function eventLabel() { return $('event').options[$('event').selectedIndex].textContent; }
  function submit(ev) {
    ev.preventDefault();
    var err = validate(), box = $('formError');
    if (err.length) { box.textContent = err.map(function (e) { return '• ' + e[1]; }).join('\n'); box.style.whiteSpace = 'pre-line'; box.hidden = false; var el = $(err[0][0]); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    box.hidden = true;
    var a = parseAmount($('amount').value);
    if (!state.clientId) state.clientId = uuid(); // se mantiene si hay que reintentar → el servidor no duplica
    var payload = {
      action: 'submit', clientId: state.clientId,
      data: { person: $('person').value, eventId: $('event').value, date: $('date').value, amount: Math.round(a * 100) / 100, concept: $('concept').value,
        supplier: $('supplier').value.trim(), docNumber: $('docNumber').value.trim(), docType: $('docType').value, ivaRate: $('ivaRate').value, inClub: $('inClub').value, notes: $('notes').value.trim() },
      files: state.files.map(function (f) { return { name: f.name, mime: f.mime, base64: f.base64 }; })
    };
    var info = { who: payload.data.person, label: eventLabel(), amount: fmt(a), reimb: $('person').options[$('person').selectedIndex].dataset.reimb !== '0' };
    if (state.offline || !navigator.onLine) return saveLocal(payload, info);
    busy(true, 'Subiendo gasto… no cierres la página');
    api(Object.assign({ password: state.password, force: state.force }, payload)).then(function (res) {
      busy(false); state.force = false;
      if (res && res.duplicate) { if (window.confirm(res.message + '\n\n¿Subirlo de todas formas?')) { state.force = true; submit(ev); } return; }
      if (!res || !res.ok) { box.textContent = (res && res.error) || 'No se pudo guardar. Inténtalo de nuevo.'; box.hidden = false; return; }
      state.clientId = ''; done(info, res.reimbursable !== false, false);
    }).catch(function (e) {
      busy(false);
      if (e && e.network) saveLocal(payload, info); else { box.textContent = 'Error: ' + (e && e.message); box.hidden = false; }
    });
  }
  function saveLocal(payload, info) {
    var item = Object.assign({ savedAt: Date.now(), info: info }, payload);
    return qPut(item).then(function () { state.clientId = ''; done(info, info.reimb, true); renderQueue(); });
  }
  function done(info, reimb, local) {
    $('doneIcon').textContent = local ? '⏳' : '✔';
    $('doneTitle').textContent = local ? 'Guardado en el móvil' : 'Gasto guardado';
    $('doneSummary').textContent = info.who + ' · ' + info.label + ' · ' + info.amount + ' €';
    var n = $('doneNote');
    n.textContent = local ? 'No hay cobertura: se enviará automáticamente en cuanto la recuperes (mantén la app instalada o abierta una vez con señal).'
      : (reimb ? 'Queda pendiente de liquidar a ' + info.who + '.' : 'Gasto de tarjeta del club: registrado para el IVA, sin liquidación.');
    n.hidden = false; show('doneView');
  }
  function resetForAnother() {
    state.files = []; state.clientId = ''; renderThumbs();
    ['amount', 'supplier', 'docNumber', 'notes'].forEach(function (i) { $(i).value = ''; });
    ['docType', 'ivaRate', 'inClub'].forEach(function (i) { $(i).value = ''; });
    $('concept').value = ''; $('date').value = todayISO(); $('ivaCalc').hidden = true; $('formError').hidden = true; show('formView');
  }

  /* ---------- envío de la cola ---------- */
  function flushQueue() {
    if (state.flushing || !state.password || !navigator.onLine) return Promise.resolve();
    state.flushing = true;
    return qAll().then(function (items) {
      var sent = 0;
      return items.filter(function (i) { return !i.failedMsg; }).reduce(function (p, it) {
        return p.then(function (stop) {
          if (stop) return true;
          var body = Object.assign({}, it, { password: state.password, force: true }); delete body.info; delete body.savedAt;
          return api(body).then(function (res) {
            if (res && res.ok) { sent++; return qDel(it.clientId).then(function () { return false; }); }
            if (res && /Clave incorrecta/.test(res.error || '')) { toast('La clave ha cambiado: vuelve a entrar para enviar los pendientes.'); return true; }
            it.failedMsg = (res && res.error) || 'Error'; return qPut(it).then(function () { return false; });
          }).catch(function () { state.offline = false; return true; }); // sin cobertura: se reintenta luego
        });
      }, Promise.resolve(false)).then(function () { if (sent) toast('✔ ' + sent + ' gasto' + (sent > 1 ? 's' : '') + ' enviado' + (sent > 1 ? 's' : '') + ' desde el móvil'); });
    }).catch(function () {}).then(function () { state.flushing = false; renderQueue(); });
  }

  /* ---------- Mis gastos ---------- */
  function loadMine() {
    var person = $('minePerson').value, body = $('mineBody');
    if (!person) { body.innerHTML = '<p class="empty">Elige una persona.</p>'; return; }
    body.innerHTML = '<p class="empty">Cargando…</p>';
    Promise.all([api({ action: 'mine', password: state.password, person: person }).catch(function (e) { return { ok: false, error: e.message, network: true }; }), qAll()]).then(function (r) {
      var res = r[0], local = r[1].filter(function (i) { return i.data.person === person; });
      var html = '';
      if (!res.ok) html += '<p class="warn">' + esc(res.network ? 'Sin conexión: no se puede consultar el servidor.' : res.error) + '</p>';
      else if (res.reimbursable) html += '<div class="tiles"><div class="tile main full"><small>Pendiente de cobro</small><b>' + fmt(res.pending) + ' €</b></div><div class="tile"><small>Ya liquidado</small><b>' + fmt(res.paid) + ' €</b></div><div class="tile"><small>Total subido</small><b>' + fmt(res.total) + ' €</b></div></div>';
      else html += '<div class="tiles"><div class="tile main full"><small>Pagado con la tarjeta del club (no se liquida)</small><b>' + fmt(res.total) + ' €</b></div></div>';
      var items = [];
      local.forEach(function (i) { items.push('<li><span class="t">' + esc(i.info.label) + '</span><span class="a">' + fmt(i.data.amount) + ' €</span><span class="s">' + esc(i.data.concept) + ' · ' + esc(i.data.date) + '</span><span class="s" style="text-align:right"><span class="pill local">Sin enviar</span></span></li>'); });
      if (res.ok) res.items.forEach(function (i) {
        var cls = i.status === 'Pendiente' ? 'pend' : (i.status === 'Liquidado' ? 'paid' : ''), extra = i.status === 'Liquidado' && i.paidOn ? ' · ' + esc(i.paidOn) : '';
        items.push('<li><span class="t">' + esc(i.event) + '</span><span class="a">' + fmt(i.amount) + ' €</span><span class="s">' + esc(i.concept) + (i.supplier ? ' · ' + esc(i.supplier) : '') + ' · ' + esc(i.date) + '</span><span class="s" style="text-align:right"><span class="pill ' + cls + '">' + esc(i.status) + '</span>' + extra + '</span></li>');
      });
      html += items.length ? '<ul class="items">' + items.join('') + '</ul>' : (res.ok ? '<p class="empty">Todavía no hay gastos de ' + esc(person) + '.</p>' : '');
      body.innerHTML = html;
    });
  }

  /* ---------- servidor simulado (solo ?mock=1) ---------- */
  var mockDb = [];
  function mockApi(body) {
    return new Promise(function (res, rej) {
      setTimeout(function () {
        if (window.__mockOffline) return rej(netError('Sin conexión'));
        if (body.password !== 'demo') return res({ ok: false, error: 'Clave incorrecta (modo demo: usa "demo")' });
        if (body.action === 'login') return res({ ok: true, config: {
          persons: ['Tarjeta empresa', 'Persona A', 'Persona B', 'Persona C'].map(function (n) { return { name: n, reimbursable: n !== 'Tarjeta empresa' }; }),
          events: [{ id: 'e1', label: 'Evento de ejemplo 1', quarter: 1 }, { id: 'e2', label: 'Evento de ejemplo 2', quarter: 2 }, { id: 'general', label: 'Gastos generales (sin evento)', quarter: 0 }],
          concepts: ['Vuelos/Barco', 'Diésel', 'Peajes/Parking', 'Comida', 'Hotel/Apartamentos', 'Otros'] } });
        if (body.action === 'submit') {
          var dup = mockDb.filter(function (x) { return x.clientId === body.clientId; })[0]; if (dup) return res({ ok: true, id: dup.id, already: true, reimbursable: dup.reimb });
          var id = 'DEMO-' + (mockDb.length + 1), reimb = body.data.person !== 'Tarjeta empresa';
          mockDb.push({ id: id, clientId: body.clientId, reimb: reimb, date: body.data.date, event: body.data.eventId, concept: body.data.concept, supplier: body.data.supplier, amount: body.data.amount, person: body.data.person, status: reimb ? 'Pendiente' : 'No aplica' });
          console.log('[demo] gasto guardado', id, body.data); return res({ ok: true, id: id, reimbursable: reimb });
        }
        if (body.action === 'mine') {
          var mine = mockDb.filter(function (x) { return x.person === body.person; }), sum = function (st) { return mine.filter(function (x) { return x.status === st; }).reduce(function (a, x) { return a + x.amount; }, 0); };
          return res({ ok: true, person: body.person, reimbursable: body.person !== 'Tarjeta empresa', pending: sum('Pendiente'), paid: sum('Liquidado'), total: mine.reduce(function (a, x) { return a + x.amount; }, 0), count: mine.length,
            items: mine.map(function (x) { return { date: x.date, event: x.event, concept: x.concept, supplier: x.supplier, amount: x.amount, status: x.status, paidOn: '' }; }) });
        }
        res({ ok: false, error: 'Acción desconocida' });
      }, 350);
    });
  }

  /* ---------- eventos ---------- */
  $('loginBtn').addEventListener('click', function () { var pw = $('password').value.trim(); if (!pw) { $('loginError').textContent = 'Escribe la clave'; $('loginError').hidden = false; return; } $('loginError').hidden = true; doLogin(pw, $('remember').checked, false); });
  $('password').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });
  $('logout').addEventListener('click', function () { clearSession(); state.password = ''; $('password').value = ''; $('queueBanner').hidden = true; show('loginView'); });
  $('tabUpload').addEventListener('click', function () { show('formView'); });
  $('tabMine').addEventListener('click', function () { show('mineView'); loadMine(); });
  $('minePerson').addEventListener('change', loadMine);
  $('person').addEventListener('change', onPersonChange);
  $('amount').addEventListener('input', updateIva); $('ivaRate').addEventListener('change', updateIva);
  $('amount').addEventListener('blur', function () { var a = parseAmount(this.value); if (!isNaN(a) && a > 0) this.value = a.toFixed(2).replace('.', ','); updateIva(); });
  $('btnCamera').addEventListener('click', function () { $('fileCamera').click(); });
  $('btnGallery').addEventListener('click', function () { $('fileGallery').click(); });
  $('fileCamera').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('fileGallery').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('expenseForm').addEventListener('submit', submit);
  $('againBtn').addEventListener('click', resetForAnother);
  $('queueRetry').addEventListener('click', function () {
    qAll().then(function (items) { return Promise.all(items.filter(function (i) { return i.failedMsg; }).map(function (i) { delete i.failedMsg; return qPut(i); })); }).then(function () { if (!navigator.onLine) toast('Aún no hay cobertura'); state.offline = false; return flushQueue(); });
  });
  $('queueDiscard').addEventListener('click', function () { if (!window.confirm('¿Descartar los gastos con error? Se perderán.')) return; qAll().then(function (items) { return Promise.all(items.filter(function (i) { return i.failedMsg; }).map(function (i) { return qDel(i.clientId); })); }).then(renderQueue); });
  window.addEventListener('online', function () { state.offline = false; flushQueue(); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) flushQueue(); });
  setInterval(function () { flushQueue(); }, 60000);

  /* ---------- arranque ---------- */
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(function () {});
  var pw = savedPassword();
  show('loginView');
  if (MOCK) { $('loginError').textContent = 'MODO DEMO: clave "demo". No se guarda nada real.'; $('loginError').hidden = false; }
  if (pw) {
    var cfg = null; try { cfg = JSON.parse(lsGet('gx.cfg') || 'null'); } catch (e) {}
    if (!navigator.onLine && cfg) { startSession(pw, cfg, true); toast('Sin cobertura: puedes registrar gastos, se enviarán después.'); }
    else doLogin(pw, !!lsGet('gx.pw'), true);
  }
})();
