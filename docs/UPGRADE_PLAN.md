# Debasish Chemistry Classes — Upgrade Plan

This upgrade is being developed on the `website-upgrade` branch. The production branch and live website are not changed by this plan.

## Non-negotiable data protection

- Do not reset, migrate destructively, or replace the existing `admissions`, `enquiries`, `exams`, `res:`, `sess:`, or `pdf:` Netlify Blobs records.
- Keep existing Student IDs and passwords intact. The Class Portal should authenticate against the existing admission records unless the owner explicitly chooses a separate credential store later.
- Make additive, namespaced storage keys for class portal data (for example `classes:`, `class-access:`, and `class-views:`).
- Do not deploy to production until a backup/export and a read-only data verification have been completed.

## 1. Shared admin security

Current backend detail: `ADMIN_PASSWORD` is checked server-side, but the code falls back to a documented default when the environment variable is absent. That default is therefore not a safe recovery secret.

Target design:
- Require a strong `ADMIN_PASSWORD` Netlify environment variable; remove the default fallback.
- Add a separate owner-only `DCC_MASTER_RECOVERY_KEY` environment variable. Never put it in frontend code, Git, logs, API responses, or normal admin screens.
- Store a salted password hash and credential version in Netlify Blobs; compare hashes server-side.
- Add an authenticated admin password-change action and a separate recovery action protected by the owner-only recovery key.
- Rotate the signing secret and invalidate old admin sessions after password changes/recovery.
- Do not change credentials or environment variables automatically during a branch preview.

Required Netlify variables before deployment: `ADMIN_PASSWORD`, `DCC_MASTER_RECOVERY_KEY`, and a high-entropy `APP_SECRET`.

## 2. Class Portal

Homepage: add a Class Portal entry beside Exam Portal.

Separate Class Portal admin and student views:
- Admin: create/edit/archive class sessions, paste a Google Meet URL, set title, class/batch, date/time and publish status.
- Student: authenticate using the existing Student ID/password and see only published sessions relevant to them.
- Store all class records under namespaced keys, never by rewriting admission records.
- Keep Meet links private to authenticated enrolled students; validate Meet URLs server-side.

## 3. Google Meet recording integration (account eligibility unknown)

Use an eligibility-tolerant integration:
- Admin connects the personal Google account using OAuth. Client ID, client secret and redirect URI are Netlify environment variables; OAuth tokens are stored server-side only.
- Request the minimum Drive scope needed to find and stream the organiser's Meet recordings. Do not expose refresh tokens to the browser.
- List only video recordings in the connected account's Meet recordings location; show a clear "recording unavailable / recording feature not enabled for this Google account" state when none are available.
- Never assume a personal Gmail account can record Meet calls. The feature depends on Google's current account/plan eligibility and host settings.
- Match a recording to a class by admin confirmation (do not silently grant access based only on a guessed filename/date).
- If Google OAuth is not configured or the account cannot record, keep the Class Portal usable for live Meet links and show the reason recordings are unavailable. Do not silently fall back to public Drive links.

Required Google Cloud setup: OAuth consent screen, OAuth web client, authorised redirect URI, and Drive API enabled. Required Netlify variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

## 4. Recording permissions and view limits

- Admin can search existing admitted students by Student ID/name and grant or revoke access per recording.
- Store access rules and view counters separately from admissions.
- Check permission and remaining view allowance on the server before every playback session; increment counts server-side.
- Do not use public or "anyone with the link" Drive sharing.
- Use a short-lived authenticated playback proxy/session rather than exposing a reusable Drive URL.
- Explain honestly that no browser can fully prevent screenshots, screen recording, or filming another display. Watermarks, fullscreen prompts and tab-switch detection are deterrents, not guarantees.

## 5. Exam portal safeguards

- Add fullscreen entry and a clear exam integrity notice.
- Detect visibility changes/tab switches and log warnings server-side; use a configurable warning threshold and teacher-selected policy.
- Do not claim screenshots can be blocked. Operating systems, browser extensions, external cameras and other devices can bypass browser restrictions.
- Preserve current exam attempts, results, question PDFs and answer keys.
- The current question-paper upload already sends the PDF to Netlify Blobs, so a PDF uploaded from another device is available after the admin signs in to the shared backend. Add a clear download action only after verifying the stored paper is present.

## 6. Testing and release gates

1. Confirm the branch starts from the intended production commit.
2. Add tests for authentication, access-control checks, view-count enforcement, OAuth state validation, token secrecy, and no-data-loss behaviour.
3. Test with a copy/staging Netlify site and a separate Blobs store. Never run migration tests against production data.
4. Verify the existing admission list, student credentials, exam settings, PDFs, active attempts and results remain unchanged.
5. Configure secrets and Google OAuth on the staging Netlify site.
6. Review the branch diff and preview with the site owner.
7. Merge/deploy only after explicit owner approval.

## Current implementation status (branch preview only)

Implemented on `website-upgrade`:
- [x] Shared admin password change and owner recovery API, salted scrypt password hash, credential-version invalidation.
- [x] Class Portal homepage entry and modal.
- [x] Class admin can create/publish/archive classes with Google Meet links.
- [x] Class student login reuses existing Student ID/password fields from admissions; class records use separate `classes:list` storage.
- [x] Google OAuth connect flow and encrypted server-side refresh-token storage.
- [x] Google Drive video discovery; teacher explicitly attaches a chosen video to a class.
- [x] Per-student recording grant/revoke and view-limit checks; playback is proxied through the function, not exposed as a public Drive link.
- [x] Exam tab-visibility/fullscreen deterrents and server-side warning records.
- [x] Authenticated exam question PDF download.

Still required before this can be considered production-ready:
- [ ] Configure Netlify environment variables and Google Cloud OAuth/Drive API; the account's recording eligibility must be confirmed by the teacher in Google Meet.
- [x] Static JavaScript syntax parsing completed for the backend module and all inline frontend scripts.
- [ ] Run API, authorization, OAuth callback, playback-range, concurrency, and browser tests on a staging deploy. No staging integration test has been run from this branch yet.
- [ ] Review the recording view-limit implementation under concurrent requests; Blobs do not provide a transactional counter, so strict anti-abuse guarantees are not claimed.
- [ ] Back up and verify production Blobs before deployment; no admission records have been intentionally rewritten by these additions.
- [ ] Confirm OAuth consent-screen verification requirements for the restricted Drive scope.
- [ ] Review branch diff and approve merge/deployment.

## Required Netlify environment variables

Required for backend authentication:
- `ADMIN_PASSWORD`: strong initial shared admin password (12+ characters).
- `APP_SECRET`: long random secret used for session signing and encryption.
- `DCC_MASTER_RECOVERY_KEY`: private owner recovery key. If the owner wants to retain `DM@123`, set this value privately in Netlify; do not commit it.

Required for Google Drive integration:
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`: exactly `https://YOUR-SITE/.netlify/functions/api` (replace with the deployed site's domain; configure the same URI in Google Cloud Console).

Enable the Google Drive API and configure an OAuth web client. The `drive.readonly` scope is restricted; Google may require OAuth app verification and a security assessment. Meet recording itself remains dependent on Google's subscription eligibility and host-side recording controls. The portal cannot force an ineligible account to record.

## Honest technical limits

- Browser code cannot block operating-system screenshots, external screen recording, browser extensions or filming another display. Exam focus detection is a deterrent, not a guarantee.
- A recording is discoverable only after Google Meet has actually created it in the connected Drive account.
- Per-student playback permissions and view counters are server-checked, but concurrent playback requests can race because Netlify Blobs is not a transactional counter. Do not describe the counter as tamper-proof.
- This branch has not been deployed or tested against production data. Do not merge or deploy until the release gates above are complete.
