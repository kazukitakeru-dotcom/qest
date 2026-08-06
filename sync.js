'use strict';

/* ==========================================================================
   QUEST LIST — 複数端末同期（Supabase）

   このアプリのデータは4つとも「IDを持つレコードの集合」なので、行単位の
   last-write-wins ＋ 墓標で素直に同期できる。ただし2点だけ気をつけている。

   ・消したものは必ず墓標を送る（app.js の dbDelete が自動で残している）。
     墓標が無いと、まだその項目を持っている端末から押し戻されて復活する。
   ・毎朝4時の自動追加は、生成するIDを「テンプレID＋日付」で決め打ちにしてある
     （app.js の processRecurring）。両端末が同じIDを作るので二重に増えない。
     「最後に走らせた日」も端末ローカルではなく meta として同期する。

   外部ライブラリは使わない（PWAをオフラインで完結させるため fetch で直接叩く）。
   ========================================================================== */

const SB_URL = 'https://kafaarlosuvqxxlxpvgg.supabase.co';
const SB_KEY = 'sb_publishable_nSwOQo-YbEtDN_KTjBf80w_D6o0iLoA';

// ログイン状態は6アプリで共通。同じオリジンなので localStorage を共有できる。
// キーを分けていたせいで、アプリの数だけログインが必要になっていた。
const SESSION_KEY    = 'sb_session_v1';
const LEGACY_SESSION_KEY = 'qest_session_v1';
const SYNC_STATE_KEY = 'qest_sync_state_v1';
const ROLLBACK_KEY   = 'qest_rollback_v1';

// サーバー時刻でも「commit の順番」と now() は完全には一致しないので、
// 前回取得位置を少しだけ巻き戻して取りこぼしを防ぐ。重複して取っても害はない。
const PULL_MARGIN_MS = 5000;
const PAGE_SIZE = 1000; // PostgREST の1回あたり上限に合わせる

// 墓標として送った項目の目印
const DELETED_SIG = 'X';

// ========== セッション ==========
function sbLoadSession() {
  try {
    let raw = localStorage.getItem(SESSION_KEY);
    // 旧キー（アプリごとに分かれていた頃のもの）からの引き継ぎ。
    // これがあるので、共通化のためにログインし直す必要はない。
    if (!raw) {
      const old = localStorage.getItem(LEGACY_SESSION_KEY);
      if (old) { localStorage.setItem(SESSION_KEY, old); raw = old; }
    }
    return JSON.parse(raw || 'null');
  } catch (e) { return null; }
}
function sbSaveSession(s) {
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}
function sbIsLoggedIn() { return !!(sbLoadSession() || {}).refresh_token; }

function _storeSession(json) {
  if (!json || !json.access_token) return null;
  const prev = sbLoadSession() || {};
  const s = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in || 3600) * 1000,
    user_id: (json.user && json.user.id) || prev.user_id || null,
    email: (json.user && json.user.email) || prev.email || null,
  };
  sbSaveSession(s);
  return s;
}

async function _authFetch(path, body) {
  const res = await fetch(`${SB_URL}/auth/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.msg || json.message || `HTTP ${res.status}`);
  }
  return json;
}

async function sbSignUp(email, password) {
  const json = await _authFetch('signup', { email, password });
  if (!json.access_token) return { needsConfirmation: true }; // メール確認が有効な場合
  _storeSession(json);
  return { needsConfirmation: false };
}

async function sbSignIn(email, password) {
  _storeSession(await _authFetch('token?grant_type=password', { email, password }));
}

function sbSignOut() {
  sbSaveSession(null);
  _saveSyncState(null);
}

// 有効なアクセストークンを返す（期限が近ければ更新する）
async function sbAccessToken() {
  const s = sbLoadSession();
  if (!s || !s.refresh_token) return null;
  if (s.access_token && Date.now() < s.expires_at - 60000) return s.access_token;
  try {
    const json = await _authFetch('token?grant_type=refresh_token', { refresh_token: s.refresh_token });
    return _storeSession(json).access_token;
  } catch (e) {
    if (/invalid|expired|not found/i.test(e.message)) sbSaveSession(null);
    throw e;
  }
}

// ========== データAPI ==========
async function _rest(path, { method = 'GET', body = null, prefer = null } = {}) {
  const token = await sbAccessToken();
  if (!token) throw new Error('ログインしていません');
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  if (method === 'GET') return res.json().catch(() => []);
  return null;
}

// 1回のGETには件数上限があるので、全部取れるまでページを送る。
// 履歴は完了するたびに増え続けるので、ここを忘れると古い履歴が静かに欠ける。
async function _restAll(path) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = await _rest(`${path}&limit=${PAGE_SIZE}&offset=${offset}`);
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
  }
}

async function _restUpsert(path, rows) {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await _rest(path, {
      method: 'POST',
      body: rows.slice(i, i + CHUNK),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
}

// ========== 変更検出 ==========
function _hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = ((h1 ^ c) * 16777619) >>> 0;
    h2 = ((h2 + c) * 31 + (h2 << 3)) >>> 0;
  }
  return h1.toString(36) + '-' + h2.toString(36) + '-' + str.length.toString(36);
}

// Postgres の jsonb はキーの並び順を保たない。
// 素の JSON.stringify で比べると、中身が同じでも「変わった」と誤判定して
// 送り直しが起き続けるので、キーを並べ替えてから文字列にする。
function _stable(v) {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_stable).join(',') + ']';
  return '{' + Object.keys(v).sort()
    .map(k => JSON.stringify(k) + ':' + _stable(v[k])).join(',') + '}';
}
function _sig(v) { return _hash(_stable(v)); }

function _key(store, id) { return `${store}:${id}`; }

function _emptySyncState() {
  return {
    initialized: false,
    lastPulledAt: null,
    // 'store:id' -> サーバーと一致していると分かっている内容のハッシュ（削除なら 'X'）
    items: {},
    metaHash: null,
    lastSyncedAt: null,
  };
}
function _loadSyncState() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || 'null');
    return (s && typeof s === 'object') ? Object.assign(_emptySyncState(), s) : _emptySyncState();
  } catch (e) { return _emptySyncState(); }
}
function _saveSyncState(s) {
  if (s) localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(s));
  else localStorage.removeItem(SYNC_STATE_KEY);
}

// ========== 取り込み前の巻き戻し用スナップショット ==========
// クラウドの内容を反映する直前に、この端末のデータを丸ごと控えておく。
async function saveRollback(reason) {
  try {
    const snap = { at: Date.now(), reason, stores: {} };
    let total = 0;
    for (const s of STORES) {
      snap.stores[s] = await dbGetAll(s);
      total += snap.stores[s].length;
    }
    if (!total) return; // 空を控えても意味がない
    snap.meta = await dbGet('meta', 'app');
    localStorage.setItem(ROLLBACK_KEY, JSON.stringify(snap));
  } catch (e) { /* 保険が取れなくても本処理は止めない */ }
}

function rollbackInfo() {
  try {
    const snap = JSON.parse(localStorage.getItem(ROLLBACK_KEY) || 'null');
    if (!snap || !snap.stores) return null;
    return { at: snap.at, count: (snap.stores.quests || []).length };
  } catch (e) { return null; }
}

async function restoreRollback() {
  const snap = JSON.parse(localStorage.getItem(ROLLBACK_KEY) || 'null');
  if (!snap || !snap.stores) { alert('戻せる控えがありません。'); return; }
  const when = new Date(snap.at).toLocaleString('ja-JP');
  if (!confirm(`${when} 時点の内容（クエスト${(snap.stores.quests || []).length}件）に戻します。\n今この端末にあるデータは置き換わります。よろしいですか？`)) return;

  for (const s of STORES) {
    for (const item of await dbGetAll(s)) await dbRawDelete(s, item.id);
    for (const item of snap.stores[s] || []) await dbRawPut(s, item);
  }
  if (snap.meta) await dbRawPut('meta', snap.meta);
  // 送信済みの目印を消して、戻した内容を改めてクラウドへ反映させる
  _saveSyncState(null);
  alert('戻しました。再読み込みします。');
  location.reload();
}

// ========== 同期本体 ==========
let _syncing = false;
let _syncTimer = null;
let _lastSyncError = null;

function scheduleSync(delay = 2500) {
  if (!sbIsLoggedIn()) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => { syncNow().catch(() => {}); }, delay);
}

// app.js の dbPut / dbDelete / dbClear から呼ばれる
window.qestOnLocalChange = function () { scheduleSync(); };

// この端末で初めて同期するときだけ、合流するか置き換えるかを決める。
async function firstSyncSetup(sync) {
  if (sync.initialized) return;

  const n = (await dbGetAll('quests')).length + (await dbGetAll('templates')).length;
  if (n > 0) {
    await saveRollback('初回同期の前');
    const merge = confirm(
      `この端末には ${n}件 のクエスト・テンプレートがあります。\n\n` +
      `［OK］この端末の内容もクラウドに合流させる\n` +
      `［キャンセル］クラウドの内容だけを取り込む\n\n` +
      `どちらを選んでも、今の内容は控えに保存され、あとから戻せます。`
    );
    if (!merge) {
      for (const s of STORES) {
        for (const item of await dbGetAll(s)) await dbRawDelete(s, item.id);
      }
      // 置き換えを選んだので、消した記録（墓標）も引き継がない
      for (const t of await dbGetAll('tombstones')) await dbRawDelete('tombstones', t.id);
      await reloadStateFromDb();
    }
  }
  sync.initialized = true;
  _saveSyncState(sync);
}

async function reloadStateFromDb() {
  state.quests    = await dbGetAll('quests');
  state.templates = await dbGetAll('templates');
  state.recurring = await dbGetAll('recurring');
  state.history   = await dbGetAll('history');
  state.meta      = (await dbGet('meta', 'app')) || { id: 'app', lastRecurring: null };
}

// app.js の init() が IndexedDB を開き終わるのを待つ。
// sync.js の方が先に走ることがあるので、db を直接触る前に必ず通す。
async function _waitForDb() {
  for (let i = 0; i < 100 && !db; i++) await new Promise(r => setTimeout(r, 100));
  if (!db) throw new Error('データベースを開けていません');
}

async function syncNow(opts = {}) {
  if (_syncing) return;
  if (!sbIsLoggedIn()) return;
  if (!navigator.onLine) { _lastSyncError = 'オフライン'; updateSyncUI(); return; }

  _syncing = true;
  updateSyncUI();
  try {
    await _waitForDb();
    const sync = _loadSyncState();
    await firstSyncSetup(sync);
    await _pull(sync);
    await _push(sync);
    sync.lastSyncedAt = Date.now();
    _saveSyncState(sync);
    _lastSyncError = null;
    if (opts.toast) alert('同期しました');
  } catch (e) {
    _lastSyncError = e.message || String(e);
    if (opts.toast) alert('同期に失敗しました：' + _lastSyncError);
  } finally {
    _syncing = false;
    updateSyncUI();
  }
}

// この端末での「今の姿」。サーバーと一致しているかの判定に使う。
// 消してある場合は 'X'、そもそも無い場合は null。
async function _localSig(store, id) {
  const item = await dbGet(store, id);
  if (item) return _sig(item);
  const tomb = await dbGet('tombstones', _key(store, id));
  return tomb ? DELETED_SIG : null;
}

// ---- 取得 ----
async function _pull(sync) {
  // 手元が空なのに同期の記録だけ残っている＝ブラウザに保存領域を回収されたなど、
  // 消えるはずのない消え方をした状態。差分だけ取っても戻らないので全件取り直す。
  if (sync.lastPulledAt && Object.keys(sync.items).length) {
    let n = 0;
    for (const s of STORES) n += await dbCount(s);
    if (n === 0) sync.lastPulledAt = null;
  }
  const since = sync.lastPulledAt ? `&updated_at=gt.${encodeURIComponent(sync.lastPulledAt)}` : '';
  const [rows, stateRows] = await Promise.all([
    _restAll(`qest_items?select=store,id,data,deleted,updated_at&order=updated_at.asc,id.asc${since}`),
    _rest('qest_state?select=doc,updated_at&limit=1'),
  ]);
  const remoteDoc = (stateRows && stateRows[0] && stateRows[0].doc) || null;
  if (!rows.length && !remoteDoc) return;

  // これから端末のデータを書き換えるので、直前の状態を控えておく
  await saveRollback('取り込み前');

  let newest = null;
  const bump = ts => { if (ts && (!newest || ts > newest)) newest = ts; };

  for (const row of rows) {
    bump(row.updated_at);
    if (!STORES.includes(row.store)) continue;
    const k = _key(row.store, row.id);

    // この端末にまだ送っていない変更があるなら、そちらを残す。
    // 送信側でサーバーに反映されるので、結局は新しい方に揃う。
    // ただし sig が null（手元に無く、墓標も無い）ときは「消したから無い」のではなく
    // 「理由なく消えている」状態なので、ローカル変更とは見なさずサーバーの内容を取り戻す。
    // ブラウザに保存領域を回収されると、これが無いと二度と復元できなくなる。
    const sig = await _localSig(row.store, row.id);
    if (sig !== null && sync.items[k] !== undefined && sync.items[k] !== sig) continue;

    if (row.deleted) {
      await dbRawDelete(row.store, row.id);
      // 手元にも墓標を残す。残さないと次回こちらから押し戻してしまう。
      await dbRawPut('tombstones', {
        id: k, store: row.store, itemId: row.id,
        at: Date.parse(row.updated_at) || Date.now(),
      });
      sync.items[k] = DELETED_SIG;
    } else {
      await dbRawPut(row.store, row.data);
      await dbRawDelete('tombstones', k);
      sync.items[k] = _sig(row.data);
    }
  }

  // ---- 端末間で共有する小さな値 ----
  if (remoteDoc) {
    bump(stateRows[0].updated_at);
    const meta = (await dbGet('meta', 'app')) || { id: 'app', lastRecurring: null };
    // 「最後に自動追加を走らせた日」は後の日付が勝つ。
    // last-write-wins にすると、古い日付を持った端末が後から書いたときに
    // 自動追加がもう一度走って二重になる。
    const remoteLast = remoteDoc.lastRecurring || null;
    if (remoteLast && (!meta.lastRecurring || remoteLast > meta.lastRecurring)) {
      meta.lastRecurring = remoteLast;
      await dbRawPut('meta', meta);
    }
  }

  await reloadStateFromDb();
  await _reconcile();

  if (newest) {
    sync.lastPulledAt = new Date(Date.parse(newest) - PULL_MARGIN_MS).toISOString();
  }

  try { renderQuests(); } catch (e) {}
}

// 取り込み後の整合。
// 片方の端末で完了したクエストが、まだ持っている側から押し戻されることがある。
// 「履歴にあるものは、もう手持ちのクエストではない」を常に成り立たせる。
async function _reconcile() {
  const done = new Set(state.history.map(h => h.id));
  const strays = state.quests.filter(q => done.has(q.id));
  if (!strays.length) return;
  state.quests = state.quests.filter(q => !done.has(q.id));
  // dbDelete を通すので墓標も残り、相手の端末にも消えたことが伝わる
  for (const q of strays) await dbDelete('quests', q.id);
}

// ---- 送信 ----
async function _push(sync) {
  const userId = (sbLoadSession() || {}).user_id;
  if (!userId) throw new Error('ユーザーIDが取れません');

  const rows = [];

  // --- 手元にある項目のうち、サーバーと違うもの ---
  for (const store of STORES) {
    for (const item of await dbGetAll(store)) {
      const k = _key(store, item.id);
      const sig = _sig(item);
      if (sync.items[k] === sig) continue;
      rows.push({ user_id: userId, store, id: item.id, data: item, deleted: false });
    }
  }

  // --- 消した項目（墓標をまだ送っていないもの） ---
  for (const t of await dbGetAll('tombstones')) {
    if (!STORES.includes(t.store)) continue;
    if (sync.items[t.id] === DELETED_SIG) continue;
    rows.push({ user_id: userId, store: t.store, id: t.itemId, data: {}, deleted: true });
  }

  if (rows.length) {
    await _restUpsert('qest_items?on_conflict=user_id,store,id', rows);
    for (const r of rows) {
      sync.items[_key(r.store, r.id)] = r.deleted ? DELETED_SIG : _sig(r.data);
    }
  }

  // --- 端末間で共有する小さな値 ---
  const meta = (await dbGet('meta', 'app')) || { id: 'app', lastRecurring: null };
  const doc = { lastRecurring: meta.lastRecurring || null };
  const h = _sig(doc);
  if (sync.metaHash !== h) {
    await _rest('qest_state?on_conflict=user_id', {
      method: 'POST',
      body: [{ user_id: userId, doc }],
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    sync.metaHash = h;
  }
}

// ========== 同期のきっかけ ==========
window.addEventListener('online', () => scheduleSync(500));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(300);
});

// ========== 画面 ==========
const $q = id => document.getElementById(id);

function updateSyncUI() {
  const box = $q('sync-status');
  if (!box) return;
  const s = sbLoadSession();

  $q('sync-login-form').classList.toggle('hidden', !!s);
  $q('sync-logged-in').classList.toggle('hidden', !s);

  const rb = rollbackInfo();
  $q('sync-rollback-btn').classList.toggle('hidden', !rb);
  if (rb) $q('sync-rollback-btn').textContent = `取り込み前（クエスト${rb.count}件）に戻す`;

  const summary = $q('sync-summary');
  box.className = 'form-hint';

  if (!s) {
    box.textContent = 'ログインしていません（この端末だけに保存されます）';
    if (summary) summary.textContent = 'この端末だけに保存されています';
    return;
  }
  if (_syncing) {
    box.textContent = '同期中…';
    if (summary) summary.textContent = '同期中…';
    return;
  }
  if (_lastSyncError) {
    box.textContent = `${s.email}／同期できていません（${_lastSyncError}）`;
    box.className = 'form-hint error';
    if (summary) summary.textContent = '同期できていません';
    return;
  }
  const t = _loadSyncState().lastSyncedAt;
  const when = t ? new Date(t).toLocaleString('ja-JP') : 'まだ';
  box.textContent = `${s.email}／最終同期 ${when}`;
  box.className = 'form-hint ok';
  if (summary) summary.textContent = `${s.email}／最終同期 ${when}`;
}

async function submitSyncLogin(mode) {
  const email = $q('sync-email').value.trim();
  const password = $q('sync-password').value;
  const msg = $q('sync-login-msg');
  if (!email || !password) { msg.textContent = 'メールアドレスとパスワードを入力してください'; return; }
  if (mode === 'signup' && password.length < 8) {
    msg.textContent = 'パスワードは8文字以上にしてください'; return;
  }
  msg.textContent = mode === 'signup' ? '登録中…' : 'ログイン中…';
  try {
    if (mode === 'signup') {
      const r = await sbSignUp(email, password);
      if (r.needsConfirmation) {
        msg.textContent = '確認メールを送りました。リンクを開いてから「ログイン」してください。';
        return;
      }
    } else {
      await sbSignIn(email, password);
    }
    msg.textContent = '';
    $q('sync-password').value = '';
    updateSyncUI();
    await syncNow({ toast: true });
  } catch (e) {
    msg.textContent = 'できませんでした：' + (e.message || e);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const on = (id, fn) => { const el = $q(id); if (el) el.addEventListener('click', fn); };
  on('btn-sync', () => { updateSyncUI(); showScreen('screen-sync'); });
  on('btn-sync-back', () => showScreen('screen-settings'));
  on('sync-do-login', () => submitSyncLogin('login'));
  on('sync-do-signup', () => submitSyncLogin('signup'));
  on('sync-now-btn', () => syncNow({ toast: true }));
  on('sync-rollback-btn', restoreRollback);
  on('sync-logout-btn', () => {
    if (!confirm('ログアウトします。ログインを共有している他のアプリもログアウトになります。\nこの端末のデータはそのまま残ります。よろしいですか？')) return;
    sbSignOut();
    updateSyncUI();
  });

  updateSyncUI();
  scheduleSync(1200);
});
