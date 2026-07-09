import express from 'express';
import { PrismaClient } from '@prisma/client';
import { cachedUser } from './cache.js';
import { enqueueWelcome } from './queue.js';
import { searchPosts } from './search.js';

const app = express();
const prisma = new PrismaClient();

app.get('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const name = await cachedUser(id, async () => {
    const user = await prisma.user.findUnique({ where: { id } });
    return user?.name ?? `user-${id}`;
  });
  res.json({ id, name });
});

app.post('/users/:id/welcome', async (req, res) => {
  await enqueueWelcome(Number(req.params.id));
  res.status(202).end();
});

app.get('/search', async (req, res) => {
  const hits = await searchPosts(String(req.query.q ?? ''));
  res.json(hits);
});

app.listen(3000);
