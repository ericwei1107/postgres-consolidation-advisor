import Redis from 'ioredis';

// Redis as a SESSION STORE: plain KV with a TTL. Latency is not user-critical
// here (sessions are read once per request, cheap to rebuild) — this should NOT
// be scored a confident "keep" just because it is Redis.
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

export async function getSession(sid: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(`session:${sid}`);
  return raw ? JSON.parse(raw) : null;
}

export async function putSession(sid: string, data: Record<string, unknown>): Promise<void> {
  await redis.set(`session:${sid}`, JSON.stringify(data));
  await redis.expire(`session:${sid}`, 1800);
}
