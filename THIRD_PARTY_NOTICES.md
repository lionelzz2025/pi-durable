# Third-party notices

## pi-wechat-assistant 0.3.1

Source: https://github.com/shenjiecode/pi-wechat-assistant
Copyright (c) 2026 sj. MIT; full license: [licenses/pi-wechat-assistant-MIT.txt](licenses/pi-wechat-assistant-MIT.txt).

Vendoring baseline: installed package 0.3.1. SHA-256 of upstream files:

| Source | SHA-256 | Local treatment |
|---|---|---|
| src/types.ts | f51241da75458cc8ae3810585d436b9fa7228f5ae1c60dd518255062c3e922b0 | Copied to src/wechat-assistant/channel/types.ts unchanged |
| src/api.ts | 4d5d86d7e6a337ee55a12f131859b58c930de2c64bde6371bb2bfb3d08010137 | Adapted protocol shapes into channel/api.ts; no runtime global import |
| LICENSE | 6e0f590ad64ec0eefc3048229cc4ef583f2cb6f55131de6948ea2668fad14c6f | Copied unchanged |

API changes: injected fetch transport, bounded response streaming, fixed HTTPS origin without redirects, cancellation/timeouts for GET and POST, secret-free error messages, explicit caller-owned client ID and no automatic retry. No cursor/seen persistence here; B2 owns admission transactions. Media upload metadata protocol is also adapted from src/api.ts; channel/cdn.ts uses the upstream fixed CDN address with bounded/cancellable transfer and no redirects or arbitrary upload_full_url. Media decryption/encoding and pi host integration are not copied yet.
