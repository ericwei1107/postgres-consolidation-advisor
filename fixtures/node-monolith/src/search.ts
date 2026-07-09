import { Client } from '@elastic/elasticsearch';

const client = new Client({ node: process.env.ELASTICSEARCH_URL ?? 'http://localhost:9200' });

export async function searchPosts(query: string) {
  const result = await client.search({
    index: 'posts',
    query: { match: { body: query } },
  });
  return result.hits.hits;
}
