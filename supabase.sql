-- ============================================================================
-- QUEST LIST — Supabase テーブル定義
-- わんにゃんメモリー／達人への道／IRON LOG／URUOI と同じプロジェクトに相乗りするため、
-- 「authenticated に grant / anon から revoke / RLS＋ポリシー」を毎回明示する。
-- Supabase ダッシュボード → SQL Editor に貼って実行する。
-- 何度実行しても壊れないように書いてある。
--
-- ※ SQL Editor は必ずタブの「＋」で新しいクエリを作ってから貼ること
--   （既存の「無題のクエリ」を上書きしてしまわないように）。
-- ============================================================================

-- ── 0) updated_at をサーバー時刻で入れるための共通トリガ関数 ──
-- 端末の時計で updated_at を入れると、時計がずれた端末の行が
-- 「前回より新しい行だけ取る」差分同期の網から永久に漏れる。
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ── 1) クエスト・テンプレート・繰り返し定義・履歴 ──
-- 4つとも「IDを持つレコードの集合」でまったく同じ形なので、
-- store 列で区別して1つのテーブルにまとめている。
create table if not exists public.qest_items (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  store      text        not null,               -- 'quests' | 'templates' | 'recurring' | 'history'
  id         text        not null,               -- アプリが作るID
  data       jsonb       not null default '{}'::jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, store, id)
);

create index if not exists qest_items_user_updated_idx
  on public.qest_items (user_id, updated_at asc);

drop trigger if exists qest_items_touch on public.qest_items;
create trigger qest_items_touch before insert or update on public.qest_items
  for each row execute function public.set_updated_at();

-- ── 2) 端末間で共有したい小さな値（1ユーザー1行） ──
-- 今のところ中身は「毎朝4時の自動追加を最後に走らせた日」だけ。
-- これを端末ローカルに置いていると、端末ごとに自動追加が走って二重になる。
create table if not exists public.qest_state (
  user_id    uuid        primary key references auth.users(id) on delete cascade,
  doc        jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists qest_state_touch on public.qest_state;
create trigger qest_state_touch before insert or update on public.qest_state
  for each row execute function public.set_updated_at();

-- ── RLS ──
alter table public.qest_items enable row level security;
alter table public.qest_state enable row level security;

drop policy if exists qest_items_own on public.qest_items;
drop policy if exists qest_state_own on public.qest_state;

create policy qest_items_own on public.qest_items
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy qest_state_own on public.qest_state
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── 権限（anon は完全に締め出す。自動設定に頼らず明示する） ──
revoke all on public.qest_items from anon;
revoke all on public.qest_state from anon;

grant select, insert, update, delete on public.qest_items to authenticated;
grant select, insert, update, delete on public.qest_state to authenticated;

-- ── 確認用（anon で叩くと permission denied になるのが正しい） ──
-- select * from public.qest_items limit 1;
