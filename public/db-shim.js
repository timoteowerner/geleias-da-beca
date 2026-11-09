/* Camada de dados do painel: mesma interface do banco usado no Claude (doc, collection, onSnapshot),
   mas falando com a API do Worker (/api). Atualiza a cada 8 s e logo depois de cada gravação. */
(function () {
  var POLL_MS = 8000;
  var cols = {};

  function err(code, message) { var e = new Error(message || code); e.code = code; return e; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function newId() {
    var a = new Uint8Array(12); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function request(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: { 'x-requested-with': 'geleias' } };
    if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch('/api/' + path, opts).then(function (r) {
      if (r.status === 401 || r.status === 403) throw err('revoked', 'Sessão expirada');
      if (r.status === 503) throw err('unavailable', 'Acesso ainda não configurado');
      if (!r.ok) throw err(r.status === 400 || r.status === 413 ? 'invalid_argument' : 'unavailable', 'HTTP ' + r.status);
      if (r.status === 204) return null;
      return r.json().catch(function () { throw err('revoked', 'Resposta inesperada'); });
    }, function () { throw err('unavailable', 'Sem conexão'); });
  }

  function col(name) { return cols[name] || (cols[name] = { map: null, sig: null, subs: [], inflight: null }); }

  function load(name) {
    var c = col(name);
    if (c.inflight) return c.inflight;
    c.inflight = request('GET', 'c/' + name).then(function (res) {
      c.inflight = null;
      var sig = JSON.stringify(res.docs), changed = sig !== c.sig;
      c.sig = sig; c.map = {};
      res.docs.forEach(function (d) { c.map[d.id] = d.data; });
      return changed;
    }, function (e) { c.inflight = null; throw e; });
    return c.inflight;
  }

  function meta() { return { fromCache: false, hasPendingWrites: false }; }
  function docSnap(id, data) {
    return { id: id, exists: data != null, data: function () { return data == null ? undefined : clone(data); }, metadata: meta() };
  }

  function fireAll(name) { col(name).subs.slice().forEach(function (s) { s.fire(); }); }
  function refresh(name) {
    return load(name).then(function (changed) { if (changed) fireAll(name); }, function (e) {
      col(name).subs.slice().forEach(function (s) { s.fail(e); });
    });
  }
  function afterWrite(name) { return load(name).then(function () { fireAll(name); }); }

  function subscribe(name, build, next, error) {
    var c = col(name), sub = { dead: false, failed: false };
    sub.fire = function () { if (sub.dead || !c.map) return; sub.failed = false; next(build(c.map)); };
    sub.fail = function (e) { if (sub.dead || sub.failed) return; sub.failed = true; if (error) error({ code: e.code || 'unavailable', message: e.message }); };
    c.subs.push(sub);
    if (c.map) setTimeout(sub.fire, 0); else load(name).then(function () { fireAll(name); }, sub.fail);
    return function () { sub.dead = true; c.subs = c.subs.filter(function (s) { return s !== sub; }); };
  }

  setInterval(function () {
    if (document.hidden) return;
    Object.keys(cols).forEach(function (n) { if (cols[n].subs.length) refresh(n); });
  }, POLL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    Object.keys(cols).forEach(function (n) { if (cols[n].subs.length) refresh(n); });
  });

  function docRef(name, id) {
    return {
      id: id, path: name + '/' + id,
      get: function () { return load(name).then(function () { return docSnap(id, col(name).map[id]); }); },
      set: function (data) { return request('PUT', 'd/' + name + '/' + id, data).then(function () { return afterWrite(name); }); },
      update: function (data) { return request('PATCH', 'd/' + name + '/' + id, data).then(function () { return afterWrite(name); }); },
      delete: function () { return request('DELETE', 'd/' + name + '/' + id).then(function () { return afterWrite(name); }); },
      onSnapshot: function (next, error) { return subscribe(name, function (map) { return docSnap(id, map[id]); }, next, error); }
    };
  }

  function query(name, order, lim) {
    function build(map) {
      var docs = Object.keys(map).map(function (id) { return { id: id, data: map[id] }; });
      if (order) {
        docs.sort(function (a, b) {
          var x = a.data[order.field], y = b.data[order.field];
          if (x === y || (x == null && y == null)) return 0;
          if (x == null) return 1; if (y == null) return -1;
          return (x < y ? -1 : 1) * (order.dir === 'desc' ? -1 : 1);
        });
      }
      if (lim) docs = docs.slice(0, lim);
      var snaps = docs.map(function (d) { return docSnap(d.id, d.data); });
      return { docs: snaps, size: snaps.length, empty: !snaps.length, metadata: meta(), docChanges: function () { return []; } };
    }
    return {
      path: name,
      orderBy: function (field, dir) { return query(name, { field: field, dir: dir || 'asc' }, lim); },
      limit: function (n) { return query(name, order, n); },
      get: function () { return load(name).then(function () { return build(col(name).map); }); },
      onSnapshot: function (next, error) { return subscribe(name, build, next, error); },
      doc: function (id) { return docRef(name, id || newId()); },
      add: function (data) { var ref = docRef(name, newId()); return ref.set(data).then(function () { return ref; }); }
    };
  }

  window.GeleiasDb = {
    doc: function (path) { var p = path.split('/'); return docRef(p[0], p[1]); },
    collection: function (name) { return query(name, null, null); }
  };
})();
