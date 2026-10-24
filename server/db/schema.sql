-- RecallLab — nodes table.
-- Design spec §5.1, with two deliberate deviations required by the build
-- contracts §2.1 so that the same schema runs on pg-mem and on real Postgres:
--
--   1. No `create extension pgcrypto` and no `gen_random_uuid()` default.
--      UUIDs are generated in the application with crypto.randomUUID().
--   2. `created_at` / `updated_at` keep `default now()` for production
--      hygiene, but the application always passes the value explicitly.
--
-- `ON DELETE CASCADE` is kept as a production safety net. The application
-- deletes children first and the parent last, inside one transaction, so the
-- database cascade normally finds nothing left to remove.

create table nodes (
  id          uuid primary key,
  parent_id   uuid references nodes(id) on delete cascade,
  kind        text    not null check (kind in ('folder', 'card')),
  title       text    not null check (length(btrim(title)) > 0),
  body        text    not null default '',
  answer      text    not null default '',
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index nodes_parent_position_idx on nodes (parent_id, position);
create index nodes_parent_idx on nodes (parent_id);
