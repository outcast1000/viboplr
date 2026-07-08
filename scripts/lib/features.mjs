// Renders docs/features.html from the docs/features.json data.
//
// Used by scripts/bump.mjs (Step 6, on every stable release) and by
// scripts/regen-features.mjs (manual regeneration after editing
// features.json without cutting a release). Keeping the template here
// means the two paths can never drift.
//
// Feature entry shape (see .claude/rules/site.md):
//   { label, heading, description, items[], screenshot, screenshotAlt,
//     screenshotWidth?, screenshotHeight?, group?, groupDescription? }
//
// `group` starts a new titled group section when it differs from the
// previous entry's group (entries must be ordered so groups are
// contiguous). `groupDescription` is only read on the entry that opens
// the group. Entries without `group` continue the current group.

const REPO = "outcast1000/viboplr";

export function renderFeaturesHtml(features, version) {
  const dmgUrl = `https://github.com/${REPO}/releases/download/v${version}/Viboplr_${version}_aarch64.dmg`;

  let lastGroup = null;
  const featureSections = features
    .map(
      (f) => {
        const w = f.screenshotWidth || 2560;
        const h = f.screenshotHeight || 1600;
        const imgTag = f.screenshot
          ? `<img src="assets/screenshots/${f.screenshot}" alt="${f.screenshotAlt || ""}" loading="lazy" width="${w}" height="${h}">`
          : `<span>${f.label} screenshot &mdash; coming soon</span>`;
        const groupHeader = f.group && f.group !== lastGroup
          ? `      <div class="feature-group-header reveal">
        <h2>${f.group}</h2>${f.groupDescription ? `\n        <p>${f.groupDescription}</p>` : ""}
      </div>
`
          : "";
        lastGroup = f.group ?? lastGroup;
        return `  <!-- Feature: ${f.label} -->
  <section class="feature-section">
    <div class="container">
${groupHeader}      <div class="feature-row reveal">
        <div class="feature-content">
          <span class="feature-label">${f.label}</span>
          <h2>${f.heading}</h2>
          <p>${f.description}</p>
          <div class="feature-list">
${f.items.map((item) => `            <div class="feature-list-item">${item}</div>`).join("\n")}
          </div>
        </div>
        <div class="feature-image">
          ${imgTag}
        </div>
      </div>
    </div>
  </section>`;
      }
    )
    .join("\n\n");

  // Skin gallery section (inserted after the Skins feature)
  const skinGallery = `
  <!-- Skin Gallery -->
  <section class="feature-section">
    <div class="container">
      <div class="skin-gallery reveal">
        <div class="skin-gallery-item">
          <img src="assets/screenshots/detail-artist-light.webp" alt="Artist detail view in Arctic Light skin" loading="lazy" width="2560" height="1600">
          <div class="skin-gallery-caption"><strong>Arctic Light</strong> &mdash; Artist detail</div>
        </div>
        <div class="skin-gallery-item">
          <img src="assets/screenshots/detail-album-viboplr.webp" alt="Album detail view in Viboplr skin" loading="lazy" width="2560" height="1600">
          <div class="skin-gallery-caption"><strong>Viboplr</strong> &mdash; Album detail</div>
        </div>
        <div class="skin-gallery-item">
          <img src="assets/screenshots/detail-track-sunset.webp" alt="Track detail view in Sunset skin" loading="lazy" width="2560" height="1600">
          <div class="skin-gallery-caption"><strong>Sunset</strong> &mdash; Track detail</div>
        </div>
      </div>
    </div>
  </section>`;

  // Insert skin gallery after the Skins feature section
  const skinsIdx = featureSections.indexOf("<!-- Feature: Skins -->");
  const afterSkins = featureSections.indexOf("<!-- Feature:", skinsIdx + 1);
  const featureSectionsWithGallery = afterSkins !== -1
    ? featureSections.slice(0, afterSkins) + skinGallery + "\n\n  " + featureSections.slice(afterSkins)
    : featureSections + "\n" + skinGallery;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Features — Viboplr</title>
  <meta name="description" content="Gapless playback, full-text search, server integration, mini player, keyboard shortcuts, and more.">
  <link rel="canonical" href="https://viboplr.com/features.html">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://viboplr.com/features.html">
  <meta property="og:title" content="Features — Viboplr">
  <meta property="og:description" content="Gapless playback, full-text search, server integration, mini player, keyboard shortcuts, and more.">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="Features — Viboplr">
  <meta name="twitter:description" content="Gapless playback, full-text search, server integration, mini player, keyboard shortcuts, and more.">
  <link rel="icon" href="assets/icon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
</head>
<body>

  <!-- Navigation -->
  <nav class="nav">
    <div class="nav-inner">
      <a href="index.html" class="nav-logo">
        <svg viewBox="0 0 512 512" width="34" height="34" aria-hidden="true">
          <defs><linearGradient id="navGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#FF6B6B"/><stop offset="100%" stop-color="#E91E8A"/></linearGradient></defs>
          <path d="M138.24 138.24 L256 281.6 L373.76 138.24" fill="none" stroke="url(#navGrad)" stroke-width="51.2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M138.24 235.52 L256 378.88 L373.76 235.52" fill="none" stroke="url(#navGrad)" stroke-width="51.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.48"/>
        </svg>
        iboPLR
      </a>
      <div class="nav-links" id="navLinks">
        <a href="index.html" class="nav-link">Home</a>
        <a href="plugins.html" class="nav-link">Plugins</a>
        <a href="skins.html" class="nav-link">Skins</a>
        <a href="download.html" class="nav-cta">Get Viboplr</a>
      </div>
      <button class="nav-hamburger" id="navHamburger" aria-label="Toggle menu">
        <span></span>
        <span></span>
        <span></span>
      </button>
    </div>
  </nav>

  <!-- Page Header -->
  <section class="page-header">
    <div class="container">
      <h1 class="animate-in">Everything you need.<br><span class="gradient-text">Nothing you don't.</span></h1>
      <p class="animate-in animate-delay-1">Full-featured, meticulously optimized, and engineered to stay out of your way.</p>
    </div>
  </section>

${featureSectionsWithGallery}

  <!-- Bottom CTA -->
  <section class="bottom-cta">
    <div class="container reveal">
      <h2>Ready to try <span class="gradient-text">Viboplr</span>?</h2>
      <p>Free, full-featured, and built for music lovers.</p>
      <div class="hero-buttons">
        <a href="${dmgUrl}" class="btn btn-primary btn-lg">Download Now</a>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer class="footer">
    <div class="container">
      <div class="footer-inner">
        <div class="footer-left">&copy; 2026 Viboplr. All rights reserved.</div>
        <div class="footer-right">
          <a href="https://github.com/${REPO}" class="footer-link" target="_blank" rel="noopener">GitHub</a>
          <span class="footer-link">Built with Tauri + React</span>
        </div>
      </div>
    </div>
  </footer>

  <script src="js/main.js"></script>
  <!-- Cloudflare Web Analytics -->
  <script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "cbb978698d3744cca00a24f8cac8bc3c"}'></script>
</body>
</html>
`;
}
