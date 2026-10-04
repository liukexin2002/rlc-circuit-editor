#!/usr/bin/env python3
"""
Reference loader: RLC editor netlist JSON -> scikit-rf Circuit.

Usage
-----
    python netlist/skrf_load.py rlc-netlist.skrf.json

    # or from Python:
    from skrf_load import build_circuit, load_netlist
    netlist = load_netlist("rlc-netlist.skrf.json")
    circuit = build_circuit(netlist)

What the exported JSON contains
-------------------------------
    frequency   all Networks must share one Frequency, so it is exported once
    networks    one entry per component, plus one per declared port / ground
    connections scikit-rf's `Circuit(connections)` argument:
                a List of List of (network_name, port_number); each inner list is one
                electrical node whose members are all tied together
    schematic   the DRAWING (positions, wire polylines, taps). scikit-rf ignores it; it
                is what lets the editor reopen the file and render the identical picture
                instead of re-deriving a possibly different layout.

Only the standard library plus scikit-rf is required.

SI values
---------
`value` is always SI: ohms for resistors, henries for inductors, farads for capacitors.
`value_text` keeps the label as displayed in the editor, so a reimport can restore it.

Notes on the element models
---------------------------
scikit-rf's media helpers give ideal lumped elements:

    tl_media.capacitor(C)   series C
    tl_media.inductor(L)    series L
    tl_media.resistor(R)    series R

They are two-port Networks, so their port indices are 0 and 1 — which is exactly how the
exporter maps a component's pins (p0 -> 0, p1 -> 1).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


def load_netlist(path: str | Path) -> dict[str, Any]:
    """Read an exported netlist JSON file."""
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise ValueError("netlist file must contain a JSON object")
    for key in ("frequency", "networks", "connections"):
        if key not in data:
            raise ValueError(f"netlist is missing required section: {key}")
    return data


def _frequency(rf, spec: dict[str, Any]):
    return rf.Frequency(
        start=float(spec.get("start", 1)),
        stop=float(spec.get("stop", 10)),
        npoints=int(spec.get("npoints", 1001)),
        unit=spec.get("unit", "GHz"),
    )


def build_networks(data: dict[str, Any]) -> dict[str, Any]:
    """
    Turn the `networks` section into scikit-rf Network objects, keyed by name.

    Unknown kinds are rejected rather than silently skipped: a missing component in a
    circuit produces wrong results that look plausible.
    """
    import skrf as rf

    freq = _frequency(rf, data["frequency"])
    media = rf.media.DefinedGammaZ0(freq, z0=50)

    out: dict[str, Any] = {}
    for entry in data["networks"]:
        name = entry["name"]
        kind = entry.get("kind")
        if name in out:
            raise ValueError(f"duplicate network name: {name}")

        if kind == "resistor":
            out[name] = media.resistor(float(entry["value"]), name=name)
        elif kind == "inductor":
            out[name] = media.inductor(float(entry["value"]), name=name)
        elif kind == "capacitor":
            out[name] = media.capacitor(float(entry["value"]), name=name)
        elif kind == "port":
            out[name] = rf.circuit.Circuit.Port(freq, name=name, z0=float(entry.get("z0", 50)))
        elif kind == "ground":
            out[name] = rf.circuit.Circuit.Ground(freq, name=name)
        else:
            raise ValueError(f"unsupported network kind: {kind!r} (network {name})")
    return out


def build_connections(data: dict[str, Any], networks: dict[str, Any]):
    """
    Resolve the exported name-based connections into scikit-rf's (Network, port) tuples.

    Validates on the way in, so a malformed file fails here with a clear message instead of
    inside scikit-rf with an obscure one.
    """
    connections = []
    seen: set[tuple[str, int]] = set()
    for group in data["connections"]:
        if not group:
            raise ValueError("empty connection group")
        resolved = []
        for item in group:
            if not (isinstance(item, (list, tuple)) and len(item) == 2):
                raise ValueError(f"connection member must be [name, port], got {item!r}")
            name, port = item[0], int(item[1])
            if name not in networks:
                raise ValueError(f"connection references unknown network: {name}")
            key = (name, port)
            if key in seen:
                # scikit-rf would raise AttributeError for a duplicate node reference.
                raise ValueError(
                    f"({name}, {port}) appears in more than one node — "
                    "the schematic has a redundant connection that a Circuit cannot express"
                )
            seen.add(key)
            resolved.append((networks[name], port))
        connections.append(resolved)
    return connections


def build_circuit(data: dict[str, Any]):
    """Build an skrf.Circuit from an exported netlist."""
    import skrf as rf

    networks = build_networks(data)
    connections = build_connections(data, networks)
    return rf.circuit.Circuit(connections)


def summarize(data: dict[str, Any]) -> str:
    lines = []
    gen = data.get("generator", {})
    lines.append(f"netlist format : {data.get('format', '?')}")
    if gen:
        lines.append(f"generator      : {gen.get('app', '?')} v{gen.get('version', '?')} (routing {gen.get('routing', '?')})")
    f = data.get("frequency", {})
    lines.append(
        f"frequency      : {f.get('start')}–{f.get('stop')} {f.get('unit')}, {f.get('npoints')} points"
    )
    lines.append(f"networks       : {len(data.get('networks', []))}")
    lines.append(f"nodes          : {len(data.get('connections', []))}")
    for net in data.get("nets", []):
        tap = ""
        if net.get("taps"):
            tap = " taps=" + ",".join(f"{t['wireId']}->{t['hostWireId']}" for t in net["taps"])
        lines.append(
            f"  {net.get('name'):<5} terminals={','.join(net.get('terminals', [])) or '-'}"
            f" wires={len(net.get('wires', []))}{tap}"
        )
    for note in data.get("notes", []):
        lines.append(f"note           : {note}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__)
        return 2
    path = argv[1]
    data = load_netlist(path)
    print(summarize(data))

    # The schematic is not needed for the electrical model, but reporting it makes it obvious
    # that the drawing travelled with the file (that is what keeps reopening pixel-identical).
    sch = data.get("schematic")
    if sch:
        print(
            f"schematic      : {len(sch.get('components', []))} parts, "
            f"{len(sch.get('wires', []))} wires "
            f"(stored polylines: {sum(1 for w in sch.get('wires', []) if w.get('waypoints'))})"
        )

    try:
        circuit = build_circuit(data)
    except ImportError:
        print("\nscikit-rf is not installed: pip install scikit-rf")
        return 0
    except ValueError as err:
        print(f"\nnetlist rejected: {err}")
        return 1

    print("\nCircuit built successfully.")
    net = circuit.network
    print(f"resulting network: {net}")
    try:
        print(f"S[0,0] at the first frequency: {net.s[0, 0, 0]}")
    except Exception:  # a one-port result indexes differently
        try:
            print(f"S[0] at the first frequency: {net.s[0, 0]}")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
