"""Bounded deterministic R&D models and experiment sweeps.

The browser keeps its requestAnimationFrame loop and canvas renderer for responsive
live visualization. Reproducible batch sweeps run here in Python when the workspace
is paired, so numerical experiment logic is not coupled to the UI.
"""
from __future__ import annotations

import math

MODEL_PARAMETERS = {
    "pendulum": {"gravity", "damping", "length"},
    "robot-arm": {"speed"},
    "pid": {"gain"},
    "particles": {"speed"},
}
PARAMETER_BOUNDS = {
    "gravity": (1.0, 20.0),
    "damping": (0.0, 1.5),
    "length": (0.5, 3.0),
    "gain": (0.2, 8.0),
    "speed": (0.2, 2.5),
}
DEFAULTS = {"gravity": 9.81, "damping": 0.12, "length": 1.6,
            "gain": 2.2, "speed": 1.0, "angle": 55.0}


def _number(value, name, bounds):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number.")
    low, high = bounds
    if value < low or value > high:
        raise ValueError(f"{name} must be between {low} and {high}.")
    return float(value)


def _initial_state(model, params):
    p = dict(DEFAULTS)
    for name, bounds in PARAMETER_BOUNDS.items():
        if name in params:
            p[name] = _number(params[name], name, bounds)
    if "angle" in params:
        p["angle"] = _number(params["angle"], "angle", (-85.0, 85.0))
    return {
        "model": model, "params": p, "time": 0.0, "steps": 0, "energy": 0.0,
        "angle": math.radians(p["angle"]), "omega": 0.0,
        "theta1": -0.75, "theta2": 1.0, "theta1v": 0.0, "theta2v": 0.0,
        "position": 0.0, "velocity": 0.0, "integral": 0.0, "previousError": 1.0,
        "agents": [
            {"x": 35 + (i * 47) % 470, "y": 45 + (i * 31) % 245,
             "vx": ((i % 3) - 1) * 0.45, "vy": ((i % 4) - 1.5) * 0.3}
            for i in range(14)
        ],
    }


def _step(s, dt):
    dt = min(0.025, max(0.0, dt))
    p, model = s["params"], s["model"]
    if model == "pendulum":
        acceleration = -(p["gravity"] / max(0.2, p["length"])) * math.sin(s["angle"]) - p["damping"] * s["omega"]
        s["omega"] += acceleration * dt
        s["angle"] += s["omega"] * dt
        s["energy"] = 0.5 * s["omega"] ** 2 * p["length"] ** 2 + p["gravity"] * p["length"] * (1 - math.cos(s["angle"]))
    elif model == "robot-arm":
        target1 = -0.8 + 0.48 * math.sin(s["time"] * 0.7 * p["speed"])
        target2 = 1.0 + 0.58 * math.sin(s["time"] * 1.1 * p["speed"])
        s["theta1v"] += (14 * (target1 - s["theta1"]) - 4 * s["theta1v"]) * dt
        s["theta2v"] += (12 * (target2 - s["theta2"]) - 3.4 * s["theta2v"]) * dt
        s["theta1"] += s["theta1v"] * dt
        s["theta2"] += s["theta2v"] * dt
        s["energy"] = 0.5 * (s["theta1v"] ** 2 + s["theta2v"] ** 2)
    elif model == "pid":
        error = 1 - s["position"]
        s["integral"] = max(-3.0, min(3.0, s["integral"] + error * dt))
        derivative = (error - s["previousError"]) / max(dt, 0.0001)
        s["previousError"] = error
        control = max(-4.0, min(4.0, p["gain"] * error + 0.22 * s["integral"] + 0.035 * derivative))
        acceleration = (control - 1.3 * s["velocity"] - 0.8 * s["position"]) * 2.4
        s["velocity"] += acceleration * dt
        s["position"] += s["velocity"] * dt
        s["energy"] = 0.5 * s["velocity"] ** 2 + 0.4 * (1 - s["position"]) ** 2
    else:
        target_x = 250 + 75 * math.cos(s["time"] * 0.18 * p["speed"])
        target_y = 150 + 55 * math.sin(s["time"] * 0.18 * p["speed"])
        for agent in s["agents"]:
            dx, dy = target_x - agent["x"], target_y - agent["y"]
            distance = math.hypot(dx, dy) or 1.0
            agent["vx"] += dx / distance * 0.12 * dt
            agent["vy"] += dy / distance * 0.12 * dt
            agent["vx"] *= 0.997
            agent["vy"] *= 0.997
            speed = math.hypot(agent["vx"], agent["vy"]) or 1.0
            if speed > 1.6:
                agent["vx"] = agent["vx"] / speed * 1.6
                agent["vy"] = agent["vy"] / speed * 1.6
            agent["x"] = max(8.0, min(492.0, agent["x"] + agent["vx"] * 60 * dt))
            agent["y"] = max(8.0, min(292.0, agent["y"] + agent["vy"] * 60 * dt))
        s["energy"] = sum(a["vx"] ** 2 + a["vy"] ** 2 for a in s["agents"]) / len(s["agents"])
    s["time"] += dt
    s["steps"] += 1


def _metric(s):
    model = s["model"]
    if model == "pendulum":
        return abs(s["angle"])
    if model == "robot-arm":
        return abs(s["theta1"] + s["theta2"])
    if model == "pid":
        return abs(1 - s["position"])
    return s["energy"]


def run_experiment_sweep(model, parameter, values, base=None):
    """Run exactly five fixed-seed (deterministic) 15-second simulations."""
    if not isinstance(model, str) or model not in MODEL_PARAMETERS:
        raise ValueError("Unknown registered simulation model.")
    if not isinstance(parameter, str) or parameter not in MODEL_PARAMETERS[model]:
        raise ValueError("This parameter is not supported by the selected model.")
    if not isinstance(values, list) or len(values) != 5:
        raise ValueError("A sweep must contain exactly five parameter values.")
    base = base if isinstance(base, dict) else {}
    # Validate all supplied base values, including parameters not used by this model.
    params = dict(DEFAULTS)
    for key, bounds in PARAMETER_BOUNDS.items():
        if key in base:
            params[key] = _number(base[key], key, bounds)
    if "angle" in base:
        params["angle"] = _number(base["angle"], "angle", (-85.0, 85.0))
    rows = []
    for raw_value in values:
        value = _number(raw_value, parameter, PARAMETER_BOUNDS[parameter])
        run_params = dict(params)
        run_params[parameter] = value
        s = _initial_state(model, run_params)
        peak, sum_squares = 0.0, 0.0
        for _ in range(1800):
            _step(s, 1 / 120)
            metric = _metric(s)
            peak = max(peak, metric)
            sum_squares += metric * metric
        rows.append({
            "parameter": parameter, "value": value, "model": model,
            "duration": s["time"], "steps": s["steps"],
            "finalMetric": round(_metric(s), 5), "peakMetric": round(peak, 5),
            "rms": round(math.sqrt(sum_squares / 1800), 5), "seed": 1,
        })
    return rows
