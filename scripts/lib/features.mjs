// Renders docs/features.html from the docs/features.json data.
//
// Used by scripts/bump.mjs (Step 6, on every stable release) and by
// scripts/regen-features.mjs (manual regeneration after editing
// features.json without cutting a release). Keeping the template here
// means the two paths can never drift.
//
// features.json is a list of groups (see .claude/rules/site.md):
//   { id, title, items[] }
// `items` are one plain sentence each, injected as raw HTML, so links,
// <code> and the <span class="feature-tag">plugin</span> marker render.

const REPO = "outcast1000/vibo";

// The page carries no version number, so callers' `version` is not used.
export function renderFeaturesHtml(features) {
  const groups = features
    .map(
      (g) => `    <section id="${g.id}">
      <h2>${g.title}</h2>
      <ul>
${g.items.map((item) => `        <li>${item}</li>`).join("\n")}
      </ul>
    </section>`,
    )
    .join("\n\n");

  const contents = features.map((g) => `<a href="#${g.id}">${g.title}</a>`).join(" · ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Features — Vibo</title>
  <meta name="description" content="Everything Vibo does, as a plain list: library and sources, playback, listening, editing, AI control, plugins and how it is built.">
  <link rel="canonical" href="https://viboplr.com/features.html">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://viboplr.com/features.html">
  <meta property="og:title" content="Features — Vibo">
  <meta property="og:description" content="Everything Vibo does, as a plain list.">
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="assets/icon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="css/plain.css">
</head>
<body>

  <header class="top">
    <a href="index.html" class="name"><img src="assets/logo-mark.svg" alt="" width="22" height="22">Vibo</a>
    <nav>
      <a href="download.html">Download</a>
      <a href="features.html" aria-current="page">Features</a>
      <a href="plugins.html">Plugins</a>
      <a href="help.html">Help</a>
      <a href="history.html">Changes</a>
      <a href="https://github.com/${REPO}" target="_blank" rel="noopener">GitHub</a>
    </nav>
  </header>

  <main>
    <section>
      <h1>Features</h1>
      <p>Everything Vibo does, as a list. Items marked <span class="feature-tag">plugin</span> need a plugin from the <a href="plugins.html">gallery</a>.</p>
      <p>${contents}</p>
    </section>

${groups}
  </main>

  <footer>
    <a href="download.html">Download</a>
    <a href="help.html">Help</a>
    <a href="community.html">Community</a>
    <a href="support.html">Support the project</a>
    <a href="https://github.com/${REPO}" target="_blank" rel="noopener">GitHub</a>
  </footer>

  <script defer src="js/analytics.js"></script>
  <script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "cbb978698d3744cca00a24f8cac8bc3c"}'></script>
</body>
</html>
`;
}
