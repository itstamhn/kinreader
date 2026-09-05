import { defineApp } from 'convex/server';
import { v } from 'convex/values';
import workpool from '@convex-dev/workpool/convex.config';

const app = defineApp({
  env: {
    AUDIO_PACKAGER_SECRET: v.optional(v.string()),
    AUDIO_PACKAGER_ORIGIN: v.optional(v.string()),
    SONIOX_API_KEY: v.optional(v.string()),
  },
});

app.use(workpool, { name: "audioPackagingPool" });
export default app;
