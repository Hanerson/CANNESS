#!/usr/bin/env python3
"""Editable NumPy algorithm model. It neither imports nor executes a device kernel.

Replace candidate_* with the algorithm actually used by your kernel. Keep the
independent prefix/row reference. Run with Python + NumPy already installed;
this script does not install dependencies. Optional --torch checks its outputs
against PyTorch as a second independent oracle.
"""
import argparse
import json
import math
import random


def reference_scan_min(rows):
    """Slow O(axis**2) prefix oracle; latest tied/NaN position wins."""
    values, indices = [], []
    for row in rows:
        value_row, index_row = [], []
        for end in range(1, len(row) + 1):
            prefix = row[:end]
            nan_positions = [i for i, value in enumerate(prefix) if math.isnan(value)]
            if nan_positions:
                index = nan_positions[-1]
            else:
                minimum = min(prefix)
                index = max(i for i, value in enumerate(prefix) if value == minimum)
            value_row.append(prefix[index])
            index_row.append(index)
        values.append(value_row)
        indices.append(index_row)
    return values, indices


def candidate_scan_min(np, rows):
    """Example doubling scan; replace this with your actual vector schedule."""
    values = np.asarray(rows, dtype=np.float64).copy()
    indices = np.broadcast_to(np.arange(values.shape[-1]), values.shape).copy()
    distance = 1
    while distance < values.shape[-1]:
        left, right = values[:, :-distance].copy(), values[:, distance:].copy()
        left_indices, right_indices = indices[:, :-distance].copy(), indices[:, distance:].copy()
        choose_left = ~np.isnan(right) & (np.isnan(left) | (left < right))
        values[:, distance:] = np.where(choose_left, left, right)
        indices[:, distance:] = np.where(choose_left, left_indices, right_indices)
        distance *= 2
    return values, indices


def reference_reduce_sum(rows):
    return [sum(row) for row in rows]


def candidate_reduce_sum(np, rows):
    """Example pairwise tree; replace this with the kernel's real schedule."""
    values = np.asarray(rows, dtype=np.float64).copy()
    while values.shape[-1] > 1:
        pairs = values.shape[-1] // 2
        reduced = values[:, :pairs * 2:2] + values[:, 1:pairs * 2:2]
        if values.shape[-1] % 2:
            reduced = np.concatenate([reduced, values[:, -1:]], axis=-1)
        values = reduced
    return values[:, 0]


def check(seed=0, use_torch=False):
    try:
        import numpy as np
    except ImportError:
        return {'status': 'unavailable', 'reason': 'NumPy is required; no dependency was installed', 'targetValidated': False}
    rng = random.Random(seed)
    cases = 0
    with np.errstate(invalid='ignore', over='ignore'):
        for axis in (1, 2, 3, 7, 16, 31, 257):
            rows = [[rng.choice([-5., -1., -1., 0., 2., 7.]) for _ in range(axis)] for _ in range(4)]
            if axis > 1:
                rows[0][0], rows[0][-1] = float('inf'), float('-inf')
                rows[1][0], rows[1][-1] = float('nan'), float('nan')
            expected_values, expected_indices = reference_scan_min(rows)
            values, indices = candidate_scan_min(np, rows)
            if not np.array_equal(values, expected_values, equal_nan=True) or not np.array_equal(indices, expected_indices):
                return {'status': 'mismatch', 'operation': 'scan_min', 'axis': axis, 'targetValidated': False}
            if not np.allclose(candidate_reduce_sum(np, rows), reference_reduce_sum(rows), equal_nan=True, rtol=1e-12, atol=1e-12):
                return {'status': 'mismatch', 'operation': 'reduce_sum', 'axis': axis, 'targetValidated': False}
            if use_torch:
                try:
                    import torch
                except ImportError:
                    return {'status': 'unavailable', 'reason': 'optional PyTorch reference is not installed', 'targetValidated': False}
                actual = torch.cummin(torch.tensor(rows, dtype=torch.float64), dim=-1)
                if not np.array_equal(actual.values.numpy(), values, equal_nan=True) or not np.array_equal(actual.indices.numpy(), indices):
                    return {'status': 'mismatch', 'operation': 'torch_cummin', 'axis': axis, 'targetValidated': False}
            cases += len(rows)
    return {'status': 'pass', 'cases': cases, 'seed': seed, 'targetValidated': False,
            'scope': 'example host algorithm model against independent prefix/row reference; not kernel execution'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seed', type=int, default=0)
    parser.add_argument('--torch', action='store_true')
    args = parser.parse_args()
    result = check(args.seed, args.torch)
    print(json.dumps(result))
    raise SystemExit(0 if result['status'] == 'pass' else 2 if result['status'] == 'unavailable' else 1)
