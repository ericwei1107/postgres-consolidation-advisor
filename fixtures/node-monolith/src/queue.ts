import { Queue } from 'bullmq';

// BullMQ (Redis-backed) job queue producer.
const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };

export const emailQueue = new Queue('email', { connection });

export async function enqueueWelcome(userId: number): Promise<void> {
  await emailQueue.add('welcome', { userId });
}
