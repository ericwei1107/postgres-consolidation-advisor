import { Worker } from 'bullmq';

const connection = { url: process.env.REDIS_URL ?? 'redis://localhost:6379' };

// Runs as the `worker` compose service (deploy.replicas: 2), concurrency 10.
export const emailWorker = new Worker(
  'email',
  async (job) => {
    console.log('sending', job.name, job.data);
  },
  { connection, concurrency: 10 },
);
