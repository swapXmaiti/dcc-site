# Staging setup for the admin security update

Before testing the staging preview, configure these Netlify environment variables for the deploy-preview context (and later for production only after staging passes):

- `ADMIN_PASSWORD`: the current admin password used to sign in before the first password change. Enter it only in Netlify's environment-variable settings; do not commit it.
- `ADMIN_RECOVERY_KEY`: the private recovery key. If retaining the existing master key, enter that value here directly in Netlify's settings. It is not stored in this repository.
- `APP_SECRET`: a long, randomly generated secret used to sign admin and student sessions. Keep it stable across deploys and never commit it.

After the first successful password change, the new admin password is stored as a salted scrypt hash in the existing Netlify Blobs store. All admin portals use the same password. The recovery key remains an environment-only credential.

Deploy previews use a separate `dcc-staging` Netlify Blobs store. Production continues to use the existing `dcc` store. This prevents staging password changes, test uploads, exam attempts, or test records from affecting live admissions and exam data. The staging store starts empty; upload a disposable test question PDF and create test records there. No admission records are copied or migrated.
