#!/usr/bin/env python3
"""Host-side mock runner. Writes an eval report plus an msprof-shaped analysis. Does not call msprof."""

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--inbox', required=True)
    parser.add_argument('--outbox', required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    inbox = Path(args.inbox)
    outbox = Path(args.outbox)
    if not inbox.exists():
        return
    for manifest in inbox.glob('*/manifest.json'):
        generation = manifest.parent.name
        dest = outbox / generation / 'results.json'
        if dest.exists():
            continue
        data = json.loads(manifest.read_text(encoding='utf-8'))
        target = data.get('performanceTargetUs')
        name = data.get('operatorName') if isinstance(data.get('operatorName'), str) else generation
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps({
            'generationId': data.get('generationId', generation),
            'status': 'pass',
            'compile': {'ok': True, 'log': ''},
            'correctness': {'ok': True, 'maxRelativeError': 0},
            'performance': {'kernelTimeUs': target, 'targetUs': target},
            'analysis': {
                'source': 'msprof-mock',
                'bottleneck': 'memory',
                'summary': f'Task Duration {target}us；aic_mte2_ratio 0.71，内存搬运为主，cube_utilization 18.4%。',
                'op': {
                    'opName': name,
                    'opType': name,
                    'taskType': 'AI_CORE',
                    'taskDurationUs': target,
                    'taskWaitTimeUs': 2,
                    'blockDim': 8,
                    'aicoreTimeUs': target,
                    'aicMacRatio': 0.12,
                    'aicMte2Ratio': 0.71,
                    'aicScalarRatio': 0.09,
                    'cubeUtilizationPct': 18.4,
                },
            },
            'summary': 'mock pass',
        }), encoding='utf-8')


if __name__ == '__main__':
    main()
