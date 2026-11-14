import builtins as _builtins
import ctypes as _ct
from pathlib import Path as _Path

import torch as _torch
import torch_npu as _torch_npu

__all__ = [{{PY_OPERATOR}}]


def _bind(variant):
    library = _ct.CDLL(str(_Path(__file__).with_name(f"libcanness-{variant}.so")))
    launch = library.canness_launch
    launch.restype = _ct.c_int
    launch.argtypes = [{{PY_ARGTYPES}}]
    return launch


_launchers = {dtype: _bind(variant) for dtype, variant in { {{PY_VARIANTS}} }.items()}


def {{OPERATOR}}({{PY_PARAMS}}):
    """Launch the CANNESS kernel on contiguous NPU input tensors."""
    _tensors = ({{PY_INPUTS}},)
    _first = _tensors[0]
    _launch = _launchers.get(_first.dtype)
    if _launch is None:
        raise _builtins.ValueError("CANNESS has no kernel for this input dtype")
    for _tensor, _dtype in _builtins.zip(_tensors, ({{PY_DTYPES}},)):
        if (_tensor.device.type != "npu" or _tensor.device != _first.device
                or _tensor.dtype != _dtype or _tensor.shape != _first.shape
                or not _tensor.is_contiguous()):
            raise _builtins.ValueError("CANNESS expects contiguous same-shape NPU inputs of the compiled dtypes")
    _total = _first.numel()
    if _total > 0xffffffff:
        raise _builtins.ValueError("CANNESS tiling supports up to 2**32 - 1 elements")
    with _torch_npu.npu.device(_first.device):
        _outputs = ({{PY_OUTPUTS}},)
        if _total:
            {{PY_ATTR_SETUP}}
            _capacity = {{TILING_CAPACITY}}{{PY_ATTR_BYTES}}
            _tiling = _torch.empty((_capacity,), dtype=_torch.uint8, device=_first.device)
            _stream = _torch_npu.npu.current_stream(_first.device).npu_stream
            _status = _launch(*(tensor.data_ptr() for tensor in (*_tensors, *_outputs)),
                              _total, _stream, _tiling.data_ptr(), _capacity{{PY_ATTR_ARGS}})
            if _status:
                raise _builtins.RuntimeError(f"CANNESS kernel launch failed ({_status})")
    return {{PY_RETURN}}
