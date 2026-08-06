// ============================================================
//  QUEST LIST APP
// ============================================================

// ---- DB ----
const DB_NAME    = 'questlist';
const DB_VERSION = 2;
const STORES     = ['quests', 'templates', 'recurring', 'history'];

// 同期のための内部ストア。バックアップの書き出し・復元の対象にはしない。
//   tombstones … 消したものの墓標。これが無いと、まだその項目を持っている端末から
//                押し戻されて復活する。
//   meta       … 「毎朝4時の自動追加を最後に走らせた日」など、端末間で共有したい小さな値。
const INTERNAL_STORES = ['tombstones', 'meta'];

// 墓標は同期し終われば用済みだが、長く開いていなかった端末が後から繋がる場合に備えて1年持つ。
const TOMB_KEEP_MS = 365 * 24 * 60 * 60 * 1000;

let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      [...STORES, ...INTERNAL_STORES].forEach(name => {
        if (!d.objectStoreNames.contains(name))
          d.createObjectStore(name, { keyPath: 'id' });
      });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbCount(store) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function dbGet(store, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ---- 生の読み書き（墓標を動かさない） ----
function dbRawPut(store, item) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).put(item);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

function dbRawDelete(store, id) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ---- アプリが使う入口。ここで墓標の面倒を見るので、呼ぶ側は今までどおりでよい ----
function tombKey(store, id) { return `${store}:${id}`; }

async function dbPut(store, item) {
  await dbRawPut(store, item);
  // 元に戻す（undo）で復活させたときは墓標を取り下げる
  if (STORES.includes(store)) await dbRawDelete('tombstones', tombKey(store, item.id));
  notifyLocalChange();
}

async function dbDelete(store, id) {
  await dbRawDelete(store, id);
  // 同期を使っていなくても記録しておく（軽いし、後からログインしても筋が通る）
  if (STORES.includes(store)) {
    await dbRawPut('tombstones', { id: tombKey(store, id), store, itemId: id, at: Date.now() });
  }
  notifyLocalChange();
}

async function dbClear(store) {
  if (STORES.includes(store)) {
    const at = Date.now();
    for (const item of await dbGetAll(store)) {
      await dbRawPut('tombstones', { id: tombKey(store, item.id), store, itemId: item.id, at });
    }
  }
  await new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readwrite').objectStore(store).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
  notifyLocalChange();
}

// sync.js が読み込まれていれば同期を予約させる。
// 未ログイン／sync.js 無しなら何も起きない＝導入前とまったく同じ挙動。
function notifyLocalChange() {
  if (typeof window.qestOnLocalChange === 'function') {
    try { window.qestOnLocalChange(); } catch (e) {}
  }
}

async function pruneTombstones() {
  const limit = Date.now() - TOMB_KEEP_MS;
  for (const t of await dbGetAll('tombstones')) {
    if (!(Number(t.at) > limit)) await dbRawDelete('tombstones', t.id);
  }
}

// ---- HELPERS ----
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
/** 端末の暦での日付。
 *  以前は new Date().toISOString().slice(0,10) を使っていたが、これは UTC 基準なので
 *  日本時間だと 0時〜9時のあいだ前日を返す。同じ間違いを繰り返さないよう関数ごと消した。
 *  日付として見せる・数えるものは必ずこちらを使う。 */
function localDateStr(d = new Date()) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function todayLocalStr() { return localDateStr(); }
/** completedAt（UTCのISO文字列）を、端末の暦での日付に直す。 */
function localDateOfIso(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : localDateStr(d);
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function esc(str) {
  return String(str).replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ---- STATE ----
let state = { quests: [], templates: [], recurring: [], history: [], meta: { id: 'app', lastRecurring: null } };
let editMode   = null; // { type: 'quest'|'template', id: null|string, fromScreen: string }
let undoTimer  = null;
let recurringTimer = null;

// ---- SORT ----
const CAT_ORDER = { deadline: 0, quick: 1, normal: 2 };

function sortQuests(list) {
  return [...list].sort((a, b) => {
    const cd = CAT_ORDER[a.category] - CAT_ORDER[b.category];
    if (cd !== 0) return cd;
    return a.priority - b.priority;
  });
}

// ---- CATEGORY META ----
const CAT = {
  deadline: { icon: '📅', label: '期限あり' },
  quick:    { icon: '⚡', label: '速攻' },
  normal:   { icon: '📋', label: '通常' }
};

const P_COLOR = ['', '#4ade80', '#a3e635', '#facc15', '#fb923c', '#ef4444'];

// ============================================================
//  NAVIGATION
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => {
    s.classList.toggle('active', s.id === id);
  });
}

// ============================================================
//  RENDER QUESTS (main screen)
// ============================================================
function renderQuests() {
  const list  = document.getElementById('quest-list');
  const empty = document.getElementById('empty-state');
  const sorted = sortQuests(state.quests);

  list.innerHTML = '';

  if (sorted.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  sorted.forEach(q => list.appendChild(makeQuestEl(q)));
}

function makeQuestEl(quest) {
  const wrap = document.createElement('div');
  wrap.className = 'quest-item';
  wrap.dataset.id = quest.id;

  const cat       = CAT[quest.category] || CAT.normal;
  const dlLabel   = quest.deadline ? deadlineLabel(quest.deadline) : '';
  const dlClass   = quest.deadline && isOverdue(quest.deadline) ? 'quest-deadline overdue' : 'quest-deadline';
  const recBadge  = quest.recurringDefId ? '<span class="recurring-badge">🔁</span>' : '';

  wrap.innerHTML = `
    <div class="quest-swipe-wrap">
      <div class="quest-delete-bg"><span>削除</span></div>
      <div class="quest-card" style="--priority-color:${P_COLOR[quest.priority]}">
        <button class="quest-complete-btn" aria-label="完了"></button>
        <div class="quest-info">
          <span class="quest-name">${esc(quest.name)}</span>
          <div class="quest-meta">
            <span class="cat-icon">${cat.icon}</span>
            ${dlLabel ? `<span class="${dlClass}">${dlLabel}</span>` : ''}
            <span class="quest-priority">P${quest.priority}</span>
            ${recBadge}
          </div>
        </div>
      </div>
    </div>`;

  wrap.querySelector('.quest-complete-btn').addEventListener('click', e => {
    e.stopPropagation();
    completeQuest(quest.id);
  });
  wrap.querySelector('.quest-info').addEventListener('click', () => openEdit('quest', quest.id, 'screen-main'));
  setupSwipe(wrap.querySelector('.quest-card'), () => deleteQuest(quest.id, wrap));

  return wrap;
}

function deadlineLabel(dateStr) {
  const d    = new Date(dateStr + 'T00:00:00');
  const diff = Math.ceil((d - Date.now()) / 86400000);
  if (diff <  0) return `${Math.abs(diff)}日超過`;
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  return `${diff}日後`;
}
function isOverdue(dateStr) {
  return new Date(dateStr + 'T00:00:00') < new Date(new Date().toDateString());
}

// ============================================================
//  COMPLETE QUEST
// ============================================================
async function completeQuest(id) {
  const quest = state.quests.find(q => q.id === id);
  if (!quest) return;

  const el = document.querySelector(`.quest-item[data-id="${id}"]`);
  if (el) {
    el.classList.add('completing');
    await sleep(360);
  }

  const entry = { ...quest, completedAt: new Date().toISOString() };
  await dbPut('history', entry);
  await dbDelete('quests', id);

  state.quests  = state.quests.filter(q => q.id !== id);
  state.history.push(entry);
  renderQuests();

  showUndo('クエスト完了！', async () => {
    await dbDelete('history', entry.id);
    await dbPut('quests', quest);
    state.history = state.history.filter(h => h.id !== entry.id);
    state.quests.push(quest);
    renderQuests();
  });
}

// ============================================================
//  DELETE QUEST
// ============================================================
async function deleteQuest(id, el) {
  const quest = state.quests.find(q => q.id === id);
  if (!quest) return;

  if (el) { el.classList.add('deleting'); await sleep(260); }

  await dbDelete('quests', id);
  state.quests = state.quests.filter(q => q.id !== id);
  renderQuests();

  showUndo('削除しました', async () => {
    await dbPut('quests', quest);
    state.quests.push(quest);
    renderQuests();
  });
}

// ============================================================
//  SWIPE TO DELETE
// ============================================================
function setupSwipe(cardEl, onDelete) {
  let startX = 0, dx = 0, dragging = false;
  const THRESHOLD = 80;

  cardEl.addEventListener('touchstart', e => {
    startX   = e.touches[0].clientX;
    dragging = true;
    cardEl.style.transition = 'none';
  }, { passive: true });

  cardEl.addEventListener('touchmove', e => {
    if (!dragging) return;
    dx = e.touches[0].clientX - startX;
    if (dx < 0) cardEl.style.transform = `translateX(${dx}px)`;
  }, { passive: true });

  cardEl.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    cardEl.style.transition = 'transform .25s ease';
    if (dx < -THRESHOLD) {
      cardEl.style.transform = 'translateX(-110%)';
      setTimeout(onDelete, 180);
    } else {
      cardEl.style.transform = 'translateX(0)';
    }
    dx = 0;
  });
}

// ============================================================
//  UNDO TOAST
// ============================================================
function showUndo(msg, fn) {
  clearTimeout(undoTimer);
  const toast = document.getElementById('undo-toast');
  document.getElementById('undo-message').textContent = msg;
  toast.classList.remove('hidden');
  document.getElementById('btn-undo').onclick = async () => { hideUndo(); await fn(); };
  undoTimer = setTimeout(hideUndo, 4200);
}
function hideUndo() {
  document.getElementById('undo-toast').classList.add('hidden');
}

// ============================================================
//  EDIT FORM
// ============================================================
function openEdit(type, id, fromScreen) {
  editMode = { type, id: id || null, fromScreen: fromScreen || 'screen-main' };

  let d = { name: '', priority: 3, category: 'normal', deadline: null, recurring: false, days: [] };

  if (type === 'quest' && id) {
    const q = state.quests.find(x => x.id === id);
    if (q) d = { name: q.name, priority: q.priority, category: q.category,
                 deadline: q.deadline, recurring: !!q.recurringDefId, days: [] };
    document.getElementById('edit-title').textContent = 'クエスト編集';
    // 既存クエストは継続設定を非表示
    document.getElementById('recurring-group').style.display = 'none';
  } else if (type === 'quest') {
    document.getElementById('edit-title').textContent = 'クエスト追加';
    document.getElementById('recurring-group').style.display = '';
    document.querySelector('#recurring-group .form-label').textContent = '継続設定';
    document.querySelector('#recurring-group .toggle-row span:first-child').textContent = '毎日繰り返す';
  } else if (type === 'template' && id) {
    const t = state.templates.find(x => x.id === id);
    if (t) d = { name: t.name, priority: t.priority, category: t.category,
                 deadline: null, recurring: !!t.recurring, days: t.days || [] };
    document.getElementById('edit-title').textContent = 'テンプレート編集';
    document.getElementById('recurring-group').style.display = '';
    document.querySelector('#recurring-group .form-label').textContent = '自動追加';
    document.querySelector('#recurring-group .toggle-row span:first-child').textContent = '毎朝4時に自動追加';
  } else {
    // template new
    document.getElementById('edit-title').textContent = 'テンプレート追加';
    document.getElementById('recurring-group').style.display = '';
    document.querySelector('#recurring-group .form-label').textContent = '自動追加';
    document.querySelector('#recurring-group .toggle-row span:first-child').textContent = '毎朝4時に自動追加';
  }

  // fill
  document.getElementById('edit-name').value = d.name;

  document.querySelectorAll('.priority-btn').forEach(b =>
    b.classList.toggle('active', +b.dataset.value === d.priority));

  document.querySelectorAll('.category-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.value === d.category));
  updateDeadlineVis(d.category);

  document.getElementById('edit-deadline').value = d.deadline || '';

  const recBox = document.getElementById('edit-recurring');
  recBox.checked = d.recurring;
  document.getElementById('recurring-days').classList.toggle('hidden', !d.recurring);

  document.querySelectorAll('.day-btn').forEach(b =>
    b.classList.toggle('active', d.days.includes(+b.dataset.day)));

  showScreen('screen-edit');
  setTimeout(() => document.getElementById('edit-name').focus(), 250);
}

function updateDeadlineVis(cat) {
  document.getElementById('deadline-group').style.display = cat === 'deadline' ? '' : 'none';
}

async function saveEdit() {
  const name = document.getElementById('edit-name').value.trim();
  if (!name) {
    const input = document.getElementById('edit-name');
    input.classList.add('error');
    setTimeout(() => input.classList.remove('error'), 700);
    return;
  }

  const priority  = +( document.querySelector('.priority-btn.active')?.dataset.value || 3 );
  const category  = document.querySelector('.category-btn.active')?.dataset.value || 'normal';
  const deadline  = category === 'deadline'
    ? (document.getElementById('edit-deadline').value || null)
    : null;
  const isRec     = document.getElementById('edit-recurring').checked;
  const days      = [...document.querySelectorAll('.day-btn.active')].map(b => +b.dataset.day);

  const { type, id, fromScreen } = editMode;

  if (type === 'quest') {
    if (id) {
      const q = state.quests.find(x => x.id === id);
      if (q) { Object.assign(q, { name, priority, category, deadline }); await dbPut('quests', q); }
    } else {
      if (isRec) {
        // 新規クエスト追加時に継続設定する場合は recurring store に保存（旧仕様互換）
        const def = { id: genId(), name, priority, category, days };
        await dbPut('recurring', def);
        state.recurring.push(def);
        const dayOfWeek = new Date().getDay();
        if (days.length === 0 || days.includes(dayOfWeek)) {
          // 今日ぶんとして印を付ける。付けないと次の4時チェックで
          // 「前回ぶん」と見なされて消えてしまう。
          await addQuestToState({ name, priority, category, deadline: null,
                                  recurringDefId: def.id, recurringDate: todayLocalStr() });
        }
      } else {
        await addQuestToState({ name, priority, category, deadline, recurringDefId: null });
      }
    }
    renderQuests();
  } else {
    // template
    if (id) {
      const t = state.templates.find(x => x.id === id);
      if (t) {
        Object.assign(t, { name, priority, category, recurring: isRec, days });
        await dbPut('templates', t);
      }
    } else {
      const t = { id: genId(), name, priority, category, recurring: isRec, days };
      await dbPut('templates', t);
      state.templates.push(t);
    }
    renderTemplates();
  }

  showScreen(fromScreen || 'screen-main');
}

async function addQuestToState(data) {
  const q = {
    id:            data.id || genId(),
    name:          data.name,
    priority:      data.priority || 3,
    category:      data.category || 'normal',
    deadline:      data.deadline || null,
    recurringDefId: data.recurringDefId || null,
    recurringDate: data.recurringDate || null,
    createdAt:     new Date().toISOString()
  };
  await dbPut('quests', q);
  state.quests.push(q);
  return q;
}

// ============================================================
//  TEMPLATES SCREEN
// ============================================================
function renderTemplates() {
  const list  = document.getElementById('template-list');
  const empty = document.getElementById('template-empty');
  list.innerHTML = '';

  if (state.templates.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  state.templates.forEach(t => {
    const wrap = document.createElement('div');
    wrap.className = 'quest-item';
    wrap.dataset.id = t.id;
    const cat = CAT[t.category] || CAT.normal;
    const recBadge = t.recurring ? '<span class="recurring-badge">🔁 4時</span>' : '';

    wrap.innerHTML = `
      <div class="quest-swipe-wrap">
        <div class="quest-delete-bg"><span>削除</span></div>
        <div class="quest-card" style="--priority-color:${P_COLOR[t.priority]}">
          <button class="template-add-btn" aria-label="追加">＋</button>
          <div class="quest-info">
            <span class="quest-name">${esc(t.name)}</span>
            <div class="quest-meta">
              <span class="cat-icon">${cat.icon}</span>
              <span class="quest-priority">P${t.priority}</span>
              ${recBadge}
            </div>
          </div>
        </div>
      </div>`;

    wrap.querySelector('.template-add-btn').addEventListener('click', e => {
      e.stopPropagation();
      useTemplate(t.id);
    });
    wrap.querySelector('.quest-info').addEventListener('click', () => openEdit('template', t.id, 'screen-templates'));
    setupSwipe(wrap.querySelector('.quest-card'), () => deleteTemplate(t.id, wrap));

    list.appendChild(wrap);
  });
}

async function useTemplate(id) {
  const t = state.templates.find(x => x.id === id);
  if (!t) return;
  await addQuestToState({ name: t.name, priority: t.priority, category: t.category });
  renderQuests();
  showScreen('screen-main');
}

async function deleteTemplate(id, el) {
  const t = state.templates.find(x => x.id === id);
  if (!t) return;
  if (el) { el.classList.add('deleting'); await sleep(260); }
  await dbDelete('templates', id);
  state.templates = state.templates.filter(x => x.id !== id);
  renderTemplates();
  showUndo('削除しました', async () => {
    await dbPut('templates', t);
    state.templates.push(t);
    renderTemplates();
  });
}

// ============================================================
//  HISTORY SCREEN
// ============================================================
function renderHistory() {
  // completedAt は UTC の文字列。前は先頭10文字をそのまま比べていたので、
  // 「本日の達成」が日本時間の朝9時で切り替わっていた（前夜の完了が今日に入る）。
  const today    = todayLocalStr();
  const todayH   = state.history.filter(h => localDateOfIso(h.completedAt) === today);
  const list     = document.getElementById('history-list');
  const statsEl  = document.getElementById('history-stats');

  statsEl.innerHTML = `
    <div class="stats-card">
      <span class="stats-num">${todayH.length}</span>
      <span class="stats-label"><strong>本日の達成</strong>クエストクリア</span>
    </div>`;

  list.innerHTML = '';

  if (todayH.length === 0) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📜</div><p>まだ完了したクエストがありません</p></div>';
    return;
  }

  [...todayH]
    .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''))
    .forEach(h => {
      const cat  = CAT[h.category] || CAT.normal;
      const time = new Date(h.completedAt).toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
      const div  = document.createElement('div');
      div.className = 'quest-item';
      div.innerHTML = `
        <div class="quest-card" style="--priority-color:${P_COLOR[h.priority] || '#444'}">
          <span class="done-check">✓</span>
          <div class="quest-info">
            <span class="quest-name done">${esc(h.name)}</span>
            <div class="quest-meta">
              <span class="cat-icon">${cat.icon}</span>
              <span>${time}</span>
              <span class="quest-priority">P${h.priority}</span>
            </div>
          </div>
        </div>`;
      list.appendChild(div);
    });
}

// ============================================================
//  RECURRING — テンプレートの自動追加（毎朝4時）
// ============================================================

/** 次の4時までのミリ秒 */
function msUntil4AM() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

/** 今日の4時を過ぎているか */
function isPast4AM() {
  const now = new Date();
  return now.getHours() >= 4;
}

/** 4時の自動追加を実行すべきか判定
 *  「最後に走らせた日」は端末ローカルではなく meta（同期対象）で持つ。
 *  localStorage に置いていた頃は端末ごとに走ってしまい、二重に追加されていた。 */
function shouldRunRecurring() {
  if (!isPast4AM()) return false;
  return state.meta.lastRecurring !== todayLocalStr();
}

/**
 * recurring フラグの立ったテンプレートをクエストに追加する。
 * ・前回分（今日ではない日の自動追加インスタンス）を削除してから追加
 * ・曜日指定がある場合は一致した日のみ追加
 *
 * 複数端末での注意：
 * 生成するクエストのIDを「テンプレID＋日付」で決め打ちにしてある。
 * こうすると両方の端末がまったく同じIDを作るので、同期しても二重に増えない。
 * ランダムIDのままだと、片方が作った今日ぶんともう片方が作った今日ぶんが
 * 別物として並んでしまう。
 */
async function processRecurring() {
  if (!shouldRunRecurring()) return;

  const today = todayLocalStr();
  const dow   = new Date().getDay();

  // 前回ぶんだけを片付ける。
  // 「recurringDefId が付いているもの全部」を消すと、もう一方の端末が
  // 今日ぶんとして作ったばかりのクエストまで巻き込んで消してしまう。
  const toRemove = state.quests.filter(q => q.recurringDefId && q.recurringDate !== today);
  for (const q of toRemove) await dbDelete('quests', q.id);
  state.quests = state.quests.filter(q => !(q.recurringDefId && q.recurringDate !== today));

  // recurring テンプレートを今日分として追加
  for (const t of state.templates) {
    if (!t.recurring) continue;
    // 曜日指定あり → 今日の曜日と一致しなければスキップ
    if (t.days && t.days.length > 0 && !t.days.includes(dow)) continue;

    const id = `rec:${t.id}:${today}`;
    if (state.quests.some(q => q.id === id)) continue;   // もう作られている
    if (state.history.some(h => h.id === id)) continue;  // 他の端末で今日ぶんを完了済み
    if (await dbGet('tombstones', tombKey('quests', id))) continue; // 他の端末で今日ぶんを削除済み

    await addQuestToState({
      id,
      name:          t.name,
      priority:      t.priority,
      category:      t.category,
      deadline:      null,
      recurringDefId: t.id,  // テンプレートIDを紐付け
      recurringDate:  today
    });
  }

  state.meta.lastRecurring = today;
  await dbPut('meta', state.meta);
}

/** アプリ起動中に4時になったら自動実行するタイマーをセット */
function scheduleRecurring() {
  clearTimeout(recurringTimer);
  recurringTimer = setTimeout(async () => {
    await processRecurring();
    renderQuests();
    scheduleRecurring(); // 翌日4時のために再スケジュール
  }, msUntil4AM());
}

// ============================================================
//  EXPORT / IMPORT
// ============================================================
async function exportData() {
  const data = {
    version:    1,
    exportedAt: new Date().toISOString(),
    quests:     state.quests,
    templates:  state.templates,
    recurring:  state.recurring,
    history:    state.history
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url, download: `questlist-backup-${todayLocalStr()}.json`
  });
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.version) throw new Error('形式が正しくありません');

    for (const s of STORES) await dbClear(s);
    for (const q of (data.quests    || [])) await dbPut('quests',    q);
    for (const t of (data.templates || [])) await dbPut('templates', t);
    for (const r of (data.recurring || [])) await dbPut('recurring', r);
    for (const h of (data.history   || [])) await dbPut('history',   h);

    state.quests    = data.quests    || [];
    state.templates = data.templates || [];
    state.recurring = data.recurring || [];
    state.history   = data.history   || [];

    renderQuests();
    showScreen('screen-main');
    showUndo('データを復元しました', () => {});
  } catch (e) {
    alert('復元に失敗しました: ' + e.message);
  }
}

// ============================================================
//  INIT
// ============================================================
async function init() {
  db = await openDB();

  state.quests    = await dbGetAll('quests');
  state.templates = await dbGetAll('templates');
  state.recurring = await dbGetAll('recurring');
  state.history   = await dbGetAll('history');
  state.meta      = (await dbGet('meta', 'app')) || { id: 'app', lastRecurring: null };

  // 旧版は「最後に自動追加した日」を端末ローカルの localStorage に持っていた。
  // 端末ごとに走ってしまい二重に追加されるので、meta に引き取って捨てる。
  const legacyLast = localStorage.getItem('questLastRecurring');
  if (legacyLast) {
    if (!state.meta.lastRecurring) {
      state.meta.lastRecurring = legacyLast;
      await dbRawPut('meta', state.meta);
    }
    localStorage.removeItem('questLastRecurring');
  }

  await pruneTombstones();

  // 起動時に4時チェック（4時以降なら即実行）
  await processRecurring();
  renderQuests();

  // アプリが起動中のまま4時になったときのタイマー
  scheduleRecurring();

  // バックグラウンドから復帰したときもチェック
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
      await processRecurring();
      renderQuests();
      scheduleRecurring(); // タイマーをリセット
    }
  });

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // ---- Event Listeners ----

  // Main
  document.getElementById('btn-add').addEventListener('click', () => openEdit('quest', null, 'screen-main'));
  document.getElementById('btn-history').addEventListener('click', () => {
    renderHistory(); showScreen('screen-history');
  });
  document.getElementById('btn-templates').addEventListener('click', () => {
    renderTemplates(); showScreen('screen-templates');
  });
  document.getElementById('btn-settings').addEventListener('click', () => showScreen('screen-settings'));

  // Edit
  document.getElementById('btn-edit-back').addEventListener('click', () => {
    showScreen(editMode?.fromScreen || 'screen-main');
  });
  document.getElementById('btn-edit-save').addEventListener('click', saveEdit);

  // Templates
  document.getElementById('btn-templates-back').addEventListener('click', () => showScreen('screen-main'));
  document.getElementById('btn-template-add').addEventListener('click', () => openEdit('template', null, 'screen-templates'));

  // History
  document.getElementById('btn-history-back').addEventListener('click', () => showScreen('screen-main'));

  // Settings
  document.getElementById('btn-settings-back').addEventListener('click', () => showScreen('screen-main'));
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
  document.getElementById('import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });

  // Undo
  document.getElementById('btn-undo').addEventListener('click', () => {});

  // Priority
  document.querySelectorAll('.priority-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.priority-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    })
  );

  // Category
  document.querySelectorAll('.category-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateDeadlineVis(btn.dataset.value);
    })
  );

  // Recurring toggle
  document.getElementById('edit-recurring').addEventListener('change', e => {
    document.getElementById('recurring-days').classList.toggle('hidden', !e.target.checked);
  });

  // Day buttons
  document.querySelectorAll('.day-btn').forEach(btn =>
    btn.addEventListener('click', () => btn.classList.toggle('active'))
  );
}

document.addEventListener('DOMContentLoaded', init);
