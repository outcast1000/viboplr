// Runs inside the umami container (node, from setup.sh) against its own API.
// Idempotent: the admin password ends up equal to UMAMI_ADMIN_PASSWORD, and a
// website with id WEBSITE_ID exists. Prints no secrets.
const BASE = "http://localhost:3000/api";
const { UMAMI_ADMIN_PASSWORD: password, WEBSITE_ID: websiteId, WEBSITE_DOMAIN: domain } = process.env;

async function call(path, { token, method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, data: text ? JSON.parse(text) : null };
}

const login = (pw) => call("/auth/login", { method: "POST", body: { username: "admin", password: pw } });

(async () => {
  if (!password || password.length < 12) throw new Error("UMAMI_ADMIN_PASSWORD must be at least 12 characters");
  if (!/^[0-9a-f-]{36}$/.test(websiteId ?? "")) throw new Error("WEBSITE_ID must be a UUID");

  let auth = await login(password);
  if (!auth.ok) {
    // First run: still on Umami's default login. Replace it before anything
    // else, so the dashboard is never reachable with admin/umami.
    const first = await login("umami");
    if (!first.ok) throw new Error(`admin login failed with both passwords (HTTP ${auth.status})`);
    const changed = await call("/me/password", {
      token: first.data.token, method: "POST", body: { currentPassword: "umami", newPassword: password },
    });
    if (!changed.ok) throw new Error(`password change failed (HTTP ${changed.status})`);
    console.log("Admin password set from the UMAMI_ADMIN_PASSWORD secret");
    auth = await login(password);
    if (!auth.ok) throw new Error("login with the new password failed");
  }
  const token = auth.data.token;

  const sites = await call("/websites?pageSize=100", { token });
  const existing = (sites.data?.data ?? []).find((w) => w.id === websiteId);
  if (existing) {
    console.log(`Website ready: ${existing.name} (${existing.id})`);
  } else {
    const created = await call("/websites", { token, method: "POST", body: { id: websiteId, name: domain, domain } });
    if (!created.ok) throw new Error(`website create failed (HTTP ${created.status}): ${JSON.stringify(created.data)}`);
    console.log(`Website created: ${domain} (${websiteId})`);
  }
})().catch((e) => {
  console.error(`bootstrap: ${e.message}`);
  process.exit(1);
});
