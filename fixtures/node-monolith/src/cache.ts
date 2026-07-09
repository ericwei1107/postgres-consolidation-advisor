import Redis from 'ioredis';

// Redis used as a plain cache: GET / SET / EXPIRE on string keys.
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

export async function cacheGet(key: string): Promise<string | null> {
  return redis.get(key);
}

export async function cacheSet(key: string, value: string, ttlSeconds = 60): Promise<void> {
  await redis.set(key, value);
  await redis.expire(key, ttlSeconds);
}

export async function cachedUser(id: number, load: () => Promise<string>): Promise<string> {
  const hit = await redis.get(`user:${id}`);
  if (hit) return hit;
  const fresh = await load();
  await redis.set(`user:${id}`, fresh);
  await redis.expire(`user:${id}`, 300);
  return fresh;
}
