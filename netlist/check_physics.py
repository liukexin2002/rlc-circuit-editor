#!/usr/bin/env python3
"""
Physics cross-check: does the exported netlist describe the circuit it claims?

`skrf_load.py` proves the file is ACCEPTED. That is necessary but not sufficient — a netlist
can be valid and still describe the wrong circuit. So this script checks the ELECTRICAL
BEHAVIOUR against the analytic answer for the topology the example draws:

    PORT1 -- RIN(50Ω) -- L1(8.893nH) --+-- ROUT(50Ω) -- PORT2
                                       |
                            C1(3.222pF) -- C2(82.25pF) -- GND

Between the inductor and the output there is a shunt path to ground through C2 (with C1 in
series with it), so the circuit is a low-pass ladder. Two things must hold:

  1. At a LOW frequency the insertion loss is small (the signal passes).
  2. At a HIGH frequency the shunt capacitors short the signal to ground, so the insertion
     loss is much larger than at low frequency.

If the netlist had wired the capacitors to the wrong node — which is exactly the mistake a
broken TAP would cause — both caps would end up somewhere harmless and the high-frequency
roll-off would not appear. So this check is a real test of the tap's netlist semantics.

Run: python netlist/check_physics.py netlist/example-lowpass.json
"""

from __future__ import annotations

import sys
from pathlib import Path

# Import the loader from this same directory, so the script works regardless of the CWD.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from skrf_load import build_circuit, load_netlist  # noqa: E402


def insertion_loss_db(circuit) -> list[float]:
    """S21 in dB across the sweep."""
    net = circuit.network
    return [float(20 * __import__("numpy").log10(abs(net.s[i, 1, 0]))) for i in range(net.s.shape[0])]


def main(argv: list[str]) -> int:
    path = argv[1] if len(argv) > 1 else "netlist/example-lowpass.json"
    data = load_netlist(path)
    circuit = build_circuit(data)
    net = circuit.network

    if net.nports != 2:
        print(f"expected a 2-port network, got {net.nports}")
        return 1

    s21 = insertion_loss_db(circuit)
    f = net.f

    low_i = 0
    high_i = len(f) - 1
    low_db = s21[low_i]
    high_db = s21[high_i]
    worst_db = min(s21)
    worst_f = f[s21.index(worst_db)]

    print(f"sweep            : {f[low_i] / 1e9:.3g} – {f[high_i] / 1e9:.3g} GHz")
    print(f"S21 @ {f[low_i] / 1e9:.3g} GHz : {low_db:.2f} dB")
    print(f"S21 @ {f[high_i] / 1e9:.3g} GHz: {high_db:.2f} dB")
    print(f"deepest notch    : {worst_db:.2f} dB @ {worst_f / 1e9:.3g} GHz")

    failures = []
    # A passive LC ladder must be lossy, never amplifying.
    if any(v > 0.01 for v in s21):
        failures.append("insertion loss is positive somewhere: the network is not passive")
    # Low frequency: mostly a through connection.
    if low_db < -20:
        failures.append(f"too lossy at the low end ({low_db:.1f} dB): the series path is not connected")
    # High frequency: the shunt capacitors must load the line. Attenuation is negative dB, so
    # a roll-off means the high-end value is MORE negative than the low-end by a clear margin.
    if high_db > low_db - 3:
        failures.append(
            f"no high-frequency roll-off ({low_db:.1f} dB -> {high_db:.1f} dB): "
            "the shunt capacitors are probably not connected to the line"
        )

    if failures:
        print("\nFAILED:")
        for x in failures:
            print("  - " + x)
        return 1

    print("\nOK: behaves as the drawn topology requires "
          "(passes at the low end, rolls off at the high end, passive throughout).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
