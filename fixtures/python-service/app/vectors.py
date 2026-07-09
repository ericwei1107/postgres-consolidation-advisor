import os

from pinecone import Pinecone

pc = Pinecone(api_key=os.environ.get("PINECONE_API_KEY", ""))
index = pc.Index("profiles")

# 1536-dim embeddings from OpenAI text-embedding-3-small.
EMBED_MODEL = "text-embedding-3-small"
EMBED_DIMS = 1536


def upsert_embedding(user_id: int, values: list[float]) -> None:
    index.upsert(vectors=[{"id": str(user_id), "values": values}])


def nearest(values: list[float], k: int = 5):
    return index.query(vector=values, top_k=k)
