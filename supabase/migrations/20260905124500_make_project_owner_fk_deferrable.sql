alter table public.projects
  alter constraint projects_user_id_fkey deferrable initially immediate;
