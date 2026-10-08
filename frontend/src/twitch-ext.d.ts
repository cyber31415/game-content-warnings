// Minimal typings for the subset of the Twitch Extension helper we use.
// https://dev.twitch.tv/docs/extensions/reference/

type TwitchAuth = { channelId: string; clientId: string; token: string; userId: string; helixToken: string };
type TwitchContext = { game?: string; theme?: "light" | "dark"; language?: string; mode?: string };

interface TwitchExt {
  onAuthorized(cb: (auth: TwitchAuth) => void): void;
  onContext(cb: (context: TwitchContext, changed: string[]) => void): void;
  onVisibilityChanged(cb: (isVisible: boolean, context: TwitchContext) => void): void;
  onError(cb: (err: unknown) => void): void;
  listen(target: string, cb: (target: string, contentType: string, message: string) => void): void;
  rig: { log(...args: unknown[]): void };
}

interface Window {
  Twitch?: { ext: TwitchExt };
}
