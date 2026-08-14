#!/usr/bin/env python3
"""Dump the real `portfolio.CHAINS` table to `chains_corpus.json` for the Rust parity test.

Run from the wallet-portfolio directory so `import portfolio` resolves:

    cd ~/Desktop/code/home-ai-assistant/wallet-portfolio
    .venv/bin/python <this file> > /dev/null

The point is that nothing here is hand-transcribed: the corpus is read out of the live dict,
so a chain added/renamed/re-ordered in Python fails the Rust test instead of silently drifting.
Ordering is preserved (dict insertion order) because `_order_chains` sorts by it.
"""

import json
import os
import sys

# Python puts *this* file's directory on sys.path, not the cwd, so add the cwd back: the
# script lives in the Rust tree but must import the Python oracle it is run from.
sys.path.insert(0, os.getcwd())

import portfolio as p  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chains_corpus.json")


def sub(cfg, key, fields):
    """A nested config block (univ3/univ4/aero_cl) reduced to `fields`, or None if absent."""
    block = cfg.get(key)
    return {f: block.get(f) for f in fields} if block else None


def main():
    chains = []
    for name, cfg in p.CHAINS.items():
        kind = p._kind(name)
        native = cfg.get("native")
        chains.append(
            {
                "name": name,
                "kind": kind,
                # Which address shape may be paired with this chain — the whole point of
                # CHAIN_KINDS: an 0x… address must never be fanned out to Bitcoin.
                "address_kind": {
                    "evm": "evm",
                    "hypercore": "evm",
                    "btc": "bitcoin",
                    "solana": "solana",
                }[kind],
                "blockscout": cfg.get("blockscout"),
                "rpc": cfg.get("rpc"),
                "llama": cfg.get("llama"),
                "aave_pool": cfg.get("aave_pool"),
                "native_symbol": native["symbol"] if native else None,
                "native_price_key": native["price_key"] if native else None,
                "chain_id": cfg.get("chain_id"),
                "vfat_api": bool(cfg.get("vfat_api", False)),
                "sickle_rpc": bool(cfg.get("sickle_rpc", False)),
                "sickle_factory": cfg.get("sickle_factory"),
                "univ3": sub(cfg, "univ3", ["npm", "factory"]),
                "univ4": sub(cfg, "univ4", ["pm", "stateview"]),
                "aero_cl": sub(cfg, "aero_cl", ["npm", "factory", "label"]),
            }
        )

    corpus = {
        "version": p.VERSION,
        "native_placeholder": p.NATIVE,
        "count": len(chains),
        "order": list(p.CHAINS),
        "chains": chains,
        # Every (address kind -> chains it pairs with) pair, computed by the real matcher.
        "pairings": {
            kind: [ch for ch in p.CHAINS if p.CHAIN_KINDS[p._kind(ch)]["match"](addr)]
            for kind, addr in (
                ("evm", "0x1234567890abcdef1234567890ABCDEF12345678"),
                ("bitcoin", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"),
                ("solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
            )
        },
    }

    with open(OUT, "w") as fh:
        json.dump(corpus, fh, indent=2, sort_keys=False)
        fh.write("\n")
    print(f"wrote {OUT}: {len(chains)} chains", file=sys.stderr)


if __name__ == "__main__":
    main()
