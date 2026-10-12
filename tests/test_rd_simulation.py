import math
import unittest

from rd_simulation import run_experiment_sweep


class PythonSimulationTests(unittest.TestCase):
    def test_all_registered_models_are_deterministic_and_bounded(self):
        cases = [
            ("pendulum", "damping", [0, .15, .35, .7, 1.2]),
            ("robot-arm", "speed", [.2, .5, 1, 1.6, 2.5]),
            ("pid", "gain", [.5, 1, 2.2, 4, 7]),
            ("particles", "speed", [.2, .5, 1, 1.6, 2.5]),
        ]
        for model, parameter, values in cases:
            with self.subTest(model=model):
                a = run_experiment_sweep(model, parameter, values, {})
                b = run_experiment_sweep(model, parameter, values, {})
                self.assertEqual(a, b)
                self.assertEqual(len(a), 5)
                self.assertTrue(all(row["steps"] == 1800 and row["seed"] == 1 for row in a))
                self.assertTrue(all(math.isfinite(row[key]) for row in a
                                    for key in ("duration", "finalMetric", "peakMetric", "rms")))
                self.assertTrue(all(row["rms"] >= 0 and row["peakMetric"] >= 0 for row in a))

    def test_rejects_unknown_models_parameters_and_unbounded_inputs(self):
        for args in [
            ("unknown", "speed", [1, 1, 1, 1, 1], {}),
            ("pendulum", "speed", [1, 1, 1, 1, 1], {}),
            ("pendulum", "damping", [0, .1, .2, .3], {}),
            ("pendulum", "damping", [0, .1, .2, .3, float("nan")], {}),
            ("pendulum", "damping", [0, .1, .2, .3, 99], {}),
            ("pendulum", "damping", [0, .1, .2, .3, .4], {"gravity": float("inf")}),
        ]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                run_experiment_sweep(*args)

    def test_parameter_sweep_does_not_mutate_input_parameters(self):
        base = {"gravity": 9.81, "damping": .12, "length": 1.6, "angle": 30}
        before = dict(base)
        run_experiment_sweep("pendulum", "damping", [0, .15, .35, .7, 1.2], base)
        self.assertEqual(base, before)


if __name__ == "__main__":
    unittest.main()
