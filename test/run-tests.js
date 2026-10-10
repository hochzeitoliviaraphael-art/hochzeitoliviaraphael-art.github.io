/*
 * Local test suite: runs Code.gs and the engine from index.html in Node
 * against a simulated Drive resumable-upload API. No Google account needed.
 *
 *   node test/run-tests.js
 *
 * This checks our own logic only. Real Google behaviour (CORS, Origin header,
 * Range header visibility) must still be tested on phones (README, Teil A).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const KIB = 1024;
const MIB = 1024 * KIB;

// ---------------------------------------------------------------------------
// Fake Drive resumable upload server
// ---------------------------------------------------------------------------
class FakeDrive {
  constructor() {
    this.sessions = new Map();
    this.nextId = 1;
    this.files = [];
    this.faults = [];        // queued faults, consumed in order by data PUTs
    this.hideRange = false;  // simulate a Range header the browser cannot read
    this.lastSessionRequest = null;
    this.gfiles = new Map();     // gallery: id -> {id, mimeType, size, parents, trashed, thumbnailLink, data}
    this.thumbFetches = 0;
    this.mediaFetches = 0;
  }
  addGalleryFile(f) {
    const file = Object.assign({ trashed: false, createdTime: '2026-10-17T15:00:00.000Z' }, f);
    if (file.data) file.size = String(file.data.length);
    this.gfiles.set(file.id, file);
    return file;
  }
  createSession(meta, headers) {
    this.lastSessionRequest = { meta, headers };
    const id = this.nextId++;
    const total = Number(headers['X-Upload-Content-Length']);
    this.sessions.set(String(id), { total, stored: Buffer.alloc(0), done: false, meta, expired: false });
    return 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=' + id;
  }
  session(url) {
    const m = /upload_id=(\d+)$/.exec(url);
    return m && this.sessions.get(m[1]);
  }
  // Returns {status, range} or throws 'network' (lost request or lost response).
  put(url, bytes, contentRange) {
    const s = this.session(url);
    if (!s || s.expired) return { status: 404, range: null };
    const rangeOf = () => (s.stored.length ? 'bytes=0-' + (s.stored.length - 1) : null);
    const statusQuery = /^bytes \*\/(\d+)$/.exec(contentRange);
    if (statusQuery) {
      if (s.done) return { status: 200, range: null };
      return { status: 308, range: this.hideRange ? null : rangeOf() };
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    assert.ok(m, 'bad Content-Range ' + contentRange);
    const start = Number(m[1]); const end = Number(m[2]); const total = Number(m[3]);
    assert.strictEqual(total, s.total, 'total mismatch');
    assert.strictEqual(end - start + 1, bytes.length, 'range length mismatch');

    const fault = this.faults.shift();
    if (fault === 'expire') { s.expired = true; return { status: 404, range: null }; }
    if (fault === 'lose-request') throw new Error('network');
    if (fault === 'server-error') return { status: 503, range: null };

    if (start !== s.stored.length) return { status: 400, range: null };
    const isLast = end + 1 === total;
    if (!isLast && bytes.length % (256 * KIB) !== 0) return { status: 400, range: null };

    let accepted = bytes;
    if (fault === 'partial') accepted = bytes.subarray(0, 256 * KIB); // Drive stores only part
    s.stored = Buffer.concat([s.stored, accepted]);
    if (s.stored.length === total) {
      s.done = true;
      this.files.push({ name: s.meta.name, parents: s.meta.parents, data: s.stored });
    }
    if (fault === 'lose-response') throw new Error('network');
    if (s.done) return { status: 200, range: null };
    return { status: 308, range: this.hideRange ? null : rangeOf() };
  }
}

// ---------------------------------------------------------------------------
// Apps Script sandbox for Code.gs
// ---------------------------------------------------------------------------
function loadBackend(drive, props, options) {
  options = options || {};
  const cache = new Map();
  const fetchLog = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null) }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => cache.set(k, v),
        getAll: (keys) => keys.reduce((o, k) => (cache.has(k) && (o[k] = cache.get(k)), o), {}),
        putAll: (obj) => Object.keys(obj).forEach((k) => cache.set(k, obj[k])),
      }),
    },
    ScriptApp: { getOAuthToken: () => 'SECRET-TOKEN' },
    Utilities: {
      formatDate(date, tz, pattern) {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        }).formatToParts(date).reduce((o, p) => ((o[p.type] = p.value), o), {});
        return pattern.replace('yyyy', parts.year).replace('MM', parts.month)
          .replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute)
          .replace('ss', parts.second);
      },
      base64Decode: (s) => Array.from(Buffer.from(s, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      base64Encode: (bytes) => toBuf(bytes).toString('base64'),
      base64EncodeWebSafe: (bytes) => {
        const b64 = toBuf(bytes).toString('base64url');
        return b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      },
      computeHmacSha256Signature: (value, key) =>
        Array.from(crypto.createHmac('sha256', key).update(value).digest()).map((b) => (b > 127 ? b - 256 : b)),
    },
    UrlFetchApp: {
      fetch(url, opts) {
        fetchLog.push({ url, opts });
        if (options.fetchThrows) throw new Error('Address unavailable: ' + url);
        const headers = opts.headers || {};
        const respond = (status, hdrs, text) => ({
          getResponseCode: () => status,
          getAllHeaders: () => hdrs || {},
          getHeaders: () => hdrs || {},
          getContentText: () => text || '',
        });
        if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable') &&
            opts.method === 'post') {
          if (options.sessionStatus) return respond(options.sessionStatus, {});
          const meta = JSON.parse(opts.payload);
          const loc = drive.createSession(meta, headers);
          return respond(200, { location: loc });
        }
        if (opts.method === 'put') {
          assert.strictEqual(opts.followRedirects, false, 'followRedirects must be false');
          const bytes = opts.payload === '' ? Buffer.alloc(0)
            : Buffer.from(opts.payload.map((b) => (b < 0 ? b + 256 : b)));
          let res;
          try {
            res = drive.put(url, bytes, headers['Content-Range']);
          } catch (e) {
            throw new Error('Exception: Timeout: ' + url);
          }
          const hdrs = {};
          if (res.range) hdrs.Range = res.range;
          return respond(res.status, hdrs);
        }
        const gal = galleryFetch(drive, props, url, opts, respond);
        if (gal) return gal;
        if (url.startsWith('https://www.googleapis.com/drive/v3/files/')) {
          return respond(200, {}, JSON.stringify({
            name: 'Hochzeit – Uploads', mimeType: 'application/vnd.google-apps.folder',
            capabilities: { canAddChildren: true },
          }));
        }
        throw new Error('unexpected fetch ' + url);
      },
      fetchAll(requests) {
        return requests.map((r) => sandbox.UrlFetchApp.fetch(r.url, r));
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        const o = { text, mime: null };
        o.setMimeType = (m) => ((o.mime = m), o);
        return o;
      },
    },
    HtmlService: {
      createTemplateFromFile(name) {
        const t = { name, evaluate() { return output('template:' + name, t); } };
        return t;
      },
      createHtmlOutput(html) { return output(html); },
    },
  };
  function toBuf(bytes) {
    return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.map((b) => (b < 0 ? b + 256 : b)));
  }
  function output(content, template) {
    const o = { content, template, title: null, meta: {} };
    o.setTitle = (t) => ((o.title = t), o);
    o.addMetaTag = (k, v) => ((o.meta[k] = v), o);
    return o;
  }
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/Code.gs'), 'utf8'), sandbox, { filename: 'Code.gs' });
  sandbox.__fetchLog = fetchLog;
  return sandbox;
}

/** Fake Drive endpoints used by the gallery. Returns a response or null. */
function galleryFetch(drive, props, url, opts, respond) {
  const headers = (opts && opts.headers) || {};
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';
  const withContent = (r, buf, type) => Object.assign(r, {
    getContent: () => buf,
    getAllHeaders: () => ({ 'Content-Type': type }),
    getHeaders: () => ({ 'Content-Type': type }),
  });
  if (url.startsWith(DRIVE + '?')) {
    const u = new URL(url);
    const q = u.searchParams.get('q');
    const folder = /^'([^']+)' in parents/.exec(q)[1];
    assert.ok(/trashed = false/.test(q), 'listing must exclude trashed files');
    const pageSize = Number(u.searchParams.get('pageSize'));
    const offset = Number(u.searchParams.get('pageToken') || 0);
    const all = Array.from(drive.gfiles.values()).filter((f) =>
      f.parents.includes(folder) && !f.trashed && /^(image|video)\//.test(f.mimeType));
    const page = all.slice(offset, offset + pageSize).map((f) => ({
      id: f.id, mimeType: f.mimeType, size: f.size, createdTime: f.createdTime,
      thumbnailLink: f.thumbnailLink, name: 'SECRET-NAME-' + f.id,
    }));
    const next = offset + pageSize < all.length ? String(offset + pageSize) : undefined;
    return respond(200, {}, JSON.stringify({ files: page, nextPageToken: next }));
  }
  let m = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?alt=media$/.exec(url);
  if (m) {
    drive.mediaFetches++;
    const f = drive.gfiles.get(decodeURIComponent(m[1]));
    if (!f) return respond(404, {});
    const r = /^bytes=(\d+)-(\d+)$/.exec(headers.Range);
    assert.ok(r, 'media fetch needs a Range header');
    const start = Number(r[1]); const end = Math.min(Number(r[2]), f.data.length - 1);
    return withContent(respond(206, {}), f.data.subarray(start, end + 1), f.mimeType);
  }
  m = /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?fields=/.exec(url);
  if (m && m[1] !== props.FOLDER_ID) {
    const f = drive.gfiles.get(decodeURIComponent(m[1]));
    if (!f) return respond(404, {}, '{}');
    return respond(200, {}, JSON.stringify({ id: f.id, mimeType: f.mimeType, size: f.size,
      trashed: f.trashed, parents: f.parents, thumbnailLink: f.thumbnailLink }));
  }
  if (/^https:\/\/[a-z0-9.-]+\//.test(url) && !url.startsWith('https://www.googleapis.com/')) {
    drive.thumbFetches++;
    if (!/^https:\/\/lh3\.googleusercontent\.com\//.test(url)) throw new Error('fetched foreign host ' + url);
    return withContent(respond(200, {}), Buffer.from('JPEG:' + url), 'image/jpeg');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Engine from index.html
// ---------------------------------------------------------------------------
function loadEngine() {
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  const js = html.split('<script>')[1].split('</script>')[0];
  const sandbox = { __TEST__: true, console, Promise, Math, Date, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'index.html' });
  return sandbox.__weddingUpload;
}

function loadGalleryHelpers() {
  const html = fs.readFileSync(path.join(ROOT, 'src/gallery.html'), 'utf8');
  const js = html.split('<script>')[1].split('</script>')[0];
  const sandbox = { __TEST__: true, Promise, Blob, atob, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(js, sandbox, { filename: 'gallery.html' });
  return sandbox.__weddingGallery;
}

function makeFile(size, name, type) {
  const data = crypto.randomBytes(size);
  return { blob: new Blob([data], { type }), data, name, type };
}

function fileLike(f) {
  return { name: f.name, type: f.type, size: f.blob.size, slice: (a, b) => f.blob.slice(a, b) };
}

/**
 * Wires the engine to the backend sandbox (google.script.run) and to the fake
 * Drive (direct XHR). Returns {engine, stats}.
 */
function wire(api, backend, drive, opts) {
  opts = opts || {};
  const stats = { sleeps: [], puts: 0, statusQueries: 0, serverCalls: {}, logs: [] };
  let online = opts.online !== undefined ? opts.online : true;
  const engine = api.createEngine({
    code: opts.code || 'CODE-1234567',
    origin: 'https://n-abc123-0lu-script.googleusercontent.com',
    random: () => 0,
    sleep: (ms) => { stats.sleeps.push(ms); return Promise.resolve(); },
    isOnline: () => online,
    waitOnline: () => { stats.waitedOnline = (stats.waitedOnline || 0) + 1; online = true; return Promise.resolve(); },
    callServer: async (fn, arg) => {
      stats.serverCalls[fn] = (stats.serverCalls[fn] || 0) + 1;
      if (opts.serverDown && opts.serverDown[fn] && opts.serverDown[fn]-- > 0) {
        throw new Error('NetworkError: Connection failure');
      }
      // google.script.run serializes arguments and results as JSON
      return JSON.parse(JSON.stringify(backend[fn](JSON.parse(JSON.stringify(arg)))));
    },
    readBase64: async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64'),
    xhrPut: async (url, body, headers, onProgress) => {
      const bytes = body ? Buffer.from(await body.arrayBuffer()) : Buffer.alloc(0);
      if (body) stats.puts++; else stats.statusQueries++;
      if (onProgress) onProgress(bytes.length);
      const res = drive.put(url, bytes, headers['Content-Range']);
      return { status: res.status, range: res.range };
    },
  });
  return { engine, stats };
}

function hooks(stats) {
  const h = { progress: [], statuses: [] };
  h.onProgress = (b) => h.progress.push(b);
  h.onStatus = (t) => h.statuses.push(t);
  h.log = (m) => stats.logs.push(m);
  return h;
}

function newItem(f, guestName) {
  return { file: fileLike(f), guestName: guestName || '', session: null, confirmed: 0 };
}

const BASE_PROPS = {
  FOLDER_ID: 'folder-xyz', ACCESS_CODE: 'CODE-1234567', ENABLED: 'true',
  UPLOAD_MODE: 'direct', MAX_FILE_MB: '2048', MAX_FILE_MB_PROXY: '500', RATE_LIMIT_PER_MIN: '120',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ----- Backend -----
test('doGet: closed, bad code, valid', () => {
  const drive = new FakeDrive();
  let b = loadBackend(drive, Object.assign({}, BASE_PROPS, { ENABLED: 'false' }));
  assert.match(b.doGet({ parameter: { k: 'CODE-1234567' } }).content, /Upload ist beendet/);
  b = loadBackend(drive, BASE_PROPS);
  assert.match(b.doGet({ parameter: {} }).content, /nicht gültig/);
  assert.match(b.doGet({ parameter: { k: 'wrong' } }).content, /nicht gültig/);
  assert.match(b.doGet(undefined).content, /nicht gültig/);
  const ok = b.doGet({ parameter: { k: 'CODE-1234567', debug: '1' } });
  assert.strictEqual(ok.content, 'template:index');
  assert.strictEqual(ok.template.code, 'CODE-1234567');
  assert.strictEqual(ok.template.debug, true);
  assert.ok(ok.meta.viewport);
  // Missing ACCESS_CODE property must never accept an empty code
  b = loadBackend(drive, Object.assign({}, BASE_PROPS, { ACCESS_CODE: '' }));
  assert.match(b.doGet({ parameter: { k: '' } }).content, /nicht gültig/);
});

test('createUploadSession: validation errors', () => {
  const drive = new FakeDrive();
  const b = loadBackend(drive, BASE_PROPS);
  const base = { code: 'CODE-1234567', fileName: 'IMG_1.jpg', mimeType: 'image/jpeg', size: 1000,
    guestName: '', origin: 'https://x.googleusercontent.com' };
  const call = (o) => b.createUploadSession(Object.assign({}, base, o));
  assert.strictEqual(call({ code: 'nope' }).error, 'BAD_CODE');
  assert.strictEqual(call({ fileName: 'a.zip', mimeType: 'application/zip' }).error, 'BAD_TYPE');
  assert.strictEqual(call({ fileName: 'a.exe', mimeType: '' }).error, 'BAD_TYPE');
  assert.strictEqual(call({ fileName: 'x.svg', mimeType: 'image/svg+xml' }).error, 'BAD_TYPE');
  assert.strictEqual(call({ size: 0 }).error, 'EMPTY');
  assert.strictEqual(call({ size: -5 }).error, 'EMPTY');
  assert.strictEqual(call({ size: 'abc' }).error, 'EMPTY');
  assert.strictEqual(call({ size: 2048 * MIB + 1 }).error, 'TOO_LARGE');
  assert.strictEqual(call({ size: 2048 * MIB }).ok, true);
  assert.strictEqual(b.createUploadSession(null).error, 'BAD_CODE');
  // HEIC from iPhone often arrives without a MIME type
  const heic = call({ fileName: 'IMG_9.HEIC', mimeType: '' });
  assert.strictEqual(heic.ok, true);
  assert.strictEqual(drive.lastSessionRequest.headers['X-Upload-Content-Type'], 'image/heic');
  const mov = call({ fileName: 'clip.MOV', mimeType: 'application/octet-stream' });
  assert.strictEqual(drive.lastSessionRequest.headers['X-Upload-Content-Type'], 'video/quicktime');
  assert.strictEqual(mov.ok, true);
});

test('createUploadSession: success shape, headers, no secrets returned', () => {
  const drive = new FakeDrive();
  const b = loadBackend(drive, BASE_PROPS);
  const res = b.createUploadSession({ code: 'CODE-1234567', fileName: 'IMG_1.jpg', mimeType: 'image/jpeg',
    size: 5000, guestName: 'Tante Erna', origin: 'https://n-abc-0lu-script.googleusercontent.com' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.mode, 'direct');
  assert.strictEqual(res.chunkSize, 8 * MIB);
  assert.match(res.sessionUrl, /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?/);
  assert.match(res.storedName, /^\d{8}-\d{6}_Tante Erna_IMG_1\.jpg$/);
  const req = drive.lastSessionRequest;
  assert.deepStrictEqual(req.meta.parents, ['folder-xyz']);
  assert.strictEqual(req.headers.Authorization, 'Bearer SECRET-TOKEN');
  assert.strictEqual(req.headers.Origin, 'https://n-abc-0lu-script.googleusercontent.com');
  assert.strictEqual(req.headers['X-Upload-Content-Length'], '5000');
  const json = JSON.stringify(res);
  assert.ok(!json.includes('SECRET-TOKEN') && !json.includes('folder-xyz'), 'leaked secret');
  // Bad origins are not forwarded
  b.createUploadSession({ code: 'CODE-1234567', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 10,
    origin: 'javascript:alert(1)' });
  assert.strictEqual(drive.lastSessionRequest.headers.Origin, undefined);
  // Proxy mode: no Origin, smaller chunks, lower limit
  const p = loadBackend(drive, Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy' }));
  const pr = p.createUploadSession({ code: 'CODE-1234567', fileName: 'a.mp4', mimeType: 'video/mp4',
    size: 10, origin: 'https://x.googleusercontent.com' });
  assert.strictEqual(pr.mode, 'proxy');
  assert.strictEqual(pr.chunkSize, 8 * MIB);
  const p2 = loadBackend(drive, Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy', PROXY_CHUNK_MB: '16' }));
  assert.strictEqual(p2.createUploadSession({ code: 'CODE-1234567', fileName: 'a.mp4', mimeType: 'video/mp4',
    size: 10 }).chunkSize, 16 * MIB);
  const p3 = loadBackend(drive, Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy', PROXY_CHUNK_MB: '999' }));
  assert.strictEqual(p3.createUploadSession({ code: 'CODE-1234567', fileName: 'a.mp4', mimeType: 'video/mp4',
    size: 10 }).chunkSize, 32 * MIB);
  const p4 = loadBackend(drive, Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy', PROXY_CHUNK_MB: 'x' }));
  assert.strictEqual(p4.createUploadSession({ code: 'CODE-1234567', fileName: 'a.mp4', mimeType: 'video/mp4',
    size: 10 }).chunkSize, 8 * MIB);
  assert.strictEqual(drive.lastSessionRequest.headers.Origin, undefined);
  assert.strictEqual(p.createUploadSession({ code: 'CODE-1234567', fileName: 'a.mp4',
    mimeType: 'video/mp4', size: 500 * MIB + 1 }).error, 'TOO_LARGE');
});

test('createUploadSession: Drive failure and exceptions never throw', () => {
  const drive = new FakeDrive();
  let b = loadBackend(drive, BASE_PROPS, { sessionStatus: 403 });
  const req = { code: 'CODE-1234567', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 10 };
  assert.strictEqual(b.createUploadSession(req).error, 'DRIVE_ERROR');
  b = loadBackend(drive, BASE_PROPS, { fetchThrows: true });
  assert.strictEqual(b.createUploadSession(req).error, 'DRIVE_ERROR');
});

test('createUploadSession: kill switch and rate limit', () => {
  const drive = new FakeDrive();
  let b = loadBackend(drive, Object.assign({}, BASE_PROPS, { ENABLED: 'false' }));
  const req = { code: 'CODE-1234567', fileName: 'a.jpg', mimeType: 'image/jpeg', size: 10 };
  assert.strictEqual(b.createUploadSession(req).error, 'CLOSED');
  b = loadBackend(drive, Object.assign({}, BASE_PROPS, { RATE_LIMIT_PER_MIN: '3' }));
  const results = [1, 2, 3, 4].map(() => b.createUploadSession(req));
  assert.deepStrictEqual(results.map((r) => r.ok), [true, true, true, false]);
  assert.strictEqual(results[3].error, 'RATE_LIMIT');
});

test('file names: sanitizing, umlauts, emojis, length, path separators', () => {
  const b = loadBackend(new FakeDrive(), BASE_PROPS);
  const d = new Date('2027-06-12T13:30:45Z'); // 15:30:45 in Berlin (summer time)
  assert.strictEqual(b.buildStoredName_('IMG_1234.jpg', 'image/jpeg', '', d), '20270612-153045_IMG_1234.jpg');
  assert.strictEqual(b.buildStoredName_('Tanz 🎉 Brautpaar.MOV', 'video/quicktime', 'Jürgen 😀', d),
    '20270612-153045_Jürgen_Tanz _ Brautpaar.mov');
  assert.strictEqual(b.buildStoredName_('../../etc/passwd.jpg', 'image/jpeg', 'a/b\\c', d),
    '20270612-153045_a_b_c_passwd.jpg');
  assert.strictEqual(b.buildStoredName_('', 'video/mp4', '', d), '20270612-153045_datei.mp4');
  assert.strictEqual(b.buildStoredName_('.hidden', 'image/png', '', d), '20270612-153045_hidden.png');
  const long = b.buildStoredName_('x'.repeat(400) + '.jpeg', 'image/jpeg', 'y'.repeat(100), d);
  assert.ok(long.length <= 150, 'too long: ' + long.length);
  assert.ok(long.endsWith('.jpeg'));
  assert.ok(long.includes('_' + 'y'.repeat(40) + '_'));
  assert.strictEqual(b.buildStoredName_('Café Ölmühle.jpg', 'image/jpeg', '  ', d),
    '20270612-153045_Café Ölmühle.jpg');
  // winter time
  assert.match(b.buildStoredName_('a.jpg', 'image/jpeg', '', new Date('2027-01-05T23:30:00Z')),
    /^20270106-003000_/);
});

test('uploadChunk/getUploadStatus: SSRF guard and mode guard', () => {
  const drive = new FakeDrive();
  const b = loadBackend(drive, Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy' }));
  const bad = ['https://evil.example/upload/drive/v3/files?x', 'https://www.googleapis.com/drive/v3/files/abc',
    'http://www.googleapis.com/upload/drive/v3/files?x', 'https://www.googleapis.com/upload/drive/v3/files?a#@evil'];
  bad.forEach((u) => {
    assert.strictEqual(b.uploadChunk({ code: 'CODE-1234567', sessionUrl: u, base64: 'AA==', start: 0,
      total: 1 }).error, 'BAD_REQUEST', u);
    assert.strictEqual(b.getUploadStatus({ code: 'CODE-1234567', sessionUrl: u, total: 1 }).error,
      'BAD_REQUEST', u);
  });
  assert.strictEqual(b.__fetchLog.length, 0, 'must not fetch foreign URLs');
  const d = loadBackend(drive, BASE_PROPS);
  assert.strictEqual(d.uploadChunk({ code: 'CODE-1234567',
    sessionUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=1',
    base64: 'AA==', start: 0, total: 1 }).error, 'WRONG_MODE');
  assert.strictEqual(d.uploadChunk({ code: 'wrong', sessionUrl: 'x' }).error, 'BAD_CODE');
});

// ----- Engine: direct mode -----
async function directUpload(size, setup) {
  const api = loadEngine();
  const drive = new FakeDrive();
  const backend = loadBackend(drive, BASE_PROPS);
  const f = makeFile(size, 'VID_0001.mp4', 'video/mp4');
  if (setup) setup(drive);
  const { engine, stats } = wire(api, backend, drive);
  const item = newItem(f, 'Max');
  const h = hooks(stats);
  await engine.uploadFile(item, h);
  assert.strictEqual(drive.files.length, 1, 'file not stored');
  assert.ok(drive.files[0].data.equals(f.data), 'data corrupted');
  return { drive, stats, h, item };
}

test('direct: small photo in one chunk', async () => {
  const { stats } = await directUpload(300 * KIB);
  assert.strictEqual(stats.puts, 1);
});

test('direct: multi-chunk video, exact multiple and remainder', async () => {
  let r = await directUpload(16 * MIB);
  assert.strictEqual(r.stats.puts, 2);
  r = await directUpload(20 * MIB + 123);
  assert.strictEqual(r.stats.puts, 3);
  assert.strictEqual(r.h.progress[r.h.progress.length - 1], 20 * MIB + 123);
});

test('direct: lost request is retried with backoff and smaller chunks', async () => {
  const { stats } = await directUpload(20 * MIB, (d) => { d.faults = [null, 'lose-request'] ; });
  assert.ok(stats.statusQueries >= 1, 'should query status after failure');
  assert.deepStrictEqual(stats.sleeps, [1000]);
});

test('direct: lost response (bytes stored, client did not see it) resumes correctly', async () => {
  await directUpload(24 * MIB, (d) => { d.faults = ['lose-response']; });
});

test('direct: Drive stores only part of a chunk', async () => {
  await directUpload(20 * MIB, (d) => { d.faults = ['partial', 'partial']; });
});

test('direct: Range header unreadable (CORS) still completes', async () => {
  await directUpload(20 * MIB, (d) => { d.hideRange = true; });
});

test('direct: Range unreadable plus lost response restarts the session', async () => {
  // Without a readable Range the true offset after a lost response is unknown.
  // Drive rejects the misaligned chunk; the engine must restart, never corrupt.
  const { drive } = await directUpload(24 * MIB, (d) => { d.hideRange = true; d.faults = [null, 'lose-response']; });
  assert.strictEqual(drive.sessions.size, 2);
});

test('direct: 5xx errors retried, then success', async () => {
  const { stats } = await directUpload(10 * MIB, (d) => { d.faults = ['server-error', 'server-error']; });
  assert.deepStrictEqual(stats.sleeps, [1000, 2000]);
});

test('direct: gives up after 5 failed retries with a retryable error', async () => {
  const api = loadEngine();
  const drive = new FakeDrive();
  drive.faults = Array(20).fill('lose-request');
  const backend = loadBackend(drive, BASE_PROPS);
  const f = makeFile(5 * MIB, 'v.mp4', 'video/mp4');
  const { engine, stats } = wire(api, backend, drive);
  const item = newItem(f);
  await assert.rejects(engine.uploadFile(item, hooks(stats)), (e) => e.code === 'NETWORK' && e.retryable);
  assert.deepStrictEqual(stats.sleeps, [1000, 2000, 4000, 8000, 16000]);
  // Manual retry resumes the same session after the network is back
  drive.faults = [];
  await engine.uploadFile(item, hooks(stats));
  assert.ok(drive.files[0].data.equals(f.data));
  assert.strictEqual(drive.sessions.size, 1, 'should reuse the session');
});

test('direct: expired session restarts with a new session', async () => {
  const { drive } = await directUpload(20 * MIB, (d) => { d.faults = [null, 'expire']; });
  assert.strictEqual(drive.sessions.size, 2);
});

test('direct: offline waits for network without counting as failure', async () => {
  const api = loadEngine();
  const drive = new FakeDrive();
  drive.faults = ['lose-request'];
  const backend = loadBackend(drive, BASE_PROPS);
  const f = makeFile(3 * MIB, 'p.jpg', 'image/jpeg');
  const { engine, stats } = wire(api, backend, drive, { online: false });
  await engine.uploadFile(newItem(f), hooks(stats));
  assert.strictEqual(stats.waitedOnline, 1);
  assert.deepStrictEqual(stats.sleeps, []);
});

test('session: final errors are not retried, rate limit is', async () => {
  const api = loadEngine();
  const drive = new FakeDrive();
  let backend = loadBackend(drive, BASE_PROPS);
  let w = wire(api, backend, drive);
  await assert.rejects(w.engine.uploadFile(newItem(makeFile(10, 'a.zip', 'application/zip')), hooks(w.stats)),
    (e) => e.code === 'BAD_TYPE' && !e.retryable);
  assert.strictEqual(w.stats.serverCalls.createUploadSession, 1);

  backend = loadBackend(drive, Object.assign({}, BASE_PROPS, { RATE_LIMIT_PER_MIN: '1' }));
  backend.createUploadSession({ code: 'CODE-1234567', fileName: 'x.jpg', mimeType: 'image/jpeg', size: 1 });
  w = wire(api, backend, drive);
  await assert.rejects(w.engine.uploadFile(newItem(makeFile(10, 'a.jpg', 'image/jpeg')), hooks(w.stats)),
    (e) => e.retryable);
  assert.strictEqual(w.stats.serverCalls.createUploadSession, 6);

  backend = loadBackend(drive, BASE_PROPS);
  w = wire(api, backend, drive, { serverDown: { createUploadSession: 2 } });
  await w.engine.uploadFile(newItem(makeFile(10, 'b.jpg', 'image/jpeg')), hooks(w.stats));
  assert.strictEqual(w.stats.serverCalls.createUploadSession, 3);
});

test('session: kill switch during upload stops with CLOSED', async () => {
  const api = loadEngine();
  const drive = new FakeDrive();
  const props = Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy' });
  const backend = loadBackend(drive, props);
  const { engine, stats } = wire(api, backend, drive);
  const item = newItem(makeFile(20 * MIB, 'v.mp4', 'video/mp4'));
  const h = hooks(stats);
  const origProgress = h.onProgress;
  h.onProgress = (b) => { origProgress(b); if (b > 0) props.ENABLED = 'false'; };
  await assert.rejects(engine.uploadFile(item, h), (e) => e.code === 'CLOSED' && !e.retryable);
});

// ----- Engine: proxy mode through Code.gs -----
async function proxyUpload(size, setup, propsExtra) {
  const api = loadEngine();
  const drive = new FakeDrive();
  const backend = loadBackend(drive, Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy' }, propsExtra));
  const f = makeFile(size, 'clip.mov', 'video/quicktime');
  let opts = {};
  if (setup) opts = setup(drive) || {};
  const { engine, stats } = wire(api, backend, drive, opts);
  await engine.uploadFile(newItem(f), hooks(stats));
  assert.strictEqual(drive.files.length, 1);
  assert.ok(drive.files[0].data.equals(f.data), 'data corrupted');
  return stats;
}

test('proxy: multi-chunk upload through backend', async () => {
  const stats = await proxyUpload(10 * MIB + 7);
  assert.strictEqual(stats.serverCalls.uploadChunk, 2);
});

test('proxy: small chunks with prefetch keep data intact, also after partial stores', async () => {
  let stats = await proxyUpload(3 * MIB + 512 * KIB + 5, null, { PROXY_CHUNK_MB: '1' });
  assert.strictEqual(stats.serverCalls.uploadChunk, 4);
  stats = await proxyUpload(3 * MIB + 5, (d) => { d.faults = [null, 'partial', 'lose-response']; },
    { PROXY_CHUNK_MB: '1' });
});

test('proxy: lost response, partial store, 5xx and expiry recover', async () => {
  await proxyUpload(10 * MIB, (d) => { d.faults = ['lose-response']; });
  await proxyUpload(10 * MIB, (d) => { d.faults = ['partial']; });
  await proxyUpload(10 * MIB, (d) => { d.faults = ['server-error', 'lose-request']; });
  await proxyUpload(10 * MIB, (d) => { d.faults = [null, 'expire']; });
  await proxyUpload(4 * MIB, () => ({ serverDown: { uploadChunk: 2 } }));
});

test('mode switch during upload restarts in the new mode', async () => {
  const api = loadEngine();
  const drive = new FakeDrive();
  const props = Object.assign({}, BASE_PROPS, { UPLOAD_MODE: 'proxy' });
  const backend = loadBackend(drive, props);
  const f = makeFile(10 * MIB, 'v.mp4', 'video/mp4');
  const { engine, stats } = wire(api, backend, drive);
  const h = hooks(stats);
  const orig = h.onProgress;
  h.onProgress = (b) => { orig(b); if (b > 0) props.UPLOAD_MODE = 'direct'; };
  await engine.uploadFile(newItem(f), h);
  const done = drive.files.find((x) => x.data.equals(f.data));
  assert.ok(done, 'file not completed after mode switch');
});

test('helpers: parseRangeNext and isVideo', () => {
  const api = loadEngine();
  assert.strictEqual(api.parseRangeNext('bytes=0-99'), 100);
  assert.strictEqual(api.parseRangeNext(null), null);
  assert.strictEqual(api.parseRangeNext('bytes=5-99'), null);
  assert.ok(api.isVideo({ type: '', name: 'a.MOV' }));
  assert.ok(!api.isVideo({ type: 'image/heic', name: 'a.heic' }));
});

test('template markers only where expected', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/index.html'), 'utf8');
  const markers = html.match(/<\?[\s\S]*?\?>/g) || [];
  assert.deepStrictEqual(markers.map((m) => m.replace(/\s+/g, ' ')), [
    "<?= code ?>", "<?= debug ? '1' : '' ?>", '<?= coupleNames ?>', '<?= closingDateText ?>',
  ]);
  assert.ok(!/<\?!=/.test(html), 'no unescaped template output');
  assert.ok(!/https?:\/\/(?!www\.googleapis)/.test(html.replace(/<!--[\s\S]*?-->/g, '')),
    'no external resources');
});


// ----- Gallery -----
const GALLERY_PROPS = Object.assign({}, BASE_PROPS, {
  GALLERY_ENABLED: 'true', GALLERY_USER: 'Gaeste', GALLERY_PASSWORD: 'Galerie-2026x',
  GALLERY_MAX_FILE_MB: '300',
});
// google.script.run passes data as JSON both ways
const viaJson = (b, fn, arg) => JSON.parse(JSON.stringify(b[fn](JSON.parse(JSON.stringify(arg)))));

function galleryWorld(propsExtra) {
  const drive = new FakeDrive();
  const props = Object.assign({}, GALLERY_PROPS, propsExtra || {});
  drive.addGalleryFile({ id: 'photo-0000001', mimeType: 'image/jpeg', parents: [props.FOLDER_ID],
    data: crypto.randomBytes(3000), thumbnailLink: 'https://lh3.googleusercontent.com/t-photo1=s220' });
  drive.addGalleryFile({ id: 'video-0000001', mimeType: 'video/mp4', parents: [props.FOLDER_ID],
    data: crypto.randomBytes(18 * MIB + 123), thumbnailLink: 'https://lh3.googleusercontent.com/t-video1=s220' });
  drive.addGalleryFile({ id: 'trashed-00001', mimeType: 'image/jpeg', parents: [props.FOLDER_ID], trashed: true,
    data: crypto.randomBytes(100), thumbnailLink: 'https://lh3.googleusercontent.com/t-trash=s220' });
  drive.addGalleryFile({ id: 'private-00001', mimeType: 'image/jpeg', parents: ['someone-elses-folder'],
    data: crypto.randomBytes(100), thumbnailLink: 'https://lh3.googleusercontent.com/t-private=s220' });
  drive.addGalleryFile({ id: 'hidden-000001', mimeType: 'image/jpeg', parents: ['subfolder-hidden'],
    data: crypto.randomBytes(100), thumbnailLink: 'https://lh3.googleusercontent.com/t-hidden=s220' });
  drive.addGalleryFile({ id: 'document-0001', mimeType: 'application/pdf', parents: [props.FOLDER_ID],
    data: crypto.randomBytes(100) });
  drive.addGalleryFile({ id: 'evilthumb-001', mimeType: 'image/png', parents: [props.FOLDER_ID],
    data: crypto.randomBytes(100), thumbnailLink: 'https://evil.example.com/steal=s220' });
  const b = loadBackend(drive, props);
  return { drive, props, b };
}

function loginToken(b) {
  const res = viaJson(b, 'openGallery', { user: 'gaeste', password: GALLERY_PROPS.GALLERY_PASSWORD });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  return res.token;
}

test('gallery: closed unless enabled with user and a long enough password', () => {
  const { b } = galleryWorld({ GALLERY_ENABLED: 'false' });
  assert.match(b.doGet({ parameter: { view: 'galerie' } }).content, /Galerie ist noch geschlossen/);
  const short = galleryWorld({ GALLERY_PASSWORD: 'abc' }).b;
  assert.match(short.doGet({ parameter: { view: 'galerie' } }).content, /noch geschlossen/);
  assert.strictEqual(viaJson(short, 'openGallery', { user: 'gaeste', password: 'abc' }).error, 'GALLERY_CLOSED');
  const noUser = galleryWorld({ GALLERY_USER: '' }).b;
  assert.strictEqual(viaJson(noUser, 'openGallery', { user: '', password: 'Galerie-2026x' }).error, 'GALLERY_CLOSED');
  // the old single-code setting alone does not open anything
  const old = galleryWorld({ GALLERY_USER: '', GALLERY_PASSWORD: '', GALLERY_CODE: 'Galerie-2026x' }).b;
  assert.strictEqual(viaJson(old, 'openGallery', { code: 'Galerie-2026x' }).error, 'GALLERY_CLOSED');
});

test('gallery: page works independently of the upload switch, no secrets in the link', () => {
  const { b } = galleryWorld({ ENABLED: 'false' });
  const out = b.doGet({ parameter: { view: 'galerie', g: 'Galerie-2026x' } });
  assert.strictEqual(out.content, 'template:gallery');
  assert.strictEqual(out.template.prefill, undefined);
  // upload page still closed
  assert.match(b.doGet({ parameter: { k: 'CODE-1234567' } }).content, /Upload ist beendet/);
});

test('gallery: wrong login is rejected, right login gives a token, nothing secret returned', () => {
  const { b } = galleryWorld();
  const bad = (arg) => viaJson(b, 'openGallery', arg).error;
  assert.strictEqual(bad({ user: 'gaeste', password: 'wrong' }), 'BAD_LOGIN');
  assert.strictEqual(bad({ user: 'jemand', password: 'Galerie-2026x' }), 'BAD_LOGIN');
  assert.strictEqual(bad({ user: 'gaeste', password: 'galerie-2026x' }), 'BAD_LOGIN', 'password is case-sensitive');
  assert.strictEqual(bad({ password: 'Galerie-2026x' }), 'BAD_LOGIN');
  assert.strictEqual(bad({ user: 'gaeste' }), 'BAD_LOGIN');
  assert.strictEqual(bad({}), 'BAD_LOGIN');
  assert.strictEqual(bad({ code: 'Galerie-2026x' }), 'BAD_LOGIN', 'old single code field is ignored');
  assert.strictEqual(bad({ user: 'gaeste', password: 'CODE-1234567' }), 'BAD_LOGIN',
    'upload code must not open the gallery');
  assert.strictEqual(bad({ user: ['gaeste'], password: { x: 1 } }), 'BAD_LOGIN');
  assert.match(viaJson(b, 'openGallery', { user: 'x', password: 'y' }).message, /Benutzername oder Passwort/);
  // user name ignores case and spaces (phones capitalize), password only trims
  const res = viaJson(b, 'openGallery', { user: ' GAESTE ', password: ' Galerie-2026x ' });
  assert.strictEqual(res.ok, true);
  assert.match(res.token, /^v1\.\d+\.[A-Za-z0-9_-]+$/);
  assert.ok(!JSON.stringify(res).includes('Galerie-2026x'));
  assert.ok(!JSON.stringify(res).includes('SECRET-TOKEN'));
  assert.ok(res.expiresAt > Date.now() + 23 * 3600 * 1000);
});

test('gallery: too many wrong codes lock the login for a while', () => {
  const { b } = galleryWorld();
  for (let i = 0; i < 30; i++) {
    assert.strictEqual(viaJson(b, 'openGallery', { user: 'gaeste', password: 'guess' + i }).error, 'BAD_LOGIN');
  }
  assert.strictEqual(viaJson(b, 'openGallery', { user: 'gaeste', password: 'Galerie-2026x' }).error, 'TOO_MANY_TRIES');
});

test('gallery: missing, forged, expired and outdated tokens are rejected', () => {
  const { drive, props, b } = galleryWorld();
  const token = loginToken(b);
  assert.strictEqual(viaJson(b, 'listGallery', {}).error, 'BAD_TOKEN');
  assert.strictEqual(viaJson(b, 'listGallery', { token: 'v1.9999999999999.abc' }).error, 'BAD_TOKEN');
  const [v, exp, sig] = token.split('.');
  // longer expiry with the old signature
  assert.strictEqual(viaJson(b, 'listGallery', { token: [v, String(Number(exp) + 1000), sig].join('.') }).error, 'BAD_TOKEN');
  // flipped signature character
  const bad = sig[0] === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
  assert.strictEqual(viaJson(b, 'listGallery', { token: [v, exp, bad].join('.') }).error, 'BAD_TOKEN');
  // validly signed but expired
  const expired = b.signGalleryToken_(Date.now() - 1000);
  assert.strictEqual(viaJson(b, 'listGallery', { token: expired }).error, 'BAD_TOKEN');
  // validly signed but claims a life far beyond GALLERY_SESSION_HOURS
  const tooLong = b.signGalleryToken_(Date.now() + 90 * 24 * 3600 * 1000);
  assert.strictEqual(viaJson(b, 'listGallery', { token: tooLong }).error, 'BAD_TOKEN');
  assert.strictEqual(viaJson(b, 'listGallery', { token }).ok, true);
  // changing the password or the user logs everybody out
  const b2 = loadBackend(drive, Object.assign({}, props, { GALLERY_PASSWORD: 'Neues-Passwort-99' }));
  assert.strictEqual(viaJson(b2, 'listGallery', { token }).error, 'BAD_TOKEN');
  const b2u = loadBackend(drive, Object.assign({}, props, { GALLERY_USER: 'familie' }));
  assert.strictEqual(viaJson(b2u, 'listGallery', { token }).error, 'BAD_TOKEN');
  // only the case of the user name changed: still the same login
  const b2c = loadBackend(drive, Object.assign({}, props, { GALLERY_USER: 'GAESTE' }));
  assert.strictEqual(viaJson(b2c, 'listGallery', { token }).ok, true);
  // kill switch
  const b3 = loadBackend(drive, Object.assign({}, props, { GALLERY_ENABLED: 'false' }));
  assert.strictEqual(viaJson(b3, 'listGallery', { token }).error, 'GALLERY_CLOSED');
});

test('gallery: listing shows only photos/videos in the folder, without names or links', () => {
  const { b } = galleryWorld();
  const token = loginToken(b);
  const res = viaJson(b, 'listGallery', { token });
  assert.strictEqual(res.ok, true);
  const ids = res.items.map((i) => i.id).sort();
  assert.deepStrictEqual(ids, ['evilthumb-001', 'photo-0000001', 'video-0000001']);
  const text = JSON.stringify(res);
  assert.ok(!/SECRET-NAME|googleusercontent|evil\.example|SECRET-TOKEN/.test(text), text);
  const video = res.items.find((i) => i.id === 'video-0000001');
  assert.strictEqual(video.kind, 'video');
  assert.strictEqual(video.size, 18 * MIB + 123);
  assert.strictEqual(viaJson(b, 'listGallery', { token, pageToken: 'x'.repeat(3000) }).error, 'BAD_REQUEST');
});

test('gallery: listing pages through large folders', () => {
  const { drive, props, b } = galleryWorld();
  for (let i = 0; i < 100; i++) {
    drive.addGalleryFile({ id: 'bulk-' + String(i).padStart(8, '0'), mimeType: 'image/jpeg',
      parents: [props.FOLDER_ID], data: Buffer.from('x') });
  }
  const token = loginToken(b);
  const seen = new Set();
  let pageToken = '';
  let pages = 0;
  do {
    const res = viaJson(b, 'listGallery', { token, pageToken });
    res.items.forEach((i) => seen.add(i.id));
    pageToken = res.nextPageToken;
    pages++;
  } while (pageToken && pages < 10);
  assert.strictEqual(seen.size, 103);
  assert.strictEqual(pages, 3);
});

test('gallery: thumbnails only for files in the folder, cached, safe hosts only', () => {
  const { drive, b } = galleryWorld();
  const token = loginToken(b);
  // Fresh backend state: ids are checked against Drive, not trusted from the client.
  const res = viaJson(b, 'getGalleryThumbnails', { token,
    ids: ['photo-0000001', 'private-00001', 'trashed-00001', 'hidden-000001', 'document-0001', 'evilthumb-001', 'nonexist-0001'] });
  assert.strictEqual(res.ok, true);
  assert.match(res.thumbs['photo-0000001'], /^data:image\/jpeg;base64,/);
  assert.ok(Buffer.from(res.thumbs['photo-0000001'].split(',')[1], 'base64').toString().endsWith('t-photo1=s400'));
  ['private-00001', 'trashed-00001', 'hidden-000001', 'document-0001', 'evilthumb-001', 'nonexist-0001']
    .forEach((id) => assert.strictEqual(res.thumbs[id], null, id));
  assert.strictEqual(drive.thumbFetches, 1, 'no thumbnail fetched for foreign or unsafe files');
  viaJson(b, 'getGalleryThumbnails', { token, ids: ['photo-0000001'] });
  assert.strictEqual(drive.thumbFetches, 1, 'second request served from cache');
  assert.strictEqual(viaJson(b, 'getGalleryThumbnails', { token, ids: [] }).error, 'BAD_REQUEST');
  assert.strictEqual(viaJson(b, 'getGalleryThumbnails', { token, ids: ['../../etc'] }).error, 'BAD_REQUEST');
  assert.strictEqual(viaJson(b, 'getGalleryThumbnails', { token,
    ids: Array.from({ length: 25 }, (_, i) => 'photo-' + String(i).padStart(7, '0')) }).error, 'BAD_REQUEST');
});

test('gallery: preview uses the large rendition and refuses foreign files', () => {
  const { b } = galleryWorld();
  const token = loginToken(b);
  const res = viaJson(b, 'getGalleryPreview', { token, id: 'photo-0000001' });
  assert.ok(Buffer.from(res.dataUrl.split(',')[1], 'base64').toString().endsWith('t-photo1=s1600'));
  assert.strictEqual(viaJson(b, 'getGalleryPreview', { token, id: 'private-00001' }).error, 'NOT_FOUND');
});

test('gallery: video is streamed in pieces and reassembles byte for byte', async () => {
  const { drive, b } = galleryWorld();
  const token = loginToken(b);
  const helpers = loadGalleryHelpers();
  const file = drive.gfiles.get('video-0000001');
  const progress = [];
  const blob = await helpers.downloadInChunks(file.data.length, file.mimeType,
    async (start) => {
      const res = viaJson(b, 'getGalleryChunk', { token, id: file.id, start });
      if (!res.ok) throw res;
      return res;
    }, (f) => progress.push(f));
  const got = Buffer.from(await blob.arrayBuffer());
  assert.ok(got.equals(file.data), 'bytes differ');
  assert.strictEqual(blob.type, 'video/mp4');
  assert.strictEqual(drive.mediaFetches, 3);
  assert.strictEqual(progress[progress.length - 1], 1);
});

test('gallery: chunks refuse foreign files, odd offsets and oversized files', () => {
  const { drive, props, b } = galleryWorld();
  const token = loginToken(b);
  assert.strictEqual(viaJson(b, 'getGalleryChunk', { token, id: 'private-00001', start: 0 }).error, 'NOT_FOUND');
  assert.strictEqual(viaJson(b, 'getGalleryChunk', { token, id: 'trashed-00001', start: 0 }).error, 'NOT_FOUND');
  assert.strictEqual(viaJson(b, 'getGalleryChunk', { token, id: 'document-0001', start: 0 }).error, 'NOT_FOUND');
  assert.strictEqual(viaJson(b, 'getGalleryChunk', { token, id: 'video-0000001', start: 5 }).error, 'BAD_REQUEST');
  assert.strictEqual(viaJson(b, 'getGalleryChunk', { token, id: 'video-0000001', start: 99 * MIB }).error, 'BAD_REQUEST');
  assert.strictEqual(drive.mediaFetches, 0);
  const small = loadBackend(drive, Object.assign({}, props, { GALLERY_MAX_FILE_MB: '10' }));
  assert.strictEqual(viaJson(small, 'getGalleryChunk', { token, id: 'video-0000001', start: 0 }).error, 'TOO_LARGE_VIEW');
  const one = viaJson(b, 'getGalleryChunk', { token, id: 'photo-0000001', start: 0 });
  assert.ok(Buffer.from(one.base64, 'base64').equals(drive.gfiles.get('photo-0000001').data));
});

test('gallery: Drive failures never throw', () => {
  const drive = new FakeDrive();
  const b = loadBackend(drive, GALLERY_PROPS, { fetchThrows: true });
  const token = loginToken(b);
  ['listGallery', 'getGalleryThumbnails', 'getGalleryPreview', 'getGalleryChunk'].forEach((fn) => {
    const res = viaJson(b, fn, { token, ids: ['photo-0000001'], id: 'photo-0000001', start: 0 });
    assert.strictEqual(res.ok, false, fn);
    assert.ok(!JSON.stringify(res).includes('googleapis'), fn);
  });
});

test('gallery helpers: sizes, durations, chunk plan', () => {
  const h = loadGalleryHelpers();
  assert.strictEqual(h.CHUNK, 8 * MIB);
  assert.deepStrictEqual(Array.from(h.chunkStarts(16 * MIB)), [0, 8 * MIB]);
  assert.deepStrictEqual(Array.from(h.chunkStarts(16 * MIB + 1)), [0, 8 * MIB, 16 * MIB]);
  assert.strictEqual(h.formatBytes(23 * MIB), '23 MB');
  assert.strictEqual(h.formatBytes(1.5 * MIB), '1,5 MB');
  assert.strictEqual(h.formatDuration(83000), '1:23');
  assert.strictEqual(h.extensionFor('video/quicktime'), 'mov');
});

test('gallery template: only escaped markers, no external resources', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/gallery.html'), 'utf8');
  const markers = html.match(/<\?[\s\S]*?\?>/g) || [];
  assert.deepStrictEqual(markers, ['<?= coupleNames ?>']);
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /type="password"[^>]*autocomplete="current-password"/);
  assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no external resources');
  assert.ok(!/innerHTML/.test(html), 'no innerHTML');
});


// ----- Variante B: JSON API and static page -----
const post = (b, body) => {
  const out = b.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  assert.strictEqual(out.mime, 'application/json');
  return JSON.parse(out.text);
};

test('doPost: dispatches only whitelisted functions and never throws', () => {
  const drive = new FakeDrive();
  const b = loadBackend(drive, BASE_PROPS);
  assert.deepStrictEqual(post(b, { fn: 'checkAccess', arg: { code: 'CODE-1234567' } }), { ok: true, mode: 'direct' });
  assert.strictEqual(post(b, { fn: 'checkAccess', arg: { code: 'nope' } }).error, 'BAD_CODE');
  for (const fn of ['testAuth', 'doGet', 'doPost', 'getProp_', 'galleryKey_', 'signGalleryToken_',
    'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.strictEqual(post(b, { fn, arg: {} }).error, 'BAD_REQUEST', fn);
  }
  assert.strictEqual(post(b, '{not json').error, 'BAD_REQUEST');
  assert.strictEqual(post(b, '').error, 'BAD_REQUEST');
  assert.strictEqual(b.doPost(undefined).mime, 'application/json');
  const closed = loadBackend(drive, Object.assign({}, BASE_PROPS, { ENABLED: 'false' }));
  assert.strictEqual(post(closed, { fn: 'checkAccess', arg: { code: 'CODE-1234567' } }).error, 'CLOSED');
});

test('doPost: upload session for the GitHub Pages origin', () => {
  const drive = new FakeDrive();
  const b = loadBackend(drive, BASE_PROPS);
  const res = post(b, { fn: 'createUploadSession', arg: { code: 'CODE-1234567', fileName: 'a.jpg',
    mimeType: 'image/jpeg', size: 1000, guestName: 'Anna', origin: 'https://hochzeitoliviaraphael-art.github.io' } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(drive.lastSessionRequest.headers.Origin, 'https://hochzeitoliviaraphael-art.github.io');
  assert.ok(!JSON.stringify(res).includes('SECRET-TOKEN'));
  assert.strictEqual(post(b, { fn: 'createUploadSession', arg: { code: 'wrong', fileName: 'a.jpg',
    mimeType: 'image/jpeg', size: 1000 } }).error, 'BAD_CODE');
});

test('doPost: gallery works through the JSON API with user and password', () => {
  const { drive, b } = galleryWorld();
  assert.strictEqual(post(b, { fn: 'openGallery', arg: { user: 'gaeste', password: 'nope' } }).error, 'BAD_LOGIN');
  assert.strictEqual(post(b, { fn: 'listGallery', arg: {} }).error, 'BAD_TOKEN');
  assert.strictEqual(post(b, { fn: 'getGalleryChunk', arg: { id: 'video-0000001', start: 0 } }).error, 'BAD_TOKEN');
  const login = post(b, { fn: 'openGallery', arg: { user: 'Gaeste', password: 'Galerie-2026x' } });
  assert.strictEqual(login.ok, true);
  const list = post(b, { fn: 'listGallery', arg: { token: login.token } });
  assert.deepStrictEqual(list.items.map((i) => i.id).sort(), ['evilthumb-001', 'photo-0000001', 'video-0000001']);
  const thumbs = post(b, { fn: 'getGalleryThumbnails', arg: { token: login.token, ids: ['photo-0000001', 'private-00001'] } });
  assert.ok(thumbs.thumbs['photo-0000001'].startsWith('data:image/'));
  assert.strictEqual(thumbs.thumbs['private-00001'], null);
  const chunk = post(b, { fn: 'getGalleryChunk', arg: { token: login.token, id: 'video-0000001', start: 8 * MIB } });
  assert.ok(Buffer.from(chunk.base64, 'base64').equals(drive.gfiles.get('video-0000001').data.subarray(8 * MIB, 16 * MIB)));
  assert.strictEqual(post(b, { fn: 'getGalleryPreview', arg: { token: login.token, id: 'private-00001' } }).error, 'NOT_FOUND');
  const all = JSON.stringify([login, list, thumbs]);
  assert.ok(!/Galerie-2026x|SECRET-TOKEN|folder-/.test(all), 'no secrets in API answers');
});

test('build-pages: static page with config, CSP and no template markers', () => {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  const url = 'https://script.google.com/macros/s/AKfycbTESTtestTEST1234567890/exec';
  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-pages.js')],
    { env: { APPS_SCRIPT_URL: url, OUT_DIR: out }, cwd: ROOT, stdio: 'pipe' });
  const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(!/<\?/.test(html), 'template markers left');
  assert.ok(html.includes('Raphael &amp; Olivia'));
  assert.ok(html.includes('vier Wochen nach der Hochzeit'));
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.ok(html.indexOf('<script src="config.js">') < html.indexOf('<script>\n'), 'config.js first');
  assert.ok(!html.includes('<base target'));
  assert.strictEqual(fs.readFileSync(path.join(out, 'config.js'), 'utf8').includes(JSON.stringify(url)), true);
  assert.ok(fs.existsSync(path.join(out, '.nojekyll')));
  // gallery page
  const gal = fs.readFileSync(path.join(out, 'galerie', 'index.html'), 'utf8');
  assert.ok(!/<\?/.test(gal), 'template markers left in gallery');
  assert.ok(gal.includes('<title>Galerie – Raphael &amp; Olivia</title>'));
  assert.ok(gal.indexOf('<script src="../config.js">') < gal.indexOf('<script>\n'), 'gallery loads config.js first');
  assert.match(gal, /media-src blob:/);
  assert.match(gal, /name="robots" content="noindex, nofollow"/);
  assert.ok(!gal.includes('<base target'));
  assert.ok(!/googleapis/.test(gal.split('</head>')[0]), 'gallery talks only to Apps Script');
  const built = fs.readdirSync(out, { recursive: true }).map(String).sort();
  assert.ok(!built.some((f) => /\.gs$|\.json$/.test(f)), 'no backend files published: ' + built);
  // wrong URL formats are refused
  for (const bad of ['', 'https://evil.example.com/exec',
    'https://script.google.com/macros/u/7/s/AKfycbTESTtestTEST1234567890/exec',
    url + '?k=abc']) {
    assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'tools/build-pages.js')],
      { env: { APPS_SCRIPT_URL: bad, OUT_DIR: out }, cwd: ROOT, stdio: 'pipe' }), bad);
  }
  fs.rmSync(out, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
module.exports = { FakeDrive, loadBackend };
if (require.main === module) (async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log('  ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('  FAIL ' + t.name + '\n       ' + String((e && e.stack) || (e && JSON.stringify(e)) || e).split('\n').slice(0, 4).join('\n       '));
    }
  }
  console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
