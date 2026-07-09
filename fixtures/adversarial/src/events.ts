import { Kafka } from 'kafkajs';

// Kafka used as a DUMB WORK QUEUE: fire-and-forget produce, a single consumer
// with no consumer-group fan-out and no replay/offset-rewind. This should NOT
// trip the streaming-platform "keep" gate — nothing here needs Kafka's log.
const kafka = new Kafka({ brokers: [process.env.KAFKA_BROKER ?? 'localhost:9092'] });
const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: 'jobs' });

export async function enqueueJob(payload: unknown): Promise<void> {
  await producer.send({ topic: 'jobs', messages: [{ value: JSON.stringify(payload) }] });
}

export async function runJobs(handle: (payload: unknown) => Promise<void>): Promise<void> {
  await consumer.subscribe({ topic: 'jobs', fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      await handle(JSON.parse(message.value?.toString() ?? 'null'));
    },
  });
}
