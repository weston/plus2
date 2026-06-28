# Google SSO & WCA integration — setup

These features are **scaffolded** in the codebase but inert until you provide
OAuth credentials via environment variables on the **API** (`apps/api`). The
"Continue with Google" / "Continue with WCA" buttons appear on the login/register
screens; until configured, the API routes respond with `503 not configured`.

Both flows: the SPA links to `GET /api/auth/{google,wca}` → provider consent →
`GET /api/auth/{google,wca}/callback` → the API find-or-creates/links the user
(`AuthService.oauthLogin`) and redirects back to `${WEB_URL}/login?accessToken=…&refreshToken=…`,
which `AuthForm` stores and then routes to the dashboard.

## Shared
- `WEB_URL` — the web app origin (default `http://localhost:3000`). Used for the
  post-login redirect.

## Google SSO
1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth client ID**
   (type: Web application).
2. Add an **Authorized redirect URI**:
   - local: `http://localhost:3001/api/auth/google/callback`
   - prod:  `https://<your-api-domain>/api/auth/google/callback`
3. Set on the API:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_CALLBACK_URL=https://<your-api-domain>/api/auth/google/callback   # optional; defaults to localhost
   WEB_URL=https://<your-web-domain>
   ```
- Scopes used: `openid email profile`. New users are created with a unique
  username derived from their Google name/email + default stats & keybindings.

## WCA integration
1. worldcubeassociation.org → your account → **OAuth applications** → register an app.
2. Redirect URI:
   - local: `http://localhost:3001/api/auth/wca/callback`
   - prod:  `https://<your-api-domain>/api/auth/wca/callback`
3. Set on the API:
   ```
   WCA_CLIENT_ID=...
   WCA_CLIENT_SECRET=...
   WCA_CALLBACK_URL=https://<your-api-domain>/api/auth/wca/callback   # optional; defaults to localhost
   ```
- Scopes used: `public email`. Signing in with WCA links the user's `wcaId`
  (shown on their profile, linking to their WCA page).
- Official records are pulled from the **public** WCA API by id (no creds needed):
  `GET /api/users/wca/:wcaId/records` proxies
  `worldcubeassociation.org/api/v0/persons/:wcaId`.

## Notes / follow-ups
- `passwordHash` is now nullable (OAuth-only accounts). Password login for such an
  account returns "This account uses Google sign-in."
- Account linking is by provider id, then by email. If a user's provider email
  matches an existing local account, it links rather than duplicating.
- **Next step (not yet wired):** turn WCA `personalRecords` into badges (extend
  `computeBadges` in `packages/shared`) and/or show official PBs on the profile.
