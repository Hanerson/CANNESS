import functools as _canness_functools
import inspect as _canness_inspect
import json as _canness_json


class UnsupportedConfiguration(ValueError):
    """The declared kernel capability matrix excludes this call."""


def _canness_guard(function, settings):
    signature = _canness_inspect.signature(function)
    support = settings["support"]
    for name in (*settings["inputs"], *support.get("wrapper_attrs", [])):
        if name not in signature.parameters:
            raise TypeError(f"Declared support parameter {name!r} is missing from {function.__name__}")
    rows = support.get("configurations", [])
    alignment = support.get("min_align_bytes", 1)

    @_canness_functools.wraps(function)
    def checked(*args, **kwargs):
        bound = signature.bind(*args, **kwargs)
        bound.apply_defaults()
        tensors = [bound.arguments[name] for name in settings["inputs"]]
        dtype = str(tensors[0].dtype).removeprefix("torch.")
        attrs = {**settings["fixedAttrs"], **{name: bound.arguments.get(name) for name in settings["runtimeAttrs"]}}
        if rows and not any(
            ("dtype" not in row or row["dtype"] == dtype)
            and all(attrs.get(name) == value and isinstance(attrs.get(name), bool) == isinstance(value, bool)
                    for name, value in row.get("attrs", {}).items())
            for row in rows
        ):
            raise UnsupportedConfiguration(f"Unsupported configuration for dtype {dtype}. Declared support: {support}")
        if alignment > 1 and any(tensor.data_ptr() % alignment for tensor in tensors):
            raise UnsupportedConfiguration(f"Input address must be {alignment}-byte aligned. Declared support: {support}")
        return function(*args, **kwargs)

    return checked


{{OPERATOR}} = _canness_guard({{OPERATOR}}, _canness_json.loads({{PY_SUPPORT}}))
