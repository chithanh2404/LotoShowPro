-- SUPABASE SCHEMA CHO LOTO ONLINE
-- Chạy trong SQL Editor của Supabase

-- 1. Bảng profiles (mở rộng auth.users)
create table if not exists public.profiles (
  id uuid references auth.users(id) primary key,
  username text unique,
  email text,
  balance bigint default 100000, -- tặng 100k xu khi đăng ký
  created_at timestamp with time zone default now()
);

-- 2. Bảng OTP (cho quên mật khẩu qua Apps Script)
create table if not exists public.password_otps (
  id uuid default gen_random_uuid() primary key,
  email text not null,
  otp text not null,
  expires_at timestamp with time zone default (now() + interval '10 minutes'),
  verified boolean default false,
  created_at timestamp with time zone default now()
);

-- 3. Bảng phòng chơi
create table if not exists public.rooms (
  id text primary key, -- VD: LOTO-8F3K2
  name text,
  host_id uuid references public.profiles(id),
  password text, -- hash hoặc plain cho đơn giản
  bet_amount bigint default 10000,
  max_players int default 5,
  status text default 'waiting', -- waiting, counting, playing, finished
  fee_percent int default 20,
  current_numbers int[] default '{}',
  winner_id uuid,
  created_at timestamp with time zone default now()
);

-- 4. Bảng người chơi trong phòng + vé
create table if not exists public.room_players (
  id uuid default gen_random_uuid() primary key,
  room_id text references public.rooms(id) on delete cascade,
  user_id uuid references public.profiles(id),
  is_bot boolean default false,
  bot_name text,
  ticket jsonb, -- lưu vé 3x9
  is_winner boolean default false,
  joined_at timestamp with time zone default now()
);

-- 5. Bảng lịch sử giao dịch
create table if not exists public.transactions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles(id),
  type text, -- bet, win, fee, deposit
  amount bigint,
  room_id text,
  created_at timestamp with time zone default now()
);

-- RLS
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_players enable row level security;
alter table public.transactions enable row level security;
alter table public.password_otps enable row level security;

create policy "public read profiles" on public.profiles for select using (true);
create policy "users update own profile" on public.profiles for update using (auth.uid() = id);
create policy "insert profile on signup" on public.profiles for insert with check (true);

create policy "public rooms" on public.rooms for all using (true) with check (true);
create policy "public room_players" on public.room_players for all using (true) with check (true);
create policy "public transactions" on public.transactions for all using (true) with check (true);
create policy "public otps" on public.password_otps for all using (true) with check (true);

-- Function tự tạo profile khi đăng ký
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, username, balance)
  values (new.id, new.email, split_part(new.email, '@', 1), 100000);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
