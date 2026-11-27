/* Pantalla de administración · Gastos SCOTT-ISB 2027.
   La clave se comprueba en el servidor (Apps Script); aquí no hay claves ni datos. Con ?mock=1 funciona con datos de ejemplo. */
(function () {
  'use strict';
  var CFG = window.CONFIG || {}, MOCK = /[?&]mock=1/.test(location.search);
  var $ = function (id) { return document.getElementById(id); };
  var state = { key: '', rep: null, tab: 'rev', idle: null, rfOpen: false, rf: { person: '', event: '', from: '', to: '', min: '', max: '' } };
  var QUARTERS = ['2026-T4', '2027-T1', '2027-T2', '2027-T3', '2027-T4', '2028-T1'];

  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
  function fmt(n) { return Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toast(m) { var t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 5000); }
  function busy(on, txt) { $('busy').hidden = !on; if (txt) $('busyText').textContent = txt; }
  function today() { return new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function files(s) { return String(s || '').split('\n').filter(function (u) { return /^https:\/\/drive\.google\.com\//.test(u); }); }

  /* ---------- API ---------- */
  function api(body) {
    if (MOCK) return mockApi(body);
    body.adminKey = state.key;
    return fetch(CFG.backendUrl, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, error: 'Sin conexión con el servidor. Inténtalo de nuevo.' }; });
  }

  /* ---------- sesión ---------- */
  function touch() { clearTimeout(state.idle); state.idle = setTimeout(function () { logout('Sesión cerrada por inactividad.'); }, 20 * 60 * 1000); }
  function logout(msg) {
    state.key = ''; state.rep = null; try { sessionStorage.removeItem('ga.k'); localStorage.removeItem('ga.k'); } catch (e) {}
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
    state.tab = t; ['rev', 'liq', 'imp', 'mas'].forEach(function (x) { $('tab-' + x).hidden = x !== t; });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) { b.classList.toggle('active', b.dataset.tab === t); });
    window.scrollTo(0, 0); touch();
  }

  /* ---------- pestaña Revisar ---------- */
  function renderRev() {
    var r = state.rep, list = r.porRevisar || [], html = '';
    var inc = []; (r.pending || []).forEach(function (p) { p.items.forEach(function (i) { if (i.review === 'Incidencia') inc.push({ person: p.person, i: i }); }); });
    $('nRev').textContent = list.length ? '(' + list.length + ')' : '';
    var f = state.rf, persons = {}, events = {};
    list.forEach(function (x) { persons[x.person] = (persons[x.person] || 0) + 1; events[x.event] = (events[x.event] || 0) + 1; });
    if (f.person && !persons[f.person]) f.person = '';
    if (f.event && !events[f.event]) f.event = '';
    var opts = function (o, cur, all) { return '<option value="">' + all + '</option>' + Object.keys(o).sort().map(function (k) { return '<option value="' + esc(k) + '"' + (k === cur ? ' selected' : '') + '>' + esc(k) + ' (' + o[k] + ')</option>'; }).join(''); };
    var act = ['person', 'event', 'from', 'to', 'min', 'max'].filter(function (k) { return f[k]; }).length;
    if (list.length > 1) html += '<details class="rf" id="rfBox"' + (state.rfOpen || act ? ' open' : '') + '><summary>Filtrar gastos' + (act ? ' · <b>' + act + ' activo' + (act > 1 ? 's' : '') + '</b>' : '') + '</summary><div class="rfh"><span></span><button id="rfClear" class="abtn link" type="button">Quitar filtros</button></div>'
      + '<div class="row"><label>Persona<select id="rfPerson">' + opts(persons, f.person, 'Todas') + '</select></label><label>Evento<select id="rfEvent">' + opts(events, f.event, 'Todos') + '</select></label></div>'
      + '<div class="row"><label>Fecha desde<input id="rfFrom" type="date" value="' + esc(f.from) + '"></label><label>Fecha hasta<input id="rfTo" type="date" value="' + esc(f.to) + '"></label></div>'
      + '<div class="row"><label>Importe desde (€)<input id="rfMin" type="text" inputmode="decimal" placeholder="0" value="' + esc(f.min) + '"></label><label>Importe hasta (€)<input id="rfMax" type="text" inputmode="decimal" placeholder="sin límite" value="' + esc(f.max) + '"></label></div></details>';
    html += '<div id="rfList"></div>';
    if (inc.length) {
      html += '<div class="sec"><span>Con incidencia</span></div>';
      inc.forEach(function (o) {
        html += '<div class="acard" data-id="' + esc(o.i.id) + '"><div class="top1"><div><div class="ttl">' + esc(o.i.supplier || o.i.concept) + ' <span class="pill inc">Incidencia</span></div><div class="sub2">' + esc(o.person) + ' · ' + esc(o.i.date) + '</div><div class="sub2">' + esc(String(o.i.reviewNote || '')) + '</div></div><div class="amt">' + fmt(o.i.amount) + ' €</div></div>'
          + '<div class="acts"><button class="abtn go" data-act="ap" type="button">Aprobar ya resuelto</button></div></div>';
      });
    }
    $('tab-rev').innerHTML = html;
    var bind = function (id, key) { var el = $(id); if (!el) return; var h = function () { f[key] = el.value.trim(); drawRevList(); }; el.addEventListener('input', h); el.addEventListener('change', h); };
    bind('rfPerson', 'person'); bind('rfEvent', 'event'); bind('rfFrom', 'from'); bind('rfTo', 'to'); bind('rfMin', 'min'); bind('rfMax', 'max');
    var bx = $('rfBox'); if (bx) bx.addEventListener('toggle', function () { state.rfOpen = bx.open; });
    var clr = $('rfClear'); if (clr) clr.addEventListener('click', function () { state.rf = { person: '', event: '', from: '', to: '', min: '', max: '' }; renderRev(); });
    drawRevList();
    Array.prototype.forEach.call($('tab-rev').querySelectorAll('.acard[data-id]'), function (c) { if (c.closest('#rfList')) return; bindCard(c); });
  }
  function fnum(s) { var n = parseFloat(String(s).replace(',', '.')); return isNaN(n) ? null : n; }
  function revFiltered() {
    var f = state.rf, mn = fnum(f.min), mx = fnum(f.max);
    return (state.rep.porRevisar || []).filter(function (x) {
      var a = Number(x.amount) || 0;
      return (!f.person || x.person === f.person) && (!f.event || x.event === f.event) && (!f.from || String(x.date) >= f.from) && (!f.to || String(x.date) <= f.to)
        && (mn === null || a >= mn) && (mx === null || a <= mx);
    });
  }
  function drawRevList() {
    var all = state.rep.porRevisar || [], list = revFiltered(), f = state.rf, html = '';
    var filtered = list.length !== all.length, tot = list.reduce(function (a, x) { return a + (Number(x.amount) || 0); }, 0);
    html += '<div class="sec"><span>' + (filtered ? 'Por revisar · ' + list.length + ' de ' + all.length : 'Por revisar') + '</span>' + (list.length > 1 ? '<button class="abtn go" id="apAll" type="button">Aprobar ' + (filtered ? 'estos ' : 'los ') + list.length + '</button>' : '') + '</div>';
    if (filtered && list.length) html += '<p class="muted small rfsum">' + list.length + ' gastos · ' + fmt(tot) + ' €</p>';
    if (!all.length) html += '<p class="empty">No hay gastos por revisar.</p>';
    else if (!list.length) html += '<p class="empty">Ningún gasto cumple los filtros. Prueba a quitar alguno.</p>';
    list.forEach(function (x) {
      var fl = files(x.files);
      html += '<div class="acard" data-id="' + esc(x.id) + '"><div class="top1"><div><div class="ttl">' + esc(x.supplier || x.concept) + '</div><div class="sub2">' + esc(x.person) + ' · ' + esc(x.date) + ' · ' + esc(x.event) + '</div><div class="sub2">' + esc(x.concept) + ' · ' + esc(x.docType || '') + (x.docNumber ? ' nº ' + esc(x.docNumber) : '') + '</div></div><div class="amt">' + fmt(x.amount) + ' €</div></div>'
        + '<div class="acts">' + fl.map(function (u, k) { return '<a class="abtn link" target="_blank" rel="noopener" href="' + esc(u) + '">Ver justificante' + (fl.length > 1 ? ' ' + (k + 1) : '') + '</a>'; }).join('')
        + '<button class="abtn go" data-act="ap" type="button">Aprobar</button><button class="abtn wr" data-act="inc" type="button">Incidencia</button></div>'
        + '<div class="inl" hidden><input type="text" placeholder="¿Qué pasa? (ej. falta el NIF)"><button class="abtn wr" data-act="incsave" type="button">Guardar</button></div></div>';
    });
    $('rfList').innerHTML = html;
    var btn = $('apAll'); if (btn) btn.addEventListener('click', function () {
      var what = filtered ? 'los ' + list.length + ' gastos filtrados (' + fmt(tot) + ' €)' : 'los ' + list.length + ' gastos (' + fmt(tot) + ' €)';
      if (window.confirm('¿Aprobar ' + what + '? Hazlo solo si has mirado los justificantes.')) review(list.map(function (x) { return x.id; }), 'Revisado', '');
    });
    Array.prototype.forEach.call($('rfList').querySelectorAll('.acard'), bindCard);
  }
  function bindCard(c) {
    var id = c.dataset.id, inl = c.querySelector('.inl');
    Array.prototype.forEach.call(c.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var a = b.dataset.act;
        if (a === 'ap') review([id], 'Revisado', '');
        else if (a === 'inc') { inl.hidden = !inl.hidden; if (!inl.hidden) inl.querySelector('input').focus(); }
        else if (a === 'incsave') { var n = inl.querySelector('input').value.trim(); if (!n) { toast('Escribe qué pasa con el gasto.'); return; } review([id], 'Incidencia', n); }
      });
    });
  }
  function review(ids, status, note) {
    busy(true, 'Guardando…'); touch();
    api({ action: 'adminReview', ids: ids, status: status, note: note }).then(function (res) { busy(false); if (!res || !res.ok) { toast((res && res.error) || 'No se pudo guardar'); return; } reload(status === 'Revisado' ? ids.length + ' gasto(s) aprobado(s)' : 'Incidencia anotada'); });
  }

  /* ---------- pestaña Liquidar ---------- */
  function renderLiq() {
    var r = state.rep, html = '<div class="sec"><span>Pendiente de liquidar</span></div>';
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
    if (r.ivaCarry) html += '<p class="muted small">Saldo de IVA a favor de ' + esc(r.ivaCarry.from) + ' a compensar en 2027: <b>' + fmt(r.ivaCarry.amount) + ' €</b> (' + esc(r.ivaCarry.status) + ').</p>';
    t.forEach(function (x) {
      if (!x.facturasEmitidas && !x.ivaSop && !x.irpf && !x.ivaPaid && !x.irpfPaid) return;
      html += '<div class="acard"><div class="top1"><div class="ttl">' + esc(x.quarter) + '</div><div class="amt">IVA a ingresar ' + fmt(x.ivaToPay) + ' €</div></div>'
        + '<div class="qrow"><span>IVA repercutido / soportado</span><span class="n">' + fmt(x.ivaRep) + ' €</span><span class="n">' + fmt(x.ivaSop) + ' €</span></div>'
        + '<div class="qrow"><span>Saldo a compensar (anterior → siguiente)</span><span class="n">' + fmt(x.carryIn) + ' €</span><span class="n">' + fmt(x.carryOut) + ' €</span></div>'
        + '<div class="qrow"><span>IVA ingresado / pendiente</span><span class="n">' + fmt(x.ivaPaid) + ' €</span><span class="n">' + fmt(x.ivaPending) + ' €</span></div>'
        + '<div class="qrow"><span>IRPF retenido / ingresado / pendiente</span><span class="n">' + fmt(x.irpf) + ' € · ' + fmt(x.irpfPaid) + ' €</span><span class="n">' + fmt(x.irpfPending) + ' €</span></div></div>';
    });
    if (!t.some(function (x) { return x.facturasEmitidas || x.ivaSop || x.irpf || x.ivaPaid || x.irpfPaid; })) html += '<p class="empty">Todavía no hay movimientos de IVA o IRPF en 2027.</p>';
    if (r.impuestos2026T4) html += '<p class="muted small">2026-T4 (se declara con el Excel de 2026): IVA soportado deducible registrado aquí ' + fmt(r.impuestos2026T4.ivaSop) + ' €, IRPF retenido ' + fmt(r.impuestos2026T4.irpf) + ' €.</p>';
    var qopts = QUARTERS.slice(1).map(function (q) { return '<option>' + q + '</option>'; }).join(''), allq = QUARTERS.map(function (q) { return '<option>' + q + '</option>'; }).join('');
    html += '<details class="more2"><summary>Anotar un pago de impuestos</summary><div class="frm"><div class="row"><select id="pTax"><option>IVA</option><option>IRPF</option></select><select id="pQ">' + qopts + '</select></div>'
      + '<div class="row"><input id="pAmt" type="text" inputmode="decimal" placeholder="Importe (€)"><input id="pDate" type="date" value="' + today() + '"></div><input id="pNote" type="text" placeholder="Nota (ej. 303 del 1T)"><button id="pGo" class="abtn go" type="button">Anotar pago</button><div id="pMsg" class="msg"></div></div></details>';
    html += '<details class="more2"><summary>Registrar factura emitida</summary><div class="frm"><div class="row"><input id="eDate" type="date" value="' + today() + '"><input id="eNum" type="text" placeholder="Nº factura"></div>'
      + '<input id="eCli" type="text" placeholder="Cliente"><div class="row"><input id="eNif" type="text" placeholder="NIF/CIF del cliente"><select id="eRate"><option value="21">IVA 21 %</option><option value="10">10 %</option><option value="4">4 %</option><option value="0">0 %</option></select></div>'
      + '<input id="eBase" type="text" inputmode="decimal" placeholder="Base imponible (€)"><input id="eNote" type="text" placeholder="Notas (opcional)"><input id="eFile" type="file" accept="application/pdf,image/*"><label class="check"><input id="eCredit" type="checkbox"> Es un abono (importe en negativo)</label><button id="eGo" class="abtn go" type="button">Registrar factura</button><div id="eMsg" class="msg"></div></div></details>';
    html += '<details class="more2"><summary>Exportar para la gestoría</summary><div class="frm"><div class="row"><select id="xFrom">' + allq + '</select><select id="xTo">' + allq + '</select></div><button id="xGo" class="abtn go" type="button">Crear hoja de exportación</button><div id="xMsg" class="msg"></div></div></details>';
    html += '<div class="sec"><span>Facturas emitidas recientes</span></div>';
    var em = r.emitidas || []; html += em.length ? em.map(function (e) { return '<div class="acard"><div class="top1"><div><div class="ttl">' + esc(e.client) + '</div><div class="sub2">nº ' + esc(e.number) + ' · ' + esc(e.date) + ' · ' + esc(e.quarter) + '</div></div><div class="amt">' + fmt(e.total) + ' €</div></div></div>'; }).join('') : '<p class="empty">Aún no hay facturas emitidas de 2027.</p>';
    html += '<div class="sec"><span>Pagos de impuestos anotados</span></div>';
    var pg = r.pagos || []; html += pg.length ? pg.map(function (e) { return '<div class="acard"><div class="top1"><div><div class="ttl">' + esc(e.tax) + ' ' + esc(e.quarter) + '</div><div class="sub2">' + esc(e.date) + (e.note ? ' · ' + esc(e.note) : '') + '</div></div><div class="amt">' + fmt(e.amount) + ' €</div></div></div>'; }).join('') : '<p class="empty">Aún no hay pagos anotados.</p>';
    $('tab-imp').innerHTML = html;
    wireImp();
  }
  function num(v) { v = String(v || '').trim().replace(/[\s€]/g, ''); var c = v.lastIndexOf(','), d = v.lastIndexOf('.'); if (c > -1 && d > -1) v = c > d ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, ''); else v = v.replace(',', '.'); return Number(v); }
  function msg(id, text, ok) { var m = $(id); m.textContent = text; m.className = 'msg ' + (ok ? 'good' : 'bad'); }
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
        $('xMsg').className = 'msg good'; $('xMsg').innerHTML = 'Hecho: ' + res.recibidas + ' recibidas y ' + res.emitidas + ' emitidas. <a target="_blank" rel="noopener" style="color:var(--brand-light)" href="' + esc(res.url) + '">Abrir la hoja</a>';
      });
    });
  }

  /* ---------- pestaña Más ---------- */
  function renderMas() {
    var r = state.rep, c = r.control || {};
    $('tab-mas').innerHTML = '<div class="sec"><span>Estado del sistema</span></div>'
      + '<div class="acard"><div class="qrow"><span>Copia de seguridad</span><span class="n">' + esc(c.backup || '—') + '</span><span></span></div>'
      + '<div class="qrow"><span>Control de archivos</span><span class="n">' + esc(c.detail || '—') + '</span><span></span></div>'
      + '<div class="qrow"><span>Gastos en el registro</span><span class="n">' + esc(r.registroRows) + '</span><span></span></div>'
      + '<div class="qrow"><span>Último control</span><span class="n">' + esc(c.at || '—') + '</span><span></span></div></div>'
      + '<p class="muted small">La clave de esta pantalla se guarda solo en este navegador mientras la sesión está abierta (o en el dispositivo, si marcaste «recordar»). La sesión se cierra tras 20 minutos sin usarla.</p>'
      + '<button id="refresh" class="btn" type="button">Actualizar datos</button>';
    $('refresh').addEventListener('click', function () { reload('Datos actualizados'); });
  }
  function renderAll() { renderRev(); renderLiq(); renderImp(); renderMas(); }

  /* ---------- servidor simulado (?mock=1) ---------- */
  var mock = null;
  function mockApi(b) {
    if (!mock) mock = {
      rev: [{ id: 'A1', person: 'Alberto Barroso', date: '2026-11-11', event: 'Mediterranean Epic · 4 feb', concept: 'Hotel/Apartamentos', supplier: 'Hotel Sol', docType: 'Factura completa', docNumber: 'F-123', amount: 186.16, status: 'Pendiente', files: 'https://drive.google.com/file/d/x/view' },
      { id: 'A2', person: 'Luis Pérez', date: '2026-11-18', event: 'Leyenda de Tartessos · 21–24 ene', concept: 'Comida', supplier: 'Bar Pepe', docType: 'Ticket / factura simplificada', docNumber: '', amount: 42.5, status: 'Pendiente', files: '' },
      { id: 'A3', person: 'Alberto Barroso', date: '2026-11-20', event: 'Leyenda de Tartessos · 21–24 ene', concept: 'Gasolina', supplier: 'Repsol', docType: 'Ticket / factura simplificada', docNumber: '', amount: 58.3, status: 'Pendiente', files: '' },
      { id: 'A4', person: 'Luis Pérez', date: '2026-11-25', event: 'Mediterranean Epic · 4 feb', concept: 'Material', supplier: 'Bike Center', docType: 'Factura completa', docNumber: 'B-77', amount: 312.9, status: 'Pendiente', files: '' }],
      appr: [{ id: 'B1', supplier: 'Repsol', concept: 'Diésel', date: '2026-11-05', net: 14, review: 'Revisado', person: 'Alberto Barroso' }], paid: [] };
    var ok = function (o) { return Promise.resolve(Object.assign({ ok: true }, o)); };
    if (b.action === 'adminReport') {
      var pend = {}; mock.appr.forEach(function (i) { (pend[i.person] = pend[i.person] || { person: i.person, total: 0, count: 0, items: [] }); pend[i.person].items.push({ id: i.id, supplier: i.supplier, concept: i.concept, date: i.date, net: i.net, amount: i.net, review: i.review, reviewNote: i.reviewNote || '' }); pend[i.person].total += i.net; });
      mock.rev.forEach(function (i) { (pend[i.person] = pend[i.person] || { person: i.person, total: 0, count: 0, items: [] }); pend[i.person].items.push({ id: i.id, supplier: i.supplier, concept: i.concept, date: i.date, net: i.amount, amount: i.amount, review: '', reviewNote: '' }); pend[i.person].total += i.amount; });
      return ok({ porRevisar: mock.rev, pending: Object.keys(pend).map(function (k) { return pend[k]; }), registroRows: 6, control: { backup: 'OK', detail: 'Todo correcto', at: '27/11/2026 3:50' }, ivaCarry: { from: '2026-T4', amount: 334.27, status: 'provisional' },
        impuestos: [{ quarter: '2027-T1', ivaRep: 0, ivaSop: 0, irpf: 0, ivaPaid: 0, irpfPaid: 0, facturasEmitidas: 0, carryIn: 334.27, carryOut: 334.27, ivaToPay: 0, ivaPending: 0, irpfPending: 0 }], impuestos2026T4: { ivaSop: 261.89, irpf: 0 }, emitidas: [], pagos: [] });
    }
    if (b.action === 'adminReview') { b.ids.forEach(function (id) { var i = mock.rev.filter(function (x) { return x.id === id; })[0]; if (i) { mock.rev = mock.rev.filter(function (x) { return x.id !== id; }); mock.appr.push({ id: i.id, supplier: i.supplier, concept: i.concept, date: i.date, net: i.amount, review: b.status, reviewNote: b.note, person: i.person }); } else mock.appr.forEach(function (x) { if (x.id === id) { x.review = b.status; x.reviewNote = b.note; } }); }); return ok({ n: b.ids.length }); }
    if (b.action === 'liquidate') { mock.appr = mock.appr.filter(function (x) { return b.ids.indexOf(x.id) < 0; }); return ok({ person: b.person, n: b.ids.length, total: b.expectedTotal }); }
    if (b.action === 'adminTaxPaid') return ok({});
    if (b.action === 'adminIssuedAdd') return ok({ iva: Math.round(b.data.base * 21) / 100, quarter: '2027-T1' });
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
