DEBASISH CHEMISTRY CLASSES - website with shared exam portal
============================================================

Folder layout (keep it exactly like this):
  public/index.html              the website
  netlify/functions/api.mjs      the shared server (admissions, exam papers, answer keys, results)
  netlify.toml, package.json     Netlify settings

IMPORTANT: Netlify's drag-and-drop upload does NOT publish the server function.
Deploy from GitHub (no coding needed) or with the Netlify CLI.

OPTION A - GitHub (browser only)
  1. Create a free account at github.com and make a new repository (private is fine).
  2. Click "Add file" > "Upload files" and drag in everything from this folder
     (public, netlify, netlify.toml, package.json). Commit.
  3. In Netlify open your site > Site configuration > Build & deploy > Continuous deployment >
     "Link repository" and pick the GitHub repo. (Or "Add new site" > "Import an existing project".)
     Leave the build command empty. Netlify reads netlify.toml and installs @netlify/blobs by itself.
  4. Wait for the deploy to finish. The site is live at the same address.

OPTION B - Netlify CLI (on a computer with Node.js)
  npm install -g netlify-cli
  netlify login
  netlify link        (choose your existing site)
  npm install
  netlify deploy --prod

CHANGE THE PASSWORD
  The admin password defaults to DM@123. To change it: Netlify > Site configuration >
  Environment variables > add ADMIN_PASSWORD with the new value, then redeploy.
  The password is checked only on the server; it is not inside the web page.

FIRST LOGIN
  Open the Admin Portal (or Exam Portal > Admin Login) in the SAME browser you used before.
  The first successful login uploads that browser's saved admissions and exam settings to the server.
  After that, every device sees the same data. Use the Refresh button in the Admin Portal to load
  new admission forms and enquiries submitted by visitors.

LIMITS
  - Question paper PDF: up to about 4 MB (Netlify function request limit).
  - Answers are A-D multiple choice only.
