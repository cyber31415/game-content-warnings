// Operator tool: pin a Twitch category to a DDD item for every channel (or remove the pin),
// and list categories the matcher couldn't resolve.
//
//   node --env-file=.env scripts/map-game.ts list
//   node --env-file=.env scripts/map-game.ts set <twitchGameId> <dddItemId> "<Twitch name>"
//   node --env-file=.env scripts/map-game.ts clear <twitchGameId>
// Stop the EBS first if the database is on the CIFS share (dot-file locking is single-process).
import { Store } from "../ebs/src/cache/db.ts";

const store = new Store(process.env.DATABASE_PATH ?? "./data/cache.sqlite", { vfs: process.env.DATABASE_VFS || undefined });
const [cmd, gameId, itemId, name] = process.argv.slice(2);

if (cmd === "list") {
  for (const r of store.listUnresolved()) {
    console.log(`${r.twitchGameId}\t${r.status}\tseen ${r.seenCount}x\t${r.twitchName}\t${r.candidatesJson}`);
  }
} else if (cmd === "set" && gameId && /^\d+$/.test(itemId ?? "")) {
  store.putManualMatch(gameId, name ?? store.getGameMap(gameId)?.twitchName ?? "", Number(itemId));
  console.log(`Pinned Twitch category ${gameId} -> DDD item ${itemId}. Restart the EBS to drop its in-memory cache.`);
} else if (cmd === "clear" && gameId) {
  store.putManualMatch(gameId, "", null);
  console.log(`Removed manual mapping for ${gameId}.`);
} else {
  console.log("usage: map-game.ts list | set <twitchGameId> <dddItemId> [name] | clear <twitchGameId>");
  process.exitCode = 1;
}
store.close();
