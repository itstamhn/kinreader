import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({ base: './src/content/blog', pattern: '**/*.md' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    heroImage: z.string().optional(),
    // Drafts are filtered out of the index, the feed and the sitemap. Every
    // query has to apply the filter itself -- the schema only supplies the flag.
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
