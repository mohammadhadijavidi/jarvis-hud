"""Minimal Jarvis HUD backend in Python (scripted echo, no model).

    pip install websockets
    python examples/python_backend.py
    # open the HUD with ?ws=ws://127.0.0.1:8791
"""
import asyncio
import json

import websockets


async def handler(ws):
    async def send(ev):
        await ws.send(json.dumps(ev))

    await send({"type": "meta", "backend": "Python example", "provider": "none", "model": "echo",
                "simulated": True, "accepts": ["text"]})
    await send({"type": "state", "state": "idle"})
    n = 0
    async for raw in ws:
        msg = json.loads(raw)
        if msg.get("type") != "user_text":
            continue
        n += 1
        await send({"type": "transcript", "id": f"u{n}", "role": "user", "text": msg["text"], "final": True})
        await send({"type": "state", "state": "thinking"})
        await send({"type": "tool_call", "id": f"t{n}", "name": "upper", "args": {"text": msg["text"]}})
        await asyncio.sleep(0.25)
        await send({"type": "tool_result", "id": f"t{n}", "status": "ok", "result": {"upper": msg["text"].upper()}, "ms": 250})
        await send({"type": "state", "state": "speaking"})
        for i, word in enumerate(f"In capitals: {msg['text'].upper()}".split()):
            await send({"type": "transcript", "id": f"a{n}", "role": "assistant",
                        "text": word if i == 0 else " " + word, "delta": i > 0})
            await send({"type": "level", "value": 0.7 if i % 2 else 0.35})
            await asyncio.sleep(0.09)
        await send({"type": "transcript", "id": f"a{n}", "role": "assistant", "text": "", "delta": True, "final": True})
        await send({"type": "level", "value": 0})
        await send({"type": "state", "state": "idle"})


async def main():
    async with websockets.serve(handler, "127.0.0.1", 8791):
        print("Python backend on ws://127.0.0.1:8791")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
