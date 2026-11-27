/* Pantalla de administración · Gastos SCOTT-ISB 2027.
   La clave se comprueba en el servidor (Apps Script); aquí no hay claves ni datos. Con ?mock=1 funciona con datos de ejemplo. */
(function () {
  'use strict';
  var CFG = window.CONFIG || {}, MOCK = /[?&]mock=1/.test(location.search);
  var $ = function (id) { return document.getElementById(id); };
  var state = { key: '', rep: null, tab: 'rev', idle: null, hist: null, hshown: 40, fopen: {}, rf: null, hf: null };
  state.rf = newF(); state.hf = newF();
  var QUARTERS = ['2026-T4', '2027-T1', '2027-T2', '2027-T3', '2027-T4', '2028-T1'];

  /** Escapa texto para meterlo en HTML o dentro de atributos (value="...", data-*="..."). */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  /** Importe escrito a mano -> número. «1.500» = 1500; «1.500,25» = 1500,25; «12,5» = 12,5; «1.5» = 1,5. Vacío = 0; no válido = NaN. */
  function num(v) {
    v = String(v == null ? '' : v).trim().replace(/[\s€]/g, ''); if (!v) return 0;
    var neg = /^[-−]/.test(v); v = v.replace(/^[-−+]/, '');
    var c = v.lastIndexOf(','), d = v.lastIndexOf('.');
    if (c > -1 && d > -1) v = c > d ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
    else if (c > -1) v = (v.match(/,/g).length > 1 && /^[1-9]\d{0,2}(,\d{3})+$/.test(v)) ? v.replace(/,/g, '') : v.replace(',', '.');
    else if (d > -1 && /^[1-9]\d{0,2}(\.\d{3})+$/.test(v)) v = v.replace(/\./g, '');
    if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return NaN;
    return neg ? -Number(v) : Number(v);
  }
  function fmtS(n) { n = Number(n) || 0; return (n > 0 ? '+' : '') + fmt(n); }
  /** «2027-01-20 10:15» -> «20/01». */
  function ddmm(s) { s = String(s || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(8, 10) + '/' + s.slice(5, 7) : ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function fmt(n) { return Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toast(m) { var t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 5000); }
  function busy(on, txt) { $('busy').hidden = !on; if (txt) $('busyText').textContent = txt; }
  function today() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function files(s) { return String(s || '').split('\n').filter(function (u) { return /^https:\/\/drive\.google\.com\//.test(u); }); }

  /* ---------- API ---------- */
  function api(body) {
    if (MOCK) return mockApi(body);
    body.adminKey = state.key;
    if (CFG.env) body.env = CFG.env;
    return fetch(CFG.backendUrl, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'Sin conexión con el servidor. Inténtalo de nuevo.' }; });
  }

  /* ---------- sesión ---------- */
  function touch() { clearTimeout(state.idle); state.idle = setTimeout(function () { logout('Sesión cerrada por inactividad.'); }, 20 * 60 * 1000); }
  function logout(msg) {
    state.key = ''; state.rep = null; state.hist = null; state.rf = newF(); state.hf = newF(); closeFix(); try { sessionStorage.removeItem('ga.k'); localStorage.removeItem('ga.k'); } catch (e) {}
    var aik = $('aiKey'); if (aik) aik.value = '';
    $('appView').hidden = true; $('tabs').hidden = true; $('logout').hidden = true; $('loginView').hidden = false; $('key').value = '';
    if (msg) { $('loginError').textContent = msg; $('loginError').hidden = false; }
  }
  function login(k, remember, silent) {
    state.key = k; busy(true, 'Comprobando…');
    return api({ action: 'adminReport' }).then(function (res) {
      busy(false);
      if (!res || !res.ok) { state.key = ''; if (!silent) { $('loginError').textContent = (res && res.error) || 'Clave incorrecta'; $('loginError').hidden = false; } return false; }
      try { (remember ? localStorage : sessionStorage).setItem('ga.k', k); } catch (e) {}
      state.rep = res; $('loginView').hidden = true; $('appView').hidden = false; $('tabs').hidden = false; $('logout').hidden = false; $('loginError').hidden = true;
      touch(); renderAll(); return true;
    });
  }
  function reload(msg) {
    busy(true, 'Actualizando…');
    return api({ action: 'adminReport' }).then(function (res) { busy(false); if (res && res.ok) { state.rep = res; renderAll(); if (msg) toast(msg); } else toast((res && res.error) || 'No se pudo actualizar'); });
  }
  function selectTab(t) {
    state.tab = t; ['rev', 'liq', 'his', 'imp', 'mas'].forEach(function (x) { $('tab-' + x).hidden = x !== t; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.dataset.tab === t); });
    window.scrollTo(0, 0); touch();
    if (t === 'his') loadHist();
  }

  /* ---------- filtros (los comparten Revisar e Histórico) ---------- */
  var FKEYS = ['person', 'event', 'status', 'q', 'from', 'to', 'min', 'max'];
  function newF() { return { person: '', event: '', status: '', q: '', from: '', to: '', min: '', max: '' }; }
  function fnum(s) { if (String(s == null ? '' : s).trim() === '') return null; var n = num(s); return isNaN(n) ? null : n; }
  function fOpts(o, cur, all) { return '<option value="">' + all + '</option>' + Object.keys(o).sort().map(function (k) { return '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(k) + ' (' + o[k] + ')</option>'; }).join(''); }
  function filtMatch(f, x) {
    var mn = fnum(f.min), mx = fnum(f.max), a = Number(x.amount) || 0, q = String(f.q || '').toLowerCase();
    return (!f.person || x.person === f.person) && (!f.event || x.event === f.event) && (!f.from || String(x.date) >= f.from) && (!f.to || String(x.date) <= f.to)
      && (mn === null || a >= mn) && (mx === null || a <= mx)
      && (!q || (String(x.supplier || '') + ' ' + String(x.concept || '') + ' ' + String(x.docNumber || '')).toLowerCase().indexOf(q) >= 0);
  }
  function filtSummary(p, f) {
    var act = FKEYS.filter(function (k) { return f[k]; }).length, s = $(p + 'Box') && $(p + 'Box').querySelector('summary');
    if (s) s.innerHTML = 'Filtrar gastos' + (act ? ' · <b>' + act + ' activo' + (act > 1 ? 's' : '') + '</b>' : '');
  }
  /** p = prefijo de ids ('rf' Revisar, 'hf' Histórico); hist = añade estado y búsqueda de texto. */
  function filtHtml(p, f, list, hist) {
    var persons = {}, events = {};
    list.forEach(function (x) { persons[x.person] = (persons[x.person] || 0) + 1; events[x.event] = (events[x.event] || 0) + 1; });
    if (f.person && !persons[f.person]) f.person = '';
    if (f.event && !events[f.event]) f.event = '';
    var act = FKEYS.filter(function (k) { return f[k]; }).length;
    var sts = [['', 'Vigentes'], ['Pendiente', 'Por liquidar'], ['Liquidado', 'Liquidado'], ['No aplica', 'Sin liquidar'], ['Anulado', 'Anulado']];
    return '<details class="rf" id="' + p + 'Box"' + (state.fopen[p] || act ? ' open' : '') + '><summary>Filtrar gastos' + (act ? ' · <b>' + act + ' activo' + (act > 1 ? 's' : '') + '</b>' : '') + '</summary><div class="rfh"><button id="' + p + 'Clear" class="abtn link" type="button">Quitar filtros</button></div>'
      + '<div class="row"><label>Persona<select id="' + p + 'Person">' + fOpts(persons, f.person, 'Todas') + '</select></label><label>Evento<select id="' + p + 'Event">' + fOpts(events, f.event, 'Todos') + '</select></label></div>'
      + (hist ? '<div class="row"><label>Estado<select id="' + p + 'Status">' + sts.map(function (s) { return '<option value="' + s[0] + '"' + (f.status === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select></label><label>Buscar<input id="' + p + 'Q" type="text" placeholder="proveedor o nº" value="' + esc(f.q) + '"></label></div>' : '')
      + '<div class="row"><label>Fecha desde<input id="' + p + 'From" type="date" value="' + esc(f.from) + '"></label><label>Fecha hasta<input id="' + p + 'To" type="date" value="' + esc(f.to) + '"></label></div>'
      + '<div class="row"><label>Importe desde (€)<input id="' + p + 'Min" type="text" inputmode="decimal" placeholder="0" value="' + esc(f.min) + '"></label><label>Importe hasta (€)<input id="' + p + 'Max" type="text" inputmode="decimal" placeholder="sin límite" value="' + esc(f.max) + '"></label></div></details>';
  }
  function filtBind(p, f, draw, again) {
    [['Person', 'person'], ['Event', 'event'], ['Status', 'status'], ['Q', 'q'], ['From', 'from'], ['To', 'to'], ['Min', 'min'], ['Max', 'max']].forEach(function (k) {
      var el = $(p + k[0]); if (!el) return;
      var h = function () { f[k[1]] = el.value.trim(); filtSummary(p, f); draw(); };
      el.addEventListener('input', h); el.addEventListener('change', h);
    });
    var bx = $(p + 'Box'); if (bx) bx.addEventListener('toggle', function () { state.fopen[p] = bx.open; });
    var clr = $(p + 'Clear'); if (clr) clr.addEventListener('click', function () { var o = newF(); FKEYS.forEach(function (k) { f[k] = o[k]; }); again(); });
  }

  /* ---------- pestaña Revisar ---------- */
  function renderRev() {
    var r = state.rep, list = r.porRevisar || [], html = '';
    var inc = []; (r.pending || []).forEach(function (p) { p.items.forEach(function (i) { if (i.review === 'Incidencia') inc.push(Object.assign({ person: p.person }, i)); }); });
    $('nRev').textContent = list.length ? '(' + list.length + ')' : '';
    html += hoyHtml(list, inc.length);
    if (list.length > 1) html += filtHtml('rf', state.rf, list, false);
    html += '<div id="rfList"></div>';
    if (inc.length) {
      html += '<div class="sec"><span>Con incidencia</span></div>';
      inc.forEach(function (o) {
        html += '<div class="acard" data-id="' + esc(o.id) + '"><div class="top1"><div><div class="ttl">' + esc(o.supplier || o.concept) + ' <span class="pill inc">Incidencia</span></div><div class="sub2">' + esc(o.person) + ' · ' + esc(o.date) + '</div><div class="sub2">' + esc(String(o.reviewNote || '')) + '</div></div><div class="amt">' + fmt(o.amount) + ' €</div></div>'
          + '<div class="acts"><button class="abtn go" data-act="ap" type="button">Aprobar ya resuelto</button><button class="abtn link" data-act="fix" type="button">Corregir</button></div></div>';
      });
    }
    $('tab-rev').innerHTML = html;
    filtBind('rf', state.rf, drawRevList, renderRev);
    drawRevList();
    Array.prototype.forEach.call($('tab-rev').querySelectorAll('.acard[data-id]'), function (c) { if (c.closest('#rfList')) return; bindCard(c); });
  }
  /** Dinero listo para liquidar (gastos revisados, neto) de una persona de «pending». */
  function readyOf(p) { return Math.round(p.items.filter(function (i) { return i.review === 'Revisado'; }).reduce(function (a, i) { return a + (Number(i.net) || 0); }, 0) * 100) / 100; }
  function daysText(n) { n = Number(n); return n === 0 ? 'hoy' : (n === 1 ? 'mañana' : (n > 1 ? 'en ' + n + ' días' : 'vencido hace ' + Math.abs(n) + (Math.abs(n) === 1 ? ' día' : ' días'))); }
  /** Tarjeta «Hoy» (resumen) y avisos ámbar del servidor. */
  function hoyHtml(list, nInc) {
    var r = state.rep, tot = list.reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0), ready = 0, people = 0, nd = r.nextDeadline, h;
    (r.pending || []).forEach(function (p) { var v = readyOf(p); if (v > 0) { ready += v; people++; } });
    h = '<div class="acard hoy"><div class="hhd">Hoy</div>'
      + '<div class="hrow"><span>Por revisar</span><b>' + (list.length ? list.length + ' (' + fmt(tot) + ' €)' : 'nada') + '</b></div>'
      + '<div class="hrow"><span>Con incidencia</span><b>' + nInc + '</b></div>'
      + '<div class="hrow"><span>Listo para liquidar</span><b>' + (people ? fmt(ready) + ' € (de ' + plural(people, 'persona', 'personas') + ')' : '0,00 €') + '</b></div>'
      + (nd && nd.title ? '<div class="hrow plazo"><span>Próximo plazo: <b>' + esc(nd.title) + '</b>' + (ddmm(nd.date) ? ' · ' + esc(ddmm(nd.date)) : '') + (nd.days != null ? ' (' + esc(daysText(nd.days)) + ')' : '') + '</span></div>' : '')
      + '</div>';
    (r.warnings || []).forEach(function (w) { h += '<div class="note warn">' + esc(w) + '</div>'; });
    var ai = r.ai; /* la IA es opcional: sin clave no se dice nada */
    if (ai && ai.hasKey && ai.enabled && Number(ai.dailyMax) > 0 && Number(ai.usedToday) >= 0.8 * Number(ai.dailyMax)) h += '<div class="note warn">Hoy llevas ' + esc(Number(ai.usedToday)) + ' de ' + esc(Number(ai.dailyMax)) + ' lecturas automáticas</div>';
    return h;
  }
  function revFiltered() { return (state.rep.porRevisar || []).filter(function (x) { return filtMatch(state.rf, x); }); }
  function drawRevList() {
    var all = state.rep.porRevisar || [], list = revFiltered(), html = '';
    var filtered = list.length !== all.length, tot = list.reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0);
    var pp = state.rf.person && (state.rep.pending || []).filter(function (p) { return p.person === state.rf.person; })[0], pready = pp ? readyOf(pp) : 0;
    if (pready > 0) html += '<div class="note strip"><span>' + esc(state.rf.person) + ': <b>' + fmt(pready) + ' €</b> listos para liquidar</span><button id="goLiq" class="abtn go" type="button">Ir a liquidar</button></div>';
    html += '<div class="sec"><span>' + (filtered ? 'Por revisar · ' + list.length + ' de ' + all.length : 'Por revisar') + '</span>' + (list.length > 1 ? '<button class="abtn go" id="apAll" type="button">Aprobar ' + (filtered ? 'estos ' : 'los ') + list.length + '</button>' : '') + '</div>';
    if (filtered && list.length) html += '<p class="muted small rfsum">' + list.length + ' gastos · ' + fmt(tot) + ' €</p>';
    if (!all.length) html += '<p class="empty">No hay gastos por revisar.</p>';
    else if (!list.length) html += '<p class="empty">Ningún gasto cumple los filtros. Prueba a quitar alguno.</p>';
    list.forEach(function (x) {
      var fl = files(x.files);
      html += '<div class="acard" data-id="' + esc(x.id) + '"><div class="top1"><div><div class="ttl">' + esc(x.supplier || x.concept) + '</div><div class="sub2">' + esc(x.person) + ' · ' + esc(x.date) + ' · ' + esc(x.event) + '</div><div class="sub2">' + esc(x.concept) + ' · ' + esc(x.docType || '') + (x.docNumber ? ' nº ' + esc(x.docNumber) : '') + '</div></div><div class="amt">' + fmt(x.amount) + ' €</div></div>'
        + '<div class="acts">' + fl.map(function (u, k) { return '<a class="abtn link" target="_blank" rel="noopener" href="' + esc(u) + '">Ver justificante' + (fl.length > 1 ? ' ' + (k + 1) : '') + '</a>'; }).join('')
        + '<button class="abtn go" data-act="ap" type="button">Aprobar</button><button class="abtn wr" data-act="inc" type="button">Incidencia</button><button class="abtn link" data-act="fix" type="button">Corregir</button></div>'
        + '<div class="inl" hidden><input type="text" placeholder="¿Qué pasa? (ej. falta el NIF)"><button class="abtn wr" data-act="incsave" type="button">Guardar</button></div></div>';
    });
    $('rfList').innerHTML = html;
    var gl = $('goLiq'); if (gl) gl.addEventListener('click', function () { goLiquidar(state.rf.person); });
    var btn = $('apAll'); if (btn) btn.addEventListener('click', function () {
      var what = filtered ? 'los ' + list.length + ' gastos filtrados (' + fmt(tot) + ' €)' : 'los ' + list.length + ' gastos (' + fmt(tot) + ' €)';
      if (window.confirm('¿Aprobar ' + what + '? Hazlo solo si has mirado los justificantes.')) review(list.map(function (x) { return x.id; }), 'Revisado', '');
    });
    Array.prototype.forEach.call($('rfList').querySelectorAll('.acard'), bindCard);
  }
  function goLiquidar(person) {
    selectTab('liq');
    var c = Array.prototype.filter.call($('tab-liq').querySelectorAll('.acard[data-p]'), function (x) { return x.dataset.p === person; })[0];
    if (c) { c.scrollIntoView({ block: 'start' }); c.classList.add('flash'); setTimeout(function () { c.classList.remove('flash'); }, 2500); }
  }
  function bindCard(c) {
    var id = c.dataset.id, inl = c.querySelector('.inl');
    Array.prototype.forEach.call(c.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.act;
        if (a === 'ap') review([id], 'Revisado', '');
        else if (a === 'fix') { var it = findItem(id); if (it) openFix(it); }
        else if (a === 'void') { var iv = findItem(id); if (iv) voidDlg(iv); }
        else if (a === 'unliq') { var iu = findItem(id); if (iu) unliqDlg(iu); }
        else if (a === 'inc') { inl.hidden = !inl.hidden; if (!inl.hidden) inl.querySelector('input').focus(); }
        else if (a === 'incsave') { var n = inl.querySelector('input').value.trim(); if (!n) { toast('Escribe qué pasa con el gasto.'); return; } review([id], 'Incidencia', n); }
      });
    });
  }
  /** Busca un gasto por id en lo que ya está cargado (por revisar, pendientes con incidencia, histórico). */
  function findItem(id) {
    var r = state.rep, hit = (r.porRevisar || []).filter(function (x) { return x.id === id; })[0];
    if (!hit) (r.pending || []).forEach(function (p) { p.items.forEach(function (i) { if (i.id === id) hit = Object.assign({ person: p.person }, i); }); });
    if (!hit && state.hist) hit = state.hist.items.filter(function (x) { return x.id === id; })[0];
    return hit || null;
  }

  /* ---------- corregir un gasto (el original queda anulado con el motivo; se crea otro con los datos corregidos) ---------- */
  function openFix(it) {
    var m = state.rep.meta;
    if (!m) { toast('Falta la versión nueva del servidor para corregir gastos.'); return; }
    var sel = function (id, opts, cur, blank) { return '<select id="' + id + '">' + (blank ? '<option value="">' + blank + '</option>' : '') + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>'; };
    var varios = String(it.ivaRate) === 'Varios', honor = it.concept === m.honorarios;
    var ivaSel = varios ? '<div class="muted small" style="margin:0">Varios tipos de IVA: se conservan. Si cambias el importe, el desglose dejará de cuadrar y habrá que repetirlo.</div>'
      : '<label>IVA' + sel('fxIva', [['21', '21 %'], ['10', '10 %'], ['4', '4 %'], ['0', '0 %']], String(it.ivaRate), String(it.ivaRate) === '' ? 'Elegir…' : '') + '</label>';
    var h = '<p class="muted small" style="margin:0 0 8px"><b>' + esc(it.supplier || it.concept) + '</b> · ' + esc(it.person) + ' · ' + fmt(it.amount) + ' €</p>'
      + '<div class="frm"><label>Evento' + sel('fxEv', m.events.map(function (e) { return [e.id, e.label]; }), it.eventId, it.eventId ? '' : 'Elegir…') + '</label>'
      + '<label>Concepto' + sel('fxCon', m.concepts.map(function (c) { return [c, c]; }), it.concept) + '</label>'
      + '<div class="row"><label>Fecha<input id="fxDate" type="date" value="' + esc(it.date) + '"></label><label>Importe (€)<input id="fxAmt" type="text" inputmode="decimal" value="' + esc(String(it.amount).replace('.', ',')) + '"></label></div>'
      + '<div class="row"><label>Proveedor<input id="fxSup" type="text" value="' + esc(it.supplier) + '"></label><label>Nº documento<input id="fxNum" type="text" value="' + esc(it.docNumber) + '"></label></div>'
      + '<div class="row"><label>NIF del emisor<input id="fxNif" type="text" value="' + esc(it.nif) + '"></label>' + ivaSel + '</div>'
      + '<label>Tipo de documento' + sel('fxDt', m.docTypes.map(function (d) { return [d, d]; }), it.docType) + '</label>'
      + '<label>Factura a nombre del club' + sel('fxClub', [['Sí', 'Sí'], ['No', 'No']], it.inClub) + '</label>'
      + '<label id="fxIrW"' + (honor ? '' : ' hidden') + '>Retención IRPF (%)<input id="fxIr" type="text" inputmode="decimal" value="' + esc(String(it.irpfRate || 0).replace('.', ',')) + '"></label>'
      + '<label>Notas<input id="fxNotes" type="text" value="' + esc(it.notes) + '"></label>'
      + '<label>Motivo de la corrección (obligatorio)<input id="fxWhy" type="text" placeholder="ej. importe mal leído"></label></div>'
      + '<p class="muted small">El gasto original queda anulado, con tu motivo, y se crea uno nuevo con estos datos y los mismos justificantes. El nuevo vuelve a quedar <b>por revisar</b>. Todo queda anotado en la pestaña «Cambios».</p>'
      + '<div class="acts"><button id="fxSave" class="abtn go" type="button">Guardar corrección</button><button id="fxCancel" class="abtn link" type="button">Cancelar</button></div><div id="fxMsg" class="msg"></div>';
    $('fixTitle').textContent = 'Corregir gasto';
    $('fixBody').innerHTML = h; $('fix').hidden = false; document.body.classList.add('modal'); $('fix').scrollTop = 0; touch();
    $('fxCon').addEventListener('change', function () { $('fxIrW').hidden = $('fxCon').value !== m.honorarios; });
    $('fxCancel').addEventListener('click', closeFix);
    $('fxSave').addEventListener('click', function () {
      var ch = {}, was = function (k, now, before) { if (String(now) !== String(before)) ch[k] = now; };
      var amt = num($('fxAmt').value); if (isNaN(amt) || amt <= 0) { msg('fxMsg', 'Escribe un importe válido.', false); return; }
      var why = $('fxWhy').value.trim(); if (!why) { msg('fxMsg', 'Escribe el motivo de la corrección.', false); return; }
      was('eventId', $('fxEv').value, it.eventId); was('concept', $('fxCon').value, it.concept); was('date', $('fxDate').value, it.date);
      if (Math.abs(amt - Number(it.amount)) > 0.004) ch.amount = amt;
      was('supplier', $('fxSup').value.trim(), it.supplier); was('docNumber', $('fxNum').value.trim(), it.docNumber); was('nif', $('fxNif').value.trim(), it.nif); was('docType', $('fxDt').value, it.docType);
      if (!varios) { if (!$('fxIva').value) { msg('fxMsg', 'Elige el tipo de IVA.', false); return; } was('ivaRate', $('fxIva').value, String(it.ivaRate)); }
      was('inClub', $('fxClub').value, it.inClub); was('notes', $('fxNotes').value.trim(), it.notes);
      if ($('fxCon').value === m.honorarios) { var ir = num($('fxIr').value); if (isNaN(ir)) { msg('fxMsg', 'Escribe la retención de IRPF (0 si no lleva).', false); return; } if (Math.abs(ir - Number(it.irpfRate || 0)) > 0.004) ch.irpfRate = ir; }
      if (!Object.keys(ch).length) { msg('fxMsg', 'No has cambiado nada.', false); return; }
      busy(true, 'Corrigiendo…'); touch();
      api({ action: 'adminCorrect', id: it.id, changes: ch, reason: why }).then(function (res) {
        busy(false);
        if (!res || !res.ok) { msg('fxMsg', srvErr(res, 'No se pudo corregir'), false); return; }
        closeFix(); state.hist = null; reload('Corregido. El gasto nuevo ha quedado por revisar.');
      });
    });
  }
  /** Cuadro propio (sin window.prompt) que pide un motivo y lo envía al servidor. o: {title, intro (HTML ya escapado), label, ph, ok, call(motivo)->cuerpo, after(res, motivo)}. */
  function openReason(o) {
    $('fixTitle').textContent = o.title;
    $('fixBody').innerHTML = o.intro + '<div class="frm"><label>' + esc(o.label || 'Motivo (obligatorio)') + '<input id="rsWhy" type="text" maxlength="200" placeholder="' + esc(o.ph || '') + '"></label></div>'
      + '<div class="acts"><button id="rsOk" class="abtn wr" type="button">' + esc(o.ok) + '</button><button id="rsCancel" class="abtn link" type="button">Cancelar</button></div><div id="rsMsg" class="msg"></div>';
    $('fix').hidden = false; document.body.classList.add('modal'); $('fix').scrollTop = 0; touch();
    $('rsCancel').addEventListener('click', closeFix);
    $('rsOk').addEventListener('click', function () {
      var why = $('rsWhy').value.trim(); if (!why) { msg('rsMsg', 'Escribe el motivo.', false); return; }
      busy(true, 'Guardando…'); touch();
      api(o.call(why)).then(function (res) {
        busy(false);
        if (!res || !res.ok) { msg('rsMsg', srvErr(res, 'No se pudo guardar'), false); return; }
        closeFix(); o.after(res, why);
      });
    });
  }
  function itemLine(it) { return '<p class="muted small" style="margin:0 0 8px"><b>' + esc(it.supplier || it.concept) + '</b> · ' + esc(it.person) + ' · ' + esc(it.date) + ' · ' + fmt(it.amount) + ' €</p>'; }
  function voidDlg(it) {
    openReason({ title: 'Anular gasto', ok: 'Sí, anular el gasto', ph: 'ej. duplicado, no es del equipo',
      intro: itemLine(it) + '<p class="muted small">El gasto queda <b>anulado</b>: deja de contar en liquidaciones e impuestos. No se borra; queda anotado con tu motivo en la pestaña «Cambios».</p>',
      call: function (why) { return { action: 'adminVoid', id: it.id, reason: why }; },
      after: function () { state.hist = null; reload('Gasto anulado.'); } });
  }
  function unliqDlg(it) {
    openReason({ title: 'Deshacer liquidación', ok: 'Sí, deshacer la liquidación', ph: 'ej. la transferencia no se hizo',
      intro: itemLine(it) + '<p class="muted small">El gasto vuelve a quedar <b>«Pendiente»</b> (por liquidar) y la reversión se anota en la pestaña «Cambios». Esto <b>no devuelve dinero</b>: solo corrige el registro. Hazlo solo si el pago no se hizo o estaba mal.</p>',
      call: function (why) { return { action: 'unliquidate', person: it.person, ids: [it.id], reason: why }; },
      after: function () { state.hist = null; reload('Liquidación deshecha: el gasto vuelve a estar pendiente.'); } });
  }
  function closeFix() { $('fix').hidden = true; document.body.classList.remove('modal'); }
  function srvErr(res, def) { var e = res && res.error; return e === 'Clave incorrecta' ? 'Esta función aún no está en el servidor (falta desplegar la versión nueva).' : (e || def); }

  /* ---------- pestaña Histórico ---------- */
  function loadHist(force) {
    if (state.hist && !force) { renderHis(); return; }
    $('tab-his').innerHTML = '<p class="empty">Cargando el histórico…</p>';
    api({ action: 'adminHistory' }).then(function (res) {
      if (!res || !res.ok) { $('tab-his').innerHTML = '<p class="empty">' + esc(srvErr(res, 'No se pudo cargar el histórico')) + '</p><button id="hisRetry" class="btn" type="button">Reintentar</button>'; $('hisRetry').addEventListener('click', function () { loadHist(true); }); return; }
      state.hist = res; renderHis();
    });
  }
  function renderHis() {
    var h = state.hist, f = state.hf;
    $('tab-his').innerHTML = filtHtml('hf', f, h.items, true) + '<div id="hfList"></div>';
    filtBind('hf', f, function () { state.hshown = 40; drawHis(); }, renderHis);
    drawHis();
  }
  function drawHis() {
    var f = state.hf, list = state.hist.items.filter(function (x) { return filtMatch(f, x) && (f.status ? x.status === f.status : x.status !== 'Anulado'); });
    var shown = list.slice(0, state.hshown), tot = list.reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0), html = '';
    html += '<div class="sec"><span>' + list.length + ' gasto' + (list.length === 1 ? '' : 's') + '</span><span>' + fmt(tot) + ' €</span></div>';
    if (state.hist.total > state.hist.items.length) html += '<p class="muted small rfsum">Se cargan los ' + state.hist.items.length + ' más recientes de ' + state.hist.total + '.</p>';
    if (!list.length) html += '<p class="empty">Ningún gasto cumple los filtros.</p>';
    shown.forEach(function (x) {
      var cls = x.status === 'Liquidado' ? 'rev' : (x.status === 'Anulado' ? 'inc' : ''), lab = x.status === 'Pendiente' ? 'Por liquidar' : (x.status === 'No aplica' ? 'Sin liquidar' : x.status);
      var rv = x.status === 'Anulado' ? '' : (x.review ? ' <span class="pill ' + (x.review === 'Revisado' ? 'rev' : 'inc') + '">' + esc(x.review) + '</span>' : ' <span class="pill">Por revisar</span>');
      var fl = files(x.files), canFix = x.status !== 'Liquidado' && x.status !== 'Anulado', canUnliq = x.status === 'Liquidado';
      var auto = String(x.reviewNote || '').indexOf('Auto') >= 0 && x.status !== 'Anulado' ? ' <span class="pill auto">Auto</span>' : '';
      html += '<div class="acard" data-id="' + esc(x.id) + '"><div class="top1"><div><div class="ttl">' + esc(x.supplier || x.concept) + '</div><div class="sub2">' + esc(x.person) + ' · ' + esc(x.date) + ' · ' + esc(x.event) + '</div><div class="sub2">' + esc(x.concept) + ' · ' + esc(x.docType || '') + (x.docNumber ? ' nº ' + esc(x.docNumber) : '') + '</div>'
        + '<div class="sub2"><span class="pill ' + cls + '">' + esc(lab) + '</span>' + (x.status === 'Liquidado' && x.paidOn ? ' ' + esc(x.paidOn) : '') + rv + auto + '</div>'
        + (x.status === 'Anulado' && x.voidNote ? '<div class="sub2">' + esc(x.voidNote) + '</div>' : '') + (x.review === 'Incidencia' && x.reviewNote ? '<div class="sub2">' + esc(x.reviewNote) + '</div>' : '') + '</div><div class="amt">' + fmt(x.amount) + ' €</div></div>'
        + ((fl.length || canFix || canUnliq) ? '<div class="acts">' + fl.map(function (u, k) { return '<a class="abtn link" target="_blank" rel="noopener" href="' + esc(u) + '">Ver justificante' + (fl.length > 1 ? ' ' + (k + 1) : '') + '</a>'; }).join('') + (canFix ? '<button class="abtn link" data-act="fix" type="button">Corregir</button><button class="abtn wr" data-act="void" type="button">Anular</button>' : '') + (canUnliq ? '<button class="abtn wr" data-act="unliq" type="button">Deshacer liquidación</button>' : '') + '</div>' : '') + '</div>';
    });
    if (list.length > shown.length) html += '<button id="hisMore" class="btn" type="button">Mostrar más (' + (list.length - shown.length) + ')</button>';
    $('hfList').innerHTML = html;
    var more = $('hisMore'); if (more) more.addEventListener('click', function () { state.hshown += 40; drawHis(); });
    Array.prototype.forEach.call($('hfList').querySelectorAll('.acard'), bindCard);
  }
  function review(ids, status, note) {
    busy(true, 'Guardando…'); touch();
    api({ action: 'adminReview', ids: ids, status: status, note: note }).then(function (res) {
      busy(false); if (!res || !res.ok) { toast((res && res.error) || 'No se pudo guardar'); return; }
      var n = res.n != null ? Number(res.n) : ids.length, nf = res.noEncontrados, nfn = Array.isArray(nf) ? nf.length : (Number(nf) || 0);
      var m = n === 0 ? 'No se ha cambiado ningún gasto' : (status === 'Revisado' ? (n === 1 ? '1 gasto aprobado' : n + ' gastos aprobados') : (n === 1 ? 'Incidencia anotada en 1 gasto' : 'Incidencia anotada en ' + n + ' gastos'));
      if (nfn) m += ' · ' + (nfn === 1 ? '1 no se ha encontrado' : nfn + ' no se han encontrado');
      reload(m);
    });
  }

  /* ---------- pestaña Liquidar ---------- */
  function copyText(t) {
    function legacy() {
      var ta = document.createElement('textarea'), ok = false; ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.select(); try { ta.setSelectionRange(0, t.length); ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta); return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return legacy(); });
    return Promise.resolve(legacy());
  }
  function renderLiq() {
    var r = state.rep, html = '', trf = (r.pending || []).filter(function (p) { return readyOf(p) > 0; });
    html += '<div class="sec"><span>Pendiente de liquidar</span>' + (trf.length ? '<button id="copyTr" class="abtn link" type="button">Copiar lista de transferencias</button>' : '') + '</div>';
    if (!(r.pending || []).length) html += '<p class="empty">No hay nada pendiente de liquidar.</p>';
    (r.pending || []).forEach(function (p) {
      var ok = p.items.filter(function (i) { return i.review === 'Revisado'; }), okTot = ok.reduce(function (a, i) { return a + (Number(i.net) || 0); }, 0), sin = p.items.length - ok.length;
      html += '<div class="acard" data-p="' + esc(p.person) + '"><div class="top1"><div><div class="ttl">' + esc(p.person) + '</div><div class="sub2">' + p.items.length + ' gasto(s) pendiente(s) · total ' + fmt(p.total) + ' €</div></div><div class="amt">' + fmt(okTot) + ' €</div></div>';
      html += '<div style="margin-top:6px">' + p.items.map(function (i) { var cls = i.review === 'Revisado' ? 'rev' : (i.review === 'Incidencia' ? 'inc' : ''); return '<div class="qrow"><span>' + esc(i.supplier || i.concept) + ' <span class="hd">' + esc(i.date) + '</span></span><span class="pill ' + cls + '">' + esc(i.review || 'Por revisar') + '</span><span class="n">' + fmt(i.net) + ' €</span></div>'; }).join('') + '</div>';
      html += '<div class="sub2" style="margin-top:6px">' + (sin ? sin + ' sin revisar: no se incluyen en la transferencia.' : 'Todo revisado.') + '</div>';
      html += '<div class="acts"><button class="abtn go" data-act="liq" type="button"' + (okTot > 0 ? '' : ' disabled') + '>Liquidar lo revisado (' + fmt(okTot) + ' €)</button></div>'
        + '<div class="inl" hidden><input type="text" placeholder="Nota (ej. transferencia 27/11)" value="transferencia ' + today().slice(8, 10) + '/' + today().slice(5, 7) + '"><button class="abtn go" data-act="liqgo" type="button">Confirmar</button></div></div>';
    });
    $('tab-liq').innerHTML = html;
    var ct = $('copyTr'); if (ct) ct.addEventListener('click', function () {
      var d = today(), lines = trf.map(function (p) { return p.person + ' · ' + fmt(readyOf(p)) + ' € · transferencia ' + d.slice(8, 10) + '/' + d.slice(5, 7); }), text = lines.join('\n');
      touch();
      copyText(text).then(function (ok) { toast(ok ? 'Copiada la lista: ' + plural(lines.length, 'transferencia', 'transferencias') + '. Pégala donde la necesites.' : 'No se pudo copiar. Hazlo a mano o prueba con otro navegador.'); });
    });
    Array.prototype.forEach.call($('tab-liq').querySelectorAll('.acard'), function (c) {
      var person = c.dataset.p, p = (state.rep.pending || []).filter(function (x) { return x.person === person; })[0], inl = c.querySelector('.inl');
      var ok = p.items.filter(function (i) { return i.review === 'Revisado'; }), okTot = Math.round(ok.reduce(function (a, i) { return a + (Number(i.net) || 0); }, 0) * 100) / 100;
      c.querySelector('[data-act="liq"]').addEventListener('click', function () { inl.hidden = !inl.hidden; });
      c.querySelector('[data-act="liqgo"]').addEventListener('click', function () {
        var note = inl.querySelector('input').value.trim();
        if (!window.confirm('Vas a marcar como liquidados ' + ok.length + ' gasto(s) de ' + person + ' por ' + fmt(okTot) + ' €. Esto no mueve dinero: solo lo anota. ¿Seguro?')) return;
        busy(true, 'Liquidando…'); touch();
        api({ action: 'liquidate', person: person, ids: ok.map(function (i) { return i.id; }), expectedTotal: okTot, note: note }).then(function (res) { busy(false); if (!res || !res.ok) { toast((res && res.error) || 'No se pudo liquidar'); return; } reload('Liquidado: ' + fmt(res.total) + ' € de ' + person); });
      });
    });
  }

  /* ---------- pestaña Impuestos ---------- */
  function renderImp() {
    var r = state.rep, t = r.impuestos || [], html = '';
    html += '<div class="sec"><span>IVA e IRPF por trimestre</span></div>';
    var cy = r.ivaCarry;
    html += '<div class="acard"><div class="top1"><div><div class="ttl">Saldo de IVA a favor de 2026' + (cy ? ' <span class="pill ' + (cy.status === 'definitivo' ? 'rev' : 'pend') + '">' + (cy.status === 'definitivo' ? 'Definitivo' : 'Provisional') + '</span>' : '') + '</div>'
      + '<div class="sub2">' + (cy ? 'A compensar en 2027' + (ddmm(cy.at) ? ' · anotado el ' + esc(ddmm(cy.at)) : '') : 'Todavía no hay saldo anotado.') + '</div>' + (cy && cy.note ? '<div class="sub2">' + esc(cy.note) + '</div>' : '') + '</div>'
      + '<div class="amt">' + (cy ? fmt(cy.amount) + ' €' : '—') + '</div></div>'
      + '<details class="more2" style="margin:10px 0 0"><summary>Cambiar el saldo</summary><div class="frm"><div class="row"><input id="cAmt" type="text" inputmode="decimal" placeholder="Importe (€)" value="' + (cy ? esc(String(cy.amount).replace('.', ',')) : '') + '"><select id="cSt"><option value="provisional"' + (cy && cy.status === 'definitivo' ? '' : ' selected') + '>Provisional</option><option value="definitivo"' + (cy && cy.status === 'definitivo' ? ' selected' : '') + '>Definitivo</option></select></div>'
      + '<input id="cNote" type="text" placeholder="Nota (ej. según el modelo 303 del 4T)"><p class="muted small" style="margin:0">«Provisional» si la cifra aún puede cambiar; «Definitivo» si ya está presentada.</p><button id="cGo" class="abtn go" type="button">Guardar saldo</button><div id="cMsg" class="msg"></div></div></details></div>';
    t.forEach(function (x) {
      var mov = x.facturasEmitidas || x.ivaSop || x.irpf || x.ivaPaid || x.irpfPaid;
      if (!mov && !x.closed) return;
      var lt = x.late || {}, late = x.closed && (Number(lt.ivaRep) || Number(lt.ivaSop) || Number(lt.irpf));
      html += '<div class="acard"><div class="top1"><div class="ttl">' + esc(x.quarter) + (x.closed ? ' <span class="pill rev">Cerrado ' + esc(ddmm(x.closed)) + '</span>' : '') + '</div><div class="amt">IVA a ingresar ' + fmt(x.ivaToPay) + ' €</div></div>'
        + '<div class="qrow"><span>IVA repercutido / soportado</span><span class="n">' + fmt(x.ivaRep) + ' €</span><span class="n">' + fmt(x.ivaSop) + ' €</span></div>'
        + '<div class="qrow"><span>Saldo a compensar (anterior → siguiente)</span><span class="n">' + fmt(x.carryIn) + ' €</span><span class="n">' + fmt(x.carryOut) + ' €</span></div>'
        + '<div class="qrow"><span>IVA ingresado / pendiente</span><span class="n">' + fmt(x.ivaPaid) + ' €</span><span class="n">' + fmt(x.ivaPending) + ' €</span></div>'
        + '<div class="qrow"><span>IRPF retenido / ingresado / pendiente</span><span class="n">' + fmt(x.irpf) + ' € · ' + fmt(x.irpfPaid) + ' €</span><span class="n">' + fmt(x.irpfPending) + ' €</span></div>'
        + (late ? '<div class="note warn">Cambios posteriores al cierre: IVA soportado ' + fmtS(lt.ivaSop) + ' €, repercutido ' + fmtS(lt.ivaRep) + ' €, IRPF ' + fmtS(lt.irpf) + ' €</div>' : '')
        + '<div class="acts">' + (x.closed ? '<button class="abtn link" data-act="reopenq" data-q="' + esc(x.quarter) + '" type="button">Reabrir</button>' : '<button class="abtn link" data-act="closeq" data-q="' + esc(x.quarter) + '" type="button">Cerrar trimestre</button>') + '</div></div>';
    });
    if (!t.some(function (x) { return x.facturasEmitidas || x.ivaSop || x.irpf || x.ivaPaid || x.irpfPaid || x.closed; })) html += '<p class="empty">Todavía no hay movimientos de IVA o IRPF en 2027.</p>';
    if (r.impuestos2026T4) html += '<p class="muted small">2026-T4 (se declara con el Excel de 2026): IVA soportado deducible registrado aquí ' + fmt(r.impuestos2026T4.ivaSop) + ' €, IRPF retenido ' + fmt(r.impuestos2026T4.irpf) + ' €.</p>';
    var qopts = QUARTERS.slice(1).map(function (q) { return '<option>' + q + '</option>'; }).join(''), allq = QUARTERS.map(function (q) { return '<option>' + q + '</option>'; }).join('');
    html += '<details class="more2"><summary>Anotar un pago de impuestos</summary><div class="frm"><div class="row"><select id="pTax"><option>IVA</option><option>IRPF</option></select><select id="pQ">' + qopts + '</select></div>'
      + '<div class="row"><input id="pAmt" type="text" inputmode="decimal" placeholder="Importe (€)"><input id="pDate" type="date" value="' + today() + '"></div><input id="pNote" type="text" placeholder="Nota (ej. 303 del 1T)"><button id="pGo" class="abtn go" type="button">Anotar pago</button><div id="pMsg" class="msg"></div></div></details>';
    html += '<details class="more2"><summary>Registrar factura emitida</summary><div class="frm"><div class="row"><input id="eDate" type="date" value="' + today() + '"><input id="eNum" type="text" placeholder="Nº factura"></div>'
      + '<input id="eCli" type="text" placeholder="Cliente"><div class="row"><input id="eNif" type="text" placeholder="NIF/CIF del cliente"><select id="eRate"><option value="21">IVA 21 %</option><option value="10">10 %</option><option value="4">4 %</option><option value="0">0 %</option></select></div>'
      + '<input id="eBase" type="text" inputmode="decimal" placeholder="Base imponible (€)"><input id="eNote" type="text" placeholder="Notas (opcional)"><input id="eFile" type="file" accept="application/pdf,image/*"><label class="check"><input id="eCredit" type="checkbox"> Es un abono (importe en negativo)</label><button id="eGo" class="abtn go" type="button">Registrar factura</button><div id="eMsg" class="msg"></div></div></details>';
    html += '<details class="more2"><summary>Exportar para la gestoría</summary><div class="frm"><div class="row"><select id="xFrom">' + allq + '</select><select id="xTo">' + allq + '</select></div><button id="xGo" class="abtn go" type="button">Crear hoja de exportación</button><div id="xMsg" class="msg"></div></div></details>';
    html += '<div class="sec"><span>Facturas emitidas recientes</span></div>';
    var em = r.emitidas || []; html += em.length ? em.map(function (e) { return '<div class="acard"><div class="top1"><div><div class="ttl">' + esc(e.client) + '</div><div class="sub2">nº ' + esc(e.number) + ' · ' + esc(e.date) + ' · ' + esc(e.quarter) + '</div></div><div class="amt">' + fmt(e.total) + ' €</div></div><div class="acts"><button class="abtn wr" data-act="ivoid" data-id="' + esc(e.id) + '" type="button">Anular</button></div></div>'; }).join('') : '<p class="empty">Aún no hay facturas emitidas de 2027.</p>';
    html += '<div class="sec"><span>Pagos de impuestos anotados</span></div>';
    var pg = r.pagos || []; html += pg.length ? pg.map(function (e) { return '<div class="acard"><div class="top1"><div><div class="ttl">' + esc(e.tax) + ' ' + esc(e.quarter) + '</div><div class="sub2">' + esc(e.date) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div><div class="amt">' + fmt(e.amount) + ' €</div></div></div>'; }).join('') : '<p class="empty">Aún no hay pagos anotados.</p>';
    $('tab-imp').innerHTML = html;
    wireImp();
  }
  function msg(id, text, ok) { var m = $(id); m.textContent = text; m.className = 'msg ' + (ok ? 'good' : 'bad'); }
  /** Cierra un trimestre: pide confirmación; si el servidor dice que hay bloqueos, los enseña y ofrece «Cerrar igualmente». */
  function closeQuarter(q, force) {
    if (!force && !window.confirm('¿Cerrar el trimestre ' + q + '? Se guardan las cifras de IVA e IRPF de hoy y, si después cambia algo, te lo avisaremos aquí. Puedes reabrirlo cuando quieras.')) return;
    busy(true, 'Cerrando…'); touch();
    api({ action: 'adminCloseQuarter', quarter: q, force: force === true }).then(function (res) {
      busy(false);
      if (res && res.ok) {
        closeFix();
        var w = (res.checks || []).filter(function (c) { return c.n > 0; }).map(function (c) { return c.label + ' (' + c.n + ')'; });
        reload('Trimestre ' + q + ' cerrado' + (w.length ? '. Avisos: ' + w.join(', ') : '') + '.'); return;
      }
      if (res && res.blockers) { blockersDlg(q, res.checks || []); return; }
      toast(srvErr(res, 'No se pudo cerrar el trimestre'));
    });
  }
  function blockersDlg(q, checks) {
    var bad = checks.filter(function (c) { return c.n > 0; });
    $('fixTitle').textContent = 'No se puede cerrar ' + q + ' todavía';
    $('fixBody').innerHTML = '<p class="muted small" style="margin:0 0 8px">Esto está pendiente en el trimestre:</p><ul class="blk">' + bad.map(function (c) { return '<li><span>' + esc(c.label) + '</span><b>' + esc(c.n) + '</b>' + (c.blocks ? '<span class="pill inc">Bloquea</span>' : '<span class="pill pend">Aviso</span>') + '</li>'; }).join('') + '</ul>'
      + '<p class="muted small">Lo mejor es resolverlo y volver a intentarlo. Si aun así quieres cerrarlo, queda anotado que se cerró con avisos.</p>'
      + '<div class="acts"><button id="blkForce" class="abtn wr" type="button">Cerrar igualmente</button><button id="blkCancel" class="abtn link" type="button">Cancelar</button></div>';
    $('fix').hidden = false; document.body.classList.add('modal'); $('fix').scrollTop = 0;
    $('blkCancel').addEventListener('click', closeFix);
    $('blkForce').addEventListener('click', function () {
      if (!window.confirm('Vas a cerrar ' + q + ' con ' + bad.filter(function (c) { return c.blocks; }).length + ' bloqueo(s) sin resolver. ¿Cerrarlo igualmente?')) return;
      closeFix(); closeQuarter(q, true);
    });
  }
  function wireImp() {
    function sendPago(force) {
      var a = num($('pAmt').value); if (isNaN(a) || a === 0) { msg('pMsg', 'Escribe el importe.', false); return; }
      busy(true, 'Anotando…'); touch();
      api({ action: 'adminTaxPaid', tax: $('pTax').value, quarter: $('pQ').value, amount: a, date: $('pDate').value, note: $('pNote').value.trim(), force: force === true }).then(function (res) {
        busy(false);
        if (res && res.duplicate) { if (window.confirm(res.message + '\n\n¿Anotarlo igualmente?')) sendPago(true); return; }
        if (!res || !res.ok) { msg('pMsg', (res && res.error) || 'No se pudo anotar', false); return; }
        reload('Pago anotado');
      });
    }
    $('pGo').addEventListener('click', function () { sendPago(false); });
    $('cGo').addEventListener('click', function () {
      var a = num($('cAmt').value), st = $('cSt').value, from = (state.rep.ivaCarry && state.rep.ivaCarry.from) || '2026-T4';
      if ($('cAmt').value.trim() === '' || isNaN(a) || a < 0) { msg('cMsg', 'Escribe el importe del saldo (0 si no hay).', false); return; }
      if (!window.confirm('¿Cambiar el saldo de IVA a favor de 2026 a ' + fmt(a) + ' € (' + st + ')? Se recalculan los trimestres de 2027 y el cambio queda anotado.')) return;
      busy(true, 'Guardando…'); touch();
      api({ action: 'adminSetCarry', amount: a, status: st, note: $('cNote').value.trim(), from: from }).then(function (res) {
        busy(false);
        if (!res || !res.ok) { msg('cMsg', srvErr(res, 'No se pudo guardar el saldo'), false); return; }
        reload('Saldo de IVA guardado: ' + fmt(a) + ' € (' + st + ')');
      });
    });
    Array.prototype.forEach.call($('tab-imp').querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.act, q = b.dataset.q;
        if (a === 'closeq') closeQuarter(q, false);
        else if (a === 'reopenq') openReason({ title: 'Reabrir ' + q, ok: 'Sí, reabrir el trimestre', ph: 'ej. falta una factura por apuntar',
          intro: '<p class="muted small" style="margin:0 0 8px">El trimestre <b>' + esc(q) + '</b> vuelve a quedar abierto y dejará de mostrarse como cerrado. Si ya presentaste los impuestos, avisa a la gestoría. El motivo queda anotado.</p>',
          call: function (why) { return { action: 'adminReopenQuarter', quarter: q, reason: why }; }, after: function () { reload('Trimestre ' + q + ' reabierto.'); } });
        else if (a === 'ivoid') {
          var e = (state.rep.emitidas || []).filter(function (x) { return String(x.id) === b.dataset.id; })[0]; if (!e) return;
          openReason({ title: 'Anular factura emitida', ok: 'Sí, anular la factura', ph: 'ej. emitida por error',
            intro: '<p class="muted small" style="margin:0 0 8px"><b>' + esc(e.client) + '</b> · nº ' + esc(e.number) + ' · ' + esc(e.date) + ' · ' + fmt(e.total) + ' €</p><p class="muted small">La factura queda <b>anulada</b> y deja de contar en el IVA repercutido de ' + esc(e.quarter) + '. No se borra; queda anotada con tu motivo.</p>',
            call: function (why) { return { action: 'adminIssuedVoid', id: e.id, reason: why }; }, after: function () { reload('Factura anulada.'); } });
        }
      });
    });
    $('eGo').addEventListener('click', function () {
      var base = num($('eBase').value); if (isNaN(base) || base <= 0) { msg('eMsg', 'Escribe la base imponible.', false); return; }
      var f = $('eFile').files[0], data = { date: $('eDate').value, number: $('eNum').value.trim(), client: $('eCli').value.trim(), nif: $('eNif').value.trim(), base: base, ivaRate: $('eRate').value, notes: $('eNote').value.trim(), credit: $('eCredit').checked };
      function send(filesArr, force) {
        busy(true, 'Registrando…'); touch();
        api({ action: 'adminIssuedAdd', data: data, files: filesArr, force: force === true }).then(function (res) {
          busy(false);
          if (res && res.duplicate) { if (window.confirm(res.message + '\n\n¿Registrarla igualmente?')) send(filesArr, true); return; }
          if (!res || !res.ok) { msg('eMsg', (res && res.error) || 'No se pudo registrar', false); return; }
          reload('Factura registrada: IVA ' + fmt(res.iva) + ' € en ' + res.quarter);
        });
      }
      if (!f) { send([]); return; }
      if (f.size > 10 * 1024 * 1024) { msg('eMsg', 'El archivo pesa más de 10 MB.', false); return; }
      var fr = new FileReader(); fr.onload = function () { send([{ name: f.name, mime: f.type, base64: String(fr.result).split(',')[1] }]); }; fr.readAsDataURL(f);
    });
    $('xGo').addEventListener('click', function () {
      busy(true, 'Creando la hoja…'); touch();
      api({ action: 'adminExport', from: $('xFrom').value, to: $('xTo').value }).then(function (res) {
        busy(false);
        if (!res || !res.ok) { msg('xMsg', (res && res.error) || 'No se pudo exportar', false); return; }
        $('xMsg').className = 'msg good'; $('xMsg').innerHTML = 'Hecho: ' + esc(res.recibidas) + ' recibidas y ' + esc(res.emitidas) + ' emitidas. <a target="_blank" rel="noopener" style="color:var(--brand-light)" href="' + esc(res.url) + '">Abrir la hoja</a>';
      });
    });
  }

  /* ---------- pestaña Más ---------- */
  /* Aprobación automática (apagada por defecto): solo tickets pequeños de conceptos rutinarios. */
  var AUTO_EXCL = ['Honorarios profesionales', 'Media/Filmaker', 'Social media'];
  function autoConcepts() { return ((state.rep.meta && state.rep.meta.concepts) || []).filter(function (c) { return AUTO_EXCL.indexOf(c) < 0; }); }
  function autoHtml() {
    var a = state.rep.autoApprove || { enabled: false, maxAmount: 30, concepts: [], sampleEvery: 5 }, cs = autoConcepts();
    return '<div class="sec"><span>Aprobación automática</span><span id="aaState" class="pill ' + (a.enabled ? 'rev' : '') + '">' + (a.enabled ? 'Activada' : 'Apagada') + '</span></div>'
      + '<div class="acard"><p class="muted small" style="margin:0 0 8px">Solo para <b>tickets pequeños</b> de los conceptos que marques. Se anotan como «Revisado · Auto». Aun así, <b>1 de cada N</b> se deja para revisión manual. Puedes apagarla cuando quieras.</p>'
      + (state.rep.autoApprove ? '' : '<p class="muted small" style="margin:0 0 8px">Esta función necesita la versión nueva del servidor.</p>')
      + '<label class="check" style="margin-top:0"><input id="aaOn" type="checkbox"' + (a.enabled ? ' checked' : '') + '> Aprobar automáticamente</label>'
      + '<div class="frm"><div class="row"><label class="fl">Importe máximo (€)<input id="aaMax" type="text" inputmode="decimal" value="' + esc(String(a.maxAmount).replace('.', ',')) + '"></label><label class="fl">Revisar a mano 1 de cada…<input id="aaN" type="text" inputmode="numeric" value="' + esc(a.sampleEvery) + '"></label></div>'
      + '<div class="fl">Conceptos que se aprueban solos</div><div class="aaList">' + cs.map(function (c, i) { return '<label class="check"><input type="checkbox" data-aac="' + esc(c) + '"' + ((a.concepts || []).indexOf(c) >= 0 ? ' checked' : '') + '> ' + esc(c) + '</label>'; }).join('') + '</div>'
      + '<button id="aaSave" class="abtn go" type="button">Guardar</button><div id="aaMsg" class="msg"></div></div></div>';
  }
  function wireAuto() {
    $('aaSave').addEventListener('click', function () {
      var was = state.rep.autoApprove && state.rep.autoApprove.enabled, on = $('aaOn').checked, mx = num($('aaMax').value), n = num($('aaN').value);
      var cs = Array.prototype.filter.call($('tab-mas').querySelectorAll('[data-aac]'), function (i) { return i.checked; }).map(function (i) { return i.dataset.aac; });
      if ($('aaMax').value.trim() === '' || isNaN(mx) || mx <= 0 || mx > 200) { msg('aaMsg', 'El importe máximo debe estar entre 0,01 y 200 €.', false); return; }
      if (isNaN(n) || n !== Math.floor(n) || n < 2 || n > 50) { msg('aaMsg', 'Revisar a mano 1 de cada…: escribe un número entero entre 2 y 50.', false); return; }
      if (on && !cs.length) { msg('aaMsg', 'Marca al menos un concepto.', false); return; }
      if (on && !was && !window.confirm('Vas a activar la aprobación automática: los tickets de hasta ' + fmt(mx) + ' € de los conceptos marcados se aprobarán solos (salvo 1 de cada ' + n + '). ¿Activarla?')) return;
      busy(true, 'Guardando…'); touch();
      api({ action: 'adminSetAutoApprove', enabled: on, maxAmount: mx, concepts: cs, sampleEvery: n }).then(function (res) {
        busy(false);
        if (!res || !res.ok) { msg('aaMsg', srvErr(res, 'No se pudo guardar'), false); return; }
        state.rep.autoApprove = res.autoApprove; var st = $('aaState'); st.textContent = res.autoApprove.enabled ? 'Activada' : 'Apagada'; st.className = 'pill' + (res.autoApprove.enabled ? ' rev' : '');
        msg('aaMsg', res.autoApprove.enabled ? 'Guardado. La aprobación automática está activada.' : 'Guardado. La aprobación automática está apagada.', true);
      });
    });
  }
  /* Lectura de papeles con IA: la clave se guarda solo en el servidor y nunca vuelve a la web. */
  function aiOf() { return Object.assign({ hasKey: false, enabled: false, model: '', dailyMax: 50, usedToday: 0 }, state.rep && state.rep.ai || {}); }
  /** Quita de un texto cualquier cosa que parezca una clave, por si el servidor la repitiera en un error. */
  function aiErr(res, def) { return String(srvErr(res, def)).replace(/sk-ant-\S*/gi, '…'); }
  function aiHtml() {
    return '<div class="sec"><span>Lectura de papeles con IA</span><span id="aiState" class="pill"></span></div>'
      + '<div class="acard"><div id="aiStat" class="sub2" style="margin:0 0 8px"></div>'
      + (state.rep.ai ? '' : '<p class="muted small" style="margin:0 0 8px">Esta función necesita la versión nueva del servidor.</p>')
      + '<p class="muted small" style="margin:0 0 8px">La foto del papel se envía a Anthropic para leerla y rellenar el formulario del equipo. Cuesta unos céntimos por papel. La clave se guarda solo en el servidor y no se vuelve a mostrar.</p>'
      + '<div class="frm"><label class="fl">Clave de la IA<input id="aiKey" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="sk-ant-…"></label>'
      + '<div class="acts" style="margin-top:0"><button id="aiKeySave" class="abtn go" type="button">Guardar clave</button></div><div id="aiKeyMsg" class="msg" style="margin-top:0"></div></div>'
      + '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--line)"><p id="aiNoKey" class="muted small" style="margin:0 0 8px" hidden>Primero guarda la clave de la IA para poder activar la lectura.</p>'
      + '<label class="check" style="margin-top:0"><input id="aiOn" type="checkbox"> Lectura automática</label>'
      + '<div class="frm"><label class="fl">Tope diario de lecturas<input id="aiMax" type="text" inputmode="numeric" autocomplete="off" placeholder="1 a 1000"></label>'
      + '<div class="acts" style="margin-top:0"><button id="aiCfgSave" class="abtn go" type="button">Guardar</button><button id="aiTest" class="abtn link" type="button">Probar conexión</button></div>'
      + '<div id="aiCfgMsg" class="msg" style="margin-top:0"></div><div id="aiTestMsg" class="msg" style="margin-top:0"></div></div></div></div>';
  }
  /** Pone al día estado, botones y bloqueos. fields = también reescribe el interruptor y el tope (no al guardar la clave, para no pisar lo que se esté editando). */
  function aiPaint(fields) {
    var a = aiOf(), st = $('aiState'), key = a.hasKey;
    st.textContent = !key ? 'Falta la clave' : (a.enabled ? 'Activada' : 'Apagada'); st.className = 'pill' + (!key ? ' pend' : (a.enabled ? ' rev' : ''));
    $('aiStat').textContent = (a.model ? 'Modelo: ' + a.model + ' · ' : '') + 'Hoy: ' + (Number(a.usedToday) || 0) + ' de ' + (Number(a.dailyMax) || 0) + ' lecturas';
    $('aiKeySave').textContent = key ? 'Cambiar clave' : 'Guardar clave';
    $('aiNoKey').hidden = key;
    ['aiOn', 'aiMax', 'aiCfgSave', 'aiTest'].forEach(function (id) { $(id).disabled = !key; });
    if (fields) { $('aiOn').checked = !!a.enabled && key; $('aiMax').value = String(a.dailyMax); }
  }
  function wireAi() {
    aiPaint(true);
    $('aiKeySave').addEventListener('click', function () {
      var inp = $('aiKey'), k = inp.value.trim();
      if (!k) { msg('aiKeyMsg', 'Pega la clave de la IA.', false); return; }
      if (!/^sk-ant-\S{12,}$/.test(k)) { msg('aiKeyMsg', 'La clave no parece válida: debe empezar por «sk-ant-» y no llevar espacios.', false); return; }
      var body = { action: 'adminSetAiKey', key: k }; k = '';
      busy(true, 'Guardando la clave…'); touch();
      api(body).then(function (res) {
        body.key = ''; busy(false);
        if (!res || !res.ok) { msg('aiKeyMsg', aiErr(res, 'No se pudo guardar la clave'), false); return; }
        inp.value = ''; state.rep.ai = res.ai || Object.assign({}, aiOf(), { hasKey: true });
        aiPaint(false); renderRev(); msg('aiKeyMsg', 'Clave guardada', true);
      });
    });
    $('aiCfgSave').addEventListener('click', function () {
      var raw = $('aiMax').value.trim(), on = $('aiOn').checked;
      if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 1000) { msg('aiCfgMsg', 'El tope diario debe ser un número entero entre 1 y 1000.', false); return; }
      busy(true, 'Guardando…'); touch();
      api({ action: 'adminAiConfig', enabled: on, dailyMax: Number(raw) }).then(function (res) {
        busy(false);
        if (!res || !res.ok) { msg('aiCfgMsg', aiErr(res, 'No se pudo guardar'), false); return; }
        state.rep.ai = res.ai || Object.assign({}, aiOf(), { enabled: on, dailyMax: Number(raw) });
        aiPaint(true); renderRev(); msg('aiCfgMsg', aiOf().enabled ? 'Guardado. La lectura automática está activada.' : 'Guardado. La lectura automática está apagada.', true);
      });
    });
    $('aiTest').addEventListener('click', function () {
      $('aiTestMsg').textContent = ''; busy(true, 'Probando la conexión…'); touch();
      api({ action: 'adminAiTest' }).then(function (res) {
        busy(false);
        if (!res || !res.ok) { msg('aiTestMsg', aiErr(res, 'No se pudo conectar con la IA'), false); return; }
        msg('aiTestMsg', 'Conectado · modelo ' + String(res.model || '—') + ' · ' + String(res.ms != null ? res.ms : '—') + ' ms', true);
      });
    });
  }
  function renderMas() {
    var r = state.rep, c = r.control || {}, team = r.team || [];
    $('tab-mas').innerHTML = '<div class="sec"><span>Estado del sistema</span></div>'
      + '<div class="acard"><div class="qrow"><span>Copia de seguridad</span><span class="n">' + esc(c.backup || '—') + '</span><span></span></div>'
      + '<div class="qrow"><span>Control de archivos</span><span class="n">' + esc(c.detail || '—') + '</span><span></span></div>'
      + '<div class="qrow"><span>Gastos en el registro</span><span class="n">' + esc(r.registroRows) + '</span><span></span></div>'
      + '<div class="qrow"><span>Último control</span><span class="n">' + esc(c.at || '—') + '</span><span></span></div></div>'
      + autoHtml()
      + '<div id="aiBox">' + aiHtml() + '</div>'
      + '<div class="sec"><span>Avisos y copias por correo</span></div>'
      + '<div class="acard"><p class="muted small" style="margin:0 0 8px"><b>Aviso de pendientes:</b> te llega los lunes si hay gastos por revisar, y cada 2 días si se acumulan 10 o más.<br><b>Copia por correo:</b> el día 1 de cada mes, con todos los datos en archivos que abre Excel. Guárdala en tu ordenador.</p>'
      + '<div class="acts"><button id="mDigest" class="abtn link" type="button">Enviarme ahora el aviso</button><button id="mBackup" class="abtn link" type="button">Enviarme ahora la copia</button></div><div id="mMsg" class="msg"></div></div>'
      + (team.length ? '<details class="more2"><summary>Correos del equipo (avisos de aprobado, incidencia y liquidado)</summary><div class="frm">'
        + '<p class="muted small" style="margin:0">Quien tenga correo recibe un aviso cuando apruebas o marcas una incidencia en sus gastos, y cuando se le liquida. Quien no lo tenga, no recibe nada. Los correos se guardan solo en el servidor, no en la web.</p>'
        + team.map(function (t) { return '<label class="tm">' + esc(t.name) + '<input type="text" inputmode="email" autocapitalize="off" data-tm="' + esc(t.name) + '" placeholder="correo (opcional)" value="' + esc(t.email) + '"></label>'; }).join('')
        + '<button id="tmSave" class="abtn go" type="button">Guardar correos</button><div id="tmMsg" class="msg"></div></div></details>' : '')
      + '<p class="muted small">La clave de esta pantalla se guarda solo en este navegador mientras la sesión está abierta (o en el dispositivo, si marcaste «recordar»). La sesión se cierra tras 20 minutos sin usarla.</p>'
      + '<button id="refresh" class="btn" type="button">Actualizar datos</button>';
    $('refresh').addEventListener('click', function () { state.hist = null; reload('Datos actualizados'); });
    wireAuto(); wireAi();
    function mail(btn, action, label) {
      $(btn).addEventListener('click', function () {
        busy(true, 'Enviando…'); touch();
        api({ action: action }).then(function (res) { busy(false); if (!res || !res.ok) { msg('mMsg', srvErr(res, 'No se pudo enviar'), false); return; } msg('mMsg', label + ' se ha enviado a tu correo.', true); });
      });
    }
    mail('mDigest', 'adminDigestTest', 'El aviso'); mail('mBackup', 'adminBackupMailNow', 'La copia');
    var tm = $('tmSave'); if (tm) tm.addEventListener('click', function () {
      var emails = {}; Array.prototype.forEach.call($('tab-mas').querySelectorAll('[data-tm]'), function (i) { emails[i.dataset.tm] = i.value.trim(); });
      busy(true, 'Guardando…'); touch();
      api({ action: 'adminSetTeamEmails', emails: emails }).then(function (res) { busy(false); if (!res || !res.ok) { msg('tmMsg', srvErr(res, 'No se pudo guardar'), false); return; } state.rep.team = res.team; msg('tmMsg', 'Guardado: ' + res.n + ' persona(s) con correo.', true); });
    });
  }
  function renderAll() { renderRev(); renderLiq(); renderImp(); renderMas(); if (state.tab === 'his') loadHist(); }

  /* ---------- servidor simulado (?mock=1) ---------- */
  var mock = null;
  function mockApi(b) {
    var LT = 'Leyenda de Tartessos · 21–24 ene', ME = 'Mediterranean Epic · 4 feb';
    var META = { concepts: ['Vuelos/Barco', 'Diésel', 'Peajes/Parking', 'Comida', 'Supermercado', 'Hotel/Apartamentos', 'Coche de alquiler', 'Material/Recambios', 'Inscripciones', 'Media/Filmaker', 'Licencias/Federación', 'Gestoría/Bancos', 'Social media', 'Extras', 'Otros', 'Honorarios profesionales'],
      events: [{ id: 'leyenda', label: LT }, { id: 'medepic', label: ME }, { id: 'abr', label: 'Andalucía Bike Race · 22–27 feb' }, { id: 'general', label: 'Gastos generales del equipo (sin evento)' }], docTypes: ['Factura completa', 'Ticket / factura simplificada'], honorarios: 'Honorarios profesionales' };
    function R(id, person, date, ev, concept, supplier, amount, status, review, extra) {
      var e = META.events.filter(function (x) { return x.label === ev; })[0];
      return Object.assign({ id: id, person: person, date: date, event: ev, eventId: e ? e.id : '', concept: concept, supplier: supplier, docType: 'Ticket / factura simplificada', docNumber: '', amount: amount, net: amount, status: status, review: review, reviewNote: '', files: '', nif: '', ivaRate: '21', inClub: 'No', irpfRate: 0, notes: '', paidOn: '', voidNote: '', origin: 'App' }, extra || {});
    }
    if (!mock) mock = { seq: 0, team: {}, rows: [
      R('A1', 'Alberto Barroso', '2026-11-11', ME, 'Hotel/Apartamentos', 'Hotel Sol', 186.16, 'Pendiente', '', { docType: 'Factura completa', docNumber: 'F-123', nif: 'B19790278', inClub: 'Sí', files: 'https://drive.google.com/file/d/x/view' }),
      R('A2', 'Luis Pérez', '2026-11-18', LT, 'Comida', 'Bar Pepe', 42.5, 'Pendiente', ''),
      R('A3', 'Alberto Barroso', '2026-11-20', LT, 'Diésel', 'Repsol', 58.3, 'Pendiente', ''),
      R('A4', 'Luis Pérez', '2026-11-25', ME, 'Material/Recambios', 'Bike Center', 312.9, 'Pendiente', '', { docType: 'Factura completa', docNumber: 'B-77', nif: 'B19790278', inClub: 'Sí' }),
      R('B1', 'Alberto Barroso', '2026-11-05', LT, 'Diésel', 'Repsol', 14, 'Pendiente', 'Revisado'),
      R('B2', 'Alberto Barroso', '2026-11-06', LT, 'Peajes/Parking', 'Parking Centro', 6.2, 'Pendiente', 'Revisado', { reviewNote: '2026-11-06 · Auto' }),
      R('I1', 'Alberto Barroso', '2026-11-15', ME, 'Material/Recambios', 'Decathlon', 89.9, 'Pendiente', 'Incidencia', { reviewNote: '2026-11-26 · falta el NIF' }),
      R('L1', 'Alberto Barroso', '2026-11-03', LT, 'Peajes/Parking', 'Autopista AP-7', 9.8, 'Liquidado', 'Revisado', { paidOn: '2026-11-20' }),
      R('L2', 'Luis Pérez', '2026-11-04', ME, 'Comida', 'Restaurante Mar', 27.5, 'Liquidado', 'Revisado', { paidOn: '2026-11-20' }),
      R('V1', 'Luis Pérez', '2026-11-06', ME, 'Comida', 'Restaurante Mar', 27.5, 'Anulado', 'Revisado', { voidNote: '2026-11-07 · duplicado' }),
      R('T1', 'Tarjeta empresa', '2026-11-08', 'Gastos generales del equipo (sin evento)', 'Gestoría/Bancos', 'Gestoría López', 121, 'No aplica', 'Revisado', { docType: 'Factura completa', docNumber: '88', nif: 'B19790278', inClub: 'Sí' })], paid: [],
      carry: { from: '2026-T4', amount: 334.27, status: 'provisional', note: 'Pendiente de presentar el 4T de 2026', at: '2026-11-20 10:00' },
      emitidas: [{ id: 'E1', date: '2027-01-15', number: '2027-001', client: 'Ayuntamiento de Morón', base: 800, iva: 168, total: 968, quarter: '2027-T1' }, { id: 'E2', date: '2027-04-10', number: '2027-002', client: 'Bicicletas Sol S.L.', base: 400, iva: 84, total: 484, quarter: '2027-T2' }],
      closed: { '2027-T1': { at: '2027-04-20 09:30' } },
      auto: { enabled: false, maxAmount: 30, concepts: ['Diésel', 'Peajes/Parking', 'Comida'], sampleEvery: 5 },
      ai: { hasKey: false, enabled: false, model: 'claude-haiku-4-5', dailyMax: 50, usedToday: 0 } }; /* la clave NUNCA se guarda aquí, solo si existe */
    var ok = function (o) { return Promise.resolve(Object.assign({ ok: true }, o)); }, bad = function (e) { return Promise.resolve({ ok: false, error: e }); };
    var rows = mock.rows, find = function (id) { return rows.filter(function (x) { return x.id === id; })[0]; };
    var stamp = function () { var d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString(); return d.slice(0, 10) + ' ' + d.slice(11, 16); };
    var QV = { '2027-T1': { late: { ivaRep: 0, ivaSop: 12.5, irpf: 0 } } };
    function qChecks(q) { // trimestre T2 de ejemplo = los gastos de la demo (con bloqueos); el resto, limpio
      var rr = q === '2027-T2' ? rows.filter(function (i) { return i.status !== 'Anulado'; }) : [];
      return [{ key: 'sinRevisar', label: 'Gastos por revisar', n: rr.filter(function (i) { return !i.review; }).length, blocks: true },
        { key: 'incidencias', label: 'Gastos con incidencia sin resolver', n: rr.filter(function (i) { return i.review === 'Incidencia'; }).length, blocks: true },
        { key: 'sinIva', label: 'Gastos sin tipo de IVA', n: 0, blocks: false }, { key: 'sinNif', label: 'Facturas completas sin NIF', n: 0, blocks: true },
        { key: 'noTermina', label: 'El trimestre aún no ha terminado', n: 1, blocks: false }];
    }
    if (b.action === 'adminReport') {
      var pend = {}, dl = new Date(Date.now() + 12 * 86400000), dls = new Date(dl.getTime() - dl.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
      rows.filter(function (i) { return i.status === 'Pendiente'; }).forEach(function (i) { var p = pend[i.person] = pend[i.person] || { person: i.person, total: 0, count: 0, items: [] }; p.items.push(Object.assign({}, i)); p.total += i.net; p.count++; });
      var emi = mock.emitidas.filter(function (e) { return !e.voided; }), isum = function (q, k) { return emi.filter(function (e) { return e.quarter === q; }).reduce(function (a, e) { return a + e[k]; }, 0); };
      var imp = [{ quarter: '2027-T1', ivaRep: isum('2027-T1', 'iva'), ivaSop: 61.2, irpf: 0, ivaPaid: 0, irpfPaid: 0, facturasEmitidas: emi.filter(function (e) { return e.quarter === '2027-T1'; }).length, carryIn: mock.carry ? mock.carry.amount : 0, carryOut: 334.27, ivaToPay: 0, ivaPending: 0, irpfPending: 0 },
        { quarter: '2027-T2', ivaRep: isum('2027-T2', 'iva'), ivaSop: 120, irpf: 40, ivaPaid: 0, irpfPaid: 0, facturasEmitidas: emi.filter(function (e) { return e.quarter === '2027-T2'; }).length, carryIn: 334.27, carryOut: 334.27, ivaToPay: 0, ivaPending: 0, irpfPending: 40 },
        { quarter: '2027-T3', ivaRep: 50, ivaSop: 10, irpf: 0, ivaPaid: 0, irpfPaid: 0, facturasEmitidas: 1, carryIn: 334.27, carryOut: 294.27, ivaToPay: 0, ivaPending: 0, irpfPending: 0 }];
      imp.forEach(function (x) { var c = mock.closed[x.quarter]; if (c) { x.closed = c.at; x.late = (QV[x.quarter] || { late: { ivaRep: 0, ivaSop: 0, irpf: 0 } }).late; } });
      return ok({ porRevisar: rows.filter(function (i) { return !i.review && i.status !== 'Anulado'; }).map(function (i) { return Object.assign({}, i); }), meta: META,
        team: ['José María Sánchez', 'Alberto Barroso', 'Luis Pérez Martínez', 'Diego del Valle'].map(function (n) { return { name: n, email: mock.team[n] || '' }; }),
        pending: Object.keys(pend).map(function (k) { return pend[k]; }), registroRows: rows.length, control: { backup: 'OK', detail: 'Todo correcto', at: '27/11/2026 3:50' },
        warnings: ['Hay 4 gastos con más de 7 días sin revisar.', 'El saldo de IVA a favor de 2026 sigue como provisional.'],
        nextDeadline: { date: dls, title: 'IVA e IRPF del 4T de 2026', days: 12 },
        autoApprove: Object.assign({}, mock.auto, { concepts: mock.auto.concepts.slice() }),
        ai: Object.assign({}, mock.ai, typeof window.__mockAiUsed === 'number' ? { usedToday: window.__mockAiUsed } : {}), /* demo: window.__mockAiUsed = N simula N lecturas hoy */
        ivaCarry: mock.carry ? Object.assign({}, mock.carry) : null,
        impuestos: imp, impuestos2026T4: { ivaSop: 261.89, irpf: 0 }, emitidas: emi.map(function (e) { return Object.assign({}, e); }), pagos: [] });
    }
    if (b.action === 'adminHistory') return ok({ total: rows.length, items: rows.slice().sort(function (a, c) { return a.date < c.date ? 1 : -1; }).map(function (i) { return Object.assign({}, i); }) });
    if (b.action === 'adminReview') {
      var nf = [], n = 0; b.ids.forEach(function (id) { var i = find(id); if (i) { i.review = b.status; i.reviewNote = b.note || ''; n++; } else nf.push(id); });
      return ok({ n: n, noEncontrados: nf });
    }
    if (b.action === 'liquidate') { b.ids.forEach(function (id) { var i = find(id); if (i) { i.status = 'Liquidado'; i.paidOn = today(); } }); return ok({ person: b.person, n: b.ids.length, total: b.expectedTotal }); }
    if (b.action === 'adminVoid') {
      var v = find(b.id); if (!v) return bad('No existe el gasto ' + b.id);
      if (!String(b.reason || '').trim()) return bad('Indica el motivo');
      if (v.status === 'Liquidado') return bad('Ya está liquidado: deshaz antes la liquidación (unliquidate)');
      if (v.status === 'Anulado') return bad('Ya estaba anulado');
      v.status = 'Anulado'; v.voidNote = today() + ' · ' + b.reason; return ok({ id: v.id });
    }
    if (b.action === 'unliquidate') {
      if (!String(b.reason || '').trim()) return bad('Indica el motivo');
      if (!b.ids || !b.ids.length) return bad('Faltan los ids');
      var tot = 0, k = 0, err = '';
      b.ids.forEach(function (id) { var i = find(id); if (!i) err = 'No se han encontrado todos los gastos'; else if (i.person !== b.person) err = 'El gasto ' + id + ' no es de ' + b.person; else if (i.status !== 'Liquidado') err = 'El gasto ' + id + ' no está liquidado (' + i.status + ')'; });
      if (err) return bad(err);
      b.ids.forEach(function (id) { var i = find(id); i.status = 'Pendiente'; i.paidOn = ''; k++; tot += i.net; });
      return ok({ person: b.person, n: k, total: Math.round(tot * 100) / 100 });
    }
    if (b.action === 'adminCorrect') {
      var o = find(b.id); if (!o) return bad('No existe el gasto ' + b.id);
      if (!String(b.reason || '').trim()) return bad('Indica el motivo de la corrección');
      if (o.status === 'Liquidado' || o.status === 'Anulado') return bad('Ya está liquidado o anulado');
      var ch = b.changes || {}, n2 = Object.assign({}, o, { id: 'C' + (++mock.seq), review: '', reviewNote: '', origin: 'Corrección', notes: ((o.notes ? o.notes + ' · ' : '') + 'Corrige a ' + o.id) });
      ['concept', 'date', 'amount', 'supplier', 'docNumber', 'nif', 'docType', 'ivaRate', 'inClub', 'irpfRate'].forEach(function (k) { if (ch[k] != null) n2[k] = ch[k]; });
      if (ch.notes != null) n2.notes = ch.notes;
      if (ch.eventId) { var e = META.events.filter(function (x) { return x.id === ch.eventId; })[0]; n2.eventId = ch.eventId; n2.event = e ? e.label : n2.event; }
      n2.net = n2.amount; o.status = 'Anulado'; o.voidNote = today() + ' · corregido por ' + n2.id + ' · ' + b.reason; rows.push(n2);
      return ok({ oldId: o.id, newId: n2.id });
    }
    if (b.action === 'adminSetCarry') {
      var am = Math.round(Number(b.amount) * 100) / 100;
      if (isNaN(am) || am < 0 || am > 1000000) return bad('Importe no válido');
      if (['provisional', 'definitivo'].indexOf(b.status) < 0) return bad('Estado: provisional o definitivo');
      mock.carry = { from: b.from || '2026-T4', amount: am, status: b.status, note: b.note || '', at: stamp() }; return ok({ carry: mock.carry });
    }
    if (b.action === 'adminIssuedVoid') {
      var em = mock.emitidas.filter(function (e) { return e.id === b.id; })[0];
      if (!b.id || !String(b.reason || '').trim()) return bad('Faltan el id y el motivo');
      if (!em || em.voided) return bad('No existe esa factura emitida');
      em.voided = true; return ok({ id: em.id });
    }
    if (b.action === 'adminCloseQuarter') {
      var q = String(b.quarter || ''); if (QUARTERS.indexOf(q) < 1) return bad('Trimestre no válido (de 2027-T1 en adelante)');
      if (mock.closed[q]) return bad('Ese trimestre ya está cerrado (' + mock.closed[q].at + ')');
      var cks = qChecks(q), blk = cks.filter(function (c) { return c.blocks && c.n > 0; });
      if (blk.length && !b.force) return Promise.resolve({ ok: false, error: 'No se puede cerrar: ' + blk.map(function (c) { return c.label + ' (' + c.n + ')'; }).join(', '), checks: cks, blockers: true });
      mock.closed[q] = { at: stamp() }; return ok({ quarter: q, snapshot: { ivaRep: 0, ivaSop: 0, irpf: 0, docs: 0, ivaToPay: 0 }, checks: cks });
    }
    if (b.action === 'adminReopenQuarter') {
      if (!String(b.reason || '').trim()) return bad('Indica el motivo');
      if (!mock.closed[b.quarter]) return bad('Ese trimestre no está cerrado');
      delete mock.closed[b.quarter]; return ok({ quarter: b.quarter });
    }
    if (b.action === 'adminSetAutoApprove') {
      var mx = Math.round(Number(b.maxAmount) * 100) / 100, ne = Math.floor(Number(b.sampleEvery)), cs = (b.concepts || []).filter(function (x) { return META.concepts.indexOf(x) >= 0 && ['Honorarios profesionales', 'Media/Filmaker', 'Social media'].indexOf(x) < 0; });
      if (!(mx > 0 && mx <= 200)) return bad('El importe máximo debe estar entre 0,01 y 200 €');
      if (!(ne >= 2 && ne <= 50)) return bad('La muestra debe ser 1 de cada 2 a 50');
      if (b.enabled === true && !cs.length) return bad('Elige al menos un concepto');
      mock.auto = { enabled: b.enabled === true, maxAmount: mx, concepts: cs, sampleEvery: ne }; return ok({ autoApprove: Object.assign({}, mock.auto) });
    }
    if (b.action === 'adminSetAiKey') {
      if (!/^sk-ant-[A-Za-z0-9_-]{12,}$/.test(String(b.key || '').trim())) return bad('La clave no tiene el formato esperado (empieza por «sk-ant-»).');
      mock.ai.hasKey = true; return ok({ ai: Object.assign({}, mock.ai) });
    }
    if (b.action === 'adminAiConfig') {
      var dm = Number(b.dailyMax);
      if (typeof b.enabled !== 'boolean') return bad('Indica si la lectura está activada o apagada');
      if (!(dm >= 1 && dm <= 1000 && dm === Math.floor(dm))) return bad('El tope diario debe ser un número entero entre 1 y 1000');
      if (b.enabled && !mock.ai.hasKey) return bad('Primero guarda la clave de la IA');
      mock.ai.enabled = b.enabled; mock.ai.dailyMax = dm; return ok({ ai: Object.assign({}, mock.ai) });
    }
    if (b.action === 'adminAiTest') {
      if (!mock.ai.hasKey) return bad('Falta la clave de la IA');
      if (window.__mockAiFail) return bad('La IA no ha respondido (error 401): revisa la clave');
      return ok({ model: mock.ai.model, ms: 840 });
    }
    if (b.action === 'adminSetTeamEmails') { Object.keys(b.emails || {}).forEach(function (k) { if (b.emails[k]) mock.team[k] = b.emails[k]; else delete mock.team[k]; }); return ok({ n: Object.keys(mock.team).length, team: Object.keys(b.emails || {}).map(function (k) { return { name: k, email: mock.team[k] || '' }; }) }); }
    if (b.action === 'adminDigestTest') return ok({ result: 'aviso enviado (' + rows.filter(function (i) { return !i.review && i.status !== 'Anulado'; }).length + ' pendientes)' });
    if (b.action === 'adminBackupMailNow') return ok({ result: 'enviada (8 pestañas)' });
    if (b.action === 'adminTaxPaid') return ok({});
    if (b.action === 'adminIssuedAdd') {
      var iva = Math.round(b.data.base * 21) / 100; mock.emitidas.push({ id: 'E' + (3 + mock.seq++), date: b.data.date, number: b.data.number, client: b.data.client, base: b.data.base, iva: iva, total: b.data.base + iva, quarter: '2027-T1' });
      return ok({ iva: iva, quarter: '2027-T1' });
    }
    if (b.action === 'adminExport') return ok({ url: '#', recibidas: 2, emitidas: 0 });
    return ok({});
  }

  /* ---------- arranque ---------- */
  $('loginBtn').addEventListener('click', function () { var k = $('key').value.trim(); if (!k) { $('loginError').textContent = 'Escribe la clave.'; $('loginError').hidden = false; return; } login(k, $('remember').checked, false); });
  $('key').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });
  $('logout').addEventListener('click', function () { logout(''); });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.addEventListener('click', function () { selectTab(b.dataset.tab); }); });
  var saved = ''; try { saved = sessionStorage.getItem('ga.k') || localStorage.getItem('ga.k') || ''; } catch (e) {}
  if (MOCK) login('demo', false, true); else if (saved) login(saved, !!(function () { try { return localStorage.getItem('ga.k'); } catch (e) { return ''; } })(), true);
})();
