import { z } from "zod";

// DoesTheDogDie API v3 (https://www.doesthedogdie.com/api/3.0). Verified against real
// responses in ebs/test/fixtures/ddd/ (scripts/capture-ddd-fixtures.ts).
// Unknown fields are allowed so additions don't break us.

const nullableString = z.string().nullish().transform((v) => v ?? null);

export const DddItemSummarySchema = z.looseObject({
  id: z.number().int().positive(),
  name: z.string(),
  releaseYear: z.union([z.number(), z.string()]).nullish().transform((v) => (v == null || v === "" ? null : Number(v))),
  itemTypeId: z.number().int().nullish(),
  itemTypeName: nullableString,
  tmdbId: z.union([z.number(), z.string()]).nullish(),
  imdbId: nullableString,
});

export const DddSearchResponseSchema = z.array(DddItemSummarySchema);

export const DddTopicItemStatSchema = z.looseObject({
  topicItemId: z.number().int().optional(),
  topicId: z.number().int(),
  topicName: z.string(),
  yesSum: z.number().int().nonnegative(),
  noSum: z.number().int().nonnegative(),
  numComments: z.number().int().nonnegative().optional(),
});

export const DddItemDetailSchema = DddItemSummarySchema.extend({
  topicItemStats: z.array(DddTopicItemStatSchema).default([]),
});

export const DddErrorSchema = z.object({ error: z.string(), message: z.string().optional() });

export type DddItemSummary = z.infer<typeof DddItemSummarySchema>;
export type DddItemDetail = z.infer<typeof DddItemDetailSchema>;
export type DddTopicItemStat = z.infer<typeof DddTopicItemStatSchema>;

export const DddTopicSchema = z.looseObject({
  id: z.number().int(),
  name: z.string(),
  keywords: nullableString,
  description: nullableString,
  topicCategoryId: z.number().int().nullish(),
});
export const DddTopicCategorySchema = z.looseObject({ id: z.number().int(), name: z.string(), topicSuperCategoryId: z.number().int().nullish() });
export const DddTopicSuperCategorySchema = z.looseObject({ id: z.number().int(), name: z.string(), shortName: nullableString });

export type DddTopic = z.infer<typeof DddTopicSchema>;
export type DddTopicCategory = z.infer<typeof DddTopicCategorySchema>;
export type DddTopicSuperCategory = z.infer<typeof DddTopicSuperCategorySchema>;
