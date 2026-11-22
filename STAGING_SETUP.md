# Staging setup for the admin security update

Before testing the staging preview, configure these Netlify environment variables for the deploy-preview context (and later for production only after staging passes):

- `ADMIN_PASSWORD`: the current admin password used to sign in before the first password change. Enter it only in Netlify's environment-variable settings; do not commit it.
- `ADMIN_RECOVERY_KEY`: the private recovery key. If retaining the existing master key, enter that value here directly in Netlify's settings. It is not stored in this repository.
- `APP_SECRET`: a long, randomly generated secret used to sign admin and student sessions. Keep it stable across deploys and never commit it.

After the first successful password change, the new admin password is stored as a salted scrypt hash in the existing Netlify Blobs store. All admin portals use the same password. The recovery key remains an environment-only credential.

The code changes in this branch do not write to or migrate admissions records. The existing `dcc` Blobs store and its admission data are left untouched.
