import { Client } from '@elastic/elasticsearch';

// Elasticsearch used ONLY for log storage with daily indices (logs-YYYY.MM.DD).
// This is the log-analytics pattern that SHOULD trip a "keep" — full-text log
// search over rolling daily indices is not what a Postgres table wants to be.
const client = new Client({ node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200' });

function dailyIndex(date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `logs-${y}.${m}.${d}`;
}

export async function writeLog(level: string, message: string): Promise<void> {
  await client.index({
    index: dailyIndex(),
    document: { level, message, '@timestamp': new Date().toISOString() },
  });
}

export async function searchLogs(query: string) {
  const result = await client.search({
    index: 'logs-*',
    query: { match: { message: query } },
  });
  return result.hits.hits;
}
