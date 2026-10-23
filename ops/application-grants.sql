-- Run as the database owner after creating the dedicated runtime role blackout_api.
-- Give this role its own password/identity outside version control.
GRANT USAGE ON SCHEMA public TO blackout_api;
GRANT SELECT ON platform_admins TO blackout_api;
GRANT SELECT, INSERT, UPDATE ON merchant_accounts, merchant_invitations TO blackout_api;
GRANT SELECT, INSERT, UPDATE ON merchant_bot_setup TO blackout_api;
GRANT SELECT, INSERT ON platform_audit TO blackout_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON api_rate_limits TO blackout_api;
-- No DDL or permission to insert/update/delete platform_admins for the API role.
-- Use a separate, restricted server command credential for migrations/admin bootstrap.
