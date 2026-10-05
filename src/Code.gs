/**
 * Wedding photo upload – Google Apps Script backend.
 *
 * Serves the upload page and creates Drive resumable-upload sessions on behalf
 * of the script owner, so guests can upload without a Google account.
 *
 * Configuration lives in Script Properties (see README.md), never in code:
 *   FOLDER_ID, ACCESS_CODE, ENABLED, UPLOAD_MODE, MAX_FILE_MB,
 *   MAX_FILE_MB_PROXY, PROXY_CHUNK_MB, RATE_LIMIT_PER_MIN
 * Gallery (optional, see README "Galerie"):
 *   GALLERY_ENABLED, GALLERY_CODE, GALLERY_SESSION_HOURS, GALLERY_MAX_FILE_MB,
 *   GALLERY_RATE_LIMIT_PER_MIN
 *
 * Security rules:
 *   - The OAuth token never leaves the server.
 *   - Session URLs, tokens and guest names are never logged.
 *   - Public functions never throw; they return { ok: false, error, message }.
 *   - The gallery only ever serves files whose parent is FOLDER_ID, never
 *     other Drive files, even though the script runs with full Drive access.
 */

// ---------------------------------------------------------------------------
// Texts the couple may edit
// ---------------------------------------------------------------------------
const COUPLE_NAMES = 'Raphael & Olivia';
// Shown as: "der Link gilt bis <CLOSING_DATE_TEXT>". Replace with a concrete date if you prefer.
const CLOSING_DATE_TEXT = 'vier Wochen nach der Hochzeit';
const PAGE_TITLE = 'Fotos & Videos teilen';
const GALLERY_TITLE = 'Galerie';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DRIVE_UPLOAD_URL =
  'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
const SESSION_URL_PREFIX = 'https://www.googleapis.com/upload/drive/v3/files?';
const TIME_ZONE = 'Europe/Berlin';
const MIB = 1024 * 1024;
const CHUNK_SIZE_DIRECT = 8 * MIB; // multiple of 256 KiB (Drive requirement)
// Proxy chunk size comes from PROXY_CHUNK_MB (whole MiB, so always a multiple of
// 256 KiB). Fewer, larger chunks mean fewer slow google.script.run round trips.
const PROXY_CHUNK_MB_MIN = 1;
const PROXY_CHUNK_MB_MAX = 32;
const MAX_GUEST_NAME = 40;
const MAX_STORED_NAME = 150;

const DEFAULTS = {
  ENABLED: 'false',
  UPLOAD_MODE: 'direct',
  MAX_FILE_MB: '2048',
  MAX_FILE_MB_PROXY: '500',
  PROXY_CHUNK_MB: '8',
  RATE_LIMIT_PER_MIN: '120',
  GALLERY_ENABLED: 'false',
  GALLERY_SESSION_HOURS: '24',
  GALLERY_MAX_FILE_MB: '300',
  GALLERY_RATE_LIMIT_PER_MIN: '900',
};

const EXTENSION_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
  webm: 'video/webm',
};

const MESSAGES = {
  CLOSED: 'Der Upload ist beendet.',
  BAD_CODE: 'Dieser Link ist nicht gültig.',
  BAD_TYPE: 'Diese Datei ist kein Foto oder Video.',
  TOO_LARGE: 'Diese Datei ist zu groß.',
  EMPTY: 'Diese Datei ist leer.',
  RATE_LIMIT: 'Gerade ist viel los, wir versuchen es gleich noch einmal.',
  DRIVE_ERROR: 'Gerade hakt es. Wir versuchen es gleich noch einmal.',
  BAD_REQUEST: 'Da ist etwas schiefgelaufen. Bitte versucht es noch einmal.',
  SESSION_EXPIRED: 'Der Upload wird neu gestartet.',
  WRONG_MODE: 'Da ist etwas schiefgelaufen. Bitte versucht es noch einmal.',
  GALLERY_CLOSED: 'Die Galerie ist gerade geschlossen.',
  BAD_GALLERY_CODE: 'Der Code stimmt nicht.',
  TOO_MANY_TRIES: 'Zu viele falsche Versuche. Bitte in ein paar Minuten noch einmal.',
  BAD_TOKEN: 'Bitte gebt den Code noch einmal ein.',
  NOT_FOUND: 'Diese Datei gibt es nicht mehr.',
  TOO_LARGE_VIEW: 'Diese Datei ist zu groß für die Galerie.',
};

// ---------------------------------------------------------------------------
// Web app entry point
// ---------------------------------------------------------------------------

/**
 * Serves the upload page, or a short notice when the upload is closed or the
 * access code is wrong.
 * @param {GoogleAppsScript.Events.DoGet} e
 * @return {GoogleAppsScript.HTML.HtmlOutput}
 */
function doGet(e) {
  const params = (e && e.parameter) || {};

  if (params.view === 'galerie') return galleryPage_(params);

  if (!isEnabled_()) {
    return noticePage_('Der Upload ist beendet. Danke!',
      'Vielen Dank für all eure Fotos und Videos.');
  }
  if (!isValidCode_(params.k)) {
    return noticePage_('Dieser Link ist nicht gültig.',
      'Bitte scannt den QR-Code noch einmal oder fragt das Brautpaar nach dem Link.');
  }

  const template = HtmlService.createTemplateFromFile('index');
  template.coupleNames = COUPLE_NAMES;
  template.closingDateText = CLOSING_DATE_TEXT;
  template.code = String(params.k);
  template.debug = params.debug === '1';

  return template.evaluate()
    .setTitle(PAGE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * JSON API for the upload page hosted outside Google (GitHub Pages).
 * The page sends POST text/plain {"fn": "...", "arg": {...}} without cookies,
 * so a browser with several Google accounts signed in still works. Apps Script
 * answers via a redirect to script.googleusercontent.com with CORS allowed.
 * Only the functions below can be called; every function checks the code.
 * @param {GoogleAppsScript.Events.DoPost} e
 * @return {GoogleAppsScript.Content.TextOutput}
 */
function doPost(e) {
  let result;
  try {
    const raw = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!raw || raw.length > 48 * MIB) {
      result = errorResult_('BAD_REQUEST');
    } else {
      const body = JSON.parse(raw);
      const handler = body && typeof body.fn === 'string' &&
        Object.prototype.hasOwnProperty.call(POST_API, body.fn) ? POST_API[body.fn] : null;
      result = handler ? handler(body.arg && typeof body.arg === 'object' ? body.arg : {})
        : errorResult_('BAD_REQUEST');
    }
  } catch (err) {
    console.error('doPost failed: ' + errName_(err));
    result = errorResult_('BAD_REQUEST');
  }
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Lets the external page show "closed" or "invalid link" right away.
 * @param {{code:string}} req
 */
function checkAccess(req) {
  req = req || {};
  if (!isEnabled_()) return errorResult_('CLOSED');
  if (!isValidCode_(req.code)) return errorResult_('BAD_CODE');
  return { ok: true, mode: getMode_() };
}

// ---------------------------------------------------------------------------
// Public API (called via google.script.run or doPost)
// ---------------------------------------------------------------------------

/**
 * Validates an upload request and opens a Drive resumable-upload session.
 * @param {{code:string,fileName:string,mimeType:string,size:number,
 *          guestName:string,origin:string}} req
 * @return {Object} {ok:true, sessionUrl, storedName, mode, chunkSize}
 *   or {ok:false, error, message}
 */
function createUploadSession(req) {
  try {
    req = req || {};
    if (!isEnabled_()) return errorResult_('CLOSED');
    if (!isValidCode_(req.code)) return errorResult_('BAD_CODE');

    const fileName = String(req.fileName || '').slice(0, 500);
    const mimeType = resolveMime_(req.mimeType, fileName);
    if (!mimeType) return errorResult_('BAD_TYPE');

    const size = Number(req.size);
    if (!isFinite(size) || size <= 0 || Math.floor(size) !== size) {
      return errorResult_('EMPTY');
    }
    const mode = getMode_();
    const maxMb = Number(getProp_(mode === 'proxy' ? 'MAX_FILE_MB_PROXY' : 'MAX_FILE_MB'));
    if (size > maxMb * MIB) return errorResult_('TOO_LARGE');

    if (!takeRateLimitSlot_()) return errorResult_('RATE_LIMIT');

    const storedName = buildStoredName_(fileName, mimeType, req.guestName, new Date());

    const headers = {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(size),
    };
    const origin = String(req.origin || '');
    if (mode === 'direct' && /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
      headers.Origin = origin;
    }

    const response = UrlFetchApp.fetch(DRIVE_UPLOAD_URL, {
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      headers: headers,
      payload: JSON.stringify({ name: storedName, parents: [getProp_('FOLDER_ID')] }),
      muteHttpExceptions: true,
      followRedirects: false,
    });

    const status = response.getResponseCode();
    const sessionUrl = getHeader_(response, 'Location');
    if (status !== 200 || !sessionUrl) {
      console.error('createUploadSession: Drive status ' + status +
        (sessionUrl ? '' : ', no Location header'));
      return errorResult_('DRIVE_ERROR');
    }

    return {
      ok: true,
      sessionUrl: sessionUrl,
      storedName: storedName,
      mode: mode,
      chunkSize: mode === 'proxy' ? getProxyChunkSize_() : CHUNK_SIZE_DIRECT,
    };
  } catch (err) {
    console.error('createUploadSession failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

/**
 * Proxy mode: forwards one base64 chunk to the Drive session.
 * @param {{code:string,sessionUrl:string,base64:string,start:number,
 *          total:number,mimeType:string}} req
 * @return {Object} {ok:true, done:boolean, nextOffset:number} or error
 */
function uploadChunk(req) {
  try {
    req = req || {};
    const check = checkSessionRequest_(req);
    if (check) return check;
    if (getMode_() !== 'proxy') return errorResult_('WRONG_MODE');

    const total = Number(req.total);
    const start = Number(req.start);
    if (!isFinite(start) || start < 0 || start >= total || Math.floor(start) !== start) {
      return errorResult_('BAD_REQUEST');
    }
    const bytes = Utilities.base64Decode(String(req.base64 || ''));
    if (!bytes.length || start + bytes.length > total) return errorResult_('BAD_REQUEST');
    // Drive requires every chunk except the last to be a multiple of 256 KiB.
    const isLast = start + bytes.length === total;
    if (!isLast && bytes.length % (256 * 1024) !== 0) return errorResult_('BAD_REQUEST');

    const end = start + bytes.length - 1;
    const mimeType = resolveMime_(req.mimeType, '') || 'application/octet-stream';
    const response = UrlFetchApp.fetch(req.sessionUrl, {
      method: 'put',
      payload: bytes,
      contentType: mimeType,
      headers: { 'Content-Range': 'bytes ' + start + '-' + end + '/' + total },
      followRedirects: false,
      muteHttpExceptions: true,
    });
    return sessionResult_(response, total);
  } catch (err) {
    console.error('uploadChunk failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

/**
 * Proxy mode: asks Drive how many bytes of a session are already stored.
 * Used to resume after a failed chunk.
 * @param {{code:string,sessionUrl:string,total:number}} req
 * @return {Object} {ok:true, done:boolean, nextOffset:number} or error
 */
function getUploadStatus(req) {
  try {
    req = req || {};
    const check = checkSessionRequest_(req);
    if (check) return check;
    const total = Number(req.total);
    const response = UrlFetchApp.fetch(req.sessionUrl, {
      method: 'put',
      payload: '',
      headers: { 'Content-Range': 'bytes */' + total },
      followRedirects: false,
      muteHttpExceptions: true,
    });
    return sessionResult_(response, total);
  } catch (err) {
    console.error('getUploadStatus failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

// ---------------------------------------------------------------------------
// Gallery: guests view all uploads, protected by GALLERY_CODE
// ---------------------------------------------------------------------------
//
// Access model:
//   1. The guest opens ?view=galerie (optionally &g=<code>) and enters the code.
//   2. openGallery() checks the code and returns a signed token with an expiry
//      (HMAC-SHA256, key derived from GALLERY_CODE and FOLDER_ID). Changing
//      GALLERY_CODE therefore logs everybody out immediately.
//   3. Every other gallery call needs a valid token and only ever touches files
//      that are direct, non-trashed children of FOLDER_ID with an image/video
//      type. Moving a file into a subfolder or the trash hides it (within
//      GALLERY_META_TTL seconds).
//   4. Media bytes are streamed through the server; files are never shared
//      publicly and guests never see a Drive link or the owner's token.

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const GALLERY_PAGE_SIZE = 48;
const GALLERY_MAX_THUMBS_PER_CALL = 24;
const GALLERY_THUMB_PX = 400;
const GALLERY_PREVIEW_PX = 1600;
const GALLERY_CHUNK_BYTES = 8 * MIB;
const GALLERY_META_TTL = 300;        // seconds; hidden/deleted files disappear after this
const GALLERY_THUMB_TTL = 6 * 3600;  // thumbnails are shared by all guests
const GALLERY_CACHE_MAX_CHARS = 95000; // CacheService values are limited to 100 KB
const GALLERY_MAX_PREVIEW_BYTES = 6 * MIB;
const GALLERY_FAIL_LIMIT = 30;       // wrong codes per 10 minutes (all guests together)
const GALLERY_TOKEN_VERSION = 'v1';
const FILE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
const THUMB_HOST_PATTERN = /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//;

/** Serves the gallery page (code form + viewer). */
function galleryPage_(params) {
  if (!isGalleryEnabled_()) {
    return noticePage_('Die Galerie ist noch geschlossen.',
      'Schaut später noch einmal vorbei. Das Brautpaar sagt Bescheid.');
  }
  const template = HtmlService.createTemplateFromFile('gallery');
  template.coupleNames = COUPLE_NAMES;
  const prefill = String(params.g || '');
  template.prefill = /^[A-Za-z0-9_-]{1,64}$/.test(prefill) ? prefill : '';
  return template.evaluate()
    .setTitle(GALLERY_TITLE + ' – ' + COUPLE_NAMES)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/**
 * Checks the gallery code and returns a signed, expiring token.
 * @param {{code:string}} req
 * @return {Object} {ok:true, token, expiresAt, maxFileBytes} or error
 */
function openGallery(req) {
  try {
    req = req || {};
    if (!isGalleryEnabled_()) return errorResult_('GALLERY_CLOSED');
    const cache = CacheService.getScriptCache();
    const failKey = 'gf_' + Math.floor(Date.now() / 600000);
    const fails = Number(cache.get(failKey) || 0);
    if (fails >= GALLERY_FAIL_LIMIT) return errorResult_('TOO_MANY_TRIES');

    const expected = getProp_('GALLERY_CODE');
    const code = typeof req.code === 'string' ? req.code.trim() : '';
    if (!expected || !code || !safeEqual_(code, expected)) {
      cache.put(failKey, String(fails + 1), 900);
      if (typeof Utilities.sleep === 'function') Utilities.sleep(700); // slows guessing
      return errorResult_('BAD_GALLERY_CODE');
    }

    const expiresAt = Date.now() + getGallerySessionHours_() * 3600 * 1000;
    return {
      ok: true,
      token: signGalleryToken_(expiresAt),
      expiresAt: expiresAt,
      maxFileBytes: getGalleryMaxFileBytes_(),
    };
  } catch (err) {
    console.error('openGallery failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

/**
 * Lists photos and videos in the upload folder, newest first.
 * @param {{token:string, pageToken:string}} req
 * @return {Object} {ok:true, items:[...], nextPageToken} or error
 */
function listGallery(req) {
  try {
    req = req || {};
    const check = checkGalleryRequest_(req);
    if (check) return check;

    const folderId = getProp_('FOLDER_ID');
    if (!FILE_ID_PATTERN.test(folderId)) return errorResult_('DRIVE_ERROR');
    const query = "'" + folderId + "' in parents and trashed = false and " +
      "(mimeType contains 'image/' or mimeType contains 'video/')";
    const fields = 'nextPageToken,files(id,mimeType,size,createdTime,thumbnailLink,' +
      'imageMediaMetadata(width,height,rotation),videoMediaMetadata(width,height,durationMillis))';
    let url = DRIVE_FILES_URL + '?q=' + encodeURIComponent(query) +
      '&orderBy=' + encodeURIComponent('createdTime desc') +
      '&pageSize=' + GALLERY_PAGE_SIZE +
      '&fields=' + encodeURIComponent(fields) +
      '&spaces=drive';
    const pageToken = String(req.pageToken || '');
    if (pageToken) {
      if (pageToken.length > 2048) return errorResult_('BAD_REQUEST');
      url += '&pageToken=' + encodeURIComponent(pageToken);
    }

    const response = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    });
    if (response.getResponseCode() !== 200) {
      console.error('listGallery: Drive status ' + response.getResponseCode());
      return errorResult_('DRIVE_ERROR');
    }
    const data = JSON.parse(response.getContentText());
    const files = (data.files || []).filter(function (f) {
      return FILE_ID_PATTERN.test(f.id) && isMediaMime_(f.mimeType);
    });

    // The query itself proves folder membership, so cache the metadata for the
    // thumbnail/preview/chunk calls that follow.
    const toCache = {};
    files.forEach(function (f) { toCache['gm_' + f.id] = JSON.stringify(metaFromFile_(f)); });
    if (files.length) CacheService.getScriptCache().putAll(toCache, GALLERY_META_TTL);

    return {
      ok: true,
      items: files.map(function (f) {
        const img = f.imageMediaMetadata || {};
        const vid = f.videoMediaMetadata || {};
        const rotated = img.rotation === 1 || img.rotation === 3;
        return {
          id: f.id,
          kind: String(f.mimeType).indexOf('video/') === 0 ? 'video' : 'image',
          mimeType: f.mimeType,
          size: Number(f.size) || 0,
          created: f.createdTime || '',
          width: Number(rotated ? img.height : (img.width || vid.width)) || 0,
          height: Number(rotated ? img.width : (img.height || vid.height)) || 0,
          durationMs: Number(vid.durationMillis) || 0,
          hasThumb: !!f.thumbnailLink,
        };
      }),
      nextPageToken: data.nextPageToken || '',
    };
  } catch (err) {
    console.error('listGallery failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

/**
 * Returns small JPEG thumbnails as data URLs for up to 24 files.
 * @param {{token:string, ids:string[]}} req
 * @return {Object} {ok:true, thumbs:{id: dataUrl|null}} or error
 */
function getGalleryThumbnails(req) {
  try {
    req = req || {};
    const check = checkGalleryRequest_(req);
    if (check) return check;
    const ids = Array.isArray(req.ids) ? req.ids : [];
    if (!ids.length || ids.length > GALLERY_MAX_THUMBS_PER_CALL ||
        !ids.every(function (id) { return typeof id === 'string' && FILE_ID_PATTERN.test(id); })) {
      return errorResult_('BAD_REQUEST');
    }

    const metas = getGalleryMetas_(ids);
    const cache = CacheService.getScriptCache();
    const thumbs = {};
    const allowed = ids.filter(function (id) { return metas[id]; });
    ids.forEach(function (id) { thumbs[id] = null; });

    const cached = allowed.length ? cache.getAll(allowed.map(function (id) { return 'gt_' + id; })) : {};
    const missing = [];
    allowed.forEach(function (id) {
      if (cached['gt_' + id]) thumbs[id] = cached['gt_' + id];
      else if (metas[id].thumb) missing.push(id);
    });

    const fetched = fetchImages_(missing.map(function (id) {
      return sizedThumbUrl_(metas[id].thumb, GALLERY_THUMB_PX);
    }), 400000);
    const toCache = {};
    missing.forEach(function (id, i) {
      if (!fetched[i]) return;
      thumbs[id] = fetched[i];
      if (fetched[i].length <= GALLERY_CACHE_MAX_CHARS) toCache['gt_' + id] = fetched[i];
    });
    if (Object.keys(toCache).length) cache.putAll(toCache, GALLERY_THUMB_TTL);
    return { ok: true, thumbs: thumbs };
  } catch (err) {
    console.error('getGalleryThumbnails failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

/**
 * Returns a large rendition (max 1600 px) as a data URL: the photo itself, or
 * the poster frame of a video.
 * @param {{token:string, id:string}} req
 */
function getGalleryPreview(req) {
  try {
    req = req || {};
    const check = checkGalleryRequest_(req);
    if (check) return check;
    if (typeof req.id !== 'string' || !FILE_ID_PATTERN.test(req.id)) return errorResult_('BAD_REQUEST');
    const meta = getGalleryMetas_([req.id])[req.id];
    if (!meta) return errorResult_('NOT_FOUND');
    if (!meta.thumb) return { ok: true, dataUrl: null };
    const dataUrl = fetchImages_([sizedThumbUrl_(meta.thumb, GALLERY_PREVIEW_PX)],
      Math.ceil(GALLERY_MAX_PREVIEW_BYTES * 4 / 3) + 64)[0];
    return { ok: true, dataUrl: dataUrl || null };
  } catch (err) {
    console.error('getGalleryPreview failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

/**
 * Returns one 8 MiB piece of the original file (base64), for playing videos
 * and saving originals. The browser joins the pieces into a Blob.
 * @param {{token:string, id:string, start:number}} req
 * @return {Object} {ok:true, base64, start, end, total, mimeType} or error
 */
function getGalleryChunk(req) {
  try {
    req = req || {};
    const check = checkGalleryRequest_(req);
    if (check) return check;
    if (typeof req.id !== 'string' || !FILE_ID_PATTERN.test(req.id)) return errorResult_('BAD_REQUEST');
    const meta = getGalleryMetas_([req.id])[req.id];
    if (!meta) return errorResult_('NOT_FOUND');
    const total = meta.size;
    if (!(total > 0)) return errorResult_('NOT_FOUND');
    if (total > getGalleryMaxFileBytes_()) return errorResult_('TOO_LARGE_VIEW');

    const start = Number(req.start);
    if (!isFinite(start) || start < 0 || start >= total || Math.floor(start) !== start ||
        start % GALLERY_CHUNK_BYTES !== 0) {
      return errorResult_('BAD_REQUEST');
    }
    const end = Math.min(start + GALLERY_CHUNK_BYTES, total) - 1;

    const response = UrlFetchApp.fetch(
      DRIVE_FILES_URL + '/' + encodeURIComponent(req.id) + '?alt=media', {
        headers: {
          Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
          Range: 'bytes=' + start + '-' + end,
        },
        muteHttpExceptions: true,
      });
    const status = response.getResponseCode();
    if (status === 404) return errorResult_('NOT_FOUND');
    if (status !== 206 && !(status === 200 && start === 0 && end === total - 1)) {
      console.error('getGalleryChunk: Drive status ' + status);
      return errorResult_('DRIVE_ERROR');
    }
    const bytes = response.getContent();
    if (bytes.length !== end - start + 1) {
      console.error('getGalleryChunk: unexpected length ' + bytes.length);
      return errorResult_('DRIVE_ERROR');
    }
    return {
      ok: true,
      base64: Utilities.base64Encode(bytes),
      start: start,
      end: end,
      total: total,
      mimeType: meta.mimeType,
    };
  } catch (err) {
    console.error('getGalleryChunk failed: ' + errName_(err));
    return errorResult_('DRIVE_ERROR');
  }
}

// --- gallery helpers --------------------------------------------------------

function isGalleryEnabled_() {
  return getProp_('GALLERY_ENABLED') === 'true' && getProp_('GALLERY_CODE').length >= 8 &&
    FILE_ID_PATTERN.test(getProp_('FOLDER_ID'));
}

function getGallerySessionHours_() {
  const h = Number(getProp_('GALLERY_SESSION_HOURS'));
  return isFinite(h) && h > 0 ? Math.min(h, 24 * 30) : Number(DEFAULTS.GALLERY_SESSION_HOURS);
}

function getGalleryMaxFileBytes_() {
  const mb = Number(getProp_('GALLERY_MAX_FILE_MB'));
  return (isFinite(mb) && mb > 0 ? Math.min(mb, 2048) : Number(DEFAULTS.GALLERY_MAX_FILE_MB)) * MIB;
}

/** Common checks for every gallery call except openGallery. */
function checkGalleryRequest_(req) {
  if (!isGalleryEnabled_()) return errorResult_('GALLERY_CLOSED');
  if (!verifyGalleryToken_(req.token)) return errorResult_('BAD_TOKEN');
  if (!takeGallerySlot_()) return errorResult_('RATE_LIMIT');
  return null;
}

function galleryKey_() {
  // Bound to the code and the folder: changing either invalidates all tokens.
  return 'gallery|' + getProp_('GALLERY_CODE') + '|' + getProp_('FOLDER_ID');
}

function signGalleryToken_(expiresAt) {
  const payload = GALLERY_TOKEN_VERSION + '.' + Math.floor(expiresAt);
  const sig = Utilities.computeHmacSha256Signature(payload, galleryKey_());
  return payload + '.' + Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

function verifyGalleryToken_(token) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== GALLERY_TOKEN_VERSION || !/^\d{10,16}$/.test(parts[1])) {
    return false;
  }
  const expiresAt = Number(parts[1]);
  const now = Date.now();
  // Reject expired tokens and tokens that claim a longer life than allowed.
  if (expiresAt <= now || expiresAt > now + getGallerySessionHours_() * 3600 * 1000 + 60000) {
    return false;
  }
  return safeEqual_(token, signGalleryToken_(expiresAt));
}

/** Constant-time string comparison. */
function safeEqual_(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function takeGallerySlot_() {
  const limit = Number(getProp_('GALLERY_RATE_LIMIT_PER_MIN'));
  if (!isFinite(limit) || limit <= 0) return true;
  const cache = CacheService.getScriptCache();
  const key = 'gr_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHHmm');
  const count = Number(cache.get(key) || 0);
  if (count >= limit) return false;
  cache.put(key, String(count + 1), 120);
  return true;
}

function isMediaMime_(mimeType) {
  const t = String(mimeType || '');
  return (t.indexOf('image/') === 0 || t.indexOf('video/') === 0) && t !== 'image/svg+xml';
}

function metaFromFile_(f) {
  return {
    mimeType: String(f.mimeType || ''),
    size: Number(f.size) || 0,
    thumb: THUMB_HOST_PATTERN.test(String(f.thumbnailLink || '')) ? f.thumbnailLink : '',
  };
}

/**
 * Returns {id: meta|null} for the given ids. A file only gets a meta object if
 * it is a non-trashed image/video directly inside FOLDER_ID. Unknown ids are
 * looked up in Drive (in parallel) and the result is cached briefly.
 */
function getGalleryMetas_(ids) {
  const cache = CacheService.getScriptCache();
  const result = {};
  const cached = cache.getAll(ids.map(function (id) { return 'gm_' + id; }));
  const missing = [];
  ids.forEach(function (id) {
    const raw = cached['gm_' + id];
    if (raw === undefined || raw === null) { missing.push(id); return; }
    result[id] = raw === 'none' ? null : JSON.parse(raw);
  });
  if (!missing.length) return result;

  const folderId = getProp_('FOLDER_ID');
  const fields = 'id,mimeType,size,trashed,parents,thumbnailLink';
  const responses = UrlFetchApp.fetchAll(missing.map(function (id) {
    return {
      url: DRIVE_FILES_URL + '/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent(fields),
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
    };
  }));
  const toCache = {};
  missing.forEach(function (id, i) {
    let meta = null;
    const status = responses[i].getResponseCode();
    if (status === 200) {
      const f = JSON.parse(responses[i].getContentText());
      if (f.id === id && !f.trashed && isMediaMime_(f.mimeType) &&
          Array.isArray(f.parents) && f.parents.indexOf(folderId) !== -1) {
        meta = metaFromFile_(f);
      }
    } else if (status !== 404) {
      // Transient error: do not cache a negative answer.
      result[id] = null;
      return;
    }
    result[id] = meta;
    toCache['gm_' + id] = meta ? JSON.stringify(meta) : 'none';
  });
  if (Object.keys(toCache).length) cache.putAll(toCache, GALLERY_META_TTL);
  return result;
}

/** "...=s220" → "...=s400". Drive thumbnail links take the size as a suffix. */
function sizedThumbUrl_(link, px) {
  const base = String(link).replace(/=s\d+(-[a-z0-9-]*)?$/i, '');
  return base + '=s' + px;
}

/**
 * Fetches images in parallel and returns data URLs (null on failure or when
 * the data URL would be longer than maxChars). Drive thumbnail links are signed
 * and usually work without a token; on failure we retry once with the token.
 */
function fetchImages_(urls, maxChars) {
  const out = urls.map(function () { return null; });
  if (!urls.length) return out;
  const valid = urls.map(function (u) { return THUMB_HOST_PATTERN.test(u); });

  function attempt(indexes, withAuth) {
    if (!indexes.length) return [];
    const responses = UrlFetchApp.fetchAll(indexes.map(function (i) {
      const r = { url: urls[i], muteHttpExceptions: true, followRedirects: true };
      if (withAuth) r.headers = { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() };
      return r;
    }));
    const failed = [];
    indexes.forEach(function (i, n) {
      const response = responses[n];
      const type = String(getHeader_(response, 'Content-Type') || '').split(';')[0].trim();
      if (response.getResponseCode() === 200 && /^image\/(jpeg|png|webp|gif)$/.test(type)) {
        const dataUrl = 'data:' + type + ';base64,' + Utilities.base64Encode(response.getContent());
        if (dataUrl.length <= maxChars) out[i] = dataUrl;
      } else {
        failed.push(i);
      }
    });
    return failed;
  }

  const first = urls.map(function (_, i) { return i; }).filter(function (i) { return valid[i]; });
  attempt(attempt(first, false), true);
  return out;
}

// ---------------------------------------------------------------------------
// Owner tools (run manually from the editor)
// ---------------------------------------------------------------------------

/**
 * Triggers the authorization dialog and checks the configuration.
 * Read-only: creates nothing, changes nothing. Run once from the editor.
 */
function testAuth() {
  const problems = [];
  ['FOLDER_ID', 'ACCESS_CODE', 'ENABLED'].forEach(function (name) {
    if (!PropertiesService.getScriptProperties().getProperty(name)) {
      problems.push('Script Property fehlt: ' + name);
    }
  });
  const mode = getMode_();
  const rawMode = PropertiesService.getScriptProperties().getProperty('UPLOAD_MODE');
  if (rawMode && rawMode !== mode) problems.push('UPLOAD_MODE ist ungültig: ' + rawMode);
  const code = PropertiesService.getScriptProperties().getProperty('ACCESS_CODE') || '';
  if (code && code.length < 10) problems.push('ACCESS_CODE ist kürzer als 10 Zeichen.');
  if (code && !/^[A-Za-z0-9_-]+$/.test(code)) {
    problems.push('ACCESS_CODE sollte nur Buchstaben, Ziffern, - und _ enthalten.');
  }

  const folderId = PropertiesService.getScriptProperties().getProperty('FOLDER_ID');
  if (folderId) {
    const response = UrlFetchApp.fetch(
      'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(folderId) +
      '?fields=name,mimeType,capabilities/canAddChildren',
      { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true });
    const status = response.getResponseCode();
    if (status === 403) {
      problems.push('Zugriff verweigert (Status 403). Prüfen: (1) Drive API unter ' +
        '"Dienste" hinzugefügt bzw. im Manifest eingetragen, (2) oauthScopes im Manifest, ' +
        '(3) Ordner liegt im selben Google-Konto wie das Script.');
    } else if (status === 404) {
      problems.push('Ordner nicht gefunden (Status 404). FOLDER_ID prüfen: nur die ID ' +
        'nach /folders/, ohne ?usp=sharing und ohne Leerzeichen.');
    } else if (status !== 200) {
      problems.push('Drive antwortet mit Status ' + status + '.');
    } else {
      const file = JSON.parse(response.getContentText());
      if (file.mimeType !== 'application/vnd.google-apps.folder') {
        problems.push('FOLDER_ID zeigt nicht auf einen Ordner.');
      } else if (!file.capabilities || !file.capabilities.canAddChildren) {
        problems.push('Keine Schreibrechte im Ordner.');
      } else {
        console.log('Ordner gefunden: ' + file.name);
      }
    }
  }

  const galleryOn = getProp_('GALLERY_ENABLED') === 'true';
  const galleryCode = getProp_('GALLERY_CODE');
  if (galleryOn && galleryCode.length < 8) {
    problems.push('Galerie: GALLERY_CODE fehlt oder ist kürzer als 8 Zeichen, die Galerie bleibt zu.');
  }
  if (galleryCode && galleryCode === getProp_('ACCESS_CODE')) {
    problems.push('Galerie: GALLERY_CODE sollte sich vom ACCESS_CODE unterscheiden.');
  }
  if (galleryCode && !/^[A-Za-z0-9_-]+$/.test(galleryCode)) {
    problems.push('Galerie: GALLERY_CODE sollte nur Buchstaben, Ziffern, - und _ enthalten.');
  }

  console.log('Modus: ' + mode + ', ENABLED: ' + isEnabled_() +
    ', Galerie: ' + (isGalleryEnabled_() ? 'offen' : 'geschlossen'));
  if (problems.length) {
    console.warn('Probleme:\n- ' + problems.join('\n- '));
  } else {
    console.log('Alles in Ordnung.');
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProp_(name) {
  const value = PropertiesService.getScriptProperties().getProperty(name);
  if (value === null || value === undefined || value === '') {
    return Object.prototype.hasOwnProperty.call(DEFAULTS, name) ? DEFAULTS[name] : '';
  }
  return String(value).trim();
}

function getProxyChunkSize_() {
  let mb = Math.floor(Number(getProp_('PROXY_CHUNK_MB')));
  if (!isFinite(mb)) mb = Number(DEFAULTS.PROXY_CHUNK_MB);
  mb = Math.min(PROXY_CHUNK_MB_MAX, Math.max(PROXY_CHUNK_MB_MIN, mb));
  return mb * MIB;
}

function isEnabled_() {
  return getProp_('ENABLED') === 'true';
}

function getMode_() {
  return getProp_('UPLOAD_MODE') === 'proxy' ? 'proxy' : 'direct';
}

function isValidCode_(code) {
  const expected = getProp_('ACCESS_CODE');
  return !!expected && typeof code === 'string' && code === expected;
}

/** Common checks for requests that address an existing session. */
function checkSessionRequest_(req) {
  if (!isEnabled_()) return errorResult_('CLOSED');
  if (!isValidCode_(req.code)) return errorResult_('BAD_CODE');
  const url = String(req.sessionUrl || '');
  // SSRF guard: only Drive upload sessions, no other hosts or paths.
  if (url.indexOf(SESSION_URL_PREFIX) !== 0 || /[\s#]/.test(url)) {
    return errorResult_('BAD_REQUEST');
  }
  const total = Number(req.total);
  if (!isFinite(total) || total <= 0 || Math.floor(total) !== total) {
    return errorResult_('BAD_REQUEST');
  }
  return null;
}

/**
 * Maps a Drive session response to {ok, done, nextOffset}.
 * A 308 without a Range header means Drive has stored no bytes yet.
 * @param {*} response UrlFetchApp response
 * @param {number} total file size in bytes
 */
function sessionResult_(response, total) {
  const status = response.getResponseCode();
  if (status === 200 || status === 201) {
    return { ok: true, done: true, nextOffset: total };
  }
  if (status === 308) {
    const next = parseRangeNext_(getHeader_(response, 'Range'));
    return { ok: true, done: false, nextOffset: next === null ? 0 : next };
  }
  if (status === 404 || status === 410) return errorResult_('SESSION_EXPIRED');
  console.error('Drive session status ' + status);
  return errorResult_('DRIVE_ERROR');
}

/** "bytes=0-1234" → 1235; anything else → null. */
function parseRangeNext_(range) {
  const match = /^bytes=0-(\d+)$/.exec(String(range || '').trim());
  return match ? Number(match[1]) + 1 : null;
}

/** Case-insensitive response header lookup. */
function getHeader_(response, name) {
  const all = (response.getAllHeaders && response.getAllHeaders()) || response.getHeaders();
  const wanted = name.toLowerCase();
  for (const key in all) {
    if (Object.prototype.hasOwnProperty.call(all, key) && key.toLowerCase() === wanted) {
      const value = all[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

/**
 * Returns an allowed image/video MIME type, or null if the file is not allowed.
 * A browser-supplied image/* or video/* type is trusted; otherwise the type is
 * derived from the file extension.
 */
function resolveMime_(mimeType, fileName) {
  const type = String(mimeType || '').toLowerCase().trim();
  if (/^(image|video)\/[a-z0-9.+-]+$/.test(type) && type !== 'image/svg+xml') {
    return type;
  }
  return guessMime_(fileName);
}

function guessMime_(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
  if (!match) return null;
  return EXTENSION_MIME[match[1].toLowerCase()] || null;
}

/**
 * Keeps Unicode letters, digits, dot, dash, underscore and space; replaces
 * everything else with "_", collapses repeats and trims.
 */
function sanitize_(str, maxLen) {
  let s = String(str || '').normalize('NFC');
  s = s.replace(/[^\p{L}\p{M}\p{N}._\- ]/gu, '_');
  s = s.replace(/_{2,}/g, '_').replace(/ {2,}/g, ' ');
  s = s.replace(/^[\s._-]+|[\s_-]+$/g, '');
  if (maxLen && s.length > maxLen) s = Array.from(s).slice(0, maxLen).join('').trim();
  return s;
}

function formatTs_(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'yyyyMMdd-HHmmss');
}

/** YYYYMMDD-HHmmss[_Guest]_Original.ext, max 150 characters. */
function buildStoredName_(fileName, mimeType, guestName, date) {
  const prefix = formatTs_(date);
  const guest = sanitize_(guestName, MAX_GUEST_NAME);

  let base = String(fileName || '').split(/[\\/]/).pop();
  let ext = '';
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    ext = sanitize_(base.slice(dot + 1), 10).toLowerCase();
    base = base.slice(0, dot);
  }
  if (!ext) {
    ext = extensionForMime_(mimeType);
  }
  base = sanitize_(base, MAX_STORED_NAME) || 'datei';

  const head = prefix + (guest ? '_' + guest : '') + '_';
  const tail = ext ? '.' + ext : '';
  const room = Math.max(1, MAX_STORED_NAME - head.length - tail.length);
  if (base.length > room) base = Array.from(base).slice(0, room).join('').replace(/[\s._-]+$/, '') || 'datei';
  return head + base + tail;
}

function extensionForMime_(mimeType) {
  for (const ext in EXTENSION_MIME) {
    if (EXTENSION_MIME[ext] === mimeType) return ext;
  }
  return '';
}

/**
 * Coarse global rate limit: counts sessions per minute in the script cache.
 * Not atomic; small overshoots are acceptable.
 */
function takeRateLimitSlot_() {
  const limit = Number(getProp_('RATE_LIMIT_PER_MIN'));
  if (!isFinite(limit) || limit <= 0) return true;
  const cache = CacheService.getScriptCache();
  const key = 'rl_' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHHmm');
  const count = Number(cache.get(key) || 0);
  if (count >= limit) return false;
  cache.put(key, String(count + 1), 120);
  return true;
}

function errorResult_(code, message) {
  return { ok: false, error: code, message: message || MESSAGES[code] || MESSAGES.BAD_REQUEST };
}

function errName_(err) {
  const text = (err && err.name ? err.name + ': ' : '') +
    (err && err.message ? err.message : String(err));
  return text.replace(/https:\/\/\S+/g, '[url]');
}

/** Small standalone page for "closed" and "invalid link". */
function noticePage_(title, text) {
  const html =
    '<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">' +
    '<style>' +
    'body{margin:0;font:18px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'background:#faf7f2;color:#2b2622;display:flex;min-height:100vh;align-items:center;justify-content:center;}' +
    'main{max-width:30rem;padding:2rem 1.25rem;text-align:center;}' +
    'h1{font:600 1.6rem/1.25 Georgia,"Times New Roman",serif;margin:0 0 .75rem;}' +
    'p{margin:0;color:#5b524a;}' +
    '</style></head><body><main>' +
    '<h1>' + escapeHtml_(title) + '</h1><p>' + escapeHtml_(text) + '</p>' +
    '</main></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(PAGE_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Functions reachable through doPost. Declared last so all functions exist.
const POST_API = {
  checkAccess: checkAccess,
  createUploadSession: createUploadSession,
  uploadChunk: uploadChunk,
  getUploadStatus: getUploadStatus,
};
