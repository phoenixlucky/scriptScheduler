import sys
from datetime import datetime
from pathlib import Path


def main() -> None:
    output = Path(__file__).with_name("hello_scheduler.log")
    line = f"hello scheduler {datetime.now().isoformat()} args={sys.argv[1:]}\n"
    output.write_text(line, encoding="utf-8")
    print(line.strip())


if __name__ == "__main__":
    main()
