from fastapi import FastAPI

from .celery_app import send_receipt
from .documents import record_view, upsert_profile
from .vectors import nearest

api = FastAPI()


@api.post("/profiles/{user_id}")
def create_profile(user_id: int, display_name: str, bio: str = "") -> dict:
    upsert_profile(user_id, display_name, bio)
    return {"ok": True}


@api.get("/profiles/{user_id}/view")
def view_profile(user_id: int) -> dict:
    record_view(user_id)
    return {"ok": True}


@api.post("/orders/{order_id}/receipt")
def receipt(order_id: int) -> dict:
    send_receipt.delay(order_id)
    return {"queued": True}


@api.post("/search")
def search(vector: list[float]) -> dict:
    return {"matches": nearest(vector)}
