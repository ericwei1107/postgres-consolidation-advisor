import os

# The only store signal in this app is the KAFKA_BROKERS env var; there is no
# kafka client import anywhere. Memcached (in compose) is never touched here.
KAFKA_BROKERS = os.environ["KAFKA_BROKERS"]


def main() -> None:
    print(f"would publish to brokers: {KAFKA_BROKERS}")


if __name__ == "__main__":
    main()
