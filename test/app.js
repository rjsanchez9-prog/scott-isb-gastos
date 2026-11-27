/* Gastos SCOTT-ISB 2027 · landing móvil. Sin dependencias.
   La clave se valida en el servidor (Apps Script): aquí no hay contraseñas ni listas de personas en el código.
   Sin cobertura: el gasto se guarda en el móvil (IndexedDB) y se envía solo cuando vuelve la señal. */
(function () {
  'use strict';
  var CFG = window.CONFIG || {};
  var MOCK = /[?&]mock=1/.test(location.search) || CFG.backendUrl === 'MOCK';
  var MAX_FILES = 4, MAX_PDF_MB = 7, BLUR_THRESHOLD = 200, TIMEOUT_MS = 60000;
  var $ = function (id) { return document.getElementById(id); };
  var state = { password: '', pins: {}, salary: false, config: null, files: [], force: false, clientId: '', offline: false, flushing: false, again: false, eventManual: false, ivaAuto: false, clubAuto: false, clubPrev: '' };

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
    v = String(v == null ? '' : v).trim().replace(/[\s€]/g, '');
    if (!v) return NaN;
    var c = v.lastIndexOf(','), d = v.lastIndexOf('.'), dots = (v.match(/\./g) || []).length;
    if (c > -1 && d > -1) v = c > d ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, ''); // el último separador es el decimal
    else if (dots > 1) v = /^[1-9]\d{0,2}(\.\d{3})+$/.test(v) ? v.replace(/\./g, '') : 'x'; // 1.234.567 -> miles
    else if (d > -1 && /^[1-9]\d{0,2}\.\d{3}$/.test(v)) v = v.replace('.', ''); // 1.500 -> mil quinientos (punto + 3 cifras, sin coma = miles)
    else v = v.replace(',', '.'); // 12,5 -> 12.5 · 12.5 se queda igual · 0.500 -> 0,5
    return /^(\d+\.?\d*|\.\d+)$/.test(v) ? Number(v) : NaN;
  }
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function savedPassword() { try { return localStorage.getItem('gx.pw') || sessionStorage.getItem('gx.pw') || ''; } catch (e) { return ''; } }
  function clearSession() { state.mpin = ''; try { localStorage.removeItem('gx.mpin'); localStorage.removeItem('gx.pw'); sessionStorage.removeItem('gx.pw'); localStorage.removeItem('gx.cfg'); localStorage.removeItem('gx.pins'); } catch (e) {} state.pins = {}; }
  function loadPins() { state.mpin = lsGet('gx.mpin') || ''; try { state.pins = JSON.parse(lsGet('gx.pins') || '{}') || {}; } catch (e) { state.pins = {}; } }
  function savePins() { lsSet('gx.pins', JSON.stringify(state.pins)); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); } // también comillas: sirve para texto y para atributos

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
      $('queueText').textContent = txt; $('queueDiscard').hidden = !failed.length; $('queueForce').hidden = !failed.some(function (i) { return i.dupe; }); b.hidden = false;
    });
  }

  /* ---------- API (real o simulada) ---------- */
  function api(body) {
    if (CFG.env) body = Object.assign({}, body, { env: CFG.env }); // entorno de pruebas: solo existe si config.js lo define
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
    state.password = pw; state.config = cfg; state.offline = !!offline; loadPins();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {} // evita que el móvil borre la cola de pendientes
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
    p.innerHTML = ''; e.innerHTML = ''; k.innerHTML = ''; mp.innerHTML = ''; state.eventManual = false;
    p.appendChild(opt('', 'Selecciona tu nombre…'));
    var fw = $('forWhom'); fw.innerHTML = ''; fw.appendChild(opt('', 'Nadie en concreto'));
    c.persons.forEach(function (x) { p.appendChild(opt(x.name, x.name, { reimb: x.reimbursable ? '1' : '0', sup: x.supplier ? '1' : '0', nopin: x.noPin ? '1' : '0' })); mp.appendChild(opt(x.name, x.name)); if (x.reimbursable && !x.supplier) fw.appendChild(opt(x.name, x.name)); });
    e.appendChild(opt('', 'Selecciona el evento…'));
    var groups = {};
    c.events.forEach(function (x) { var q = x.quarter || 0; (groups[q] = groups[q] || []).push(x); });
    Object.keys(groups).sort().forEach(function (q) {
      var g = document.createElement('optgroup'); g.label = q === '0' ? 'Sin evento' : 'Trimestre ' + q;
      groups[q].forEach(function (x) { g.appendChild(opt(x.id, x.label)); }); e.appendChild(g);
    });
    k.appendChild(opt('', 'Tipo de gasto…'));
    c.concepts.forEach(function (x) { k.appendChild(opt(x, x)); });
    buildConceptTiles();
    var lp = lsGet('gx.person'); if (lp) { p.value = lp; mp.value = lp; }
    $('date').value = ''; $('date').max = todayISO(); $('date').min = '2026-11-01';
    onPersonChange();
  }
  /* ---------- teselas de concepto (los más usados a un toque; el resto en «Más tipos») ---------- */
  var TOP = [['Comida', '🍽️', 'Comida'], ['Supermercado', '🛒', 'Supermercado'], ['Diésel', '⛽', 'Diésel'], ['Peajes/Parking', '🅿️', 'Peajes · Parking'], ['Hotel/Apartamentos', '🏨', 'Hotel'], ['Vuelos/Barco', '✈️', 'Vuelos · Barco'], ['Coche de alquiler', '🚗', 'Coche alquiler'], ['Material/Recambios', '🔧', 'Material'], ['Otros', '⋯', 'Otros']];
  var conceptWired = false;
  function buildConceptTiles() {
    var box = $('conceptTiles'), have = {}; box.innerHTML = '';
    Array.prototype.forEach.call($('concept').options, function (o) { have[o.value] = 1; });
    TOP.forEach(function (t) {
      if (!have[t[0]]) return;
      var b = document.createElement('button'); b.type = 'button'; b.className = 'ct'; b.dataset.v = t[0];
      b.innerHTML = '<span class="ci">' + t[1] + '</span><span class="cl">' + esc(t[2]) + '</span>';
      b.addEventListener('click', function () { $('concept').value = t[0]; $('concept').dispatchEvent(new Event('change')); });
      box.appendChild(b);
    });
    var m = document.createElement('button'); m.type = 'button'; m.className = 'ct'; m.id = 'conceptMoreBtn';
    m.innerHTML = '<span class="ci">＋</span><span class="cl">Más tipos</span>';
    m.addEventListener('click', function () { $('conceptMore').hidden = !$('conceptMore').hidden; });
    box.appendChild(m);
    if (!conceptWired) { $('concept').addEventListener('change', syncConceptTiles); conceptWired = true; }
    syncConceptTiles();
  }
  function syncConceptTiles() {
    var v = $('concept').value, inTop = false;
    Array.prototype.forEach.call($('conceptTiles').querySelectorAll('.ct[data-v]'), function (b) { var on = b.dataset.v === v; b.classList.toggle('on', on); if (on) inTop = true; });
    $('conceptMoreBtn').classList.toggle('on', !!v && !inTop);
    if (v && !inTop) $('conceptMore').hidden = false; else if (inTop) $('conceptMore').hidden = true;
  }
  function personNeedsPin(name) { var os = $('person') ? $('person').options : []; for (var i = 0; i < os.length; i++) if (os[i].value === name) return os[i].dataset.nopin !== '1'; return true; }
  function needsPin() { var o = $('person').options[$('person').selectedIndex]; return !!($('person').value && o && o.dataset.nopin !== '1'); }
  function onPersonChange() {
    var sel = $('person'), o = sel.options[sel.selectedIndex], n = $('personNote');
    if (o && o.dataset.sup === '1') { n.textContent = 'Factura de un proveedor (agencia de viajes, etc.) que pagará el club por transferencia: queda pendiente de pago hasta que se abone. Indica en "Más datos" para quién es.'; n.hidden = false; }
    else if (o && o.dataset.reimb === '0') { n.textContent = 'Pago con la tarjeta del club: se guarda para el IVA, pero NO entra en ninguna liquidación de gastos.'; n.hidden = false; } else n.hidden = true;
    if (sel.value) { lsSet('gx.person', sel.value); $('minePerson').value = sel.value; }
    applyEvent();
    $('pinBox').hidden = !needsPin(); $('pin').value = needsPin() ? (state.pins[sel.value] || (sel.value !== 'José María Sánchez' && state.mpin) || '') : ''; state.salary = false; $('pinStatus').textContent = '';
    if (needsPin() && $('pin').value) verifyPin();
  }
  var HON = 'Honorarios profesionales';
  function irpfValue() {
    var v = $('irpfRate').value; if (v !== 'other') return v;
    var t = $('irpfOther').value.trim().replace(',', '.'), n = /^\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
    return (!isNaN(n) && n >= 0 && n <= 47) ? String(Math.round(n * 100) / 100) : '';
  }
  function isHon() { return $('concept').value === HON; } // reglas exclusivas de honorarios (factura completa, un solo IVA, partida anual)
  function irpfList() { var l = state.config && state.config.irpfConcepts; return Array.isArray(l) ? l : [HON]; } // conceptos que piden retención (respaldo: solo honorarios)
  function needsIrpf() { return irpfList().indexOf($('concept').value) >= 0; }
  function irpfPositive() { var v = irpfValue(); return v !== '' && Number(v) > 0; }
  function isTicket() { return $('docType').value === 'Ticket / factura simplificada'; }
  function updateIrpfWarn() { $('irpfWarn').hidden = !(needsIrpf() && irpfPositive() && isTicket()); }
  var TRAVEL = ['Vuelos/Barco', 'Hotel/Apartamentos', 'Coche de alquiler', 'Inscripciones'];
  function updateWhom() {
    var po = $('person').options[$('person').selectedIndex], c = $('concept').value;
    var show = !!c && c !== HON && ((po && po.dataset.sup === '1') || TRAVEL.indexOf(c) >= 0);
    $('forWhomBox').hidden = !show; if (!show) $('forWhom').value = '';
  }
  function verifyPin() {
    var person = $('person').value, pin = $('pin').value.trim(), st = $('pinStatus');
    if (!person || !pin) { st.textContent = ''; state.salary = false; return Promise.resolve(false); }
    if (state.offline || !navigator.onLine) { st.textContent = 'Sin cobertura: el PIN se comprobará al enviar.'; return Promise.resolve(false); }
    return api({ action: 'pin', password: state.password, person: person, pin: pin }).then(function (res) {
      if (res && res.ok && res.master) { state.mpin = pin; lsSet('gx.mpin', pin); state.salary = false; st.textContent = '✔ PIN maestro: solo sirve para consultar «Mis gastos» de esta persona'; updateIva(); return true; }
      if (res && res.ok) { state.pins[person] = pin; savePins(); state.salary = !!res.salary; st.textContent = '✔ PIN correcto'; updateIva(); retryFailed(person, true); return true; }
      state.salary = false; st.textContent = (res && res.error) || 'PIN incorrecto'; updateIva(); return false;
    }).catch(function () { st.textContent = 'No se pudo comprobar (sin conexión).'; return false; });
  }
  function updateIva() {
    updateWhom();
    var hon = isHon(), irp = needsIrpf();
    $('amountLabel').textContent = irp ? 'Total de la factura ANTES de la retención (base + IVA)' : 'Importe IVA incluido';
    var a = parseAmount($('amount').value), r = $('ivaRate').value, el = $('ivaCalc'), ir = irpfValue(), ic = $('irpfCalc'); $('irpfOther').hidden = $('irpfRate').value !== 'other';
    $('irpfBox').hidden = !irp; $('irpfNote').hidden = !(hon && state.salary);
    $('irpfHelp').textContent = hon ? 'Pon el porcentaje que indique la factura del profesional.' : 'Si quien te factura es un autónomo, su factura suele llevar retención de IRPF (15 % o 7 %). Elige 0 % si no lleva.';
    if (hon && !$('docType').value) { $('docType').value = 'Factura completa'; updateDoc(); }
    updateIrpfWarn();
    ic.hidden = true; $('ivaMulti').hidden = r !== 'multi'; if (r === 'multi') updateMulti();
    if (!isNaN(a) && a > 0 && r !== '' && r !== 'multi') {
      var base = a / (1 + Number(r) / 100); el.textContent = 'Base imponible ' + fmt(base) + ' € · IVA ' + fmt(a - base) + ' €'; el.hidden = false;
      if (irp && ir !== '') { var ret = Math.round(base * Number(ir)) / 100; ic.textContent = 'Retención ' + fmt(ret) + ' € · A transferir ' + fmt(a - ret) + ' €'; ic.hidden = false; }
    } else el.hidden = true;
  }

  /* ---------- atajos: último evento e IVA sugerido ---------- */
  function evMap() { var m = null; try { m = JSON.parse(lsGet('gx.events') || '{}'); } catch (e) {} return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; }
  function rememberEvent(person, id) { if (!person || !id) return; var m = evMap(); m[person] = id; lsSet('gx.events', JSON.stringify(m)); }
  function updateEventHint() { var p = $('person').value, id = p ? evMap()[p] : ''; $('eventHint').hidden = !(id && $('event').value === id); }
  function applyEvent() { // deja puesto el último evento de esta persona, salvo que ya haya elegido uno a mano; la primera vez no hay nada
    var e = $('event'), p = $('person').value, id = p ? evMap()[p] : '', ok = false;
    Array.prototype.forEach.call(e.options, function (o) { if (id && o.value === id) ok = true; });
    if (!state.eventManual) e.value = ok ? id : '';
    updateEventHint();
  }
  function suggestIva() {
    var c = $('concept').value, d = state.config && state.config.ivaDefaults, sel = $('ivaRate'), n = $('ivaSuggest'), v = (c && d && Object.prototype.hasOwnProperty.call(d, c)) ? String(d[c]).trim() : '';
    if (['21', '10', '4', '0'].indexOf(v) < 0) v = '';
    if (sel.value !== '' && !state.ivaAuto) return; // la persona ya eligió el IVA: no se pisa
    if (v) { sel.value = v; state.ivaAuto = true; n.textContent = 'Sugerido para ' + c + ': ' + v + ' %. Cámbialo si tu ticket dice otro.'; n.hidden = false; }
    else if (state.ivaAuto) { sel.value = ''; state.ivaAuto = false; n.hidden = true; n.textContent = ''; }
  }
  function onConceptChange() { suggestIva(); updateIva(); }
  function onIvaChange() { state.ivaAuto = false; $('ivaSuggest').hidden = true; updateIva(); } // cambio hecho por la persona

  /* ---------- varios tipos de IVA (supermercado…) ---------- */
  var RATES = [21, 10, 4, 0];
  function money(v) { var n = parseAmount(v); return isNaN(n) ? 0 : Math.round(n * 100) / 100; }
  function breakdown() {
    var rows = [];
    RATES.forEach(function (rt) { var b = money($('mb' + rt).value), c = rt === 0 ? 0 : money($('mc' + rt).value); if (b > 0) rows.push({ r: rt, b: b, c: c }); });
    return rows;
  }
  function updateMulti() {
    RATES.forEach(function (rt) {
      if (rt === 0) return;
      var c = $('mc' + rt), b = money($('mb' + rt).value);
      if (!c.dataset.manual) c.value = b > 0 ? (Math.round(b * rt) / 100).toFixed(2).replace('.', ',') : '';
    });
    var rows = breakdown(), base = 0, cuota = 0, a = parseAmount($('amount').value), el = $('multiSum');
    rows.forEach(function (x) { base += x.b; cuota += x.c; });
    var tot = Math.round((base + cuota) * 100) / 100;
    if (!rows.length) { el.textContent = ''; el.className = 'small'; return; }
    var ok = !isNaN(a) && Math.abs(tot - a) <= 0.02;
    el.textContent = 'Suma del desglose: ' + fmt(tot) + ' € (base ' + fmt(base) + ' + IVA ' + fmt(cuota) + ')' + (isNaN(a) || a <= 0 ? '' : ok ? ' · ✔ cuadra con el importe' : ' · ✖ el importe es ' + fmt(a) + ' €: revisa los números');
    el.className = 'small ' + (isNaN(a) || a <= 0 ? '' : ok ? 'msum-ok' : 'msum-bad');
  }
  function multiErrors(a) {
    var rows = breakdown(), e = [], base = 0, cuota = 0;
    if (isHon()) return ['Los honorarios profesionales llevan un único tipo de IVA'];
    if (rows.length < 2) return ['Rellena la base de al menos dos tipos de IVA (si solo hay uno, elígelo en la lista)'];
    rows.forEach(function (x) {
      base += x.b; cuota += x.c;
      if (Math.abs(x.c - x.b * x.r / 100) > 0.05) e.push('La cuota del ' + x.r + ' % no cuadra con su base (debería rondar ' + fmt(Math.round(x.b * x.r) / 100) + ' €)');
    });
    if (!e.length && !isNaN(a) && Math.abs(base + cuota - a) > 0.02) e.push('El desglose suma ' + fmt(base + cuota) + ' € y el importe es ' + fmt(a) + ' €');
    return e;
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

  /* ---------- factura o ticket: datos fiscales ---------- */
  // Misma comprobación que el servidor (NIF/CIF/NIE con letra de control; identificadores extranjeros con prefijo de país).
  function nifCheck(raw) {
    var s = String(raw == null ? '' : raw).toUpperCase().replace(/[\s.\-\/]/g, '');
    if (/^ES[0-9A-Z]{9}$/.test(s)) s = s.slice(2);
    if (!s) return { error: 'Indica el NIF / CIF del emisor de la factura' };
    var L = 'TRWAGMYFPDXBNJZSQVHLCKE', i, dg, sum;
    if (/^[0-9]{8}[A-Z]$/.test(s)) return L.charAt(Number(s.slice(0, 8)) % 23) === s.charAt(8) ? { nif: s } : { error: 'El NIF no es válido: revisa los números y la letra' };
    if (/^[XYZ][0-9]{7}[A-Z]$/.test(s)) return L.charAt(Number('XYZ'.indexOf(s.charAt(0)) + s.slice(1, 8)) % 23) === s.charAt(8) ? { nif: s } : { error: 'El NIE no es válido: revisa los números y la letra' };
    if (/^[ABCDEFGHJNPQRSUVW][0-9]{7}[0-9A-J]$/.test(s)) {
      sum = 0;
      for (i = 0; i < 7; i++) { dg = Number(s.charAt(i + 1)); if (i % 2 === 0) { dg *= 2; if (dg > 9) dg -= 9; } sum += dg; }
      var ctl = (10 - sum % 10) % 10, letter = 'JABCDEFGHI'.charAt(ctl), c = s.charAt(8), f = s.charAt(0);
      var ok = /[PQRSNW]/.test(f) ? c === letter : (/[ABEH]/.test(f) ? c === String(ctl) : (c === String(ctl) || c === letter));
      return ok ? { nif: s } : { error: 'El CIF no es válido: revisa los números y el último carácter' };
    }
    if (/^[KLM][0-9]{7}[0-9A-Z]$/.test(s)) return { nif: s };
    if (/^[A-Z]{2,3}[A-Z0-9]{6,16}$/.test(s)) return { nif: s };
    return { error: 'El NIF / CIF no tiene un formato válido (ej. B12345678, 12345678Z, o un identificador extranjero con prefijo de país)' };
  }
  function updateDoc() {
    var fact = $('docType').value === 'Factura completa', d = $('more');
    $('nifBox').hidden = !fact;
    $('lblSupplier').textContent = fact ? 'Razón social del emisor (obligatorio)' : 'Establecimiento (opcional)';
    $('lblDocNumber').textContent = fact ? 'Nº de factura (obligatorio)' : 'Nº de ticket (opcional)';
    $('moreSum').textContent = fact ? 'Datos de la factura (obligatorios)' : 'Más datos (opcional)';
    $('supplier').placeholder = fact ? 'Nombre de la empresa o autónomo que emite la factura' : 'Ej. Repsol, Hotel Girona…';
    if (fact) d.open = true;
    syncClub(); updateIrpfWarn();
    updateNif();
  }
  function syncClub() { // un ticket nunca va a nombre del club: se oculta la pregunta y se envía «No»
    var tk = isTicket(), sel = $('inClub');
    $('inClubBox').hidden = tk; $('inClubTicket').hidden = !tk; $('inClubHelp').hidden = tk;
    if (tk) { if (!state.clubAuto) { state.clubPrev = sel.value; state.clubAuto = true; } sel.value = 'No'; }
    else if (state.clubAuto) { sel.value = state.clubPrev || ''; state.clubAuto = false; state.clubPrev = ''; }
  }
  function updateNif() {
    var el = $('nifStatus'), v = $('nif').value.trim();
    if ($('nifBox').hidden || !v) { el.textContent = ''; return; }
    var r = nifCheck(v); el.textContent = r.error ? '✖ ' + r.error : '✔ ' + r.nif;
  }

  /* ---------- envío ---------- */
  function validate() {
    var err = [], a = parseAmount($('amount').value);
    if (!$('person').value) err.push(['person', 'Elige la persona']);
    if (needsPin() && !$('pin').value.trim()) err.push(['pin', 'Escribe tu PIN personal']);
    else if (needsPin() && state.mpin && $('person').value !== 'José María Sánchez' && $('pin').value.trim() === state.mpin) err.push(['pin', 'Ese es el PIN maestro: solo sirve para consultar. Para subir un gasto a nombre de esta persona hace falta su propio PIN']);
    if (!$('event').value) err.push(['event', 'Elige el evento']);
    if (!$('date').value) err.push(['date', 'Indica la fecha que figura en la factura o ticket']);
    else if ($('date').value > todayISO() || $('date').value < '2026-11-01') err.push(['date', 'La fecha debe estar entre el 01/11/2026 y hoy']);
    if (isNaN(a) || a <= 0) err.push(['amount', 'Escribe el importe con IVA (mayor que 0)']);
    if (!$('concept').value) err.push(['concept', 'Elige el tipo de gasto']);
    if (!$('ivaRate').value) err.push(['ivaRate', 'Indica el tipo de IVA (mira la factura)']);
    else if ($('ivaRate').value === 'multi') multiErrors(a).forEach(function (m) { err.push(['mb21', m]); });
    if (!isTicket() && !$('inClub').value) err.push(['inClub', 'Indica si la factura está a nombre del club']);
    if (needsIrpf() && irpfValue() === '') err.push([$('irpfRate').value === 'other' ? 'irpfOther' : 'irpfRate', 'Indica la retención de IRPF de la factura (0 si no lleva; entre 0 y 47 %)']);
    if (!$('docType').value) err.push(['docType', 'Indica si es factura completa o ticket']);
    else if ($('docType').value !== 'Factura completa' && isHon()) err.push(['docType', 'Los honorarios profesionales requieren factura completa']);
    else if ($('docType').value !== 'Factura completa' && needsIrpf() && irpfPositive()) err.push(['docType', 'Si la factura lleva retención de IRPF hace falta una factura completa (un ticket no sirve). Elige «Factura completa» o pon la retención a 0 % si no la lleva']);
    else if ($('docType').value === 'Factura completa') {
      if ($('supplier').value.trim().length < 2) err.push(['supplier', 'Indica la razón social del emisor de la factura']);
      if (!$('docNumber').value.trim()) err.push(['docNumber', 'Indica el nº de factura']);
      var nv = nifCheck($('nif').value); if (nv.error) err.push(['nif', nv.error]);
    }
    if (!state.files.length) err.push(['btnCamera', 'Adjunta la foto de la factura o ticket']);
    return err;
  }
  function eventLabel() { return $('event').options[$('event').selectedIndex].textContent; }
  function submit(ev) {
    ev.preventDefault();
    var err = validate(), box = $('formError');
    if (err.length) { box.textContent = err.map(function (e) { return '• ' + e[1]; }).join('\n'); box.style.whiteSpace = 'pre-line'; box.hidden = false; var el = $(err[0][0] === 'concept' ? 'conceptTiles' : err[0][0]); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    box.hidden = true;
    var a = parseAmount($('amount').value);
    if (!state.clientId) state.clientId = uuid(); // se mantiene si hay que reintentar → el servidor no duplica
    var payload = {
      action: 'submit', clientId: state.clientId,
      data: { person: $('person').value, eventId: $('event').value, date: $('date').value, amount: Math.round(a * 100) / 100, concept: $('concept').value,
        forWhom: $('forWhomBox').hidden ? '' : $('forWhom').value, supplier: $('supplier').value.trim(), docNumber: $('docNumber').value.trim(), nif: $('docType').value === 'Factura completa' ? nifCheck($('nif').value).nif || '' : '', docType: $('docType').value, ivaRate: $('ivaRate').value, ivaBreakdown: $('ivaRate').value === 'multi' ? breakdown() : undefined, irpfRate: needsIrpf() ? irpfValue() : '', inClub: isTicket() ? 'No' : $('inClub').value, notes: $('notes').value.trim() },
      files: state.files.map(function (f) { return { name: f.name, mime: f.mime, base64: f.base64 }; })
    };
    var info = { who: payload.data.person, eventId: payload.data.eventId, label: eventLabel(), amount: fmt(a), reimb: $('person').options[$('person').selectedIndex].dataset.reimb !== '0', sup: $('person').options[$('person').selectedIndex].dataset.sup === '1' };
    if (state.offline || !navigator.onLine) return saveLocal(payload, info);
    busy(true, 'Subiendo gasto… no cierres la página');
    api(Object.assign({ password: state.password, pin: needsPin() ? $('pin').value.trim() : '', force: state.force }, payload)).then(function (res) {
      busy(false); state.force = false;
      if (res && res.pinError) { box.textContent = res.error; box.hidden = false; $('pinStatus').textContent = res.error; $('pin').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
      if (res && res.duplicate) { if (window.confirm(res.message + '\n\n¿Subirlo de todas formas?')) { state.force = true; submit(ev); } return; }
      if (!res || !res.ok) { box.textContent = (res && res.error) || 'No se pudo guardar. Inténtalo de nuevo.'; box.hidden = false; return; }
      if (needsPin()) { state.pins[payload.data.person] = $('pin').value.trim(); savePins(); } state.clientId = ''; done(info, res.reimbursable !== false, false, !!res.auto);
    }).catch(function (e) {
      busy(false);
      if (e && e.network) saveLocal(payload, info); else { box.textContent = 'Error: ' + (e && e.message); box.hidden = false; }
    });
  }
  function saveLocal(payload, info) {
    var item = Object.assign({ savedAt: Date.now(), info: info, pin: needsPin() ? $('pin').value.trim() : '' }, payload); // el PIN escrito sin cobertura viaja con el gasto
    return qPut(item).then(function () { state.clientId = ''; done(info, info.reimb, true); renderQueue(); });
  }
  function done(info, reimb, local, auto) {
    rememberEvent(info.who, info.eventId);
    $('doneIcon').textContent = local ? '⏳' : '✔';
    $('doneTitle').textContent = local ? 'Guardado en el móvil' : 'Gasto guardado';
    $('doneSummary').textContent = info.who + ' · ' + info.label + ' · ' + info.amount + ' €';
    var n = $('doneNote');
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) && !(window.navigator.standalone);
    n.textContent = local ? 'No hay cobertura: se enviará automáticamente en cuanto la recuperes (mantén la app instalada o abierta una vez con señal).' + (ios ? ' En iPhone, añade esta web a la pantalla de inicio (Compartir → Añadir a pantalla de inicio): si no, el móvil puede borrar los pendientes pasados unos días.' : '')
      : (info.sup ? 'Factura de proveedor registrada: queda pendiente de pago por el club.' : (reimb ? 'Queda pendiente de liquidar a ' + info.who + '.' : 'Gasto de tarjeta del club: registrado para el IVA, sin liquidación.'));
    n.hidden = false; $('doneAuto').hidden = !(auto && !local); show('doneView');
  }
  function resetForAnother() {
    state.files = []; state.clientId = ''; state.ivaAuto = false; state.clubAuto = false; state.clubPrev = ''; state.eventManual = false; renderThumbs();
    $('ivaSuggest').hidden = true;
    ['amount', 'supplier', 'docNumber', 'notes'].forEach(function (i) { $(i).value = ''; });
    ['docType', 'ivaRate', 'inClub', 'forWhom', 'irpfRate', 'irpfOther', 'mb21', 'mb10', 'mb4', 'mb0', 'mc21', 'mc10', 'mc4'].forEach(function (i) { $(i).value = ''; if ($(i).dataset) delete $(i).dataset.manual; });
    $('ivaMulti').hidden = true;
    $('nif').value = ''; $('concept').value = ''; syncConceptTiles(); $('date').value = ''; updateDoc(); $('ivaCalc').hidden = true; $('irpfBox').hidden = true; $('irpfWarn').hidden = true; $('forWhomBox').hidden = true; $('formError').hidden = true; applyEvent(); show('formView');
  }

  /* ---------- envío de la cola ---------- */
  function flushQueue() {
    if (state.flushing) { state.again = true; return Promise.resolve(); } // si llega otra orden mientras envía, se repasa al terminar
    if (!state.password || !navigator.onLine) return Promise.resolve();
    state.flushing = true;
    return qAll().then(function (items) {
      var sent = 0, badPins = {};
      return items.filter(function (i) { return !i.failedMsg; }).reduce(function (p, it) {
        return p.then(function (stop) {
          if (stop) return true;
          var pinV = it.pin || state.pins[it.data.person] || '';
          if (!pinV && personNeedsPin(it.data.person)) { toast('Falta el PIN de ' + it.data.person + ': ábrelo en «Subir gasto» y escríbelo para enviar los pendientes.'); return true; } // sin PIN no se envía: cada intento vacío cuenta como fallo y bloquea
          var bad = it.data.person + '|' + pinV;
          if (badPins[bad]) return failPin(it).then(function () { return false; }); // mismo PIN que ya falló: no se vuelve a probar (evita bloquear el PIN)
          var body = Object.assign({}, it, { password: state.password, pin: pinV, force: !!it.forceSend }); delete body.info; delete body.savedAt; delete body.dupe; delete body.forceSend; delete body.failedMsg; delete body.pinFail;
          return api(body).then(function (res) {
            if (res && res.ok) { sent++; return qDel(it.clientId).then(function () { return false; }); }
            if (res && res.duplicate) { it.failedMsg = 'Posible duplicado (' + (res.message || 'ya hay un gasto igual') + ')'; it.dupe = true; return qPut(it).then(function () { return false; }); }
            if (res && res.pinError) { badPins[bad] = 1; return failPin(it).then(function () { return false; }); }
            if (res && /Clave incorrecta/.test(res.error || '')) { toast('La clave ha cambiado: vuelve a entrar para enviar los pendientes.'); return true; }
            it.failedMsg = (res && res.error) || 'Error'; return qPut(it).then(function () { return false; });
          }).catch(function () { state.offline = false; return true; }); // sin cobertura: se reintenta luego
        });
      }, Promise.resolve(false)).then(function () { if (sent) toast('✔ ' + sent + ' gasto' + (sent > 1 ? 's' : '') + ' enviado' + (sent > 1 ? 's' : '') + ' desde el móvil'); });
    }).catch(function () {}).then(function () { state.flushing = false; renderQueue(); if (state.again) { state.again = false; return flushQueue(); } });
  }
  var PIN_FAIL = 'El PIN no es correcto. Abre el gasto, escribe tu PIN y reenvíalo';
  function failPin(it) { // queda como fallido y NO se reintenta solo hasta que la persona lo corrija o lo reenvíe
    it.failedMsg = PIN_FAIL; it.pinFail = true; return qPut(it);
  }
  function retryFailed(person, onlyPin) { // person vacío = todos los fallidos; los de PIN solo se reenvían si ya hay un PIN comprobado
    return qAll().then(function (items) {
      var missing = false;
      return Promise.all(items.filter(function (i) { return i.failedMsg && (!person || i.data.person === person) && (!onlyPin || i.pinFail); }).map(function (i) {
        if (i.pinFail) { if (!state.pins[i.data.person] && personNeedsPin(i.data.person)) { missing = true; return null; } delete i.pin; delete i.pinFail; }
        delete i.failedMsg; return qPut(i);
      })).then(function () { if (missing) toast('Para reenviar el gasto con el PIN mal: elige tu nombre en «Subir gasto», escribe tu PIN y vuelve a pulsar Reintentar.'); });
    }).then(function () { renderQueue(); return flushQueue(); });
  }

  /* ---------- Mis gastos ---------- */
  var mine = { res: null, local: [], person: '', status: '', event: '' };
  function loadMine() {
    var person = $('person').value, pin = needsPin() ? $('pin').value.trim() : '', body = $('mineBody');
    if (!person || (needsPin() && !pin)) { body.innerHTML = '<p class="empty">Elige tu nombre y escribe tu PIN en «Subir gasto» para ver tus gastos.</p>'; return; }
    body.innerHTML = '<p class="empty">Cargando…</p>';
    Promise.all([api({ action: 'mine', password: state.password, person: person, pin: pin }).catch(function (e) { return { ok: false, error: e.message, network: true }; }), qAll()]).then(function (r) {
      if (mine.person !== person) { mine.status = ''; mine.event = ''; }
      mine.person = person; mine.res = r[0]; mine.local = r[1].filter(function (i) { return i.data.person === person; });
      renderMine();
    });
  }
  function renderMine() {
    var res = mine.res, person = mine.person, body = $('mineBody'), html = '';
    if (!res.ok) html += '<p class="warn">' + esc(res.network ? 'Sin conexión: no se puede consultar el servidor.' : res.error) + '</p>';
    if (res.ok && res.master) html += '<p class="muted small" style="margin-bottom:8px">Consulta con PIN maestro: estás viendo los gastos de ' + esc(res.person) + '.</p>';
    else if (res.reimbursable) html += '<div class="tiles"><div class="tile main full"><small>' + (res.supplier ? 'Pendiente de pago a proveedores' : 'Pendiente de cobro') + '</small><b>' + fmt(res.pending) + ' €</b></div><div class="tile"><small>Ya liquidado</small><b>' + fmt(res.paid) + ' €</b></div><div class="tile"><small>Total subido</small><b>' + fmt(res.total) + ' €</b></div></div>';
    else html += '<div class="tiles"><div class="tile main full"><small>Pagado con la tarjeta del club (no se liquida)</small><b>' + fmt(res.total) + ' €</b></div></div>';
    var all = [];
    mine.local.forEach(function (i) { all.push({ event: i.info.label, status: 'Sin enviar', amount: Number(i.data.amount) || 0, li: '<li><span class="t">' + esc(i.info.label) + '</span><span class="a">' + fmt(i.data.amount) + ' €</span><span class="s">' + esc(i.data.concept) + ' · ' + esc(i.data.date) + '</span><span class="s" style="text-align:right"><span class="pill local">Sin enviar</span></span></li>' }); });
    if (res.ok) res.items.forEach(function (i) {
      var cls = i.status === 'Pendiente' ? 'pend' : (i.status === 'Liquidado' ? 'paid' : ''), extra = i.status === 'Liquidado' && i.paidOn ? ' · ' + esc(i.paidOn) : '';
      var rv = i.status !== 'Pendiente' ? '' : (i.review === 'Revisado' ? ' <span class="pill paid">Revisado</span>' : (i.review === 'Incidencia' ? ' <span class="pill warnx">Incidencia: ' + esc(String(i.reviewNote || '').replace(/^\d{4}-\d{2}-\d{2}( · )?/, '')) + '</span>' : ' <span class="pill">En revisión</span>'));
      all.push({ event: i.event, status: i.status, amount: Number(i.amount) || 0, li: '<li><span class="t">' + esc(i.event) + '</span><span class="a">' + fmt(i.amount) + ' €</span><span class="s">' + esc(i.concept) + (i.supplier ? ' · ' + esc(i.supplier) : '') + ' · ' + esc(i.date) + (i.irpf ? ' · IRPF −' + fmt(i.irpf) + ' € (neto ' + fmt(i.net) + ' €)' : '') + '</span><span class="s" style="text-align:right"><span class="pill ' + cls + '">' + esc(i.status) + '</span>' + extra + rv + '</span></li>' });
    });
    if (!all.length) { body.innerHTML = html + (res.ok ? '<p class="empty">Todavía no hay gastos de ' + esc(person) + '.</p>' : ''); return; }
    var sts = [], evs = [];
    all.forEach(function (x) { if (sts.indexOf(x.status) < 0) sts.push(x.status); if (evs.indexOf(x.event) < 0) evs.push(x.event); });
    if (sts.indexOf(mine.status) < 0) mine.status = '';
    if (evs.indexOf(mine.event) < 0) mine.event = '';
    html += '<div class="chips">' + ['Todos'].concat(sts).map(function (s2) { var v = s2 === 'Todos' ? '' : s2; return '<button type="button" class="chip' + (mine.status === v ? ' on' : '') + '" data-st="' + esc(v) + '">' + esc(s2) + '</button>'; }).join('') + '</div>';
    if (evs.length > 1) html += '<select id="mineEvent" class="mine-ev"><option value="">Todos los eventos</option>' + evs.map(function (e2) { return '<option value="' + esc(e2) + '"' + (mine.event === e2 ? ' selected' : '') + '>' + esc(e2) + '</option>'; }).join('') + '</select>';
    var shown = all.filter(function (x) { return (!mine.status || x.status === mine.status) && (!mine.event || x.event === mine.event); });
    var tot = shown.reduce(function (a, x) { return a + x.amount; }, 0);
    html += '<p class="mine-sum">' + shown.length + ' gasto' + (shown.length === 1 ? '' : 's') + ' · <b>' + fmt(tot) + ' €</b>' + ((mine.status || mine.event) ? ' <span class="muted">(filtrado)</span>' : '') + '</p>';
    html += shown.length ? '<ul class="items">' + shown.map(function (x) { return x.li; }).join('') + '</ul>' : '<p class="empty">Ningún gasto con ese filtro.</p>';
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('.chip'), function (b) { b.addEventListener('click', function () { mine.status = b.dataset.st; renderMine(); }); });
    var se = $('mineEvent'); if (se) se.addEventListener('change', function () { mine.event = se.value; renderMine(); });
  }

  /* ---------- servidor simulado (solo ?mock=1) ---------- */
  var mockDb = /[?&]seed=1/.test(location.search) ? [ // datos de ejemplo solo en modo demo (?mock=1&seed=1)
    { id: 'D1', clientId: 'a', reimb: true, date: '2026-11-05', event: 'Leyenda de Tartessos · 21–24 ene', concept: 'Diésel', supplier: 'Repsol', amount: 14, person: 'Persona A', status: 'Liquidado' },
    { id: 'D2', clientId: 'b', reimb: true, date: '2026-11-11', event: 'Leyenda de Tartessos · 21–24 ene', concept: 'Hotel/Apartamentos', supplier: 'Hotel Sol', amount: 186.16, person: 'Persona A', status: 'Pendiente' },
    { id: 'D3', clientId: 'c', reimb: true, date: '2026-11-18', event: 'Mediterranean Epic · 4 feb', concept: 'Comida', supplier: 'Bar Pepe', amount: 42.5, person: 'Persona A', status: 'Pendiente' },
    { id: 'D4', clientId: 'd', reimb: true, date: '2026-11-20', event: 'Mediterranean Epic · 4 feb', concept: 'Peajes/Parking', supplier: '', amount: 9.8, person: 'Persona A', status: 'Liquidado' }] : [];
  function mockApi(body) {
    return new Promise(function (res, rej) {
      (window.__mockLog = window.__mockLog || []).push({ action: body.action, env: body.env, pin: body.pin, data: body.data }); // solo demo: permite comprobar qué se envía
      setTimeout(function () {
        if (window.__mockOffline) return rej(netError('Sin conexión'));
        if (body.password !== 'demo') return res({ ok: false, error: 'Clave incorrecta (modo demo: usa "demo")' });
        if (['pin', 'submit', 'mine'].indexOf(body.action) >= 0 && (body.action === 'submit' ? body.data.person : body.person) !== 'Tarjeta empresa' && body.pin !== '123456') return res({ ok: false, pinError: true, error: 'PIN incorrecto (modo demo: 123456)' });
        if (body.action === 'pin') return res({ ok: true, salary: body.person === 'Persona A' });
        if (body.action === 'submit' && window.__mockDup && !body.force) return res({ ok: false, duplicate: true, message: 'Ya hay un gasto igual (demo).' });
        if (body.action === 'login') return res({ ok: true, config: {
          persons: ['Tarjeta empresa', 'Persona A', 'Persona B', 'Persona C'].map(function (n) { return { name: n, reimbursable: n !== 'Tarjeta empresa', noPin: n === 'Tarjeta empresa' }; }),
          events: [{ id: 'e1', label: 'Evento de ejemplo 1', quarter: 1 }, { id: 'e2', label: 'Evento de ejemplo 2', quarter: 2 }, { id: 'general', label: 'Gastos generales (sin evento)', quarter: 0 }],
          concepts: ['Vuelos/Barco', 'Diésel', 'Peajes/Parking', 'Comida', 'Hotel/Apartamentos', 'Supermercado', 'Otros', 'Honorarios profesionales', 'Media/Filmaker', 'Social media'],
          irpfConcepts: ['Honorarios profesionales', 'Media/Filmaker', 'Social media'],
          ivaDefaults: { 'Diésel': '21', 'Peajes/Parking': '21', 'Hotel/Apartamentos': '10', 'Comida': '10', 'Coche de alquiler': '21' } } });
        if (body.action === 'submit') {
          var dup = mockDb.filter(function (x) { return x.clientId === body.clientId; })[0]; if (dup) return res({ ok: true, id: dup.id, already: true, reimbursable: dup.reimb });
          var id = 'DEMO-' + (mockDb.length + 1), reimb = body.data.person !== 'Tarjeta empresa';
          mockDb.push({ id: id, clientId: body.clientId, reimb: reimb, date: body.data.date, event: body.data.eventId, concept: body.data.concept, supplier: body.data.supplier, amount: body.data.amount, person: body.data.person, status: reimb ? 'Pendiente' : 'No aplica' });
          console.log('[demo] gasto guardado', id, body.data); return res({ ok: true, id: id, reimbursable: reimb, auto: !!window.__mockAuto });
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
  $('pin').addEventListener('change', verifyPin);
  $('person').addEventListener('change', onPersonChange);
  ['mb21', 'mb10', 'mb4', 'mb0'].forEach(function (i) { $(i).addEventListener('input', updateMulti); }); ['mc21', 'mc10', 'mc4'].forEach(function (i) { $(i).addEventListener('input', function () { $(i).dataset.manual = $(i).value.trim() ? '1' : ''; updateMulti(); }); });
  $('docType').addEventListener('change', updateDoc); $('nif').addEventListener('input', updateNif); $('amount').addEventListener('input', updateIva); $('ivaRate').addEventListener('change', onIvaChange); $('event').addEventListener('change', function () { state.eventManual = true; updateEventHint(); }); $('irpfRate').addEventListener('change', updateIva); $('irpfOther').addEventListener('input', updateIva); $('concept').addEventListener('change', onConceptChange); $('person').addEventListener('change', updateIva);
  $('amount').addEventListener('blur', function () { var a = parseAmount(this.value); if (!isNaN(a) && a > 0) this.value = a.toFixed(2).replace('.', ','); updateIva(); });
  $('btnCamera').addEventListener('click', function () { $('fileCamera').click(); });
  $('btnGallery').addEventListener('click', function () { $('fileGallery').click(); });
  $('fileCamera').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('fileGallery').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('expenseForm').addEventListener('submit', submit);
  $('againBtn').addEventListener('click', resetForAnother);
  $('queueRetry').addEventListener('click', function () { if (!navigator.onLine) toast('Aún no hay cobertura'); state.offline = false; retryFailed(''); });
  $('queueForce').addEventListener('click', function () {
    qAll().then(function (items) { return Promise.all(items.filter(function (i) { return i.dupe; }).map(function (i) { delete i.failedMsg; i.forceSend = true; return qPut(i); })); }).then(function () { if (navigator.onLine) flushQueue(); else renderQueue(); });
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
