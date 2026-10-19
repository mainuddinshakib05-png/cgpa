create table if not exists public.uiu_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.uiu_routine_releases (
  id bigint generated always as identity primary key,
  semester text not null,
  source_filename text not null,
  source_path text not null,
  entries jsonb not null,
  uploaded_by uuid not null references auth.users (id),
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists uiu_one_current_routine_release
  on public.uiu_routine_releases (is_current)
  where is_current;

create table if not exists public.uiu_site_presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  current_page text not null,
  last_seen timestamptz not null default now()
);

create index if not exists uiu_site_presence_last_seen_idx
  on public.uiu_site_presence (last_seen desc);

create table if not exists public.uiu_page_visits (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  page_path text not null,
  visited_at timestamptz not null default now(),
  constraint uiu_valid_analytics_page check (
    page_path in ('home', 'cgpa', 'cover', 'games', 'reminder', 'routine')
  )
);

create index if not exists uiu_page_visits_visited_at_idx
  on public.uiu_page_visits (visited_at desc);

create index if not exists uiu_page_visits_page_path_idx
  on public.uiu_page_visits (page_path, visited_at desc);

alter table public.uiu_admins enable row level security;
alter table public.uiu_routine_releases enable row level security;
alter table public.uiu_site_presence enable row level security;
alter table public.uiu_page_visits enable row level security;

revoke all on public.uiu_admins from anon, authenticated;
revoke all on public.uiu_routine_releases from anon, authenticated;
revoke all on public.uiu_site_presence from anon, authenticated;
revoke all on public.uiu_page_visits from anon, authenticated;
revoke all on sequence public.uiu_routine_releases_id_seq from anon, authenticated;
revoke all on sequence public.uiu_page_visits_id_seq from anon, authenticated;

create or replace function public.uiu_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (
      (select auth.uid()) is not null
      and lower(coalesce((select auth.jwt() ->> 'email'), '')) = 'mainuddinshakib05@gmail.com'
    )
    or exists (
      select 1
      from public.uiu_admins
      where user_id = (select auth.uid())
    ),
    false
  );
$$;

revoke all on function public.uiu_is_admin() from public;
grant execute on function public.uiu_is_admin() to anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('uiu-routine-pdfs', 'uiu-routine-pdfs', false, 26214400, array['application/pdf'])
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "UIU admins can upload routine PDFs" on storage.objects;
create policy "UIU admins can upload routine PDFs"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'uiu-routine-pdfs'
    and (select public.uiu_is_admin())
  );

drop policy if exists "UIU admins can read routine PDFs" on storage.objects;
create policy "UIU admins can read routine PDFs"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'uiu-routine-pdfs'
    and (select public.uiu_is_admin())
  );

drop policy if exists "UIU admins can delete routine PDFs" on storage.objects;
create policy "UIU admins can delete routine PDFs"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'uiu-routine-pdfs'
    and (select public.uiu_is_admin())
  );

create or replace function public.uiu_get_routine_catalog()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'semester', release.semester,
    'updated_at', release.created_at,
    'courses', coalesce(catalog.courses, '[]'::jsonb)
  )
  from public.uiu_routine_releases as release
  cross join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'code', course.course_code,
        'name', course.course_name,
        'faculties', course.faculties
      )
      order by course.course_code
    ) as courses
    from (
      select
        upper(trim(entry.value ->> 'code')) as course_code,
        coalesce(
          min(nullif(trim(entry.value ->> 'course'), '')),
          upper(trim(entry.value ->> 'code'))
        ) as course_name,
        array_agg(
          distinct trim(entry.value ->> 'faculty')
          order by trim(entry.value ->> 'faculty')
        ) as faculties
      from jsonb_array_elements(release.entries) as entry(value)
      where nullif(trim(entry.value ->> 'code'), '') is not null
        and nullif(trim(entry.value ->> 'faculty'), '') is not null
      group by upper(trim(entry.value ->> 'code'))
    ) as course
  ) as catalog
  where release.is_current
  limit 1;
$$;

create or replace function public.uiu_get_selected_class_options(p_selections jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_entries jsonb;
  result jsonb;
  selection_count integer;
begin
  if p_selections is null or jsonb_typeof(p_selections) <> 'array' then
    raise exception 'Select at least one course and faculty.';
  end if;

  selection_count := jsonb_array_length(p_selections);
  if selection_count < 1 or selection_count > 12 then
    raise exception 'Select between 1 and 12 courses.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_selections) as selection(value)
    where nullif(trim(selection.value ->> 'code'), '') is null
       or nullif(trim(selection.value ->> 'faculty'), '') is null
  ) then
    raise exception 'Every selected course needs a faculty.';
  end if;

  if (
    select count(distinct upper(trim(selection.value ->> 'code')))
    from jsonb_array_elements(p_selections) as selection(value)
  ) <> selection_count then
    raise exception 'Each course can only be selected once.';
  end if;

  select release.entries
  into current_entries
  from public.uiu_routine_releases as release
  where release.is_current
  limit 1;

  if current_entries is null then
    raise exception 'The administrator has not published a routine yet.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_selections) as selection(value)
    where not exists (
      select 1
      from jsonb_array_elements(current_entries) as entry(value)
      where upper(trim(entry.value ->> 'code')) =
            upper(trim(selection.value ->> 'code'))
        and lower(trim(entry.value ->> 'faculty')) =
            lower(trim(selection.value ->> 'faculty'))
    )
  ) then
    raise exception 'One of your selected course or faculty options is not in the current routine.';
  end if;

  with selected as (
    select
      selection.ordinality as position,
      upper(trim(selection.value ->> 'code')) as code,
      trim(selection.value ->> 'faculty') as faculty
    from jsonb_array_elements(p_selections) with ordinality as selection(value, ordinality)
  ),
  grouped as (
    select
      selected.position,
      selected.code,
      selected.faculty,
      coalesce(nullif(trim(entry.value ->> 'section'), ''), 'default') as section,
      coalesce(
        min(nullif(trim(entry.value ->> 'course'), '')),
        selected.code
      ) as course,
      jsonb_agg(entry.value order by entry.value ->> 'day', (entry.value ->> 'start')::integer) as meetings
    from selected
    cross join jsonb_array_elements(current_entries) as entry(value)
    where upper(trim(entry.value ->> 'code')) = selected.code
      and lower(trim(entry.value ->> 'faculty')) = lower(selected.faculty)
    group by
      selected.position,
      selected.code,
      selected.faculty,
      coalesce(nullif(trim(entry.value ->> 'section'), ''), 'default')
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'position', grouped.position,
        'code', grouped.code,
        'course', grouped.course,
        'faculty', grouped.faculty,
        'section', grouped.section,
        'meetings', grouped.meetings
      )
      order by grouped.position, grouped.section
    ),
    '[]'::jsonb
  )
  into result
  from grouped;

  return result;
end;
$$;

create or replace function public.uiu_publish_routine(
  p_semester text,
  p_source_filename text,
  p_source_path text,
  p_entries jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  entry jsonb;
  new_release public.uiu_routine_releases%rowtype;
begin
  if not (select public.uiu_is_admin()) then
    raise exception 'Administrator access is required to publish a routine.';
  end if;

  if nullif(trim(p_semester), '') is null or length(trim(p_semester)) > 80 then
    raise exception 'Enter a semester name (up to 80 characters).';
  end if;

  if nullif(trim(p_source_filename), '') is null or length(p_source_filename) > 255 then
    raise exception 'The PDF filename is missing or too long.';
  end if;

  if p_source_path !~ '^[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}\.pdf$' then
    raise exception 'The uploaded PDF path is invalid.';
  end if;

  if p_entries is null
     or jsonb_typeof(p_entries) <> 'array'
     or jsonb_array_length(p_entries) = 0
     or jsonb_array_length(p_entries) > 12000 then
    raise exception 'The PDF must contain between 1 and 12000 course meetings.';
  end if;

  for entry in select item.value from jsonb_array_elements(p_entries) as item(value)
  loop
    if nullif(trim(entry ->> 'code'), '') is null
       or nullif(trim(entry ->> 'course'), '') is null
       or nullif(trim(entry ->> 'faculty'), '') is null
       or nullif(trim(entry ->> 'section'), '') is null
       or nullif(trim(entry ->> 'day'), '') is null
       or jsonb_typeof(entry -> 'days') <> 'array'
       or jsonb_array_length(entry -> 'days') = 0
       or coalesce((entry ->> 'start') !~ '^[0-9]{1,4}$', true)
       or coalesce((entry ->> 'end') !~ '^[0-9]{1,4}$', true) then
      raise exception 'The PDF has an incomplete course row. Check its text and try again.';
    end if;

    if (entry ->> 'end')::integer <= (entry ->> 'start')::integer
       or (entry ->> 'end')::integer > 2880
       or exists (
         select 1
         from jsonb_array_elements_text(entry -> 'days') as day(value)
         where day.value not in ('Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday')
       ) then
      raise exception 'A parsed course row has invalid days or class times.';
    end if;
  end loop;

  if not exists (
    select 1
    from jsonb_array_elements(p_entries) as entry(value)
    where nullif(trim(entry.value ->> 'faculty'), '') is not null
  ) then
    raise exception 'The PDF did not contain any recognizable faculty names.';
  end if;

  update public.uiu_routine_releases
  set is_current = false
  where is_current;

  insert into public.uiu_routine_releases (
    semester,
    source_filename,
    source_path,
    entries,
    uploaded_by,
    is_current
  )
  values (
    trim(p_semester),
    p_source_filename,
    p_source_path,
    p_entries,
    (select auth.uid()),
    true
  )
  returning * into new_release;

  return jsonb_build_object(
    'semester', new_release.semester,
    'updated_at', new_release.created_at,
    'entry_count', jsonb_array_length(new_release.entries)
  );
end;
$$;

create or replace function public.uiu_track_site_activity(p_page text, p_track_visit boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_user_id uuid := (select auth.uid());
  previous_page text;
begin
  if current_user_id is null then
    raise exception 'A signed-in browser session is required.';
  end if;

  if p_page not in ('home', 'cgpa', 'cover', 'games', 'reminder', 'routine') then
    raise exception 'The requested analytics page is invalid.';
  end if;

  delete from public.uiu_page_visits
  where visited_at < now() - interval '90 days';

  delete from public.uiu_site_presence
  where last_seen < now() - interval '5 minutes';

  if (select public.uiu_is_admin()) then
    delete from public.uiu_site_presence
    where user_id = current_user_id;
    return;
  end if;

  select presence.current_page
  into previous_page
  from public.uiu_site_presence as presence
  where presence.user_id = current_user_id;

  insert into public.uiu_site_presence (user_id, current_page, last_seen)
  values (current_user_id, p_page, now())
  on conflict (user_id) do update
  set current_page = excluded.current_page,
      last_seen = excluded.last_seen;

  if p_track_visit and previous_page is distinct from p_page then
    insert into public.uiu_page_visits (user_id, page_path)
    values (current_user_id, p_page);
  end if;
end;
$$;

create or replace function public.uiu_get_admin_analytics()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (select public.uiu_is_admin()) then
    raise exception 'Administrator access is required to view analytics.';
  end if;

  return jsonb_build_object(
    'active_users', (
      select count(*)
      from public.uiu_site_presence as presence
      where presence.last_seen > now() - interval '90 seconds'
        and not exists (
          select 1 from public.uiu_admins as admin
          where admin.user_id = presence.user_id
        )
    ),
    'visits_today', (
      select count(*)
      from public.uiu_page_visits as visit
      where visit.visited_at >= date_trunc('day', now())
    ),
    'visitors_today', (
      select count(distinct visit.user_id)
      from public.uiu_page_visits as visit
      where visit.visited_at >= date_trunc('day', now())
    ),
    'top_pages', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'page', page.page_path,
          'visits', page.visit_count,
          'visitors', page.visitor_count
        )
        order by page.visit_count desc, page.page_path
      )
      from (
        select
          visit.page_path,
          count(*) as visit_count,
          count(distinct visit.user_id) as visitor_count
        from public.uiu_page_visits as visit
        where visit.visited_at >= now() - interval '7 days'
        group by visit.page_path
        order by visit_count desc, visit.page_path
        limit 10
      ) as page
    ), '[]'::jsonb),
    'active_pages', coalesce((
      select jsonb_agg(
        jsonb_build_object('page', page.current_page, 'users', page.user_count)
        order by page.user_count desc, page.current_page
      )
      from (
        select presence.current_page, count(*) as user_count
        from public.uiu_site_presence as presence
        where presence.last_seen > now() - interval '90 seconds'
          and not exists (
            select 1 from public.uiu_admins as admin
            where admin.user_id = presence.user_id
          )
        group by presence.current_page
      ) as page
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.uiu_get_admin_routine()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_release public.uiu_routine_releases%rowtype;
begin
  if not (select public.uiu_is_admin()) then
    raise exception 'Administrator access is required to view routine details.';
  end if;

  select release.*
  into current_release
  from public.uiu_routine_releases as release
  where release.is_current
  limit 1;

  if current_release.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'semester', current_release.semester,
    'source_filename', current_release.source_filename,
    'source_path', current_release.source_path,
    'updated_at', current_release.created_at,
    'entry_count', jsonb_array_length(current_release.entries)
  );
end;
$$;

revoke all on function public.uiu_get_routine_catalog() from public;
revoke all on function public.uiu_get_selected_class_options(jsonb) from public;
revoke all on function public.uiu_publish_routine(text, text, text, jsonb) from public;
revoke all on function public.uiu_track_site_activity(text, boolean) from public;
revoke all on function public.uiu_get_admin_analytics() from public;
revoke all on function public.uiu_get_admin_routine() from public;

grant execute on function public.uiu_get_routine_catalog() to anon, authenticated;
grant execute on function public.uiu_get_selected_class_options(jsonb) to authenticated;
grant execute on function public.uiu_publish_routine(text, text, text, jsonb) to authenticated;
grant execute on function public.uiu_track_site_activity(text, boolean) to authenticated;
grant execute on function public.uiu_get_admin_analytics() to authenticated;
grant execute on function public.uiu_get_admin_routine() to authenticated;
