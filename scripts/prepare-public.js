#!/usr/bin/env node
/**
 * prepare-public.js — Strip Enigma-specific authentication code for the
 * open-source GitHub release. Master retains everything; this script runs
 * on the github-release branch after `git checkout master -- .` to produce
 * a clean local-auth-only codebase.
 *
 * Usage (inside publish workflow):
 *   git checkout github-release
 *   git rm -rf . && git checkout master -- .
 *   node scripts/prepare-public.js          # <-- this script
 *   git rm -r .gitea .claude
 *   git add -A && git commit -m "Sync with upstream"
 */

import fs from 'fs';

// ─── Helpers ─────────────────────────────────────────────────

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, c) { fs.writeFileSync(p, c); }
function rm(p) { try { fs.unlinkSync(p); } catch {} }
function dedent(text, n) {
  const pfx = ' '.repeat(n);
  return text.split('\n').map(l => l.startsWith(pfx) ? l.slice(n) : l).join('\n');
}

/** Remove everything between two marker strings (inclusive of start, exclusive of end). */
function cutBetween(code, startMarker, endMarker) {
  const a = code.indexOf(startMarker);
  const b = code.indexOf(endMarker, a);
  if (a === -1 || b === -1) throw new Error(`Markers not found:\n  start: ${startMarker.slice(0, 60)}\n  end: ${endMarker.slice(0, 60)}`);
  return code.slice(0, a) + code.slice(b);
}

/** Remove a {authProvider === 'enigma' ? (...) : (...)} ternary, keeping only the local branch. */
function stripEnigmaTernary(code) {
  const needle = "{authProvider === 'enigma' ? (";
  const idx = code.indexOf(needle);
  if (idx === -1) return code;

  // Determine indentation of the ternary line
  const lineStart = code.lastIndexOf('\n', idx) + 1;
  const indent = code.slice(lineStart, idx);

  // Find the closing `)}` at the same indentation
  const closeNeedle = `\n${indent})}\n`;
  const closeIdx = code.indexOf(closeNeedle, idx);
  if (closeIdx === -1) throw new Error('Cannot find ternary close for enigma branch');

  // Find `) : (` separator
  const sepNeedle = `\n${indent}) : (\n`;
  const sepIdx = code.indexOf(sepNeedle, idx);
  if (sepIdx === -1) throw new Error('Cannot find ternary separator for enigma branch');

  // Extract local branch (between separator and close)
  let localBranch = code.slice(sepIdx + sepNeedle.length, closeIdx);

  // Remove <> and </> wrapper lines
  localBranch = localBranch.replace(/^[ ]*<>\n/, '');
  localBranch = localBranch.replace(/\n[ ]*<\/>$/, '');

  // Dedent by 4 (2 for ternary arm + 2 for fragment wrapper)
  localBranch = dedent(localBranch, 4);

  return code.slice(0, lineStart) + localBranch + code.slice(closeIdx + closeNeedle.length);
}

let changed = 0;
function done(label) { changed++; console.log(`  [${changed}] ${label}`); }

console.log('[prepare-public] Stripping Enigma auth code for open-source release...\n');

// ═══════════════════════════════════════════════════════════════
// 1. DELETE Enigma-only files
// ═══════════════════════════════════════════════════════════════

rm('src/services/oauth.js');
rm('src/services/license.js');
rm('frontend/src/components/FeedbackModal.tsx');
rm('migrations/021_oauth.sql');
done('Deleted: oauth.js, license.js, FeedbackModal.tsx, 021_oauth.sql');

// ═══════════════════════════════════════════════════════════════
// 2. BACKEND transforms
// ═══════════════════════════════════════════════════════════════

// ── src/routes/auth.js ───────────────────────────────────────
{
  let c = read('src/routes/auth.js');

  // Remove license import
  c = c.replace(
    "import { extractAndSaveLicenseFromUserinfo, getLicenseStatus } from '../services/license.js';\n",
    ''
  );

  // Remove AUTH_PROVIDER const
  c = c.replace(
    "const AUTH_PROVIDER = process.env.AUTH_PROVIDER || 'local';\n",
    ''
  );

  // Remove entire OAuth2/enigma section (from section comment to local section comment)
  c = cutBetween(c,
    '// ─── OAuth2 endpoints (enigma provider only)',
    '// ─── Local auth endpoints (local provider only)'
  );

  // Unwrap local auth block: extract content, remove if guard, dedent
  {
    const marker = '// ─── Local auth endpoints (local provider only) ─────────────';
    const tokenMgmt = '// ─── Token management (unchanged) ───────────────────────────';
    const a = c.indexOf(marker);
    const b = c.indexOf(tokenMgmt);
    if (a === -1 || b === -1) throw new Error('Cannot find local auth section markers');

    let block = c.slice(a + marker.length, b);
    // Remove the if guard opening
    block = block.replace("\nif (AUTH_PROVIDER === 'local') {\n", '\n');
    // Remove the closing brace (last `}\n\n` before token management)
    block = block.replace(/\}\n\n$/, '\n');
    // Dedent the content by 2 spaces (was inside if block)
    block = dedent(block, 2);
    c = c.slice(0, a) + block + c.slice(b);
  }

  // Remove __oauth__ check in login
  c = c.replace(" || user.password_hash === '__oauth__'", '');

  // Remove authProvider from /me response
  c = c.replace(', authProvider: AUTH_PROVIDER', '');

  // Remove enigma license block in /me
  {
    const marker = "  if (AUTH_PROVIDER === 'enigma') {\n";
    const a = c.indexOf(marker);
    if (a !== -1) {
      const b = c.indexOf('\n  }\n', a);
      if (b !== -1) c = c.slice(0, a) + c.slice(b + 4);
    }
  }

  write('src/routes/auth.js', c);
  done('Cleaned: src/routes/auth.js');
}

// ── src/routes/setup.js ──────────────────────────────────────
{
  let c = read('src/routes/setup.js');

  c = c.replace(
    "import { getInstanceId } from '../services/license.js';\n",
    ''
  );
  c = c.replace('    instanceId: getInstanceId(),\n', '');
  c = c.replace("    authProvider: process.env.AUTH_PROVIDER || 'local',\n", '');
  c = c.replace(
    "  if ((process.env.AUTH_PROVIDER || 'local') !== 'local') {\n" +
    "    return res.status(400).json({ error: 'Local registration not available with this auth provider' });\n" +
    "  }\n\n",
    ''
  );

  write('src/routes/setup.js', c);
  done('Cleaned: src/routes/setup.js');
}

// ── src/routes/system.js ─────────────────────────────────────
{
  let c = read('src/routes/system.js');

  // Remove the entire Feedback section (imports, version block, endpoint)
  c = cutBetween(c,
    '// ==================== Feedback ====================\n',
    '// POST /api/cleanup/run'
  );

  write('src/routes/system.js', c);
  done('Cleaned: src/routes/system.js');
}

// ── src/routes/users.js ──────────────────────────────────────
{
  let c = read('src/routes/users.js');

  // Remove AUTH_PROVIDER guard on password endpoint
  c = c.replace(
    "  if ((process.env.AUTH_PROVIDER || 'local') !== 'local') {\n" +
    "    return res.status(410).json({ error: 'Password management is handled by the Enigma Platform.' });\n" +
    "  }\n\n",
    ''
  );

  // Remove __oauth__ check
  c = c.replace(" || user.password_hash === '__oauth__'", '');

  write('src/routes/users.js', c);
  done('Cleaned: src/routes/users.js');
}

// ── src/server.js ────────────────────────────────────────────
{
  let c = read('src/server.js');

  c = c.replace(
    "import { startLicenseChecker } from './services/license.js';\nstartLicenseChecker();\n",
    ''
  );

  write('src/server.js', c);
  done('Cleaned: src/server.js');
}

// ═══════════════════════════════════════════════════════════════
// 3. FRONTEND transforms
// ═══════════════════════════════════════════════════════════════

// ── frontend/src/api/client.ts ───────────────────────────────
{
  let c = read('frontend/src/api/client.ts');

  // Clean SetupStatus: remove authProvider and platformUrl
  c = c.replace(
    "  authProvider: 'local' | 'enigma';\n  platformUrl?: string;\n",
    ''
  );

  // Remove getLoginUrl function
  c = cutBetween(c,
    "export async function getLoginUrl()",
    "export const createAdmin"
  );

  // Remove License interface
  c = cutBetween(c, 'export interface License {\n', 'export interface AuthMeResponse');

  // Clean AuthMeResponse: remove enigma fields
  c = c.replace(
    "  authProvider?: 'local' | 'enigma';\n  platformUrl?: string;\n  license?: License | null;\n",
    ''
  );

  // Remove Feedback section (FeedbackData + submitFeedback)
  c = cutBetween(c, '// Feedback\n', '// Templates\n');

  write('frontend/src/api/client.ts', c);
  done('Cleaned: frontend/src/api/client.ts');
}

// ── frontend/src/contexts/AuthContext.tsx ─────────────────────
{
  let c = read('frontend/src/contexts/AuthContext.tsx');

  // Remove License from import
  c = c.replace(', type License', '');

  // Remove platformUrl and license from context interface
  c = c.replace('  platformUrl: string | null;\n  license: License | null;\n', '');

  // Remove state declarations
  c = c.replace(
    "  const [platformUrl, setPlatformUrl] = useState<string | null>(null);\n",
    ''
  );
  c = c.replace(
    "  const [license, setLicense] = useState<License | null>(null);\n",
    ''
  );

  // Remove from refresh callback
  c = c.replace(
    "        if (data.platformUrl) setPlatformUrl(data.platformUrl);\n" +
    "        setLicense(data.license || null);\n",
    ''
  );

  // Remove from provider value
  c = c.replace(
    '{ user, orgs, currentOrg, platformUrl, license, loading, switchOrg, logout, refresh, setAuth }',
    '{ user, orgs, currentOrg, loading, switchOrg, logout, refresh, setAuth }'
  );

  write('frontend/src/contexts/AuthContext.tsx', c);
  done('Cleaned: frontend/src/contexts/AuthContext.tsx');
}

// ── frontend/src/pages/Login.tsx ─────────────────────────────
{
  let c = read('frontend/src/pages/Login.tsx');

  // Simplify imports
  c = c.replace(
    "import { getLoginUrl, login as apiLogin, getSetupStatus } from '../api/client';",
    "import { login as apiLogin } from '../api/client';"
  );

  // Remove authProvider and platformUrl state
  c = c.replace(
    "  const [authProvider, setAuthProvider] = useState<'local' | 'enigma' | null>(null);\n" +
    "  const [platformUrl, setPlatformUrl] = useState('');\n",
    ''
  );

  // Remove setup status check from useEffect (keep error code handling)
  c = c.replace(
    "    getSetupStatus().then(s => setAuthProvider(s.authProvider)).catch(() => setAuthProvider('local'));\n",
    ''
  );

  // Remove handleOAuthLogin
  c = cutBetween(c,
    '  const handleOAuthLogin = async ',
    '  const handleLocalLogin = async '
  );

  // Remove authProvider guard
  c = c.replace("  if (!authProvider) return null;\n\n", '');

  // Replace enigma ternary with local-only content
  c = stripEnigmaTernary(c);

  write('frontend/src/pages/Login.tsx', c);
  done('Cleaned: frontend/src/pages/Login.tsx');
}

// ── frontend/src/pages/Setup.tsx ─────────────────────────────
{
  let c = read('frontend/src/pages/Setup.tsx');

  // Remove getLoginUrl from imports
  c = c.replace(
    "import { getLoginUrl, completeSetup, getRuntimes, detectRuntimes, createAdmin, getSetupStatus, RuntimeInfo } from '../api/client';",
    "import { completeSetup, getRuntimes, detectRuntimes, createAdmin, getSetupStatus, RuntimeInfo } from '../api/client';"
  );

  // Remove authProvider state
  c = c.replace(
    "  const [authProvider, setAuthProvider] = useState<'local' | 'enigma'>('local');\n",
    ''
  );

  // Simplify step label (remove enigma ternary)
  c = c.replace(
    "    { key: 'auth', label: authProvider === 'enigma' ? 'Sign In' : 'Admin Account' },",
    "    { key: 'auth', label: 'Admin Account' },"
  );

  // Remove setup status check for authProvider
  c = c.replace(
    "    getSetupStatus().then(s => setAuthProvider(s.authProvider)).catch(() => {});\n",
    ''
  );

  // Remove the empty useEffect that's left over
  c = c.replace(
    "  useEffect(() => {\n  }, []);\n\n",
    ''
  );

  // Remove handlePlatformLogin (enigma sign-in handler)
  c = cutBetween(c,
    '  // --- Sign in with Platform (enigma) ---\n',
    '  // --- Create local admin ---\n'
  );

  // Remove the enigma auth step
  c = cutBetween(c,
    "          {step === 'auth' && authProvider === 'enigma' && (\n",
    "          {step === 'auth' && authProvider === 'local' && (\n"
  );

  // Simplify the local auth condition (remove authProvider check)
  c = c.replace(
    "          {step === 'auth' && authProvider === 'local' && (",
    "          {step === 'auth' && ("
  );

  write('frontend/src/pages/Setup.tsx', c);
  done('Cleaned: frontend/src/pages/Setup.tsx');
}

// ── frontend/src/pages/Register.tsx ──────────────────────────
{
  let c = read('frontend/src/pages/Register.tsx');

  // Simplify imports
  c = c.replace(
    "import { getLoginUrl, register as apiRegister, getSetupStatus } from '../api/client';",
    "import { register as apiRegister } from '../api/client';"
  );

  // Remove authProvider, platformUrl state
  c = c.replace(
    "  const [authProvider, setAuthProvider] = useState<'local' | 'enigma' | null>(null);\n" +
    "  const [platformUrl, setPlatformUrl] = useState('');\n",
    ''
  );

  // Remove setup status check
  c = c.replace(
    "    getSetupStatus().then(s => setAuthProvider(s.authProvider)).catch(() => setAuthProvider('local'));\n",
    ''
  );

  // Remove handleOAuthRegister
  c = cutBetween(c,
    '  const handleOAuthRegister = async ',
    '  const handleLocalRegister = async '
  );

  // Remove authProvider guard
  c = c.replace("  if (!authProvider) return null;\n\n", '');

  // Replace enigma ternary with local-only content
  c = stripEnigmaTernary(c);

  write('frontend/src/pages/Register.tsx', c);
  done('Cleaned: frontend/src/pages/Register.tsx');
}

// ── frontend/src/components/Sidebar.tsx ──────────────────────
{
  let c = read('frontend/src/components/Sidebar.tsx');

  // Remove FeedbackModal import
  c = c.replace("import FeedbackModal from './FeedbackModal';\n", '');

  // Remove platformUrl, license from useAuth destructure
  c = c.replace(
    '  const { user, platformUrl, license, logout } = useAuth();',
    '  const { user, logout } = useAuth();'
  );

  // Remove showFeedback state
  c = c.replace(
    "  const [showFeedback, setShowFeedback] = useState(false);\n",
    ''
  );

  // Remove license badge section
  c = cutBetween(c,
    '        {/* License badge */}\n',
    '        {/* Footer */}\n'
  );

  // Remove platformUrl links and Send Feedback button (keep Sign Out)
  c = cutBetween(c,
    '                  {platformUrl && (\n',
    "                  <button\n                    onClick={() => { setShowUserMenu(false); logout(); }}\n"
  );

  // Remove FeedbackModal render
  c = c.replace(
    "      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}\n",
    ''
  );

  write('frontend/src/components/Sidebar.tsx', c);
  done('Cleaned: frontend/src/components/Sidebar.tsx');
}

// ═══════════════════════════════════════════════════════════════
// 4. TEST transforms
// ═══════════════════════════════════════════════════════════════

// ── tests/setup.js ───────────────────────────────────────────
{
  let c = read('tests/setup.js');

  // Remove platform_user_id from test user creation
  c = c.replace(
    "  const platformUserId = overrides.platformUserId || `plat-${userId}`;\n",
    ''
  );
  c = c.replace(
    "    'INSERT INTO users (id, email, name, password_hash, platform_user_id) VALUES (?, ?, ?, ?, ?)',\n" +
    "    [userId, email.toLowerCase(), name, '__oauth__', platformUserId]\n",
    "    'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)',\n" +
    "    [userId, email.toLowerCase(), name, 'not_hashed_for_tests']\n"
  );

  write('tests/setup.js', c);
  done('Cleaned: tests/setup.js');
}

// ── tests/auth.test.js ──────────────────────────────────────
{
  let c = read('tests/auth.test.js');

  // Remove AUTH_PROVIDER comment
  c = c.replace(
    '// Tests run with AUTH_PROVIDER=local (the default)\n',
    ''
  );

  // Remove "rejects OAuth-only user" test case
  c = cutBetween(c,
    "    it('rejects OAuth-only user trying local login'",
    "    it('rejects missing email'"
  );

  // Remove "rejects for OAuth-only users" test in password section
  c = cutBetween(c,
    "    it('rejects for OAuth-only users'",
    '  });\n\n  // ─── OAuth endpoints'
  );

  // Remove the entire "OAuth endpoints in local mode" describe block
  c = cutBetween(c,
    '  // ─── OAuth endpoints not available in local mode',
    '});\n'
  );
  // Add back the closing `});`
  c = c + '});\n';

  write('tests/auth.test.js', c);
  done('Cleaned: tests/auth.test.js');
}

// ── tests/setup-wizard.test.js ──────────────────────────────
{
  let c = read('tests/setup-wizard.test.js');

  // Remove AUTH_PROVIDER comment
  c = c.replace(
    '// Tests run with AUTH_PROVIDER=local (the default)\n',
    ''
  );

  // Remove assertions for fields we stripped from the status response
  c = c.replace("      assert.ok(res.body.instanceId);\n", '');
  c = c.replace("      assert.equal(res.body.authProvider, 'local');\n", '');

  // Remove instanceId stability test
  c = cutBetween(c,
    "    it('returns stable instanceId across calls'",
    "    it('does not include platformUrl"
  );

  // Remove platformUrl test
  c = cutBetween(c,
    "    it('does not include platformUrl in local mode'",
    '  });\n\n  // ─── POST /api/setup/create-admin'
  );

  write('tests/setup-wizard.test.js', c);
  done('Cleaned: tests/setup-wizard.test.js');
}

// ═══════════════════════════════════════════════════════════════
// 4b. STALE COMMENT cleanup
// ═══════════════════════════════════════════════════════════════

// ── src/routes/setup.js — stale OAuth comment ────────────────
{
  let c = read('src/routes/setup.js');
  c = c.replace(
    'Called after the user has authenticated (via OAuth or local admin creation).',
    'Called after the admin account has been created.'
  );
  write('src/routes/setup.js', c);
  done('Cleaned stale comment: src/routes/setup.js');
}

// ── frontend/src/api/client.ts — stale section comment ──────
{
  let c = read('frontend/src/api/client.ts');
  c = c.replace('// Setup & OAuth\n', '// Setup\n');
  write('frontend/src/api/client.ts', c);
  done('Cleaned stale comment: frontend/src/api/client.ts');
}

// ── frontend/src/App.tsx — stale OAuth comment ──────────────
{
  let c = read('frontend/src/App.tsx');
  c = c.replace(
    '// User exists but setup not finished (came back from OAuth, needs runtimes + template)',
    '// User exists but setup not finished (needs runtimes + template)'
  );
  write('frontend/src/App.tsx', c);
  done('Cleaned stale comment: frontend/src/App.tsx');
}

// ═══════════════════════════════════════════════════════════════
// 5. CONFIG transforms
// ═══════════════════════════════════════════════════════════════

// ── README.md ────────────────────────────────────────────────
{
  let c = read('README.md');

  // Fix clone URLs to the public GitHub repo
  c = c.replace(
    /https:\/\/github\.com\/enigma-labs\/Nebula\.git/g,
    'https://github.com/reforia/Nebula.git'
  );

  // Remove AUTH_PROVIDER row from the config table
  c = c.replace(
    /\| `AUTH_PROVIDER` \|[^\n]*\n/,
    ''
  );

  write('README.md', c);
  done('Cleaned: README.md');
}

// ── .env.example ─────────────────────────────────────────────
{
  let c = read('.env.example');

  // Remove AUTH_PROVIDER line
  c = c.replace(
    '# Auth provider: "local" (email/password) or "enigma" (Enigma Platform OAuth)\n' +
    '# Self-hosted users should use "local" — no external account required.\n' +
    'AUTH_PROVIDER=local\n',
    ''
  );

  // Remove Enigma Platform OAuth section
  c = c.replace(
    '\n# --- Enigma Platform OAuth (only needed when AUTH_PROVIDER=enigma) ---\n' +
    '# OAUTH_REDIRECT_URI=http://your-server:8080/api/auth/callback\n' +
    '# PLATFORM_URL=https://your-platform-url\n',
    ''
  );

  write('.env.example', c);
  done('Cleaned: .env.example');
}

// ── docker-compose.yml ───────────────────────────────────────
{
  let c = read('docker-compose.yml');

  c = c.replace('      - AUTH_PROVIDER=${AUTH_PROVIDER:-local}\n', '');
  c = c.replace('      - OAUTH_REDIRECT_URI=${OAUTH_REDIRECT_URI:-}\n', '');
  c = c.replace('      - PLATFORM_URL=${PLATFORM_URL:-}\n', '');

  write('docker-compose.yml', c);
  done('Cleaned: docker-compose.yml');
}

// ═══════════════════════════════════════════════════════════════
// 6. Self-removal — this script shouldn't ship in the public repo
// ═══════════════════════════════════════════════════════════════

rm('scripts/prepare-public.js');
done('Self-deleted: scripts/prepare-public.js');

console.log(`\n[prepare-public] Done — ${changed} operations completed.`);
console.log('Next: git rm -r .gitea .claude && git add -A && git commit');
