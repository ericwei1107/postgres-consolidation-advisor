import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

// High-fan-out endpoint: one HTTP request issues >=10 cache reads. This fan-out
// (A9) is the shape that SHOULD trip a "keep" — moving it to Postgres turns 10+
// cheap GETs into 10+ round-trips or a more complex query.
export async function buildFeed(userId: number, followeeIds: number[]): Promise<string[]> {
  const items: string[] = [];
  const self = await redis.get(`profile:${userId}`);
  if (self) items.push(self);
  for (const id of followeeIds.slice(0, 12)) {
    const post = await redis.get(`latest_post:${id}`);
    if (post) items.push(post);
  }
  return items;
}
