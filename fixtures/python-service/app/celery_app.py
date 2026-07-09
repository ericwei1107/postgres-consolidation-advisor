from celery import Celery

# Literal broker URL -> resolves to redis (see PLAN.md 2.2 Celery broker rule).
app = Celery("python-service", broker="redis://redis:6379/0")
app.conf.worker_concurrency = 8


@app.task
def send_receipt(order_id: int) -> None:
    print("sending receipt for", order_id)
