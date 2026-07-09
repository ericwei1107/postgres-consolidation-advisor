import os

from pymongo import MongoClient

client = MongoClient(os.environ.get("MONGODB_URI", "mongodb://localhost:27017"))
db = client["python_service"]
profiles = db["profiles"]


def upsert_profile(user_id: int, display_name: str, bio: str) -> None:
    # Document model: nested `prefs`, a tags array, and a counter.
    profiles.update_one(
        {"_id": user_id},
        {
            "$set": {
                "display_name": display_name,
                "bio": bio,
                "prefs": {"theme": "dark", "locale": "en-US"},
                "tags": ["new"],
            }
        },
        upsert=True,
    )


def record_view(user_id: int) -> None:
    # Atomic counter increment — a shape Postgres handles with a single UPDATE.
    profiles.update_one({"_id": user_id}, {"$inc": {"views": 1}})
