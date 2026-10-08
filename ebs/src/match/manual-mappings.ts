// Curated Twitch category -> DoesTheDogDie item pins, applied at every EBS start so they
// travel with the code to any server. Use for cases the automatic matcher rightly refuses
// to guess. Each entry needs a reason.
export const MANUAL_MAPPINGS: { twitchGameId: string; twitchName: string; dddItemId: number; reason: string }[] = [
  {
    twitchGameId: "778386489",
    twitchName: "The Last of Us Part I",
    dddItemId: 14438,
    reason: "2022 remake of the 2013 game with the same story; DDD only lists the original (The Last of Us, #14438).",
  },
];
