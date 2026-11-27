import importlib.util
from pathlib import Path
from tempfile import TemporaryFile

source = Path("plugin/remote/validate_submission.py")
spec = importlib.util.spec_from_file_location("output_limit_validator", source)
assert spec is not None and spec.loader is not None
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)

for size in (1024, validator.MAX_OUTPUT_BYTES + 1):
    with TemporaryFile() as log:
        log.write(b"aicore exception\n")
        log.truncate(size)
        evidence = {}
        try:
            validator.read_command_output(log, evidence)
        except ValueError as error:
            print(error)
        print(f"bytes={size}, device_fault={'device_fault' in evidence}")
