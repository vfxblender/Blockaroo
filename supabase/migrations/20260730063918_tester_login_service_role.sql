-- Temporary pre-alpha tester provisioning runs only inside the JWT-protected
-- tester-login Edge Function. The service role bypasses RLS but still needs
-- explicit table privileges in this project.
grant select, insert, update, delete
  on table
    public.profiles,
    public.homes,
    public.neighbors,
    public.user_blocks
  to service_role;
