// DEV ONLY. Stand-in for https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js
// so the real panel/config pages can run outside Twitch. Served by scripts/dev-frontend.ts
// at /harness/<page>.html?channel=<id>&role=<viewer|broadcaster>&game=<name>&theme=<dark|light>
(function () {
  const params = new URLSearchParams(location.search);
  const channel = params.get("channel") || "23523234";
  const role = params.get("role") || "viewer";
  let context = { game: params.get("game") || "", theme: params.get("theme") || "dark", language: "en", mode: "viewer" };
  const segKey = "harness-broadcaster-segment-" + channel;

  const cbs = { authorized: [], context: [], visibility: [], config: [], listen: [] };
  let auth = null;

  function readSegment() {
    try {
      const raw = localStorage.getItem(segKey);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  const ext = {
    onAuthorized(cb) {
      cbs.authorized.push(cb);
      if (auth) cb(auth);
    },
    onContext(cb) {
      cbs.context.push(cb);
      setTimeout(() => cb(context, Object.keys(context)), 0);
    },
    onVisibilityChanged(cb) {
      cbs.visibility.push(cb);
    },
    onError() {},
    listen(target, cb) {
      cbs.listen.push({ target, cb });
    },
    configuration: {
      get broadcaster() {
        return readSegment();
      },
      onChanged(cb) {
        cbs.config.push(cb);
        setTimeout(cb, 0);
      },
      set(segment, version, content) {
        localStorage.setItem(segKey, JSON.stringify({ version, content }));
        cbs.config.forEach((cb) => cb());
      },
    },
    rig: { log: console.log },
  };
  window.Twitch = { ext };

  fetch(`/harness/token?channel=${encodeURIComponent(channel)}&role=${encodeURIComponent(role)}`)
    .then((r) => r.json())
    .then((t) => {
      auth = { channelId: channel, clientId: "harness", token: t.token, userId: "U" + channel, helixToken: "" };
      cbs.authorized.forEach((cb) => cb(auth));
    });

  // Test hooks for driving the page (used by scripts/e2e-local.py and by hand in devtools).
  window.__harness = {
    setGame(name) {
      context = { ...context, game: name };
      cbs.context.forEach((cb) => cb(context, ["game"]));
    },
    setTheme(theme) {
      context = { ...context, theme };
      cbs.context.forEach((cb) => cb(context, ["theme"]));
    },
    setVisible(v) {
      cbs.visibility.forEach((cb) => cb(v, context));
    },
    pubsub(message) {
      cbs.listen.filter((l) => l.target === "broadcast").forEach((l) => l.cb("broadcast", "application/json", JSON.stringify(message)));
    },
  };
})();
