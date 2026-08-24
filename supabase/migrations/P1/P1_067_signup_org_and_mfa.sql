
-- New-user onboarding: self-service signup must create an organization
-- context before the profile can access any organization-scoped resource.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, core
AS $$
DECLARE
  v_org_id uuid;
  v_org_name text;
BEGIN
  v_org_name := NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'organization_name', '')), '');

  IF v_org_name IS NOT NULL THEN
    INSERT INTO core.organizations (
      name, legal_name, created_by, is_active
    ) VALUES (
      v_org_name, v_org_name, NEW.id, true
    )
    RETURNING id INTO v_org_id;
  END IF;

  INSERT INTO public.profiles (
    user_id, full_name, role, email, organization_id,
    can_create_project, can_edit_project, can_delete_project,
    can_add_income, can_edit_income, can_delete_income,
    can_add_expense, can_edit_expense, can_delete_expense,
    can_create_invoice, can_edit_invoice, can_delete_invoice
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    CASE WHEN v_org_id IS NOT NULL THEN 'CEO' ELSE 'EMPLOYEE' END,
    NEW.email,
    v_org_id,
    false, false, false,
    false, false, false,
    false, false, false,
    false, false, false
  );

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
'Creates an organization-scoped profile for self-service signups when organization_name is supplied. Existing admin-created users without organization metadata remain unassigned until explicitly provisioned.';
