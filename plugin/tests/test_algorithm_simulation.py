import importlib.util
import sys
sys.dont_write_bytecode = True
from pathlib import Path
import unittest

path = Path(__file__).parents[1] / 'templates' / 'local-validation' / 'algorithm-simulation.py'
spec = importlib.util.spec_from_file_location('algorithm_simulation', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class SimulationTests(unittest.TestCase):
    def test_independent_prefix_reference_latest_ties_and_nans(self):
        values, indices = module.reference_scan_min([[3., 1., 1., float('nan'), 0., float('nan')]])
        self.assertEqual(indices, [[0, 1, 2, 3, 3, 5]])
        self.assertEqual(values[0][:3], [3., 1., 1.])

    def test_numpy_example_matches_independent_or_reports_unavailable(self):
        result = module.check(seed=42)
        self.assertIn(result['status'], ('pass', 'unavailable'))
        self.assertFalse(result['targetValidated'])
        if result['status'] == 'pass':
            self.assertEqual(result['cases'], 28)

if __name__ == '__main__':
    unittest.main()
