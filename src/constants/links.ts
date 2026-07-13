// Single source of truth for external URLs the app links to.
export const LINKS = {
  homepage: "https://viboplr.com",
  pluginsPage: "https://viboplr.com/plugins.html",
  skinsPage: "https://viboplr.com/skins.html",
  issues: "https://github.com/outcast1000/viboplr/issues",
  supportPage: "https://viboplr.com/support.html",
  // Topic explainers; HelpLink appends "#<anchor>". Anchors on that page are
  // add-only — older app builds link into the live site.
  helpPage: "https://viboplr.com/help.html",
  // Gallery submission issue-form. A bot validates the JSON and opens the PR.
  skinSubmitForm: "https://github.com/outcast1000/viboplr-skins/issues/new?template=submit-skin.yml",
} as const;
