-- Table for the "Save to Supabase" step of the n8n workflow
-- "AI Prompt Generator — Multi-Model Evaluation" (n8n workflow aY4Q1DmIxBDcsVpW).
-- That node inserts two fields: goal (the webhook body's goal) and
-- best_prompt (the winning prompt). id and created_at fill themselves in.
--
-- Run once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.

create table if not exists public.prompts (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  goal        text not null,
  best_prompt text not null
);

comment on table public.prompts is
  'Best prompt per goal, written by the n8n workflow "AI Prompt Generator — Multi-Model Evaluation".';

-- Newest first, for browsing past results.
create index if not exists prompts_created_at_idx on public.prompts (created_at desc);

-- Row Level Security on, with no policies: the public anon key can neither read
-- nor write this table. n8n's Supabase credential uses the service_role key,
-- which bypasses RLS, so the workflow's insert still works.
alter table public.prompts enable row level security;

-- Make the Data API see the new table right away (fixes the 404 if it lingers).
notify pgrst, 'reload schema';
