import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Run weekly reading digest every Monday at 13:00 UTC (9:00 AM EST)
crons.cron(
  'weekly-reading-digest',
  '0 13 * * 1',
  internal.routers.digest.sendWeeklyDigests,
  {}
);

crons.interval(
  'cleanup abandoned exact-track uploads',
  { hours: 1 },
  internal.routers.ttsInternal.cleanupAbandonedTrackUploads,
  { cursor: null }
);

export default crons;
