import { defineConfig } from "vitepress";

export default defineConfig({
  title: "thinkbot",
  description:
    "An ops agent that triages monitoring alerts — correlates them against GitHub, Datadog, Sentry and Rollbar, and reports what changed",
  base: "/thinkbot/",
  cleanUrls: true,
  head: [
    ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
    ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
    [
      "link",
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
    ],
  ],
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/setup" },
      { text: "clawdwatch", link: "https://triptechtravel.github.io/clawdwatch/" },
    ],
    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Overview", link: "/" },
          { text: "Setup", link: "/guide/setup" },
          { text: "Security", link: "/guide/security" },
          { text: "Contributing", link: "/guide/contributing" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/triptechtravel/thinkbot" },
    ],
    search: { provider: "local" },
  },
});
